import { auditOutcome } from '../audit';
import { containsNullPrimitive } from '../authorization';
import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import {
	refuseOversizedFields,
	refuseUnreadableUrls,
	rejectGuardFailure,
	rejectMutation
} from '../reject';
import { cleanString, unwrapArchetypeRecord } from '../archetype-record';
import { createdIdOutcome, judgeCreatedId, shapeFaultDetail } from './created-id';
import { recordBodySchema, referenceFieldNames, summarizeRecord } from './record-shape';
import { toApexFields } from './update-record';
import { contractOf, noContractResponse } from '../content-contract-guard';
import type { BffContext } from '../context';

/**
 * POST /api/admin/records/[schema] — mint one content-library record.
 *
 * This is the create half of create-then-reveal: the "New …" button calls this
 * FIRST and only then renders a form bound to the real id, so text typed into a
 * brand-new record cannot be dropped against a `temp-` id. That is cheap here
 * because a create is one proven call, and harmless because these records have no
 * status — nothing half-finished can be "published" by accident; the worst case is
 * a record named "New partner" sitting in a list until someone finishes it.
 *
 * `containsNullPrimitive` runs FIRST, before shape validation, because a rejected
 * `null` deserves to be named as what it is — the one input that would destroy the
 * field's row upstream and strand its old value where the public site reads it —
 * and not reported as a generic shape failure. Empty strings ARE allowed: `''` is
 * the safe clear, and a brand-new record legitimately has almost nothing filled in.
 *
 * REFERENCES ARE NOT WRITABLE ON CREATE. There is no existing item to diff against
 * and `null` is only ever meaningful against one; the editor sets them on the
 * screen that opens a moment later, through the update path that does the diff
 * properly.
 */
