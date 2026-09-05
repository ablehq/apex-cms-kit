import { z } from 'zod';
import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { cleanString, isRecord, unwrapArchetypeCollection } from '../archetype-record';
import type { ApexAdminClient } from '../apex-admin-client';
import type { BffContext } from '../context';

/**
 * GET /api/admin/images — the asset library's `images` gallery (spec §2.7, §4.2).
 *
 * This module also owns the three things every other image operation needs, so
 * there is exactly one answer to "which gallery, and which items are in it":
 * `imageIdSchema`, `readImagesGalleryId` and `loadImagesGallery`.
 *
 * ── THE GALLERY ID IS NEVER A LITERAL ──────────────────────────────────────────
 * `cms_config` names three galleries — `images`, `videos`, `files` — and their ids
 * are ACCOUNT-SCOPED (risk R14). The dev account's images gallery is
 * `3b2c7541-…`; production's is a different uuid, so a hard-coded id is a screen
 * that works locally and reads an empty (or someone else's) gallery in production.
 * It is resolved by NAME from `cms_config` on every request, exactly as the
 * snapshot pipeline resolves it.
 *
 * ── WHY MEMBERSHIP IS CHECKED AND NOT ASSUMED ──────────────────────────────────
 * `PATCH /cms/gallery_items/:id` and `DELETE /cms/gallery_items/:id` address an item
 * by id alone: Apex is perfectly willing to let the Images screen edit or delete a
 * VIDEO or a FILE, because as far as it is concerned they are the same kind of row
 * in a different gallery. Nothing upstream scopes them. So `loadImagesGallery`
 * exists and every write goes through it: an id that is not in the images gallery is
 * a 404 from this admin, which makes "the Images screen can only touch images" a
 * property of the code rather than of the caller's good manners.
 *
 * ── WHAT AN IMAGE IS, READ OFF REAL APEX ───────────────────────────────────────
 * Probe G2, an item with no bytes attached:
 *
 *   { id, gallery_id, position, caption, alt, taggings: [], created_at, updated_at }
 *
 * `medium` and `thumbnail` are `has_one … as: :record` and are simply ABSENT until
 * something is attached — they are not null keys, they are missing keys. Nothing
 * here guesses at their shape: no bytes have been uploaded against this Apex, so no
 * shape has been observed, and inventing one would be a thumbnail that silently
 * never renders.
 */
export const imageIdSchema = z
	.string()
	.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);

/** One row of the Images list. */
export interface AdminGalleryImageRecord {
	id: string;
	galleryId: string;
	caption: string;
	alt: string;
	position: number;
	createdAt: string;
	/**
	 * A thumbnail to draw, when the site can compose one. `null` is the honest
	 * answer for a deployment with no assets prefix — the picker then shows the id,
	 * which is what it did before any site could resolve a URL.
	 */
	url: string | null;
}

/** Normalize one `Cms::GalleryItem`. Rows without an id are dropped, not rendered blank. */
export function summarizeGalleryImage(
	row: Record<string, unknown>,
	assetsPrefix = '',
	gallery: string = 'images'
): AdminGalleryImageRecord {
	const medium = isRecord(row.medium) ? row.medium : null;
	const file = medium && isRecord(medium.file) ? medium.file : null;
	const key = file ? cleanString(file.key) : '';
	return {
		id: cleanString(row.id),
		galleryId: cleanString(row.gallery_id),
		caption: cleanString(row.caption),
		alt: cleanString(row.alt),
		position: typeof row.position === 'number' ? row.position : 0,
		createdAt: cleanString(row.created_at),
		// The same transform the public pages use, so the picker shows what the site
		// will show.
		// A Cloudflare IMAGE transform — meaningless for a PDF or an MP4, so only images
		// get a thumbnail URL. The other galleries carry the key and no URL.
		url:
			assetsPrefix && key && gallery === 'images'
				? `${assetsPrefix}/cdn-cgi/image/f=auto,w=auto/${key}`
				: null
	};
}

/** The account's `images` gallery id, resolved by name from `cms_config`. */
/** The galleries `cms_config` names, and the only ones a screen may address. */
export const GALLERY_NAMES = Object.freeze(['images', 'videos', 'files'] as const);

/**
 * Resolve ONE gallery's id by NAME from `cms_config`, on every request (the ids are
 * account-scoped — risk R14). `gallery` defaults to `images` so every shipped caller
 * is unchanged; an unknown name resolves to null, never to the images gallery.
 */
