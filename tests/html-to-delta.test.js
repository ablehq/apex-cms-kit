// @ts-nocheck — node:test suite over the admin's HTML→Delta conversion.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { htmlToDelta } from '../src/admin/html-to-delta.js';
import { decodeReferences, isSafeUrl } from '../src/sanitize/html.js';
import { isSafeUrlValue, sanitizeWriteHtml } from '../src/sanitize/write-boundary';
import { plainToRichText } from '../src/admin/rich-text.js';

/**
 * P5 fix 3, item 1: A RICH-TEXT EDIT IN THE NEW ADMIN MUST NOT DESTROY FORMATTING
 * FOR THE OLD ONE.
 *
 * A `rich_text` field stores `{editor, html, content}`, and when `editor` is
 * `'quilljs'` the `content` is a Quill delta. Apex's own CMS UI — which every
 * client is still using on these same records — LOADS ITS EDITOR FROM `content`,
 * NOT FROM `html`:
 *
 *   apex-cms-template/src/lib/components/archetypes/RichTextArchetypeSchemaItem.svelte
 *     :47-48  quill.setContents(parsedValue.content)
 *     :59-62  content: quill.getContents(),
 *             html: quill.getSemanticHTML({preserveWhitespace: true})
 *
 * Before `htmlToDelta`, the kit built that delta from `richTextPlainText()` —
 * markup stripped — so bold, headings, links and lists entered in the new admin
 * became ONE UNATTRIBUTED INSERT. Opening the record in the CMS showed the text
 * with the formatting gone, and the CMS's next save wrote the loss into `html`.
 *
 * ── WHERE THE EXPECTED VALUES COME FROM ────────────────────────────────────
 * Every delta asserted below was MEASURED, not invented: each was fed to a real
 * Quill 2.0.3 (the version `apex-cms-template/package.json:58` pins) running under
 * jsdom via `setContents`, and read back with `getSemanticHTML({preserveWhitespace:
 * true})` and `getContents()` — the exact pair of calls the CMS component makes.
 * `htmlToDelta`'s output is byte-identical to what `getContents()` returns for the
 * same document, INCLUDING Quill's own normalisation (adjacent inserts carrying
 * equal attributes are merged, which is why `'.\nfirst'` is one op below).
 *
 * ── THE SET COVERED, AND WHY IT IS THIS SET ────────────────────────────────
 * The union of what BOTH toolbars that write this field can produce:
 *
 *   kit `ui/RichTextField.svelte:164-205` — bold `<b>`, italic `<i>`,
 *     heading `formatBlock '<h2>'`, link `createLink` → `<a href>`, bulleted list
 *     `<ul><li>`; plus the `<p>`/`<div>`/`<br>` a contenteditable emits.
 *   CMS `RichText.svelte:11-14` + `RichTextArchetypeSchemaItem.svelte:27-32` —
 *     header 1–4, bold, italic, underline, strike, link, bullet and ordered lists.
 *
 * The CMS's stored `html` is what the kit's control READS into its surface, so
 * anything Quill can emit comes back through this conversion on the next
 * keystroke. Covering only the kit's five buttons would lose an underline the
 * moment someone typed one character into a record the CMS had formatted.
 */

