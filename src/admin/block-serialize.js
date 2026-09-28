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
	const payload = {};
	if (instance.id && !isTempId(instance.id)) payload.id = instance.id;
	const templateId = instance.page_block_template_id || instance.page_block_template?.id;
	if (templateId) payload.page_block_template_id = templateId;
	if (Number.isInteger(instance.position)) payload.position = instance.position;
	const entity = instance.entity;
	if (entity) {
		payload.entity_attributes = { entity_type_id: entity.entity_type_id };
		if (entity.id && !isTempId(entity.id)) payload.entity_attributes.id = entity.id;
	}
	payload.child_template_instances_attributes = (instance.child_template_instances ?? []).map(
		serializeTemplateInstance
	);
	for (const id of instance.deleted_child_template_instance_ids ?? [])
		if (id && !isTempId(id))
			payload.child_template_instances_attributes.push({ id, _destroy: true });
	return payload;
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
