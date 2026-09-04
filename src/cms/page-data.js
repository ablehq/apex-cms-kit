/**
 * The read model for CMS pages: which pages route, in what order their sections
 * render, and what the renderer is handed.
 *
 * Everything here runs in `+page.server.js` only. Two consequences, both
 * deliberate:
 *
 * 1. The page corpus never enters the client bundle. Keus imports `pages.json`
 *    in a *universal* load and ships 515 KB of it to every visitor (plan §7);
 *    the corpus stays server-side here, and only the projection below is
 *    serialized into a route's `__data.json`.
 * 2. Rich text is sanitized here, not at render time, so no live payload is ever
 *    written into `__data.json` either. The one `{@html}` sink sanitizes again —
 *    the operation is idempotent, and a sink that is safe when read on its own
 *    is worth the second pass.
 *
 * The projection is also what keeps account ids, staff ids, timestamps and the
 * rest of the Apex record out of the built output: a block becomes a template
 * slug and its field values, and nothing else.
 */

import { plainTextForAttribute, sanitizeRichText } from '../sanitize/html.js';
import { isReservedSlug, normalizeSlugPath } from './page-slug-validation.js';
import { RESERVED_SLUG_PREFIX } from './slug.js';

export { normalizeSlugPath };

/** Only `published` renders. `draft`, `editing`, `scheduled`, `archived` do not. */
const PUBLISHED = 'published';

/**
 * A page routes when it is published, has a slug, that slug is not internal, and
 * no filesystem route already owns the path.
 *
 * @param {unknown} page
 * @param {{ warn?: (message: string) => void }} [options]
 */
export function isCmsPageRoutable(page, options = {}) {
	if (!page || typeof page !== 'object') return false;
	const record = /** @type {{ slug?: unknown, status?: unknown }} */ (page);
	const slug = record.slug;
	if (typeof slug !== 'string' || slug === '') return false;
	if (record.status !== PUBLISHED) return false;
	if (slug.startsWith(RESERVED_SLUG_PREFIX)) return false;
	if (isReservedSlug(slug)) {
		options.warn?.(
			`CMS page "${slug}" collides with a route the site generates and will never render. ` +
				'Rename the page, or delete it.'
		);
		return false;
	}
	return true;
}

/**
 * @param {unknown} pages
 * @param {{ warn?: (message: string) => void }} [options]
 */
export function routableCmsPages(pages, options = {}) {
	if (!Array.isArray(pages)) return [];
	return pages.filter((page) => isCmsPageRoutable(page, options));
}

/**
 * An `anchor_id` becomes a DOM id, so it is reduced to what is safe to put in
 * one and to link to with `#`. An empty result means no anchor, not a broken
 * one.
 *
 * @param {unknown} value
 */
export function toAnchorId(value) {
	if (typeof value !== 'string') return '';
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/gu, '-')
		.replace(/^-+|-+$/gu, '')
		.slice(0, 64);
}

/** @param {unknown} value */
function isRichTextValue(value) {
	return typeof value === 'object' && value !== null && 'html' in value;
}

/**
 * Field values, reduced to what a component can render.
 *
 * The shape decides the treatment, so no template contract lookup is needed at
 * render time: `{editor, html, content}` is rich text and becomes `{html}` with
 * the markup sanitized; everything else passes through as a string, a boolean,
 * or an array of strings. Anything else is dropped rather than guessed at.
 *
 * A media field stores a gallery-item id, which is a plain string like any
 * other — so a string that the media index knows becomes the resolved
 * `{url, alt, contentType}` here. That is the whole of "media ids resolve
 * through the snapshot's media map"; a string the index does not know stays a
 * string, which is what an unresolvable reference should degrade to.
 *
 * @param {unknown} fieldsData
 * @param {Map<string, { url: string, alt: string, contentType: string }>} [media]
 * @returns {Record<string, unknown>}
 */
export function projectFields(fieldsData, media) {
	if (!fieldsData || typeof fieldsData !== 'object') return {};
	/** @type {Record<string, unknown>} */
	const fields = {};
	for (const [name, value] of Object.entries(fieldsData)) {
		if (isRichTextValue(value)) {
			const html = sanitizeRichText(value);
			if (html) fields[name] = { html };
			continue;
		}
		if (typeof value === 'string') {
			if (value === '') continue;
			const resolved = media?.get(value);
			fields[name] = resolved ? { ...resolved } : value;
			continue;
		}
		if (typeof value === 'boolean' || typeof value === 'number') {
			fields[name] = value;
			continue;
		}
		if (Array.isArray(value)) {
			const items = value.filter((item) => typeof item === 'string');
			if (items.length > 0) fields[name] = items;
		}
	}
	return fields;
}

/**
 * @param {unknown} instance
 * @param {string} key
 * @param {Map<string, { url: string, alt: string, contentType: string }>} [media]
 * @returns {{ key: string, template: string, fields: Record<string, unknown>,
 *   anchorId: string, children: Array<object> } | null}
 */
