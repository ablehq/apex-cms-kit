import { appendAuditEntry } from '../audit';
import { containsNullPrimitive } from '../authorization';
import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { rejectMutation } from '../reject';
import { cleanString, unwrapArchetypeRecord } from '../archetype-record';
import { recordBodySchema, referenceFieldNames, summarizeRecord } from './record-shape';
import { toApexFields } from './update-record';
import { requireContract } from '../content-contract-guard';
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
	const contract = requireContract(ctx);
	const meta = {
		action: 'records.create',
		method: 'POST',
		path: `/api/admin/records/${params.schema}`,
		requestId: request.headers.get('cf-ray')
	};

	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectMutation(ctx, meta, guard.status, guard.reason, guard.reason);

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

	const parsed = recordBodySchema(contract, params.schema).safeParse(bodyJson);
	if (!parsed.success) {
		return rejectMutation(ctx, actorMeta, 400, 'invalid body', 'invalid body');
	}
	if (parsed.data.references && Object.keys(parsed.data.references).length > 0) {
		return rejectMutation(ctx, actorMeta, 400, 'references on create', 'references on create');
	}

	const fields = toApexFields(parsed.data.fields ?? {});
	const apexResponse = await guard.apex.createContentLibraryRecord(params.schema, fields);

	if (ctx.db) {
		await appendAuditEntry(ctx.db, {
			id: crypto.randomUUID(),
			occurredAt: new Date(ctx.now ?? Date.now()).toISOString(),
			actorEmail: guard.actor.email,
			actorSub: guard.actor.sub,
			action: meta.action,
			method: meta.method,
			path: meta.path,
			accountId: ctx.accountId ?? null,
			pageId: null,
			requestId: meta.requestId,
			outcome: apexResponse.ok ? 'accepted' : 'apex_error',
			detail: {
				schema: params.schema,
				fields: Object.keys(fields),
				apexStatus: apexResponse.status
			}
		});
	}

	if (!apexResponse.ok) {
		const status =
			apexResponse.status >= 400 && apexResponse.status < 500 ? apexResponse.status : 502;
		return noStoreJson({ error: 'upstream error', status: apexResponse.status }, status);
	}

	const created = unwrapArchetypeRecord(apexResponse.body);
	const recordId = created ? cleanString(created.id) : '';
	if (!recordId) return bffError(502, 'unexpected upstream shape');

	// Proved by an independent re-read, not by the create echo. Apex's create
	// response comes back with `primitives: {}` — the flattened read model has not
	// been recomputed at the moment it is serialized — so summarizing the echo would
	// hand the browser a record with no values and the list would show a blank row
	// for a record that is fine. A 200 is not evidence.
	const reread = await guard.apex.getContentLibraryRecord(params.schema, recordId);
	if (!reread.ok) return bffError(502, 'upstream error');
	const record = unwrapArchetypeRecord(reread.body);
	if (!record) return bffError(502, 'unexpected upstream shape');

	return noStoreJson({ ok: true, record: summarizeRecord(contract, params.schema, record) }, 201);
}
