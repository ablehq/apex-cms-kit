import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fetchAllPages } from '../src/cms/pagination.js';

/** @param {number} count */
function records(count) {
	return Array.from({ length: count }, (_, index) => ({ id: `record-${index + 1}` }));
}

describe('CMS pagination', () => {
	it('fetches and preserves more than 100 records across every page', async () => {
		const source = records(205);
		/** @type {number[]} */
		const requestedPages = [];
		const result = await fetchAllPages(
			async (filters) => {
				const page = Number(filters.page);
				const perPage = Number(filters.per_page);
				requestedPages.push(page);
				return {
					data: source.slice((page - 1) * perPage, page * perPage),
					pagination: {
						current_page: page,
						total_pages: Math.ceil(source.length / perPage),
						total_count: source.length
					}
				};
			},
			{ q: { sorts: ['created_at desc'] }, per_page: 100, page: 1 },
			{ label: 'sermons' }
		);

		assert.deepEqual(requestedPages, [1, 2, 3]);
		assert.equal(result.data.length, 205);
		assert.equal(new Set(result.data.map((item) => item.id)).size, 205);
	});

	it('deduplicates overlapping page boundaries only when the unique count is complete', async () => {
		const pages = [
			[{ id: 'one' }, { id: 'two' }],
			[{ id: 'two' }, { id: 'three' }]
		];
		const result = await fetchAllPages(
			async (filters) => ({
				data: pages[Number(filters.page) - 1],
				pagination: { current_page: Number(filters.page), total_pages: 2, total_count: 3 }
			}),
			{ per_page: 2 },
			{ label: 'tags' }
		);
		assert.deepEqual(
			result.data.map((item) => item.id),
			['one', 'two', 'three']
		);
	});

	it('can reject duplicate ids for strict entity-reference resolution', async () => {
		await assert.rejects(
			fetchAllPages(
				async (filters) => ({
					data:
						Number(filters.page) === 1
							? [{ id: 'one' }, { id: 'two' }]
							: [{ id: 'two' }, { id: 'three' }],
					pagination: { current_page: Number(filters.page), total_pages: 2, total_count: 3 }
				}),
				{ per_page: 2 },
				{ label: 'transcript rows', rejectDuplicateIds: true }
			),
			/duplicate id two/
		);
	});

	it('fails instead of silently returning an incomplete collection', async () => {
		await assert.rejects(
			fetchAllPages(
				async (filters) => ({
					data: Number(filters.page) === 1 ? [{ id: 'one' }] : [],
					pagination: { current_page: Number(filters.page), total_pages: 2, total_count: 2 }
				}),
				{ per_page: 1 },
				{ label: 'sermons' }
			),
			/sermons fetch is incomplete/
		);
	});

	it('fails if collection totals change during pagination', async () => {
		await assert.rejects(
			fetchAllPages(
				async (filters) => {
					const page = Number(filters.page);
					return {
						data: [{ id: `record-${page}` }],
						pagination: {
							current_page: page,
							total_pages: 2,
							total_count: page === 1 ? 2 : 3
						}
					};
				},
				{ per_page: 1 },
				{ label: 'sermons' }
			),
			/changed while it was being paginated/
		);
	});
});
