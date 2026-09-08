// @ts-nocheck — node:test suite over the admin browser helper's dynamic shapes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { saveEntity } from '../src/admin/save-entity.js';

/**
 * WHAT THE EDITOR IS TOLD when the record write is refused — in the KIT's helper,
 * so every site inherits it.
 *
 * The default sentence is "Saving failed. Nothing was changed — Save again to
 * retry." It promises two things, and `unbacked-record` breaks the second one:
 * retrying can never work, because the refusal is a property of the record rather
 * than of the request, so "Save again to retry" is an instruction that loops
 * forever.
 *
 * There used to be a second such refusal, `child-list-write-failed`, whose lie was
 * the FIRST promise — the flat write was committed and some lists were saved, so
 * "Nothing was changed" told someone to stop looking at a half-updated record. It
 * is gone with the transport that produced it (P3b): a record save is one PATCH
 * again, so there is no half-applied state left to describe.
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

describe('saveEntity — the refusal whose default message is a lie', () => {
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
