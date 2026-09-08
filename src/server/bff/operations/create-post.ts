import { z } from 'zod';
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
import { contractOf, noContractResponse } from '../content-contract-guard';
import { toApexFields } from './update-record';
import { primitiveFieldsShape } from './record-shape';
import {
	buildPostLoad,
	postRouteMeta,
	postSchemaOf,
	publishedDateSchema,
	rejectedWriteResponse
} from './post-shape';
import type { ContentContract } from '../content-contract';
import type { BffContext } from '../context';

/**
 * POST /api/admin/posts/[schema] — mint a post.
 *
 * ONE Apex call creates all three records: the archetype, its `Cms::Post`, an
 * empty `Cms::Document`, and any primitive sent beside them (a story's `kind`).
 * That is what makes create-then-reveal cheap — the "New …" flow creates the
 * record FIRST and only then renders a form bound to the real id — and safe: a new
 * post is `draft`, and the snapshot filters `q[status_eq]=published`.
 *
 * REFERENCES ARE NOT WRITABLE ON CREATE, as on the record create: the editor sets
 * them on the screen that opens a moment later, through the archetype update that
 * diffs against a fresh read. `fields` (the archetype primitives) ARE, because a
 * story's `kind` is an enum the create dialog asks for.
 *
 * The slug is the post's public address, so the schema pins it to a URL-safe
 * charset. `Cms::Post` slugs are unique PER ACCOUNT ACROSS SCHEMAS (measured
 * 2026-09-05: an update may not take a story's slug), and Apex says so with a
 * 422 that comes back here as `409 slug-taken` when the slug is what it refused —
 * something an editor can act on — and as `422 invalid` with Apex's own field
 * errors otherwise.
 */
export function createPostBodySchema(contract: ContentContract, slug: string) {
	// THE SAME `fields` SHAPE A RECORD GETS, from the same builder, because a post's
	// primitives are written through the same `archetype_models` controller
	// (`createPost` POSTs to `archetype_schemas/:slug/archetype_models`). So the
	// question "may this field carry an array" has one answer per field, not one per
	// operation, and `primitiveFieldsShape` is where it is asked — for the array
	// kinds the backend stores and, for everything else, the refusal that keeps an
	// array off a field the flat surface would empty. Spelling it twice is how the
	// two drift.
	const fieldsShape = primitiveFieldsShape(contract, slug);
	return z
		.object({
			title: z.string().min(1).max(300),
			slug: z
				.string()
				.min(1)
				.max(200)
				.regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/u),
			summary: z.string().max(4000).optional(),
			// The shape AND the calendar — `2026-13-45` passes a regex, reaches Apex,
			// and is cast to `nil` with a 200 (`post.rb` validates nothing).
			publishedDate: publishedDateSchema.optional(),
			fields: z.object(fieldsShape).strict().optional()
		})
		.strict();
}

