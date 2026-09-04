// @ts-nocheck — legacy-mode admin browser module (plan §8, 3a compile-mode (a)).
// Deliberately untyped JS to sit beside the legacy-compiled admin components; its
// behavior is covered by tests/admin-save-page.test.js + tests/bff-realapex.test.js.
// Rich-text value handling for the admin field editor.
//
// GLC's `validator_kind: rich_text` fields store the tiptap-shaped object Apex
// expects — `{ editor, html, content }` — the same shape the public renderer reads.
// The plan (02 §3, constraint 4) wants church staff to get a real rich-text editor
// rather than a raw-HTML textarea; a full Quill/tiptap integration is deferred to
// bring-up (it needs the `quill` dependency + the legacy/runes snippet hybrid the
// plan flags). For 3a.2 the control is a plain-text field that produces valid
// paragraph HTML on the way in — honest, dependency-free, and it never corrupts
// existing HTML (which it passes through).

const HTML_TAG = /<\/?[a-z][^>]*>/iu;

/**
 * Wrap edited plain text back into paragraph HTML, preserving pre-existing markup.
 *
 * @param {unknown} text
 * @returns {import('./types').RichTextValue}
 */
export function plainToRichText(text) {
	const raw = `${text ?? ''}`;
	const html = HTML_TAG.test(raw)
		? raw
		: raw
				.split('\n')
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
				.map((line) => `<p>${line}</p>`)
				.join('');
	return { editor: 'tiptap', html, content: {} };
}
