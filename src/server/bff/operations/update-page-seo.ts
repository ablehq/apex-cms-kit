import { z } from 'zod';
import { unwrapArchetypeRecord } from '../archetype-record';
import { auditOutcome } from '../audit';
import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { rejectGuardFailure, rejectMutation } from '../reject';
import { pageIdSchema } from './get-page';
import { pageMetaRows, pageMetaRow, pageMetaProblem } from '../../../cms/page-meta.js';
import type { BffContext } from '../context';

/**
 * The dedicated page SEO route accepts the three web meta names, separate from
 * page.title (`page-draft.js:1217`). Apex silently APPENDS a row without its id
 * (phase-4-plan.md §7 probe), so ids come solely from this request's page read
 * and the page-only selection policy. Only requested names may change.
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
			.refine((meta) => Object.keys(meta).length > 0)
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

	const names = Object.keys(parsed.data.meta);
	for (const name of names) {
		const problem = pageMetaProblem(page.meta_properties, name);
		if (problem)
			return rejectMutation(
				ctx,
				{ ...actor, pageId, detail: { fields: names } },
				409,
				problem,
				`${problem}: ${name}`
			);
	}
	const attributes: Record<string, unknown>[] = [];
	for (const name of names) {
		const selected = pageMetaRow(page.meta_properties, name)!;
		attributes.push({
			id: selected.id,
			name,
			group: 'web',
			value_type: 'string',
			value: parsed.data.meta[name as keyof typeof parsed.data.meta]
		});
		for (const row of pageMetaRows(page.meta_properties, name)) {
			if (row !== selected) attributes.push({ id: row.id, _destroy: true });
		}
	}

	const response = await guard.apex.updatePageStructure(pageId, {
		meta_properties_attributes: attributes
	});
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
