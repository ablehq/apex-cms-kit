//
// The local draft behind every content-library editor, in the shape GLC's
// `entity-draft.js` established: edits mutate THIS, not Apex; there is no autosave,
// no debounce and no coordinator; a single explicit save (`save-entity.js`) reads
// the dirty set off a draft and writes it. Plain object graphs, so the whole model
// is testable without a DOM or a network.
//
// ── WHAT IS DIFFERENT FROM GLC'S, AND WHY (plan §4.4) ──────────────────────────
// GLC's version declares its schemas as hard-coded name lists and coerces every
// value through `String(value)`. It gets away with that because neither of its two
// content-library schemas has a non-string field. Godrej's have three:
// `team_member.description` and `focus_area.our_approach` are rich text
// (`{html, editor, content}`), and every one of the four types has at least one
// gallery reference. `String({html: …})` is `"[object Object]"` — in the form, and
// then on the wire.
//
// Widening the value type is the easy half. Four call sites in GLC's version carry
// a string-only assumption that a non-string value breaks SILENTLY, and all four
// are fixed here:
//
//   1. `text()` → gone. Values are held as they are.
//   2. `baselineFields: { ...fields }` was a SHALLOW copy, so the baseline and the
//      live field aliased the SAME rich-text object and the baseline mutated with
//      the edit. → `structuredClone`.
//   3. `next === draft.baselineFields[name]` — `===` on two objects is never true,
//      so a rich field could NEVER return to clean: Save stayed enabled forever and
//      the patch resent it on every save. → a structural equality check.
//   4. `reconcileEntity` re-`text()`d and re-shallow-copied after every save, which
//      reintroduced (2) each time. → clone again.
//
// ── AND ONE RULE THAT SURVIVES UNCHANGED, BECAUSE IT IS THE DANGEROUS ONE ──────
// A PRIMITIVE field can never be set to `null`. `null` destroys the
// `archetype_item` row upstream AND strands the old value in
// `archetype.primitives` — and this site's loaders read `primitives` and then
// overwrite from `archetype_items`, so with the row gone there is nothing left to
// overwrite with and the deleted text is what the public page renders,
// indefinitely, while the admin shows the field as empty. Clearing is `''`.
// `setField` refuses `null` outright; the BFF refuses it again.
//
// References are the exception, and they have their own setters that say so.


function clone(value) {
	// Rich text and reference arrays are plain JSON, so `structuredClone` is exact.
	// It also throws on a `$state` proxy, which is why the admin subtree is pinned
	// to legacy compile mode (svelte.config.js).
	return typeof value === 'object' && value !== null ? structuredClone(value) : value;
}

/**
 * Structural equality, for the dirty check.
 *
 * `===` is wrong for a rich-text field — two structurally identical objects are
 * never `===` — and a field that can never return to clean means a Save button
 * that is never disabled and a patch that resends a value nobody touched.
 * Deliberately narrow: these values are JSON out of Apex, so there are no dates,
 * maps, cycles or class instances to get wrong.
 */
export function sameValue(a, b) {
	if (a === b) return true;
	if (a === null || b === null) return false;
	if (typeof a !== 'object' || typeof b !== 'object') return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) {
		if (a.length !== b.length) return false;
		return a.every((item, index) => sameValue(item, b[index]));
	}
	const keysA = Object.keys(a);
	const keysB = Object.keys(b);
	if (keysA.length !== keysB.length) return false;
	return keysA.every(
		(key) => Object.prototype.hasOwnProperty.call(b, key) && sameValue(a[key], b[key])
	);
}

/** Two id sets are the same selection when they hold the same ids, in any order. */
function sameIdSet(a, b) {
	if (a.length !== b.length) return false;
	const held = new Set(a);
	return b.every((id) => held.has(id));
}

/**
 * Build a draft from a loaded record and its stale-guard baseline.
 *
 * The field list comes from the committed contract, so a schema change is a
 * regenerated JSON file rather than an edited name list — and a field the contract
 * does not have cannot be written even if the server sent one.
 *
 * @param {string} schemaSlug the archetype schema slug, e.g. 'team_member'
 * @param {{ id: string, fields?: Record<string, unknown>, references?: Record<string, {itemId: string, targetId: string}[]> }} record
 * @param {string} version
 */
export function createEntityDraft(schemaSlug, record, version, contract) {
	if (!contract) throw new Error('createEntityDraft needs the site content contract');
	if (!contract.schema(schemaSlug)) throw new Error(`unknown schema: ${schemaSlug}`);

	const fields = {};
	for (const def of contract.primitiveFieldDefs(schemaSlug)) {
		const value = record?.fields ? record.fields[def.field_name] : undefined;
		fields[def.field_name] = value === undefined || value === null ? '' : clone(value);
	}

	// References are held as ORDERED ID SETS — what the editor selected. The join-row
	// ids the server needs for a removal are not the browser's business: it sends
	// the set, and the BFF diffs it against a fresh read (see `update-record.ts`).
	// That is what keeps the two id spaces from ever being conflated here.
	const references = {};
	for (const item of contract.referenceItems(schemaSlug)) {
		const held = record?.references ? (record.references[item.name] ?? []) : [];
		references[item.name] =
			item.relationship_kind === 'has_many'
				? held.map((entry) => entry.targetId)
				: (held[0]?.targetId ?? null);
	}

	return {
		schemaSlug,
		/**
		 * The site's content contract, carried on the draft rather than threaded
		 * through every helper: `setEntityReference`, `entityPatch` and
		 * `reconcileEntity` all need it, and an argument they could each forget is
		 * a defect waiting to happen.
		 */
		contract,
		entityId: record?.id ?? '',
		baselineVersion: version ?? '',
		fields,
		baselineFields: clone(fields),
		dirtyFields: new Set(),
		references,
		baselineReferences: clone(references),
		dirtyReferences: new Set()
	};
}

