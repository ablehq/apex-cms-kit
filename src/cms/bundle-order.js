/**
 * THE ORDER A BUNDLE'S CHILDREN ARE IN — one rule, every reader.
 *
 * `Cms::PageBlock::EntityBundle` owns its children and their order lives on the row
 * as `position`. Apex declares NO order scope on `has_many :entities`, so a read-back
 * arrives in heap order — which is not creation order and not position order.
 *
 * That matters more than it sounds. If the admin panel renders one order and the
 * draft operations index another, a drag moves a different row than the one the
 * editor grabbed, and the renumber that follows writes the wrong order to Apex.
 * Everything therefore sorts through this, including the draft model itself.
 *
 * ── WHY `position ?? 0` AND A `created_at` TIEBREAK ─────────────────────────
 * The column is `integer default: 0`, and every child of the one live bundle is `0` —
 * so the tiebreak does all the work today and the sort must be STABLE on equal
 * positions, or the live page reorders itself for nothing. `created_at` reproduces
 * the order that page renders now, which is what lets editable ordering ship without
 * a backfill.
 *
 * ── WHY `cms/` AND NOT `admin/` ────────────────────────────────────────────
 * A site's PUBLIC loader is one of the readers. `admin/page-draft.js` is a
 * `@ts-nocheck` browser module carrying the whole draft model; importing it into a
 * server loader would drag that model into the public build for a two-line sort.
 */

/** @param {{position?: number|null, created_at?: string|null}} a @param {{position?: number|null, created_at?: string|null}} b */
export function compareBundleChildren(a, b) {
	const byPosition = (a?.position ?? 0) - (b?.position ?? 0);
	if (byPosition !== 0) return byPosition;
	const at = `${a?.created_at ?? ''}`;
	const bt = `${b?.created_at ?? ''}`;
	if (at === bt) return 0;
	return at < bt ? -1 : 1;
}

/** A copy of `children`, in render order.
 * @param {unknown} children
 * @returns {any[]} */
export function bundleChildrenInOrder(children) {
	if (!Array.isArray(children)) return [];
	return [...children].sort(compareBundleChildren);
}

/**
 * Sort a bundle's children IN PLACE into render order.
 *
 * In place, because the draft operations splice this very array: once it is ordered,
 * the index the editor dragged and the index the model moves are the same number.
 */
/** @param {unknown} children */
export function sortBundleChildrenInPlace(children) {
	if (Array.isArray(children)) children.sort(compareBundleChildren);
	return children;
}
