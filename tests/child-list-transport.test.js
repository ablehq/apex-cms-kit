// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	childListFieldNames,
	isArrayShapedKind,
	splitChildListFields
} from '../src/server/bff/operations/child-list.ts';
import { unbackedPrimitiveKeys, readPrimitiveItemId } from '../src/server/bff/archetype-record.ts';
import { handleUpdateRecord } from '../src/server/bff/operations/update-record.ts';
import { handleCreateRecord } from '../src/server/bff/operations/create-record.ts';
import { handleUpdatePostArchetype } from '../src/server/bff/operations/update-post-archetype.ts';
import { handleCreatePost } from '../src/server/bff/operations/create-post.ts';
import { ApexTransportError, createApexAdminClient } from '../src/server/bff/apex-admin-client.ts';
import { createSessionSecret, sessionIdFor } from '../src/server/bff/session.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { createMemorySessionStore } from './harness/session-store.ts';
import { createMigratedDatabase } from './harness/d1.ts';

/**
 * P3: THE CHILD-LIST TRANSPORT, THE FLAT-SURFACE REFUSAL, AND THE PARTIAL-WRITE
 * GUARD — the three mechanics that stop a record save from destroying the record.
 *
 * Every assertion here is anchored to something measured against local Apex on
 * 2026-09-07, re-read raw after each write:
 *
 *   - a flat PATCH carrying `{expertise_items: [a, b]}` answers **200** and stores
 *     **`[]`**, and mints the item row holding that `[]`;
 *   - a PATCH of that row through `…/schema_item/expertise_items/items/:itemId`
 *     stores `[a, b]`, in order, with every sibling field untouched;
 *   - a SECOND POST for the same field answers **422** (Primitive schema items are
 *     forced `has_one`);
 *   - a PATCH naming an id that is not an entity of the field's type answers
 *     **500**, while the same mistake on the CREATE leg answers a 422 naming the
 *     field;
 *   - a record with `primitives` and ZERO items loses every unsent field on the
 *     next write, because `primitives` is rebuilt from the items that exist.
 *
 * `fakeApex` below MODELS APEX, not the kit's client: its flat write stores `[]`
 * for an array exactly as Apex does, and it rebuilds `primitives` from its items
 * on every write exactly as `on_primitive_changed` does. That is what makes the
 * whole-record comparison a real gate — a routing regression shows up here as an
 * ERASED LIST, which is the failure this phase exists to prevent, rather than as a
 * thrown error the stub invented.
 */

const ORIGIN = 'https://site.test';
const CSRF = 'csrf-child-list';
const RECORD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CHILD_A = '11111111-1111-4111-8111-111111111111';
const CHILD_B = '22222222-2222-4222-8222-222222222222';
const CHILD_C = '33333333-3333-4333-8333-333333333333';

/** A schema with two scalars, two child lists and one reference. */
function fieldDef(field_name, validator_kind) {
	return {
		field_name,
		display_name: field_name,
		validator_kind,
		text_inclusion: null,
		is_required: false,
		place_holder: null,
		default_value: null
	};
}

const TEAM_MEMBER_FIELDS = [
	fieldDef('name', null),
	fieldDef('biography', 'rich_text'),
	fieldDef('expertise_items', 'array_ref/entity-type/expertise-text-item'),
	fieldDef('highlights', 'array_ref/entity-type/text-item'),
	fieldDef('tag_names', 'text_array'),
	fieldDef('scores', 'number_array')
];

const contract = {
	schema: (slug) =>
		slug === 'team_member' || slug === 'article'
			? {
					slug,
					display_name: slug,
					target_model: slug === 'article' ? 'Cms::Post' : null,
					id: null,
					items: []
				}
			: null,
	isContentLibrarySlug: (slug) => slug === 'team_member',
	primitiveFieldDefs: (slug) => {
		if (slug === 'team_member') return TEAM_MEMBER_FIELDS;
		// A POST schema that declares an array-shaped field. No site has one today;
		// the next one that does must not find out in production.
		if (slug === 'article') return [fieldDef('kind', null), fieldDef('tag_names', 'text_array')];
		return [];
	},
	referenceItems: () => [],
	referrersTo: () => ({ countable: [], uncounted: [] })
};

/**
 * An Apex that behaves the way the measured one behaves.
 *
 * `primitives` is DERIVED from the items on every read, never stored — the same
 * relationship `Archetype#on_primitive_changed` has with `archetype_items`. So a
 * field with no item simply is not in `primitives`, and a field routed to the flat
 * surface as an array lands as `[]`, which is the silent loss.
 *
 * ── PROVISIONAL: THIS DOUBLE MODELS THE OLD FLAT SURFACE ─────────────────────
 * "an array answers 200 and stores `[]`" in `updateContentLibraryRecord` below is a
 * CAPABILITY of the backend production runs, not a permanent contract. Plan 08
 * makes `archetype_models` permit list-shaped fields; when that is DEPLOYED and
 * VERIFIED this double stops being a description of anything, and it is deleted
 * with the transport it exists to test — the single reviewed kit change plan 07's
 * **P3b** node inventories. The local backend this repo is developed against has
 * ALREADY moved; `poovayya/tests/apex-array-capability-realapex.test.ts` is what
 * records which build is actually running. Do not "fix" this double to match it:
 * until the transition lands, the old behaviour is the one the kit must survive.
 */
