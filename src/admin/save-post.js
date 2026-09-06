//
// The one explicit save for a post — `save-entity.js`'s invariants, unchanged:
// the stale guard checked ONCE before any write, stop on the first failure,
// status LAST and never after a failure, re-baseline at the end, no autosave.
//
// The ORDER is not a preference; it falls out of what a post is. Its stages are
// written on four different endpoints, and the only question is what happens
// when one of them fails:
//
//   1. Stale guard, ONCE — the composite token over post + archetype + document.
//   2. Post fields  → PATCH …/posts/:schema/:id           (title, slug, summary,
//                                                          publishedDate, SEO, cover)
//   3. Body         → PUT   …/posts/:schema/:id/body
//   4. Archetype    → PUT   …/posts/:schema/:id/archetype (kind, references)
//   5. Tags         → PUT   …/posts/:schema/:id/tags
//   6. Status event → POST  …/posts/:schema/:id/status     [only if asked]
//   7. Re-baseline.
//
// Status is last and is never dispatched after any earlier failure, because
// publishing a half-saved post is the one outcome worth designing against: it is
// the only failure here that reaches the public site. Everything else leaves a
// draft that is merely behind, and the message says which stage it is behind at.

import {
	hasPostArchetypeChanges,
	hasPostFieldChanges,
	postArchetypePatch,
	postFieldsPatch,
	reconcilePost
} from './post-draft.js';

export const STALE_MESSAGE =
	'This was changed somewhere else since you opened it. Reload to get the latest version, then re-apply your changes.';

/**
 * Apex's field errors, as the BFF forwards them on a 422 (`{ errors: [{ attribute,
 * messages }] }`), in a sentence: "published_date is invalid".
 * @param {any} res
 */
function fieldErrors(res) {
	const errors = Array.isArray(res?.errors) ? res.errors : [];
	return errors
		.map((/** @type {any} */ e) =>
			`${e.attribute} ${Array.isArray(e.messages) ? e.messages.join(', ') : ''}`.trim()
		)
		.filter(Boolean)
		.join('; ');
}

/**
 * @param {string} stage @param {any} res
 */
function messageFor(stage, res) {
	const status = res?.status;
	if (stage === 'fields') {
		if (status === 409) {
			// The ONLY case the address is the problem: the BFF answers 409 solely when
			// Apex's errors name the slug.
			return 'Another post already uses that address. Nothing after it was saved; choose a different one and Save again.';
		}
		if (status === 422) {
			const detail = fieldErrors(res);
			return `${detail ? `A field was rejected: ${detail}.` : 'A field was rejected.'} Nothing after it was saved; fix it and Save again.`;
		}
		return 'Saving failed. Nothing after it was saved — Save again to retry.';
	}
	if (stage === 'body') {
		return 'The body could not be saved. Your field edits were saved; Save again to retry.';
	}
	if (stage === 'archetype') {
		return 'The references could not be saved. Your other changes were saved; Save again to retry.';
	}
	if (stage === 'tags') {
		return 'Your changes were saved, but the tags were not. Save again to retry the tags.';
	}
	return 'Publishing failed after your changes were saved. Save/Publish again to retry.';
}

/**
 * Save a post. Publish is the SAME function with `statusEvent: 'publish'`.
 *
 * @typedef {import('./post-draft.js').PostDraft} PostDraft
 * @typedef {{
 *   readPostVersion: (slug: string, id: string) => Promise<{ version?: unknown } | null>,
 *   updatePost: (slug: string, id: string, patch: unknown) => Promise<any>,
 *   savePostBody: (slug: string, id: string, blocks: unknown[]) => Promise<any>,
 *   updatePostArchetype: (slug: string, id: string, patch: unknown) => Promise<any>,
 *   setPostTags: (slug: string, id: string, tagIds: string[]) => Promise<any>,
 *   changePostStatus: (slug: string, id: string, statusEvent: string) => Promise<any>,
 *   getPost: (slug: string, id: string) => Promise<any>
 * }} PostClient
 *
 * @param {PostDraft} draft
 * @param {PostClient} client the ONLY thing that touches the network
 * @param {{ statusEvent?: 'publish' | 'unpublish' | null }} [options]
 * @returns {Promise<{ok: boolean, stage?: string, status?: number, stale?: boolean, message?: string, refreshed?: boolean}>}
 */
export async function savePost(draft, client, options = {}) {
	const { statusEvent } = options;
	const slug = draft.schemaSlug;
	const id = draft.postId;

	// 1. Stale guard, ONCE.
	let current;
	try {
		current = await client.readPostVersion(slug, id);
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

	// 2. The post's own fields (title / slug / summary / date / SEO / cover).
	if (hasPostFieldChanges(draft)) {
		const res = await client.updatePost(slug, id, postFieldsPatch(draft));
		if (!res.ok) {
			return {
				ok: false,
				stage: 'fields',
				status: res.status,
				message: messageFor('fields', res)
			};
		}
	}

	// 3. The body — the whole document, in order.
	if (draft.bodyDirty) {
		const res = await client.savePostBody(slug, id, draft.blocks);
		if (!res.ok) {
			return {
				ok: false,
				stage: 'body',
				status: res.status,
				message: messageFor('body', res)
			};
		}
	}

	// 4. The archetype half — primitives and references.
	if (hasPostArchetypeChanges(draft)) {
		const res = await client.updatePostArchetype(slug, id, postArchetypePatch(draft));
		if (!res.ok) {
			return {
				ok: false,
				stage: 'archetype',
				status: res.status,
				message: messageFor('archetype', res)
			};
		}
	}

	// 5. Tags — the desired set, reconciled server-side. Idempotent here even though
	// Apex's tagging endpoint is not.
	if (draft.tagsDirty) {
		const res = await client.setPostTags(slug, id, draft.tagIds);
		if (!res.ok) {
			return {
				ok: false,
				stage: 'tags',
				status: res.status,
				message: messageFor('tags', res)
			};
		}
	}

	// 6. Status — only when asked, and only once everything above succeeded.
	if (statusEvent) {
		const res = await client.changePostStatus(slug, id, statusEvent);
		if (!res.ok) {
			return {
				ok: false,
				stage: 'status',
				status: res.status,
				message: messageFor('status', res)
			};
		}
	}

	// 7. Re-baseline.
	try {
		const fresh = await client.getPost(slug, id);
		reconcilePost(draft, fresh.post, fresh.version);
	} catch {
		return { ok: true, refreshed: false };
	}
	return { ok: true, refreshed: true };
}
