/**
 * Slugs starting `__` are reserved and never routable — the preview route and
 * the phase-4 data-type singletons use them (plan §2, fact 7). It lives in its
 * own module because both the routing filter and the slug-collision guard need
 * it, and they must not import each other.
 */
export const RESERVED_SLUG_PREFIX = '__';
