/** Page-only SEO policy. Post metadata keeps its existing independent contract. */
export const PAGE_META_NAMES = /** @type {const} */ (['title', 'description', 'keywords']);

/** @param {unknown} rows @param {string} name @returns {Record<string, unknown>[]} */
export function pageMetaRows(rows, name) {
	if (!Array.isArray(rows)) return [];
	return rows.filter(
		(row) =>
			row &&
			typeof row === 'object' &&
			!Array.isArray(row) &&
			typeof row.group === 'string' &&
			row.group.trim() === 'web' &&
			typeof row.name === 'string' &&
			row.name.trim() === name
	);
}
/** Display the same row the write targets, including an unwritable idless row.
 * @param {unknown} rows @param {string} name
 */
export function pageMetaRow(rows, name) {
	const matching = pageMetaRows(rows, name);
	return (
		matching.find((row) => typeof row.value === 'string' && row.value.trim()) ?? matching[0] ?? null
	);
}
/** @param {unknown} rows @param {string} name @returns {string} */
export function pageMetaValue(rows, name) {
	const value = pageMetaRow(rows, name)?.value;
	return typeof value === 'string' ? value : '';
}
/** @param {unknown} rows @param {string} name @returns {'missing-meta-row' | 'unwritable-meta-row' | null} */
export function pageMetaProblem(rows, name) {
	const matching = pageMetaRows(rows, name);
	if (!matching.length) return 'missing-meta-row';
	// cms_meta_properties uses UUID primary keys; malformed or repeated IDs
	// cannot identify a survivor safely when duplicate rows are destroyed.
	/** @param {unknown} id */
	const validId = (id) =>
		typeof id === 'string' &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
	if (matching.some((row) => !validId(row.id))) return 'unwritable-meta-row';
	const ids = (Array.isArray(rows) ? rows : []).flatMap((row) =>
		row && typeof row === 'object' && validId(row.id) ? [row.id.toLowerCase()] : []
	);
	return matching.some(
		(row) => ids.filter((id) => id === String(row.id).toLowerCase()).length !== 1
	)
		? 'unwritable-meta-row'
		: null;
}
