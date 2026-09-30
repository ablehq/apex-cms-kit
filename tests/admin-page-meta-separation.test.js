// @ts-nocheck — draft and save behavior is exercised with Apex-shaped page data.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	createDraft,
	isDirty,
	PAGE_META_NAMES,
	setPageField,
	setPageMeta,
	structurePayload
} from '../src/admin/page-draft.js';
import { META_NAMES } from '../src/server/bff/operations/post-shape.ts';
import { savePage } from '../src/admin/save-page.js';

function draft() {
	return createDraft(
		{
			id: 'page-1',
			title: 'Page',
			slug: 'page',
			summary: '',
			status: 'draft',
			blocks: [],
			meta_properties: [{ id: 'meta-title', name: 'title', group: 'web', value: 'Stored meta' }]
		},
		'version-1'
	);
}

/** save-page.js:373-390 and :443-459 have independent legs; record each payload. */
function recordingClient(d) {
	const calls = [];
	return {
		calls,
		async readVersion() {
			return { version: 'version-1' };
		},
		async savePageStructure(id, body) {
			calls.push(['structure', id, body]);
			return { ok: true, page: structuredClone(d.page), version: 'version-2' };
		},
		async updatePageSeo(id, meta) {
			calls.push(['seo', id, { meta }]);
			return { ok: true, status: 200 };
		},
		async getPage() {
			return { page: structuredClone(d.page), version: 'version-2' };
		}
	};
}

describe('page and meta stores', () => {
	/** page-draft.js:1098-1111 and :1215-1221 keep meta title out of the page name. */
	it('meta title edit leaves the page title and structure state alone', () => {
		const d = draft();
		setPageMeta(d, 'title', 'M');
		assert.equal(d.page.title, 'Page');
		assert.equal(structurePayload(d).title, 'Page');
		assert.equal(d.structureDirty, false);
		assert.deepEqual(d.metaEdits, { title: 'M' });
	});

	/** page-draft.js:1079-1085 sends a page rename through structure only. */
	it('page rename leaves the meta title row and edit state alone', () => {
		const d = draft();
		const stored = structuredClone(d.page.meta_properties[0]);
		setPageField(d, 'title', 'P');
		assert.equal(d.page.title, 'P');
		assert.deepEqual(d.metaEdits, {});
		assert.deepEqual(d.page.meta_properties[0], stored);
		assert.equal(d.structureDirty, true);
		assert.equal(isDirty(d), true);
	});

	/** save-page.js:443-459 must send a meta-only title through SEO, never structure. */
	it('saves a meta-title-only edit through SEO', async () => {
		const d = draft();
		setPageMeta(d, 'title', 'M');
		const client = recordingClient(d);
		await savePage(d, client);
		assert.deepEqual(client.calls, [['seo', 'page-1', { meta: { title: 'M' } }]]);
	});

	/** save-page.js:373-390 must send a page rename through structure, never SEO. */
	it('saves a page-title-only edit through structure', async () => {
		const d = draft();
		setPageField(d, 'title', 'P');
		const client = recordingClient(d);
		await savePage(d, client);
		assert.equal(client.calls.length, 1);
		assert.equal(client.calls[0][0], 'structure');
		assert.equal(client.calls[0][2].title, 'P');
	});

	/** page-draft.js:1215-1221 must exclude meta even when both save legs run. */
	it('keeps both titles separate in a combined save', async () => {
		const d = draft();
		setPageField(d, 'title', 'P');
		setPageMeta(d, 'title', 'M');
		setPageMeta(d, 'keywords', 'k');
		const client = recordingClient(d);
		await savePage(d, client);
		assert.deepEqual(
			client.calls.map(([name]) => name),
			['structure', 'seo']
		);
		assert.equal(client.calls[0][2].title, 'P');
		assert.equal('meta' in client.calls[0][2], false);
		assert.equal('meta_properties_attributes' in client.calls[0][2], false);
		assert.equal('keywords' in client.calls[0][2], false);
		assert.deepEqual(client.calls[1][2], { meta: { title: 'M', keywords: 'k' } });
	});
	/** page-draft.js:1101-1109 must baseline against the row the id-keyed writer preserves. */
	it('uses the non-blank id-bearing duplicate as the meta baseline', () => {
		const d = draft();
		d.page.meta_properties = [
			{ id: 'one', name: 'description', group: 'web', value: '' },
			{ id: 'two', name: 'description', group: 'web', value: 'X' }
		];
		assert.equal(setPageMeta(d, 'description', 'X'), true);
		assert.deepEqual(d.metaEdits, {});
	});

	/** page-draft.js:1098-1100 must accept the same three names post-shape.ts:77 writes. */
	it('tracks meta title and keywords separately and drops edits at baseline', () => {
		assert.deepEqual(PAGE_META_NAMES, META_NAMES);
		const d = draft();
		assert.equal(setPageMeta(d, 'title', 'M'), true);
		assert.equal(setPageMeta(d, 'keywords', 'alpha'), true);
		assert.deepEqual(d.metaEdits, { title: 'M', keywords: 'alpha' });
		assert.equal(setPageMeta(d, 'title', 'Stored meta'), true);
		assert.deepEqual(d.metaEdits, { keywords: 'alpha' });
		assert.equal(setPageMeta(d, 'unknown', 'x'), false);
	});
	/** save-page-structure.ts:347-365 accepts only page fields, so other names cannot mutate the draft. */
	it('setPageField refuses every non-page field without making a draft dirty', () => {
		for (const name of ['meta_properties', 'blocks', 'id', 'status', '__proto__']) {
			const d = draft();
			const before = structuredClone(d.page);
			assert.equal(setPageField(d, name, []), false, name);
			assert.deepEqual(d.page, before, name);
			assert.equal(isDirty(d), false, name);
		}
	});
});
