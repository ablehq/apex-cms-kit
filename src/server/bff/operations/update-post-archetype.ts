import { auditOutcome } from '../audit';
import { containsNullPrimitive } from '../authorization';
import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import {
	refuseOversizedFields,
	refuseUnreadableUrls,
	rejectGuardFailure,
	rejectMutation
} from '../reject';
import { contractOf, noContractResponse } from '../content-contract-guard';
import {
	hasManyDiff,
	recordBodySchema,
	referenceFieldNames,
	summarizeRecord
} from './record-shape';
import { toApexFields } from './update-record';
import {
	buildPostLoad,
	loadPostView,
	postIdSchema,
	postRouteMeta,
	postSchemaOf,
	readPostArchetype,
	readPostIds
} from './post-shape';
import type { HasManyEntry } from '../apex-admin-client';
import type { BffContext } from '../context';

/**
 * PUT /api/admin/posts/[schema]/[postId]/archetype — the ARCHETYPE half of a
 * post: its primitives (a story's `kind`) and its references (author has_one;
 * focus_area and partner has_many).
 *
 * The write goes to `…/{schema}/archetype_models/:archetypeId`, and the archetype
 * id is resolved from Apex's own view — read through the schema-scoped list, so a
 * post of another schema is a 404 here and nothing is written.
 *
 * The body is exactly the record update's: `recordBodySchema` built from the
 * contract, so an unknown field is a 400 rather than a silently ignored key, and
 * the same null rule — `null` on a PRIMITIVE is refused (it destroys the row and
 * strands the old value in `primitives`), `null` on a has_one is the ONLY way to
 * clear it. A has_many arrives as the DESIRED SET and is diffed here against a
 * read taken in this request, as `update-record.ts` does and for the same reason:
 * `apply_has_many_value` upserts, so a removal must travel as `_destroy` against
 * the JOIN ROW id.
 *
 * A LIST IS WRITABLE ON A POST ARCHETYPE, and it did not used to be.
 *
 * There was no child-list transport here — the content-library path routed its
 * lists to `…/schema_item/{field}/items` and this one had nowhere to send them —
 * so an array-shaped field on a post schema was refused outright, in the currency
 * a caller can act on, rather than reaching `updatePostArchetype` and throwing.
 *
 * A post's primitives go through the SAME `archetype_models` controller a record's
 * do (`updatePostArchetype` PATCHes `archetype_schemas/:slug/archetype_models/:id`),
 * so `ellipsis-backend` PR #1888 (`fix/archetype-model-array-fields`) widened both
 * at once and the list rides this PATCH like every other field.
 *
 * The refusal that REMAINS is per-field, not per-surface: `recordBodySchema`
 * rejects an array on anything but a single-field Primitive of an array kind,
 * because on everything else the flat surface still reduces it to `[]`. No post
 * schema on any site declares an array kind today, so the kit's hermetic tests
 * are the evidence for both halves here.
 *
 * Unchanged either way: this surface still carries no unbacked partial-write
 * guard (plan 07's P3 log records that gap), and that one is about a record's own
 * shape rather than a backend version.
 */
