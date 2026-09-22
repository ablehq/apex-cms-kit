// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract, run to verify.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
	createDraft,
	setField,
	setChildField,
	reorderBlocks,
	setBlockOrder,
	addTemplateBlock,
	addSpacerBlock,
	setSpacerKind,
	addCollectionBlock,
	addListChild,
	addBundleEntity,
	removeBundleEntity,
	moveBundleEntity,
	setBundleEntityField,
	newBundleEntities,
	isBundleBlock,
	removeListChild,
	moveListChild,
	setListChildField,
	adoptListChildId,
	newListChildren,
	editedListChildren,
	listChildRows,
	reconcile,
	setCollectionItemCount,
	setCollectionSource,
	COLLECTION_KINDS,
	isCollectionBlock,
	removeBlock,
	isDirty,
	canEditFields,
	dirtyEntityPatches,
	structurePayload,
	getBlocks
} from '../src/admin/page-draft.js';
import { isTempId } from '../src/admin/block-serialize.js';
import { savePage, STALE_MESSAGE } from '../src/admin/save-page.js';
import { BLANK_SLUG_MESSAGE, RESERVED_SLUG_MESSAGE } from '../src/admin/field-errors.js';

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
			// After a structure save the server HOLDS the minted block, so a re-read
			// answers the realized page, the way Apex would.
			const page = overrides.structurePage ? overrides.structurePage() : samplePage();
			return { page, version: 'v-refreshed' };
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

	/**
	 * K41 / K67, the editor-facing half. `save-page-structure.ts` refuses a rename
	 * onto a route the site generates, onto the chrome or onto the home page with
	 * `400 reserved-slug` — the human reason goes to the audit table and only the
	 * CODE comes back to the browser (`bff-client.js`'s `mutate` spreads the body,
	 * then pins `ok`/`status`, so `result.error` is on the object `messageFor`
	 * gets). Without a branch on that code the editor is told "Saving the page
	 * layout failed. Save again to retry." — a sentence about the layout, naming
	 * neither the slug nor the address, advising a retry that can never succeed.
	 *
	 * MUTATION (run): drop the `result?.error === 'reserved-slug'` branch from
	 * `messageFor` → this test goes RED.
	 */
	it('a refused slug is reported as the create form reports it, not as a layout failure', async () => {
		const draft = createDraft(samplePage(), 'baseline-v');
		reorderBlocks(draft, 0, 1);
		const client = makeClient({
			serverVersion: 'baseline-v',
			results: { structure: () => ({ ok: false, status: 400, error: 'reserved-slug' }) }
		});
		const result = await savePage(draft, client);
		assert.equal(result.ok, false);
		assert.equal(result.stage, 'structure');
		assert.equal(result.status, 400);
		// The SAME sentence `pageCreateError` / `PageList.svelte` show for the same
		// refusal — one rule, one wording, shared from `field-errors.js`.
		assert.equal(result.message, RESERVED_SLUG_MESSAGE);
		assert.doesNotMatch(result.message, /Save again to retry/u);
	});

	/**
	 * The OTHER address refusal (codex F3). `save-page-structure.ts` answers
	 * `400 invalid-slug` when the slug sent is blank — what an editor produces by
	 * clearing the Slug field, which no site's input marks `required`. Until it had
	 * its own code it was the schema's `400 invalid body`, and this mapper could
	 * only report it as "Saving the page layout failed. Save again to retry.": the
	 * layout named for a failure of the address, and a retry that cannot succeed.
	 *
	 * It is NOT `RESERVED_SLUG_MESSAGE`: "choose a different one" is no instruction
	 * for a field with nothing in it.
	 *
	 * MUTATION (run): drop the `result?.error === 'invalid-slug'` branch from
	 * `messageFor` → this test goes RED with the retry sentence.
	 */
	it('a cleared slug is named as a missing address, not as a layout failure', async () => {
		const draft = createDraft(samplePage(), 'baseline-v');
		reorderBlocks(draft, 0, 1);
		const client = makeClient({
			serverVersion: 'baseline-v',
			results: { structure: () => ({ ok: false, status: 400, error: 'invalid-slug' }) }
		});
		const result = await savePage(draft, client);
		assert.equal(result.ok, false);
		assert.equal(result.stage, 'structure');
		assert.equal(result.status, 400);
		assert.equal(result.message, BLANK_SLUG_MESSAGE);
		assert.notEqual(result.message, RESERVED_SLUG_MESSAGE);
		assert.doesNotMatch(result.message, /Save again to retry/u);
	});

	it('any OTHER 400 on the structure save still reads as a layout failure', async () => {
		// The branch is on the code, not on the status: `invalid body`, `foreign id`
		// and the rest are 400s the editor cannot fix by choosing a new address.
		const draft = createDraft(samplePage(), 'baseline-v');
		reorderBlocks(draft, 0, 1);
		const client = makeClient({
			serverVersion: 'baseline-v',
			results: { structure: () => ({ ok: false, status: 400, error: 'invalid body' }) }
		});
		const result = await savePage(draft, client);
		assert.match(result.message, /Saving the page layout failed/u);
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

describe('a duplicated section — the fields the editor seeded on a temp entity', () => {
	/** The server page after the structure save: the new block minted at position 2. */
	function mintedPage() {
		const page = samplePage();
		page.blocks.push({
			id: 'block-new',
			label: 'Copy of heading',
			position: 2,
			blockable_type: 'Cms::PageBlock::TemplateInstance',
			blockable: {
				id: 'inst-new',
				page_block_template_id: 'tpl-heading',
				page_block_template: { id: 'tpl-heading', slug: 'glc-page-heading' },
				// Rails permits no `fields_data` under `entity_attributes`: minted EMPTY.
				entity: { id: 'entity-new', entity_type_id: ET_HEADING, fields_data: {} },
				child_template_instances: []
			}
		});
		return page;
	}
	const copied = { title: 'The Gospel', breadcrumb_label: 'Home' };

	it('saves the structure, then PATCHes the copied fields ONCE against the minted entity id', async () => {
		const client = makeClient({ structurePage: mintedPage });
		const draft = createDraft(samplePage(), 'baseline-v');
		addTemplateBlock(draft, {
			templateId: 'tpl-heading',
			templateSlug: 'glc-page-heading',
			label: 'Copy of heading',
			entityTypeId: ET_HEADING,
			fieldsData: { ...copied }
		});
		const result = await savePage(draft, client);
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.deepEqual(
			client.calls.map((c) => c[0]),
			['readVersion', 'savePageStructure', 'patchEntityFields', 'getPage'],
			'structure first, then the seeded fields, then a re-read for an honest baseline'
		);
		const patches = client.calls.filter((c) => c[0] === 'patchEntityFields');
		assert.equal(patches.length, 1);
		assert.equal(patches[0][1], 'entity-new', 'the id Apex minted, never the temp id');
		assert.deepEqual(patches[0][2], copied);
		assert.equal(draft.baselineVersion, 'v-refreshed');
		assert.equal(isDirty(draft), false);
	});

	it('a new block with no fields makes no extra PATCH', async () => {
		const client = makeClient({ structurePage: mintedPage });
		const draft = createDraft(samplePage(), 'baseline-v');
		addTemplateBlock(draft, {
			templateId: 'tpl-heading',
			templateSlug: 'glc-page-heading',
			label: 'Blank',
			entityTypeId: ET_HEADING,
			fieldsData: {}
		});
		assert.equal((await savePage(draft, client)).ok, true);
		assert.deepEqual(
			client.calls.map((c) => c[0]),
			['readVersion', 'savePageStructure'],
			"nothing to copy: no PATCH, and the structure save's page is baseline enough"
		);
	});

	it('a refused copy stops there — the section exists, its fields do not, and no publish goes out', async () => {
		const client = makeClient({
			structurePage: mintedPage,
			results: { fields: () => ({ ok: false, status: 422 }) }
		});
		const draft = createDraft(samplePage(), 'baseline-v');
		addTemplateBlock(draft, {
			templateId: 'tpl-heading',
			templateSlug: 'glc-page-heading',
			label: 'Copy',
			entityTypeId: ET_HEADING,
			fieldsData: { ...copied }
		});
		const result = await savePage(draft, client, { statusEvent: 'publish' });
		assert.equal(result.ok, false);
		assert.equal(result.stage, 'new-block-fields');
		assert.equal(result.status, 422);
		assert.match(result.message, /The new section was added, but its fields could not be saved/u);
		assert.ok(!client.calls.some((c) => c[0] === 'changePageStatus'), 'no publish after a failure');
	});
});

describe('generated listings (Cms::PageBlock::AutoCollection)', () => {
	/**
	 * The shape a SITE declares. Two sources, deliberately with different defaults, so
	 * a switch that forgets to adopt the new default is visible.
	 */
	const SOURCES = [
		{
			refName: 'team member',
			label: 'Team',
			defaultCount: 0,
			itemCount: 'none',
			aliases: ['member']
		},
		{ refName: 'story', label: 'Stories', defaultCount: 3, itemCount: 'count', minCount: 1 }
	];

	it('adds a listing from the list, taking its label and count FROM the source', () => {
		const draft = createDraft(samplePage(), 'baseline-v');
		const block = addCollectionBlock(draft, 'story', SOURCES);

		assert.equal(isCollectionBlock(block), true);
		assert.equal(block.id.startsWith('temp-'), true);
		assert.equal(block.label, 'Stories', 'the label comes from the source, not the caller');
		assert.equal(block.blockable.ref_name, 'story');
		assert.equal(block.blockable.item_count, 3);
		assert.equal(block.blockable.kind, 'archetype', 'Apex refuses a nil kind on the whole page');
		assert.equal(isTempId(block.blockable.id), true, 'the blockable carries a TEMP id');
		assert.equal(isDirty(draft), true);

		const attr = structurePayload(draft).blocks_attributes[block.position];
		assert.equal(Object.hasOwn(attr, 'id'), false);
		assert.equal(attr.blockable_type, 'Cms::PageBlock::AutoCollection');
		assert.deepEqual(attr.blockable_attributes, {
			kind: 'archetype',
			ref_name: 'story',
			item_count: 3,
			// What all nine live bands carry, and what the old admin's create path wrote.
			sort_expression: ['created_at desc']
		});
		assert.equal(attr._destroy, false);
	});

	it('REFUSES a source that is not in the list, and one the list half-declares', () => {
		// Apex validates `ref_name` not at all, so this list is the only guard there is.
		const draft = createDraft(samplePage(), 'baseline-v');
		assert.equal(addCollectionBlock(draft, 'invented', SOURCES), null);
		assert.equal(addCollectionBlock(draft, 'story', []), null);
		assert.equal(addCollectionBlock(draft, 'story', null), null);
		// A half-built entry would write a good ref_name beside a bad label/count.
		assert.equal(addCollectionBlock(draft, 'x', [{ refName: 'x', defaultCount: 1 }]), null);
		assert.equal(addCollectionBlock(draft, 'x', [{ refName: 'x', label: 'X' }]), null);
		assert.equal(getBlocks(draft).some(isCollectionBlock), false);
		assert.equal(isDirty(draft), false, 'a refusal must not dirty the draft');
	});

	it('keeps BOTH ids on an edited listing — the orphan-row mutation', () => {
		// Dropping the blockable id makes Rails build a new record and orphan the old
		// one, proven against real Apex in poovayya/tests/chrome-realapex.test.ts.
		const page = samplePage();
		page.blocks.push({
			id: 'b1',
			position: 2,
			label: 'Stories',
			blockable_type: 'Cms::PageBlock::AutoCollection',
			blockable: { id: 'c1', kind: 'archetype', ref_name: 'story', item_count: 3 }
		});
		const draft = createDraft(page, 'baseline-v');
		assert.equal(setCollectionItemCount(draft, 'b1', 6, SOURCES), true);

		const attr = structurePayload(draft).blocks_attributes.find((block) => block.id === 'b1');
		assert.equal(attr.id, 'b1', 'the BLOCK id survives');
		assert.equal(attr.blockable_attributes.id, 'c1', 'the BLOCKABLE id survives');
		assert.equal(attr.blockable_attributes.item_count, 6);
		assert.equal(attr.blockable_attributes.ref_name, 'story');
		// Without this the mutation "drop `structureDirty = true`" passes every test
		// while `savePage` skips the structure PATCH: Save looks fine and the number
		// reverts on reload. `structurePayload` serializes regardless of the flag.
		assert.equal(isDirty(draft), true, 'a count change must dirty the draft');
	});

	it('refuses a count below the source’s own floor', () => {
		// One site's loader reads `item_count || default`, so a stored 0 silently becomes
		// the default — a box that accepted 0 would say one thing and do another. The
		// other site means 0 literally, which is why the floor is per source, not global.
		const page = samplePage();
		page.blocks.push({
			id: 'coll',
			position: 2,
			blockable_type: 'Cms::PageBlock::AutoCollection',
			blockable: { id: 'c1', kind: 'archetype', ref_name: 'story', item_count: 3 }
		});
		const draft = createDraft(page, 'baseline-v');
		assert.equal(setCollectionItemCount(draft, 'coll', 0, SOURCES), false, 'below the floor');
		assert.equal(setCollectionItemCount(draft, 'coll', 1, SOURCES), true, 'at the floor');
		// A source with no floor takes 0: there it means "all of them".
		const noFloor = [{ refName: 'story', label: 'S', defaultCount: 0, itemCount: 'count' }];
		const other = createDraft(structuredClone(page), 'baseline-v');
		assert.equal(setCollectionItemCount(other, 'coll', 0, noFloor), true);
	});

	it('refuses a source list entry that does not say whether it takes a count', () => {
		// Required, because the screens read omission as "no control" and the mutation
		// read it as "counts are fine".
		const draft = createDraft(samplePage(), 'baseline-v');
		assert.equal(
			addCollectionBlock(draft, 'x', [{ refName: 'x', label: 'X', defaultCount: 1 }]),
			null
		);
		assert.equal(
			addCollectionBlock(draft, 'x', [
				{ refName: 'x', label: 'X', defaultCount: 1, itemCount: 'maybe' }
			]),
			null
		);
	});

	it('refuses a bad count, a non-listing block and a missing blockable', () => {
		const page = samplePage();
		page.blocks.push(
			{
				id: 'coll',
				position: 2,
				blockable_type: 'Cms::PageBlock::AutoCollection',
				blockable: { id: 'c1', kind: 'archetype', ref_name: 'story', item_count: 3 }
			},
			{
				id: 'headless',
				position: 3,
				blockable_type: 'Cms::PageBlock::AutoCollection',
				blockable: null
			}
		);
		const draft = createDraft(page, 'baseline-v');

		assert.equal(setCollectionItemCount(draft, 'coll', -1, SOURCES), false);
		assert.equal(setCollectionItemCount(draft, 'coll', 1.5, SOURCES), false);
		assert.equal(setCollectionItemCount(draft, 'coll', '3', SOURCES), false);
		assert.equal(setCollectionItemCount(draft, 'headless', 3, SOURCES), false);
		assert.equal(setCollectionItemCount(draft, 'missing', 3, SOURCES), false);
		assert.equal(setCollectionItemCount(draft, draft.page.blocks[0].id, 3, SOURCES), false);
		assert.equal(isDirty(draft), false, 'no refusal may dirty the draft');

		// A no-op is accepted and still does not dirty.
		assert.equal(setCollectionItemCount(draft, 'coll', 3, SOURCES), true);
		assert.equal(isDirty(draft), false);
	});

	it('switching a source rewrites ref_name, label AND item_count together', () => {
		// Writing only ref_name leaves the old name in both admins' outlines and carries
		// a count across a semantic boundary: on Poovayya a testimonials count of 6
		// switched to team members selects capped-grid mode where the live page shows a
		// search UI.
		const page = samplePage();
		page.blocks.push({
			id: 'b1',
			position: 2,
			label: 'Stories',
			blockable_type: 'Cms::PageBlock::AutoCollection',
			blockable: { id: 'c1', kind: 'archetype', ref_name: 'story', item_count: 6 }
		});
		const draft = createDraft(page, 'baseline-v');
		assert.equal(setCollectionSource(draft, 'b1', 'team member', SOURCES), true);

		const block = getBlocks(draft).find((candidate) => candidate.id === 'b1');
		assert.equal(block.blockable.ref_name, 'team member');
		assert.equal(block.label, 'Team', 'the outline name follows the source');
		assert.equal(block.blockable.item_count, 0, 'the count adopts the new default');
		assert.equal(block.blockable.id, 'c1', 'the row is updated, never replaced');
		assert.equal(isDirty(draft), true);
	});

	it('switching REFUSES an unlisted source and leaves every field alone', () => {
		const page = samplePage();
		page.blocks.push({
			id: 'b1',
			position: 2,
			label: 'Stories',
			blockable_type: 'Cms::PageBlock::AutoCollection',
			blockable: { id: 'c1', kind: 'archetype', ref_name: 'story', item_count: 6 }
		});
		const draft = createDraft(page, 'baseline-v');
		assert.equal(setCollectionSource(draft, 'b1', 'invented', SOURCES), false);
		assert.equal(setCollectionSource(draft, 'b1', 'story', [{ refName: 'story' }]), false);

		const block = getBlocks(draft).find((candidate) => candidate.id === 'b1');
		assert.equal(block.blockable.ref_name, 'story');
		assert.equal(block.label, 'Stories');
		assert.equal(block.blockable.item_count, 6);
		assert.equal(isDirty(draft), false);
	});

	it('REFUSES a kind Apex does not accept — the whole page save depends on it', () => {
		// `kind` is the ONE field Apex validates, and `validates_associated :blockable`
		// means a bad value 422s the entire page, not just this block.
		const draft = createDraft(samplePage(), 'baseline-v');
		assert.equal(addCollectionBlock(draft, 'story', SOURCES, { kind: 'not-a-kind' }), null);
		assert.equal(isDirty(draft), false, 'a refused kind must leave the draft alone');
		// An EMPTY kind is treated as "not given" and takes the default, which is valid:
		// falling back to a value Apex accepts cannot break a save, and refusing would
		// only turn a caller's sloppiness into a missing section.
		assert.equal(
			addCollectionBlock(draft, 'story', SOURCES, { kind: '' }).blockable.kind,
			'archetype'
		);
		// The three Apex accepts.
		for (const kind of ['archetype', 'entity_type', 'model']) {
			const block = addCollectionBlock(draft, 'story', SOURCES, { kind });
			assert.equal(block.blockable.kind, kind);
		}
		// A caller passing null must not throw — `= {}` fires only on undefined.
		assert.equal(addCollectionBlock(draft, 'story', SOURCES, null).blockable.kind, 'archetype');
	});

	it('reads a stored ref in ANY spelling Apex might hold', () => {
		// The site normalises before deciding to show the panel; if the kit matched the
		// raw string, an underscored band got a "How many" box that silently did nothing
		// — no error, no dirty flag, no save, the typed number just sitting there.
		for (const stored of ['story', 'Story', 'STORY']) {
			const page = samplePage();
			page.blocks.push({
				id: 'b1',
				position: 2,
				blockable_type: 'Cms::PageBlock::AutoCollection',
				blockable: { id: 'c1', kind: 'archetype', ref_name: stored, item_count: 3 }
			});
			const draft = createDraft(page, 'baseline-v');
			assert.equal(setCollectionItemCount(draft, 'b1', 5, SOURCES), true, stored);
			assert.equal(isDirty(draft), true, stored);
		}
		// And an underscored alias of a multi-word source.
		const page = samplePage();
		page.blocks.push({
			id: 'b1',
			position: 2,
			blockable_type: 'Cms::PageBlock::AutoCollection',
			blockable: { id: 'c1', kind: 'archetype', ref_name: 'team_member', item_count: 4 }
		});
		const draft = createDraft(page, 'baseline-v');
		// team member declares itemCount 'none', so the refusal here is the RULE, not a
		// failure to recognise the spelling — proven by the switch below being a no-op.
		assert.equal(setCollectionItemCount(draft, 'b1', 5, SOURCES), false);
		assert.equal(setCollectionSource(draft, 'b1', 'team member', SOURCES), true);
		assert.equal(draft.page.blocks[2].blockable.ref_name, 'team_member', 'recognised, so no-op');
		assert.equal(isDirty(draft), false);
	});

	it('REFUSES a count on a source whose count is a mode switch, not a limit', () => {
		// Poovayya's team band renders a search-and-filter UI at 0 and a capped grid at
		// any positive value, so a "count" written there deletes the live search box.
		const page = samplePage();
		page.blocks.push({
			id: 'team',
			position: 2,
			blockable_type: 'Cms::PageBlock::AutoCollection',
			blockable: { id: 'c1', kind: 'archetype', ref_name: 'team member', item_count: 0 }
		});
		const draft = createDraft(page, 'baseline-v');
		assert.equal(setCollectionItemCount(draft, 'team', 8, SOURCES), false);
		assert.equal(draft.page.blocks[2].blockable.item_count, 0);
		assert.equal(isDirty(draft), false);
		// And a band whose ref is not in the list at all.
		assert.equal(setCollectionItemCount(draft, 'team', 8, []), false);
	});

	it('re-picking the source a band ALREADY uses changes nothing, even through an alias', () => {
		// The band is stored under the alias `member`; the dropdown shows "Team" as
		// selected. Comparing raw strings made re-picking "Team" rewrite the row and
		// reset a count the editor never touched.
		const page = samplePage();
		page.blocks.push({
			id: 'b1',
			position: 2,
			label: 'Team',
			blockable_type: 'Cms::PageBlock::AutoCollection',
			blockable: { id: 'c1', kind: 'archetype', ref_name: 'member', item_count: 12 }
		});
		const draft = createDraft(page, 'baseline-v');
		assert.equal(setCollectionSource(draft, 'b1', 'team member', SOURCES), true);

		const block = getBlocks(draft).find((candidate) => candidate.id === 'b1');
		assert.equal(block.blockable.ref_name, 'member', 'the stored spelling is left alone');
		assert.equal(block.blockable.item_count, 12, 'the count is NOT reset');
		assert.equal(isDirty(draft), false, 'a no-op must not dirty the draft');
	});

	it('REFUSES an alias as the target — one authorable spelling per source', () => {
		const page = samplePage();
		page.blocks.push({
			id: 'b1',
			position: 2,
			blockable_type: 'Cms::PageBlock::AutoCollection',
			blockable: { id: 'c1', kind: 'archetype', ref_name: 'story', item_count: 3 }
		});
		const draft = createDraft(page, 'baseline-v');
		assert.equal(setCollectionSource(draft, 'b1', 'member', SOURCES), false);
		assert.equal(addCollectionBlock(draft, 'member', SOURCES), null);
	});

	it('REFUSES switching a block that is not a listing at all', () => {
		// Writing ref_name onto a TemplateInstance blockable raises
		// ActiveModel::UnknownAttributeError in Rails and kills the whole page save.
		const draft = createDraft(samplePage(), 'baseline-v');
		const templateBlockId = draft.page.blocks[0].id;
		assert.equal(setCollectionSource(draft, templateBlockId, 'story', SOURCES), false);
		assert.equal(setCollectionSource(draft, 'nope', 'story', SOURCES), false);
		assert.equal(isDirty(draft), false);
	});

	it('a malformed duplicate earlier in the list does not hide a good source', () => {
		const draft = createDraft(samplePage(), 'baseline-v');
		const withDuplicate = [
			{ refName: 'story' },
			{ refName: 'story', label: 'Stories', defaultCount: 3, itemCount: 'count' }
		];
		const block = addCollectionBlock(draft, 'story', withDuplicate);
		assert.notEqual(block, null, 'the first USABLE entry wins, not the first entry');
		assert.equal(block.label, 'Stories');
	});

	it('refuses source lists that are not lists, and refNames that are not names', () => {
		const draft = createDraft(samplePage(), 'baseline-v');
		for (const bad of [{}, new Map(), 'story', 0, undefined]) {
			assert.equal(addCollectionBlock(draft, 'story', bad), null);
		}
		for (const bad of ['', null, 0, {}, '__proto__', 'constructor']) {
			assert.equal(addCollectionBlock(draft, bad, SOURCES), null);
		}
		assert.equal(isDirty(draft), false);
	});

	it('positions stay contiguous when the server sent gaps', () => {
		const page = samplePage();
		page.blocks[0].position = 7;
		const draft = createDraft(page, 'baseline-v');
		addCollectionBlock(draft, 'story', SOURCES);
		assert.deepEqual(
			getBlocks(draft).map((block) => block.position),
			getBlocks(draft).map((_, index) => index)
		);
	});
});

describe('child rows inside a section (array_ref fields)', () => {
	/** A page whose first block is a template instance with a two-id list. */
	function pageWithList() {
		const page = samplePage();
		page.blocks[0].blockable.entity.fields_data = {
			heading: 'Why us',
			why_choose_points: ['row-1', 'row-2']
		};
		return page;
	}

	it('a NEW row never reaches the parent array — a temp id there is a 422', () => {
		// Apex resolves every array_ref element on write and refuses one it cannot find,
		// naming a field the editor never typed into.
		const draft = createDraft(pageWithList(), 'v');
		const blockId = getBlocks(draft)[0].id;
		const row = addListChild(draft, blockId, 'why_choose_points', 'strength-item', {
			text: 'new'
		});
		assert.ok(row && row.id.startsWith('temp-'));
		assert.deepEqual(
			getBlocks(draft)[0].blockable.entity.fields_data.why_choose_points,
			['row-1', 'row-2'],
			'the stored array is untouched until the create lands'
		);
		assert.equal(newListChildren(draft).length, 1);
		assert.equal(newListChildren(draft)[0].fields_data.text, 'new');
		// It is visible to the editor, though.
		const rows = listChildRows(draft, blockId, 'why_choose_points');
		assert.deepEqual(
			rows.map((r) => r.pending),
			[false, false, true]
		);
	});

	it('adopting a created id puts it in the array and drops the pending row', () => {
		const draft = createDraft(pageWithList(), 'v');
		const blockId = getBlocks(draft)[0].id;
		const row = addListChild(draft, blockId, 'why_choose_points', 'strength-item');
		assert.equal(adoptListChildId(draft, blockId, 'why_choose_points', row.id, 'row-3'), true);
		assert.deepEqual(getBlocks(draft)[0].blockable.entity.fields_data.why_choose_points, [
			'row-1',
			'row-2',
			'row-3'
		]);
		assert.equal(newListChildren(draft).length, 0, 'no second create on a retry');
		assert.equal(isDirty(draft), true, 'the parent must be written');
	});

	it('REFUSES to adopt a temp id, which is the whole point of the leg', () => {
		const draft = createDraft(pageWithList(), 'v');
		const blockId = getBlocks(draft)[0].id;
		const row = addListChild(draft, blockId, 'why_choose_points', 'strength-item');
		assert.equal(adoptListChildId(draft, blockId, 'why_choose_points', row.id, 'temp-x'), false);
		assert.equal(adoptListChildId(draft, blockId, 'why_choose_points', row.id, ''), false);
		assert.deepEqual(getBlocks(draft)[0].blockable.entity.fields_data.why_choose_points, [
			'row-1',
			'row-2'
		]);
	});

	it('reorder and remove touch only the parent array — no child traffic', () => {
		const draft = createDraft(pageWithList(), 'v');
		const blockId = getBlocks(draft)[0].id;
		assert.equal(moveListChild(draft, blockId, 'why_choose_points', 1, 0), true);
		assert.deepEqual(getBlocks(draft)[0].blockable.entity.fields_data.why_choose_points, [
			'row-2',
			'row-1'
		]);
		assert.equal(removeListChild(draft, blockId, 'why_choose_points', 'row-2'), true);
		assert.deepEqual(getBlocks(draft)[0].blockable.entity.fields_data.why_choose_points, ['row-1']);
		assert.equal(newListChildren(draft).length, 0);
		assert.equal(editedListChildren(draft).length, 0);
		// The parent is dirty, which is the leg that carries both.
		assert.equal(isDirty(draft), true);
	});

	it('editing a stored row is its own leg, not the parent entity', () => {
		// A list child is free-standing: `collectEntities` walks BLOCKS and would never
		// find it, so marking the parent dirty would write the wrong record.
		const draft = createDraft(pageWithList(), 'v');
		const blockId = getBlocks(draft)[0].id;
		assert.equal(
			setListChildField(
				draft,
				blockId,
				'why_choose_points',
				'row-1',
				'text',
				'edited',
				'strength-item'
			),
			true
		);
		assert.deepEqual(editedListChildren(draft), [
			{ childId: 'row-1', childType: 'strength-item', fields_data: { text: 'edited' } }
		]);
		assert.equal(
			setListChildField(draft, blockId, 'why_choose_points', 'not-a-row', 'text', 'x', 's'),
			false,
			'a row that is not in the array is refused'
		);
		// The PATCH route is `entity_types/:ref/entities/:id`, so an edit with no type
		// could not be dispatched — refuse it here rather than at the request.
		assert.equal(
			setListChildField(draft, blockId, 'why_choose_points', 'row-2', 'text', 'x'),
			false,
			'a stored edit without its child type is refused'
		);
	});

	it('editing a PENDING row is carried to its create, not a patch', () => {
		const draft = createDraft(pageWithList(), 'v');
		const blockId = getBlocks(draft)[0].id;
		const row = addListChild(draft, blockId, 'why_choose_points', 'strength-item');
		assert.equal(
			setListChildField(draft, blockId, 'why_choose_points', row.id, 'text', 'typed'),
			true
		);
		assert.equal(newListChildren(draft)[0].fields_data.text, 'typed');
		assert.equal(editedListChildren(draft).length, 0, 'a pending row is never patched');
	});

	it('RECONCILE clears pending rows — or the next save creates them twice', () => {
		// `reconcile` replaces `draft.page` and resets every other flag, so a temp row
		// left behind would look new again on the following save. This is the mutation.
		const draft = createDraft(pageWithList(), 'v');
		const blockId = getBlocks(draft)[0].id;
		addListChild(draft, blockId, 'why_choose_points', 'strength-item');
		setListChildField(draft, blockId, 'why_choose_points', 'row-1', 'text', 'e', 'strength-item');
		assert.equal(newListChildren(draft).length, 1);
		assert.equal(editedListChildren(draft).length, 1);

		reconcile(draft, pageWithList(), 'v2');
		assert.equal(newListChildren(draft).length, 0, 'a pending row survived a reconcile');
		assert.equal(editedListChildren(draft).length, 0, 'an edit survived a reconcile');
	});

	it('refuses every operation on a block that is still a temp', () => {
		const draft = createDraft(samplePage(), 'v');
		const fresh = addCollectionBlock(draft, 'story', [
			{ refName: 'story', label: 'S', defaultCount: 1, itemCount: 'count' }
		]);
		assert.equal(addListChild(draft, fresh.id, 'f', 'strength-item'), null);
		assert.equal(removeListChild(draft, fresh.id, 'f', 'x'), false);
		assert.equal(moveListChild(draft, fresh.id, 'f', 0, 1), false);
		assert.equal(setListChildField(draft, fresh.id, 'f', 'x', 'y', 'z'), false);
	});
});

describe("a bundle's own children", () => {
	function pageWithBundle() {
		const page = samplePage();
		page.blocks.push({
			id: 'bundle-block',
			position: 2,
			label: null,
			blockable_type: 'Cms::PageBlock::EntityBundle',
			blockable: {
				id: 'bundle-1',
				entity_type_ids: ['card-type'],
				entities: [
					{ id: 'card-a', position: 0, entity_type_id: 'card-type', fields_data: { heading: 'A' } },
					{ id: 'card-b', position: 0, entity_type_id: 'card-type', fields_data: { heading: 'B' } }
				]
			}
		});
		return page;
	}

	it('a REORDER renumbers every sibling and marks each one dirty', () => {
		// Every live child is position 0 and there is nothing below zero, so moving the
		// last row to the front cannot be written as one row. And a renumbered row that
		// is not marked dirty is never emitted, so the drag is silently dropped.
		const draft = createDraft(pageWithBundle(), 'v');
		assert.equal(moveBundleEntity(draft, 'bundle-block', 1, 0), true);
		const rows = draft.page.blocks[2].blockable.entities;
		assert.deepEqual(
			rows.map((r) => [r.id, r.position]),
			[
				['card-b', 0],
				['card-a', 1]
			]
		);
		// card-b keeps position 0 — canonicalising [0,0] gives [0,1], so asserting that
		// every VALUE changed would fail on a correct implementation.
		const patched = dirtyEntityPatches(draft).map((p) => p.entityId);
		assert.deepEqual(patched.sort(), ['card-a'], 'only the row whose value changed is patched');
	});

	it('carries position on the patch, never alone', () => {
		// The entities route assigns fields and position in one call, and a bare
		// {position} body is a 500 because fields_data is mandatory.
		const draft = createDraft(pageWithBundle(), 'v');
		moveBundleEntity(draft, 'bundle-block', 1, 0);
		const patch = dirtyEntityPatches(draft).find((p) => p.entityId === 'card-a');
		assert.equal(patch.position, 1);
		assert.deepEqual(patch.fields_data, { heading: 'A' });
	});

	it('a field edit on a bundle child reaches dirtyEntityPatches', () => {
		// It only does because collectEntities walks blockable.entities — a bundle OWNS
		// its children, unlike an array_ref row.
		const draft = createDraft(pageWithBundle(), 'v');
		assert.equal(setBundleEntityField(draft, 'bundle-block', 'card-a', 'heading', 'edited'), true);
		const patch = dirtyEntityPatches(draft).find((p) => p.entityId === 'card-a');
		assert.equal(patch.fields_data.heading, 'edited');
	});

	it('a NEW child is created by its own leg, not by the page PATCH', () => {
		const draft = createDraft(pageWithBundle(), 'v');
		const added = addBundleEntity(draft, 'bundle-block', 'card', { heading: 'C' });
		assert.ok(added.id.startsWith('temp-'));
		assert.equal(newBundleEntities(draft).length, 1);
		assert.equal(newBundleEntities(draft)[0].position, 2);
		// And it is NOT in the structure payload's entities_attributes.
		const attr = structurePayload(draft).blocks_attributes.find((b) => b.id === 'bundle-block');
		assert.equal(attr.blockable_attributes.entities_attributes, undefined);
		assert.equal(attr.blockable_attributes.entities, undefined, 'the read-back key must not ride');
	});

	it('only REMOVALS travel on the page PATCH, as _destroy entries', () => {
		// entities_attributes is the only destroy path and permits no position. An entry
		// with no id would build a NEW row, so nothing else may be sent here.
		const draft = createDraft(pageWithBundle(), 'v');
		assert.equal(removeBundleEntity(draft, 'bundle-block', 'card-a'), true);
		const attr = structurePayload(draft).blocks_attributes.find((b) => b.id === 'bundle-block');
		assert.deepEqual(attr.blockable_attributes.entities_attributes, [
			{ id: 'card-a', _destroy: true }
		]);
		assert.equal(attr.blockable_attributes.deleted_entity_ids, undefined);
		// The survivor was renumbered.
		assert.equal(draft.page.blocks[2].blockable.entities[0].position, 0);
	});

	it('removing DIRTIES the draft — or the structure save never happens', () => {
		const draft = createDraft(pageWithBundle(), 'v');
		assert.equal(isDirty(draft), false);
		removeBundleEntity(draft, 'bundle-block', 'card-a');
		assert.equal(isDirty(draft), true, 'deleted_entity_ids alone does not dirty the draft');
	});

	it('removing a TEMP child leaves nothing to destroy', () => {
		const draft = createDraft(pageWithBundle(), 'v');
		const added = addBundleEntity(draft, 'bundle-block', 'card');
		assert.equal(removeBundleEntity(draft, 'bundle-block', added.id), true);
		const attr = structurePayload(draft).blocks_attributes.find((b) => b.id === 'bundle-block');
		assert.equal(attr.blockable_attributes.entities_attributes, undefined);
		assert.equal(newBundleEntities(draft).length, 0);
	});

	it('refuses every operation on a block that is not a bundle', () => {
		const draft = createDraft(pageWithBundle(), 'v');
		const other = draft.page.blocks[0].id;
		assert.equal(isBundleBlock(draft.page.blocks[0]), false);
		assert.equal(addBundleEntity(draft, other, 'card'), null);
		assert.equal(removeBundleEntity(draft, other, 'x'), false);
		assert.equal(moveBundleEntity(draft, other, 0, 1), false);
		assert.equal(setBundleEntityField(draft, other, 'x', 'y', 'z'), false);
	});
});

describe('page-draft local model', () => {
	it('adds a medium spacer locally and serializes it without server ids', () => {
		const draft = createDraft(samplePage(), 'baseline-v');
		const block = addSpacerBlock(draft);
		const blocks = getBlocks(draft);

		assert.equal(block.id.startsWith('temp-'), true);
		assert.equal(block.label, null);
		assert.equal(block.blockable_type, 'Cms::PageBlock::Spacer');
		assert.equal(block.blockable.kind, 'medium');
		assert.equal(isTempId(block.blockable.id), true, 'the blockable carries a TEMP id');
		assert.equal(block.position, blocks.indexOf(block));
		assert.equal(isDirty(draft), true);

		const attr = structurePayload(draft).blocks_attributes[block.position];
		assert.equal(Object.hasOwn(attr, 'id'), false);
		assert.equal(attr.blockable_type, 'Cms::PageBlock::Spacer');
		assert.deepEqual(attr.blockable_attributes, { kind: 'medium' });
		assert.equal(attr._destroy, false);
	});

	it('sets and serializes a hydrated spacer kind with its existing ids', () => {
		const page = samplePage();
		page.blocks.push({
			id: 'b1',
			position: 2,
			blockable_type: 'Cms::PageBlock::Spacer',
			blockable: { id: 's1', kind: 'medium', created_at: '2026-09-19T00:00:00.000Z' }
		});
		const draft = createDraft(page, 'baseline-v');

		assert.equal(setSpacerKind(draft, 'b1', 'large'), true);
		assert.equal(isDirty(draft), true);
		const attr = structurePayload(draft).blocks_attributes.find((block) => block.id === 'b1');
		assert.equal(attr.id, 'b1');
		assert.equal(attr.blockable_attributes.id, 's1');
		assert.equal(attr.blockable_attributes.kind, 'large');
	});

	it('refuses invalid spacer kinds and missing blockable records without dirtying the draft', () => {
		const page = samplePage();
		page.blocks.push(
			{
				id: 'spacer',
				position: 2,
				blockable_type: 'Cms::PageBlock::Spacer',
				blockable: { id: 'spacer-record', kind: 'medium' }
			},
			{
				id: 'empty-spacer',
				position: 3,
				blockable_type: 'Cms::PageBlock::Spacer',
				blockable: null
			}
		);
		const draft = createDraft(page, 'baseline-v');

		for (const kind of ['huge', '', null]) {
			assert.equal(setSpacerKind(draft, 'spacer', kind), false);
		}
		assert.equal(setSpacerKind(draft, 'block-heading', 'large'), false);
		assert.equal(setSpacerKind(draft, 'unknown', 'large'), false);
		assert.equal(setSpacerKind(draft, 'empty-spacer', 'large'), false);
		assert.equal(setSpacerKind(draft, 'spacer', 'medium'), true);
		assert.equal(isDirty(draft), false);
		assert.equal(getBlocks(draft).find((block) => block.id === 'empty-spacer').blockable, null);
	});

	it('saves a new spacer through the structure route without patching entity fields', async () => {
		const draft = createDraft(samplePage(), 'baseline-v');
		addSpacerBlock(draft);
		const client = makeClient({ serverVersion: 'baseline-v' });

		const result = await savePage(draft, client);

		assert.equal(result.ok, true);
		assert.equal(client.calls.filter((call) => call[0] === 'savePageStructure').length, 1);
		assert.equal(client.calls.filter((call) => call[0] === 'patchEntityFields').length, 0);
	});

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

describe('a media field with no picker offers no destructive control', () => {
	const RAW = readFileSync(
		fileURLToPath(new URL('../src/admin/ui/BlockFieldEditor.svelte', import.meta.url)),
		'utf8'
	);

	it('Remove is gated on onPickMedia, like Replace', () => {
		// Without this, Remove was the only LIVE control on a media field when no picker
		// was passed: it writes the delete marker, Apex empties the field, and the editor
		// cannot put an image back. Reachable the moment a child list carries a media
		// field, which is exactly what Phase 3's child types do.
		// The media Remove is the one whose click writes `emptyValue`.
		const at = RAW.indexOf('onChange(def.field_name, emptyValue)');
		assert.ok(at > 0, 'the media Remove button was not found');
		const button = RAW.slice(at - 400, at);
		assert.match(
			button,
			/!onPickMedia/u,
			'the media Remove must be disabled without a picker — it is a one-way door'
		);
	});
});
