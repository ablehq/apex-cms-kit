// @ts-nocheck — legacy-mode admin browser module (plan §8, 3a compile-mode (a)).
// Deliberately untyped JS to sit beside the legacy-compiled admin components; its
// behavior is covered by tests/admin-save-entity.test.js.
import {
	articleFieldsPatch,
	entityPatch,
	hasArticleFieldChanges,
	reconcileArticle,
	reconcileEntity
} from './entity-draft.js';

// The one explicit save for the three phase-3d entities — `save-page.js`'s
// invariants, unchanged: the stale guard checked ONCE before any write, stop on the
// first partial failure, status LAST and never after a failure, re-baseline at the
// end, no autosave anywhere.
//
// `saveArticle`'s order is not a preference; it falls out of what an article is.
// The three records have to be written on three different endpoints, and the only
// question is what happens when the second one fails:
//
//   1. Stale guard, ONCE — the composite of post + archetype + document versions.
//   2. Post fields   → PATCH /api/admin/articles/:id        (title, slug, summary,
//                                                            publishedDate, meta)
//   3. Author        → PUT   /api/admin/articles/:id/author
//   4. Body          → PUT   /api/admin/articles/:id/body
//   5. Status event  → POST  /api/admin/articles/:id/status   [only if asked]
//   6. Re-baseline.
//
// Status is last and is never dispatched after any earlier failure, because
// publishing a half-saved article is the one outcome worth designing against: it is
// the only failure here that reaches the public site. Everything else leaves a draft
// that is merely behind.
//
// Authors and resources collapse to one PATCH (plus the tag reconciliation for a
// resource), but they keep the same function shape, the same guard and the same
// stop-on-failure rule — so there is one save story in this admin, not three.

export const STALE_MESSAGE =
	'This was changed somewhere else since you opened it. Reload to get the latest version, then re-apply your changes.';

const VERSION_READERS = { author: 'readAuthorVersion', resource: 'readResourceVersion' };
const PATCHERS = { author: 'updateAuthor', resource: 'updateResource' };
const GETTERS = { author: 'getAuthor', resource: 'getResource' };
const RECORD_KEYS = { author: 'author', resource: 'resource' };

function fieldsMessage(status) {
	return status === 422
		? 'A field was rejected (check required values). Fix it and Save again.'
		: 'Saving failed. Nothing was changed — Save again to retry.';
}

/**
 * Save an author or a resource.
 *
 * @param {import('./types').AdminEntityDraft} draft
 * @param {import('./types').BffClient} client the ONLY thing that touches the network
 * @param {{ tagIds?: string[] }} [options] `tagIds` reconciles a resource's tags;
 *   omit it to leave them alone. It is the FULL desired set, not a diff.
 * @returns {Promise<import('./types').SaveEntityResult>}
 */
export async function saveEntity(draft, client, options = {}) {
	const kind = draft.kind;
	const id = draft.entityId;
	const readVersion = VERSION_READERS[kind];
	if (!readVersion) return { ok: false, stage: 'kind', message: `unknown entity kind: ${kind}` };

	// 1. Stale guard — ONCE, before any write. An author or a resource is a single
	// record with no children, so its own `updated_at` is a sufficient token.
	let current;
	try {
		current = await client[readVersion](id);
	} catch {
		return {
			ok: false,
			stage: 'version',
			message: 'Could not check for other changes. Save again to retry.'
		};
	}
	if (current?.version !== draft.baselineVersion) {
		return { ok: false, stale: true, stage: 'version', message: STALE_MESSAGE };
	}

	// 2. The fields — only what changed, and only ever as strings.
	const patch = entityPatch(draft);
	if (Object.keys(patch).length > 0) {
		const res = await client[PATCHERS[kind]](id, patch);
		if (!res.ok) {
			return { ok: false, stage: 'fields', status: res.status, message: fieldsMessage(res.status) };
		}
	}

	// 3. Tags, if the caller is managing them. AFTER the fields, so a rejected field
	// never leaves the tags moved on a record whose text did not save. This one call
	// is idempotent even though Apex's tagging endpoint is not — the server sends the
	// whole desired set and reconciles.
	if (Array.isArray(options.tagIds)) {
		const res = await client.setResourceTags(id, options.tagIds);
		if (!res.ok) {
			return {
				ok: false,
				stage: 'tags',
				status: res.status,
				message: 'Your changes were saved, but the tags were not. Save again to retry the tags.'
			};
		}
	}

	// 4. Re-baseline, so the stale guard's token matches the server again.
	try {
		const fresh = await client[GETTERS[kind]](id);
		reconcileEntity(draft, fresh[RECORD_KEYS[kind]], fresh.version);
	} catch {
		return { ok: true, refreshed: false };
	}
	return { ok: true, refreshed: true };
}

