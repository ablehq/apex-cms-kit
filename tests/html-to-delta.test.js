// @ts-nocheck — node:test suite over the admin's HTML→Delta conversion.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { htmlToDelta } from '../src/admin/html-to-delta.js';
import { plainToRichText, richTextPlainText } from '../src/admin/rich-text.js';

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
		assert.deepEqual(htmlToDelta('<p>a&nbsp;b</p>'), { ops: [{ insert: 'a b\n' }] });
		assert.deepEqual(htmlToDelta('<p>&#65;&#x42;</p>'), { ops: [{ insert: 'AB\n' }] });
		// A reference outside the set stays literal rather than becoming a guess.
		assert.deepEqual(htmlToDelta('<p>&copy;</p>'), { ops: [{ insert: '&copy;\n' }] });
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

	it('NO INPUT LOSES TEXT — the property, over the shapes the three tenants store', () => {
		/**
		 * Run for real over every `rich_text` html on local Apex — 110 stored and
		 * synthetic values across Poovayya, Godrej and GLC: nothing threw, and nothing
		 * lost a character. The corpus below is the representative slice of that,
		 * pinned here so the property is checked without a live account.
		 *
		 * It is the property that matters most: this conversion runs on every keystroke
		 * and its output is stored. Losing an attribute we do not model is a formatting
		 * change; losing TEXT is the failure this whole item is about, pointed the other
		 * way.
		 */
		const corpus = [
			'<p>Aditya Poovayya is the founding partner of Poovayya &amp; Co.</p>',
			'<h1>Excellence in Legal Practice</h1>',
			'<p><span class="glc-dropcap">G</span>od is holy, and He can\u2019t tolerate sin.</p>',
			'<p>We uphold the Solas:</p><ul><li>Sola Scriptura</li><li>Sola Fide</li></ul>',
			'<blockquote>A quoted line</blockquote>',
			'<p>a</p><p></p><p>b</p>',
			'<p>a<br>b</p>',
			'<div>one</div><div>two</div>',
			'<p>5 &lt; 6 &amp; 7 &gt; 6</p>',
			'<p>a\u00a0b</p>',
			'<p><b>bold</b><i>italic</i><u>under</u><s>strike</s></p>',
			'<ul><li>a<ul><li>b</li></ul></li></ul>',
			'<p><a href="https://x.test/">link</a> and <a href="javascript:x">refused</a></p>',
			'<p><!-- comment -->kept</p>',
			'<p><span style="color:red">unknown tag</span></p>',
			'<table><tr><td>cell</td></tr></table>',
			'<p>unclosed',
			'stray</p>',
			'<p><b>crossed</p>',
			'<p><ul><li>chrome nests badly</li></ul></p>'
		];
		// Whitespace is stripped from BOTH sides on purpose. The two disagree about it
		// and `richTextPlainText` is the sloppier one — its `</li>` → newline regex
		// runs `a` and `b` together for a NESTED list, where the delta correctly puts
		// them on two lines. The claim under test is that no CHARACTER is lost, and
		// pinning line breaks to the weaker reference would pin the weakness.
		const textOf = (value) => value.replace(/\s+/gu, '');
		for (const html of corpus) {
			const delta = htmlToDelta(html);
			const carried = textOf(delta.ops.map((op) => String(op.insert)).join(''));
			const expected = textOf(richTextPlainText(html));
			assert.equal(carried, expected, html);
		}
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

	it('pathological nesting is bounded rather than unbounded, and keeps the text', () => {
		const deep = '<div>'.repeat(500) + 'x' + '</div>'.repeat(500);
		assert.deepEqual(htmlToDelta(deep).ops.at(-1).insert.endsWith('\n'), true);
		assert.ok(htmlToDelta(deep).ops.some((op) => String(op.insert).includes('x')));
		const wide = '<img>'.repeat(500) + '<p>x</p>';
		assert.deepEqual(htmlToDelta(wide), { ops: [{ insert: 'x\n' }] });
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