function fakeApex({ items = [], unbackedPrimitives = null, failItemWrite = null } = {}) {
	const calls = [];
	const rows = items.map((item) => ({ ...item }));

	function record() {
		const primitives = {};
		for (const row of rows) Object.assign(primitives, row.fields_data);
		return {
			id: RECORD_ID,
			updated_at: '2026-09-07T00:00:00Z',
			position: 3,
			// A record whose `primitives` were written DIRECTLY carries keys no item
			// accounts for. That is the state the guard is about, and it cannot be
			// reached by writing — only by having been seeded that way.
			primitives: unbackedPrimitives ? { ...unbackedPrimitives, ...primitives } : primitives,
			archetype_items: rows.map((row) => ({
				id: row.id,
				relatable_type: 'PropertySet',
				archetype_schema_item: { name: row.field, slug: row.field },
				fields_data: row.fields_data
			}))
		};
	}

	return {
		calls,
		record,
		async getContentLibraryRecord() {
			return { status: 200, ok: true, body: { data: record() } };
		},
		async updateContentLibraryRecord(slug, id, fields, references, position) {
			calls.push({ kind: 'flat', slug, id, fields, references, position });
			for (const [name, value] of Object.entries(fields)) {
				// THE MEASURED FLAT SURFACE: an array answers 200 and stores `[]`.
				const stored = Array.isArray(value) ? [] : value;
				const existing = rows.find((row) => row.field === name);
				if (existing) existing.fields_data = { [name]: stored };
				else rows.push({ id: `item-${name}`, field: name, fields_data: { [name]: stored } });
			}
			return { status: 200, ok: true, body: { data: record() } };
		},
		async createArchetypeItem(slug, archetypeId, fieldName, fieldsData) {
			calls.push({ kind: 'item-create', slug, archetypeId, fieldName, fieldsData });
			if (failItemWrite === fieldName) return { status: 422, ok: false, body: null };
			if (rows.some((row) => row.field === fieldName)) {
				// A second row for a `has_one` schema item is a 422 upstream.
				return { status: 422, ok: false, body: null };
			}
			rows.push({ id: `item-${fieldName}`, field: fieldName, fields_data: fieldsData });
			return { status: 200, ok: true, body: { data: {} } };
		},
		async updateArchetypeItem(slug, archetypeId, fieldName, itemId, fieldsData) {
			calls.push({ kind: 'item-update', slug, archetypeId, fieldName, itemId, fieldsData });
			if (failItemWrite === fieldName) return { status: 500, ok: false, body: null };
			const row = rows.find((entry) => entry.id === itemId);
			if (!row) return { status: 404, ok: false, body: null };
			row.fields_data = fieldsData;
			return { status: 200, ok: true, body: { data: {} } };
		},
		async createContentLibraryRecord(slug, fields) {
			calls.push({ kind: 'create', slug, fields });
			return { status: 201, ok: true, body: { data: { id: RECORD_ID } } };
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
		contract
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

function patch(session, body) {
	return new Request(`${ORIGIN}/api/admin/records/team_member/${RECORD_ID}`, {
		method: 'PATCH',
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

async function update(ctx, body) {
	return handleUpdateRecord(patch(await signIn(ctx), body), ctx, {
		schema: 'team_member',
		recordId: RECORD_ID
	});
}

/** A record with every field backed by an item — the state an API create leaves. */
function backedItems() {
	return [
		{ id: '44444444-4444-4444-8444-444444444444', field: 'name', fields_data: { name: 'Asha' } },
		{
			id: '55555555-5555-4555-8555-555555555555',
			field: 'biography',
			fields_data: { biography: { html: '<p>bio</p>' } }
		},
		{
			id: '66666666-6666-4666-8666-666666666666',
			field: 'expertise_items',
			fields_data: { expertise_items: [CHILD_A] }
		},
		{
			id: '77777777-7777-4777-8777-777777777777',
			field: 'highlights',
			fields_data: { highlights: [CHILD_C] }
		}
	];
}

describe('which fields are array-shaped, and why the kind decides it', () => {
	it('routes all three array kinds, not only `array_ref`', () => {
		// `text_array` and `number_array` are emptied by the flat surface identically.
		// Keying on the `array_ref` prefix alone would leave those two on the path.
		assert.equal(isArrayShapedKind('array_ref/entity-type/quote-item'), true);
		assert.equal(isArrayShapedKind('text_array'), true);
		assert.equal(isArrayShapedKind('number_array'), true);
	});

	it('leaves every scalar kind — including a single `ref/` — on the flat surface', () => {
		for (const kind of [
			null,
			undefined,
			'',
			'text',
			'multiline_text',
			'rich_text',
			'numeric',
			'date'
		])
			assert.equal(isArrayShapedKind(kind), false, String(kind));
		// `ref/entity-type/x` is a single id, which the flat surface DOES persist.
		assert.equal(isArrayShapedKind('ref/entity-type/expertise-text-item'), false);
		assert.equal(isArrayShapedKind(42), false);
	});

	it('names the schema’s child lists in contract order', () => {
		assert.deepEqual(childListFieldNames(contract, 'team_member'), [
			'expertise_items',
			'highlights',
			'tag_names',
			'scores'
		]);
		assert.deepEqual(childListFieldNames(contract, 'unknown'), []);
	});

	it('splits by the field’s KIND, so an empty list is still routed', () => {
		const { flat, childLists } = splitChildListFields(contract, 'team_member', {
			name: 'Asha',
			expertise_items: [CHILD_A, CHILD_B],
			// The legitimate "clear the list". Routed, not sent flat — sent flat it
			// would look identical and be indistinguishable from the loss.
			highlights: []
		});
		assert.deepEqual(flat, { name: 'Asha' });
		assert.deepEqual(childLists, [
			{ field: 'expertise_items', value: [CHILD_A, CHILD_B] },
			{ field: 'highlights', value: [] }
		]);
	});
});

describe('unbackedPrimitiveKeys — what a partial write would destroy', () => {
	it('names every primitives key with no item behind it', () => {
		const record = {
			primitives: { name: 'Asha', designation: 'Partner', email: 'a@b.test' },
			archetype_items: []
		};
		assert.deepEqual(unbackedPrimitiveKeys(record).sort(), ['designation', 'email', 'name']);
	});

	it('is empty when every key has a row — the state every API create leaves', () => {
		const record = {
			primitives: { name: 'Asha', designation: 'Partner' },
			archetype_items: [
				{
					id: 'i1',
					relatable_type: 'PropertySet',
					archetype_schema_item: { slug: 'name' },
					fields_data: { name: 'Asha' }
				},
				{
					id: 'i2',
					relatable_type: 'PropertySet',
					archetype_schema_item: { slug: 'designation' },
					fields_data: { designation: 'Partner' }
				}
			]
		};
		assert.deepEqual(unbackedPrimitiveKeys(record), []);
	});

	it('does not count a REFERENCE row as covering a primitive', () => {
		// A reference item carries `fields_data` too, under the item's own name — but
		// `on_primitive_changed` only walks PRIMITIVE items, so a reference row
		// rebuilds nothing and must not be read as coverage.
		const record = {
			primitives: { practice_areas: 'x' },
			archetype_items: [
				{
					id: 'i1',
					relatable_type: 'Specification::Archetype',
					archetype_schema_item: { slug: 'practice_areas' },
					fields_data: { practice_areas: 'target-id' }
				}
			]
		};
		assert.deepEqual(unbackedPrimitiveKeys(record), ['practice_areas']);
	});

	it('a record with no primitives at all has nothing to lose', () => {
		assert.deepEqual(unbackedPrimitiveKeys({ primitives: {}, archetype_items: [] }), []);
		assert.deepEqual(unbackedPrimitiveKeys({}), []);
	});

	it('finds the PRIMITIVE row that holds one field, and only that one', () => {
		const record = {
			archetype_items: [
				{
					id: 'ref-row',
					relatable_type: 'Specification::Archetype',
					archetype_schema_item: { slug: 'expertise_items' },
					fields_data: { expertise_items: 'not-an-item-row' }
				},
				{
					id: 'prim-row',
					relatable_type: 'PropertySet',
					archetype_schema_item: { slug: 'expertise_items' },
					fields_data: { expertise_items: [CHILD_A] }
				}
			]
		};
		assert.equal(readPrimitiveItemId(record, 'expertise_items'), 'prim-row');
		assert.equal(readPrimitiveItemId(record, 'nothing'), null);
	});
});

describe('the flat archetype_models surface REFUSES an array, in the client', () => {
	function client(
		onFetch = async () => new Response('{}', { headers: { 'content-type': 'application/json' } })
	) {
		return createApexAdminClient({
			baseUrl: 'https://apex.test',
			token: 'tok',
			allowedSchemaSlugs: ['team_member'],
			allowedPostSlugs: ['article'],
			fetchImpl: onFetch
		});
	}

	it('throws on an array field rather than writing one — on update AND create', async () => {
		let called = 0;
		const apex = client(async () => {
			called += 1;
			return new Response('{}', { headers: { 'content-type': 'application/json' } });
		});
		await assert.rejects(
			() =>
				apex.updateContentLibraryRecord('team_member', RECORD_ID, { expertise_items: [CHILD_A] }),
			/array on the flat archetype_models surface: expertise_items/
		);
		await assert.rejects(
			() => apex.createContentLibraryRecord('team_member', { tag_names: ['a'] }),
			/array on the flat archetype_models surface: tag_names/
		);
		assert.equal(called, 0, 'nothing reached Apex');
	});

	it('checks EVERY key, not just the first — a scalar first field is not a pass', async () => {
		let called = 0;
		const apex = client(async () => {
			called += 1;
			return new Response('{}', { headers: { 'content-type': 'application/json' } });
		});
		await assert.rejects(
			() =>
				apex.updateContentLibraryRecord('team_member', RECORD_ID, {
					name: 'Asha',
					biography: { html: '<p>x</p>' },
					expertise_items: [CHILD_A]
				}),
			/array on the flat archetype_models surface: expertise_items/
		);
		assert.equal(called, 0);
	});

	it('refuses on the POST archetype surface too — it is the same endpoint', async () => {
		const apex = client();
		await assert.rejects(
			() => apex.updatePostArchetype('article', RECORD_ID, { tag_names: ['a'] }),
			/array on the flat archetype_models surface/
		);
		await assert.rejects(
			() => apex.createPost('article', { title: 't' }, { tag_names: ['a'] }),
			/array on the flat archetype_models surface/
		);
	});

	it('leaves REFERENCE arrays alone — they are a different parameter', async () => {
		const bodies = [];
		const apex = client(async (_url, init) => {
			bodies.push(JSON.parse(init.body));
			return new Response('{}', { headers: { 'content-type': 'application/json' } });
		});
		await apex.updateContentLibraryRecord(
			'team_member',
			RECORD_ID,
			{ name: 'Asha' },
			{ practice_areas: [{ practice_areas: CHILD_A }, { item_id: CHILD_B, _destroy: true }] }
		);
		assert.equal(bodies.length, 1);
		assert.equal(bodies[0].practice_areas.length, 2, 'the has_many diff still travels');
	});
});

describe('the items endpoint — the surface that actually stores a list', () => {
	function recording() {
		const sent = [];
		const apex = createApexAdminClient({
			baseUrl: 'https://apex.test',
			token: 'tok',
			allowedSchemaSlugs: ['team_member'],
			fetchImpl: async (url, init) => {
				sent.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
				return new Response('{}', { headers: { 'content-type': 'application/json' } });
			}
		});
		return { apex, sent };
	}

	it('POSTs to the schema_item route with `fields_data`, keyed by ARCHETYPE id', async () => {
		const { apex, sent } = recording();
		await apex.createArchetypeItem('team_member', RECORD_ID, 'expertise_items', {
			expertise_items: [CHILD_A]
		});
		assert.equal(
			sent[0].url,
			`https://apex.test/api/platform/v1/specification/archetypes/${RECORD_ID}/schema_item/expertise_items/items`
		);
		assert.equal(sent[0].method, 'POST');
		assert.deepEqual(sent[0].body, { fields_data: { expertise_items: [CHILD_A] } });
	});

	it('PATCHes the EXISTING row by its item id, and its BODY is the envelope', async () => {
		const { apex, sent } = recording();
		await apex.updateArchetypeItem('team_member', RECORD_ID, 'expertise_items', CHILD_B, {
			expertise_items: [CHILD_A]
		});
		assert.equal(
			sent[0].url,
			`https://apex.test/api/platform/v1/specification/archetypes/${RECORD_ID}/schema_item/expertise_items/items/${CHILD_B}`
		);
		assert.equal(sent[0].method, 'PATCH');
		// The BODY, asserted whole. `fields_data` is not decoration: the controller
		// branches on `permitted_params[:fields_data].blank?` and, when it is blank,
		// updates the item's own columns instead — so an empty map, or the same keys
		// spread at the root, is a SILENT NO-OP on the list. This is the common leg
		// (POST happens once per field, ever), and it was the one going unasserted.
		assert.deepEqual(sent[0].body, { fields_data: { expertise_items: [CHILD_A] } });
	});

	it('sends `position` only when asked, so an unpassed one cannot reorder the row', async () => {
		const { apex, sent } = recording();
		await apex.createArchetypeItem('team_member', RECORD_ID, 'expertise_items', {}, 4);
		assert.equal(sent[0].body.position, 4);
		await apex.createArchetypeItem('team_member', RECORD_ID, 'expertise_items', {});
		assert.equal('position' in sent[1].body, false);
	});

	it('still narrows to the allowlist, on a route that carries no schema slug', async () => {
		// The items route is addressed by ARCHETYPE id. Without the check a
		// content-library client could write items on a post archetype.
		const { apex } = recording();
		await assert.rejects(
			() => apex.createArchetypeItem('article', RECORD_ID, 'x', {}),
			/not a content-library archetype schema/
		);
		await assert.rejects(
			() => apex.updateArchetypeItem('article', RECORD_ID, 'x', CHILD_A, {}),
			/not a content-library archetype schema/
		);
	});

	it('refuses a field name that is not a field name, and a bad id', async () => {
		const { apex } = recording();
		await assert.rejects(
			() => apex.createArchetypeItem('team_member', RECORD_ID, '../../pages', {}),
			/invalid schema item slug/
		);
		await assert.rejects(
			() => apex.createArchetypeItem('team_member', 'not-a-uuid', 'expertise_items', {}),
			/invalid uuid/
		);
		await assert.rejects(
			() => apex.updateArchetypeItem('team_member', RECORD_ID, 'expertise_items', 'nope', {}),
			/invalid uuid/
		);
	});
});

describe('PATCH /records/:schema/:id — the partial-write guard', () => {
	it('REFUSES a field write to a record whose primitives have no rows, and writes nothing', async () => {
		const apex = fakeApex({
			items: [],
			unbackedPrimitives: { name: 'Asha', biography: { html: '<p>bio</p>' } }
		});
		const ctx = ctxWith(apex);
		const response = await update(ctx, { fields: { name: 'Asha Rao' } });
		assert.equal(response.status, 409);
		const body = await response.json();
		assert.equal(body.error, 'unbacked-record');
		// The names, so a backfill knows what it is repairing.
		assert.deepEqual(body.unbackedFields.sort(), ['biography', 'name']);
		assert.equal(apex.calls.length, 0, 'no write of any kind was attempted');
	});

	it('allows the same write once every key has a row', async () => {
		const apex = fakeApex({ items: backedItems() });
		const ctx = ctxWith(apex);
		const response = await update(ctx, { fields: { name: 'Asha Rao' } });
		assert.equal(response.status, 200, await response.clone().text());
		assert.equal(apex.record().primitives.name, 'Asha Rao');
		// And the fields it did not carry are all still there.
		assert.deepEqual(apex.record().primitives.expertise_items, [CHILD_A]);
	});

	it('does not stand in the way of a reorder — `position` rebuilds nothing', async () => {
		// A position-only patch touches a COLUMN, not an item, so it triggers no
		// primitives rebuild and is safe on a record the guard would otherwise refuse.
		const apex = fakeApex({ items: [], unbackedPrimitives: { name: 'Asha' } });
		const ctx = ctxWith(apex);
		const response = await update(ctx, { position: 9 });
		assert.equal(response.status, 200, await response.clone().text());
		assert.equal(apex.calls[0].kind, 'flat');
		assert.equal(apex.calls[0].position, 9);
	});
});

describe('PATCH /records/:schema/:id — a child list is written, and nothing else moves', () => {
	/**
	 * THE §4.1b GATE. A happy path that only asserts the list it wrote would pass
	 * while a sibling list or a scalar was erased — which is exactly what the flat
	 * surface does. So this compares the WHOLE record, before and after, and permits
	 * one key to differ.
	 */
	it('writes one list through the items endpoint and leaves every other field byte-identical', async () => {
		const apex = fakeApex({ items: backedItems() });
		const before = apex.record();
		const ctx = ctxWith(apex);

		const response = await update(ctx, { fields: { expertise_items: [CHILD_A, CHILD_B] } });
		assert.equal(response.status, 200, await response.clone().text());

		const after = apex.record();
		assert.deepEqual(after.primitives.expertise_items, [CHILD_A, CHILD_B], 'the list was stored');

		for (const key of Object.keys(before.primitives)) {
			if (key === 'expertise_items') continue;
			assert.deepEqual(after.primitives[key], before.primitives[key], `${key} must not have moved`);
		}
		assert.deepEqual(
			Object.keys(after.primitives).sort(),
			Object.keys(before.primitives).sort(),
			'no field appeared or disappeared'
		);
		// Named explicitly: the sibling list is the one this phase exists to protect.
		assert.deepEqual(after.primitives.highlights, [CHILD_C], 'the sibling list survived');
	});

	it('never puts an array on the flat surface — the flat write carries only scalars', async () => {
		const apex = fakeApex({ items: backedItems() });
		const ctx = ctxWith(apex);
		await update(ctx, {
			fields: { name: 'Asha Rao', expertise_items: [CHILD_B], highlights: [] }
		});
		const flat = apex.calls.find((call) => call.kind === 'flat');
		assert.deepEqual(flat.fields, { name: 'Asha Rao' });
		for (const value of Object.values(flat.fields)) assert.equal(Array.isArray(value), false);
		assert.deepEqual(apex.record().primitives.highlights, [], 'the clear was a real clear');
		assert.deepEqual(apex.record().primitives.expertise_items, [CHILD_B]);
	});

	it('PATCHes the existing row, and POSTs only where there is none', async () => {
		const apex = fakeApex({ items: backedItems() });
		const ctx = ctxWith(apex);
		await update(ctx, { fields: { expertise_items: [CHILD_B], tag_names: ['a', 'b'] } });
		const item = apex.calls.filter((call) => call.kind.startsWith('item-'));
		assert.deepEqual(
			item.map((call) => [call.kind, call.fieldName]),
			[
				// `expertise_items` has a row: PATCH it. A second POST would be a 422 —
				// a Primitive schema item is forced `has_one`.
				['item-update', 'expertise_items'],
				['item-create', 'tag_names']
			]
		);
		assert.equal(item[0].itemId, '66666666-6666-4666-8666-666666666666');
	});

	it('a reorder is the same array in a different order, and it lands in order', async () => {
		const apex = fakeApex({
			items: [
				...backedItems().filter((row) => row.field !== 'expertise_items'),
				{
					id: '66666666-6666-4666-8666-666666666666',
					field: 'expertise_items',
					fields_data: { expertise_items: [CHILD_A, CHILD_B] }
				}
			]
		});
		const ctx = ctxWith(apex);
		await update(ctx, { fields: { expertise_items: [CHILD_B, CHILD_A] } });
		assert.deepEqual(apex.record().primitives.expertise_items, [CHILD_B, CHILD_A]);
	});

	it('refuses an array on a field that does not hold one, before the client can throw', async () => {
		const apex = fakeApex({ items: backedItems() });
		const ctx = ctxWith(apex);
		const response = await update(ctx, { fields: { name: ['not', 'a', 'list'] } });
		assert.equal(response.status, 400);
		assert.equal(apex.calls.length, 0, 'nothing was read or written');
	});

	it('refuses a child list whose entries are not entity ids', async () => {
		const apex = fakeApex({ items: backedItems() });
		const ctx = ctxWith(apex);
		assert.equal((await update(ctx, { fields: { expertise_items: ['nope'] } })).status, 400);
		assert.equal((await update(ctx, { fields: { expertise_items: 'a-string' } })).status, 400);
		assert.equal(apex.calls.length, 0);
	});
});

describe('PATCH /records/:schema/:id — a child-list failure is named, not flattened', () => {
	it('reports the FIELD and the upstream status instead of "upstream error"', async () => {
		// Upstream answers a bare 500 for an id that is not an entity of the field's
		// type, because the update leg's validation guard is inverted. Flattening that
		// to 502 "upstream error" tells an editor the server is broken.
		const apex = fakeApex({ items: backedItems(), failItemWrite: 'expertise_items' });
		const ctx = ctxWith(apex);
		const response = await update(ctx, { fields: { expertise_items: [CHILD_B] } });
		assert.equal(response.status, 502);
		const body = await response.json();
		assert.equal(body.error, 'child-list-write-failed');
		assert.equal(body.field, 'expertise_items');
		// `upstreamStatus`, NOT `status`: the browser client spreads the body over its
		// own result, so a body key called `status` would replace the real HTTP 502
		// with the 500 that caused it.
		assert.equal(body.upstreamStatus, 500);
		assert.equal('status' in body, false, 'the body must not shadow the HTTP status');
		assert.deepEqual(body.written, []);
	});

	it('names the lists that DID land — the flat write is already committed', async () => {
		const apex = fakeApex({ items: backedItems(), failItemWrite: 'highlights' });
		const ctx = ctxWith(apex);
		const response = await update(ctx, {
			fields: { name: 'Asha Rao', expertise_items: [CHILD_B], highlights: [CHILD_A] }
		});
		assert.equal(response.status, 502);
		const body = await response.json();
		assert.deepEqual(body.written, ['expertise_items'], 'the caller is told what landed');
		assert.equal(body.field, 'highlights');
		// And it is true: the first list and the scalar really are written.
		assert.deepEqual(apex.record().primitives.expertise_items, [CHILD_B]);
		assert.equal(apex.record().primitives.name, 'Asha Rao');
	});

	it('forwards a 4xx from the items endpoint rather than making it a 502', async () => {
		// The CREATE leg validates properly and answers 422 naming the field, so that
		// status is worth keeping.
		const apex = fakeApex({ items: backedItems(), failItemWrite: 'tag_names' });
		const ctx = ctxWith(apex);
		const response = await update(ctx, { fields: { tag_names: ['a'] } });
		assert.equal(response.status, 422);
		assert.equal((await response.json()).code, 'child-list-write-failed');
	});

	it('does not touch a list when the flat write itself was refused', async () => {
		const apex = fakeApex({ items: backedItems() });
		apex.updateContentLibraryRecord = async () => ({ status: 422, ok: false, body: null });
		const ctx = ctxWith(apex);
		const response = await update(ctx, {
			fields: { name: 'Asha Rao', expertise_items: [CHILD_B] }
		});
		assert.equal(response.status, 422);
		assert.equal(
			apex.calls.some((call) => call.kind.startsWith('item-')),
			false,
			'the lists were never reached'
		);
	});
});

describe('the guard\u2019s boundary and its partial cases', () => {
	it('refuses on ONE unbacked key as readily as on many', async () => {
		// `> 0`, not `> 1`. A fixture that only ever carries two would let the
		// off-by-one through, and one lost field is still a lost field.
		const apex = fakeApex({
			items: [
				{ id: '44444444-4444-4444-8444-444444444444', field: 'name', fields_data: { name: 'Asha' } }
			],
			unbackedPrimitives: { designation: 'Partner' }
		});
		const ctx = ctxWith(apex);
		const response = await update(ctx, { fields: { name: 'Asha Rao' } });
		assert.equal(response.status, 409);
		assert.deepEqual((await response.json()).unbackedFields, ['designation']);
		assert.equal(apex.calls.length, 0);
	});

	it('refuses a PARTIALLY backed record — one row does not vouch for the rest', async () => {
		// The dangerous middle state: a backfill that stopped, or a record one field
		// of which was written by hand. `unbackedPrimitiveKeys` must be per-KEY;
		// "does this record have any PropertySet row at all?" would call this healthy
		// and then destroy the two keys with no row.
		const apex = fakeApex({
			items: [
				{ id: '44444444-4444-4444-8444-444444444444', field: 'name', fields_data: { name: 'Asha' } }
			],
			unbackedPrimitives: { designation: 'Partner', email: 'a@b.test', alma_mater: 'NLS' }
		});
		const ctx = ctxWith(apex);
		const response = await update(ctx, { fields: { name: 'Asha Rao' } });
		assert.equal(response.status, 409);
		assert.deepEqual((await response.json()).unbackedFields.sort(), [
			'alma_mater',
			'designation',
			'email'
		]);
		assert.equal(apex.calls.length, 0, 'and it wrote nothing at all');
	});
});

describe('the audit row says what actually happened', () => {
	async function auditRows(db) {
		return db.sqlite
			.prepare('SELECT action, outcome, detail FROM bff_audit_log ORDER BY occurred_at, rowid')
			.all()
			.map((row) => ({ ...row, detail: row.detail ? JSON.parse(row.detail) : null }));
	}

	it('records which lists travelled and which landed', async () => {
		const db = await createMigratedDatabase();
		const apex = fakeApex({ items: backedItems() });
		const ctx = ctxWith(apex, db);
		assert.equal(
			(await update(ctx, { fields: { expertise_items: [CHILD_B], tag_names: ['a'] } })).status,
			200
		);
		const rows = await auditRows(db);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].outcome, 'accepted');
		assert.deepEqual(rows[0].detail.childLists, ['expertise_items', 'tag_names']);
		assert.deepEqual(rows[0].detail.childListsWritten, ['expertise_items', 'tag_names']);
		db.close();
	});

	it('a half-applied save is NEVER audited as accepted', async () => {
		// The flat write and the first list are committed and cannot be taken back,
		// so this row is the only record that the record is now in a mixed state.
		const db = await createMigratedDatabase();
		const apex = fakeApex({ items: backedItems(), failItemWrite: 'highlights' });
		const ctx = ctxWith(apex, db);
		const response = await update(ctx, {
			fields: { name: 'Asha Rao', expertise_items: [CHILD_B], highlights: [CHILD_A] }
		});
		assert.equal(response.status, 502);
		const rows = await auditRows(db);
		assert.equal(rows.length, 1, 'one row, not two');
		assert.equal(rows[0].outcome, 'apex_error');
		assert.equal(rows[0].detail.childListFailedOn, 'highlights');
		assert.equal(rows[0].detail.childListStatus, 500);
		assert.deepEqual(rows[0].detail.childListsWritten, ['expertise_items']);
		assert.deepEqual(rows[0].detail.fields.sort(), ['expertise_items', 'highlights', 'name']);
		db.close();
	});

	it('a refused unbacked write is audited as rejected, with the fields named', async () => {
		const db = await createMigratedDatabase();
		const apex = fakeApex({ items: [], unbackedPrimitives: { name: 'Asha', email: 'a@b.test' } });
		const ctx = ctxWith(apex, db);
		assert.equal((await update(ctx, { fields: { name: 'x' } })).status, 409);
		const rows = await auditRows(db);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].outcome, 'rejected');
		assert.equal(rows[0].detail.reason, 'unbacked-record');
		assert.deepEqual(rows[0].detail.unbackedFields.sort(), ['email', 'name']);
		db.close();
	});

	it('a TRANSPORT fault mid-list is audited too, and names the list it died on', async () => {
		// `call` rethrows a network fault when no abort signal was passed, and the
		// admin path passes none. Without the catch this escaped as a framework 500
		// AFTER the flat write had committed, with no audit row for any of it.
		const db = await createMigratedDatabase();
		const apex = fakeApex({ items: backedItems() });
		apex.updateArchetypeItem = async () => {
			throw new ApexTransportError(new TypeError('fetch failed'));
		};
		const ctx = ctxWith(apex, db);
		const response = await update(ctx, {
			fields: { name: 'Asha Rao', expertise_items: [CHILD_B] }
		});
		assert.equal(response.status, 502);
		const body = await response.json();
		assert.equal(body.error, 'child-list-write-failed');
		assert.equal(body.field, 'expertise_items');
		assert.equal(body.upstreamStatus, 0, '`0` is "no answer", not an HTTP refusal');
		const rows = await auditRows(db);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].outcome, 'apex_error');
		assert.equal(rows[0].detail.childListFailedOn, 'expertise_items');
		assert.equal(
			rows[0].detail.childListFault,
			'network',
			'Apex really was asked and never answered'
		);
		db.close();
	});

	it('a TRANSPORT fault on the FLAT write is audited too, rather than escaping as a 500', async () => {
		const db = await createMigratedDatabase();
		const apex = fakeApex({ items: backedItems() });
		apex.updateContentLibraryRecord = async () => {
			throw new ApexTransportError(new TypeError('fetch failed'));
		};
		const ctx = ctxWith(apex, db);
		const response = await update(ctx, { fields: { name: 'Asha Rao' } });
		assert.equal(response.status, 502);
		const rows = await auditRows(db);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].outcome, 'apex_error');
		assert.equal(rows[0].detail.apexStatus, 0);
		assert.equal(rows[0].detail.thrown, undefined, 'a network fault is not a thrown one');
		db.close();
	});

	/**
	 * ── NOT EVERY THROW IS A TRANSPORT FAULT ─────────────────────────────────
	 *
	 * `catch {}` recorded `apexStatus: 0` — "Apex never answered" — for every throw
	 * the client can make, including its OWN refusals, on which Apex was never asked
	 * anything. The audit row is the only record of a half-applied save; a fiction
	 * there is worse than no row.
	 */
	it('a NON-transport throw on the flat write surfaces with its real reason, not as apexStatus 0', async () => {
		const db = await createMigratedDatabase();
		const apex = fakeApex({ items: backedItems() });
		apex.updateContentLibraryRecord = async () => {
			// Exactly what `contentLibrarySlug` / `assertUuid` / `assertNoArrayFields`
			// do inside the real client.
			throw new Error('not a content-library archetype schema: team_member');
		};
		const ctx = ctxWith(apex, db);
		await assert.rejects(
			() => update(ctx, { fields: { name: 'Asha Rao' } }),
			/not a content-library archetype schema/u,
			'the real reason reaches the frame that can log it'
		);
		const rows = await auditRows(db);
		assert.equal(rows.length, 1, 'and the attempt is still recorded');
		assert.equal(rows[0].outcome, 'apex_error');
		assert.equal(rows[0].detail.thrown, true);
		assert.match(rows[0].detail.thrownReason, /not a content-library archetype schema/u);
		assert.equal(rows[0].detail.apexStatus, undefined, 'NOT relabelled as "no answer"');
		db.close();
	});

	it('a NON-transport throw mid-list is audited as thrown, and the half-applied save is still reported', async () => {
		// Here the flat write HAS committed, so rethrowing would tell the editor
		// nothing about a save that is now half applied. The failure is reported as
		// usual and the audit row carries which kind of failure it was.
		const db = await createMigratedDatabase();
		const apex = fakeApex({ items: backedItems() });
		apex.updateArchetypeItem = async () => {
			throw new Error('refusing off-origin Apex call');
		};
		const ctx = ctxWith(apex, db);
		const response = await update(ctx, {
			fields: { name: 'Asha Rao', expertise_items: [CHILD_B] }
		});
		assert.equal(response.status, 502);
		assert.equal((await response.json()).error, 'child-list-write-failed');
		const rows = await auditRows(db);
		assert.equal(rows[0].detail.childListFault, 'thrown', 'Apex was never asked');
		assert.match(rows[0].detail.childListReason, /off-origin/u);
		db.close();
	});

	it('the REAL client’s allowlist refusal is a throw, not a transport fault', async () => {
		// The narrowing rests on the real client actually distinguishing the two, so
		// this asserts against `createApexAdminClient` rather than the double: an
		// allowlist refusal is a plain `Error`, and only a failed fetch is wrapped.
		const client = createApexAdminClient({
			baseUrl: 'http://127.0.0.1:59999',
			token: 't',
			allowedSchemaSlugs: ['author']
		});
		await assert.rejects(
			() => client.updateContentLibraryRecord('team_member', RECORD_ID, { name: 'x' }),
			(error) => {
				assert.equal(error instanceof ApexTransportError, false);
				assert.match(error.message, /not a content-library archetype schema/u);
				return true;
			}
		);
		// And a fetch that genuinely fails IS wrapped — nothing listens on 59999.
		await assert.rejects(
			() => client.updateContentLibraryRecord('author', RECORD_ID, { name: 'x' }),
			(error) => {
				assert.ok(error instanceof ApexTransportError, `got ${error?.name}: ${error?.message}`);
				return true;
			}
		);
	});
});

