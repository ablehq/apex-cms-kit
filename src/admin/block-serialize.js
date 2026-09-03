// @ts-nocheck — legacy-mode admin browser module (plan §8, 3a compile-mode (a)).
// Deliberately untyped JS to sit beside the legacy-compiled admin components; its
// behavior is covered by tests/admin-save-page.test.js + tests/bff-realapex.test.js.
// Lifted from keus-cms `src/lib/admin/utils/page-block-payload.js` (plan §8, 3a lift
// list), unchanged in shape — it maps a draft block to the `blocks_attributes` entry
// Apex's page PATCH permits. The two `structuredClone` calls are safe here because
// the admin runs in legacy Svelte mode (svelte.config.js exemption) and this module
// only ever sees plain draft objects, never a `$state` proxy (which structuredClone
// throws on). Temp ids (a block the editor added but has not persisted) are stripped
// so Apex mints a real id — the server side of the temp-id fix (plan M1).

function isTempId(id) {
	return typeof id === 'string' && id.startsWith('temp-');
}

function serializeTemplateInstance(instance) {
	const templateInstance = structuredClone(instance || {});
	if (isTempId(templateInstance.id)) delete templateInstance.id;
	if (templateInstance.entity && isTempId(templateInstance.entity.id)) {
		delete templateInstance.entity.id;
	}
	if (templateInstance.entity) {
		templateInstance.entity_attributes = templateInstance.entity;
		delete templateInstance.entity;
	}
	// The hydrated read carries the template object; the write only needs its id.
	if (templateInstance.page_block_template) {
		if (!templateInstance.page_block_template_id && templateInstance.page_block_template.id) {
			templateInstance.page_block_template_id = templateInstance.page_block_template.id;
		}
		delete templateInstance.page_block_template;
	}
	if (Array.isArray(templateInstance.child_template_instances)) {
		const deletedChildren = Array.isArray(templateInstance.deleted_child_template_instance_ids)
			? templateInstance.deleted_child_template_instance_ids
					.filter((id) => id && !isTempId(`${id}`))
					.map((id) => ({ id, _destroy: true }))
			: [];
		templateInstance.child_template_instances_attributes = [
			...templateInstance.child_template_instances.map((child) => serializeTemplateInstance(child)),
			...deletedChildren
		];
		delete templateInstance.child_template_instances;
	}
	delete templateInstance.deleted_child_template_instance_ids;
	return templateInstance;
}

export function serializePageBlockForSave(block, index) {
	if (block.blockable_type === 'Cms::PageBlock::TemplateInstance') {
		const payload = {
			label: block.label,
			position: index,
			blockable_type: block.blockable_type,
			blockable_attributes: serializeTemplateInstance(block.blockable || {}),
			_destroy: false
		};
		if (!isTempId(`${block.id}`)) payload.id = block.id;
		return payload;
	}

	const blockableAttrs = structuredClone(block.blockable || {});
	if (isTempId(blockableAttrs.id)) delete blockableAttrs.id;
	if (blockableAttrs.entity && isTempId(blockableAttrs.entity.id)) delete blockableAttrs.entity.id;
	if (blockableAttrs.entity) {
		blockableAttrs.entity_attributes = blockableAttrs.entity;
		delete blockableAttrs.entity;
	}
	if (blockableAttrs.entity_attributes && !blockableAttrs.entity_type_id) {
		blockableAttrs.entity_type_id = blockableAttrs.entity_attributes.entity_type_id;
	}
	const payload = {
		label: block.label,
		position: index,
		blockable_type: block.blockable_type,
		blockable_attributes: blockableAttrs,
		_destroy: false
	};
	if (!isTempId(`${block.id}`)) payload.id = block.id;
	return payload;
}

/** Serialize an ordered block list plus `{ id, _destroy: true }` for removed blocks. */
export function serializeBlocksForSave(blocks, deletedBlockIds = []) {
	const attrs = blocks.map((block, index) => serializePageBlockForSave(block, index));
	for (const id of deletedBlockIds) {
		if (id && !isTempId(`${id}`)) attrs.push({ id, _destroy: true });
	}
	return attrs;
}

export { isTempId };
