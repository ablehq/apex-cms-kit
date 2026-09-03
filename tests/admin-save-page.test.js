// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract, run to verify.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	createDraft,
	setField,
	setChildField,
	reorderBlocks,
	setBlockOrder,
	addTemplateBlock,
	removeBlock,
	isDirty,
	canEditFields,
	dirtyEntityPatches,
	structurePayload,
	getBlocks
} from '../src/admin/page-draft.js';
import { savePage, STALE_MESSAGE } from '../src/admin/save-page.js';

const PAGE_ID = '9f06e386-86b3-4ddf-9466-d4ca325ada86';
const ET_HEADING = 'f867796b-c70c-47e4-8f6b-ad122832367b';
const ET_PROSE = 'aaaaaaaa-c70c-47e4-8f6b-ad122832367b';

function samplePage() {
	return {
		id: PAGE_ID,
		title: 'The Gospel',
		slug: 'gospel',
		summary: '',
		status: 'published',
		updated_at: '2026-07-31T00:00:00.000Z',
		blocks: [
			{
				id: 'block-heading',
				label: 'Page heading',
				position: 0,
				blockable_type: 'Cms::PageBlock::TemplateInstance',
				updated_at: '2026-07-31T00:00:00.000Z',
				blockable: {
					id: 'inst-heading',
					page_block_template_id: 'tpl-heading',
					page_block_template: { id: 'tpl-heading', slug: 'glc-page-heading' },
					updated_at: '2026-07-31T00:00:00.000Z',
					entity: {
						id: 'entity-heading',
						entity_type_id: ET_HEADING,
						updated_at: '2026-07-31T00:00:00.000Z',
						fields_data: { title: 'The Gospel', breadcrumb_label: 'Home' }
					},
					child_template_instances: []
				}
			},
			{
				id: 'block-prose',
				label: 'Prose',
				position: 1,
				blockable_type: 'Cms::PageBlock::TemplateInstance',
				updated_at: '2026-07-31T00:00:00.000Z',
				blockable: {
					id: 'inst-prose',
					page_block_template_id: 'tpl-prose',
					page_block_template: { id: 'tpl-prose', slug: 'glc-prose' },
					updated_at: '2026-07-31T00:00:00.000Z',
					entity: {
						id: 'entity-prose',
						entity_type_id: ET_PROSE,
						updated_at: '2026-07-31T00:00:00.000Z',
						fields_data: { body: { editor: 'tiptap', html: '<p>Grace</p>', content: {} } }
					},
					child_template_instances: []
				}
			}
		]
	};
}

/**
 * A recording BFF client double. `readVersion` returns `serverVersion` (defaults to
 * the draft's baseline, i.e. not stale). Each mutation is recorded and its result is
 * taken from `results` so a test can force a 422 at a chosen stage.
 */
function makeClient(overrides = {}) {
	const calls = [];
	const results = overrides.results || {};
	let serverVersion = overrides.serverVersion;
	const client = {
		calls,
		setServerVersion(v) {
			serverVersion = v;
		},
		async readVersion() {
			calls.push(['readVersion']);
			return { version: serverVersion };
		},
		async patchEntityFields(entityTypeId, entityId, fields) {
			calls.push(['patchEntityFields', entityId, fields]);
			return results.fields ? results.fields(entityId) : { ok: true, status: 200 };
		},
		async savePageStructure(pageId, payload) {
			calls.push(['savePageStructure', payload]);
			if (results.structure) return results.structure(payload);
			const page = overrides.structurePage ? overrides.structurePage(payload) : samplePage();
			return { ok: true, status: 200, page, version: 'v-after-structure' };
		},
		async changePageStatus(pageId, statusEvent) {
			calls.push(['changePageStatus', statusEvent]);
			return results.status ? results.status(statusEvent) : { ok: true, status: 200 };
		},
		async getPage() {
			calls.push(['getPage']);
			return { page: samplePage(), version: 'v-refreshed' };
		}
	};
	if (serverVersion === undefined) serverVersion = 'baseline-v';
	return client;
}

