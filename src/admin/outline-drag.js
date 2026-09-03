// @ts-nocheck — legacy-mode admin browser module (plan §8, 3a compile-mode (a)).
// Deliberately untyped JS to sit beside the legacy-compiled admin components; its
// behavior is covered by tests/admin-save-page.test.js + tests/bff-realapex.test.js.
// Lifted verbatim from keus-cms `src/lib/admin/utils/outline-drag.js` (plan §8, 3a
// lift list). Pointer-based section reorder, no HTML5 DnD, no library: given the
// cursor's Y and the current row rects, it returns the index the dragged row should
// land at — counting rows whose midpoint is above the cursor. The drag itself only
// mutates local draft order (page-draft.js setBlockOrder); persistence waits for an
// explicit Save (plan M1: reorder never persists on drag).
/**
 * @param {number} clientY
 * @param {Element[]} rows
 * @returns {number} an insertion slot in [0..rows.length]
 */
export function getOutlineInsertionIndex(clientY, rows) {
	let index = 0;
	for (const row of rows) {
		const rect = row.getBoundingClientRect();
		const midpoint = rect.top + rect.height / 2;
		if (clientY >= midpoint) index++;
		else break;
	}
	return Math.min(index, rows.length);
}
