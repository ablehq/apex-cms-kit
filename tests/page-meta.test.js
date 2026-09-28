import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	createDraft,
	setPageMeta,
	isDirty,
	reconcile,
	addTemplateBlock
} from '../src/admin/page-draft.js';
import { savePage } from '../src/admin/save-page.js';
import { cmsPageMeta } from '../src/cms/page-data.js';
import { pageMetaValue, pageMetaProblem } from '../src/cms/page-meta.js';
import { computePageVersion } from '../src/server/bff/page-version.ts';
import { savePageStructureBodySchema } from '../src/server/bff/operations/save-page-structure.ts';
const page = () => ({
	id: 'page',
	title: 'Page title',
	slug: 'page',
	summary: 'Summary',
	status: 'draft',
	updated_at: 'unchanged',
	blocks: [],
	meta_properties: ['title', 'description', 'keywords'].map((name, index) => ({
		id: `10000000-0000-4000-8000-00000000000${index}`,
		group: 'web',
		name,
		value: ''
	}))
});

test('page metadata selector preserves visible idless values but refuses them for writes', () => {
	const rows = [
		{ id: 'social', group: 'social', name: 'title', value: 'Wrong' },
		{ id: 'blank', group: 'web', name: 'title', value: '' },
		{ group: 'web', name: 'title', value: 'Visible' }
	];
	assert.equal(pageMetaValue(rows, 'title'), 'Visible');
	assert.equal(pageMetaProblem(rows, 'title'), 'unwritable-meta-row');
	assert.equal(
		setPageMeta(createDraft({ ...page(), meta_properties: rows }, 'v1'), 'title', 'Change'),
		false
	);
	assert.equal(cmsPageMeta({ ...page(), meta_properties: [rows[0]] }).title, 'Page title');
});
test('meta draft is separate, reversible and adds optional keywords only when nonempty', () => {
	const draft = createDraft(page(), 'v1');
	setPageMeta(draft, 'title', 'SEO');
	setPageMeta(draft, 'keywords', 'one');
	assert.equal(draft.page.title, 'Page title');
	assert.equal(draft.structureDirty, false);
	assert.equal(isDirty(draft), true);
	setPageMeta(draft, 'title', '');
	setPageMeta(draft, 'keywords', '');
	assert.equal(isDirty(draft), false);
	assert.deepEqual(cmsPageMeta(page()), { title: 'Page title', description: 'Summary' });
	const seo = page();
	seo.meta_properties[2].value = 'one';
	assert.equal(cmsPageMeta(seo).keywords, 'one');
});
test('metadata participates in deterministic stale version even when timestamp is fixed', async () => {
	const before = page();
	const initial = await computePageVersion(before);
	before.meta_properties[0].value = 'Changed';
	assert.notEqual(await computePageVersion(before), initial);
	assert.equal(
		await computePageVersion(before),
		await computePageVersion({ ...before, meta_properties: [...before.meta_properties].reverse() })
	);
});
test('generic structure cannot bypass dedicated metadata policy', () => {
	assert.equal(
		savePageStructureBodySchema.safeParse({
			meta_properties_attributes: [{ name: 'title', value: 'Forged' }]
		}).success,
		false
	);
});
test('SEO-only save omits structure, precedes status and adopts the final post-write read', async () => {
	const draft = createDraft(page(), 'v1');
	setPageMeta(draft, 'title', 'SEO');
	const calls = [];
	const fresh = page();
	fresh.meta_properties[0].value = 'SEO';
	const result = await savePage(
		draft,
		{
			readVersion: async () => ({ version: 'v1' }),
			updatePageSeo: async (id, meta) => {
				calls.push(['seo', id, meta]);
				return { ok: true };
			},
			changePageStatus: async () => {
				calls.push(['status']);
				return { ok: true };
			},
			getPage: async () => {
				calls.push(['get']);
				return { page: fresh, version: 'v2' };
			}
		},
		{ statusEvent: 'publish' }
	);
	assert.deepEqual(result, { ok: true, refreshed: true });
	assert.deepEqual(
		calls.map((x) => x[0]),
		['seo', 'status', 'get']
	);
	assert.equal(draft.baselineVersion, 'v2');
	assert.equal(isDirty(draft), false);
});
test('structure then refused SEO requires recovery and a retry cannot mint another section', async () => {
	const draft = createDraft(page(), 'v1');
	setPageMeta(draft, 'title', 'SEO');
	addTemplateBlock(draft, {
		templateId: 'tpl',
		templateSlug: 'prose',
		entityTypeId: 'type',
		fieldsData: {}
	});
	let structures = 0;
	let statuses = 0;
	const client = {
		readVersion: async () => ({ version: 'v1' }),
		savePageStructure: async () => {
			structures++;
			return { ok: true, page: page(), version: 'v2' };
		},
		updatePageSeo: async () => ({ ok: false, status: 409 }),
		changePageStatus: async () => {
			statuses++;
			return { ok: true };
		}
	};
	assert.equal((await savePage(draft, client, { statusEvent: 'publish' })).recoveryRequired, true);
	assert.equal((await savePage(draft, client, { statusEvent: 'publish' })).stage, 'refresh');
	assert.equal(structures, 1);
	assert.equal(statuses, 0);
	reconcile(draft, page(), 'v2');
	assert.equal(draft.recoveryRequired, false);
});
test('unknown structure outcome and failed final read block all blind retries', async () => {
	for (const failAt of ['structure', 'read']) {
		const draft = createDraft(page(), 'v1');
		addTemplateBlock(draft, {
			templateId: 'tpl',
			templateSlug: 'prose',
			entityTypeId: 'type',
			fieldsData: {}
		});
		let calls = 0;
		const client = {
			readVersion: async () => ({ version: 'v1' }),
			savePageStructure: async () => {
				calls++;
				if (failAt === 'structure') throw Error('lost response');
				return { ok: true };
			},
			getPage: async () => {
				throw Error('offline');
			}
		};
		const result = await savePage(draft, client);
		assert.equal(draft.recoveryRequired, true);
		assert.equal(result.ok, failAt === 'read');
		await savePage(draft, client);
		assert.equal(calls, 1);
	}
});

test('malformed UUID metadata IDs are visible but cannot be written', () => {
	const rows = [{ id: 'not-a-uuid', name: 'title', group: 'web', value: 'Visible' }];
	assert.equal(pageMetaValue(rows, 'title'), 'Visible');
	assert.equal(pageMetaProblem(rows, 'title'), 'unwritable-meta-row');
});
