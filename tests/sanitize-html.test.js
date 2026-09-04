import assert from 'node:assert/strict';
import test from 'node:test';

import {
	allowRichTextClasses,
	decodeReferences,
	isSafeUrl,
	plainTextForAttribute,
	renderParagraphHtml,
	sanitizeHtml,
	sanitizeRichText
} from '../src/sanitize/html.js';
import { EVENT_HANDLER_PATTERN, FORBIDDEN_SUBSTRINGS, XSS_PAYLOADS } from './xss-corpus.js';

test('the payload corpus covers every category the plan names', () => {
	const categories = new Set(XSS_PAYLOADS.map((entry) => entry.category));
	for (const required of ['script', 'event-handler', 'javascript-url', 'svg', 'malformed']) {
		assert.ok(categories.has(required), `corpus is missing the ${required} category`);
	}
	assert.ok(XSS_PAYLOADS.length >= 40, 'corpus is smaller than it was');
});

test('every corpus payload renders inert', () => {
	for (const entry of XSS_PAYLOADS) {
		const output = sanitizeHtml(entry.payload);
		const lowered = output.toLowerCase();
		for (const forbidden of FORBIDDEN_SUBSTRINGS) {
			assert.ok(
				!lowered.includes(forbidden),
				`${entry.name}: output contains ${forbidden} — ${output}`
			);
		}
		assert.ok(
			!EVENT_HANDLER_PATTERN.test(output),
			`${entry.name}: output contains an event handler — ${output}`
		);
	}
});

test('inert output still keeps the reading text', () => {
	for (const entry of XSS_PAYLOADS) {
		if (!entry.keeps) continue;
		const text = plainTextForAttribute(sanitizeHtml(entry.payload));
		assert.ok(text.includes(entry.keeps), `${entry.name}: lost ${JSON.stringify(entry.keeps)}`);
	}
});

test('sanitizing is idempotent across the corpus', () => {
	for (const entry of XSS_PAYLOADS) {
		const once = sanitizeHtml(entry.payload);
		assert.equal(sanitizeHtml(once), once, `${entry.name} is not idempotent`);
	}
});

test('allowed prose markup survives unchanged in shape', () => {
	assert.equal(
		sanitizeHtml('<p>Plain <strong>bold</strong> and <em>italic</em>.</p>'),
		'<p>Plain <strong>bold</strong> and <em>italic</em>.</p>'
	);
	assert.equal(
		sanitizeHtml('<ul><li>One</li><li>Two</li></ul>'),
		'<ul><li>One</li><li>Two</li></ul>'
	);
	assert.equal(sanitizeHtml('<h2>Heading</h2>'), '<h2>Heading</h2>');
	assert.equal(
		sanitizeHtml('<blockquote><p>Quoted</p></blockquote>'),
		'<blockquote><p>Quoted</p></blockquote>'
	);
	assert.equal(sanitizeHtml('line<br>break'), 'line<br>break');
});

test('character references in prose are preserved, bare ampersands are escaped', () => {
	assert.equal(sanitizeHtml('<p>a&nbsp;b</p>'), '<p>a&nbsp;b</p>');
	assert.equal(sanitizeHtml('<p>Tom &amp; Jerry</p>'), '<p>Tom &amp; Jerry</p>');
	assert.equal(sanitizeHtml('<p>Tom & Jerry</p>'), '<p>Tom &amp; Jerry</p>');
	assert.equal(sanitizeHtml('<p>5 &lt; 6</p>'), '<p>5 &lt; 6</p>');
});

test('safe anchors keep their href, unsafe ones lose it but keep their text', () => {
	assert.equal(sanitizeHtml('<a href="/who-we-are">Who</a>'), '<a href="/who-we-are">Who</a>');
	// `&b` is not a character reference, so it is escaped on the way out — the
	// browser resolves `&amp;b=2` to the same query string.
	assert.equal(
		sanitizeHtml('<a href="https://gospellife.in/x?a=1&b=2">Site</a>'),
		'<a href="https://gospellife.in/x?a=1&amp;b=2">Site</a>'
	);
	assert.equal(
		sanitizeHtml('<a href="https://gospellife.in/x?a=1&amp;b=2">Site</a>'),
		'<a href="https://gospellife.in/x?a=1&amp;b=2">Site</a>'
	);
	assert.equal(
		sanitizeHtml('<a href="mailto:hi@example.com">Mail</a>'),
		'<a href="mailto:hi@example.com">Mail</a>'
	);
	assert.equal(sanitizeHtml('<a href="#section">Jump</a>'), '<a href="#section">Jump</a>');
	assert.equal(sanitizeHtml('<a href="javascript:alert(1)">Bad</a>'), '<a>Bad</a>');
});

