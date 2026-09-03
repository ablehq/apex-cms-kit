/**
 * The vendored sanitize-on-render module (plan §7).
 *
 * Keus renders CMS rich text through 38 unsanitized `{@html}` sinks. Anything
 * that can write `fields_data` — the editor, or the API directly — can therefore
 * execute script on the public site. This module is the reason we do not copy
 * that: every `{@html}` sink in this repo renders a string that came out of
 * here.
 *
 * ## Why hand-written rather than a dependency
 *
 * The property that makes a small sanitizer safe is not the size of its tag
 * table — it is that **the output is generated, never passed through**. Nothing
 * from the input is copied verbatim into the result:
 *
 * - text is re-escaped on the way out;
 * - an allowed element is re-serialized from its parsed name and its surviving
 *   attributes, each value re-escaped;
 * - anything unrecognised is dropped, not escaped-and-kept.
 *
 * So a tokenizer mistake degrades to losing content, never to emitting markup we
 * did not choose to emit. `<scr<script>ipt>` cannot reassemble downstream
 * because neither half is ever written out. That is a much smaller thing to get
 * right than a parser that has to round-trip arbitrary HTML faithfully, and it
 * is why this is ~250 lines instead of a dependency.
 *
 * ## What it deliberately does not do
 *
 * It is not a general-purpose HTML sanitizer and must not be reused as one. It
 * knows one input shape: rich text produced by the block editor. Tables, images,
 * forms, iframes, `style` attributes and `id` attributes are all absent from the
 * allowlist — an element carrying only unknown attributes still renders, an
 * element that is not on the list is unwrapped, and the executable-content
 * elements are dropped with their contents. `img` is a deliberate v1 omission
 * (media is a gallery reference field, not inline markup); revisit it with the
 * editor in phase 3a rather than by widening the list here.
 *
 * The sanitizer runs at projection time in `+page.server.js` — so no live
 * payload is serialized into a route's `__data.json` — and again in the one
 * `{@html}` sink component, so the sink is self-evidently safe when read on its
 * own. `sanitize(sanitize(x)) === sanitize(x)`, asserted in the corpus tests.
 */

/** Elements we are willing to emit. Everything else is unwrapped or dropped. */
const ALLOWED_TAGS = new Set([
	'a',
	'b',
	'blockquote',
	'br',
	'code',
	'div',
	'em',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'hr',
	'i',
	'li',
	'ol',
	'p',
	'pre',
	's',
	'span',
	'strike',
	'strong',
	'sub',
	'sup',
	'u',
	'ul'
]);

/** Emitted without a closing tag. */
const VOID_TAGS = new Set(['br', 'hr']);

/**
 * Elements whose *contents* go with them. These either execute (`script`), can
 * carry executable children (`svg`, `math`, `template`), or are parsed as raw
 * text by the browser, which makes "keep the text" the wrong answer.
 */
const DROP_WITH_CONTENT = new Set([
	'applet',
	'audio',
	'base',
	'canvas',
	'embed',
	'frame',
	'frameset',
	'head',
	'iframe',
	'link',
	'math',
	'meta',
	'noembed',
	'noframes',
	'noscript',
	'object',
	'plaintext',
	'script',
	'style',
	'svg',
	'template',
	'textarea',
	'title',
	'video',
	'xmp'
]);

/**
 * The members of `DROP_WITH_CONTENT` that have no content: they never get a
 * closing tag, so treating them like `<script>` would swallow the rest of the
 * document. `<meta http-equiv="refresh">` is the one that bites.
 */
const VOID_DROP_TAGS = new Set(['base', 'embed', 'frame', 'link', 'meta']);

/** Attributes kept per element. Nothing is global except `class`. */
const ALLOWED_ATTRIBUTES = new Map([['a', new Set(['href', 'title'])]]);

/** Attributes whose value is a URL and must survive `safeUrl`. */
const URL_ATTRIBUTES = new Set(['href']);

const ALLOWED_URL_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

/**
 * Class is the one attribute rich text genuinely needs — the editor expresses
 * alignment and indentation with it, and our own typographic ornaments (the
 * drop cap) are authored with it. Unknown tokens are dropped rather than the
 * whole attribute, so `class="ql-align-center evil"` keeps the alignment.
 */
