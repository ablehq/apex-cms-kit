// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	createdIdOutcome,
	judgeCreatedId,
	shapeFaultDetail
} from '../src/server/bff/operations/created-id.ts';

/**
 * THE VERDICT ON A 2xx CREATE'S IDENTIFIER — the shared rule six create handlers
 * take before they write their audit row.
 *
 * Its whole purpose is that the log can say WHICH of three things happened, so the
 * one thing it must not do is lose the evidence on the way. That is what it was
 * doing: a non-string id was discarded and then reported as absent.
 */

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('judgeCreatedId', () => {
	it('a usable uuid is accepted, and is what the caller may hand on', () => {
		const verdict = judgeCreatedId(true, UUID, 'entity');
		assert.deepEqual(verdict, { id: UUID, returnedId: UUID, shapeFault: null });
		assert.equal(createdIdOutcome(true, verdict), 'accepted');
		assert.deepEqual(shapeFaultDetail(verdict), {});
	});

	it('a NON-STRING id is kept and called MALFORMED, not thrown away and called missing', () => {
		/**
		 * OPUS REVIEW OF FIX PASS 3, FINDING 5. `judgeCreatedId(true, 42, 'page')`
		 * answered `{reason: 'missing-page-id', returnedId: null}`. There WAS an id —
		 * it just was not a string — so the row exists, `42` is the handle an operator
		 * has on it, and the log said there was nothing to look for. This module's own
		 * docblock promises that handle.
		 *
		 * MUTATION: `typeof raw === 'string' && raw !== '' ? raw : null` back in place
		 * of the `String(raw)` narrowing, and every case here fails.
		 */
		for (const [raw, expected] of [
			[42, '42'],
			[true, 'true'],
			[{ id: 'nested' }, '[object Object]'],
			[['a'], 'a']
		]) {
			const verdict = judgeCreatedId(true, raw, 'page');
			assert.equal(verdict.shapeFault, 'malformed-page-id', String(raw));
			assert.equal(verdict.returnedId, expected, String(raw));
			// It is never handed on: only a real uuid string may be built into a URL.
			assert.equal(verdict.id, null, String(raw));
			assert.deepEqual(shapeFaultDetail(verdict), {
				reason: 'malformed-page-id',
				returnedId: expected
			});
			assert.equal(createdIdOutcome(true, verdict), 'upstream_shape_error');
		}
	});

	it('`null`, `undefined` and `` are MISSING — an empty string names nothing', () => {
		for (const raw of [null, undefined, '']) {
			const verdict = judgeCreatedId(true, raw, 'record');
			assert.deepEqual(verdict, {
				id: null,
				returnedId: null,
				shapeFault: 'missing-record-id'
			});
		}
	});

	it('a string that is not a uuid is malformed, and comes back CAPPED', () => {
		assert.deepEqual(judgeCreatedId(true, 'yes', 'entity'), {
			id: null,
			returnedId: 'yes',
			shapeFault: 'malformed-entity-id'
		});
		// The only attacker- or upstream-controlled text in the row. An audit table is
		// not the place to discover that an unbounded upstream string does not fit.
		const long = 'x'.repeat(500);
		assert.equal(judgeCreatedId(true, long, 'entity').returnedId.length, 120);
		assert.equal(shapeFaultDetail(judgeCreatedId(true, long, 'entity')).returnedId.length, 120);
	});

	it('a FAILED create has no shape fault — the missing id is expected there', () => {
		const verdict = judgeCreatedId(false, null, 'post');
		assert.equal(verdict.shapeFault, null);
		assert.equal(createdIdOutcome(false, verdict), 'apex_error');
		// And a failure that somehow carried an id still reports `apex_error`, because
		// what failed is the request, not the shape of its answer.
		assert.equal(createdIdOutcome(false, judgeCreatedId(false, UUID, 'post')), 'apex_error');
	});
});
