import { md5Base64 } from './md5.js';
import { declaredContentType, refusalMessage, refuseUpload } from './media-types.js';

/**
 * The browser half of a media upload, in one place so both sites' library screens
 * and the picker run the SAME three legs in the same order.
 *
 *   sign      → the BFF checks type and size and mints a storage URL. It creates
 *               NOTHING upstream: no gallery item, no caption.
 *   PUT       → the bytes go straight to that URL. It is storage, not Apex, and it
 *               carries no Apex credential — this is the only request in the admin
 *               that does not go to our own origin.
 *   finalize  → the BFF creates the gallery item AND attaches the medium, in one
 *               server-side operation.
 *
 * ── WHY THERE IS NO ROLLBACK HERE ─────────────────────────────────────────────
 * Because there is nothing to roll back. The gallery item is created at FINALIZE,
 * after the bytes are already stored, so every way this function can fail — a
 * refused type, a dead network, a 422 from storage, a browser tab closed mid-PUT —
 * leaves no gallery item behind. "A caption attached to no picture" is not handled;
 * it is unreachable. The earlier design created the item first and needed a
 * compensating delete that the browser could not always perform (a sign-leg failure
 * answered without the id), which is exactly why the order changed.
 *
 * What is NOT repaired, and is not repairable from here: signing mints an
 * `ActiveStorage::Blob` immediately, so a failed or abandoned PUT strands bytes that
 * no platform API can reach. That is upstream debt in `ellipsis-backend` (a periodic
 * purge with an age threshold); it is named, not silently inherited.
 *
 * @typedef {'no-such-gallery' | 'type-not-allowed' | 'empty-file' | 'too-large'
 *           | 'sign-failed' | 'store-failed' | 'finalize-failed'} UploadFailure
 * @typedef {'preparing' | 'uploading' | 'saving'} UploadPhase
 *
 * @param {import('./types').BffClient} client
 * @param {{
 *   gallery: string,
 *   file: File,
 *   title?: string,
 *   alt?: string,
 *   onPhase?: (phase: UploadPhase) => void
 * }} options
 * @returns {Promise<{ ok: true, galleryItemId: string }
 *                 | { ok: false, reason: UploadFailure, message: string }>}
 */
export async function uploadMedia(client, { gallery, file, title = '', alt = '', onPhase }) {
	const contentType = declaredContentType(file);

	// BEFORE anything is signed, so a refusal costs no upstream call and no upload.
	// The server checks the same two things with the same function; this one exists
	// to make the refusal instant, not to be the guarantee.
	const refusal = refuseUpload(gallery, contentType, file.size);
	if (refusal) return { ok: false, reason: refusal, message: refusalMessage(gallery, refusal) };

	// Hashing 25 MiB on the main thread takes roughly half a second, which looks like
	// a dead button unless the caller can say "Preparing…" first.
	report(onPhase, 'preparing');
	let signed;
	try {
		const bytes = new Uint8Array(await file.arrayBuffer());
		signed = await client.signMediaUpload({
			gallery,
			file: {
				byte_size: file.size,
				content_type: contentType,
				filename: file.name,
				checksum: md5Base64(bytes)
			}
		});
	} catch (error) {
		return failure('sign-failed', error, 'The upload could not be started.');
	}
	if (!signed?.ok || !signed.uploadUrl || !signed.signedId) {
		return failure('sign-failed', signed, 'The upload could not be started.');
	}

	report(onPhase, 'uploading');
	let put;
	try {
		// `signed.uploadHeaders` are storage's own — Content-Type, Content-MD5 and
		// whatever else it asked for. They are sent back verbatim; storage verifies
		// the MD5 and answers 422 if the bytes do not match what was declared.
		put = await fetch(signed.uploadUrl, {
			method: 'PUT',
			headers: signed.uploadHeaders || {},
			body: file
		});
	} catch (error) {
		return failure('store-failed', error, 'The file could not be stored.');
	}
	if (!put.ok) {
		return { ok: false, reason: 'store-failed', message: 'The file could not be stored.' };
	}

	report(onPhase, 'saving');
	let finalized;
	try {
		finalized = await client.finalizeMediaUpload({
			gallery,
			signedId: signed.signedId,
			title,
			alt
		});
	} catch (error) {
		return failure('finalize-failed', error, 'The upload did not finish.');
	}
	if (!finalized?.ok || !finalized.galleryItemId) {
		return failure('finalize-failed', finalized, 'The upload did not finish.');
	}

	return { ok: true, galleryItemId: finalized.galleryItemId };
}

/**
 * @param {((phase: UploadPhase) => void) | undefined} onPhase
 * @param {UploadPhase} phase
 */
function report(onPhase, phase) {
	if (typeof onPhase === 'function') onPhase(phase);
}

/**
 * A failed leg, preferring what the server actually said. The BFF passes Apex's own
 * message through (`operations/media.ts`), so "Content type image/avif is not a valid
 * kind" reaches the editor instead of a generic apology — which is the whole point of
 * surfacing it. `fallback` covers a thrown fetch, which has no server message at all.
 *
 * `source` is `unknown` because it really is: this is handed either a BFF response
 * or a caught exception, and the only thing it asks of either is whether it happens
 * to carry a string `error`. Narrowing here rather than at the four call sites.
 *
 * @param {UploadFailure} reason
 * @param {unknown} source
 * @param {string} fallback
 * @returns {{ ok: false, reason: UploadFailure, message: string }}
 */
function failure(reason, source, fallback) {
	const said =
		source && typeof source === 'object' && 'error' in source && typeof source.error === 'string'
			? source.error.trim()
			: '';
	return { ok: false, reason, message: said || fallback };
}
