import type { BffDatabase } from './d1';

/**
 * The upload claim: what makes a signed id mean something.
 *
 * The media sign leg checks a file's type and size against ONE named gallery and
 * then hands the browser an ActiveStorage signed id. That signed id comes back on
 * the finalize request, which makes it a caller-supplied token — and an
 * ActiveStorage signed id carries no gallery and no use count, so on its own it
 * proves nothing about the check that produced it. Measured against local Apex
 * before this module existed: a PNG signed for `images` finalized into `videos`; a
 * PDF signed for `files` finalized into `images`; one signed id finalized twice,
 * leaving two gallery items whose two media shared a single blob — and because
 * `Medium` is `has_one_attached :file, dependent: :purge_later`, deleting either
 * item would have purged the other's bytes.
 *
 * So the sign leg writes down what it decided, and finalize spends that row:
 *
 *   sign      → `recordUploadClaim(db, uploadClaimId(signedId), 'files', now)`
 *   finalize  → `redeemUploadClaim(db, uploadClaimId(signedId), 'files', now)`
 *
 * ── WHY THE REDEMPTION IS ONE STATEMENT ───────────────────────────────────────
 * `UPDATE … WHERE redeemed_at IS NULL` and its row-change count, not a SELECT
 * followed by an UPDATE. A read-then-write has a window between the two halves, and
 * in a Worker that window spans an `await`, so two concurrent finalizes would both
 * read "unredeemed" and both write. One conditional UPDATE cannot do that: D1 runs
 * it through a single writer, so exactly one of the two reports `changes === 1` and
 * the other reports 0. The same primitive the ingest single-use claims already
 * depend on (see `d1.ts` on `meta.changes`).
 *
 * A platform that reports NO change count fails CLOSED: the claim is treated as
 * unredeemable rather than assumed spent by us, because "we cannot tell whether we
 * won" and "we won" are different answers and only one of them is safe.
 */

/**
 * How long a signed upload may sit unredeemed. Generous — an editor on a slow link
 * uploading 25 MB is minutes, not hours — because the TTL is a sweep policy, not a
 * security boundary: single use and the gallery binding are what the row is for.
 */
export const UPLOAD_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Why a finalize may not spend a signed id. These are `reason` codes for the audit
 * row; `uploadClaimMessage` turns each into the sentence the editor reads.
 */
export type UploadClaimRefusal =
	| 'upload-not-recognised'
	| 'upload-wrong-gallery'
	| 'upload-already-used'
	| 'upload-expired'
	| 'upload-claim-unavailable';

/**
 * The claim's primary key: the SHA-256 of the signed id, never the signed id.
 *
 * It doubles as the UPLOAD ATTEMPT ID in the audit log, which is what lets a sign
 * row and a finalize row be recognised as two halves of one upload — and a sign row
 * with no finalize beside it be recognised as an abandonment. Safe to log precisely
 * because it is a one-way hash: holding it does not let anyone finalize, since the
 * op hashes whatever signed id it is handed and compares. The signed id itself is a
 * capability to attach a blob and must never reach the log.
 *
 * Both `recordUploadClaim` and `redeemUploadClaim` take this id rather than the
 * signed id, so the credential structurally cannot travel past the handler.
 */
export async function uploadClaimId(signedId: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signedId));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * Write down what the sign leg decided. Throws rather than returning a flag: a
 * signed id whose claim was not stored can never be finalized, so handing the
 * browser one would be handing it a dead URL, and the sign op must answer with a
 * failure instead of a 200.
 */
export async function recordUploadClaim(
	db: BffDatabase,
	claimId: string,
	gallery: string,
	now: number
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO bff_media_upload_claim (id, gallery, created_at, expires_at, redeemed_at)
			 VALUES (?, ?, ?, ?, NULL)`
		)
		.bind(claimId, gallery, now, now + UPLOAD_CLAIM_TTL_MS)
		.run();
}

/**
 * Spend the claim, or say why it cannot be spent. `null` means this request — and
 * only this request — may go on to create the gallery item and the medium.
 *
 * The gallery is part of the WHERE clause rather than something read back and
 * compared, so a claim is never even a candidate for a finalize that names a
 * different library. The follow-up SELECT runs only on the losing path, and only to
 * choose which sentence the editor is shown.
 */
export async function redeemUploadClaim(
	db: BffDatabase,
	claimId: string,
	gallery: string,
	now: number
): Promise<UploadClaimRefusal | null> {
	const id = claimId;
	const claimed = await db
		.prepare(
			`UPDATE bff_media_upload_claim
			    SET redeemed_at = ?
			  WHERE id = ? AND gallery = ? AND redeemed_at IS NULL AND expires_at > ?`
		)
		.bind(now, id, gallery, now)
		.run();

	// Fail CLOSED on a platform that reports no count: not knowing whether this
	// request won the race is not the same as having won it.
	if (claimed.meta?.changes === 1) return null;
	if (typeof claimed.meta?.changes !== 'number') return 'upload-claim-unavailable';

	const row = await db
		.prepare(`SELECT gallery, expires_at, redeemed_at FROM bff_media_upload_claim WHERE id = ?`)
		.bind(id)
		.first<{ gallery: string; expires_at: number; redeemed_at: number | null }>();
	if (!row) return 'upload-not-recognised';
	// Most specific first: a signed id pointed at the wrong library is the caller
	// doing something the sign leg never authorized, whatever else is also true of it.
	if (row.gallery !== gallery) return 'upload-wrong-gallery';
	if (row.redeemed_at !== null) return 'upload-already-used';
	if (row.expires_at <= now) return 'upload-expired';
	// The UPDATE matched nothing and the row looks spendable: something raced us in a
	// way this code does not model. Refuse rather than proceed on a guess.
	return 'upload-claim-unavailable';
}

/**
 * Drop claims nobody can spend any more. Called on the sign path, where one extra
 * indexed DELETE is already in the shadow of an Apex round trip, so the table stays
 * about a day deep without a scheduled job.
 */
export async function purgeExpiredUploadClaims(db: BffDatabase, now: number): Promise<void> {
	await db.prepare(`DELETE FROM bff_media_upload_claim WHERE expires_at <= ?`).bind(now).run();
}

/**
 * The refusal as a sentence for an editor, whose file is already uploaded by the
 * time any of these can happen. Each one ends with what to do next, because "that
 * upload was prepared for a different library" is a fact about our bookkeeping and
 * "choose the file again" is the only part they can act on.
 */
export function uploadClaimMessage(refusal: UploadClaimRefusal): string {
	switch (refusal) {
		case 'upload-wrong-gallery':
			return 'That upload was prepared for a different library. Choose the file again.';
		case 'upload-already-used':
			return 'That upload has already been saved. Choose the file again to add another copy.';
		case 'upload-expired':
			return 'That upload was prepared too long ago. Choose the file again.';
		default:
			return 'That upload could not be matched to a prepared file. Choose the file again.';
	}
}
