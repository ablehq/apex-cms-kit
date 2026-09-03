// @ts-nocheck — legacy-mode admin browser module (plan §8, 3a compile-mode (a)).
// Deliberately untyped JS to sit beside the legacy-compiled admin components; its
// behavior is covered by tests/admin-save-page.test.js + tests/bff-realapex.test.js.
import { dirtyEntityPatches, structurePayload, reconcile } from './page-draft.js';

// The one explicit save (plan §8, 3a M1, "One explicit savePage() — no autosave, no
// coordinator"). This is the WHOLE persistence path: no debounce helper, no
// coordinator store, no flush registry, no barrier. It is a plain async function of a
// draft and a BFF client, so its invariants — write order, stop-on-partial-failure,
// the stale guard checked once, re-baseline — are unit-testable without a DOM or a
// network.
//
// Write order, exactly:
//   1. Stale guard, ONCE: read the composite version; if it moved, refuse (recoverable).
//   2. Per-entity field PATCHes, in order; STOP on the first failure.
//   3. Page structure (order / add / remove); STOP on failure.
//   4. Status event (publish / unpublish), only when asked; never after any failure.
// Publish is the SAME function with `statusEvent: 'publish'` — it awaits every prior
// step and never dispatches the status if an earlier step failed (plan M1).

export const STALE_MESSAGE =
	'This page was changed somewhere else since you opened it. Reload to get the latest version, then re-apply your changes.';

function messageFor(stage, result) {
	const status = result?.status;
	if (stage === 'fields') {
		return status === 422
			? 'A section field was rejected (check required values). Your other changes were not saved yet — fix it and Save again.'
			: 'Saving a section field failed. Nothing after it was saved — Save again to retry.';
	}
	if (stage === 'structure') {
		return status === 422
			? 'The page layout was rejected. Your field edits were saved; fix the layout and Save again.'
			: 'Saving the page layout failed. Save again to retry.';
	}
	return 'Publishing failed after your changes were saved. Save/Publish again to retry.';
}

/**
 * @param {import('./types').AdminPageDraft} draft a page-draft (page-draft.js)
 * @param {import('./types').BffClient} client the ONLY thing that touches the network
 * @param {{ statusEvent?: import('./types').AdminStatusEvent }} [options]
 * @returns {Promise<import('./types').SavePageResult>}
 */
export async function savePage(draft, client, options = {}) {
	const { statusEvent } = options;
	const pageId = draft.pageId;

	// 1. Stale guard — compared ONCE, before any write. page.updated_at alone would
	// miss block-field edits, so this is the composite version (page-version.ts).
	let current;
	try {
		current = await client.readVersion(pageId);
	} catch {
		return {
			ok: false,
			stage: 'version',
			message: 'Could not check the page version. Save again to retry.'
		};
	}
	if (current?.version !== draft.baselineVersion) {
		return { ok: false, stale: true, stage: 'version', message: STALE_MESSAGE };
	}

	// 2. Dirty entity field PATCHes, in order. Stop on the first failure so the
	// structure/status writes below are never dispatched after a partial failure.
	for (const patch of dirtyEntityPatches(draft)) {
		const res = await client.patchEntityFields(
			patch.entityTypeId,
			patch.entityId,
			patch.fields_data
		);
		if (!res.ok) {
			return { ok: false, stage: 'fields', status: res.status, message: messageFor('fields', res) };
		}
	}

	// 3. Page structure — only if it changed. Carries block order / add / remove.
	let freshPage = null;
	let freshVersion = null;
	if (draft.structureDirty || draft.deletedBlockIds.length > 0) {
		const res = await client.savePageStructure(pageId, structurePayload(draft));
		if (!res.ok) {
			return {
				ok: false,
				stage: 'structure',
				status: res.status,
				message: messageFor('structure', res)
			};
		}
		freshPage = res.page ?? null;
		freshVersion = res.version ?? null;
	}

	// 4. Status event — only when asked (Publish / Unpublish). Never reached if any
	// step above returned. A status change invalidates the structure snapshot, so we
	// force a fresh read below.
	if (statusEvent) {
		const res = await client.changePageStatus(pageId, statusEvent);
		if (!res.ok) {
			return { ok: false, stage: 'status', status: res.status, message: messageFor('status', res) };
		}
		freshPage = null;
	}

	// 5. Re-baseline. Prefer the page the structure save already returned; otherwise
	// read it fresh so the draft (and the stale guard's baseline) match the server.
	if (freshPage && freshVersion) {
		reconcile(draft, freshPage, freshVersion);
	} else {
		try {
			const { page, version } = await client.getPage(pageId);
			reconcile(draft, page, version);
		} catch {
			// The writes succeeded; only the refresh failed. Report success but flag
			// that the draft may be behind, so the UI can prompt a reload.
			return { ok: true, refreshed: false };
		}
	}
	return { ok: true, refreshed: true };
}
