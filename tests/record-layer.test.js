// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	hasManyDiff,
	countReferencesTo,
	summarizeRecord
} from '../src/server/bff/operations/record-shape.ts';
import { handleDeleteRecord } from '../src/server/bff/operations/delete-record.ts';
import { handleCreateRecord } from '../src/server/bff/operations/create-record.ts';
import { handleUpdateRecord } from '../src/server/bff/operations/update-record.ts';
import { createApexAdminClient } from '../src/server/bff/apex-admin-client.ts';
import { createSessionSecret, sessionIdFor } from '../src/server/bff/session.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { createMemorySessionStore } from './harness/session-store.ts';

const ORIGIN = 'https://site.test';
const CSRF = 'csrf-record';
/** A uuid, because every record operation validates the id shape before using it. */
const RECORD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/**
 * A two-schema content model: `story` (a post, uncountable) and `partner` both point
 * at `focus_area`. Enough to exercise the countable/uncounted split without a site.
 */
const contract = {
	schema: (slug) =>
		['focus_area', 'partner', 'story'].includes(slug)
			? {
					slug,
					display_name: slug,
					target_model: slug === 'story' ? 'Cms::Post' : null,
					id: null,
					items: []
				}
			: null,
	isContentLibrarySlug: (slug) => slug === 'focus_area' || slug === 'partner',
	primitiveFieldDefs: () => [],
	referenceItems: (slug) =>
		slug === 'partner' || slug === 'story'
			? [
					{
						name: 'focus_area',
						kind: 'reference',
						position: 0,
						field_defs: null,
						relationship_kind: 'has_many',
						target_schema: 'focus_area',
						reference_display_field: null
					}
				]
			: [],
	referrersTo: (slug) =>
		slug === 'focus_area'
			? {
					countable: [{ slug: 'partner', displayName: 'partner', itemName: 'focus_area' }],
					uncounted: [{ slug: 'story', displayName: 'story', itemName: 'focus_area' }]
				}
			: { countable: [], uncounted: [] }
};

describe('hasManyDiff — the whole desired set, or nothing', () => {
	const held = [
		{ itemId: 'join-1', targetId: 'target-a' },
		{ itemId: 'join-2', targetId: 'target-b' }
	];

	it('adds by TARGET id and removes by JOIN id — the two id spaces are not interchangeable', () => {
		const diff = hasManyDiff('focus_area', held, ['target-a', 'target-c']);
		assert.deepEqual(diff, [{ focus_area: 'target-c' }, { item_id: 'join-2', _destroy: true }]);
	});

	it('an unchanged set sends NOTHING — `[]` would clear the relation', () => {
		assert.equal(hasManyDiff('focus_area', held, ['target-a', 'target-b']), null);
		assert.equal(hasManyDiff('focus_area', [], []), null);
	});

	it('clearing every entry destroys each join row, and never sends a bare []', () => {
		const diff = hasManyDiff('focus_area', held, []);
		assert.deepEqual(diff, [
			{ item_id: 'join-1', _destroy: true },
			{ item_id: 'join-2', _destroy: true }
		]);
	});
});

