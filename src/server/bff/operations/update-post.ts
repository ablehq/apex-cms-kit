import { z } from 'zod';
import { auditOutcome } from '../audit';
import { containsNullPrimitive } from '../authorization';
import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { rejectMutation } from '../reject';
import { contractOf, noContractResponse } from '../content-contract-guard';
import {
	buildPostLoad,
	coverAttributes,
	loadPostView,
	metaAttributes,
	postIdSchema,
	postRouteMeta,
	postSchemaOf,
	readPostIds
} from './post-shape';
import type { PostFields } from '../apex-admin-client';
import type { BffContext } from '../context';

/**
 * PATCH /api/admin/posts/[schema]/[postId] — the post's OWN fields: title, slug,
 * summary, published date, the SEO triple and the cover.
 *
 * The endpoint is `PATCH /cms/posts/:postId`, and that is not a preference.
 * Routing a post's fields through `archetype_models` answers **422 `Slug has
 * already been taken`**, because the service validates a freshly built `Cms::Post`
 * whose slug collides with the post's own. The Apex client has no method that can
 * express that mistake.
 *
 * SEO AND THE COVER ARE WRITTEN BY ID. Both are `accepts_nested_attributes_for`:
 * an entry without an id creates a SECOND row (measured for both), so the ids
 * come from the record read in this request, never from the browser.
 *
 * `coverId` is the one key here where `null` is CORRECT — it is a reference to a
 * gallery item, and `null` destroys the cover row, which is exactly "this post has
 * no cover". Every other key is a `Cms::Post` column where a clear is `''`.
 */
export const updatePostBodySchema = z
	.object({
		title: z.string().min(1).max(300).optional(),
		slug: z
			.string()
			.min(1)
			.max(200)
			.regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/u)
			.optional(),
		summary: z.string().max(4000).optional(),
		publishedDate: z
			.string()
			.regex(/^(?:\d{4}-\d{2}-\d{2})?$/u)
			.optional(),
		meta: z
			.object({
				title: z.string().max(300).optional(),
				description: z.string().max(1000).optional(),
				keywords: z.string().max(500).optional()
			})
			.strict()
			.optional(),
		coverId: postIdSchema.nullable().optional()
	})
	.strict();

export async function handleUpdatePost(
	request: Request,
	ctx: BffContext,
	params: { schema: string; postId: string }
): Promise<Response> {
	const contract = contractOf(ctx);
	if (!contract) return noContractResponse();
	const meta = postRouteMeta(request, 'posts.update', 'PATCH', params.schema, params.postId);

	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectMutation(ctx, meta, guard.status, guard.reason, guard.reason);
	const actor = { ...meta, actorEmail: guard.actor.email, actorSub: guard.actor.sub };

	if (!postSchemaOf(contract, params.schema)) {
		return rejectMutation(ctx, actor, 404, 'unknown collection', 'unknown collection');
	}
	const idResult = postIdSchema.safeParse(params.postId);
	if (!idResult.success) return rejectMutation(ctx, actor, 400, 'invalid id', 'invalid post id');

	let bodyJson: unknown;
	try {
		bodyJson = await request.json();
	} catch {
		return rejectMutation(ctx, actor, 400, 'invalid json', 'invalid json');
	}

	// The shared null guard, told that `coverId` is the one reference-shaped key.
	if (
		bodyJson &&
		typeof bodyJson === 'object' &&
		containsNullPrimitive(bodyJson as Record<string, unknown>, ['coverId'])
	) {
		return rejectMutation(ctx, actor, 400, 'null-field', 'null primitive');
	}
	const parsed = updatePostBodySchema.safeParse(bodyJson);
	if (!parsed.success) return rejectMutation(ctx, actor, 400, 'invalid body', 'invalid body');

	const view = await loadPostView(guard.apex, params.schema, idResult.data);
	if (!view) return rejectMutation(ctx, actor, 404, 'not found', 'not found');
	const ids = readPostIds(view);

	const fields: PostFields = {};
	if (parsed.data.title !== undefined) fields.title = parsed.data.title;
	if (parsed.data.slug !== undefined) fields.slug = parsed.data.slug;
	if (parsed.data.summary !== undefined) fields.summary = parsed.data.summary;
	if (parsed.data.publishedDate !== undefined) fields.published_date = parsed.data.publishedDate;
	if (parsed.data.meta) {
		const attributes = metaAttributes(view, parsed.data.meta);
		if (attributes.length > 0) fields.meta_properties_attributes = attributes;
	}
	if (parsed.data.coverId !== undefined) {
		const attributes = coverAttributes(view, parsed.data.coverId);
		if (attributes) fields.shared_gallery_items_attributes = attributes;
	}

	// Nothing to write is not an error — the browser only sends what changed, and a
	// cover set to what it already is has nothing to say to Apex.
	const apexResponse =
		Object.keys(fields).length > 0
			? await guard.apex.updatePostFields(ids.postId, fields)
			: { ok: true, status: 200, body: null };

	await auditOutcome(ctx, meta, guard.actor, {
		outcome: apexResponse.ok ? 'accepted' : 'apex_error',
		detail: {
			schema: params.schema,
			postId: ids.postId,
			fields: Object.keys(fields),
			apexStatus: apexResponse.status
		}
	});

	if (apexResponse.status === 422) return bffError(409, 'slug-taken');
	if (!apexResponse.ok) return bffError(502, 'upstream error');

	// Re-read rather than echo: the write surface answers 200 for shapes it drops.
	const loaded = await buildPostLoad(contract, guard.apex, params.schema, ids.postId);
	if (!loaded) return bffError(502, 'unexpected upstream shape');
	return noStoreJson({ ok: true, post: loaded.post, version: loaded.version });
}
