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
// for the other's benefit. `isSafeUrl` IS imported: that is a judgement, not a
// tokenizer, and there must be exactly one of it.

import { isSafeUrl } from '../sanitize/html.js';

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
 */
const LEAF_BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote']);

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
 * The same depth cap `sanitize/html.js` uses, for the same reason: pathological
 * nesting must not build an unbounded stack. Past it an element is not opened at
 * all, so its text still reaches the delta as content of the enclosing block —
 * losing structure rather than throwing inside a reactive statement.
 */
const MAX_DEPTH = 64;

/**
 * The named character references this module decodes.
 *
 * NOT the sanitizer's `NAMED_ENTITIES`, on purpose (see the header). This set is
 * what the two producers actually emit: Quill 2.0.3's `getSemanticHTML` escapes
 * `& < > "` and passes U+00A0 through raw, and a contenteditable's `innerHTML`
 * escapes `& < >` and writes `&nbsp;`. Anything outside this set and the numeric
 * forms is left as literal text — visible, rather than silently becoming a
 * different character than the html renders.
 */
const NAMED_REFERENCES = new Map([
	['amp', '&'],
	['apos', "'"],
	['gt', '>'],
	['lt', '<'],
	['nbsp', ' '],
	['quot', '"']
]);

/** @param {string} value */
function decodeText(value) {
	if (!value.includes('&')) return value;
	return value.replace(
		/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/gu,
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
			return NAMED_REFERENCES.get(body.toLowerCase()) ?? match;
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
			if (Number.isInteger(level) && level > 0 && level <= 8) classIndent = level;
		}
	}

	// A nested list expresses its depth by NESTING in Quill's semantic html
	// (`<ul><li>a<ul><li>b</li></ul></li></ul>`) and by `ql-indent-N` in the
	// editor's own DOM. Either can reach this module, so an explicit class wins
	// and the nesting depth is the fallback.
	const indent = classIndent ?? (frame.name === 'li' ? frame.listDepth - 1 : 0);
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
	const html = typeof input === 'string' ? input : `${input ?? ''}`;
	/** @type {Array<Record<string, unknown>>} */
	const ops = [];
	/** @type {Array<Record<string, unknown>>} */
	let line = [];
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

	/** Close the current line, stamping the newline with `attributes`. */
	function closeLine(attributes) {
		for (const op of line) pushOp(op);
		line = [];
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

	/** @param {string} raw */
	function addText(raw) {
		const text = decodeText(raw);
		if (text === '') return;
		// Whitespace between blocks — `<ul>\n  <li>` — is layout, not content. Inside
		// a block it is content, and `preserveWhitespace: true` means the old admin
		// keeps it, so only the no-open-block case is dropped.
		if (currentBlock() === null && text.trim() === '') return;
		const attributes = inlineAttributes();
		line.push(attributes ? { insert: text, attributes } : { insert: text });
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
			continue;
		}

		const leaf = LEAF_BLOCK.has(name);
		const container = LIST_CONTAINER.has(name);
		if ((leaf || container) && line.length > 0) breakLine();
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
	if (line.length > 0) closeLine(null);

	return { ops };
}

/**
 * The inline attribute an open element contributes, or null.
 *
 * `<a>` is the one that reads an attribute value, and the one that can refuse:
 * before this module, no href ever reached `content`, so writing one there is a
 * new path for a `javascript:` URL to reach a place that renders it — Apex's CMS
 * UI builds its editor from the delta. `isSafeUrl` is the kit's single URL
 * judgement, shared with the render sanitizer and the write boundary. A refused
 * href drops the link attribute and KEEPS the text.
 *
 * @param {string} name
 * @param {Record<string, string>} attributes
 * @returns {[string, unknown] | null}
 */
function inlineFor(name, attributes) {
	if (name === 'a') {
		const href = decodeText(attributes.href ?? '');
		if (!href || !isSafeUrl(href)) return null;
		return ['link', href];
	}
	return INLINE_ATTRIBUTE.get(name) ?? null;
}