describe('countReferencesTo — fails closed', () => {
	function apexStub(pages) {
		return {
			async listContentLibrary(slug) {
				const page = pages[slug];
				return page ?? { status: 502, ok: false, body: null };
			}
		};
	}

	it('counts only the records that actually hold the target', async () => {
		const counted = await countReferencesTo(
			contract,
			apexStub({
				partner: {
					status: 200,
					ok: true,
					body: {
						data: [
							{
								id: 'p1',
								archetype_items: [
									{
										id: 'join-1',
										relatable_type: 'Specification::Archetype',
										archetype_schema_item: { name: 'focus_area' },
										fields_data: { focus_area: 'fa-1' }
									}
								]
							},
							{ id: 'p2', archetype_items: [] }
						],
						pagination: { total_count: 2, current_page: 1, total_pages: 1 }
					}
				}
			}),
			'focus_area',
			'fa-1'
		);
		assert.equal(counted.ok, true);
		assert.equal(counted.count, 1);
	});

	it('reads EVERY page — a reference on page two is not zero', async () => {
		const ref = (targetId) => ({
			id: 'p',
			archetype_items: [
				{
					id: 'join',
					relatable_type: 'Specification::Archetype',
					archetype_schema_item: { name: 'focus_area' },
					fields_data: { focus_area: targetId }
				}
			]
		});
		const pages = {
			1: { data: [ref('other')], pagination: { total_count: 2, current_page: 1, total_pages: 2 } },
			2: { data: [ref('fa-1')], pagination: { total_count: 2, current_page: 2, total_pages: 2 } }
		};
		const apex = {
			async listContentLibrary(_slug, query) {
				return { status: 200, ok: true, body: pages[query.page] };
			}
		};
		const counted = await countReferencesTo(contract, apex, 'focus_area', 'fa-1');
		assert.deepEqual([counted.ok, counted.count], [true, 1]);
	});

	it('missing pagination metadata is {ok:false} — we cannot know there is no page two', async () => {
		const apex = {
			async listContentLibrary() {
				return { status: 200, ok: true, body: { data: [] } };
			}
		};
		assert.equal((await countReferencesTo(contract, apex, 'focus_area', 'fa-1')).ok, false);
	});

	it('a leg that will not read is {ok:false}, never a partial count read as complete', async () => {
		const counted = await countReferencesTo(contract, apexStub({}), 'focus_area', 'fa-1');
		assert.equal(counted.ok, false);
	});
});

describe('DELETE /records/:schema/:id — the in-use refusal', () => {
	function ctxWith(apex) {
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
	function req(session, { confirm = false } = {}) {
		return new Request(
			`${ORIGIN}/api/admin/records/focus_area/8f14e45f-ceea-467a-9a3c-3f1a7c9d2b55${confirm ? '?confirm=1' : ''}`,
			{
				method: 'DELETE',
				headers: {
					origin: ORIGIN,
					'sec-fetch-site': 'same-origin',
					'x-csrf-token': CSRF,
					cookie: `apex_admin_session=${session}; apex_bff_csrf=${CSRF}`
				}
			}
		);
	}

	it('refuses OUTRIGHT while any referrer cannot be counted — confirmed or not', async () => {
		const apex = {
			async listContentLibrary() {
				throw new Error('must not read: the answer does not depend on a count');
			},
			async deleteContentLibraryRecord() {
				throw new Error('must not delete');
			}
		};
		const ctx = ctxWith(apex);
		const session = await signIn(ctx);
		for (const confirm of [false, true]) {
			const response = await handleDeleteRecord(req(session, { confirm }), ctx, {
				schema: 'focus_area',
				recordId: '8f14e45f-ceea-467a-9a3c-3f1a7c9d2b55'
			});
			assert.equal(response.status, 409);
			const body = await response.json();
			assert.equal(body.error, 'uncountable-references');
			// Naming it is the point: "0 references" would be a lie the editor acts on.
			assert.deepEqual(body.uncountedReferrers, ['story']);
		}
	});

	it('with every referrer countable, an unconfirmed delete reports the count and writes nothing', async () => {
		const countableOnly = {
			...contract,
			referrersTo: () => ({
				countable: [{ slug: 'partner', displayName: 'partner', itemName: 'focus_area' }],
				uncounted: []
			})
		};
		const apex = {
			async listContentLibrary() {
				return {
					status: 200,
					ok: true,
					body: {
						data: [
							{
								id: 'p1',
								archetype_items: [
									{
										id: 'join-1',
										relatable_type: 'Specification::Archetype',
										archetype_schema_item: { name: 'focus_area' },
										fields_data: { focus_area: '8f14e45f-ceea-467a-9a3c-3f1a7c9d2b55' }
									}
								]
							}
						],
						pagination: { total_count: 1, current_page: 1, total_pages: 1 }
					}
				};
			},
			async deleteContentLibraryRecord() {
				throw new Error('must not delete without confirmation');
			}
		};
		const ctx = { ...ctxWith(apex), contract: countableOnly };
		const response = await handleDeleteRecord(req(await signIn(ctx)), ctx, {
			schema: 'focus_area',
			recordId: '8f14e45f-ceea-467a-9a3c-3f1a7c9d2b55'
		});
		assert.equal(response.status, 409);
		const body = await response.json();
		assert.equal(body.error, 'in-use');
		assert.equal(body.referenceCount, 1);
	});
});

describe('allowedSchemaSlugs — a post archetype is unreachable, not merely discouraged', () => {
	const client = createApexAdminClient({
		baseUrl: 'https://apex.test',
		token: 'tok',
		allowedSchemaSlugs: ['focus_area', 'partner'],
		fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'application/json' } })
	});

	it('refuses a slug outside the allowlist on every content-library method', async () => {
		await assert.rejects(
			() => client.listContentLibrary('story'),
			/not a content-library archetype schema/
		);
		await assert.rejects(
			() => client.getContentLibraryRecord('story', '8f14e45f-ceea-467a-9a3c-3f1a7c9d2b55'),
			/not a content-library/
		);
		await assert.rejects(
			() => client.createContentLibraryRecord('story', {}),
			/not a content-library/
		);
		await assert.rejects(
			() => client.updateContentLibraryRecord('story', '8f14e45f-ceea-467a-9a3c-3f1a7c9d2b55', {}),
			/not a content-library/
		);
		await assert.rejects(
			() => client.deleteContentLibraryRecord('story', '8f14e45f-ceea-467a-9a3c-3f1a7c9d2b55'),
			/not a content-library/
		);
	});

	it('allows a listed slug, and a client with no allowlist keeps today’s behaviour', async () => {
		assert.equal((await client.listContentLibrary('partner')).ok, true);
		const open = createApexAdminClient({
			baseUrl: 'https://apex.test',
			token: 'tok',
			fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'application/json' } })
		});
		assert.equal((await open.listContentLibrary('anything')).ok, true);
	});
});

