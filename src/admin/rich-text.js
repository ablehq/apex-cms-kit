// @ts-nocheck — legacy-mode admin browser module (plan §8, 3a compile-mode (a)).
// Deliberately untyped JS to sit beside the legacy-compiled admin components; its
// behavior is covered by tests/rich-text.test.js, tests/admin-save-page.test.js and
// tests/bff-realapex.test.js.
//
// ── WHAT A `rich_text` FIELD ACTUALLY HOLDS, ON THE THREE SITES ─────────────
// `{ editor, html, content }`, and the parts vary more than the shape:
//
//   1. `{editor: null, html, content}` — every Poovayya archetype primitive
//      (all twelve `team_member` records);
//   2. `{editor: 'quilljs', html, content: {ops: [...]}}` — Poovayya's page-block
//      entities and Godrej's post bodies, where `content` is a QUILL DELTA;
//   3. `{editor: 'tiptap', html, content: {}}` — GLC's page fields
//      (`cms/scripts/page-authoring.js:64`), where `content` is a ProseMirror doc;
//   4. `{editor: 'quilljs', content_html: '…'}` with NO `html` and NO `content` —
//      GLC's article document blocks (`save-body-article.ts:80`,
//      `cms/scripts/seed-content.js:414`);
//   5. a bare HTML string, from a plain-text field rendered as markup.
//
// ── THE DEFECT THIS MODULE WAS REWRITTEN TO FIX ────────────────────────────
// `plainToRichText` used to return `{editor: 'tiptap', html, content: {}}`
// UNCONDITIONALLY, and it is called on every keystroke of every rich-text control
// on every site. So editing ANY field on a Godrej record rewrote a populated Quill
// delta to `{}` and relabelled the value `tiptap` — a live defect, not a
// hypothetical: Godrej's stored values are shape 2, and its editors are still using
// Apex's own CMS UI on the same records. What that UI does with a value whose
// `editor` flipped and whose `content` was emptied is verified by nobody.
//
// Three rules follow, and each of them is load-bearing:
//
//   A. UNCHANGED HTML RETURNS THE STORED OBJECT BY IDENTITY. The common case is an
//      editor clicking into a field and out again, and a child PATCH sends the
//      row's WHOLE field map rather than the moved key — so without this, saving
//      one field reshapes every other rich-text field on the row.
//   B. A NON-EMPTY STORED `editor` SURVIVES. A quilljs field stays a quilljs field.
//      Only a null/absent one takes the site's default, which is a PROP rather than
//      a constant, because the right default differs per site (GLC: tiptap; Godrej
//      and Poovayya: quilljs).
//   C. REGENERATED `content` BRANCHES ON THE EDITOR. A Quill delta for `quilljs`,
//      `{}` for `tiptap`. Emitting `{ops: […]}` into a tiptap field would write a
//      Quill document where a ProseMirror one belongs — the mirror image of the bug
//      being fixed. A preserved `content` is not an option either: it would then
//      disagree with the new `html`, and Apex's CMS UI shows `content`.
//
// Shape 4 gets a rule of its own: `richTextHtml` REFUSES it rather than reading
// `''` off a missing `html` key. Returning `''` would make an edit look like a
// deletion, and a write-back would wipe a GLC article body.
//
// ── THE SECOND DEFECT, FIXED THE SAME WAY ──────────────────────────────────
// Regenerating `content` for a `quilljs` field used to build the delta from
// `richTextPlainText()` — MARKUP STRIPPED — so the whole document became ONE
// UNATTRIBUTED INSERT. That is not cosmetic, because Apex's own CMS UI LOADS ITS
// EDITOR FROM `content`, NOT FROM `html`
// (`apex-cms-template/.../RichTextArchetypeSchemaItem.svelte:47-48`,
// `quill.setContents(parsedValue.content)`), and writes both back at `:59-62`. So
// a heading or a bold run entered here vanished the moment the record was opened
// in the CMS, and that UI's next save wrote the loss into `html` too.
//
// `htmlToDelta` (`./html-to-delta.js`) is the repair: a real HTML→Delta
// conversion over the union of what BOTH toolbars can produce, measured against
// the Quill version the CMS pins. Rule C below is unchanged — the dialect still
// branches on the editor name; what changed is that the quilljs branch now
// produces a faithful delta instead of a flattened one.

import { htmlToDelta } from './html-to-delta.js';

const HTML_TAG = /<\/?[a-z][^>]*>/iu;

/** The editor written when a value has none and the site named no default. */
const FALLBACK_EDITOR = 'tiptap';

/**
 * Narrow a field value to a stored rich-text OBJECT, or null for a string/absent.
 *
 * The value comes out of a block entity's or a record's `fields_data` — Apex-
 * validated JSON this module does not get to choose the shape of — so the narrowing
 * happens once, here, rather than at each place below that would otherwise guess.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asRichText(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	return value;
}

/**
 * Is this a value whose HTML lives under a key this module does not write?
 *
 * Shape 4 — `{editor, content_html}`, GLC's article document blocks. It reaches this
 * module only if something mounts a `RichTextField` over a block value, which
 * nothing does today (`get-article.ts:267` flattens to `html` on the way out and
 * `save-body-article.ts:80` rebuilds `content_html` server-side). Refusing is what
 * keeps that true by construction rather than by nobody having tried.
 *
 * @param {unknown} value
 */
