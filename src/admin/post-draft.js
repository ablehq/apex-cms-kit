//
// The local draft behind a POST editor — an update, a story, an article — in the
// shape `entity-draft.js` established: edits mutate THIS, not Apex; there is no
// autosave, no debounce and no coordinator; a single explicit save
// (`save-post.js`) reads the dirty state off a draft and writes it, in the one
// order that is safe for three records.
//
// A post is THREE Apex records, so the dirty state is per STAGE, and each stage
// is what one BFF route writes:
//
//   fields      → PATCH …/posts/:schema/:id            title, slug, summary,
//                                                      publishedDate, the SEO
//                                                      triple, the cover
//   body        → PUT   …/posts/:schema/:id/body       the document blocks
//   archetype   → PUT   …/posts/:schema/:id/archetype  primitives (kind) and
//                                                      references
//   tags        → PUT   …/posts/:schema/:id/tags       the desired tag set
//
// Two rules survive from the record draft because they are the dangerous ones:
// a PRIMITIVE can never be set to `null` (it destroys the row upstream and
// strands the old value where the public site reads it — clearing is `''`), and
// references are held as ORDERED ID SETS, never as join rows: the BFF diffs a
// has_many against a fresh read, so the two id spaces never meet here.

/**
 * @typedef {import('./entity-draft.js').EntityContract} EntityContract
 * @typedef {{ id: string | null, kind: 'rich_text' | 'quote', html?: string, quote?: string, quotedBy?: string }} PostBlock
 * @typedef {{
 *   id?: string,
 *   title?: string,
 *   slug?: string,
 *   summary?: string,
 *   publishedDate?: string,
 *   status?: string,
 *   fields?: Record<string, any>,
 *   references?: Record<string, { itemId: string, targetId: string }[]>,
 *   tags?: { id: string, tagId: string, tagName: string }[],
 *   coverId?: string | null,
 *   meta?: { title?: string, description?: string, keywords?: string },
 *   blocks?: PostBlock[]
 * }} PostRecord
 * @typedef {{
 *   schemaSlug: string,
 *   contract: EntityContract,
 *   postId: string,
 *   baselineVersion: string,
 *   post: PostRecord,
 *   fields: Record<string, string>,
 *   baselineFields: Record<string, string>,
 *   dirtyFields: Set<string>,
 *   coverId: string | null,
 *   baselineCoverId: string | null,
 *   coverDirty: boolean,
 *   archetypeFields: Record<string, any>,
 *   baselineArchetypeFields: Record<string, any>,
 *   dirtyArchetypeFields: Set<string>,
 *   references: Record<string, any>,
 *   baselineReferences: Record<string, any>,
 *   dirtyReferences: Set<string>,
 *   tagIds: string[],
 *   baselineTagIds: string[],
 *   tagsDirty: boolean,
 *   blocks: PostBlock[],
 *   baselineBlocks: PostBlock[],
 *   bodyDirty: boolean
 * }} PostDraft
 */

import { sameValue } from './entity-draft.js';

/**
 * The post's own writable fields. The first four are `Cms::Post` columns; the
 * three `meta*` are the SEO triple Apex mints in the `web` group at create time.
 * One map because they are one form and one save; `postFieldsPatch` splits them
 * back apart for the route.
 */
export const POST_FIELDS = [
	'title',
	'slug',
	'summary',
	'publishedDate',
	'metaTitle',
	'metaDescription',
	'metaKeywords'
];

/** Every post field is a string. `null` and `undefined` become `''`. */
/** @param {unknown} value */
function text(value) {
	if (typeof value === 'string') return value;
	if (value === null || value === undefined) return '';
	return String(value);
}

/** @param {any} value @returns {any} */
function clone(value) {
	try {
		return structuredClone(value);
	} catch {
		return JSON.parse(JSON.stringify(value));
	}
}

/** @param {string[]} a @param {string[]} b */
function sameIdSet(a, b) {
	if (a.length !== b.length) return false;
	const held = new Set(a);
	return b.every((id) => held.has(id));
}

/**
 * Build a draft from a loaded post and its stale-guard baseline.
 *
 * @param {string} schemaSlug the post archetype schema slug, e.g. 'story'
 * @param {PostRecord} post
 * @param {string} version
 * @param {EntityContract} contract the site's content contract
 * @returns {PostDraft}
 */
