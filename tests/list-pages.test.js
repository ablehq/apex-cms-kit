// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleListPages } from '../src/server/bff/operations/list-pages.ts';
import { listAllPages } from '../src/server/bff/paginate.ts';
import { createSessionSecret, sessionIdFor } from '../src/server/bff/session.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { createMemorySessionStore } from './harness/session-store.ts';

const ORIGIN = 'https://site.test';

/** A paginating pages surface: `count` rows, `perPage` per page, recording each query. */
function pagesApex(count, { perPage = 100, breakOn = null } = {}) {
	const all = Array.from({ length: count }, (_, i) => ({ id: `p${i + 1}`, slug: `page-${i + 1}` }));
	const calls = [];
	return {
		calls,
		async listPages(query) {
			calls.push(query);
			const page = Number(query.page);
			const size = Number(query.per_page ?? perPage);
			if (breakOn === page) return { ok: true, status: 200, body: { data: all.slice(0, 3) } };
			return {
				ok: true,
				status: 200,
				body: {
					data: all.slice((page - 1) * size, page * size),
					pagination: { current_page: page, total_pages: Math.max(1, Math.ceil(count / size)) }
				}
			};
		}
	};
}

function ctxWith(apex) {
	return {
		allowedOrigins: parseAllowedOrigins(ORIGIN),
		sessions: createMemorySessionStore(),
		auth: {
			async passwordGrant() {
				return null;
			},
			async refreshGrant() {
				return null;
			},
			async staffsMe() {
				return null;
			},
			async revoke() {}
		},
		createApexClient: () => apex,
		reviewOnlyFields: []
	};
}

async function signIn(ctx) {
	const secret = createSessionSecret();
	const now = Date.now();
	await ctx.sessions.create({
		id: await sessionIdFor(secret),
		createdAt: now,
		lastSeenAt: now,
		expiresAt: now + 3600_000,
		staffEmail: 'e@site.test',
		staffId: 'staff-1',
		staffName: 'E',
		accessToken: 't',
		tokenType: 'Bearer',
		accessExpiresAt: now + 3600_000,
		refreshToken: 'r'
	});
	return secret;
}

async function list(apex, query = '') {
	const ctx = ctxWith(apex);
	const session = await signIn(ctx);
	const res = await handleListPages(
		new Request(`${ORIGIN}/api/admin/pages${query}`, {
			headers: {
				origin: ORIGIN,
				'sec-fetch-site': 'same-origin',
				cookie: `apex_admin_session=${session}`
			}
		}),
		ctx
	);
	return { res, body: await res.json() };
}

describe('GET /api/admin/pages reads EVERY page', () => {
	it('two pages of results come back whole, in exactly two calls', async () => {
		const apex = pagesApex(150);
		const { res, body } = await list(apex, '?status=all');
		assert.equal(res.status, 200);
		assert.equal(body.pages.length, 150);
		assert.equal(body.pages[149].slug, 'page-150');
		assert.deepEqual(
			apex.calls.map((c) => [c.page, c.per_page]),
			[
				[1, 100],
				[2, 100]
			]
		);
		assert.ok(
			apex.calls.every((c) => !('q[status_eq]' in c)),
			'`all` sends no status filter'
		);
	});

	it('a status filter rides along on every page', async () => {
		const apex = pagesApex(101);
		await list(apex, '?status=draft');
		assert.equal(apex.calls.length, 2);
		assert.ok(apex.calls.every((c) => c['q[status_eq]'] === 'draft'));
	});

	it('an explicit page keeps the single-page answer', async () => {
		const apex = pagesApex(150, { perPage: 50 });
		const { body } = await list(apex, '?page=2');
		assert.equal(body.pages.length, 50);
		assert.equal(body.pages[0].slug, 'page-51');
		assert.deepEqual(apex.calls, [{ page: 2, per_page: 50 }]);
	});

	it('a malformed envelope on page 2 is 502, not the first page alone', async () => {
		const apex = pagesApex(150, { breakOn: 2 });
		const { res, body } = await list(apex);
		assert.equal(res.status, 502);
		assert.deepEqual(body, { error: 'upstream error' });
		assert.equal(apex.calls.length, 2);
	});

	it('the walk is capped: more than 20 pages fails closed', async () => {
		const asked = [];
		const rows = await listAllPages(async (page) => {
			asked.push(page);
			return { ok: true, body: { data: [{ id: `p${page}` }], pagination: { total_pages: 21 } } };
		});
		assert.equal(rows, null);
		assert.equal(asked.length, 20, 'page 21 is never asked for');
		const capped = await listAllPages(
			async (page) => ({ ok: true, body: { data: [], pagination: { total_pages: 3 } } }),
			{ maxPages: 2 }
		);
		assert.equal(capped, null);
	});
});
