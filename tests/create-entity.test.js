// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createApexAdminClient } from '../src/server/bff/apex-admin-client.ts';
import { handleCreateEntity } from '../src/server/bff/operations/create-entity.ts';
import { MAX_FIELD_VALUE_CHARS } from '../src/sanitize/write-boundary.ts';
import { createSessionSecret, sessionIdFor } from '../src/server/bff/session.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { createMemorySessionStore } from './harness/session-store.ts';
import { createMigratedDatabase } from './harness/d1.ts';

/**
 * P5a: THE ENTITY-CREATE OPERATION — the mechanic without which a child list
 * cannot be edited at all, and a general-purpose writer into the content library
 * that two of the three sites on this kit must not be able to reach.
 *
 * The two claims this file exists to hold:
 *
 *   1. A SITE THAT NAMES NO ENTITY TYPES CAN CREATE NOTHING. `allowedEntityTypes`
 *      copies `allowedPostSlugs`' refuse-when-absent shape, not
 *      `allowedSchemaSlugs`' allow-when-absent one. Godrej and GLC pass no list, so
 *      mounting this route on either would change nothing they can do — asserted
 *      below with their exact client options rather than described.
 *   2. THE RESPONSE IS `{ok: true, entityId}` AT THE TOP LEVEL. `bff-client.js`'s
 *      `mutate` spreads the body onto the result and the caller reads
 *      `result.entityId`; nesting it under `entity` would make every child create
 *      report failure while the entity exists, and a retry would mint a second
 *      orphan.
 *
 * Plus the boundary rules every write path carries, proved on THIS path: the
 * sanitizer, the per-field ceiling, the unreadable-URL refusal, and the guard exit
 * that costs an unauthenticated caller no D1 row.
 */

const ORIGIN = 'https://site.test';
const CSRF = 'csrf-create-entity';
const ENTITY_TYPE = 'strength-item';
const NEW_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function recordingApex({ status = 200, body, allowed = [ENTITY_TYPE] } = {}) {
	const stored = { created: null };
	return {
		stored,
		allowsEntityType(entityType) {
			return allowed.includes(entityType);
		},
		async createEntity(entityType, fieldsData) {
			if (!allowed.includes(entityType)) throw new Error(`not an allowed entity type`);
			stored.created = { entityType, fieldsData };
			return {
				status,
				ok: status >= 200 && status < 300,
				body: body === undefined ? { data: { id: NEW_ID, fields_data: fieldsData } } : body
			};
		}
	};
}

