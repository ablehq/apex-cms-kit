import { z } from 'zod';
import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { cleanString, unwrapArchetypeCollection } from '../archetype-record';
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
 * here guesses at their shape: no bytes can be uploaded against this Apex (below),
 * so no shape has been observed, and inventing one would be a thumbnail that
 * silently never renders. See `IMAGE_UPLOAD_ENABLED`.
 */
export const imageIdSchema = z
	.string()
	.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);

/**
 * ⚠ BRING-UP GATE — byte upload is NOT proven and is therefore OFF (spec §2.7).
 *
 * `POST /api/platform/v1/media/signed_upload_url` answers 200 with
 * `{url, headers, signed_id}` (probes G5/G6) — but the `url` it returns points at
 * `http://localhost:3000` while this Apex serves on `:3001`, and a `PUT` to it hung
 * until it was killed. The finalize leg (`POST /media` with the signed id) has
 * therefore never been executed at all: it is marked NOT PROVEN in the probe ledger.
 *
 * The screen shows the Upload button DISABLED and says why, rather than offering a
 * control that would create an empty gallery item and then fail — an editor would be
 * left with a caption attached to no image and no way to tell that from a slow
 * upload. Everything else on the screen (browse, caption, alt, delete) is proven
 * against real local Apex and works.
 *
 * At bring-up: flip this to `true`, confirm the `medium`/`thumbnail` read shape, and
 * surface a thumbnail URL from it. Nothing else on this screen changes.
 */
export const IMAGE_UPLOAD_ENABLED = false;

/** The reason the upload control is off, in the words the editor is shown. */
export const IMAGE_UPLOAD_DISABLED_REASON =
	'Uploading is not switched on yet. The storage service this CMS uploads to is not reachable from here, so an upload would appear to start and never finish. Captions, alt text and deletion all work.';

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
	assetsPrefix = ''
): AdminGalleryImageRecord {
	const medium = isPlainRecord(row.medium) ? row.medium : null;
	const file = medium && isPlainRecord(medium.file) ? medium.file : null;
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
		url: assetsPrefix && key ? `${assetsPrefix}/cdn-cgi/image/f=auto,w=auto/${key}` : null
	};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The account's `images` gallery id, resolved by name from `cms_config`. */
export async function readImagesGalleryId(apex: ApexAdminClient): Promise<string | null> {
	const config = await apex.readCmsConfig();
	if (!config.ok) return null;
	const body = config.body as { data?: unknown } | null;
	const data = (body?.data ?? body) as { asset_library?: unknown } | null;
	const entries = Array.isArray(data?.asset_library) ? data.asset_library : [];
	for (const entry of entries) {
		const gallery = (entry as { gallery?: { id?: unknown; name?: unknown } }).gallery;
		if (cleanString(gallery?.name) === 'images') {
			const id = cleanString(gallery?.id);
			if (imageIdSchema.safeParse(id).success) return id;
		}
	}
	return null;
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
	assetsPrefix = ''
): Promise<{ galleryId: string; images: AdminGalleryImageRecord[] } | null> {
	const galleryId = await readImagesGalleryId(apex);
	if (!galleryId) return null;

	const listed = await apex.listGalleryItems(galleryId);
	if (!listed.ok) return null;

	const images = unwrapArchetypeCollection(listed.body)
		.map((row) => summarizeGalleryImage(row, assetsPrefix))
		.filter((image) => image.id.length > 0)
		// Newest first, like every other collection in this admin. `position` is what
		// Apex sorts a gallery by for RENDERING; the library screen is a filing
		// cabinet, and the thing an editor just added should be at the top of it.
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

	return { galleryId, images };
}

/** The item with this id, only if it is in the IMAGES gallery. `null` otherwise. */
export async function findImage(
	apex: ApexAdminClient,
	imageId: string,
	assetsPrefix = ''
): Promise<AdminGalleryImageRecord | null> {
	const gallery = await loadImagesGallery(apex, assetsPrefix);
	if (!gallery) return null;
	return gallery.images.find((image) => image.id === imageId) ?? null;
}

export async function handleListImages(request: Request, ctx: BffContext): Promise<Response> {
	const guard = await guardRequest(request, ctx, { mutation: false });
	if (!guard.ok) return guard.response;

	// The site's CDN prefix, when it has one: with it the picker browses thumbnails,
	// without it the ids, which is what it did before any site could resolve a URL.
	const gallery = await loadImagesGallery(guard.apex, ctx.assetsPrefix ?? '');
	if (!gallery) return bffError(502, 'upstream error');

	// The gate travels WITH the data, so the button's state is a server fact rather
	// than a guess the browser makes about an environment it cannot see.
	return noStoreJson({
		images: gallery.images,
		galleryId: gallery.galleryId,
		uploadEnabled: IMAGE_UPLOAD_ENABLED,
		uploadDisabledReason: IMAGE_UPLOAD_ENABLED ? '' : IMAGE_UPLOAD_DISABLED_REASON
	});
}
