import { z } from 'zod';
import { bffError, enforceBrowserBoundary, noStoreHeaders } from '../boundary';
import { appendAuditEntry } from '../audit';
import {
	clearedSessionCookieHeader,
	createSessionSecret,
	isSecureRequest,
	readSessionCookie,
	sessionCookieHeader,
	sessionIdFor,
	SESSION_ABSOLUTE_TTL_MS
} from '../session';
import type { BffContext } from '../context';

/**
 * Login and logout — the only two BFF operations that do NOT run behind
 * `guardRequest`, because they are what creates and destroys the thing the guard
 * checks. They still run behind the full browser boundary (exact Origin,
 * `Sec-Fetch-Site: same-origin`, and the double-submit CSRF token on both, since
 * both are mutations): a cross-site page must be able neither to log someone in as
 * an attacker-controlled account nor to log them out.
 *
 * The password crosses this process exactly once, in memory, on its way to Apex's
 * token endpoint. It is never stored, never logged, and never put in an audit
 * `detail`. What comes back — the Apex access + refresh token for that person — is
 * written to D1 and to nothing else; the browser is handed an opaque cookie.
 */

/**
 * The login body. `.strict()`, both fields bounded. The email bound is RFC 5321's
 * 320-character maximum; the password bound just keeps a megabyte of junk from
 * being forwarded upstream.
 */
export const loginBodySchema = z
	.object({
		email: z.string().trim().min(3).max(320),
		password: z.string().min(1).max(512)
	})
	.strict();

/** Refuse an oversized login body before parsing it. */
const MAX_LOGIN_BODY_BYTES = 8 * 1024;

const LOGIN_ACTION = 'auth.login';
const LOGOUT_ACTION = 'auth.logout';

/** Audit without ever letting an audit failure change the auth outcome. */
async function audit(
	ctx: BffContext,
	entry: {
		actorEmail: string;
		actorSub?: string | null;
		action: string;
		method: string;
		path: string;
		outcome: 'accepted' | 'rejected';
		detail?: unknown;
	}
): Promise<void> {
	if (!ctx.db) return;
	try {
		await appendAuditEntry(ctx.db, {
			id: crypto.randomUUID(),
			occurredAt: new Date(ctx.now ?? Date.now()).toISOString(),
			accountId: ctx.accountId ?? null,
			...entry
		});
	} catch {
		// swallow — a D1 hiccup must not turn a correct login into a 500
	}
}

function jsonWithCookie(data: unknown, status: number, cookie: string): Response {
	const headers = noStoreHeaders({ 'content-type': 'application/json' });
	headers.append('set-cookie', cookie);
	return new Response(JSON.stringify(data), { status, headers });
}

/**
 * POST /api/admin/auth/login — authenticate an editor against APEX STAFF
 * credentials and open a server-side session.
 *
 * The sequence, and why each step is where it is:
 *   1. boundary (CSRF included) — a cross-site form must not be able to post here;
 *   2. Apex password grant — Apex, not this app, decides whether the credentials
 *      are correct. A failure is an opaque 401 with no distinction between "no such
 *      user" and "wrong password";
 *   3. `staffsMe` with the brand-new token — this both resolves the CANONICAL
 *      identity (never the string the form supplied) and proves Apex will admit
 *      this principal to the platform surface the admin uses. A principal Apex
 *      refuses gets no session, and the token minted a moment ago is revoked again
 *      rather than left alive. THIS is what replaced the editor allowlist;
 *   4. only then is a session written and a cookie issued.
 */
