//
// The one explicit save for every content-library record, ported from
// `gospel-life-church/src/lib/admin/save-entity.js` with its invariants unchanged:
// the stale guard checked ONCE before any write, stop on the first failure,
// re-baseline at the end, no autosave anywhere.
//
// It is shorter than GLC's because a Godrej content-library record is ONE Apex
// record. GLC's `saveEntity` also reconciles a resource's tags, and its
// `saveArticle` sequences three endpoints; neither applies here. What replaces them
// is a single PATCH that carries the dirty fields AND the reference selections
// together, so a partially-saved record is not a state this screen can reach.
//
// The reference DIFF is not computed here. The browser sends the set the editor
// selected and the BFF diffs it against a read taken in the same request
// (`operations/update-record.ts`). That is deliberate: `apply_has_many_value`
// upserts rather than replaces, so a removal has to travel as an explicit
// `_destroy` against the JOIN ROW id — an id this module has never seen and should
// not have to reason about. A baseline captured when the screen loaded could also
// be minutes old by the time Save is pressed.

import { entityPatch, hasEntityChanges, reconcileEntity } from './entity-draft.js';

export const STALE_MESSAGE =
	'This was changed somewhere else since you opened it. Reload to get the latest version, then re-apply your changes.';

function fieldsMessage(status) {
	return status === 422
		? 'A field was rejected (check required values). Fix it and Save again.'
		: 'Saving failed. Nothing was changed — Save again to retry.';
}

/**
 * Save one content-library record.
 *
 * @param {object} draft from `createEntityDraft`
 * @param {object} client the ONLY thing that touches the network
 * @returns {Promise<{ok: boolean, stage?: string, status?: number, stale?: boolean, message?: string, refreshed?: boolean}>}
 */
export async function saveEntity(draft, client) {
	const { schemaSlug, entityId } = draft;

	// 1. Stale guard — ONCE, before any write. A content-library record is a single
	// record with no children, so its own `updated_at` is a sufficient token.
	let current;
	try {
		current = await client.readRecordVersion(schemaSlug, entityId);
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

	// 2. The one write — dirty fields and changed reference selections together.
	if (hasEntityChanges(draft)) {
		const result = await client.updateRecord(schemaSlug, entityId, entityPatch(draft));
		if (!result.ok) {
			return {
				ok: false,
				stage: 'fields',
				status: result.status,
				message: fieldsMessage(result.status)
			};
		}
		// The update answers with the whole record, because a reference diff mints new
		// join rows and the browser's copy of the relation is now behind. Adopting it
		// here means the next save's diff starts from what Apex actually holds.
		if (result.record) {
			reconcileEntity(draft, result.record, result.version);
			return { ok: true, refreshed: true };
		}
	}

	// 3. Re-baseline from a fresh read, so the stale guard's token matches the server
	// again. What is on screen after a save is what Apex stored, not what we sent.
	try {
		const fresh = await client.getRecord(schemaSlug, entityId);
		reconcileEntity(draft, fresh.record, fresh.version);
	} catch {
		return { ok: true, refreshed: false };
	}
	return { ok: true, refreshed: true };
}
