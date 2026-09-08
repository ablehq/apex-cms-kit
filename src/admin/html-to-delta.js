// @ts-nocheck — legacy-mode admin browser module (plan §8, 3a compile-mode (a)).
// Deliberately untyped JS to sit beside the legacy-compiled admin components; its
// behavior is covered by tests/html-to-delta.test.js and tests/rich-text.test.js.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
// A `rich_text` field stores `{editor, html, content}`. When `editor` is
// `'quilljs'`, `content` is a QUILL DELTA — and Apex's own CMS UI, which every
// client is still using on these same records, LOADS ITS EDITOR FROM `content`,
// NOT FROM `html`:
//
//   apex-cms-template/src/lib/components/archetypes/RichTextArchetypeSchemaItem.svelte:47-48
//       const parsedValue = JSON.parse(value);
//       if (parsedValue?.content) quill.setContents(parsedValue.content);
//   …and writes both back at :59-62 (`content: quill.getContents()`,
//       `html: quill.getSemanticHTML({preserveWhitespace: true})`).
//
// Until this module existed, the kit's admin built that delta from
// `richTextPlainText()` — MARKUP STRIPPED — so a bold word or a heading typed in
// the new admin became one unattributed insert. Open the same record in the old
// admin and the formatting was gone from what Quill loaded; the next save there
// wrote the loss into `html` as well. Not a regression the kit introduced (the
// previously pinned revision emptied `content` outright), but a defect that would
// have been published into a package three sites depend on.
//
// ── THE SET THIS MODULE CARRIES, AND WHERE IT COMES FROM ────────────────────
// Two toolbars write into the same field, so the conversion has to carry the
// union of what they can produce, not just the newer one's five buttons.
//
//   1. The kit's own control, `ui/RichTextField.svelte` — five `execCommand`
//      buttons: bold (`<b>`), italic (`<i>`), heading (`formatBlock '<h2>'`),
//      link (`createLink` → `<a href>`), bulleted list (`<ul><li>`); plus the
//      `<p>`/`<div>`/`<br>` a contenteditable emits while typing, and plain text
//      from the forced-plain-text paste path.
//   2. Apex's own CMS UI, whose stored `html` is what the kit's control READS
//      into its surface — so anything Quill can emit round-trips through here on
//      the next keystroke. Its two mounts declare, between them:
//      header 1–4, bold, italic, underline, strike, link, bullet and ordered
//      lists (`RichText.svelte:11-14`, `RichTextArchetypeSchemaItem.svelte:27-32`).
//
// Everything below was MEASURED against Quill 2.0.3 (the version
// `apex-cms-template/package.json:58` pins) driven under jsdom, feeding each
// delta through `setContents` and reading back `getSemanticHTML({preserveWhitespace:
// true})` — the exact pair of calls the old admin makes:
//
//   bold      {insert:'x',attributes:{bold:true}}            ↔ <strong>x</strong>
//   italic    {insert:'x',attributes:{italic:true}}          ↔ <em>x</em>
//   underline {insert:'x',attributes:{underline:true}}       ↔ <u>x</u>
//   strike    {insert:'x',attributes:{strike:true}}          ↔ <s>x</s>
//   code      {insert:'x',attributes:{code:true}}            ↔ <code>x</code>
//   script    {insert:'x',attributes:{script:'super'}}       ↔ <sup>x</sup>
//   link      {insert:'x',attributes:{link:'…'}}             ↔ <a href="…" rel=… target=…>x</a>
//   header    {insert:'\n',attributes:{header:2}}            ↔ <h2>…</h2>
//   blockquote{insert:'\n',attributes:{blockquote:true}}     ↔ <blockquote>…</blockquote>
//   list      {insert:'\n',attributes:{list:'bullet'}}       ↔ <ul><li>…</li></ul>
//             {insert:'\n',attributes:{list:'ordered'}}      ↔ <ol><li>…</li></ol>
//   nesting   {insert:'\n',attributes:{list:'bullet',indent:1}}
//                                                            ↔ <ul><li>a<ul><li>b</li></ul></li></ul>
//   align     {insert:'\n',attributes:{align:'center'}}      ↔ <p class="ql-align-center">…</p>
//   indent    {insert:'\n',attributes:{indent:2}}            ↔ <p class="ql-indent-2">…</p>
//   paragraph {insert:'a\n\nb\n'}                            ↔ <p>a</p><p></p><p>b</p>
//
// `ql-align-*` and `ql-indent-*` are here because they are the two class families
// `sanitize/html.js` explicitly allows through to the public site, so they are
// values the stored html is expected to carry.
//
// ── WHAT IS DELIBERATELY NOT CARRIED ───────────────────────────────────────
// `<pre>` / `code-block`. Quill 2.0.3's own `getSemanticHTML()` does not
// round-trip it: a two-line code block serializes to
// `<pre data-language="plain">\n\n\n</pre>` — THE TEXT IS ALREADY GONE from the
// html before this module sees it. There is nothing to reconstruct, neither
// toolbar can produce one, and inventing a `code-block` attribute from an empty
// `<pre>` would write a delta that disagrees with the html. It parses as an
// ordinary block instead. Images and embeds likewise: neither toolbar emits one
// and `sanitize/html.js` drops `img` on render.
//
// ── WHY NOT THE SANITIZER'S TOKENIZER ──────────────────────────────────────
// `sanitize/html.js` has a `readTag` this file could have imported, and it is
// deliberately not imported. That module's contract is "the output is generated,
// never passed through — a tokenizer mistake degrades to losing content"; this
// one's is the opposite, "reproduce the structure faithfully". Its own docblock
// says it is not a general-purpose parser and must not be reused as one, and its
// character-reference grammar carries a coupling warning against widening —
// which this module has to do (`&nbsp;` is not in the sanitizer's named set and
// is the single most common reference a contenteditable emits). Giving a security
// boundary a second consumer with a different contract is how one gets widened
// for the other's benefit. The URL JUDGEMENT is imported, because that is a
// judgement rather than a tokenizer and there must be exactly one of it.
//
// ── THE DELTA IS DERIVED FROM WHAT WILL BE STORED ──────────────────────────
// codex P5 fix 4, item 3. A `rich_text` value's two halves — `html` and the delta
// in `content` — are ONE value shown by two editors, so they must say the same
// thing. They were being judged by DIFFERENT RULES, and could therefore disagree:
//
//   • The link check here was the RENDER-time `isSafeUrl`, which resolves an
//     unresolved character reference as a relative URL and calls it safe.
//     `href="&#00000000106;avascript:x"` is `javascript:` to a browser (its
//     numeric window has no 7-digit limit); the write boundary REFUSES it as
//     unreadable, so the stored html lost the href while the delta kept a link.
//   • Unknown elements are unwrapped here — text survives, tag does not — but the
//     write boundary DROPS `<script>`, `<style>`, `<svg>`, `<form>` and the rest
//     of the executable set WITH THEIR CONTENTS. So `<script>alert(1)</script>`
//     left the stored html empty and the delta holding `alert(1)` as prose.
//
// Both are closed the same way: this module runs `sanitizeWriteHtml` over its
// input FIRST and parses the result, and uses `isSafeUrlValue` — the write
// boundary's strict predicate — for `<a href>`. The delta is then a reading of
// exactly the html that reaches Apex, not of what was typed.
//
// WHAT THAT DOES AND DOES NOT PROMISE. It is true of a delta THIS MODULE builds:
// it reads sanitized html, so it can carry nothing the html beside it does not.
// The sentence that used to sit here went further — "if a write path ever forgets
// to sanitize, the delta is the STRICTER of the two, never the looser one" — and
// that was FALSE IN BOTH DIRECTIONS, because a delta does not have to come from
// here. The BFF accepts `{html, content}` as authored, and `sanitizeFieldValue`
// was running the MARKUP sanitizer over `content` as well: text that merely
// looked like a tag was deleted from the delta while the html kept it escaped
// (stricter, and a data loss), and a `javascript:` scheme spelled
// `attributes.link` has no `<` in it, so it rode through beside an `<a>` whose
// href had just been stripped (looser). Neither direction was this module's to
// fix and neither is closed here: the write boundary now judges a rich-text
// value part by part — html as markup, the delta's text as text, both halves'
// URLs by `isSafeUrlValue` — and `sanitizeFormattingRecord` in
// `sanitize/write-boundary.ts` is where that lives.

