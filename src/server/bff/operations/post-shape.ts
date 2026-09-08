import { z } from 'zod';
import { bffError, noStoreJson } from '../boundary';
import { canonicalize } from '../../../cms/canonical-json.js';
import { sanitizeHtml } from '../../../sanitize/html.js';
import { MAX_FIELD_VALUE_CHARS } from '../../../sanitize/write-boundary';
import {
	archetypeIdSchema,
	cleanString,
	isRecord,
	readPrimitiveValue,
	readReferences,
	readTaggings,
	readUpdatedAt,
	unwrapArchetypeCollection,
	unwrapArchetypeRecord
} from '../archetype-record';
import type { ArchetypeReference, ArchetypeTagging } from '../archetype-record';
import type { ApexAdminClient } from '../apex-admin-client';
import type { ArchetypeSchema, ContentContract } from '../content-contract';
import { loadReferenceTargets } from './list-records';
import type { AdminRecord } from './record-shape';

/**
 * What one POST is, on the wire between the BFF and the browser, and the shared
 * machinery every post operation reads Apex through. The generalisation of GLC's
 * `get-article.ts` + `save-body-article.ts`, parameterised on the schema slug and
 * widened for what a Godrej post carries that an article does not (plan 04, G1).
 *
 * A POST IS THREE RECORDS, addressed in THREE id spaces:
 *
 *   - a `Cms::Post`                — title / slug / summary / published_date /
 *                                    status / the SEO triple / the COVER
 *                                    (`shared_gallery_items`);           by POST id
 *   - a `Specification::Archetype` — the PRIMITIVES (a story's `kind`) and the
 *                                    REFERENCES (author, focus_area, partner),
 *                                    and the TAGGINGS;               by ARCHETYPE id
 *   - a `Cms::Document`            — the body blocks;                by DOCUMENT id
 *
 * …and the blocks are a FOURTH id space, with two halves. Every block has an
 * OUTER id (`cms_document_blocks.id`, what `position` and `_destroy` address) and
 * an INNER `blockable.id` (the `RichText` / `Quote` / `Divider` / `GalleryItem`
 * row, `document_block.rb:7-17`), which an in-place update must name in
 * `blockable_attributes.id` — omit it and Apex mints a fresh inner row on every
 * save while the outer id holds, so the churn is invisible from the outside.
 *
 * `postId` is what every route is addressed by, because it is what the list
 * links on and what the status and field writes take. The archetype id and the
 * document id are resolved HERE from Apex's own `post_archetype_views` record
 * and never taken from the client — so no caller can point a reference write or
 * a delete at another post's archetype by supplying its id. And the view is read
 * through the SCHEMA-SCOPED list, so a story's id addressed through the update
 * route finds nothing (measured 2026-09-05: `q[id_eq]` under the other slug → 0
 * rows), which is the cross-schema refusal.
 *
 * MEASURED against local Apex on 2026-09-05, each the reason for a line below:
 *
 *   - `post_archetype_views` carries the post, `archetype_id`, `archetype`
 *     WITHOUT its items, `document` WITHOUT its blocks, `meta_properties` (three
 *     `web` rows minted at create) and `shared_gallery_items` (each with its own
 *     join id). So the archetype costs one read and the body one read, per post.
 *   - `specification/archetypes/search_and_filter` for a post schema carries
 *     `archetype_items`, `taggings` and `target_model_id` — the list read that
 *     keeps the list screen from being N+1.
 *   - a `shared_gallery_items_attributes` entry without an id APPENDS a second
 *     cover; with the existing id it updates in place; `_destroy` removes it. The
 *     same id-or-append hazard as the SEO rows, handled the same way.
 *   - `posts.updated_at` does NOT move when a cover is written, and an
 *     `archetype_item` write does not touch the archetype's `updated_at`. So the
 *     stale-save token hashes the references, the cover and the taggings
 *     themselves, not only the timestamps (see `computePostVersion`).
 */

export const postIdSchema = archetypeIdSchema;

/** The SEO triple `Cms::Post#create_meta_properties` mints in group `web` at create. */
export const META_NAMES = ['title', 'description', 'keywords'] as const;

/**
 * The FOUR `Cms::DocumentBlock` subclasses an editor can author here.
 *
 * `Cms::DocumentBlock::Video`, `Cms::DocumentBlock::Spacer`,
 * `Cms::DocumentBlock::Entity` and the LEGACY `Cms::DocumentBlock::Image` are
 * PASSTHROUGHS: they are not returned to the editor, they are never destroyed by a
 * save, and their positions are restated rather than assumed. The legacy `Image`
 * block (its own `Medium`, `image.rb:2`) is a different table from the `image`
 * kind below, which is a `GalleryItem` block pointing at a row in the account's
 * images gallery — a distinction worth naming because the two would otherwise
 * read as the same thing.
 */
export const BLOCK_TYPE_RICH_TEXT = 'Cms::DocumentBlock::RichText';
export const BLOCK_TYPE_QUOTE = 'Cms::DocumentBlock::Quote';
export const BLOCK_TYPE_DIVIDER = 'Cms::DocumentBlock::Divider';
export const BLOCK_TYPE_GALLERY_ITEM = 'Cms::DocumentBlock::GalleryItem';

