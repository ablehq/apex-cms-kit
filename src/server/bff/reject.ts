import { bffError } from './boundary';
import { auditRejection } from './audit';
import { resolveSession } from './guard';
import type { GuardResult } from './guard';
import type { BffContext } from './context';

/**
 * The fixed metadata a rejected mutation records. `action`/`method`/`path` are the
 * operation's own constants (never attacker-controlled), so an audited rejection
 * can be attributed to a route even when the caller could not be identified. A
 * route PARAMETER therefore never belongs in `path`; put it in `detail`, and only
 * once it has been validated.
 */
export interface RejectMeta {
	action: string;
	method: string;
	path: string;
	actorEmail?: string;
	actorSub?: string | null;
	pageId?: string | null;
	requestId?: string | null;
	/** Extra context for the audit row, merged alongside `reason`. Never a secret. */
	detail?: Record<string, unknown>;
}

/**
 * F4 (3a.1 review hardening): the single exit every mutation takes when it turns a
 * request away — a failed guard (forged token, cross-origin, missing CSRF) or a
 * strict-validation failure (unknown field, bad id, review-only field). It writes
 * one append-only `outcome: 'rejected'` row (best-effort — a D1 hiccup must never
 * upgrade a correct 4xx into a 500) and returns the opaque `bffError` the client
 * sees. Accepted / apex_error rows are still written inline by the op on its happy
 * and upstream-failure paths; this closes the third path.
 */
export async function rejectMutation(
	ctx: BffContext,
	meta: RejectMeta,
	status: number,
	code: string,
	reason: string
): Promise<Response> {
	if (ctx.db) {
		try {
			await auditRejection(ctx.db, {
				id: crypto.randomUUID(),
				occurredAt: new Date(ctx.now ?? Date.now()).toISOString(),
				actorEmail: meta.actorEmail ?? 'unknown',
				actorSub: meta.actorSub ?? null,
				action: meta.action,
				method: meta.method,
				path: meta.path,
				accountId: ctx.accountId ?? null,
				pageId: meta.pageId ?? null,
				requestId: meta.requestId ?? null,
				...(meta.detail ? { detail: meta.detail } : {}),
				reason
			});
		} catch {
			// swallow — auditing a rejection must not change the rejection's outcome
		}
	}
	return bffError(status, code);
}

/**
 * The GUARD-failure exit, for operations reachable by the open internet (3c
 * round-3 finding 9). `rejectMutation` writes a row, so taking it before anyone
 * has authenticated hands an unauthenticated caller one D1 INSERT per request —
 * write amplification an attacker controls. That is exactly the property
 * `ingest-guard.ts` states for the machine surface ("FAILED AUTH PERFORMS NO D1
 * WRITES — a read at most"), and it belongs here too:
 *
 *   - nobody signed in → the guard's own response, no audit row;
 *   - a REAL session that still fails the boundary (CSRF, cross-origin) → one
 *     audited rejection attributed to that editor, exactly as before.
 *
 * `guardRequest` checks the boundary BEFORE the session, so a 403 arrives with
 * the session unresolved and answering "was anyone actually signed in?" costs
 * one indexed read. A 401 is already proof that nobody was, so it costs nothing.
 */
export async function rejectGuardFailure(
	request: Request,
	ctx: BffContext,
	meta: RejectMeta,
	guard: Extract<GuardResult, { ok: false }>
): Promise<Response> {
	const session =
		guard.status === 401 ? null : await resolveSession(request, ctx).catch(() => null);
	if (!session) return guard.response;
	return rejectMutation(
		ctx,
		{ ...meta, actorEmail: session.staffEmail, actorSub: session.staffId },
		guard.status,
		guard.reason,
		guard.reason
	);
}
