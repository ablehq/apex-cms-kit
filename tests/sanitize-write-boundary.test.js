// @ts-nocheck — node:test suite over dynamic values; behavior is the contract.
// Ported from godrej-foundation's vitest spec when the write-boundary sanitizer
// moved into the kit; the cases are unchanged.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	MAX_FIELD_VALUE_CHARS,
	fieldValueChars,
	isSafeUrlValue,
	oversizedFieldNames,
	residualReferenceFieldNames,
	sanitizeFieldValue,
	sanitizeWriteHtml
} from '../src/sanitize/write-boundary.ts';

describe('isSafeUrlValue', () => {
	it('accepts the allowed protocols', () => {
		assert.deepEqual(isSafeUrlValue('https://example.com/a'), true);
		assert.deepEqual(isSafeUrlValue('http://example.com'), true);
		assert.deepEqual(isSafeUrlValue('mailto:someone@example.com'), true);
		assert.deepEqual(isSafeUrlValue('tel:+911234567890'), true);
	});

	it('accepts root-relative and anchor values', () => {
		assert.deepEqual(isSafeUrlValue('/areas-of-work'), true);
		assert.deepEqual(isSafeUrlValue('#section'), true);
		assert.deepEqual(isSafeUrlValue(''), true);
	});

	it('rejects the executable and embedding protocols', () => {
		assert.deepEqual(isSafeUrlValue('javascript:alert(1)'), false);
		assert.deepEqual(isSafeUrlValue('JaVaScRiPt:alert(1)'), false);
		assert.deepEqual(isSafeUrlValue('vbscript:msgbox(1)'), false);
		assert.deepEqual(isSafeUrlValue('data:text/html,<script>alert(1)</script>'), false);
	});

	it('rejects a protocol hidden behind whitespace or control characters', () => {
		assert.deepEqual(isSafeUrlValue('java\tscript:alert(1)'), false);
		assert.deepEqual(isSafeUrlValue('java\nscript:alert(1)'), false);
		assert.deepEqual(isSafeUrlValue('  javascript:alert(1)'), false);
		assert.deepEqual(isSafeUrlValue('\u0000javascript:alert(1)'), false);
	});

	it('rejects a protocol hidden behind a C0 control character', () => {
		// The URL parser removes tab, LF and CR itself, so those were already refused.
		// It leaves the REST of the C0 range in place — the value then fails scheme
		// parsing and resolves as a relative url, which reads as SAFE. Poovayya's
		// sanitizer stripped every non-printable before deciding; that case merged in
		// here when the two were reconciled (plan 07, P4a).
		assert.deepEqual(isSafeUrlValue('java\u0000script:alert(1)'), false);
		assert.deepEqual(isSafeUrlValue('java\u000bscript:alert(1)'), false);
		assert.deepEqual(isSafeUrlValue('java\u000cscript:alert(1)'), false);
		assert.deepEqual(isSafeUrlValue('javascript\u007f:alert(1)'), false);
		// A non-ASCII host is NOT a control character and must survive: Poovayya's
		// `[^!-~]` strip would have destroyed it, which is why only the control range
		// came across.
		assert.deepEqual(isSafeUrlValue('https://\u4f8b\u3048.jp/a'), true);
		assert.deepEqual(isSafeUrlValue('/caf\u00e9/men\u00fc'), true);
	});

	it('rejects a protocol hidden behind HTML entities', () => {
		assert.deepEqual(isSafeUrlValue('&#106;avascript:alert(1)'), false);
		assert.deepEqual(isSafeUrlValue('&#x6a;avascript:alert(1)'), false);
		assert.deepEqual(isSafeUrlValue('javascript&colon;alert(1)'), false);
	});

	it('rejects `&Tab;`, the entity this module used to spell in lower case', () => {
		// P4 review finding 1(a). The local table held `tab`, which is not an HTML
		// entity; the real one is `&Tab;`, and a browser turns it into a tab the URL
		// parser then strips. The judge now decodes with `html.js`'s grammar, which
		// lower-cases the name before the lookup, so both spellings resolve.
		assert.deepEqual(isSafeUrlValue('java&Tab;script:alert(1)'), false);
		assert.deepEqual(isSafeUrlValue('java&tab;script:alert(1)'), false);
		assert.deepEqual(isSafeUrlValue('java&NewLine;script:alert(1)'), false);
	});

	it('refuses a reference too long for the decoder rather than judging it decoded', () => {
		// P4 review finding 1(b). The decode windows are 7 decimal digits and 6 hex;
		// a browser has no window at all, so a zero-padded reference IS `javascript:`
		// to it and was left untouched — and therefore judged safe — here. Nothing
		// re-escapes at the write boundary, so the answer is to refuse.
		assert.deepEqual(isSafeUrlValue('&#00000000106;avascript:alert(1)'), false);
		assert.deepEqual(isSafeUrlValue('&#x0000006A;avascript:alert(1)'), false);
		// Unterminated too: a browser decodes `&#106` without the semicolon.
		assert.deepEqual(isSafeUrlValue('&#106avascript:alert(1)'), false);
		// And any other unresolved reference, whatever it spells.
		assert.deepEqual(isSafeUrlValue('https://example.com/?a=&unknownentity;'), false);
	});

	it('still accepts an ordinary escaped query string', () => {
		// The fail-closed rule must not refuse the `&amp;` every editor's link
		// carries: it DECODES, so nothing is left over to refuse.
		assert.deepEqual(isSafeUrlValue('https://example.com/s?q=a&amp;b=c'), true);
		assert.deepEqual(isSafeUrlValue('https://example.com/s?q=a&b=c'), true);
		assert.deepEqual(isSafeUrlValue('/areas?a=1&b=2'), true);
	});

	it('rejects a scheme hidden behind a zero-width or non-breaking space', () => {
		// The local strip was `[\u0000-\u001f\u007f]`; `html.js`'s covers the C1
		// range, NBSP, and the zero-width and bidi marks, which browsers also skip
		// while reading a scheme. Sharing it is what closed these.
		assert.deepEqual(isSafeUrlValue('java\u200bscript:alert(1)'), false);
		assert.deepEqual(isSafeUrlValue('java\u00a0script:alert(1)'), false);
		assert.deepEqual(isSafeUrlValue('\ufeffjavascript:alert(1)'), false);
	});
});

