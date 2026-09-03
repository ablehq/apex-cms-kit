// @ts-nocheck — legacy-mode admin browser module (plan §8, 3a compile-mode (a)).
// Deliberately untyped JS to sit beside the legacy-compiled admin components; its
// behavior is covered by tests/admin-save-entity.test.js.
//
// The local draft for the three phase-3d entities, in the shape `page-draft.js`
// already established: edits mutate THIS, not Apex; there is no autosave, no
// debounce and no coordinator; a single explicit save (`save-entity.js`) reads the
// dirty set off a draft and writes it. Plain object graphs, so the whole model is
// unit-testable without a DOM or a network.
//
// Two rules are enforced HERE rather than left to each screen, because both are
// invisible when you get them wrong:
//
//   1. EVERY VALUE IS A STRING. `null` is coerced to `''` on the way in and can
//      never be produced on the way out. Sending `null` for a primitive field
//      destroys the archetype_item row upstream AND leaves the old value stranded
//      in `archetype.primitives` — the exact key the public site renders — so the
//      admin would show the field empty while the site kept serving the deleted
//      text, indefinitely. `''` is the safe clear. The one legitimate `null` in 3d
//      is an article's AUTHOR, which is a reference, not a primitive, and it has
//      its own setter below that says so.
//
//   2. ONLY KNOWN FIELD NAMES. The field lists are the schemas from
//      `cms_template.rb`, and a name outside them is refused rather than written.
//      The BFF's zod schemas are `.strict()`, so an unknown key is a 400 — better
//      to fail in the draft, where the caller can see which name was wrong.

/**
 * @typedef {import('./types').AdminEntityDraft} AdminEntityDraft
 * @typedef {import('./types').AdminArticleDraft} AdminArticleDraft
 * @typedef {import('./types').AdminContentKind} AdminContentKind
 */

/** The content-library schemas, field for field (`cms_template.rb`). */
const CONTENT_FIELDS = {
	author: ['name', 'designation'],
	resource: ['type', 'title', 'description', 'url']
};

/**
 * An article's writable fields. The first four are `Cms::Post` columns; the three
 * `meta*` are the SEO triple Apex auto-creates in the `web` group at create time.
 * They live in ONE map because they are one form and one save; `articleFieldsPatch`
 * splits them back apart for the route.
 */
const ARTICLE_FIELDS = [
	'title',
	'slug',
	'summary',
	'publishedDate',
	'metaTitle',
	'metaDescription',
	'metaKeywords'
];

/** Every value in a draft is a string. `null` and `undefined` become `''`. */
function text(value) {
	if (typeof value === 'string') return value;
	if (value === null || value === undefined) return '';
	return String(value);
}

function clone(value) {
	return structuredClone(value);
}

/** @param {AdminContentKind} kind */
export function entityFieldNames(kind) {
	return CONTENT_FIELDS[kind] ? [...CONTENT_FIELDS[kind]] : [];
}

/**
 * Build a draft from a loaded author/resource and its stale-guard baseline.
 *
 * @param {AdminContentKind} kind
 * @param {Record<string, unknown>} record
 * @param {string} version
 * @returns {AdminEntityDraft}
 */
export function createEntityDraft(kind, record, version) {
	const names = CONTENT_FIELDS[kind];
	if (!names) throw new Error(`unknown entity kind: ${kind}`);
	const fields = {};
	for (const name of names) fields[name] = text(record ? record[name] : '');
	return {
		kind,
		entityId: record?.id ?? '',
		baselineVersion: version ?? '',
		fields,
		baselineFields: { ...fields },
		dirtyFields: new Set()
	};
}

/**
 * Set one field. Returns false for a name the schema does not have, so a typo in a
 * form descriptor surfaces as a field that will not accept input rather than as a
 * 400 on save.
 *
 * A value edited back to what it was is no longer dirty — the save then sends
 * nothing for it, and the Save button goes back to disabled, which is the M1
 * contract ("disabled until dirty") behaving honestly.
 *
 * @param {AdminEntityDraft} draft
 * @param {string} name
 * @param {unknown} value
 * @returns {boolean}
 */
export function setEntityField(draft, name, value) {
	if (!draft || !Object.prototype.hasOwnProperty.call(draft.fields, name)) return false;
	const next = text(value);
	draft.fields[name] = next;
	if (next === draft.baselineFields[name]) draft.dirtyFields.delete(name);
	else draft.dirtyFields.add(name);
	return true;
}

/** @param {AdminEntityDraft} draft */
export function isEntityDirty(draft) {
	return Boolean(draft) && draft.dirtyFields.size > 0;
}

/**
 * The PATCH body: only the fields that actually changed, in schema order. Every
 * value is a string, so this cannot express the destructive `null`.
 *
 * @param {AdminEntityDraft} draft
 * @returns {Record<string, string>}
 */
export function entityPatch(draft) {
	const patch = {};
	for (const name of CONTENT_FIELDS[draft.kind] ?? []) {
		if (draft.dirtyFields.has(name)) patch[name] = text(draft.fields[name]);
	}
	return patch;
}

/**
 * Re-baseline after a successful save: adopt the server's record and version, and
 * clear the dirty set.
 *
 * @param {AdminEntityDraft} draft
 * @param {Record<string, unknown>} record
 * @param {string} version
 */