const ALLOWED_CLASSES = new Set([
	'glc-dropcap',
	'glc-lede',
	'glc-scripture',
	'ql-align-center',
	'ql-align-justify',
	'ql-align-right',
	'ql-indent-1',
	'ql-indent-2',
	'ql-indent-3',
	'ql-indent-4',
	'ql-indent-5',
	'ql-indent-6',
	'ql-indent-7',
	'ql-indent-8'
]);

/** Depth cap, so pathological nesting cannot build an unbounded close stack. */
const MAX_DEPTH = 64;

const NAMED_ENTITIES = new Map([
	['amp', '&'],
	['apos', "'"],
	['colon', ':'],
	['gt', '>'],
	['lt', '<'],
	['newline', '\n'],
	['quot', '"'],
	['sol', '/'],
	['tab', '\t']
]);

/**
 * A character reference in *text* can only ever produce a character, never
 * markup, so valid references are preserved rather than double-escaped —
 * otherwise every `&nbsp;` the editor emits would render as literal text.
 *
 * ⚠ COUPLED TO `decodeReferences`. This is the *escape* grammar: a reference it
 * matches is written through live (`&…;`), which means the browser will decode
 * it. `decodeReferences` is the *decode* grammar the URL judge uses to see what
 * that reference becomes. The two MUST recognise the same reference forms — the
 * same numeric digit windows and the same named set. Widen one without the
 * other and a URL can carry a live reference the judge never resolved (e.g.
 * `javascript&colon;…`), which is the single edit that turns this sanitizer
 * exploitable. The symmetry is locked by a test in `tests/sanitize-html.test.js`
 * ("the escape grammar and the decode grammar recognise the same references").
 */
const CHARACTER_REFERENCE = /&(?:[a-zA-Z][a-zA-Z0-9]{1,31};|#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};)/y;

/** @param {string} value */
function escapeText(value) {
	let out = '';
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (character === '<') {
			out += '&lt;';
		} else if (character === '>') {
			out += '&gt;';
		} else if (character === '&') {
			CHARACTER_REFERENCE.lastIndex = index;
			out += CHARACTER_REFERENCE.test(value) ? '&' : '&amp;';
		} else {
			out += character;
		}
	}
	return out;
}

/** @param {string} value */
function escapeAttribute(value) {
	return escapeText(value).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/**
 * Decode enough of the character references to defeat the classic obfuscated
 * scheme (`java&#115;cript:`, `javascript&colon;`). Used only to *judge* a URL —
 * the value written back out is always the original, escaped.
 *
 * ⚠ COUPLED TO `CHARACTER_REFERENCE`. This is the *decode* grammar; that regex
 * is the *escape* grammar that decides which references are written through
 * live. They must recognise the same reference forms — matching numeric digit
 * windows (7 decimal, 6 hex) and the `NAMED_ENTITIES` set — or a reference the
 * escape side preserves could reach the browser without this judge ever
 * resolving it. Exported so the coupling test can assert the two agree.
 *
 * @param {string} value
 */
export function decodeReferences(value) {
	return value.replace(
		/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g,
		(match, body) => {
			if (body[0] === '#') {
				const code =
					body[1] === 'x' || body[1] === 'X'
						? Number.parseInt(body.slice(2), 16)
						: Number.parseInt(body.slice(1), 10);
				if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
				try {
					return String.fromCodePoint(code);
				} catch {
					return match;
				}
			}
			return NAMED_ENTITIES.get(body.toLowerCase()) ?? match;
		}
	);
}

/**
 * Every character a browser skips or ignores while reading a URL scheme:
 * C0/C1 controls, spaces, and the zero-width and bidirectional marks. Removing
 * them is what stops `java\u200bscript:` and `jav\tascript:` from reading as a
 * relative path to a naive scheme test.
 *
 * @param {string} value
 */
function stripInvisible(value) {
	let out = '';
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		const invisible =
			code <= 0x20 ||
			(code >= 0x7f && code <= 0xa0) ||
			(code >= 0x200b && code <= 0x200f) ||
			(code >= 0x2028 && code <= 0x202e) ||
			code === 0xfeff;
		if (!invisible) out += character;
	}
	return out;
}

/**
 * Judge a URL by what a browser would actually navigate to: references decoded,
 * then every character a browser ignores while reading the scheme stripped out.
 *
 * @param {string} raw
 * @returns {boolean} whether the original value is safe to emit
 */