import { decodeReferences } from '../sanitize/html.js';
import { isSafeUrlValue, sanitizeWriteHtml } from '../sanitize/write-boundary';

/** Inline elements and the Quill attribute each one sets. */
const INLINE_ATTRIBUTE = new Map([
	['b', ['bold', true]],
	['strong', ['bold', true]],
	['i', ['italic', true]],
	['em', ['italic', true]],
	['u', ['underline', true]],
	['s', ['strike', true]],
	['strike', ['strike', true]],
	['del', ['strike', true]],
	['code', ['code', true]],
	['sub', ['script', 'sub']],
	['sup', ['script', 'super']]
]);

/** Block elements whose Quill attribute is fixed by the tag name alone. */
const BLOCK_ATTRIBUTE = new Map([
	['h1', ['header', 1]],
	['h2', ['header', 2]],
	['h3', ['header', 3]],
	['h4', ['header', 4]],
	['h5', ['header', 5]],
	['h6', ['header', 6]],
	['blockquote', ['blockquote', true]]
]);

/**
 * Elements that OWN a line: closing one ends the line and stamps the newline with
 * that element's attributes. `div` is here because that is what a contenteditable
 * produces for a new line in Chrome, and `p` because that is what Quill produces.
 *
 * THE SECOND GROUP is every other block-level element MEASURED to end a line in
 * Quill 2.0.3's own `clipboard.convert` (Opus review of fix pass 3, finding 7b).
 * Without them `<section>a</section><section>b</section>` came out as `ab` — two
 * paragraphs run together into one word, which is text corruption rather than a lost
 * format. Neither producer emits any of them, but a paste can.
 *
 * THE THIRD GROUP is `table`, `tr` and `td`, and the sentence that used to stand
 * here said the opposite — "deliberately absent, each measured … which does NOT end
 * a line on them" — which was WRONG, and wrong in the direction that runs two cells'
 * text together (Opus review of fix pass 4, finding 3). Quill 2.0.3's `isLine` list
 * is `[address, article, blockquote, canvas, dd, div, dl, dt, fieldset, figcaption,
 * figure, footer, form, h1…h6, header, iframe, li, main, nav, ol, output, p, pre,
 * section, table, td, tr, ul, video]` — `table`, `td` and `tr` are IN it. The two
 * corpus cases that appeared to confirm the old claim could not see the defect: one
 * was a single cell, and the other wrote `<td>a</td><td>b</td>` with no `<table>`
 * around it, which the browser deletes before Quill is handed it. Measured directly
 * against that build:
 *
 *   <table><tr><td>a</td><td>b</td></tr></table>   quill "a\nb"   kit was "ab"
 *
 * STILL ABSENT, and each of these genuinely measured NOT to end a line under the
 * same build: `tbody`, `thead`, `th`, `caption`, `details`, `summary`, `hgroup`,
 * `legend`, `aside` — note `th` and `tbody`, which are the two the review's summary
 * named alongside the real three and which the list above does not contain
 * (`<thead><tr><th>h1</th><th>h2</th></tr></thead>` is `"h1h2"`, one line). And
 * `pre` stays out for the reason the header gives: Quill's serializer has already
 * emptied a code block by the time this module sees it, so giving `<pre>` a line of
 * its own would add a blank line and nothing else.
 *
 * Unreachable on the three sites today: 0 of 97 stored rich-text values contains a
 * table tag. A paste is how one arrives.
 */