describe('sanitizeHtml', () => {
	it('leaves safe markup alone', () => {
		const html = '<p>Read the <a href="https://example.com">report</a>.</p>';
		assert.deepEqual(sanitizeWriteHtml(html), html);
	});

	it('drops an href whose protocol is not allowed', () => {
		assert.deepEqual(sanitizeWriteHtml('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
		assert.deepEqual(sanitizeWriteHtml("<a href='javascript:alert(1)'>x</a>"), '<a>x</a>');
		assert.deepEqual(sanitizeWriteHtml('<a href=javascript:alert(1)>x</a>'), '<a>x</a>');
	});

	it('drops a dangerous src', () => {
		assert.deepEqual(sanitizeWriteHtml('<img src="data:text/html;base64,PHN2Zz4=">'), '<img>');
	});

	it('strips nested tags that would reconstitute on a single pass', () => {
		// `<scr<script></script>ipt>` holds a complete inner `<script></script>`;
		// removing it once joins `<scr` to `ipt>` and yields a LIVE `<script>`.
		assert.deepEqual(
			sanitizeWriteHtml('<scr<script></script>ipt>alert(1)</scr<script></script>ipt>'),
			''
		);
		assert.deepEqual(sanitizeWriteHtml('<sty<style></style>le>x</style>'), 'x');
		assert.deepEqual(
			sanitizeWriteHtml('<scr<scr<script></script>ipt></script>ipt>alert(1)'),
			'alert(1)'
		);
	});

	it('removes executable elements outright, not just their attributes', () => {
		// An `<iframe>` used to survive with its `src` stripped. It no longer survives at
		// all: the element denylist runs first, so there is nothing left to hold an
		// attribute. Same for a `<script>` that carries no attribute to strip.
		assert.deepEqual(sanitizeWriteHtml('<iframe src="javascript:alert(1)"></iframe>'), '');
		assert.deepEqual(sanitizeWriteHtml('<p>hi</p><script>alert(1)</script>'), '<p>hi</p>');
		assert.deepEqual(sanitizeWriteHtml('<SCRIPT>alert(1)</SCRIPT>'), '');
		assert.deepEqual(sanitizeWriteHtml('<style>body{display:none}</style>'), '');
		// An unclosed tag cannot slip the pair — the bare-tag alternative catches it.
		assert.deepEqual(sanitizeWriteHtml('<p>a</p><script>alert(1)'), '<p>a</p>alert(1)');
	});

	it('leaves presentational markup and bare comparisons alone', () => {
		const safe = '<p>keep <b>me</b> <a href="https://ok.com">link</a></p>';
		assert.deepEqual(sanitizeWriteHtml(safe), safe);
		assert.deepEqual(sanitizeWriteHtml('<p>1 < 2 and 3 > 2</p>'), '<p>1 < 2 and 3 > 2</p>');
	});

	it('drops inline event handlers', () => {
		assert.deepEqual(
			sanitizeWriteHtml('<img src="/a.png" onerror="alert(1)">'),
			'<img src="/a.png">'
		);
		assert.deepEqual(sanitizeWriteHtml('<p onclick=alert(1)>x</p>'), '<p>x</p>');
		// `<svg>` is now dropped with its contents (see EXECUTABLE_ELEMENT), so the
		// handler goes with the element rather than being stripped off a survivor.
		assert.deepEqual(sanitizeWriteHtml("<svg onload='alert(1)'></svg>"), '');
	});

	it('drops a handler that follows a quote or a slash, with no whitespace at all', () => {
		// P4 review finding 1(c). `\son…` required whitespace; the HTML parser does
		// not, and all three of these execute in a browser.
		assert.deepEqual(sanitizeWriteHtml('<img src="x"onerror=alert(1)>'), '<img src="x">');
		assert.deepEqual(
			sanitizeWriteHtml('<a href="/x"/onclick=alert(1)>y</a>'),
			'<a href="/x"/>y</a>'
		);
		assert.deepEqual(sanitizeWriteHtml("<p id='a'onmouseover=alert(1)>y</p>"), "<p id='a'>y</p>");
		// The whitespace case still consumes its space rather than leaving `<p >`.
		assert.deepEqual(sanitizeWriteHtml('<p onclick="alert(1)">y</p>'), '<p>y</p>');
	});

	it('drops the elements that carry executable children or a form target', () => {
		// P4 review finding 1(d). `<animate>` needs no event attribute and no href on
		// the svg itself; `formaction` is a navigation target the old attribute list
		// never looked at.
		assert.deepEqual(
			sanitizeWriteHtml('<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>'),
			''
		);
		assert.deepEqual(
			sanitizeWriteHtml('<form action="javascript:alert(1)"><button>go</button></form>'),
			''
		);
		assert.deepEqual(sanitizeWriteHtml('<math><mtext>x</mtext></math>'), '');
		assert.deepEqual(sanitizeWriteHtml('<p>a</p><input value="x">'), '<p>a</p>');
	});

	it('drops a URL-valued attribute that is not spelled href or src', () => {
		// The second lock: even on an element the denylist leaves standing.
		assert.deepEqual(sanitizeWriteHtml('<p formaction="javascript:alert(1)">x</p>'), '<p>x</p>');
		assert.deepEqual(sanitizeWriteHtml('<p ping="javascript:alert(1)">x</p>'), '<p>x</p>');
		assert.deepEqual(sanitizeWriteHtml('<p values="javascript:alert(1)">x</p>'), '<p>x</p>');
		assert.deepEqual(sanitizeWriteHtml('<p poster="javascript:alert(1)">x</p>'), '<p>x</p>');
		// A custom data attribute is not a URL sink and is left alone.
		assert.deepEqual(
			sanitizeWriteHtml('<p data-x="javascript:alert(1)">y</p>'),
			'<p data-x="javascript:alert(1)">y</p>'
		);
	});

	it('drops an href whose reference the decoder cannot read', () => {
		assert.deepEqual(sanitizeWriteHtml('<a href="java&Tab;script:alert(1)">x</a>'), '<a>x</a>');
		assert.deepEqual(
			sanitizeWriteHtml('<a href="&#00000000106;avascript:alert(1)">x</a>'),
			'<a>x</a>'
		);
		assert.deepEqual(
			sanitizeWriteHtml('<a href="&#x0000006A;avascript:alert(1)">x</a>'),
			'<a>x</a>'
		);
	});

	it('survives an href that hides behind a quoted angle bracket', () => {
		assert.deepEqual(
			sanitizeWriteHtml('<a title="a>b" href="javascript:alert(1)">x</a>'),
			'<a title="a>b">x</a>'
		);
	});
});

describe('sanitizeFieldValue', () => {
	it('sanitizes the html of a stored rich-text value and keeps the rest', () => {
		const value = {
			editor: 'quilljs',
			html: '<p><a href="javascript:alert(1)">x</a></p>',
			content: { ops: [{ insert: 'x\n' }] }
		};
		assert.deepEqual(sanitizeFieldValue(value), {
			editor: 'quilljs',
			html: '<p><a>x</a></p>',
			content: { ops: [{ insert: 'x\n' }] }
		});
	});

	it('returns the same object when nothing needed changing', () => {
		const value = { editor: 'quilljs', html: '<p>fine</p>', content: {} };
		assert.deepEqual(sanitizeFieldValue(value), value);
	});

	it('walks arrays, including an array of rich-text objects', () => {
		const ids = ['3f1b0c2e-0000-4000-8000-000000000000', 'not-a-uuid'];
		assert.deepEqual(sanitizeFieldValue(ids), ids);
		assert.deepEqual(
			sanitizeFieldValue([
				{ editor: 'quilljs', html: '<a href="javascript:alert(1)">x</a>', content: {} },
				'<img src="/a.png" onerror="alert(1)">'
			]),
			[{ editor: 'quilljs', html: '<a>x</a>', content: {} }, '<img src="/a.png">']
		);
	});

	it('walks NESTED objects, not only a top-level `html`', () => {
		// The gap that decided the merge: this sanitizer looked at `value.html` and
		// stopped, so anything one level down was stored as authored. Poovayya's
		// walked every key; that behaviour is now here.
		assert.deepEqual(sanitizeFieldValue({ a: { html: '<script>alert(1)</script>' } }), {
			a: { html: '' }
		});
		assert.deepEqual(
			sanitizeFieldValue({
				editor: 'quilljs',
				html: '<p>ok</p>',
				content: { blocks: [{ html: '<a href="javascript:alert(1)">x</a>' }] }
			}),
			{ editor: 'quilljs', html: '<p>ok</p>', content: { blocks: [{ html: '<a>x</a>' }] } }
		);
		// A key that is not `html` is no safer: the walk is structural.
		assert.deepEqual(sanitizeFieldValue({ html: 42, other: '<script>x</script>' }), {
			html: 42,
			other: ''
		});
	});

	it('returns the SAME object and the SAME array when nothing needed changing', () => {
		// The identity contract the walk must not break — a caller can still tell
		// "sanitized" from "untouched" by reference.
		const nested = { editor: 'quilljs', html: '<p>fine</p>', content: { ops: [{ insert: 'x' }] } };
		assert.equal(sanitizeFieldValue(nested), nested);
		const list = [{ html: '<p>fine</p>' }, 'plain'];
		assert.equal(sanitizeFieldValue(list), list);
		const changed = [{ html: '<script>x</script>' }];
		assert.notEqual(sanitizeFieldValue(changed), changed);
	});

	it('sanitizes bare HTML strings and leaves plain values untouched', () => {
		assert.deepEqual(sanitizeFieldValue('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
		assert.deepEqual(sanitizeFieldValue('Ravi & Co'), 'Ravi & Co');
		assert.deepEqual(sanitizeFieldValue('member'), 'member');
		assert.deepEqual(sanitizeFieldValue(42), 42);
	});
});

/**
 * ONE VALUE, ONE VERDICT — the two halves of a rich-text field, judged by what they
 * ARE (codex P5 fix 5, item 1).
 *
 * `html` is markup and keeps `sanitizeWriteHtml`. A `content` that is a Quill delta
 * or a ProseMirror document is a FORMATTING RECORD: its `insert`/`text` strings are
 * the document's literal text, and its `link`/`href`/`src` are URLs. Running the
 * markup sanitizer over the whole thing got BOTH of those backwards, in opposite
 * directions, and each direction below is the reproduction that named the defect.
 */
describe('sanitizeFieldValue judges a rich-text value part by part', () => {
	it('DIRECTION 1 — text that merely looks like a tag survives in the delta', () => {
		// Was: html kept the words escaped, and the delta came back `{"ops":[{"insert":"\n"}]}`
		// — the one copy Apex's own CMS UI loads its editor from, emptied. Its next
		// save would have written that loss into `html` too.
		const value = {
			editor: 'quilljs',
			html: '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
			content: { ops: [{ insert: '<script>alert(1)</script>\n' }] }
		};
		assert.deepEqual(sanitizeFieldValue(value), {
			editor: 'quilljs',
			html: '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
			content: { ops: [{ insert: '<script>alert(1)</script>\n' }] }
		});
		// Nothing needed doing to it, so the identity contract holds here too.
		assert.equal(sanitizeFieldValue(value), value);
	});

	it('DIRECTION 2 — a javascript: link in the delta is dropped, as it is in the html', () => {
		// Was: the href was stripped out of `html` and the SAME scheme was stored
		// verbatim in `attributes.link`, because it has no `<` in it and the walk
		// only ever looked for markup.
		const value = {
			editor: 'quilljs',
			html: '<p><a href="javascript:alert(1)">click</a></p>',
			content: {
				ops: [{ insert: 'click', attributes: { link: 'javascript:alert(1)' } }, { insert: '\n' }]
			}
		};
		assert.deepEqual(sanitizeFieldValue(value), {
			editor: 'quilljs',
			html: '<p><a>click</a></p>',
			content: { ops: [{ insert: 'click', attributes: {} }, { insert: '\n' }] }
		});
	});

	it('keeps a SAFE link, and keeps the formatting beside a dropped one', () => {
		assert.deepEqual(
			sanitizeFieldValue({
				editor: 'quilljs',
				html: '<p><a href="/areas">a</a></p>',
				content: {
					ops: [
						{ insert: 'a', attributes: { link: '/areas', bold: true } },
						{ insert: 'b', attributes: { link: 'javascript:alert(1)', bold: true } },
						{ insert: '\n' }
					]
				}
			}),
			{
				editor: 'quilljs',
				html: '<p><a href="/areas">a</a></p>',
				content: {
					ops: [
						{ insert: 'a', attributes: { link: '/areas', bold: true } },
						{ insert: 'b', attributes: { bold: true } },
						{ insert: '\n' }
					]
				}
			}
		);
	});

	it('judges a Quill image EMBED by the same predicate the html half uses', () => {
		// `{insert: {image: '…'}}` is a URL where the whole insert is the value. The
		// key goes and the op stays, the way `<img src="javascript:…">` comes back
		// as a src-less `<img>`.
		assert.deepEqual(sanitizeFieldValue({ ops: [{ insert: { image: 'javascript:alert(1)' } }] }), {
			ops: [{ insert: {} }]
		});
		const safe = { ops: [{ insert: { image: '/uploads/a.png' } }] };
		assert.equal(sanitizeFieldValue(safe), safe);
	});

	it('does the same for a tiptap document — text passes, marks[].attrs.href is judged', () => {
		assert.deepEqual(
			sanitizeFieldValue({
				editor: 'tiptap',
				html: '<p><a href="javascript:alert(1)">click</a></p>',
				content: {
					type: 'doc',
					content: [
						{
							type: 'paragraph',
							content: [
								{
									type: 'text',
									text: 'click',
									marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]
								},
								{ type: 'text', text: ' <script>alert(1)</script>' }
							]
						}
					]
				}
			}),
			{
				editor: 'tiptap',
				html: '<p><a>click</a></p>',
				content: {
					type: 'doc',
					content: [
						{
							type: 'paragraph',
							content: [
								{ type: 'text', text: 'click', marks: [{ type: 'link', attrs: {} }] },
								{ type: 'text', text: ' <script>alert(1)</script>' }
							]
						}
					]
				}
			}
		);
	});

	it('refuses a URL key whose value is not a string, and keeps an explicit `null`', () => {
		// Opus review of fix pass 5, finding 5. `CONTENT_URL_KEYS` only judged
		// strings, so `{link: ['javascript:…']}` and `{link: {url: '…'}}` walked past
		// the predicate as ordinary structure and rode through verbatim. A URL is a
		// string; anything else at one of these keys is something the judge cannot
		// read, and it drops to the same inert state a refused string does.
		assert.deepEqual(
			sanitizeFieldValue({ ops: [{ insert: 'x', attributes: { link: ['javascript:alert(1)'] } }] }),
			{ ops: [{ insert: 'x', attributes: {} }] }
		);
		assert.deepEqual(
			sanitizeFieldValue({
				ops: [{ insert: 'x', attributes: { link: { url: 'javascript:alert(1)' } } }]
			}),
			{ ops: [{ insert: 'x', attributes: {} }] }
		);
		// The embed key is the same rule with the whole insert as the value.
		assert.deepEqual(sanitizeFieldValue({ ops: [{ insert: { image: { u: 'javascript:x' } } }] }), {
			ops: [{ insert: {} }]
		});
		// …but an explicit `null` STAYS. A tiptap link mark with no target is
		// `attrs: {href: null}`, that is already the inert state, and rewriting it
		// would move a stored value for nothing — identity included.
		const unset = {
			type: 'doc',
			content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: null } }] }]
		};
		assert.equal(sanitizeFieldValue(unset), unset);
	});

	it('leaves the structural walk in place for a `content` that is NOT a delta', () => {
		// `{blocks: [{html}]}` is markup living under `content`, and it stays markup.
		// The exemption is for the two formatting dialects, not for the key name.
		assert.deepEqual(
			sanitizeFieldValue({
				editor: 'quilljs',
				html: '<p>ok</p>',
				content: { blocks: [{ html: '<script>alert(1)</script>' }] }
			}),
			{ editor: 'quilljs', html: '<p>ok</p>', content: { blocks: [{ html: '' }] } }
		);
	});

	it('names the field when the delta carries a URL the judge cannot READ', () => {
		// The refusal that keeps the two halves from being judged at different
		// VOLUMES: a residual reference in `html` refuses the write by name, so the
		// same one in `attributes.link` must too, rather than vanishing in silence
		// from a value that may be perfectly safe.
		assert.deepEqual(
			residualReferenceFieldNames({
				body: {
					editor: 'quilljs',
					html: '<p>x</p>',
					content: { ops: [{ insert: 'x', attributes: { link: '&#00000000106;avascript:x' } }] }
				},
				fine: { editor: 'quilljs', html: '<p>y</p>', content: { ops: [{ insert: 'y\n' }] } }
			}),
			['body']
		);
		// And plain text that spells a reference is TEXT, not a URL: no refusal.
		assert.deepEqual(
			residualReferenceFieldNames({
				body: { editor: 'quilljs', html: '<p>x</p>', content: { ops: [{ insert: '&#106;x\n' }] } }
			}),
			[]
		);
	});
});