describe('what a save costs, and what it records when it fails before it starts', () => {
	it('a LIST-ONLY save sends no empty flat PATCH', async () => {
		// Nothing belongs on the flat surface, and an empty body is a round trip that
		// can only fail. The child writes must still run exactly as they would after
		// a real one.
		const apex = fakeApex({ items: backedItems() });
		const ctx = ctxWith(apex);
		const response = await update(ctx, { fields: { expertise_items: [CHILD_B] } });
		assert.equal(response.status, 200, await response.clone().text());
		assert.equal(
			apex.calls.some((call) => call.kind === 'flat'),
			false,
			'no flat write was attempted'
		);
		assert.deepEqual(apex.record().primitives.expertise_items, [CHILD_B], 'and the list landed');
	});

	it('still sends the flat PATCH when a scalar, a reference or a reorder is in the save', async () => {
		for (const [label, body] of [
			['a scalar', { fields: { name: 'Asha Rao', expertise_items: [CHILD_B] } }],
			['a reorder', { position: 7, fields: { expertise_items: [CHILD_B] } }]
		]) {
			const apex = fakeApex({ items: backedItems() });
			const ctx = ctxWith(apex);
			assert.equal((await update(ctx, body)).status, 200, label);
			assert.ok(
				apex.calls.some((call) => call.kind === 'flat'),
				`${label} still travels flat`
			);
		}
	});

	it('an unreadable record is a 502 WITH an audit row, not a silent one', async () => {
		// The pre-write read failing used to return a bare `bffError` before the audit
		// block, so a save that failed before it started left no trace at all.
		const db = await createMigratedDatabase();
		const apex = fakeApex({ items: backedItems() });
		apex.getContentLibraryRecord = async () => ({ status: 503, ok: false, body: null });
		const ctx = ctxWith(apex, db);
		const response = await update(ctx, { fields: { name: 'Asha Rao' } });
		assert.equal(response.status, 502);
		const rows = db.sqlite
			.prepare('SELECT outcome, detail FROM bff_audit_log')
			.all()
			.map((row) => ({ ...row, detail: row.detail ? JSON.parse(row.detail) : null }));
		assert.equal(rows.length, 1);
		assert.equal(rows[0].outcome, 'rejected');
		assert.equal(rows[0].detail.reason, 'pre-write read failed');
		db.close();
	});

	it('an unbacked refusal survives a broken audit log — a 409 never becomes a 500', async () => {
		// Nothing was written, so a D1 hiccup must not replace the deliberate refusal
		// with a framework error and hide the very thing the guard exists to say.
		const db = await createMigratedDatabase();
		db.sqlite.exec('DROP TABLE bff_audit_log');
		const apex = fakeApex({ items: [], unbackedPrimitives: { name: 'Asha', email: 'a@b.test' } });
		const ctx = ctxWith(apex, db);
		const response = await update(ctx, { fields: { name: 'x' } });
		assert.equal(response.status, 409, 'the refusal still arrives');
		assert.equal((await response.json()).error, 'unbacked-record');
		db.close();
	});
});

