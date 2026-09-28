// @ts-nocheck — adversarial provider trees and browser drafts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	createDraft,
	addTemplateBlock,
	setField,
	setChildField,
	addOwnedChild,
	duplicateOwnedChild,
	duplicateOwnedSection,
	removeOwnedChild,
	moveOwnedChild,
	removeBlock,
	structurePayload,
	dirtyEntityPatches
} from '../src/admin/page-draft.js';
import { savePage } from '../src/admin/save-page.js';
import { validPageTreeOwnership } from '../src/server/bff/page-tree-ownership.ts';
const registry = {
	list: {
		templateId: 'tpl-list',
		entityTypeId: 'type-list',
		fields: ['title', 'anchor'],
		anchors: ['anchor'],
		children: ['item']
	},
	item: {
		templateId: 'tpl-item',
		entityTypeId: 'type-item',
		fields: ['label', 'href', 'anchor'],
		anchors: ['anchor'],
		children: []
	}
};
function fixture() {
	return {
		id: 'page',
		title: 'Page',
		slug: 'page',
		blocks: [
			{
				id: 'block',
				position: 0,
				blockable_type: 'Cms::PageBlock::TemplateInstance',
				blockable: {
					id: 'root',
					page_block_template: { id: 'tpl-list', slug: 'list' },
					entity: {
						id: 'entity-root',
						entity_type_id: 'type-list',
						fields_data: { title: 'Title', anchor: 'original' }
					},
					child_template_instances: [
						{
							id: 'child',
							position: 0,
							parent_template_instance_id: 'root',
							page_block_template: { id: 'tpl-item', slug: 'item' },
							entity: {
								id: 'entity-child',
								entity_type_id: 'type-item',
								fields_data: { label: 'First', href: 'shared-reference', anchor: 'child-anchor' }
							},
							child_template_instances: []
						}
					]
				}
			}
		]
	};
}
function minted(page) {
	let n = 0;
	const result = structuredClone(page);
	const real = (id) => (id.startsWith('temp-') ? `minted-${++n}` : id);
	function instance(row, parent) {
		row.id = real(row.id);
		row.parent_template_instance_id = parent;
		row.entity.id = real(row.entity.id);
		row.child_template_instances.forEach((child) => instance(child, row.id));
	}
	result.blocks.forEach((block) => {
		block.id = real(block.id);
		instance(block.blockable, null);
	});
	return result;
}
function clientFor(draft, change = (page) => page, failAt = 0) {
	const calls = [];
	let fresh;
	return {
		calls,
		readVersion: async () => ({ version: 'v1' }),
		savePageStructure: async () => {
			calls.push('structure');
			fresh = change(minted(draft.page));
			return { ok: true, page: fresh, version: 'v2' };
		},
		patchEntityFields: async (type, id, fields) => {
			calls.push({ type, id, fields });
			return { ok: calls.filter((x) => typeof x === 'object').length !== failAt, status: 422 };
		},
		changePageStatus: async () => {
			calls.push('status');
			return { ok: true };
		},
		getPage: async () => {
			calls.push('readback');
			return { page: fresh, version: 'v3' };
		}
	};
}
test('owned add/edit/move/remove seeds never leak temp IDs or fields into skeleton', () => {
	const draft = createDraft(fixture(), 'v1');
	const child = addOwnedChild(draft, 'block', 'item', registry);
	setChildField(draft, 'block', child.id, 'label', 'Local seed');
	assert.deepEqual(dirtyEntityPatches(draft), []);
	moveOwnedChild(draft, 'block', child.id, -1, registry);
	assert.equal(draft.page.blocks[0].blockable.child_template_instances[0].id, child.id);
	const wire = JSON.stringify(structurePayload(draft));
	assert.ok(!wire.includes('temp-'));
	assert.ok(!wire.includes('fields_data'));
	assert.ok(!wire.includes('Local seed'));
	removeOwnedChild(draft, 'block', child.id, registry);
	assert.equal(draft.page.blocks[0].blockable.deleted_child_template_instance_ids, undefined);
	setChildField(draft, 'block', 'child', 'label', 'Stored edit');
	removeOwnedChild(draft, 'block', 'child', registry);
	assert.deepEqual(dirtyEntityPatches(draft), []);
	assert.deepEqual(
		structurePayload(draft).blocks_attributes[0].blockable_attributes
			.child_template_instances_attributes,
		[{ id: 'child', _destroy: true }]
	);
});
test('item and section duplicates clear anchors, keep references, strip ownership and preserve original', () => {
	const page = fixture();
	page.blocks[0].blockable.account_id = 'secret-owner';
	page.blocks[0].blockable.entity.owner_id = 'root';
	const draft = createDraft(page, 'v1');
	const original = JSON.stringify(draft.page.blocks[0]);
	const copy = duplicateOwnedSection(draft, 'block', registry);
	assert.equal(JSON.stringify(draft.page.blocks[0]), original);
	assert.equal(copy.blockable.entity.fields_data.anchor, '');
	assert.equal(copy.blockable.child_template_instances[0].entity.fields_data.anchor, '');
	assert.equal(
		copy.blockable.child_template_instances[0].entity.fields_data.href,
		'shared-reference'
	);
	assert.equal(copy.blockable.account_id, undefined);
	assert.equal(copy.blockable.entity.owner_id, undefined);
	const item = duplicateOwnedChild(draft, 'block', 'child', registry);
	assert.equal(item.entity.fields_data.anchor, '');
	assert.notEqual(item.entity.id, 'entity-child');
	setChildField(draft, 'block', 'child', 'label', 'dirty');
	removeBlock(draft, 'block');
	assert.deepEqual(dirtyEntityPatches(draft), []);
});
test('unsupported pair/depth/missing registry refuses atomically', () => {
	const draft = createDraft(fixture(), 'v1');
	let before = JSON.stringify(draft.page);
	assert.throws(() => addOwnedChild(draft, 'block', 'bad', registry));
	assert.equal(JSON.stringify(draft.page), before);
	assert.throws(() => duplicateOwnedSection(draft, 'block', { list: registry.list }));
	assert.equal(JSON.stringify(draft.page), before);
	draft.page.blocks[0].blockable.child_template_instances[0].child_template_instances = [
		structuredClone(draft.page.blocks[0].blockable.child_template_instances[0])
	];
	before = JSON.stringify(draft.page);
	assert.throws(() => duplicateOwnedSection(draft, 'block', registry));
	assert.equal(JSON.stringify(draft.page), before);
});
test('existing edits precede structure; new root/child seeds follow all identity validation and status stays last', async () => {
	const draft = createDraft(fixture(), 'v1');
	setChildField(draft, 'block', 'child', 'label', 'existing');
	const child = addOwnedChild(draft, 'block', 'item', registry);
	setChildField(draft, 'block', child.id, 'label', 'new');
	const root = addTemplateBlock(draft, {
		templateId: 'tpl-list',
		templateSlug: 'list',
		entityTypeId: 'type-list'
	});
	setField(draft, root.id, 'title', 'new root');
	addOwnedChild(draft, root.id, 'item', registry);
	const client = clientFor(draft);
	assert.deepEqual(await savePage(draft, client, { statusEvent: 'publish' }), {
		ok: true,
		refreshed: true
	});
	assert.equal(client.calls[0].id, 'entity-child');
	assert.equal(client.calls[1], 'structure');
	assert.equal(client.calls.at(-2), 'status');
	assert.equal(client.calls.at(-1), 'readback');
	assert.ok(
		client.calls.filter((x) => typeof x === 'object').every((x) => !x.id.startsWith('temp-'))
	);
});
test('malformed whole sibling set prevents every seed PATCH and blind remint', async () => {
	for (const corrupt of [
		(p) => {
			p.blocks[0].blockable.child_template_instances.pop();
			return p;
		},
		(p) => {
			p.blocks[0].blockable.child_template_instances[1].position = 0;
			return p;
		},
		(p) => {
			p.blocks[0].blockable.child_template_instances[1].parent_template_instance_id = 'other';
			return p;
		},
		(p) => {
			p.blocks[0].blockable.child_template_instances[1].entity.entity_type_id = 'wrong';
			return p;
		},
		(p) => {
			p.blocks[0].blockable.child_template_instances[1].page_block_template.id = 'wrong';
			return p;
		},
		(p) => {
			p.blocks[0].blockable.child_template_instances[1].entity.id = 'entity-child';
			return p;
		}
	]) {
		const draft = createDraft(fixture(), 'v1');
		const child = addOwnedChild(draft, 'block', 'item', registry);
		setChildField(draft, 'block', child.id, 'label', 'keep');
		const client = clientFor(draft, corrupt);
		const result = await savePage(draft, client, { statusEvent: 'publish' });
		assert.equal(result.recoveryRequired, true);
		assert.deepEqual(client.calls, ['structure']);
		await savePage(draft, client);
		assert.deepEqual(client.calls, ['structure']);
		assert.equal(child.entity.fields_data.label, 'keep');
	}
});
test('second seed failure and lost structure response preserve work and block publication/retry', async () => {
	const draft = createDraft(fixture(), 'v1');
	duplicateOwnedSection(draft, 'block', registry);
	const client = clientFor(draft, (p) => p, 2);
	assert.equal((await savePage(draft, client, { statusEvent: 'publish' })).recoveryRequired, true);
	assert.ok(!client.calls.includes('status'));
	const count = client.calls.length;
	await savePage(draft, client);
	assert.equal(client.calls.length, count);
	const other = createDraft(fixture(), 'v1');
	addOwnedChild(other, 'block', 'item', registry);
	const lost = clientFor(other);
	lost.savePageStructure = async () => {
		throw new Error('response lost');
	};
	assert.equal((await savePage(other, lost)).recoveryRequired, true);
});
test('contextual ownership binds block/instance/entity/child and validates tombstones', () => {
	const page = fixture();
	const draft = createDraft(page, 'v1');
	const payload = () => structurePayload(draft).blocks_attributes;
	assert.equal(validPageTreeOwnership(page, payload()), true);
	for (const corrupt of [
		(rows) => (rows[0].blockable_id = 'root'),
		(rows) => (rows[0].blockable_attributes.id = 'child'),
		(rows) => (rows[0].blockable_attributes.entity_attributes.id = 'entity-child'),
		(rows) =>
			(rows[0].blockable_attributes.child_template_instances_attributes[0].parent_template_instance_id =
				'other')
	]) {
		const rows = payload();
		corrupt(rows);
		assert.equal(validPageTreeOwnership(page, rows), false);
	}
	const deletion = payload();
	deletion[0].blockable_attributes.child_template_instances_attributes = [
		{ id: 'child', _destroy: true }
	];
	assert.equal(validPageTreeOwnership(page, deletion), true);
	deletion[0].blockable_attributes.child_template_instances_attributes[0].parent_template_instance_id =
		'other';
	assert.equal(validPageTreeOwnership(page, deletion), false);
	const nested = structuredClone(page.blocks[0]);
	nested.id = 'block2';
	nested.blockable.id = 'root2';
	nested.blockable.entity.id = 'entity2';
	nested.blockable.child_template_instances = [];
	page.blocks.push(nested);
	const reparent = payload();
	reparent.push({
		id: 'block2',
		blockable_type: nested.blockable_type,
		blockable_attributes: {
			id: 'root2',
			child_template_instances_attributes: [{ id: 'child', _destroy: true }]
		}
	});
	reparent[0].blockable_attributes.child_template_instances_attributes = [];
	assert.equal(validPageTreeOwnership(page, reparent), false);
});

