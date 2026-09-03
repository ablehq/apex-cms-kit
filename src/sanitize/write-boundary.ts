/**
 * The WRITE-boundary sanitizer: what an admin is allowed to store.
 *
 * Distinct from `sanitize/html.js`, which is the RENDER-time allowlist a public
 * page passes stored HTML through. Both exist on purpose — the write boundary
 * stops a bad value entering Apex through this admin, and the render allowlist
 * covers everything already in Apex and everything written by any other client.
 * Neither is a substitute for the other, and they are named apart so a caller
 * cannot reach for one meaning the other.
 */

/** The protocols a link or a source may use. Everything else is dropped. */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/** Any base will do: it decides only what a RELATIVE url resolves to. */
const RESOLUTION_BASE = 'https://sanitizer.invalid/';

/** ` onclick="…"`, ` onerror=…` — quoted either way, or bare. */
const EVENT_ATTRIBUTE = /\son[a-z0-9_:-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/giu;

/**
 * Elements that execute or load, removed with their content.
 *
 * The protocol allowlist and the event-attribute strip cover how script gets in
 * through an ATTRIBUTE. Neither does anything about a bare `<script>` ELEMENT —
 * which no rich-text field has any business carrying, and which a direct POST from
 * an authenticated session could otherwise land verbatim in a value the public site
 * renders with `{@html}`.
 *
 * This is still not a general HTML sanitizer and is not trying to become one. It is
 * a protocol allowlist plus a denylist of the few elements that are executable
 * rather than presentational. The second alternative catches an unclosed `<script`
 * with no matching close tag, so a truncated tag cannot slip past the pair.
 */
const EXECUTABLE_ELEMENT =
	/<(script|style|iframe|object|embed|link|meta|base)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?(?:script|style|iframe|object|embed|link|meta|base)\b[^>]*>?/giu;

/** ` href="…"`, ` src='…'`, ` xlink:href=…` — where a protocol can hide. */
const URL_ATTRIBUTE = /\s(?:href|src|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/giu;

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	colon: ':',
	tab: '\t',
	newline: '\n',
	NewLine: '\n'
};

/**
 * Decode the entities an attribute value may hide a protocol behind.
 *
 * The browser decodes attribute values before it parses them as URLs, so
 * `href="&#106;avascript:alert(1)"` IS `javascript:` by the time it matters. Check
 * the decoded form or the check is decoration.
 */
function decodeEntities(value: string): string {
	return value
		.replace(/&#x([0-9a-f]{1,6});?/giu, (match, hex: string) => codePoint(parseInt(hex, 16), match))
		.replace(/&#(\d{1,7});?/gu, (match, dec: string) => codePoint(parseInt(dec, 10), match))
		.replace(/&([a-z]+);/giu, (match, name: string) => NAMED_ENTITIES[name] ?? match);
}

function codePoint(value: number, fallback: string): string {
	if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return fallback;
	return String.fromCodePoint(value);
}

/**
 * Is this attribute value something we are willing to store?
 *
 * Resolved with `new URL`, not string-matched: the URL parser strips the tabs,
 * newlines and control characters `java\tscript:` hides behind, and it is the same
 * parser the browser will use. A relative or anchor value resolves against the
 * base and comes back `https:`, which is why they need no case of their own.
 */
export function isSafeUrlValue(raw: string): boolean {
	const value = decodeEntities(raw).trim();
	if (value === '') return true;
	try {
		return SAFE_PROTOCOLS.has(new URL(value, RESOLUTION_BASE).protocol);
	} catch {
		return false;
	}
}

/** Strip executable elements, dangerous protocols and inline handlers out of authored HTML. */
/**
 * Strip executable elements until the string stops changing.
 *
 * One pass is not enough, and the reason is the whole point of this function.
 * `<scr<script></script>ipt>` contains a complete inner `<script></script>`;
 * removing it joins `<scr` to `ipt>` and RECONSTITUTES a live `<script>` tag out
 * of text that had none. A single `.replace()` therefore hands back working
 * script from input it just "sanitised". Repeat to a fixed point instead.
 *
 * The bound is a safety valve, not a limit anyone should reach: each pass
 * strictly shortens the string, so a fixed point always arrives well before it.
 */
function stripExecutableElements(html: string): string {
	let current = html;
	for (let pass = 0; pass < 20; pass += 1) {
		const next = current.replace(EXECUTABLE_ELEMENT, '');
		if (next === current) return current;
		current = next;
	}
	// Twenty passes without settling means input crafted to defeat the loop, not
	// authored content. Refuse it rather than return a half-stripped string.
	return '';
}

export function sanitizeWriteHtml(html: string): string {
	return stripExecutableElements(html)
		.replace(EVENT_ATTRIBUTE, '')
		.replace(URL_ATTRIBUTE, (match, doubled?: string, singled?: string, bare?: string) => {
			const value = doubled ?? singled ?? bare ?? '';
			// The whole attribute goes, not just its value: an `href`-less `<a>` is
			// inert text, which is the right outcome for a link nobody may follow.
			return isSafeUrlValue(value) ? match : '';
		});
}

/**
 * One field value on its way to Apex.
 *
 * Rich text arrives as `{editor, html, content}` and its `html` is the part the
 * site renders; a field may also hold bare HTML as a string. Anything else — a
 * uuid, an enum, a plain title — passes through untouched, and so does a string
 * with no markup in it, so a name with an `&` in it is not rewritten.
 *
 * An array is walked rather than waved through. The only `array_ref` in the
 * contract today holds uuids, which have no `<` in them and so come back
 * unchanged — but an array is a value the caller controls, and the first
 * array-of-objects field would otherwise be an unsanitized hole straight to a
 * `{@html}` sink. Poovayya's write-boundary sanitizer walks arrays for the same
 * reason.
 */
export function sanitizeFieldValue(value: unknown): unknown {
	if (typeof value === 'string') {
		return value.includes('<') ? sanitizeWriteHtml(value) : value;
	}
	if (Array.isArray(value)) return value.map(sanitizeFieldValue);
	if (!value || typeof value !== 'object') return value;
	const stored = value as { html?: unknown };
	if (typeof stored.html !== 'string') return value;
	const html = sanitizeWriteHtml(stored.html);
	return html === stored.html ? value : { ...stored, html };
}