function articleMessage(stage, status) {
	if (stage === 'fields') {
		return status === 422
			? 'A field was rejected — a slug has to be unique. Nothing after it was saved; fix it and Save again.'
			: 'Saving the article failed. Nothing after it was saved — Save again to retry.';
	}
	if (stage === 'author') {
		return 'The author could not be set. Your field edits were saved; Save again to retry.';
	}
	if (stage === 'body') {
		return 'The body could not be saved. Your other changes were saved; Save again to retry.';
	}
	return 'Publishing failed after your changes were saved. Save/Publish again to retry.';
}

/**
 * Save an article. Publish is the SAME function with `statusEvent: 'publish'`.
 *
 * @param {import('./types').AdminArticleDraft} draft
 * @param {import('./types').BffClient} client
 * @param {{ statusEvent?: import('./types').AdminStatusEvent }} [options]
 * @returns {Promise<import('./types').SaveArticleResult>}
 */
export async function saveArticle(draft, client, options = {}) {
	const { statusEvent } = options;
	const id = draft.articleId;

	// 1. Stale guard, ONCE. An article is three records, so the token is a composite
	// of all three `updated_at`s — `post.updated_at` alone would miss a body edit
	// made in another tab, which is the case the guard exists for.
	let current;
	try {
		current = await client.readArticleVersion(id);
	} catch {
		return {
			ok: false,
			stage: 'version',
			message: 'Could not check for other changes. Save again to retry.'
		};
	}
	if (current?.version !== draft.baselineVersion) {
		return { ok: false, stale: true, stage: 'version', message: STALE_MESSAGE };
	}

	// 2. Post fields (title / slug / summary / published date / SEO).
	if (hasArticleFieldChanges(draft)) {
		const res = await client.updateArticle(id, articleFieldsPatch(draft));
		if (!res.ok) {
			return {
				ok: false,
				stage: 'fields',
				status: res.status,
				message: articleMessage('fields', res.status)
			};
		}
	}

	// 3. The author reference. `null` clears it, and clearing is a legitimate edit.
	if (draft.authorDirty) {
		const res = await client.setArticleAuthor(id, draft.authorId);
		if (!res.ok) {
			return {
				ok: false,
				stage: 'author',
				status: res.status,
				message: articleMessage('author', res.status)
			};
		}
	}

	// 4. The body — the whole document, in order.
	if (draft.bodyDirty) {
		const res = await client.saveArticleBody(id, draft.blocks);
		if (!res.ok) {
			return {
				ok: false,
				stage: 'body',
				status: res.status,
				message: articleMessage('body', res.status)
			};
		}
	}

	// 5. Status — only when asked, and only once everything above succeeded. This is
	// the line that keeps a half-saved article off the public site.
	if (statusEvent) {
		const res = await client.changeArticleStatus(id, statusEvent);
		if (!res.ok) {
			return {
				ok: false,
				stage: 'status',
				status: res.status,
				message: articleMessage('status', res.status)
			};
		}
	}

	// 6. Re-baseline.
	try {
		const fresh = await client.getArticle(id);
		reconcileArticle(draft, fresh.article, fresh.version);
	} catch {
		return { ok: true, refreshed: false };
	}
	return { ok: true, refreshed: true };
}