describe('PATCH /posts/:schema/:id — an array on a post archetype is a 400, not a 500', () => {
	it('refuses it with a typed status instead of letting the client throw', async () => {
		// `recordBodySchema` accepts an array on an array-shaped field — it has to,
		// for the record path that routes them to the items endpoint — and
		// `toApexFields` passes it through. There is NO such routing for a post, so
		// the value would reach `updatePostArchetype`, whose `assertNoArrayFields`
		// throws: an uncaught framework 500 where the caller deserves a 400.
		const apex = {
			async listPosts() {
				throw new Error('the refusal must land before any upstream read');
			},
			async updatePostArchetype() {
				throw new Error('must not write');
			}
		};
		const ctx = ctxWith(apex);
		const session = await signIn(ctx);
		const postId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
		const response = await handleUpdatePostArchetype(
			new Request(`${ORIGIN}/api/admin/posts/article/${postId}`, {
				method: 'PATCH',
				headers: {
					origin: ORIGIN,
					'sec-fetch-site': 'same-origin',
					'x-csrf-token': CSRF,
					'content-type': 'application/json',
					cookie: `apex_admin_session=${session}; apex_bff_csrf=${CSRF}`
				},
				body: JSON.stringify({ fields: { tag_names: ['a', 'b'] } })
			}),
			ctx,
			{ schema: 'article', postId }
		);
		assert.equal(response.status, 400);
		assert.equal((await response.json()).error, 'child list on post');
	});
});

