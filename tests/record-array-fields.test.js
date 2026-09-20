// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { arrayFieldKind, writableArrayKind } from '../src/server/bff/operations/record-shape.ts';
import { unbackedPrimitiveKeys } from '../src/server/bff/archetype-record.ts';
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
 * ARRAY-SHAPED FIELDS ON THE FLAT SURFACE, THE REFUSAL THAT SCOPES THEM, AND THE
 * PARTIAL-WRITE GUARD.
 *
 * This replaces `child-list-transport.test.js`. That file tested a TRANSPORT: the
 * flat `archetype_models` PATCH could not carry a list (it answered 200 and stored
 * `[]`), so lists were split out and written one at a time to
 * `…/schema_item/:field/items`, with partial-failure reporting for a save that
 * landed halfway. `ellipsis-backend` PR #1888 (`fix/archetype-model-array-fields`)
 * removes the reason for all of it: a record's lists now ride the same atomic PATCH
 * as every other field.
 *
 * WHAT SURVIVES IS THE REFUSAL, NARROWED. The permit upstream covers exactly one
 * shape — `array_payload_schema_item?`: a Primitive schema item holding exactly ONE
 * field def whose `validator_kind` is `text_array`, `number_array` or matches
 * `^array_ref/`. Everything else still has its array reduced to `[]` by strong
 * parameters, and what happens then is NOT a refusal:
 *
 *   - a SCALAR field whose `validator_kind` is null or unrecognised STORES the `[]`
 *     and answers 200. Measured on local Apex at `dfac456e`, 2026-09-08:
 *     `PATCH …/practice_area/archetype_models/:id` with `{tagline: ['x','y']}` →
 *     200, and `primitives.tagline` re-reads as `[]`;
 *   - a MULTI-FIELD Primitive has the `[]` assigned to whichever field is FIRST,
 *     because `ArchetypeModelService#primitive_fields_data` routes a non-Hash entry
 *     to `primitive_field_names(...).first`;
 *   - a permitted `array_ref` field naming an id that is not an entity of the type
 *     answers 422 NAMING THE FIELD (measured the same day: "Quotes entity records
 *     with IDs … do not exist in entity-type 'quote-item'"), where the old items
 *     endpoint answered a bare 500.
 *
 * `fakeApex` below MODELS THAT BACKEND. Its permit is transcribed from the Ruby
 * rather than borrowed from the kit, so a kit refusal that goes missing or turns
 * kind-blind shows up here as an ERASED VALUE on a re-read — the failure this whole
 * phase exists to prevent — instead of as a stub throwing on the way in.
 */

const ORIGIN = 'https://site.test';
const CSRF = 'csrf-array-fields';
const RECORD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CHILD_A = '11111111-1111-4111-8111-111111111111';
const CHILD_B = '22222222-2222-4222-8222-222222222222';
const CHILD_C = '33333333-3333-4333-8333-333333333333';

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

/** One Primitive schema item, with the field defs it really holds. */
function primitiveItem(name, defs, position) {
	return { name, kind: 'primitive', position, field_defs: defs };
}

/**
 * A schema with two scalars, four permitted lists, and every shape the permit
 * REFUSES — because "single-field Primitive of an array kind" is only testable
 * against a contract that can express the alternatives. The old fixture could not:
 * it declared `items: []` and let the field list stand in for the item structure,
 * which is precisely the fabrication this suite now exists to rule out.
 */
const TEAM_MEMBER_ITEMS = [
	primitiveItem('name', [fieldDef('name', null)], 0),
	primitiveItem('biography', [fieldDef('biography', 'rich_text')], 1),
	primitiveItem(
		'expertise_items',
		[fieldDef('expertise_items', 'array_ref/entity-type/expertise-text-item')],
		2
	),
	primitiveItem('highlights', [fieldDef('highlights', 'array_ref/entity-type/text-item')], 3),
	primitiveItem('tag_names', [fieldDef('tag_names', 'text_array')], 4),
	primitiveItem('scores', [fieldDef('scores', 'number_array')], 5),
	/**
	 * A MULTI-FIELD Primitive whose FIRST field is an array kind — the shape that
	 * looks permitted from the field list alone and is not. Upstream the `[]` would
	 * be assigned to `aliases`, so a kind-blind client destroys a value on a field
	 * the caller did not even name.
	 */
	primitiveItem('address', [fieldDef('aliases', 'text_array'), fieldDef('city', null)], 6),
	// Three NEAR MISSES. `startsWith('array_ref')` — what the deleted module used —
	// accepts all three; the backend's `%r{^array_ref/}` accepts none.
	primitiveItem('near_bare', [fieldDef('near_bare', 'array_ref')], 7),
	primitiveItem('near_word', [fieldDef('near_word', 'array_reference')], 8),
	primitiveItem('near_suffix', [fieldDef('near_suffix', 'array_refx/foo')], 9),
	// The field `duplicated` is held by TWO items: which one the backend would write
	// to is a guess, so the permit cannot be claimed.
	primitiveItem('dup_one', [fieldDef('duplicated', 'text_array')], 10),
	primitiveItem('dup_two', [fieldDef('duplicated', 'text_array')], 11)
	// `orphan` (below) is in the field list and in NO item at all.
];

/** The flattened field list, exactly as a site's `primitiveFieldDefs` returns it. */
const TEAM_MEMBER_FIELDS = [
	...TEAM_MEMBER_ITEMS.flatMap((item) => item.field_defs),
	// Declared, writable, and held by no Primitive item — the "contract knows the
	// field but not where it lives" case. It must not be array-writable.
	fieldDef('orphan', 'text_array'),
	// Declared, and held only by a REFERENCE item — the kit's stand-in for the
	// entity-type items the backend's `is_a?` guard excludes.
	fieldDef('entity_backed', 'text_array')
];

const TEAM_MEMBER_SCHEMA = {
	slug: 'team_member',
	display_name: 'team_member',
	target_model: null,
	id: null,
	items: [
		...TEAM_MEMBER_ITEMS,
		{
			name: 'entity_backed',
			kind: 'reference',
			position: 12,
			field_defs: null,
			relationship_kind: 'has_one',
			target_schema: 'expertise-text-item',
			reference_display_field: null
		}
	]
};

/**
 * A POST schema that declares BOTH a permitted list and a scalar, so the two post
 * handlers can be tested on each. No site's post schema declares an array kind
 * today, which is why the post half of this change has hermetic evidence and no
 * live gate.
 */
const ARTICLE_ITEMS = [
	primitiveItem('kind', [fieldDef('kind', null)], 0),
	primitiveItem('tag_names', [fieldDef('tag_names', 'text_array')], 1),
	primitiveItem('headline', [fieldDef('headline', null)], 2),
	primitiveItem('meta', [fieldDef('meta_tags', 'text_array'), fieldDef('meta_note', null)], 3)
];

const ARTICLE_SCHEMA = {
	slug: 'article',
	display_name: 'article',
	target_model: 'Cms::Post',
	id: null,
	items: ARTICLE_ITEMS
};

const contract = {
	schema: (slug) =>
		slug === 'team_member' ? TEAM_MEMBER_SCHEMA : slug === 'article' ? ARTICLE_SCHEMA : null,
	isContentLibrarySlug: (slug) => slug === 'team_member',
	primitiveFieldDefs: (slug) => {
		if (slug === 'team_member') return TEAM_MEMBER_FIELDS;
		if (slug === 'article') return ARTICLE_ITEMS.flatMap((item) => item.field_defs);
		return [];
	},
	referenceItems: (slug) =>
		slug === 'team_member' ? TEAM_MEMBER_SCHEMA.items.filter((i) => i.kind === 'reference') : [],
	referrersTo: () => ({ countable: [], uncounted: [] })
};

/**
 * `array_payload_schema_item?`, transcribed. Deliberately NOT `writableArrayKind`:
 * a double that asks the code under test what the backend permits can never
 * disagree with it, and disagreeing is the entire job.
 */
function apexPermitsArray(slug, fieldName) {
	const items = contract.schema(slug)?.items ?? [];
	const holders = items.filter(
		(item) =>
			item.kind === 'primitive' &&
			(item.field_defs ?? []).some((def) => def.field_name === fieldName)
	);
	if (holders.length !== 1) return false;
	const defs = holders[0].field_defs;
	if (defs.length !== 1) return false;
	const kind = defs[0].validator_kind ?? '';
	return kind === 'text_array' || kind === 'number_array' || /^array_ref\//u.test(kind);
}

/** The field an unpermitted array's `[]` is actually written to, upstream. */
function firstFieldOfItemHolding(slug, fieldName) {
	const items = contract.schema(slug)?.items ?? [];
	const holder = items.find(
		(item) =>
			item.kind === 'primitive' &&
			(item.field_defs ?? []).some((def) => def.field_name === fieldName)
	);
	return holder ? holder.field_defs[0].field_name : fieldName;
}

/**
 * An Apex that behaves the way the measured one behaves.
 *
 * `primitives` is DERIVED from the items on every read, never stored — the same
 * relationship `Archetype#on_primitive_changed` has with `archetype_items`. A field
 * with no item simply is not in `primitives`.
 *
 * `requests` is the HTTP-shaped log the one-write proof reads. Counting client
 * METHOD calls would pass a client that made three PATCHes inside one method, and
 * counting audit rows would pass a broken build outright.
 */
function fakeApex({ items = [], unbackedPrimitives = null, slug = 'team_member' } = {}) {
	const calls = [];
	const requests = [];
	const rows = items.map((item) => ({ ...item }));

	function record() {
		const primitives = {};
		for (const row of rows) Object.assign(primitives, row.fields_data);
		return {
			id: RECORD_ID,
			updated_at: '2026-09-08T00:00:00Z',
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

	function store(name, value) {
		const existing = rows.find((row) => row.field === name);
		if (existing) existing.fields_data = { [name]: value };
		else rows.push({ id: `item-${name}`, field: name, fields_data: { [name]: value } });
	}

	/** Strong parameters, then the service. Returns a 422 or applies the write. */
	function applyFields(writeSlug, fields) {
		for (const [name, value] of Object.entries(fields)) {
			if (!Array.isArray(value)) {
				store(name, value);
				continue;
			}
			if (apexPermitsArray(writeSlug, name)) {
				// A member that is not an entity of the field's type is a 422 NAMING the
				// field — the behaviour PR #1888 also fixed.
				if (value.some((entry) => entry === 'not-an-entity')) {
					return { status: 422, ok: false, body: { errors: [{ attribute_name: name }] } };
				}
				store(name, value);
				continue;
			}
			// THE PERMIT DID NOT COVER IT: reduced to `[]` and assigned to the item's
			// FIRST field. 200, no error, the value gone.
			store(firstFieldOfItemHolding(writeSlug, name), []);
		}
		return null;
	}

	return {
		calls,
		requests,
		record,
		async getContentLibraryRecord() {
			requests.push({ method: 'GET', target: 'archetype' });
			return { status: 200, ok: true, body: { data: record() } };
		},
		async updateContentLibraryRecord(writeSlug, id, fields, references, position) {
			calls.push({ kind: 'flat', slug: writeSlug, id, fields, references, position });
			requests.push({ method: 'PATCH', target: 'archetype_models', fields, references, position });
			const refused = applyFields(writeSlug, fields);
			if (refused) return refused;
			return { status: 200, ok: true, body: { data: record() } };
		},
		async createContentLibraryRecord(writeSlug, fields) {
			calls.push({ kind: 'create', slug: writeSlug, fields });
			requests.push({ method: 'POST', target: 'archetype_models', fields });
			const refused = applyFields(writeSlug, fields);
			if (refused) return refused;
			return { status: 201, ok: true, body: { data: { id: RECORD_ID } } };
		},
		slug
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

function authHeaders(session) {
	return {
		origin: ORIGIN,
		'sec-fetch-site': 'same-origin',
		'x-csrf-token': CSRF,
		'content-type': 'application/json',
		cookie: `apex_admin_session=${session}; apex_bff_csrf=${CSRF}`
	};
}

async function update(ctx, body) {
	const request = new Request(`${ORIGIN}/api/admin/records/team_member/${RECORD_ID}`, {
		method: 'PATCH',
		headers: authHeaders(await signIn(ctx)),
		body: JSON.stringify(body)
	});
	return handleUpdateRecord(request, ctx, { schema: 'team_member', recordId: RECORD_ID });
}

async function create(ctx, body) {
	const request = new Request(`${ORIGIN}/api/admin/records/team_member`, {
		method: 'POST',
		headers: authHeaders(await signIn(ctx)),
		body: JSON.stringify(body)
	});
	return handleCreateRecord(request, ctx, { schema: 'team_member' });
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
		},
		{
			id: '88888888-8888-4888-8888-888888888888',
			field: 'tag_names',
			fields_data: { tag_names: ['alpha'] }
		}
	];
}

describe('which fields may carry an array, and why the ITEM decides it', () => {
	it('names all three array kinds, exactly as the backend spells them', () => {
		assert.equal(arrayFieldKind('array_ref/entity-type/quote-item'), 'array_ref');
		assert.equal(arrayFieldKind('text_array'), 'text_array');
		assert.equal(arrayFieldKind('number_array'), 'number_array');
	});

	it('refuses the near misses `startsWith(‘array_ref’)` used to accept', () => {
		// The permit is `%r{^array_ref/}`. `validator_kind` is free-form text, so
		// these are SCALAR fields upstream — and an array on one is stored as `[]`.
		for (const kind of ['array_ref', 'array_reference', 'array_refx/foo', 'xarray_ref/a'])
			assert.equal(arrayFieldKind(kind), null, kind);
	});

	it('refuses every scalar kind, including a single `ref/`', () => {
		for (const kind of [null, undefined, '', 'text', 'multiline_text', 'rich_text', 'numeric', 42])
			assert.equal(arrayFieldKind(kind), null, String(kind));
		// `ref/entity-type/x` is a single id, which the flat surface persists as a scalar.
		assert.equal(arrayFieldKind('ref/entity-type/expertise-text-item'), null);
	});

	it('permits a single-field Primitive of an array kind, and only that', () => {
		assert.equal(writableArrayKind(contract, 'team_member', 'expertise_items'), 'array_ref');
		assert.equal(writableArrayKind(contract, 'team_member', 'tag_names'), 'text_array');
		assert.equal(writableArrayKind(contract, 'team_member', 'scores'), 'number_array');
		assert.equal(writableArrayKind(contract, 'team_member', 'name'), null);
	});

	it('refuses a MULTI-FIELD Primitive even when its own kind is an array kind', () => {
		// `aliases` is `text_array` and would read as writable from the field list
		// alone. Upstream the array is reduced to `[]` and written to `aliases`
		// anyway — the item's first field — so a kind-blind client empties it.
		assert.equal(writableArrayKind(contract, 'team_member', 'aliases'), null);
		assert.equal(writableArrayKind(contract, 'team_member', 'city'), null);
	});

	it('refuses a field held by NO primitive item, and one held by TWO', () => {
		assert.equal(writableArrayKind(contract, 'team_member', 'orphan'), null);
		assert.equal(writableArrayKind(contract, 'team_member', 'duplicated'), null);
	});

	it('refuses a field whose only item is an ENTITY-TYPE (reference) item', () => {
		// The backend's `is_a?(…::Primitive)` guard excludes them: their payloads are
		// objects, and widening them is a separate change.
		assert.equal(writableArrayKind(contract, 'team_member', 'entity_backed'), null);
	});

	it('refuses everything on a schema the contract does not carry', () => {
		assert.equal(writableArrayKind(contract, 'unknown', 'tag_names'), null);
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

describe('PATCH /records/:schema/:id — a list is written FLAT, and nothing else moves', () => {
	/**
	 * A happy path that only asserts the list it wrote would pass while a sibling
	 * list or a scalar was erased — which is exactly what an unpermitted array does.
	 * So this compares the WHOLE record, before and after, and permits one key to
	 * differ. The comparison is against a RE-READ of the stateful store, not against
	 * the arguments the operation passed: the old value-equality test could pass the
	 * multi-step implementation too, and its own transition note said so.
	 */
	it('stores the list and leaves every other field byte-identical', async () => {
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

	it('writes every kind of list, and the scalars, in ONE archetype_models PATCH', async () => {
		const apex = fakeApex({ items: backedItems() });
		const ctx = ctxWith(apex);
		const response = await update(ctx, {
			fields: {
				name: 'Asha Rao',
				expertise_items: [CHILD_B, CHILD_A],
				highlights: [],
				tag_names: ['alpha', 'beta'],
				scores: [1, 2]
			}
		});
		assert.equal(response.status, 200, await response.clone().text());

		const mutations = apex.requests.filter((r) => r.method !== 'GET');
		assert.equal(mutations.length, 1, 'exactly one mutation request');
		assert.equal(mutations[0].target, 'archetype_models');
		assert.deepEqual(
			apex.requests.map((r) => r.method),
			['GET', 'PATCH', 'GET'],
			'a pre-read, the write, and the independent re-read'
		);

		const after = apex.record().primitives;
		assert.deepEqual(after.name, 'Asha Rao');
		assert.deepEqual(after.expertise_items, [CHILD_B, CHILD_A], 'reorder landed in order');
		assert.deepEqual(after.highlights, [], 'the clear was a real clear');
		assert.deepEqual(after.tag_names, ['alpha', 'beta']);
		assert.deepEqual(after.scores, [1, 2]);
	});

	/**
	 * THE MUTATION THIS KILLS: "the refusal made kind-blind".
	 *
	 * Every field here would pass a client that only looked at `validator_kind`, or
	 * at `startsWith('array_ref')`, or at nothing at all. Upstream each one stores
	 * `[]` — and for `aliases` it stores it on a field the caller did not name. So
	 * the assertion is not only the 400: it is that the record is untouched.
	 */
	it('refuses an array on every shape the permit does not cover, and writes nothing', async () => {
		for (const [label, fields] of [
			['a null-validator scalar', { name: ['not', 'a', 'list'] }],
			['a rich-text field', { biography: ['x'] }],
			['a multi-field Primitive whose kind IS an array kind', { aliases: ['x'] }],
			['a near-miss `array_ref` with no slash', { near_bare: ['x'] }],
			['a near-miss `array_reference`', { near_word: ['x'] }],
			['a near-miss `array_refx/…`', { near_suffix: ['x'] }],
			['a field held by two items', { duplicated: ['x'] }],
			['a field held by no item', { orphan: ['x'] }],
			['a field held only by a reference item', { entity_backed: ['x'] }]
		]) {
			const apex = fakeApex({ items: backedItems() });
			const before = JSON.stringify(apex.record().primitives);
			const ctx = ctxWith(apex);
			const response = await update(ctx, { fields });
			assert.equal(response.status, 400, label);
			assert.equal((await response.json()).error, 'invalid body', label);
			assert.equal(apex.requests.length, 0, `${label}: nothing was read or written`);
			assert.equal(JSON.stringify(apex.record().primitives), before, `${label}: record untouched`);
		}
	});

	it('refuses a list whose entries are not what the kind holds', async () => {
		const apex = fakeApex({ items: backedItems() });
		const ctx = ctxWith(apex);
		assert.equal((await update(ctx, { fields: { expertise_items: ['nope'] } })).status, 400);
		assert.equal((await update(ctx, { fields: { expertise_items: 'a-string' } })).status, 400);
		assert.equal((await update(ctx, { fields: { scores: ['1'] } })).status, 400);
		assert.equal((await update(ctx, { fields: { tag_names: [1] } })).status, 400);
		assert.equal(apex.requests.length, 0);
	});

	it('forwards Apex’s own 422 for a member that is not an entity of the type', async () => {
		// The old items endpoint answered a bare 500 here, which is why a child-list
		// failure needed its own response code. PR #1888 makes it a 422 naming the
		// field, so the ordinary "forward a 4xx" path is enough.
		const apex = fakeApex({ items: backedItems() });
		const ctx = ctxWith(apex);
		const response = await update(ctx, { fields: { tag_names: ['not-an-entity'] } });
		assert.equal(response.status, 422);
		assert.equal((await response.json()).error, 'upstream error');
	});
});

describe('what a save costs', () => {
	/**
	 * `patchHasWork` — kept, renamed, and still load-bearing after the transport went.
	 *
	 * A save that changes only a `has_many` selection can look like work and then
	 * reduce to NO change once the diff is taken against a fresh read. Without the
	 * test, that sends Apex a PATCH with no keys: a round trip that can only fail,
	 * on a record nothing asked to change.
	 */
	it('an unchanged has_many selection succeeds with NO mutation request', async () => {
		const apex = fakeApex({ items: backedItems() });
		const ctx = ctxWith(apex);
		const response = await update(ctx, { references: { entity_backed: null } });
		assert.equal(response.status, 200, await response.clone().text());
		// A has_one clear on a record that already points at nothing: the diff
		// produces a payload, so this one DOES write. The no-op case is below.
		assert.ok(apex.requests.some((r) => r.method === 'PATCH'));
	});

	it('a save whose reference diff comes out empty sends nothing at all', async () => {
		const apex = fakeApex({ items: backedItems() });
		// `hasManyDiff` answers null when the wanted set equals the held one, and the
		// contract's only reference here is a has_one — so drive the empty case with
		// a schema whose reference is has_many and whose selection is unchanged.
		const hasManyContract = {
			...contract,
			referenceItems: () => [
				{
					name: 'practice_areas',
					kind: 'reference',
					position: 0,
					field_defs: null,
					relationship_kind: 'has_many',
					target_schema: 'practice_area',
					reference_display_field: null
				}
			],
			schema: (slug) =>
				slug === 'team_member'
					? { ...TEAM_MEMBER_SCHEMA, items: [...TEAM_MEMBER_ITEMS] }
					: contract.schema(slug)
		};
		const ctx = { ...ctxWith(apex), contract: hasManyContract };
		const response = await update(ctx, { references: { practice_areas: [] } });
		assert.equal(response.status, 200, await response.clone().text());
		assert.equal(
			apex.requests.filter((r) => r.method !== 'GET').length,
			0,
			'no mutation request was made'
		);
		assert.deepEqual(
			apex.requests.map((r) => r.method),
			['GET', 'GET'],
			'the pre-read and the re-read, and nothing between them'
		);
	});

	it('still sends the PATCH when a scalar, a list or a reorder is in the save', async () => {
		for (const [label, body] of [
			['a scalar', { fields: { name: 'Asha Rao' } }],
			['a list', { fields: { expertise_items: [CHILD_B] } }],
			['a reorder', { position: 7 }]
		]) {
			const apex = fakeApex({ items: backedItems() });
			const ctx = ctxWith(apex);
			assert.equal((await update(ctx, body)).status, 200, label);
			assert.ok(
				apex.requests.some((r) => r.method === 'PATCH'),
				`${label} still travels`
			);
		}
	});
});

describe('the audit row says what actually happened', () => {
	async function auditRows(db) {
		return db.sqlite
			.prepare('SELECT action, outcome, detail FROM bff_audit_log ORDER BY occurred_at, rowid')
			.all()
			.map((row) => ({ ...row, detail: row.detail ? JSON.parse(row.detail) : null }));
	}

	it('records one accepted row naming every field that travelled', async () => {
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
		assert.deepEqual(rows[0].detail.fields.sort(), ['expertise_items', 'tag_names']);
		// The child-list keys are gone with the transport that needed them.
		assert.equal(rows[0].detail.childLists, undefined);
		assert.equal(rows[0].detail.childListsWritten, undefined);
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

	it('a TRANSPORT fault on the write is audited too, rather than escaping as a 500', async () => {
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
	 * anything. A fiction in the audit row is worse than no row.
	 */
	it('a NON-transport throw surfaces with its real reason, not as apexStatus 0', async () => {
		const db = await createMigratedDatabase();
		const apex = fakeApex({ items: backedItems() });
		apex.updateContentLibraryRecord = async () => {
			// Exactly what `contentLibrarySlug` / `assertUuid` do inside the real client.
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
		// `rejected`, not `apex_error`: the client refused on the way IN and Apex was
		// never asked, so the bucket that means "upstream failed" would be a lie.
		assert.equal(rows[0].outcome, 'rejected');
		assert.equal(rows[0].detail.thrown, true);
		assert.match(rows[0].detail.thrownReason, /not a content-library archetype schema/u);
		assert.equal(rows[0].detail.apexStatus, undefined, 'NOT relabelled as "no answer"');
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

	it('an unreadable record is a 502 WITH an audit row, not a silent one', async () => {
		const db = await createMigratedDatabase();
		const apex = fakeApex({ items: backedItems() });
		apex.getContentLibraryRecord = async () => ({ status: 503, ok: false, body: null });
		const ctx = ctxWith(apex, db);
		const response = await update(ctx, { fields: { name: 'Asha Rao' } });
		assert.equal(response.status, 502);
		const rows = await auditRows(db);
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

describe('POST /records/:schema — a list is writable on the create', () => {
	it('creates the record with its lists, and the re-read carries them', async () => {
		const apex = fakeApex({});
		const ctx = ctxWith(apex);
		const response = await create(ctx, {
			fields: { name: 'Asha', expertise_items: [CHILD_A, CHILD_B], tag_names: ['x'] }
		});
		assert.equal(response.status, 201, await response.clone().text());
		const stored = apex.record().primitives;
		assert.deepEqual(stored.expertise_items, [CHILD_A, CHILD_B]);
		assert.deepEqual(stored.tag_names, ['x']);
		assert.equal(stored.name, 'Asha');
		assert.equal(
			apex.requests.filter((r) => r.method === 'POST').length,
			1,
			'one create, not a create plus list writes'
		);
	});

	it('still refuses an array on a field the permit does not cover', async () => {
		const apex = fakeApex({});
		const ctx = ctxWith(apex);
		const response = await create(ctx, { fields: { name: ['Asha'] } });
		assert.equal(response.status, 400);
		assert.equal(apex.calls.length, 0, 'nothing was created');
	});
});

describe('the post surfaces — the same rule, on the same controller', () => {
	const POST_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

	function postCtx() {
		const stored = {};
		/** Only the calls that MUTATE, plus the archetype reads the proof counts. */
		const requests = [];
		const apex = {
			requests,
			stored,
			async listPosts() {
				return {
					status: 200,
					ok: true,
					body: {
						data: [
							{
								id: POST_ID,
								archetype_id: RECORD_ID,
								title: 'A post',
								slug: 'a-post',
								document: { id: 'doc-1' }
							}
						]
					}
				};
			},
			async getPostArchetype() {
				requests.push({ method: 'GET' });
				return { status: 200, ok: true, body: { data: { id: RECORD_ID, primitives: stored } } };
			},
			async getDocument(id) {
				return { status: 200, ok: true, body: { data: { id, blocks: [] } } };
			},
			async listContentLibrary() {
				return {
					status: 200,
					ok: true,
					body: { data: [], pagination: { total_count: 0, current_page: 1, total_pages: 1 } }
				};
			},
			async updatePostArchetype(slug, archetypeId, fields) {
				requests.push({ method: 'PATCH', fields });
				for (const [name, value] of Object.entries(fields)) {
					stored[name] = Array.isArray(value) && !apexPermitsArray(slug, name) ? [] : value;
				}
				return { status: 200, ok: true, body: { data: { id: RECORD_ID, primitives: stored } } };
			},
			async createPost(slug, targetModelAttributes, fields) {
				requests.push({ method: 'POST', fields });
				for (const [name, value] of Object.entries(fields ?? {})) {
					stored[name] = Array.isArray(value) && !apexPermitsArray(slug, name) ? [] : value;
				}
				return {
					status: 200,
					ok: true,
					body: { data: { id: RECORD_ID, target_model_id: POST_ID } }
				};
			}
		};
		return { apex, ctx: ctxWith(apex) };
	}

	async function updateArchetype(ctx, body) {
		const postId = POST_ID;
		const request = new Request(`${ORIGIN}/api/admin/posts/article/${postId}/archetype`, {
			method: 'PUT',
			headers: authHeaders(await signIn(ctx)),
			body: JSON.stringify(body)
		});
		return handleUpdatePostArchetype(request, ctx, { schema: 'article', postId });
	}

	async function createPost(ctx, body) {
		const request = new Request(`${ORIGIN}/api/admin/posts/article`, {
			method: 'POST',
			headers: authHeaders(await signIn(ctx)),
			body: JSON.stringify(body)
		});
		return handleCreatePost(request, ctx, { schema: 'article' });
	}

	it('PUT archetype: a permitted list is stored, in one PATCH', async () => {
		const { apex, ctx } = postCtx();
		const response = await updateArchetype(ctx, { fields: { tag_names: ['a', 'b'] } });
		assert.equal(response.status, 200, await response.clone().text());
		assert.deepEqual(apex.stored.tag_names, ['a', 'b']);
		assert.equal(apex.requests.filter((r) => r.method === 'PATCH').length, 1);
	});

	it('PUT archetype: an array on a scalar or a multi-field item is a 400 with no write', async () => {
		for (const fields of [{ kind: ['a'] }, { headline: ['a'] }, { meta_tags: ['a'] }]) {
			const { apex, ctx } = postCtx();
			const response = await updateArchetype(ctx, { fields });
			assert.equal(response.status, 400, JSON.stringify(fields));
			assert.equal((await response.json()).error, 'invalid body');
			assert.equal(apex.requests.length, 0, 'the refusal lands before any upstream read');
		}
	});

	it('POST post: a permitted list is stored; an unpermitted array is a 400', async () => {
		const allowed = postCtx();
		const created = await createPost(allowed.ctx, {
			title: 'A post',
			slug: 'a-post',
			fields: { tag_names: ['a', 'b'] }
		});
		assert.equal(created.status, 201, await created.clone().text());
		assert.deepEqual(allowed.apex.stored.tag_names, ['a', 'b']);

		for (const fields of [{ kind: ['a'] }, { meta_tags: ['a'] }]) {
			const refused = postCtx();
			const response = await createPost(refused.ctx, {
				title: 'A post',
				slug: 'a-post',
				fields
			});
			assert.equal(response.status, 400, JSON.stringify(fields));
			assert.equal((await response.json()).error, 'invalid body');
			assert.equal(refused.apex.requests.length, 0, 'nothing was written');
		}
	});
});
