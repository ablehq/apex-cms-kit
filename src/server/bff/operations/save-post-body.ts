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
import { loadGalleryMemberIds } from './list-gallery-images';
import {
	apexBlockRows,
	blockHtmlValues,
	buildBlocksAttributes,
	changedImageBlocks,
	computeBodyVersion,
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
 * editor removed — and NEVER destroy a block of a kind the editor was not shown,
 * which is how a `Video`, `Spacer`, `Entity` or LEGACY `Image` block survives a
 * save untouched, with only its position restated.
 *
 * FOUR KINDS ARE EDITABLE: `rich_text`, `quote`, `divider` and `image` (a
 * `Cms::DocumentBlock::GalleryItem`). HTML is sanitized on the way in as well as
 * on the way out.
 *
 * THREE REFUSALS BEFORE ANY WRITE, in this order:
 *
 *   1. the per-field ceiling and the unreadable-URL rule, over the block HTML —
 *      the same two every other write path runs, so the answer names the block;
 *   2. `409 stale` when the document has moved since this editor loaded it
 *      (`bodyVersion`), because a body save DESTROYS what it was not sent;
 *   3. `400 unknown-image` when a NEW or CHANGED image block names an id that is
 *      not in the account's images gallery. Apex would take any uuid — the column
 *      is an unvalidated FK — and either store a row the public site silently
 *      drops, or 500 on a PG foreign-key violation.
 *
 * AND ONE RULE ABOUT WHAT HAPPENS AFTER THE PATCH IS DISPATCHED. Rails commits at
 * `resource.update` and can still raise while RENDERING the response — which is
 * exactly what the Disk-service trap does to a document holding a GalleryItem
 * block with bytes. So a 5xx, a transport throw, or a 200 whose re-read fails are
 * all WRITE-UNCERTAIN: the answer is `502 body-written-unread`, and the audit row
 * says `accepted … unread: true`, not `rejected`. Reporting an uncertain write as
 * an ordinary failure is what makes an editor press Save again and append a second
 * copy of every block they just created.
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

	// THE PRE-WRITE READ. A failure here is `502` with NOTHING dispatched — the one
	// place in this operation where a rejection row is the honest record. It used to
	// answer `[]`, and the save then diffed the whole body against an empty document:
	// every block became an id-less create, the document doubled, and the response
	// was 200.
	const currentRows = await readDocumentBlocks(guard.apex, ids.documentId);
	if (currentRows === null) {
		return rejectMutation(ctx, actor, 502, 'upstream error', 'document unreadable');
	}
	const current = apexBlockRows(currentRows);

	// The interleaved-save guard. `savePost`'s composite check ran before this
	// request; this one is against the rows THIS request just read.
	if ((await computeBodyVersion(currentRows)) !== parsed.data.bodyVersion) {
		return rejectMutation(ctx, actor, 409, 'stale', 'stale body version');
	}

	// Gallery membership, resolved ONCE and only for the image blocks that are new
	// or repointed. A body whose image blocks are unchanged performs no gallery read
	// at all.
	const changedImages = changedImageBlocks(current, parsed.data.blocks);
	if (changedImages.length > 0) {
		// A NEW or CHANGED image block must NAME an image. `null` round-trips only on
		// an existing block whose value has not moved — which is the case that never
		// reaches here.
		const nameless = changedImages.find((entry) => entry.galleryItemId === null);
		if (nameless) {
			return rejectMutation(
				ctx,
				actor,
				400,
				'unknown-image',
				`unknown image: blocks[${nameless.index}].galleryItemId`
			);
		}
		const members = await loadGalleryMemberIds(guard.apex);
		// UNREADABLE IS NOT ABSENT. `null` means `cms_config` or the gallery would not
		// read; calling that `unknown-image` tells an editor their picture does not
		// exist. It is an upstream fault, and nothing is written.
		if (members === null) return bffError(502, 'upstream error');
		const stranger = changedImages.find((entry) => !members.has(entry.galleryItemId as string));
		if (stranger) {
			return rejectMutation(
				ctx,
				actor,
				400,
				'unknown-image',
				`unknown image: blocks[${stranger.index}].galleryItemId`
			);
		}
	}

	const attributes = buildBlocksAttributes(current, parsed.data.blocks);

	// ── Everything below this line is after the point of no return ──────────────
	let dispatched = false;
	let apexResponse: { ok: boolean; status: number; body: unknown } = {
		ok: true,
		status: 200,
		body: null
	};
	if (attributes.length > 0) {
		dispatched = true;
		try {
			apexResponse = await guard.apex.updateDocumentBlocks(ids.documentId, attributes);
		} catch {
			// A transport throw AFTER the request left is not "nothing happened".
			apexResponse = { ok: false, status: 0, body: null };
		}
	}

	// A 4xx is Apex validating BEFORE it commits: nothing landed, and the ordinary
	// upstream failure is the truthful answer. A 5xx or a transport fault is not.
	const writeUncertain =
		dispatched && !apexResponse.ok && (apexResponse.status === 0 || apexResponse.status >= 500);

	const detail = {
		schema: params.schema,
		postId: ids.postId,
		blocks: parsed.data.blocks.length,
		apexStatus: apexResponse.status
	};

	// ONE audit row per request, written once the outcome is actually known — the
	// re-read below can still change it from `accepted` to "accepted but unread".
	if (writeUncertain) return await answerUnread(ctx, meta, guard.actor, detail);

	if (!apexResponse.ok) {
		await auditOutcome(ctx, meta, guard.actor, { outcome: 'apex_error', detail });
		return bffError(502, 'upstream error');
	}

	// Re-read: the browser adopts Apex's block ids, so a block it just created stops
	// being new on the next save instead of being appended a second time. A FAILED
	// re-read after a landed PATCH is the same write-uncertain case as a 500.
	const after = await readDocumentBlocks(guard.apex, ids.documentId);
	if (after === null) {
		if (dispatched) return await answerUnread(ctx, meta, guard.actor, detail);
		// Nothing was dispatched, so nothing is uncertain: the document is as it was and
		// only the read that would have echoed it failed.
		await auditOutcome(ctx, meta, guard.actor, {
			outcome: 'apex_error',
			detail: { ...detail, reason: 'document-unreadable-after-no-op' }
		});
		return bffError(502, 'upstream error');
	}
	await auditOutcome(ctx, meta, guard.actor, { outcome: 'accepted', detail });
	return noStoreJson({
		ok: true,
		blocks: normalizeBlocks(after),
		bodyVersion: await computeBodyVersion(after)
	});
}

/**
 * The write-uncertain answer, in one place because its two halves must agree.
 *
 * The audit row is `accepted` with `unread: true` — NOT `upstream_shape_error`,
 * which `create-entity.ts` writes for a 2xx whose id cannot be named. There the
 * write's identity is unknown; here the write is addressed by an id we already
 * hold and has probably landed. A `rejected` row would say nothing reached Apex,
 * which is the one thing that is certainly false.
 *
 * The response carries `code` as well as `error` — `bffError` emits `{error}` only
 * — because the browser's save sequencer branches on `res.code` to offer Reload
 * rather than Retry. A retry would resend `id: null` blocks that now exist.
 */
async function answerUnread(
	ctx: BffContext,
	meta: ReturnType<typeof postRouteMeta>,
	actor: { email: string; sub: string | null },
	detail: Record<string, unknown>
): Promise<Response> {
	await auditOutcome(ctx, meta, actor, {
		outcome: 'accepted',
		detail: { ...detail, unread: true }
	});
	return noStoreJson({ error: 'body-written-unread', code: 'body-written-unread' }, 502);
}
