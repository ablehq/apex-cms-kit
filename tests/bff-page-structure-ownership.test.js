// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	collectPageIds,
	findForeignId,
	handleSavePageStructure
} from '../src/server/bff/operations/save-page-structure.ts';
import { createSessionSecret, sessionIdFor } from '../src/server/bff/session.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { createMemorySessionStore } from './harness/session-store.ts';

const ORIGIN = 'https://site.test';
const CSRF = 'csrf-ownership';
const PAGE_A = '8f14e45f-ceea-467a-9a3c-3f1a7c9d2b55';

// Page A's tree, as `GET /cms/pages/:id` returns it.
const A = {
	block: 'a1000000-0000-4000-8000-000000000001',
	inst: 'a1000000-0000-4000-8000-000000000002',
	entity: 'a1000000-0000-4000-8000-000000000003',
	child: 'a1000000-0000-4000-8000-000000000004',
	childEntity: 'a1000000-0000-4000-8000-000000000005',
	richBlock: 'a1000000-0000-4000-8000-000000000006',
	richBlockable: 'a1000000-0000-4000-8000-000000000007',
	meta: 'a1000000-0000-4000-8000-000000000008',
	displayMeta: 'a1000000-0000-4000-8000-000000000009'
};
// Page B's ids — never in A's tree.
const B = {
	block: 'b2000000-0000-4000-8000-000000000001',
	richBlockable: 'b2000000-0000-4000-8000-000000000007',
	inst: 'b2000000-0000-4000-8000-000000000002'
};
const TEMPLATE = 'c3000000-0000-4000-8000-000000000001';
const ENTITY_TYPE = 'c3000000-0000-4000-8000-000000000002';

function pageA() {
	return {
		id: PAGE_A,
		title: 'A',
		slug: 'a',
		meta_properties: [{ id: A.meta, name: 'title', group: 'web', value: 'A' }],
		blocks: [
			{
				id: A.block,
				position: 0,
				blockable_type: 'Cms::PageBlock::TemplateInstance',
				blockable: {
					id: A.inst,
					page_block_template: { id: TEMPLATE, slug: 'hero' },
					entity: { id: A.entity, entity_type_id: ENTITY_TYPE, fields_data: { headline: 'A' } },
					display_meta_properties: [{ id: A.displayMeta, name: 'theme', value: 'dark' }],
					child_template_instances: [
						{
							id: A.child,
							page_block_template: { id: TEMPLATE, slug: 'card' },
							entity: { id: A.childEntity, entity_type_id: ENTITY_TYPE, fields_data: {} }
						}
					]
				}
			},
			{
				id: A.richBlock,
				position: 1,
				blockable_type: 'Cms::PageBlock::RichText',
				blockable: { id: A.richBlockable, content_html: '<p>A</p>' }
			}
		]
	};
}

/** The editor's own payload for A: reorder, one edit, one add (no ids), one removal. */
function honestBody() {
	return {
		title: 'A',
		slug: 'a',
		summary: '',
		blocks_attributes: [
			{
				id: A.richBlock,
				position: 0,
				blockable_type: 'Cms::PageBlock::RichText',
				blockable_attributes: { id: A.richBlockable, content_html: '<p>A, edited</p>' },
				_destroy: false
			},
			{
				position: 1,
				blockable_type: 'Cms::PageBlock::TemplateInstance',
				blockable_attributes: {
					page_block_template_id: TEMPLATE,
					entity_attributes: { entity_type_id: ENTITY_TYPE }
				},
				_destroy: false
			},
			{
				id: A.block,
				position: 2,
				blockable_type: 'Cms::PageBlock::TemplateInstance',
				blockable_attributes: {
					id: A.inst,
					entity_attributes: { id: A.entity },
					child_template_instances_attributes: [
						{ id: A.child, entity_attributes: { id: A.childEntity } },
						{ id: A.child, _destroy: true }
					],
					parent_template_instance_id: null,
					group_member_template_instance_ids: [A.child]
				},
				_destroy: false
			}
		],
		meta_properties_attributes: [{ id: A.meta, name: 'title', group: 'web', value: 'A!' }]
	};
}