export async function handleCreatePost(
	request: Request,
	ctx: BffContext,
	params: { schema: string }
): Promise<Response> {
	const contract = contractOf(ctx);
	if (!contract) return noContractResponse();
	const meta = postRouteMeta(request, 'posts.create', 'POST');

	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectGuardFailure(request, ctx, meta, guard);
	const actor = { ...meta, actorEmail: guard.actor.email, actorSub: guard.actor.sub };

	if (!postSchemaOf(contract, params.schema)) {
		return rejectMutation(ctx, actor, 404, 'unknown collection', 'unknown collection');
	}

	let bodyJson: unknown;
	try {
		bodyJson = await request.json();
	} catch {
		return rejectMutation(ctx, actor, 400, 'invalid json', 'invalid json');
	}

	const submitted = (bodyJson as { fields?: Record<string, unknown> })?.fields;
	if (submitted && containsNullPrimitive(submitted)) {
		return rejectMutation(ctx, actor, 400, 'null-field', 'null primitive');
	}

	// The per-field ceiling, named before the shape check so the refusal can say
	// WHICH field is over it (`field-too-large`) rather than a generic `invalid body`.
	//
	// THIS PATH HAD NO CEILING AT ALL. `fields` is `z.unknown()` per primitive, so
	// nothing capped it on the way to `toApexFields` — the one create path where an
	// unbounded value could reach Apex, the snapshot and every render of the field,
	// while its three siblings refused it. Found by the P4 review (finding 2).
	const tooLarge = await refuseOversizedFields(ctx, actor, submitted);
	if (tooLarge) return tooLarge;
	// The other half of the same rule (Opus O5): a URL attribute this judge cannot
	// read is refused BY NAME rather than silently stripped on the way through the
	// sanitizer, so an editor is told which field to look at.
	const unreadable = await refuseUnreadableUrls(ctx, actor, submitted);
	if (unreadable) return unreadable;

	const parsed = createPostBodySchema(contract, params.schema).safeParse(bodyJson);
	if (!parsed.success) return rejectMutation(ctx, actor, 400, 'invalid body', 'invalid body');

	const fields = toApexFields(parsed.data.fields ?? {});
	const apexResponse = await guard.apex.createPost(
		params.schema,
		{
			title: parsed.data.title,
			slug: parsed.data.slug,
			summary: parsed.data.summary ?? '',
			published_date: parsed.data.publishedDate ?? ''
		},
		fields
	);

	// Apex answers with the ARCHETYPE; the admin addresses a post by its POST id,
	// which is the archetype's `target_model_id`. THE VERDICT ON IT IS TAKEN BEFORE
	// THE AUDIT IS WRITTEN — the rule and the reasoning are in `created-id.ts`. This
	// handler used to audit `accepted` on any 2xx and then answer 502 when the id was
	// missing or unusable (codex's P5 fix review, 2026-09-08).
	const record = unwrapArchetypeRecord(apexResponse.body);
	const verdict = judgeCreatedId(
		apexResponse.ok,
		record ? cleanString(record.target_model_id) : null,
		'post'
	);

	await auditOutcome(ctx, meta, guard.actor, {
		outcome: createdIdOutcome(apexResponse.ok, verdict),
		detail: {
			schema: params.schema,
			slug: parsed.data.slug,
			postId: verdict.id,
			...shapeFaultDetail(verdict),
			fields: Object.keys(fields),
			apexStatus: apexResponse.status
		}
	});

	// A 422 is Apex's own validation: `409 slug-taken` only when the slug is what
	// it refused, otherwise `422 invalid` with the field errors.
	if (apexResponse.status === 422) return rejectedWriteResponse(apexResponse.body);
	if (!apexResponse.ok) return bffError(502, 'upstream error');
	const postId = verdict.id;
	if (postId === null) return bffError(502, 'unexpected upstream shape');

	// Re-read through the schema-scoped surface, so what comes back is what the
	// editor loads.
	//
	// THE POST EXISTS AND THIS OPERATION CAN NAME IT. So a failed read is not a
	// failed create, and answering 502 was how a post that had been minted came back
	// to the browser as an error — the "New …" dialog then offered the same slug
	// again, and the second attempt was `409 slug-taken` for a post the editor could
	// not see. `ok: true, unread: true` with the ids, and the editor's own load
	// decides what happens next. The `accepted` row above stays true; this second row
	// is what keeps the log from being silent about the degraded answer.
	const loaded = await buildPostLoad(contract, guard.apex, params.schema, postId);
	if (!loaded || loaded.ok !== true) {
		await auditOutcome(ctx, meta, guard.actor, {
			outcome: 'accepted',
			detail: {
				schema: params.schema,
				postId,
				unread: true,
				reason: loaded ? loaded.reason : 'post-create-read-failed'
			}
		});
		return noStoreJson(
			{
				ok: true,
				unread: true,
				post: { id: postId, archetypeId: record ? cleanString(record.id) : '', status: 'draft' }
			},
			201
		);
	}
	return noStoreJson(
		{
			ok: true,
			post: loaded.post,
			version: loaded.version,
			bodyVersion: loaded.bodyVersion,
			referenceTargets: loaded.referenceTargets
		},
		201
	);
}
