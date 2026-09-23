// @ts-nocheck — Apex rows can include legacy duplicates and incomplete values.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { pickMetaRow } from '../src/cms/meta-row.js';

/** post-shape.ts:337-342 shows the first non-blank web value; every writer must preserve it. */
it('picks the first non-blank web row, or the first blank row', () => {
	const blank = { id: '1', name: 'description', group: 'web', value: '' };
	const filled = { id: '2', name: 'description', group: 'web', value: 'X' };
	assert.equal(pickMetaRow([blank, filled], 'description'), filled);
	const spaced = { id: '3', name: 'description', group: 'web', value: '  ' };
	assert.equal(pickMetaRow([spaced, blank], 'description'), spaced);
	assert.equal(pickMetaRow([{ ...filled, group: 'display' }, blank], 'description'), blank);
	assert.equal(pickMetaRow([], 'description'), null);
	// post-shape.ts:363-366 trims these strings before its writer sees them.
	assert.equal(
		pickMetaRow([{ id: '4', name: ' description ', group: ' web ', value: 'Y' }], 'description')
			?.value,
		'Y'
	);
});

/** update-page-seo.ts:62-70 cannot write an id-less row without Apex appending a duplicate. */
it('skips id-less rows when an id is required', () => {
	const idless = { name: 'title', group: 'web', value: 'X' };
	const stored = { id: '2', name: 'title', group: 'web', value: '' };
	assert.equal(pickMetaRow([idless, stored], 'title', { requireId: true }), stored);
	assert.equal(pickMetaRow([idless], 'title', { requireId: true }), null);
});
