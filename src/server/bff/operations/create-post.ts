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
import { buildPostLoad, postRouteMeta, postSchemaOf, rejectedWriteResponse } from './post-shape';
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
	const fieldsShape: Record<string, z.ZodTypeAny> = {};
	for (const def of contract.primitiveFieldDefs(slug)) {
		// AN ARRAY IS REFUSED HERE, in the currency a caller can act on.
		//
		// `z.unknown()` accepted one, `toApexFields` passed it through, and
		// `createPost` → `assertNoArrayFields` then THREW — a framework 500 where a
		// 400 belongs. There is no child-list transport for a post: an array-shaped
		// field on a post schema is not writable at all, and saying so is better than
		// crashing. No post schema on any site declares one today; the next one that
		// does must not find out in production.
		//
		// PROVISIONAL — a capability gate on the backend build, not a rule about
		// posts. A post's fields ride the SAME `archetype_models` controller plan 08
		// fixes, so once that fix is DEPLOYED and VERIFIED an array on a post field
		// is writable and this refine comes out with the rest of the gate, in the one
		// reviewed kit change plan 07's **P3b** node inventories. Until then it stays:
		// on the backend production runs the value is answered 200 and stored as `[]`.
		fieldsShape[def.field_name] = z
			.unknown()
			.refine((value) => !Array.isArray(value), 'a post field does not hold a list')
			.optional();
	}
	return z
		.object({
			title: z.string().min(1).max(300),
			slug: z
				.string()
				.min(1)
				.max(200)
				.regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/u),
			summary: z.string().max(4000).optional(),
			publishedDate: z
				.string()
				.regex(/^(?:\d{4}-\d{2}-\d{2})?$/u)
				.optional(),
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

	// Re-read through the one surface an editor's token can use, so what comes back
	// is what the editor loads.
	const loaded = await buildPostLoad(contract, guard.apex, params.schema, postId);
	if (!loaded) {
		// The post EXISTS and this operation can name it, so the `accepted` row above
		// is true and stays. What must not happen is that the failure of the read that
		// follows leaves no trace: without this row the log says a create succeeded and
		// is silent about the 502 the editor was actually sent.
		await auditOutcome(ctx, meta, guard.actor, {
			outcome: 'apex_error',
			detail: { schema: params.schema, postId, reason: 'post-create-read-failed' }
		});
		return bffError(502, 'unexpected upstream shape');
	}
	return noStoreJson({ ok: true, ...loaded }, 201);
}
