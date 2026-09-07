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

/**
 * The most characters one field value may carry into Apex.
 *
 * A ceiling is a MECHANIC, not a screen's preference (kit boundary, §5): without one,
 * a single authenticated POST can push an unbounded string through the BFF, into
 * Apex, into the published snapshot and into every page render that reads the field.
 * Poovayya carried this rule alone (`records.ts:349`, `z.string().max(200_000)`) and
 * the kit had no equivalent — no `.max` on a field value and no body cap — so every
 * site on the kit's record and entity write paths had none either.
 *
 * 200 000 is Poovayya's number and the kit's own rich-text block cap
 * (`post-shape.ts`'s `blockSchema.html`) — the two were the same literal in two
 * places, and this is now the one place they both read.
 */
export const MAX_FIELD_VALUE_CHARS = 200_000;

/**
 * C0 controls and DEL, which a scheme can hide inside.
 *
 * `new URL` removes ASCII tab, LF and CR for us — they are stripped by the URL
 * parser itself, which is why `java<TAB>script:` already fails. It does NOT remove
 * the rest of the C0 range, so `java<NUL>script:` and `java<VT>script:` reach the
 * parser intact, fail scheme parsing, and resolve as a RELATIVE url — which reads
 * as safe. That is what a browser does with them too, so this is defence rather
 * than a live bypass; a URL has no legitimate use for a raw control character, and
 * Poovayya's sanitizer refused them, so the kit's does now as well.
 *
 * Only the control range is removed. Poovayya stripped everything outside printable
 * ASCII (`[^!-~]`), which also destroys legitimate IDN hosts and unicode paths, so
 * that part is deliberately NOT carried over.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/gu;

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
 * Resolved with `new URL`, not string-matched: the URL parser strips the tabs and
 * newlines `java\tscript:` hides behind, and it is the same parser the browser will
 * use. A relative or anchor value resolves against the base and comes back
 * `https:`, which is why they need no case of their own. The remaining C0 controls
 * the URL parser leaves in place are removed first — see `CONTROL_CHARACTERS`.
 */
export function isSafeUrlValue(raw: string): boolean {
	const value = decodeEntities(raw).replace(CONTROL_CHARACTERS, '').trim();
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
 * `{@html}` sink.
 *
 * EVERY OBJECT VALUE IS WALKED, not just a top-level `html`. That is the one place
 * Poovayya's sanitizer was stronger than this one and the reason the two are being
 * merged rather than one kept: `{a: {html: '<script>…'}}` came back UNTOUCHED here,
 * because only `value.html` was looked at and `value.a` was not a string. A field
 * value is caller-controlled JSON — a rich-text object, a list of them, or a shape
 * nobody has written yet — so the walk is structural rather than keyed on one
 * property name, and the `{editor, html, content}` case falls out of it.
 *
 * The identity contract is unchanged: a value nothing needed doing to comes back as
 * the SAME object, so a caller can still tell "sanitized" from "untouched" by
 * reference. One accepted cost of the walk: a tiptap `content` node whose `text`
 * literally spells an executable tag has that text stripped, the way Poovayya has
 * always behaved. Storing it verbatim next to the `html` the site renders is the
 * worse of the two.
 */
export function sanitizeFieldValue(value: unknown): unknown {
	if (typeof value === 'string') {
		return value.includes('<') ? sanitizeWriteHtml(value) : value;
	}
	if (Array.isArray(value)) {
		let moved = false;
		const walked = value.map((entry) => {
			const next = sanitizeFieldValue(entry);
			if (next !== entry) moved = true;
			return next;
		});
		return moved ? walked : value;
	}
	if (!value || typeof value !== 'object') return value;
	let moved = false;
	const walked: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
		const next = sanitizeFieldValue(nested);
		if (next !== nested) moved = true;
		walked[key] = next;
	}
	return moved ? walked : value;
}

/**
 * How many characters this field value costs, for `MAX_FIELD_VALUE_CHARS`.
 *
 * A string is its own length. Anything structured is measured by what actually
 * travels — its JSON encoding — because that is what the BFF forwards, what Apex
 * stores and what the published snapshot carries; measuring only the strings inside
 * would let a caller spend the same bytes on ten thousand keys instead of one long
 * value. A value that will not encode is refused rather than waved through: it
 * cannot reach Apex anyway, and "cannot be measured" must not read as "small".
 */
export function fieldValueChars(value: unknown): number {
	if (typeof value === 'string') return value.length;
	if (value === null || value === undefined) return 0;
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

/**
 * The names of the fields in one write that are over the ceiling.
 *
 * Names, not a boolean, so the refusal can say WHICH field — an editor who pasted a
 * document into one of twenty fields should not have to find it by bisection. The
 * caller turns this into a typed 400; reaching Apex with it would be a 500 or, worse
 * on the flat surface, a 200 over a truncated store.
 */
export function oversizedFieldNames(fields: unknown): string[] {
	if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return [];
	const over: string[] = [];
	for (const [name, value] of Object.entries(fields as Record<string, unknown>)) {
		if (fieldValueChars(value) > MAX_FIELD_VALUE_CHARS) over.push(name);
	}
	return over;
}
