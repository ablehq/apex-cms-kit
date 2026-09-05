import { z } from 'zod';
import { auditOutcome } from '../audit';
import { containsNullPrimitive } from '../authorization';
import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { rejectMutation } from '../reject';
import { cleanString, unwrapArchetypeRecord } from '../archetype-record';
import { contractOf, noContractResponse } from '../content-contract-guard';
import { toApexFields } from './update-record';
import { buildPostLoad, postIdSchema, postRouteMeta, postSchemaOf } from './post-shape';
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
 * 422 that comes back here as `409 slug-taken` — something an editor can act on.
 */
export function createPostBodySchema(contract: ContentContract, slug: string) {
	const fieldsShape: Record<string, z.ZodTypeAny> = {};
	for (const def of contract.primitiveFieldDefs(slug)) {
		fieldsShape[def.field_name] = z.unknown().optional();
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
	const meta = postRouteMeta(request, 'posts.create', 'POST', params.schema);

	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectMutation(ctx, meta, guard.status, guard.reason, guard.reason);
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

	await auditOutcome(ctx, meta, guard.actor, {
		outcome: apexResponse.ok ? 'accepted' : 'apex_error',
		detail: {
			schema: params.schema,
			slug: parsed.data.slug,
			fields: Object.keys(fields),
			apexStatus: apexResponse.status
		}
	});

	if (apexResponse.status === 422) return bffError(409, 'slug-taken');
	if (!apexResponse.ok) return bffError(502, 'upstream error');

	// Apex answers with the ARCHETYPE; the admin addresses a post by its POST id,
	// which is the archetype's `target_model_id`. Re-read through the one surface
	// an editor's token can use, so what comes back is what the editor loads.
	const record = unwrapArchetypeRecord(apexResponse.body);
	const postId = record ? cleanString(record.target_model_id) : '';
	if (!postIdSchema.safeParse(postId).success) return bffError(502, 'unexpected upstream shape');

	const loaded = await buildPostLoad(contract, guard.apex, params.schema, postId);
	if (!loaded) return bffError(502, 'unexpected upstream shape');
	return noStoreJson({ ok: true, ...loaded }, 201);
}
