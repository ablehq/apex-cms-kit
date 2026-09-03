import { z } from 'zod';
import { appendAuditEntry } from '../audit';
import { containsReviewOnlyField } from '../authorization';
import { noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { rejectMutation } from '../reject';
import type { BffContext } from '../context';

/**
 * PATCH /api/admin/entities/[entityTypeId]/[entityId] — the per-entity block-field
 * write `savePage()` dispatches for each dirty block (plan §8, 3a M1). Block field
 * values live on the block's backing entity (`blockable.entity.fields_data`);
 * `PageBlock#page` has no `touch: true`, so editing a field here is what moves the
 * block/entity timestamps the composite version guard reads. This is why fields are
 * saved through per-entity PATCHes FIRST, then the page structure — not folded into
 * one page PATCH.
 *
 * Fail closed: both ids must be UUIDs; `fields_data` must be a flat object whose
 * keys are field-name-shaped; and the review-only invariant holds here too — a
 * `transcript_reviewed` (or any review-only) key anywhere is rejected, because only
 * the dedicated human-review route (3b) may ever set it.
 */
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);

const fieldNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/u);

export const entityFieldsBodySchema = z
	.object({
		fields_data: z.record(fieldNameSchema, z.unknown())
	})
	.strict();

export async function handlePatchEntityFields(
	request: Request,
	ctx: BffContext,
	params: { entityTypeId: string; entityId: string }
): Promise<Response> {
	const meta = {
		action: 'entities.fields.patch',
		method: 'PATCH',
		path: `/api/admin/entities/${params.entityTypeId}/${params.entityId}`,
		requestId: request.headers.get('cf-ray')
	};

	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectMutation(ctx, meta, guard.status, guard.reason, guard.reason);

	const actorMeta = { ...meta, actorEmail: guard.actor.email, actorSub: guard.actor.sub };

	const typeId = uuid.safeParse(params.entityTypeId);
	const entityId = uuid.safeParse(params.entityId);
	if (!typeId.success || !entityId.success) {
		return rejectMutation(ctx, actorMeta, 400, 'invalid id', 'invalid entity id');
	}

	let bodyJson: unknown;
	try {
		bodyJson = await request.json();
	} catch {
		return rejectMutation(ctx, actorMeta, 400, 'invalid json', 'invalid json');
	}

	if (containsReviewOnlyField(bodyJson)) {
		return rejectMutation(ctx, actorMeta, 400, 'field not allowed', 'review-only field');
	}

	const parsed = entityFieldsBodySchema.safeParse(bodyJson);
	if (!parsed.success) {
		return rejectMutation(ctx, actorMeta, 400, 'invalid body', 'invalid body');
	}

	const apexResponse = await guard.apex.updateEntityFields(
		typeId.data,
		entityId.data,
		parsed.data.fields_data
	);
	const outcome = apexResponse.ok ? 'accepted' : 'apex_error';

	if (ctx.db) {
		await appendAuditEntry(ctx.db, {
			id: crypto.randomUUID(),
			occurredAt: new Date(ctx.now ?? Date.now()).toISOString(),
			actorEmail: guard.actor.email,
			actorSub: guard.actor.sub,
			action: 'entities.fields.patch',
			method: 'PATCH',
			path: actorMeta.path,
			accountId: ctx.accountId ?? null,
			pageId: null,
			requestId: request.headers.get('cf-ray'),
			outcome,
			detail: {
				entityTypeId: typeId.data,
				entityId: entityId.data,
				fields: Object.keys(parsed.data.fields_data),
				apexStatus: apexResponse.status
			}
		});
	}

	if (!apexResponse.ok) {
		// Forward a 4xx (e.g. Apex's 422 validation failure) as-is so `savePage()` can
		// surface an actionable message and STOP before dispatching the later writes;
		// a 5xx/network fault is flattened to 502. Either way the response is not ok,
		// so the partial-failure rule holds.
		const status =
			apexResponse.status >= 400 && apexResponse.status < 500 ? apexResponse.status : 502;
		return noStoreJson({ error: 'upstream error', status: apexResponse.status }, status);
	}
	return noStoreJson({ ok: true });
}
