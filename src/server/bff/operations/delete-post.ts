import { auditOutcome } from '../audit';
import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { rejectMutation } from '../reject';
import { contractOf, noContractResponse } from '../content-contract-guard';
import { loadPostView, postIdSchema, postRouteMeta, postSchemaOf, readPostIds } from './post-shape';
import type { BffContext } from '../context';

/**
 * DELETE /api/admin/posts/[schema]/[postId] — remove a post, whole.
 *
 * ONE call, addressed to the ARCHETYPE rather than to the post: deleting the
 * archetype cascades to its `Cms::Post` and to the document that holds the body
 * (measured 2026-09-05: the document reads 404 and the view is gone). Deleting the
 * post instead would leave an orphan archetype behind, which is why the client's
 * `deletePost` takes an archetype id and this operation resolves it from Apex's
 * own record — through the schema-scoped read — rather than from the browser.
 *
 * There is no in-use guard here: nothing references a post. Deleting a record a
 * post points AT is the guarded direction, in `delete-record.ts`.
 */
export async function handleDeletePost(
	request: Request,
	ctx: BffContext,
	params: { schema: string; postId: string }
): Promise<Response> {
	const contract = contractOf(ctx);
	if (!contract) return noContractResponse();
	const meta = postRouteMeta(request, 'posts.delete', 'DELETE', params.schema, params.postId);

	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectMutation(ctx, meta, guard.status, guard.reason, guard.reason);
	const actor = { ...meta, actorEmail: guard.actor.email, actorSub: guard.actor.sub };

	if (!postSchemaOf(contract, params.schema)) {
		return rejectMutation(ctx, actor, 404, 'unknown collection', 'unknown collection');
	}
	const idResult = postIdSchema.safeParse(params.postId);
	if (!idResult.success) return rejectMutation(ctx, actor, 400, 'invalid id', 'invalid post id');

	const view = await loadPostView(guard.apex, params.schema, idResult.data);
	if (!view) return rejectMutation(ctx, actor, 404, 'not found', 'not found');
	const ids = readPostIds(view);
	if (!ids.archetypeId) return bffError(502, 'unexpected upstream shape');

	const apexResponse = await guard.apex.deletePost(params.schema, ids.archetypeId);

	await auditOutcome(ctx, meta, guard.actor, {
		outcome: apexResponse.ok ? 'accepted' : 'apex_error',
		detail: {
			schema: params.schema,
			postId: ids.postId,
			archetypeId: ids.archetypeId,
			apexStatus: apexResponse.status
		}
	});

	if (!apexResponse.ok) return bffError(502, 'upstream error');
	return noStoreJson({ ok: true });
}
