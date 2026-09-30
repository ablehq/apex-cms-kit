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

describe('page SEO write boundary', () => {
	/**
	 * Phase 4A §7: local Apex answered 200 for an id-less write and silently
	 * appended a duplicate description, which crashes Poovayya's keyed page each.
	 */
	it('takes the description id from Apex and heals a duplicate row', async () => {
		const { response, calls } = await run(
			page([
				{ id: META, name: 'description', group: 'web', value: 'Before' },
				{ id: EXTRA, name: 'description', group: 'web', value: 'Duplicate' }
			]),
			{ meta: { description: 'After' } }
		);
		assert.equal(response.status, 200, await response.clone().text());
		assert.deepEqual(
			calls.find(([name]) => name === 'updatePageStructure'),
			[
				'updatePageStructure',
				PAGE,
				{
					meta_properties_attributes: [
						{ id: META, name: 'description', group: 'web', value_type: 'string', value: 'After' },
						{ id: EXTRA, _destroy: true }
					]
				}
			]
		);
	});

	/**
	 * Phase 4A §1.6a: the route must not accept browser-supplied ids or title
	 * and keywords, since only description is rendered on both sites; its length
	 * must use the post SEO ceiling rather than passing an unbounded string.
	 */
	it('rejects extra meta names and ids before any Apex call', async () => {
		for (const body of [
			{ meta: { title: 'Invisible' } },
			{ meta: { description: 'x'.repeat(1001) } },
			{ meta: { description: 'After', id: EXTRA } },
			{ meta: { description: 'After' }, id: EXTRA }
		]) {
			const { response, calls } = await run(page(), body);
			assert.equal(response.status, 400);
			assert.deepEqual(calls, []);
		}
	});

	/**
	 * Phase 4A §1.4b: older pages elsewhere may lack a web description.
	 * Skipping its missing id must never become an id-less append or false save.
	 */
	it('refuses a missing description row without writing', async () => {
		const { response, calls } = await run(page([]), { meta: { description: 'After' } });
		assert.equal(response.status, 409);
		assert.deepEqual(
			calls.filter(([name]) => name === 'updatePageStructure'),
			[]
		);
	});
});
