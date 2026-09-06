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
 * serialized — but the whole body is walked TWICE before Apex sees it: for the
 * review-only invariant (a `transcript_reviewed` smuggled inside a nested
 * `entity_attributes.fields_data` is rejected), and for ownership (every `id`,
 * `blockable_id`, `parent_template_instance_id` and
 * `group_member_template_instance_ids[]` must be an id of the addressed page's
 * freshly-read tree — else 400 `block not on this page`, no write). On success the
 * fresh page's version token is returned so `savePage()` can re-baseline without a
 * second round-trip.
 */
const jsonRecord = z.record(z.string(), z.unknown());

/**
 * Every id in a page's tree, as Apex just returned it: the page, its blocks, their
 * blockables, entities, child template instances, display meta properties and the
 * page's own meta properties — any `id` string at any depth. This is the set a
 * structure save may name; nothing outside it belongs to this page.
 */
export function collectPageIds(page: unknown): Set<string> {
	const ids = new Set<string>();
	const walk = (value: unknown, depth: number) => {
		if (depth > 32 || value === null || typeof value !== 'object') return;
		if (Array.isArray(value)) {
			for (const item of value) walk(item, depth + 1);
			return;
		}
		const record = value as Record<string, unknown>;
		if (typeof record.id === 'string' && record.id !== '') ids.add(record.id);
		for (const child of Object.values(record)) walk(child, depth + 1);
	};
	walk(page, 0);
	return ids;
}

/** The keys under which a structure body names an existing row. */
const OWNED_ID_KEYS = ['id', 'blockable_id', 'parent_template_instance_id'] as const;
const OWNED_ID_LIST_KEYS = ['group_member_template_instance_ids'] as const;

/**
 * The first id in `body` that is not one of `owned` — `null` when every id the body
 * names belongs to the addressed page. Walks the whole body (blocks, nested
 * blockable/entity/child attributes, `_destroy` rows, meta properties): Rails
 * permits `blockable_id` and nested `blockable_attributes.id`, and
 * `Cms::PageBlock accepts_nested_attributes_for :blockable`, so a body naming
 * another page's blockable id plus nested attributes would rewrite THAT page's
 * content. The editor never sends `blockable_id`, and every `id` it sends came
 * from this page's own tree (block-serialize.js strips temp ids), so an honest
 * save never trips this; a new block simply names no ids.
 */
export function findForeignId(body: unknown, owned: Set<string>): { key: string } | null {
	const walk = (value: unknown, depth: number): { key: string } | null => {
		if (depth > 32 || value === null || typeof value !== 'object') return null;
		if (Array.isArray(value)) {
			for (const item of value) {
				const found = walk(item, depth + 1);
				if (found) return found;
			}
			return null;
		}
		const record = value as Record<string, unknown>;
		for (const key of OWNED_ID_KEYS) {
			const id = record[key];
			if (id === undefined || id === null) continue;
			if (typeof id !== 'string' || !owned.has(id)) return { key };
		}
		for (const key of OWNED_ID_LIST_KEYS) {
			const list = record[key];
			if (list === undefined || list === null) continue;
			if (!Array.isArray(list)) return { key };
			for (const id of list) if (typeof id !== 'string' || !owned.has(id)) return { key };
		}
		for (const child of Object.values(record)) {
			const found = walk(child, depth + 1);
			if (found) return found;
		}
		return null;
	};
	return walk(body, 0);
}

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

	// Ownership: every id the body names must be in the addressed page's tree, read
	// FRESH here (never from the body). Anything else is refused before the PATCH,
	// with zero writes — see `findForeignId` for what Rails would otherwise permit.
	const current = await guard.apex.getPage(idResult.data);
	if (!current.ok) {
		return noStoreJson({ error: 'upstream error', status: current.status }, 502);
	}
	const currentPage = unwrapArchetypeRecord(current.body);
	if (!currentPage) return noStoreJson({ error: 'upstream error' }, 502);
	const owned = collectPageIds(currentPage);
	owned.add(idResult.data);
	const foreign = findForeignId(parsed.data, owned);
	if (foreign) {
		return rejectMutation(
			ctx,
			{ ...actorMeta, detail: { key: foreign.key } },
			400,
			'block not on this page',
			'foreign id'
		);
	}

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
	//
	// A malformed envelope here answers 200 with `page: null`, NOT 502 — unlike
	// `get-page` and `preview-page`, which do 502 on the same shape. The difference is
	// deliberate: by this line the PATCH has already landed upstream, so a 502 would
	// tell the editor a completed write failed and `savePage()` would retry it. Null
	// is the honest answer, and `save-page.js` is written for it — it falls back to a
	// fresh `getPage()` and, if that fails too, returns `{ ok: true, refreshed: false }`
	// so the UI can prompt a reload. Do not "fix" this into a 502.
	const page = unwrapArchetypeRecord(apexResponse.body);
	const version = page ? await computePageVersion(page) : null;
	return noStoreJson({ ok: true, page, version });
}
