import { z } from 'zod';
import { auditOutcome } from '../audit';
import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { rejectGuardFailure, rejectMutation } from '../reject';
import { unwrapArchetypeRecord } from '../archetype-record';
import { computePageVersion } from '../page-version';
import { getPageSlugValidationError } from '../../../cms/page-slug-validation.js';
import { createdIdOutcome, judgeCreatedId, shapeFaultDetail } from './created-id';
import { rejectedWriteResponse } from './post-shape';
import type { BffContext } from '../context';

/**
 * POST /api/admin/pages — mint a page (plan 04, G3). The one write neither site
 * had: GLC's pages screen says "CAPABILITY GAP — New page", and Godrej's pages
 * were provisioned by scripts. `POST /cms/pages` permits title, summary and slug;
 * measured 2026-09-05 it answers with a `draft` page carrying its `web` SEO triple
 * and no blocks, so create-then-reveal is cheap and safe — nothing half-finished
 * can reach the public site, which serves only `published` pages.
 *
 * TWO refusals Apex does not make. A duplicate slug it does refuse (422, surfaced
 * as `409 slug-taken`); a slug the SITE reserves — `/admin`, `/api`, a generated
 * tree like `/blogs` — it accepts, and the page then silently never renders
 * because a filesystem route outranks it. `getPageSlugValidationError` is the
 * same guard the site's renderer and its authoring script read; it needs the
 * site's reserved routes bound (`bindReservedRoutes`, in the site's `site.js`),
 * and fails closed with a 500 rather than guessing when they are not.
 */
export const createPageBodySchema = z
	.object({
		title: z.string().min(1).max(300),
		slug: z
			.string()
			.min(1)
			.max(300)
			.regex(/^[a-z0-9/_-]+$/iu),
		summary: z.string().max(5000).optional()
	})
	.strict();

export async function handleCreatePage(request: Request, ctx: BffContext): Promise<Response> {
	const meta = {
		action: 'pages.create',
		method: 'POST',
		path: '/api/admin/pages',
		requestId: request.headers.get('cf-ray')
	};

	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectGuardFailure(request, ctx, meta, guard);
	const actor = { ...meta, actorEmail: guard.actor.email, actorSub: guard.actor.sub };

	let bodyJson: unknown;
	try {
		bodyJson = await request.json();
	} catch {
		return rejectMutation(ctx, actor, 400, 'invalid json', 'invalid json');
	}
	const parsed = createPageBodySchema.safeParse(bodyJson);
	if (!parsed.success) return rejectMutation(ctx, actor, 400, 'invalid body', 'invalid body');

	let reserved: string;
	try {
		reserved = getPageSlugValidationError(parsed.data.slug);
	} catch {
		// The site never bound its reserved routes: nothing here can say whether the
		// slug is safe, and a page that silently never renders is the worse answer.
		return bffError(500, 'reserved routes not bound');
	}
	if (reserved) {
		return rejectMutation(ctx, actor, 400, 'reserved-slug', reserved);
	}

	const apexResponse = await guard.apex.createPage({
		title: parsed.data.title,
		slug: parsed.data.slug,
		summary: parsed.data.summary ?? ''
	});

	// THE VERDICT, TAKEN BEFORE THE AUDIT IS WRITTEN — the rule and the reasoning are
	// in `created-id.ts`. This handler used to audit `accepted` on any 2xx and then
	// answer 502 for an idless body, and its id check was `typeof page.id ===
	// 'string'`, which accepts the EMPTY STRING: an empty id reached the response as
	// `page.id` and would have been interpolated into the next Apex URL the editor
	// asked for (codex's P5 fix review, 2026-09-08).
	const page = unwrapArchetypeRecord(apexResponse.body);
	const verdict = judgeCreatedId(apexResponse.ok, page ? page.id : null, 'page');

	await auditOutcome(ctx, meta, guard.actor, {
		outcome: createdIdOutcome(apexResponse.ok, verdict),
		detail: {
			slug: parsed.data.slug,
			pageId: verdict.id,
			...shapeFaultDetail(verdict),
			apexStatus: apexResponse.status
		}
	});

	// Apex's own validation: `409 slug-taken` when the slug is what it refused,
	// `422 invalid` with the field errors otherwise — the same rule as the posts.
	if (apexResponse.status === 422) return rejectedWriteResponse(apexResponse.body);
	if (!apexResponse.ok) return bffError(502, 'upstream error');
	if (!page || !verdict.id) return bffError(502, 'unexpected upstream shape');

	// The create echo carries the whole page (blocks `[]`, the SEO triple), so the
	// version can be computed from it; the editor re-reads on open anyway.
	return noStoreJson({ ok: true, page, version: await computePageVersion(page) }, 201);
}
