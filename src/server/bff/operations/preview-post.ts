/**
 * The draft preview for a POST (an update, a story, an article), as the site's own
 * public post route would draw it, from what is in Apex RIGHT NOW rather than from
 * the published snapshot.
 *
 * It is the page preview's sibling (`preview-page.ts`) and is built the same way:
 * this operation owns the guard, the Apex reads and the published comparison; a
 * SITE ADAPTER owns the projection its public post route uses. So if the preview
 * and the published post ever look different, the difference is in the data —
 * something was saved, or the snapshot is behind — never a second renderer.
 *
 * ── What it reads ──────────────────────────────────────────────────────────
 * A post is three records (`post-shape.ts`), and each is read through the SAME
 * Apex endpoint the publish uses to build the snapshot, so it arrives in the shape
 * the site's loaders already read:
 *
 *   - the post view  — `cms/post_archetype_views`   (publish's post collections)
 *   - its archetype  — `archetype_schemas/:slug/archetypes/:id` (publish's `archetypes`)
 *   - its document   — `cms/documents/search_and_filter`        (publish's `documents`)
 *
 * A post also DRAWS records it only points at, and those are read live too:
 *
 *   - its REFERENCE TARGETS (an author, partners, focus areas), from
 *     `specification/archetypes/search_and_filter` — publish's content-library
 *     collections. An author created and chosen since the last publish is not in
 *     the snapshot at all, and an edited one is stale there, so reading them from
 *     the snapshot would preview a byline the next publish will not show.
 *   - every GALLERY ITEM it shows — its cover, its gallery-item blocks, and the
 *     media fields (`ref/model/Cms::GalleryItem`) on it and on those targets, such
 *     as an author's photo — from `cms/gallery_items/search_and_filter`, publish's
 *     asset libraries. A new cover is not in the snapshot, and a corrected caption
 *     on an existing one does not change its id, so these are re-read whether or
 *     not the snapshot holds them.
 *
 * The live rows are handed to the adapter SEPARATELY from the snapshot. The saved
 * projection uses them (`collectionsWithSavedPost`); the published comparison does
 * not, because it describes what the site is serving now. A failed read of either
 * kind is not a failed preview: the snapshot's row, or none, is used — what the
 * public site shows today.
 *
 * ── What it cannot show ────────────────────────────────────────────────────
 * It reads Apex, so it shows the last SAVE. Unsaved edits live only in the
 * browser's draft, and nothing server-side has them. The editor says so.
 *
 * ── Access ─────────────────────────────────────────────────────────────────
 * It returns UNPUBLISHED content, so it runs behind `guardRequest` like every other
 * Apex read: signed out is a 401 and no post data, before Apex is ever called.
 * The post is read through the SCHEMA-SCOPED list, so a story id addressed as an
 * update finds nothing — the same cross-schema refusal the editor's own read has.
 * Reference targets are read only for the schemas the content contract names as
 * this post's targets, and only when they are content-library schemas.
 *
 * Like `loadSitePagePreview`, this returns DATA rather than a `Response`: its
 * caller is a `+page.server.ts` load, not a `+server.ts` route.
 */

import { stringifyCanonical } from '../../../cms/canonical-json.js';
import { ARCHETYPES_BASE, DOCUMENTS_BASE, GALLERY_BASE } from '../apex-admin-client';
import {
	cleanString,
	isRecord,
	readPrimitiveValue,
	readReferences,
	unwrapArchetypeCollection
} from '../archetype-record';
import { contractOf } from '../content-contract-guard';
import { guardRequest } from '../guard';
import { ContentUnavailableError, readContent } from '../../content/read';
import {
	BLOCK_TYPE_GALLERY_ITEM,
	loadPostView,
	postIdSchema,
	postSchemaOf,
	readPostArchetype,
	readPostIds
} from './post-shape';
import type { ApexAdminClient } from '../apex-admin-client';
import type { ContentContract } from '../content-contract';
import type { BffContext } from '../context';
import type { OnSiteState } from './preview-page';

