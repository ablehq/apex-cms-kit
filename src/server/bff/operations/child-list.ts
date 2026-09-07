import { readPrimitiveItemId } from '../archetype-record';
import type { ApexAdminClient, ContentLibraryFields } from '../apex-admin-client';
import type { ContentContract } from '../content-contract';

/**
 * CHILD LISTS: the array-shaped fields on a record, and the only transport that
 * persists them.
 *
 * ── THE TWO SURFACES ARE NOT EQUIVALENT ──────────────────────────────────────
 * A record can be written two ways and only one of them stores an array:
 *
 *   PATCH /specification/archetype_schemas/:slug/archetype_models/:id
 *       flat, keyed by field name. An array answers **200** and stores **`[]`**.
 *   PATCH /specification/archetypes/:id/schema_item/:field/items/:itemId
 *       `{fields_data: {<field>: [...]}}`. Stores the array, in order.
 *
 * The flat surface is not merely unable to write the list — it DESTROYS it, with
 * a 200 and no error, and mints the row holding the `[]` so the loss survives a
 * re-read. `assertNoArrayFields` in the Apex client refuses that payload outright;
 * this module is the other half, the route the value actually takes.
 *
 * ── ONE ROW PER LIST, NOT ONE PER CHILD ──────────────────────────────────────
 * A Primitive schema item is forced `has_one` upstream, and a second POST for the
 * same field answers 422 (measured). So the whole ordered list lives in ONE
 * `archetype_item`'s `fields_data`, child order is the array index rather than a
 * column, and a reorder or a removal is simply re-sending the array. Find the row
 * and PATCH it; POST only when the record carries none.
 *
 * ── WHY THE KIND, NOT THE `array_ref` PREFIX ─────────────────────────────────
 * `text_array` and `number_array` are emptied by the flat surface identically —
 * `PropertySetDataModel#permitted_fields_data` emits `{name => []}` for all three
 * kinds, and `archetype_models_controller`'s `schema_item_field_names` emits it for
 * none of them. Routing only `array_ref/…` would leave the other two on the path
 * this module exists to close.
 */

/**
 * Whether a validator kind holds an ARRAY, and therefore whether the field must
 * leave the flat surface.
 *
 * `startsWith('array_ref')` rather than `'array_ref/'` deliberately: it mirrors
 * `PropertySetDataModel#permitted_fields_data`'s own `start_with?("array_ref")`,
 * which is the line that decides whether an array survives the items endpoint. A
 * stricter test here than upstream's would route a field to a surface that then
 * refuses it.
 */
export function isArrayShapedKind(kind: string | null | undefined): boolean {
	if (typeof kind !== 'string') return false;
	return kind === 'text_array' || kind === 'number_array' || kind.startsWith('array_ref');
}

/** The array-shaped field names on one schema, in contract order. */
export function childListFieldNames(contract: ContentContract, slug: string): string[] {
	return contract
		.primitiveFieldDefs(slug)
		.filter((def) => isArrayShapedKind(def.validator_kind))
		.map((def) => def.field_name);
}

/** One list to write: the field, and the whole desired array. */
export interface ChildListWrite {
	field: string;
	value: unknown[];
}

/**
 * Split a submitted field map into the part that goes flat and the part that goes
 * to the items endpoint.
 *
 * Keyed on the CONTRACT's validator kind, not on `Array.isArray(value)`: a
 * declared child list sent as `[]` must still be routed (that is the legitimate
 * "clear the list"), and a non-array on a declared child list is a caller bug the
 * body schema has already refused.
 */
export function splitChildListFields(
	contract: ContentContract,
	slug: string,
	fields: ContentLibraryFields
): { flat: ContentLibraryFields; childLists: ChildListWrite[] } {
	const names = new Set(childListFieldNames(contract, slug));
	const flat: ContentLibraryFields = {};
	const childLists: ChildListWrite[] = [];
	for (const [name, value] of Object.entries(fields)) {
		if (names.has(name) && Array.isArray(value)) childLists.push({ field: name, value });
		else flat[name] = value;
	}
	return { flat, childLists };
}

/** What happened to the child lists: all of them, or the one that stopped it. */
export type ChildListWriteResult =
	{ ok: true; written: string[] } | { ok: false; written: string[]; field: string; status: number };

/**
 * Write each list to its own `archetype_item`, against a record READ IN THIS
 * REQUEST.
 *
 * `record` is the pre-write read, and it is what supplies the item ids. Taking it
 * fresh matters: an id captured when the screen loaded could name a row another
 * editor's save has replaced, and the POST fallback would then answer 422 rather
 * than write.
 *
 * NOT ATOMIC, and there is no way to make it so — Apex has no transaction spanning
 * these endpoints, and each list is its own request. So it stops at the FIRST
 * failure and reports which lists had already landed, rather than continuing and
 * leaving the caller to guess. Re-sending the same request is safe: every leg is a
 * PATCH of the whole desired array, or a POST that becomes a PATCH once the row
 * exists, so a retry converges rather than duplicating.
 */
export async function writeChildLists(
	apex: ApexAdminClient,
	slug: string,
	recordId: string,
	record: Record<string, unknown>,
	childLists: readonly ChildListWrite[]
): Promise<ChildListWriteResult> {
	const written: string[] = [];
	for (const { field, value } of childLists) {
		const itemId = readPrimitiveItemId(record, field);
		const fieldsData = { [field]: value };
		const response = itemId
			? await apex.updateArchetypeItem(slug, recordId, field, itemId, fieldsData)
			: await apex.createArchetypeItem(slug, recordId, field, fieldsData);
		if (!response.ok) return { ok: false, written, field, status: response.status };
		written.push(field);
	}
	return { ok: true, written };
}