describe('htmlToDelta: one test per attribute the toolbars can produce', () => {
	it('bold — both spellings, the new admin`s <b> and the CMS`s <strong>', () => {
		const expected = { ops: [{ insert: 'Bold', attributes: { bold: true } }, { insert: '\n' }] };
		assert.deepEqual(htmlToDelta('<p><b>Bold</b></p>'), expected);
		assert.deepEqual(htmlToDelta('<p><strong>Bold</strong></p>'), expected);
	});

	it('italic — the new admin`s <i> and the CMS`s <em>', () => {
		const expected = { ops: [{ insert: 'It', attributes: { italic: true } }, { insert: '\n' }] };
		assert.deepEqual(htmlToDelta('<p><i>It</i></p>'), expected);
		assert.deepEqual(htmlToDelta('<p><em>It</em></p>'), expected);
	});

	it('underline — CMS only, and exactly why the set is the UNION of both toolbars', () => {
		// The kit's toolbar has no underline button. It still has to survive: the kit's
		// control loads the CMS's html into its surface, so one keystroke in the new
		// admin re-derives the delta for a document the CMS underlined.
		assert.deepEqual(htmlToDelta('<p><u>U</u></p>'), {
			ops: [{ insert: 'U', attributes: { underline: true } }, { insert: '\n' }]
		});
	});

	it('strike — <s>, and the two spellings a paste can leave behind', () => {
		const expected = { ops: [{ insert: 'S', attributes: { strike: true } }, { insert: '\n' }] };
		assert.deepEqual(htmlToDelta('<p><s>S</s></p>'), expected);
		assert.deepEqual(htmlToDelta('<p><strike>S</strike></p>'), expected);
		assert.deepEqual(htmlToDelta('<p><del>S</del></p>'), expected);
	});

	it('heading — every level both toolbars offer, on the NEWLINE and not the text', () => {
		// The shape matters as much as the value: Quill puts a block format on the
		// newline that ENDS the line. A `header` on the text op would not render.
		for (const level of [1, 2, 3, 4, 5, 6]) {
			assert.deepEqual(htmlToDelta(`<h${level}>Head</h${level}>`), {
				ops: [{ insert: 'Head' }, { insert: '\n', attributes: { header: level } }]
			});
		}
	});

	it('link — the href becomes a `link` attribute on the text', () => {
		assert.deepEqual(htmlToDelta('<p><a href="https://x.test/a">Site</a></p>'), {
			ops: [{ insert: 'Site', attributes: { link: 'https://x.test/a' } }, { insert: '\n' }]
		});
		// Quill's own semantic HTML adds rel/target; they are not part of the delta.
		assert.deepEqual(
			htmlToDelta(
				'<p><a href="https://x.test/a" rel="noopener noreferrer" target="_blank">Site</a></p>'
			),
			{ ops: [{ insert: 'Site', attributes: { link: 'https://x.test/a' } }, { insert: '\n' }] }
		);
	});

	it('link — a scheme the render sanitizer refuses is DROPPED, and the text KEPT', () => {
		/**
		 * Before this module no href ever reached `content`, so writing one there is a
		 * NEW path for a `javascript:` URL to reach something that renders it — the CMS
		 * builds its editor from the delta. The judgement is the kit's single
		 * `isSafeUrl`, shared with the render sanitizer and the write boundary, rather
		 * than a second string test that would drift from it.
		 */
		assert.deepEqual(htmlToDelta('<p><a href="javascript:alert(1)">x</a></p>'), {
			ops: [{ insert: 'x\n' }]
		});
		assert.deepEqual(htmlToDelta('<p><a href="java&Tab;script:alert(1)">x</a></p>'), {
			ops: [{ insert: 'x\n' }]
		});
		// The safe schemes and a site-relative path all survive.
		for (const href of [
			'https://x.test/',
			'http://x.test/',
			'mailto:a@x.test',
			'tel:+1',
			'/about',
			'#top'
		]) {
			assert.deepEqual(
				htmlToDelta(`<p><a href="${href}">x</a></p>`).ops[0].attributes,
				{ link: href },
				href
			);
		}
	});

	it('bulleted list — one newline per item, each carrying list: bullet', () => {
		assert.deepEqual(htmlToDelta('<ul><li>one</li><li>two</li></ul>'), {
			ops: [
				{ insert: 'one' },
				{ insert: '\n', attributes: { list: 'bullet' } },
				{ insert: 'two' },
				{ insert: '\n', attributes: { list: 'bullet' } }
			]
		});
	});

	it('ordered list — CMS only, and the list KIND is what distinguishes it', () => {
		assert.deepEqual(htmlToDelta('<ol><li>one</li></ol>'), {
			ops: [{ insert: 'one' }, { insert: '\n', attributes: { list: 'ordered' } }]
		});
	});

	it('nested list — Quill expresses depth as `indent`, the html as NESTING', () => {
		// `<ul><li>a<ul><li>b</li></ul></li></ul>` is what `getSemanticHTML` emits for
		// an indented bullet, so the outer item's newline has to be flushed BEFORE the
		// inner list is walked or the two lines come out in the wrong order.
		assert.deepEqual(htmlToDelta('<ul><li>a<ul><li>b</li></ul></li></ul>'), {
			ops: [
				{ insert: 'a' },
				{ insert: '\n', attributes: { list: 'bullet' } },
				{ insert: 'b' },
				{ insert: '\n', attributes: { list: 'bullet', indent: 1 } }
			]
		});
		// Three deep, and an ordered list nested in a bulleted one.
		assert.deepEqual(htmlToDelta('<ul><li>a<ol><li>b<ol><li>c</li></ol></li></ol></li></ul>').ops, [
			{ insert: 'a' },
			{ insert: '\n', attributes: { list: 'bullet' } },
			{ insert: 'b' },
			{ insert: '\n', attributes: { list: 'ordered', indent: 1 } },
			{ insert: 'c' },
			{ insert: '\n', attributes: { list: 'ordered', indent: 2 } }
		]);
	});

	it('`data-list` beats the container — the editor DOM calls a bullet list an <ol>', () => {
		// Measured on Quill 2.0.3: `getSemanticHTML` emits `<ul><li>`, but the LIVE
		// editor's own innerHTML for the same document is
		// `<ol><li data-list="bullet"><span class="ql-ui" …></span>one</li></ol>`.
		// Reading only the container turns every bullet list from that html into a
		// numbered one.
		assert.deepEqual(htmlToDelta('<ol><li data-list="bullet">one</li></ol>'), {
			ops: [{ insert: 'one' }, { insert: '\n', attributes: { list: 'bullet' } }]
		});
		assert.deepEqual(htmlToDelta('<ul><li data-list="ordered">one</li></ul>'), {
			ops: [{ insert: 'one' }, { insert: '\n', attributes: { list: 'ordered' } }]
		});
		// A value that is neither falls back to the container rather than inventing one.
		assert.deepEqual(htmlToDelta('<ul><li data-list="nonsense">one</li></ul>'), {
			ops: [{ insert: 'one' }, { insert: '\n', attributes: { list: 'bullet' } }]
		});
		// And the editor's own `ql-ui` cursor span contributes nothing.
		assert.deepEqual(
			htmlToDelta(
				'<ol><li data-list="bullet"><span class="ql-ui" contenteditable="false"></span>one</li></ol>'
			),
			{ ops: [{ insert: 'one' }, { insert: '\n', attributes: { list: 'bullet' } }] }
		);
	});

	it('blockquote, inline code, and sub/superscript', () => {
		assert.deepEqual(htmlToDelta('<blockquote>q</blockquote>'), {
			ops: [{ insert: 'q' }, { insert: '\n', attributes: { blockquote: true } }]
		});
		assert.deepEqual(htmlToDelta('<p><code>x</code></p>'), {
			ops: [{ insert: 'x', attributes: { code: true } }, { insert: '\n' }]
		});
		assert.deepEqual(htmlToDelta('<p><sup>x</sup></p>'), {
			ops: [{ insert: 'x', attributes: { script: 'super' } }, { insert: '\n' }]
		});
		assert.deepEqual(htmlToDelta('<p><sub>x</sub></p>'), {
			ops: [{ insert: 'x', attributes: { script: 'sub' } }, { insert: '\n' }]
		});
	});

	it('alignment and indentation — the two class families the sanitizer lets through', () => {
		// `sanitize/html.js` allowlists exactly `ql-align-*` and `ql-indent-1..8`, which
		// is what makes them values the stored html is expected to carry.
		assert.deepEqual(htmlToDelta('<p class="ql-align-center">c</p>'), {
			ops: [{ insert: 'c' }, { insert: '\n', attributes: { align: 'center' } }]
		});
		assert.deepEqual(htmlToDelta('<p class="ql-align-right">c</p>').ops[1].attributes, {
			align: 'right'
		});
		assert.deepEqual(htmlToDelta('<p class="ql-indent-2">i</p>'), {
			ops: [{ insert: 'i' }, { insert: '\n', attributes: { indent: 2 } }]
		});
		// An unknown class contributes nothing rather than becoming an attribute.
		assert.deepEqual(htmlToDelta('<p class="glc-dropcap">x</p>'), { ops: [{ insert: 'x\n' }] });
	});

	it('COMPOSITE — every button at once, byte-identical to Quill`s own getContents()', () => {
		/**
		 * The one case that catches an error only visible when the pieces interact:
		 * ordering across a heading, a mid-paragraph inline run, a list and a tail. The
		 * `'.\nfirst'` op is Quill's own normalisation — adjacent inserts with equal
		 * attributes are merged — reproduced here so the stored delta and the delta the
		 * CMS writes back after an untouched save are the SAME BYTES.
		 */
		const html =
			'<h2>Title</h2>' +
			'<p>A <strong>bold</strong> and <em>ital</em> and a <a href="https://x.test/">link</a>.</p>' +
			'<ul><li>first</li><li>second</li></ul>' +
			'<p>plain tail</p>';
		assert.deepEqual(htmlToDelta(html), {
			ops: [
				{ insert: 'Title' },
				{ insert: '\n', attributes: { header: 2 } },
				{ insert: 'A ' },
				{ insert: 'bold', attributes: { bold: true } },
				{ insert: ' and ' },
				{ insert: 'ital', attributes: { italic: true } },
				{ insert: ' and a ' },
				{ insert: 'link', attributes: { link: 'https://x.test/' } },
				{ insert: '.\nfirst' },
				{ insert: '\n', attributes: { list: 'bullet' } },
				{ insert: 'second' },
				{ insert: '\n', attributes: { list: 'bullet' } },
				{ insert: 'plain tail\n' }
			]
		});
	});

	it('nested inline formats combine on one op rather than replacing each other', () => {
		assert.deepEqual(htmlToDelta('<p><strong><em>x</em></strong></p>'), {
			ops: [{ insert: 'x', attributes: { bold: true, italic: true } }, { insert: '\n' }]
		});
		assert.deepEqual(
			htmlToDelta('<p><a href="https://x.test/"><strong>x</strong></a></p>').ops[0].attributes,
			{ link: 'https://x.test/', bold: true }
		);
	});
});

