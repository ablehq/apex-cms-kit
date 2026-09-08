/**
 * The WRITE-boundary sanitizer: what an admin is allowed to store.
 *
 * Distinct from `sanitize/html.js`, which is the RENDER-time allowlist a public
 * page passes stored HTML through. Both exist on purpose — the write boundary
 * stops a bad value entering Apex through this admin, and the render allowlist
 * covers everything already in Apex and everything written by any other client.
 * Neither is a substitute for the other, and they are named apart so a caller
 * cannot reach for one meaning the other.
 *
 * ONE REFERENCE GRAMMAR, SHARED. The decoding half is imported from `html.js`
 * rather than written again here. This module had its own `decodeEntities` and its
 * own control-character strip, and both were WEAKER than the render side's: a
 * lowercase-only named table that missed `&Tab;` (the real entity; `tab` is not
 * one), and a strip that left `\u200b` and NBSP in place. `sanitize-rich-text.ts`,
 * the Poovayya sanitizer this one replaced, stripped every reference before judging
 * — so the merge that produced this file was a REGRESSION on those inputs. Sharing
 * `decodeReferences` and `stripInvisible` is what stops the two judges drifting
 * apart again; `sanitize-html.test.js` already locks the decode grammar to the
 * escape grammar, so all three now move together.
 */

import { decodeReferences, stripInvisible } from './html.js';

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
 * A character reference that SURVIVED decoding — the write boundary's fail-closed rule.
 *
 * `decodeReferences` recognises the same windows the render escaper writes through:
 * 7 decimal digits, 6 hex, a named entity of at most 32 characters. A browser has no
 * such windows. `&#00000000106;avascript:` and `&#x0000006A;avascript:` are
 * `javascript:` to every browser and are left ALONE by the decoder, so judging the
 * decoded string waves them through — the bypass the P4 review proved live.
 *
 * The render side does not have this problem: whatever it cannot resolve it
 * re-escapes to `&amp;…`, so an unresolved reference reaches the page as text. NOTHING
 * RE-ESCAPES AT THE WRITE BOUNDARY — the value is stored as authored — so the only
 * safe answer here is to refuse. A URL that still carries `&#…` or `&name;` after a
 * full decode is not a URL any editor typed; it is an encoding this judge cannot
 * read, and "cannot be read" must not resolve to "safe".
 *
 * TWO NARROW FALSE POSITIVES, accepted (Opus O5, Fable FF6). A DOUBLE-ENCODED
 * reference — `&amp;amp;`, `&amp;#x26;` — decodes ONCE here to `&amp;` / `&#x26;`,
 * which still matches, so the value is refused; a browser also single-decodes it, to
 * the harmless text `&amp;`. And `?a=1&#2024` in a query string looks like the start
 * of a numeric reference. Both are refusals of something safe, which is the correct
 * direction for a fail-closed rule — but a SILENT strip of a safe attribute is not,
 * which is what `residualReferenceFieldNames` below exists to fix: the caller can
 * now name the field and say why instead of quietly dropping the link.
 *
 * Deliberately asymmetric: a NUMERIC reference is refused with or without its
 * semicolon, because a browser decodes `&#106` unterminated too, while a NAMED one is
 * refused only when terminated — an ordinary query string is full of `&name=value`
 * and none of the unterminated legacy names produce a letter or a colon.
 */
