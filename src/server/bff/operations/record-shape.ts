import { z } from 'zod';
import type { ContentContract, Referrers } from '../content-contract';
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
	return { id: cleanString(record.id), updatedAt: readUpdatedAt(record), fields, references };
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
 */
export function recordBodySchema(contract: ContentContract, slug: string) {
	const fieldNames = contract.primitiveFieldDefs(slug).map((def) => def.field_name);
	const references = contract.referenceItems(slug);

	const fieldsShape: Record<string, z.ZodTypeAny> = {};
	for (const name of fieldNames) fieldsShape[name] = z.unknown().optional();

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
			references: z.object(referencesShape).strict().optional()
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
 * How many content-library records reference this one, fresh.
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
		// EVERY page. A referrer on page two counted as zero is the one answer that
		// must never be a guess: it reads as "nothing uses this" and talks an editor
		// into a delete that silently strips the reference.
		let page = 1;
		for (;;) {
			const listed = await apex.listContentLibrary(referrer.slug, {
				per_page: PAGE_SIZE,
				page
			});
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
