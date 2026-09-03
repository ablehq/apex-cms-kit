import { bffError, enforceBrowserBoundary } from './boundary';
import {
	isSessionExpired,
	needsAccessRefresh,
	readSessionCookie,
	sessionIdFor,
	SESSION_TOUCH_INTERVAL_MS
} from './session';
import type { SessionRecord } from './session';
import type { ApexAdminClient } from './apex-admin-client';
import type { BffContext } from './context';

export interface Actor {
	/** The signed-in editor's canonical Apex staff email. */
	email: string;
	/** The Apex staff uuid — the same principal Apex's own audit records. */
	sub: string | null;
}

export type GuardResult<Client = ApexAdminClient> =
	| {
			ok: true;
			actor: Actor;
			/**
			 * An Apex client bound to THIS EDITOR's token. Operations must call Apex
			 * through this and only this: `BffContext` deliberately has no ready-made
			 * client, so there is no way to reach Apex without having first passed the
			 * guard, and no way to reach it as anyone but the signed-in person.
			 */
			apex: Client;
	  }
	| { ok: false; response: Response; status: number; reason: string };

/**
 * The single gate every BFF operation passes through, in order:
 *   1. browser-boundary hygiene (origin / Sec-Fetch-Site / CSRF-on-mutation);
 *   2. the server-side session: an opaque cookie resolved against D1, checked for
 *      absolute expiry and idle timeout, with the editor's Apex token refreshed in
 *      place when it is close to running out;
 *   3. that's it — there is no separate editor allowlist. Apex decides who may hold
 *      a session (the login refuses any principal Apex will not admit to the
 *      platform surface) and Apex authorizes every call made with that person's own
 *      token. A second list in an env var would put user management back OUTSIDE
 *      the CMS, which is precisely what this change removed.
 *
 * Fail-closed is structural, not a policy choice: no cookie, an unknown cookie, an
 * expired session or a refusable refresh all return a `Response` and no Apex client
 * is ever constructed. The client gets a status code and a short code, never the
 * internal reason.
 */
export async function guardRequest<Ctx extends BffContext>(
	request: Request,
	ctx: Ctx,
	options: { mutation: boolean }
): Promise<GuardResult<ReturnType<Ctx['createApexClient']>>> {
	const boundary = enforceBrowserBoundary(request, {
		allowedOrigins: ctx.allowedOrigins,
		mutation: options.mutation
	});
	if (!boundary.ok) {
		return {
			ok: false,
			response: bffError(boundary.status, boundary.reason),
			status: boundary.status,
			reason: boundary.reason
		};
	}

	const session = await resolveSession(request, ctx);
	if (!session) {
		return {
			ok: false,
			response: bffError(401, 'unauthorized'),
			status: 401,
			reason: 'unauthorized'
		};
	}

	return {
		ok: true,
		actor: { email: session.staffEmail, sub: session.staffId },
		apex: ctx.createApexClient(session.accessToken) as ReturnType<Ctx['createApexClient']>
	};
}

/**
 * Resolve the session behind a request, renewing the Apex token if needed, or null.
 *
 * Any failure DELETES the row rather than leaving a half-dead session behind: an
 * expired envelope and a refresh Apex refuses are both terminal, and the next
 * request should look like a clean "not signed in" rather than retry forever.
 */
export async function resolveSession(
	request: Request,
	ctx: BffContext
): Promise<SessionRecord | null> {
	const secret = readSessionCookie(request);
	if (!secret) return null;

	const id = await sessionIdFor(secret);
	const record = await ctx.sessions.read(id);
	if (!record) return null;

	const now = ctx.now ?? Date.now();
	if (isSessionExpired(record, now)) {
		await ctx.sessions.delete(id).catch(() => {});
		return null;
	}

	let current = record;
	if (needsAccessRefresh(current, now)) {
		const refreshed = await ctx.auth.refreshGrant(current.refreshToken);
		if (!refreshed) {
			// Apex will not renew this person's token — revoked, disabled, or the
			// refresh token itself is gone. The session ends here.
			await ctx.sessions.delete(id).catch(() => {});
			return null;
		}
		current = {
			...current,
			accessToken: refreshed.accessToken,
			tokenType: refreshed.tokenType,
			refreshToken: refreshed.refreshToken,
			accessExpiresAt: now + refreshed.expiresInSec * 1000,
			lastSeenAt: now
		};
		await ctx.sessions.update(current);
		return current;
	}

	// Touch at minute resolution, not per request: `last_seen_at` drives the idle
	// cutoff, which is measured in hours, so a D1 write per GET buys nothing.
	if (now - current.lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) {
		current = { ...current, lastSeenAt: now };
		await ctx.sessions.update(current).catch(() => {});
	}
	return current;
}

/**
 * The page-navigation variant, for `+layout.server.ts`. It resolves the session
 * WITHOUT the browser-boundary check and without renewing the Apex token, because a
 * top-level document navigation is not an API call: a link followed from another
 * site arrives with `Sec-Fetch-Site: cross-site`, and 403-ing that would be wrong —
 * the correct answer is to show the login page. Nothing privileged is read here, and
 * every actual data path still goes through `guardRequest`.
 */
export async function resolvePageSession(
	request: Request,
	ctx: BffContext
): Promise<{ email: string; name: string | null } | null> {
	const secret = readSessionCookie(request);
	if (!secret) return null;
	const record = await ctx.sessions.read(await sessionIdFor(secret));
	if (!record) return null;
	if (isSessionExpired(record, ctx.now ?? Date.now())) return null;
	return { email: record.staffEmail, name: record.staffName };
}