export function isSafeUrl(raw) {
	const decoded = stripInvisible(decodeReferences(raw));
	if (decoded === '') return false;
	const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(decoded);
	if (!scheme) {
		// No scheme at all: a relative path, a query, or a fragment. The one
		// shape to refuse is a bare backslash pair, which some browsers still
		// read as protocol-relative.
		return !decoded.startsWith('\\\\');
	}
	return ALLOWED_URL_SCHEMES.has(scheme[1].toLowerCase());
}

/**
 * @param {string} value
 * @returns {string} the surviving class tokens, or '' when none survive
 */
function filterClasses(value) {
	return decodeReferences(value)
		.split(/\s+/u)
		.filter((token) => ALLOWED_CLASSES.has(token))
		.join(' ');
}

/**
 * @typedef {{ end: number, kind: 'open' | 'close' | 'ignore', name?: string,
 *   attributes?: Array<[string, string]>, selfClosing?: boolean }} Token
 */

/**
 * Read one `<...>` construct starting at `start`. An unterminated construct
 * consumes the rest of the input and is ignored — leaving a dangling `<script`
 * behind is exactly the mistake this module exists to avoid.
 *
 * @param {string} html
 * @param {number} start
 * @returns {Token}
 */
function readTag(html, start) {
	if (html.startsWith('<!--', start)) {
		const end = html.indexOf('-->', start + 4);
		return { kind: 'ignore', end: end === -1 ? html.length : end + 3 };
	}
	if (html.startsWith('<!', start) || html.startsWith('<?', start)) {
		const end = html.indexOf('>', start + 2);
		return { kind: 'ignore', end: end === -1 ? html.length : end + 1 };
	}

	const closing = html.startsWith('</', start);
	const nameStart = start + (closing ? 2 : 1);
	const nameMatch = /^[a-zA-Z][a-zA-Z0-9:_.-]*/u.exec(html.slice(nameStart));
	if (!nameMatch) {
		// Not a tag: a stray `<`. The caller re-reads it as text.
		return { kind: 'ignore', end: start + 1, name: undefined };
	}
	const name = nameMatch[0].toLowerCase();
	let index = nameStart + nameMatch[0].length;

	if (closing) {
		const end = html.indexOf('>', index);
		return { kind: 'close', name, end: end === -1 ? html.length : end + 1 };
	}

	/** @type {Array<[string, string]>} */
	const attributes = [];
	let selfClosing = false;
	while (index < html.length) {
		while (index < html.length && /\s/u.test(html[index])) index += 1;
		if (index >= html.length) break;
		if (html[index] === '>') {
			index += 1;
			break;
		}
		if (html[index] === '/') {
			selfClosing = true;
			index += 1;
			continue;
		}
		const attributeName = /^[^\s/>=]+/u.exec(html.slice(index));
		if (!attributeName) {
			index += 1;
			continue;
		}
		index += attributeName[0].length;
		while (index < html.length && /\s/u.test(html[index])) index += 1;
		let value = '';
		if (html[index] === '=') {
			index += 1;
			while (index < html.length && /\s/u.test(html[index])) index += 1;
			const quote = html[index];
			if (quote === '"' || quote === "'") {
				const end = html.indexOf(quote, index + 1);
				value = html.slice(index + 1, end === -1 ? html.length : end);
				index = end === -1 ? html.length : end + 1;
			} else {
				const unquoted = /^[^\s>]*/u.exec(html.slice(index));
				value = unquoted ? unquoted[0] : '';
				index += value.length;
			}
		}
		attributes.push([attributeName[0].toLowerCase(), value]);
	}

	return { kind: 'open', name, attributes, selfClosing, end: index };
}

/**
 * @param {string} name
 * @param {Array<[string, string]>} attributes
 */
function serializeAttributes(name, attributes) {
	const allowed = ALLOWED_ATTRIBUTES.get(name);
	const seen = new Set();
	let out = '';
	for (const [attribute, value] of attributes) {
		if (seen.has(attribute)) continue;
		if (attribute === 'class') {
			const classes = filterClasses(value);
			if (!classes) continue;
			seen.add(attribute);
			out += ` class="${escapeAttribute(classes)}"`;
			continue;
		}
		if (!allowed?.has(attribute)) continue;
		if (URL_ATTRIBUTES.has(attribute) && !isSafeUrl(value)) continue;
		seen.add(attribute);
		out += ` ${attribute}="${escapeAttribute(value)}"`;
	}
	return out;
}

