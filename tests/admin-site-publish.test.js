// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handlePublishSite, handleSiteStatus } from '../src/server/bff/operations/publish-site.ts';
import { createSessionSecret, sessionIdFor } from '../src/server/bff/session.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { createMemorySessionStore } from './harness/session-store.ts';
import { CONTENT_KEY, resetContentMemo } from '../src/server/content/read.ts';

const ORIGIN = 'https://gospellife.in';
const CSRF = 'csrf-publish';
const ACCOUNT = '11111111-2222-4333-8444-555555555555';

function memoryStore() {
	const map = new Map();
	return {
		map,
		async get(key) {
			return map.has(key) ? map.get(key) : null;
		},
		async put(key, value) {
			map.set(key, value);
		}
	};
}

/** An Apex client that answers every collection with one record, or fails one path. */
function stubApex(failPath = null) {
	const page = (id) => ({
		data: [{ id }],
		pagination: { total_count: 1, current_page: 1, total_pages: 1 }
	});
	const empty = { data: [], pagination: { total_count: 0, current_page: 1, total_pages: 0 } };
	return {
		async readCmsConfig() {
			return {
				status: 200,
				ok: true,
				body: {
					data: {
						posts: [],
						content_library: [
							{ archetype_schema: { slug: 'author', plural_name: 'authors', account_id: ACCOUNT } }
						],
						asset_library: []
					}
				}
			};
		},
		async get(path) {
			if (path === failPath) return { status: 502, ok: false, body: null };
			if (path.endsWith('/specification/archetypes/search_and_filter'))
				return { status: 200, ok: true, body: page('a1') };
			if (path.endsWith('/tags/search_and_filter'))
				return { status: 200, ok: true, body: page('t1') };
			return { status: 200, ok: true, body: empty };
		}
	};
}

function baseCtx(overrides = {}) {
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
		createApexClient: () => stubApex(),
		content: memoryStore(),
		accountId: ACCOUNT,
		...overrides
	};
}

async function signIn(ctx) {
	const secret = createSessionSecret();
	const now = Date.now();
	await ctx.sessions.create({
		id: await sessionIdFor(secret),
		createdAt: now,
		lastSeenAt: now,
		expiresAt: now + 8 * 60 * 60 * 1000,
		staffEmail: 'editor@gospellife.in',
		staffId: 'aaaaaaaa-1111-4222-8333-444444444444',
		staffName: 'Test Editor',
		accessToken: 'apex-access',
		tokenType: 'Bearer',
		accessExpiresAt: now + 2 * 60 * 60 * 1000,
		refreshToken: 'apex-refresh'
	});
	return secret;
}

function publishRequest(session, { method = 'POST', body, origin = ORIGIN } = {}) {
	return new Request(`${ORIGIN}/api/admin/site/publish`, {
		method,
		headers: {
			origin,
			'sec-fetch-site': 'same-origin',
			'content-type': 'application/json',
			...(method === 'POST' ? { 'x-csrf-token': CSRF } : {}),
			cookie: session
				? `apex_admin_session=${session}; apex_bff_csrf=${CSRF}`
				: `apex_bff_csrf=${CSRF}`
		},
		...(body ? { body: JSON.stringify(body) } : {})
	});
}

describe('POST /api/admin/site/publish — the guard', () => {
	it('signed out is 401 and nothing is read or written', async () => {
		const ctx = baseCtx();
		const response = await handlePublishSite(publishRequest(null), ctx);
		assert.equal(response.status, 401);
		assert.equal(ctx.content.map.size, 0);
	});

	it('a foreign origin is refused before the session is looked at', async () => {
		const ctx = baseCtx();
		const session = await signIn(ctx);
		const response = await handlePublishSite(
			publishRequest(session, { origin: 'https://preview.example' }),
			ctx
		);
		assert.equal(response.status, 403);
		assert.equal(ctx.content.map.size, 0);
	});

	it('no CONTENT binding ⇒ 501 with a named code', async () => {
		const ctx = baseCtx({ content: undefined });
		const session = await signIn(ctx);
		const response = await handlePublishSite(publishRequest(session), ctx);
		assert.equal(response.status, 501);
		assert.equal((await response.json()).error, 'content_not_configured');
	});
});

describe('POST /api/admin/site/publish — the publish', () => {
	it('writes the snapshot as the editor and answers with the counts', async () => {
		resetContentMemo();
		const ctx = baseCtx();
		const session = await signIn(ctx);
		const response = await handlePublishSite(publishRequest(session), ctx);
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.equal(body.ok, true);
		assert.equal(body.counts.authors, 1);
		assert.ok(ctx.content.map.get(CONTENT_KEY).includes('"publishedBy":"editor@gospellife.in"'));

		const status = await handleSiteStatus(publishRequest(session, { method: 'GET' }), ctx);
		const { published } = await status.json();
		assert.equal(published.version, body.version);
		assert.equal(published.collections, undefined, 'the manifest, not the whole value');
	});

	it('an emptied collection is 409 until the body says allowEmpty', async () => {
		resetContentMemo();
		const ctx = baseCtx();
		const session = await signIn(ctx);
		assert.equal((await handlePublishSite(publishRequest(session), ctx)).status, 200);
		const before = ctx.content.map.get(CONTENT_KEY);

		const emptied = baseCtx({
			content: ctx.content,
			sessions: ctx.sessions,
			createApexClient: () => {
				const apex = stubApex();
				const inner = apex.get;
				apex.get = async (path, query) =>
					path.endsWith('/specification/archetypes/search_and_filter')
						? {
								status: 200,
								ok: true,
								body: { data: [], pagination: { total_count: 0, current_page: 1, total_pages: 0 } }
							}
						: inner(path, query);
				return apex;
			}
		});
		const refused = await handlePublishSite(publishRequest(session), emptied);
		assert.equal(refused.status, 409);
		assert.equal((await refused.json()).error, 'empty_collection');
		assert.equal(ctx.content.map.get(CONTENT_KEY), before, 'nothing written');

		const confirmed = await handlePublishSite(
			publishRequest(session, { body: { allowEmpty: true } }),
			emptied
		);
		assert.equal(confirmed.status, 200);
		assert.equal((await confirmed.json()).counts.authors, 0);
	});

	it('an Apex failure is 502 with our sentence, an unknown error is 502 with a fixed one', async () => {
		resetContentMemo();
		const ctx = baseCtx({
			createApexClient: () => stubApex('/api/platform/v1/tags/search_and_filter')
		});
		const session = await signIn(ctx);
		const failed = await handlePublishSite(publishRequest(session), ctx);
		assert.equal(failed.status, 502);
		assert.match((await failed.json()).detail, /tags:tags: Apex 502/);
		assert.equal(ctx.content.map.size, 0);

		const thrown = baseCtx({
			sessions: ctx.sessions,
			createApexClient: () => ({
				async readCmsConfig() {
					throw new Error('secret internals');
				}
			})
		});
		const response = await handlePublishSite(publishRequest(session), thrown);
		assert.equal(response.status, 502);
		assert.doesNotMatch((await response.json()).detail, /secret internals/);
	});
});
