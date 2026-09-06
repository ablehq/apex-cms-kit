import { z } from 'zod';
import { unwrapArchetypeRecord } from '../archetype-record';
import { auditOutcome } from '../audit';
import { noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import {
	purgeExpiredUploadClaims,
	recordUploadClaim,
	redeemUploadClaim,
	uploadClaimMessage
} from '../media-claim';
import { rejectMutation } from '../reject';
import { readGalleryId } from './list-gallery-images';
import { CAPTION_MAX_LENGTH, galleryMedia, refuseUpload } from '../../../admin/media-types.js';
import type { ApexAdminClient, ApexResponse } from '../apex-admin-client';
import type { BffContext } from '../context';

/**
 * The media upload path, as two same-origin BFF ops. Keus's MediaService did all of
 * this browser-side with a raw Apex bearer token; here every Apex call is server-side
 * behind the guard, and only the raw file bytes ever leave the browser directly — to
 * the ActiveStorage SIGNED URL, which is storage, not Apex, and carries no Apex
 * credential.
 *
 *   POST /api/admin/media/uploads  → check the type and size, mint a signed URL,
 *                                    write the CLAIM. Creates NOTHING upstream.
 *   (the browser PUTs the file to that URL)
 *   POST /api/admin/media          → spend the claim, then create the gallery item
 *                                    AND attach the medium.
 *
 * ── WHY THE ITEM IS CREATED HERE AND NOT AT SIGN ──────────────────────────────
 * It used to be created at sign, before the bytes existed. Every failure after that
 * point — a 422 from storage, a size refusal, a closed tab — left a gallery item with
 * a caption and no picture, and a sign-leg failure left one the browser could not even
 * name, because the op answered 502 without the id. Compensating for that in the
 * browser was tried and does not work.
 *
 * Creating the item at FINALIZE removes the failure mode rather than handling it:
 * nothing exists until the bytes are stored, so there is no rollback to perform and
 * no orphaned item to sweep. The one compensation left is local and server-side: if
 * creating the MEDIUM fails after the item was created, this op deletes the item it
 * just made, in the same request.
 *
 * ── WHAT MOVING THE CREATE DID *NOT* REMOVE ───────────────────────────────────
 * This file used to argue that finalize no longer had to guard its target because
 * there was no browser-supplied `galleryItemId` left to distrust. That was wrong,
 * and measurably so. The SIGNED ID is still a caller-supplied token, and it is the
 * only thing tying the finalize request to the type and size check the sign leg ran.
 * With nothing checking it: a PNG signed for `images` finalized into `videos` (200);
 * a PDF signed for `files` finalized into `images` (200); one signed id finalized
 * twice, and twice concurrently, each time leaving two gallery items whose media
 * shared a single blob — which `dependent: :purge_later` turns into "deleting one
 * item destroys the other's bytes".
 *
 * `media-claim.ts` closes both holes with one row: sign writes down the gallery it
 * judged, finalize spends that row with a single conditional UPDATE. See that file
 * for why one statement, and not a read followed by a write.
 *
 * ── WHAT IS STILL NOT REPAIRED ────────────────────────────────────────────────
 * The blob. Signing mints an `ActiveStorage::Blob` immediately, so an abandoned or
 * failed PUT strands bytes that no platform API can reach, and `ellipsis-backend` has
 * no sweeper for unattached blobs. Even the success-then-delete path purges
 * asynchronously. That is upstream debt — a periodic purge with an age threshold —
 * named here rather than silently inherited.
 *
 * Fail closed: strict bodies, and the gallery is addressed by NAME (its id is
 * account-scoped and resolved from `cms_config` per request — risk R14).
 */

/**
 * The gallery is a NAME, never an id. `refuseUpload` rejects a name this kit does not
 * serve, so the schema only has to bound the string; keeping the vocabulary in one
 * module (`admin/media-types.js`) is what stops the browser check, this check and the
 * file input's `accept` from drifting apart.
 */
const signBodySchema = z
	.object({
		gallery: z.string().max(40),
		file: z
			.object({
				byte_size: z.number().int().positive(),
				content_type: z.string().max(120),
				filename: z.string().max(300),
				checksum: z.string().max(64)
			})
			.strict()
	})
	.strict();

const finalizeBodySchema = z
	.object({
		gallery: z.string().max(40),
		signedId: z.string().min(1).max(4096),
		title: z.string().max(CAPTION_MAX_LENGTH).optional(),
		alt: z.string().max(CAPTION_MAX_LENGTH).optional()
	})
	.strict();

/**
 * A rejected body, as a sentence.
 *
 * Everywhere else in this BFF a schema failure answers the code `invalid body`, and
 * that is right: those codes are read by screens that already know what they sent
 * and choose their own words. This path is the exception, and it is the only one —
 * the media screens print the server's string VERBATIM, and they print it after the
 * editor's bytes have already been uploaded. A caption pasted past the cap therefore
 * showed a person the words "invalid body" as the explanation for losing a 20 MB
 * upload. The `maxlength` attributes make that unreachable through the UI; this
 * makes it survivable when it is reached anyway.
 *
 * The audit row still records `invalid body`, so nothing that greps the log changes.
 */
function invalidBodyMessage(issues: { path: PropertyKey[]; code: string }[], fallback: string) {
	for (const issue of issues) {
		if (issue.code !== 'too_big') continue;
		const field = issue.path[issue.path.length - 1];
		if (field === 'title')
			return `That caption is too long. Keep it to ${CAPTION_MAX_LENGTH} characters or fewer.`;
		if (field === 'alt')
			return `That alt text is too long. Keep it to ${CAPTION_MAX_LENGTH} characters or fewer.`;
		if (field === 'filename') return 'That file name is too long. Rename the file and try again.';
	}
	return fallback;
}

/**
 * What Apex actually said, dug out of the two failure shapes its controllers use:
 *
 *   {"message": "Content type image/avif is not a valid kind", "errors": {...}}
 *   {"data": [{"attribute_name": "file", "messages": ["File file size must be …"]}]}
 *
 * Flattening both to `502 {error:'upstream error'}` — which is what this file used to
 * do on every non-2xx — means an editor is told an upload failed and never told why,
 * for a class of failures whose reasons are entirely actionable ("that type is not
 * allowed", "that file is too big"). Length-capped: it is a message for a person, not
 * a channel for arbitrary upstream text.
 */
function apexMessage(body: unknown): string {
	const root = body as { message?: unknown; errors?: unknown; data?: unknown } | null;
	if (typeof root?.message === 'string' && root.message.trim())
		return root.message.trim().slice(0, 300);

	const rows = Array.isArray(root?.data) ? root.data : [];
	const fromRows: string[] = [];
	for (const row of rows) {
		const messages = (row as { messages?: unknown })?.messages;
		if (Array.isArray(messages))
			for (const m of messages) if (typeof m === 'string') fromRows.push(m);
	}
	if (fromRows.length) return fromRows.join('. ').slice(0, 300);

	const errors = root?.errors;
	if (errors && typeof errors === 'object') {
		const flat: string[] = [];
		for (const value of Object.values(errors as Record<string, unknown>)) {
			// Rails answers `{field: ["msg"]}` here, but a bare `{field: "msg"}` shows up
			// too. Braces, not a dangling `else`: without them the string branch binds to
			// the INNER `if` and can never run, silently dropping half the shapes.
			if (Array.isArray(value)) {
				for (const m of value) if (typeof m === 'string') flat.push(m);
			} else if (typeof value === 'string') {
				flat.push(value);
			}
		}
		if (flat.length) return flat.join('. ').slice(0, 300);
	}
	return '';
}

/**
 * An upstream failure, with its reason. A 422 is Apex judging the REQUEST and is
 * passed through as a 422 so the browser can tell "you sent something invalid" from
 * "the upstream is unwell". Every other upstream status becomes a 502 — echoing a 401
 * or a 403 from Apex would read to the admin as "your session ended", which is a
 * different and misleading thing — but it still carries the message.
 */
function upstreamFailure(response: ApexResponse): Response {
	const message = apexMessage(response.body);
	const status = response.status === 422 ? 422 : 502;
	return noStoreJson({ error: message || 'upstream error' }, status);
}

export async function handleSignMediaUpload(request: Request, ctx: BffContext): Promise<Response> {
	const meta = {
		action: 'media.upload.sign',
		method: 'POST',
		path: '/api/admin/media/uploads',
		requestId: request.headers.get('cf-ray')
	};
	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectMutation(ctx, meta, guard.status, guard.reason, guard.reason);
	const actorMeta = { ...meta, actorEmail: guard.actor.email, actorSub: guard.actor.sub };

	let bodyJson: unknown;
	try {
		bodyJson = await request.json();
	} catch {
		return rejectMutation(ctx, actorMeta, 400, 'invalid json', 'invalid json');
	}
	const parsed = signBodySchema.safeParse(bodyJson);
	if (!parsed.success) {
		const said = invalidBodyMessage(
			parsed.error.issues,
			'That file could not be prepared for upload.'
		);
		return rejectMutation(ctx, actorMeta, 400, said, 'invalid body');
	}

	// The SAME check the browser ran, run again where it actually holds. A browser
	// check constrains a well-behaved browser; this one constrains everyone. Note it
	// happens before any Apex call, so a refusal costs nothing upstream.
	const refusal = refuseUpload(
		parsed.data.gallery,
		parsed.data.file.content_type,
		parsed.data.file.byte_size
	);
	if (refusal) return rejectMutation(ctx, actorMeta, 400, refusal, refusal);

	// Fail CLOSED before asking Apex for anything: a signed id whose claim cannot be
	// written is a token finalize could not check, so minting one would hand the
	// browser exactly the unbound capability the claim exists to prevent.
	if (!ctx.db) {
		return noStoreJson({ error: 'Uploads are not available on this deployment.' }, 500);
	}

	const signed = await guard.apex.createSignedUploadUrl(parsed.data.file).catch(() => null);
	if (signed === null) {
		// A rethrown transport fault. Nothing upstream was created that could need
		// sweeping — but an unaudited exception is still a request nobody can account
		// for afterwards, which is the whole point of the log.
		await auditOutcome(ctx, meta, guard.actor, {
			outcome: 'apex_error',
			detail: { gallery: parsed.data.gallery, filename: parsed.data.file.filename }
		});
		return noStoreJson({ error: 'The upload could not be started. Try again.' }, 502);
	}
	if (!signed.ok) {
		await auditOutcome(ctx, meta, guard.actor, {
			outcome: 'apex_error',
			detail: { filename: parsed.data.file.filename, apexStatus: signed.status }
		});
		return upstreamFailure(signed);
	}
	const signedData =
		unwrapArchetypeRecord(signed.body) ?? (signed.body as Record<string, unknown> | null);
	const uploadUrl = typeof signedData?.url === 'string' ? signedData.url : '';
	const signedId = typeof signedData?.signed_id === 'string' ? signedData.signed_id : '';
	if (!uploadUrl || !signedId) {
		await auditOutcome(ctx, meta, guard.actor, {
			outcome: 'apex_error',
			detail: { gallery: parsed.data.gallery, filename: parsed.data.file.filename }
		});
		return noStoreJson({ error: 'unexpected upstream shape' }, 502);
	}

	const now = ctx.now ?? Date.now();
	// The sweep is best-effort housekeeping and must never cost an editor an upload;
	// the claim write is the opposite, and a failure there fails the whole sign.
	try {
		await purgeExpiredUploadClaims(ctx.db, now);
	} catch {
		// swallow — an unswept expired claim is refused anyway, by its `expires_at`.
	}
	try {
		await recordUploadClaim(ctx.db, signedId, parsed.data.gallery, now);
	} catch {
		await auditOutcome(ctx, meta, guard.actor, {
			outcome: 'apex_error',
			detail: { gallery: parsed.data.gallery, claimStored: false }
		});
		return noStoreJson({ error: 'The upload could not be started.' }, 500);
	}

	await auditOutcome(ctx, meta, guard.actor, {
		outcome: 'accepted',
		detail: { gallery: parsed.data.gallery, filename: parsed.data.file.filename }
	});

	// No `galleryItemId`: nothing has been created. That absence is the design.
	return noStoreJson({
		uploadUrl,
		uploadHeaders: signedData?.headers ?? {},
		signedId
	});
}

export async function handleFinalizeMediaUpload(
	request: Request,
	ctx: BffContext
): Promise<Response> {
	const meta = {
		action: 'media.upload.finalize',
		method: 'POST',
		path: '/api/admin/media',
		requestId: request.headers.get('cf-ray')
	};
	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectMutation(ctx, meta, guard.status, guard.reason, guard.reason);
	const actorMeta = { ...meta, actorEmail: guard.actor.email, actorSub: guard.actor.sub };

	let bodyJson: unknown;
	try {
		bodyJson = await request.json();
	} catch {
		return rejectMutation(ctx, actorMeta, 400, 'invalid json', 'invalid json');
	}
	const parsed = finalizeBodySchema.safeParse(bodyJson);
	if (!parsed.success) {
		const said = invalidBodyMessage(parsed.error.issues, 'That upload could not be saved as sent.');
		return rejectMutation(ctx, actorMeta, 400, said, 'invalid body');
	}

	const { gallery, signedId } = parsed.data;
	// An unknown name is the CALLER's fault and is refused before any upstream call.
	if (!galleryMedia(gallery))
		return rejectMutation(ctx, actorMeta, 400, 'no-such-gallery', 'no-such-gallery');

	// Fail CLOSED: without the claim store there is nothing to check the signed id
	// against, and an unchecked signed id is the whole defect this guard closes.
	if (!ctx.db) {
		return noStoreJson({ error: 'Uploads are not available on this deployment.' }, 500);
	}

	// SPEND THE SIGNED ID, and do it FIRST — before the Apex reads, so a token that
	// was never minted here, was minted for another library, or has already been
	// spent costs no upstream call at all. Winning this is what authorizes everything
	// below it. A claim spent by a request that then fails upstream is NOT put back:
	// releasing it would reopen the window it exists to close, and the cost of not
	// releasing is that the editor chooses the file again — which is what the browser
	// asks them to do on any finalize failure anyway.
	const refusal = await redeemUploadClaim(ctx.db, signedId, gallery, ctx.now ?? Date.now());
	if (refusal) {
		return rejectMutation(ctx, actorMeta, 400, uploadClaimMessage(refusal), refusal);
	}

	// A name this kit serves that `cms_config` cannot resolve is an UPSTREAM fault —
	// a failed read, or an account without that gallery — so it is a 502, not a 400.
	// The two cases answer differently because they are different mistakes.
	const galleryId = await readGalleryId(guard.apex, gallery).catch(() => null);
	if (!galleryId) {
		await auditOutcome(ctx, meta, guard.actor, { outcome: 'apex_error', detail: { gallery } });
		return noStoreJson({ error: 'upstream error' }, 502);
	}

	// `.catch(() => null)` on every upstream call from here down, because the ADMIN
	// transport RETHROWS network faults (`apex-admin-client.ts`: only the
	// signal-carrying ingest path turns them into typed failures). An escaping
	// exception is a framework 500 with no audit row and no cleanup — which is the
	// hole that was closed for the malformed-shape branch and left open on this one.
	const created = await guard.apex
		.createGalleryItem(galleryId, parsed.data.title ?? '', parsed.data.alt ?? '')
		.catch(() => null);
	if (created === null) {
		// The create THREW: the request may or may not have reached Apex, and there is
		// no id either way, so there is nothing to sweep by. Record it — an item that
		// exists under a caption nobody can name is exactly what an operator needs the
		// audit row to point at.
		await auditOutcome(ctx, meta, guard.actor, {
			outcome: 'apex_error',
			detail: {
				gallery,
				itemCreated: 'unknown',
				caption: (parsed.data.title ?? '').slice(0, 80)
			}
		});
		return noStoreJson({ error: 'The upload could not be saved. Choose the file again.' }, 502);
	}
	if (!created.ok) {
		await auditOutcome(ctx, meta, guard.actor, {
			outcome: 'apex_error',
			detail: { gallery, apexStatus: created.status }
		});
		return upstreamFailure(created);
	}
	const item = unwrapArchetypeRecord(created.body);
	const galleryItemId = typeof item?.id === 'string' && item.id ? item.id : null;
	if (!galleryItemId) {
		// Apex answered 2xx, so an item almost certainly EXISTS — this op simply cannot
		// name it. That made this the one post-create failure that swept nothing and
		// audited nothing, while its two neighbours do both: an orphan was left with a
		// caption and no picture, and no record that it had happened.
		//
		// Sweep with whatever came back (an id of the wrong TYPE is still an id; the
		// client's own uuid check refuses a nonsense one and `deleteQuietly` reports
		// that as `false`), and audit either way. The caption goes in the detail — not
		// a secret, and the only handle a person has on an item nothing can name.
		const unusable = item?.id;
		const rawId = unusable === undefined || unusable === null ? '' : String(unusable);
		const swept = rawId ? await deleteQuietly(guard.apex, rawId) : false;
		await auditOutcome(ctx, meta, guard.actor, {
			outcome: 'apex_error',
			detail: {
				gallery,
				apexStatus: created.status,
				unnamedItem: true,
				itemDeleted: swept,
				caption: (parsed.data.title ?? '').slice(0, 80)
			}
		});
		return noStoreJson({ error: 'unexpected upstream shape' }, 502);
	}

	const medium = await guard.apex
		.createMedium({
			kind: 'primary',
			file: signedId,
			record_id: galleryItemId,
			record_type: 'Cms::GalleryItem'
		})
		.catch(() => null);
	if (medium === null) {
		// ── THE ATTACH THREW, AND THAT IS THE AMBIGUOUS CASE ──────────────────────
		// A rethrown transport fault means the request may have been LOST on the way
		// out or on the way back: the `Medium` may exist, or may not, and this op
		// cannot tell. Both readings are handled by the same action — sweep the item —
		// because deleting the item destroys any medium hanging off it and purges the
		// blob (`dependent: :purge_later`), so the outcome converges on "nothing
		// exists" whichever way the coin actually landed. Leaving it alone does not
		// converge: it is either a caption with no picture, or a finished upload the
		// editor was told had failed, and the retry then makes a duplicate.
		//
		// The retry is safe to invite BECAUSE of the claim: this signed id is already
		// spent, so "choose the file again" means a new sign and a new PUT, and the
		// same bytes cannot be attached twice. What it costs is one stranded blob,
		// which is the upstream debt this design already names.
		const swept = await deleteQuietly(guard.apex, galleryItemId);
		await auditOutcome(ctx, meta, guard.actor, {
			outcome: 'apex_error',
			detail: {
				gallery,
				galleryItemId,
				attachOutcome: 'unknown',
				itemDeleted: swept,
				caption: (parsed.data.title ?? '').slice(0, 80)
			}
		});
		return noStoreJson({ error: 'The upload could not be saved. Choose the file again.' }, 502);
	}
	if (!medium.ok) {
		// The ONE compensation this design still needs, and it is local: the item was
		// created moments ago, in this request, by this op, so its id is known and the
		// delete cannot race a caller. An item with no medium is the "caption attached
		// to no picture" the whole ordering exists to prevent.
		const swept = await deleteQuietly(guard.apex, galleryItemId);
		await auditOutcome(ctx, meta, guard.actor, {
			outcome: 'apex_error',
			detail: { gallery, galleryItemId, apexStatus: medium.status, itemDeleted: swept }
		});
		return upstreamFailure(medium);
	}

	const data = unwrapArchetypeRecord(medium.body);
	await auditOutcome(ctx, meta, guard.actor, {
		outcome: 'accepted',
		detail: { gallery, galleryItemId, apexStatus: medium.status }
	});
	return noStoreJson({ galleryItemId, mediumId: data?.id ?? null });
}

/**
 * Delete the item we just created, reporting whether it worked rather than assuming.
 * A throw here would replace Apex's real reason for the failure with the reason the
 * cleanup failed, which is the less useful of the two — so the outcome is recorded in
 * the audit detail and the original failure is what the editor is told.
 */
async function deleteQuietly(apex: ApexAdminClient, galleryItemId: string): Promise<boolean> {
	try {
		const deleted = await apex.deleteGalleryItem(galleryItemId);
		return deleted.ok;
	} catch {
		return false;
	}
}
