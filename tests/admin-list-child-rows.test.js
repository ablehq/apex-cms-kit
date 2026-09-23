/**
 * `listChildRows` — WHAT AN EXISTING ROW ACTUALLY DRAWS.
 *
 * An `array_ref` field stores IDS, and the editor draws ROWS. This is the join. It
 * used to return `fields_data: {}` for every stored row, so four live "why choose"
 * points rendered as four rows reading "(empty)" that opened to blank inputs — an
 * invitation to "repair" content that was never broken. Found in the Phase 3 review,
 * 2026-09-22; the server now hydrates the rows and the draft carries them.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	createDraft,
	listChildRows,
	setListChildField,
	addListChild,
	editedListChildren,
	isDirty,
	removeListChild,
	setPageMeta,
	reconcile
} from '../src/admin/page-draft.js';

const FIELD = 'why_choose_points';

function samplePage(ids = ['row-1', 'row-2']) {
	return {
		id: 'page-1',
		title: 'About',
		slug: 'about',
		blocks: [
			{
				id: 'block-1',
				position: 0,
				blockable_type: 'Cms::PageBlock::Entity',
				blockable: {
					id: 'blockable-1',
					entity: {
						id: 'entity-1',
						entity_type: { slug: 'four-points' },
						fields_data: { heading: 'Why choose us', [FIELD]: ids }
					}
				}
			}
		]
	};
}

const HYDRATED = {
	'block-1': {
		[FIELD]: [
			{ id: 'row-1', fields: { title: 'Depth', body: 'Decades of it' } },
			{ id: 'row-2', fields: { title: 'Reach', body: 'Everywhere' } }
		]
	}
};

describe('listChildRows draws the row, not the id', () => {
	test('a stored row carries the fields the server hydrated', () => {
		const draft = createDraft(samplePage(), 'v1', HYDRATED);
		const rows = listChildRows(draft, 'block-1', FIELD);
		assert.equal(rows.length, 2);
		assert.deepEqual(rows[0], {
			id: 'row-1',
			pending: false,
			fields_data: { title: 'Depth', body: 'Decades of it' }
		});
	});

	test('an EDIT layers over the stored fields instead of replacing them', () => {
		// The edit records only the field typed into. Replacing would blank every other
		// field on screen the moment an editor touched a single input.
		const draft = createDraft(samplePage(), 'v1', HYDRATED);
		setListChildField(draft, 'block-1', FIELD, 'row-1', 'title', 'Depth, revised', 'strength-item');
		const row = listChildRows(draft, 'block-1', FIELD)[0];
		assert.equal(row.fields_data.title, 'Depth, revised');
		assert.equal(row.fields_data.body, 'Decades of it', 'the untouched field must survive');
	});

	test('rows come back in the PARENT’s order, which is the order on the page', () => {
		const draft = createDraft(samplePage(['row-2', 'row-1']), 'v1', HYDRATED);
		assert.deepEqual(
			listChildRows(draft, 'block-1', FIELD).map((r) => r.id),
			['row-2', 'row-1']
		);
	});

	test('a pending row still reads as pending, after the stored ones', () => {
		const draft = createDraft(samplePage(), 'v1', HYDRATED);
		addListChild(draft, 'block-1', FIELD, 'strength-item', { title: 'New' });
		const rows = listChildRows(draft, 'block-1', FIELD);
		assert.equal(rows.length, 3);
		assert.equal(rows[2].pending, true);
		assert.equal(rows[2].fields_data.title, 'New');
	});

	test('no hydration at all is an empty row, not a crash', () => {
		// A site that supplies no resolver gets `{}`. The row is still listed — its id
		// is in the parent's array — it simply has nothing to draw.
		const draft = createDraft(samplePage(), 'v1');
		const rows = listChildRows(draft, 'block-1', FIELD);
		assert.equal(rows.length, 2);
		assert.deepEqual(rows[0].fields_data, {});
	});
});

describe('reconcile and the hydrated baseline', () => {
	test('reconciling WITHOUT fresh rows keeps the ones already held', () => {
		// `savePage` re-baselines from a page read-back that does not carry rows.
		// Blanking here would turn every existing row into "(empty)" the instant a save
		// succeeded — a save that worked, reported as content loss.
		const draft = createDraft(samplePage(), 'v1', HYDRATED);
		reconcile(draft, samplePage(), 'v2');
		assert.equal(listChildRows(draft, 'block-1', FIELD)[0].fields_data.title, 'Depth');
	});

	test('reconciling WITH fresh rows adopts them', () => {
		const draft = createDraft(samplePage(), 'v1', HYDRATED);
		reconcile(draft, samplePage(), 'v2', {
			'block-1': { [FIELD]: [{ id: 'row-1', fields: { title: 'Server wins' } }] }
		});
		assert.equal(listChildRows(draft, 'block-1', FIELD)[0].fields_data.title, 'Server wins');
	});

	test('reconcile drops edits, so the layered value must come from the server', () => {
		const draft = createDraft(samplePage(), 'v1', HYDRATED);
		setListChildField(draft, 'block-1', FIELD, 'row-1', 'title', 'Typed', 'strength-item');
		reconcile(draft, samplePage(), 'v2', {
			'block-1': { [FIELD]: [{ id: 'row-1', fields: { title: 'Typed' } }] }
		});
		const row = listChildRows(draft, 'block-1', FIELD)[0];
		assert.equal(row.fields_data.title, 'Typed', 'the saved value must survive the re-baseline');
	});

	test('the hydrated rows are CLONED, so a caller cannot mutate the draft through them', () => {
		const rows = structuredClone(HYDRATED);
		const draft = createDraft(samplePage(), 'v1', rows);
		rows['block-1'][FIELD][0].fields.title = 'mutated outside';
		assert.equal(listChildRows(draft, 'block-1', FIELD)[0].fields_data.title, 'Depth');
	});
});

describe('isDirty — the Save button, and what it used to refuse to notice', () => {
	test('ADDING a row makes the page saveable', () => {
		// It did not. The row lives beside the page rather than in it, so no block
		// changed and no flag moved: an editor added a row, typed into it, and the Save
		// button stayed grey with no way to keep the work.
		const draft = createDraft(samplePage(), 'v1', HYDRATED);
		assert.equal(isDirty(draft), false, 'a freshly loaded page is clean');
		addListChild(draft, 'block-1', FIELD, 'strength-item', { title: 'New' });
		assert.equal(isDirty(draft), true);
	});

	test('EDITING an existing row makes the page saveable', () => {
		const draft = createDraft(samplePage(), 'v1', HYDRATED);
		setListChildField(draft, 'block-1', FIELD, 'row-1', 'title', 'Changed', 'strength-item');
		assert.equal(isDirty(draft), true);
	});

	test('a save clears it again, so the button goes back to grey', () => {
		const draft = createDraft(samplePage(), 'v1', HYDRATED);
		addListChild(draft, 'block-1', FIELD, 'strength-item', { title: 'New' });
		reconcile(draft, samplePage(), 'v2', HYDRATED);
		assert.equal(isDirty(draft), false);
	});
});

describe('removing a row takes its queued edit with it', () => {
	test('an edited-then-removed row makes no PATCH and leaves no orphan edit', () => {
		// The edit was keyed by child id and survived the removal, so the save PATCHed a
		// row the editor could no longer see — pointlessly when it succeeded, and
		// unfixably when it 422'd, because there was no row on screen to correct.
		// (codex's review of this branch, 2026-09-22.)
		const draft = createDraft(samplePage(), 'v1', HYDRATED);
		setListChildField(draft, 'block-1', FIELD, 'row-1', 'title', 'Changed', 'strength-item');
		assert.equal(editedListChildren(draft).length, 1);
		removeListChild(draft, 'block-1', FIELD, 'row-1');
		assert.equal(editedListChildren(draft).length, 0, 'the edit must go with the row');
	});

	test('removing one row leaves the OTHER row’s edit alone', () => {
		const draft = createDraft(samplePage(), 'v1', HYDRATED);
		setListChildField(draft, 'block-1', FIELD, 'row-1', 'title', 'One', 'strength-item');
		setListChildField(draft, 'block-1', FIELD, 'row-2', 'title', 'Two', 'strength-item');
		removeListChild(draft, 'block-1', FIELD, 'row-1');
		const edits = editedListChildren(draft);
		assert.equal(edits.length, 1);
		assert.equal(edits[0].childId, 'row-2');
	});
});

describe('setPageMeta baselines on a row the server can write', () => {
	test('an ID-LESS description row does not become the baseline', () => {
		// `update-page-seo.ts` 409s when no id-bearing row exists, and its message says to
		// clear the field to escape. If an id-less row's value were the baseline, clearing
		// would store '' instead of dropping the edit — so every Save would 409 again and
		// the page could never be published. (codex's review, 2026-09-23.)
		const page = samplePage();
		page.meta_properties = [{ name: 'description', group: 'web', value: 'Existing' }];
		const draft = createDraft(page, 'v1');
		setPageMeta(draft, 'description', '');
		assert.equal(
			Object.hasOwn(draft.metaEdits, 'description'),
			false,
			'clearing must DROP the edit, or the 409 is inescapable'
		);
	});

	test('an id-bearing row still baselines normally', () => {
		const page = samplePage();
		page.meta_properties = [{ id: 'm1', name: 'description', group: 'web', value: 'Stored' }];
		const draft = createDraft(page, 'v1');
		setPageMeta(draft, 'description', 'Changed');
		assert.equal(draft.metaEdits.description, 'Changed');
		setPageMeta(draft, 'description', 'Stored');
		assert.equal(Object.hasOwn(draft.metaEdits, 'description'), false, 'back to stored = clean');
	});
});
