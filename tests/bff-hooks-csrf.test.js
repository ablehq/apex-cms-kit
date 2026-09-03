// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract, run to verify.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { adminHooks } from '../src/hooks.ts';

const handle = adminHooks();
import { CSRF_COOKIE } from '../src/server/bff/boundary.ts';

/**
 * F3 (3a.1 review hardening): the admin session must ISSUE the double-submit CSRF
 * cookie the boundary verifies — otherwise the check the whole mutation path relies
 * on can never be satisfied by the real app. This drives the SvelteKit `handle` hook
 * with a minimal fake event and asserts the cookie is minted on admin documents,
 * left alone when already present, and never set on public paths.
 */
function fakeEvent(pathname, { protocol = 'https:', existingCookie = null } = {}) {
	const set = [];
	const store = new Map();
	if (existingCookie) store.set(CSRF_COOKIE, existingCookie);
	return {
		event: {
			url: new URL(`${protocol}//gospellife.in${pathname}`),
			cookies: {
				get: (name) => store.get(name) ?? undefined,
				set: (name, value, opts) => {
					store.set(name, value);
					set.push({ name, value, opts });
				}
			}
		},
		set
	};
}

const resolve = async () => new Response('ok', { status: 200 });

describe('CSRF cookie issuance (hooks.server)', () => {
	it('mints an unpredictable apex_bff_csrf cookie on an admin document, once', async () => {
		const { event, set } = fakeEvent('/admin/pages');
		await handle({ event, resolve });
		assert.equal(set.length, 1);
		const cookie = set[0];
		assert.equal(cookie.name, CSRF_COOKIE);
		// crypto.randomUUID() shape — unpredictable, not a fixed literal.
		assert.match(cookie.value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
		// Attributes: readable by JS (double-submit), tightly scoped.
		assert.equal(cookie.opts.httpOnly, false);
		assert.equal(cookie.opts.sameSite, 'strict');
		assert.equal(cookie.opts.path, '/');
		assert.equal(cookie.opts.secure, true);
	});

	it('does NOT overwrite an existing token (in-flight forms keep working)', async () => {
		const { event, set } = fakeEvent('/admin/pages', { existingCookie: 'already-here' });
		await handle({ event, resolve });
		assert.equal(set.length, 0);
	});

	it('does not set the cookie on public paths', async () => {
		const { event, set } = fakeEvent('/gospel');
		await handle({ event, resolve });
		assert.equal(set.length, 0);
	});

	it('sets secure=false on http (local bring-up) so the cookie still lands', async () => {
		const { event, set } = fakeEvent('/admin', { protocol: 'http:' });
		await handle({ event, resolve });
		assert.equal(set[0].opts.secure, false);
	});

	it('two fresh sessions get different tokens (unpredictable)', async () => {
		const a = fakeEvent('/admin/pages');
		const b = fakeEvent('/admin/pages');
		await handle({ event: a.event, resolve });
		await handle({ event: b.event, resolve });
		assert.notEqual(a.set[0].value, b.set[0].value);
	});
});

/**
 * 3a.3 adversarial gate — "responses are no-store". The plan requires EVERY `/admin`
 * and `/api/*` response to be non-cacheable and non-indexable, not just the happy-path
 * JSON the operations build. `hooks.server.ts` stamps the headers on the resolved
 * response regardless of status, so the admin shell, the 404/405s, the redirects and
 * the error pages are all covered. This pins that, status-independently.
 */
describe('no-store + noindex on every admin/api response (hooks.server)', () => {
	const resolveWith = (status) => async () => new Response('body', { status });

	for (const path of [
		'/admin',
		'/admin/pages',
		'/api/admin/pages',
		'/api/ingest',
		'/api/ingest/x'
	]) {
		for (const status of [200, 307, 404, 405, 500]) {
			it(`stamps no-store + noindex on ${path} (status ${status})`, async () => {
				const { event } = fakeEvent(path);
				const response = await handle({ event, resolve: resolveWith(status) });
				assert.equal(response.headers.get('cache-control'), 'no-store');
				assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
			});
		}
	}
});