test('the class allowlist keeps known tokens and drops the rest', () => {
	assert.equal(
		sanitizeHtml('<p class="ql-align-center evil">x</p>'),
		'<p class="ql-align-center">x</p>'
	);
	// A site's own class is dropped until the site allows it, then kept.
	assert.equal(sanitizeHtml('<span class="glc-dropcap">W</span>'), '<span>W</span>');
	allowRichTextClasses(['glc-dropcap']);
	assert.equal(
		sanitizeHtml('<span class="glc-dropcap">W</span>'),
		'<span class="glc-dropcap">W</span>'
	);
	assert.equal(sanitizeHtml('<p class="totally-made-up">x</p>'), '<p>x</p>');
});

test('unknown elements are unwrapped and executable ones are dropped whole', () => {
	assert.equal(sanitizeHtml('<table><tr><td>Cell</td></tr></table>'), 'Cell');
	assert.equal(sanitizeHtml('<section><p>Kept</p></section>'), '<p>Kept</p>');
	assert.equal(sanitizeHtml('<style>p{color:red}</style><p>Kept</p>'), '<p>Kept</p>');
	assert.equal(sanitizeHtml('<img src="https://example.com/a.png" alt="a">'), '');
});

test('mis-nesting is closed rather than left dangling', () => {
	assert.equal(sanitizeHtml('<p><strong>bold</p>'), '<p><strong>bold</strong></p>');
	assert.equal(sanitizeHtml('<em>a<strong>b</em>c</strong>'), '<em>a<strong>b</strong></em>c');
	assert.equal(sanitizeHtml('<p>open'), '<p>open</p>');
});

test('non-string and wrapped rich-text values reduce to a string', () => {
	assert.equal(sanitizeRichText(null), '');
	assert.equal(sanitizeRichText(undefined), '');
	assert.equal(sanitizeRichText(42), '');
	assert.equal(
		sanitizeRichText({ editor: 'quilljs', html: '<p>Hi</p>', content: {} }),
		'<p>Hi</p>'
	);
	assert.equal(
		sanitizeRichText({ editor: 'quilljs', html: '<script>x</script>', content: {} }),
		''
	);
	assert.equal(sanitizeRichText('<p>Hi</p>'), '<p>Hi</p>');
});

test('isSafeUrl judges what a browser would navigate to', () => {
	for (const safe of [
		'/about',
		'#anchor',
		'./relative',
		'../up',
		'https://example.com',
		'HTTP://EXAMPLE.COM',
		'mailto:a@b.c',
		'tel:+91-99999-99999',
		'//cdn.example.com/x.png'
	]) {
		assert.ok(isSafeUrl(safe), `${safe} should be safe`);
	}
	for (const unsafe of [
		'javascript:alert(1)',
		'JaVaScRiPt:alert(1)',
		' javascript:alert(1)',
		'java\tscript:alert(1)',
		'java​script:alert(1)',
		'javascript&#58;alert(1)',
		'javascript&colon;alert(1)',
		'data:text/html,<script>alert(1)</script>',
		'vbscript:msgbox(1)',
		'file:///etc/passwd',
		'\\\\evil.example\\share',
		''
	]) {
		assert.ok(!isSafeUrl(unsafe), `${unsafe} should be refused`);
	}
});

test('plain text extraction cannot resurrect a dropped payload', () => {
	assert.equal(plainTextForAttribute('<p>Hello <strong>world</strong></p>'), 'Hello world');
	assert.equal(plainTextForAttribute('<script>alert(1)</script><p>Hi</p>'), 'Hi');
	assert.equal(plainTextForAttribute({ html: '<p>a&nbsp;b</p>' }), 'a b');
});

test('plainTextForAttribute leaves angle brackets escaped so it can never build a tag', () => {
	// Sanitized prose keeps a literal `<`/`>` as `&lt;`/`&gt;`. Decoding those
	// back here would let the function reassemble markup out of escaped text, so
	// they must survive escaped even after tags are stripped.
	assert.equal(plainTextForAttribute('<p>5 &lt; 6 &gt; 4</p>'), '5 &lt; 6 &gt; 4');
	// A would-be tag that arrives already escaped stays inert text, not a tag.
	assert.equal(
		plainTextForAttribute('<p>&lt;img src=x onerror=alert(1)&gt;</p>'),
		'&lt;img src=x onerror=alert(1)&gt;'
	);
	// Quotes and ampersands are still decoded — fine for a framework-escaped
	// attribute value, which is the only sink this feeds.
	assert.equal(plainTextForAttribute('<p>Tom &amp; &quot;Jerry&quot;</p>'), 'Tom & "Jerry"');
});

