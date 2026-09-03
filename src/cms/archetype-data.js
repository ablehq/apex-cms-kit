/**
 * @param {Array<{
 *   type: string,
 *   data: Array<{ archetype_id: string, archetype_schema_slug: string }>
 * }>} collections
 */
export function collectArchetypeReferences(collections) {
	const references = new Map();

	for (const collection of collections.filter((item) => item.type === 'posts')) {
		for (const post of collection.data) {
			const reference = {
				archetypeId: post.archetype_id,
				archetypeSlug: post.archetype_schema_slug
			};
			references.set(`${reference.archetypeSlug}:${reference.archetypeId}`, reference);
		}
	}

	return [...references.values()];
}

/** @param {unknown[][]} archetypeBatches */
export function createArchetypesDataEntry(archetypeBatches) {
	return {
		name: 'archetypes',
		type: 'archetypes',
		data: archetypeBatches.flat()
	};
}
