// @ts-nocheck — draft and save behavior is exercised with Apex-shaped page data.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDraft, isDirty, setPageField, setPageMeta } from '../src/admin/page-draft.js';

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

describe('page and meta stores', () => {
	/** page-draft.js:1101-1103 must baseline against the row the id-keyed writer preserves. */
	it('uses the non-blank id-bearing duplicate as the meta baseline', () => {
		const d = draft();
		d.page.meta_properties = [
			{ id: 'one', name: 'description', group: 'web', value: '' },
			{ id: 'two', name: 'description', group: 'web', value: 'X' }
		];
		assert.equal(setPageMeta(d, 'description', 'X'), true);
		assert.deepEqual(d.metaEdits, {});
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
