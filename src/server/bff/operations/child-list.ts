import { readPrimitiveItemId } from '../archetype-record';
import { ApexTransportError } from '../apex-admin-client';
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
 * ── THIS WHOLE MODULE IS PROVISIONAL ─────────────────────────────────────────
 * Plan 08 makes `archetype_models` permit list-shaped fields, the way the entity
 * controller already does. When that is DEPLOYED and VERIFIED — not merely merged
 * — a record's lists ride the same atomic PATCH as every other field and this
 * module, its partial-failure reporting and its convergence argument all go, in
 * one reviewed kit change that also removes `assertNoArrayFields`. It is kept
 * until then because it is what works against the backend production is on.
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
 * Keyed on the CONTRACT's validator kind FIRST, and on `Array.isArray(value)` only
 * as the second half of the same test. The contract is what decides: an array on a
 * field the contract does not call a list stays flat, so a stray array cannot invent
 * a child-list write on a scalar field. The `Array.isArray` half is a type narrowing
 * for `ChildListWrite.value`, and it can only ever be true here — `recordBodySchema`
 * (`record-shape.ts`) has already refused a non-array on a declared list with a named
 * 400, so a declared list that reaches this function is an array, `[]` included.
 * `[]` is the legitimate "clear the list" and must be routed like any other value.
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

/**
 * What happened to the child lists: all of them, or the one that stopped it.
 *
 * `fault` is present only when there was no HTTP answer at all, and it says WHY:
 * `'network'` is the fetch itself failing, `'thrown'` is this client refusing the
 * call (an allowlist, `assertUuid`, `assertNoArrayFields`) or a bug. `status: 0`
 * alone cannot tell those apart, and the audit row is where the difference is read.
 */
export type ChildListWriteResult =
	| { ok: true; written: string[] }
	| {
			ok: false;
			written: string[];
			field: string;
			status: number;
			fault?: 'network' | 'thrown';
			reason?: string;
	  };

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
		let response;
		try {
			response = itemId
				? await apex.updateArchetypeItem(slug, recordId, field, itemId, fieldsData)
				: await apex.createArchetypeItem(slug, recordId, field, fieldsData);
		} catch (error) {
			// The client RETHROWS a network fault when no abort signal was passed, and
			// the admin path passes none. Caught HERE rather than at the call site
			// because this is the only frame that knows WHICH list was in flight —
			// and after a committed flat write, "which one" is the whole report.
			// `status: 0` is "never got an answer", distinct from any HTTP refusal.
			//
			// NOT every throw is a transport fault, and an unqualified catch that says
			// it is puts a lie in the audit row. The client's own refusals — the schema
			// allowlist, `assertUuid`, `assertNoArrayFields` — arrive here identically,
			// and on those Apex was never asked anything. Rethrowing them instead is
			// not an option once the flat write has committed: the editor would be told
			// nothing about a save that is now half applied. So the fault is CLASSIFIED
			// and both facts travel.
			return {
				ok: false,
				written,
				field,
				status: 0,
				fault: error instanceof ApexTransportError ? 'network' : 'thrown',
				reason: error instanceof Error ? error.message : String(error)
			};
		}
		if (!response.ok) return { ok: false, written, field, status: response.status };
		written.push(field);
	}
	return { ok: true, written };
}
