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
 * the site's loaders already read. A site hands its loader the saved records in
 * place of the published ones and changes nothing else:
 *
 *   - the post view  — `cms/post_archetype_views`   (publish's post collections)
 *   - its archetype  — `archetype_schemas/:slug/archetypes/:id` (publish's `archetypes`)
 *   - its document   — `cms/documents/search_and_filter`        (publish's `documents`)
 *
 * …plus every image the post points at (its cover, its gallery-item blocks) that the
 * snapshot does not hold yet, read from `cms/gallery_items/search_and_filter` — the
 * endpoint the publish reads the asset libraries from. A new post's cover is
 * usually a new upload, so without this the preview of exactly the post an editor
 * is checking would show its cover missing. Those images are not on the public
 * site until the next publish; the preview shows them because the next publish
 * will, and the post cannot go live without one.
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
 *
 * Like `loadSitePagePreview`, this returns DATA rather than a `Response`: its
 * caller is a `+page.server.ts` load, not a `+server.ts` route.
 */

import { stringifyCanonical } from '../../../cms/canonical-json.js';
import { cleanString, isRecord, unwrapArchetypeCollection } from '../archetype-record';
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
import type { BffContext } from '../context';
import type { OnSiteState } from './preview-page';

export type { OnSiteState } from './preview-page';

const PLATFORM = '/api/platform/v1';
const DOCUMENTS_SEARCH = `${PLATFORM}/cms/documents/search_and_filter`;
const GALLERY_ITEMS_SEARCH = `${PLATFORM}/cms/gallery_items/search_and_filter`;

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
	 * Gallery items the saved post points at that no snapshot collection holds yet,
	 * read live. Raw `cms/gallery_items` rows — the asset-library row shape — so a
	 * site appends them to whichever collection its loader resolves images from.
	 */
	galleryItems: Record<string, unknown>[];
	/** An independent copy of the published snapshot's collections. */
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
	 * The PUBLISHED post, projected the same way, for the identical/differs check —
	 * or null when the site does not serve this post. Compared to `comparable` with
	 * canonical JSON, so both must be built from the same function.
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

	const galleryItems = await readUnpublishedGalleryItems(
		guard.apex,
		referencedGalleryItemIds(post, document),
		collections
	);

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
 * A copy of the snapshot's collections with the saved post standing in for the
 * published one — the step every site adapter starts with.
 *
 * The saved post, archetype and document REPLACE any row with the same id (the
 * published version), or are added when the site has none (a draft). The live
 * gallery items are appended to `imagesCollection`. `documents` and `archetypes`
 * are the names the publish itself gives those collections; the post and image
 * collection names are the site's, because the publish names them after Apex's
 * `plural_name` and gallery name.
 */
export function collectionsWithSavedPost(
	input: PostPreviewAdapterInput,
	names: { postsCollection: string; imagesCollection: string }
): Record<string, unknown[]> {
	const { saved } = input;
	const next: Record<string, unknown[]> = { ...input.collections };
	next[names.postsCollection] = withRow(next[names.postsCollection], saved.post);
	next.archetypes = withRow(next.archetypes, saved.archetype);
	next.documents = withRow(next.documents, saved.document);
	const images = (next[names.imagesCollection] ?? []).slice();
	const held = new Set(images.map(rowId).filter(Boolean));
	for (const item of input.galleryItems) {
		if (!held.has(rowId(item))) images.push(item);
	}
	next[names.imagesCollection] = images;
	return next;
}

/** The published row for this post, by id, from the adapter's copy — or null. */
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

/**
 * The referenced gallery items no snapshot collection holds, read live. A failed
 * read is not a failed preview: the post still renders, with those images
 * unresolved — exactly how the public site would show it today.
 */
async function readUnpublishedGalleryItems(
	apex: ApexAdminClient,
	ids: string[],
	collections: Record<string, unknown[]>
): Promise<Record<string, unknown>[]> {
	if (ids.length === 0) return [];
	const held = new Set<string>();
	for (const rows of Object.values(collections)) {
		if (!Array.isArray(rows)) continue;
		for (const row of rows) {
			const id = rowId(row);
			if (id) held.add(id);
		}
	}
	const missing = ids.filter((id) => !held.has(id));
	if (missing.length === 0) return [];
	try {
		const response = await apex.get(GALLERY_ITEMS_SEARCH, {
			q: { id_in: missing },
			per_page: missing.length
		});
		if (!response.ok) return [];
		const wanted = new Set(missing);
		return unwrapArchetypeCollection(response.body).filter((row) => wanted.has(rowId(row)));
	} catch {
		return [];
	}
}

function withRow(rows: unknown[] | undefined, row: Readonly<Record<string, unknown>>): unknown[] {
	const id = rowId(row);
	const rest = (rows ?? []).filter((r) => rowId(r) !== id);
	return [row, ...rest];
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
