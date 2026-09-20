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

/**
 * Per-site security-header options.
 *
 * The MECHANISM is the kit's (standing rule §5 — security rules are shared); the
 * POLICY is each site's, because the sites do not load the same third parties.
 * Godrej pulls GTM, gtag, Google Fonts and reCAPTCHA; GLC and Poovayya only fonts.
 * So the kit sets the three headers that are the same everywhere and takes the CSP
 * as a string.
 */
export interface AdminHooksOptions {
	/**
	 * The site's Content-Security-Policy. Omit it and no CSP is sent — the kit will
	 * not guess a policy on a site's behalf, because a wrong `script-src` breaks
	 * analytics or a contact form on the first load and looks like an outage.
	 */
	contentSecurityPolicy?: string;
	/**
	 * Send the CSP as `Content-Security-Policy-Report-Only`. **Defaults to `true`,
	 * deliberately.** A blocking policy on a page carrying third-party scripts fails
	 * closed and silently, and standing rule §6 says a green suite is not proof.
	 * Ship report-only, watch what it reports, then pass `false`.
	 */
	cspReportOnly?: boolean;
	/**
	 * `Strict-Transport-Security`. Defaults to one year with NO `includeSubDomains`,
	 * which is the fail-safe direction: `includeSubDomains` breaks any subdomain that
	 * is not HTTPS-only, and that has to be confirmed per domain rather than assumed.
	 * Pass the fuller value once it is. Do not add `preload` without meaning it — it
	 * is hard to undo. `null` disables the header.
	 */
	strictTransportSecurity?: string | null;
	/**
	 * `X-Frame-Options`, default `DENY`. `null` disables it.
	 *
	 * **If the site serves an Apex live-preview iframe, its own hook must handle this
	 * on that path** — Godrej's `previewFrame` deletes the header and sets its own CSP.
	 *
	 * CORRECTED 2026-09-10, and the correction matters more than the original claim:
	 * an earlier version of this comment said `previewFrame` is "sequenced AFTER
	 * `adminHooks()` so it still wins. Measured." **That is not what `sequence()` does.**
	 * It NESTS handles, so the later handle's post-processing runs FIRST and this header
	 * is re-set after that delete. The final review drove the real `sequence` and got
	 * `x-frame-options: DENY` alongside the preview CSP on `/__preview__`.
	 *
	 * The preview still works, because a browser that sees `frame-ancestors` ignores
	 * `X-Frame-Options` entirely — so this is a note, not a defect. But the word
	 * "measured" was doing work it had not earned, in three separate documents. If the
	 * ordering is ever made to matter, `sequence(previewFrame, adminHooks(...))` is the
	 * arrangement that does what the old comment described, and it should be verified
	 * with `curl -I` against a real deploy rather than by reasoning.
	 *
	 * GLC and Poovayya have no preview route at all (measured 2026-09-10, and that part
	 * held up), so `DENY` is safe for them as they stand.
	 */
	frameOptions?: string | null;
}

const DEFAULT_HSTS = 'max-age=31536000';

export function adminHooks(options: AdminHooksOptions = {}): Handle {
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

		// SECURITY HEADERS, on every response — public pages included, which is where
		// the client's scanner looked. Set before the cache branch below so nothing
		// can return early past them.
		//
		// These close findings 1, 2, 4 and 5 of the 2026-08 report. Finding 3
		// (Subresource Integrity) is deliberately NOT addressed here and cannot be:
		// `integrity=` on gtag.js or Google Fonts pins a hash to a URL whose contents
		// Google rotates, so it would break the site on their next change. A CSP
		// `script-src` allowlist is the honest answer, which is why the CSP is an
		// option rather than a fixed string.
		const hsts =
			options.strictTransportSecurity === undefined
				? DEFAULT_HSTS
				: options.strictTransportSecurity;
		// Only over HTTPS: the header is meaningless on http and sending it there just
		// makes local bring-up look like production.
		if (hsts && event.url.protocol === 'https:') {
			response.headers.set('Strict-Transport-Security', hsts);
		}
		response.headers.set('X-Content-Type-Options', 'nosniff');
		const frameOptions = options.frameOptions === undefined ? 'DENY' : options.frameOptions;
		if (frameOptions) response.headers.set('X-Frame-Options', frameOptions);
		if (options.contentSecurityPolicy) {
			response.headers.set(
				options.cspReportOnly === false
					? 'Content-Security-Policy'
					: 'Content-Security-Policy-Report-Only',
				options.contentSecurityPolicy
			);
		}

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