export function createPostDraft(schemaSlug, post, version, contract) {
	if (!contract) throw new Error('createPostDraft needs the site content contract');
	if (!contract.schema(schemaSlug)) throw new Error(`unknown schema: ${schemaSlug}`);
	const meta = post?.meta ?? {};
	const fields = {
		title: text(post?.title),
		slug: text(post?.slug),
		summary: text(post?.summary),
		publishedDate: text(post?.publishedDate),
		metaTitle: text(meta.title),
		metaDescription: text(meta.description),
		metaKeywords: text(meta.keywords)
	};

	/** @type {Record<string, any>} */
	const archetypeFields = {};
	for (const def of contract.primitiveFieldDefs(schemaSlug)) {
		const value = post?.fields ? post.fields[def.field_name] : undefined;
		archetypeFields[def.field_name] = value === undefined || value === null ? '' : clone(value);
	}

	/** @type {Record<string, any>} */
	const references = {};
	for (const item of contract.referenceItems(schemaSlug)) {
		const held = post?.references ? (post.references[item.name] ?? []) : [];
		references[item.name] =
			item.relationship_kind === 'has_many'
				? held.map((entry) => entry.targetId)
				: (held[0]?.targetId ?? null);
	}

	const tagIds = Array.isArray(post?.tags) ? post.tags.map((tag) => tag.tagId) : [];
	const blocks = Array.isArray(post?.blocks) ? clone(post.blocks) : [];
	const coverId = post?.coverId ?? null;

	return {
		schemaSlug,
		contract,
		postId: post?.id ?? '',
		baselineVersion: version ?? '',
		post: clone(post ?? {}),
		fields,
		baselineFields: { ...fields },
		dirtyFields: new Set(),
		coverId,
		baselineCoverId: coverId,
		coverDirty: false,
		archetypeFields,
		baselineArchetypeFields: clone(archetypeFields),
		dirtyArchetypeFields: new Set(),
		references,
		baselineReferences: clone(references),
		dirtyReferences: new Set(),
		tagIds,
		baselineTagIds: [...tagIds],
		tagsDirty: false,
		blocks,
		baselineBlocks: clone(blocks),
		bodyDirty: false
	};
}

/**
 * Set one of the post's own fields. Returns false for a name outside `POST_FIELDS`.
 * @param {PostDraft} draft @param {string} name @param {unknown} value
 */
export function setPostField(draft, name, value) {
	if (!draft || !POST_FIELDS.includes(name)) return false;
	const next = text(value);
	draft.fields[name] = next;
	if (next === draft.baselineFields[name]) draft.dirtyFields.delete(name);
	else draft.dirtyFields.add(name);
	return true;
}

/**
 * Point the post at a cover gallery item, or at none. `null` is CORRECT here: the
 * cover is a reference to a gallery item, and destroying the row is the only way
 * to say "no cover".
 * @param {PostDraft} draft @param {string | null} coverId
 */
export function setPostCover(draft, coverId) {
	draft.coverId = coverId || null;
	draft.coverDirty = draft.coverId !== draft.baselineCoverId;
}

/**
 * Set one archetype primitive (a story's `kind`). Refuses a name the contract does
 * not have; `null` becomes `''`, the safe clear.
 * @param {PostDraft} draft @param {string} name @param {unknown} value
 */
export function setPostArchetypeField(draft, name, value) {
	if (!draft || !Object.prototype.hasOwnProperty.call(draft.archetypeFields, name)) return false;
	const next = value === null || value === undefined ? '' : value;
	draft.archetypeFields[name] = clone(next);
	if (sameValue(draft.archetypeFields[name], draft.baselineArchetypeFields[name])) {
		draft.dirtyArchetypeFields.delete(name);
	} else {
		draft.dirtyArchetypeFields.add(name);
	}
	return true;
}

/**
 * Set a reference relation: a has_many takes the full desired id set, a has_one
 * an id or `null` (the one legitimate null on a reference).
 * @param {PostDraft} draft @param {string} name @param {any} value
 */
export function setPostReference(draft, name, value) {
	if (!draft || !Object.prototype.hasOwnProperty.call(draft.references, name)) return false;
	const item = draft.contract.referenceItems(draft.schemaSlug).find((entry) => entry.name === name);
	if (!item) return false;
	if (item.relationship_kind === 'has_many') {
		const next = Array.isArray(value) ? [...new Set(value.filter(Boolean))] : [];
		draft.references[name] = next;
		if (sameIdSet(next, draft.baselineReferences[name] ?? [])) draft.dirtyReferences.delete(name);
		else draft.dirtyReferences.add(name);
		return true;
	}
	const next = value || null;
	draft.references[name] = next;
	if (next === (draft.baselineReferences[name] ?? null)) draft.dirtyReferences.delete(name);
	else draft.dirtyReferences.add(name);
	return true;
}

/**
 * Replace the desired tag set. The FULL set, never a diff — the BFF reconciles.
 * @param {PostDraft} draft @param {string[]} tagIds
 */
export function setPostTags(draft, tagIds) {
	const next = Array.isArray(tagIds) ? [...new Set(tagIds.filter(Boolean))] : [];
	draft.tagIds = next;
	draft.tagsDirty = !sameIdSet(next, draft.baselineTagIds);
}

