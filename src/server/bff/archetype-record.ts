import { z } from 'zod';

/**
 * How every phase-3d operation reads ONE Apex archetype response — authors,
 * resources and the archetype half of an article.
 *
 * It exists for the same reason `sermon-record.ts` did, and that file now delegates
 * to it so there is exactly one implementation of the two readers both need. An
 * archetype's shape is not obvious and it is not uniform: the same record carries
 *
 *   - `primitives` — the FLATTENED read model (`{name, designation}`), the only key
 *     the public site actually renders, and the one a write must never strand;
 *   - `fields_data` — `{}` at the top level for a content-library schema (the field
 *     values are NOT here, which is the first thing that surprises a reader);
 *   - `archetype_items[]` — one row per field, where a PRIMITIVE row is backed by a
 *     `PropertySet` and a REFERENCE row is backed by a `Specification::Archetype`;
 *   - `relatable_data` — ~4× of pure duplication (4,397 B for a two-field author),
 *     which the snapshot projection strips and nothing here should ever pass on.
 *
 * If two operations disagreed about which of those holds a value, the admin would
 * quietly show one thing and the site another — which is the exact failure mode the
 * `null`-on-a-primitive defect produces, so it is worth not reproducing by hand.
 */

/** The id format, checked before it is ever interpolated into an Apex URL. */
export const archetypeIdSchema = z
	.string()
	.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);

/**
 * Unwrap the single record from an Apex response. Apex answers either
 * `{ data: { … } }` or the bare record; anything else is not a record, and saying
 * so is what turns an unexpected upstream shape into a 502 instead of a silent
 * empty result.
 */
export function unwrapArchetypeRecord(body: unknown): Record<string, unknown> | null {
	if (!body || typeof body !== 'object') return null;
	const maybe = body as { data?: unknown };
	if (maybe.data && typeof maybe.data === 'object' && !Array.isArray(maybe.data)) {
		return maybe.data as Record<string, unknown>;
	}
	if ('id' in (body as object)) return body as Record<string, unknown>;
	return null;
}

/**
 * Unwrap a `search_and_filter` list. Always an array, so callers never branch on
 * absence — an upstream shape we do not recognise reads as "nothing", which is the
 * safe direction for a list.
 */