/** `Cms::DocumentBlock::Divider#kind` — the only three Apex validates (`divider.rb:2-3`). */
export const DIVIDER_KINDS = ['small', 'medium', 'large'] as const;
export type DividerKind = (typeof DIVIDER_KINDS)[number];

/**
 * What a divider with no stored `kind` reads as, and what the editor sends for a
 * new one. `kind` is `allow_nil` upstream, so a null would round-trip as a
 * divider whose size the public renderer has to guess; it guesses `medium`
 * (Poovayya's article page), so this is that guess, made once, on the way out.
 */
export const DEFAULT_DIVIDER_KIND: DividerKind = 'medium';

/** The `shared_gallery_items.kind` the public loaders read the cover from. */
const COVER_KIND = 'cover';

/**
 * Apex's own 422 body, read: `{ data: [{ attribute_name, messages: [] }] }`. What the
 * browser is handed on a rejected write, so the editor is told which field and
 * why — a rejected cover or a bad `published_date` is not a slug problem, and was
 * being reported as one.
 */
export interface ApexValidationError {
	attribute: string;
	messages: string[];
}

export function apexValidationErrors(body: unknown): ApexValidationError[] {
	const data = (body as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) return [];
	const errors: ApexValidationError[] = [];
	for (const row of data) {
		if (!isRecord(row)) continue;
		const attribute = cleanString(row.attribute_name);
		const messages = Array.isArray(row.messages)
			? row.messages.filter((m): m is string => typeof m === 'string')
			: [];
		if (attribute) errors.push({ attribute, messages });
	}
	return errors;
}

/**
 * The response for an Apex 422: `409 slug-taken` ONLY when the errors name the
 * slug — the one case an editor fixes by changing the address — and otherwise
 * `422 invalid` carrying Apex's errors so the screen can say which field.
 */
export function rejectedWriteResponse(body: unknown): Response {
	const errors = apexValidationErrors(body);
	if (errors.some((error) => error.attribute === 'slug')) return bffError(409, 'slug-taken');
	return noStoreJson({ error: 'invalid', code: 'invalid', errors }, 422);
}

// The paginator moved to `../paginate` so the pages list shares it; re-exported
// here because the post list and its tests import it from this module.
export { listAllPages } from '../paginate';

/** The schema, only if it is a POST schema — the one kind these operations serve. */
export function postSchemaOf(contract: ContentContract, slug: string): ArchetypeSchema | null {
	const schema = contract.schema(slug);
	return schema && schema.target_model === 'Cms::Post' ? schema : null;
}

/**
 * One body block, as the editor edits it — a DISCRIMINATED UNION on `kind`, and
 * the outbound shape is the inbound shape.
 *
 * The draft holds what the server handed it verbatim and sends it back verbatim
 * into a `.strict()` schema, so a read-only convenience key (an image's caption,
 * say) added here would be refused on the very next save. The editor resolves an
 * image's caption and thumbnail from the images list it already loads, not from
 * the block.
 */
export interface AdminRichTextBlock {
	id: string | null;
	kind: 'rich_text';
	html: string;
}

export interface AdminQuoteBlock {
	id: string | null;
	kind: 'quote';
	quote: string;
	quotedBy: string;
}

export interface AdminDividerBlock {
	id: string | null;
	kind: 'divider';
	dividerKind: DividerKind;
}

export interface AdminImageBlock {
	id: string | null;
	kind: 'image';
	/**
	 * `cms_document_block_gallery_items.gallery_item_id` — a real, NULLABLE,
	 * unvalidated FK (`gallery_item.rb:2`, migration `:5`). `null` is a block
	 * upstream has that points at nothing; the editor shows it as a missing image
	 * and offers the picker. A NEW or CHANGED image block may not be null.
	 */
	galleryItemId: string | null;
}

export type AdminPostBlock =
	AdminRichTextBlock | AdminQuoteBlock | AdminDividerBlock | AdminImageBlock;

/** One block as APEX holds it — what the body reconciliation needs and the browser never sees. */
export interface ApexBlockRow {
	id: string;
	position: number;
	blockableType: string;
	blockableId: string;
	/**
	 * The GalleryItem block's stored item id, or `null` for every other kind AND for
	 * a GalleryItem block that points at nothing. Carried so the body save can tell
	 * a NEW or CHANGED image block (which must name a member of the images gallery)
	 * from an unchanged one (which must not cost a gallery read).
	 */
	galleryItemId: string | null;
}

export interface AdminPostMeta {
	title: string;
	description: string;
	keywords: string;
}

/** A post as the admin sees it. */
export interface AdminPost {
	id: string;
	archetypeId: string;
	documentId: string;
	title: string;
	slug: string;
	summary: string;
	status: string;
	publishedDate: string;
	updatedAt: string;
	/** The archetype primitives the contract names (a story's `kind`), UNNARROWED. */
	fields: Record<string, unknown>;
	/** Reference relations by item name — both ids, as `AdminRecord.references`. */
	references: Record<string, ArchetypeReference[]>;
	/** Tag associations; `id` is the TAGGING id. */
	tags: ArchetypeTagging[];
	/** The cover's gallery item id, or null. */
	coverId: string | null;
	meta: AdminPostMeta;
	blocks: AdminPostBlock[];
}

