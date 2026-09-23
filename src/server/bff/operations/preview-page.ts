/**
 * The draft preview: one page, as the site would render it, from what is in Apex
 * RIGHT NOW rather than from the committed snapshot the public routes are built
 * from.
 *
 * Why this exists. The public catch-all route reads the PUBLISHED snapshot out of
 * KV at request time. The consequence is that the admin's "Preview" button, which
 * pointed at the page's PUBLIC address, showed the last published state and never
 * the editor's work — a control named Preview that previews nothing you just did.
 * This is the path that makes the name true.
 *
 * (This paragraph used to describe `prerender = true` reading `cms/data/pages.json`.
 * Neither has been true since the move to runtime KV content; the route does not
 * prerender and that file does not exist.)
 *
 * ── Reuse is the design, not a convenience ──────────────────────────────────
 * The generic operation owns the guard, Apex read and published comparison; a
 * site adapter owns the projection that its public route actually uses. GLC's
 * adapter uses `projectCmsPage` and the same media index as its publish path.
 * Other sites supply their own public projection and comparable rather than
 * copying GLC's block shape or creating a second projection for preview.
 *
 * That matters for one reason: if the preview and the published page ever look
 * different, the difference is IN THE DATA — someone saved something, or the
 * snapshot is behind — rather than an artifact of a parallel renderer.
 *
 * ── What it can and cannot show ────────────────────────────────────────────
 * It reads Apex. So it shows the last SAVE, and it cannot show unsaved edits
 * sitting in the browser's draft — nothing server-side has them. The UI says so
 * plainly rather than implying otherwise, and `savedAt` below is what lets it.
 *
 * ── Access ─────────────────────────────────────────────────────────────────
 * This returns UNPUBLISHED content, so it runs behind `guardRequest` like every
 * other Apex read: the guard resolves the editor's server-side session and hands
 * back an Apex client bound to THAT PERSON's token. `BffContext` deliberately has
 * no ready-made client, so there is no way to reach Apex here without a session.
 * Signed out is a 401 and no page data at all, before Apex is ever called.
 *
 * Shape note: unlike its neighbours this operation returns DATA rather than a
 * `Response`, because its caller is a `+page.server.ts` load and not a `+server.ts`
 * route. Everything else about it — the guard, the fixed Apex call, the closed
 * result type — is the same pattern.
 */

import { unwrapArchetypeRecord } from '../archetype-record';
import { stringifyCanonical } from '../../../cms/canonical-json.js';
import { buildMediaIndex } from '../../../cms/media.js';
import {
	isCmsPageRoutable,
	normalizeSlugPath,
	projectCmsPage,
	projectedPageBySlug
} from '../../../cms/page-data.js';
import type { ProjectedCmsPage } from '../../../cms/page-data.js';

import { guardRequest } from '../guard';
import { ContentUnavailableError, readContent } from '../../content/read';
import { pageIdSchema } from './get-page';
import type { BffContext } from '../context';
import type { ApexAdminClient } from '../apex-admin-client';

/** How the page the public site serves compares to what is saved in Apex now. */
export type OnSiteState =
	/** The site's copy is byte-identical to the saved page, projected. */
	| 'identical'
	/** The site has this page, but an older version of it. */
	| 'differs'
	/** The site has no such page — unpublished, renamed, or never refreshed. */
	| 'absent';

export interface PagePreview {
	pageId: string;
	/** Exactly what `[...slug]`'s load hands its renderer, built the same way. */
	page: ProjectedCmsPage;
	/** Whatever the site's `messages` hook derives for this page's blocks — e.g. GLC's sermon strip. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	messages: any;
	/** Sections whose template has no component — named, not silently missing. */
	unknownTemplates: string[];
	/** Apex's own status: `published`, `draft`, `editing`, `scheduled`, `archived`. */
	status: string;
	/** Whether the public site would route this page at all. */
	routable: boolean;
	/** Its address on the site, when it has one. */
	publicPath: string | null;
	/** When Apex last accepted a save — what "this is your last save" refers to. */
	savedAt: string | null;
	onSite: OnSiteState;
}

/** The site's renderer registry check: which of a page's blocks have a component. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PartitionRenderableBlocks = (blocks: any[]) => {
	renderable: any[];
	unknownSlugs: string[];
};

export type PagePreviewResult =
	{ ok: true; preview: PagePreview } | { ok: false; status: number; reason: string };

/** §2.2: adapters may read Apex as the editor, but must leave the shared snapshot untouched. */
export interface PreviewAdapterInput {
	/** Apex's saved page; clone before an in-place transform. */
	raw: Readonly<Record<string, unknown>>;
	/** read.ts:114 returns the memo across requests; read-only by contract. */
	collections: Record<string, unknown[]>;
	/** The guard's client, bound to the signed-in editor. */
	apex: ApexAdminClient;
}

export type PreviewProjection<Payload> =
	| { ok: true; payload: Payload; comparable: unknown; unknownTemplates: string[] }
	| { ok: false; status: 404 | 422 | 502; reason: string };

/** §2.2: each site supplies its public projection and its own comparison rules. */
export interface SitePreviewAdapter<Payload> {
	projectSaved(input: PreviewAdapterInput): Promise<PreviewProjection<Payload>>;
	publishedComparable(input: PreviewAdapterInput): Promise<unknown | null>;
	routable(raw: Readonly<Record<string, unknown>>): boolean;
	publicPath(raw: Readonly<Record<string, unknown>>): string;
}

export interface SitePagePreview<Payload> {
	pageId: string;
	payload: Payload;
	unknownTemplates: string[];
	status: string;
	routable: boolean;
	publicPath: string | null;
	savedAt: string | null;
	onSite: OnSiteState;
}