export async function handleUpdatePostArchetype(
	request: Request,
	ctx: BffContext,
	params: { schema: string; postId: string }
): Promise<Response> {
	const contract = contractOf(ctx);
	if (!contract) return noContractResponse();
	const meta = postRouteMeta(request, 'posts.update_archetype', 'PUT', true, '/archetype');

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

	const submitted = (bodyJson as { fields?: Record<string, unknown> })?.fields;
	if (submitted && containsNullPrimitive(submitted, referenceFieldNames(contract, params.schema))) {
		return rejectMutation(ctx, actor, 400, 'null-field', 'null primitive');
	}
	// The per-field ceiling, named before the shape check so the refusal can say
	// WHICH field is over it (`field-too-large`) rather than a generic `invalid body`.
	const tooLarge = await refuseOversizedFields(ctx, actor, submitted);
	if (tooLarge) return tooLarge;
	// The other half of the same rule (Opus O5): a URL attribute this judge cannot
	// read is refused BY NAME rather than silently stripped on the way through the
	// sanitizer, so an editor is told which field to look at.
	const unreadable = await refuseUnreadableUrls(ctx, actor, submitted);
	if (unreadable) return unreadable;

	const parsed = recordBodySchema(contract, params.schema).safeParse(bodyJson);
	if (!parsed.success) return rejectMutation(ctx, actor, 400, 'invalid body', 'invalid body');

	const fields = toApexFields(parsed.data.fields ?? {});
	const wantedReferences = parsed.data.references ?? {};
	if (Object.keys(fields).length === 0 && Object.keys(wantedReferences).length === 0) {
		return rejectMutation(ctx, actor, 400, 'empty patch', 'empty patch');
	}
	const view = await loadPostView(guard.apex, params.schema, idResult.data);
	if (!view) return rejectMutation(ctx, actor, 404, 'not found', 'not found');
	const ids = readPostIds(view);
	if (!ids.archetypeId) return bffError(502, 'unexpected upstream shape');

	const references: Record<string, HasManyEntry[] | string | null> = {};
	if (Object.keys(wantedReferences).length > 0) {
		const current = await readPostArchetype(guard.apex, params.schema, ids.archetypeId);
		if (!current) return bffError(502, 'upstream error');
		const held = summarizeRecord(contract, params.schema, current).references;
		for (const item of contract.referenceItems(params.schema)) {
			const wanted = (wantedReferences as Record<string, unknown>)[item.name];
			if (wanted === undefined) continue;
			if (item.relationship_kind === 'has_one') {
				references[item.name] = (wanted as string | null) ?? null;
				continue;
			}
			const diff = hasManyDiff(item.name, held[item.name] ?? [], wanted as string[]);
			if (diff) references[item.name] = diff;
		}
	}

	const apexResponse = await guard.apex.updatePostArchetype(
		params.schema,
		ids.archetypeId,
		fields,
		references
	);

	await auditOutcome(ctx, meta, guard.actor, {
		outcome: apexResponse.ok ? 'accepted' : 'apex_error',
		detail: {
			schema: params.schema,
			postId: ids.postId,
			archetypeId: ids.archetypeId,
			fields: Object.keys(fields),
			references: Object.fromEntries(
				Object.entries(references).map(([name, value]) => [
					name,
					Array.isArray(value)
						? `+${value.filter((e) => !('_destroy' in e)).length}/-${value.filter((e) => '_destroy' in e).length}`
						: value === null
							? 'cleared'
							: 'set'
				])
			),
			apexStatus: apexResponse.status
		}
	});

	if (!apexResponse.ok) {
		const status =
			apexResponse.status >= 400 && apexResponse.status < 500 ? apexResponse.status : 502;
		return noStoreJson({ error: 'upstream error', status: apexResponse.status }, status);
	}

	// Re-read: the join-row ids the browser must diff against next time are newly
	// minted, and a 200 from this surface is not evidence the reference moved.
	//
	// The same rule as the fields stage's (`update-post.ts`): the archetype write has
	// LANDED, so a failed read back is `ok: true, unread: true` with an `accepted`
	// row saying so — not a 502 that tells an editor nothing was saved over
	// references that were. The join-row ids are diffed against a FRESH read on the
	// next save, so a retry cannot double them.
	const loaded = await buildPostLoad(contract, guard.apex, params.schema, ids.postId);
	if (!loaded || loaded.ok !== true) {
		await auditOutcome(ctx, meta, guard.actor, {
			outcome: 'accepted',
			detail: {
				schema: params.schema,
				postId: ids.postId,
				unread: true,
				reason: loaded ? loaded.reason : 'post-archetype-read-failed'
			}
		});
		return noStoreJson({ ok: true, unread: true });
	}
	return noStoreJson({
		ok: true,
		post: loaded.post,
		version: loaded.version,
		bodyVersion: loaded.bodyVersion
	});
}
