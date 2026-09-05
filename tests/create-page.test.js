// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	createPageBodySchema,
	handleCreatePage
} from '../src/server/bff/operations/create-page.ts';
import { bindReservedRoutes } from '../src/cms/page-slug-validation.js';
import { createSessionSecret, sessionIdFor } from '../src/server/bff/session.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { createMemorySessionStore } from './harness/session-store.ts';

/**
 * The page create: what reaches Apex, and the two refusals Apex itself does not
 * make — a slug the site reserves (measured: Apex accepts `/admin`), and a
 * duplicate slug surfaced as something an editor can act on.
 */
const ORIGIN = 'https://site.test';
const CSRF = 'csrf-pages';
const PAGE = 'dddddddd-1111-2222-3333-444444444444';

bindReservedRoutes({ prefixes: ['/blogs'], routes: ['/search'] });

function apexStub(calls, { createStatus = 200 } = {}) {
	return {
		async createPage(body) {
			calls.push(['createPage', body]);
			if (createStatus === 422) {
				return { ok: false, status: 422, body: { data: [{ attribute_name: 'slug' }] } };
			}
			return {
				ok: true,
				status: 200,
				body: {
					data: {
						id: PAGE,
						...body,
						status: 'draft',
						blocks: [],
						meta_properties: [],
						updated_at: 'now'
					}
				}
			};
		}
	};
}

function ctxWith(calls, options) {
	return {
		allowedOrigins: parseAllowedOrigins(ORIGIN),
		reviewOnlyFields: [],
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
		createApexClient: () => apexStub(calls, options)
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
		staffId: '11111111-1111-2222-3333-444444444444',
		staffName: 'E',
		accessToken: 't',
		tokenType: 'Bearer',
		accessExpiresAt: now + 3600_000,
		refreshToken: 'r'
	});
	return secret;
}

function post(session, body) {
	return new Request(`${ORIGIN}/api/admin/pages`, {
		method: 'POST',
		headers: {
			origin: ORIGIN,
			'sec-fetch-site': 'same-origin',
			'content-type': 'application/json',
			'x-csrf-token': CSRF,
			cookie: `apex_admin_session=${session}; apex_bff_csrf=${CSRF}`
		},
		body: JSON.stringify(body)
	});
}

describe('the create body is closed', () => {
	it('takes title, slug and an optional summary, and nothing else', () => {
		assert.ok(createPageBodySchema.safeParse({ title: 'T', slug: 'about-us' }).success);
		assert.ok(
			createPageBodySchema.safeParse({ title: 'T', slug: 'about-us', summary: 'S' }).success
		);
		assert.ok(!createPageBodySchema.safeParse({ title: 'T', slug: 'About Us' }).success);
		assert.ok(
			!createPageBodySchema.safeParse({ title: 'T', slug: 'a', status: 'published' }).success
		);
		assert.ok(!createPageBodySchema.safeParse({ slug: 'a' }).success);
	});
});

describe('handleCreatePage', () => {
	it('sends exactly title, slug and summary, and answers 201 with the page and a version', async () => {
		const calls = [];
		const ctx = ctxWith(calls);
		const res = await handleCreatePage(
			post(await signIn(ctx), { title: 'About', slug: 'about-us' }),
			ctx
		);
		assert.equal(res.status, 201, await res.clone().text());
		const body = await res.json();
		assert.equal(body.ok, true);
		assert.equal(body.page.id, PAGE);
		assert.match(body.version, /^[0-9a-f]{64}$/u);
		assert.deepEqual(calls, [['createPage', { title: 'About', slug: 'about-us', summary: '' }]]);
	});

	it('refuses a slug the site reserves BEFORE Apex — admin, api, a generated tree, an exact route', async () => {
		for (const slug of ['admin', 'api/x', 'blogs/hello', 'search']) {
			const calls = [];
			const ctx = ctxWith(calls);
			const res = await handleCreatePage(post(await signIn(ctx), { title: 'T', slug }), ctx);
			assert.equal(res.status, 400, slug);
			assert.deepEqual(await res.json(), { error: 'reserved-slug' });
			assert.deepEqual(calls, [], `${slug} must never reach Apex`);
		}
	});

	it('surfaces a duplicate slug as 409 slug-taken', async () => {
		const calls = [];
		const ctx = ctxWith(calls, { createStatus: 422 });
		const res = await handleCreatePage(post(await signIn(ctx), { title: 'T', slug: 'taken' }), ctx);
		assert.equal(res.status, 409);
		assert.deepEqual(await res.json(), { error: 'slug-taken' });
	});
});