/**
 * Apex stores `published_date` as a full timestamp (`2026-07-01T00:00:00.000Z`) and
 * accepts a bare `2026-07-01` on the way back in. The editor's field is a date, so
 * the date is what it is shown and what it sends; anything unparseable passes
 * through unchanged rather than being blanked.
 */
export function normalizeDate(value: unknown): string {
	const text = cleanString(value);
	if (!text) return '';
	const match = /^(\d{4}-\d{2}-\d{2})/u.exec(text);
	return match ? match[1] : text;
}

/**
 * Whether a `YYYY-MM-DD` string names a day that exists. `''` (the clear) passes.
 *
 * `Cms::Post` has NO validation on `published_date` (`post.rb`), so Rails casts
 * what it cannot parse to `nil`: `2026-13-45` and `2026-02-30` both pass a shape
 * regex, reach Apex, answer 200 and CLEAR the date the editor was trying to
 * change. The regex is the shape; this is the calendar.
 */
export function isCalendarDate(value: string): boolean {
	if (value === '') return true;
	const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (month < 1 || month > 12 || day < 1 || day > 31) return false;
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
	);
}

/** `publishedDate` on both post write schemas: the shape AND the calendar. One definition. */
export const publishedDateSchema = z
	.string()
	.regex(/^(?:\d{4}-\d{2}-\d{2})?$/u)
	.refine(isCalendarDate, { message: 'not a calendar date' });

/**
 * The one post record, read through the SCHEMA-SCOPED list, filtered by the slug
 * — fixed, last — so `q[id_eq]` can only ever select a post of THIS schema. That
 * scoping is the cross-schema refusal, and it is why the list is used even where a
 * direct read would work.
 *
 * `GET /cms/posts/:id` is NOT used, and the reason has changed. GLC measured it
 * 403 for its staff token on 2026-07-31 (`get-article.ts:35-40`); on Poovayya's
 * tenant it answers 200 for role `store-admin` (measured 2026-09-08). So it is not
 * universally forbidden — it is simply not SCOPED, and an unscoped read by id is
 * exactly what would let a post of one schema be loaded through another schema's
 * route. Do not "optimise" this into a direct read.
 */
export async function loadPostView(
	apex: ApexAdminClient,
	slug: string,
	postId: string
): Promise<Record<string, unknown> | null> {
	const response = await apex.listPosts(slug, { 'q[id_eq]': postId, per_page: 1 });
	if (!response.ok) return null;
	const rows = unwrapArchetypeCollection(response.body);
	return rows.find((row) => cleanString(row.id) === postId) ?? null;
}

/** The three ids a post is made of, read from Apex's record and never from a caller. */
export function readPostIds(view: Record<string, unknown>): {
	postId: string;
	archetypeId: string;
	documentId: string;
} {
	const document = isRecord(view.document) ? view.document : null;
	return {
		postId: cleanString(view.id),
		archetypeId: cleanString(view.archetype_id),
		documentId: document ? cleanString(document.id) : ''
	};
}

/** The archetype half — primitives, references, taggings — or null when it will not read. */
export async function readPostArchetype(
	apex: ApexAdminClient,
	slug: string,
	archetypeId: string
): Promise<Record<string, unknown> | null> {
	if (!archetypeId) return null;
	const response = await apex.getPostArchetype(slug, archetypeId);
	if (!response.ok) return null;
	return unwrapArchetypeRecord(response.body);
}

/** The `web`-group SEO triple, as the editor edits it. Missing rows read as `''`. */
export function readMeta(view: Record<string, unknown>): AdminPostMeta {
	const meta: AdminPostMeta = { title: '', description: '', keywords: '' };
	const rows = Array.isArray(view.meta_properties) ? view.meta_properties : [];
	for (const row of rows) {
		if (!isRecord(row)) continue;
		if (cleanString(row.group) !== 'web') continue;
		const name = cleanString(row.name);
		if (name === 'title' || name === 'description' || name === 'keywords') {
			// First row wins: a no-id write can leave a DUPLICATE row behind (measured),
			// and Apex returns them in creation order, so the original is the one to show.
			if (!meta[name]) meta[name] = cleanString(row.value);
		}
	}
	return meta;
}

/**
 * `meta_properties_attributes` rows, keyed by the EXISTING row's id.
 *
 * The id is not optional. Measured on real local Apex: an entry with a name but
 * no id creates a SECOND row with the same name rather than updating the first,
 * and the post then carries two `title` metas forever. So the write is built
 * from the ids Apex already gave us, and a name with no existing row is skipped
 * rather than invented — `Cms::Post` mints all three at create time, so a missing
 * row means something else is wrong and quietly adding a fourth would hide it.
 */
export function metaAttributes(
	view: Record<string, unknown>,
	changes: Partial<AdminPostMeta>
): Record<string, unknown>[] {
	const rows = Array.isArray(view.meta_properties) ? view.meta_properties : [];
	const attributes: Record<string, unknown>[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		if (!isRecord(row)) continue;
		if (cleanString(row.group) !== 'web') continue;
		const name = cleanString(row.name);
		const id = cleanString(row.id);
		if (!id) continue;
		if (seen.has(name)) {
			// A SECOND row of the same name is what a no-id write left behind; `readMeta`
			// shows the first, so the extra is invisible until it is not. Healed here,
			// the way `coverAttributes` heals a duplicate cover row.
			//
			// NOTE: the culling applies to EVERY name in group `web`, not only the three
			// in META_NAMES. That is safe today because Apex mints exactly title,
			// description and keywords in group `web` and nothing else writes there;
			// should another `web` meta ever appear, its duplicates would be culled by
			// the same rule — deliberate, since a duplicate is wrong whatever its name.
			attributes.push({ id, _destroy: true });
			continue;
		}
		seen.add(name);
		const next = changes[name as (typeof META_NAMES)[number]];
		if (next === undefined) continue;
		attributes.push({ id, name, group: 'web', value_type: 'string', value: next });
	}
	return attributes;
}