test('a payload cannot survive a round trip through plain text and back', () => {
	for (const entry of XSS_PAYLOADS) {
		const text = plainTextForAttribute(entry.payload);
		const output = sanitizeHtml(text).toLowerCase();
		for (const forbidden of FORBIDDEN_SUBSTRINGS) {
			assert.ok(!output.includes(forbidden), `${entry.name}: round trip re-created ${forbidden}`);
		}
	}
});

test('the escape grammar and the decode grammar recognise the same references', () => {
	// The load-bearing coupling: CHARACTER_REFERENCE (escape) writes a reference
	// through live — `&…;` the browser will decode — while decodeReferences
	// (decode) is what the URL judge resolves it to. If the escape side preserves
	// a reference the decode side never sees, a URL can smuggle a live reference
	// (`javascript&colon;…`) past the judge. So the two must recognise the same
	// forms. We probe the escape grammar through its consumer (a lone reference is
	// preserved iff CHARACTER_REFERENCE matched it) and the decode grammar
	// directly.
	const preserved = (/** @type {string} */ token) => sanitizeHtml(token) === token;
	const decoded = (/** @type {string} */ token) => decodeReferences(token) !== token;

	// Every reference form the code handles: numeric dec/hex inside the digit
	// window (valid code points, including each ceiling) plus the vendored named
	// set. Each must be both preserved by the escape grammar and decoded by the
	// judge — symmetry in both directions.
	const handled = [
		'&#58;', // colon, decimal
		'&#160;', // nbsp, decimal
		'&#1114111;', // U+10FFFF — the 7-decimal-digit ceiling
		'&#x3a;', // colon, hex
		'&#xa0;', // nbsp, hex
		'&#x10FFFF;', // U+10FFFF — the 6-hex-digit ceiling
		'&amp;',
		'&apos;',
		'&colon;',
		'&gt;',
		'&lt;',
		'&newline;',
		'&quot;',
		'&sol;',
		'&tab;'
	];
	for (const token of handled) {
		assert.ok(preserved(token), `escape grammar should preserve ${token}`);
		assert.ok(decoded(token), `decode grammar should decode ${token}`);
	}

	// One digit past each window: neither grammar may recognise it. Widen one
	// regex without the other and exactly one of these flips, failing the test.
	for (const token of ['&#12345678;', '&#x1234567;']) {
		assert.ok(!preserved(token), `escape grammar should not preserve ${token}`);
		assert.ok(!decoded(token), `decode grammar should not decode ${token}`);
	}

	// The escape grammar's one intentional superset: a well-formed *named*
	// reference outside the vendored set is preserved but not decoded. Safe,
	// because a browser will not resolve `&notareal;` either, and every named
	// reference that matters to a URL (colon, tab, newline, sol) is in the set
	// above and therefore symmetric.
	assert.ok(preserved('&notareal;'));
	assert.ok(!decoded('&notareal;'));
});

test('every `<` in sanitized output opens a tag from the allowlist grammar', () => {
	// The strongest cheap, dependency-free invariant: the output is *generated*,
	// so any raw `<` in it can only be a tag this module chose to emit — an
	// allowed tag name, optionally with class/href/title attributes whose quoted
	// values carry no `"`, `<` or `>`. (The alternation restates ALLOWED_TAGS; a
	// tag added there must be added here too, which is a feature: the assertion
	// only ever loosens deliberately.)
	const TAG =
		/^<\/?(?:a|b|blockquote|br|code|div|em|h[2-6]|hr|i|li|ol|p|pre|s|span|strike|strong|sub|sup|u|ul)(?: (?:class|href|title)="[^"<>]*")*>$/u;
	const samples = [
		...XSS_PAYLOADS.map((entry) => entry.payload),
		'<p class="ql-align-center">centred</p>',
		'<a href="https://gospellife.in/x?a=1&b=2" title="Go">link</a>',
		'<blockquote><p>quote</p></blockquote>',
		'<ul><li>one</li><li>two</li></ul>',
		'<span class="glc-dropcap">W</span>hoever'
	];
	for (const sample of samples) {
		const out = sanitizeHtml(sample);
		const tags = out.match(/<[^>]*>/gu) ?? [];
		for (const tag of tags) {
			assert.match(tag, TAG, `emitted \`${tag}\` outside the tag grammar for: ${sample}`);
		}
		// And no raw `<` exists that is not the opening of one of those tags.
		assert.equal(
			(out.match(/</gu) ?? []).length,
			tags.length,
			`a raw < escaped the tag grammar for: ${sample}`
		);
	}
});

// ── the blog paragraph sink (`Paragraph.svelte`, the pre-existing stored-XSS) ──
//
// `renderParagraphHtml` is the render half of Finding 3: the blog body is
// CMS-authored HTML rendered through `{@html}`, and its `[[link:href|text]]`
// shorthand used to expand into an anchor with no scheme check and no escaping.
// These assert that a payload — in a `[[link]]` OR in the raw body — is inert,
// while a legitimate link and ordinary formatting still render.