export function reconcileEntity(draft, record, version) {
	for (const name of CONTENT_FIELDS[draft.kind] ?? []) {
		draft.fields[name] = text(record ? record[name] : '');
	}
	draft.baselineFields = { ...draft.fields };
	draft.dirtyFields = new Set();
	if (version) draft.baselineVersion = version;
	if (record?.id) draft.entityId = record.id;
}

// ── Articles ────────────────────────────────────────────────────────────────
//
// An article is THREE records — a `Cms::Post`, the archetype that carries the
// author reference, and a document that carries the body — so the dirty state is
// per STAGE. That is what lets one save write only what changed, in the one order
// that is safe, and stop at the first failure.

/**
 * @param {import('./types').AdminArticle} article
 * @param {string} version
 * @returns {AdminArticleDraft}
 */
export function createArticleDraft(article, version) {
	const meta = article?.meta ?? {};
	const fields = {
		title: text(article?.title),
		slug: text(article?.slug),
		summary: text(article?.summary),
		publishedDate: text(article?.publishedDate),
		metaTitle: text(meta.title),
		metaDescription: text(meta.description),
		metaKeywords: text(meta.keywords)
	};
	const blocks = Array.isArray(article?.blocks) ? clone(article.blocks) : [];
	return {
		articleId: article?.id ?? '',
		baselineVersion: version ?? '',
		article: clone(article ?? {}),
		fields,
		baselineFields: { ...fields },
		dirtyFields: new Set(),
		authorId: article?.authorId ?? null,
		baselineAuthorId: article?.authorId ?? null,
		blocks,
		baselineBlocks: clone(blocks),
		authorDirty: false,
		bodyDirty: false
	};
}

/**
 * @param {AdminArticleDraft} draft
 * @param {string} name one of ARTICLE_FIELDS
 * @param {unknown} value
 * @returns {boolean}
 */
export function setArticleField(draft, name, value) {
	if (!draft || !ARTICLE_FIELDS.includes(name)) return false;
	const next = text(value);
	draft.fields[name] = next;
	if (next === draft.baselineFields[name]) draft.dirtyFields.delete(name);
	else draft.dirtyFields.add(name);
	return true;
}

/**
 * Point the article at an author, or at none. `null` is CORRECT here and nowhere
 * else in this module: the author is a reference, and destroying the reference item
 * is the only way to say "this article has no author".
 *
 * @param {AdminArticleDraft} draft
 * @param {string | null} authorId
 */
export function setArticleAuthorId(draft, authorId) {
	draft.authorId = authorId || null;
	draft.authorDirty = draft.authorId !== draft.baselineAuthorId;
}

/**
 * Replace the body. The document PATCH rebuilds Apex's block list from what it is
 * sent, so the whole body travels every time and a partial list would delete the
 * rest — which is why this takes the full array rather than a per-block setter.
 *
 * @param {AdminArticleDraft} draft
 * @param {import('./types').AdminArticleBlock[]} blocks
 */
export function setArticleBlocks(draft, blocks) {
	draft.blocks = Array.isArray(blocks) ? clone(blocks) : [];
	draft.bodyDirty = JSON.stringify(draft.blocks) !== JSON.stringify(draft.baselineBlocks);
}

/** @param {AdminArticleDraft} draft */
export function isArticleDirty(draft) {
	return Boolean(draft) && (draft.dirtyFields.size > 0 || draft.authorDirty || draft.bodyDirty);
}

/**
 * The `PATCH /api/admin/articles/:id` body — only what changed. `meta` appears only
 * when one of the three SEO fields moved, and then carries only the moved ones.
 *
 * @param {AdminArticleDraft} draft
 * @returns {Record<string, unknown>}
 */
export function articleFieldsPatch(draft) {
	const patch = {};
	for (const name of ['title', 'slug', 'summary', 'publishedDate']) {
		if (draft.dirtyFields.has(name)) patch[name] = text(draft.fields[name]);
	}
	const meta = {};
	if (draft.dirtyFields.has('metaTitle')) meta.title = text(draft.fields.metaTitle);
	if (draft.dirtyFields.has('metaDescription'))
		meta.description = text(draft.fields.metaDescription);
	if (draft.dirtyFields.has('metaKeywords')) meta.keywords = text(draft.fields.metaKeywords);
	if (Object.keys(meta).length > 0) patch.meta = meta;
	return patch;
}

/** True when the post-fields stage has anything to write. */
export function hasArticleFieldChanges(draft) {
	return Object.keys(articleFieldsPatch(draft)).length > 0;
}

/**
 * @param {AdminArticleDraft} draft
 * @param {import('./types').AdminArticle} article
 * @param {string} version
 */
export function reconcileArticle(draft, article, version) {
	const fresh = createArticleDraft(article, version || draft.baselineVersion);
	draft.articleId = fresh.articleId || draft.articleId;
	draft.article = fresh.article;
	draft.fields = fresh.fields;
	draft.baselineFields = fresh.baselineFields;
	draft.dirtyFields = new Set();
	draft.authorId = fresh.authorId;
	draft.baselineAuthorId = fresh.authorId;
	draft.authorDirty = false;
	draft.blocks = fresh.blocks;
	draft.baselineBlocks = fresh.baselineBlocks;
	draft.bodyDirty = false;
	if (version) draft.baselineVersion = version;
}
