// @ts-nocheck — legacy-mode admin browser module (plan §8, 3a compile-mode (a)).
// Deliberately untyped JS to sit beside the legacy-compiled admin components; its
// behavior is covered by tests/admin-save-page.test.js + tests/bff-realapex.test.js.
import { PAGE_META_NAMES, pageMetaValue, pageMetaProblem } from '../cms/page-meta.js';
import { isTempId, serializeBlocksForSave } from './block-serialize.js';

/**
 * `@ts-nocheck` suppresses errors in THIS file; it does not stop the annotations
 * below from typing everything that imports it. The shapes live in `./types.d.ts`.
 *
 * @typedef {import('./types').AdminPage} AdminPage
 * @typedef {import('./types').AdminPageBlock} AdminPageBlock
 * @typedef {import('./types').AdminPageDraft} AdminPageDraft
 */

/** Apex's delegated type for a spacer. */
export const SPACER_BLOCKABLE = 'Cms::PageBlock::Spacer';
/** The sizes `Cms::PageBlock::Spacer` accepts (it validates `kind` in these; nil allowed). */
export const SPACER_KINDS = Object.freeze(['small', 'medium', 'large']);

export function isSpacerBlock(block) {
	return block?.blockable_type === SPACER_BLOCKABLE;
}

// Local page-draft state (plan §8, 3a M1). Edits mutate THIS, not Apex. There is no
// autosave, no debounce, no coordinator — a single explicit `savePage()` (save-page.js)
// reads the dirty set off a draft and writes it. The draft is a plain object graph
// (legacy Svelte mode, so no `$state` proxy) which keeps the serializer's
// structuredClone calls safe and makes the whole model unit-testable without a DOM.