const RESIDUAL_REFERENCE = /&(?:#[0-9]|#[xX][0-9a-fA-F]|[a-zA-Z][a-zA-Z0-9]{1,31};)/u;

/** Any base will do: it decides only what a RELATIVE url resolves to. */
const RESOLUTION_BASE = 'https://sanitizer.invalid/';

/**
 * ` onclick="…"`, ` onerror=…` — quoted either way, or bare.
 *
 * THE SEPARATOR IS NOT ALWAYS WHITESPACE. This was `\son…`, and the HTML parser is
 * happy with none: `<svg/onload=alert(1)>`, `<img src="x"onerror=alert(1)>` and
 * `<a href="/x"/onclick=alert(1)>` all execute, and all three walked past a `\s`.
 * A quote or a slash ends an attribute just as well, so they start the next one.
 *
 * The whitespace case CONSUMES the space (so `<p onclick=x>x</p>` comes back
 * `<p>x</p>`, not `<p >x</p>`); the quote and slash cases are a LOOKBEHIND, because
 * that character belongs to the attribute before it and removing it would join two
 * tokens that were separate.
 */
const EVENT_ATTRIBUTE = /(?:\s|(?<=["'/]))on[a-z0-9_:-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/giu;

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
 *
 * `svg` and `math` carry executable children of their own — `<svg><animate
 * attributeName="href" values="javascript:…">` needs no event attribute and no
 * `href` on the svg itself, so neither the handler strip nor the protocol allowlist
 * sees it. `form`, `button` and `input` bring `formaction`, which is a navigation
 * target spelled somewhere the allowlist was not looking. All five are dropped here
 * with their contents.
 *
 * HOW THIS RELATES TO THE RENDER SIDE, precisely — the sentence that used to sit
 * here said "the two lists are meant to agree", and they do not, because they are
 * answering different questions. `html.js` has THREE lists: `DROP_WITH_CONTENT`
 * (dropped with their contents at render — `script`, `style`, `iframe`, `object`,
 * `embed`, `link`, `meta`, `base`, `svg`, `math` and more), `ALLOWED_TAGS` (kept),
 * and everything else, which is UNWRAPPED: the tag goes and its text stays. `form`,
 * `button` and `input` fall in that third bucket, so at render they lose their
 * attributes and leave their text — inert, but not the same operation as the drop
 * this list performs. `NEVER_ALLOWED` in `html.js` is the list that genuinely
 * corresponds to this one: what a site may never add to the render allowlist, and
 * it is a superset of both. The invariant that matters is not list equality, it is
 * that NOTHING EXECUTABLE SURVIVES EITHER SIDE — which each list secures on its own,
 * so neither depends on the other being right.
 */
const EXECUTABLE_ELEMENT =
	/<(script|style|iframe|object|embed|link|meta|base|svg|math|form|button|input)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?(?:script|style|iframe|object|embed|link|meta|base|svg|math|form|button|input)\b[^>]*>?/giu;

/**
 * ` href="…"`, ` src='…'`, ` xlink:href=…` — where a protocol can hide.
 *
 * The list is longer than the three attributes rich text is supposed to hold,
 * because a URL sink is not always spelled `href`: `formaction` on a submit button
 * and `action` on a form both navigate; `values`, `to` and `from` are how SVG
 * animation writes one; `poster`, `background`, `ping` and `data` are the rest of
 * the browser's URL-valued attributes on elements this sanitizer might otherwise
 * leave standing. The elements that carry most of them are dropped outright above —
 * this is the second lock on the same door, for the shapes the element denylist
 * cannot see.
 *
 * `data` matches only a whole attribute name: `data-foo="…"` has a `-` where the
 * `=` must be, so custom data attributes are untouched.
 *
 * The separator is read the same way `EVENT_ATTRIBUTE` reads it — whitespace
 * consumed, a closing quote or a slash matched by lookbehind — so
 * `<img src="x"formaction="javascript:…">` cannot hide behind the absence of a
 * space either.
 */
const URL_ATTRIBUTE =
	/(?:\s|(?<=["'/]))(?:href|src|xlink:href|formaction|action|values|to|from|poster|background|ping|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/giu;

/**
 * Is this attribute value something we are willing to store?
 *
 * Three steps, in this order, and each of them was a live bypass at some point:
 *
 *   1. DECODE, with the render side's grammar (`decodeReferences`). The browser
 *      decodes an attribute value before it parses it as a URL, so
 *      `href="&#106;avascript:…"` IS `javascript:` by the time it matters.
 *   2. REFUSE ANYTHING STILL ENCODED (`RESIDUAL_REFERENCE`). Fail closed: the
 *      decoder's digit windows are narrower than a browser's, and nothing
 *      re-escapes at the write boundary.
 *   3. STRIP THE INVISIBLES, again with the render side's function. `new URL`
 *      removes tab, LF and CR itself; it leaves the rest of C0, C1, NBSP and the
 *      zero-width and bidi marks in place, and a value that then fails scheme
 *      parsing resolves as a RELATIVE url — which reads as safe.
 *
 * Only then `new URL`, not a string match: it is the same parser the browser will
 * use, and a relative or anchor value resolves against the base and comes back
 * `https:`, which is why they need no case of their own.
 *
 * A non-ASCII HOST survives all of this — `stripInvisible` removes formatting
 * characters, not letters — which is what Poovayya's `[^!-~]` strip destroyed and
 * the reason that half was never carried over.
 */
export function isSafeUrlValue(raw: string): boolean {
	const decoded = decodeReferences(raw);
	if (RESIDUAL_REFERENCE.test(decoded)) return false;
	const value = stripInvisible(decoded);
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

/**
 * Does this string carry a URL attribute that is being refused ONLY because it still
 * holds a character reference after a full decode?
 *
 * The distinction matters. `sanitizeWriteHtml` drops a `javascript:` href, and that
 * is a correct silent strip — nobody needs to be told their script was removed. It
 * ALSO drops an href the decoder could not read, which is a different act: the value
 * may be perfectly safe (`?a=1&#2024`, a double-encoded `&amp;amp;`) and the editor
 * is simply told nothing while their link disappears. Fail-closed is right; failing
 * SILENTLY is not.
 */
function hasResidualReferenceUrl(value: string): boolean {
	if (!value.includes('<')) return false;
	for (const match of value.matchAll(URL_ATTRIBUTE)) {
		const raw = match[1] ?? match[2] ?? match[3] ?? '';
		if (raw === '') continue;
		if (RESIDUAL_REFERENCE.test(decodeReferences(raw))) return true;
	}
	return false;
}

/** Walk one field value the way `sanitizeFieldValue` does, looking for the above. */
function residualReferenceInValue(value: unknown): boolean {
	if (typeof value === 'string') return hasResidualReferenceUrl(value);
	if (Array.isArray(value)) return value.some(residualReferenceInValue);
	if (!value || typeof value !== 'object') return false;
	return Object.values(value as Record<string, unknown>).some(residualReferenceInValue);
}

/**
 * The names of the fields in one write that carry a URL this judge cannot read.
 *
 * OPUS O5. The shape is `oversizedFieldNames`': names rather than a boolean, so the
 * refusal can say WHICH field, and the caller turns it into a typed 400
 * (`unreadable-url` — `refuseUnreadableUrls` in `server/bff/reject.ts`). The two are
 * deliberately the same shape and are called next to each other on every write path,
 * because they are the same kind of rule: something about this write cannot be
 * accepted, and the editor should be told which field to look at rather than left to
 * find it by bisection or, worse, to discover afterwards that a link is gone.
 *
 * This does NOT widen what is stored. `sanitizeWriteHtml` still strips the attribute
 * if the value ever reaches it; the write is simply refused first, with a reason.
 */
export function residualReferenceFieldNames(fields: unknown): string[] {
	if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return [];
	const named: string[] = [];
	for (const [name, value] of Object.entries(fields as Record<string, unknown>)) {
		if (residualReferenceInValue(value)) named.push(name);
	}
	return named;
}