const LEAF_BLOCK = new Set([
	'p',
	'div',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'li',
	'blockquote',
	'address',
	'article',
	'dd',
	'dl',
	'dt',
	'fieldset',
	'figcaption',
	'figure',
	'footer',
	'header',
	'main',
	'nav',
	'section',
	'table',
	'tr',
	'td'
]);

/** List containers, and the `list` value each gives the `<li>`s inside it. */
const LIST_CONTAINER = new Map([
	['ul', 'bullet'],
	['ol', 'ordered']
]);

/**
 * Elements that never carry a closing tag. Opening a frame for one would leave it
 * on the stack for the rest of the document, and enough of them would reach
 * `MAX_DEPTH` and start dropping structure. `br` is handled before this set is
 * consulted, because it is the one that does something.
 */
const VOID_ELEMENTS = new Set([
	'area',
	'base',
	'br',
	'col',
	'embed',
	'hr',
	'img',
	'input',
	'link',
	'meta',
	'param',
	'source',
	'track',
	'wbr'
]);

/** The alignments Quill expresses as a class; `left` is the absence of one. */
const ALIGNMENTS = new Set(['center', 'right', 'justify']);

/**
 * The deepest indent Quill has a class for — `ql-indent-1` … `ql-indent-8`.
 *
 * Past it the delta names a level the stylesheet cannot render, so the CMS shows the
 * line flush left while the html shows it nested: the two halves disagreeing again.
 */
const MAX_INDENT = 8;

/** @param {number} level */
function clampIndent(level) {
	if (!Number.isInteger(level) || level <= 0) return 0;
	return level > MAX_INDENT ? MAX_INDENT : level;
}

/**
 * A run of whitespace that contains a LINE BREAK — a layout separator.
 *
 * Two rules meet here and they disagree, so the boundary between them is drawn
 * explicitly rather than by accident:
 *
 *   • SPACES AND TABS ARE CONTENT. The CMS reads its editor back with
 *     `getSemanticHTML({preserveWhitespace: true})`, so `<p>a  b</p>` really does
 *     mean two spaces and collapsing them would delete one. This module keeps them.
 *   • A LINE BREAK IS NOT. Neither producer of this field emits one as content:
 *     Quill's serializer emits a newline only inside a `<pre>` (which this module
 *     deliberately does not model), and a contenteditable emits none at all. Every
 *     newline that reaches here is therefore source formatting — a pretty-printed
 *     document, or a seed script's template literal.
 *
 * And keeping one would be far worse than cosmetic: in a Quill delta a `\n` inside
 * an `insert` string is a LINE TERMINATOR. `<h2>\n  Heading\n</h2>` used to produce
 * `[{insert:'\n  Heading\n'}, {insert:'\n', header:2}]` — three lines, the text on
 * an unstyled one and the `header:2` stranded on an empty line at the end. The
 * heading was destroyed by its own indentation.
 *
 * So a newline-bearing run becomes ONE SPACE, and only when content follows it on
 * the same line (`pendingLayout` below). That is what a browser does, and it is
 * what Quill's own `clipboard.convert` does — measured to agree exactly on
 * `<b>a</b>\n<i>b</i>`, `<h2>\n  Heading\n</h2>`, `<ul>\n <li>\n a\n </li>\n</ul>`
 * and `<div>\n  <b>x</b>\n</div>`.
 */
const LAYOUT_RUN = /[ \t\f]*[\n\r][ \t\n\r\f]*/u;

/**
 * A text node made of nothing but the whitespace a browser COLLAPSES.
 *
 * `String.prototype.trim` is not this test: it treats U+00A0 as whitespace, and
 * U+00A0 is content — `<p>&nbsp;</p>` is a deliberate blank line and Quill keeps
 * it. Every other unicode space is left out for the same reason.
 */
const LAYOUT_WHITESPACE = /^[ \t\n\r\f\v]*$/u;

