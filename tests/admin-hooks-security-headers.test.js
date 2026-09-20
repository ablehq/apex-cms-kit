import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { adminHooks } from '../src/hooks.ts';

/**
 * THE FOUR HEADERS THE CLIENT'S SECURITY TEAM ASKED FOR, and the two things about
 * them that are easy to get wrong.
 *
 * Findings 1, 2, 4 and 5 of the 2026-08 report: no CSP, no HSTS, no
 * X-Content-Type-Options, no X-Frame-Options on any page of any of the three sites.
 * The mechanism lives here rather than in each site because standing rule §5 puts
 * security rules in the kit — but the CSP VALUE stays per site, because the sites do
 * not load the same third parties and a wrong `script-src` breaks a contact form.
 *
 * Finding 3 (Subresource Integrity) is deliberately not addressed and cannot be:
 * pinning a hash to a Google-hosted URL breaks on their next rotation.
 *
 * MUTATION: delete any `headers.set` in the block, or flip a default — one of these fails.
 */
const run = async (hook, url, init = {}) => {
	const event = {
		url: new URL(url),
		request: new Request(url, { method: init.method ?? 'GET' }),
		cookies: { get: () => 'x', set: () => {} }
	};
	return hook({ event, resolve: async () => new Response('ok', { status: 200 }) });
};

describe('security headers are set on every response', () => {
	it('sets nosniff and DENY on a PUBLIC page, which is where the scanner looked', async () => {
		const res = await run(adminHooks(), 'https://example.com/about-us');
		assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
		assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
	});

	it('sets HSTS over https and NOT over http', async () => {
		const secure = await run(adminHooks(), 'https://example.com/');
		assert.equal(secure.headers.get('Strict-Transport-Security'), 'max-age=31536000');
		const plain = await run(adminHooks(), 'http://localhost:8080/');
		assert.equal(
			plain.headers.get('Strict-Transport-Security'),
			null,
			'the header is meaningless on http and would make local bring-up look like production'
		);
	});

	it('does NOT include subdomains by default — that has to be confirmed, not assumed', async () => {
		const res = await run(adminHooks(), 'https://example.com/');
		assert.doesNotMatch(
			res.headers.get('Strict-Transport-Security') ?? '',
			/includeSubDomains/u,
			'includeSubDomains breaks any subdomain that is not HTTPS-only'
		);
		const opted = await run(
			adminHooks({ strictTransportSecurity: 'max-age=31536000; includeSubDomains' }),
			'https://example.com/'
		);
		assert.match(opted.headers.get('Strict-Transport-Security'), /includeSubDomains/u);
	});

	it('sends NO CSP unless the site gives one — the kit does not guess a policy', async () => {
		const res = await run(adminHooks(), 'https://example.com/');
		assert.equal(res.headers.get('Content-Security-Policy'), null);
		assert.equal(res.headers.get('Content-Security-Policy-Report-Only'), null);
	});

	it('ships a given CSP as REPORT-ONLY by default, and blocks only when asked', async () => {
		const policy = "frame-ancestors 'none'; script-src 'self'";
		const reportOnly = await run(adminHooks({ contentSecurityPolicy: policy }), 'https://x.com/');
		assert.equal(reportOnly.headers.get('Content-Security-Policy-Report-Only'), policy);
		assert.equal(
			reportOnly.headers.get('Content-Security-Policy'),
			null,
			'a blocking policy on the first guess breaks analytics or a form, silently'
		);
		const blocking = await run(
			adminHooks({ contentSecurityPolicy: policy, cspReportOnly: false }),
			'https://x.com/'
		);
		assert.equal(blocking.headers.get('Content-Security-Policy'), policy);
		assert.equal(blocking.headers.get('Content-Security-Policy-Report-Only'), null);
	});

	it('lets a site turn X-Frame-Options off, for a preview iframe', async () => {
		// Godrej serves an Apex live-preview iframe and its own hook deletes this header
		// on that path. `null` is the other way to do it, for a site that wants no default.
		const res = await run(adminHooks({ frameOptions: null }), 'https://example.com/');
		assert.equal(res.headers.get('X-Frame-Options'), null);
	});

	it('still sets them on admin and API responses, alongside the no-store rules', async () => {
		const res = await run(adminHooks(), 'https://example.com/admin/pages');
		assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
		assert.equal(res.headers.get('Cache-Control'), 'no-store');
		assert.equal(res.headers.get('X-Robots-Tag'), 'noindex, nofollow');
	});
});