export function unwrapArchetypeCollection(body: unknown): Record<string, unknown>[] {
	if (Array.isArray(body)) return body.filter(isRecord);
	if (!body || typeof body !== 'object') return [];
	const data = (body as { data?: unknown }).data;
	if (Array.isArray(data)) return data.filter(isRecord);
	return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The flattened field bag, always an object so callers never branch on its absence. */
export function readPrimitives(record: Record<string, unknown>): Record<string, unknown> {
	const primitives = record.primitives;
	return primitives && typeof primitives === 'object'
		? (primitives as Record<string, unknown>)
		: {};
}

/** Trim a value Apex may return as a string, null, or something else entirely. */
export function cleanString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

/** The per-field rows. Always an array. */
export function readArchetypeItems(record: Record<string, unknown>): Record<string, unknown>[] {
	const items = record.archetype_items;
	return Array.isArray(items) ? items.filter(isRecord) : [];
}

/**
 * The id a REFERENCE item points at, or null when the reference is unset.
 *
 * The distinguishing mark is `relatable_type`, not the field name: a primitive's row
 * is backed by a `PropertySet` and a reference's row by a `Specification::Archetype`.
 * Both carry `fields_data`, so matching on the name alone would happily return a
 * primitive's text value as if it were an id.
 *
 * Note what is NOT here: the referenced record's display name. Apex sends
 * `relatable_data: { primitives: null }` for a reference — the author's name is not
 * inlined — so every caller resolves the name by joining against the authors
 * collection by id. That is what the public site already does
 * (`blogExtractor.ts:103-105`), and it is why the article list loads authors too.
 */
export function readReferenceId(record: Record<string, unknown>, itemName: string): string | null {
	for (const item of readArchetypeItems(record)) {
		if (item.relatable_type !== 'Specification::Archetype') continue;
		const schemaItem = isRecord(item.archetype_schema_item) ? item.archetype_schema_item : null;
		if (!schemaItem) continue;
		if (schemaItem.name !== itemName && schemaItem.slug !== itemName) continue;
		const fieldsData = isRecord(item.fields_data) ? item.fields_data : null;
		const value = fieldsData ? fieldsData[itemName] : null;
		if (typeof value === 'string' && value) return value;
		// A reference item that exists but holds no id is the same as no reference.
		return null;
	}
	return null;
}

/** One tag association on a record. `id` is the TAGGING id — what un-tagging deletes. */
export interface ArchetypeTagging {
	id: string;
	tagId: string;
	tagName: string;
}

/**
 * The record's tag associations, normalized.
 *
 * `id` is deliberately the tagging's own id and not the tag's: removing a tag from
 * ONE record is `DELETE /taggings/:id`. `DELETE /tags/:id` deletes the vocabulary
 * word and cascades across the entire account — one call un-tagged every record on
 * it (probe T6) — so the id that makes that mistake easy is the one not returned.
 *
 * Duplicates are kept rather than collapsed. `POST /taggings` is not idempotent
 * (probe T4), so a record CAN carry the same tag twice, and the reconciling
 * operation needs to see both rows to delete the extra one.
 *
 * LENIENT ON PURPOSE — and therefore not for reconcilers. An absent array reads
 * as no rows and an unparseable row is dropped, which is what a DISPLAY caller
 * wants (the admin's picker shows what it can). A caller that decides what to
 * WRITE from this answer must use `readTaggingsStrict` below instead.
 */
export function readTaggings(record: Record<string, unknown>): ArchetypeTagging[] {
	const taggings = record.taggings;
	if (!Array.isArray(taggings)) return [];
	const rows: ArchetypeTagging[] = [];
	for (const tagging of taggings) {
		if (!isRecord(tagging)) continue;
		const id = cleanString(tagging.id);
		const tagId = cleanString(tagging.tag_id);
		if (!id || !tagId) continue;
		const tag = isRecord(tagging.tag) ? tagging.tag : null;
		rows.push({ id, tagId, tagName: tag ? cleanString(tag.name) : '' });
	}
	return rows;
}

/** The strict read's verdict: the rows, or the reason the projection is unusable. */
export type StrictTaggingsRead =
	{ ok: true; taggings: ArchetypeTagging[] } | { ok: false; reason: string };

/**
 * The same rows as `readTaggings`, read STRICTLY — for callers that RECONCILE
 * rather than display (ruled 2026-08-09, codex round-3 finding #12).
 *
 * The lenient reader above answers `[]` for a record whose `taggings` key is
 * absent and silently drops a row it cannot parse. For the admin's tag picker
 * that is right: a partial projection shows fewer chips and the operator sees
 * the record, which beats a blank screen. For a RECONCILER it is a lie with
 * teeth: "no rows" is indistinguishable from "no projection", so an upstream
 * that omitted the embedded array yields zero planned mutations, zero writes,
 * and a reported success over a record that still carries every unwanted tag.
 *
 * So here absence is a FAILURE, not an empty set, and any row missing the two
 * ids reconciliation actually steers on — the TAGGING id (what a detach names)
 * and the TAG id (what identity is grouped by) — fails the whole read rather
 * than being dropped from it. A dropped row is a row the reconciler would
 * neither keep nor delete, which is the same silent survival by another route.
 *
 * `tag.name` stays optional: it is reporting detail (`tagsRemoved`), never a
 * key, and an unnamed row is still perfectly deletable.
 */
export function readTaggingsStrict(record: Record<string, unknown>): StrictTaggingsRead {
	const taggings = record.taggings;
	if (!Array.isArray(taggings)) {
		return {
			ok: false,
			reason:
				taggings === undefined
					? 'the record carries no embedded taggings array'
					: 'the record embedded taggings as a non-array'
		};
	}
	const rows: ArchetypeTagging[] = [];
	for (const [index, tagging] of taggings.entries()) {
		if (!isRecord(tagging)) return { ok: false, reason: `taggings[${index}] is not an object` };
		const id = cleanString(tagging.id);
		if (!id) return { ok: false, reason: `taggings[${index}] carries no tagging id` };
		const tagId = cleanString(tagging.tag_id);
		if (!tagId) return { ok: false, reason: `taggings[${index}] carries no tag id` };
		const tag = isRecord(tagging.tag) ? tagging.tag : null;
		rows.push({ id, tagId, tagName: tag ? cleanString(tag.name) : '' });
	}
	return { ok: true, taggings: rows };
}

/** `updated_at` as a plain string — the stale-save token for a single record. */
export function readUpdatedAt(record: Record<string, unknown>): string {
	return cleanString(record.updated_at);
}
