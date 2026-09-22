// @ts-nocheck — legacy-mode admin browser module (plan §8, 3a compile-mode (a)).
// Deliberately untyped JS to sit beside the legacy-compiled admin components; its
// behavior is covered by tests/admin-save-page.test.js + tests/bff-realapex.test.js.
import { isTempId, serializeBlocksForSave } from './block-serialize.js';
import { sortBundleChildrenInPlace } from '../cms/bundle-order.js';

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
 * @param {Record<string, Record<string, { id: string, fields: Record<string, unknown> }[]>>} [childRows]
 *   The stored rows every `array_ref` field points at, hydrated by the server. A
 *   site with no such field passes nothing.
 * @returns {AdminPageDraft}
 */
export function createDraft(page, version, childRows) {
	const draft = {
		pageId: page.id,
		baselineVersion: version,
		page: clone(page),
		metaEdits: {},
		/** Entity ids whose `fields_data` the editor changed. */
		dirtyEntityIds: new Set(),
		/** True once blocks were reordered / added / removed, or page fields changed. */
		structureDirty: false,
		/** Real ids of removed blocks, sent as `{ id, _destroy: true }`. */
		deletedBlockIds: [],
		/**
		 * Child rows an editor has added to an `array_ref` field but that do not exist
		 * in Apex yet, keyed `blockId` → `fieldName` → rows.
		 *
		 * Deliberately NOT in `fields_data`. An `array_ref` element must be the id of an
		 * entity that ALREADY EXISTS — Apex's validator resolves every element and 422s
		 * on one it cannot find, naming a field the editor never typed into. So a new
		 * row lives here until its create lands, and `adoptListChildId` moves the real
		 * id into the parent array.
		 */
		listChildren: {},
		/**
		 * Field edits to rows that ALREADY exist, keyed `childId` → `fieldName` → value.
		 *
		 * Separate from `dirtyEntityIds` because these entities are not reachable from
		 * the page: `collectEntities` walks blocks, and a list child is free-standing.
		 * Its own save leg writes them.
		 */
		listChildEdits: {},
		/**
		 * The STORED rows an `array_ref` points at, hydrated by the server, keyed
		 * `blockId` → `fieldName` → `[{ id, fields }]`.
		 *
		 * Read-only baseline, never edited in place: an editor's changes go to
		 * `listChildEdits` and are layered over this on read. That split is what lets
		 * `discard` be "drop the edits" rather than "re-fetch the page".
		 */
		childRows: childRows && typeof childRows === 'object' ? clone(childRows) : {}
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
 * ── CHILD ROWS INSIDE A SECTION (`array_ref` fields) ────────────────────────
 *
 * An `array_ref` field stores the IDS of free-standing entities. The rows are not
 * owned by the block — the block references them — which is what makes this
 * different from a bundle's children and from a nested template instance.
 *
 * Two rules shape every operation below:
 *
 * 1. **A temp id must never reach the parent array.** Apex resolves every element of
 *    an `array_ref` on write and 422s on one it cannot find, naming a field the editor
 *    never touched. So a new row waits in `draft.listChildren` until its create lands.
 * 2. **Reorder and remove need no child traffic at all.** Both are edits to the
 *    parent's array, and `setField` already marks the parent entity dirty — the
 *    existing entity-PATCH leg carries them.
 */

/** @param {AdminPageDraft} draft @param {string} blockId @param {string} fieldName */
function pendingRows(draft, blockId, fieldName) {
	if (!draft.listChildren[blockId]) draft.listChildren[blockId] = {};
	if (!Array.isArray(draft.listChildren[blockId][fieldName])) {
		draft.listChildren[blockId][fieldName] = [];
	}
	return draft.listChildren[blockId][fieldName];
}

/** The parent's stored id array for one `array_ref` field, or `[]`. */
function storedIds(block, fieldName) {
	const value = block?.blockable?.entity?.fields_data?.[fieldName];
	return Array.isArray(value) ? value : [];
}

/**
 * Add a row to an `array_ref` field. It exists only in the draft until it is saved.
 *
 * @param {AdminPageDraft} draft
 * @param {string | null | undefined} blockId
 * @param {string} fieldName
 * @param {string} childType the entity type SLUG the row will be created as
 * @param {Record<string, unknown>} [fieldsData]
 * @returns {{ id: string, childType: string, fields_data: Record<string, unknown> } | null}
 */
export function addListChild(draft, blockId, fieldName, childType, fieldsData = {}) {
	const block = findBlock(draft, blockId);
	if (!canEditFields(block)) return null;
	if (typeof fieldName !== 'string' || !fieldName) return null;
	if (typeof childType !== 'string' || !childType) return null;
	const row = {
		id: nextTempId('child'),
		childType,
		fields_data: fieldsData && typeof fieldsData === 'object' ? { ...fieldsData } : {}
	};
	pendingRows(draft, block.id, fieldName).push(row);
	return row;
}

/**
 * Remove a row — a pending one outright, a stored one from the parent's array.
 *
 * The stored row's ENTITY is left in place. It is free-standing and may be referenced
 * elsewhere; there is also no working delete route for one. The button says so.
 *
 * @param {AdminPageDraft} draft
 * @param {string | null | undefined} blockId
 * @param {string} fieldName
 * @param {string} childId
 * @returns {boolean}
 */
export function removeListChild(draft, blockId, fieldName, childId) {
	const block = findBlock(draft, blockId);
	if (!canEditFields(block)) return false;
	const pending = pendingRows(draft, block.id, fieldName);
	const at = pending.findIndex((row) => row.id === childId);
	if (at !== -1) {
		pending.splice(at, 1);
		return true;
	}
	const ids = storedIds(block, fieldName);
	if (!ids.includes(childId)) return false;
	// The queued edit goes WITH the row. It was keyed by child id and survived the
	// removal otherwise: the save would PATCH a row the editor can no longer see —
	// pointlessly if it succeeded, and unfixably if it 422'd, because there is no
	// row on screen to correct.
	if (draft.listChildEdits) delete draft.listChildEdits[childId];
	return setField(
		draft,
		block.id,
		fieldName,
		ids.filter((id) => id !== childId)
	);
}

/**
 * Move a STORED row within the parent's array. Pending rows have no place in it yet.
 *
 * @param {AdminPageDraft} draft
 * @param {string | null | undefined} blockId
 * @param {string} fieldName
 * @param {number} from
 * @param {number} to
 * @returns {boolean}
 */
export function moveListChild(draft, blockId, fieldName, from, to) {
	const block = findBlock(draft, blockId);
	if (!canEditFields(block)) return false;
	const ids = [...storedIds(block, fieldName)];
	if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
	if (from < 0 || to < 0 || from >= ids.length || to >= ids.length) return false;
	if (from === to) return true;
	const [moved] = ids.splice(from, 1);
	ids.splice(to, 0, moved);
	return setField(draft, block.id, fieldName, ids);
}

/**
 * Set a field on one child row, pending or stored.
 *
 * A pending row is edited in place here and carried to its create. A stored row's
 * entity is marked dirty so the existing entity-PATCH leg writes it.
 *
 * @param {AdminPageDraft} draft
 * @param {string | null | undefined} blockId
 * @param {string} fieldName
 * @param {string} childId
 * @param {string} childField
 * @param {unknown} value
 * @param {string} [childType] required for a STORED row — the PATCH route is
 *   `entity_types/:ref/entities/:id`, so the type travels with the edit
 * @returns {boolean}
 */
export function setListChildField(
	draft,
	blockId,
	fieldName,
	childId,
	childField,
	value,
	childType
) {
	const block = findBlock(draft, blockId);
	if (!canEditFields(block)) return false;
	if (typeof childField !== 'string' || !childField) return false;
	const row = pendingRows(draft, block.id, fieldName).find((item) => item.id === childId);
	if (row) {
		row.fields_data[childField] = value;
		return true;
	}
	if (!storedIds(block, fieldName).includes(childId)) return false;
	if (isTempId(`${childId}`)) return false;
	if (typeof childType !== 'string' || !childType) return false;
	if (!draft.listChildEdits) draft.listChildEdits = {};
	if (!draft.listChildEdits[childId]) {
		draft.listChildEdits[childId] = { childType, fields_data: {} };
	}
	draft.listChildEdits[childId].fields_data[childField] = value;
	return true;
}

/**
 * Move a created row's REAL id into the parent's array, and drop the pending row.
 *
 * Called as each create lands, before the parent is written — so a retry after a
 * later failure does not create the same row twice.
 *
 * @param {AdminPageDraft} draft
 * @param {string | null | undefined} blockId
 * @param {string} fieldName
 * @param {string} tempId
 * @param {string} realId
 * @returns {boolean}
 */
export function adoptListChildId(draft, blockId, fieldName, tempId, realId) {
	const block = findBlock(draft, blockId);
	if (!canEditFields(block)) return false;
	if (typeof realId !== 'string' || !realId || isTempId(realId)) return false;
	const pending = pendingRows(draft, block.id, fieldName);
	const at = pending.findIndex((row) => row.id === tempId);
	if (at === -1) return false;
	pending.splice(at, 1);
	return setField(draft, block.id, fieldName, [...storedIds(block, fieldName), realId]);
}

/**
 * The rows `savePage` must CREATE, in the order the editor added them.
 * @param {AdminPageDraft} draft
 */
export function newListChildren(draft) {
	const out = [];
	for (const [blockId, fields] of Object.entries(draft.listChildren ?? {})) {
		for (const [fieldName, rows] of Object.entries(fields ?? {})) {
			for (const row of rows) out.push({ blockId, fieldName, ...row });
		}
	}
	return out;
}

/**
 * The stored rows `savePage` must PATCH — `{childId, fields_data}` per edited row.
 * @param {AdminPageDraft} draft
 */
export function editedListChildren(draft) {
	return Object.entries(draft.listChildEdits ?? {}).map(([childId, edit]) => ({
		childId,
		childType: edit.childType,
		fields_data: edit.fields_data
	}));
}

/**
 * What the editor sees: stored rows in the parent's order, then the pending ones.
 *
 * @param {AdminPageDraft} draft
 * @param {string | null | undefined} blockId
 * @param {string} fieldName
 */
export function listChildRows(draft, blockId, fieldName) {
	const block = findBlock(draft, blockId);
	if (!block) return [];
	const edits = draft.listChildEdits ?? {};
	// The server-hydrated baseline for this field, by id. Without it a stored row has
	// no content to draw and every existing row renders "(empty)".
	const hydratedRows = draft.childRows?.[blockId]?.[fieldName];
	const hydrated = new Map();
	for (const row of hydratedRows ?? []) {
		if (row && typeof row.id === 'string') hydrated.set(row.id, row.fields ?? {});
	}
	/**
	 * A row whose entity no longer exists is DROPPED, not drawn empty.
	 *
	 * The resolver already filters those out — a referenced child that is gone cannot
	 * be edited, and re-saving the parent without it is the repair. But the parent's
	 * array still names it, and listing from the array alone put the blank row
	 * straight back, so the drop achieved nothing on screen.
	 *
	 * Only when this field WAS hydrated. A site that supplies no resolver has no
	 * hydration for any field, and there every stored id must still be listed —
	 * otherwise the list would simply render empty.
	 */
	const drawOnlyHydrated = Array.isArray(hydratedRows);
	const stored = storedIds(block, fieldName)
		.filter((id) => !drawOnlyHydrated || hydrated.has(id))
		.map((id) => ({
			id,
			pending: false,
			// Edits LAYER over the stored fields rather than replacing them: an edit records
			// only the fields typed into, so replacing would blank every other one on screen
			// the moment an editor touched a single input.
			fields_data: { ...(hydrated.get(id) ?? {}), ...(edits[id]?.fields_data ?? {}) }
		}));
	const pending = pendingRows(draft, block.id, fieldName).map((row) => ({
		id: row.id,
		pending: true,
		childType: row.childType,
		fields_data: { ...row.fields_data }
	}));
	return [...stored, ...pending];
}

/**
 * ── A BUNDLE'S OWN CHILDREN (`Cms::PageBlock::EntityBundle`) ────────────────
 *
 * Different from an `array_ref` list in every way that matters: the bundle OWNS
 * these rows (`has_many :entities, as: :owner, dependent: :destroy`), their order
 * lives on the row as `position` rather than in an array, and destroying the block
 * destroys them.
 *
 * `Cms::PageBlock::EntityGroup` has the identical mechanism. Nothing on these sites
 * uses one, and `isBundleBlock` deliberately does not claim it — but the operations
 * take the block, not a hard-coded type, so adopting it later is a predicate change.
 */
export const BUNDLE_BLOCKABLE = 'Cms::PageBlock::EntityBundle';

/** @param {AdminPageBlock | null | undefined} block */
export function isBundleBlock(block) {
	return block?.blockable_type === BUNDLE_BLOCKABLE;
}

/**
 * The bundle's children, IN RENDER ORDER, as the live array.
 *
 * Sorted in place on every read. Apex declares no order scope on `has_many :entities`,
 * so a read-back is heap order — and the panel renders render-order. If this returned
 * the raw array, the index an editor dragged and the index `moveBundleEntity` splices
 * would be different rows, and the renumber that follows would write that wrong order
 * to Apex. Sorting here makes the two the same number everywhere.
 */
function ownedChildren(block) {
	const rows = block?.blockable?.entities;
	if (!Array.isArray(rows)) return [];
	return sortBundleChildrenInPlace(rows);
}

/**
 * Give every sibling a contiguous `position`, and mark each one dirty.
 *
 * Renumbering the WHOLE set is not tidiness. Every live child is `position: 0` and
 * there is no value below zero, so moving the last row to the front cannot be
 * expressed by writing that one row. And each renumbered row must be marked dirty or
 * `dirtyEntityPatches` emits none of them and the drag is silently dropped.
 */
function renumber(draft, block) {
	// The RAW array, deliberately: it has just been spliced into the new order, and
	// `ownedChildren` would re-sort it by the OLD positions and undo the move.
	const rows = Array.isArray(block?.blockable?.entities) ? block.blockable.entities : [];
	rows.forEach((child, index) => {
		if (!child?.id) return;
		if (child.position !== index) {
			child.position = index;
			draft.dirtyEntityIds.add(child.id);
		}
	});
}

/**
 * Add a child to a bundle. It is created by its own leg, so it carries a temp id
 * until then — but unlike an `array_ref` row there is no parent array to keep it out
 * of, so it lives in the block where the editor can see it.
 *
 * @param {AdminPageDraft} draft
 * @param {string | null | undefined} blockId
 * @param {string} childType the entity type SLUG
 * @param {Record<string, unknown>} [fieldsData]
 * @returns {{ id: string } | null}
 */
export function addBundleEntity(draft, blockId, childType, fieldsData = {}) {
	const block = findBlock(draft, blockId);
	if (!isBundleBlock(block) || !block.blockable) return null;
	if (typeof childType !== 'string' || !childType) return null;
	if (!Array.isArray(block.blockable.entities)) block.blockable.entities = [];
	const child = {
		id: nextTempId('bundle-child'),
		childType,
		position: block.blockable.entities.length,
		fields_data: fieldsData && typeof fieldsData === 'object' ? { ...fieldsData } : {}
	};
	block.blockable.entities.push(child);
	draft.structureDirty = true;
	return child;
}

/**
 * Remove a child. A stored row is destroyed with the page save; a temp one just goes.
 *
 * @param {AdminPageDraft} draft
 * @param {string | null | undefined} blockId
 * @param {string} childId
 * @returns {boolean}
 */
export function removeBundleEntity(draft, blockId, childId) {
	const block = findBlock(draft, blockId);
	if (!isBundleBlock(block) || !block.blockable) return false;
	const rows = ownedChildren(block);
	const at = rows.findIndex((row) => row?.id === childId);
	if (at === -1) return false;
	const [removed] = rows.splice(at, 1);
	if (!isTempId(`${removed.id}`)) {
		if (!Array.isArray(block.blockable.deleted_entity_ids)) {
			block.blockable.deleted_entity_ids = [];
		}
		block.blockable.deleted_entity_ids.push(removed.id);
	}
	draft.dirtyEntityIds.delete(removed.id);
	// Explicitly: pushing onto `deleted_entity_ids` does not dirty the draft by
	// itself, and without this `savePage` skips the structure PATCH and the removal
	// is silently dropped.
	draft.structureDirty = true;
	renumber(draft, block);
	return true;
}

/**
 * Move a child within its bundle. Renumbers every sibling — see `renumber`.
 *
 * @param {AdminPageDraft} draft
 * @param {string | null | undefined} blockId
 * @param {number} from
 * @param {number} to
 * @returns {boolean}
 */
export function moveBundleEntity(draft, blockId, from, to) {
	const block = findBlock(draft, blockId);
	if (!isBundleBlock(block) || !block.blockable) return false;
	const rows = ownedChildren(block);
	if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
	if (from < 0 || to < 0 || from >= rows.length || to >= rows.length) return false;
	if (from === to) return true;
	const [moved] = rows.splice(from, 1);
	rows.splice(to, 0, moved);
	renumber(draft, block);
	return true;
}

/**
 * Set a field on one of a bundle's children.
 *
 * @param {AdminPageDraft} draft
 * @param {string | null | undefined} blockId
 * @param {string} childId
 * @param {string} fieldName
 * @param {unknown} value
 * @returns {boolean}
 */
export function setBundleEntityField(draft, blockId, childId, fieldName, value) {
	const block = findBlock(draft, blockId);
	if (!isBundleBlock(block) || !block.blockable) return false;
	if (typeof fieldName !== 'string' || !fieldName) return false;
	const child = ownedChildren(block).find((row) => row?.id === childId);
	if (!child) return false;
	if (!child.fields_data || typeof child.fields_data !== 'object') child.fields_data = {};
	child.fields_data[fieldName] = value;
	// A temp child is created by its own leg and carries its fields there; only a
	// stored one goes through the dirty-entity patch.
	if (!isTempId(`${child.id}`)) draft.dirtyEntityIds.add(child.id);
	return true;
}

/** The children a save must CREATE, with the block that owns them. */
export function newBundleEntities(draft) {
	const out = [];
	for (const block of draft.page.blocks) {
		if (!isBundleBlock(block)) continue;
		for (const child of ownedChildren(block)) {
			if (isTempId(`${child.id}`)) out.push({ blockId: block.id, ...child });
		}
	}
	return out;
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

/**
 * The only three values Apex accepts, and it ENFORCES them.
 *
 * `auto_collection.rb` validates `kind` for inclusion, and `Cms::PageBlock` declares
 * `validates_associated :blockable` — so a bad kind 422s the WHOLE page save, not
 * just this block. That makes it the one field here worth validating most: `ref_name`
 * is unvalidated upstream and its worst case is a band that renders nothing, while a
 * bad `kind` means nothing on the page saves at all.
 */
export const COLLECTION_KINDS = Object.freeze(['archetype', 'entity_type', 'model']);

/** @param {AdminPageBlock | null | undefined} block */
export function isCollectionBlock(block) {
	return block?.blockable_type === COLLECTION_BLOCKABLE;
}

/**
 * Is this list entry complete enough to write three fields from?
 *
 * A half-built entry would let a switch write a good `ref_name` beside a missing
 * label and an undefined count — three fields, one of them wrong, atomically.
 *
 * @param {CollectionSource | null | undefined} source
 */
function isUsableSource(source) {
	if (!source || typeof source !== 'object') return false;
	if (typeof source.refName !== 'string' || !source.refName) return false;
	if (typeof source.label !== 'string' || !source.label) return false;
	// Required, not optional: the screens read omission as "no count control" while a
	// mutation would have read it as "counts are fine", which is the kind of drift that
	// only shows up on the third consumer.
	if (source.itemCount !== 'count' && source.itemCount !== 'none') return false;
	if (source.minCount !== undefined && !Number.isInteger(source.minCount)) return false;
	// `0` is MEANINGFUL, not unset: on one site it selects the search-and-filter view.
	return Number.isInteger(source.defaultCount) && source.defaultCount >= 0;
}

/**
 * The source an editor may point a band AT — exact `refName` only.
 *
 * Aliases are deliberately not accepted here: they are spellings already out there
 * that the renderer must keep reading, not values this admin offers. One canonical
 * spelling per source is what lets a site test assert its renderer branches and its
 * source list match with nothing left over.
 *
 * The FIRST USABLE match wins rather than the first match: a malformed duplicate
 * earlier in a site's list would otherwise make a perfectly good source unauthorable,
 * with no signal to the editor beyond a missing card.
 *
 * @param {readonly CollectionSource[] | null | undefined} sources
 * @param {unknown} refName
 * @returns {CollectionSource | null}
 */
function resolveTarget(sources, refName) {
	if (!Array.isArray(sources) || typeof refName !== 'string' || !refName) return null;
	return sources.filter((source) => source?.refName === refName).find(isUsableSource) ?? null;
}

/**
 * A stored `ref_name`, in the spelling this comparison works in.
 *
 * Apex stores whatever was written: `team member`, `team_member`, `Focus-Area`. Both
 * sites already normalise the same way before dispatching, so the kit has to as well
 * — matching the raw string here made `setCollectionItemCount` return false for an
 * underscored band whose panel the site had already decided to show, which reads as a
 * "How many" box that silently does nothing.
 *
 * @param {unknown} value
 */
function normalizeRef(value) {
	return String(value ?? '')
		.toLowerCase()
		.trim()
		.replace(/[_-]+/gu, ' ')
		.replace(/\s+/gu, ' ');
}

/**
 * The source a STORED `ref_name` belongs to — canonical spelling or alias.
 *
 * This is the comparison half, and it has to accept aliases where `resolveTarget`
 * must not. A band stored as `member` IS the `team member` source; without this the
 * kit would read "switch to team member" as a change, rewrite the row, and reset a
 * count the editor never touched — while the dropdown showed that source as already
 * selected. Alias knowledge lives here rather than in three sites, which is the
 * whole reason the list is passed in.
 *
 * @param {readonly CollectionSource[] | null | undefined} sources
 * @param {unknown} refName
 * @returns {CollectionSource | null}
 */
function resolveStored(sources, refName) {
	if (!Array.isArray(sources)) return null;
	const wanted = normalizeRef(refName);
	if (!wanted) return null;
	return (
		sources
			.filter(
				(source) =>
					normalizeRef(source?.refName) === wanted ||
					(Array.isArray(source?.aliases) &&
						source.aliases.some((alias) => normalizeRef(alias) === wanted))
			)
			.find(isUsableSource) ?? null
	);
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
	const source = resolveTarget(sources, refName);
	if (!source) return null;
	// `options` is guarded rather than defaulted: `= {}` fires only on `undefined`, and
	// every other refusal in this file survives a caller passing null.
	const kind = (options && typeof options === 'object' && options.kind) || 'archetype';
	// The field Apex actually enforces. A bad value here 422s the whole page save.
	if (!COLLECTION_KINDS.includes(kind)) return null;
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
			item_count: source.defaultCount,
			// Measured 2026-09-22: all nine live bands across both sites carry exactly
			// this, and it is what the old admin's create path wrote. Apex treats null
			// identically (`sort_expression || ["created_at desc"]`) and neither site
			// calls the code that reads it — but a band an editor adds should be
			// indistinguishable from one that was already there.
			sort_expression: ['created_at desc']
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
 * Takes the source list too, and REFUSES a source that declares `itemCount: 'none'`.
 * That is not symmetry for its own sake: on one site this field is a mode switch
 * rather than a limit — `item_count` of 0 renders a search-and-filter view and any
 * positive value replaces it with a capped grid — so writing a count there deletes a
 * live search box. Leaving that to each site's screen would make the one operation
 * that can destroy a page's behaviour the only unguarded one.
 *
 * @param {AdminPageDraft} draft
 * @param {string | null | undefined} blockId
 * @param {unknown} count
 * @param {readonly CollectionSource[]} sources
 * @returns {boolean}
 */
export function setCollectionItemCount(draft, blockId, count, sources) {
	const block = findBlock(draft, blockId);
	if (!isCollectionBlock(block) || !block.blockable || typeof block.blockable !== 'object')
		return false;
	if (!Number.isInteger(count) || /** @type {number} */ (count) < 0) return false;
	const source = resolveStored(sources, block.blockable.ref_name);
	if (!source || source.itemCount === 'none') return false;
	// A site's own floor. On one site 0 means "show them all"; on the other the loader
	// reads 0 as unset and substitutes a default, so a 0 there is a control that says
	// one thing and does another.
	if (Number.isInteger(source.minCount) && count < source.minCount) return false;
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
	const source = resolveTarget(sources, refName);
	if (!source) return false;
	// Compared through the SOURCE, not through the raw string. A band stored under an
	// alias (`member`) already IS the `team member` source, and the dropdown shows it
	// as selected — so re-picking it must be a no-op. Comparing strings instead made
	// that re-pick rewrite the row and reset a count the editor never touched.
	if (resolveStored(sources, block.blockable.ref_name) === source) return true;
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
 * Page SEO has its own save leg (save-page.js), so it stays out of the structure
 * payload. Match setPostField: returning to the stored value removes the edit.
 * Only description renders on both sites (phase-4-plan.md §1.5).
 *
 * @param {AdminPageDraft} draft
 * @param {'description'} name
 * @param {string} value
 * @returns {boolean}
 */
export function setPageMeta(draft, name, value) {
	if (name !== 'description') return false;
	const baseline =
		draft.page.meta_properties?.find((row) => row?.group === 'web' && row.name === name)?.value ??
		'';
	if (value === baseline) delete draft.metaEdits[name];
	else draft.metaEdits[name] = value;
	return true;
}

/**
 * Is there anything to save?
 *
 * This is what the Save button is enabled by, so anything it does not count is
 * UNSAVEABLE — the editor makes the change, the button stays grey, and the only way
 * out is to leave the page and lose it.
 *
 * ── THE TWO COLLECTIONS IT USED TO MISS ─────────────────────────────────────
 * `listChildren` and `listChildEdits` live beside the page rather than in it — an
 * `array_ref` row is a FREE-STANDING entity, so adding one changes no block and
 * editing one marks no entity on the tree dirty. Neither flag moved, so the whole
 * repeatable feature was unusable: add a row, type into it, and Save stayed
 * disabled.
 *
 * Found by the browser gate on 2026-09-22, not by the suite — and it could not have
 * been found by the suite, because the unit tests call `savePage` directly and never
 * ask whether the button that reaches it is enabled. The bundle operations were
 * never affected: a bundle OWNS its children, so `addBundleEntity` sets
 * `structureDirty` and `setBundleEntityField` marks the child's own entity dirty.
 *
 * @param {AdminPageDraft} draft
 * @returns {boolean}
 */
export function isDirty(draft) {
	return (
		draft.dirtyEntityIds.size > 0 ||
		draft.structureDirty ||
		draft.deletedBlockIds.length > 0 ||
		Object.keys(draft.metaEdits).length > 0 ||
		newListChildren(draft).length > 0 ||
		editedListChildren(draft).length > 0
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
		// A bundle OWNS its children, so a field edit on one rides the dirty-entity leg.
		// List children are deliberately NOT here: those are free-standing, written by
		// their own leg, and collecting them would write each row twice.
		const owned = block.blockable?.entities;
		if (Array.isArray(owned)) {
			for (const child of owned) if (child?.id) entities.set(child.id, child);
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
		const patch = {
			entityTypeId: entity.entity_type_id,
			entityId: entity.id,
			fields_data: clone(entity.fields_data || {})
		};
		// A bundle child's row order lives on the row. `position` can never travel
		// without `fields_data` — the entities route assigns both in one call and a
		// bare `{position}` body is a 500 — so it rides this patch rather than a leg
		// of its own.
		if (Number.isInteger(entity.position)) patch.position = entity.position;
		patches.push(patch);
	}
	return patches;
}

/**
 * The `blocks_attributes` + page-fields payload for the structure save.
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
 * @param {Record<string, Record<string, { id: string, fields: Record<string, unknown> }[]>>} [childRows]
 *   Fresh hydrated rows, when the caller has them. OMITTED keeps the ones already on
 *   the draft — a page read-back that does not carry rows must not blank them.
 * @returns {void}
 */
export function reconcile(draft, serverPage, version, childRows) {
	draft.page = clone(serverPage);
	if (!Array.isArray(draft.page.blocks)) draft.page.blocks = [];
	sortBlocks(draft);
	draft.dirtyEntityIds = new Set();
	draft.structureDirty = false;
	draft.deletedBlockIds = [];
	draft.metaEdits = {};
	// Or a row whose create already landed is created a SECOND time on the next save:
	// `reconcile` replaces `draft.page` wholesale and resets every other flag, so a
	// temp row left here would look new again.
	draft.listChildren = {};
	draft.listChildEdits = {};
	// Only when the caller HAS fresh rows. `savePage` reconciles from a page read-back
	// that may not carry them, and blanking the baseline there would turn every
	// existing row into "(empty)" the instant a save succeeded.
	if (childRows && typeof childRows === 'object') draft.childRows = clone(childRows);
	if (version) draft.baselineVersion = version;
	draft.pageId = draft.page.id;
}
