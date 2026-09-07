//
// The one explicit save for every content-library record, ported from
// `gospel-life-church/src/lib/admin/save-entity.js` with its invariants unchanged:
// the stale guard checked ONCE before any write, stop on the first failure,
// re-baseline at the end, no autosave anywhere.
//
// It is shorter than GLC's because a the site content-library record is ONE Apex
// record. GLC's `saveEntity` also reconciles a resource's tags, and its
// `saveArticle` sequences three endpoints; neither applies here.
//
// IT IS NO LONGER ONE PATCH, and "a partially-saved record is not a state this
// screen can reach" — which this comment used to claim — is no longer true. An
// array-shaped field cannot ride the flat surface (it answers 200 and stores `[]`),
// so the operation writes the scalars flat and then each list to its own
// `archetype_item`. A failure after the flat write leaves the record MIXED, and the
// operation says so: `child-list-write-failed` names the field that failed and the
// lists that had already landed. `fieldsMessage` below is where that reaches a
// human, and it is why the default "Nothing was changed" sentence is not safe to
// use for every refusal.
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

/**
 * What the editor is told when the record write is refused.
 *
 * The default sentence promises TWO things — nothing changed, and a retry will
 * work — and the operation has two refusals for which each promise is FALSE.
 * Saying "nothing was changed" over a committed write is worse than saying
 * nothing: it tells someone to stop looking.
 *
 * The BFF client's `mutate` spreads the response body onto its result, so `code`,
 * `field`, `written` and `unbackedFields` are already here; this only has to read
 * them. Every site that uses this helper — Godrej renders it verbatim in
 * `RecordEditor.svelte` — inherits the wording from one place.
 *
 * @param {number|undefined} status
 * @param {{code?: string, field?: string, written?: string[], unbackedFields?: string[]}} [result]
 */
function fieldsMessage(status, result = {}) {
	if (result.code === 'child-list-write-failed') {
		// The flat write IS committed and the lists in `written` ARE saved; only the
		// named list failed. A retry is right — every leg re-sends the whole desired
		// array, so it converges — but "nothing was changed" is simply untrue.
		return (
			`The list “${result.field ?? 'unknown'}” could not be saved. The rest of the ` +
			'record was saved. An item in it may have been deleted — remove it and Save again.'
		);
	}
	if (result.code === 'unbacked-record') {
		// Retrying can NEVER work: the refusal is a property of the record, not of
		// this request. Telling someone to Save again would loop them forever.
		const fields = (result.unbackedFields ?? []).join(', ');
		return (
			'This record cannot be edited safely: it was imported without the rows a save ' +
			'rebuilds from, so saving one field would delete the others' +
			(fields ? ` (${fields})` : '') +
			'. Nothing was changed. It needs repairing before it can be edited — Save again ' +
			'will not help.'
		);
	}
	return status === 422
		? 'A field was rejected (check required values). Fix it and Save again.'
		: 'Saving failed. Nothing was changed — Save again to retry.';
}

/**
 * Save one content-library record.
 *
 * The two parameters were `{object}`, which types nothing — every property read off
 * them was an error the moment `checkJs` was switched on. They now say what this
 * function actually touches, and nothing more.
 *
 * @typedef {import('./entity-draft.js').EntityDraft} EntityDraftLike
 * @typedef {{
 *   readRecordVersion: (slug: string, id: string) => Promise<{ version?: unknown } | null>,
 *   updateRecord: (slug: string, id: string, patch: unknown) => Promise<any>,
 *   getRecord: (slug: string, id: string) => Promise<any>
 * }} EntityClient
 *
 * @param {EntityDraftLike} draft from `createEntityDraft`
 * @param {EntityClient} client the ONLY thing that touches the network
 * @returns {Promise<{ok: boolean, stage?: string, status?: number, code?: string, retryable?: boolean, stale?: boolean, message?: string, refreshed?: boolean}>}
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
				code: result.code,
				// False for the one refusal a retry can never fix, so a screen can hide
				// its "Save again" affordance rather than offering a dead end.
				retryable: result.code !== 'unbacked-record',
				message: fieldsMessage(result.status, result)
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