/**
 * The same depth cap `sanitize/html.js` uses, for the same reason: pathological
 * nesting must not build an unbounded stack. Past it an element is not opened at
 * all, so its text still reaches the delta as content of the enclosing block —
 * losing structure rather than throwing inside a reactive statement.
 */
const MAX_DEPTH = 64;

/**
 * The HTML 4 Latin-1 names, in code-point order from U+00A0 to U+00FF.
 *
 * Written as their sequence rather than as ninety-six map literals because that is
 * what they are — the block is contiguous and defined by its order, so a name in the
 * wrong place is visible as a name in the wrong place. `tests/html-to-delta.test.js`
 * pins the count and both ends.
 */
const LATIN1_NAMES =
	'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr ' +
	'deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest ' +
	'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ' +
	'ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig ' +
	'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml ' +
	'eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml';

/**
 * The named character references this module decodes — A STATED, TESTED SUBSET.
 *
 * NOT the sanitizer's `NAMED_ENTITIES`, on purpose (see the header): that set is nine
 * entries, locked to an ESCAPE grammar by a coupling test, and carries a warning
 * against widening it for anyone else's benefit.
 *
 * IT USED TO BE SIX, AND SIX WAS TOO FEW (codex P5 fix 4, item 5; Opus 7c). Anything
 * outside the set was left as literal text on the reasoning that literal is visible
 * and a wrong character is not. That reasoning was wrong in one direction nobody had
 * traced: the delta's text goes back through Quill, whose `getSemanticHTML` escapes a
 * bare `&`, so `&eacute;` in the html became the literal text `&eacute;` in the delta
 * and then `&amp;eacute;` in the html on the CMS's next save. Not a wrong character —
 * a growing one, on every save, and the page renders it.
 *
 * So the set is the Latin-1 block plus the general-punctuation names a word processor
 * paste actually produces, which between them cover what an editor can type. It is
 * still a SUBSET of HTML5's 2,231 names and this docblock is where that is admitted:
 * a reference outside it is still left literal, and `&zeta;` still round-trips badly.
 * The alternative — shipping the full table, or reaching for the DOM, which this
 * module cannot do because its tests run in Node — buys the last fraction of a
 * percent for two thousand lines of data.
 *
 * CASE IS SIGNIFICANT, and that is new: `&Eacute;` and `&eacute;` are different
 * characters, so the lookup is exact. The five markup names keep their legacy
 * upper-case spellings, which is the only case-folding a browser does that anything
 * here emits.
 */
const NAMED_REFERENCES = new Map([
	...LATIN1_NAMES.split(' ').map((name, index) => [name, String.fromCodePoint(0xa0 + index)]),
	['amp', '&'],
	['AMP', '&'],
	['apos', "'"],
	['APOS', "'"],
	['gt', '>'],
	['GT', '>'],
	['lt', '<'],
	['LT', '<'],
	['quot', '"'],
	['QUOT', '"'],
	// General punctuation — what a paste from Word, Docs or a browser leaves behind.
	['ndash', '–'],
	['mdash', '—'],
	['lsquo', '‘'],
	['rsquo', '’'],
	['sbquo', '‚'],
	['ldquo', '“'],
	['rdquo', '”'],
	['bdquo', '„'],
	['dagger', '†'],
	['Dagger', '‡'],
	['bull', '•'],
	['hellip', '…'],
	['permil', '‰'],
	['prime', '′'],
	['Prime', '″'],
	['lsaquo', '‹'],
	['rsaquo', '›'],
	['oline', '‾'],
	['frasl', '⁄'],
	['euro', '€'],
	['trade', '™'],
	['larr', '←'],
	['uarr', '↑'],
	['rarr', '→'],
	['darr', '↓'],
	['harr', '↔'],
	['minus', '−'],
	['circ', 'ˆ'],
	['tilde', '˜'],
	['ensp', ' '],
	['emsp', ' '],
	['thinsp', ' '],
	['zwnj', '‌'],
	['zwj', '‍'],
	['lrm', '‎'],
	['rlm', '‏']
]);

/**
 * @param {string} value
 *
 * The NUMERIC forms have NO DIGIT WINDOW at all, unlike the sanitizer's (7 decimal,
 * 6 hex), and deliberately so. The sanitizer's narrow windows are a
 * FAIL-CLOSED device: what it cannot resolve it re-escapes, or the write boundary
 * refuses. Here there is nothing to fail closed about — the output is a delta, not
 * markup, and nothing is re-serialized from it into a page — so the only question is
 * whether the delta says what the html renders. A browser decodes
 * `&#00000000106;` however many leading zeros it carries, and leaving it literal is
 * the same growing-`&amp;` corruption as the named case above. The code-point range
 * check is what bounds it: a reference too long to parse becomes `Infinity`, fails
 * `Number.isFinite`, and is left exactly as it was written.
 */
function decodeText(value) {
	if (!value.includes('&')) return value;
	return value.replace(
		/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/gu,
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
			return NAMED_REFERENCES.get(body) ?? match;
		}
	);
}

/**
 * Read one `<…>` construct starting at `start`.
 *
 * Deliberately smaller than the sanitizer's reader: this one only has to
 * recognise the shapes Quill and a contenteditable emit, and an unterminated
 * construct is skipped rather than being made to fail safe — nothing here is
 * re-serialized into a page.
 *
 * @param {string} html
 * @param {number} start
 * @returns {{end: number, kind: 'open' | 'close' | 'skip', name?: string,
 *   attributes?: Record<string, string>, selfClosing?: boolean}}
 */