/**
 * Set one primitive field. Returns false for a name the schema does not have, so a
 * typo in a form descriptor surfaces as a field that will not accept input rather
 * than as a 400 on save.
 *
 * A value edited back to what it was is no longer dirty — the save then sends
 * nothing for it and the Save button goes back to disabled, which is the "disabled
 * until dirty" contract behaving honestly.
 *
 * `null` and `undefined` become `''`. That is the safe clear, and it is why the
 * media control's Remove is given `''` to emit on these screens rather than GLC's
 * `null` (plan §6): a `null` here would be the destructive write.
 */
export function setEntityField(draft, name, value) {
	if (!draft || !Object.prototype.hasOwnProperty.call(draft.fields, name)) return false;
	const next = value === null || value === undefined ? '' : value;
	draft.fields[name] = clone(next);
	if (sameValue(draft.fields[name], draft.baselineFields[name])) draft.dirtyFields.delete(name);
	else draft.dirtyFields.add(name);
	return true;
}

/**
 * Set a reference relation.
 *
 * A `has_many` takes an array of target ids — the full desired selection, not a
 * diff. A `has_one` takes an id or `null`, and `null` is CORRECT here and nowhere
 * else in this module: destroying the reference item is the only way to say "this
 * record points at nothing", and nothing is stranded because a reference
 * contributes no primitive.
 */
export function setEntityReference(draft, name, value) {
	if (!draft || !Object.prototype.hasOwnProperty.call(draft.references, name)) return false;
	const item = draft.contract.referenceItems(draft.schemaSlug).find((entry) => entry.name === name);
	if (!item) return false;

	if (item.relationship_kind === 'has_many') {
		const next = Array.isArray(value) ? [...new Set(value.filter(Boolean))] : [];
		draft.references[name] = next;
		if (sameIdSet(next, draft.baselineReferences[name] ?? [])) draft.dirtyReferences.delete(name);
		else draft.dirtyReferences.add(name);
		return true;
	}

	const next = value || null;
	draft.references[name] = next;
	if (next === (draft.baselineReferences[name] ?? null)) draft.dirtyReferences.delete(name);
	else draft.dirtyReferences.add(name);
	return true;
}

/** Is this reference currently selected? For a `has_many` picker's tick state. */
export function hasReference(draft, name, targetId) {
	const held = draft?.references?.[name];
	if (Array.isArray(held)) return held.includes(targetId);
	return held === targetId;
}

export function isEntityDirty(draft) {
	return Boolean(draft) && (draft.dirtyFields.size > 0 || draft.dirtyReferences.size > 0);
}

/**
 * The PATCH body: only what actually changed, in schema order.
 *
 * `fields` carries values as they are — a rich-text object stays an object. There
 * is no path from here that can express the destructive `null` on a primitive,
 * because `setEntityField` cannot store one.
 */
export function entityPatch(draft) {
	const fields = {};
	for (const def of draft.contract.primitiveFieldDefs(draft.schemaSlug)) {
		if (draft.dirtyFields.has(def.field_name))
			fields[def.field_name] = draft.fields[def.field_name];
	}
	const references = {};
	for (const item of draft.contract.referenceItems(draft.schemaSlug)) {
		if (draft.dirtyReferences.has(item.name)) references[item.name] = draft.references[item.name];
	}
	const patch = {};
	if (Object.keys(fields).length > 0) patch.fields = fields;
	if (Object.keys(references).length > 0) patch.references = references;
	return patch;
}

export function hasEntityChanges(draft) {
	return Object.keys(entityPatch(draft)).length > 0;
}

/**
 * Re-baseline after a successful save: adopt the server's record and version, and
 * clear the dirty sets.
 *
 * The baseline is a DEEP clone of the adopted values, not a spread of them. A
 * shallow copy would alias the live rich-text object, so the baseline would move
 * with the next keystroke and the field would read as clean while it was being
 * edited — GLC's bug (3) and (4), reintroduced on every save.
 */
export function reconcileEntity(draft, record, version) {
	const fresh = createEntityDraft(
		draft.schemaSlug,
		record,
		version || draft.baselineVersion,
		draft.contract
	);
	draft.entityId = fresh.entityId || draft.entityId;
	draft.fields = fresh.fields;
	draft.baselineFields = fresh.baselineFields;
	draft.dirtyFields = new Set();
	draft.references = fresh.references;
	draft.baselineReferences = fresh.baselineReferences;
	draft.dirtyReferences = new Set();
	if (version) draft.baselineVersion = version;
}
