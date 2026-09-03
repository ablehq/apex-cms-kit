import { canonicalize } from '../../cms/canonical-json.js';

/**
 * The composite page-version token for the stale-save guard (plan §8, 3a
 * "A composite page version … compared once on Save").
 *
 * `page.updated_at` ALONE is not enough: `Cms::PageBlock#page` has no `touch: true`,
 * so an editor changing a block field moves the block's and the entity's timestamps
 * but NOT the page's. A guard keyed on `page.updated_at` would miss exactly the edit
 * it exists to catch. So the token is a hash over a canonical projection of the
 * whole expanded tree — page identity/status, and for every block (recursively
 * through child template instances) its id, position, type, and its entity's id,
 * timestamp and `fields_data`. Any field edit, reorder, add or remove by anyone
 * changes the projection and therefore the hash.
 *
 * The token is opaque to the browser: the get-page op captures it as the baseline
 * at load, and `savePage()` reads it once more at save-time and compares the two
 * strings. Equality means "the server tree is exactly what I loaded"; inequality
 * means someone else wrote in between — the save refuses and asks for a reload.
 */

interface EntityLike {
	id?: unknown;
	updated_at?: unknown;
	fields_data?: unknown;
}

interface BlockableLike {
	id?: unknown;
	updated_at?: unknown;
	page_block_template_id?: unknown;
	entity?: EntityLike | null;
	child_template_instances?: BlockableLike[] | null;
}

interface BlockLike {
	id?: unknown;
	position?: unknown;
	label?: unknown;
	blockable_type?: unknown;
	updated_at?: unknown;
	blockable?: BlockableLike | null;
}

interface PageLike {
	id?: unknown;
	status?: unknown;
	updated_at?: unknown;
	blocks?: BlockLike[] | null;
}

function projectEntity(entity: EntityLike | null | undefined): unknown {
	if (!entity || typeof entity !== 'object') return null;
	return {
		id: entity.id ?? null,
		updated_at: entity.updated_at ?? null,
		fields_data: entity.fields_data ?? null
	};
}

function projectBlockable(blockable: BlockableLike | null | undefined): unknown {
	if (!blockable || typeof blockable !== 'object') return null;
	const children = Array.isArray(blockable.child_template_instances)
		? blockable.child_template_instances.map(projectBlockable)
		: [];
	return {
		id: blockable.id ?? null,
		updated_at: blockable.updated_at ?? null,
		page_block_template_id: blockable.page_block_template_id ?? null,
		entity: projectEntity(blockable.entity),
		children
	};
}

/** Reduce a hydrated Apex page to the version-sensitive projection described above. */
export function projectPageForVersion(page: PageLike): unknown {
	const blocks = Array.isArray(page?.blocks) ? page.blocks : [];
	return {
		id: page?.id ?? null,
		status: page?.status ?? null,
		updated_at: page?.updated_at ?? null,
		blocks: blocks.map((block) => ({
			id: block?.id ?? null,
			position: block?.position ?? null,
			label: block?.label ?? null,
			blockable_type: block?.blockable_type ?? null,
			updated_at: block?.updated_at ?? null,
			blockable: projectBlockable(block?.blockable)
		}))
	};
}

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let hex = '';
	for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
	return hex;
}

/**
 * Compute the composite version token: a hex SHA-256 over the canonical JSON of the
 * projection (object keys sorted so key-order jitter from Apex never changes the
 * hash; array order preserved so a reorder DOES). Web-standard `crypto.subtle`, so
 * the identical token is produced in workerd and Node.
 */
export async function computePageVersion(page: PageLike): Promise<string> {
	const canonical = JSON.stringify(canonicalize(projectPageForVersion(page)));
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonical));
	return toHex(digest);
}
