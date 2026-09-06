/**
 * What each library gallery accepts, and how large a file may be — defined ONCE and
 * read by all three places that must agree, so they cannot drift apart:
 *
 *   1. the browser check in `upload-media.js`, before anything is signed,
 *   2. the server check in `server/bff/operations/media.ts`, which is the one that
 *      actually holds (a browser check constrains only a well-behaved browser),
 *   3. the file input's `accept`, which is a convenience for the chooser and no
 *      kind of guarantee — a picker can always be told "All Files".
 *
 * ── THE TYPE LISTS ────────────────────────────────────────────────────────────
 * Apex matches content types by EXACT STRING MEMBERSHIP against
 * `Medium::BlobInput#accepted_content_types`:
 *
 *   image/jpeg image/jpg image/gif image/png image/webp image/svg+xml image/*
 *   application/pdf text/csv video/mp4 video/webm
 *
 * Anything outside that list is a 422 at the SIGN leg ("<type> is not a valid kind"),
 * verified by probe for `application/msword`, `application/vnd.ms-excel`,
 * `video/quicktime` and `image/avif`.
 *
 * The lists below are NARROWER than Apex's, deliberately, in two places:
 *
 *   - `image/*` is a literal member of Apex's list and a constructed request really
 *     can send that exact string (probed: it signs, stores and finalizes). It is
 *     excluded here rather than dismissed as unreachable.
 *   - `image/svg+xml` is excluded. The direct-upload path passes no disposition, so
 *     the object is stored `Content-Disposition: inline` and the media host serves
 *     an uploaded SVG as a DOCUMENT — script and all — on an origin shared by every
 *     Apex tenant, whose headers and CSP we do not control. Neither site needs
 *     editor-uploaded SVG.
 *
 * ── WHAT THESE LISTS DO AND DO NOT CONTROL ────────────────────────────────────
 * This file used to say the SVG exclusion "is enforced in the sign op, not only
 * here", which read as a guarantee about BYTES and is not one. Every check on this
 * path judges the DECLARED string and nothing looks at the file: declare `text/csv`,
 * PUT SVG bytes, and the object stores and Apex records it as `image/svg+xml` —
 * measured against local Apex. So the lists are a real control over the ordinary
 * path (a chooser, a browser's guess from an extension, the wrong file picked) and
 * NOT a control over a caller choosing what to declare. That caller is a signed-in
 * editor holding the account's own staff token, so this path opens nothing they
 * could not already do through Apex directly.
 *
 * Do NOT answer this with byte sniffing: the first 4 KB is exactly what Marcel
 * reads, a polyglot beats both, and the control that would hold — a
 * `Content-Disposition` that is not `inline`, or a media host not shared across
 * tenants — lives upstream.
 *
 * ── THE SIZE LIMIT IS THIS KIT'S POLICY, NOT APEX'S CAP ───────────────────────
 * The two backends disagree with each other, on the number AND on where it is
 * enforced: the branch this was measured against validates `less_than: 25.megabytes`
 * at FINALIZE (after the bytes are already stored), while `origin/master` validates
 * `less_than_or_equal_to: 30.megabytes` at SIGN. The kit therefore sets its own limit,
 * chosen to hold under BOTH, and refusing in the browser means an oversized file costs
 * no upload at all rather than a 25 MiB round trip that ends in a 422 — and, worse, an
 * orphaned 25 MiB blob nothing sweeps. Apex's own refusal is still surfaced verbatim if
 * it ever fires.
 *
 * The comparison is STRICTLY LESS THAN, and the boundary byte is not a detail: Rails'
 * `less_than: 25.megabytes` refuses a file of exactly 26,214,400 bytes, measured — sign
 * 200, PUT 204, finalize 422 "File file size must be less than 25 MB". An inclusive
 * limit would pass that exact size through this gate and into the failure the gate
 * exists to prevent. One byte under is the largest size proved to land.
 */

/**
 * The size limit, in bytes. A file must be strictly SMALLER than this — 26,214,399
 * bytes is the largest that uploads, and is proved to.
 */
export const UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;

/** How to say `UPLOAD_LIMIT_BYTES` to an editor. */
export const MAX_UPLOAD_LABEL = '25 MB';

/**
 * How long a caption or an alt text may be.
 *
 * Defined here for the same reason the type lists are: the finalize schema, the
 * refusal sentence and every `maxlength` attribute on every caption box in both
 * sites have to agree, and they only agree if there is one number. Without the
 * attribute the cap was reachable by PASTE, and what an editor got for it was the
 * literal words "invalid body" — after their bytes were already uploaded.
 */