/** The cover rows as Apex holds them: the join id and the gallery item it points at. */
function readCoverRows(view: Record<string, unknown>): { id: string; galleryItemId: string }[] {
	const rows = Array.isArray(view.shared_gallery_items) ? view.shared_gallery_items : [];
	const covers: { id: string; galleryItemId: string }[] = [];
	for (const row of rows) {
		if (!isRecord(row)) continue;
		if (cleanString(row.kind) !== COVER_KIND) continue;
		const id = cleanString(row.id);
		const galleryItemId = cleanString(row.gallery_item_id);
		if (id && galleryItemId) covers.push({ id, galleryItemId });
	}
	return covers;
}

/** The cover's gallery item id — the FIRST `cover` row, as the public loaders read it. */
export function readCoverId(view: Record<string, unknown>): string | null {
	return readCoverRows(view)[0]?.galleryItemId ?? null;
}

/**
 * `shared_gallery_items_attributes` for "the cover is now this gallery item, or
 * none" — the id-or-append hazard handled the way `metaAttributes` handles SEO.
 *
 * Measured 2026-09-05: an entry without an id APPENDS a second cover row; an
 * entry with the existing row's id updates it in place; `{id, _destroy: true}`
 * removes it. So: the first existing row is UPDATED (or destroyed), every extra
 * cover row a previous append left behind is destroyed, and a row is created only
 * when none exists. `null` means "nothing to send".
 */
export function coverAttributes(
	view: Record<string, unknown>,
	coverId: string | null
): Record<string, unknown>[] | null {
	const rows = readCoverRows(view);
	const attributes: Record<string, unknown>[] = [];
	const [first, ...extras] = rows;
	for (const row of extras) attributes.push({ id: row.id, _destroy: true });
	if (coverId === null) {
		if (first) attributes.push({ id: first.id, _destroy: true });
	} else if (first) {
		if (first.galleryItemId !== coverId) {
			attributes.push({ id: first.id, gallery_item_id: coverId, kind: COVER_KIND });
		}
	} else {
		attributes.push({ gallery_item_id: coverId, kind: COVER_KIND });
	}
	return attributes.length > 0 ? attributes : null;
}

/**
 * Apex's block rows for a document, in position order — or `null` when the read
 * FAILED.
 *
 * THIS USED TO FAIL OPEN, and it was the most expensive bug in the post layer.
 * It answered `[]` for a failed read, which is indistinguishable from an empty
 * document, and `handleSavePostBody` diffs the desired body against exactly that:
 * every block the editor sent became an id-less CREATE, the document DOUBLED, and
 * the editor was told 200. The two read callers hashed the same empty answer into
 * a stale-guard token, so the next save agreed with it.
 *
 * `null` is therefore load-bearing and every caller must branch on it: before a
 * write it is `502` with nothing dispatched; after one it is write-uncertain
 * (`save-post-body.ts`); on a read it is `502`, never a 200 with an empty body and
 * never a 404 (a 404 makes an editor's Reload build a draft out of `undefined`).
 *
 * A transport THROW counts as a failed read, not as a crash: the Apex client's
 * methods reject on a network fault, and an exception escaping here would have
 * become a 500 with no audit row.
 */
export async function readDocumentBlocks(
	apex: ApexAdminClient,
	documentId: string
): Promise<Record<string, unknown>[] | null> {
	if (!documentId) return null;
	let response;
	try {
		response = await apex.getDocument(documentId);
	} catch {
		return null;
	}
	if (!response.ok) return null;
	const record = unwrapArchetypeRecord(response.body);
	const blocks = record && Array.isArray(record.blocks) ? record.blocks : [];
	return blocks
		.filter(isRecord)
		.slice()
		.sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));
}

/** Apex's block rows reduced to the ids and payload keys the body reconciliation addresses. */
export function apexBlockRows(blocks: Record<string, unknown>[]): ApexBlockRow[] {
	return blocks.map((block) => {
		const blockable = isRecord(block.blockable) ? block.blockable : null;
		const type = cleanString(block.blockable_type);
		return {
			id: cleanString(block.id),
			position: Number(block.position ?? 0),
			blockableType: type,
			blockableId: blockable ? cleanString(blockable.id) : '',
			galleryItemId:
				type === BLOCK_TYPE_GALLERY_ITEM ? cleanString(blockable?.gallery_item_id) || null : null
		};
	});
}

