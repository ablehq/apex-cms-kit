// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleSavePageStructure } from '../src/server/bff/operations/save-page-structure.ts';
import { createSessionSecret, sessionIdFor } from '../src/server/bff/session.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { createMemorySessionStore } from './harness/session-store.ts';

/**
 * A SITE THAT NEVER BOUND ITS RESERVED ROUTES.
 *
 * `bindReservedRoutes` is module state and there is no way to unbind, so this
 * case cannot share a process with the bound suite — hence its own file. Node's
 * test runner gives each file its own process, which is what makes that work;
 * nothing here may import a module that binds.
 *
 * The behaviour is the one `create-page.ts` already has, and it is deliberate:
 * nothing can say whether the slug is safe, and a page that silently never
 * renders is the worse answer than a refused save. MUTATION: drop the try/catch
 * around the validator in `handleSavePageStructure` → the rename case here throws
 * out of the handler instead of answering 500, and goes RED.
 */
const ORIGIN = 'https://site.test';
const CSRF = 'csrf-slug-unbound';
const PAGE = '7a14e45f-ceea-467a-9a3c-3f1a7c9d2b55';
const BLOCK = 'a1000000-0000-4000-8000-000000000001';

function pageAt(slug) {
	return {
		id: PAGE,
		title: 'A page',
		slug,
		meta_properties: [],
		blocks: [
			{
				id: BLOCK,
				position: 0,
				blockable_type: 'Cms::PageBlock::RichText',
				blockable: { id: 'a1000000-0000-4000-8000-000000000002', content_html: '<p>A</p>' }
			}
		]
	};
}

function bodyFor(slug) {
	return {
		title: 'A page',
		slug,
		summary: '',
		blocks_attributes: [
			{
				id: BLOCK,
				position: 0,
				blockable_type: 'Cms::PageBlock::RichText',
				blockable_attributes: {
					id: 'a1000000-0000-4000-8000-000000000002',
					content_html: '<p>A, edited</p>'
				},
				_destroy: false
			}
		]
	};
}

function ctxWith(calls, page) {
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
		}),
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

function patch(session, body) {
	return new Request(`${ORIGIN}/api/admin/pages/${PAGE}/structure`, {
		method: 'PATCH',
		headers: {
			origin: ORIGIN,
			'sec-fetch-site': 'same-origin',
			'content-type': 'application/json',
			'x-csrf-token': CSRF,
			cookie: `apex_bff_csrf=${CSRF}; apex_admin_session=${session}`
		},
		body: JSON.stringify(body)
	});
}

async function save(storedSlug, body) {
	const calls = [];
	const ctx = ctxWith(calls, pageAt(storedSlug));
	const res = await handleSavePageStructure(patch(await signIn(ctx), body), ctx, {
		pageId: PAGE
	});
	return { res, patches: calls.filter(([name]) => name === 'updatePageStructure') };
}

describe('a site that never bound its reserved routes', () => {
	it('refuses a RENAME with the same fail-closed 500 the create path answers', async () => {
		const { res, patches } = await save('about-us', bodyFor('about-the-firm'));
		assert.equal(res.status, 500);
		assert.deepEqual(await res.json(), { error: 'reserved routes not bound' });
		assert.deepEqual(patches, [], 'nothing is written when nothing can be judged');
	});

	it('still saves a reorder, because an unchanged slug is never judged', async () => {
		// The guard consults the validator only on a rename, so an unbound site is
		// not locked out of editing its pages — only out of moving them.
		const { res, patches } = await save('about-us', bodyFor('about-us'));
		assert.equal(res.status, 200, await res.clone().text());
		assert.equal(patches.length, 1);
	});
});
