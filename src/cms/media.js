/**
 * Media ids resolved through the snapshot's media map.
 *
 * A media field stores a gallery-item id string (`ref/model/Cms::GalleryItem`,
 * §2 fact 4); the URL lives in the asset-library collections `cms:setup` writes
 * — `images.json`, `files.json`, `videos.json`. This turns one into the other.
 *
 * Honest limit ✎: the dev account has no gallery items at all (all three files
 * are `[]`), so this is written against the shape the same endpoint returns in
 * keus-cms — a record keyed by `record_id` when it describes a `Cms::GalleryItem`
 * and by its own `id` otherwise, carrying a signed `url`. It is indexed under
 * both keys for that reason. No block component in this phase has a media field
 * (`glc-hero`'s logo is the first), so the first real consumer arrives with the
 * hero and should re-check the shape against live data then.
 */

/** @param {unknown} value */
function mediaRecordUrl(value) {
	const record = /** @type {Record<string, any>} */ (value);
	for (const candidate of [record.url, record.file?.url, record.file?.signed_url]) {
		if (typeof candidate === 'string' && candidate !== '') return candidate;
	}
	return '';
}

/**
 * @param {Array<unknown>} collections each an asset-library collection
 * @returns {Map<string, { url: string, alt: string, contentType: string }>}
 */
export function buildMediaIndex(collections) {
	/** @type {Map<string, { url: string, alt: string, contentType: string }>} */
	const index = new Map();
	for (const collection of collections) {
		if (!Array.isArray(collection)) continue;
		for (const item of collection) {
			if (!item || typeof item !== 'object') continue;
			const record = /** @type {Record<string, any>} */ (item);
			const url = mediaRecordUrl(record);
			if (!url) continue;
			const entry = {
				url,
				alt: typeof record.alt_text === 'string' ? record.alt_text : '',
				contentType: typeof record.file?.content_type === 'string' ? record.file.content_type : ''
			};
			for (const key of [record.record_id, record.id]) {
				// First writer wins, so a gallery item's own record is not
				// overwritten by an attachment that happens to share an id.
				if (typeof key === 'string' && key !== '' && !index.has(key)) index.set(key, entry);
			}
		}
	}
	return index;
}

