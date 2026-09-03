/**
 * The draft preview: one page, as the site would render it, from what is in Apex
 * RIGHT NOW rather than from the committed snapshot the public routes are built
 * from.
 *
 * Why this exists. `src/routes/[...slug]/+page.server.js` is `prerender = true`
 * and reads `cms/data/pages.json` — the committed snapshot (plan §2, the hermetic
 * build). That is deliberate and stays. The consequence is that the admin's
 * "Preview" button, which pointed at the page's PUBLIC address, showed the last
 * published snapshot and never the editor's work — a control named Preview that
 * previews nothing you just did, with the caveat in a tooltip. This is the path
 * that makes the name true.
 *
 * ── Reuse is the design, not a convenience ──────────────────────────────────
 * The projection is `projectCmsPage` / `projectBlocks` / `projectFields` from
 * `$lib/cms/page-data.js` — the SAME functions `cms:setup` calls through
 * `snapshot-projection.js` to write `cms/data/pages.json`, and therefore the same
 * transform that produced everything the public site serves. The media index is
 * built by the same `buildMediaIndex` over the same three asset-library files.
 * The renderer on the other side is `$lib/blocks/CmsPageRenderer.svelte` and the
 * same `Glc*` components, dispatched through the same registry.
 *
 * That matters for one reason: if the preview and the published page ever look
 * different, the difference is IN THE DATA — someone saved something, or the
 * snapshot is behind — and can never be an artifact of a second renderer drifting
 * from the first. A parallel projection would make "the preview lied" a
 * permanently open question. There is no second projection here, and there must
 * not be one.
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

import { stringifyCanonical } from '../../../cms/canonical-json.js';
import { buildMediaIndex } from '../../../cms/media.js';
import { isCmsPageRoutable, projectCmsPage, projectedPageBySlug } from '../../../cms/page-data.js';
import type { ProjectedCmsPage } from '../../../cms/page-data.js';

import { guardRequest } from '../guard';
import { ContentUnavailableError, readContent } from '../../content/read';
import { pageIdSchema, unwrapPage } from './get-page';
import type { BffContext } from '../context';

/**
 * The published snapshot (KV, plan §2.3), read for two things only: the media map
 * (media ids are resolved at publish time, so a request-time projection has to be
 * handed the same index), and the "what is on the site" comparison below.
 *
 * Honest limit: an image uploaded since the last publish is not in this index, so
 * its id stays an unresolved string — exactly as it would on the site until the
 * next publish. The preview is wrong in the same direction as the site, which is
 * the only kind of wrong that is safe here.
 */
async function siteSnapshot(ctx: BffContext) {
	const { collections } = await readContent(ctx.content);
	return {
		mediaIndex: buildMediaIndex([
			collections.images ?? [],
			collections.files ?? [],
			collections.videos ?? []
		]),
		pages: (collections.pages ?? []) as ProjectedCmsPage[],
		collections
	};
}

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

export async function loadPagePreview(
	request: Request,
	ctx: BffContext,
	params: { pageId: string },
	options: {
		partitionRenderableBlocks: PartitionRenderableBlocks;
		/** Derive the request-time data a derived section needs (GLC: the sermon strip). */
		messages?: (collections: Record<string, unknown[]>, blocks: unknown[]) => unknown;
	}
): Promise<PagePreviewResult> {
	const { partitionRenderableBlocks } = options;
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

	const raw = unwrapPage(apexResponse.body);
	if (!raw) return { ok: false, status: 502, reason: 'unexpected upstream shape' };

	let site: Awaited<ReturnType<typeof siteSnapshot>>;
	try {
		site = await siteSnapshot(ctx);
	} catch (cause) {
		if (!(cause instanceof ContentUnavailableError)) throw cause;
		return { ok: false, status: 503, reason: 'the site has not been published yet' };
	}

	// ── The site's own projection, on live data. No second implementation. ──
	const projected = projectCmsPage(raw, { media: site.mediaIndex });
	const { renderable, unknownTemplates } = previewBlocks(projected, partitionRenderableBlocks);
	const messages = options.messages ? options.messages(site.collections, renderable) : [];

	// "What is live" for THIS page, stated as a fact rather than a guess: the
	// snapshot's entry and the live projection are the output of the same function,
	// so canonical JSON compares them exactly. `differs` is precisely the state
	// that made a block reorder look like it had done nothing.
	const onSnapshot = projectedPageBySlug(site.pages, projected.slug);
	const onSite: OnSiteState = !onSnapshot
		? 'absent'
		: stringifyCanonical(onSnapshot) === stringifyCanonical(projected)
			? 'identical'
			: 'differs';

	const routable = isCmsPageRoutable(raw);

	return {
		ok: true,
		preview: {
			pageId: idResult.data,
			page: { ...projected, blocks: renderable },
			messages,
			unknownTemplates,
			status: typeof raw.status === 'string' ? raw.status : '',
			routable,
			publicPath: routable ? projected.slug : null,
			savedAt: typeof raw.updated_at === 'string' ? raw.updated_at : null,
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
