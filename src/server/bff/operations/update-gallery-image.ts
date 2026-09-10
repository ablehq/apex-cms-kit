import { z } from 'zod';
import { auditOutcome } from '../audit';
import { noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { rejectGuardFailure, rejectMutation } from '../reject';
import { findImage, imageIdSchema, GALLERY_NAMES } from './list-gallery-images';
import type { BffContext } from '../context';

/**
 * PATCH /api/admin/images/[imageId] — an image's caption and alt text (probe G3).
 *
 * `caption` and `alt` are ORDINARY COLUMNS on `Cms::GalleryItem`, not archetype
 * primitives, which is why this operation looks simpler than its resource and author
 * siblings and why it is allowed to: there is no `archetype_items` row to destroy,
 * so the `null` hazard those operations guard against (probe N2) does not exist
 * here. `''` and `null` would both simply clear the column. The schema still refuses
 * `null` — not for safety, but so that "clear this field" has exactly one spelling
 * across the whole admin.
 *
 * `position` is deliberately NOT writable. Apex accepts it, but this screen has no
 * reordering affordance, so the only way it could be sent is by accident.
 *
 * MEMBERSHIP FIRST. `findImage` is what makes this route unable to edit a video or a
 * file: the id is looked up in the IMAGES gallery, and anything else is a 404. Apex
 * would happily accept the write — `PATCH /cms/gallery_items/:id` is not scoped to a
 * gallery — so the scoping has to happen here or nowhere.
 *
 * ALT TEXT IS NOT DECORATION. It is what a screen reader says in place of the image,
 * so it is a first-class field on this screen and not a tooltip. A caption is shown
 * beside the image; alt text replaces it.
 */
export const updateImageBodySchema = z
	.object({
		caption: z.string().max(500).optional(),
		alt: z.string().max(500).optional()
	})
	.strict()
	// An empty PATCH means a save decided it had something to write and then wrote
	// nothing — a caller bug, not a no-op to absorb quietly.
	.refine((fields) => Object.keys(fields).length > 0);

export async function handleUpdateImage(
	request: Request,
	ctx: BffContext,
	params: { imageId: string },
	options: { gallery?: string } = {}
): Promise<Response> {
	const gallery = options.gallery ?? 'images';
	/**
	 * NEITHER AUDIT COLUMN TAKES A CALLER'S STRING.
	 *
	 * This meta is built BEFORE `imageIdSchema` runs, so `${params.imageId}` in the
	 * path wrote an arbitrary caller-supplied value into `bff_audit_log.path` on every
	 * refused request — the rule `reject.ts` states and every other operation follows.
	 * `gallery` is the same hazard one step removed: Godrej's route wrapper validates
	 * it against `isLibraryGallery` before delegating, but this operation is the one
	 * that WRITES the row and must not depend on a caller doing that.
	 *
	 * So the path is the route TEMPLATE and `action` is narrowed to a name this kit
	 * actually serves. The validated id goes in `detail` once there is one.
	 */
	const known = (GALLERY_NAMES as readonly string[]).includes(gallery);
	const meta = {
		// The audit row names the gallery actually addressed — never "images" for a file.
		action: `${known ? gallery : 'gallery'}.update`,
		method: 'PATCH',
		path:
			known && gallery === 'images'
				? '/api/admin/images/[imageId]'
				: '/api/admin/galleries/[gallery]/[imageId]',
		requestId: request.headers.get('cf-ray')
	};

	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectGuardFailure(request, ctx, meta, guard);

	const actorMeta = { ...meta, actorEmail: guard.actor.email, actorSub: guard.actor.sub };

	const idResult = imageIdSchema.safeParse(params.imageId);
	if (!idResult.success) {
		return rejectMutation(ctx, actorMeta, 400, 'invalid id', 'invalid image id');
	}

	let bodyJson: unknown;
	try {
		bodyJson = await request.json();
	} catch {
		return rejectMutation(ctx, actorMeta, 400, 'invalid json', 'invalid json');
	}

	const parsed = updateImageBodySchema.safeParse(bodyJson);
	if (!parsed.success) {
		return rejectMutation(ctx, actorMeta, 400, 'invalid body', 'invalid body');
	}

	if (!(GALLERY_NAMES as readonly string[]).includes(gallery)) {
		return rejectMutation(ctx, actorMeta, 404, 'not found', 'no such gallery');
	}
	const existing = await findImage(guard.apex, idResult.data, '', gallery);
	if (!existing) return rejectMutation(ctx, actorMeta, 404, 'not found', 'no such image');

	const apexResponse = await guard.apex.updateGalleryItem(idResult.data, parsed.data);

	await auditOutcome(ctx, meta, guard.actor, {
		outcome: apexResponse.ok ? 'accepted' : 'apex_error',
		detail: {
			imageId: idResult.data,
			fields: Object.keys(parsed.data),
			apexStatus: apexResponse.status
		}
	});

	if (!apexResponse.ok) {
		const status =
			apexResponse.status >= 400 && apexResponse.status < 500 ? apexResponse.status : 502;
		return noStoreJson({ error: 'upstream error', status: apexResponse.status }, status);
	}

	// RE-READ, not the PATCH's echo. This admin has already shipped one write that
	// Apex answered 200 to and dropped on the floor (phase 3b) and one that 422'd for
	// months behind a stub, so a status code does not count as evidence anywhere in
	// this codebase: the value is written when the READ surface shows it.
	// Re-read from the SAME gallery the write was addressed to. Reading images here for
	// a files item would find nothing and answer 502 after the write had landed.
	const image = await findImage(guard.apex, idResult.data, ctx.assetsPrefix ?? '', gallery);
	if (!image) return noStoreJson({ error: 'unexpected upstream shape' }, 502);

	return noStoreJson({ image });
}