describe('the write path refuses what must never reach Apex', () => {
	function apexRecording() {
		const writes = [];
		return {
			writes,
			async createContentLibraryRecord(slug, fields) {
				writes.push({ slug, fields });
				return { status: 201, ok: true, body: { data: { id: 'new-1', updated_at: 'now' } } };
			},
			async listContentLibrary() {
				return {
					status: 200,
					ok: true,
					body: { data: [], pagination: { total_count: 0, current_page: 1, total_pages: 1 } }
				};
			},
			async getContentLibraryRecord() {
				return { status: 200, ok: true, body: { data: { id: 'new-1', updated_at: 'now' } } };
			}
		};
	}
	const fieldContract = {
		...contract,
		primitiveFieldDefs: (slug) =>
			slug === 'focus_area'
				? [
						{
							field_name: 'title',
							display_name: 'Title',
							validator_kind: null,
							text_inclusion: null,
							is_required: false,
							place_holder: null,
							default_value: null
						}
					]
				: [],
		referenceItems: () => []
	};
	function ctxWith(apex) {
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
			createApexClient: () => apex,
			contract: fieldContract
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
	function post(session, body) {
		return new Request(`${ORIGIN}/api/admin/records/focus_area`, {
			method: 'POST',
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

	it('refuses a null primitive — it destroys the row upstream and strands the old value', async () => {
		const apex = apexRecording();
		const ctx = ctxWith(apex);
		const response = await handleCreateRecord(
			post(await signIn(ctx), { fields: { title: null } }),
			ctx,
			{
				schema: 'focus_area'
			}
		);
		assert.equal(response.status, 400);
		assert.equal(apex.writes.length, 0, 'nothing was written');
	});

	it('sanitizes authored HTML on CREATE, not only on update', async () => {
		const apex = apexRecording();
		const ctx = ctxWith(apex);
		const response = await handleCreateRecord(
			post(await signIn(ctx), { fields: { title: '<a href="javascript:alert(1)">x</a>' } }),
			ctx,
			{ schema: 'focus_area' }
		);
		assert.equal(response.status, 201);
		assert.equal(apex.writes.length, 1);
		assert.doesNotMatch(String(apex.writes[0].fields.title), /javascript:/);
	});

	it('answers a JSON 500 — not a framework error page — when no contract is configured', async () => {
		const ctx = { ...ctxWith(apexRecording()), contract: undefined };
		const response = await handleCreateRecord(post(await signIn(ctx), { fields: {} }), ctx, {
			schema: 'focus_area'
		});
		assert.equal(response.status, 500);
		assert.equal(response.headers.get('content-type'), 'application/json');
	});

	it('refuses `position` on CREATE rather than dropping it', async () => {
		// `recordBodySchema` accepts the key for the update path, so without an
		// explicit refusal a create carrying one would parse, be ignored, and answer
		// 201 — a create that silently did not do what it was asked.
		const apex = apexRecording();
		const ctx = ctxWith(apex);
		const response = await handleCreateRecord(
			post(await signIn(ctx), { fields: { title: 'x' }, position: 3 }),
			ctx,
			{ schema: 'focus_area' }
		);
		assert.equal(response.status, 400);
		assert.equal(apex.writes.length, 0, 'nothing was written');
	});

	/**
	 * RECORD `position` — the archetype's own ordering column (plan §2.1.2).
	 *
	 * The kit's record response omitted it and its write schema was `.strict()` over
	 * `fields` and `references` only, so a site that sorts its public lists by
	 * `position` — Poovayya does, in five places — could neither read nor write the
	 * order its pages are drawn in. Ordering is not a schema primitive, so it could
	 * not be added as a field.
	 *
	 * Proved LIVE against local Apex on 2026-09-07 as well as here: a `team_member`
	 * read back `position: 12`, a PATCH of `{position: 77}` answered 200, and an
	 * independent re-read returned 77.
	 */
	describe('record position', () => {
		function apexWithPosition(record) {
			const writes = [];
			return {
				writes,
				async getContentLibraryRecord() {
					return { status: 200, ok: true, body: { data: record } };
				},
				async updateContentLibraryRecord(slug, id, fields, references, position) {
					writes.push({ slug, id, fields, references, position });
					return { status: 200, ok: true, body: { data: record } };
				}
			};
		}
		function patch(session, body) {
			return new Request(`${ORIGIN}/api/admin/records/focus_area/${RECORD_ID}`, {
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

		it('is read onto the record, and an absent one is null rather than 0', () => {
			assert.equal(
				summarizeRecord(fieldContract, 'focus_area', { id: 'a', position: 4 }).position,
				4
			);
			assert.equal(summarizeRecord(fieldContract, 'focus_area', { id: 'a' }).position, null);
			// `0` is a real ordering value; coercing an absent one to it would jump a
			// record that never had a position to the front of every list.
			assert.equal(
				summarizeRecord(fieldContract, 'focus_area', { id: 'a', position: 0 }).position,
				0
			);
			assert.equal(
				summarizeRecord(fieldContract, 'focus_area', { id: 'a', position: '3' }).position,
				null
			);
		});

		it('travels at the ROOT of the write, not inside fields', async () => {
			const apex = apexWithPosition({ id: RECORD_ID, position: 9, updated_at: 'then' });
			const ctx = ctxWith(apex);
			const response = await handleUpdateRecord(patch(await signIn(ctx), { position: 9 }), ctx, {
				schema: 'focus_area',
				recordId: RECORD_ID
			});
			assert.equal(response.status, 200, await response.clone().text());
			assert.equal(apex.writes.length, 1);
			assert.equal(apex.writes[0].position, 9);
			assert.deepEqual(apex.writes[0].fields, {}, 'position is not a field');
			assert.equal((await response.json()).record.position, 9);
		});

		it('a reorder-only patch is a real change, not an "empty patch"', async () => {
			// The empty-patch check counts `position`. Left out of it, a patch carrying
			// only a reorder would be refused 400 while the reorder is exactly the change
			// an editor made.
			const apex = apexWithPosition({ id: RECORD_ID, position: 2, updated_at: 'then' });
			const ctx = ctxWith(apex);
			const response = await handleUpdateRecord(patch(await signIn(ctx), { position: 2 }), ctx, {
				schema: 'focus_area',
				recordId: RECORD_ID
			});
			assert.equal(response.status, 200);
		});

		it('`null` clears it, and `undefined` is not sent at all', async () => {
			const apex = apexWithPosition({ id: RECORD_ID, updated_at: 'then' });
			const ctx = ctxWith(apex);
			assert.equal(
				(
					await handleUpdateRecord(patch(await signIn(ctx), { position: null }), ctx, {
						schema: 'focus_area',
						recordId: RECORD_ID
					})
				).status,
				200
			);
			assert.equal(apex.writes[0].position, null, 'null clears the column');

			const other = apexWithPosition({ id: RECORD_ID, updated_at: 'then' });
			const ctx2 = ctxWith(other);
			await handleUpdateRecord(patch(await signIn(ctx2), { fields: { title: 'x' } }), ctx2, {
				schema: 'focus_area',
				recordId: RECORD_ID
			});
			assert.equal(other.writes[0].position, undefined, 'an untouched position is not written');
		});

		it('the client omits the key entirely for `undefined` and sends it for `null`', async () => {
			// A `position: null` in the JSON body CLEARS the column upstream, so
			// "unchanged" has to be an absent key rather than a null one. This is the
			// only place that distinction is visible on the wire.
			const bodies = [];
			const client = createApexAdminClient({
				baseUrl: 'https://apex.test',
				token: 't',
				fetchImpl: async (_url, init) => {
					bodies.push(JSON.parse(init.body));
					return new Response('{}', {
						status: 200,
						headers: { 'content-type': 'application/json' }
					});
				}
			});
			await client.updateContentLibraryRecord('focus_area', RECORD_ID, { title: 'a' });
			await client.updateContentLibraryRecord('focus_area', RECORD_ID, {}, {}, null);
			await client.updateContentLibraryRecord('focus_area', RECORD_ID, {}, {}, 5);
			// A schema MAY carry a primitive field of its own called `position` — Apex
			// permits `:position` at the root beside the field names, so the two share a
			// key. An unpassed ordering must not clobber the field: spreading a bare
			// `position` would write `undefined` over it and JSON.stringify would then
			// drop the field entirely, silently discarding a value the editor typed.
			await client.updateContentLibraryRecord('focus_area', RECORD_ID, { position: 'third' });
			await client.updateContentLibraryRecord(
				'focus_area',
				RECORD_ID,
				{ position: 'third' },
				{},
				7
			);
			assert.equal('position' in bodies[0], false);
			assert.equal(bodies[1].position, null);
			assert.equal(bodies[2].position, 5);
			assert.equal(bodies[3].position, 'third', 'an unpassed ordering leaves the field alone');
			assert.equal(bodies[4].position, 7, 'an explicit ordering wins');
		});

		it('refuses a position that is not an integer', async () => {
			const apex = apexWithPosition({ id: RECORD_ID, updated_at: 'then' });
			const ctx = ctxWith(apex);
			for (const value of [1.5, '2', true]) {
				const response = await handleUpdateRecord(
					patch(await signIn(ctx), { position: value }),
					ctx,
					{
						schema: 'focus_area',
						recordId: RECORD_ID
					}
				);
				assert.equal(response.status, 400, `position ${JSON.stringify(value)} is refused`);
			}
			assert.equal(apex.writes.length, 0);
		});
	});
});
