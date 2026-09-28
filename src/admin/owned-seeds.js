// @ts-nocheck — draft trees and provider responses are validated at runtime.
import { isTempId } from './block-serialize.js';
const TEMPLATE = 'Cms::PageBlock::TemplateInstance';
export function hasTemporaryNodes(page) {
	return (page.blocks ?? []).some(
		(block) =>
			block.blockable_type === TEMPLATE &&
			(isTempId(block.id) ||
				isTempId(block.blockable?.id) ||
				isTempId(block.blockable?.entity?.id) ||
				(block.blockable?.child_template_instances ?? []).some(
					(child) => isTempId(child.id) || isTempId(child.entity?.id)
				))
	);
}
/** Match the whole returned tree before allowing any field write to a minted ID. */
export function mappedOwnedSeeds(expected, fresh) {
	const patches = [];
	const seen = new Set();
	const stored = new Set();
	const remember = (value) => {
		if (value && typeof value === 'object') {
			if (typeof value.id === 'string' && !isTempId(value.id)) stored.add(value.id);
			for (const child of Object.values(value)) remember(child);
		}
	};
	remember(expected.blocks);
	const fail = () => {
		throw new Error('The saved structure could not be safely matched. Reload before saving again.');
	};
	function identity(wanted, actual) {
		if (typeof actual !== 'string' || !actual || isTempId(actual) || seen.has(actual)) fail();
		seen.add(actual);
		if (isTempId(wanted)) {
			if (stored.has(actual)) fail();
		} else if (wanted !== actual) fail();
	}
	function siblings(wanted, actual, visit, roots = false) {
		if (!Array.isArray(actual) || wanted.length !== actual.length) fail();
		const matched = new Set();
		wanted.forEach((item, index) => {
			const position = roots ? index : (item.position ?? null);
			const candidates = actual.filter((row) =>
				isTempId(item.id) ? (row.position ?? null) === position : row.id === item.id
			);
			if (candidates.length !== 1) fail();
			const row = candidates[0];
			if (matched.has(row) || (row.position ?? null) !== position) fail();
			matched.add(row);
			visit(item, row, index);
		});
	}

	function instance(wanted, actual, parent, depth) {
		if (!actual || (depth > 1 && isTempId(wanted.id))) fail();
		identity(wanted.id, actual.id);
		if ((actual.parent_template_instance_id ?? null) !== parent) fail();
		const template = wanted.page_block_template_id || wanted.page_block_template?.id;
		if (
			!template ||
			template !== (actual.page_block_template_id || actual.page_block_template?.id) ||
			(actual.page_block_template?.id && actual.page_block_template.id !== template)
		)
			fail();
		const entity = wanted.entity;
		const returned = actual.entity;
		if (!entity?.entity_type_id || !returned || entity.entity_type_id !== returned.entity_type_id)
			fail();
		identity(entity.id, returned.id);
		if (isTempId(entity.id) && Object.keys(entity.fields_data ?? {}).length)
			patches.push({
				entityId: returned.id,
				entityTypeId: returned.entity_type_id,
				fields_data: structuredClone(entity.fields_data)
			});
		siblings(
			wanted.child_template_instances ?? [],
			actual.child_template_instances ?? [],
			(child, row) => instance(child, row, actual.id, depth + 1)
		);
	}
	siblings(
		expected.blocks ?? [],
		fresh?.blocks,
		(wanted, actual) => {
			identity(wanted.id, actual.id);
			if (wanted.blockable_type !== actual.blockable_type) fail();
			if (wanted.blockable_type === TEMPLATE) instance(wanted.blockable, actual.blockable, null, 0);
			else if (wanted.blockable?.id) identity(wanted.blockable.id, actual.blockable?.id);
		},
		true
	);
	return patches;
}