describe('htmlToDelta: the document structure a contenteditable produces', () => {
	it('paragraphs, blank lines and <br> all collapse to newlines', () => {
		assert.deepEqual(htmlToDelta('<p>a</p><p>b</p>'), { ops: [{ insert: 'a\nb\n' }] });
		assert.deepEqual(htmlToDelta('<p>a</p><p></p><p>b</p>'), { ops: [{ insert: 'a\n\nb\n' }] });
		assert.deepEqual(htmlToDelta('<p>a<br>b</p>'), { ops: [{ insert: 'a\nb\n' }] });
		// Chrome's empty line. One newline, not two.
		assert.deepEqual(htmlToDelta('<p><br></p>'), { ops: [{ insert: '\n' }] });
		// Chrome writes <div> for a new line in a contenteditable, Quill writes <p>.
		assert.deepEqual(htmlToDelta('<div>a</div><div>b</div>'), { ops: [{ insert: 'a\nb\n' }] });
	});

	it('a block that only WRAPS blocks says nothing of its own, and lends its format', () => {
		/**
		 * A contenteditable wraps freely, and `execCommand('insertUnorderedList')` in
		 * Chrome really does leave `<p><ul><li>…</li></ul></p>` — measured in the
		 * browser pass. Closing the wrapper as well as the child would put a blank line
		 * after every list an editor makes. And where the WRAPPER is the one carrying
		 * the format, that format has to reach the child's line or it lands on an empty
		 * one after it: a blank quoted line under an unquoted paragraph.
		 */
		assert.deepEqual(htmlToDelta('<div><p>a</p></div>'), { ops: [{ insert: 'a\n' }] });
		assert.deepEqual(htmlToDelta('<div><div>a</div><div>b</div></div>'), {
			ops: [{ insert: 'a\nb\n' }]
		});
		assert.deepEqual(htmlToDelta('<p><ul><li>x</li></ul></p>'), {
			ops: [{ insert: 'x' }, { insert: '\n', attributes: { list: 'bullet' } }]
		});
		assert.deepEqual(htmlToDelta('<blockquote><p>q</p></blockquote>'), {
			ops: [{ insert: 'q' }, { insert: '\n', attributes: { blockquote: true } }]
		});
		// Innermost wins: a heading inside a wrapper is still a heading.
		assert.deepEqual(htmlToDelta('<div><h2>H</h2><p>b</p></div>'), {
			ops: [{ insert: 'H' }, { insert: '\n', attributes: { header: 2 } }, { insert: 'b\n' }]
		});
	});

	it('a bare text node is a line — the first thing typed into an empty surface', () => {
		assert.deepEqual(htmlToDelta('bare text'), { ops: [{ insert: 'bare text\n' }] });
		assert.deepEqual(htmlToDelta('first<div>second</div>'), {
			ops: [{ insert: 'first\nsecond\n' }]
		});
	});

	it('empty html is an empty delta, and the delta always ends with a newline', () => {
		assert.deepEqual(htmlToDelta(''), { ops: [] });
		assert.deepEqual(htmlToDelta(null), { ops: [] });
		assert.deepEqual(htmlToDelta(undefined), { ops: [] });
		for (const html of ['<p>a</p>', '<h2>a</h2>', '<ul><li>a</li></ul>', 'bare']) {
			const ops = htmlToDelta(html).ops;
			assert.ok(String(ops[ops.length - 1].insert).endsWith('\n'), html);
		}
	});

	it('character references are decoded, including the &nbsp; a contenteditable writes', () => {
		assert.deepEqual(htmlToDelta('<p>a &amp; b &lt; c</p>'), { ops: [{ insert: 'a & b < c\n' }] });
		assert.deepEqual(htmlToDelta('<p>a&nbsp;b</p>'), { ops: [{ insert: 'a\u00a0b\n' }] });
		assert.deepEqual(htmlToDelta('<p>&#65;&#x42;</p>'), { ops: [{ insert: 'AB\n' }] });
		// The Latin-1 block and the punctuation names a paste leaves behind, which the
		// six-entry set used to leave as literal text (codex P5 fix 4, item 5). Literal
		// was not the harmless outcome it was described as: the delta's text goes back
		// through Quill, which escapes a bare `&`, so `&copy;` became `&amp;copy;` in
		// the stored html on the CMS's next save — and again on the one after that.
		assert.deepEqual(htmlToDelta('<p>&copy; &eacute; &mdash; &hellip;</p>'), {
			ops: [{ insert: '\u00a9 \u00e9 \u2014 \u2026\n' }]
		});
		// Case is significant: these are two different characters.
		assert.deepEqual(htmlToDelta('<p>&Eacute;&eacute;</p>'), {
			ops: [{ insert: '\u00c9\u00e9\n' }]
		});
		// The Latin-1 table is a contiguous block and is asserted as one, so a name in
		// the wrong position shows up as a name in the wrong position.
		assert.deepEqual(htmlToDelta('<p>&nbsp;|&yuml;|&Agrave;|&divide;</p>'), {
			ops: [{ insert: '\u00a0|\u00ff|\u00c0|\u00f7\n' }]
		});
		// A numeric reference a browser decodes but the SANITIZER's narrow window
		// cannot. Here there is nothing to fail closed about — the output is a delta,
		// never markup — and leaving it literal is the same growing-`&amp;` corruption.
		assert.deepEqual(htmlToDelta('<p>&#00000000106;</p>'), { ops: [{ insert: 'j\n' }] });
		// STILL A SUBSET, and this is the case that says so out loud: a name outside it
		// is left literal, which the docblock states rather than papering over.
		assert.deepEqual(htmlToDelta('<p>&zeta;</p>'), { ops: [{ insert: '&zeta;\n' }] });
	});

	it('whitespace inside a block is content; whitespace between blocks is layout', () => {
		// `preserveWhitespace: true` is what the CMS passes, so the runs inside a line
		// have to survive — while the newlines a pretty-printed document puts between
		// `</li>` and `<li>` must not become empty lines.
		assert.deepEqual(htmlToDelta('<p>a  b</p>'), { ops: [{ insert: 'a  b\n' }] });
		assert.deepEqual(htmlToDelta('<ul>\n  <li>one</li>\n  <li>two</li>\n</ul>').ops, [
			{ insert: 'one' },
			{ insert: '\n', attributes: { list: 'bullet' } },
			{ insert: 'two' },
			{ insert: '\n', attributes: { list: 'bullet' } }
		]);
		/**
		 * AT THE START OF A LINE the drop applies at every depth, not only at the
		 * document root — Quill strips a run wherever it touches a line element, and
		 * the head of a block always does. `<p>   </p>` used to come back holding
		 * three spaces.
		 *
		 * MUTATION: put `currentBlock() === null` back into `pushText`'s guard and the
		 * first two fail.
		 */
		assert.deepEqual(htmlToDelta('<p>   </p>'), { ops: [{ insert: '\n' }] });
		assert.deepEqual(htmlToDelta('<ul><li>   </li></ul>').ops, [
			{ insert: '\n', attributes: { list: 'bullet' } }
		]);
		/**
		 * …but U+00A0 IS CONTENT, and `''.trim()` would have called it whitespace.
		 * `<p>&nbsp;</p>` is a blank line an editor typed on purpose and Quill keeps
		 * it — the reason the guard tests `LAYOUT_WHITESPACE` rather than trimming.
		 *
		 * MUTATION: change `LAYOUT_WHITESPACE.test(text)` back to `text.trim() === ''`
		 * and this one fails.
		 */
		assert.deepEqual(htmlToDelta('<p>&nbsp;</p>'), { ops: [{ insert: '\u00a0\n' }] });
	});

	it('THE SPACE BETWEEN TWO FORMATTED RUNS AT THE DOCUMENT ROOT SURVIVES', () => {
		/**
		 * CODEX P5 FIX 4, ITEM 1 — the regression guard, and the reason the helper
		 * below no longer strips whitespace.
		 *
		 * `htmlToDelta('<strong>a</strong> <em>b</em>')` returned
		 * `[{insert:'a',bold},{insert:'b',italic},{insert:'\n'}]`. The space was GONE:
		 * root-level whitespace was discarded whenever no block was open, and at the
		 * document root none ever is. That shape is not exotic — it is what the kit's
		 * own contenteditable holds before anything has wrapped the text in a `<p>`,
		 * which is to say the first thing an editor types into an empty field. Inside
		 * a `<p>` the identical markup was correct, which is exactly why 581 tests and
		 * two reviews walked past it.
		 *
		 * Every expectation here was read off a real Quill 2.0.3 under jsdom via
		 * `clipboard.convert` — Quill's OWN html→delta path, an oracle written by
		 * someone else — and agrees with it character for character.
		 */
		assert.deepEqual(htmlToDelta('<strong>a</strong> <em>b</em>'), {
			ops: [
				{ insert: 'a', attributes: { bold: true } },
				{ insert: ' ' },
				{ insert: 'b', attributes: { italic: true } },
				{ insert: '\n' }
			]
		});
		// The same shape the kit's own five buttons produce, and a link pair.
		assert.deepEqual(htmlToDelta('<b>bold</b> then <i>ital</i> then plain').ops, [
			{ insert: 'bold', attributes: { bold: true } },
			{ insert: ' then ' },
			{ insert: 'ital', attributes: { italic: true } },
			{ insert: ' then plain\n' }
		]);
		assert.deepEqual(
			htmlToDelta('<a href="https://x.test/">one</a> and <a href="https://y.test/">two</a>').ops,
			[
				{ insert: 'one', attributes: { link: 'https://x.test/' } },
				{ insert: ' and ' },
				{ insert: 'two', attributes: { link: 'https://y.test/' } },
				{ insert: '\n' }
			]
		);
		// A non-breaking space is CONTENT, and survives as U+00A0 rather than as a
		// plain space — Quill's own converter normalises it and is the lossier one.
		assert.deepEqual(htmlToDelta('<b>a</b>&nbsp;<i>b</i>').ops[1], { insert: '\u00a0' });
		// And the three cases the drop rule still has to drop, all measured against
		// the same oracle: leading whitespace, whitespace between two blocks, and
		// whitespace between two lists.
		assert.deepEqual(htmlToDelta(' <b>a</b>'), {
			ops: [{ insert: 'a', attributes: { bold: true } }, { insert: '\n' }]
		});
		assert.deepEqual(htmlToDelta('<p>a</p> <p>b</p>'), { ops: [{ insert: 'a\nb\n' }] });
		assert.deepEqual(htmlToDelta('<ul><li>a</li></ul> <ul><li>b</li></ul>').ops, [
			{ insert: 'a' },
			{ insert: '\n', attributes: { list: 'bullet' } },
			{ insert: 'b' },
			{ insert: '\n', attributes: { list: 'bullet' } }
		]);
	});

	it('THE LINE-START TWIN: a `<br>` does not make the space after it layout', () => {
		/**
		 * Opus review of fix pass 4, finding 5 — the same rule one position over.
		 * The fix above keeps a whitespace node MID-LINE at the document root; this
		 * one is at LINE START, and the drop rule could not tell a line a `<br>`
		 * began from a line a block boundary began.
		 *
		 * Quill's `matchText` is the oracle and it does not have that ambiguity: it
		 * strips a whitespace run only where the run TOUCHES A LINE ELEMENT — the
		 * previous sibling for the leading strip, the next sibling for the trailing
		 * one. `<br>` is not in its `isLine` list, so the space is kept; `<p>` is,
		 * so it is not. Every expectation below is that build's own answer.
		 *
		 * MUTATION: drop the `lineStartedByBreak` branch from `pushText` and the
		 * first two fail; drop the `else clearLayout()` beside it and the third
		 * gains a space Quill does not have.
		 */
		// Quill: [{insert:'a',bold},{insert:'\n '},{insert:'b',italic}] — op for op,
		// plus the trailing newline this module always closes a document with.
		assert.deepEqual(htmlToDelta('<b>a</b><br> <i>b</i>').ops, [
			{ insert: 'a', attributes: { bold: true } },
			{ insert: '\n ' },
			{ insert: 'b', attributes: { italic: true } },
			{ insert: '\n' }
		]);
		// A space that is a whole line of its own, because a `<br>` closes it too.
		assert.deepEqual(htmlToDelta('a<br> <br> b'), { ops: [{ insert: 'a\n \n b\n' }] });
		// …and the other half of the same rule: a BLOCK opening next is a line
		// element, so the run touches one after all and goes.
		assert.deepEqual(htmlToDelta('<b>a</b><br> <p>b</p>').ops, [
			{ insert: 'a', attributes: { bold: true } },
			{ insert: '\nb\n' }
		]);
		// At the END of the document the space is still content — Quill reads
		// `a<br> ` as `"a\n "` — so it gets a line rather than being discarded.
		assert.deepEqual(htmlToDelta('a<br> '), { ops: [{ insert: 'a\n \n' }] });
	});

	it('a LINE BREAK in the source is layout — it never becomes a line in the delta', () => {
		/**
		 * The other half of the same rule, and the reason the fix is not simply "keep
		 * every root-level space". In a delta a `\n` inside an `insert` is a LINE
		 * TERMINATOR, so carrying a source newline through fabricates lines and leaves
		 * the block attribute stranded on an empty one:
		 *
		 *   BEFORE: '<h2>\n  Heading\n</h2>'
		 *        → [{insert:'\n  Heading\n'}, {insert:'\n', header:2}]
		 *          — three lines, the text unstyled, the heading destroyed by its own
		 *            indentation.
		 *
		 * A newline-bearing run of whitespace is therefore one space when content
		 * follows it on the same line, and nothing otherwise. Spaces and tabs with no
		 * newline in them are left alone, because `preserveWhitespace: true` means the
		 * CMS really did store them. All four agree with `clipboard.convert` exactly.
		 */
		assert.deepEqual(htmlToDelta('<h2>\n  Heading\n</h2>'), {
			ops: [{ insert: 'Heading' }, { insert: '\n', attributes: { header: 2 } }]
		});
		assert.deepEqual(htmlToDelta('<ul>\n  <li>\n    a\n  </li>\n</ul>'), {
			ops: [{ insert: 'a' }, { insert: '\n', attributes: { list: 'bullet' } }]
		});
		assert.deepEqual(htmlToDelta('<div>\n  <b>x</b>\n</div>'), {
			ops: [{ insert: 'x', attributes: { bold: true } }, { insert: '\n' }]
		});
		assert.deepEqual(htmlToDelta('<p>a\nb</p>'), { ops: [{ insert: 'a b\n' }] });
		// The separator belongs to the GAP it was written in, not to what opens after
		// it: unattributed here, not tucked inside the `<em>` as `<em> b</em>`.
		assert.deepEqual(htmlToDelta('<b>a</b>\n<i>b</i>').ops[1], { insert: ' ' });
	});

	it('an unknown element is UNWRAPPED — its text survives, its attribute does not', () => {
		// Losing a format we do not model is a formatting change. Dropping the text
		// with it would be a deletion, which is the failure this whole item is about.
		assert.deepEqual(htmlToDelta('<p><span style="color:red">x</span> y</p>'), {
			ops: [{ insert: 'x y\n' }]
		});
		assert.deepEqual(htmlToDelta('<p><font size="4">x</font></p>'), { ops: [{ insert: 'x\n' }] });
		assert.deepEqual(htmlToDelta('<p><mark>x</mark></p>'), { ops: [{ insert: 'x\n' }] });
	});

	it('malformed markup degrades instead of throwing — it runs on every keystroke', () => {
		// `plainToRichText` is called from a reactive statement on input, so a throw
		// takes the editor down with the field half-typed.
		assert.deepEqual(htmlToDelta('<p>a'), { ops: [{ insert: 'a\n' }] });
		assert.deepEqual(htmlToDelta('a</p>'), { ops: [{ insert: 'a\n' }] });
		assert.deepEqual(htmlToDelta('<p>a<b>b</p>'), {
			ops: [{ insert: 'a' }, { insert: 'b', attributes: { bold: true } }, { insert: '\n' }]
		});
		assert.deepEqual(htmlToDelta('<p>5 < 6</p>'), { ops: [{ insert: '5 < 6\n' }] });
		assert.deepEqual(htmlToDelta('<p><!-- note -->a</p>'), { ops: [{ insert: 'a\n' }] });
		assert.deepEqual(htmlToDelta('<p>a<img src="x">b</p>'), { ops: [{ insert: 'ab\n' }] });
		assert.deepEqual(htmlToDelta('<p title="a<b">x</p>'), { ops: [{ insert: 'x\n' }] });
		// An empty list container is still a block boundary: `a` and `b` are two lines
		// in a browser, and merging them would be the one case where not flushing the
		// line before a CONTAINER opens — not just before a leaf block — is visible.
		assert.deepEqual(htmlToDelta('a<ul></ul>b'), { ops: [{ insert: 'a\nb\n' }] });
	});

	it('NO INPUT LOSES TEXT — the property, over the shapes the three tenants store, EXACTLY', () => {
		/**
		 * Run for real over every `rich_text` html on local Apex — 110 stored and
		 * synthetic values across Poovayya, Godrej and GLC: nothing threw, and nothing
		 * lost a character. The corpus below is the representative slice of that,
		 * pinned here so the property is checked without a live account.
		 *
		 * ── WHY THE EXPECTATIONS ARE EXACT NOW (codex P5 fix 4, item 1) ───────────
		 * This assertion used to read
		 *
		 *     const textOf = (value) => value.replace(/\s+/gu, '');
		 *     assert.equal(textOf(deltaText), textOf(richTextPlainText(html)));
		 *
		 * — every space, tab and newline deleted from BOTH sides before comparing.
		 * That is how a 581-test suite failed to notice that
		 * `htmlToDelta('<strong>a</strong> <em>b</em>')` was joining two words:
		 * the only thing it lost was whitespace, and whitespace was exactly what the
		 * helper threw away. A test that deletes the class of value the code under test
		 * mishandles is not a weak test, it is a blind one.
		 *
		 * It compared against `richTextPlainText`, too — a regex tag-stripper that
		 * disagreed with the converter on line breaks, which is WHY the stripping was
		 * introduced. So both halves are gone: the reference is now the measured text
		 * itself, written out, one string per input, no normalisation of any kind.
		 * Re-running the file against these un-stripped expectations moved exactly one
		 * case beyond the trailing newline every entry gained — the NESTED LIST, where
		 * the old reference said `'ab'` and the delta correctly says `'a\nb\n'`.
		 *
		 * Every value below was read off the converter AND cross-checked against a real
		 * Quill 2.0.3's own `clipboard.convert` under jsdom — an independent html→delta
		 * implementation. All but three agree character for character; those three are
		 * named at the bottom, and in each the kit is the one that keeps more.
		 */
		const corpus = [
			[
				'<p>Aditya Poovayya is the founding partner of Poovayya &amp; Co.</p>',
				'Aditya Poovayya is the founding partner of Poovayya & Co.\n'
			],
			['<h1>Excellence in Legal Practice</h1>', 'Excellence in Legal Practice\n'],
			[
				'<p><span class="glc-dropcap">G</span>od is holy, and He can’t tolerate sin.</p>',
				'God is holy, and He can’t tolerate sin.\n'
			],
			[
				'<p>We uphold the Solas:</p><ul><li>Sola Scriptura</li><li>Sola Fide</li></ul>',
				'We uphold the Solas:\nSola Scriptura\nSola Fide\n'
			],
			['<blockquote>A quoted line</blockquote>', 'A quoted line\n'],
			['<p>a</p><p></p><p>b</p>', 'a\n\nb\n'],
			['<p>a<br>b</p>', 'a\nb\n'],
			['<div>one</div><div>two</div>', 'one\ntwo\n'],
			['<p>5 &lt; 6 &amp; 7 &gt; 6</p>', '5 < 6 & 7 > 6\n'],
			['<p>a\u00a0b</p>', 'a\u00a0b\n'],
			['<p><b>bold</b><i>italic</i><u>under</u><s>strike</s></p>', 'bolditalicunderstrike\n'],
			// The one the old helper was actively masking: two LINES, not two words.
			['<ul><li>a<ul><li>b</li></ul></li></ul>', 'a\nb\n'],
			[
				'<p><a href="https://x.test/">link</a> and <a href="javascript:x">refused</a></p>',
				'link and refused\n'
			],
			['<p><!-- comment -->kept</p>', 'kept\n'],
			['<p><span style="color:red">unknown tag</span></p>', 'unknown tag\n'],
			['<table><tr><td>cell</td></tr></table>', 'cell\n'],
			['<p>unclosed', 'unclosed\n'],
			['stray</p>', 'stray\n'],
			['<p><b>crossed</p>', 'crossed\n'],
			['<p><ul><li>chrome nests badly</li></ul></p>', 'chrome nests badly\n'],
			// Formatted runs at the DOCUMENT ROOT — the shape item 1 was about, and the
			// shape this corpus did not contain, which is the second reason it passed.
			['<strong>a</strong> <em>b</em>', 'a b\n'],
			['<b>bold</b> then <i>ital</i> then plain', 'bold then ital then plain\n'],
			['<a href="https://x.test/">one</a> and <a href="https://y.test/">two</a>', 'one and two\n'],
			['<b>a</b>&nbsp;<i>b</i>', 'a\u00a0b\n'],
			['<u>u</u> <s>s</s> <code>c</code>', 'u s c\n'],
			// Pretty-printed markup, which used to destroy the block it indented.
			['<h2>\n  Heading\n</h2>', 'Heading\n'],
			['<ul>\n  <li>\n    a\n  </li>\n</ul>', 'a\n'],
			['<div>\n  <b>x</b>\n</div>', 'x\n'],
			['<p>a\nb</p>', 'a b\n']
		];
		for (const [html, expected] of corpus) {
			const carried = htmlToDelta(html)
				.ops.map((op) => String(op.insert))
				.join('');
			assert.equal(carried, expected, html);
		}
		/**
		 * THE THREE DELIBERATE DIVERGENCES from Quill's own converter, all measured:
		 *
		 *   1. U+00A0 stays U+00A0. `clipboard.convert` normalises it to a plain space;
		 *      that is a character the author typed and the kit keeps it.
		 *   2. Runs of spaces and tabs are NOT collapsed — `<p>a  b</p>` really does hold
		 *      two spaces, because `preserveWhitespace: true` is how the CMS wrote it.
		 *   3. `<p><ul><li>x</li></ul></p>` — Quill opens with a phantom empty line, the
		 *      kit does not.
		 */
		assert.deepEqual(htmlToDelta('<p>a  b</p>'), { ops: [{ insert: 'a  b\n' }] });
	});

	it('an attribute named after a prototype member does not disturb the ones that are read', () => {
		/**
		 * The tag's attribute names come straight off the markup, so the bag is
		 * `Object.create(null)` and membership is `Object.hasOwn` — an ordinary `{}`
		 * answers `'constructor' in attributes` before anything is read, and assigning
		 * to `__proto__` writes through the prototype setter instead of storing a key.
		 *
		 * SAID PLAINLY: no mutation kills this one. Putting `{}` and `key in` back
		 * leaves every assertion here green, because the only names that collide after
		 * `.toLowerCase()` are `constructor` and `__proto__` and this module reads
		 * neither — it reads `href`, `class` and `data-list`. It is pinned anyway,
		 * because what makes it unreachable is the current READ LIST, and the read list
		 * grew by one in this same change.
		 */
		assert.deepEqual(htmlToDelta('<p constructor="x" __proto__="y">t</p>'), {
			ops: [{ insert: 't\n' }]
		});
		// The one that matters: a class still survives beside them.
		assert.deepEqual(
			htmlToDelta('<p __proto__="y" class="ql-align-center">t</p>').ops[1].attributes,
			{ align: 'center' }
		);
		// And an href still survives beside them, rather than being lost to the bag.
		assert.deepEqual(
			htmlToDelta('<p><a constructor="x" href="https://x.test/">t</a></p>').ops[0].attributes,
			{ link: 'https://x.test/' }
		);
	});

	it('EVERY indent derivation is clamped, not just the one written as a class', () => {
		/**
		 * CODEX P5 FIX 4, ITEM 5. `ql-indent-N` was rejected above 8 and nesting depth
		 * was not, so `<ul>`×30 wrote `indent: 29` — a level Quill has no `ql-indent-*`
		 * class for, so it renders flush left while the html renders it nested. The two
		 * halves of one value disagreeing, from the other end.
		 *
		 * MUTATION: drop the `clampIndent(...)` wrapper and the last assertion fails.
		 */
		const nested = (depth) => '<ul><li>'.repeat(depth) + 'deep' + '</li></ul>'.repeat(depth);
		assert.deepEqual(htmlToDelta(nested(3)).ops.at(-1).attributes, {
			list: 'bullet',
			indent: 2
		});
		// Nine deep is past the last class Quill ships, and comes back AT it.
		assert.deepEqual(htmlToDelta(nested(20)).ops.at(-1).attributes, {
			list: 'bullet',
			indent: 8
		});
		// The class derivation, unchanged: 8 is the last one that is honoured.
		assert.deepEqual(htmlToDelta('<p class="ql-indent-8">x</p>').ops[1].attributes, { indent: 8 });
		// Past it the class is ignored entirely — no attributes, so the two ops merge.
		assert.deepEqual(htmlToDelta('<p class="ql-indent-9">x</p>'), { ops: [{ insert: 'x\n' }] });
		// And the text is never the thing that is lost, however hostile the nesting.
		assert.ok(
			htmlToDelta(nested(200))
				.ops.map((op) => String(op.insert))
				.join('')
				.includes('deep')
		);
	});

	it('a block element this module does not model still ENDS A LINE', () => {
		/**
		 * OPUS 7b. `<section>a</section><section>b</section>` came back as `ab` — two
		 * paragraphs run together into one word. Losing a format we do not model is a
		 * formatting change; running two words together is text corruption.
		 *
		 * Every tag below was measured to end a line in Quill 2.0.3's own
		 * `clipboard.convert`, and every tag in the second list was measured NOT to.
		 *
		 * MUTATION: remove the second group from `LEAF_BLOCK` and the first loop fails.
		 */
		for (const name of [
			'section',
			'article',
			'header',
			'footer',
			'main',
			'nav',
			'address',
			'figure',
			'figcaption',
			'dl',
			'dt',
			'dd',
			'fieldset'
		]) {
			assert.deepEqual(
				htmlToDelta(`<${name}>a</${name}><${name}>b</${name}>`),
				{ ops: [{ insert: 'a\nb\n' }] },
				name
			);
		}
		/**
		 * TABLE INTERNALS, AND THE CLAIM THAT USED TO BE HERE.
		 *
		 * This comment said "the table internals are NOT lines — measured against the
		 * same Quill build", and that was FALSE (Opus review of fix pass 4, finding
		 * 3). Quill 2.0.3's `isLine` list contains `table`, `td` and `tr`, and
		 * `<table><tr><td>a</td><td>b</td></tr></table>` reads as `"a\nb"` there while
		 * this module produced `"ab"` — two cells run together into one word, which is
		 * text corruption rather than a lost format.
		 *
		 * Neither assertion that stood here could see it. `<td>a</td><td>b</td>` with
		 * no `<table>` around it is not a measurement of Quill's rule at all: the
		 * browser's parser DELETES those tags before the clipboard sees them, so the
		 * "agreement" was between this module and a document Quill never received. The
		 * other case was a single cell, where a line break has nothing to separate.
		 *
		 * MUTATION: remove `table`/`tr`/`td` from `LEAF_BLOCK` and the first two below
		 * fail.
		 */
		assert.deepEqual(htmlToDelta('<table><tr><td>a</td><td>b</td></tr></table>'), {
			ops: [{ insert: 'a\nb\n' }]
		});
		assert.deepEqual(
			htmlToDelta('<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></tbody></table>'),
			{ ops: [{ insert: 'a\nb\nc\n' }] }
		);
		// `th`, `tbody`, `thead` and `caption` are genuinely absent from Quill's list
		// — the two cells of a header row are ONE line — so the row break comes from
		// the `<tr>` around them and nothing else.
		assert.deepEqual(
			htmlToDelta(
				'<table><thead><tr><th>h1</th><th>h2</th></tr></thead><tbody><tr><td>a</td></tr></tbody></table>'
			),
			{ ops: [{ insert: 'h1h2\na\n' }] }
		);
		assert.deepEqual(htmlToDelta('<table><tr><td>cell</td></tr></table>'), {
			ops: [{ insert: 'cell\n' }]
		});
	});

	it('pathological nesting is bounded rather than unbounded, and keeps the text', () => {
		const deep = '<div>'.repeat(500) + 'x' + '</div>'.repeat(500);
		assert.deepEqual(htmlToDelta(deep).ops.at(-1).insert.endsWith('\n'), true);
		assert.ok(htmlToDelta(deep).ops.some((op) => String(op.insert).includes('x')));
		const wide = '<img>'.repeat(500) + '<p>x</p>';
		assert.deepEqual(htmlToDelta(wide), { ops: [{ insert: 'x\n' }] });
	});
});

