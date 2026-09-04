/**
 * What the kit's record operations need to know about a site's content model —
 * and nothing else.
 *
 * Every site keeps its own committed field contract (a JSON the generator writes,
 * read by its own `admin/contract.ts`). The kit cannot import that file and must
 * not carry one of its own, so a site implements this interface over it and hands
 * it in on the request context: `ctx.contract`. Not a module singleton — `ctx` is
 * already what the guard passes every operation, and a singleton bound by an import
 * side effect is a trap for server code that renders on a route which never
 * imported it.
 *
 * What is deliberately NOT here: the account id (already `ctx.accountId`), the
 * gallery ids (an operation option), and the media field names (only a site's own
 * editor screen reads those). None of them is schema knowledge.
 */

export interface FieldDef {
	field_name: string;
	/** Never null — the generator applies `display_name || titleize(field_name)`. */
	display_name: string;
	validator_kind: string | null;
	text_inclusion: string[] | null;
	is_required: boolean;
	place_holder: string | null;
	default_value: string | null;
}

export interface PrimitiveItem {
	name: string;
	kind: 'primitive';
	position: number;
	field_defs: FieldDef[];
}

export interface ReferenceItem {
	name: string;
	kind: 'reference';
	position: number;
	field_defs: null;
	relationship_kind: 'has_one' | 'has_many';
	target_schema: string;
	reference_display_field: string | null;
}

export type SchemaItem = PrimitiveItem | ReferenceItem;

export interface ArchetypeSchema {
	slug: string;
	display_name: string;
	/** `'Cms::Post'` for the two post archetypes, `null` for the content library. */
	target_model: string | null;
	id: string | null;
	items: SchemaItem[];
}

export interface Referrers {
	/**
	 * Referring content-library schemas — the ones P1 can actually count, because
	 * their collections are readable through the generic list.
	 */
	countable: { slug: string; displayName: string; itemName: string }[];
	/**
	 * Referring POST schemas (`update`, `story`). Named but NOT counted: a post's
	 * archetype is not addressable through the content-library client (its fields
	 * would 422 there — SHARED-FACTS §15), and the post surface is P2. A partial
	 * count reads as a complete one, which is the exact sentence that talks someone
	 * into a delete, so it is left uncounted and said so.
	 */
	uncounted: { slug: string; displayName: string; itemName: string }[];
}

export interface ContentContract {
	/** One schema as the admin holds it, or null when the slug is unknown. */
	schema(slug: string): ArchetypeSchema | null;
	/** Whether this slug may be read and written through the content-library surface. */
	isContentLibrarySlug(slug: string): boolean;
	primitiveFieldDefs(slug: string): FieldDef[];
	referenceItems(slug: string): ReferenceItem[];
	/**
	 * Which schemas point at this one. The `countable`/`uncounted` split is
	 * load-bearing: a partial count reads as a complete one, and that is the
	 * sentence that talks someone into a delete.
	 */
	referrersTo(slug: string): Referrers;
}
