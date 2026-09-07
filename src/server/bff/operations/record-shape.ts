import { z } from 'zod';
import type { ContentContract } from '../content-contract';
import {
	cleanString,
	readPrimitiveValue,
	readReferences,
	readUpdatedAt,
	unwrapArchetypeCollection
} from '../archetype-record';
import type { ArchetypeReference } from '../archetype-record';
import type { ApexAdminClient, HasManyEntry } from '../apex-admin-client';

/**
 * What one content-library record IS, on the wire between the BFF and the browser,
 * and the validation that decides what may be written to it.
 *
 * There is one of these for four screens rather than four of them, because the four
 * types differ only in their field list — and the field list is data, from the
 * committed contract (plan §5, "one parameterised screen"). GLC hand-wrote a CRUD
 * quartet per type; this is that written once.
 */

/** The Apex `per_page` ceiling these lists are read at, matching the snapshot pipeline. */
export const PAGE_SIZE = 100;

/** A record as the admin sees it. */
export interface AdminRecord {
	id: string;
	updatedAt: string;
	/**
	 * The archetype's own ordering COLUMN — not a declared field, which is why it
	 * sits beside `fields` rather than in it.
	 *
	 * `null` when the record carries none, which is a legal upstream state and is
	 * what a record created without one holds. It is NOT the destructive `null` the
	 * primitive rule is about: `position` is a column on the archetype, not an
	 * `archetype_item`, so clearing it strands nothing.
	 *
	 * The kit dropped it until P3. A site that sorts its public lists by `position`
	 * — Poovayya does, in five places — had no way to read or write the ordering the
	 * page is drawn in, and ordering is not a schema primitive it could add.
	 */
	position: number | null;
	/**
	 * The primitive field values, by field name, UNNARROWED.
	 *
	 * Not `Record<string, string>`, and that is the §4.4 finding made structural:
	 * `team_member.description` and `focus_area.our_approach` hold
	 * `{html, editor, content}` objects. `String(…)` on one of those is
	 * `"[object Object]"`, in the form and then on the wire.
	 */
	fields: Record<string, unknown>;
	/**
	 * Reference relations, by item name. Each entry carries BOTH ids, because a
	 * remove names the join row and an add names the target and the two are not
	 * interchangeable (SHARED-FACTS §14).
	 */
	references: Record<string, ArchetypeReference[]>;
}

/** Project one Apex archetype into the record the browser edits. */
export function summarizeRecord(
	contract: ContentContract,
	slug: string,
	record: Record<string, unknown>
): AdminRecord {
	const fields: Record<string, unknown> = {};
	for (const def of contract.primitiveFieldDefs(slug)) {
		const value = readPrimitiveValue(record, def.field_name);
		// `undefined` would disappear through JSON; an absent field is an empty one.
		fields[def.field_name] = value === undefined ? '' : value;
	}
	const references: Record<string, ArchetypeReference[]> = {};
	for (const item of contract.referenceItems(slug)) {
		references[item.name] = readReferences(record, item.name);
	}
	return {
		id: cleanString(record.id),
		updatedAt: readUpdatedAt(record),
		position: readPosition(record),
		fields,
		references
	};
}

/**
 * The archetype's `position` column, or null.
 *
 * Anything that is not a finite number reads as "unset" rather than as `0`.
 * Coercing here would be worse than dropping it: `0` is a real ordering value and a
 * record that never had one would jump to the front of every list.
 */
