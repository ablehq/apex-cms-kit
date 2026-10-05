// @ts-nocheck — legacy-mode admin browser module, beside `ui/RichTextField.svelte`.
// Its behavior is covered by tests/rich-text-bar.test.js.
//
// ── WHAT THE B / I / H2 / LIST BAR KNOWS ABOUT THE CARET ───────────────────
// The bar used to know nothing, which showed in two ways (Isaac on Poovayya's
// article editor, 2026-10-05):
//
//   1. H2 was a one-way door. The button ran `formatBlock '<h2>'` whatever the
//      caret was in, so a paragraph made a heading could never be made a paragraph
//      again; the way back was to delete the heading and type it again.
//   2. No button ever showed pressed. With the caret in a heading, H2 looked the
//      same as in a paragraph, so nothing said what pressing it would do.
//
// So the bar reads where the caret is. B, I and List are toggles in the browser
// already (`execCommand` undoes them when the selection has them) and only needed
// showing; H2 is not — `formatBlock` sets a block, it does not toggle one — so the
// H2 button now decides: a heading goes back to a paragraph, anything else becomes
// a heading.
//
// B and I are read with `queryCommandState`, the same state `execCommand` decides
// its own toggle by, so a pressed B is exactly a B that will un-bold. The heading
// and the list are read off the DOM, at BOTH ends of the selection: a selection
// that starts in a heading and ends in a paragraph is not "in a heading", and
// pressing H2 makes all of it one.

/** The bar with nothing pressed: the caret is in no surface of this field. */
export const BAR_IDLE = Object.freeze({ bold: false, italic: false, heading: false, list: false });

/**
 * Whether `node` is `root` or inside it. Walked by `parentNode` rather than
 * `root.contains`, so the tests can drive it with plain objects.
 * @param {Node | null} node
 * @param {Node} root
 */
function within(node, root) {
	for (let at = node; at; at = at.parentNode) {
		if (at === root) return true;
	}
	return false;
}

/**
 * The nearest element called `tag` at or above `node`, stopping at `root` — so
 * nothing outside the field's surface can count as the field's formatting.
 * @param {Node | null} node
 * @param {Node} root the editable surface
 * @param {string} tag an upper-case `nodeName`, e.g. `'H2'`
 */
export function closestWithin(node, root, tag) {
	for (let at = node; at && at !== root; at = at.parentNode) {
		if (at.nodeName === tag) return at;
	}
	return null;
}

/**
 * Which of the bar's toggles the selection already has.
 * @param {{ anchorNode: Node | null, focusNode: Node | null } | null} selection
 *   `document.getSelection()`
 * @param {Node} root the editable surface
 * @param {(command: string) => boolean} commandState `document.queryCommandState`,
 *   asked only when the selection is in `root`
 * @returns {{ bold: boolean, italic: boolean, heading: boolean, list: boolean }}
 */
export function barState(selection, root, commandState) {
	const anchor = selection?.anchorNode ?? null;
	const focus = selection?.focusNode ?? null;
	if (!within(anchor, root) || !within(focus, root)) return BAR_IDLE;
	const inBoth = (/** @type {string} */ tag) =>
		closestWithin(anchor, root, tag) !== null && closestWithin(focus, root, tag) !== null;
	return {
		bold: commandState('bold') === true,
		italic: commandState('italic') === true,
		heading: inBoth('H2'),
		list: inBoth('UL')
	};
}

/**
 * What the H2 button applies with `formatBlock`: a heading goes back to a
 * paragraph, anything else becomes a heading.
 * @param {boolean} inHeading `barState(…).heading`
 */
export function headingBlock(inHeading) {
	return inHeading ? '<p>' : '<h2>';
}