describe('the delta and the stored html are judged by ONE set of rules', () => {
	/**
	 * CODEX P5 FIX 4, ITEM 3. `{editor, html, content}` is one value with two
	 * readings — the site renders `html`, Apex's CMS builds its editor from the
	 * delta in `content` — so the two must not be able to say different things.
	 * They were judged by different rules and could:
	 *
	 *   • the delta's link check was the RENDER-time `isSafeUrl`, which is happy
	 *     with an unresolved character reference (it resolves as a relative URL),
	 *     while the WRITE boundary refuses one outright;
	 *   • unknown elements are unwrapped here, keeping their text, while the write
	 *     boundary drops the EXECUTABLE ones with their contents.
	 *
	 * `htmlToDelta` now parses `sanitizeWriteHtml(input)` and asks `isSafeUrlValue`
	 * about hrefs, so both halves are readings of one string.
	 */
	it('an over-long numeric or hex reference in an href is refused by BOTH halves', () => {
		// A browser has no 7-digit window: this IS `javascript:` when it renders.
		// `decodeReferences` cannot read it, and "cannot be read" must not resolve
		// to "safe" — so the write boundary drops the attribute, and the delta must
		// not carry a link the stored html no longer has.
		for (const href of [
			'&#00000000106;avascript:alert(1)',
			'&#x000000006A;avascript:alert(1)',
			'&#106avascript:alert(1)'
		]) {
			const html = `<p><a href="${href}">t</a></p>`;
			assert.equal(sanitizeWriteHtml(html).includes('href'), false, href);
			assert.deepEqual(htmlToDelta(html), { ops: [{ insert: 't\n' }] }, href);
		}
		// And the same value under the OLD judge reads as SAFE. That difference is
		// the whole finding: the delta kept a link the stored html had dropped.
		assert.equal(isSafeUrl('&#00000000106;avascript:alert(1)'), true);
		assert.equal(isSafeUrlValue('&#00000000106;avascript:alert(1)'), false);
	});

	it('the delta asks the STORAGE judge, so it cannot drop a link the html keeps', () => {
		/**
		 * The two predicates disagree in BOTH directions, and this is the direction
		 * that survives sanitisation. A bare backslash pair is refused by the
		 * RENDER-time `isSafeUrl` (some browsers read it as protocol-relative) and
		 * accepted by the write boundary, which resolves it like any other relative
		 * value — so `sanitizeWriteHtml` KEEPS the href.
		 *
		 * If this module asked the render judge, the stored html would carry the link
		 * and the delta would not: one value, two answers, which is the whole finding.
		 * Which judge the RENDERER then applies to that href is its own business, and
		 * it still refuses it — that is the render allowlist doing its job, not a
		 * reason for the delta to disagree with the string it is a reading of.
		 */
		const href = '\\\\evil.test\\a';
		assert.equal(isSafeUrl(href), false);
		assert.equal(isSafeUrlValue(href), true);
		assert.equal(sanitizeWriteHtml(`<p><a href="${href}">t</a></p>`).includes('href'), true);
		assert.deepEqual(htmlToDelta(`<p><a href="${href}">t</a></p>`).ops[0].attributes, {
			link: href
		});
	});

	it('an executable wrapper loses its TEXT in the delta, exactly as it does in the html', () => {
		// Unwrapping an unknown element keeps its text on purpose. An EXECUTABLE
		// element is not unknown — the write boundary deletes it and everything
		// inside it — so keeping the text here would have put script source into
		// the CMS's editor as prose, beside an `html` that had none of it.
		for (const html of [
			'<p>a</p><script>alert(1)</script><p>b</p>',
			'<p>a</p><style>body{x:1}</style><p>b</p>',
			'<p>a</p><svg><animate values="javascript:alert(1)"></animate></svg><p>b</p>',
			'<p>a</p><form><input value="x"></form><p>b</p>'
		]) {
			const carried = htmlToDelta(html)
				.ops.map((op) => String(op.insert))
				.join('');
			assert.equal(carried, 'a\nb\n', html);
		}
		for (const html of [
			'<script>alert(1)</script>',
			'<style>p{}</style>',
			'<p>keep<script>drop</script>keep2</p>'
		]) {
			const carried = htmlToDelta(html)
				.ops.map((op) => String(op.insert))
				.join('');
			assert.equal(/alert|drop|p\{\}/u.test(carried), false, html);
		}
	});

	it('an ordinary href survives both halves, decoded the same way in each', () => {
		// The risk a stricter judge brings is refusing something ordinary, so the
		// safe set is pinned beside the refused one.
		for (const href of [
			'https://x.test/a?b=1&amp;c=2',
			'/areas-of-work',
			'#top',
			'mailto:a@x.test',
			'tel:+911234567890',
			'https://例え.jp/a'
		]) {
			const html = `<p><a href="${href}">t</a></p>`;
			assert.equal(sanitizeWriteHtml(html).includes('href'), true, href);
			assert.deepEqual(htmlToDelta(html).ops[0].attributes, { link: decodeReferences(href) }, href);
		}
	});
});

