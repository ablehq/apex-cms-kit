/**
 * Authorization invariants that live in the BFF itself.
 *
 * WHO MAY ACT is no longer decided here. Until 2026-07-31 this file held an exact
 * editor allowlist (`PRIVATE_BFF_EDITOR_EMAILS`) checked after a Cloudflare Access
 * JWT verified. Both are gone: an editor now signs in with their own Apex staff
 * credentials, and APEX decides. Concretely —
 *
 *   - login only succeeds if Apex issues that person a token AND admits them to the
 *     platform surface (`GET /api/platform/v1/staffs/me`, see `apex-auth.ts`);
 *   - every subsequent Apex call carries THAT PERSON's token, so Apex's own
 *     authorization runs on every operation, not just at the door.
 *
 * Keeping a second allowlist would have put user management back in a Cloudflare
 * env var — the exact problem this change removed — and would have added a way for
 * the two lists to disagree. It fails closed without one: no Apex session, no
 * session row, no Apex client, no call (`guard.ts`).
 *
 * What remains here is the review-only invariant, which is a property of the DATA
 * and belongs at the BFF regardless of who is calling.
 */

/**
 * The review-only RULE lives here; the review-only FIELD NAMES do not.
 *
 * The invariant is generic: only a dedicated human-review route may set a
 * review-only field, so every other mutation route must refuse a body that even
 * NAMES one. Which fields those are is a property of a site's content model —
 * `transcript_reviewed` is a GLC sermon field, and Godrej has no equivalent — so
 * the list arrives on `BffContext.reviewOnlyFields`, set by the site.
 *
 * `fields` is REQUIRED and has no default, deliberately. A default of `[]` would
 * turn this predicate into one that always returns `false`: a security guard that
 * silently passes. Required means `tsc` fails any caller that forgets it.
 */

/**
 * The second data invariant, added for phase 3d, and the same class of thing as the
 * review-only rule above: a property of the DATA that must hold no matter who is
 * calling.
 *
 * Sending `null` for a PRIMITIVE field DESTROYS the underlying `archetype_item` row
 * upstream — and, worse, leaves the destroyed value stranded in
 * `archetype.primitives`, which is the exact key `/blogs` and `/resources` render.
 * So the row is gone, the admin shows the field as empty, and the public site keeps
 * serving the deleted content indefinitely (proven: `3d-probe-results.md` N2; cause:
 * `archetype_item.rb:15` has `after_save_commit :update_archetype_primitives` with no
 * `after_destroy_commit` counterpart). Clearing a field is `''`, which is proven
 * non-destructive (N1).
 *
 * WHY IT TAKES A REFERENCE LIST — the primitive/reference asymmetry is the whole
 * point, and it is not visible in the value:
 *
 *   - on a PRIMITIVE (`name`, `designation`, `type`, `title`, `description`, `url`),
 *     `null` is the destructive case above and is never legitimate;
 *   - on a REFERENCE (an article's `author`), `null` is CORRECT and is the only way
 *     to clear one (probe F3). `{"author": null}` destroys the reference item, which
 *     is precisely "this article has no author", and nothing is stranded because a
 *     reference item contributes nothing to `primitives`.
 *
 * `null` alone therefore cannot be judged; only `null` AT A KEY can. The two schemas
 * this guard actually protects — `author` is `{name, designation}` and `resource` is
 * `{type, title, description, url}` (`cms_template.rb`) — have NO reference fields,
 * so every caller in 3d passes no second argument and every `null` is a rejection.
 * The one reference in the whole phase never travels as a fields map at all: it has
 * its own route taking `{authorId: string | null}` and its own client method
 * (`setArticleAuthor`), so it is exempt BY CONSTRUCTION rather than by exception.
 * The parameter exists so that a schema which one day mixes the two can say which
 * keys are which, instead of someone loosening the guard for all of them.
 *
 * Values are treated as OPAQUE — the walk does not descend, for the same reason
 * `containsReviewOnlyField` does not descend into `fields_data` values: what a field
 * holds is content, and only the top-level key/value pairs are what Apex assigns.
 *
 * @param fieldsData the FLAT field map about to be PATCHed to `archetype_models`
 * @param referenceFields keys that are references, where `null` is the correct clear
 */
export function containsNullPrimitive(
	fieldsData: Record<string, unknown>,
	referenceFields: readonly string[] = []
): boolean {
	if (!isPlainObject(fieldsData)) return false;
	for (const [key, value] of Object.entries(fieldsData)) {
		if (value === null && !referenceFields.includes(key)) return true;
	}
	return false;
}

