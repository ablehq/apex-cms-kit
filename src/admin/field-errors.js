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
