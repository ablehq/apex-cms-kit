/**
 * Browser-boundary hygiene (plan §8, 3a). The session cookie is `SameSite=Strict`,
 * which already withholds it from cross-site requests — but SameSite is one browser
 * behaviour, and the admin does not rest a write on it alone. Every BFF request must
 * additionally clear:
 *
 *   - an exact `Origin` allowlist (no wildcard, no suffix match);
 *   - `Sec-Fetch-Site: same-origin`;
 *   - a CSRF token on mutations (double-submit: `X-CSRF-Token` header must equal
 *     the `apex_bff_csrf` cookie);
 *
 * GET/HEAD are side-effect-free and need no CSRF token, but are still held to the
 * origin / fetch-metadata checks so a cross-site page cannot read admin data. Login
 * and logout are mutations and are held to all three, so a cross-site page can
 * neither sign an editor in as someone else nor sign them out.
 * Responses are always `no-store` (built here so the header can never be forgotten).
 *
 * What this file does NOT do is forward anything: the inbound cookies and arbitrary
 * headers stop here — the Apex client (`apex-admin-client.ts`) builds a fresh request
 * carrying only the signed-in editor's own bearer token, which the browser never sees.
 */

const CSRF_COOKIE = 'apex_bff_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD']);

export type BoundaryResult = { ok: true } | { ok: false; status: number; reason: string };

export interface BoundaryOptions {
	/** Exact origins allowed to call the BFF, e.g. ['https://gospellife.in']. */
	allowedOrigins: string[];
	/** Whether this request mutates (requires the CSRF token). */
	mutation: boolean;
}

export function isSafeMethod(method: string): boolean {
	return SAFE_METHODS.has(method.toUpperCase());
}

/** Constant-time string comparison, to keep CSRF checks free of timing oracles. */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return mismatch === 0;
}

function readCookie(request: Request, name: string): string | null {
	const header = request.headers.get('cookie');
	if (!header) return null;
	for (const pair of header.split(';')) {
		const index = pair.indexOf('=');
		if (index === -1) continue;
		if (pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
	}
	return null;
}

export function enforceBrowserBoundary(request: Request, options: BoundaryOptions): BoundaryResult {
	const method = request.method.toUpperCase();

	const origin = request.headers.get('origin');
	if (origin && !options.allowedOrigins.includes(origin)) {
		return { ok: false, status: 403, reason: 'origin not allowed' };
	}

	const secFetchSite = request.headers.get('sec-fetch-site');
	// When present it must be same-origin. `none` (a user typing the URL) is only
	// tolerated for safe reads; a mutation must be a genuine same-origin fetch.
	if (secFetchSite && secFetchSite !== 'same-origin') {
		if (!(isSafeMethod(method) && secFetchSite === 'none')) {
			return { ok: false, status: 403, reason: 'cross-site request' };
		}
	}

	if (options.mutation) {
		if (isSafeMethod(method)) {
			// A mutation must never arrive as GET/HEAD — those are cacheable and
			// link-followable. This is a programming error, not a client one.
			return { ok: false, status: 405, reason: 'mutation requires an unsafe method' };
		}
		if (!origin) return { ok: false, status: 403, reason: 'missing origin' };
		if (secFetchSite !== 'same-origin') {
			return { ok: false, status: 403, reason: 'mutation must be same-origin' };
		}
		const headerToken = request.headers.get('x-csrf-token');
		const cookieToken = readCookie(request, CSRF_COOKIE);
		if (!headerToken || !cookieToken || !timingSafeEqual(headerToken, cookieToken)) {
			return { ok: false, status: 403, reason: 'missing or mismatched CSRF token' };
		}
	}

	return { ok: true };
}

/** Headers every BFF response carries: never cached, never indexed. */
export function noStoreHeaders(extra?: HeadersInit): Headers {
	const headers = new Headers(extra);
	headers.set('cache-control', 'no-store');
	headers.set('x-robots-tag', 'noindex, nofollow');
	return headers;
}

/** A JSON response with the mandatory no-store / noindex headers. */
export function noStoreJson(data: unknown, status = 200): Response {
	const headers = noStoreHeaders({ 'content-type': 'application/json' });
	return new Response(JSON.stringify(data), { status, headers });
}

/** A JSON error response. The client gets a code, never the internal reason detail. */
export function bffError(status: number, code: string): Response {
	return noStoreJson({ error: code }, status);
}

/** Parse the exact-origin allowlist from env (comma-separated). */
export function parseAllowedOrigins(value: string | undefined): string[] {
	return (value ?? '')
		.split(',')
		.map((origin) => origin.trim())
		.filter((origin) => origin.length > 0);
}

export { CSRF_COOKIE };