function readTag(html, start) {
	if (html.startsWith('<!--', start)) {
		const end = html.indexOf('-->', start + 4);
		return { kind: 'skip', end: end === -1 ? html.length : end + 3 };
	}
	if (html.startsWith('<!', start) || html.startsWith('<?', start)) {
		const end = html.indexOf('>', start + 2);
		return { kind: 'skip', end: end === -1 ? html.length : end + 1 };
	}

	const closing = html.startsWith('</', start);
	const nameStart = start + (closing ? 2 : 1);
	const nameMatch = /^[a-zA-Z][a-zA-Z0-9:_.-]*/u.exec(html.slice(nameStart));
	// A stray `<`. The caller re-reads it as text, so it survives into the delta.
	if (!nameMatch) return { kind: 'skip', end: start + 1, name: undefined };

	const name = nameMatch[0].toLowerCase();
	let index = nameStart + nameMatch[0].length;

	if (closing) {
		const end = html.indexOf('>', index);
		return { kind: 'close', name, end: end === -1 ? html.length : end + 1 };
	}

	/**
	 * A bag with NO PROTOTYPE, and `Object.hasOwn` to ask about it.
	 *
	 * The names come straight off the markup, so `{}` here would mean
	 * `'constructor' in attributes` is true before anything is read — a real
	 * `constructor=""` would be dropped as a duplicate — and `attributes['__proto__']
	 * = value` would write through the prototype setter instead of storing a key.
	 * The same defect codex found in Poovayya's backfill comparison, in a smaller
	 * place.
	 */
	const attributes = Object.create(null);
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
		const key = attributeName[0].toLowerCase();
		// First wins, matching how a browser resolves a duplicated attribute.
		if (!Object.hasOwn(attributes, key)) attributes[key] = value;
	}

	return { kind: 'open', name, attributes, selfClosing, end: index };
}

/** A stable key for "these two attribute maps are the same", for op merging. */
function attributeKey(attributes) {
	if (!attributes) return '';
	return JSON.stringify(
		Object.keys(attributes)
			.sort()
			.map((key) => [key, attributes[key]])
	);
}

/** @param {Record<string, string>} attributes */
function classesOf(attributes) {
	return decodeText(attributes?.class ?? '')
		.split(/\s+/u)
		.filter(Boolean);
}

/**
 * The Quill block attributes a `<li>`/`<p>`/`<h2>`/… stamps on its newline.
 *
 * @param {{name: string, attributes: Record<string, string>, listKind: string | null,
 *   listDepth: number}} frame
 */
function blockAttributesOf(frame) {
	/** @type {Record<string, unknown>} */
	const out = {};

	if (frame.name === 'li' && frame.listKind) {
		/**
		 * `data-list` WINS over the container. Quill's semantic HTML — what the CMS
		 * stores — uses `<ul>` and `<ol>` honestly, but the editor's own DOM does not:
		 * a BULLET list is `<ol><li data-list="bullet">` (measured on Quill 2.0.3), so
		 * reading only the container turns every bullet list into a numbered one for
		 * any html that came from the live editor rather than from the serializer.
		 */
		const declared = frame.attributes['data-list'];
		out.list = declared === 'bullet' || declared === 'ordered' ? declared : frame.listKind;
	} else {
		const fixed = BLOCK_ATTRIBUTE.get(frame.name);
		if (fixed) out[fixed[0]] = fixed[1];
	}

	let classIndent = null;
	for (const token of classesOf(frame.attributes)) {
		if (token.startsWith('ql-align-')) {
			const alignment = token.slice('ql-align-'.length);
			if (ALIGNMENTS.has(alignment)) out.align = alignment;
			continue;
		}
		if (token.startsWith('ql-indent-')) {
			const level = Number.parseInt(token.slice('ql-indent-'.length), 10);
			if (Number.isInteger(level) && level > 0 && level <= MAX_INDENT) classIndent = level;
		}
	}

	// A nested list expresses its depth by NESTING in Quill's semantic html
	// (`<ul><li>a<ul><li>b</li></ul></li></ul>`) and by `ql-indent-N` in the
	// editor's own DOM. Either can reach this module, so an explicit class wins
	// and the nesting depth is the fallback.
	//
	// BOTH derivations are clamped, and only one of them used to be (codex P5 fix 4,
	// item 5). A `ql-indent-9` class was rejected while thirty nested `<ul>`s wrote
	// `indent: 29` — a value `ql-indent-*` has no class for, so Quill renders it at no
	// indent at all and the delta and the html stop agreeing. Same ceiling, both ways.
	const indent = clampIndent(classIndent ?? (frame.name === 'li' ? frame.listDepth - 1 : 0));
	if (indent > 0) out.indent = indent;

	return Object.keys(out).length > 0 ? out : null;
}

