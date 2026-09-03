import { z } from 'zod';
import { appendAuditEntry } from '../audit';
import { noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { rejectMutation } from '../reject';
import { findImage, imageIdSchema } from './list-gallery-images';
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
	params: { imageId: string }
): Promise<Response> {
	const meta = {
		action: 'images.update',
		method: 'PATCH',
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

	const existing = await findImage(guard.apex, idResult.data);
	if (!existing) return rejectMutation(ctx, actorMeta, 404, 'not found', 'no such image');

	const apexResponse = await guard.apex.updateGalleryItem(idResult.data, parsed.data);

	if (ctx.db) {
		await appendAuditEntry(ctx.db, {
			id: crypto.randomUUID(),
			occurredAt: new Date(ctx.now ?? Date.now()).toISOString(),
			actorEmail: guard.actor.email,
			actorSub: guard.actor.sub,
			action: 'images.update',
			method: 'PATCH',
			path: actorMeta.path,
			accountId: ctx.accountId ?? null,
			pageId: null,
			requestId: request.headers.get('cf-ray'),
			outcome: apexResponse.ok ? 'accepted' : 'apex_error',
			detail: {
				imageId: idResult.data,
				fields: Object.keys(parsed.data),
				apexStatus: apexResponse.status
			}
		});
	}

	if (!apexResponse.ok) {
		const status =
			apexResponse.status >= 400 && apexResponse.status < 500 ? apexResponse.status : 502;
		return noStoreJson({ error: 'upstream error', status: apexResponse.status }, status);
	}

	// RE-READ, not the PATCH's echo. This admin has already shipped one write that
	// Apex answered 200 to and dropped on the floor (phase 3b) and one that 422'd for
	// months behind a stub, so a status code does not count as evidence anywhere in
	// this codebase: the value is written when the READ surface shows it.
	const image = await findImage(guard.apex, idResult.data);
	if (!image) return noStoreJson({ error: 'unexpected upstream shape' }, 502);

	return noStoreJson({ image });
}
