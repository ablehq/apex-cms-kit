/**
 * A post's cover FOCUS POINT: the spot an editor picked that has to stay in view
 * when a page crops the cover.
 *
 * A site crops a cover with `object-fit: cover`, which anchors on the centre unless
 * told otherwise. When the frame is a different shape from the photo (a full-width
 * banner with a height cap is 2.6 : 1 at 1440px and 3.5 : 1 at 1920px), the centre
 * crop cuts off whatever is near the top or bottom, usually heads. The focus moves
 * the crop: it is the `object-position` for that cover.
 *
 * WHERE IT LIVES. A `meta_properties` row on the `Cms::Post`, `group: 'display'`,
 * `name: 'cover_focus'`, value `"<x>% <y>%"` in whole percentages from the
 * top-left. `Cms::MetaProperty` takes any name and group, and `posts_controller`
 * permits both on `meta_properties_attributes`, so this needs no Apex schema change
 * and the publish carries it with the rest of `meta_properties`. The `display` group
 * keeps it clear of the SEO rows (`meta-row.js`, group `web`). No row means the
 * centre, which is what every cover drew before the focus existed.
 *
 * Written by the post's own PATCH (`server/bff/operations/update-post.ts`, rows from
 * `coverFocusAttributes` in `post-shape.ts`), edited through `admin/post-draft.js`
 * and picked with `admin/ui/CoverFocusPicker.svelte`. Read here by both the admin
 * and a site's public pages, from the raw Apex record, live or published.
 *
 * The value ends up in a `style` attribute, so it is parsed strictly and rebuilt
 * from two numbers, never passed through.
 */

export const COVER_FOCUS_GROUP = 'display';
export const COVER_FOCUS_NAME = 'cover_focus';
const FOCUS_VALUE = /^(\d{1,3})% (\d{1,3})%$/u;

/**
 * @typedef {{ x: number, y: number }} CoverFocus percentages from the top-left
 */

/**
 * `"30% 20%"` → `{ x: 30, y: 20 }`; anything else → null.
 * @param {unknown} value
 * @returns {CoverFocus | null}
 */
export function parseCoverFocus(value) {
	const match = typeof value === 'string' ? FOCUS_VALUE.exec(value.trim()) : null;
	if (!match) return null;
	const x = Number(match[1]);
	const y = Number(match[2]);
	if (x > 100 || y > 100) return null;
	return { x, y };
}

/**
 * `{ x: 30, y: 20 }` → `"30% 20%"`, the stored form and the CSS `object-position`.
 * @param {CoverFocus} focus
 * @returns {string}
 */
export function formatCoverFocus(focus) {
	return `${focus.x}% ${focus.y}%`;
}

/**
 * Whether a `meta_properties` row is a focus row.
 * @param {unknown} row
 * @returns {boolean}
 */
export function isCoverFocusRow(row) {
	if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
	const { group, name } = /** @type {Record<string, unknown>} */ (row);
	return (
		typeof group === 'string' &&
		group.trim() === COVER_FOCUS_GROUP &&
		typeof name === 'string' &&
		name.trim() === COVER_FOCUS_NAME
	);
}

/**
 * The post's focus, or null for the centre. The FIRST focus row is the one that
 * counts, so a duplicate an id-less write left behind cannot displace it.
 * @param {{ meta_properties?: unknown } | null | undefined} post a raw Apex post row, live or published
 * @returns {CoverFocus | null}
 */
export function readCoverFocus(post) {
	const rows = Array.isArray(post?.meta_properties) ? post.meta_properties : [];
	const row = rows.find(isCoverFocusRow);
	return row ? parseCoverFocus(/** @type {Record<string, unknown>} */ (row).value) : null;
}

/**
 * The CSS `object-position` for the post's cover, or `''` for the centre, so a page
 * can write `style:object-position={coverObjectPosition(post) || null}` and leave an
 * unfocused cover's markup exactly as it was.
 * @param {{ meta_properties?: unknown } | null | undefined} post
 * @returns {string}
 */
export function coverObjectPosition(post) {
	const focus = readCoverFocus(post);
	return focus ? formatCoverFocus(focus) : '';
}