/**
 * Apex's blocks as the editor edits them.
 *
 * `content_html` is SANITIZED on the way out as well as on the way in: the stored
 * value is rendered with `{@html}` on the public site, and the admin is a
 * first-party way to get HTML into that sink — one sanitizer, two consumers.
 *
 * FOUR editable kinds are returned: `rich_text`, `quote`, `divider` and `image`
 * (a `Cms::DocumentBlock::GalleryItem` pointing at a row in the images gallery).
 * A block of ANY OTHER `blockable_type` — `Video`, `Spacer`, `Entity` and the
 * LEGACY `Image`, which is its own `Medium` and not this `image` kind — is NOT
 * returned. That is deliberate and it is paired with the body write, which never
 * destroys a block it did not hand out: an editor cannot edit one of those here,
 * and cannot silently delete one either. It survives a save untouched, with only
 * its position restated.
 */
export function normalizeBlocks(blocks: Record<string, unknown>[]): AdminPostBlock[] {
	const out: AdminPostBlock[] = [];
	for (const block of blocks) {
		const blockable = isRecord(block.blockable) ? block.blockable : null;
		const type = cleanString(block.blockable_type);
		const id = cleanString(block.id) || null;
		if (type === BLOCK_TYPE_RICH_TEXT) {
			out.push({ id, kind: 'rich_text', html: sanitizeHtml(blockable?.content_html) });
		} else if (type === BLOCK_TYPE_QUOTE) {
			out.push({
				id,
				kind: 'quote',
				quote: cleanString(blockable?.quote),
				// `quoted_by` is the real attribution field.
				quotedBy: cleanString(blockable?.quoted_by)
			});
		} else if (type === BLOCK_TYPE_DIVIDER) {
			const stored = cleanString(blockable?.kind);
			out.push({
				id,
				kind: 'divider',
				dividerKind: (DIVIDER_KINDS as readonly string[]).includes(stored)
					? (stored as DividerKind)
					: DEFAULT_DIVIDER_KIND
			});
		} else if (type === BLOCK_TYPE_GALLERY_ITEM) {
			out.push({
				id,
				kind: 'image',
				galleryItemId: cleanString(blockable?.gallery_item_id) || null
			});
		}
	}
	return out;
}

const blockIdShape = { id: postIdSchema.nullable().optional() };

/**
 * One block on the wire in, per kind, each `.strict()`.
 *
 * A DISCRIMINATED union rather than one open object: with a single shape, a
 * `quote` carrying an `html` key and a `divider` carrying nothing at all both
 * parsed, and the write silently invented the missing half. Now the key set is
 * exact per kind, and the outbound shape (`AdminPostBlock`) is this shape, so a
 * round-trip of what the server handed out always parses.
 */
const blockSchema = z.discriminatedUnion('kind', [
	z
		.object({
			...blockIdShape,
			kind: z.literal('rich_text'),
			html: z.string().max(MAX_FIELD_VALUE_CHARS).optional()
		})
		.strict(),
	z
		.object({
			...blockIdShape,
			kind: z.literal('quote'),
			quote: z.string().max(20_000).optional(),
			quotedBy: z.string().max(300).optional()
		})
		.strict(),
	z
		.object({
			...blockIdShape,
			kind: z.literal('divider'),
			// Always sent — a divider with no size is a divider whose size the renderer
			// guesses, and the guess belongs on the read (`DEFAULT_DIVIDER_KIND`).
			dividerKind: z.enum(DIVIDER_KINDS)
		})
		.strict(),
	z
		.object({
			...blockIdShape,
			kind: z.literal('image'),
			// Nullable, because a row upstream may point at nothing and must round-trip;
			// `handleSavePostBody` is what refuses a null on a NEW or CHANGED block.
			galleryItemId: archetypeIdSchema.nullable()
		})
		.strict()
]);

export const savePostBodySchema = z
	.object({
		blocks: z.array(blockSchema).max(200),
		/**
		 * The `bodyVersion` this editor loaded — see `computeBodyVersion`. Required:
		 * optional would mean a client could opt out of the interleaved-save check by
		 * omitting one key, which is not a check.
		 */
		bodyVersion: z.string().min(1).max(200)
	})
	.strict();

/**
 * The block bodies in an UNVALIDATED save, keyed so a refusal can name the block.
 *
 * `blockSchema.html` carries `.max(MAX_FIELD_VALUE_CHARS)`, which is the same
 * ceiling every other write path enforces — but a zod `.max()` fails as
 * `invalid body`, and an editor who pasted a document into the third block of
 * twelve cannot act on that. This lets `handleSavePostBody` run the SAME
 * `refuseOversizedFields` the record, entity and archetype paths run, before the
 * shape check, so the answer is a typed `field-too-large` naming `blocks[2].html`.
 *
 * Deliberately tolerant of a malformed body: anything that is not an array of
 * objects contributes no key, and the shape check that follows refuses it.
 */
export function blockHtmlValues(body: unknown): Record<string, unknown> {
	const blocks = (body as { blocks?: unknown })?.blocks;
	if (!Array.isArray(blocks)) return {};
	const out: Record<string, unknown> = {};
	blocks.forEach((block, index) => {
		if (!block || typeof block !== 'object' || Array.isArray(block)) return;
		const html = (block as { html?: unknown }).html;
		if (html !== undefined) out[`blocks[${index}].html`] = html;
	});
	return out;
}

export type DesiredBlock = z.infer<typeof blockSchema>;

/** The `blockable_type` an editable kind maps to. */
export function typeOf(kind: AdminPostBlock['kind']): string {
	if (kind === 'quote') return BLOCK_TYPE_QUOTE;
	if (kind === 'divider') return BLOCK_TYPE_DIVIDER;
	if (kind === 'image') return BLOCK_TYPE_GALLERY_ITEM;
	return BLOCK_TYPE_RICH_TEXT;
}

