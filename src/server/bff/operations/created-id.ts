import { archetypeIdSchema } from '../archetype-record';

/**
 * THE VERDICT ON THE IDENTIFIER A 2xx CREATE CAME BACK WITH, TAKEN BEFORE THE
 * AUDIT ROW IS WRITTEN.
 *
 * Every create handler in this BFF has the same three-way problem and used to
 * answer it as many different ways. The rule now shared by `createEntity`,
 * `createPage`, `createPost`, `createRecord` and `handleCreateTag` — and by GLC's
 * own copy of the tag handler, which imports this module rather than growing a
 * seventh answer:
 *
 *   1. Apex answered a failure            → `apex_error`, and the caller gets 4xx/502.
 *   2. Apex answered 2xx with a usable id → `accepted`.
 *   3. Apex answered 2xx and this handler CANNOT NAME what it created →
 *      `upstream_shape_error`, and the caller gets 502.
 *
 * Case 3 is the one that needed a value of its own. `createEntity` used to write
 * `accepted` on any 2xx and only then reject an idless body with a 502, so the log
 * recorded an acceptance for a request that was answered 502 — and said nothing
 * about the row that 2xx had probably created and nothing could point at. An audit
 * row that contradicts the response is worse than no row: it is the row an operator
 * would trust. `createPage`, `createPost` and `createRecord` had the identical
 * contradiction and did not get the fix (codex's P5 fix review, 2026-09-08);
 * `createPage` additionally accepted an EMPTY STRING as an id, which reached the
 * response body as `page.id` and would have been interpolated into the next Apex
 * URL the editor asked for.
 *
 * ── WHY THE ID IS VALIDATED AND NOT JUST TESTED FOR PRESENCE ──────────────
 * Apex mints every id as a uuid — measured on local Apex across pages
 * (`8bbe0ed0-2c11-…`), archetype models and their `target_model_id`, and content-
 * library entities. "Nonempty string" is not the same check: a caller that puts a
 * non-uuid straight into a parent's `array_ref` array, or into a URL path, is
 * handing Apex's validator something it will refuse — AFTER the child already
 * exists. `archetypeIdSchema` is the kit's one id grammar, shared with every route
 * that interpolates an id, so this cannot drift from it.
 *
 * ── ONE DELIBERATE CHANGE TO WHAT `createEntity` USED TO RECORD ────────────
 * Its own version treated an EMPTY-STRING id as `malformed-entity-id`, because
 * `returnedId && ENTITY_UUID.test(returnedId)` fell through the falsy `''` while
 * the `returnedId === null` test above it did not. Here `''` reads as no id at all
 * and the reason is `missing-entity-id`. An empty string names nothing, and the
 * four handlers now agree — `createPage` is the one that made this concrete, since
 * `typeof '' === 'string'` was its whole id check and an empty id reached the
 * response as `page.id`.
 *
 * ── WHAT THIS DOES NOT COVER ───────────────────────────────────────────────
 * A failure AFTER a valid id has been obtained — the post-create re-read that
 * `createPost` and `createRecord` both do — is NOT a shape fault. The write
 * happened and this operation can name it, so the `accepted` row is true and
 * stays. What must not happen is that the re-read failure leaves no trace at all,
 * which is what `auditPostCreateReadFailure` is for.
 *
 * AND ONE 2xx-CREATE DELIBERATELY KEEPS ITS OWN ANSWER: the gallery-item create
 * inside `handleFinalizeMediaUpload` (`media.ts:432-478`). The opening sentence here
 * used to read "every create handler… the rule they now share", which was not true
 * of it (Opus review of fix pass 3, finding 6). It is not an oversight and folding
 * it in would make it worse:
 *
 *   • it is one step of a MULTI-STEP upload, so an unnameable item is swept on the
 *     spot rather than reported and left — the outcome it records is about the whole
 *     upload failing, not about this create's shape;
 *   • it audits `apex_error` rather than `upstream_shape_error` because the request
 *     it is describing genuinely failed and the row it made was then deleted;
 *   • it checks for a NONEMPTY STRING rather than a uuid on purpose — an id of the
 *     wrong type is still something to try deleting, and the client's own
 *     `assertUuid` refuses a nonsense one, which `deleteQuietly` reports as `false`.
 *
 * The rule below is for a create whose id the CALLER is about to use. That one's id
 * has no future beyond the sweep it is handed to.
 */
