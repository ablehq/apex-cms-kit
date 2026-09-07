// @ts-nocheck — node:test suite over the admin browser helper's dynamic shapes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { saveEntity } from '../src/admin/save-entity.js';

/**
 * WHAT THE EDITOR IS TOLD when the record write is refused — in the KIT's helper,
 * so every site inherits it.
 *
 * The default sentence is "Saving failed. Nothing was changed — Save again to
 * retry." It promises two things, and P3 introduced two refusals for which each
 * promise is FALSE:
 *
 *   - `child-list-write-failed` — the flat write IS committed and the lists in
 *     `written` ARE saved. "Nothing was changed" tells someone to stop looking at
 *     a record that is now half-updated.
 *   - `unbacked-record` — retrying can never work, because the refusal is a
 *     property of the record rather than of the request. "Save again to retry" is
 *     an instruction that loops forever.
 *
 * Godrej renders this string verbatim (`RecordEditor.svelte`), which is why the
 * wording lives here rather than in one site's copy of the save flow.
 */
const SCHEMA = 'partner';

function dirtyDraft() {
	return {
		schemaSlug: SCHEMA,
		entityId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
		baselineVersion: 'v1',
		dirtyFields: new Set(['name']),
		dirtyReferences: new Set(),
		fields: { name: 'Asha' },
		references: {},
		contract: {
			primitiveFieldDefs: () => [{ field_name: 'name' }],
			referenceItems: () => []
		}
	};
}

function clientRefusing(body) {
	return {
		async readRecordVersion() {
			return { version: 'v1' };
		},
		async updateRecord() {
			return { ok: false, ...body };
		},
		async getRecord() {
			throw new Error('must not re-read after a refusal');
		}
	};
}

describe('saveEntity — the two refusals whose default message is a lie', () => {
	it('a failed child list says what WAS saved, and names the list that was not', async () => {
		const result = await saveEntity(
			dirtyDraft(),
			clientRefusing({
				status: 502,
				error: 'child-list-write-failed',
				code: 'child-list-write-failed',
				field: 'highlights',
				upstreamStatus: 500,
				written: ['expertise_items']
			})
		);
		assert.equal(result.ok, false);
		assert.equal(result.code, 'child-list-write-failed');
		assert.match(result.message, /highlights/, 'the failing list is named');
		assert.match(result.message, /rest of the record was saved/i);
		assert.doesNotMatch(
			result.message,
			/nothing was changed/i,
			'the flat write is committed; saying otherwise stops the editor looking'
		);
		assert.equal(result.retryable, true, 're-sending the whole array converges');
	});

	it('an unbacked record says a retry CANNOT work, and does not say to try again', async () => {
		const result = await saveEntity(
			dirtyDraft(),
			clientRefusing({
				status: 409,
				error: 'unbacked-record',
				code: 'unbacked-record',
				unbackedFields: ['designation', 'name']
			})
		);
		assert.equal(result.ok, false);
		assert.equal(result.code, 'unbacked-record');
		assert.equal(result.retryable, false);
		assert.match(result.message, /designation, name/, 'the fields at risk are named');
		assert.match(result.message, /will not help/i, 'and it says the retry is futile');
		assert.doesNotMatch(result.message, /Save again to retry/);
	});

	it('every other failure keeps the message it already had', async () => {
		const rejected = await saveEntity(dirtyDraft(), clientRefusing({ status: 422 }));
		assert.match(rejected.message, /A field was rejected/);
		assert.equal(rejected.retryable, true);

		const failed = await saveEntity(dirtyDraft(), clientRefusing({ status: 500 }));
		assert.match(failed.message, /Nothing was changed — Save again to retry/);
	});
});