/**
 * Sanitize a rich-text HTML string down to the allowlist.
 *
 * @param {unknown} input
 * @returns {string}
 */
export function sanitizeHtml(input) {
	if (typeof input !== 'string' || input === '') return '';

	let out = '';
	/** @type {string[]} */
	const open = [];
	let index = 0;
	/** @type {string | null} */
	let dropping = null;
	let droppingDepth = 0;

	while (index < input.length) {
		const next = input.indexOf('<', index);
		if (next === -1) {
			if (!dropping) out += escapeText(input.slice(index));
			break;
		}
		if (!dropping && next > index) out += escapeText(input.slice(index, next));

		const token = readTag(input, next);
		if (token.end <= next) {
			// Defensive: never fail to advance.
			index = next + 1;
			continue;
		}
		index = token.end;

		if (dropping) {
			if (token.kind === 'open' && token.name === dropping && !token.selfClosing) {
				droppingDepth += 1;
			} else if (token.kind === 'close' && token.name === dropping) {
				droppingDepth -= 1;
				if (droppingDepth === 0) dropping = null;
			}
			continue;
		}

		if (token.kind === 'ignore') {
			// A stray `<` that starts nothing: keep it as text so prose reading
			// "a < b" survives.
			if (token.end === next + 1) out += '&lt;';
			continue;
		}

		const name = /** @type {string} */ (token.name);

		if (token.kind === 'close') {
			const depth = open.lastIndexOf(name);
			if (depth === -1) continue;
			for (let level = open.length - 1; level >= depth; level -= 1) {
				out += `</${open[level]}>`;
			}
			open.length = depth;
			continue;
		}

		if (DROP_WITH_CONTENT.has(name)) {
			if (!token.selfClosing && !VOID_DROP_TAGS.has(name)) {
				dropping = name;
				droppingDepth = 1;
			}
			continue;
		}
		if (!ALLOWED_TAGS.has(name)) continue; // unwrap: the tag goes, its text stays

		const attributes = serializeAttributes(name, token.attributes ?? []);
		if (VOID_TAGS.has(name)) {
			out += `<${name}${attributes}>`;
			continue;
		}
		if (token.selfClosing) {
			out += `<${name}${attributes}></${name}>`;
			continue;
		}
		if (open.length >= MAX_DEPTH) continue;
		out += `<${name}${attributes}>`;
		open.push(name);
	}

	for (let level = open.length - 1; level >= 0; level -= 1) out += `</${open[level]}>`;
	return out;
}

/**
 * A rich-text field arrives as `{editor, html, content}` from the block editor,
 * or as a bare string from a plain-text field that happens to be rendered as
 * markup. Both reduce to "the HTML we are willing to render".
 *
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeRichText(value) {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return sanitizeHtml(value);
	if (typeof value === 'object' && 'html' in value) {
		return sanitizeHtml(/** @type {{ html?: unknown }} */ (value).html);
	}
	return '';
}

/**
 * The blog body's `[[link:href|text]]` shorthand, expanded into a safe anchor.
 *
 * ⚠ Runs on ALREADY-SANITIZED html only — never on raw input. `renderParagraphHtml`
 * passes the body through `sanitizeHtml` first, so every real tag is on the
 * allowlist and every text run is escaped by the time we get here. The `[[…]]`
 * tokens are plain text to the sanitizer — `[`, `]`, `:` and `|` are not markup —
 * so they survive that pass intact and are the only thing left to expand.
 *
 * Two things keep the emitted anchor safe:
 *   • the scheme is judged by `isSafeUrl`, which decodes obfuscated references
 *     first (`javascript:` and `java&#115;cript:` both fail) — an unsafe link
 *     degrades to its already-escaped text, never an anchor;
 *   • the href is re-escaped for ATTRIBUTE context. `sanitizeHtml`'s text escape
 *     leaves `"`/`'` raw (they are harmless in text), which WOULD break out of an
 *     attribute; `escapeAttribute` closes that. Both escapers are idempotent over
 *     valid references, so escaping the already-escaped href is a no-op, not a
 *     double-encode.
 *
 * The `target`/`rel`/`class` on the anchor are OURS, emitted here rather than
 * copied from input — which is why they survive at all: the sanitizer's `a`
 * allowlist is href/title only, so expanding BEFORE sanitizing would strip them.
 * Sanitizing first, expanding second, keeps both the safety and the styling.
 *
 * ⚠ The two groups are LENGTH-BOUNDED on purpose. Unbounded `[^|]+`/`[^\]]+`,
 * combined with the global scan restarting at every `[[link:`, made expansion
 * O(n²): an adversarial body of many `[[link:` prefixes, one `|`, and no closing
 * `]]` cost seconds of CPU per render — a stored DoS on the SSR blog route,
 * writable by anyone who can author a blog body. A real href or link text is
 * short; capping each at 2048 chars keeps expansion linear and degrades an
 * over-long token to its (already-escaped) text, exactly like an unsafe scheme.
 */
