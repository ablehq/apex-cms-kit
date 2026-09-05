import { z } from 'zod';
import { canonicalize } from '../../../cms/canonical-json.js';
import { sanitizeHtml } from '../../../sanitize/html.js';
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
 * A POST IS THREE RECORDS, addressed in TWO id spaces:
 *
 *   - a `Cms::Post`                — title / slug / summary / published_date /
 *                                    status / the SEO triple / the COVER
 *                                    (`shared_gallery_items`);           by POST id
 *   - a `Specification::Archetype` — the PRIMITIVES (a story's `kind`) and the
 *                                    REFERENCES (author, focus_area, partner),
 *                                    and the TAGGINGS;               by ARCHETYPE id
 *   - a `Cms::Document`            — the body blocks;                by DOCUMENT id
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

/** The two `Cms::DocumentBlock` subclasses an editor can author here. */
export const BLOCK_TYPE_RICH_TEXT = 'Cms::DocumentBlock::RichText';
export const BLOCK_TYPE_QUOTE = 'Cms::DocumentBlock::Quote';

/** The `shared_gallery_items.kind` the public loaders read the cover from. */
const COVER_KIND = 'cover';

/** The schema, only if it is a POST schema — the one kind these operations serve. */
export function postSchemaOf(contract: ContentContract, slug: string): ArchetypeSchema | null {
	const schema = contract.schema(slug);
	return schema && schema.target_model === 'Cms::Post' ? schema : null;
}

export interface AdminPostBlock {
	id: string | null;
	kind: 'rich_text' | 'quote';
	html?: string;
	quote?: string;
	quotedBy?: string;
}

/** One block as APEX holds it — what the body reconciliation needs and the browser never sees. */
export interface ApexBlockRow {
	id: string;
	position: number;
	blockableType: string;
	blockableId: string;
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
 * The one post record, from the ONLY read surface an editor's token can use
 * (`GET /cms/posts/:id` is 403 for a staff token), filtered by the schema slug —
 * fixed, last — so `q[id_eq]` can only ever select a post of THIS schema.
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
		if (!id || seen.has(name)) continue;
		const next = changes[name as (typeof META_NAMES)[number]];
		if (next === undefined) continue;
		seen.add(name);
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

/** Apex's block rows for a document, in position order. Empty when the read failed. */
export async function readDocumentBlocks(
	apex: ApexAdminClient,
	documentId: string
): Promise<Record<string, unknown>[]> {
	if (!documentId) return [];
	const response = await apex.getDocument(documentId);
	if (!response.ok) return [];
	const record = unwrapArchetypeRecord(response.body);
	const blocks = record && Array.isArray(record.blocks) ? record.blocks : [];
	return blocks
		.filter(isRecord)
		.slice()
		.sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));
}

