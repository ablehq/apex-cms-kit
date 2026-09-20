// @ts-check
/**
 * Apex's field errors, as the BFF forwards them on a 422:
 * `{ code: 'invalid', errors: [{ attribute, messages }] }`.
 *
 * ONE reading of that shape, shared by every screen that shows it (the post
 * editor through `savePost`, a site's page-create form, …) so the wording
 * cannot drift between them. Apex's messages are FULL sentences already
 * ("Published date is invalid"), so they are shown as they are; the attribute
 * name is the fallback only for an error that carries no message at all.
 *
 * The caller supplies the sentence AROUND the list — what was and was not
 * saved, what to do next — because that differs per screen; what does not
 * differ is the list itself and the wording for the case where Apex rejected
 * the write but named no field.
 */

/** The shared wording for a 422 whose `errors` name nothing. */
export const NO_FIELD_NAMED = 'A field was rejected, but Apex did not say which.';

/**
 * The shared wording for a `400 reserved-slug` — the ONE refusal two different
 * screens can now produce for the same reason, so it lives here with the rest of
 * the shared wording rather than in either of them.
 *
 * It was written for the page-create form (`pageCreateError`, and Poovayya's
 * `createError`, which say this sentence today) and it is what the structure save
 * says as well (`save-page.js`), because an editor who renames a page in Details
 * and one who types the address into the create dialog have hit the same rule and
 * need the same next step. The alternative was the structure save's generic
 * "Saving the page layout failed. Save again to retry." — a sentence about the
 * layout, naming neither the slug nor the address, telling the editor to repeat
 * an action that can never succeed.
 */
export const RESERVED_SLUG_MESSAGE =
	'That address is a route the site generates, not a page. Choose a different one.';

/**
 * The shared wording for a `400 invalid-slug` — the OTHER address refusal the
 * structure save can produce, and it needs its own sentence because the fix is
 * the opposite one: `RESERVED_SLUG_MESSAGE` says "choose a different address",
 * which is no help at all to an editor who has cleared the field and has no
 * address to choose differently from.
 *
 * Clearing the Slug field is ordinary editor behaviour — none of the three sites
 * marks that input `required` — and until `save-page-structure.ts` named it, the
 * answer was a schema `400 invalid body`, which this module's caller could only
 * report as "Saving the page layout failed. Save again to retry.": a sentence
 * about the layout, for a failure of the address, advising a retry that is
 * guaranteed to fail forever. It names the field and gives a next step that can
 * actually succeed.
 */
export const BLANK_SLUG_MESSAGE =
	'A page needs an address. Type a slug (for example "about-us") and Save again.';

/**
 * The messages, one string per rejected attribute, in Apex's order. Empty when
 * the body carries no usable errors.
 * @param {any} res
 * @returns {string[]}
 */
export function fieldErrorMessages(res) {
	const errors = Array.isArray(res?.errors) ? res.errors : [];
	return errors
		.map((/** @type {any} */ e) => {
			const messages = Array.isArray(e?.messages)
				? e.messages.filter((/** @type {unknown} */ m) => typeof m === 'string' && m.trim() !== '')
				: [];
			return messages.length > 0 ? messages.join(', ') : String(e?.attribute ?? '').trim();
		})
		.filter(Boolean);
}

/**
 * The sentence that names what was rejected: "A field was rejected: Published
 * date is invalid; summary." — or `NO_FIELD_NAMED` when nothing was named.
 * @param {any} res
 */
export function rejectedFieldsSentence(res) {
	const messages = fieldErrorMessages(res);
	return messages.length > 0 ? `A field was rejected: ${messages.join('; ')}.` : NO_FIELD_NAMED;
}