export type { OnSiteState } from './preview-page';

// The list endpoints the publish reads, so each row arrives in the snapshot's shape.
const DOCUMENTS_SEARCH = `${DOCUMENTS_BASE}/search_and_filter`;
const GALLERY_ITEMS_SEARCH = `${GALLERY_BASE}/search_and_filter`;
const ARCHETYPES_SEARCH = `${ARCHETYPES_BASE}/search_and_filter`;

/** The `validator_kind` of a field that stores a gallery-item id (`cms/media.js`). */
export const GALLERY_ITEM_FIELD = 'ref/model/Cms::GalleryItem';

/** The three saved records, each in the shape the publish writes it to the snapshot. */
export interface SavedPost {
	/** A `cms/post_archetype_views` row: title, slug, status, cover, SEO, `document.id`. */
	post: Readonly<Record<string, unknown>>;
	/** The archetype: primitives, references, taggings, `target_model_id`. */
	archetype: Readonly<Record<string, unknown>>;
	/** The body document, `blocks` included. */
	document: Readonly<Record<string, unknown>>;
}

/** What a site adapter is handed. Everything here is the adapter's own copy. */
export interface PostPreviewAdapterInput {
	/** The post schema slug: `update`, `story`, `article`. */
	schema: string;
	saved: SavedPost;
	/**
	 * The records the saved post references, read live, keyed by the TARGET schema
	 * slug (`author`, `partner`, `focus_area`). Raw content-library rows, the shape
	 * of the snapshot's content-library collections. A schema whose read failed is
	 * absent, so the snapshot's rows stand for it.
	 */
	referenceTargets: Record<string, Record<string, unknown>[]>;
	/**
	 * Every gallery item the saved post shows — cover, image blocks, media fields on
	 * it and on its reference targets — read live. Raw `cms/gallery_items` rows, the
	 * asset-library row shape.
	 */
	galleryItems: Record<string, unknown>[];
	/**
	 * An independent copy of the published snapshot's collections, untouched: the
	 * published comparison reads these, and must, to describe what the site serves.
	 */
	collections: Record<string, unknown[]>;
	/** The guard's client, bound to the signed-in editor. */
	apex: ApexAdminClient;
}

export type PostPreviewProjection<Payload> =
	| { ok: true; payload: Payload; comparable: unknown }
	| { ok: false; status: 404 | 422 | 502; reason: string };

/** Each site supplies its public post projection and its own comparison rules. */
export interface SitePostPreviewAdapter<Payload> {
	/** The saved post, projected exactly as the site's public post route would. */
	projectSaved(input: PostPreviewAdapterInput): Promise<PostPreviewProjection<Payload>>;
	/**
	 * The PUBLISHED post, projected the same way from the snapshot as it stands, for
	 * the identical/differs check — or null when the site does not serve this post.
	 * Compared to `comparable` with canonical JSON, so both must be built by the same
	 * function.
	 */
	publishedComparable(input: PostPreviewAdapterInput): Promise<unknown | null>;
	/** Whether the public site would route this post at all. */
	routable(post: Readonly<Record<string, unknown>>, schema: string): boolean;
	/** Its address on the site, e.g. `/blogs/<slug>`. Asked only when routable. */
	publicPath(post: Readonly<Record<string, unknown>>, schema: string): string;
}

export interface SitePostPreview<Payload> {
	schema: string;
	postId: string;
	payload: Payload;
	/** Apex's own status: `published`, `draft`, `editing`, `scheduled`, `archived`. */
	status: string;
	routable: boolean;
	publicPath: string | null;
	/**
	 * The latest `updated_at` Apex reports across the three records. Approximate by
	 * Apex's own rules: a cover write does not move the post's, and an archetype
	 * item write does not move the archetype's (`post-shape.ts`).
	 */
	savedAt: string | null;
	onSite: OnSiteState;
}

export type SitePostPreviewResult<Payload> =
	{ ok: true; preview: SitePostPreview<Payload> } | { ok: false; status: number; reason: string };

