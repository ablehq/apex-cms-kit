import { z } from 'zod';
import { appendAuditEntry } from '../audit';

import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { rejectMutation } from '../reject';
import type { BffContext } from '../context';

/**
 * PATCH /api/admin/pages/[pageId]/status — the write route that proves the mutation
 * pattern (plan §8, 3a). Publish/unpublish is `POST .../status_event` in Apex
 * (`:status` is not a permitted page param — `02 §5`), so this route maps a typed
 * event onto that one fixed call. NOTE: `status_event` below is OUR wire name, on our
 * own same-origin surface; Apex's body key for that endpoint is `event`, and the
 * translation happens in exactly one place — see `changePageStatus` in
 * `apex-admin-client.ts`, which carries the measured evidence. Guards: full boundary hygiene INCLUDING the CSRF
 * token (mutation), Access-JWT verification, the editor allowlist. It fails closed
 * on an unknown method (the router 405s), a malformed id, invalid/unknown body
 * fields (the schema is `.strict()`), and a non-editor identity.
 *
 * Reserved invariant: this route can NEVER set `transcript_reviewed` — only the
 * dedicated human-review route (not built in the scaffold) may. The strict body
 * schema already rejects it; the explicit check below documents the invariant.
 */
export const pageIdSchema = z
	.string()
	.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);

export const statusBodySchema = z
	.object({ status_event: z.enum(['publish', 'unpublish']) })
	.strict();

export async function handlePatchPageStatus(
	request: Request,
	ctx: BffContext,
	params: { pageId: string }
): Promise<Response> {
	const meta = {
		action: 'pages.status_event',
		method: 'PATCH',
		path: `/api/admin/pages/${params.pageId}/status`,
		pageId: params.pageId,
		requestId: request.headers.get('cf-ray')
	};

	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectMutation(ctx, meta, guard.status, guard.reason, guard.reason);

	const idResult = pageIdSchema.safeParse(params.pageId);
	if (!idResult.success) {
		return rejectMutation(
			ctx,
			{ ...meta, actorEmail: guard.actor.email },
			400,
			'invalid page id',
			'invalid page id'
		);
	}

	let bodyJson: unknown;
	try {
		bodyJson = await request.json();
	} catch {
		return rejectMutation(
			ctx,
			{ ...meta, actorEmail: guard.actor.email },
			400,
			'invalid json',
			'invalid json'
		);
	}

	if (
		typeof bodyJson === 'object' &&
		bodyJson !== null &&
		ctx.reviewOnlyFields.some((field) => field in bodyJson)
	) {
		return rejectMutation(
			ctx,
			{ ...meta, actorEmail: guard.actor.email },
			400,
			'field not allowed',
			'review-only field'
		);
	}

	const bodyResult = statusBodySchema.safeParse(bodyJson);
	if (!bodyResult.success) {
		return rejectMutation(
			ctx,
			{ ...meta, actorEmail: guard.actor.email },
			400,
			'invalid body',
			'invalid body'
		);
	}

	const apexResponse = await guard.apex.changePageStatus(
		idResult.data,
		bodyResult.data.status_event
	);
	const outcome = apexResponse.ok ? 'accepted' : 'apex_error';

	if (ctx.db) {
		await appendAuditEntry(ctx.db, {
			id: crypto.randomUUID(),
			occurredAt: new Date(ctx.now ?? Date.now()).toISOString(),
			actorEmail: guard.actor.email,
			actorSub: guard.actor.sub,
			action: 'pages.status_event',
			method: 'PATCH',
			path: `/api/admin/pages/${idResult.data}/status`,
			accountId: ctx.accountId ?? null,
			pageId: idResult.data,
			requestId: request.headers.get('cf-ray'),
			outcome,
			detail: { status_event: bodyResult.data.status_event, apexStatus: apexResponse.status }
		});
	}

	if (!apexResponse.ok) return bffError(502, 'upstream error');
	return noStoreJson({ ok: true, status_event: bodyResult.data.status_event });
}
