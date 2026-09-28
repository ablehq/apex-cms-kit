// @ts-nocheck — the request harness exercises the real BFF guard and Apex wire body.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleUpdatePageSeo } from '../src/server/bff/operations/update-page-seo.ts';
import { createSessionSecret, sessionIdFor } from '../src/server/bff/session.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { createMemorySessionStore } from './harness/session-store.ts';

const ORIGIN = 'https://site.test';
const CSRF = 'csrf-page-seo';
const PAGE = '7a14e45f-ceea-467a-9a3c-3f1a7c9d2b55';
const META = 'a1000000-0000-4000-8000-000000000008';
const EXTRA = 'a1000000-0000-4000-8000-000000000009';

function context(page, calls) {
	return {
		db: {
			prepare() {
				return {
					bind(...values) {
						return {
							async run() {
								calls.audit ??= [];
								calls.audit.push(values);
							}
						};
					}
				};
			}
		},
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
		createApexClient: () => ({
			async getPage(id) {
				calls.push(['getPage', id]);
				return { ok: true, status: 200, body: { data: page } };
			},
			async updatePageStructure(id, body) {
				calls.push(['updatePageStructure', id, body]);
				return { ok: true, status: 200, body: { data: page } };
			}
		})
	};
}

async function signedRequest(ctx, body) {
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
	return new Request(`${ORIGIN}/api/admin/pages/${PAGE}/seo`, {
		method: 'PATCH',
		headers: {
			origin: ORIGIN,
			'sec-fetch-site': 'same-origin',
			'content-type': 'application/json',
			'x-csrf-token': CSRF,
			cookie: `apex_bff_csrf=${CSRF}; apex_admin_session=${secret}`
		},
		body: JSON.stringify(body)
	});
}

function page(rows = [{ id: META, name: 'description', group: 'web', value: 'Before' }]) {
	return { id: PAGE, title: 'Page', slug: '/', meta_properties: rows, blocks: [] };
}

async function run(stored, body) {
	const calls = [];
	const ctx = context(stored, calls);
	const response = await handleUpdatePageSeo(await signedRequest(ctx, body), ctx, { pageId: PAGE });
	return { response, calls };
}

describe('page-only SEO boundary', () => {
	it('updates selected requested web row by ID and removes only its duplicates', async () => {
		const rows = [
			{ id: META, name: 'title', group: 'web', value: '' },
			{ id: EXTRA, name: 'title', group: 'web', value: 'Visible' },
			{ id: 'other', name: 'description', group: 'web', value: 'Keep' },
			{ id: 'social', name: 'title', group: 'social', value: 'Social' }
		];
		const { response, calls } = await run(page(rows), { meta: { title: '' } });
		assert.equal(response.status, 200);
		assert.equal(calls.audit.length, 1);
		assert.equal(calls.audit[0][2], 'e@site.test');
		assert.equal(calls.audit[0][5], 'pages.seo.update');
		assert.equal(calls.audit[0][7], '/api/admin/pages/[pageId]/seo');
		assert.equal(calls.audit[0][9], PAGE);
		assert.equal(calls.audit[0][11], 'accepted');
		assert.deepEqual(JSON.parse(calls.audit[0][12]).fields, ['title']);
		assert.deepEqual(calls[1][2], {
			meta_properties_attributes: [
				{ id: EXTRA, name: 'title', group: 'web', value_type: 'string', value: '' },
				{ id: META, _destroy: true }
			]
		});
	});
	it('refuses missing or idless metadata atomically, including multiple requested names', async () => {
		for (const [rows, code] of [
			[[], 'missing-meta-row'],
			[
				[
					{ name: 'title', group: 'web', value: 'Visible' },
					{ id: META, name: 'title', group: 'web', value: '' }
				],
				'unwritable-meta-row'
			]
		]) {
			const { response, calls } = await run(
				page([{ id: META, name: 'description', group: 'web', value: 'Before' }, ...rows]),
				{ meta: { description: 'New', title: 'New' } }
			);
			assert.equal(response.status, 409);
			assert.equal((await response.json()).error, code);
			assert.equal(calls.length, 1);
			assert.equal(calls.audit[0][11], 'rejected');
			assert.equal(calls.audit[0][9], PAGE);
		}
	});
	it('refuses repeated UUID identity without updating or destroying a survivor', async () => {
		for (const secondName of ['title', 'description']) {
			const rows = [
				{ id: META, group: 'web', name: 'title', value: 'First' },
				{ id: META.toUpperCase(), group: 'web', name: secondName, value: 'Second' }
			];
			const { response, calls } = await run(page(rows), { meta: { title: 'New' } });
			assert.equal(response.status, 409);
			assert.equal((await response.json()).error, 'unwritable-meta-row');
			assert.equal(calls.length, 1);
			assert.equal(calls.audit[0][11], 'rejected');
		}
	});
	it('strictly rejects malformed, extra and oversized fields before any Apex request', async () => {
		for (const body of [
			null,
			[],
			{ title: 'wrong' },
			{ meta: {} },
			{ meta: { title: null } },
			{ meta: { title: 'x'.repeat(301) } },
			{ meta: { description: 'x'.repeat(1001) } },
			{ meta: { keywords: 'x'.repeat(501) } },
			{ meta: { id: META } },
			{ meta: { unknown: 'x' } }
		]) {
			const { response, calls } = await run(page(), body);
			assert.equal(response.status, 400);
			assert.equal(calls.length, 0);
		}
	});
	it('denies unsigned or cross-origin callers without upstream reads', async () => {
		const calls = [];
		const ctx = context(page(), calls);
		const unsigned = await handleUpdatePageSeo(
			new Request(`${ORIGIN}/seo`, {
				method: 'PATCH',
				headers: {
					origin: ORIGIN,
					'sec-fetch-site': 'same-origin',
					'content-type': 'application/json'
				},
				body: JSON.stringify({ meta: { description: 'x' } })
			}),
			ctx,
			{ pageId: PAGE }
		);
		assert.equal(unsigned.status, 403);
		assert.equal(calls.length, 0);
		const request = await signedRequest(ctx, { meta: { description: 'x' } });
		request.headers.set('origin', 'https://evil.test');
		assert.equal((await handleUpdatePageSeo(request, ctx, { pageId: PAGE })).status, 403);
		assert.equal(calls.length, 0);
	});
	it('accepts all three names and preserves empty strings without writing page fields', async () => {
		const rows = ['title', 'description', 'keywords'].map((name, i) => ({
			id: `10000000-0000-4000-8000-00000000000${i}`,
			group: 'web',
			name,
			value: 'Before'
		}));
		const { response, calls } = await run(page(rows), {
			meta: { title: 'SEO', description: '', keywords: 'one, two' }
		});
		assert.equal(response.status, 200);
		assert.equal(calls[1][2].meta_properties_attributes.length, 3);
		assert.equal(calls[1][2].meta_properties_attributes[1].value, '');
		assert.deepEqual(Object.keys(calls[1][2]), ['meta_properties_attributes']);
	});
});
