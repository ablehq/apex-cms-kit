// @ts-nocheck — the request harness exercises the real BFF guard and Apex wire body.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleUpdatePageSeo } from '../src/server/bff/operations/update-page-seo.ts';
import { createSessionSecret, sessionIdFor } from '../src/server/bff/session.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { createMemorySessionStore } from './harness/session-store.ts';
import { createMigratedDatabase } from './harness/d1.ts';

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
	/** PIN: update-page-seo.ts:17-27 has always rejected a page title outside `meta`. */
	it('rejects a top-level page title without calling Apex', async () => {
		const { response, calls } = await run(page(), { title: 'P' });
		assert.equal(response.status, 400);
		assert.deepEqual(calls, []);
	});
	/** update-page-seo.ts:17-27 and :62-70 accept meta title but take its id from Apex. */
	it('writes meta title by its stored id and never page.title', async () => {
		const { response, calls } = await run(
			page([{ id: META, name: 'title', group: 'web', value: '' }]),
			{ meta: { title: 'M' } }
		);
		assert.equal(response.status, 200);
		assert.deepEqual(calls.find(([name]) => name === 'updatePageStructure')[2], {
			meta_properties_attributes: [
				{ id: META, name: 'title', group: 'web', value_type: 'string', value: 'M' }
			]
		});
	});

	/** update-page-seo.ts:62-68 must reject any requested name without a stored row. */
	it('refuses a missing title row before any write', async () => {
		const { response, calls } = await run(page([]), { meta: { title: 'M' } });
		assert.equal(response.status, 409);
		assert.equal(calls.filter(([name]) => name === 'updatePageStructure').length, 0);
	});

	/** update-page-seo.ts:62-68 must not partially write when one of several names is absent. */
	it('refuses the whole request when keywords have no stored row', async () => {
		const { response, calls } = await run(
			page([{ id: META, name: 'title', group: 'web', value: '' }]),
			{ meta: { title: 'M', keywords: 'k' } }
		);
		assert.equal(response.status, 409);
		assert.equal(calls.filter(([name]) => name === 'updatePageStructure').length, 0);
	});

	/**
	 * kit#12 review (Isaac): the 409 names the rowless names, so the editor is
	 * told to clear only those. Here the description has a row and title does not.
	 */
	it('names only the rowless names in the missing-row refusal', async () => {
		const { response, calls } = await run(page(), { meta: { title: 'M', description: 'After' } });
		assert.equal(response.status, 409);
		assert.deepEqual(await response.json(), { missing: ['title'], error: 'missing meta row' });
		assert.equal(calls.filter(([name]) => name === 'updatePageStructure').length, 0);
	});

	/** update-post.ts:68-73 sets the shared SEO ceilings; browser input cannot bypass them. */
	it('refuses keywords over 500 characters before Apex', async () => {
		const { response, calls } = await run(page(), { meta: { keywords: 'x'.repeat(501) } });
		assert.equal(response.status, 400);
		assert.deepEqual(calls, []);
	});

	it('refuses a title over 300 characters with invalid body before Apex', async () => {
		const { response, calls } = await run(
			page([{ id: META, name: 'title', group: 'web', value: '' }]),
			{ meta: { title: 'x'.repeat(301) } }
		);
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { error: 'invalid body' });
		assert.deepEqual(calls, []);
	});

	/** update-page-seo.ts:72-75 audits the names sent, so the log identifies the edited fields. */
	it('audits title and keywords by name', async () => {
		const db = await createMigratedDatabase();
		try {
			const calls = [];
			const ctx = context(
				page([
					{ id: META, name: 'title', group: 'web', value: '' },
					{ id: EXTRA, name: 'keywords', group: 'web', value: '' }
				]),
				calls
			);
			ctx.db = db;
			const response = await handleUpdatePageSeo(
				await signedRequest(ctx, {
					meta: { title: 'M', keywords: 'k' }
				}),
				ctx,
				{ pageId: PAGE }
			);
			assert.equal(response.status, 200);
			const row = db.sqlite
				.prepare("SELECT detail FROM bff_audit_log WHERE action = 'pages.seo.update'")
				.get();
			assert.deepEqual(JSON.parse(row.detail).fields, ['title', 'keywords']);
		} finally {
			db.close();
		}
	});
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
	 * Phase 6 K3: the route accepts three names, but no browser-supplied ids;
	 * each name uses the post SEO ceiling rather than an unbounded string.
	 */
	it('rejects extra meta names and ids before any Apex call', async () => {
		for (const body of [
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