describe('POST /posts/:schema — an array on a post CREATE is a 400, not a 500', () => {
	it('refuses it in the body schema, before the client can throw', async () => {
		// Same trapdoor as the post UPDATE: `z.unknown()` accepted an array,
		// `toApexFields` passed it, and `createPost` → `assertNoArrayFields` threw.
		const apex = {
			async createPost() {
				throw new Error('must not write');
			}
		};
		const ctx = ctxWith(apex);
		const session = await signIn(ctx);
		const response = await handleCreatePost(
			new Request(`${ORIGIN}/api/admin/posts/article`, {
				method: 'POST',
				headers: {
					origin: ORIGIN,
					'sec-fetch-site': 'same-origin',
					'x-csrf-token': CSRF,
					'content-type': 'application/json',
					cookie: `apex_admin_session=${session}; apex_bff_csrf=${CSRF}`
				},
				body: JSON.stringify({
					title: 'A post',
					slug: 'a-post',
					fields: { tag_names: ['a', 'b'] }
				})
			}),
			ctx,
			{ schema: 'article' }
		);
		assert.equal(response.status, 400);
		assert.equal((await response.json()).error, 'invalid body');
	});
});

describe('POST /records/:schema — a child list cannot be written on a create', () => {
	it('refuses it rather than storing `[]` and reporting 201', async () => {
		const apex = fakeApex({});
		const ctx = ctxWith(apex);
		const session = await signIn(ctx);
		const response = await handleCreateRecord(
			new Request(`${ORIGIN}/api/admin/records/team_member`, {
				method: 'POST',
				headers: {
					origin: ORIGIN,
					'sec-fetch-site': 'same-origin',
					'x-csrf-token': CSRF,
					'content-type': 'application/json',
					cookie: `apex_admin_session=${session}; apex_bff_csrf=${CSRF}`
				},
				body: JSON.stringify({ fields: { name: 'Asha', expertise_items: [CHILD_A] } })
			}),
			ctx,
			{ schema: 'team_member' }
		);
		assert.equal(response.status, 400);
		assert.equal(apex.calls.length, 0, 'nothing was created');
	});
});