export interface CreatedIdVerdict {
	/** The id this operation may use and hand on, or null. */
	id: string | null;
	/**
	 * The RAW value Apex returned, unjudged — null when there was none at all. Kept
	 * separate from the verdict because the two are wanted for different things: the
	 * verdict decides whether this operation may answer `{ok: true}`, and the raw
	 * value is the handle an operator needs to go and find the orphan.
	 */
	returnedId: string | null;
	/** null when the create failed upstream, or when the id is usable. */
	shapeFault: string | null;
}

/**
 * @param apexOk whether Apex answered 2xx. A shape fault is only meaningful for a
 *   SUCCESS: a failure is already an `apex_error` and the missing id is expected.
 * @param raw the id as read out of the response body, before any judgement.
 * @param noun what the id names — `entity`, `page`, `post`, `record`. It becomes
 *   part of the audit `reason`, so the log says which create could not be named
 *   rather than only that one could not.
 */
export function judgeCreatedId(apexOk: boolean, raw: unknown, noun: string): CreatedIdVerdict {
	/**
	 * A NON-STRING ID IS STILL AN ID, and this used to throw it away and then misname
	 * what it had done (Opus review of fix pass 3, finding 5). `judgeCreatedId(true,
	 * 42, 'page')` answered `{reason: 'missing-page-id', returnedId: null}` — but
	 * there WAS an id; it simply was not a string. The row exists, `42` is the handle
	 * an operator has on it, and the log said there was nothing to look for.
	 *
	 * `String(raw)` keeps it, the way `media.ts:462` already does for the same
	 * situation, and it is capped here as well as in `shapeFaultDetail` so nothing
	 * downstream can be handed an unbounded upstream string. `''` and `null` still
	 * read as MISSING — an empty string names nothing, which is the deliberate choice
	 * the section above records.
	 */
	const returnedId =
		raw === null || raw === undefined || raw === '' ? null : String(raw).slice(0, 120);
	// `id` is what the caller may HAND ON, so it is the uuid rule and nothing else: a
	// number that stringifies to `'42'` is not an id any Apex URL may be built from.
	const id = typeof raw === 'string' && archetypeIdSchema.safeParse(raw).success ? raw : null;
	const shapeFault = !apexOk
		? null
		: returnedId === null
			? `missing-${noun}-id`
			: id === null
				? `malformed-${noun}-id`
				: null;
	return { id, returnedId, shapeFault };
}

/** The audit `outcome` a create verdict implies. */
export function createdIdOutcome(
	apexOk: boolean,
	verdict: CreatedIdVerdict
): 'accepted' | 'apex_error' | 'upstream_shape_error' {
	if (!apexOk) return 'apex_error';
	return verdict.shapeFault ? 'upstream_shape_error' : 'accepted';
}

/**
 * The `detail` fragment a shape fault adds, and nothing at all when there is none.
 *
 * The raw value is CAPPED. It is the only part of the row that is attacker- or
 * upstream-controlled text, and an audit table is not the place to discover that an
 * unbounded upstream string fits in a D1 row.
 */
export function shapeFaultDetail(
	verdict: CreatedIdVerdict
): Record<string, unknown> | Record<string, never> {
	if (!verdict.shapeFault) return {};
	return {
		reason: verdict.shapeFault,
		returnedId: verdict.returnedId === null ? null : verdict.returnedId.slice(0, 120)
	};
}
