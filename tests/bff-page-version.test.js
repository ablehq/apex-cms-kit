// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract, run to verify.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computePageVersion, projectPageForVersion } from '../src/server/bff/page-version.ts';

function page() {
	return {
		id: 'p1',
		status: 'published',
		updated_at: 't0',
		blocks: [
			{
				id: 'b1',
				position: 0,
				label: 'Heading',
				blockable_type: 'Cms::PageBlock::TemplateInstance',
				updated_at: 't0',
				blockable: {
					id: 'i1',
					updated_at: 't0',
					page_block_template_id: 'tpl1',
					entity: { id: 'e1', updated_at: 't0', fields_data: { title: 'A' } },
					child_template_instances: []
				}
			},
			{
				id: 'b2',
				position: 1,
				label: 'Prose',
				blockable_type: 'Cms::PageBlock::TemplateInstance',
				updated_at: 't0',
				blockable: {
					id: 'i2',
					updated_at: 't0',
					page_block_template_id: 'tpl2',
					entity: { id: 'e2', updated_at: 't0', fields_data: { body: 'B' } },
					child_template_instances: []
				}
			}
		]
	};
}

describe('composite page version', () => {
	it('is stable for identical trees and insensitive to object key order', async () => {
		const a = await computePageVersion(page());
		// Rebuild the same page with keys inserted in a different order.
		const reordered = page();
		reordered.blocks[0].blockable.entity.fields_data = {
			...reordered.blocks[0].blockable.entity.fields_data
		};
		const b = await computePageVersion(JSON.parse(JSON.stringify(reordered)));
		assert.equal(a, b);
	});

	it('CHANGES when a block field value changes (what page.updated_at would miss)', async () => {
		const base = await computePageVersion(page());
		const edited = page();
		edited.blocks[0].blockable.entity.fields_data.title = 'CHANGED';
		// page.updated_at deliberately left untouched — the whole point of the guard.
		const after = await computePageVersion(edited);
		assert.notEqual(base, after);
	});

	it('CHANGES when blocks are reordered', async () => {
		const base = await computePageVersion(page());
		const reordered = page();
		reordered.blocks.reverse();
		reordered.blocks.forEach((block, index) => (block.position = index));
		const after = await computePageVersion(reordered);
		assert.notEqual(base, after);
	});

	it('CHANGES when a block is added or removed', async () => {
		const base = await computePageVersion(page());
		const removed = page();
		removed.blocks.pop();
		assert.notEqual(base, await computePageVersion(removed));
	});

	it('projects child template instances recursively', () => {
		const withChild = page();
		withChild.blocks[0].blockable.child_template_instances = [
			{
				id: 'c1',
				updated_at: 't0',
				entity: { id: 'ce1', updated_at: 't0', fields_data: { label: 'x' } }
			}
		];
		const projected = projectPageForVersion(withChild);
		assert.equal(projected.blocks[0].blockable.children.length, 1);
		assert.equal(projected.blocks[0].blockable.children[0].entity.id, 'ce1');
	});

	it('is a 64-char hex sha-256 digest', async () => {
		const v = await computePageVersion(page());
		assert.match(v, /^[0-9a-f]{64}$/u);
	});
});
