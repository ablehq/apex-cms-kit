import { z } from 'zod';
import { unwrapArchetypeRecord } from '../archetype-record';
import { auditOutcome } from '../audit';
import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { rejectGuardFailure, rejectMutation } from '../reject';
import { pageIdSchema } from './get-page';
import { metaAttributes } from './post-shape';
import type { BffContext } from '../context';

/**
 * The dedicated page SEO route accepts the three web meta names, separate from
 * page.title (`page-draft.js:1217`). Apex silently APPENDS a row without its id
 * (phase-4-plan.md §7 probe), so ids come solely from this request's page read
 * and the same id-keyed builder used by post SEO.
 */
export const updatePageSeoBodySchema = z
	.object({
		meta: z
			.object({
				title: z.string().max(300).optional(),
				description: z.string().max(1000).optional(),
				keywords: z.string().max(500).optional()
			})
			.strict()
	})
	.strict();

export async function handleUpdatePageSeo(
	request: Request,
	ctx: BffContext,
	params: { pageId: string }
): Promise<Response> {
	const meta = {
		action: 'pages.seo.update',
		method: 'PATCH',
		path: '/api/admin/pages/[pageId]/seo',
		requestId: request.headers.get('cf-ray')
	};
	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectGuardFailure(request, ctx, meta, guard);
	const actor = { ...meta, actorEmail: guard.actor.email, actorSub: guard.actor.sub };
	const idResult = pageIdSchema.safeParse(params.pageId);
	if (!idResult.success)
		return rejectMutation(ctx, actor, 400, 'invalid page id', 'invalid page id');
	const pageId = idResult.data;

	let bodyJson: unknown;
	try {
		bodyJson = await request.json();
	} catch {
		return rejectMutation(ctx, actor, 400, 'invalid json', 'invalid json');
	}
	const parsed = updatePageSeoBodySchema.safeParse(bodyJson);
	if (!parsed.success) return rejectMutation(ctx, actor, 400, 'invalid body', 'invalid body');

	const current = await guard.apex.getPage(pageId);
	if (!current.ok) return bffError(502, 'upstream error');
	const page = unwrapArchetypeRecord(current.body);
	if (!page) return bffError(502, 'unexpected upstream shape');

	const attributes = metaAttributes(page, parsed.data.meta);
	// The builder skips a name without an id-bearing row (`post-shape.ts:363-382`).
	// Refuse the whole request before writing so no field appears falsely saved.
	const names = Object.keys(parsed.data.meta);
	const missing = names.filter((name) => !attributes.some((row) => row.name === name));
	if (missing.length)
		return rejectMutation(ctx, actor, 409, 'missing meta row', `missing ${missing.join(', ')} row`);
	const response = attributes.length
		? await guard.apex.updatePageStructure(pageId, { meta_properties_attributes: attributes })
		: { ok: true, status: 200, body: current.body };
	await auditOutcome(ctx, meta, guard.actor, {
		outcome: response.ok ? 'accepted' : 'apex_error',
		pageId,
		detail: { fields: names, apexStatus: response.status }
	});
	if (!response.ok) {
		const status = response.status >= 400 && response.status < 500 ? response.status : 502;
		return noStoreJson({ error: 'upstream error', status: response.status }, status);
	}
	// The §7 probe found updated rows in the PATCH response. If that envelope is
	// absent, the browser's final getPage still decides whether it can refresh.
	return noStoreJson({ ok: true });
}