export type SitePagePreviewResult<Payload> =
	{ ok: true; preview: SitePagePreview<Payload> } | { ok: false; status: number; reason: string };

/** The original GLC fourth argument, kept structurally identical for its call site. */
export interface GlcPreviewOptions {
	partitionRenderableBlocks: PartitionRenderableBlocks;
	/** Derive the request-time data a derived section needs (GLC: the sermon strip). */
	messages?: (collections: Record<string, unknown[]>, blocks: unknown[]) => unknown;
	/**
	 * The `<title>` fallback for a page with no title of its own — and it MUST be
	 * the same value the site's publish projection uses. The two projections are
	 * compared byte-for-byte below to decide `identical` vs `differs`, so a site
	 * that passes `siteTitle` at publish and not here reports every untitled page
	 * as `differs` forever, no matter how often it republishes.
	 */
	siteTitle?: string;
}

/** §2.2: keep GLC's media, partition, messages and unpartitioned comparable. */
export function glcPagePreviewAdapter(
	options: GlcPreviewOptions
): SitePreviewAdapter<{ page: ProjectedCmsPage; messages: unknown }> {
	return {
		async projectSaved(input) {
			// An unpublished upload is unresolved here, just as it is on the public site.
			const media = buildMediaIndex([
				input.collections.images ?? [],
				input.collections.files ?? [],
				input.collections.videos ?? []
			]);
			const projected = projectCmsPage(input.raw, { media, siteTitle: options.siteTitle });
			const { renderable, unknownTemplates } = previewBlocks(
				projected,
				options.partitionRenderableBlocks
			);
			const messages = options.messages ? options.messages(input.collections, renderable) : [];
			return {
				ok: true,
				payload: { page: { ...projected, blocks: renderable }, messages },
				comparable: projected,
				unknownTemplates
			};
		},
		async publishedComparable(input) {
			return projectedPageBySlug(
				(input.collections.pages ?? []) as ProjectedCmsPage[],
				normalizeSlugPath(input.raw.slug)
			);
		},
		routable: isCmsPageRoutable,
		publicPath: (raw) => normalizeSlugPath(raw.slug)
	};
}

/** §2.2: authenticate and read first; adapters handle only site-specific projection. */
export async function loadSitePagePreview<Payload>(
	request: Request,
	ctx: BffContext,
	params: { pageId: string },
	adapter: SitePreviewAdapter<Payload>
): Promise<SitePagePreviewResult<Payload>> {
	const guard = await guardRequest(request, ctx, { mutation: false });
	if (!guard.ok) return { ok: false, status: guard.status, reason: guard.reason };

	const idResult = pageIdSchema.safeParse(params.pageId);
	if (!idResult.success) return { ok: false, status: 400, reason: 'invalid page id' };

	const apexResponse = await guard.apex.getPage(idResult.data);
	// A 404 here means Apex has no such page — a genuine dead link. It is NOT the
	// public site's 404, which fires for a page that merely is not published; that
	// page is the whole point of this route and renders normally below.
	if (apexResponse.status === 404) return { ok: false, status: 404, reason: 'no such page' };
	if (!apexResponse.ok) return { ok: false, status: 502, reason: 'upstream error' };

	const raw = unwrapArchetypeRecord(apexResponse.body);
	if (!raw) return { ok: false, status: 502, reason: 'unexpected upstream shape' };

	let collections: Record<string, unknown[]>;
	try {
		({ collections } = await readContent(ctx.content));
	} catch (cause) {
		if (!(cause instanceof ContentUnavailableError)) throw cause;
		return { ok: false, status: 503, reason: 'the site has not been published yet' };
	}

	// Capture every raw-derived fact before an adapter can transform its input.
	const status = typeof raw.status === 'string' ? raw.status : '';
	const savedAt = typeof raw.updated_at === 'string' ? raw.updated_at : null;
	const routable = adapter.routable(raw);
	const publicPath = routable ? adapter.publicPath(raw) : null;
	const input = { raw, collections, apex: guard.apex };
	const projected = await adapter.projectSaved(input);
	if (!projected.ok) return projected;
	const onSnapshot = await adapter.publishedComparable(input);
	const onSite: OnSiteState =
		onSnapshot === null
			? 'absent'
			: stringifyCanonical(onSnapshot) === stringifyCanonical(projected.comparable)
				? 'identical'
				: 'differs';

	return {
		ok: true,
		preview: {
			pageId: idResult.data,
			payload: projected.payload,
			unknownTemplates: projected.unknownTemplates,
			status,
			routable,
			publicPath,
			savedAt,
			onSite
		}
	};
}

/** GLC's established result shape and signature, now expressed through the site adapter. */
export async function loadPagePreview(
	request: Request,
	ctx: BffContext,
	params: { pageId: string },
	options: GlcPreviewOptions
): Promise<PagePreviewResult> {
	const result = await loadSitePagePreview(request, ctx, params, glcPagePreviewAdapter(options));
	if (!result.ok) return result;
	const { pageId, payload, unknownTemplates, status, routable, publicPath, savedAt, onSite } =
		result.preview;
	return {
		ok: true,
		preview: {
			pageId,
			page: payload.page,
			messages: payload.messages,
			unknownTemplates,
			status,
			routable,
			publicPath,
			savedAt,
			onSite
		}
	};
}

/**
 * The same drop-and-report the public route performs, kept in one place so the
 * preview cannot quietly render a section the site would skip (or skip one it
 * would render).
 */
function previewBlocks(
	projected: ProjectedCmsPage,
	partitionRenderableBlocks: PartitionRenderableBlocks
) {
	const { renderable, unknownSlugs } = partitionRenderableBlocks(projected.blocks);
	return { renderable, unknownTemplates: unknownSlugs };
}
