/**
 * Pick the `web` row an editor sees. `post-shape.ts:345-347` already reads the
 * first non-blank value; using the same row for writes prevents blank-first
 * duplicates from destroying the visible value. An id is required when Apex
 * must update the row rather than append another one (`update-page-seo.ts:54`).
 *
 * @param {unknown} rows
 * @param {string} name
 * @param {{requireId?: boolean}} [options]
 * @returns {Record<string, unknown> | null}
 */
export function pickMetaRow(rows, name, { requireId = false } = {}) {
	if (!Array.isArray(rows)) return null;
	let first = null;
	for (const row of rows) {
		if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
		if (
			typeof row.group !== 'string' ||
			row.group.trim() !== 'web' ||
			typeof row.name !== 'string' ||
			row.name.trim() !== name
		)
			continue;
		if (requireId && (typeof row.id !== 'string' || !row.id.trim())) continue;
		first ??= row;
		if (typeof row.value === 'string' && row.value.trim()) return row;
	}
	return first;
}
