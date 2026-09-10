// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	handleSavePageStructure,
	structureValueFields
} from '../src/server/bff/operations/save-page-structure.ts';
import {
	MAX_FIELD_VALUE_CHARS,
	oversizedFieldNames,
	residualReferenceFieldNames
} from '../src/sanitize/write-boundary.ts';
import { createSessionSecret, sessionIdFor } from '../src/server/bff/session.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { createMemorySessionStore } from './harness/session-store.ts';

/**
 * The structure save was the ONE write path in the BFF with no ceiling, no URL judge
 * and no value sanitizer. `patch-entity-fields`, `create-entity`, `create-record`,
 * `update-record`, `create-post`, `update-post-archetype` and `save-post-body` all run
 * the same three rules over caller-supplied values; this route ran none of them,
 * because `blocks_attributes` is a passthrough `z.array(jsonRecord)` and the two walks
 * it already had were both about KEYS (review-only fields, and id ownership).
 *
 * These tests pin all three. Each was checked against the mutation that removes the
 * rule it covers, and each goes RED — see the commit message for the exact set.
 */

const ORIGIN = 'https://site.test';
const CSRF = 'csrf-write-boundary';
const PAGE = '8f14e45f-ceea-467a-9a3c-3f1a7c9d2b55';
const IDS = {
	block: 'a1000000-0000-4000-8000-000000000001',
	inst: 'a1000000-0000-4000-8000-000000000002',
	entity: 'a1000000-0000-4000-8000-000000000003',
	richBlock: 'a1000000-0000-4000-8000-000000000006',
	richBlockable: 'a1000000-0000-4000-8000-000000000007',
	meta: 'a1000000-0000-4000-8000-000000000008'
};
const ENTITY_TYPE = 'c3000000-0000-4000-8000-000000000002';

function page() {
	return {
		id: PAGE,
		title: 'A',
		slug: 'a',
		meta_properties: [{ id: IDS.meta, name: 'title', group: 'web', value: 'A' }],
		blocks: [
			{
				id: IDS.block,
				position: 0,
				blockable_type: 'Cms::PageBlock::TemplateInstance',
				blockable: {
					id: IDS.inst,
					entity: { id: IDS.entity, entity_type_id: ENTITY_TYPE, fields_data: { headline: 'A' } },
					child_template_instances: []
				}
			},
			{
				id: IDS.richBlock,
				position: 1,
				blockable_type: 'Cms::PageBlock::RichText',
				blockable: { id: IDS.richBlockable, content_html: '<p>A</p>' }
			}
		]
	};
}

/** A payload naming only ids the page owns, so ownership never fires and the value rules do. */
function body(overrides = {}) {
	return {
		title: 'A',
		slug: 'a',
		blocks_attributes: [
			{
				id: IDS.richBlock,
				position: 0,
				blockable_type: 'Cms::PageBlock::RichText',
				blockable_attributes: {
					id: IDS.richBlockable,
					content_html: overrides.contentHtml ?? '<p>A, edited</p>'
				}
			},
			{
				id: IDS.block,
				position: 1,
				blockable_type: 'Cms::PageBlock::TemplateInstance',
				blockable_attributes: {
					id: IDS.inst,
					entity_attributes: {
						id: IDS.entity,
						property_set_attributes: {
							info: overrides.info ?? { headline: 'A, edited' }
						}
					}
				}
			}
		],
		meta_properties_attributes: [{ id: IDS.meta, name: 'title', group: 'web', value: 'A!' }]
	};
}

function ctxWith(calls) {
	const apex = {
		async getPage(id) {
			calls.push(['getPage', id]);
			return { ok: true, status: 200, body: { data: page() } };
		},
		async updatePageStructure(id, sent) {
			calls.push(['updatePageStructure', id, sent]);
			return { ok: true, status: 200, body: { data: page() } };
		}
	};
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
		reviewOnlyFields: ['transcript_reviewed']
	};
}

async function save(sendBody) {
	const calls = [];
	const ctx = ctxWith(calls);
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
	const request = new Request(`${ORIGIN}/api/admin/pages/${PAGE}/structure`, {
		method: 'PATCH',
		headers: {
			origin: ORIGIN,
			'sec-fetch-site': 'same-origin',
			'content-type': 'application/json',
			'x-csrf-token': CSRF,
			cookie: `apex_bff_csrf=${CSRF}; apex_admin_session=${secret}`
		},
		body: JSON.stringify(sendBody)
	});
	const res = await handleSavePageStructure(request, ctx, { pageId: PAGE });
	return { res, patches: calls.filter(([name]) => name === 'updatePageStructure') };
}

