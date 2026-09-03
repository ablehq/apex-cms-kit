import type { Handle } from '@sveltejs/kit';
import { CSRF_COOKIE } from './server/bff/boundary';

/**
 * Every `/admin` and `/api/*` response is non-indexable and non-cacheable
 * (plan §7). The BFF boundary helper also stamps `Cache-Control: no-store` on the
 * JSON responses it builds; doing it here as well guarantees the header on
 * everything under these prefixes — the rendered admin shell, 404/405s, error
 * pages — not just the happy-path JSON. Public routes are untouched.
 */
const NON_PUBLIC_PREFIXES = ['/admin', '/api'] as const;

function isNonPublic(pathname: string): boolean {
	return NON_PUBLIC_PREFIXES.some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
	);
}

function isAdminDocument(pathname: string): boolean {
	return pathname === '/admin' || pathname.startsWith('/admin/');
}

export function adminHooks(): Handle {
	return async ({ event, resolve }) => {
	// F3 (3a.1 review hardening): issue the double-submit CSRF token the boundary
	// verifies on mutations. The boundary compares an `X-CSRF-Token` header against
	// the `apex_bff_csrf` cookie — but nothing was ever SETTING that cookie, so the
	// check could previously only be satisfied by a test. Here the admin session
	// mints one (unpredictable `crypto.randomUUID`) the first time an editor loads
	// any admin document, and the browser echoes it back as the header on writes.
	//
	// Attributes: `httpOnly: false` is REQUIRED — the double-submit pattern needs
	// JS to read the cookie to build the header; the token is not a bearer secret,
	// it only proves the request came from a page the app served. `sameSite: strict`
	// + `path: /` scope it tightly; `secure` follows the scheme so it still sets on
	// http://localhost during local bring-up.
	if (isAdminDocument(event.url.pathname) && !event.cookies.get(CSRF_COOKIE)) {
		event.cookies.set(CSRF_COOKIE, crypto.randomUUID(), {
			path: '/',
			httpOnly: false,
			sameSite: 'strict',
			secure: event.url.protocol === 'https:',
			maxAge: 60 * 60 * 8
		});
	}

	const response = await resolve(event);
	if (isNonPublic(event.url.pathname)) {
		response.headers.set('X-Robots-Tag', 'noindex, nofollow');
		response.headers.set('Cache-Control', 'no-store');
	} else if (
		event.request?.method === 'GET' &&
		response.ok &&
		!response.headers.has('Cache-Control')
	) {
		// Public pages render from the published snapshot (plan §2.3). A short shared
		// max-age lets the adapter keep them in the edge cache, so a burst of visitors
		// costs one render per edge per minute — the same bound as KV's own cache.
		response.headers.set('Cache-Control', 'public, max-age=0, s-maxage=60');
	}
	return response;
	};
}