/**
 * The structural depth past which a page-structure payload is refused OUTRIGHT. A
 * legit Apex block tree nests only a few `child_template_instances_attributes` levels
 * deep; anything past this cap is a pathological payload. The walk below fails CLOSED
 * (returns true → the op rejects) past the cap — NOT the old fail-OPEN `return false`,
 * which let a review-only key nested past the cap slip through to Apex. Because field
 * VALUES are never descended into (see below), a deeply-nested rich-text document can
 * never push a legitimate save anywhere near this cap, so it will not false-reject.
 */
const MAX_STRUCTURAL_DEPTH = 64;

/**
 * The same body as `archetype-record.ts`'s `isRecord`, deliberately NOT imported.
 * This module has no imports at all, and that is worth more than three saved lines:
 * the write invariants here must not be able to change because a record-parsing
 * module changed.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The page-structure save carries a nested, recursive `blocks_attributes` tree that
 * can include `entity_attributes.fields_data` for newly added blocks — so a shallow
 * key check is not enough to keep the review-only invariant. This walks the body's
 * STRUCTURE (the objects/arrays Apex reads as nested attributes) and returns true if a
 * review-only name appears at any ATTRIBUTE position, so the op can fail closed before
 * the payload ever reaches Apex — the guarantee must hold here, not be backstopped by
 * Apex strong-params.
 *
 * The gated concern is `transcript_reviewed` appearing as a KEY Apex interprets as a
 * field/attribute name — i.e. as a structural attribute key, or as a KEY inside a
 * `fields_data` map — NOT a key buried inside a rich-text field's CONTENT value (a
 * `rich_text` field stores a deeply-nested tiptap/prosemirror document as its value).
 * So the walk distinguishes structural nesting from field content:
 *   - it checks every structural object's KEYS for review-only names;
 *   - at a `fields_data` map it scans the field-name KEYS, but treats each field VALUE
 *     as OPAQUE content it does NOT descend into (a `transcript_reviewed` key inside a
 *     tiptap value is content, not an attribute; the literal string
 *     `"transcript_reviewed"` as a value is likewise ignored — only KEYS are gated);
 *   - it fails CLOSED past `MAX_STRUCTURAL_DEPTH`, so a pathological structural payload
 *     can never walk off the end and fail open.
 */
export function containsReviewOnlyField(
	value: unknown,
	fields: readonly string[],
	depth = 0
): boolean {
	// TypeScript makes `fields` required, but a JS caller can still omit it. Say what
	// is wrong rather than dying on `undefined.includes` three frames down.
	if (!Array.isArray(fields)) {
		throw new TypeError(
			'containsReviewOnlyField: `fields` is required (BffContext.reviewOnlyFields)'
		);
	}
	if (value === null || typeof value !== 'object') return false;
	// Fail CLOSED past the structural cap. The field-value skip below means the only
	// thing that can grow `depth` is genuine attribute nesting, never rich-text content.
	if (depth > MAX_STRUCTURAL_DEPTH) return true;
	if (Array.isArray(value))
		return value.some((item) => containsReviewOnlyField(item, fields, depth + 1));
	for (const [key, nested] of Object.entries(value)) {
		if (fields.includes(key)) return true;
		// A `fields_data` map: its KEYS are field/attribute names (scan them), but its
		// VALUES are opaque field CONTENT — do NOT descend, so a rich-text tiptap value
		// is never mistaken for structure and a deep document never trips the cap.
		//
		// The one consequence of that skip, recorded here so it is not rediscovered as a
		// "bug": `{"fields_data":{"__proto__":{"transcript_reviewed":true}}}` PASSES this
		// guard. `__proto__` is not itself a review-only name, and what hangs under it is
		// treated as opaque content. It is unreachable rather than allowed — the entity
		// route parses `fields_data` with `z.record(fieldNameSchema, …)` and `__proto__`
		// does not survive into the parsed output (verified: the body serialized upstream
		// carried only the legitimate field key), and Rails has no prototype semantics on
		// the far side. Anyone loosening that record — a wider key schema, a passthrough,
		// or hand-rolled parsing — is removing the only thing that closes this, and must
		// either keep `__proto__` out of the parsed output or make this walk descend.
		if (key === 'fields_data' && isPlainObject(nested)) {
			for (const fieldName of Object.keys(nested)) {
				if (fields.includes(fieldName)) return true;
			}
			continue;
		}
		if (containsReviewOnlyField(nested, fields, depth + 1)) return true;
	}
	return false;
}