function apexStub(calls, page = pageA()) {
	return {
		async getPage(id) {
			calls.push(['getPage', id]);
			return { ok: true, status: 200, body: { data: page } };
		},
		async updatePageStructure(id, body) {
			calls.push(['updatePageStructure', id, body]);
			return { ok: true, status: 200, body: { data: page } };
		}
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
		createApexClient: () => apexStub(calls, page),
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
	return new Request(`${ORIGIN}/api/admin/pages/${PAGE_A}/structure`, {
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

async function save(body, page) {
	const calls = [];
	const ctx = ctxWith(calls, page);
	const session = await signIn(ctx);
	const res = await handleSavePageStructure(patch(session, body), ctx, { pageId: PAGE_A });
	return { res, calls, patches: calls.filter(([name]) => name === 'updatePageStructure') };
}

describe('collectPageIds / findForeignId', () => {
	it('collects every id in the tree — blocks, blockables, entities, children, both meta kinds', () => {
		const ids = collectPageIds(pageA());
		for (const id of Object.values(A)) assert.ok(ids.has(id), id);
		assert.ok(ids.has(PAGE_A));
		assert.ok(
			ids.has(TEMPLATE),
			'catalogue ids in the tree are collected too (harmless: not a row)'
		);
		for (const id of Object.values(B)) assert.ok(!ids.has(id), `B's ${id} is not in A's tree`);
	});

	it('an honest editor payload names nothing foreign', () => {
		assert.equal(findForeignId(honestBody(), collectPageIds(pageA())), null);
	});

	it('names the key that carried the foreign id', () => {
		const owned = collectPageIds(pageA());
		assert.deepEqual(findForeignId({ blocks_attributes: [{ id: B.block }] }, owned), { key: 'id' });
		assert.deepEqual(
			findForeignId({ blocks_attributes: [{ blockable_id: B.richBlockable }] }, owned),
			{ key: 'blockable_id' }
		);
		assert.deepEqual(
			findForeignId(
				{ blocks_attributes: [{ blockable_attributes: { parent_template_instance_id: B.inst } }] },
				owned
			),
			{ key: 'parent_template_instance_id' }
		);
		assert.deepEqual(
			findForeignId(
				{
					blocks_attributes: [
						{ blockable_attributes: { group_member_template_instance_ids: [A.child, B.inst] } }
					]
				},
				owned
			),
			{ key: 'group_member_template_instance_ids' }
		);
		assert.deepEqual(findForeignId({ meta_properties_attributes: [{ id: B.block }] }, owned), {
			key: 'id'
		});
		// A non-string id is foreign by definition.
		assert.deepEqual(findForeignId({ blocks_attributes: [{ id: 42 }] }, owned), { key: 'id' });
	});
});

describe('PATCH /pages/:id/structure — only this page’s rows', () => {
	it('an honest reorder / edit / add / remove passes, after ONE fresh read', async () => {
		const { res, calls, patches } = await save(honestBody());
		assert.equal(res.status, 200, await res.clone().text());
		assert.deepEqual(
			calls.map(([name]) => name),
			['getPage', 'updatePageStructure'],
			'the page is read fresh, then written once'
		);
		assert.equal(patches[0][1], PAGE_A);
	});

	const foreign = [
		{
			name: "page B's block id",
			key: 'id',
			mutate: (body) => {
				body.blocks_attributes[0].id = B.block;
			}
		},
		{
			name: "page B's rich-text blockable, by blockable_id + nested content (codex's live repro)",
			key: 'blockable_id',
			mutate: (body) => {
				body.blocks_attributes.push({
					position: 3,
					blockable_type: 'Cms::PageBlock::RichText',
					blockable_id: B.richBlockable,
					blockable_attributes: { id: B.richBlockable, content_html: '<p>rewritten</p>' },
					_destroy: false
				});
			}
		},
		{
			name: "page B's template instance as a parent",
			key: 'parent_template_instance_id',
			mutate: (body) => {
				body.blocks_attributes[2].blockable_attributes.parent_template_instance_id = B.inst;
			}
		},
		{
			name: "page B's instance among group members",
			key: 'group_member_template_instance_ids',
			mutate: (body) => {
				body.blocks_attributes[2].blockable_attributes.group_member_template_instance_ids = [
					B.inst
				];
			}
		},
		{
			name: "page B's rich-text blockable nested under an honest block",
			key: 'id',
			mutate: (body) => {
				body.blocks_attributes[0].blockable_attributes.id = B.richBlockable;
			}
		},
		{
			name: "page B's row destroyed through A",
			key: 'id',
			mutate: (body) => {
				body.blocks_attributes.push({ id: B.block, _destroy: true });
			}
		},
		{
			name: "another page's meta property",
			key: 'id',
			mutate: (body) => {
				body.meta_properties_attributes[0].id = B.block;
			}
		}
	];

	for (const testCase of foreign) {
		it(`${testCase.name} → 400 block not on this page, ZERO writes`, async () => {
			const body = honestBody();
			testCase.mutate(body);
			const { res, patches } = await save(body);
			assert.equal(res.status, 400);
			assert.deepEqual(await res.json(), { error: 'block not on this page' });
			assert.equal(patches.length, 0, 'nothing reached Apex');
		});
	}

	it('the review-only walk still runs first', async () => {
		const body = honestBody();
		body.blocks_attributes[0].id = B.block;
		body.blocks_attributes[1].blockable_attributes.entity_attributes.fields_data = {
			transcript_reviewed: true
		};
		const { res, patches } = await save(body);
		assert.equal(res.status, 400);
		assert.deepEqual(await res.json(), { error: 'field not allowed' });
		assert.equal(patches.length, 0);
	});

	it('a page that will not read is 502, and nothing is written', async () => {
		const calls = [];
		const ctx = ctxWith(calls);
		ctx.createApexClient = () => ({
			async getPage() {
				calls.push(['getPage']);
				return { ok: false, status: 500, body: null };
			},
			async updatePageStructure() {
				calls.push(['updatePageStructure']);
				return { ok: true, status: 200, body: {} };
			}
		});
		const session = await signIn(ctx);
		const res = await handleSavePageStructure(patch(session, honestBody()), ctx, {
			pageId: PAGE_A
		});
		assert.equal(res.status, 502);
		assert.deepEqual(
			calls.map(([n]) => n),
			['getPage']
		);
	});
});
