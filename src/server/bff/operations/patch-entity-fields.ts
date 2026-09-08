import { z } from 'zod';
import { auditOutcome } from '../audit';
import { containsReviewOnlyField } from '../authorization';
import { noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import {
	refuseOversizedFields,
	refuseUnreadableUrls,
	rejectGuardFailure,
	rejectMutation
} from '../reject';
import { sanitizeFieldValue } from '../../../sanitize/write-boundary';
import { ENTITY_TYPE_REF } from '../apex-admin-client';
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
 * Fail closed: the entity id must be a UUID and the entity TYPE a uuid or a slug
 * (Apex resolves `:entity_type_id` either way, and one site on this kit has only
 * slugs — see `assertEntityTypeRef`); `fields_data` must be a flat object whose
 * keys are field-name-shaped; and the review-only invariant holds here too — a
 * `transcript_reviewed` (or any review-only) key anywhere is rejected, because only
 * the dedicated human-review route (3b) may ever set it.
 *
 * EVERY VALUE IS SANITIZED AND BOUNDED before it goes upstream. Until plan 07's P4a
 * this operation forwarded `fields_data` verbatim — the only unsanitized write path
 * left in the kit, and the one a block field goes through. A block entity's value
 * is rendered with `{@html}` on the public site (Poovayya's `Hero.svelte:56` is one
 * of several), so a `<script>` or a `javascript:` href posted here with a valid
 * session was stored as authored. The record paths already funnelled through
 * `toApexFields`; this one now uses the same `sanitizeFieldValue`, and the same
 * per-field ceiling the record paths gained in the same change.
 */
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);

/**
 * A uuid OR a slug — `entity_types/:id_or_slug`. Nothing that could carry a path.
 *
 * THE CLIENT'S OWN REGEX, not a second spelling of it: this used to be `/iu`, which
 * accepts uppercase and — through unicode case folding — U+212A and U+017F, all of
 * which `assertEntityTypeRef` then refused by THROWING. A request that passes route
 * validation and dies in the client is a framework 500 with no audit row, in place of
 * the audited 400 this route already knows how to answer.
 */
const entityTypeRef = z.string().regex(ENTITY_TYPE_REF);

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
		// The route TEMPLATE, not the request's own path. `reject.ts` states the rule
		// and `postRouteMeta` already follows it: a route parameter is
		// attacker-controlled until validated, and this meta is built BEFORE the
		// validation, so interpolating it would write an arbitrary caller string into
		// the audit table's `path` on every refused request. The validated values go
		// in `detail`.
		path: '/api/admin/entities/[entityTypeId]/[entityId]',
		requestId: request.headers.get('cf-ray')
	};

	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectGuardFailure(request, ctx, meta, guard);

	const actorMeta = { ...meta, actorEmail: guard.actor.email, actorSub: guard.actor.sub };

	const typeId = entityTypeRef.safeParse(params.entityTypeId);
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

	if (containsReviewOnlyField(bodyJson, ctx.reviewOnlyFields)) {
		return rejectMutation(ctx, actorMeta, 400, 'field not allowed', 'review-only field');
	}

	const parsed = entityFieldsBodySchema.safeParse(bodyJson);
	if (!parsed.success) {
		return rejectMutation(ctx, actorMeta, 400, 'invalid body', 'invalid body');
	}

	// Named before the write, not collapsed into `invalid body`: the caller is told
	// WHICH field is over the ceiling.
	const tooLarge = await refuseOversizedFields(ctx, actorMeta, parsed.data.fields_data);
	if (tooLarge) return tooLarge;
	// The other half of the same rule (Opus O5): a URL attribute this judge cannot
	// read is refused BY NAME rather than silently stripped on the way through the
	// sanitizer, so an editor is told which field to look at.
	const unreadable = await refuseUnreadableUrls(ctx, actorMeta, parsed.data.fields_data);
	if (unreadable) return unreadable;

	const fieldsData: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(parsed.data.fields_data)) {
		fieldsData[name] = sanitizeFieldValue(value);
	}

	const apexResponse = await guard.apex.updateEntityFields(typeId.data, entityId.data, fieldsData);
	const outcome = apexResponse.ok ? 'accepted' : 'apex_error';

	await auditOutcome(ctx, meta, guard.actor, {
		outcome,
		detail: {
			entityTypeId: typeId.data,
			entityId: entityId.data,
			fields: Object.keys(parsed.data.fields_data),
			apexStatus: apexResponse.status
		}
	});

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