/** Apex's block rows reduced to the ids the body reconciliation addresses. */
export function apexBlockRows(blocks: Record<string, unknown>[]): ApexBlockRow[] {
	return blocks.map((block) => {
		const blockable = isRecord(block.blockable) ? block.blockable : null;
		return {
			id: cleanString(block.id),
			position: Number(block.position ?? 0),
			blockableType: cleanString(block.blockable_type),
			blockableId: blockable ? cleanString(blockable.id) : ''
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
 * A block whose `blockable_type` is neither editable kind — a
 * `Cms::DocumentBlock::GalleryItem`, which story bodies carry — is NOT returned.
 * That is deliberate and it is paired with the body write, which never destroys a
 * block it did not hand out: an editor cannot edit an image block here, and
 * cannot silently delete one either. The block survives a save untouched.
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
		}
	}
	return out;
}

const blockSchema = z
	.object({
		id: postIdSchema.nullable().optional(),
		kind: z.enum(['rich_text', 'quote']),
		html: z.string().max(200_000).optional(),
		quote: z.string().max(20_000).optional(),
		quotedBy: z.string().max(300).optional()
	})
	.strict();

export const savePostBodySchema = z.object({ blocks: z.array(blockSchema).max(200) }).strict();

export type DesiredBlock = z.infer<typeof blockSchema>;

/** The `blockable_type` an editable kind maps to. */
function typeOf(kind: 'rich_text' | 'quote'): string {
	return kind === 'quote' ? BLOCK_TYPE_QUOTE : BLOCK_TYPE_RICH_TEXT;
}

/** The `blockable_attributes` payload for one desired block, sanitized. */
function payloadOf(block: DesiredBlock): Record<string, unknown> {
	if (block.kind === 'quote') {
		return { quote: block.quote ?? '', quoted_by: block.quotedBy ?? '' };
	}
	return { editor: 'quilljs', content_html: sanitizeHtml(block.html ?? '') };
}

/**
 * Turn "here is the whole body" into the nested-attributes diff Apex actually
 * applies. `PATCH /cms/documents/:id` with `blocks_attributes` is NOT a
 * replacement: an entry with no id creates, an entry with an id updates, and a
 * row simply omitted survives — so a client that sent the whole body twice would
 * DOUBLE it. This keeps by id, creates the id-less, destroys what the editor
 * removed, and never touches a block kind the editor was not shown.
 */
export function buildBlocksAttributes(
	current: ApexBlockRow[],
	desired: DesiredBlock[]
): Record<string, unknown>[] {
	const editable = current.filter(
		(row) => row.blockableType === BLOCK_TYPE_RICH_TEXT || row.blockableType === BLOCK_TYPE_QUOTE
	);
	const byId = new Map(editable.map((row) => [row.id, row]));
	const kept = new Set<string>();
	const attributes: Record<string, unknown>[] = [];

	desired.forEach((block, index) => {
		const existing = block.id ? byId.get(block.id) : undefined;
		// An id whose KIND changed is not an update: `blockable_type` is a different
		// table. It becomes a create here and a destroy below.
		if (existing && existing.blockableType === typeOf(block.kind)) {
			kept.add(existing.id);
			attributes.push({
				id: existing.id,
				position: index,
				blockable_type: existing.blockableType,
				blockable_attributes: { id: existing.blockableId, ...payloadOf(block) }
			});
			return;
		}
		attributes.push({
			blockable_type: typeOf(block.kind),
			position: index,
			blockable_attributes: payloadOf(block)
		});
	});

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
		blocks: blocks.map((block) => ({
			id: block.id,
			kind: block.kind,
			html: block.html ?? '',
			quote: block.quote ?? '',
			quotedBy: block.quotedBy ?? ''
		}))
	};
	const canonical = JSON.stringify(canonicalize(projection));
	return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(canonical)));
}

/** The whole post the editor opens, its guard token, and the reference targets its pickers need. */
export async function buildPostLoad(
	contract: ContentContract,
	apex: ApexAdminClient,
	slug: string,
	postId: string
): Promise<{
	post: AdminPost;
	version: string;
	referenceTargets: Record<string, AdminRecord[]>;
} | null> {
	const view = await loadPostView(apex, slug, postId);
	if (!view) return null;
	const ids = readPostIds(view);
	const [archetype, apexBlocks, targets] = await Promise.all([
		readPostArchetype(apex, slug, ids.archetypeId),
		readDocumentBlocks(apex, ids.documentId),
		loadReferenceTargets(contract, apex, slug)
	]);
	if (!targets.ok) return null;
	const blocks = normalizeBlocks(apexBlocks);
	return {
		post: summarizePost(contract, slug, view, archetype, blocks),
		version: await computePostVersion(view, archetype, blocks, contract, slug),
		referenceTargets: targets.targets
	};
}

/** The fixed audit metadata for one post route. Route PARAMETERS go in `detail`, never here. */
export function postRouteMeta(
	request: Request,
	action: string,
	method: string,
	schema: string,
	postId?: string,
	suffix = ''
): { action: string; method: string; path: string; requestId: string | null } {
	const base = `/api/admin/posts/${schema}`;
	return {
		action,
		method,
		path: postId ? `${base}/${postId}${suffix}` : base,
		requestId: request.headers.get('cf-ray')
	};
}
