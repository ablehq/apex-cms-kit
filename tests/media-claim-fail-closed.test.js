// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { redeemUploadClaim } from '../src/server/bff/media-claim.ts';

/**
 * `redeemUploadClaim` was imported by NO test in this repo. Its race behaviour is
 * exercised through the finalize handler against real sqlite (`harness/d1.ts`), which
 * is the right way to test "exactly one of two concurrent finalizes may spend this
 * row" — but real sqlite always reports a change count, so the one branch that
 * handles a platform which does NOT report one could never be reached from there.
 *
 * Measured: flipping `if (typeof claimed.meta?.changes !== 'number')` to `return null`
 * — fail OPEN, every finalize allowed — left the whole suite green. That branch's own
 * comment states the rule it exists for: "not knowing whether this request won the
 * race is not the same as having won it."
 *
 * A stub is correct HERE and nowhere else in this area: the property under test is
 * what the code does when the platform reports nothing, which real sqlite cannot
 * produce.
 */

function stubDb({ runMeta, row } = {}) {
	const queries = [];
	const db = {
		queries,
		prepare(query) {
			queries.push(query.trim().split(/\s+/u)[0].toUpperCase());
			const statement = {
				bind: () => statement,
				async run() {
					return { meta: runMeta };
				},
				async first() {
					return row ?? null;
				}
			};
			return statement;
		}
	};
	return db;
}

const NOW = 1_700_000_000_000;
const spendable = (over = {}) => ({
	gallery: 'images',
	expires_at: NOW + 60_000,
	redeemed_at: null,
	...over
});

describe('redeemUploadClaim', () => {
	it('the UPDATE matched exactly one row: this request won, and no SELECT is needed', async () => {
		const db = stubDb({ runMeta: { changes: 1 } });
		assert.equal(await redeemUploadClaim(db, 'c1', 'images', NOW), null);
		assert.deepEqual(db.queries, ['UPDATE'], 'the losing path is the only one that reads back');
	});

	it('FAILS CLOSED when the platform reports no change count at all', async () => {
		for (const runMeta of [undefined, {}, { changes: null }, { changes: '1' }]) {
			const db = stubDb({ runMeta, row: spendable() });
			assert.equal(
				await redeemUploadClaim(db, 'c1', 'images', NOW),
				'upload-claim-unavailable',
				`meta ${JSON.stringify(runMeta)} must not be read as a win`
			);
			assert.deepEqual(
				db.queries,
				['UPDATE'],
				'refused before the read-back — an unknown outcome is not a losing outcome to explain'
			);
		}
	});

	it('a claim id nothing knows is not recognised', async () => {
		const db = stubDb({ runMeta: { changes: 0 }, row: null });
		assert.equal(await redeemUploadClaim(db, 'c1', 'images', NOW), 'upload-not-recognised');
	});

	it('a signed id pointed at the WRONG library is refused first, whatever else is true of it', async () => {
		// Most specific first, deliberately: this row is also expired AND already
		// redeemed, and the caller still needs to be told the sign leg never authorized
		// this library.
		const db = stubDb({
			runMeta: { changes: 0 },
			row: spendable({ gallery: 'documents', redeemed_at: NOW - 1, expires_at: NOW - 1 })
		});
		assert.equal(await redeemUploadClaim(db, 'c1', 'images', NOW), 'upload-wrong-gallery');
	});

	it('a spent claim is already-used; an expired one is expired', async () => {
		const used = stubDb({ runMeta: { changes: 0 }, row: spendable({ redeemed_at: NOW - 1 }) });
		assert.equal(await redeemUploadClaim(used, 'c1', 'images', NOW), 'upload-already-used');

		const expired = stubDb({ runMeta: { changes: 0 }, row: spendable({ expires_at: NOW }) });
		assert.equal(
			await redeemUploadClaim(expired, 'c1', 'images', NOW),
			'upload-expired',
			'expires_at === now is expired: the SQL says `expires_at > ?`'
		);
	});

	it('the UPDATE matched nothing but the row looks spendable: refuse rather than guess', async () => {
		const db = stubDb({ runMeta: { changes: 0 }, row: spendable() });
		assert.equal(await redeemUploadClaim(db, 'c1', 'images', NOW), 'upload-claim-unavailable');
	});
});