export async function handleLogin(request: Request, ctx: BffContext): Promise<Response> {
	const path = '/api/admin/auth/login';
	const boundary = enforceBrowserBoundary(request, {
		allowedOrigins: ctx.allowedOrigins,
		mutation: true
	});
	if (!boundary.ok) {
		await audit(ctx, {
			actorEmail: 'unknown',
			action: LOGIN_ACTION,
			method: request.method,
			path,
			outcome: 'rejected',
			detail: { reason: boundary.reason }
		});
		return bffError(boundary.status, boundary.reason);
	}

	/**
	 * FAIL CLOSED BEFORE ASKING APEX FOR ANYTHING.
	 *
	 * If there is nowhere to put a session — no D1 binding, which is a bare
	 * `vite dev` or a deploy whose binding was never wired — then a login cannot
	 * succeed no matter what the credentials are. Discovering that AFTER the
	 * password grant would mean Apex had already minted a real access + refresh
	 * token for a real person, and the 500 that followed would strand that token
	 * live and unrevoked for its full lifetime. So the check happens here, before
	 * the password has been sent anywhere. 503, not 500: the deployment is missing
	 * a binding, which is an operational state, not a bad request.
	 */
	if (ctx.sessions.ready?.() === false) {
		await audit(ctx, {
			actorEmail: 'unknown',
			action: LOGIN_ACTION,
			method: request.method,
			path,
			outcome: 'rejected',
			detail: { reason: 'session store unavailable' }
		});
		return bffError(503, 'session store unavailable');
	}

	const raw = await request.text();
	if (raw.length > MAX_LOGIN_BODY_BYTES) return bffError(413, 'payload too large');

	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch {
		return bffError(400, 'invalid body');
	}
	const parsed = loginBodySchema.safeParse(parsedJson);
	if (!parsed.success) return bffError(400, 'invalid body');

	const submittedEmail = parsed.data.email.toLowerCase();

	const token = await ctx.auth.passwordGrant(parsed.data.email, parsed.data.password);
	if (!token) {
		// Deliberately indistinguishable from "no such account": the response says
		// nothing an attacker could use to enumerate staff.
		await audit(ctx, {
			actorEmail: submittedEmail,
			action: LOGIN_ACTION,
			method: request.method,
			path,
			outcome: 'rejected',
			detail: { reason: 'invalid credentials' }
		});
		return bffError(401, 'invalid credentials');
	}

	const identity = await ctx.auth.staffsMe(token.accessToken);
	if (!identity) {
		// Correct credentials, but Apex will not admit this principal to the platform
		// surface the admin drives. Hand the token straight back rather than leaving a
		// live token behind for a login that was refused.
		await ctx.auth.revoke(token.accessToken);
		await audit(ctx, {
			actorEmail: submittedEmail,
			action: LOGIN_ACTION,
			method: request.method,
			path,
			outcome: 'rejected',
			detail: { reason: 'not authorized in apex' }
		});
		return bffError(403, 'forbidden');
	}

	const now = ctx.now ?? Date.now();
	const secret = createSessionSecret();
	const id = await sessionIdFor(secret);
	const email = identity.email.toLowerCase();

	try {
		await ctx.sessions.create({
			id,
			createdAt: now,
			lastSeenAt: now,
			expiresAt: now + SESSION_ABSOLUTE_TTL_MS,
			staffEmail: email,
			staffId: identity.id,
			staffName: identity.name,
			accessToken: token.accessToken,
			tokenType: token.tokenType,
			accessExpiresAt: now + token.expiresInSec * 1000,
			refreshToken: token.refreshToken
		});
	} catch {
		// The store was ready a moment ago and the write still failed — a D1 outage,
		// a missing table, a full disk. The token Apex just minted is now unreachable
		// by this app and would otherwise stay live for its full lifetime, so it is
		// handed straight back. Same rule as the `staffsMe` refusal above: a login
		// that did not succeed must not leave a credential behind.
		await ctx.auth.revoke(token.accessToken);
		await audit(ctx, {
			actorEmail: email,
			actorSub: identity.id,
			action: LOGIN_ACTION,
			method: request.method,
			path,
			outcome: 'rejected',
			detail: { reason: 'session could not be stored' }
		});
		return bffError(503, 'session store unavailable');
	}
	// Opportunistic sweep so dead rows do not accumulate; never blocks the login.
	await ctx.sessions.purgeExpired(now).catch(() => {});

	await audit(ctx, {
		actorEmail: email,
		actorSub: identity.id,
		action: LOGIN_ACTION,
		method: request.method,
		path,
		outcome: 'accepted'
	});

	return jsonWithCookie(
		{ ok: true, editor: { email, name: identity.name } },
		200,
		sessionCookieHeader(secret, {
			secure: isSecureRequest(request),
			maxAgeSeconds: SESSION_ABSOLUTE_TTL_MS / 1000
		})
	);
}

/**
 * POST /api/admin/auth/logout — end the session SERVER-SIDE.
 *
 * Deleting the row is what actually ends it: the cookie is a lookup key, so a copy
 * of it taken beforehand is worthless the moment the row is gone. Clearing the
 * cookie and revoking the Apex token upstream are both belt-and-braces on top.
 *
 * Always 200, even with no session: "log me out" succeeding when you were already
 * logged out is correct, and answering differently would report whether a given
 * cookie was live.
 */
export async function handleLogout(request: Request, ctx: BffContext): Promise<Response> {
	const path = '/api/admin/auth/logout';
	const boundary = enforceBrowserBoundary(request, {
		allowedOrigins: ctx.allowedOrigins,
		mutation: true
	});
	if (!boundary.ok) return bffError(boundary.status, boundary.reason);

	const secret = readSessionCookie(request);
	if (secret) {
		const id = await sessionIdFor(secret);
		const record = await ctx.sessions.read(id).catch(() => null);
		await ctx.sessions.delete(id).catch(() => {});
		if (record) {
			await ctx.auth.revoke(record.accessToken);
			await audit(ctx, {
				actorEmail: record.staffEmail,
				actorSub: record.staffId,
				action: LOGOUT_ACTION,
				method: request.method,
				path,
				outcome: 'accepted'
			});
		}
	}

	return jsonWithCookie({ ok: true }, 200, clearedSessionCookieHeader(isSecureRequest(request)));
}