/**
 * The attributes that actually go on this block's newline: what an ENCLOSING block
 * contributes, then this block's own.
 *
 * A block inside a block is not what either producer emits — Quill writes
 * `<blockquote>q</blockquote>`, not `<blockquote><p>q</p></blockquote>` — but a
 * contenteditable wraps things in `<div>` freely and stored html can carry either.
 * Without the merge the inner `<p>` takes the line and the `blockquote` lands on an
 * empty one after it, which reads in the CMS as a blank quoted line under an
 * unquoted paragraph. Innermost wins, so a `<h2>` inside a `<div>` is still a
 * heading and not something else.
 *
 * @param {{inherited: Record<string, unknown> | null, name: string,
 *   attributes: Record<string, string>, listKind: string | null, listDepth: number}} frame
 */
function lineAttributesOf(frame) {
	const own = blockAttributesOf(frame);
	if (!frame.inherited) return own;
	const merged = { ...frame.inherited, ...(own ?? {}) };
	return Object.keys(merged).length > 0 ? merged : null;
}

/**
 * Convert rich-text HTML into a Quill delta.
 *
 * The delta is `{ops: [...]}` — the JSON shape `quill.getContents()` serializes
 * to and `quill.setContents()` accepts, which is what makes the value the old
 * admin loads and the value this kit writes the same thing.
 *
 * Unknown elements are UNWRAPPED: their text survives as content of the enclosing
 * block. Losing an attribute we do not model is a formatting change; dropping the
 * text with it would be a deletion.
 *
 * @param {unknown} input
 * @returns {{ops: Array<Record<string, unknown>>}}
 */