export async function readGalleryId(
	apex: ApexAdminClient,
	gallery: string = 'images'
): Promise<string | null> {
	if (!(GALLERY_NAMES as readonly string[]).includes(gallery)) return null;
	const config = await apex.readCmsConfig();
	if (!config.ok) return null;
	const body = config.body as { data?: unknown } | null;
	const data = (body?.data ?? body) as { asset_library?: unknown } | null;
	const entries = Array.isArray(data?.asset_library) ? data.asset_library : [];
	for (const entry of entries) {
		const entryGallery = (entry as { gallery?: { id?: unknown; name?: unknown } }).gallery;
		if (cleanString(entryGallery?.name) === gallery) {
			const id = cleanString(entryGallery?.id);
			if (imageIdSchema.safeParse(id).success) return id;
		}
	}
	return null;
}

/** The images gallery's id — the original name, kept for its positional callers. */
export function readImagesGalleryId(apex: ApexAdminClient): Promise<string | null> {
	return readGalleryId(apex, 'images');
}

/**
 * The images gallery and its items, sorted the way the screen shows them.
 *
 * `null` means the gallery itself could not be read, which is an upstream fault —
 * distinct from an images gallery that is simply empty (an empty array), because
 * the screen says something different about each.
 */
export async function loadImagesGallery(
	apex: ApexAdminClient,
	assetsPrefix = '',
	gallery: string = 'images'
): Promise<{ galleryId: string; images: AdminGalleryImageRecord[] } | null> {
	const galleryId = await readGalleryId(apex, gallery);
	if (!galleryId) return null;

	const listed = await apex.listGalleryItems(galleryId);
	if (!listed.ok) return null;

	const images = unwrapArchetypeCollection(listed.body)
		.map((row) => summarizeGalleryImage(row, assetsPrefix, gallery))
		.filter((image) => image.id.length > 0)
		// Newest first, like every other collection in this admin. `position` is what
		// Apex sorts a gallery by for RENDERING; the library screen is a filing
		// cabinet, and the thing an editor just added should be at the top of it.
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

	return { galleryId, images };
}

/**
 * The item with this id, only if it is in the REQUESTED gallery (`images` by default).
 * Apex addresses items by id alone, so this membership check is the only thing that
 * stops the files screen editing an image, or vice versa.
 *
 * TWO checks, not one. The list is read with `q[gallery_id_eq]`, but a filter is
 * a request, not a proof: a code review proved by mutation (2026-09-05) that
 * against an Apex which ignored the filter, an item from another gallery came
 * back in the list, matched by id, and was written upstream through the wrong
 * route. So the row's OWN `gallery_id` — which `summarizeGalleryImage` already
 * carries as `galleryId` — must also equal the gallery id resolved by name. A row
 * Apex returns from the wrong gallery is refused whatever the filter did.
 */
export async function findImage(
	apex: ApexAdminClient,
	imageId: string,
	assetsPrefix = '',
	gallery: string = 'images'
): Promise<AdminGalleryImageRecord | null> {
	const loaded = await loadImagesGallery(apex, assetsPrefix, gallery);
	if (!loaded) return null;
	return (
		loaded.images.find((image) => image.id === imageId && image.galleryId === loaded.galleryId) ??
		null
	);
}

export async function handleListImages(
	request: Request,
	ctx: BffContext,
	options: { gallery?: string } = {}
): Promise<Response> {
	const gallery = options.gallery ?? 'images';
	const guard = await guardRequest(request, ctx, { mutation: false });
	if (!guard.ok) return guard.response;
	if (!(GALLERY_NAMES as readonly string[]).includes(gallery))
		return bffError(404, 'no such gallery');

	// The site's CDN prefix, when it has one: with it the picker browses thumbnails,
	// without it the ids, which is what it did before any site could resolve a URL.
	const loaded = await loadImagesGallery(guard.apex, ctx.assetsPrefix ?? '', gallery);
	if (!loaded) return bffError(502, 'upstream error');
	// `images` stays as the key the shipped browser client reads; `items` is the honest
	// name for a files or videos listing and carries the same rows.
	return noStoreJson({
		gallery,
		galleryId: loaded.galleryId,
		images: loaded.images,
		items: loaded.images
	});
}