export async function handleCreateRecord(
	request: Request,
	ctx: BffContext,
	params: { schema: string }
): Promise<Response> {
	const contract = contractOf(ctx);
	if (!contract) return noContractResponse();
	const meta = {
		action: 'records.create',
		method: 'POST',
		// The route TEMPLATE, not the request's own path. `reject.ts` states the rule
		// and `postRouteMeta` already follows it: a route parameter is
		// attacker-controlled until validated, and this meta is built BEFORE the
		// validation, so interpolating it would write an arbitrary caller string into
		// the audit table's `path` on every refused request. The validated values go
		// in `detail`.
		path: '/api/admin/records/[schema]',
		requestId: request.headers.get('cf-ray')
	};

	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectGuardFailure(request, ctx, meta, guard);

	const actorMeta = { ...meta, actorEmail: guard.actor.email, actorSub: guard.actor.sub };

	if (!contract.isContentLibrarySlug(params.schema)) {
		return rejectMutation(ctx, actorMeta, 404, 'unknown collection', 'unknown collection');
	}

	let bodyJson: unknown;
	try {
		bodyJson = await request.json();
	} catch {
		return rejectMutation(ctx, actorMeta, 400, 'invalid json', 'invalid json');
	}

	const submitted = (bodyJson as { fields?: Record<string, unknown> })?.fields;
	if (submitted && containsNullPrimitive(submitted, referenceFieldNames(contract, params.schema))) {
		return rejectMutation(ctx, actorMeta, 400, 'null-field', 'null primitive');
	}

	// The per-field ceiling, named before the shape check so the refusal can say
	// WHICH field is over it (`field-too-large`) rather than a generic `invalid body`.
	const tooLarge = await refuseOversizedFields(ctx, actorMeta, submitted);
	if (tooLarge) return tooLarge;
	// The other half of the same rule (Opus O5): a URL attribute this judge cannot
	// read is refused BY NAME rather than silently stripped on the way through the
	// sanitizer, so an editor is told which field to look at.
	const unreadable = await refuseUnreadableUrls(ctx, actorMeta, submitted);
	if (unreadable) return unreadable;

	const parsed = recordBodySchema(contract, params.schema).safeParse(bodyJson);
	if (!parsed.success) {
		return rejectMutation(ctx, actorMeta, 400, 'invalid body', 'invalid body');
	}
	if (parsed.data.references && Object.keys(parsed.data.references).length > 0) {
		return rejectMutation(ctx, actorMeta, 400, 'references on create', 'references on create');
	}
	// NOR IS `position` WRITABLE ON CREATE, and it is refused rather than dropped.
	// `recordBodySchema` accepts the key for the UPDATE path, so without this line a
	// create carrying one would parse, be ignored, and answer 201 — a create that
	// silently did not do what it was asked. Ordering is set on the screen that
	// opens a moment later, through the update path that actually sends it.
	if (parsed.data.position !== undefined) {
		return rejectMutation(ctx, actorMeta, 400, 'position on create', 'position on create');
	}
	/**
	 * A LIST IS WRITABLE ON CREATE, and it did not used to be.
	 *
	 * An array-shaped field had to go to `/specification/archetypes/:id/schema_item/
	 * :field/items`, which needs the archetype id this call is about to mint — so a
	 * create carrying one was REFUSED rather than answering 201 over a list that was
	 * never written. `ellipsis-backend` PR #1888 (`fix/archetype-model-array-fields`)
	 * made `archetype_models` permit a list-shaped value, so the list now rides this
	 * POST like every other field and the refusal is gone.
	 *
	 * What is NOT gone is the refusal for a field the permit does not cover:
	 * `recordBodySchema` rejects an array on anything but a single-field Primitive of
	 * an array kind, because on everything else the flat surface still reduces it to
	 * `[]`. See `writableArrayKind` in `record-shape.ts`.
	 */
	const fields = toApexFields(parsed.data.fields ?? {});
	const apexResponse = await guard.apex.createContentLibraryRecord(params.schema, fields);

	// THE VERDICT, TAKEN BEFORE THE AUDIT IS WRITTEN — the rule and the reasoning are
	// in `created-id.ts`. This handler used to audit `accepted` on any 2xx and then
	// answer 502 for an idless body, and it checked only that the id was a nonempty
	// string before interpolating it into the re-read URL below (codex's P5 fix
	// review, 2026-09-08).
	const created = unwrapArchetypeRecord(apexResponse.body);
	const verdict = judgeCreatedId(
		apexResponse.ok,
		created ? cleanString(created.id) : null,
		'record'
	);

	await auditOutcome(ctx, meta, guard.actor, {
		outcome: createdIdOutcome(apexResponse.ok, verdict),
		detail: {
			schema: params.schema,
			recordId: verdict.id,
			...shapeFaultDetail(verdict),
			fields: Object.keys(fields),
			apexStatus: apexResponse.status
		}
	});

	if (!apexResponse.ok) {
		const status =
			apexResponse.status >= 400 && apexResponse.status < 500 ? apexResponse.status : 502;
		return noStoreJson({ error: 'upstream error', status: apexResponse.status }, status);
	}

	const recordId = verdict.id;
	if (recordId === null) return bffError(502, 'unexpected upstream shape');

	// Proved by an independent re-read, not by the create echo. Apex's create
	// response comes back with `primitives: {}` — the flattened read model has not
	// been recomputed at the moment it is serialized — so summarizing the echo would
	// hand the browser a record with no values and the list would show a blank row
	// for a record that is fine. A 200 is not evidence.
	const reread = await guard.apex.getContentLibraryRecord(params.schema, recordId);
	const record = reread.ok ? unwrapArchetypeRecord(reread.body) : null;
	if (!record) {
		// The record EXISTS and this operation can name it, so the `accepted` row above
		// is true and stays. Without this second row the log would say a create
		// succeeded and be silent about the 502 the editor was actually sent, which is
		// the same contradiction the verdict above exists to stop, one step later.
		await auditOutcome(ctx, meta, guard.actor, {
			outcome: 'apex_error',
			detail: {
				schema: params.schema,
				recordId,
				reason: 'post-create-read-failed',
				apexStatus: reread.status
			}
		});
		return bffError(502, reread.ok ? 'unexpected upstream shape' : 'upstream error');
	}

	return noStoreJson({ ok: true, record: summarizeRecord(contract, params.schema, record) }, 201);
}
