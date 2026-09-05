import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { contractOf, noContractResponse } from '../content-contract-guard';
import {
	buildPostLoad,
	computePostVersion,
	loadPostView,
	normalizeBlocks,
	postIdSchema,
	postSchemaOf,
	readDocumentBlocks,
	readPostArchetype,
	readPostIds
} from './post-shape';
import type { BffContext } from '../context';

/**
 * GET /api/admin/posts/[schema]/[postId]         → `{ post, version, referenceTargets }`
 * GET /api/admin/posts/[schema]/[postId]/version → `{ version }`
 *
 * Both reads: no CSRF, full boundary + session guard. The two are separate
 * operations on purpose, and the difference is cost: the load carries the
 * reference target collections the pickers need; the VERSION read is called once
 * immediately before every save by `savePost()`, so it reads the three records
 * and nothing else.
 */
export async function handleGetPost(
	request: Request,
	ctx: BffContext,
	params: { schema: string; postId: string }
): Promise<Response> {
	const guard = await guardRequest(request, ctx, { mutation: false });
	if (!guard.ok) return guard.response;
	const contract = contractOf(ctx);
	if (!contract) return noContractResponse();
	if (!postSchemaOf(contract, params.schema)) return bffError(404, 'unknown collection');
	const idResult = postIdSchema.safeParse(params.postId);
	if (!idResult.success) return bffError(400, 'invalid post id');

	const loaded = await buildPostLoad(contract, guard.apex, params.schema, idResult.data);
	// A post of another schema, or a deleted one, finds nothing on the scoped read.
	if (!loaded) return bffError(404, 'not found');
	return noStoreJson(loaded);
}

export async function handleReadPostVersion(
	request: Request,
	ctx: BffContext,
	params: { schema: string; postId: string }
): Promise<Response> {
	const guard = await guardRequest(request, ctx, { mutation: false });
	if (!guard.ok) return guard.response;
	const contract = contractOf(ctx);
	if (!contract) return noContractResponse();
	if (!postSchemaOf(contract, params.schema)) return bffError(404, 'unknown collection');
	const idResult = postIdSchema.safeParse(params.postId);
	if (!idResult.success) return bffError(400, 'invalid post id');

	const view = await loadPostView(guard.apex, params.schema, idResult.data);
	if (!view) return bffError(404, 'not found');
	const ids = readPostIds(view);
	const [archetype, apexBlocks] = await Promise.all([
		readPostArchetype(guard.apex, params.schema, ids.archetypeId),
		readDocumentBlocks(guard.apex, ids.documentId)
	]);
	const version = await computePostVersion(
		view,
		archetype,
		normalizeBlocks(apexBlocks),
		contract,
		params.schema
	);
	return noStoreJson({ version });
}
