import { appendAuditEntry } from '../audit';
import { containsNullPrimitive } from '../authorization';
import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { rejectMutation } from '../reject';
import { readUpdatedAt, unwrapArchetypeRecord } from '../archetype-record';
import {
	hasManyDiff,
	recordBodySchema,
	referenceFieldNames,
	summarizeRecord
} from './record-shape';
import { recordIdSchema } from './get-record';
import { sanitizeFieldValue } from '../../../sanitize/write-boundary';
import type { ContentLibraryFields, HasManyEntry } from '../apex-admin-client';
import { requireContract } from '../content-contract-guard';
import type { BffContext } from '../context';

/**
 * PATCH /api/admin/records/[schema]/[recordId] — the one write every content-library
 * editor makes.
 *
 * The body is a PARTIAL: only what the draft says changed travels, which is why
 * every key is optional and why an empty patch is a 400 rather than a no-op — a
 * save that sends nothing is a bug in the caller, not a request.
 *
 * Three things make the destructive `null` unspellable on a primitive rather than
 * merely discouraged, and all three are deliberate belt-and-braces:
 *
 *   1. `containsNullPrimitive` rejects it here, with its own code, BEFORE Apex, and
 *      it is told which keys are references so a legitimate reference clear is not
 *      caught with it;
 *   2. `toApexFields` cannot produce one — it drops `undefined` and coerces nothing
 *      else into `null`;
 *   3. `ContentLibraryFields` in the Apex client has no `null` in its value type.
 *
 * Clearing a field is `''`. `null` destroys the `archetype_item` row AND leaves the
 * old value stranded in `archetype.primitives` — and this site's loaders read
 * `primitives` first and overwrite from `archetype_items`, so with the row gone
 * there is nothing left to overwrite with and the deleted text is what the public
 * page renders, indefinitely, while the admin shows the field as empty.
 */