function isUnreadableShape(value) {
	const stored = asRichText(value);
	if (!stored) return false;
	return !('html' in stored) && 'content_html' in stored;
}

/**
 * The `html` of a stored rich-text value, as a TYPED result.
 *
 * `{ok: true, html}` or `{ok: false, reason: 'content-html'}`. A result rather than
 * a bare string because the failure has to be visible: this runs inside a reactive
 * statement (`$: incoming = richTextHtml(value)`), so throwing would take the editor
 * down, and returning `''` — which is what the previous version did — would present
 * a populated field as empty and let the next keystroke store that emptiness.
 *
 * Reads the `html` KEY ONLY. A bare string is its own html.
 *
 * @param {unknown} value
 * @returns {{ok: true, html: string} | {ok: false, reason: string}}
 */
export function richTextHtml(value) {
	if (isUnreadableShape(value)) return { ok: false, reason: 'content-html' };
	const stored = asRichText(value);
	if (stored) return { ok: true, html: `${stored.html ?? ''}` };
	return { ok: true, html: `${value ?? ''}` };
}

/**
 * Editable plain text from a stored rich-text value (or a bare string).
 *
 * It USED to be what built the Quill delta below, which is why it is exported
 * under a name of its own rather than inlined — and why that delta carried no
 * formatting. `htmlToDelta` took that job; this is now the plain-text READING of a
 * stored value, kept exported because the package's export map is a total wildcard
 * over `src/`, so removing it is a breaking change for a function nothing is
 * broken by. NOT called `richTextToPlainText`: that name was renamed away in
 * `sanitize/html.js` to `plainTextForAttribute`, which carries a "SAFE SINK ONLY —
 * must NEVER feed `{@html}`" warning, and reusing it here for a different contract
 * is how two functions end up confused for one.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function richTextPlainText(value) {
	const read = richTextHtml(value);
	const html = read.ok ? read.html : '';
	if (!html) return '';
	if (!HTML_TAG.test(html)) return html;
	return html
		.replace(/<\/(?:p|div|li|h[1-6])>/giu, '\n')
		.replace(/<br\s*\/?>/giu, '\n')
		.replace(/<[^>]+>/gu, '')
		.replace(/&nbsp;/giu, ' ')
		.replace(/&amp;/giu, '&')
		.replace(/&lt;/giu, '<')
		.replace(/&gt;/giu, '>')
		.replace(/\n{3,}/gu, '\n\n')
		.trim();
}

/**
 * Wrap edited HTML (or plain text) back into a stored rich-text value.
 *
 * @param {unknown} text the control's output — HTML from the contenteditable, or
 *   plain text, which is wrapped in paragraphs.
 * @param {unknown} [previous] the value this field held before the edit. When the
 *   HTML has not moved and `previous` is an OBJECT, THIS IS RETURNED UNCHANGED —
 *   same identity, same `editor`, same `content` — so a save cannot reshape a field
 *   nobody edited. Identity cannot apply to shape 5: a bare string always comes back
 *   as an object, because that is what the field has to store.
 * @param {{defaultEditor?: string}} [options] the editor name written when the
 *   stored value names none. Per SITE, not per kit: GLC's fields are tiptap and
 *   Poovayya's and Godrej's are quilljs, and a constant here would be wrong for two
 *   of the three. Defaults to `'tiptap'`, which is what this module did before the
 *   option existed, so a site that passes nothing is unchanged.
 * @returns {import('./types').RichTextValue}
 */
export function plainToRichText(text, previous, options = {}) {
	const stored = asRichText(previous);
	const raw = `${text ?? ''}`;
	const html = HTML_TAG.test(raw)
		? raw
		: raw
				.split('\n')
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
				.map((line) => `<p>${line}</p>`)
				.join('');

	// A value whose HTML this module cannot read is handed straight back. Overwriting
	// it would replace a GLC article body with whatever a control that could not
	// display it produced — which is `''`.
	if (isUnreadableShape(previous)) return previous;

	// Unchanged HTML: hand back exactly what was stored, by identity. This is the case
	// that keeps Apex's own CMS UI able to reopen the field, and it is the common one.
	if (stored && `${stored.html ?? ''}` === html) return previous;

	// The HTML genuinely moved.
	const editor =
		stored && typeof stored.editor === 'string' && stored.editor
			? stored.editor
			: (options.defaultEditor ?? FALLBACK_EDITOR);

	// `content` is regenerated to agree with the new `html`, in the DIALECT the
	// editor name declares. A Quill delta into a tiptap field would be a ProseMirror
	// document's slot holding a Quill one — the same class of error as the rewrite
	// this module exists to stop, pointing the other way.
	//
	// The delta is built from the MARKUP, not from the flattened text. It is the
	// only copy of the value Apex's CMS UI reads, so a plain-text delta beside a
	// formatted `html` is a silent one-way loss the moment anyone opens the record
	// there.
	const content = editor === 'quilljs' ? htmlToDelta(html) : {};
	return { editor, html, content };
}