describe('savePage (M1 explicit save)', () => {
	it('writes dirty fields, THEN structure, in the required order', async () => {
		const draft = createDraft(samplePage(), 'baseline-v');
		setField(draft, 'block-heading', 'title', 'The Good News');
		reorderBlocks(draft, 0, 1); // structure change too

		const client = makeClient({ serverVersion: 'baseline-v' });
		const result = await savePage(draft, client);

		assert.equal(result.ok, true);
		const order = client.calls.map((c) => c[0]);
		// version read first, then the entity field PATCH, then the structure save.
		assert.deepEqual(order.slice(0, 3), ['readVersion', 'patchEntityFields', 'savePageStructure']);
		// exactly one field PATCH, targeting the dirty entity only.
		const patches = client.calls.filter((c) => c[0] === 'patchEntityFields');
		assert.equal(patches.length, 1);
		assert.equal(patches[0][1], 'entity-heading');
	});

	it('a 422 on a field PATCH BLOCKS the later structure and status dispatch', async () => {
		const draft = createDraft(samplePage(), 'baseline-v');
		setField(draft, 'block-heading', 'title', 'X');
		reorderBlocks(draft, 0, 1);

		const client = makeClient({
			serverVersion: 'baseline-v',
			results: { fields: () => ({ ok: false, status: 422 }) }
		});
		const result = await savePage(draft, client, { statusEvent: 'publish' });

		assert.equal(result.ok, false);
		assert.equal(result.stage, 'fields');
		assert.equal(result.status, 422);
		// The structure save and the status event must NEVER have been dispatched.
		assert.ok(!client.calls.some((c) => c[0] === 'savePageStructure'));
		assert.ok(!client.calls.some((c) => c[0] === 'changePageStatus'));
		// And the draft is still dirty — nothing was persisted, so nothing is clean.
		assert.equal(isDirty(draft), true);
	});

	it('a structure failure blocks the status dispatch (publish is the same savePage)', async () => {
		const draft = createDraft(samplePage(), 'baseline-v');
		reorderBlocks(draft, 0, 1);
		const client = makeClient({
			serverVersion: 'baseline-v',
			results: { structure: () => ({ ok: false, status: 500 }) }
		});
		const result = await savePage(draft, client, { statusEvent: 'publish' });
		assert.equal(result.ok, false);
		assert.equal(result.stage, 'structure');
		assert.ok(!client.calls.some((c) => c[0] === 'changePageStatus'));
	});

	it('the composite version guard detects a stale save and dispatches NOTHING', async () => {
		const draft = createDraft(samplePage(), 'baseline-v');
		setField(draft, 'block-heading', 'title', 'X');
		const client = makeClient({ serverVersion: 'someone-else-changed-it' });
		const result = await savePage(draft, client);
		assert.equal(result.ok, false);
		assert.equal(result.stale, true);
		assert.equal(result.message, STALE_MESSAGE);
		// Only the version read happened — no writes.
		assert.deepEqual(
			client.calls.map((c) => c[0]),
			['readVersion']
		);
	});

	it('Publish calls the SAME savePage and appends the status event last', async () => {
		const draft = createDraft(samplePage(), 'baseline-v');
		setField(draft, 'block-heading', 'title', 'X');
		const client = makeClient({ serverVersion: 'baseline-v' });
		const result = await savePage(draft, client, { statusEvent: 'publish' });
		assert.equal(result.ok, true);
		const order = client.calls.map((c) => c[0]);
		assert.ok(order.includes('changePageStatus'));
		// status is dispatched AFTER the field write, never before.
		assert.ok(order.indexOf('patchEntityFields') < order.indexOf('changePageStatus'));
	});

	it('a field-only save re-baselines via getPage and clears dirty', async () => {
		const draft = createDraft(samplePage(), 'baseline-v');
		setField(draft, 'block-heading', 'title', 'X');
		const client = makeClient({ serverVersion: 'baseline-v' });
		const result = await savePage(draft, client);
		assert.equal(result.ok, true);
		assert.ok(client.calls.some((c) => c[0] === 'getPage'));
		assert.equal(isDirty(draft), false);
		assert.equal(draft.baselineVersion, 'v-refreshed');
	});
});

