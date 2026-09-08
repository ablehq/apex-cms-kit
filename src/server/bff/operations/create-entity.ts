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
import type { BffContext } from '../context';

/**
 * POST /api/admin/entities/[entityType] — create ONE content-library entity.
 *
 * THE MECHANIC WITHOUT WHICH A CHILD LIST CANNOT BE EDITED AT ALL. An `array_ref`
 * field's value is an ordered list of ids of entities that ALREADY EXIST: Apex's
 * validator resolves every element against `ContentLibrary::Entity` and errors when
 * the row is absent (`content_library/property_set_form_helper.rb:143`). There is no
 * create-on-write. So a row an editor just added by pressing "+ Add item" has no id,
 * and putting it in the parent's array is a validation error, not an insert.
 *
 * The order a child-list save follows, and why this is a separate call rather than
 * part of the record write:
 *
 *   1. CREATE every new child here, collecting the returned ids;
 *   2. PATCH every edited existing child (`patch-entity-fields.ts`);
 *   3. save the PARENT's ordered array of child ids.
 *
 * Stop on the first failure. A half-created child list with the parent unsaved is
 * recoverable — the orphans are simply unreferenced entities; a parent pointing at
 * ids that failed to create is not.
 *
 * ── WHO CAN REACH THIS ──────────────────────────────────────────────────────
 * A general-purpose writer into the content library is not something the kit hands
 * out by default. `allowedEntityTypes` on the client is REFUSE-WHEN-ABSENT (the
 * `allowedPostSlugs` shape, not the `allowedSchemaSlugs` one), so a site that names
 * no types cannot create anything: `guard.apex.allowsEntityType` is false for every
 * input and this operation answers 404 before a request is built. Godrej and GLC
 * name none — neither has an `array_ref` field, and their entities are minted by the
 * page structure — so mounting this route on either changes nothing they can do.
 *
 * THERE IS NO DELETE COUNTERPART, and that is deliberate. Removing an array
 * reference drops the id from the parent's list and leaves the child entity in
 * place, because that is what removing a reference IS. The cost is that
 * removed-and-never-re-added children accumulate unreferenced; that is the correct
 * trade for not destroying data on a mis-click, and if it ever matters it is a
 * housekeeping task, not an admin feature. (Deleting an entity outright is the
 * top-level `content_library/entities/:id`, a separate and deliberate act.)
 *
 * ── THE ENDPOINT, AND THE ONE THAT WAS NOT CHOSEN ───────────────────────────
 * `POST /content_library/entity_types/:ref/entities` — the same endpoint
 * `updateEntityFields` PATCHes. Not `entity_models`: one `permitted_params` on
 * `entities_controller` serves create AND update (`:113-115`) and both permit arrays
 * for `text_array` / `number_array` / `array_ref/*` (`entity_data_model.rb:32-50`),
 * so there is nothing to gain — while `entity_models` takes a FLAT payload, passes
 * unknown keys through to a 422 instead of dropping them, and creates through a
 * different service with different error bodies.
 */

/** A uuid OR a slug — `entity_types/:id_or_slug`. Nothing that could carry a path. */
const entityTypeRef = z
	.string()
	.regex(/^[0-9a-z][0-9a-z-]*$/iu)
	.max(120);

const fieldNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/u);

/**
 * `.strict()` and a field-name pattern: an unknown TOP-LEVEL key is a 400 rather
 * than something Apex silently drops, and a field name that is not field-name-shaped
 * never reaches a payload. The `entities` controller drops unknown keys quietly, so
 * without this a caller could believe a typo had been stored.
 */
export const createEntityBodySchema = z
	.object({
		fields_data: z.record(fieldNameSchema, z.unknown())
	})
	.strict();

/** Apex's single-entity envelope. A created entity has `{id, fields_data}` and no `primitives`. */
function createdEntityId(body: unknown): string | null {
	if (!body || typeof body !== 'object') return null;
	const envelope = body as { data?: unknown; id?: unknown };
	const data =
		envelope.data && typeof envelope.data === 'object'
			? (envelope.data as { id?: unknown })
			: (envelope as { id?: unknown });
	return typeof data.id === 'string' ? data.id : null;
}

