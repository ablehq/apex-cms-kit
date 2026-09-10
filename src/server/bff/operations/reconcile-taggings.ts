import { z } from 'zod';
import { auditOutcome } from '../audit';
import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { rejectGuardFailure, rejectMutation } from '../reject';
import {
	archetypeIdSchema,
	cleanString,
	unwrapArchetypeCollection,
	unwrapArchetypeRecord
} from '../archetype-record';
import { contractOf, noContractResponse } from '../content-contract-guard';
import { judgeCreatedId, shapeFaultDetail } from './created-id';
import { loadPostView, postIdSchema, postRouteMeta, postSchemaOf, readPostIds } from './post-shape';
import type { ApexAdminClient } from '../apex-admin-client';
import type { BffContext } from '../context';

/**
 * The tag surface — the reconciler GLC's `reconcile-taggings.ts` proved, moved
 * here with the post mechanics and parameterised on the schema (plan 04, G1):
 *
 *   PUT  /api/admin/posts/[schema]/[postId]/tags   the reconciliation
 *   GET  /api/admin/tags                           the vocabulary
 *   POST /api/admin/tags                           list-then-create, adopt on 422
 *
 * WHY THIS IS A RECONCILIATION AND NOT AN APPEND. `POST /taggings` IS NOT
 * IDEMPOTENT: an identical retry returns 200 and creates a SECOND row —
 * `Tagging` has no uniqueness validation and no unique index. A browser that
 * retries is enough to corrupt a record's tags. So the ONE call the browser can
 * retry is made idempotent: it sends the FULL DESIRED SET, and this operation
 * reads the current set, POSTs only what is missing, DELETEs what is not wanted
 * AND the duplicate rows, then re-reads and heals once more.
 *
 * WHY NOTHING HERE DELETES A TAG. `DELETE /tags/:id` cascades across the whole
 * account. The Apex client ships no `deleteTag`, and removing a tag from a record
 * is `deleteTagging` — the correctly scoped call.
 */

/** One reconciled association. `id` is the TAGGING's id — never the tag's. */
export interface ReconciledTagging {
	id: string;
	tagId: string;
	tagName: string;
}

export interface AdminTagRecord {
	id: string;
	name: string;
}

interface TaggingRow {
	id: string;
	tagId: string;
	createdAt: string;
}

const TAG_PAGE_SIZE = 100;
/** Enough for any vocabulary this admin will meet; past it the read fails closed. */
const MAX_TAG_PAGES = 20;

/**
 * The whole vocabulary, every page, or null when it would not read completely.
 * Fails CLOSED on a page it cannot account for: a partial vocabulary would refuse
 * a real tag as unknown, or adopt the wrong one.
 */
export async function readTagVocabulary(apex: ApexAdminClient): Promise<AdminTagRecord[] | null> {
	const rows: AdminTagRecord[] = [];
	for (let page = 1; page <= MAX_TAG_PAGES; page += 1) {
		const response = await apex.listTags({ per_page: TAG_PAGE_SIZE, page });
		if (!response.ok) return null;
		const pageRows = unwrapArchetypeCollection(response.body);
		for (const row of pageRows) {
			const id = cleanString(row.id);
			const name = cleanString(row.name);
			if (id && name) rows.push({ id, name });
		}
		const pagination = (response.body as { pagination?: { total_pages?: unknown } } | null)
			?.pagination;
		const totalPages = Number(pagination?.total_pages);
		if (Number.isInteger(totalPages)) {
			if (page >= totalPages) return rows;
			continue;
		}
		// No pagination metadata: a full page means there may be more we cannot see.
		if (pageRows.length >= TAG_PAGE_SIZE) return null;
		return rows;
	}
	return null;
}

/**
 * The rows Apex currently holds for one taggable, OLDEST FIRST. The sort is not
 * cosmetic: `partition` keeps the first row of each tag group and deletes the
 * rest, and "first" has to be stable or two reconciliations of the same record
 * would churn ids. Apex's own list order is NOT creation order (measured).
 */