export function htmlToDelta(input) {
	// The WRITE-sanitised html, not the raw input — see the header. This is what
	// makes the delta and the stored `html` two readings of one string rather than
	// two documents judged by different rules.
	const html = sanitizeWriteHtml(typeof input === 'string' ? input : `${input ?? ''}`);
	/** @type {Array<Record<string, unknown>>} */
	const ops = [];
	/** @type {Array<Record<string, unknown>>} */
	let line = [];
	/**
	 * Is a layout separator (see `LAYOUT_RUN`) waiting to be spent?
	 *
	 * It becomes a single space if content follows it ON THE SAME LINE, and nothing
	 * at all otherwise — which is how the leading and trailing indentation of a
	 * pretty-printed block disappears while the space between two inline runs
	 * survives. Cleared at every line boundary: a separator never crosses one.
	 */
	let pendingLayout = false;
	/** @type {Record<string, unknown> | null} the inline attributes it was seen with. */
	let pendingLayoutAttributes = null;
	/** The text it spends. One space for a newline-bearing run; the run itself for a
	 * spaces-and-tabs one, which this module keeps rather than collapses. */
	let pendingLayoutText = ' ';
	/**
	 * Is the waiting separator CONTENT rather than source formatting?
	 *
	 * Quill strips a whitespace run only where it TOUCHES A LINE ELEMENT — its
	 * `matchText` removes the leading run when the previous sibling is one and the
	 * trailing run when the next sibling is one, and leaves it alone otherwise. A
	 * `<br>` is not a line element, so the space in `<b>a</b><br> <i>b</i>` is
	 * content and Quill reads `"a\n b"`; this module read `"a\nb"`, because its
	 * drop rule is "line start at the document root" and a `<br>` starts a line
	 * exactly like a block boundary does (Opus review of fix pass 4, finding 5 —
	 * the line-start twin of the root-run bug fix pass 4 closed).
	 *
	 * A content separator is therefore held rather than dropped, and spent when
	 * something follows it on the same line — which is also how the OTHER half of
	 * Quill's rule falls out: if a block opens next, the run touches a line element
	 * after all and `clearLayout` discards it.
	 */
	let pendingLayoutIsContent = false;
	/**
	 * Was the line in progress started by a `<br>` rather than by a block boundary?
	 *
	 * The one bit of context the streaming walk needs to answer "is the previous
	 * sibling a line element". Cleared at every line close and whenever a block or
	 * list container opens.
	 */
	let lineStartedByBreak = false;
	/** @type {Array<{name: string, attributes: Record<string, string>, inline: [string, unknown] | null,
	 *   leaf: boolean, inherited: Record<string, unknown> | null, listKind: string | null,
	 *   listDepth: number, emitted: boolean}>} */
	const stack = [];

	function pushOp(op) {
		const previous = ops[ops.length - 1];
		if (
			previous &&
			typeof previous.insert === 'string' &&
			typeof op.insert === 'string' &&
			attributeKey(previous.attributes) === attributeKey(op.attributes)
		) {
			previous.insert += op.insert;
			return;
		}
		ops.push(op);
	}

	/** The inline attributes every open element contributes, innermost winning. */
	function inlineAttributes() {
		/** @type {Record<string, unknown>} */
		const out = {};
		for (const frame of stack) {
			if (frame.inline) out[frame.inline[0]] = frame.inline[1];
		}
		return Object.keys(out).length > 0 ? out : null;
	}

	/** The innermost element that owns a line, or null at the document root. */
	function currentBlock() {
		for (let index = stack.length - 1; index >= 0; index -= 1) {
			if (stack[index].leaf) return stack[index];
		}
		return null;
	}

	function currentListKind() {
		for (let index = stack.length - 1; index >= 0; index -= 1) {
			const kind = LIST_CONTAINER.get(stack[index].name);
			if (kind) return kind;
		}
		return null;
	}

	function listDepth() {
		let depth = 0;
		for (const frame of stack) if (LIST_CONTAINER.has(frame.name)) depth += 1;
		return depth;
	}

	/** Forget a waiting separator without spending it. */
	function clearLayout() {
		pendingLayout = false;
		pendingLayoutText = ' ';
		pendingLayoutIsContent = false;
	}

	/** Close the current line, stamping the newline with `attributes`. */
	function closeLine(attributes) {
		// A CONTENT separator is the line's whole content when nothing else was
		// written on it: `a<br> <br> b` is three lines to Quill and the middle one
		// holds the space. An ordinary separator is dropped here instead — it had
		// nothing follow it, so it was the trailing indentation of a pretty-printed
		// block.
		if (pendingLayoutIsContent && line.length === 0) {
			line.push(
				pendingLayoutAttributes
					? { insert: pendingLayoutText, attributes: pendingLayoutAttributes }
					: { insert: pendingLayoutText }
			);
		}
		for (const op of line) pushOp(op);
		line = [];
		clearLayout();
		lineStartedByBreak = false;
		pushOp(attributes ? { insert: '\n', attributes } : { insert: '\n' });
	}

	/**
	 * A block is about to open, or a `<br>` was hit. Either way the line in
	 * progress belongs to the block that is CURRENTLY innermost — this is what
	 * puts `a` on the outer bullet before `b` on the nested one, rather than
	 * after it.
	 */
	function breakLine() {
		const block = currentBlock();
		closeLine(block ? lineAttributesOf(block) : null);
		if (block) block.emitted = true;
	}

	function popTo(name) {
		let depth = stack.length - 1;
		while (depth >= 0 && stack[depth].name !== name) depth -= 1;
		// A close tag with no open element is stray markup; ignore it rather than
		// unwinding the whole document.
		if (depth < 0) return;
		while (stack.length > depth) {
			const frame = stack.pop();
			if (!frame.leaf) continue;
			// An empty `<p></p>` is a blank line and must still produce a newline;
			// an `<li>` that already flushed its own line before a nested list must
			// not produce a second one.
			if (line.length > 0 || !frame.emitted) closeLine(lineAttributesOf(frame));
			// The line this block just closed belongs to the block OUTSIDE it as well —
			// a `<div>` whose whole content was a `<p>` has already had its say, and
			// closing it again would add a blank line to every wrapped paragraph.
			const enclosing = currentBlock();
			if (enclosing) enclosing.emitted = true;
		}
	}

	/**
	 * Push one run of CONTENT onto the line in progress.
	 *
	 * `line.length === 0` is the load-bearing half of the drop rule, and it was not
	 * there until codex found what its absence costs. The condition used to be
	 * `currentBlock() === null` alone, so whitespace was discarded whenever no block
	 * was open — including the space in `<strong>a</strong> <em>b</em>`, two
	 * formatted runs at the DOCUMENT ROOT, which is exactly what a contenteditable
	 * holds before anything has wrapped it in a `<p>`. The two words were stored
	 * joined: TEXT LOSS, in the headline feature of this module, on the commonest
	 * markup its own control produces. Inside a `<p>` the same markup was fine,
	 * which is why it survived review.
	 *
	 * A line that already holds ops is INSIDE a run of content whatever the stack
	 * says, so its whitespace is content. An empty line means nothing has been
	 * emitted since the last newline, so LEADING and BETWEEN-BLOCK whitespace is
	 * still dropped — `<ul>  <li>` and `<p>a</p> <p>b</p>` are unchanged.
	 *
	 * THE OTHER HALF OF THE CONDITION USED TO BE `currentBlock() === null` TOO, and
	 * that was the same mistake one level down: it made the rule "at the document
	 * root" rather than "at the start of a line", so a whitespace-only node at the
	 * head of a block was kept where Quill strips it (`<p>   </p>` came back holding
	 * three spaces, `<table><tr><td>a</td> <td>b</td></tr>` gained a whole line
	 * holding one). Quill's rule is positional, not depth-based: a run is stripped
	 * where it touches a LINE element on either side, which at line start is always.
	 *
	 * `LAYOUT_WHITESPACE` rather than `trim()`, because `''.trim()` treats U+00A0 as
	 * whitespace and it is not: `<p>&nbsp;</p>` is a blank line an editor typed on
	 * purpose, Quill keeps it, and trimming it away would delete content. The class
	 * is exactly the characters a browser collapses.
	 *
	 * @param {string} text
	 */
	function pushText(text) {
		if (text === '') return;
		if (line.length === 0 && LAYOUT_WHITESPACE.test(text)) {
			// …EXCEPT when a `<br>` started this line. See `pendingLayoutIsContent`:
			// Quill strips a run that touches a LINE element, and `<br>` is not one,
			// so this whitespace is content. Held rather than pushed, so that a block
			// opening next still discards it — that block IS a line element.
			if (lineStartedByBreak) markLayout(text, true);
			return;
		}
		const attributes = inlineAttributes();
		line.push(attributes ? { insert: text, attributes } : { insert: text });
	}

	/**
	 * Remember that a layout separator was seen, and WITH WHICH INLINE ATTRIBUTES.
	 *
	 * The separator belongs to the gap it was written in, not to whatever opens
	 * next: in `<b>a</b>\n<i>b</i>` the newline sits at the document root, between
	 * the two elements, so its space is unattributed. Reading the attributes at
	 * spend time instead would put the space inside the `<em>` and serialize back as
	 * `<em> b</em>` — the same text, in a place Quill does not put it.
	 */
	function markLayout(text = ' ', isContent = false) {
		if (pendingLayout) return;
		pendingLayout = true;
		pendingLayoutText = text;
		pendingLayoutIsContent = isContent;
		pendingLayoutAttributes = inlineAttributes();
	}

	/** Spend a waiting layout separator: mid-line, or anywhere if it is content. */
	function spendLayout() {
		if (!pendingLayout) return;
		const text = pendingLayoutText;
		const attributes = pendingLayoutAttributes;
		const isContent = pendingLayoutIsContent;
		clearLayout();
		if (line.length === 0 && !isContent) return;
		line.push(attributes ? { insert: text, attributes } : { insert: text });
	}

	/** @param {string} raw */
	function addText(raw) {
		const decoded = decodeText(raw);
		if (decoded === '') return;
		// Split on the layout runs: every gap between two parts WAS one, and a leading
		// or trailing empty part means the text began or ended with one.
		const parts = LAYOUT_RUN.test(decoded) ? decoded.split(LAYOUT_RUN) : [decoded];
		for (let index = 0; index < parts.length; index += 1) {
			if (index > 0) markLayout();
			if (parts[index] === '') continue;
			spendLayout();
			pushText(parts[index]);
		}
		if (parts[parts.length - 1] === '') markLayout();
	}

	let cursor = 0;
	while (cursor < html.length) {
		const next = html.indexOf('<', cursor);
		if (next === -1) {
			addText(html.slice(cursor));
			break;
		}
		if (next > cursor) addText(html.slice(cursor, next));
		const token = readTag(html, next);
		if (token.kind === 'skip') {
			// A stray `<` reads as text, so nothing is silently swallowed.
			if (token.end === next + 1) addText('<');
			cursor = token.end;
			continue;
		}
		if (token.kind === 'close') {
			popTo(token.name);
			cursor = token.end;
			continue;
		}

		const name = token.name;
		cursor = token.end;
		if (name === 'br') {
			breakLine();
			// `breakLine` cleared it; this line was started by a `<br>`, and that is
			// the one line start whose leading whitespace Quill keeps.
			lineStartedByBreak = true;
			continue;
		}

		const leaf = LEAF_BLOCK.has(name);
		const container = LIST_CONTAINER.has(name);
		if (leaf || container) {
			if (line.length > 0) breakLine();
			// Nothing on this line for a waiting separator to separate, and the thing
			// that follows it is a LINE element — the other half of Quill's rule, and
			// the reason `<b>a</b><br> <p>b</p>` keeps no space.
			else clearLayout();
			lineStartedByBreak = false;
		}
		if (token.selfClosing || VOID_ELEMENTS.has(name) || stack.length >= MAX_DEPTH) continue;

		const enclosing = leaf ? currentBlock() : null;
		stack.push({
			name,
			attributes: token.attributes ?? {},
			inline: inlineFor(name, token.attributes ?? {}),
			leaf,
			// Captured at PUSH, while the enclosing frames are still on the stack: a
			// frame is popped before its line is closed, so neither its list depth nor
			// what encloses it can be read at that point.
			inherited: enclosing ? lineAttributesOf(enclosing) : null,
			listKind: name === 'li' ? currentListKind() : null,
			listDepth: name === 'li' ? listDepth() : 0,
			emitted: false
		});
	}

	while (stack.length > 0) popTo(stack[stack.length - 1].name);
	// A CONTENT separator still waiting at the end of the document is the last
	// line's content — `a<br> ` is `"a\n "` to Quill — so it closes a line of its
	// own. An ordinary one is trailing indentation and closes nothing.
	if (line.length > 0 || pendingLayoutIsContent) closeLine(null);

	return { ops };
}

