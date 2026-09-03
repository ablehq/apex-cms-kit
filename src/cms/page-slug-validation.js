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
 * Prefixes that are code, not content, and can never become CMS pages: the admin
 * and its API (the login page, the session routes and every BFF operation live
 * here), and the data-type routes, whose index and detail pages are generated from
 * archetype records. `/blogs/anything` is a blog post, not a page.
 *
 */
export const RESERVED_PREFIXES = Object.freeze([
	'/admin',
	'/api',
	'/blogs',
	'/resources',
	'/sermons'
]);

/**
 * Exact routes that are code, not content.
 *
 * `/` used to be here. It is not any more: the home page IS a CMS page (§2),
 * authored at `/`, and its hand-built route was deleted in the commit that put
 * that page live — so the catch-all answers `/` and a page authored there is
 * content, not a collision.
 */
export const RESERVED_ROUTES = Object.freeze([
	// A form with a server action; nothing about it is authorable yet.
	'/contact'
]);

/**
 * Static routes that are being ported to the CMS. A published CMS page may
 * legitimately exist at one of these slugs while the filesystem route still
 * shadows it — that is the correct temporary state (plan §7), and deleting the
 * route is a separate later commit, gated on the production page existing.
 *
 * They are listed rather than merely absent so that "is this slug free?" and
 * "does a route already answer here?" stay two different questions.
 */
export const PORTABLE_ROUTES = Object.freeze(['/gospel', '/what-we-believe', '/who-we-are']);

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
	if (RESERVED_ROUTES.includes(slug)) return true;
	return RESERVED_PREFIXES.some((prefix) => slug === prefix || slug.startsWith(`${prefix}/`));
}

/** @param {unknown} rawSlug */
export function isPortableRouteSlug(rawSlug) {
	return PORTABLE_ROUTES.includes(normalizeSlugPath(rawSlug));
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
