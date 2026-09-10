import { z } from 'zod';
import { auditOutcome } from '../audit';
import { cleanString } from '../archetype-record';
import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { rejectGuardFailure, rejectMutation } from '../reject';
import { contractOf, noContractResponse } from '../content-contract-guard';
import { loadPostView, postIdSchema, postRouteMeta, postSchemaOf, readPostIds } from './post-shape';
import type { BffContext } from '../context';

/**
 * POST /api/admin/posts/[schema]/[postId]/status — publish / unpublish.
 *
 * `status` is not writable on any field route; this is the only door, which is
 * what keeps "publish" an act with an audit row rather than a value in a form.
 * The two vocabularies meet one line deep, in `changePostStatus`: our wire name
 * is `statusEvent`, Apex's body key is `event`. The status is RE-READ rather than
 * echoed, because the previous shape of this route reported success for a write
 * Apex had refused.
 */
export const postStatusBodySchema = z
	.object({ statusEvent: z.enum(['publish', 'unpublish']) })
	.strict();

export async function handlePatchPostStatus(
	request: Request,
	ctx: BffContext,
	params: { schema: string; postId: string }
): Promise<Response> {
	const contract = contractOf(ctx);
	if (!contract) return noContractResponse();
	const meta = postRouteMeta(request, 'posts.status_event', 'POST', true, '/status');

	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectGuardFailure(request, ctx, meta, guard);
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
	const parsed = postStatusBodySchema.safeParse(bodyJson);
	if (!parsed.success) return rejectMutation(ctx, actor, 400, 'invalid body', 'invalid body');

	const view = await loadPostView(guard.apex, params.schema, idResult.data);
	if (!view) return rejectMutation(ctx, actor, 404, 'not found', 'not found');
	const ids = readPostIds(view);

	const apexResponse = await guard.apex.changePostStatus(ids.postId, parsed.data.statusEvent);

	await auditOutcome(ctx, meta, guard.actor, {
		outcome: apexResponse.ok ? 'accepted' : 'apex_error',
		detail: {
			schema: params.schema,
			postId: ids.postId,
			statusEvent: parsed.data.statusEvent,
			apexStatus: apexResponse.status
		}
	});

	if (!apexResponse.ok) return bffError(502, 'upstream error');

	const fresh = await loadPostView(guard.apex, params.schema, ids.postId);
	// NOT `status`. `bff-client.js`'s `mutate` writes the HTTP status onto its result
	// and THEN spreads the body over it, so a body key called `status` replaces the
	// real one — here with a post-status STRING ('published'), which is worse than the
	// numeric shadow the same reorder fixed elsewhere because it type-checks. No
	// consumer reads it (`save-post.js` and Godrej's `PostList.svelte` read `.ok`);
	// the key is renamed rather than dropped so a screen that wants the fresh status
	// has somewhere to read it.
	return noStoreJson({ ok: true, postStatus: fresh ? cleanString(fresh.status) : '' });
}
