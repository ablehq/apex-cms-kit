// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { containsReviewOnlyField } from '../src/server/bff/authorization.ts';
import { handlePatchEntityFields } from '../src/server/bff/operations/patch-entity-fields.ts';
import { handleSavePageStructure } from '../src/server/bff/operations/save-page-structure.ts';
import { handlePatchPageStatus } from '../src/server/bff/operations/patch-page-status.ts';
import { createSessionSecret, sessionIdFor } from '../src/server/bff/session.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { createMemorySessionStore } from './harness/session-store.ts';

const ORIGIN = 'https://site.test';
const CSRF = 'csrf-review-only';
const PAGE_ID = '8f14e45f-ceea-467a-9a3c-3f1a7c9d2b55';
const ENTITY_ID = '5c9f0a21-1b2c-4d3e-8f40-a1b2c3d4e5f6';

/**
 * The review-only guard, exercised at every kit operation that enforces it.
 *
 * Until this file there was NO kit test for any of the three: the list lived in the
 * kit as a hard-coded GLC field name, so the gate was only ever proved from GLC.
 * Now the list arrives on the context, and what has to be proved here is both
 * directions — a site that names a field is protected, and a site that names none
 * is not accidentally gated (nor crashed) by an empty list.
 */

/**
 * Records the Apex method each operation reaches for, whatever it is called. That
 * is the observable this suite needs: a refused request must touch Apex ZERO times,
 * and an ungated one must get far enough to try.
 */
function recordingApex(calls) {
	return new Proxy(
		{},
		{
			get:
				(_target, name) =>
				async (...args) => {
					calls.push(String(name));
					return { ok: true, status: 200, data: { id: args[0] ?? null } };
				}
		}
	);
}

function ctxWith(reviewOnlyFields, calls = []) {
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
		createApexClient: () => recordingApex(calls),
		reviewOnlyFields
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
		staffId: 'aaaaaaaa-1111-4222-8333-444444444444',
		staffName: 'E',
		accessToken: 't',
		tokenType: 'Bearer',
		accessExpiresAt: now + 3600_000,
		refreshToken: 'r'
	});
	return secret;
}

function write(session, path, body, method = 'PATCH') {
	return new Request(`${ORIGIN}${path}`, {
		method,
		headers: {
			origin: ORIGIN,
			'sec-fetch-site': 'same-origin',
			'x-csrf-token': CSRF,
			'content-type': 'application/json',
			cookie: `apex_admin_session=${session}; apex_bff_csrf=${CSRF}`
		},
		body: JSON.stringify(body)
	});
}

describe('containsReviewOnlyField — the predicate itself', () => {
	const FIELDS = ['transcript_reviewed'];

	it('finds the name at the top level, nested, and inside an array', () => {
		assert.equal(containsReviewOnlyField({ transcript_reviewed: true }, FIELDS), true);
		assert.equal(containsReviewOnlyField({ a: { b: { transcript_reviewed: 1 } } }, FIELDS), true);
		assert.equal(containsReviewOnlyField([{ transcript_reviewed: false }], FIELDS), true);
	});

	it('scans `fields_data` KEYS but treats each field VALUE as opaque content', () => {
		assert.equal(
			containsReviewOnlyField({ fields_data: { transcript_reviewed: true } }, FIELDS),
			true
		);
		// The literal string as a VALUE is content, not an attribute name.
		assert.equal(containsReviewOnlyField({ note: 'transcript_reviewed' }, FIELDS), false);
		// A key inside a rich-text value is content too — this is the documented skip.
		assert.equal(
			containsReviewOnlyField({ fields_data: { body: { transcript_reviewed: 1 } } }, FIELDS),
			false
		);
	});

	it('fails CLOSED past the structural depth cap', () => {
		let deep = {};
		let cursor = deep;
		for (let i = 0; i < 70; i += 1) {
			cursor.next = {};
			cursor = cursor.next;
		}
		assert.equal(containsReviewOnlyField(deep, FIELDS), true);
	});

	it('an EMPTY list gates nothing — and does not throw', () => {
		assert.equal(containsReviewOnlyField({ transcript_reviewed: true }, []), false);
		assert.equal(containsReviewOnlyField({ a: { b: 1 } }, []), false);
	});
});

describe('the three kit operations that enforce the review-only rule', () => {
	const cases = [
		{
			name: 'entity field patch',
			body: { fields_data: { transcript_reviewed: true } },
			run: (request, ctx) =>
				handlePatchEntityFields(request, ctx, { entityTypeId: PAGE_ID, entityId: ENTITY_ID }),
			path: `/api/admin/entities/${PAGE_ID}/${ENTITY_ID}/fields`
		},
		{
			name: 'page structure save',
			body: { blocks: [{ entity_attributes: { fields_data: { transcript_reviewed: true } } }] },
			run: (request, ctx) => handleSavePageStructure(request, ctx, { pageId: PAGE_ID }),
			path: `/api/admin/pages/${PAGE_ID}/structure`
		},
		{
			name: 'page status',
			body: { status: 'published', transcript_reviewed: true },
			run: (request, ctx) => handlePatchPageStatus(request, ctx, { pageId: PAGE_ID }),
			path: `/api/admin/pages/${PAGE_ID}/status`
		}
	];

	for (const testCase of cases) {
		it(`${testCase.name} refuses a body that names a review-only field, before Apex`, async () => {
			const calls = [];
			const ctx = ctxWith(['transcript_reviewed'], calls);
			const session = await signIn(ctx);
			const response = await testCase.run(write(session, testCase.path, testCase.body), ctx);
			assert.equal(response.status, 400, `${testCase.name} should refuse`);
			// `field not allowed` is the review-only guard's own code, distinct from the
			// `invalid body` a schema failure returns — otherwise these bodies could 400
			// for the wrong reason and the test would still pass.
			assert.equal((await response.json()).error, 'field not allowed');
			// The refusal is what matters, but so is WHERE it happens: nothing reached Apex.
			assert.deepEqual(calls, [], `${testCase.name} must refuse before writing`);
		});

		it(`${testCase.name} does NOT gate a site whose list is empty`, async () => {
			const calls = [];
			const ctx = ctxWith([], calls);
			const session = await signIn(ctx);
			const response = await testCase.run(write(session, testCase.path, testCase.body), ctx);
			// The same body must no longer be refused BY THE REVIEW-ONLY GUARD. Two of
			// these bodies still fail their own schema (they carry a field the strict
			// parser does not know), which is a different 400 — so the assertion is on
			// the code, not the status.
			const error = response.status === 400 ? (await response.json()).error : null;
			assert.notEqual(error, 'field not allowed', `${testCase.name} should not be gated`);
		});
	}
});
