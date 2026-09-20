// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	partitionTaggings,
	readTagVocabulary,
	reconcileTaggings
} from '../src/server/bff/operations/reconcile-taggings.ts';

/**
 * The reconciler, with a recording Apex whose `POST /taggings` is as
 * non-idempotent as the real one: every create appends a row. What is pinned is
 * that the desired set is reached from any starting state — including one a
 * previous retry corrupted — that deletes precede creates, and that a second
 * identical call writes nothing.
 */

const ARCH = 'aaaaaaaa-1111-2222-3333-444444444444';
const T1 = '11111111-1111-2222-3333-444444444444';
const T2 = '22222222-1111-2222-3333-444444444444';
const T3 = '33333333-1111-2222-3333-444444444444';

function apexWith(rows) {
	const calls = [];
	let serial = 100;
	return {
		calls,
		rows,
		async listTaggings(query) {
			calls.push(['listTaggings', query['q[taggable_id_eq]']]);
			// Apex's own list order is NOT creation order — the reconciler must sort.
			return { ok: true, status: 200, body: { data: [...rows].reverse() } };
		},
		async createTagging(tagId, taggableId) {
			calls.push(['createTagging', tagId]);
			serial += 1;
			rows.push({
				id: `tg-${serial}`,
				tag_id: tagId,
				taggable_id: taggableId,
				created_at: `2026-09-05T00:00:${serial}Z`
			});
			return { ok: true, status: 200, body: { data: { id: `tg-${serial}` } } };
		},
		async deleteTagging(id) {
			calls.push(['deleteTagging', id]);
			const index = rows.findIndex((row) => row.id === id);
			if (index >= 0) rows.splice(index, 1);
			return { ok: true, status: 200, body: null };
		},
		async listTags() {
			return {
				ok: true,
				status: 200,
				body: {
					data: [
						{ id: T1, name: 'Water' },
						{ id: T2, name: 'Energy' }
					],
					pagination: { total_pages: 1 }
				}
			};
		}
	};
}

const row = (id, tagId, at) => ({ id, tag_id: tagId, created_at: at });
const names = new Map([
	[T1, 'Water'],
	[T2, 'Energy'],
	[T3, 'Food']
]);

describe('partitionTaggings', () => {
	it('keeps the OLDEST row per wanted tag, dooms extras and unwanted rows, names the missing', () => {
		const { keep, doomed, missing } = partitionTaggings(
			[
				{ id: 'a', tagId: T1, createdAt: '1' },
				{ id: 'b', tagId: T1, createdAt: '2' },
				{ id: 'c', tagId: T3, createdAt: '3' }
			],
			[T1, T2]
		);
		assert.equal(keep.get(T1).id, 'a');
		assert.deepEqual(
			doomed.map((r) => r.id),
			['b', 'c']
		);
		assert.deepEqual(missing, [T2]);
	});
});

describe('reconcileTaggings', () => {
	it('reaches the desired set: deletes first, then creates, then heals — and reports what is there', async () => {
		const apex = apexWith([
			row('tg-1', T1, '2026-09-05T00:00:01Z'),
			row('tg-2', T3, '2026-09-05T00:00:02Z')
		]);
		const result = await reconcileTaggings(apex, ARCH, [T2, T1], names);
		assert.deepEqual(
			apex.calls.map((call) => call[0]),
			['listTaggings', 'deleteTagging', 'createTagging', 'listTaggings']
		);
		assert.deepEqual(apex.calls[1], ['deleteTagging', 'tg-2']);
		assert.deepEqual(apex.calls[2], ['createTagging', T2]);
		// Reported in the order the editor asked for, with the tagging ids.
		assert.deepEqual(
			result.map((r) => [r.tagId, r.tagName]),
			[
				[T2, 'Energy'],
				[T1, 'Water']
			]
		);
		assert.equal(result[1].id, 'tg-1', 'the pre-existing row was kept, not recreated');
	});

	it('heals duplicates a non-idempotent retry left behind, keeping the oldest', async () => {
		const apex = apexWith([
			row('tg-9', T1, '2026-09-05T00:00:09Z'),
			row('tg-1', T1, '2026-09-05T00:00:01Z')
		]);
		const result = await reconcileTaggings(apex, ARCH, [T1], names);
		assert.deepEqual(apex.calls[1], ['deleteTagging', 'tg-9']);
		assert.equal(result[0].id, 'tg-1');
		assert.equal(apex.rows.length, 1);
	});

	it('a second identical call writes nothing — the retry the browser makes is safe', async () => {
		const apex = apexWith([]);
		await reconcileTaggings(apex, ARCH, [T1, T2], names);
		const writes = () => apex.calls.filter(([name]) => name !== 'listTaggings').length;
		const before = writes();
		assert.equal(before, 2);
		await reconcileTaggings(apex, ARCH, [T1, T2], names);
		assert.equal(writes(), before, 'no delete, no create');
		assert.equal(apex.rows.length, 2);
	});

	it('an empty desired set removes every row', async () => {
		const apex = apexWith([row('tg-1', T1, '1'), row('tg-2', T2, '2')]);
		const result = await reconcileTaggings(apex, ARCH, [], names);
		assert.deepEqual(result, []);
		assert.equal(apex.rows.length, 0);
	});

	it('fails closed when the current set will not read', async () => {
		const apex = apexWith([]);
		apex.listTaggings = async () => ({ ok: false, status: 502, body: null });
		assert.equal(await reconcileTaggings(apex, ARCH, [T1], names), null);
		assert.ok(!apex.calls.some(([name]) => name === 'createTagging'));
	});
});

describe('readTagVocabulary', () => {
	it('reads every page and fails closed on a full page with no pagination', async () => {
		const pages = [
			{ data: [{ id: T1, name: 'Water' }], pagination: { total_pages: 2 } },
			{ data: [{ id: T2, name: 'Energy' }], pagination: { total_pages: 2 } }
		];
		let n = 0;
		const apex = { listTags: async () => ({ ok: true, status: 200, body: pages[n++] }) };
		assert.deepEqual(await readTagVocabulary(apex), [
			{ id: T1, name: 'Water' },
			{ id: T2, name: 'Energy' }
		]);
		const full = {
			listTags: async () => ({
				ok: true,
				status: 200,
				body: { data: Array.from({ length: 100 }, (_, i) => ({ id: `${i}`, name: `t${i}` })) }
			})
		};
		assert.equal(await readTagVocabulary(full), null);
	});
});