/**
 * The `blockable_attributes` payload for one desired block, sanitized.
 *
 * Every key here is one `documents_controller.rb:20-36` permits: `quote` /
 * `quoted_by`, `kind`, `gallery_item_id`, `editor` / `content_html`. An
 * unpermitted key is dropped by Rails in silence, so this list and that permit
 * are the same list read twice.
 */
function payloadOf(block: DesiredBlock): Record<string, unknown> {
	if (block.kind === 'quote') {
		return { quote: block.quote ?? '', quoted_by: block.quotedBy ?? '' };
	}
	if (block.kind === 'divider') return { kind: block.dividerKind };
	// `null` is sent as `null`: on an unchanged block it is a no-op, and it is the
	// only way an existing null-backed row survives a save with its inner id.
	if (block.kind === 'image') return { gallery_item_id: block.galleryItemId };
	return { editor: 'quilljs', content_html: sanitizeHtml(block.html ?? '') };
}

/** Whether a stored row is one of the four kinds the editor is handed. */
function isEditableRow(row: ApexBlockRow): boolean {
	return (
		row.blockableType === BLOCK_TYPE_RICH_TEXT ||
		row.blockableType === BLOCK_TYPE_QUOTE ||
		row.blockableType === BLOCK_TYPE_DIVIDER ||
		row.blockableType === BLOCK_TYPE_GALLERY_ITEM
	);
}

/**
 * The stored row a desired block UPDATES IN PLACE, or `undefined` when it is a
 * create. One rule, read by `buildBlocksAttributes` and by
 * `changedImageBlocks` — spelling it twice is how the write and the gallery check
 * come to disagree about which blocks are new.
 *
 * An id whose KIND changed is not an update: `blockable_type` is a different
 * table, so it becomes a create plus a destroy.
 */
function matchingRow(
	byId: Map<string, ApexBlockRow>,
	block: DesiredBlock
): ApexBlockRow | undefined {
	const existing = block.id ? byId.get(block.id) : undefined;
	return existing && existing.blockableType === typeOf(block.kind) ? existing : undefined;
}

/**
 * The image blocks a save CREATES or CHANGES — the only ones whose
 * `galleryItemId` has to be checked against the images gallery.
 *
 * A body whose image blocks all point where they already point performs no
 * gallery read at all, which is the difference between one `cms_config` +
 * paginated `gallery_items` walk per save and none.
 */
export function changedImageBlocks(
	current: ApexBlockRow[],
	desired: DesiredBlock[]
): { index: number; galleryItemId: string | null }[] {
	const byId = new Map(current.filter(isEditableRow).map((row) => [row.id, row]));
	const out: { index: number; galleryItemId: string | null }[] = [];
	desired.forEach((block, index) => {
		if (block.kind !== 'image') return;
		const existing = matchingRow(byId, block);
		if (existing && existing.galleryItemId === block.galleryItemId) return;
		out.push({ index, galleryItemId: block.galleryItemId });
	});
	return out;
}

/**
 * Turn "here is the whole body" into the nested-attributes diff Apex actually
 * applies. `PATCH /cms/documents/:id` with `blocks_attributes` is NOT a
 * replacement: an entry with no id creates, an entry with an id updates, and a
 * row simply omitted survives — so a client that sent the whole body twice would
 * DOUBLE it. This keeps by id, creates the id-less, destroys what the editor
 * removed, and never touches a block kind the editor was not shown.
 *
 * POSITIONS COME OUT CONTIGUOUS FROM 0. Passthrough rows hold their slot in
 * document order while the attributes are laid out, and the filled slots are then
 * renumbered `0…n-1` before they are emitted. Without that last step a removal
 * left the numbering sparse — `[A, B, Spacer, C] → [A]` emitted `0, 2` — and
 * nothing upstream renumbers (`document_block.rb` has no callback), so the gaps
 * accumulated save after save.
 */