/**
 * THE SCOPE OF THE EXEMPTION — what is a formatting record, and WHERE
 * (codex P5 fix 6, item 1).
 *
 * The block above says what a formatting record is judged BY. This one says which
 * objects get to be one, and it is the assertion whose absence let a HIGH
 * regression ship through the pass that wrote the block above: `isQuillDelta` asked
 * only "is there an `ops` array", so `{editor, html: '<hostile>', content: {},
 * ops: []}` was handed WHOLE to `sanitizeFormattingRecord` — which by design
 * rewrites nothing but URL keys — and the `html` the public sites render was stored
 * verbatim through a real handler, 200 OK. Apex drops the unknown `ops` on the way
 * in, so the stored value does not even carry the disguise; Godrej renders `.html`
 * through `{@html}` with no render-time sanitizer behind it.
 *
 * Two rules, and BOTH are needed — neither implies the other:
 *
 *   SHAPE. The object must be the dialect and nothing else. `{ops, html}` is not a
 *   delta; it is an object with a delta in it, and its `html` is markup.
 *   POSITION. A formatting record lives at the `content` of a rich-text value, or is
 *   the whole field value. `{a: {ops: […]}}` is some other field's nested object and
 *   nothing there has said its strings are a document's text; it keeps the
 *   structural walk, which is exactly what it got before the exemption existed.
 */