function ctxWith(apex, db) {
	return {
		allowedOrigins: parseAllowedOrigins(ORIGIN),
		sessions: createMemorySessionStore(),
		...(db ? { db } : {}),
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
		reviewOnlyFields: ['transcript_reviewed']
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

function signedRequest(session, fieldsData, entityType = ENTITY_TYPE) {
	return new Request(`${ORIGIN}/api/admin/entities/${entityType}`, {
		method: 'POST',
		headers: {
			origin: ORIGIN,
			'sec-fetch-site': 'same-origin',
			'x-csrf-token': CSRF,
			'content-type': 'application/json',
			cookie: `apex_admin_session=${session}; apex_bff_csrf=${CSRF}`
		},
		body: JSON.stringify({ fields_data: fieldsData })
	});
}

async function create(ctx, fieldsData, entityType = ENTITY_TYPE) {
	const session = await signIn(ctx);
	return handleCreateEntity(signedRequest(session, fieldsData, entityType), ctx, { entityType });
}

describe('allowedEntityTypes refuses when ABSENT — the property two live sites depend on', () => {
	const fetchImpl = async () => new Response('{}', { status: 200 });

	it("GLC's client options cannot create an entity of any type", async () => {
		// GLC passes `allowedSchemaSlugs` and nothing else (`context.ts:38`).
		const client = createApexAdminClient({
			baseUrl: 'https://apex.internal',
			token: 't',
			fetchImpl,
			allowedSchemaSlugs: ['author', 'resource']
		});
		assert.equal(client.allowsEntityType('author'), false);
		assert.equal(client.allowsEntityType('anything'), false);
		await assert.rejects(
			() => client.createEntity('author', { name: 'x' }),
			/not an allowed entity type/u
		);
	});

	it("Godrej's client options cannot either, though it names both other allowlists", async () => {
		// Godrej passes `allowedSchemaSlugs` AND `allowedPostSlugs` (`context.ts:46-47`),
		// which is exactly the shape that would have been waved through had this option
		// copied `contentLibrarySlug`'s allow-when-absent rule.
		const client = createApexAdminClient({
			baseUrl: 'https://apex.internal',
			token: 't',
			fetchImpl,
			allowedSchemaSlugs: ['focus_area'],
			allowedPostSlugs: ['update']
		});
		assert.equal(client.allowsEntityType('focus_area'), false);
		await assert.rejects(
			() => client.createEntity('focus_area', {}),
			/not an allowed entity type/u
		);
	});

	it('a site that names its types can create those, and only those', async () => {
		const seen = [];
		const client = createApexAdminClient({
			baseUrl: 'https://apex.internal',
			token: 't',
			fetchImpl: async (url, init) => {
				seen.push({ url: String(url), method: init.method, body: init.body });
				return new Response(JSON.stringify({ data: { id: NEW_ID } }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			},
			allowedEntityTypes: ['strength-item', 'expertise-item']
		});
		assert.equal(client.allowsEntityType('strength-item'), true);
		assert.equal(client.allowsEntityType('quote-item'), false);
		await assert.rejects(() => client.createEntity('quote-item', {}), /not an allowed entity/u);

		await client.createEntity('strength-item', { title: 'Sector depth' });
		assert.equal(seen.length, 1, 'the refused call never reached the network');
		assert.equal(
			seen[0].url,
			'https://apex.internal/api/platform/v1/content_library/entity_types/strength-item/entities',
			'the SAME endpoint updateEntityFields patches, not entity_models'
		);
		assert.equal(seen[0].method, 'POST');
		assert.deepEqual(JSON.parse(seen[0].body), { fields_data: { title: 'Sector depth' } });
	});

	it('a type that could carry a path is refused before it is interpolated', async () => {
		const client = createApexAdminClient({
			baseUrl: 'https://apex.internal',
			token: 't',
			fetchImpl,
			// Even NAMED, a ref that is not ref-shaped is refused: the allowlist is the
			// site's decision, `assertEntityTypeRef` is the transport's.
			allowedEntityTypes: ['../../etc/passwd']
		});
		await assert.rejects(() => client.createEntity('../../etc/passwd', {}), /invalid entity type/u);
	});
});

describe('the create-entity operation', () => {
	it('creates, and answers {ok, entityId} at the TOP LEVEL', async () => {
		const apex = recordingApex();
		const response = await create(ctxWith(apex), { title: 'Sector depth' });
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { ok: true, entityId: NEW_ID });
		assert.deepEqual(apex.stored.created, {
			entityType: ENTITY_TYPE,
			fieldsData: { title: 'Sector depth' }
		});
	});

	it('answers 404 for a type this site does not mint, and never calls Apex', async () => {
		// The sibling property, at the operation: on Godrej and GLC every type takes
		// this branch, so the route is inert wherever it is mounted without a list.
		const apex = recordingApex({ allowed: [] });
		const response = await create(ctxWith(apex), { title: 'x' }, 'author');
		assert.equal(response.status, 404);
		assert.equal(apex.stored.created, null);
	});

	it('refuses a type that is not entity-type-shaped with a 400', async () => {
		const apex = recordingApex();
		const ctx = ctxWith(apex);
		const session = await signIn(ctx);
		const response = await handleCreateEntity(
			signedRequest(session, { title: 'x' }, 'x'),
			ctx,
			// The PARAMETER is what the route hands over; a router that does not decode
			// the way this one expects must not reach the client.
			{ entityType: '../../etc/passwd' }
		);
		assert.equal(response.status, 400);
		assert.equal(apex.stored.created, null);
	});

	it('refuses an unknown TOP-LEVEL key and a field name that is not field-shaped', async () => {
		// `.strict()` plus `fieldNameSchema`. The `entities` controller drops unknown
		// keys silently, so without this a caller could believe a typo was stored.
		const apex = recordingApex();
		const ctx = ctxWith(apex);
		const session = await signIn(ctx);
		const withExtra = new Request(`${ORIGIN}/api/admin/entities/${ENTITY_TYPE}`, {
			method: 'POST',
			headers: {
				origin: ORIGIN,
				'sec-fetch-site': 'same-origin',
				'x-csrf-token': CSRF,
				'content-type': 'application/json',
				cookie: `apex_admin_session=${session}; apex_bff_csrf=${CSRF}`
			},
			body: JSON.stringify({ fields_data: { title: 'x' }, position: 3 })
		});
		assert.equal(
			(await handleCreateEntity(withExtra, ctx, { entityType: ENTITY_TYPE })).status,
			400
		);

		const badName = await create(ctxWith(apex), { 'Title Case': 'x' });
		assert.equal(badName.status, 400);
		assert.equal(apex.stored.created, null);
	});

	it('SANITIZES every value on the way through — the same judge as every other write', async () => {
		const apex = recordingApex();
		await create(ctxWith(apex), {
			title: '<p>ok</p><script>alert(1)</script>',
			body: { editor: 'quilljs', html: '<a href="javascript:alert(1)">x</a>', content: {} },
			rows: [{ html: '<img src="x" onerror=alert(1)>' }]
		});
		assert.deepEqual(apex.stored.created.fieldsData, {
			title: '<p>ok</p>',
			body: { editor: 'quilljs', html: '<a>x</a>', content: {} },
			rows: [{ html: '<img src="x">' }]
		});
		assert.doesNotMatch(JSON.stringify(apex.stored.created), /script|onerror/iu);
	});

	it('carries the per-field ceiling and the unreadable-URL refusal', async () => {
		const apex = recordingApex();
		const tooLarge = await create(ctxWith(apex), {
			title: 'x'.repeat(MAX_FIELD_VALUE_CHARS + 1)
		});
		assert.equal(tooLarge.status, 400);
		assert.equal(apex.stored.created, null, 'nothing reached Apex');

		const unreadable = await create(ctxWith(apex), {
			body: '<a href="&#00000000106;avascript:alert(1)">x</a>'
		});
		assert.equal(unreadable.status, 400);
		assert.equal(apex.stored.created, null);
	});

	it('refuses a review-only field, on a CREATE as on a patch', async () => {
		const apex = recordingApex();
		const response = await create(ctxWith(apex), { transcript_reviewed: true });
		assert.equal(response.status, 400);
		assert.equal(apex.stored.created, null);
	});

	it('forwards a 4xx, flattens a 5xx, and refuses a 200 with no id', async () => {
		const refused = recordingApex({ status: 422, body: { errors: ['Title is required'] } });
		assert.equal((await create(ctxWith(refused), { title: '' })).status, 422);

		const broken = recordingApex({ status: 500, body: {} });
		assert.equal((await create(ctxWith(broken), { title: 'x' })).status, 502);

		// A 200 with no id would leave an orphan behind while looking like a success:
		// the caller writes nothing into the parent's array and never learns why.
		const idless = recordingApex({ status: 200, body: { data: {} } });
		const response = await create(ctxWith(idless), { title: 'x' });
		assert.equal(response.status, 502);
		assert.equal((await response.json()).error, 'unexpected upstream shape');
	});

	/**
	 * THE AUDIT ROW MAY NOT CONTRADICT THE RESPONSE.
	 *
	 * The row was written FIRST, `accepted` on any 2xx, and the idless body was
	 * rejected afterwards — so the log recorded an acceptance for a request that was
	 * answered 502, and said nothing about the entity that 2xx had probably created
	 * and this handler could no longer name. And "nonempty string" was the whole id
	 * check, so `{"id": "yes"}` was accepted outright and handed to a caller that
	 * would put it in a parent's `array_ref` (codex's P5 fix review, 2026-09-08).
	 *
	 * MUTATIONS: audit `apexResponse.ok ? 'accepted' : 'apex_error'` again — the
	 * first two cases fail; drop `ENTITY_UUID.test(returnedId)` — the third fails.
	 */
	it('a 2xx this handler cannot NAME is audited `upstream_shape_error`, never accepted', async () => {
		async function rows(db) {
			return db.sqlite
				.prepare('SELECT outcome, detail FROM bff_audit_log ORDER BY occurred_at, rowid')
				.all()
				.map((row) => ({ ...row, detail: JSON.parse(row.detail) }));
		}

		const missingDb = await createMigratedDatabase();
		const missing = await create(
			ctxWith(recordingApex({ status: 200, body: { data: {} } }), missingDb),
			{ title: 'x' }
		);
		assert.equal(missing.status, 502);
		const [missingRow] = await rows(missingDb);
		assert.equal(missingRow.outcome, 'upstream_shape_error');
		assert.equal(missingRow.detail.reason, 'missing-entity-id');
		assert.equal(missingRow.detail.entityId, null);
		assert.equal(missingRow.detail.returnedId, null);
		missingDb.close();

		// A non-uuid id is a shape this operation does not understand, and passing it
		// on would put a value in a parent's array that Apex's validator refuses —
		// after the child already exists.
		const junkDb = await createMigratedDatabase();
		const junk = await create(
			ctxWith(recordingApex({ status: 200, body: { data: { id: 'yes' } } }), junkDb),
			{ title: 'x' }
		);
		assert.equal(junk.status, 502);
		assert.equal((await junk.json()).error, 'unexpected upstream shape');
		const [junkRow] = await rows(junkDb);
		assert.equal(junkRow.outcome, 'upstream_shape_error');
		assert.equal(junkRow.detail.reason, 'malformed-entity-id');
		assert.equal(junkRow.detail.returnedId, 'yes', 'the handle on the row nothing can name');
		junkDb.close();

		// The control: a real uuid is accepted, and audited as accepted.
		const goodDb = await createMigratedDatabase();
		const good = await create(ctxWith(recordingApex(), goodDb), { title: 'x' });
		assert.equal(good.status, 200);
		assert.equal((await good.json()).entityId, NEW_ID);
		const [goodRow] = await rows(goodDb);
		assert.equal(goodRow.outcome, 'accepted');
		assert.equal(goodRow.detail.entityId, NEW_ID);
		assert.equal(goodRow.detail.reason, undefined);
		goodDb.close();
	});

	it('an unauthenticated attempt buys no D1 row; a real session that fails the boundary does', async () => {
		const db = await createMigratedDatabase();
		try {
			const ctx = ctxWith(recordingApex(), db);
			const anonymous = new Request(`${ORIGIN}/api/admin/entities/${ENTITY_TYPE}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ fields_data: { title: 'x' } })
			});
			assert.equal(
				(await handleCreateEntity(anonymous, ctx, { entityType: ENTITY_TYPE })).status,
				403
			);
			const { results: none } = await db.prepare('SELECT * FROM bff_audit_log').bind().all();
			assert.deepEqual(none, [], 'write amplification an attacker controls');

			const session = await signIn(ctx);
			const forged = new Request(`${ORIGIN}/api/admin/entities/${ENTITY_TYPE}`, {
				method: 'POST',
				headers: {
					origin: ORIGIN,
					'sec-fetch-site': 'same-origin',
					'x-csrf-token': 'not-the-cookie',
					'content-type': 'application/json',
					cookie: `apex_admin_session=${session}; apex_bff_csrf=${CSRF}`
				},
				body: JSON.stringify({ fields_data: { title: 'x' } })
			});
			assert.equal(
				(await handleCreateEntity(forged, ctx, { entityType: ENTITY_TYPE })).status,
				403
			);
			const { results } = await db.prepare('SELECT * FROM bff_audit_log').bind().all();
			assert.equal(results.length, 1);
			assert.equal(results[0].actor_email, 'e@site.test');
			assert.equal(results[0].path, '/api/admin/entities/[entityType]');
		} finally {
			db.close();
		}
	});

	it('audits an accepted create with the new id, against the route TEMPLATE', async () => {
		const db = await createMigratedDatabase();
		try {
			const apex = recordingApex();
			await create(ctxWith(apex, db), { title: 'Sector depth' });
			const { results } = await db.prepare('SELECT * FROM bff_audit_log').bind().all();
			assert.equal(results.length, 1);
			assert.equal(results[0].outcome, 'accepted');
			assert.equal(results[0].path, '/api/admin/entities/[entityType]');
			const detail = JSON.parse(results[0].detail);
			assert.equal(detail.entityType, ENTITY_TYPE);
			assert.equal(detail.entityId, NEW_ID);
			assert.deepEqual(detail.fields, ['title']);
		} finally {
			db.close();
		}
	});
});