export async function handleCreateEntity(
	request: Request,
	ctx: BffContext,
	params: { entityType: string }
): Promise<Response> {
	const meta = {
		action: 'entities.create',
		method: 'POST',
		// The route TEMPLATE, never the caller's path: this meta is built before the
		// parameter is validated, and `reject.ts` states the rule.
		path: '/api/admin/entities/[entityType]',
		requestId: request.headers.get('cf-ray')
	};

	const guard = await guardRequest(request, ctx, { mutation: true });
	// The kit's guard exit: an UNAUTHENTICATED caller buys no D1 INSERT, while a real
	// session that fails the boundary is still audited against that editor.
	if (!guard.ok) return rejectGuardFailure(request, ctx, meta, guard);

	const actorMeta = { ...meta, actorEmail: guard.actor.email, actorSub: guard.actor.sub };

	const entityType = entityTypeRef.safeParse(params.entityType);
	if (!entityType.success) {
		return rejectMutation(ctx, actorMeta, 400, 'invalid id', 'invalid entity type');
	}
	// Only a type this site has NAMED. 404 rather than 403: from the caller's side a
	// type this deployment does not mint does not exist here, and saying which types
	// do exist is not this route's job. The client refuses the same input by throwing
	// — two spellings of one option, so a future caller that skips this check still
	// cannot reach Apex.
	if (!guard.apex.allowsEntityType(entityType.data)) {
		return rejectMutation(ctx, actorMeta, 404, 'not found', 'unknown entity type');
	}

	let bodyJson: unknown;
	try {
		bodyJson = await request.json();
	} catch {
		return rejectMutation(ctx, actorMeta, 400, 'invalid json', 'invalid json');
	}

	// The review-only invariant holds on every write surface, not just the ones that
	// happen to have a review field today: only the dedicated human-review route may
	// set one, and a create is as good a way in as a patch.
	if (containsReviewOnlyField(bodyJson, ctx.reviewOnlyFields)) {
		return rejectMutation(ctx, actorMeta, 400, 'field not allowed', 'review-only field');
	}

	const parsed = createEntityBodySchema.safeParse(bodyJson);
	if (!parsed.success) return rejectMutation(ctx, actorMeta, 400, 'invalid body', 'invalid body');

	// The same per-field ceiling and unreadable-URL refusal every other write path
	// carries — a new write path is exactly where a boundary rule goes missing.
	const tooLarge = await refuseOversizedFields(ctx, actorMeta, parsed.data.fields_data);
	if (tooLarge) return tooLarge;
	const unreadable = await refuseUnreadableUrls(ctx, actorMeta, parsed.data.fields_data);
	if (unreadable) return unreadable;

	const fieldsData: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(parsed.data.fields_data)) {
		fieldsData[name] = sanitizeFieldValue(value);
	}

	const apexResponse = await guard.apex.createEntity(entityType.data, fieldsData);
	const entityId = createdEntityId(apexResponse.body);

	await auditOutcome(ctx, meta, guard.actor, {
		outcome: apexResponse.ok ? 'accepted' : 'apex_error',
		detail: {
			entityType: entityType.data,
			entityId,
			fields: Object.keys(parsed.data.fields_data),
			apexStatus: apexResponse.status
		}
	});

	if (!apexResponse.ok) {
		const status =
			apexResponse.status >= 400 && apexResponse.status < 500 ? apexResponse.status : 502;
		return noStoreJson({ error: 'upstream error', status: apexResponse.status }, status);
	}
	// The id is the whole point of the call — without it the caller cannot put the new
	// row in the parent's array, and a 200 with no id would leave an orphan behind
	// while looking like a success.
	if (!entityId) return noStoreJson({ error: 'unexpected upstream shape' }, 502);

	// `{ok: true, entityId}` — read as `result.entityId` off the flattened body by
	// every caller (`bff-client.js`'s `mutate` spreads the body onto the result). Do
	// not nest it: a caller that reads `undefined` reports failure while the entity
	// exists, and a retry mints a second orphan.
	return noStoreJson({ ok: true, entityId });
}