/**
 * Replace the body. The document write is the whole body, in order, so this takes
 * the full array rather than a per-block setter.
 * @param {PostDraft} draft @param {PostBlock[]} blocks
 */
export function setPostBlocks(draft, blocks) {
	draft.blocks = Array.isArray(blocks) ? clone(blocks) : [];
	draft.bodyDirty = JSON.stringify(draft.blocks) !== JSON.stringify(draft.baselineBlocks);
}

/** @param {PostDraft} draft */
export function isPostDirty(draft) {
	return (
		Boolean(draft) &&
		(draft.dirtyFields.size > 0 ||
			draft.coverDirty ||
			draft.dirtyArchetypeFields.size > 0 ||
			draft.dirtyReferences.size > 0 ||
			draft.tagsDirty ||
			draft.bodyDirty)
	);
}

/**
 * The `PATCH …/posts/:schema/:id` body — only what changed. `meta` appears only
 * when an SEO field moved, and then carries only the moved ones; `coverId` only
 * when the cover moved.
 * @param {PostDraft} draft
 * @returns {Record<string, unknown>}
 */
export function postFieldsPatch(draft) {
	/** @type {Record<string, unknown>} */
	const patch = {};
	for (const name of ['title', 'slug', 'summary', 'publishedDate']) {
		if (draft.dirtyFields.has(name)) patch[name] = text(draft.fields[name]);
	}
	/** @type {Record<string, string>} */
	const meta = {};
	if (draft.dirtyFields.has('metaTitle')) meta.title = text(draft.fields.metaTitle);
	if (draft.dirtyFields.has('metaDescription'))
		meta.description = text(draft.fields.metaDescription);
	if (draft.dirtyFields.has('metaKeywords')) meta.keywords = text(draft.fields.metaKeywords);
	if (Object.keys(meta).length > 0) patch.meta = meta;
	if (draft.coverDirty) patch.coverId = draft.coverId;
	return patch;
}

/** @param {PostDraft} draft */
export function hasPostFieldChanges(draft) {
	return Object.keys(postFieldsPatch(draft)).length > 0;
}

/**
 * The `PUT …/posts/:schema/:id/archetype` body — dirty primitives and changed
 * reference selections, in the record update's shape.
 * @param {PostDraft} draft
 * @returns {Record<string, unknown>}
 */
export function postArchetypePatch(draft) {
	/** @type {Record<string, any>} */
	const fields = {};
	for (const def of draft.contract.primitiveFieldDefs(draft.schemaSlug)) {
		if (draft.dirtyArchetypeFields.has(def.field_name)) {
			fields[def.field_name] = draft.archetypeFields[def.field_name];
		}
	}
	/** @type {Record<string, any>} */
	const references = {};
	for (const item of draft.contract.referenceItems(draft.schemaSlug)) {
		if (draft.dirtyReferences.has(item.name)) references[item.name] = draft.references[item.name];
	}
	/** @type {Record<string, unknown>} */
	const patch = {};
	if (Object.keys(fields).length > 0) patch.fields = fields;
	if (Object.keys(references).length > 0) patch.references = references;
	return patch;
}

/** @param {PostDraft} draft */
export function hasPostArchetypeChanges(draft) {
	return Object.keys(postArchetypePatch(draft)).length > 0;
}

/**
 * Re-baseline after a successful save: adopt the server's post and version, and
 * clear every dirty set.
 * @param {PostDraft} draft @param {PostRecord} post @param {string} version
 */
export function reconcilePost(draft, post, version) {
	const fresh = createPostDraft(
		draft.schemaSlug,
		post,
		version || draft.baselineVersion,
		draft.contract
	);
	draft.postId = fresh.postId || draft.postId;
	draft.post = fresh.post;
	draft.fields = fresh.fields;
	draft.baselineFields = fresh.baselineFields;
	draft.dirtyFields = new Set();
	draft.coverId = fresh.coverId;
	draft.baselineCoverId = fresh.baselineCoverId;
	draft.coverDirty = false;
	draft.archetypeFields = fresh.archetypeFields;
	draft.baselineArchetypeFields = fresh.baselineArchetypeFields;
	draft.dirtyArchetypeFields = new Set();
	draft.references = fresh.references;
	draft.baselineReferences = fresh.baselineReferences;
	draft.dirtyReferences = new Set();
	draft.tagIds = fresh.tagIds;
	draft.baselineTagIds = fresh.baselineTagIds;
	draft.tagsDirty = false;
	draft.blocks = fresh.blocks;
	draft.baselineBlocks = fresh.baselineBlocks;
	draft.bodyDirty = false;
	if (version) draft.baselineVersion = version;
}