async function readTaggingRows(
	apex: ApexAdminClient,
	taggableId: string
): Promise<TaggingRow[] | null> {
	const response = await apex.listTaggings({
		'q[taggable_id_eq]': taggableId,
		'q[taggable_type_eq]': 'Specification::Archetype'
	});
	if (!response.ok) return null;
	return unwrapArchetypeCollection(response.body)
		.map((row) => ({
			id: cleanString(row.id),
			tagId: cleanString(row.tag_id),
			createdAt: cleanString(row.created_at)
		}))
		.filter((row) => row.id.length > 0 && row.tagId.length > 0)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * Reduce the rows to "one row per tag, plus the extras that should not exist".
 * The OLDEST row of each tag group survives: it is the one that existed before
 * whatever retry produced the duplicate.
 */
export function partitionTaggings(rows: TaggingRow[], desired: string[]) {
	const keep = new Map<string, TaggingRow>();
	const doomed: TaggingRow[] = [];
	for (const row of rows) {
		if (!desired.includes(row.tagId)) {
			doomed.push(row);
			continue;
		}
		if (keep.has(row.tagId)) doomed.push(row);
		else keep.set(row.tagId, row);
	}
	const missing = desired.filter((tagId) => !keep.has(tagId));
	return { keep, doomed, missing };
}

/**
 * Make the record's taggings equal `desiredTagIds`, and return what is actually
 * there afterwards. Safe to call twice with the same arguments — that is the point.
 */
export async function reconcileTaggings(
	apex: ApexAdminClient,
	taggableId: string,
	desiredTagIds: string[],
	names: Map<string, string>
): Promise<ReconciledTagging[] | null> {
	const current = await readTaggingRows(apex, taggableId);
	if (!current) return null;

	const first = partitionTaggings(current, desiredTagIds);

	// Deletes BEFORE creates. If the reconciliation is interrupted half-way, a
	// record missing a tag is a smaller lie than one carrying a tag an editor removed.
	for (const row of first.doomed) {
		const deleted = await apex.deleteTagging(row.id);
		if (!deleted.ok) return null;
	}
	for (const tagId of first.missing) {
		const created = await apex.createTagging(tagId, taggableId);
		if (!created.ok) return null;
	}

	// Re-read and heal ONCE more: the create above is the non-idempotent call, so a
	// concurrent save can still leave a duplicate behind. This pass makes the RESULT
	// duplicate-free, and is the independent confirmation that the writes landed.
	const after = await readTaggingRows(apex, taggableId);
	if (!after) return null;
	const second = partitionTaggings(after, desiredTagIds);
	for (const row of second.doomed) {
		await apex.deleteTagging(row.id).catch(() => undefined);
	}

	return desiredTagIds
		.map((tagId) => {
			const row = second.keep.get(tagId);
			return row ? { id: row.id, tagId, tagName: names.get(tagId) ?? '' } : null;
		})
		.filter((row): row is ReconciledTagging => row !== null);
}

export const setPostTagsBodySchema = z
	.object({
		// The FULL desired set. Bounded, deduplicated below — an unbounded list would
		// be an unbounded number of Apex round trips from one request.
		tagIds: z.array(archetypeIdSchema).max(50)
	})
	.strict();

/**
 * PUT /api/admin/posts/[schema]/[postId]/tags — the desired set, reconciled.
 *
 * The post must be a post OF THIS SCHEMA: `POST /taggings` takes a bare archetype
 * id and is not schema-scoped, so without the scoped view read a route named
 * `/posts/update/:id/tags` would happily tag a story. Every tag must already be in
 * the vocabulary — Apex accepts a tagging that points at nothing, and the public
 * site would render a tag with no name.
 */
export async function handleSetPostTags(
	request: Request,
	ctx: BffContext,
	params: { schema: string; postId: string }
): Promise<Response> {
	const contract = contractOf(ctx);
	if (!contract) return noContractResponse();
	const meta = postRouteMeta(request, 'posts.tags.put', 'PUT', true, '/tags');

	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectGuardFailure(request, ctx, meta, guard);
	const actor = { ...meta, actorEmail: guard.actor.email, actorSub: guard.actor.sub };

	if (!postSchemaOf(contract, params.schema)) {
		return rejectMutation(ctx, actor, 404, 'unknown collection', 'unknown collection');
	}
	const idResult = postIdSchema.safeParse(params.postId);
	if (!idResult.success) return rejectMutation(ctx, actor, 400, 'invalid id', 'invalid post id');

	let bodyJson: unknown;
	try {
		bodyJson = await request.json();
	} catch {
		return rejectMutation(ctx, actor, 400, 'invalid json', 'invalid json');
	}
	const parsed = setPostTagsBodySchema.safeParse(bodyJson);
	if (!parsed.success) return rejectMutation(ctx, actor, 400, 'invalid body', 'invalid body');
	// Deduplicate the REQUEST too: asking for the same tag twice must not be a way
	// to ask this operation to create the duplicate it exists to prevent.
	const desired = [...new Set(parsed.data.tagIds)];

	const view = await loadPostView(guard.apex, params.schema, idResult.data);
	if (!view) return rejectMutation(ctx, actor, 404, 'not found', 'not found');
	const ids = readPostIds(view);
	if (!ids.archetypeId) return bffError(502, 'unexpected upstream shape');

	const vocabulary = await readTagVocabulary(guard.apex);
	if (!vocabulary) return bffError(502, 'upstream error');
	const names = new Map(vocabulary.map((tag) => [tag.id, tag.name]));
	if (desired.some((tagId) => !names.has(tagId))) {
		return rejectMutation(ctx, actor, 400, 'unknown-tag', 'unknown tag id');
	}

	const taggings = await reconcileTaggings(guard.apex, ids.archetypeId, desired, names);

	await auditOutcome(ctx, meta, guard.actor, {
		outcome: taggings ? 'accepted' : 'apex_error',
		detail: { schema: params.schema, postId: ids.postId, tagCount: desired.length }
	});

	if (!taggings) return bffError(502, 'upstream error');
	return noStoreJson({ ok: true, taggings });
}

/** GET /api/admin/tags — the vocabulary, as the picker lists it. */
export async function handleListTags(request: Request, ctx: BffContext): Promise<Response> {
	const guard = await guardRequest(request, ctx, { mutation: false });
	if (!guard.ok) return guard.response;
	const tags = await readTagVocabulary(guard.apex);
	if (!tags) return bffError(502, 'upstream error');
	return noStoreJson({ tags });
}

export const createTagBodySchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();

/**
 * POST /api/admin/tags — add a word to the vocabulary from inside the picker.
 *
 * LIST-THEN-CREATE, ADOPT ON 422. `Tag` validates uniqueness per tenant, so a
 * name that already exists comes back as a 422 that is not an error an editor
 * should see: they typed a tag name and a tag by that name exists, which is what
 * they asked for. The lookup is exact-match first; the fallback after a 422 widens
 * to case-insensitive, because at that point Apex has TOLD us a colliding row
 * exists and the only question left is which one it is.
 */
export async function handleCreateTag(request: Request, ctx: BffContext): Promise<Response> {
	const meta = {
		action: 'tags.create',
		method: 'POST',
		path: '/api/admin/tags',
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
	const parsed = createTagBodySchema.safeParse(bodyJson);
	if (!parsed.success) return rejectMutation(ctx, actor, 400, 'invalid body', 'invalid body');
	const name = parsed.data.name;

	const existing = await readTagVocabulary(guard.apex);
	if (!existing) return bffError(502, 'upstream error');
	const already = existing.find((tag) => tag.name === name);
	if (already) return noStoreJson({ ok: true, tag: already, created: false });

	const apexResponse = await guard.apex.createTag(name);

	/**
	 * THE VERDICT, TAKEN BEFORE THE AUDIT ROW IS WRITTEN — and the 422 adoption is
	 * PART of the verdict, not a recovery after it.
	 *
	 * This is the fifth 2xx-create in this BFF, and it kept the contradiction the
	 * other four were fixed for (codex P5 fix 4, item 2). It wrote `accepted` for ANY
	 * 2xx and for ANY 422, and only afterwards decided whether it could name a tag —
	 * so a 2xx whose body had no usable id was logged as an ACCEPTANCE and answered
	 * 502, and a 422 whose re-read found nothing to adopt was logged as an ACCEPTANCE
	 * and answered 422. An audit row that contradicts the response is worse than no
	 * row: it is the row an operator would trust. `created-id.ts` carries the shared
	 * rule and the reasoning.
	 *
	 * On a 422 the question this request actually ends on is "is there now a tag by
	 * this name that we can name?", and nothing answers that until the re-read has
	 * run. So the adoption happens first and the audit reports what it found.
	 */
	const record = apexResponse.ok ? unwrapArchetypeRecord(apexResponse.body) : null;
	const verdict = judgeCreatedId(apexResponse.ok, record?.id, 'tag');
	const returnedName = cleanString(record?.name);

	/**
	 * A 2xx that named a DIFFERENT WORD is as unusable as one that named nothing.
	 * The picker is about to show the typed word as selected, and the id underneath
	 * it would belong to another tag — every record tagged from that session would
	 * carry the wrong word. `judgeCreatedId` cannot see this, because the name is
	 * this create's second output and it only judges the first.
	 *
	 * Measured on local Apex before making it fatal: `POST /tags` echoes `name`
	 * VERBATIM — case, inner spaces and even the leading/trailing ones a caller
	 * sends (the body schema has already trimmed by then). So a mismatch is a real
	 * upstream-shape fault and not this handler misreading a normalisation.
	 */
	const wrongName = verdict.id !== null && returnedName !== name;

	// The race the list above cannot close: another editor created it between the
	// read and the write. Re-read and adopt rather than showing a validation error.
	// Exact match first; the case-insensitive fallback is only reached once Apex has
	// TOLD us a colliding row exists and the only question left is which one.
	let adopted: AdminTagRecord | null = null;
	if (!apexResponse.ok && apexResponse.status === 422) {
		const refreshed = await readTagVocabulary(guard.apex);
		adopted =
			refreshed?.find((tag) => tag.name === name) ??
			refreshed?.find((tag) => tag.name.toLowerCase() === name.toLowerCase()) ??
			null;
	}

	const created =
		apexResponse.ok && verdict.id !== null && !wrongName
			? { id: verdict.id, name: returnedName }
			: null;

	await auditOutcome(ctx, meta, guard.actor, {
		// `accepted` means one thing only: this request ended holding a tag it can
		// name — either the one Apex just created, or the one the 422 pointed at.
		// A 2xx it cannot name is `upstream_shape_error` (a row almost certainly
		// exists and nothing can point at it); anything else is `apex_error`.
		outcome:
			created || adopted ? 'accepted' : apexResponse.ok ? 'upstream_shape_error' : 'apex_error',
		detail: {
			name,
			tagId: created?.id ?? adopted?.id ?? null,
			...(apexResponse.status === 422 ? { adopted: adopted !== null } : {}),
			...(wrongName
				? { reason: 'unexpected-tag-name', returnedName: returnedName.slice(0, 120) }
				: shapeFaultDetail(verdict)),
			apexStatus: apexResponse.status
		}
	});

	if (created) return noStoreJson({ ok: true, tag: created, created: true }, 201);
	if (adopted) return noStoreJson({ ok: true, tag: adopted, created: false });
	if (apexResponse.ok) return bffError(502, 'unexpected upstream shape');

	const status =
		apexResponse.status >= 400 && apexResponse.status < 500 ? apexResponse.status : 502;
	return noStoreJson({ error: 'upstream error', status: apexResponse.status }, status);
}
