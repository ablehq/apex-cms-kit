// One serialization, so the committed snapshot diffs cleanly and its hashes
// agree wherever they are recomputed.
//
// Two rules, from plan §2:
//
//   * Object keys sort deterministically. A projection built from Apex responses
//     would otherwise carry whatever key order the API happened to return, and a
//     reordered-but-identical record would show as a diff and a different hash.
//
//   * Array order is left ALONE. Sections, rows and blocks are semantic
//     sequences — sorting them would corrupt the content. The projection has
//     already put every array in the order it must ship in; canonicalization
//     must not second-guess that.

/**
 * Rebuild a value with every object's keys in sorted order, recursively, while
 * preserving array order. `null` and primitives pass through untouched.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === 'object') {
		/** @type {Record<string, unknown>} */
		const sorted = {};
		for (const key of Object.keys(value).sort()) {
			sorted[key] = canonicalize(/** @type {Record<string, unknown>} */ (value)[key]);
		}
		return sorted;
	}
	return value;
}

/**
 * The canonical on-disk form of a snapshot file: keys sorted, tab-indented (the
 * repo's prettier `useTabs`), one trailing newline so the tracked file stays
 * clean under `prettier --check`.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stringifyCanonical(value) {
	return `${JSON.stringify(canonicalize(value), null, '\t')}\n`;
}