describe('sanitizeFieldValue recognises a formatting record by shape AND by position', () => {
	const HOSTILE = '<img src=x onerror=alert(1)><script>alert(2)</script>';
	const SANITIZED = '<img src=x>';

	it('SHAPE — one extra key means the object is not the delta, and its html is markup', () => {
		// The reproduction, at the unit the endpoint tests mount.
		assert.deepEqual(
			sanitizeFieldValue({ editor: 'quilljs', html: HOSTILE, content: {}, ops: [] }),
			{ editor: 'quilljs', html: SANITIZED, content: {}, ops: [] }
		);
		// …and the control it must equal: the same value with the decoy removed.
		assert.deepEqual(sanitizeFieldValue({ editor: 'quilljs', html: HOSTILE, content: {} }), {
			editor: 'quilljs',
			html: SANITIZED,
			content: {}
		});
	});

	it('SHAPE — the same for a doc, whose own keys are `type`, `content` and `attrs`', () => {
		assert.deepEqual(sanitizeFieldValue({ type: 'doc', html: HOSTILE }), {
			type: 'doc',
			html: SANITIZED
		});
		// A doc node's real keys still make a doc, `attrs` included…
		const doc = { type: 'doc', attrs: { id: 1 }, content: [{ type: 'text', text: HOSTILE }] };
		assert.equal(sanitizeFieldValue(doc), doc, 'text inside a doc is text, and untouched');
		// …and a `content` that is not a list of nodes is not a doc at all.
		assert.deepEqual(sanitizeFieldValue({ type: 'doc', content: HOSTILE }), {
			type: 'doc',
			content: SANITIZED
		});
	});

	it('SHAPE — a delta with an extra key UNDER `content` is not exempt either', () => {
		assert.deepEqual(
			sanitizeFieldValue({
				editor: 'quilljs',
				html: '<p>ok</p>',
				content: { ops: [{ insert: '<b>x</b>' }], html: HOSTILE }
			}),
			{
				editor: 'quilljs',
				html: '<p>ok</p>',
				// `<b>x</b>` survives because `<b>` is allowed markup, not because it is
				// text — the point is that this object went through the MARKUP judge.
				content: { ops: [{ insert: '<b>x</b>' }], html: SANITIZED }
			}
		);
	});

	it('POSITION — the `content` of a rich-text value is a record; the value AROUND it is not', () => {
		// `rich-text.js`'s header lists the stored shapes: a `content` beside an `html`
		// string or an `editor` (which is `null` on every Poovayya archetype primitive,
		// so presence is what counts). Both spellings reach the exemption.
		const byEditor = { editor: null, content: { ops: [{ insert: '<b>x</b>\n' }] } };
		assert.equal(sanitizeFieldValue(byEditor), byEditor);
		const byHtml = { html: '<p>x</p>', content: { ops: [{ insert: '<script>x</script>\n' }] } };
		assert.equal(sanitizeFieldValue(byHtml), byHtml);
		// And the negative that gives the predicate its edge: a `content` with neither
		// half of a rich-text value beside it is not a rich-text value's `content`. The
		// key name alone does not buy the exemption, or any field could be spelled into
		// it.
		assert.deepEqual(
			sanitizeFieldValue({ a: 1, content: { ops: [{ insert: '<script>x</script>' }] } }),
			{
				a: 1,
				content: { ops: [{ insert: '' }] }
			}
		);
	});

	it('POSITION — a field value that IS a delta is judged as one', () => {
		// `sanitizeFieldValue` is called once per field on all four write paths, so the
		// field value itself is the other place a record can legitimately be. It still
		// needs the exact shape, so it cannot be used to smuggle an `html` in beside it.
		assert.deepEqual(sanitizeFieldValue({ ops: [{ insert: { image: 'javascript:alert(1)' } }] }), {
			ops: [{ insert: {} }]
		});
		const text = { ops: [{ insert: '<script>alert(1)</script>\n' }] };
		assert.equal(sanitizeFieldValue(text), text);
	});

	it('POSITION — a delta-shaped object somewhere else keeps the structural walk', () => {
		// THE DELIBERATE TRADE, pinned so it is a decision rather than a drift. Shape
		// alone would say "an object with only an `ops` array is a formatting record
		// wherever it appears", and then any nested corner of any field could claim the
		// exemption by being spelled that way. Position says what the thing IS.
		//
		// What this costs: a `javascript:` string under `{a: {ops: […]}}` is stored
		// rather than dropped — which is what it did before the exemption existed at
		// all, since a string with no `<` in it was never markup. What it buys: the
		// strings there are still sanitized as markup, and no unrecognised structure
		// can turn off the judge for an `html` beside it.
		assert.deepEqual(sanitizeFieldValue({ a: { ops: [{ insert: HOSTILE }] } }), {
			a: { ops: [{ insert: SANITIZED }] }
		});
	});

	it('the residual-reference walk asks the SAME question in the SAME places', () => {
		// The two must agree or the refusal drifts away from the strip it announces.
		// `{ops: []}` switched this one off too: the field went unnamed where the
		// identical value without the decoy named it.
		const unreadable = '<a href="&#00000000106;avascript:x">c</a>';
		assert.deepEqual(
			residualReferenceFieldNames({
				decoy_ops: { editor: 'quilljs', html: unreadable, content: {}, ops: [] },
				decoy_doc: { type: 'doc', html: unreadable },
				control: { editor: 'quilljs', html: unreadable, content: {} }
			}),
			['decoy_ops', 'decoy_doc', 'control']
		);
		// And the record positions it must still reach: the `content` of an envelope,
		// and a field value that is itself a delta.
		assert.deepEqual(
			residualReferenceFieldNames({
				in_content: {
					editor: 'quilljs',
					html: '<p>x</p>',
					content: { ops: [{ insert: 'x', attributes: { link: '&#00000000106;avascript:x' } }] }
				},
				bare: { ops: [{ insert: 'x', attributes: { link: '&#00000000106;avascript:x' } }] }
			}),
			['in_content', 'bare']
		);
		// …and the positions it must NOT reach, which is the same rule as
		// `sanitizeFieldValue`'s and has to move with it. THIS REFUSAL EXISTS TO
		// ANNOUNCE A STRIP: in a non-record position the sanitizer treats these strings
		// as markup, `&#00000000106;avascript:x` has no `<` in it so nothing is
		// stripped, and a 400 naming the field would be a refusal of a write that was
		// about to be stored intact. The two walks agree or the boundary lies.
		const elsewhere = {
			body: { a: { ops: [{ insert: 'x', attributes: { link: '&#00000000106;avascript:x' } }] } }
		};
		assert.deepEqual(residualReferenceFieldNames(elsewhere), []);
		assert.equal(sanitizeFieldValue(elsewhere.body), elsewhere.body, 'nothing was stripped');
	});
});