test('untouched gapped/null child positions survive creating a section elsewhere', async () => {
	const page = fixture();
	page.blocks[0].blockable.child_template_instances[0].position = null;
	const second = structuredClone(page.blocks[0].blockable.child_template_instances[0]);
	second.id = 'child2';
	second.entity.id = 'entity-child2';
	second.position = 5;
	page.blocks[0].blockable.child_template_instances.unshift(second);
	const draft = createDraft(page, 'v1');
	const block = addTemplateBlock(draft, {
		templateId: 'tpl-list',
		templateSlug: 'list',
		entityTypeId: 'type-list'
	});
	setField(draft, block.id, 'title', 'New section');
	const client = clientFor(draft);
	assert.equal((await savePage(draft, client, { statusEvent: 'publish' })).ok, true);
	assert.ok(client.calls.includes('status'));
});
test('missing or malformed minted version prevents seeds and status', async () => {
	for (const version of [undefined, null, '', 42]) {
		const draft = createDraft(fixture(), 'v1');
		const child = addOwnedChild(draft, 'block', 'item', registry);
		setChildField(draft, 'block', child.id, 'label', 'Keep');
		const client = clientFor(draft);
		client.savePageStructure = async () => {
			client.calls.push('structure');
			return { ok: true, page: minted(draft.page), version };
		};
		assert.equal(
			(await savePage(draft, client, { statusEvent: 'publish' })).recoveryRequired,
			true
		);
		assert.deepEqual(client.calls, ['structure']);
	}
});
test('stored deeper descendants are preserved while new depth is refused', () => {
	const page = fixture();
	const child = page.blocks[0].blockable.child_template_instances[0];
	const deeper = structuredClone(child);
	deeper.id = 'grandchild';
	deeper.entity.id = 'grandentity';
	deeper.parent_template_instance_id = 'child';
	child.child_template_instances.push(deeper);
	const draft = createDraft(page, 'v1');
	assert.equal(validPageTreeOwnership(page, structurePayload(draft).blocks_attributes), true);
	const wire = structurePayload(draft).blocks_attributes;
	const newNode =
		wire[0].blockable_attributes.child_template_instances_attributes[0]
			.child_template_instances_attributes[0];
	delete newNode.id;
	delete newNode.entity_attributes.id;
	assert.equal(validPageTreeOwnership(page, wire), false);
});