describe('plainToRichText writes the faithful delta, not the flattened one', () => {
	const QUILL = {
		editor: 'quilljs',
		html: '<p>Stored body</p>',
		content: { ops: [{ insert: 'Stored body\n' }] }
	};

	it('formatting entered in the new admin reaches `content`, which is what the CMS reads', () => {
		/**
		 * THE REGRESSION GUARD FOR ITEM 1. Asserting `next.html` alone passed before
		 * the fix and would pass after any future flattening — the CMS never reads
		 * `html`. The delta is the assertion that matters.
		 */
		const next = plainToRichText('<h2>Head</h2><p><b>Bold</b> and <i>ital</i></p>', QUILL);
		assert.equal(next.editor, 'quilljs');
		assert.deepEqual(next.content, {
			ops: [
				{ insert: 'Head' },
				{ insert: '\n', attributes: { header: 2 } },
				{ insert: 'Bold', attributes: { bold: true } },
				{ insert: ' and ' },
				{ insert: 'ital', attributes: { italic: true } },
				{ insert: '\n' }
			]
		});
		assert.ok(
			next.content.ops.some((op) => op.attributes?.bold),
			'a delta with no attributes at all is the flattened bug coming back'
		);
	});

	it('a tiptap field still NEVER receives a Quill delta', () => {
		const next = plainToRichText('<p><b>x</b></p>', {
			editor: 'tiptap',
			html: '<p>old</p>',
			content: {}
		});
		assert.deepEqual(next.content, {});
	});

	it('every attribute survives a save from the new admin, one case each', () => {
		const carried = [
			['<p><b>x</b></p>', { bold: true }],
			['<p><i>x</i></p>', { italic: true }],
			['<p><u>x</u></p>', { underline: true }],
			['<p><s>x</s></p>', { strike: true }],
			['<p><a href="https://x.test/">x</a></p>', { link: 'https://x.test/' }]
		];
		for (const [html, attributes] of carried) {
			const next = plainToRichText(html, QUILL, { defaultEditor: 'quilljs' });
			assert.deepEqual(next.content.ops[0].attributes, attributes, html);
		}
		const blocks = [
			['<h2>x</h2>', { header: 2 }],
			['<h3>x</h3>', { header: 3 }],
			['<ul><li>x</li></ul>', { list: 'bullet' }],
			['<ol><li>x</li></ol>', { list: 'ordered' }],
			['<blockquote>x</blockquote>', { blockquote: true }]
		];
		for (const [html, attributes] of blocks) {
			const next = plainToRichText(html, QUILL, { defaultEditor: 'quilljs' });
			assert.deepEqual(next.content.ops[1].attributes, attributes, html);
		}
	});

	it('a null-editor field taking the quilljs default gets the faithful delta too', () => {
		// Poovayya's twelve `team_member` records are stored `editor: null`, and its
		// admin passes `defaultEditor="quilljs"`. They are the records this defect
		// would have hit first.
		const next = plainToRichText(
			'<p><b>x</b></p>',
			{
				editor: null,
				html: '<p>old</p>',
				content: { ops: [] }
			},
			{ defaultEditor: 'quilljs' }
		);
		assert.equal(next.editor, 'quilljs');
		assert.deepEqual(next.content.ops[0].attributes, { bold: true });
	});

	it('an unchanged field still comes back BY IDENTITY — the delta is not regenerated', () => {
		// Rule A is what keeps a save that touched a different field from reshaping
		// this one, and the conversion must not have weakened it.
		assert.equal(plainToRichText('<p>Stored body</p>', QUILL), QUILL);
	});
});
