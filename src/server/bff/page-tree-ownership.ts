/** Contextual ownership complements the page-wide foreign-ID check. */
interface Row {
	[key: string]: unknown;
	id?: string;
	blockable_type?: string;
	blockable?: Row;
	blocks?: Row[];
	page_block_template_id?: string;
	page_block_template?: Row;
	parent_template_instance_id?: string | null;
	entity?: Row;
	entity_attributes?: Row;
	entity_type_id?: string;
	child_template_instances?: Row[];
	child_template_instances_attributes?: Row[];
}
export function validPageTreeOwnership(page: Row, blocks: unknown): boolean {
	if (!Array.isArray(blocks)) return false;
	const seen = new Set<string>();
	const claim = (id: unknown) => {
		if (typeof id !== 'string' || !id || seen.has(id)) return false;
		seen.add(id);
		return true;
	};
	const template = (row: Row) => row.page_block_template_id ?? row.page_block_template?.id;
	function instance(
		incoming: Row,
		current: Row | undefined,
		parent: string | null,
		depth: number
	): boolean {
		if (
			(depth > 1 && !current) ||
			!incoming ||
			typeof incoming !== 'object' ||
			Array.isArray(incoming)
		)
			return false;
		if ('parent_id' in incoming || 'blockable_id' in incoming) return false;
		if (incoming._destroy !== undefined && typeof incoming._destroy !== 'boolean') return false;
		if (
			incoming.id !== undefined &&
			(!current || incoming.id !== current.id || !claim(incoming.id))
		)
			return false;
		if (current && incoming.id !== current.id) return false;
		const supplied = incoming.parent_template_instance_id;
		if (supplied !== undefined && supplied !== null && (!current || supplied !== parent))
			return false;
		if (current && supplied === null && parent !== null) return false;
		if (
			current?.parent_template_instance_id !== undefined &&
			(current.parent_template_instance_id ?? null) !== parent
		)
			return false;
		if (
			current &&
			incoming.page_block_template_id !== undefined &&
			template(current) !== incoming.page_block_template_id
		)
			return false;
		const entity = incoming.entity_attributes;
		if (entity) {
			if (typeof entity !== 'object' || Array.isArray(entity)) return false;
			if (current) {
				if (entity.id !== current.entity?.id || !claim(entity.id)) return false;
				if (
					entity.entity_type_id !== undefined &&
					entity.entity_type_id !== current.entity?.entity_type_id
				)
					return false;
			} else if (entity.id !== undefined) return false;
		}
		const children = incoming.child_template_instances_attributes ?? [];
		if (!Array.isArray(children)) return false;
		for (const child of children) {
			if (!child || typeof child !== 'object') return false;
			if (child._destroy !== undefined && typeof child._destroy !== 'boolean') return false;
			const actual = (current?.child_template_instances ?? []).find(
				(row: Row) => row.id === child.id
			);
			if (child._destroy) {
				if (
					!actual ||
					!claim(child.id) ||
					Object.keys(child).some(
						(key) => !['id', '_destroy', 'parent_template_instance_id'].includes(key)
					) ||
					(child.parent_template_instance_id !== undefined &&
						child.parent_template_instance_id !== current?.id)
				)
					return false;
				continue;
			}
			if (!instance(child, actual, current?.id ?? null, depth + 1)) return false;
		}
		return true;
	}
	for (const incoming of blocks) {
		if (!incoming || typeof incoming !== 'object') return false;
		if (incoming._destroy !== undefined && typeof incoming._destroy !== 'boolean') return false;
		const current = (page.blocks ?? []).find((row: Row) => row.id === incoming.id);
		if (incoming.id !== undefined && (!current || !claim(incoming.id))) return false;
		if (incoming._destroy) {
			if (!current || Object.keys(incoming).some((key) => !['id', '_destroy'].includes(key)))
				return false;
			continue;
		}
		const kind = incoming.blockable_type ?? current?.blockable_type;
		if (current && kind !== current.blockable_type) return false;
		if (kind === 'Cms::PageBlock::TemplateInstance') {
			if ('blockable_id' in incoming) return false;
			if (
				incoming.blockable_attributes &&
				!instance(incoming.blockable_attributes, current?.blockable, null, 0)
			)
				return false;
		}
	}
	return true;
}
