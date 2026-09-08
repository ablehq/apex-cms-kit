// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleCreateTag } from '../src/server/bff/operations/reconcile-taggings.ts';
import { createSessionSecret, sessionIdFor } from '../src/server/bff/session.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { createMemorySessionStore } from './harness/session-store.ts';
import { createMigratedDatabase } from './harness/d1.ts';

/**
 * `POST /api/admin/tags` — THE FIFTH 2xx-CREATE IN THIS BFF, and the one that kept
 * the contradiction the other four were fixed for (codex P5 fix 4, item 2).
 *
 * It wrote its audit row FIRST — `accepted` for any 2xx and for any 422 — and only
 * afterwards asked whether it could name a tag. Two rows in that log were therefore
 * false:
 *
 *   • a 2xx whose body carried no usable id was answered 502 and logged `accepted`;
 *   • a 422 whose re-read found nothing to adopt was answered 422 and logged
 *     `accepted`.
 *
 * An audit row that contradicts the response is worse than no row, because it is
 * the row an operator would trust. The verdict — INCLUDING the 422 adoption, which
 * is what actually decides whether this request ended holding a tag — is now taken
 * before the row is written.
 *
 * MUTATIONS THIS FILE KILLS:
 *   M1  move the `auditOutcome` call back above the verdict with
 *       `outcome: ok || status === 422 ? 'accepted' : 'apex_error'`
 *       → the four `upstream_shape_error` cases and the failed-adoption case fail.
 *   M2  drop the `wrongName` check (`verdict.id !== null && returnedName !== name`)
 *       → 'a 2xx that names a DIFFERENT word' fails.
 *   M3  audit before the adoption re-read (`adopted` always null at audit time)
 *       → 'a 422 the re-read can adopt' fails.
 */

const ORIGIN = 'https://site.test';
const CSRF = 'csrf-create-tag';
const TAG_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3311';
const OTHER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3312';

/**
 * @param vocabulary the rows `listTags` answers with. On a 422 the handler re-reads,
 *   so `afterCreate` is what the SECOND read sees — the row another editor won the
 *   race with.
 */
function recordingApex({ create, vocabulary = [], afterCreate = null } = {}) {
	let created = false;
	return {
		async listTags() {
			const rows = created && afterCreate ? afterCreate : vocabulary;
			return { ok: true, status: 200, body: { data: rows, pagination: { total_pages: 1 } } };
		},
		async createTag() {
			created = true;
			return create;
		}
	};
}