const INLINE_LINK_PATTERN = /\[\[link:([^|]{1,2048})\|([^\]]{1,2048})\]\]/gu;

/** @param {string} sanitizedHtml */
function expandInlineLinks(sanitizedHtml) {
	return sanitizedHtml.replace(
		INLINE_LINK_PATTERN,
		(/** @type {string} */ _whole, /** @type {string} */ href, /** @type {string} */ text) => {
			// Two reasons to refuse and fall back to the (already-escaped) text:
			//   • an unsafe scheme (`javascript:` and obfuscations, judged decoded);
			//   • a raw quote or angle bracket in the href — a real URL never carries
			//     one, so it is an attribute-breakout attempt. Escaping WOULD neutralise
			//     it, but the escaped `onmouseover=` still trips coarse handler scanners
			//     (including the output gate's), so we drop the anchor rather than emit
			//     a mangled one.
			if (!isSafeUrl(href) || /["'<>]/u.test(href)) return text;
			return (
				`<a href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer" ` +
				`class="link-text text-stone-700 underline body-serif">${text}</a>`
			);
		}
	);
}

/**
 * The blog paragraph sink (`Paragraph.svelte`). The one `{@html}` sink on the
 * public blog route, made safe by construction: sanitize the raw body to the
 * allowlist FIRST — so any stored markup (`<script>`, an `onerror` attribute, a
 * `javascript:` href) is inert and cross-tag formatting stays intact — then
 * expand the `[[link:…]]` shorthand into safe anchors on the sanitized string.
 *
 * The blog route is server-rendered (not prerendered), so the build-time output
 * gate never sees its HTML; this render-time pass IS the defense.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function renderParagraphHtml(text) {
	if (typeof text !== 'string') return '';
	return expandInlineLinks(sanitizeHtml(text));
}

/**
 * The reading text of a rich-text value, for a meta description or image `alt`.
 * Runs on already-sanitized markup, strips the tags, and decodes the handful of
 * entities a reader wants resolved.
 *
 * ⚠ SAFE SINK ONLY — the name is the warning. This is *not* raw-HTML-safe. It
 * deliberately leaves `<` and `>` escaped, so it can never reassemble a tag; but
 * it *does* decode `&quot;`, `&#39;` and `&amp;`, so its output can contain a
 * raw `"` or `'`. That is correct for its one job: an attribute value that a
 * template engine re-escapes — the meta `content=` and image `alt=` sinks are
 * Svelte-escaped. It must NEVER feed a `{@html}` sink, a JSON-LD blob, or a
 * hand-built tag/attribute string, where a decoded quote could break out.
 *
 * (Renamed from `richTextToPlainText`, which read as "safe plain text" and
 * invited exactly that misuse.)
 *
 * @param {unknown} value
 * @returns {string}
 */
export function plainTextForAttribute(value) {
	return (
		sanitizeRichText(value)
			.replace(/<[^>]*>/gu, ' ')
			.replace(/&nbsp;|&#160;|&#xa0;/giu, ' ')
			// `&lt;`/`&gt;` are left escaped on purpose: decoding them would let this
			// function reconstruct a `<tag>` from sanitized text. Everything after this
			// point can produce a raw character but never a raw angle bracket.
			.replace(/&quot;/giu, '"')
			.replace(/&#39;|&apos;/giu, "'")
			.replace(/&amp;/giu, '&')
			.replace(/\s+/gu, ' ')
			.trim()
	);
}