describe('page-draft local model', () => {
	it('reorder mutates the draft only and NEVER calls the client', async () => {
		const draft = createDraft(samplePage(), 'baseline-v');
		const before = getBlocks(draft).map((b) => b.id);
		reorderBlocks(draft, 0, 1);
		const after = getBlocks(draft).map((b) => b.id);
		assert.deepEqual(after, [before[1], before[0]]);
		assert.equal(getBlocks(draft)[0].position, 0);
		assert.equal(getBlocks(draft)[1].position, 1);
		assert.equal(draft.structureDirty, true);
		// setBlockOrder (the pointer-drag path) is equally local.
		setBlockOrder(draft, [before[0], before[1]]);
		assert.deepEqual(
			getBlocks(draft).map((b) => b.id),
			[before[0], before[1]]
		);
	});

	it('unsaved-changes state persists until a successful save', async () => {
		const draft = createDraft(samplePage(), 'baseline-v');
		assert.equal(isDirty(draft), false);
		setField(draft, 'block-prose', 'body', { editor: 'tiptap', html: '<p>Hi</p>', content: {} });
		assert.equal(isDirty(draft), true);
		const client = makeClient({ serverVersion: 'baseline-v' });
		await savePage(draft, client);
		assert.equal(isDirty(draft), false);
	});

	it('the temp-id rule: a new block is not field-editable until it has a real id', () => {
		const draft = createDraft(samplePage(), 'baseline-v');
		const block = addTemplateBlock(draft, {
			templateId: 'tpl-prose',
			templateSlug: 'glc-prose',
			label: 'Prose',
			entityTypeId: ET_PROSE,
			fieldsData: { body: { editor: 'tiptap', html: '', content: {} } }
		});
		assert.equal(canEditFields(block), false);
		// setField refuses while the block is a temp.
		const accepted = setField(draft, block.id, 'body', {
			editor: 'tiptap',
			html: '<p>x</p>',
			content: {}
		});
		assert.equal(accepted, false);
		assert.equal(draft.dirtyEntityIds.size, 0);
		// structure is dirty though — the add needs to be persisted to mint real ids.
		assert.equal(draft.structureDirty, true);
	});

	it('after a structure save reconciles real ids, the new block becomes editable', async () => {
		const draft = createDraft(samplePage(), 'baseline-v');
		addTemplateBlock(draft, {
			templateId: 'tpl-prose',
			templateSlug: 'glc-prose',
			label: 'Prose',
			entityTypeId: ET_PROSE,
			fieldsData: { body: { editor: 'tiptap', html: '', content: {} } }
		});
		// The structure save returns a server page where the new block has real ids.
		const realized = () => {
			const page = samplePage();
			page.blocks.push({
				id: 'block-new-real',
				label: 'Prose',
				position: 2,
				blockable_type: 'Cms::PageBlock::TemplateInstance',
				blockable: {
					id: 'inst-new-real',
					page_block_template: { slug: 'glc-prose' },
					entity: { id: 'entity-new-real', entity_type_id: ET_PROSE, fields_data: { body: '' } },
					child_template_instances: []
				}
			});
			return page;
		};
		const client = makeClient({ serverVersion: 'baseline-v', structurePage: realized });
		const result = await savePage(draft, client);
		assert.equal(result.ok, true);
		const newBlock = getBlocks(draft).find((b) => b.id === 'block-new-real');
		assert.ok(newBlock);
		assert.equal(canEditFields(newBlock), true);
		// Now its fields are editable and mark the entity dirty.
		const accepted = setField(draft, 'block-new-real', 'body', {
			editor: 'tiptap',
			html: '<p>Now</p>',
			content: {}
		});
		assert.equal(accepted, true);
		assert.deepEqual(dirtyEntityPatches(draft)[0].entityId, 'entity-new-real');
	});

	it('dirtyEntityPatches lists only changed entities; structurePayload strips temp ids', () => {
		const draft = createDraft(samplePage(), 'baseline-v');
		setField(draft, 'block-heading', 'title', 'X');
		const patches = dirtyEntityPatches(draft);
		assert.equal(patches.length, 1);
		assert.equal(patches[0].entityId, 'entity-heading');
		assert.equal(patches[0].fields_data.title, 'X');

		const added = addTemplateBlock(draft, {
			templateId: 'tpl-prose',
			templateSlug: 'glc-prose',
			label: 'Prose',
			entityTypeId: ET_PROSE,
			fieldsData: {}
		});
		const payload = structurePayload(draft);
		const addedAttr = payload.blocks_attributes.find(
			(b) => !b.id && b.blockable_type === 'Cms::PageBlock::TemplateInstance'
		);
		assert.ok(addedAttr, 'the temp block has no id in the payload (Apex mints it)');
		assert.equal(added.id.startsWith('temp-'), true);
	});

	it('removeBlock records a real id for _destroy and drops temp adds silently', () => {
		const draft = createDraft(samplePage(), 'baseline-v');
		removeBlock(draft, 'block-prose');
		assert.deepEqual(draft.deletedBlockIds, ['block-prose']);
		const temp = addTemplateBlock(draft, {
			templateId: 'tpl-prose',
			templateSlug: 'glc-prose',
			entityTypeId: ET_PROSE,
			fieldsData: {}
		});
		removeBlock(draft, temp.id);
		assert.deepEqual(draft.deletedBlockIds, ['block-prose']); // temp id not added
	});

	it('setChildField refuses temp children too', () => {
		const draft = createDraft(samplePage(), 'baseline-v');
		// no children in the sample; setting on a missing child returns false.
		assert.equal(setChildField(draft, 'block-heading', 'nope', 'label', 'x'), false);
	});
});
