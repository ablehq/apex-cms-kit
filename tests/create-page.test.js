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
import { createMigratedDatabase } from './harness/d1.ts';

/**
 * The page create: what reaches Apex, and the two refusals Apex itself does not
 * make — a slug the site reserves (measured: Apex accepts `/admin`), and a
 * duplicate slug surfaced as something an editor can act on.
 */
const ORIGIN = 'https://site.test';
const CSRF = 'csrf-pages';
const PAGE = 'dddddddd-1111-2222-3333-444444444444';

bindReservedRoutes({ prefixes: ['/blogs'], routes: ['/search'] });

function apexStub(calls, { createStatus = 200, createdId = PAGE } = {}) {
	return {
		async createPage(body) {
			calls.push(['createPage', body]);
			if (createStatus === 422) {
				return { ok: false, status: 422, body: { data: [{ attribute_name: 'slug' }] } };
			}
			if (createdId === null) return { ok: true, status: 200, body: { data: { ...body } } };
			return {
				ok: true,
				status: 200,
				body: {
					data: {
						id: createdId,
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

function ctxWith(calls, options, db) {
	return {
		...(db ? { db } : {}),
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

describe('the audit row may not contradict the response', () => {
	/**
	 * P5 fix 3, item 2. `handleCreateEntity` was given `upstream_shape_error` for the
	 * 2xx it cannot name; `createPage`, `createPost` and `createRecord` had the
	 * IDENTICAL contradiction and did not get the fix — they wrote `accepted` before
	 * knowing the write was nameable, and could then answer 502 while the log said
	 * the operation had been accepted. An audit row that contradicts the response is
	 * worse than no row: it is the row an operator would trust.
	 *
	 * `createPage` also accepted an EMPTY STRING as an id (`typeof page.id ===
	 * 'string'`), which reached the response body as `page.id` and would have been
	 * interpolated into the next Apex URL the editor asked for.
	 * (codex's P5 fix review, 2026-09-08.)
	 *
	 * MUTATIONS: audit `apexResponse.ok ? 'accepted' : 'apex_error'` again — the
	 * first three cases fail; put `typeof page.id === 'string'` back as the id check
	 * — the empty-string and non-uuid cases fail.
	 */
	async function rows(db) {
		return db.sqlite
			.prepare('SELECT outcome, detail FROM bff_audit_log ORDER BY occurred_at, rowid')
			.all()
			.map((row) => ({ ...row, detail: JSON.parse(row.detail) }));
	}

	async function create(createdId) {
		const db = await createMigratedDatabase();
		const ctx = ctxWith([], { createdId }, db);
		const res = await handleCreatePage(
			post(await signIn(ctx), { title: 'T', slug: 'a-page' }),
			ctx
		);
		const audit = await rows(db);
		db.close();
		return { res, audit };
	}

	it('a 2xx with NO id is `upstream_shape_error`, and the response is 502', async () => {
		const { res, audit } = await create(null);
		assert.equal(res.status, 502);
		assert.equal((await res.json()).error, 'unexpected upstream shape');
		assert.equal(audit.length, 1);
		assert.equal(audit[0].outcome, 'upstream_shape_error');
		assert.equal(audit[0].detail.reason, 'missing-page-id');
		assert.equal(audit[0].detail.pageId, null);
		assert.equal(audit[0].detail.returnedId, null);
	});

	it('a 2xx with an EMPTY-STRING id is refused, not accepted as a page', async () => {
		// The specific hole: `typeof '' === 'string'` passed, so a 201 went back with
		// `page.id: ''` and the editor's next request built an Apex URL ending in `/`.
		const { res, audit } = await create('');
		assert.equal(res.status, 502);
		assert.equal(audit[0].outcome, 'upstream_shape_error');
		assert.equal(audit[0].detail.reason, 'missing-page-id');
	});

	it('a 2xx with a NON-UUID id is `malformed-page-id`, and keeps the raw value', async () => {
		const { res, audit } = await create('yes');
		assert.equal(res.status, 502);
		assert.equal(audit[0].outcome, 'upstream_shape_error');
		assert.equal(audit[0].detail.reason, 'malformed-page-id');
		assert.equal(audit[0].detail.returnedId, 'yes', 'the handle on the row nothing can name');
		assert.equal(audit[0].detail.pageId, null);
	});

	it('the raw value in the audit row is CAPPED — an audit table is not a sink', async () => {
		const { audit } = await create('z'.repeat(5000));
		assert.equal(audit[0].detail.returnedId.length, 120);
	});

	it('the control: a real uuid is accepted, audited accepted, and named in the row', async () => {
		const { res, audit } = await create(PAGE);
		assert.equal(res.status, 201);
		assert.equal(audit.length, 1);
		assert.equal(audit[0].outcome, 'accepted');
		assert.equal(audit[0].detail.pageId, PAGE);
		assert.ok(!('reason' in audit[0].detail));
	});

	it('an APEX FAILURE is still `apex_error`, not a shape fault', async () => {
		// A missing id in a failure body is expected, and calling it a shape fault
		// would bury the upstream error under a different name.
		const db = await createMigratedDatabase();
		const ctx = ctxWith([], { createStatus: 422 }, db);
		const res = await handleCreatePage(
			post(await signIn(ctx), { title: 'T', slug: 'a-page' }),
			ctx
		);
		// 409, not 422: a 422 naming `slug` is Apex saying the slug is taken.
		assert.equal(res.status, 409);
		const audit = await rows(db);
		db.close();
		assert.equal(audit[0].outcome, 'apex_error');
		assert.ok(!('reason' in audit[0].detail));
	});
});
