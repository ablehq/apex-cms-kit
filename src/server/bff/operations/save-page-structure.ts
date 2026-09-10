import { unwrapArchetypeRecord } from '../archetype-record';
import { z } from 'zod';
import { appendAuditEntry } from '../audit';
import { containsReviewOnlyField } from '../authorization';
import { noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import {
	refuseOversizedFields,
	refuseUnreadableUrls,
	rejectGuardFailure,
	rejectMutation
} from '../reject';
import { sanitizeFieldValue } from '../../../sanitize/write-boundary';
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

/**
 * The keys under which a structure body carries a BAG OF FIELD VALUES rather than
 * structure. Apex's page permit spells `fields_data` as `property_set_attributes.info`
 * (`ContentLibrary::Entity` reads its `fields_data` out of `property_set.info_object.rows`),
 * so both names address the same thing and both are measured entry by entry.
 */
const FIELD_VALUE_BAGS = new Set(['fields_data', 'info']);

/**
 * The caller-supplied VALUES inside a structure body, flattened to `path -> value` so
 * that the two refusals every other write path already runs can run here too.
 *
 * WHY THIS EXISTS. `blocks_attributes` is `z.array(jsonRecord)` — a deliberate
 * passthrough for the Apex-shaped tree, which is walked twice already (for
 * review-only keys, and for id ownership) and both of those walks are about KEYS.
 * Nothing looked at the values, so this was the one write path in the BFF with no
 * ceiling and no URL judge: `patch-entity-fields`, `create-entity`, `create-record`,
 * `update-record`, `create-post`, `update-post-archetype` and `save-post-body` all
 * run both, and this one ran neither.
 *
 * MEASURED THE SAME WAY THE SIBLINGS MEASURE, deliberately, so this route is not held
 * to a tighter rule than the rest of the boundary. A field bag is measured ENTRY BY
 * ENTRY — a structured field value (a Quill delta, a rich-text envelope) is measured
 * whole, exactly as `patch-entity-fields` measures one `fields_data` entry — and every
 * other string leaf is measured on its own. The whole block is NOT measured as one
 * value: that would be a ceiling no other path imposes, and a legitimately long page
 * would trip it.
 *
 * Keyed by PATH (`blocks_attributes[3].blockable_attributes.content_html`) because the
 * refusals name the field they refuse, and "content_html" alone would send an editor
 * bisecting a 200-block page to find which one.
 */
export function structureValueFields(body: unknown): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	const walk = (value: unknown, path: string, depth: number) => {
		if (depth > 32) return;
		// A string is a value wherever it sits — INCLUDING inside an array. An earlier
		// draft of this walk descended into arrays but only recorded strings found as
		// object properties, so `group_member_template_instance_ids: [<200k chars>]`
		// measured nothing at all.
		if (typeof value === 'string') {
			values[path] = value;
			return;
		}
		if (value === null || typeof value !== 'object') return;
		if (Array.isArray(value)) {
			value.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
			return;
		}
		for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
			const here = path ? `${path}.${key}` : key;
			if (
				FIELD_VALUE_BAGS.has(key) &&
				nested &&
				typeof nested === 'object' &&
				!Array.isArray(nested)
			) {
				for (const [name, fieldValue] of Object.entries(nested as Record<string, unknown>)) {
					values[`${here}.${name}`] = fieldValue;
				}
				continue;
			}
			walk(nested, here, depth + 1);
		}
	};
	walk(body, '', 0);
	return values;
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
		// The route TEMPLATE, not the request's own path. `reject.ts` states the rule
		// and `postRouteMeta` already follows it: a route parameter is
		// attacker-controlled until validated, and this meta is built BEFORE the
		// validation, so interpolating it would write an arbitrary caller string into
		// the audit table's `path` on every refused request. The validated values go
		// in `detail`.
		path: '/api/admin/pages/[pageId]/structure',
		// NO `pageId` HERE. `auditRejection` writes it to its own indexed column, and
		// this meta is built before `pageIdSchema` runs — so an unvalidated route
		// parameter reached that column on every guard failure. It is added below, once
		// there is a validated id to add.
		requestId: request.headers.get('cf-ray')
	};

	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectGuardFailure(request, ctx, meta, guard);

	const actorMeta = { ...meta, actorEmail: guard.actor.email, actorSub: guard.actor.sub };

	const idResult = pageIdSchema.safeParse(params.pageId);
	if (!idResult.success)
		return rejectMutation(ctx, actorMeta, 400, 'invalid page id', 'invalid page id');
	// From here the id HAS been validated, so it may go in the column it belongs in.
	const validMeta = { ...actorMeta, pageId: idResult.data };

	let bodyJson: unknown;
	try {
		bodyJson = await request.json();
	} catch {
		return rejectMutation(ctx, validMeta, 400, 'invalid json', 'invalid json');
	}

	if (containsReviewOnlyField(bodyJson, ctx.reviewOnlyFields)) {
		return rejectMutation(ctx, validMeta, 400, 'field not allowed', 'review-only field');
	}

	const parsed = savePageStructureBodySchema.safeParse(bodyJson);
	if (!parsed.success) return rejectMutation(ctx, validMeta, 400, 'invalid body', 'invalid body');

	// The same two rules `patch-entity-fields.ts:109-115` runs, in the same place —
	// after the schema, before any Apex round-trip. Both name the offending field
	// rather than collapsing into `invalid body`, because an editor who pasted a
	// document into one of a page's blocks should not find it by bisection.
	//
	// The ceiling is the half that bites today. `MAX_FIELD_VALUE_CHARS`'s own docblock
	// calls it "a MECHANIC, not a screen's preference", and describes this route
	// exactly: without one, a single authenticated POST pushes an unbounded string
	// through the BFF into Apex and into the published snapshot — where `publishContent`
	// then refuses the whole snapshot as `too_large`, blocking publishing SITE-WIDE for
	// every collection, with nothing pointing at the block that caused it.
	const structureValues = structureValueFields(parsed.data);
	const tooLarge = await refuseOversizedFields(ctx, validMeta, structureValues);
	if (tooLarge) return tooLarge;
	const unreadable = await refuseUnreadableUrls(ctx, validMeta, structureValues);
	if (unreadable) return unreadable;

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
			{ ...validMeta, detail: { key: foreign.key } },
			400,
			'block not on this page',
			'foreign id'
		);
	}

	// The third rule the siblings run, and the last one this path was missing.
	// `sanitizeFieldValue` is the SAME call `patch-entity-fields.ts:119` makes over one
	// entity's `fields_data`; here it walks the block tree, which carries field bags of
	// its own (`entities_attributes[].property_set_attributes.info` IS `fields_data`)
	// plus `blockable_attributes.content_html`, the raw HTML column on
	// `Cms::PageBlock::RichText`.
	//
	// It is `sanitizeWriteHtml` underneath, NOT the render allowlist: it removes
	// executable elements and dangerous attributes and leaves everything else exactly
	// as the editor wrote it. A string with no `<` in it is returned by reference, so
	// ids, slugs and positions are untouched — the identity contract that file
	// documents holds for the whole tree.
	//
	// Not an XSS fix. `content_html` is sanitized again at projection by GLC and
	// Poovayya, and Godrej's loader never renders it. This is the write boundary doing
	// at the boundary what three sites currently each do downstream.
	const sanitizedBody = {
		...parsed.data,
		...(parsed.data.blocks_attributes
			? { blocks_attributes: sanitizeFieldValue(parsed.data.blocks_attributes) }
			: {}),
		...(parsed.data.meta_properties_attributes
			? {
					meta_properties_attributes: sanitizeFieldValue(parsed.data.meta_properties_attributes)
				}
			: {})
	};

	const apexResponse = await guard.apex.updatePageStructure(
		idResult.data,
		sanitizedBody as PageStructureBody
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
