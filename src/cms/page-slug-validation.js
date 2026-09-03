/**
 * The slug-collision guard, lifted from `keus-cms/src/lib/cms/page-slug-validation.js`
 * and given the two things GLC needs that Keus's version does not have: a real
 * distinction between routes that are code and routes that are content, and the
 * `admin`/`api` prefixes the admin's own location adds (plan §7).
 *
 * A SvelteKit filesystem route always outranks `[...slug]`, so a CMS page whose
 * slug collides with one is not an error the router will report — it is a page
 * that silently never renders. This says so, once, in a place both the renderer
 * and the authoring script read.
 */

import { RESERVED_SLUG_PREFIX } from './slug.js';

/**
 * Which paths are code, not content. Every site reserves `/admin` and `/api`; a
 * site adds its own generated trees (`/blogs`, `/sermons`, …), exact routes, and
 * the static routes it is still porting to the CMS, with `bindReservedRoutes`.
 */
/** @type {{ prefixes: string[], routes: string[], portable: string[] } | null} */
let bound = null;

/**
 * @param {{ prefixes?: string[], routes?: string[], portable?: string[] }} config
 *   `prefixes` — trees whose index and detail pages are generated (a page can never
 *   be authored under them); `routes` — exact routes that are code; `portable` —
 *   static routes being ported, which a CMS page may legitimately shadow.
 */
export function bindReservedRoutes(config) {
	bound = {
		prefixes: ['/admin', '/api', ...(config.prefixes ?? [])],
		routes: [...(config.routes ?? [])],
		portable: [...(config.portable ?? [])]
	};
	return reservedRoutes();
}
/** Fails closed: a site that never bound its routes cannot validate a slug. */
function current() {
	if (!bound) throw new Error("reserved routes not bound: import the site's site.js first");
	return bound;
}
export function reservedRoutes() {
	const b = current();
	return {
		RESERVED_PREFIXES: Object.freeze([...b.prefixes]),
		RESERVED_ROUTES: Object.freeze([...b.routes]),
		PORTABLE_ROUTES: Object.freeze([...b.portable])
	};
}

/**
 * @param {unknown} rawSlug
 * @returns {string} a normalized, leading-slash path (`/` for an empty slug)
 */
export function normalizeSlugPath(rawSlug) {
	if (!rawSlug) return '/';
	const joined = Array.isArray(rawSlug) ? rawSlug.join('/') : rawSlug;
	const cleaned = `${joined}`.trim().replace(/^\/+|\/+$/gu, '');
	return cleaned ? `/${cleaned}` : '/';
}

/** @param {unknown} rawSlug */
export function isReservedSlug(rawSlug) {
	const slug = normalizeSlugPath(rawSlug);
	if (current().routes.includes(slug)) return true;
	return current().prefixes.some((prefix) => slug === prefix || slug.startsWith(`${prefix}/`));
}

/** @param {unknown} rawSlug */
export function isPortableRouteSlug(rawSlug) {
	return current().portable.includes(normalizeSlugPath(rawSlug));
}

/**
 * The message an editor — or, until there is one, the authoring script — should
 * be shown. Empty string means the slug is usable.
 *
 * `__`-prefixed slugs are *not* rejected here: they are reserved from public
 * routing, not from being created, and the phase-4 singletons depend on them.
 *
 * @param {unknown} rawSlug
 * @returns {string}
 */
export function getPageSlugValidationError(rawSlug) {
	const slug = normalizeSlugPath(rawSlug);

	// The home page. Allowed explicitly rather than by the path grammar below,
	// which describes hyphenated words and cannot express the empty path.
	if (slug === '/') return '';

	for (const prefix of ['/admin', '/api']) {
		if (slug === prefix || slug.startsWith(`${prefix}/`)) {
			return `"${slug}" is reserved for the site administration area.`;
		}
	}

	if (isReservedSlug(slug)) return `"${slug}" is a route the site generates, not a page.`;

	if (slug.slice(1).startsWith(RESERVED_SLUG_PREFIX)) return '';

	if (!/^\/[a-z0-9]+(?:[-/][a-z0-9]+)*$/u.test(slug)) {
		return `"${slug}" is not a usable page path — use lowercase words separated by hyphens.`;
	}

	return '';
}
