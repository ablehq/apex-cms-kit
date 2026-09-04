import { z } from 'zod';
import { unwrapArchetypeRecord } from '../archetype-record';
import { auditOutcome } from '../audit';
import { noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { rejectMutation } from '../reject';
import type { BffContext } from '../context';

/**
 * The MediaPickerModal upload path (plan §8, 3a lift list), as two same-origin BFF
 * ops. Keus's MediaService did all of this browser-side with a raw Apex bearer token;
 * here every Apex call is server-side behind the guard, and only the raw file bytes
 * ever leave the browser directly — to the ActiveStorage SIGNED URL, which is storage,
 * not Apex, and carries no Apex credential.
 *
 *   POST /api/admin/media/uploads  → create the gallery item + a signed upload URL
 *   (browser PUTs the file to that URL)
 *   POST /api/admin/media          → finalize: record the medium against the item
 *
 * Media upload remains upload-only (no browse/reuse) exactly as the design notes
 * (02 §5 — that is Phase 5). Fail closed: strict bodies, gallery ids UUID-checked.
 */
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);

const signBodySchema = z
	.object({
		galleryId: uuid,
		title: z.string().max(300).optional(),
		alt: z.string().max(300).optional(),
		file: z
			.object({
				byte_size: z
					.number()
					.int()
					.positive()
					.max(50 * 1024 * 1024),
				content_type: z.string().max(120),
				filename: z.string().max(300),
				checksum: z.string().max(64)
			})
			.strict()
	})
	.strict();

const finalizeBodySchema = z
	.object({
		galleryItemId: uuid,
		signedId: z.string().min(1).max(4096),
		contentType: z.string().max(120).optional()
	})
	.strict();

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
	if (!parsed.success) return rejectMutation(ctx, actorMeta, 400, 'invalid body', 'invalid body');

	const galleryItem = await guard.apex.createGalleryItem(
		parsed.data.galleryId,
		parsed.data.title ?? '',
		parsed.data.alt ?? ''
	);
	if (!galleryItem.ok) return noStoreJson({ error: 'upstream error' }, 502);
	const item = unwrapArchetypeRecord(galleryItem.body);
	const galleryItemId = typeof item?.id === 'string' ? item.id : null;
	if (!galleryItemId) return noStoreJson({ error: 'unexpected upstream shape' }, 502);

	const signed = await guard.apex.createSignedUploadUrl(parsed.data.file);
	if (!signed.ok) return noStoreJson({ error: 'upstream error' }, 502);
	const signedData =
		unwrapArchetypeRecord(signed.body) ?? (signed.body as Record<string, unknown> | null);

	await auditOutcome(ctx, meta, guard.actor, {
		outcome: 'accepted',
		detail: { galleryItemId, filename: parsed.data.file.filename }
	});

	return noStoreJson({
		galleryItemId,
		uploadUrl: signedData?.url ?? null,
		uploadHeaders: signedData?.headers ?? {},
		signedId: signedData?.signed_id ?? null
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
	if (!parsed.success) return rejectMutation(ctx, actorMeta, 400, 'invalid body', 'invalid body');

	const medium = await guard.apex.createMedium({
		kind: 'primary',
		file: parsed.data.signedId,
		record_id: parsed.data.galleryItemId,
		record_type: 'Cms::GalleryItem'
	});
	const outcome = medium.ok ? 'accepted' : 'apex_error';
	const data = unwrapArchetypeRecord(medium.body);

	await auditOutcome(ctx, meta, guard.actor, {
		outcome,
		detail: { galleryItemId: parsed.data.galleryItemId, apexStatus: medium.status }
	});

	if (!medium.ok) return noStoreJson({ error: 'upstream error' }, 502);
	return noStoreJson({ galleryItemId: parsed.data.galleryItemId, mediumId: data?.id ?? null });
}
