// @ts-nocheck — legacy-mode admin browser module (plan §8, 3a compile-mode (a)).
// Deliberately untyped JS to sit beside the legacy-compiled admin components; its
// behavior is covered by tests/admin-save-page.test.js + tests/bff-realapex.test.js.
import { isTempId, serializeBlocksForSave } from './block-serialize.js';

/**
 * `@ts-nocheck` suppresses errors in THIS file; it does not stop the annotations
 * below from typing everything that imports it. The shapes live in `./types.d.ts`.
 *
 * @typedef {import('./types').AdminPage} AdminPage
 * @typedef {import('./types').AdminPageBlock} AdminPageBlock
 * @typedef {import('./types').AdminPageDraft} AdminPageDraft
 * @typedef {import('./types').CollectionSource} CollectionSource
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
		deletedBlockIds: []
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

/**
 * The temp-id fix (plan M1): a block the editor just added has a temp id and NO
 * server-side entity, so its fields must not be editable until a structure save has
 * minted real ids. Anything with a temp block id or temp entity id is locked.
 *
 * @param {AdminPageBlock | null | undefined} block
 * @returns {boolean}
 */
export function canEditFields(block) {
	if (!block) return false;
	if (isTempId(`${block.id}`)) return false;
	const entity = block.blockable?.entity;
	if (entity && isTempId(`${entity.id}`)) return false;
	return true;
}

/**
 * Set one field value on a block's backing entity. Refuses (returns false) while the
 * block is still a temp — the caller must persist the structure to get a real id
 * first. On success it marks exactly that entity dirty, so `savePage()` PATCHes only
 * the entities that actually changed.
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
	draft.dirtyEntityIds.add(entity.id);
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
	if (!child || isTempId(`${child.id}`) || !child.entity || isTempId(`${child.entity.id}`)) {
		return false;
	}
	if (!child.entity.fields_data || typeof child.entity.fields_data !== 'object') {
		child.entity.fields_data = {};
	}
	child.entity.fields_data[fieldName] = value;
	draft.dirtyEntityIds.add(child.entity.id);
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
 * A GENERATED LISTING — the bands that render a collection of records.
 *
 * `kind` is REQUIRED by Apex: `Cms::PageBlock::AutoCollection` validates it against
 * `archetype | entity_type | model`, and `Cms::PageBlock` declares
 * `validates_associated :blockable`, so a nil kind fails the WHOLE page save, not
 * just this block. Every band live on either site today is `archetype`.
 */
export const COLLECTION_BLOCKABLE = 'Cms::PageBlock::AutoCollection';

/** @param {AdminPageBlock | null | undefined} block */
export function isCollectionBlock(block) {
	return block?.blockable_type === COLLECTION_BLOCKABLE;
}

/**
 * Find a source by its `refName` in the list the CALLER owns.
 *
 * The list lives in each site because each site's renderer decides what it can
 * draw, and **Apex validates `ref_name` not at all** — a typo saves 200 and renders
 * nothing. So this list is the only guard there is, and every operation below goes
 * through it rather than taking a caller's word for a string.
 *
 * @param {readonly CollectionSource[] | null | undefined} sources
 * @param {unknown} refName
 * @returns {CollectionSource | null}
 */
function resolveSource(sources, refName) {
	if (!Array.isArray(sources) || typeof refName !== 'string' || !refName) return null;
	const found = sources.find((source) => source?.refName === refName);
	if (!found) return null;
	// A half-built entry would let a switch write a good `ref_name` beside a missing
	// label and an undefined count — three fields, one of them wrong, atomically.
	if (typeof found.label !== 'string' || !found.label) return null;
	if (!Number.isInteger(found.defaultCount) || found.defaultCount < 0) return null;
	return found;
}

/**
 * Append a generated listing for `refName`, taking its label and count FROM the list.
 *
 * Creation is the path that mints these values, so it is the one that most needs the
 * allow-list: an invented `refName` here would produce a band no renderer can draw
 * and no dialog can recreate.
 *
 * @param {AdminPageDraft} draft
 * @param {string} refName
 * @param {readonly CollectionSource[]} sources
 * @param {{ kind?: string }} [options]
 * @returns {AdminPageBlock | null} the block, or `null` if the source is not listed
 */
export function addCollectionBlock(draft, refName, sources, options = {}) {
	const source = resolveSource(sources, refName);
	if (!source) return null;
	const kind = typeof options.kind === 'string' && options.kind ? options.kind : 'archetype';
	const block = {
		id: nextTempId('block'),
		label: source.label,
		position: draft.page.blocks.length,
		blockable_type: COLLECTION_BLOCKABLE,
		// A temp id for the same reason the spacer carries one: `AdminBlockable.id` is
		// required, and `serializePageBlockForSave` strips temp ids so Apex mints the real
		// one. `item_count` is always sent — the old admin's writes never omit it.
		blockable: {
			id: nextTempId('collection'),
			kind,
			ref_name: source.refName,
			item_count: source.defaultCount
		}
	};
	draft.page.blocks.push(block);
	applyPositions(draft);
	draft.structureDirty = true;
	return block;
}

/**
 * Set how many records a listing shows.
 *
 * @param {AdminPageDraft} draft
 * @param {string | null | undefined} blockId
 * @param {unknown} count
 * @returns {boolean}
 */
export function setCollectionItemCount(draft, blockId, count) {
	const block = findBlock(draft, blockId);
	if (!isCollectionBlock(block) || !block.blockable || typeof block.blockable !== 'object')
		return false;
	if (!Number.isInteger(count) || /** @type {number} */ (count) < 0) return false;
	if (block.blockable.item_count === count) return true;
	block.blockable.item_count = count;
	draft.structureDirty = true;
	return true;
}

/**
 * Point a listing at a different source — `ref_name`, `label` and `item_count` TOGETHER.
 *
 * All three, because the alternative leaves the band half-switched: both admins name
 * an outline row from the stored `label`, so writing only `ref_name` keeps the old
 * name on screen; and `item_count` does not mean the same thing to every source. On
 * Poovayya a testimonials band with a count of 6 switched to team members would
 * select capped-grid mode with six members, where the live page shows a
 * search-and-filter UI. Adopting the new source's default is the only transition
 * that leaves the block self-consistent.
 *
 * @param {AdminPageDraft} draft
 * @param {string | null | undefined} blockId
 * @param {string} refName
 * @param {readonly CollectionSource[]} sources
 * @returns {boolean}
 */
export function setCollectionSource(draft, blockId, refName, sources) {
	const block = findBlock(draft, blockId);
	if (!isCollectionBlock(block) || !block.blockable || typeof block.blockable !== 'object')
		return false;
	const source = resolveSource(sources, refName);
	if (!source) return false;
	if (block.blockable.ref_name === source.refName) return true;
	block.blockable.ref_name = source.refName;
	block.blockable.item_count = source.defaultCount;
	block.label = source.label;
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
	return draft.dirtyEntityIds.size > 0 || draft.structureDirty || draft.deletedBlockIds.length > 0;
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
	if (version) draft.baselineVersion = version;
	draft.pageId = draft.page.id;
}
