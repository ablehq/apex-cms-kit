/**
 * Apex staff authentication — the mechanism Keus and `apex-cms-template` use, and
 * the one this repo's own build already uses (`src/lib/services/core/apex-api-service.ts`
 * `performLogin` / `requestToken`, driven by `cms/scripts/cms-auth.ts`). It is now
 * also the admin's login, with one difference that is the entire point of the BFF:
 * these calls happen SERVER-SIDE and the tokens they return never leave the Worker.
 *
 * Three grants and one identity read, measured against the local Apex at
 * http://localhost:3001 on 2026-07-31:
 *
 *   POST /api/v1/staff/token/otpless   Basic(app_id:app_secret) + {grant_type:'password',
 *                                      username, password}
 *                                      → 200 {access_token, token_type, expires_in: 7200,
 *                                             refresh_token, created_at}
 *                                      → 400 invalid_grant  (wrong password / unknown user)
 *                                      → 401                (bad client credential)
 *   POST /api/v1/staff/token           …{grant_type:'refresh_token', refresh_token}
 *                                      → 200, same shape, a fresh 7200s access token
 *   POST /api/v1/staff/token/revoke    …{token}  → 200
 *   GET  /api/platform/v1/staffs/me    Bearer   → 200 {data:{id, email, name, …}}
 *                                      → 401 {code:'invalid-token'}
 *
 * `staffsMe` is doing TWO jobs and both matter. It resolves the CANONICAL identity
 * (Apex's own email + staff id, not the string the user typed into the form), which
 * is what the audit rows and Apex's own attribution key off. And it is the
 * AUTHORIZATION probe: a principal Apex will not admit to the platform surface gets
 * a non-200 here, and the login refuses to create a session. That is what lets the
 * separate editor allowlist go away without anything failing open — Apex decides
 * who may act, which is the whole reason for this change.
 *
 * Everything returns `null` on failure rather than throwing. The route turns that
 * into a status code and a short opaque code; an Apex error string never reaches
 * the browser, and a network blip can never become a 500 that looks like a bug.
 */

export interface ApexTokenSet {
	accessToken: string;
	tokenType: string;
	/** Seconds, as Apex reports it (7200 on the measured instance). */
	expiresInSec: number;
	refreshToken: string;
	/** Seconds since epoch, as Apex reports it. */
	createdAtSec: number;
}

export interface ApexStaffIdentity {
	id: string | null;
	email: string;
	name: string | null;
}

export interface ApexAuthClient {
	/** The password grant. `null` for ANY failure — bad password, unknown user, upstream down. */
	passwordGrant(username: string, password: string): Promise<ApexTokenSet | null>;
	/** The refresh grant, so a session outlives the 2-hour access token. */
	refreshGrant(refreshToken: string): Promise<ApexTokenSet | null>;
	/** Canonical identity AND the platform-authorization probe. `null` ⇒ refuse the session. */
	staffsMe(accessToken: string): Promise<ApexStaffIdentity | null>;
	/** Best-effort upstream revocation on logout. Never throws. */
	revoke(accessToken: string): Promise<void>;
}

export interface ApexAuthClientOptions {
	/** Fixed Apex origin — the same one the admin client calls. */
	baseUrl: string;
	applicationId: string;
	applicationSecret: string;
	fetchImpl?: typeof globalThis.fetch;
}

const TOKEN_PASSWORD_PATH = '/api/v1/staff/token/otpless';
const TOKEN_REFRESH_PATH = '/api/v1/staff/token';
const TOKEN_REVOKE_PATH = '/api/v1/staff/token/revoke';
const STAFFS_ME_PATH = '/api/platform/v1/staffs/me';

