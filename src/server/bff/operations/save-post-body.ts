import { auditOutcome } from '../audit';
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
	apexBlockRows,
	blockHtmlValues,
	buildBlocksAttributes,
	loadPostView,
	normalizeBlocks,
	postIdSchema,
	postRouteMeta,
	postSchemaOf,
	readDocumentBlocks,
	readPostIds,
	savePostBodySchema
} from './post-shape';
import type { BffContext } from '../context';

/**
 * PUT /api/admin/posts/[schema]/[postId]/body — the post's document blocks.
 *
 * `PATCH /cms/documents/:id` with `blocks_attributes` APPENDS: an entry with no
 * id creates, an entry with an id updates, a row simply omitted survives. A
 * client that sent the whole body every time would double it on every save. This
 * operation turns the browser's whole-body intent into Apex's diff
 * (`buildBlocksAttributes`): keep by id, create what is new, destroy what the
 * editor removed — and NEVER destroy a block kind the editor was not shown, which
 * is how a story's `GalleryItem` blocks survive a save untouched.
 *
 * HTML is sanitized on the way in as well as on the way out.
 */
export async function handleSavePostBody(
	request: Request,
	ctx: BffContext,
	params: { schema: string; postId: string }
): Promise<Response> {
	const contract = contractOf(ctx);
	if (!contract) return noContractResponse();
	const meta = postRouteMeta(request, 'posts.save_body', 'PUT', true, '/body');

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
	// The per-field ceiling, in the same currency as every other write path. The
	// schema's `.max(MAX_FIELD_VALUE_CHARS)` already refused an over-long block, but
	// as a generic `invalid body` — which does not say WHICH of up to two hundred
	// blocks was the one. Run first, so the typed answer wins.
	const tooLarge = await refuseOversizedFields(ctx, actor, blockHtmlValues(bodyJson));
	if (tooLarge) return tooLarge;
	// The other half of the same rule (Opus O5): a URL attribute this judge cannot
	// read is refused BY NAME rather than silently stripped on the way through the
	// sanitizer, so an editor is told which field to look at.
	const unreadable = await refuseUnreadableUrls(ctx, actor, blockHtmlValues(bodyJson));
	if (unreadable) return unreadable;

	const parsed = savePostBodySchema.safeParse(bodyJson);
	if (!parsed.success) return rejectMutation(ctx, actor, 400, 'invalid body', 'invalid body');

	const view = await loadPostView(guard.apex, params.schema, idResult.data);
	if (!view) return rejectMutation(ctx, actor, 404, 'not found', 'not found');
	const ids = readPostIds(view);
	if (!ids.documentId) return bffError(502, 'unexpected upstream shape');

	const current = apexBlockRows(await readDocumentBlocks(guard.apex, ids.documentId));
	const attributes = buildBlocksAttributes(current, parsed.data.blocks);

	const apexResponse =
		attributes.length > 0
			? await guard.apex.updateDocumentBlocks(ids.documentId, attributes)
			: { ok: true, status: 200, body: null };

	await auditOutcome(ctx, meta, guard.actor, {
		outcome: apexResponse.ok ? 'accepted' : 'apex_error',
		detail: {
			schema: params.schema,
			postId: ids.postId,
			blocks: parsed.data.blocks.length,
			apexStatus: apexResponse.status
		}
	});

	if (!apexResponse.ok) return bffError(502, 'upstream error');

	// Re-read: the browser adopts Apex's block ids, so a block it just created stops
	// being new on the next save instead of being appended a second time.
	const blocks = normalizeBlocks(await readDocumentBlocks(guard.apex, ids.documentId));
	return noStoreJson({ ok: true, blocks });
}