describe('the per-field ceiling', () => {
	it('is 200 000 characters and counts a string by its length', () => {
		assert.equal(MAX_FIELD_VALUE_CHARS, 200_000);
		assert.equal(fieldValueChars('x'.repeat(200_000)), 200_000);
		assert.equal(fieldValueChars(''), 0);
		assert.equal(fieldValueChars(null), 0);
		assert.equal(fieldValueChars(undefined), 0);
	});

	it('measures a structured value by what actually travels — its JSON', () => {
		assert.equal(fieldValueChars({ a: 'bc' }), JSON.stringify({ a: 'bc' }).length);
		assert.equal(fieldValueChars(['a', 'b']), 9);
		assert.equal(fieldValueChars(42), 2);
		assert.equal(fieldValueChars(true), 4);
	});

	it('a value that will not encode is refused rather than waved through', () => {
		const circular = {};
		circular.self = circular;
		assert.equal(fieldValueChars(circular), Number.POSITIVE_INFINITY);
		assert.deepEqual(oversizedFieldNames({ circular }), ['circular']);
	});

	it('names every field over the ceiling and none that is under it', () => {
		const over = 'x'.repeat(200_001);
		assert.deepEqual(oversizedFieldNames({ a: 'x'.repeat(200_000), b: over, c: over, d: 1 }), [
			'b',
			'c'
		]);
		assert.deepEqual(oversizedFieldNames({}), []);
		// A non-object body cannot be walked, and answering "nothing is over" for one
		// is safe only because the shape check that follows refuses it anyway.
		assert.deepEqual(oversizedFieldNames(null), []);
		assert.deepEqual(oversizedFieldNames('x'.repeat(200_001)), []);
	});
});