/** Authenticate and read first; the adapter handles only the site's projection. */
export async function loadSitePostPreview<Payload>(
	request: Request,
	ctx: BffContext,
	params: { schema: string; postId: string },
	adapter: SitePostPreviewAdapter<Payload>
): Promise<SitePostPreviewResult<Payload>> {
	const guard = await guardRequest(request, ctx, { mutation: false });
	if (!guard.ok) return { ok: false, status: guard.status, reason: guard.reason };

	const contract = contractOf(ctx);
	if (!contract) return { ok: false, status: 500, reason: 'content contract not configured' };
	if (!postSchemaOf(contract, params.schema))
		return { ok: false, status: 404, reason: 'unknown collection' };
	const idResult = postIdSchema.safeParse(params.postId);
	if (!idResult.success) return { ok: false, status: 400, reason: 'invalid post id' };
	const postId = idResult.data;

	// The same scoped read the editor's load makes: another schema's post, or a
	// deleted one, finds nothing.
	const post = await loadPostView(guard.apex, params.schema, postId);
	if (!post) return { ok: false, status: 404, reason: 'no such post' };

	const ids = readPostIds(post);
	const [archetype, document] = await Promise.all([
		readPostArchetype(guard.apex, params.schema, ids.archetypeId),
		readPostDocument(guard.apex, ids.documentId)
	]);
	// A post that exists but whose archetype or body will not read is an upstream
	// fault. Rendering it without them would preview a post with no body, or no
	// author, that is not the post — so it is a 502, never a partial page.
	if (!archetype || !document) return { ok: false, status: 502, reason: 'upstream error' };

	let collections: Record<string, unknown[]>;
	try {
		({ collections } = await readContent(ctx.content));
	} catch (cause) {
		if (!(cause instanceof ContentUnavailableError)) throw cause;
		return { ok: false, status: 503, reason: 'the site has not been published yet' };
	}

	// Targets first: their media fields (an author's photo) are gallery items too,
	// so the one gallery read below covers the post and everything it draws.
	const referenceTargets = await readReferenceTargets(
		guard.apex,
		contract,
		params.schema,
		archetype
	);
	const galleryIds = new Set(referencedGalleryItemIds(post, document));
	for (const id of mediaFieldIds(contract, params.schema, archetype)) galleryIds.add(id);
	for (const [target, rows] of Object.entries(referenceTargets)) {
		for (const row of rows)
			for (const id of mediaFieldIds(contract, target, row)) galleryIds.add(id);
	}
	const galleryItems = await readGalleryItems(guard.apex, [...galleryIds]);

	// Capture every raw-derived fact before an adapter can transform its input.
	const status = typeof post.status === 'string' ? post.status : '';
	const savedAt = latestTimestamp([post.updated_at, archetype.updated_at, document.updated_at]);
	const routable = adapter.routable(post, params.schema);
	const publicPath = routable ? adapter.publicPath(post, params.schema) : null;

	// Preview is admin-only and rare; cloning costs less than an adapter's in-place
	// splice reaching the public site's shared snapshot memo.
	const input: PostPreviewAdapterInput = {
		schema: params.schema,
		saved: structuredClone({ post, archetype, document }),
		referenceTargets: structuredClone(referenceTargets),
		galleryItems: structuredClone(galleryItems),
		collections: structuredClone(collections),
		apex: guard.apex
	};
	const projected = await adapter.projectSaved(input);
	if (!projected.ok) return projected;
	const onSnapshot = await adapter.publishedComparable(input);
	const onSite: OnSiteState =
		onSnapshot == null
			? 'absent'
			: stringifyCanonical(onSnapshot) === stringifyCanonical(projected.comparable)
				? 'identical'
				: 'differs';

	return {
		ok: true,
		preview: {
			schema: params.schema,
			postId,
			payload: projected.payload,
			status,
			routable,
			publicPath,
			savedAt,
			onSite
		}
	};
}