/**
 * The inline attribute an open element contributes, or null.
 *
 * `<a>` is the one that reads an attribute value, and the one that can refuse:
 * before this module, no href ever reached `content`, so writing one there is a
 * new path for a `javascript:` URL to reach a place that renders it — Apex's CMS
 * UI builds its editor from the delta. A refused href drops the link attribute and
 * KEEPS the text.
 *
 * `isSafeUrlValue` is the STORAGE predicate — the same one `sanitizeWriteHtml`
 * uses to decide whether the attribute may stay in the html at all — and it is
 * stricter than the render-time `isSafeUrl` this used to call, in exactly the way
 * that matters here: it REFUSES a value still holding a character reference after a
 * full decode. Two judges meant two answers about one href, and the delta kept
 * links the stored html had already dropped (codex P5 fix 4, item 3). One judge.
 *
 * The value CARRIED is `decodeReferences(raw)` — the write boundary's decode, not
 * this module's narrower `decodeText` — for the same reason: the surviving
 * attribute and the delta's `link` have to be the same URL, and the boundary's
 * grammar is the one that decided the attribute could stay.
 *
 * @param {string} name
 * @param {Record<string, string>} attributes
 * @returns {[string, unknown] | null}
 */
function inlineFor(name, attributes) {
	if (name === 'a') {
		const raw = attributes.href ?? '';
		if (!raw || !isSafeUrlValue(raw)) return null;
		return ['link', decodeReferences(raw)];
	}
	return INLINE_ATTRIBUTE.get(name) ?? null;
}
