import { bffError } from './boundary';
import { auditRejection } from './audit';
import { resolveSession } from './guard';
import { oversizedFieldNames, residualReferenceFieldNames } from '../../sanitize/write-boundary';
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
		guard.status === 401
			? null
			: // ATTRIBUTION ONLY (Opus O6). The request is already refused; the single
				// question left is "whose editor session was it?". `{ refresh: false }`
				// answers that from the row and stops there — no `sessions.delete` on an
				// expired cookie, no upstream token refresh. Both are WRITES (D1, and an
				// Apex round-trip) bought by a request that will not be served, on a path
				// the open internet can reach; and a refused request is the worst possible
				// moment to end somebody's session as a side effect.
				await resolveSession(request, ctx, { refresh: false }).catch(() => null);
	if (!session) return guard.response;
	return rejectMutation(
		ctx,
		{ ...meta, actorEmail: session.staffEmail, actorSub: session.staffId },
		guard.status,
		guard.reason,
		guard.reason
	);
}

/**
 * The per-field ceiling refusal, written once for every write path that has one.
 *
 * `MAX_FIELD_VALUE_CHARS` is the mechanic (see `sanitize/write-boundary.ts`); this
 * is how a route says no to it. Returns `null` when nothing is over — so a caller
 * reads as `const tooLarge = await refuseOversizedFields(…); if (tooLarge) return
 * tooLarge;` — and a typed 400 `field-too-large` naming the fields when something
 * is, rather than folding it into the generic `invalid body` a zod `.max()` would
 * produce or letting the value reach Apex, where the flat surface answers 200 over
 * what it did not store.
 */
export async function refuseOversizedFields(
	ctx: BffContext,
	meta: RejectMeta,
	fields: unknown
): Promise<Response | null> {
	const over = oversizedFieldNames(fields);
	if (over.length === 0) return null;
	return rejectMutation(ctx, meta, 400, 'field-too-large', `field too large: ${over.join(', ')}`);
}

/**
 * The unreadable-URL refusal, the twin of `refuseOversizedFields`.
 *
 * OPUS O5. `sanitizeWriteHtml` fails closed on a URL attribute that still carries a
 * character reference after a full decode — correct, because the decoder's windows
 * are narrower than a browser's and nothing re-escapes at the write boundary — but
 * it did so by SILENTLY DROPPING the attribute. An editor whose link had a
 * double-encoded `&amp;amp;` in it saved, got a 200, and found the link gone with no
 * explanation. The known false positives are narrow and harmless
 * (`residualReferenceFieldNames` names them), which is exactly why the answer is a
 * typed refusal naming the field rather than a wider rule or a silent strip.
 *
 * Same call shape as the ceiling: `null` when nothing is wrong, a typed 400 when
 * something is. Called on every write path that carries authored HTML.
 */
export async function refuseUnreadableUrls(
	ctx: BffContext,
	meta: RejectMeta,
	fields: unknown
): Promise<Response | null> {
	const named = residualReferenceFieldNames(fields);
	if (named.length === 0) return null;
	return rejectMutation(
		ctx,
		meta,
		400,
		'unreadable-url',
		`link cannot be read: ${named.join(', ')}`
	);
}
