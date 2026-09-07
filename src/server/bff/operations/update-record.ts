import { auditOutcome } from '../audit';
import { containsNullPrimitive } from '../authorization';
import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { refuseOversizedFields, rejectGuardFailure, rejectMutation } from '../reject';
import { readUpdatedAt, unbackedPrimitiveKeys, unwrapArchetypeRecord } from '../archetype-record';
import {
	hasManyDiff,
	recordBodySchema,
	referenceFieldNames,
	summarizeRecord
} from './record-shape';
import { splitChildListFields, writeChildLists } from './child-list';
import { recordIdSchema } from './get-record';
import { sanitizeFieldValue } from '../../../sanitize/write-boundary';
import { ApexTransportError } from '../apex-admin-client';
import type { ApexResponse, ContentLibraryFields, HasManyEntry } from '../apex-admin-client';
import { contractOf, noContractResponse } from '../content-contract-guard';
import type { BffContext } from '../context';

/**
 * PATCH /api/admin/records/[schema]/[recordId] — the one write every content-library
 * editor makes.
 *
 * The body is a PARTIAL: only what the draft says changed travels, which is why
 * every key is optional and why an empty patch is a 400 rather than a no-op — a
 * save that sends nothing is a bug in the caller, not a request.
 *
 * `position` — the archetype's own ordering column — travels at the ROOT of the
 * body, not inside `fields`, because that is where Apex permits it and because it
 * is not a declared field: it has no `field_def`, no validator kind, and no entry
 * in the contract. It is the one key here where `null` is legitimate.
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
 *
 * ── TWO THINGS THIS OPERATION DOES THAT NOTHING ABOUT A PATCH SUGGESTS ────────
 *
 * 1. IT REFUSES A PARTIAL WRITE TO AN UNBACKED RECORD. See THE PARTIAL-WRITE GUARD
 *    below; the short version is that on such a record a partial write silently
 *    deletes every field it does not carry.
 *
 * 2. IT SENDS ARRAY-SHAPED FIELDS SOMEWHERE ELSE. A child list on the flat surface
 *    is stored as `[]`, with a 200. They go to the items endpoint instead — see
 *    `child-list.ts` — which means one write can be several Apex requests and can
 *    fail after the first has landed. That is reported rather than hidden.
 */