test('final readback cannot substitute different minted identities after seed writes', async () => {
	const draft = createDraft(fixture(), 'v1');
	const child = addOwnedChild(draft, 'block', 'item', registry);
	setChildField(draft, 'block', child.id, 'label', 'Seed');
	const client = clientFor(draft);
	client.getPage = async () => {
		const page = minted(draft.page);
		page.blocks[0].blockable.child_template_instances[1].entity.id = 'different-minted-entity';
		return { page, version: 'v3' };
	};
	assert.deepEqual(await savePage(draft, client), { ok: true, refreshed: false });
	assert.equal(draft.recoveryRequired, true);
	assert.equal(child.entity.fields_data.label, 'Seed');
});

test('shuffled provider root arrays retain their explicit positions through final readback', async () => {
	const draft = createDraft(fixture(), 'v1');
	const block = addTemplateBlock(draft, {
		templateId: 'tpl-list',
		templateSlug: 'list',
		entityTypeId: 'type-list'
	});
	setField(draft, block.id, 'title', 'New section');
	const client = clientFor(draft, (page) => {
		page.blocks.reverse();
		return page;
	});
	assert.deepEqual(await savePage(draft, client), { ok: true, refreshed: true });
});

test('destroy flags are booleans and root tombstones cannot carry update attributes', () => {
	const page = fixture();
	for (const value of ['false', 'true', 0, 1, null]) {
		const rows = structurePayload(createDraft(page, 'v1')).blocks_attributes;
		rows[0]._destroy = value;
		assert.equal(validPageTreeOwnership(page, rows), false);
		delete rows[0]._destroy;
		rows[0].blockable_attributes.child_template_instances_attributes[0]._destroy = value;
		assert.equal(validPageTreeOwnership(page, rows), false);
	}
	assert.equal(validPageTreeOwnership(page, [{ id: 'block', _destroy: true }]), true);
	assert.equal(
		validPageTreeOwnership(page, [{ id: 'block', _destroy: true, blockable_id: 'root' }]),
		false
	);
	assert.equal(
		validPageTreeOwnership(page, [
			{ id: 'block', _destroy: true, blockable_attributes: { id: 'root' } }
		]),
		false
	);
});