describe('structureValueFields', () => {
	it('keys every value by its PATH, so a refusal names the block', () => {
		const values = structureValueFields(body());
		assert.equal(
			values['blocks_attributes[0].blockable_attributes.content_html'],
			'<p>A, edited</p>'
		);
		assert.equal(values['meta_properties_attributes[0].value'], 'A!');
	});

	it('measures a field bag ENTRY BY ENTRY, so a structured field value is measured whole', () => {
		const delta = { ops: [{ insert: 'hello' }] };
		const values = structureValueFields(body({ info: { headline: 'H', rich: delta } }));
		const base =
			'blocks_attributes[1].blockable_attributes.entity_attributes.property_set_attributes.info';
		assert.equal(values[`${base}.headline`], 'H');
		assert.deepEqual(
			values[`${base}.rich`],
			delta,
			'the whole structured value, not its leaves — this is how `patch-entity-fields` measures one `fields_data` entry'
		);
	});

	it('records a string sitting inside an ARRAY', () => {
		const values = structureValueFields({
			blocks_attributes: [
				{ blockable_attributes: { group_member_template_instance_ids: ['x', 'yy'] } }
			]
		});
		assert.equal(
			values['blocks_attributes[0].blockable_attributes.group_member_template_instance_ids[1]'],
			'yy'
		);
	});

	it('does NOT measure a whole block as one value — no other write path imposes that', () => {
		const values = structureValueFields(body());
		assert.ok(
			!('blocks_attributes[0]' in values),
			'a legitimately long page must not trip a ceiling its siblings would not'
		);
	});
});

describe('the structure save runs the write boundary', () => {
	it('refuses an oversized content_html BY PATH, and writes nothing', async () => {
		const sent = body({ contentHtml: `<p>${'x'.repeat(MAX_FIELD_VALUE_CHARS)}</p>` });
		const { res, patches } = await save(sent);
		assert.equal(res.status, 400);
		const payload = await res.json();
		assert.equal(payload.error, 'field-too-large');
		assert.equal(patches.length, 0, 'refused BEFORE Apex — no partial write');
		// WHERE THE FIELD NAME ACTUALLY GOES. `bffError` puts only the code in the
		// response body, so `refuseOversizedFields`' reason string — the half that names
		// the offending field — reaches the AUDIT ROW and not the editor. That is true of
		// all seven write paths in this kit, not something this route does differently,
		// so it is pinned here as it is and logged as its own issue rather than changed
		// under a cutover. What this asserts is that the name computed for that reason is
		// the full path, not a bare `content_html` repeated across 200 blocks.
		assert.deepEqual(oversizedFieldNames(structureValueFields(sent)), [
			'blocks_attributes[0].blockable_attributes.content_html'
		]);
	});

	it('refuses an oversized field inside a nested entity, by its path', async () => {
		const sent = body({ info: { headline: 'x'.repeat(MAX_FIELD_VALUE_CHARS + 1) } });
		const { res, patches } = await save(sent);
		assert.equal(res.status, 400);
		assert.equal((await res.json()).error, 'field-too-large');
		assert.equal(patches.length, 0);
		assert.deepEqual(oversizedFieldNames(structureValueFields(sent)), [
			'blocks_attributes[1].blockable_attributes.entity_attributes.property_set_attributes.info.headline'
		]);
	});

	it('accepts a value exactly ON the ceiling (the boundary is not off by one)', async () => {
		const { res, patches } = await save(
			body({ info: { headline: 'x'.repeat(MAX_FIELD_VALUE_CHARS) } })
		);
		assert.equal(res.status, 200);
		assert.equal(patches.length, 1);
	});

	it('refuses a URL the judge cannot read, by name, rather than silently dropping it', async () => {
		const sent = body({ contentHtml: '<a href="?x=1&#2024">t</a>' });
		const { res, patches } = await save(sent);
		assert.equal(res.status, 400);
		const payload = await res.json();
		assert.equal(payload.error, 'unreadable-url');
		assert.equal(patches.length, 0);
		assert.deepEqual(residualReferenceFieldNames(structureValueFields(sent)), [
			'blocks_attributes[0].blockable_attributes.content_html'
		]);
	});

	it('sanitizes content_html before Apex sees it', async () => {
		const { res, patches } = await save(
			body({ contentHtml: '<p>ok<script>alert(1)</script><img src=x onerror=alert(2)></p>' })
		);
		assert.equal(res.status, 200);
		const sent = patches[0][2];
		const html = sent.blocks_attributes[0].blockable_attributes.content_html;
		assert.ok(!html.includes('<script'), `script survived: ${html}`);
		assert.ok(!/onerror/i.test(html), `event attribute survived: ${html}`);
		assert.ok(html.includes('ok'), 'the editor’s own text is kept');
	});

	it('sanitizes a nested entity field too, not just the rich-text column', async () => {
		const { patches } = await save(
			body({ info: { headline: '<img src=x onerror=alert(1)>Hello' } })
		);
		const info =
			patches[0][2].blocks_attributes[1].blockable_attributes.entity_attributes
				.property_set_attributes.info;
		assert.ok(!/onerror/i.test(info.headline), `event attribute survived: ${info.headline}`);
		assert.ok(info.headline.includes('Hello'));
	});

	it('leaves an honest payload alone — ids, positions and clean markup pass through', async () => {
		const sendBody = body();
		const { res, patches } = await save(sendBody);
		assert.equal(res.status, 200);
		const sent = patches[0][2];
		assert.equal(sent.blocks_attributes[0].id, IDS.richBlock);
		assert.equal(sent.blocks_attributes[0].position, 0);
		assert.equal(
			sent.blocks_attributes[0].blockable_attributes.content_html,
			'<p>A, edited</p>',
			'clean markup is byte-identical'
		);
		assert.equal(sent.title, 'A');
		assert.equal(sent.meta_properties_attributes[0].value, 'A!');
	});
});
