import { z } from 'zod';
import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { cleanString, unwrapArchetypeCollection } from '../archetype-record';
import { contractOf, noContractResponse } from '../content-contract-guard';
import { loadReferenceTargets } from './list-records';
import { PAGE_SIZE } from './record-shape';
import type { AdminRecord } from './record-shape';
import { postSchemaOf, summarizePost } from './post-shape';
import type { AdminPost } from './post-shape';
import type { ApexAdminClient } from '../apex-admin-client';
import type { ContentContract } from '../content-contract';
import type { BffContext } from '../context';

/**
 * GET /api/admin/posts/[schema] — the list screen's one read: every post of one
 * schema, with its archetype half joined, plus the reference target collections
 * the rows and the pickers resolve names against.
 *
 * NAMED `post-list`, NOT `list-posts`, and that is not taste. Vite 6.2's package
 * `exports` matcher treats a bare subpath whose name ENDS IN `ts` (or `js`) as a
 * hit for this package's `./*.ts` (`./*.js`) pattern and looks for
 * `list-pos.ts`, which does not exist — measured 2026-09-05 with `zz-ends-ts`
 * (fails), `zz-ends-js` (fails), `zz-ends-xx` (resolves); Node's own resolver
 * gets all three right. So a kit module a site imports bare must not have a
 * name ending in `ts`, `js`, `css` or `svelte`. Any future module in this
 * package inherits the rule.
 *
 * TWO reads, not N+1. `post_archetype_views` carries the post fields and the
 * `archetype_id`; `specification/archetypes` for the same schema carries the
 * items and the taggings (measured 2026-09-05). Joined by archetype id here, so
 * the list costs two calls however long it is — plus one per reference target
 * collection, exactly as the record list pays. Bodies are NOT read for the list.
 *
 * THE STATUS FILTER IS APPLIED HERE, NOT UPSTREAM. The screen's tab counts must
 * be counts of posts, not of guesses, so the browser asks for everything and the
 * filter narrows in memory.
 */
export const listPostsQuerySchema = z
	.object({ status: z.enum(['all', 'published', 'draft']).optional() })
	.strict();

/** Every post of one schema, summarized without bodies, plus the reference targets. */
export async function loadPostCatalogue(
	contract: ContentContract,
	apex: ApexAdminClient,
	slug: string
): Promise<{ posts: AdminPost[]; referenceTargets: Record<string, AdminRecord[]> } | null> {
	const [views, archetypes] = await Promise.all([
		apex.listPosts(slug, { per_page: PAGE_SIZE, page: 1, 'q[sorts][]': 'created_at desc' }),
		apex.listPostArchetypes(slug, { per_page: PAGE_SIZE, page: 1 })
	]);
	if (!views.ok || !archetypes.ok) return null;

	const byArchetypeId = new Map<string, Record<string, unknown>>();
	for (const record of unwrapArchetypeCollection(archetypes.body)) {
		const id = cleanString(record.id);
		if (id) byArchetypeId.set(id, record);
	}

	const posts = unwrapArchetypeCollection(views.body)
		.map((view) =>
			summarizePost(
				contract,
				slug,
				view,
				byArchetypeId.get(cleanString(view.archetype_id)) ?? null,
				[]
			)
		)
		.filter((post) => post.id.length > 0);

	const targets = await loadReferenceTargets(contract, apex, slug);
	if (!targets.ok) return null;
	return { posts, referenceTargets: targets.targets };
}

export async function handleListPosts(
	request: Request,
	ctx: BffContext,
	params: { schema: string }
): Promise<Response> {
	const guard = await guardRequest(request, ctx, { mutation: false });
	if (!guard.ok) return guard.response;
	const contract = contractOf(ctx);
	if (!contract) return noContractResponse();
	if (!postSchemaOf(contract, params.schema)) return bffError(404, 'unknown collection');

	const raw = Object.fromEntries(new URL(request.url).searchParams.entries());
	const parsed = listPostsQuerySchema.safeParse(raw);
	if (!parsed.success) return bffError(400, 'invalid query');

	const catalogue = await loadPostCatalogue(contract, guard.apex, params.schema);
	if (!catalogue) return bffError(502, 'upstream error');

	const status = parsed.data.status ?? 'all';
	const posts =
		status === 'all'
			? catalogue.posts
			: catalogue.posts.filter((post) =>
					status === 'published' ? post.status === 'published' : post.status !== 'published'
				);

	return noStoreJson({
		schema: params.schema,
		posts,
		referenceTargets: catalogue.referenceTargets
	});
}
