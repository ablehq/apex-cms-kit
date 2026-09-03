import { appendAuditEntry } from '../audit';
import { noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { rejectMutation } from '../reject';
import { publishContent, ContentPublishError } from '../../content/publish';
import { ContentUnavailableError, manifestOf, readContent } from '../../content/read';
import type { BffContext } from '../context';

/**
 * `/api/admin/site/publish` — the rail's "Publish site" button (plan §2.3).
 *
 * POST fetches every collection from Apex AS THE EDITOR, projects it, and writes
 * the one KV value the public routes read. It is the one action in the admin that
 * changes what a member of the public sees, so it takes the whole mutation path —
 * CSRF, same-origin, a resolved session, an audit row naming the editor — and the
 * Apex reads carry that editor's token, so Apex's audit names them too.
 *
 * The request runs as long as the fetch takes (tens of seconds; Workers has no
 * wall-clock limit while the client waits). A refusal — no account pin, the wrong
 * account, a collection that emptied — is a 409 with a named code and a sentence;
 * an Apex failure is a 502; nothing is written in either case.
 */
export async function handlePublishSite(request: Request, ctx: BffContext): Promise<Response> {
	const meta = {
		action: 'site.publish',
		method: 'POST',
		path: '/api/admin/site/publish',
		requestId: request.headers.get('cf-ray')
	};

	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectMutation(ctx, meta, guard.status, guard.reason, guard.reason);

	if (!ctx.content) {
		await audit(ctx, guard.actor, 'apex_error', { reason: 'not_configured' });
		return noStoreJson(
			{
				error: 'content_not_configured',
				detail: 'The CONTENT KV binding is not set on this deployment.'
			},
			501
		);
	}

	const body = (await request.json().catch(() => null)) as { allowEmpty?: unknown } | null;
	let result;
	try {
		result = await publishContent({
			apex: guard.apex,
			kv: ctx.content,
			project: ctx.project,
			accountId: ctx.accountId,
			publishedBy: guard.actor.email,
			allowEmpty: body?.allowEmpty === true,
			now: ctx.now
		});
	} catch (error) {
		// Our own publish errors carry an operator-safe sentence ("tags: Apex 502");
		// anything else is logged here and answered with a fixed one.
		const known = error instanceof ContentPublishError;
		if (!known) console.error('[publish] failed', error);
		const detail = known ? error.message : 'Publish failed; see the Worker logs.';
		await audit(ctx, guard.actor, 'apex_error', { detail });
		return noStoreJson({ error: 'apex_error', detail }, known ? error.status : 502);
	}

	if (!result.ok) {
		await audit(ctx, guard.actor, 'rejected', { code: result.error, detail: result.detail });
		return noStoreJson({ error: result.error, detail: result.detail }, 409);
	}
	await audit(ctx, guard.actor, 'accepted', { version: result.version, counts: result.counts });
	return noStoreJson(result);
}

/** GET — what the site is serving now, for the rail. Session-gated, no CSRF. */
export async function handleSiteStatus(request: Request, ctx: BffContext): Promise<Response> {
	const guard = await guardRequest(request, ctx, { mutation: false });
	if (!guard.ok) return guard.response;
	try {
		return noStoreJson({ published: manifestOf(await readContent(ctx.content)) });
	} catch (cause) {
		if (cause instanceof ContentUnavailableError) return noStoreJson({ published: null });
		throw cause;
	}
}

async function audit(
	ctx: BffContext,
	actor: { email: string; sub: string | null },
	outcome: 'accepted' | 'rejected' | 'apex_error',
	detail: Record<string, unknown>
) {
	if (!ctx.db) return;
	try {
		await appendAuditEntry(ctx.db, {
			id: crypto.randomUUID(),
			occurredAt: new Date(ctx.now ?? Date.now()).toISOString(),
			actorEmail: actor.email,
			actorSub: actor.sub,
			action: 'site.publish',
			method: 'POST',
			path: '/api/admin/site/publish',
			accountId: ctx.accountId ?? null,
			requestId: null,
			outcome,
			detail
		});
	} catch {
		// Auditing must never change the outcome of the thing it audits.
	}
}
