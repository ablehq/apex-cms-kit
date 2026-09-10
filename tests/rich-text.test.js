// @ts-nocheck — node:test suite over the admin's dynamic field-value shapes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { plainToRichText, richTextHtml } from '../src/admin/rich-text.js';

/**
 * P5a: RICH TEXT THAT PRESERVES WHAT IS STORED.
 *
 * `plainToRichText` used to return `{editor: 'tiptap', html, content: {}}`
 * unconditionally, and it is called on every keystroke of every rich-text control on
 * every site on this kit. So editing ANY field on a Godrej record rewrote a
 * populated Quill delta to `{}` and relabelled the value `tiptap`. That is a LIVE
 * DEFECT, not a hypothetical — Godrej's stored values really are quilljs with
 * populated deltas, and its editors are still using Apex's own CMS UI on the same
 * records, which reads `content`.
 *
 * The five shapes below are measured, not invented:
 *
 *   1. `{editor: null, html, content}` — every Poovayya archetype primitive;
 *   2. `{editor: 'quilljs', html, content: {ops}}` — Poovayya page blocks, Godrej;
 *   3. `{editor: 'tiptap', html, content: {}}` — ONE value on GLC. Not "GLC's page
 *      fields": measured across every archetype schema and entity type on that
 *      tenant, GLC is 19 `quilljs` to this 1, and all 19 carry `content: {}` too;
 *   4. `{editor: 'quilljs', content_html}` — GLC article document blocks;
 *   5. a bare HTML string — both siblings' article editors pass one as `value`.
 */

const QUILL = {
	editor: 'quilljs',
	html: '<p>Stored body</p>',
	content: { ops: [{ insert: 'Stored body\n' }] }
};
const TIPTAP = { editor: 'tiptap', html: '<p>Stored body</p>', content: {} };
const NULL_EDITOR = { editor: null, html: '<p>Stored body</p>', content: { ops: [] } };
const CONTENT_HTML = { editor: 'quilljs', content_html: '<p>Article body</p>' };

describe('richTextHtml reads the html KEY, and refuses the shape it cannot read', () => {
	it('reads all three html-bearing objects and a bare string', () => {
		assert.deepEqual(richTextHtml(QUILL), { ok: true, html: '<p>Stored body</p>' });
		assert.deepEqual(richTextHtml(TIPTAP), { ok: true, html: '<p>Stored body</p>' });
		assert.deepEqual(richTextHtml(NULL_EDITOR), { ok: true, html: '<p>Stored body</p>' });
		assert.deepEqual(richTextHtml('<p>bare</p>'), { ok: true, html: '<p>bare</p>' });
		assert.deepEqual(richTextHtml(null), { ok: true, html: '' });
		assert.deepEqual(richTextHtml(undefined), { ok: true, html: '' });
	});

	it('REFUSES a content_html-keyed value rather than answering the empty string', () => {
		/**
		 * GLC's article document blocks (`save-body-article.ts:80`,
		 * `cms/scripts/seed-content.js:414`). The previous reader took `stored.html ??
		 * ''` and answered `''`, which presents a populated article body as an EMPTY
		 * FIELD — and the next keystroke would then store that emptiness. A typed
		 * result rather than a throw, because the caller is a reactive statement
		 * (`$: read = richTextHtml(value)`) and throwing takes the editor down.
		 */
		assert.deepEqual(richTextHtml(CONTENT_HTML), { ok: false, reason: 'content-html' });
	});

	it('an object with BOTH keys is readable — html wins, and nothing is refused', () => {
		// The refusal is for a value with no `html` at all. A block that carries both
		// is not the dangerous case: the key this module writes is present.
		assert.deepEqual(richTextHtml({ ...CONTENT_HTML, html: '<p>x</p>' }), {
			ok: true,
			html: '<p>x</p>'
		});
	});
});