let tempCounter = 0;
function nextTempId(prefix) {
	tempCounter += 1;
	return `temp-${prefix}-${tempCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

function clone(value) {
	return structuredClone(value);
}

/**
 * Build a draft from a hydrated Apex page and its composite version token.
 * `baselineVersion` is the pristine server state the stale guard compares against
 * ONCE on Save.
 *
 * @param {AdminPage} page
 * @param {string} version
 * @returns {AdminPageDraft}
 */
export function createDraft(page, version) {
	const draft = {
		pageId: page.id,
		baselineVersion: version,
		page: clone(page),
		/** Entity ids whose `fields_data` the editor changed. */
		dirtyEntityIds: new Set(),
		/** True once blocks were reordered / added / removed, or page meta changed. */
		structureDirty: false,
		/** Real ids of removed blocks, sent as `{ id, _destroy: true }`. */
		deletedBlockIds: [],
		metaEdits: {},
		recoveryRequired: false
	};
	if (!Array.isArray(draft.page.blocks)) draft.page.blocks = [];
	sortBlocks(draft);
	return draft;
}

function sortBlocks(draft) {
	draft.page.blocks.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

/**
 * @param {AdminPageDraft} draft
 * @returns {AdminPageBlock[]} always an array — `createDraft` guarantees it.
 */
export function getBlocks(draft) {
	return draft.page.blocks;
}

function findBlock(draft, blockId) {
	return draft.page.blocks.find((block) => block.id === blockId) || null;
}

/** Local fields are editable when an owned entity exists, including temp seeds.
 * @param {AdminPageBlock | null | undefined} block
 * @returns {boolean}
 */
export function canEditFields(block) {
	if (!block) return false;
	const entity = block.blockable?.entity;
	if (!entity?.id) return false;
	return true;
}

/**
 * Set a backing entity value locally. Stored entities become dirty field patches;
 * temporary entities stay structure seeds until verified IDs are returned.
 *
 * @param {AdminPageDraft} draft
 * @param {string | null | undefined} blockId a block that is not there is a no-op
 * @param {string} fieldName
 * @param {unknown} value
 * @returns {boolean} true when the value was written
 */
export function setField(draft, blockId, fieldName, value) {
	const block = findBlock(draft, blockId);
	if (!canEditFields(block)) return false;
	const entity = block.blockable?.entity;
	if (!entity) return false;
	if (!entity.fields_data || typeof entity.fields_data !== 'object') entity.fields_data = {};
	entity.fields_data[fieldName] = value;
	if (isTempId(entity.id)) draft.structureDirty = true;
	else draft.dirtyEntityIds.add(entity.id);
	return true;
}

/**
 * Set a field on a nested child template instance's entity (same temp-id rule).
 *
 * @param {AdminPageDraft} draft
 * @param {string | null | undefined} blockId
 * @param {string | null | undefined} childId
 * @param {string} fieldName
 * @param {unknown} value
 * @returns {boolean}
 */
export function setChildField(draft, blockId, childId, fieldName, value) {
	const block = findBlock(draft, blockId);
	if (!canEditFields(block)) return false;
	const children = block.blockable?.child_template_instances;
	if (!Array.isArray(children)) return false;
	const child = children.find((item) => item.id === childId);
	if (!child || !child.entity) {
		return false;
	}
	if (!child.entity.fields_data || typeof child.entity.fields_data !== 'object') {
		child.entity.fields_data = {};
	}
	child.entity.fields_data[fieldName] = value;
	if (isTempId(child.entity.id)) draft.structureDirty = true;
	else draft.dirtyEntityIds.add(child.entity.id);
	return true;
}

/**
 * Reorder blocks by moving one index to another. LOCAL ONLY — this rewrites
 * `position` on the in-memory draft and marks structure dirty; it NEVER calls the
 * BFF. Persistence happens only when `savePage()` runs (plan M1: "reordering is
 * local and never persists on drag").
 *
 * @param {AdminPageDraft} draft
 * @param {number} fromIndex
 * @param {number} toIndex
 * @returns {void}
 */
export function reorderBlocks(draft, fromIndex, toIndex) {
	const blocks = draft.page.blocks;
	if (fromIndex < 0 || fromIndex >= blocks.length) return;
	const clamped = Math.max(0, Math.min(toIndex, blocks.length - 1));
	if (clamped === fromIndex) return;
	const [moved] = blocks.splice(fromIndex, 1);
	blocks.splice(clamped, 0, moved);
	applyPositions(draft);
	draft.structureDirty = true;
}

/**
 * Reorder to an explicit id order (used by the pointer-drag outline). Local only.
 *
 * @param {AdminPageDraft} draft
 * @param {string[]} orderedIds
 * @returns {void}
 */
export function setBlockOrder(draft, orderedIds) {
	const byId = new Map(draft.page.blocks.map((block) => [block.id, block]));
	const next = [];
	for (const id of orderedIds) {
		const block = byId.get(id);
		if (block) next.push(block);
	}
	// Keep any block the caller omitted, appended in its existing order.
	for (const block of draft.page.blocks) if (!next.includes(block)) next.push(block);
	draft.page.blocks = next;
	applyPositions(draft);
	draft.structureDirty = true;
}

function applyPositions(draft) {
	draft.page.blocks.forEach((block, index) => {
		block.position = index;
	});
}

/**
 * Add a new template-instance block. It gets a temp id and a temp entity id, so its
 * fields are NOT editable yet (`canEditFields` is false). A structure save mints the
 * real ids; `reconcile()` then unlocks the fields. Returns the temp block.
 *
 * @param {AdminPageDraft} draft
 * @param {{
 *   templateId: string,
 *   templateSlug: string,
 *   label: string,
 *   entityTypeId: string,
 *   fieldsData: Record<string, unknown>
 * }} spec
 * @returns {AdminPageBlock}
 */
export function addTemplateBlock(
	draft,
	{ templateId, templateSlug, label, entityTypeId, fieldsData }
) {
	const block = {
		id: nextTempId('block'),
		label: label || templateSlug || 'Section',
		position: draft.page.blocks.length,
		blockable_type: 'Cms::PageBlock::TemplateInstance',
		blockable: {
			id: nextTempId('inst'),
			page_block_template_id: templateId,
			page_block_template: { id: templateId, slug: templateSlug, name: label },
			entity: {
				id: nextTempId('entity'),
				entity_type_id: entityTypeId,
				fields_data: fieldsData || {}
			},
			child_template_instances: []
		}
	};
	draft.page.blocks.push(block);
	applyPositions(draft);
	draft.structureDirty = true;
	return block;
}

/**
 * Append a medium spacer with no blockable id, so Apex builds the delegated record.
 *
 * @param {AdminPageDraft} draft
 * @returns {AdminPageBlock}
 */
export function addSpacerBlock(draft) {
	const block = {
		id: nextTempId('block'),
		label: null,
		position: draft.page.blocks.length,
		blockable_type: SPACER_BLOCKABLE,
		// A TEMP id, like the template path's instance and entity: `AdminBlockable.id` is
		// required, so an id-less blockable would be a type that lies to every consumer.
		// `serializePageBlockForSave` strips temp ids, so Apex still mints the real one.
		blockable: { id: nextTempId('spacer'), kind: 'medium' }
	};
	draft.page.blocks.push(block);
	applyPositions(draft);
	draft.structureDirty = true;
	return block;
}

/**
 * Set a spacer's size without creating a missing delegated record.
 *
 * @param {AdminPageDraft} draft
 * @param {string | null | undefined} blockId
 * @param {unknown} kind
 * @returns {boolean}
 */
export function setSpacerKind(draft, blockId, kind) {
	const block = findBlock(draft, blockId);
	if (!isSpacerBlock(block) || !block.blockable || typeof block.blockable !== 'object')
		return false;
	if (!SPACER_KINDS.includes(kind)) return false;
	if (block.blockable.kind === kind) return true;
	block.blockable.kind = kind;
	draft.structureDirty = true;
	return true;
}

/**
 * Remove a block. A real (non-temp) id is remembered so the save can `_destroy` it.
 *
 * @param {AdminPageDraft} draft
 * @param {string | null | undefined} blockId
 * @returns {void}
 */
export function removeBlock(draft, blockId) {
	const index = draft.page.blocks.findIndex((block) => block.id === blockId);
	if (index === -1) return;
	const [removed] = draft.page.blocks.splice(index, 1);
	forgetOwnedFields(draft, removed?.blockable);
	if (removed && !isTempId(`${removed.id}`)) draft.deletedBlockIds.push(removed.id);
	applyPositions(draft);
	draft.structureDirty = true;
}

/**
 * Set a page-level string field (title/slug/summary). Marks structure dirty.
 *
 * Those three are the whole list because they are what the structure route's body
 * schema permits (`save-page-structure.ts`).
 *
 * @param {AdminPageDraft} draft
 * @param {'title' | 'slug' | 'summary'} name
 * @param {string} value
 * @returns {void}
 */
export function setPageField(draft, name, value) {
	draft.page[name] = value;
	draft.structureDirty = true;
}

/**
 * @param {AdminPageDraft} draft
 * @returns {boolean}
 */
export function isDirty(draft) {
	return (
		draft.dirtyEntityIds.size > 0 ||
		draft.structureDirty ||
		draft.deletedBlockIds.length > 0 ||
		Object.keys(draft.metaEdits ?? {}).length > 0
	);
}

/** Collect every entity in the tree, keyed by id, so dirty ones can be found. */
function collectEntities(draft) {
	const entities = new Map();
	for (const block of draft.page.blocks) {
		const entity = block.blockable?.entity;
		if (entity?.id) entities.set(entity.id, entity);
		const children = block.blockable?.child_template_instances;
		if (Array.isArray(children)) {
			for (const child of children) {
				if (child.entity?.id) entities.set(child.entity.id, child.entity);
			}
		}
	}
	return entities;
}

/**
 * The per-entity PATCH list `savePage()` dispatches FIRST — one entry per dirty
 * entity, in a stable order. Temp entity ids are impossible here (setField refuses
 * them), so every entry targets a real Apex entity.
 *
 * @param {AdminPageDraft} draft
 * @returns {Array<{
 *   entityTypeId: string | null | undefined,
 *   entityId: string,
 *   fields_data: Record<string, unknown>
 * }>}
 */
export function dirtyEntityPatches(draft) {
	const entities = collectEntities(draft);
	const patches = [];
	for (const entityId of draft.dirtyEntityIds) {
		const entity = entities.get(entityId);
		if (!entity || isTempId(`${entity.id}`)) continue;
		patches.push({
			entityTypeId: entity.entity_type_id,
			entityId: entity.id,
			fields_data: clone(entity.fields_data || {})
		});
	}
	return patches;
}

/**
 * The `blocks_attributes` + page-meta payload for the structure save.
 *
 * @param {AdminPageDraft} draft
 * @returns {{
 *   title: string | null | undefined,
 *   slug: string | null | undefined,
 *   summary: string,
 *   blocks_attributes: Array<Record<string, unknown>>
 * }}
 */
export function structurePayload(draft) {
	return {
		title: draft.page.title,
		slug: draft.page.slug,
		summary: draft.page.summary ?? '',
		blocks_attributes: serializeBlocksForSave(draft.page.blocks, draft.deletedBlockIds)
	};
}

/**
 * Re-baseline after a successful save: replace the tree with the fresh server page,
 * clear every dirty flag, and adopt the new version token. This is where temp-id
 * blocks become real (the server page carries real ids) and their fields unlock.
 *
 * @param {AdminPageDraft} draft
 * @param {AdminPage} serverPage
 * @param {string} version
 * @returns {void}
 */
export function reconcile(draft, serverPage, version) {
	draft.page = clone(serverPage);
	if (!Array.isArray(draft.page.blocks)) draft.page.blocks = [];
	sortBlocks(draft);
	draft.dirtyEntityIds = new Set();
	draft.structureDirty = false;
	draft.deletedBlockIds = [];
	draft.metaEdits = {};
	draft.recoveryRequired = false;
	if (version) draft.baselineVersion = version;
	draft.pageId = draft.page.id;
}

/** SEO remains separate from page title/slug/structure.
 * @param {AdminPageDraft} draft @param {'title' | 'description' | 'keywords'} name @param {string} value
 * @returns {boolean}
 */
export function setPageMeta(draft, name, value) {
	if (
		!PAGE_META_NAMES.includes(name) ||
		typeof value !== 'string' ||
		pageMetaProblem(draft.page.meta_properties, name)
	)
		return false;
	draft.metaEdits ??= {};
	if (value === pageMetaValue(draft.page.meta_properties, name)) delete draft.metaEdits[name];
	else draft.metaEdits[name] = value;
	return true;
}

/** Owned-template operations take site policy as data; no site slugs live in the kit.
 * @typedef {{templateId:string, entityTypeId:string, fields:string[], anchors:string[], children:string[]}} OwnedTemplate
 * @typedef {Record<string, OwnedTemplate>} OwnedTemplates
 */
function forgetOwnedFields(draft, instance) {
	if (instance?.entity?.id) draft.dirtyEntityIds.delete(instance.entity.id);
	for (const child of instance?.child_template_instances ?? []) forgetOwnedFields(draft, child);
}
function ownedSpec(instance, registry, depth = 0) {
	const slug = instance?.page_block_template?.slug;
	const spec = registry[slug];
	if (!spec?.templateId || !spec.entityTypeId || depth > 1)
		throw new Error('This template is unavailable or has unsupported nested items.');
	for (const child of instance.child_template_instances ?? []) {
		if (!spec.children.includes(child?.page_block_template?.slug))
			throw new Error('This child template is unavailable.');
		ownedSpec(child, registry, depth + 1);
	}
	return spec;
}
function ownedInstance(slug, registry, source) {
	const spec = registry[slug];
	if (!spec?.templateId || !spec.entityTypeId) throw new Error('This template is not configured.');
	const fields = {};
	for (const name of spec.fields)
		if (Object.hasOwn(source?.entity?.fields_data ?? {}, name))
			fields[name] = clone(source.entity.fields_data[name]);
	for (const name of spec.anchors) if (Object.hasOwn(fields, name)) fields[name] = '';
	return {
		id: nextTempId('inst'),
		page_block_template_id: spec.templateId,
		page_block_template: { id: spec.templateId, slug },
		entity: { id: nextTempId('entity'), entity_type_id: spec.entityTypeId, fields_data: fields },
		child_template_instances: []
	};
}
function ownedParent(draft, blockId, registry) {
	const block = findBlock(draft, blockId);
	if (!block || block.blockable_type !== 'Cms::PageBlock::TemplateInstance')
		throw new Error('Section unavailable.');
	ownedSpec(block.blockable, registry);
	return block.blockable;
}
function childPositions(parent) {
	parent.child_template_instances.forEach((child, index) => {
		child.position = index;
	});
}
/** @param {AdminPageDraft} draft @param {string} blockId @param {string} slug @param {OwnedTemplates} registry */
export function addOwnedChild(draft, blockId, slug, registry) {
	const parent = ownedParent(draft, blockId, registry);
	if (!registry[parent.page_block_template.slug].children.includes(slug))
		throw new Error('This child template is unavailable.');
	const child = ownedInstance(slug, registry);
	parent.child_template_instances ??= [];
	parent.child_template_instances.push(child);
	childPositions(parent);
	draft.structureDirty = true;
	return child;
}
/** @param {AdminPageDraft} draft @param {string} blockId @param {string} childId @param {OwnedTemplates} registry */
export function duplicateOwnedChild(draft, blockId, childId, registry) {
	const parent = ownedParent(draft, blockId, registry);
	const index = parent.child_template_instances.findIndex((child) => child.id === childId);
	if (index < 0) throw new Error('Item unavailable.');
	const source = parent.child_template_instances[index];
	const child = ownedInstance(source.page_block_template.slug, registry, source);
	parent.child_template_instances.splice(index + 1, 0, child);
	childPositions(parent);
	draft.structureDirty = true;
	return child;
}
/** @param {AdminPageDraft} draft @param {string} blockId @param {string} childId @param {OwnedTemplates} registry */
export function removeOwnedChild(draft, blockId, childId, registry) {
	const parent = ownedParent(draft, blockId, registry);
	const index = parent.child_template_instances.findIndex((child) => child.id === childId);
	if (index < 0) return;
	const [child] = parent.child_template_instances.splice(index, 1);
	forgetOwnedFields(draft, child);
	if (!isTempId(child.id)) {
		parent.deleted_child_template_instance_ids ??= [];
		parent.deleted_child_template_instance_ids.push(child.id);
	}
	childPositions(parent);
	draft.structureDirty = true;
}
/** @param {AdminPageDraft} draft @param {string} blockId @param {string} childId @param {number} offset @param {OwnedTemplates} registry */
export function moveOwnedChild(draft, blockId, childId, offset, registry) {
	const parent = ownedParent(draft, blockId, registry);
	const index = parent.child_template_instances.findIndex((child) => child.id === childId);
	const target = index + offset;
	if (index < 0 || target < 0 || target >= parent.child_template_instances.length) return;
	const [child] = parent.child_template_instances.splice(index, 1);
	parent.child_template_instances.splice(target, 0, child);
	childPositions(parent);
	draft.structureDirty = true;
}
/** @param {AdminPageDraft} draft @param {string} blockId @param {OwnedTemplates} registry */
export function duplicateOwnedSection(draft, blockId, registry) {
	const source = ownedParent(draft, blockId, registry);
	const original = findBlock(draft, blockId);
	const root = ownedInstance(source.page_block_template.slug, registry, source);
	root.child_template_instances = (source.child_template_instances ?? []).map((child) =>
		ownedInstance(child.page_block_template.slug, registry, child)
	);
	childPositions(root);
	const block = {
		id: nextTempId('block'),
		label: `${original.label || source.page_block_template.slug} copy`,
		position: 0,
		blockable_type: 'Cms::PageBlock::TemplateInstance',
		blockable: root
	};
	draft.page.blocks.splice(draft.page.blocks.indexOf(original) + 1, 0, block);
	applyPositions(draft);
	draft.structureDirty = true;
	return block;
}