export function buildBlocksAttributes(
	current: ApexBlockRow[],
	desired: DesiredBlock[]
): Record<string, unknown>[] {
	const isEditable = isEditableRow;
	const ordered = [...current].sort((a, b) => a.position - b.position);
	const editable = ordered.filter(isEditable);
	const byId = new Map(editable.map((row) => [row.id, row]));
	const kept = new Set<string>();

	// POSITIONS ARE ASSIGNED ACROSS EVERY BLOCK, IN DOCUMENT ORDER. A block the
	// editor is not shown (a `Spacer`, a `Video`, a legacy `Image`) keeps its SLOT —
	// the index it held among all blocks — and the editor's blocks fill the
	// remaining slots in the order the editor sent. Numbering only the editable
	// blocks from 0 would leave the passthrough on its old number, so a reorder
	// around it could land two blocks on one position and Apex would order them
	// arbitrarily.
	const slots = new Array<Record<string, unknown> | null>(ordered.length + desired.length).fill(
		null
	);
	ordered.forEach((row, index) => {
		if (!isEditable(row)) slots[index] = { id: row.id, position: index };
	});
	const queue = desired.map((block) => {
		const existing = matchingRow(byId, block);
		if (existing) {
			kept.add(existing.id);
			return {
				id: existing.id,
				blockable_type: existing.blockableType,
				// The INNER id. Omit it and Apex mints a fresh `blockable` row on every
				// save, so the outer block id holds while the row underneath it churns.
				blockable_attributes: { id: existing.blockableId, ...payloadOf(block) }
			};
		}
		return { blockable_type: typeOf(block.kind), blockable_attributes: payloadOf(block) };
	});
	let slot = 0;
	for (const entry of queue) {
		while (slots[slot]) slot += 1;
		slots[slot] = { ...entry, position: slot };
		slot += 1;
	}

	// COMPACT. The slots carry document ORDER; their indices are only as dense as
	// the removals left them. Renumbering here — passthrough rows included, since
	// each already emits its own `{id, position}` row — is what keeps the stored
	// positions `0…n-1` for ever.
	const filled = slots.filter((entry): entry is Record<string, unknown> => Boolean(entry));
	filled.forEach((entry, index) => {
		entry.position = index;
	});

	// Kept and created blocks in position order, then the untouched blocks' own
	// position rows (so a passthrough's number is stated, never assumed), then
	// the destroys.
	const attributes: Record<string, unknown>[] = [];
	const passthrough: Record<string, unknown>[] = [];
	for (const entry of filled) {
		if ('blockable_type' in entry) attributes.push(entry);
		else passthrough.push(entry);
	}
	attributes.push(...passthrough);
	for (const row of editable) {
		if (!kept.has(row.id)) attributes.push({ id: row.id, _destroy: true });
	}
	return attributes;
}

/**
 * Project one post — its view, its archetype and its blocks — into the record the
 * browser edits. The archetype may be null (it would not read); the post is then
 * shown with empty fields and references rather than not at all.
 */
export function summarizePost(
	contract: ContentContract,
	slug: string,
	view: Record<string, unknown>,
	archetype: Record<string, unknown> | null,
	blocks: AdminPostBlock[]
): AdminPost {
	const ids = readPostIds(view);
	const fields: Record<string, unknown> = {};
	for (const def of contract.primitiveFieldDefs(slug)) {
		const value = archetype ? readPrimitiveValue(archetype, def.field_name) : undefined;
		fields[def.field_name] = value === undefined ? '' : value;
	}
	const references: Record<string, ArchetypeReference[]> = {};
	for (const item of contract.referenceItems(slug)) {
		references[item.name] = archetype ? readReferences(archetype, item.name) : [];
	}
	return {
		id: ids.postId,
		archetypeId: ids.archetypeId,
		documentId: ids.documentId,
		title: cleanString(view.title),
		slug: cleanString(view.slug),
		summary: cleanString(view.summary),
		status: cleanString(view.status) || 'draft',
		publishedDate: normalizeDate(view.published_date),
		updatedAt: readUpdatedAt(view),
		fields,
		references,
		tags: archetype ? readTaggings(archetype) : [],
		coverId: readCoverId(view),
		meta: readMeta(view),
		blocks
	};
}

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
	let hex = '';
	for (const byte of new Uint8Array(buffer)) hex += byte.toString(16).padStart(2, '0');
	return hex;
}

/**
 * The composite stale-save token: canonical JSON, then SHA-256, so key-order
 * jitter from Apex cannot move it but a real change can.
 *
 * WIDER THAN GLC's, deliberately. GLC hashes post + archetype `updated_at` plus
 * the blocks. That misses three edits another tab can make to a Godrej post:
 * `archetype_item` writes do not touch the archetype's `updated_at`, a nested
 * `shared_gallery_items` save does not move `posts.updated_at` (measured), and a
 * tagging is a separate row entirely. So the token hashes the references, the
 * cover and the taggings themselves — and the post's own fields, which costs
 * nothing and closes the same gap for a title edited in place.
 */
export async function computePostVersion(
	view: Record<string, unknown>,
	archetype: Record<string, unknown> | null,
	blocks: AdminPostBlock[],
	contract: ContentContract,
	slug: string
): Promise<string> {
	const summary = summarizePost(contract, slug, view, archetype, blocks);
	const archetypeRecord = isRecord(view.archetype) ? view.archetype : {};
	const projection = {
		post: {
			id: summary.id,
			status: summary.status,
			updated_at: readUpdatedAt(view),
			title: summary.title,
			slug: summary.slug,
			summary: summary.summary,
			published_date: summary.publishedDate,
			meta: summary.meta,
			coverId: summary.coverId
		},
		archetype: {
			id: summary.archetypeId,
			updated_at: archetype ? readUpdatedAt(archetype) : readUpdatedAt(archetypeRecord),
			fields: summary.fields,
			references: summary.references,
			taggings: summary.tags.map((tag) => ({ id: tag.id, tagId: tag.tagId }))
		},
		// Every editable payload of every kind. A divider resized from `medium` to
		// `large`, or an image repointed at another gallery item, is a change another
		// tab must be told about — the token has to move for both.
		blocks: blocks.map((block) => ({
			id: block.id,
			kind: block.kind,
			html: block.kind === 'rich_text' ? block.html : '',
			quote: block.kind === 'quote' ? block.quote : '',
			quotedBy: block.kind === 'quote' ? block.quotedBy : '',
			dividerKind: block.kind === 'divider' ? block.dividerKind : '',
			galleryItemId: block.kind === 'image' ? block.galleryItemId : null
		}))
	};
	const canonical = JSON.stringify(canonicalize(projection));
	return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(canonical)));
}