export async function handleUpdateRecord(
	request: Request,
	ctx: BffContext,
	params: { schema: string; recordId: string }
): Promise<Response> {
	const contract = requireContract(ctx);
	const meta = {
		action: 'records.update',
		method: 'PATCH',
		path: `/api/admin/records/${params.schema}/${params.recordId}`,
		requestId: request.headers.get('cf-ray')
	};

	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectMutation(ctx, meta, guard.status, guard.reason, guard.reason);

	const actorMeta = { ...meta, actorEmail: guard.actor.email, actorSub: guard.actor.sub };

	if (!contract.isContentLibrarySlug(params.schema)) {
		return rejectMutation(ctx, actorMeta, 404, 'unknown collection', 'unknown collection');
	}
	const idResult = recordIdSchema.safeParse(params.recordId);
	if (!idResult.success) {
		return rejectMutation(ctx, actorMeta, 400, 'invalid id', 'invalid record id');
	}

	let bodyJson: unknown;
	try {
		bodyJson = await request.json();
	} catch {
		return rejectMutation(ctx, actorMeta, 400, 'invalid json', 'invalid json');
	}

	const submitted = (bodyJson as { fields?: Record<string, unknown> })?.fields;
	if (submitted && containsNullPrimitive(submitted, referenceFieldNames(contract, params.schema))) {
		return rejectMutation(ctx, actorMeta, 400, 'null-field', 'null primitive');
	}

	const parsed = recordBodySchema(contract, params.schema).safeParse(bodyJson);
	if (!parsed.success) {
		return rejectMutation(ctx, actorMeta, 400, 'invalid body', 'invalid body');
	}

	const fields = toApexFields(parsed.data.fields ?? {});
	const wantedReferences = parsed.data.references ?? {};
	if (Object.keys(fields).length === 0 && Object.keys(wantedReferences).length === 0) {
		return rejectMutation(ctx, actorMeta, 400, 'empty patch', 'empty patch');
	}

	/**
	 * The reference payload, diffed against a read taken IN THIS REQUEST.
	 *
	 * `apply_has_many_value` upserts: a non-empty array leaves unlisted existing
	 * items in place, so sending the new selection alone would add without ever
	 * removing — a save that returns 200 and silently keeps the deselected item.
	 * The diff has to name the removals explicitly, as `_destroy` entries against
	 * the JOIN ROW id, and every entry in the array has to be a hash or the
	 * additions are dropped instead.
	 *
	 * Diffing here rather than in the browser means the baseline is seconds old
	 * instead of however long the screen has been open, and means the browser
	 * cannot express a malformed payload at all: it sends the set the editor
	 * selected, which is the only thing it actually knows.
	 */
	const references: Record<string, HasManyEntry[] | string | null> = {};
	let current: Record<string, unknown> | null = null;
	if (Object.keys(wantedReferences).length > 0) {
		const read = await guard.apex.getContentLibraryRecord(params.schema, idResult.data);
		if (read.status === 404) return rejectMutation(ctx, actorMeta, 404, 'not found', 'not found');
		if (!read.ok) return bffError(502, 'upstream error');
		current = unwrapArchetypeRecord(read.body);
		if (!current) return bffError(502, 'unexpected upstream shape');
		const held = summarizeRecord(contract, params.schema, current).references;

		for (const item of contract.referenceItems(params.schema)) {
			const wanted = (wantedReferences as Record<string, unknown>)[item.name];
			if (wanted === undefined) continue;
			if (item.relationship_kind === 'has_one') {
				// A has_one travels as a bare id, or `null` to clear it. `null` is
				// CORRECT on a reference and only on a reference: it destroys the
				// reference item, which is exactly "this record points at nothing", and
				// nothing is stranded because a reference contributes no primitive.
				references[item.name] = (wanted as string | null) ?? null;
				continue;
			}
			const diff = hasManyDiff(item.name, held[item.name] ?? [], wanted as string[]);
			// `null` means nothing moved. Sending `[]` would destroy the whole relation,
			// which is a different instruction from "I did not change this".
			if (diff) references[item.name] = diff;
		}
	}

	const apexResponse = await guard.apex.updateContentLibraryRecord(
		params.schema,
		idResult.data,
		fields,
		references
	);

	if (ctx.db) {
		await appendAuditEntry(ctx.db, {
			id: crypto.randomUUID(),
			occurredAt: new Date(ctx.now ?? Date.now()).toISOString(),
			actorEmail: guard.actor.email,
			actorSub: guard.actor.sub,
			action: meta.action,
			method: meta.method,
			path: meta.path,
			accountId: ctx.accountId ?? null,
			pageId: null,
			requestId: meta.requestId,
			outcome: apexResponse.ok ? 'accepted' : 'apex_error',
			detail: {
				schema: params.schema,
				recordId: idResult.data,
				fields: Object.keys(fields),
				// The reference diff is the part of this write with the most ways to go
				// wrong and the fewest traces, so the shape that travelled is recorded.
				references: Object.fromEntries(
					Object.entries(references).map(([name, value]) => [
						name,
						Array.isArray(value) ? summarizeDiff(value) : value === null ? 'cleared' : 'set'
					])
				),
				apexStatus: apexResponse.status
			}
		});
	}

	if (!apexResponse.ok) {
		// Forward a 4xx (Apex's own validation failure) as-is so the editor can be
		// told which field was refused; a 5xx or a network fault flattens to 502.
		const status =
			apexResponse.status >= 400 && apexResponse.status < 500 ? apexResponse.status : 502;
		return noStoreJson({ error: 'upstream error', status: apexResponse.status }, status);
	}

	// Proved by an independent re-read rather than by the PATCH echo — two Apex
	// write shapes in this family answer 200 and persist nothing, so the token this
	// operation reports is one Apex was asked for a second time.
	const reread = await guard.apex.getContentLibraryRecord(params.schema, idResult.data);
	if (!reread.ok) return bffError(502, 'upstream error');
	const record = unwrapArchetypeRecord(reread.body);
	if (!record) return bffError(502, 'unexpected upstream shape');

	// The whole record comes back, not just the version: the reference diff means
	// the browser's idea of the relation is now behind the server's (the join-row
	// ids it must send `_destroy` against are newly minted), and a picker holding
	// stale item ids would fail its next remove silently.
	return noStoreJson({
		ok: true,
		version: readUpdatedAt(record),
		record: summarizeRecord(contract, params.schema, record)
	});
}

/** A compact description of one relation's diff, for the audit row. Never an id dump. */
function summarizeDiff(entries: HasManyEntry[]): string {
	let added = 0;
	let removed = 0;
	for (const entry of entries) {
		if ('_destroy' in entry) removed += 1;
		else added += 1;
	}
	return `+${added}/-${removed}`;
}

/**
 * The field map that goes on the wire: the submitted values, minus anything the
 * caller did not send.
 *
 * `undefined` is dropped rather than becoming `null`, which is the whole point —
 * "unchanged" is an omitted key and "cleared" is `''`. Rich-text objects pass
 * through as objects; coercing them to strings here is the `[object Object]`
 * defect the entity draft exists to avoid, one layer down.
 *
 * It is also where authored HTML is SANITIZED, because it is the one funnel every
 * content-library write passes through — this operation and `create-record` both
 * call it. `RichTextField` refuses a `javascript:` link at the keyboard, but a
 * direct POST never goes near it, and what is stored is rendered with `{@html}` on
 * the public site. See `sanitize/write-boundary.ts`.
 */
export function toApexFields(submitted: Record<string, unknown>): ContentLibraryFields {
	const fields: ContentLibraryFields = {};
	for (const [name, value] of Object.entries(submitted)) {
		if (value === undefined) continue;
		if (value === null) continue; // unreachable: `containsNullPrimitive` rejected it
		fields[name] = sanitizeFieldValue(value) as ContentLibraryFields[string];
	}
	return fields;
}