function parseTokenSet(value: unknown): ApexTokenSet | null {
	if (!value || typeof value !== 'object') return null;
	const token = value as Record<string, unknown>;
	if (typeof token.access_token !== 'string' || !token.access_token) return null;
	if (typeof token.token_type !== 'string' || !token.token_type) return null;
	if (typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in)) return null;
	if (typeof token.created_at !== 'number' || !Number.isFinite(token.created_at)) return null;
	// The refresh token is REQUIRED: without one the session could not outlive the
	// 2-hour access token, and a session that silently dies mid-edit is worse than
	// one that never starts. If Apex ever stops issuing it, login fails loudly here.
	if (typeof token.refresh_token !== 'string' || !token.refresh_token) return null;
	return {
		accessToken: token.access_token,
		tokenType: token.token_type,
		expiresInSec: token.expires_in,
		refreshToken: token.refresh_token,
		createdAtSec: token.created_at
	};
}

export function createApexAuthClient(options: ApexAuthClientOptions): ApexAuthClient {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	if (!options.baseUrl) throw new Error('Apex base URL is not configured');
	if (!options.applicationId || !options.applicationSecret) {
		// Fail at context construction, not at login: an admin wired without its
		// client credential must not answer "wrong password" to a correct one.
		throw new Error('Apex application credentials are not configured');
	}
	const origin = new URL(options.baseUrl).origin;
	const basic = btoa(`${options.applicationId}:${options.applicationSecret}`);

	/**
	 * Same upstream hygiene as `apex-admin-client.ts`: a fresh `Headers` (no inbound
	 * cookie or header is ever forwarded), a fixed origin re-checked after URL
	 * resolution, `redirect: 'manual'` so a 3xx is a failure rather than a chase,
	 * and upstream `Set-Cookie` is never read.
	 */
	async function call(
		path: string,
		init: RequestInit,
		authorization: string
	): Promise<{ ok: boolean; status: number; body: unknown }> {
		const url = new URL(path, `${origin}/`);
		if (url.origin !== origin) throw new Error('refusing off-origin Apex call');
		const headers = new Headers();
		headers.set('authorization', authorization);
		headers.set('accept', 'application/json');
		if (init.body !== undefined && init.body !== null) {
			headers.set('content-type', 'application/json');
		}
		const response = await fetchImpl(url, { ...init, headers, redirect: 'manual' });
		if (response.status >= 300 && response.status < 400) {
			return { ok: false, status: response.status, body: null };
		}
		let body: unknown = null;
		const contentType = response.headers.get('content-type') ?? '';
		if (contentType.includes('application/json')) {
			body = await response.json().catch(() => null);
		}
		return { ok: response.ok, status: response.status, body };
	}

	async function requestToken(path: string, grant: Record<string, unknown>) {
		try {
			const response = await call(
				path,
				{ method: 'POST', body: JSON.stringify(grant) },
				`Basic ${basic}`
			);
			if (!response.ok) return null;
			return parseTokenSet(response.body);
		} catch {
			return null;
		}
	}

	return {
		async passwordGrant(username, password) {
			return requestToken(TOKEN_PASSWORD_PATH, {
				grant_type: 'password',
				username,
				password
			});
		},
		async refreshGrant(refreshToken) {
			return requestToken(TOKEN_REFRESH_PATH, {
				grant_type: 'refresh_token',
				refresh_token: refreshToken
			});
		},
		async staffsMe(accessToken) {
			try {
				const response = await call(STAFFS_ME_PATH, { method: 'GET' }, `Bearer ${accessToken}`);
				if (!response.ok) return null;
				const body = response.body as { data?: Record<string, unknown> } | null;
				const data = body?.data;
				if (!data || typeof data !== 'object') return null;
				const email = typeof data.email === 'string' ? data.email.trim() : '';
				// No email ⇒ no identity to attribute an edit to ⇒ no session.
				if (!email) return null;
				return {
					id: typeof data.id === 'string' ? data.id : null,
					email,
					name: typeof data.name === 'string' ? data.name : null
				};
			} catch {
				return null;
			}
		},
		async revoke(accessToken) {
			try {
				await call(
					TOKEN_REVOKE_PATH,
					{ method: 'POST', body: JSON.stringify({ token: accessToken }) },
					`Basic ${basic}`
				);
			} catch {
				// Best effort. The session row is deleted regardless, so the token is
				// unreachable through this app whether or not Apex acknowledged.
			}
		}
	};
}