function ctxWith(apex, db) {
	return {
		allowedOrigins: parseAllowedOrigins(ORIGIN),
		sessions: createMemorySessionStore(),
		db,
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
		createApexClient: () => apex
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

async function createTag(ctx, name) {
	const session = await signIn(ctx);
	return handleCreateTag(
		new Request(`${ORIGIN}/api/admin/tags`, {
			method: 'POST',
			headers: {
				origin: ORIGIN,
				'sec-fetch-site': 'same-origin',
				'x-csrf-token': CSRF,
				'content-type': 'application/json',
				cookie: `apex_admin_session=${session}; apex_bff_csrf=${CSRF}`
			},
			body: JSON.stringify({ name })
		}),
		ctx
	);
}

async function auditRows(db) {
	return db.sqlite
		.prepare('SELECT outcome, detail FROM bff_audit_log ORDER BY occurred_at, rowid')
		.all()
		.map((row) => ({ ...row, detail: JSON.parse(row.detail) }));
}

/** One case: run it against a fresh migrated D1 and hand back response + rows. */
async function run(apexOptions, name = 'doctrine') {
	const db = await createMigratedDatabase();
	const response = await createTag(ctxWith(recordingApex(apexOptions), db), name);
	const rows = await auditRows(db);
	db.close();
	return { response, rows };
}

describe('POST /api/admin/tags: the audit row may not contradict the response', () => {
	it('a 2xx naming a usable tag is `accepted`, and the row carries the id', async () => {
		const { response, rows } = await run({
			create: { ok: true, status: 200, body: { data: { id: TAG_ID, name: 'doctrine' } } }
		});
		assert.equal(response.status, 201);
		assert.deepEqual(await response.json(), {
			ok: true,
			tag: { id: TAG_ID, name: 'doctrine' },
			created: true
		});
		assert.equal(rows.length, 1);
		assert.equal(rows[0].outcome, 'accepted');
		assert.equal(rows[0].detail.tagId, TAG_ID);
		assert.equal(rows[0].detail.name, 'doctrine');
	});

	it('a 2xx with NO id is `upstream_shape_error`, not `accepted`', async () => {
		// The response is 502. Under the old ordering the log said `accepted` — for a
		// request that failed, about a row Apex had probably created and this handler
		// could no longer point at.
		const { response, rows } = await run({ create: { ok: true, status: 200, body: { data: {} } } });
		assert.equal(response.status, 502);
		assert.equal(rows[0].outcome, 'upstream_shape_error');
		assert.equal(rows[0].detail.reason, 'missing-tag-id');
		assert.equal(rows[0].detail.tagId, null);
		assert.equal(rows[0].detail.returnedId, null);
	});

	it('a 2xx with a NON-UUID id is `upstream_shape_error`, and the raw value is kept', async () => {
		// The raw id is the handle an operator needs to go and find the row nothing
		// references. It is capped, and it is NOT handed on: `assertUuid` guards every
		// path that would interpolate it into an Apex URL.
		const { response, rows } = await run({
			create: { ok: true, status: 200, body: { data: { id: 'yes', name: 'doctrine' } } }
		});
		assert.equal(response.status, 502);
		assert.equal(rows[0].outcome, 'upstream_shape_error');
		assert.equal(rows[0].detail.reason, 'malformed-tag-id');
		assert.equal(rows[0].detail.returnedId, 'yes');
		assert.equal(rows[0].detail.tagId, null);
	});

	it('a 2xx that names a DIFFERENT word is `upstream_shape_error`', async () => {
		/**
		 * The id is fine and the create succeeded — but the picker is about to show
		 * the word the editor typed as selected, over an id belonging to another tag,
		 * and every record tagged in that session would carry the wrong word.
		 *
		 * Measured on local Apex before making this fatal: `POST /tags` echoes `name`
		 * verbatim — case, inner spaces, and the outer ones a caller sends. A mismatch
		 * is a genuine upstream-shape fault, not this handler misreading a
		 * normalisation that does not happen.
		 */
		const { response, rows } = await run({
			create: { ok: true, status: 200, body: { data: { id: TAG_ID, name: 'something else' } } }
		});
		assert.equal(response.status, 502);
		assert.equal(rows[0].outcome, 'upstream_shape_error');
		assert.equal(rows[0].detail.reason, 'unexpected-tag-name');
		assert.equal(rows[0].detail.returnedName, 'something else');
		assert.equal(rows[0].detail.tagId, null);
	});

	it('a 422 the re-read CAN adopt is `accepted` — the race is not an error', async () => {
		// Another editor created it between the list and the write. The editor asked
		// for a tag by that name and there is one, which is what they wanted.
		const { response, rows } = await run({
			create: { ok: false, status: 422, body: { errors: ['Name has already been taken'] } },
			vocabulary: [],
			afterCreate: [{ id: OTHER_ID, name: 'doctrine' }]
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			ok: true,
			tag: { id: OTHER_ID, name: 'doctrine' },
			created: false
		});
		assert.equal(rows[0].outcome, 'accepted');
		assert.equal(rows[0].detail.adopted, true);
		assert.equal(rows[0].detail.tagId, OTHER_ID);
	});

	it('a 422 the re-read CANNOT adopt is `apex_error`, not `accepted`', async () => {
		// Apex refused and nothing came back to adopt: the editor is answered 422 and
		// the log has to say the same thing. This is the second row the old ordering
		// got backwards.
		const { response, rows } = await run({
			create: { ok: false, status: 422, body: { errors: ['Name is invalid'] } },
			vocabulary: [],
			afterCreate: []
		});
		assert.equal(response.status, 422);
		assert.equal(rows[0].outcome, 'apex_error');
		assert.equal(rows[0].detail.adopted, false);
		assert.equal(rows[0].detail.tagId, null);
	});

	it('a 5xx is `apex_error` and comes back 502, with no `adopted` claim at all', async () => {
		const { response, rows } = await run({
			create: { ok: false, status: 500, body: { error: 'boom' } }
		});
		assert.equal(response.status, 502);
		assert.equal(rows[0].outcome, 'apex_error');
		assert.equal(rows[0].detail.tagId, null);
		assert.equal('adopted' in rows[0].detail, false);
	});

	it('a name already in the vocabulary never reaches Apex at all', async () => {
		// The list-then-create half, pinned so the audit changes above cannot quietly
		// turn the common case into a write.
		const { response } = await run({
			create: { ok: false, status: 500, body: {} },
			vocabulary: [{ id: TAG_ID, name: 'doctrine' }]
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			ok: true,
			tag: { id: TAG_ID, name: 'doctrine' },
			created: false
		});
	});
});