function projectInstance(instance, key, media) {
	if (!instance || typeof instance !== 'object') return null;
	const record = /** @type {Record<string, any>} */ (instance);
	const template = record.page_block_template?.slug;
	if (typeof template !== 'string' || template === '') return null;

	const fields = projectFields(record.entity?.fields_data, media);
	const children = Array.isArray(record.child_template_instances)
		? [...record.child_template_instances]
				// Position first; the Apex instance id breaks a tie so equal-position
				// children are ordered deterministically, not by Apex response order.
				.sort(
					(left, right) =>
						(left?.position ?? 0) - (right?.position ?? 0) ||
						String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
				)
				.flatMap((/** @type {unknown} */ child, /** @type {number} */ index) => {
					const projected = projectInstance(child, `${key}.${index}`, media);
					return projected ? [projected] : [];
				})
		: [];

	return {
		key,
		template,
		fields,
		anchorId: toAnchorId(fields.anchor_id),
		children: /** @type {Array<object>} */ (children)
	};
}

/**
 * @param {unknown} page
 * @param {Map<string, { url: string, alt: string, contentType: string }>} [media]
 * @returns {Array<{ key: string, template: string, fields: Record<string, unknown>,
 *   anchorId: string, children: Array<object> }>}
 */
export function projectBlocks(page, media) {
	const blocks = /** @type {{ blocks?: unknown }} */ (page)?.blocks;
	if (!Array.isArray(blocks)) return [];
	return (
		blocks
			.slice()
			// The API returns blocks in position order today; sorting here means the
			// renderer does not depend on that staying true, and children are sorted
			// the same way one level down. The Apex block id breaks a tie so two
			// equal-position blocks always project in the same order — and so are
			// assigned the same positional keys — regardless of Apex response order.
			.sort(
				(left, right) =>
					(left?.position ?? 0) - (right?.position ?? 0) ||
					String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
			)
			// `flatMap` rather than `map().filter(Boolean)`: a block whose blockable
			// is not a renderable template instance is dropped, and this is the form
			// that says so in the type as well as at runtime.
			.flatMap((block, index) => {
				if (block?.blockable_type !== 'Cms::PageBlock::TemplateInstance') return [];
				// F7 (plan §2): a block's key is its position, not its Apex UUID. The
				// renderer only needs a stable list key, and a positional one shrinks
				// the payload and keeps diffs stable when a block's id churns but its
				// place does not. Children extend it one level down: `b0.1`.
				const projected = projectInstance(block.blockable, `b${index}`, media);
				return projected ? [projected] : [];
			})
	);
}

/**
 * @param {unknown} page
 * @returns {{ title: string, description: string }}
 */
/** @param {{ siteTitle?: string }} [options] */
export function cmsPageMeta(page, options = {}) {
	const record = /** @type {Record<string, any>} */ (page ?? {});
	const properties = Array.isArray(record.meta_properties) ? record.meta_properties : [];
	/** @param {string} name */
	const value = (name) => {
		const found = properties.find((property) => property?.name === name)?.value;
		return typeof found === 'string' ? found.trim() : '';
	};

	const description = value('description') || (record.summary ?? '');
	return {
		title: value('title') || record.title || options.siteTitle || '',
		description: plainTextForAttribute(typeof description === 'string' ? description : '')
	};
}

/**
 * Everything a rendered CMS page is: its path, its head, and its sections.
 * Nothing from the Apex record survives that is not named here.
 *
 * @param {unknown} page
 * @param {{ media?: Map<string, { url: string, alt: string, contentType: string }>, siteTitle?: string }} [options]
 *   `siteTitle` is the `<title>` fallback for a page with neither a meta title nor a title.
 */
export function projectCmsPage(page, options = {}) {
	const record = /** @type {Record<string, any>} */ (page ?? {});
	return {
		slug: normalizeSlugPath(record.slug),
		title: typeof record.title === 'string' ? record.title : '',
		meta: cmsPageMeta(page, options),
		blocks: projectBlocks(page, options.media)
	};
}

/**
 * @typedef {ReturnType<typeof projectCmsPage>} ProjectedCmsPage
 */

// ── Readers over the committed projection ───────────────────────────────────
//
// The functions above turn a raw Apex page into its public projection at
// `cms:setup` time. The three below read what that wrote: `cms/data/pages.json`
// already holds only routable pages, projected, with normalized slugs — so a
// loader needs to find one by slug and list the prerender entries, nothing more.
// The raw-shape functions stay for the projection engine and its tests.

/**
 * @param {ProjectedCmsPage[]} pages
 * @param {unknown} rawSlug
 * @returns {ProjectedCmsPage | null}
 */
export function projectedPageBySlug(pages, rawSlug) {
	const wanted = normalizeSlugPath(rawSlug);
	return (Array.isArray(pages) ? pages : []).find((page) => page.slug === wanted) ?? null;
}