describe('plainToRichText: unchanged HTML comes back BY IDENTITY', () => {
	it('returns the same object for each of the three stored object shapes', () => {
		// Identity, not deep equality: a child PATCH sends the row's WHOLE field map, so
		// a save that touched a different field must not reshape this one.
		assert.equal(plainToRichText('<p>Stored body</p>', QUILL), QUILL);
		assert.equal(plainToRichText('<p>Stored body</p>', TIPTAP), TIPTAP);
		assert.equal(plainToRichText('<p>Stored body</p>', NULL_EDITOR), NULL_EDITOR);
	});

	it('a BARE STRING always comes back as an object — identity cannot apply', () => {
		// Shape 5. Both siblings' article editors pass a bare `html` string as `value`
		// and read `next.html`, so this path must produce a field value, never echo.
		const next = plainToRichText('<p>bare</p>', '<p>bare</p>');
		assert.equal(typeof next, 'object');
		assert.equal(next.html, '<p>bare</p>');
		assert.equal(next.editor, 'tiptap', 'the kit default, unchanged from before the option');
	});

	it('a content_html value is handed straight back, unedited', () => {
		// Refusing to READ it and then overwriting it anyway would be the worst of both.
		assert.equal(plainToRichText('', CONTENT_HTML), CONTENT_HTML);
		assert.equal(plainToRichText('<p>anything</p>', CONTENT_HTML), CONTENT_HTML);
	});
});

describe('plainToRichText: when the HTML MOVES, the editor decides the content dialect', () => {
	it('a quilljs value keeps editor quilljs and gets a populated DELTA', () => {
		// The Godrej repair, at module level. Before this, editing any field on a Godrej
		// record rewrote its body to `{editor: 'tiptap', content: {}}`.
		const next = plainToRichText('<p>New body</p>', QUILL);
		assert.notEqual(next, QUILL, 'the HTML moved, so this is a new value');
		assert.equal(next.editor, 'quilljs');
		assert.equal(next.html, '<p>New body</p>');
		assert.deepEqual(next.content, { ops: [{ insert: 'New body\n' }] });
	});

	it('a tiptap value keeps editor tiptap and NEVER receives a Quill delta', () => {
		// The mirror-image error: `{ops: […]}` in a field whose `content` is a
		// ProseMirror document. GLC's page fields are this shape.
		const next = plainToRichText('<p>New body</p>', TIPTAP);
		assert.equal(next.editor, 'tiptap');
		assert.equal(next.html, '<p>New body</p>');
		assert.deepEqual(next.content, {});
		assert.ok(!('ops' in next.content), 'a Quill delta must never reach a tiptap field');
	});

	it('a null editor takes the SITE default, from the option and not a constant', () => {
		// Poovayya's twelve team members are stored `editor: null`. The right default
		// differs per site, so a constant here would be wrong for two of the three.
		assert.equal(plainToRichText('<p>New</p>', NULL_EDITOR).editor, 'tiptap');
		assert.equal(
			plainToRichText('<p>New</p>', NULL_EDITOR, { defaultEditor: 'quilljs' }).editor,
			'quilljs'
		);
		assert.deepEqual(
			plainToRichText('<p>New</p>', NULL_EDITOR, { defaultEditor: 'quilljs' }).content,
			{ ops: [{ insert: 'New\n' }] },
			'and the dialect follows the editor it just chose'
		);
	});

	it('a STORED editor beats the site default — a quilljs field stays quilljs', () => {
		assert.equal(
			plainToRichText('<p>New</p>', QUILL, { defaultEditor: 'tiptap' }).editor,
			'quilljs'
		);
		assert.equal(
			plainToRichText('<p>New</p>', TIPTAP, { defaultEditor: 'quilljs' }).editor,
			'tiptap'
		);
	});

	it('with no previous value at all, the option still decides', () => {
		assert.equal(plainToRichText('<p>New</p>').editor, 'tiptap');
		assert.equal(
			plainToRichText('<p>New</p>', null, { defaultEditor: 'quilljs' }).editor,
			'quilljs'
		);
	});

	it('plain text is wrapped in paragraphs; existing markup is passed through', () => {
		assert.equal(plainToRichText('one\n\ntwo').html, '<p>one</p><p>two</p>');
		assert.equal(plainToRichText('<h2>kept</h2>').html, '<h2>kept</h2>');
		assert.deepEqual(plainToRichText('', null, { defaultEditor: 'quilljs' }), {
			editor: 'quilljs',
			html: '',
			content: { ops: [] }
		});
	});
});
