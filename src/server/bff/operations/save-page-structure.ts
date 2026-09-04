import { unwrapArchetypeRecord } from '../archetype-record';
import { z } from 'zod';
import { appendAuditEntry } from '../audit';
import { containsReviewOnlyField } from '../authorization';
import { noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { rejectMutation } from '../reject';
import { pageIdSchema } from './get-page';
import { computePageVersion } from '../page-version';
import type { BffContext } from '../context';
import type { PageStructureBody } from '../apex-admin-client';

/**
 * PATCH /api/admin/pages/[pageId]/structure — the block-order / add / remove save
 * `savePage()` dispatches AFTER the per-entity field PATCHes (plan §8, 3a M1). It
 * maps to the one page PATCH Apex permits (`blocks_attributes`, plus the page-level
 * title/slug/summary and `meta_properties_attributes`). Publish/unpublish is NOT
 * here — `:status` is not a permitted page param; that stays the status_event op.
 *
 * The top-level schema is `.strict()` (unknown keys fail closed). `blocks_attributes`
 * is a passthrough array — it is a deep, recursive Apex-shaped payload the client
 * serialized — but the whole body is walked for the review-only invariant first, so
 * a `transcript_reviewed` smuggled inside a nested `entity_attributes.fields_data`
 * is rejected. On success the fresh page's version token is returned so `savePage()`
 * can re-baseline without a second round-trip.
 */
const jsonRecord = z.record(z.string(), z.unknown());

export const savePageStructureBodySchema = z
	.object({
		title: z.string().max(300).optional(),
		slug: z
			.string()
			.max(300)
			.regex(/^[a-z0-9/_-]*$/iu)
			.optional(),
		summary: z.string().max(5000).optional(),
		blocks_attributes: z.array(jsonRecord).max(200).optional(),
		meta_properties_attributes: z.array(jsonRecord).max(50).optional()
	})
	.strict();

export async function handleSavePageStructure(
	request: Request,
	ctx: BffContext,
	params: { pageId: string }
): Promise<Response> {
	const meta = {
		action: 'pages.structure.save',
		method: 'PATCH',
		path: `/api/admin/pages/${params.pageId}/structure`,
		pageId: params.pageId,
		requestId: request.headers.get('cf-ray')
	};

	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectMutation(ctx, meta, guard.status, guard.reason, guard.reason);

	const actorMeta = { ...meta, actorEmail: guard.actor.email, actorSub: guard.actor.sub };

	const idResult = pageIdSchema.safeParse(params.pageId);
	if (!idResult.success)
		return rejectMutation(ctx, actorMeta, 400, 'invalid page id', 'invalid page id');

	let bodyJson: unknown;
	try {
		bodyJson = await request.json();
	} catch {
		return rejectMutation(ctx, actorMeta, 400, 'invalid json', 'invalid json');
	}

	if (containsReviewOnlyField(bodyJson, ctx.reviewOnlyFields)) {
		return rejectMutation(ctx, actorMeta, 400, 'field not allowed', 'review-only field');
	}

	const parsed = savePageStructureBodySchema.safeParse(bodyJson);
	if (!parsed.success) return rejectMutation(ctx, actorMeta, 400, 'invalid body', 'invalid body');

	const apexResponse = await guard.apex.updatePageStructure(
		idResult.data,
		parsed.data as PageStructureBody
	);
	const outcome = apexResponse.ok ? 'accepted' : 'apex_error';

	if (ctx.db) {
		await appendAuditEntry(ctx.db, {
			id: crypto.randomUUID(),
			occurredAt: new Date(ctx.now ?? Date.now()).toISOString(),
			actorEmail: guard.actor.email,
			actorSub: guard.actor.sub,
			action: 'pages.structure.save',
			method: 'PATCH',
			path: actorMeta.path,
			accountId: ctx.accountId ?? null,
			pageId: idResult.data,
			requestId: request.headers.get('cf-ray'),
			outcome,
			detail: {
				blocks: parsed.data.blocks_attributes?.length ?? 0,
				apexStatus: apexResponse.status
			}
		});
	}

	if (!apexResponse.ok) {
		const status =
			apexResponse.status >= 400 && apexResponse.status < 500 ? apexResponse.status : 502;
		return noStoreJson({ error: 'upstream error', status: apexResponse.status }, status);
	}

	// Return the fresh page + its new version so `savePage()` re-baselines the stale
	// guard and reconciles temp-id blocks to their server ids in one round-trip.
	const page = unwrapArchetypeRecord(apexResponse.body);
	const version = page ? await computePageVersion(page) : null;
	return noStoreJson({ ok: true, page, version });
}
