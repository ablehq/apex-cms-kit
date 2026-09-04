import { auditOutcome } from '../audit';
import { noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { rejectMutation } from '../reject';
import { countReferencesTo } from './record-shape';
import { recordIdSchema } from './get-record';
import { contractOf, noContractResponse } from '../content-contract-guard';
import type { BffContext } from '../context';

/**
 * DELETE /api/admin/records/[schema]/[recordId] — and the one guard in this phase
 * that Apex itself will not enforce.
 *
 * WHAT APEX DOES. `DELETE …/:slug/archetype_models/:id` on a record other records
 * reference answers **200**, deletes it, and SILENTLY strips it from every one of
 * those references. There is no error, no confirmation prompt, no dangling id left
 * behind to notice later, and no undo.
 *
 * So the refusal is ours to write:
 *
 *   1. count, FRESH, how many records reference this one — not trusting a number
 *      the browser sent or a list it loaded ten minutes ago;
 *   2. if that count is non-zero and the caller did not pass `?confirm=1`, refuse
 *      with `409 {code:'in-use', referenceCount, …}` and touch nothing;
 *   3. only then delete, and report what it emptied so the screen can say what
 *      actually happened rather than "Deleted".
 *
 * The count is recomputed on the confirmed call too, because between the warning
 * and the confirmation somebody else may have added a reference — a confirmation
 * for "2 partners" must not silently strip 3.
 *
 * ── WHAT THE COUNT DOES AND DOES NOT COVER, AND WHY IT SAYS SO ─────────────────
 * It covers the content-library relations, which are readable through the generic
 * list. It does NOT cover `update` and `story`, which also reference authors, focus
 * areas and partners: a post archetype is not addressable on this surface (its
 * fields would 422 there) and the post screen is P2.
 *
 * That gap is REPORTED rather than papered over. A partial count reads as a
 * complete one, and "0 records use this" is precisely the sentence that talks an
 * editor into a delete. So the response carries `uncountedReferrers`, the screen
 * names them, and the confirm button says what it does not know.
 *
 * AND, SINCE IT CANNOT COUNT THEM, IT REFUSES. Naming the gap is not enough: a
 * confirmed delete of a focus area would have Apex strip it from every Update and
 * Story that referenced it, silently, and P1 cannot see — let alone report — what
 * it just emptied. So a non-empty `uncountedReferrers` is a 409 in its own right,
 * with no `?confirm=1` that gets past it. That refusal lifts when the post screens
 * land (P2) and those referrers move into the countable set.
 */
export async function handleDeleteRecord(
	request: Request,
	ctx: BffContext,
	params: { schema: string; recordId: string }
): Promise<Response> {
	const contract = contractOf(ctx);
	if (!contract) return noContractResponse();
	const meta = {
		action: 'records.delete',
		method: 'DELETE',
		path: `/api/admin/records/${params.schema}/${params.recordId}`,
		requestId: request.headers.get('cf-ray')
	};

	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectMutation(ctx, meta, guard.status, guard.reason, guard.reason);

	const actorMeta = { ...meta, actorEmail: guard.actor.email, actorSub: guard.actor.sub };

	if (!contract.isContentLibrarySlug(params.schema)) {
		return rejectMutation(ctx, actorMeta, 404, 'unknown collection', 'unknown collection');
	}
	const idResult = recordIdSchema.safeParse(params.recordId);
	if (!idResult.success) {
		return rejectMutation(ctx, actorMeta, 400, 'invalid id', 'invalid record id');
	}

	// Only the exact string `1`. A truthy-ish `?confirm=maybe` is not a
	// confirmation, and this is not a parameter to be liberal about.
	const confirmed = new URL(request.url).searchParams.get('confirm') === '1';

	const referrers = contract.referrersTo(params.schema);
	const uncounted = referrers.uncounted.map((entry) => entry.displayName);

	// Refuse OUTRIGHT while any referrer cannot be counted, confirmed or not. This
	// is before the count read on purpose: the answer does not depend on it, and
	// there is no version of this request that may proceed.
	if (uncounted.length > 0) {
		await auditOutcome(ctx, meta, guard.actor, {
			outcome: 'rejected',
			detail: {
				schema: params.schema,
				recordId: idResult.data,
				reason: 'uncountable-references',
				uncountedReferrers: uncounted
			}
		});
		return noStoreJson(
			{
				error: 'uncountable-references',
				code: 'uncountable-references',
				uncountedReferrers: uncounted
			},
			409
		);
	}

	const counted = await countReferencesTo(contract, guard.apex, params.schema, idResult.data);
	if (!counted.ok) {
		// Fail CLOSED. An unknown count is not zero: if a referring collection cannot
		// be read, the one thing we cannot do is proceed as though nothing pointed at
		// this record. The editor is told to try again; nothing is deleted.
		return rejectMutation(ctx, actorMeta, 502, 'reference check failed', 'reference check failed');
	}
	const referenceCount = counted.count;

	if (referenceCount > 0 && !confirmed) {
		await auditOutcome(ctx, meta, guard.actor, {
			outcome: 'rejected',
			detail: { schema: params.schema, recordId: idResult.data, reason: 'in-use', referenceCount }
		});
		// A 409 with the count IN THE BODY, not a bare error code: the number is the
		// whole message, and the screen re-asks the question with it.
		return noStoreJson(
			{
				error: 'in-use',
				code: 'in-use',
				referenceCount,
				referrers: referrers.countable.map((entry) => entry.displayName),
				uncountedReferrers: uncounted
			},
			409
		);
	}

	const apexResponse = await guard.apex.deleteContentLibraryRecord(params.schema, idResult.data);

	await auditOutcome(ctx, meta, guard.actor, {
		outcome: apexResponse.ok ? 'accepted' : 'apex_error',
		// `strippedReferences` is recorded because it is the part of this action that
		// leaves no other trace anywhere: the references are gone from Apex, and this
		// row is the only place that says how many there were.
		detail: {
			schema: params.schema,
			recordId: idResult.data,
			confirmed,
			strippedReferences: referenceCount,
			uncountedReferrers: uncounted,
			apexStatus: apexResponse.status
		}
	});

	if (!apexResponse.ok) {
		const status =
			apexResponse.status >= 400 && apexResponse.status < 500 ? apexResponse.status : 502;
		return noStoreJson({ error: 'upstream error', status: apexResponse.status }, status);
	}

	return noStoreJson({
		ok: true,
		strippedReferences: referenceCount,
		uncountedReferrers: uncounted
	});
}
