import { auditOutcome } from '../audit';
import { noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { rejectMutation } from '../reject';
import { findImage, imageIdSchema } from './list-gallery-images';
import type { BffContext } from '../context';

/**
 * DELETE /api/admin/images/[imageId] — remove one image from the library (probe C4).
 *
 * ⚠ THERE IS NO IN-USE GUARD, AND THAT IS NOT AN OVERSIGHT. Nothing in the proven
 * Apex surface answers "what references this gallery item". An image can be pointed
 * at by a `Cms::DocumentBlock::Image` in any article, by a media field on any page
 * block, or by nothing at all, and there is no reverse index and no reverse query —
 * finding out would mean walking every document and every page on every render of
 * this screen, and would still be a guess about block shapes this admin cannot edit.
 *
 * So the deletion is unguarded, and the SCREEN SAYS SO rather than showing a "Used
 * by" column full of dashes. A dash in that column would read as "nothing uses this,
 * safe to delete", which is precisely the false statement that would cost someone a
 * live page's artwork. Compare `delete-author.ts`, which DOES guard, because there
 * the reverse query exists and the count is knowable.
 *
 * MEMBERSHIP FIRST, for the same reason as the update: `DELETE /cms/gallery_items/:id`
 * is not scoped to a gallery, so without `findImage` the Images screen could delete a
 * video or a file by id. Anything not in the images gallery is a 404 here.
 */
export async function handleDeleteImage(
	request: Request,
	ctx: BffContext,
	params: { imageId: string }
): Promise<Response> {
	const meta = {
		action: 'images.delete',
		method: 'DELETE',
		path: `/api/admin/images/${params.imageId}`,
		requestId: request.headers.get('cf-ray')
	};

	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectMutation(ctx, meta, guard.status, guard.reason, guard.reason);

	const actorMeta = { ...meta, actorEmail: guard.actor.email, actorSub: guard.actor.sub };

	const idResult = imageIdSchema.safeParse(params.imageId);
	if (!idResult.success) {
		return rejectMutation(ctx, actorMeta, 400, 'invalid id', 'invalid image id');
	}

	const existing = await findImage(guard.apex, idResult.data);
	if (!existing) return rejectMutation(ctx, actorMeta, 404, 'not found', 'no such image');

	const apexResponse = await guard.apex.deleteGalleryItem(idResult.data);

	await auditOutcome(ctx, meta, guard.actor, {
		outcome: apexResponse.ok ? 'accepted' : 'apex_error',
		// The caption is recorded because it is the only human-readable name this
		// record ever had, and after the delete there is nowhere else to read it.
		detail: { imageId: idResult.data, caption: existing.caption, apexStatus: apexResponse.status }
	});

	if (!apexResponse.ok) {
		const status =
			apexResponse.status >= 400 && apexResponse.status < 500 ? apexResponse.status : 502;
		return noStoreJson({ error: 'upstream error', status: apexResponse.status }, status);
	}

	return noStoreJson({ ok: true });
}