/**
 * The BODY's own version — a hash over the document rows as Apex holds them:
 * outer block id, `blockable_type`, position, inner `blockable.id` and the
 * editable payload.
 *
 * WHY IT EXISTS. `savePost` runs the composite stale check ONCE, before its
 * writes; `handleSavePostBody` then reads the current rows fresh and `_destroy`s
 * every EDITABLE row absent from what the editor sent. Tab A passes its check;
 * Tab B adds a divider; A's body save reads B's divider as current, does not find
 * it in A's desired list, and destroys it — silently, with a 200. That race used
 * to be confined to rich text and quotes; four editable kinds widen it to blocks
 * that were safe precisely because they were passthroughs.
 *
 * So the editor carries the version it LOADED and sends it with the body, and
 * this operation recomputes it from the rows it has just read: a mismatch is
 * `409 stale` with no PATCH.
 *
 * WHAT STAYS OPEN, deliberately: the window between this read and the PATCH
 * inside one request. Closing that needs a compare-and-set on the document, which
 * Apex does not offer — `PATCH /cms/documents/:id` takes no version, no ETag and
 * no `lock_version`. The check narrows the race from "since you opened the
 * editor" to "since this request started"; it does not remove it.
 *
 * Passthrough rows are hashed too (by id, type and position, with a null
 * payload): a `Spacer` inserted between the load and the save moves the token,
 * which is right — the save is about to renumber it.
 */
export async function computeBodyVersion(rows: Record<string, unknown>[]): Promise<string> {
	const projection = [...rows]
		.sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
		.map((row) => {
			const blockable = isRecord(row.blockable) ? row.blockable : null;
			const type = cleanString(row.blockable_type);
			let payload: unknown = null;
			if (type === BLOCK_TYPE_RICH_TEXT) payload = cleanString(blockable?.content_html);
			else if (type === BLOCK_TYPE_QUOTE) {
				payload = {
					quote: cleanString(blockable?.quote),
					quotedBy: cleanString(blockable?.quoted_by)
				};
			} else if (type === BLOCK_TYPE_DIVIDER) payload = cleanString(blockable?.kind);
			else if (type === BLOCK_TYPE_GALLERY_ITEM) {
				payload = cleanString(blockable?.gallery_item_id) || null;
			}
			return {
				id: cleanString(row.id),
				type,
				position: Number(row.position ?? 0),
				blockableId: blockable ? cleanString(blockable.id) : '',
				payload
			};
		});
	const canonical = JSON.stringify(canonicalize(projection));
	return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(canonical)));
}

/** The post an editor opens: the record, both guard tokens, and the pickers' targets. */
export interface PostLoad {
	ok: true;
	post: AdminPost;
	version: string;
	bodyVersion: string;
	referenceTargets: Record<string, AdminRecord[]>;
}

/**
 * A load that FAILED for a reason that is not "there is no such post".
 *
 * The distinction is the whole point: `null` means the scoped view found nothing
 * — a deleted post, or one of another schema — and is a 404. A typed failure means
 * a record that exists could not be READ, and is a 502. Collapsing the two was
 * how an unreadable document became a 404, and a 404 is what makes an editor's
 * Reload build a draft out of `undefined`.
 */
export interface PostLoadFailure {
	ok: false;
	reason: 'document-unreadable' | 'reference-targets-unreadable';
}

export type PostLoadResult = PostLoad | PostLoadFailure | null;

export async function buildPostLoad(
	contract: ContentContract,
	apex: ApexAdminClient,
	slug: string,
	postId: string
): Promise<PostLoadResult> {
	const view = await loadPostView(apex, slug, postId);
	if (!view) return null;
	const ids = readPostIds(view);
	const [archetype, apexBlocks, targets] = await Promise.all([
		readPostArchetype(apex, slug, ids.archetypeId),
		readDocumentBlocks(apex, ids.documentId),
		loadReferenceTargets(contract, apex, slug)
	]);
	if (apexBlocks === null) return { ok: false, reason: 'document-unreadable' };
	if (!targets.ok) return { ok: false, reason: 'reference-targets-unreadable' };
	const blocks = normalizeBlocks(apexBlocks);
	return {
		ok: true,
		post: summarizePost(contract, slug, view, archetype, blocks),
		version: await computePostVersion(view, archetype, blocks, contract, slug),
		bodyVersion: await computeBodyVersion(apexBlocks),
		referenceTargets: targets.targets
	};
}

/**
 * The fixed audit metadata for one post route: the route's TEMPLATE, with the
 * placeholders left in. A route parameter never belongs in `path` (`reject.ts`):
 * it is attacker-controlled until validated, and an audited rejection has to be
 * attributable to a route even when the id in it was junk. The validated schema
 * and post id go in the row's `detail`, where every accepting operation already
 * puts them.
 */
export function postRouteMeta(
	request: Request,
	action: string,
	method: string,
	withPostId = false,
	suffix = ''
): { action: string; method: string; path: string; requestId: string | null } {
	const base = '/api/admin/posts/[schema]';
	return {
		action,
		method,
		path: withPostId ? `${base}/[postId]${suffix}` : base,
		requestId: request.headers.get('cf-ray')
	};
}
