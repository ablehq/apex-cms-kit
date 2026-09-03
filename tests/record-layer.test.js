// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasManyDiff, countReferencesTo } from '../src/server/bff/operations/record-shape.ts';
import { handleDeleteRecord } from '../src/server/bff/operations/delete-record.ts';
import { createApexAdminClient } from '../src/server/bff/apex-admin-client.ts';
import { createSessionSecret, sessionIdFor } from '../src/server/bff/session.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { createMemorySessionStore } from './harness/session-store.ts';

const ORIGIN = 'https://site.test';
const CSRF = 'csrf-record';

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
	schemas: () => ['focus_area', 'partner', 'story'].map((slug) => contract.schema(slug)),
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