export const CAPTION_MAX_LENGTH = 300;

/**
 * @typedef {object} GalleryMedia
 * @property {readonly string[]} types The content types this gallery accepts.
 * @property {string} accept The file input's `accept` attribute.
 * @property {string} label The accepted formats, as a sentence fragment for help text.
 * @property {boolean} hasAlt Whether alt text means anything here (images only).
 */

/**
 * The three galleries `cms_config` names. `accept` carries the `.csv` EXTENSION
 * alongside the type because Windows reports a `.csv` as `application/vnd.ms-excel`,
 * which a type-only `accept` would filter out of the chooser entirely.
 *
 * @type {Readonly<Record<string, GalleryMedia>>}
 */
export const GALLERY_MEDIA = Object.freeze({
	images: Object.freeze({
		types: Object.freeze(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']),
		accept: 'image/jpeg,image/png,image/gif,image/webp',
		label: 'JPEG, PNG, GIF or WebP',
		hasAlt: true
	}),
	files: Object.freeze({
		types: Object.freeze(['application/pdf', 'text/csv']),
		accept: 'application/pdf,text/csv,.csv',
		label: 'PDF or CSV',
		hasAlt: false
	}),
	videos: Object.freeze({
		types: Object.freeze(['video/mp4', 'video/webm']),
		accept: 'video/mp4,video/webm',
		label: 'MP4 or WebM',
		hasAlt: false
	})
});

/**
 * The gallery's media rules, or null for a name this kit does not serve. Callers
 * branch on null rather than falling back to `images`: silently filing a video in
 * the images gallery is worse than refusing.
 *
 * @param {string} gallery
 * @returns {GalleryMedia | null}
 */
export function galleryMedia(gallery) {
	return Object.prototype.hasOwnProperty.call(GALLERY_MEDIA, gallery)
		? GALLERY_MEDIA[gallery]
		: null;
}

/**
 * The content type to DECLARE for a chosen file.
 *
 * `File.type` is the browser's guess from the extension and the OS registry, and on
 * Windows a `.csv` comes through as `application/vnd.ms-excel` — which Apex refuses
 * with a 422 at sign. The extension is the better evidence for exactly that case, so
 * `.csv` is declared as `text/csv` whatever the browser said. Everything else is
 * taken at face value: guessing more broadly would mean declaring a type the bytes
 * may not match, and Apex re-derives the stored type from the bytes anyway.
 *
 * @param {{ name?: string, type?: string }} file
 * @returns {string}
 */
export function declaredContentType(file) {
	const name = typeof file?.name === 'string' ? file.name : '';
	if (/\.csv$/iu.test(name)) return 'text/csv';
	return typeof file?.type === 'string' ? file.type : '';
}

/**
 * Why this upload must be refused, or null when it may proceed. The SAME function
 * runs in the browser and on the server, so the two answers cannot differ.
 *
 * The returned strings are the `reason` codes `uploadMedia` reports and the error
 * codes the BFF answers with — one vocabulary, not two.
 *
 * @param {string} gallery
 * @param {string} contentType
 * @param {number} byteSize
 * @returns {'no-such-gallery' | 'type-not-allowed' | 'too-large' | 'empty-file' | null}
 */
export function refuseUpload(gallery, contentType, byteSize) {
	const media = galleryMedia(gallery);
	if (!media) return 'no-such-gallery';
	if (!media.types.includes(contentType)) return 'type-not-allowed';
	if (!(byteSize > 0)) return 'empty-file';
	if (!(byteSize < UPLOAD_LIMIT_BYTES)) return 'too-large';
	return null;
}

/**
 * That refusal as a sentence for an editor. Kept beside the codes so a screen can
 * print something useful without inventing its own wording per gallery.
 *
 * @param {string} gallery
 * @param {string} reason
 * @returns {string}
 */
export function refusalMessage(gallery, reason) {
	const media = galleryMedia(gallery);
	switch (reason) {
		case 'no-such-gallery':
			return 'There is no such library to upload to.';
		case 'type-not-allowed':
			return media
				? `That file type cannot go in this library. Choose ${media.label}.`
				: 'That file type cannot go in this library.';
		case 'empty-file':
			return 'That file is empty.';
		case 'too-large':
			return `That file is larger than ${MAX_UPLOAD_LABEL}. Choose a smaller one.`;
		default:
			return 'That file cannot be uploaded.';
	}
}