export async function handleUpdateRecord(
	request: Request,
	ctx: BffContext,
	params: { schema: string; recordId: string }
): Promise<Response> {
	const contract = contractOf(ctx);
	if (!contract) return noContractResponse();
	const meta = {
		action: 'records.update',
		method: 'PATCH',
		// The route TEMPLATE, not the request's own path. `reject.ts` states the rule
		// and `postRouteMeta` already follows it: a route parameter is
		// attacker-controlled until validated, and this meta is built BEFORE the
		// validation, so interpolating it would write an arbitrary caller string into
		// the audit table's `path` on every refused request. The validated values go
		// in `detail`.
		path: '/api/admin/records/[schema]/[recordId]',
		requestId: request.headers.get('cf-ray')
	};

	const guard = await guardRequest(request, ctx, { mutation: true });
	if (!guard.ok) return rejectGuardFailure(request, ctx, meta, guard);

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

	// The per-field ceiling, named before the shape check so the refusal can say
	// WHICH field is over it (`field-too-large`) rather than a generic `invalid body`.
	const tooLarge = await refuseOversizedFields(ctx, actorMeta, submitted);
	if (tooLarge) return tooLarge;

	const parsed = recordBodySchema(contract, params.schema).safeParse(bodyJson);
	if (!parsed.success) {
		return rejectMutation(ctx, actorMeta, 400, 'invalid body', 'invalid body');
	}

	const fields = toApexFields(parsed.data.fields ?? {});
	const wantedReferences = parsed.data.references ?? {};
	// `position` counts as a change. Left out of this test it would be sent, and
	// persisted, while a patch carrying ONLY a reorder answered 400 "empty patch".
	const position = parsed.data.position;
	if (
		Object.keys(fields).length === 0 &&
		Object.keys(wantedReferences).length === 0 &&
		position === undefined
	) {
		return rejectMutation(ctx, actorMeta, 400, 'empty patch', 'empty patch');
	}

	/**
	 * THE PRE-WRITE READ, taken once and used for three things: the partial-write
	 * guard, the reference diff, and the `archetype_item` ids a child list is
	 * written through.
	 *
	 * Taken whenever anything but `position` is being written. A `position`-only
	 * patch skips it deliberately and is safe to skip: `position` is a column on the
	 * archetype, not an `archetype_item`, so it triggers no primitives rebuild and
	 * has nothing to be diffed against. A REFERENCE-only patch is read for its diff
	 * but is NOT guarded — `update_archetype_primitives` fires only for a Primitive
	 * schema item, so writing a reference row rebuilds nothing.
	 */
	const references: Record<string, HasManyEntry[] | string | null> = {};
	let current: Record<string, unknown> | null = null;
	const writesFields = Object.keys(fields).length > 0;
	if (writesFields || Object.keys(wantedReferences).length > 0) {
		const read = await guard.apex.getContentLibraryRecord(params.schema, idResult.data);
		if (read.status === 404) return rejectMutation(ctx, actorMeta, 404, 'not found', 'not found');
		// AUDITED, where a bare `bffError` left no row at all. Nothing was written, so
		// `rejectMutation`'s best-effort form is the right one — a D1 hiccup must not
		// turn a correct 502 into a 500 — but a save that failed before it started is
		// still a save somebody made, and the audit is where they would look for it.
		if (!read.ok) {
			return rejectMutation(ctx, actorMeta, 502, 'upstream error', 'pre-write read failed');
		}
		current = unwrapArchetypeRecord(read.body);
		if (!current) {
			return rejectMutation(ctx, actorMeta, 502, 'upstream error', 'pre-write read shape');
		}

		/**
		 * ── THE PARTIAL-WRITE GUARD ────────────────────────────────────────────
		 *
		 * WHY THIS EXISTS, because nothing about a PATCH suggests it:
		 *
		 * `Archetype#primitives` — the flattened bag the public site renders — is a
		 * CACHE, not storage. Every save of any Primitive `archetype_item` runs
		 * `on_primitive_changed`, which THROWS THE WHOLE BAG AWAY and rebuilds it
		 * from the items that exist at that moment (`archetype.rb:206-218`).
		 *
		 * On a record whose items cover its keys that is harmless: the rebuild
		 * reproduces every field, so writing one field leaves the other nineteen
		 * exactly where they were. Proved live. **Every record created through any
		 * admin is in that state from birth**, because every API create mints items.
		 *
		 * On a record whose `primitives` were written DIRECTLY, with no item rows
		 * behind them — `create!(primitives: …)` from a seed or an import — the
		 * rebuild has nothing to rebuild from. Writing one field creates one item,
		 * the bag becomes that one field, and **every other field is gone**. 200, no
		 * error, nothing in the response that differs from a good save. The public
		 * site renders the emptied record on the next publish.
		 *
		 * "Always send the full field set" is NOT the remedy and was measured not to
		 * be: a stored value that fails today's validation blocks the whole save (a
		 * `card_image` pointing at a deleted gallery item answers 422), so on such a
		 * record the full-set write can be impossible and the record becomes
		 * uneditable instead of merely dangerous. The remedy is to BACKFILL the item
		 * rows once, from a dump taken before the first write, and to keep this guard
		 * permanently so an import can never quietly recreate the hazard.
		 *
		 * It refuses rather than repairs on purpose. Repairing means writing the
		 * fields, which is the destructive act itself: whatever it could write is
		 * only what it just read back, and one leg of a repair failing leaves the
		 * record worse than it found it. That belongs in a script that dumps first.
		 */
		if (writesFields) {
			const unbacked = unbackedPrimitiveKeys(current);
			if (unbacked.length > 0) {
				// BEST-EFFORT, unlike every other `auditOutcome` in this file, and the
				// difference is the write. Elsewhere a row that fails to land after Apex
				// accepted a write must not be swallowed — the caller would be told
				// everything is fine. Here NOTHING was written, so letting `auditOutcome`
				// throw would replace a correct, deliberate 409 with a framework 500 and
				// hide the very refusal this guard exists to make. Same rule as
				// `rejectMutation`, which cannot be used here because the body names the
				// fields.
				try {
					await auditOutcome(ctx, meta, guard.actor, {
						outcome: 'rejected',
						detail: {
							schema: params.schema,
							recordId: idResult.data,
							reason: 'unbacked-record',
							unbackedFields: unbacked
						}
					});
				} catch {
					// swallow — auditing a refusal must not change the refusal's outcome
				}
				// The field NAMES travel back, not their values: "this record cannot be
				// edited" is unactionable, while "these fields have no rows behind them"
				// names what the backfill has to repair.
				return noStoreJson(
					{ error: 'unbacked-record', code: 'unbacked-record', unbackedFields: unbacked },
					409
				);
			}
		}

		/**
		 * The reference payload, diffed against the read taken just above.
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
		if (Object.keys(wantedReferences).length > 0) {
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
	}

	/**
	 * The two payloads. `flat` is everything `archetype_models` can hold; the child
	 * lists leave that surface entirely, because it answers 200 and stores `[]`.
	 *
	 * Split AFTER `toApexFields`, so the sanitiser stays the single funnel every
	 * content-library write passes through — child values included.
	 */
	const { flat, childLists } = splitChildListFields(contract, params.schema, fields);

	/**
	 * The invariant the child-list write rests on, asserted rather than assumed: a
	 * child list is a FIELD, every field write takes the pre-read, so `current` is
	 * non-null whenever there is a list to write. Written as `&& current` in the
	 * expression below it would be a SILENT SKIP — the lists quietly unwritten and
	 * the save reported as clean, which is the exact class of failure this whole
	 * phase is about. So it refuses instead, before anything is written.
	 */
	if (childLists.length > 0 && !current) return bffError(502, 'unexpected upstream shape');

	/**
	 * THE FLAT WRITE FIRST, and the order is deliberate.
	 *
	 * Neither ordering is atomic — Apex has no transaction across these endpoints —
	 * so the question is which failure leaves less behind. The flat PATCH is
	 * validated against the WHOLE record and refuses with a 4xx having written
	 * nothing, so putting it first means an ordinary validation refusal costs no
	 * child-list write at all. Going the other way round would have the common
	 * refusal arrive after the lists had already changed.
	 */
	/**
	 * BOTH WRITES ARE WRAPPED, and the reason is the second one.
	 *
	 * `call` in the Apex client RETHROWS a network fault unless the caller passed an
	 * abort signal, and the admin path passes none. So a connection reset on the
	 * second of three lists would escape this operation as a framework 500 — after
	 * the flat write and the first list had already committed — with NO audit row
	 * for any of it. The one record of a half-applied save would be missing exactly
	 * when it is most needed.
	 *
	 * A TRANSPORT fault is therefore turned into the same typed failure an HTTP one
	 * produces, so the audit below runs either way. The error itself is never
	 * forwarded: it can carry a URL and upstream detail, and this response is read
	 * by a browser.
	 *
	 * ONLY a transport fault. `catch {}` on its own relabels every throw this client
	 * can make — the schema allowlist, `assertUuid`, `assertNoArrayFields` — as
	 * "Apex never answered", which is false and lands in the audit row as fact. Those
	 * are bugs in a caller, not upstream failures: nothing has been written when one
	 * fires, so the row is written (best-effort, since nothing depends on it) saying
	 * `thrown` and the error is RE-RAISED with its real reason intact rather than
	 * flattened into a 502 about a request that was never made.
	 */
	const flatHasWork =
		Object.keys(flat).length > 0 || Object.keys(references).length > 0 || position !== undefined;
	let apexResponse: ApexResponse;
	if (!flatHasWork) {
		// A LIST-ONLY save has nothing for the flat surface, and sending it an empty
		// body is a round trip that can only fail. Treated as an accepted no-op so the
		// child-list writes below run exactly as they would after a real flat write.
		apexResponse = { status: 200, ok: true, body: null };
	} else {
		try {
			apexResponse = await guard.apex.updateContentLibraryRecord(
				params.schema,
				idResult.data,
				flat,
				references,
				position
			);
		} catch (error) {
			if (!(error instanceof ApexTransportError)) {
				try {
					await auditOutcome(ctx, meta, guard.actor, {
						// NOT `apex_error`. Apex was never asked: the client threw on the way
						// in — an array on a flat field, a malformed id — so the bucket that
						// says "upstream failed" would be a lie in the one table that has to
						// stay honest about who broke what. `thrown: true` still marks it as
						// a throw rather than a validated refusal.
						outcome: 'rejected',
						detail: {
							schema: params.schema,
							recordId: idResult.data,
							fields: Object.keys(fields),
							thrown: true,
							thrownReason: error instanceof Error ? error.message : String(error)
						}
					});
				} catch {
					// swallow — auditing must not replace the real error with its own
				}
				throw error;
			}
			apexResponse = { status: 0, ok: false, body: null, networkError: true };
		}
	}

	/**
	 * The child lists, once the flat write has been accepted. `writeChildLists`
	 * catches a thrown transport fault itself — it is the frame that knows which
	 * list was in flight — so nothing escapes past here unaudited.
	 */
	const childResult =
		apexResponse.ok && childLists.length > 0
			? await writeChildLists(guard.apex, params.schema, idResult.data, current!, childLists)
			: null;

	await auditOutcome(ctx, meta, guard.actor, {
		outcome: apexResponse.ok && childResult?.ok !== false ? 'accepted' : 'apex_error',
		detail: {
			schema: params.schema,
			recordId: idResult.data,
			fields: Object.keys(fields),
			// Which lists travelled on the OTHER surface, and how far they got. A
			// child-list write can fail after the flat write landed, and an audit row
			// that did not say so would read as a clean save.
			...(childLists.length === 0
				? {}
				: {
						childLists: childLists.map((entry) => entry.field),
						childListsWritten: childResult?.written ?? [],
						...(childResult && !childResult.ok
							? {
									childListFailedOn: childResult.field,
									childListStatus: childResult.status,
									// `status: 0` on its own reads as "Apex never answered". It is
									// only true for `'network'`; `'thrown'` means this client
									// refused the call and Apex was never asked. Recorded apart so
									// the one row describing a half-applied save says which.
									...(childResult.fault
										? { childListFault: childResult.fault, childListReason: childResult.reason }
										: {})
								}
							: {})
					}),
			// A reorder changes what a visitor sees and touches no field, so without
			// this an audit row for one would be indistinguishable from a no-op.
			...(position === undefined ? {} : { position }),
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

	if (!apexResponse.ok) {
		// Forward a 4xx (Apex's own validation failure) as-is so the editor can be
		// told which field was refused; a 5xx or a network fault flattens to 502.
		const status =
			apexResponse.status >= 400 && apexResponse.status < 500 ? apexResponse.status : 502;
		return noStoreJson({ error: 'upstream error', status: apexResponse.status }, status);
	}

	if (childResult && !childResult.ok) {
		/**
		 * A CHILD-LIST FAILURE IS NOT "upstream error", and flattening it to one is
		 * what hides the commonest cause.
		 *
		 * The items endpoint's UPDATE leg answers a bare **500**, with no body, when
		 * a list names an id that is not an entity of the field's type — because
		 * `ArchetypeItemDataModel#validate_update_for_primitive_schema_item` merges
		 * the property-set errors on SUCCESS instead of on failure, so a rejected
		 * value falls through to `property_set_attributes` returning nil and raising.
		 * The CREATE leg validates correctly and answers a 422 naming the field. So
		 * "forward 4xx, flatten 5xx" turns the single most likely editor mistake —
		 * a child that has since been deleted — into "the server is broken".
		 *
		 * What travels back instead: the CODE, the FIELD, the upstream status, and
		 * which lists had already landed, because the flat write is committed by now
		 * and there is no way to take it back. The screen phrases it; the kit's job
		 * is to make the fact expressible (kit boundary, §5).
		 */
		// The audit row is already written above — it carries `childListFailedOn`,
		// `childListStatus` and `childListsWritten` and its outcome is `apex_error`.
		// A second row here would double-count one failed save.
		return noStoreJson(
			{
				error: 'child-list-write-failed',
				code: 'child-list-write-failed',
				field: childResult.field,
				// NOT `status`. `bff-client.js`'s `mutate` writes the HTTP status onto
				// its result and then spreads the body over it, so a body key called
				// `status` REPLACES the real one — a 502 silently reported as the 500
				// that caused it. `0` here means "no answer at all" (a transport fault).
				upstreamStatus: childResult.status,
				written: childResult.written
			},
			childResult.status >= 400 && childResult.status < 500 ? childResult.status : 502
		);
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