export function readPosition(record: Record<string, unknown>): number | null {
	const value = record.position;
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The body schema for a create or an update on one schema slug.
 *
 * Built from the CONTRACT, so an unknown field name is a 400 here rather than a
 * silently ignored key upstream, and so adding a field to the schema is one
 * regenerated JSON file rather than four edited zod objects.
 *
 * `fields` values are `z.unknown()` because rich text is a legitimate object. What
 * they may NOT be is `null` — the destructive case — and that is enforced
 * separately by `containsNullPrimitive`, which can tell a null on a primitive from
 * a null on a reference. Doing it in zod would need the same distinction and would
 * report it as a shape failure rather than as what it is.
 *
 * ARRAYS ARE DECIDED BY THE FIELD'S KIND, not left to `z.unknown()`:
 *
 *   - an ARRAY-SHAPED field (`array_ref/…`, `text_array`, `number_array`) takes an
 *     array and only an array, checked down to its entries. It leaves the flat
 *     surface entirely — see `child-list.ts`;
 *   - EVERY OTHER field REFUSES an array. `z.unknown()` accepted one, and an array
 *     on a scalar field is stored as `[]` by the flat surface with a 200. The Apex
 *     client throws on the same input; this makes it a named 400 before the throw,
 *     so a caller gets told what was wrong with its body instead of a 500.
 */
export function recordBodySchema(contract: ContentContract, slug: string) {
	const fieldDefs = contract.primitiveFieldDefs(slug);
	const references = contract.referenceItems(slug);

	const fieldsShape: Record<string, z.ZodTypeAny> = {};
	for (const def of fieldDefs) {
		const kind = def.validator_kind ?? '';
		if (kind.startsWith('array_ref')) {
			// The entries are content-library ENTITY ids. A malformed one would reach
			// the items endpoint and come back as a bare 500 (see `updateArchetypeItem`),
			// so it is worth refusing here where the field can still be named.
			fieldsShape[def.field_name] = z.array(z.string().uuid()).max(200).optional();
		} else if (kind === 'text_array') {
			fieldsShape[def.field_name] = z.array(z.string()).max(200).optional();
		} else if (kind === 'number_array') {
			fieldsShape[def.field_name] = z.array(z.number()).max(200).optional();
		} else {
			fieldsShape[def.field_name] = z
				.unknown()
				.refine((value) => !Array.isArray(value), 'this field does not hold a list')
				.optional();
		}
	}

	const referencesShape: Record<string, z.ZodTypeAny> = {};
	for (const item of references) {
		referencesShape[item.name] =
			item.relationship_kind === 'has_many'
				? // The DESIRED SET of target ids, not a diff. The server computes the
					// diff against a fresh read — see `hasManyDiff`.
					z.array(z.string().uuid()).max(200).optional()
				: // A has_one: an id, or `null` to clear. `null` is CORRECT on a
					// reference and only on a reference.
					z.string().uuid().nullable().optional();
	}

	return z
		.object({
			fields: z.object(fieldsShape).strict().optional(),
			references: z.object(referencesShape).strict().optional(),
			/**
			 * The archetype's ordering column, at the ROOT of the payload — which is
			 * where Apex permits it (`archetype_models_controller.rb:181`, `:position`
			 * alongside the field names) and why it is not inside `fields`, whose names
			 * are checked against the contract.
			 *
			 * `null` is ALLOWED here and only here. On a primitive it destroys the
			 * `archetype_item` row and strands the old value where the public site
			 * reads it; on this column it just clears the ordering.
			 */
			position: z.number().int().nullable().optional()
		})
		.strict();
}

/** The reference item names on a schema — the keys where `null` is legitimate. */
export function referenceFieldNames(contract: ContentContract, slug: string): string[] {
	return contract.referenceItems(slug).map((item) => item.name);
}

/**
 * Turn a DESIRED SET of target ids into the payload Apex actually needs.
 *
 * `apply_has_many_value` UPSERTS; it does not replace. `nil` is a validation error
 * ("must be an array"), `[]` destroys everything, and a non-empty array leaves
 * unlisted existing items exactly where they were. So deselecting an item and
 * saving would return 200 and change nothing.
 *
 * The diff is computed HERE, on the server, against a read taken in the same
 * request — not in the browser against a baseline captured when the screen loaded.
 * The browser sends what the editor selected; it cannot express a malformed
 * payload, and the baseline cannot be minutes old.
 *
 * EVERY ENTRY IS A HASH. A mixed scalar/hash array is split by two separate
 * `permit` calls upstream and the hash form wins outright, so
 * `["new-id", {item_id, _destroy}]` keeps the destroy and silently drops the add.
 * Note the two id spaces: an add names the TARGET record under the item's own name,
 * a remove names the JOIN ROW as `item_id`. A bare `{id: …}` is ambiguous and is
 * never sent.
 */
export function hasManyDiff(
	itemName: string,
	current: ArchetypeReference[],
	desired: string[]
): HasManyEntry[] | null {
	const wanted = new Set(desired);
	const held = new Map(current.map((reference) => [reference.targetId, reference.itemId]));

	const entries: HasManyEntry[] = [];
	for (const targetId of wanted) {
		if (!held.has(targetId)) entries.push({ [itemName]: targetId });
	}
	for (const [targetId, itemId] of held) {
		if (!wanted.has(targetId)) entries.push({ item_id: itemId, _destroy: true });
	}
	// Nothing moved: send nothing. Sending `[]` would destroy the whole relation,
	// which is the difference between "I did not touch this" and "I cleared it".
	if (entries.length === 0) return null;
	return entries;
}

/**
 * Which other record types point AT this one, read from the contract.
 *
 * Deleting a record in Apex answers 200 and SILENTLY strips it from every reference
 * that held it — no error, no dangling id, no undo. Apex will not warn anybody, so
 * the delete confirmation has to, and it has to name the types truthfully.
 */
/**
 * How many records reference this one, fresh — content-library records AND posts.
 *
 * A referrer whose schema is a POST (`target_model: 'Cms::Post'`) is read through
 * `listPostArchetypes`, the archetypes surface that carries the items; a
 * content-library referrer through `listContentLibrary`. A site whose contract
 * names a post referrer as countable but whose client has not enabled that slug
 * gets a thrown refusal from the client — caught here and reported as
 * `{ok:false}`, so the delete answers 502 rather than 500 and, above all, never
 * proceeds on a count it could not take.
 *
 * It fails CLOSED: any leg that will not read returns `{ok:false}` and the caller
 * answers 502 rather than a count that is missing entries — because a missing entry
 * reads as "nothing uses this", which is the one answer that must never be a guess.
 */
export async function countReferencesTo(
	contract: ContentContract,
	apex: ApexAdminClient,
	targetSlug: string,
	targetId: string
): Promise<{ ok: true; count: number } | { ok: false }> {
	const { countable } = contract.referrersTo(targetSlug);
	let count = 0;
	for (const referrer of countable) {
		const isPost = contract.schema(referrer.slug)?.target_model === 'Cms::Post';
		// EVERY page. A referrer on page two counted as zero is the one answer that
		// must never be a guess: it reads as "nothing uses this" and talks an editor
		// into a delete that silently strips the reference.
		let page = 1;
		for (;;) {
			let listed;
			try {
				listed = isPost
					? await apex.listPostArchetypes(referrer.slug, { per_page: PAGE_SIZE, page })
					: await apex.listContentLibrary(referrer.slug, { per_page: PAGE_SIZE, page });
			} catch {
				return { ok: false };
			}
			if (!listed.ok) return { ok: false };
			for (const record of unwrapArchetypeCollection(listed.body)) {
				const references = readReferences(record, referrer.itemName);
				if (references.some((reference) => reference.targetId === targetId)) count += 1;
			}
			const pagination = (listed.body as { pagination?: { total_pages?: unknown } } | null)
				?.pagination;
			const totalPages = pagination?.total_pages;
			// No pagination metadata means we cannot know there is no page two.
			if (!Number.isInteger(totalPages)) return { ok: false };
			if (page >= Math.max(1, totalPages as number)) break;
			page += 1;
		}
	}
	return { ok: true, count };
}