/**
 * A copy of the snapshot's collections as the NEXT publish would read them, for
 * this post: the step every site adapter's `projectSaved` starts with.
 *
 *   - the saved post, archetype and document go FIRST in their collections, and
 *     any published copy of them (same id) is dropped. Sites find a post by its
 *     slug, and its archetype by the post it belongs to, taking the first match;
 *     the snapshot can still hold another post at this slug (one renamed since the
 *     last publish), and the saved post must win;
 *   - each live reference target replaces its snapshot row, or is added, in the
 *     collection `referenceCollections` names for its schema;
 *   - each live gallery item replaces its snapshot row, or is added, in
 *     `imagesCollection`.
 *
 * `documents` and `archetypes` are the names the publish itself gives those
 * collections. The others are the site's, because the publish names them after
 * Apex's `plural_name` and gallery name. A target schema with no entry in
 * `referenceCollections` is left as the snapshot has it.
 *
 * `input.collections` is not modified — `publishedComparable` must keep reading
 * the snapshot as it stands.
 */
export function collectionsWithSavedPost(
	input: PostPreviewAdapterInput,
	names: {
		postsCollection: string;
		imagesCollection: string;
		referenceCollections?: Record<string, string>;
	}
): Record<string, unknown[]> {
	const { saved } = input;
	const next: Record<string, unknown[]> = { ...input.collections };
	next[names.postsCollection] = savedFirst(next[names.postsCollection], saved.post);
	next.archetypes = savedFirst(next.archetypes, saved.archetype);
	next.documents = savedFirst(next.documents, saved.document);
	for (const [target, rows] of Object.entries(input.referenceTargets ?? {})) {
		const name = names.referenceCollections?.[target];
		if (name) next[name] = upsert(next[name], rows);
	}
	next[names.imagesCollection] = upsert(next[names.imagesCollection], input.galleryItems);
	return next;
}

/** The published row for this post, by id, from the snapshot as it stands — or null. */
export function publishedPostRow(
	input: PostPreviewAdapterInput,
	postsCollection: string
): Record<string, unknown> | null {
	const id = rowId(input.saved.post);
	const row = (input.collections[postsCollection] ?? []).find((r) => rowId(r) === id);
	return isRecord(row) ? row : null;
}

/** Every gallery item id the post points at: its cover rows and its image blocks. */
export function referencedGalleryItemIds(
	post: Readonly<Record<string, unknown>>,
	document: Readonly<Record<string, unknown>>
): string[] {
	const ids = new Set<string>();
	const covers = Array.isArray(post.shared_gallery_items) ? post.shared_gallery_items : [];
	for (const row of covers) {
		const id = isRecord(row) ? cleanString(row.gallery_item_id) : '';
		if (id) ids.add(id);
	}
	const blocks = Array.isArray(document.blocks) ? document.blocks : [];
	for (const block of blocks) {
		if (!isRecord(block) || block.blockable_type !== BLOCK_TYPE_GALLERY_ITEM) continue;
		const blockable = isRecord(block.blockable) ? block.blockable : null;
		const id = blockable ? cleanString(blockable.gallery_item_id) : '';
		if (id) ids.add(id);
	}
	return [...ids];
}

/**
 * The gallery-item ids an archetype record holds in its media fields — the fields
 * the contract types `ref/model/Cms::GalleryItem` for its schema.
 */
export function mediaFieldIds(
	contract: ContentContract,
	schema: string,
	record: Readonly<Record<string, unknown>>
): string[] {
	const ids: string[] = [];
	for (const def of contract.primitiveFieldDefs(schema)) {
		if (def.validator_kind !== GALLERY_ITEM_FIELD) continue;
		const id = cleanString(readPrimitiveValue(record as Record<string, unknown>, def.field_name));
		if (id) ids.push(id);
	}
	return ids;
}

/**
 * The records the saved post references, read live, one read per target schema.
 * Only the targets the contract names for this schema, and only content-library
 * ones — the same set the publish lists. A failed read leaves that schema out.
 */