test('a legitimate [[link]] still produces a working, styled anchor', () => {
	const out = renderParagraphHtml('Read our [[link:/about|About]] page.');
	assert.match(out, /<a href="\/about"[^>]*>About<\/a>/u);
	assert.ok(out.includes('target="_blank"'), `lost target=_blank — ${out}`);
	assert.ok(out.includes('rel="noopener noreferrer"'), `lost rel — ${out}`);
	assert.ok(
		out.includes('class="link-text text-stone-700 underline body-serif"'),
		`lost the link styling — ${out}`
	);
});

test('a javascript: URL in a [[link]] renders inert, keeping the text', () => {
	const out = renderParagraphHtml('Click [[link:javascript:alert(1)|here]] now.');
	assert.ok(!out.includes('<a'), `emitted an anchor for an unsafe scheme — ${out}`);
	assert.ok(!out.toLowerCase().includes('javascript:'), `leaked the scheme — ${out}`);
	assert.ok(out.includes('here'), `dropped the link text — ${out}`);
	// obfuscated form is caught the same way (isSafeUrl decodes references first).
	const obf = renderParagraphHtml('[[link:java&#115;cript:alert(1)|x]]');
	assert.ok(!obf.includes('<a'), `emitted an anchor for an obfuscated scheme — ${obf}`);
});

test('an attribute-breakout in a [[link]] href cannot escape the attribute', () => {
	const out = renderParagraphHtml('[[link:/x" onmouseover="alert(1)|hit]]');
	// A raw quote in the href is a breakout attempt: no anchor is emitted at all,
	// so nothing — not even escaped — carries the handler; the text survives.
	assert.ok(!out.includes('<a'), `emitted an anchor for a breakout href — ${out}`);
	assert.ok(!EVENT_HANDLER_PATTERN.test(out), `an event handler survived — ${out}`);
	assert.ok(!out.toLowerCase().includes('onmouseover'), `leaked the handler name — ${out}`);
	assert.ok(out.includes('hit'), `dropped the link text — ${out}`);
});

test('raw body markup is sanitized to the allowlist before it is rendered', () => {
	// script drops with its content.
	assert.equal(renderParagraphHtml('<script>alert(1)</script>Hello'), 'Hello');
	// an unknown element with an event handler is unwrapped; the handler is gone.
	const img = renderParagraphHtml('<img src=x onerror=alert(1)>Body');
	assert.ok(!EVENT_HANDLER_PATTERN.test(img), `an event handler survived — ${img}`);
	assert.ok(!img.toLowerCase().includes('onerror'), `leaked onerror — ${img}`);
	assert.ok(img.includes('Body'), `lost the body text — ${img}`);
	// a raw anchor with a javascript: href keeps the text, loses the href.
	const anchor = renderParagraphHtml('<a href="javascript:alert(1)">link</a>');
	assert.ok(!anchor.toLowerCase().includes('javascript:'), `leaked the scheme — ${anchor}`);
	assert.ok(anchor.includes('link'), `lost the anchor text — ${anchor}`);
});

test('ordinary blog formatting renders unchanged, including across a [[link]]', () => {
	assert.equal(
		renderParagraphHtml('<strong>Bold</strong> and <em>italic</em>.'),
		'<strong>Bold</strong> and <em>italic</em>.'
	);
	// a link inside formatting keeps the surrounding tags intact (no early close).
	const out = renderParagraphHtml('<strong>See [[link:/a|here]]</strong>.');
	assert.match(out, /^<strong>See <a href="\/a"[^>]*>here<\/a><\/strong>\.$/u);
});

test('the paragraph sink is total over odd input and keeps its output inert', () => {
	assert.equal(renderParagraphHtml(null), '');
	assert.equal(renderParagraphHtml(undefined), '');
	assert.equal(renderParagraphHtml(42), '');
	// It runs once on the RAW body and is deliberately not idempotent — the anchor
	// it emits carries a `target`/`class` the sanitizer allowlist would strip on a
	// second pass, which is exactly why we sanitize first and expand second. What
	// must hold across the whole corpus is that the OUTPUT is inert.
	for (const entry of XSS_PAYLOADS) {
		const output = renderParagraphHtml(entry.payload).toLowerCase();
		for (const forbidden of FORBIDDEN_SUBSTRINGS) {
			assert.ok(!output.includes(forbidden), `${entry.name}: sink emitted ${forbidden}`);
		}
		assert.ok(
			!EVENT_HANDLER_PATTERN.test(output),
			`${entry.name}: sink emitted an event handler — ${output}`
		);
	}
});