async function readReferenceTargets(
	apex: ApexAdminClient,
	contract: ContentContract,
	schema: string,
	archetype: Record<string, unknown>
): Promise<Record<string, Record<string, unknown>[]>> {
	const wanted = new Map<string, Set<string>>();
	for (const item of contract.referenceItems(schema)) {
		const target = item.target_schema;
		if (!target || !contract.isContentLibrarySlug(target)) continue;
		for (const reference of readReferences(archetype, item.name)) {
			if (!wanted.has(target)) wanted.set(target, new Set());
			wanted.get(target)!.add(reference.targetId);
		}
	}
	const entries = await Promise.all(
		[...wanted].map(async ([target, idSet]) => {
			const ids = [...idSet];
			try {
				const response = await apex.get(ARCHETYPES_SEARCH, {
					q: { archetype_schema_slug_eq: target, id_in: ids },
					per_page: ids.length
				});
				if (!response.ok) return null;
				const rows = unwrapArchetypeCollection(response.body).filter((row) =>
					idSet.has(rowId(row))
				);
				return [target, rows] as const;
			} catch {
				return null;
			}
		})
	);
	return Object.fromEntries(entries.filter((entry) => entry !== null));
}

/**
 * The body document, read through the endpoint the publish lists documents from,
 * so its shape is the snapshot's. Null when it will not read — never an empty
 * document, which would preview a post with its body silently missing.
 */
async function readPostDocument(
	apex: ApexAdminClient,
	documentId: string
): Promise<Record<string, unknown> | null> {
	if (!documentId) return null;
	let response;
	try {
		response = await apex.get(DOCUMENTS_SEARCH, { q: { id_eq: documentId }, per_page: 1 });
	} catch {
		return null;
	}
	if (!response.ok) return null;
	const row = unwrapArchetypeCollection(response.body).find(
		(record) => cleanString(record.id) === documentId
	);
	if (!row || !Array.isArray(row.blocks)) return null;
	return row;
}

/** The gallery items, read live, in one read. A failed read reads as none. */
async function readGalleryItems(
	apex: ApexAdminClient,
	ids: string[]
): Promise<Record<string, unknown>[]> {
	if (ids.length === 0) return [];
	try {
		const response = await apex.get(GALLERY_ITEMS_SEARCH, {
			q: { id_in: ids },
			per_page: ids.length
		});
		if (!response.ok) return [];
		const wanted = new Set(ids);
		return unwrapArchetypeCollection(response.body).filter((row) => wanted.has(rowId(row)));
	} catch {
		return [];
	}
}

/** The row first, then every other row with a different id. The input is not modified. */
function savedFirst(
	rows: unknown[] | undefined,
	row: Readonly<Record<string, unknown>>
): unknown[] {
	const id = rowId(row);
	return [row, ...(rows ?? []).filter((other) => !id || rowId(other) !== id)];
}

/**
 * Rows replaced in place by id, and new ones appended, so the collection keeps the
 * snapshot's order. These are looked up by id. The input is not modified.
 */
function upsert(
	rows: unknown[] | undefined,
	incoming: readonly Readonly<Record<string, unknown>>[]
): unknown[] {
	const next = (rows ?? []).slice();
	const at = new Map<string, number>();
	next.forEach((row, index) => {
		const id = rowId(row);
		if (id && !at.has(id)) at.set(id, index);
	});
	for (const row of incoming) {
		const id = rowId(row);
		const index = id ? at.get(id) : undefined;
		if (index === undefined) {
			if (id) at.set(id, next.length);
			next.push(row);
		} else {
			next[index] = row;
		}
	}
	return next;
}

function rowId(row: unknown): string {
	return isRecord(row) ? cleanString(row.id) : '';
}

function latestTimestamp(values: unknown[]): string | null {
	let latest: string | null = null;
	let latestMs = -Infinity;
	for (const value of values) {
		if (typeof value !== 'string') continue;
		const ms = Date.parse(value);
		if (Number.isNaN(ms) || ms <= latestMs) continue;
		latest = value;
		latestMs = ms;
	}
	return latest;
}
