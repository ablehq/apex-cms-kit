/**
 * Publish: fetch every collection from Apex, project it, and write ONE KV value
 * (plan §2.3). Called by the admin's Publish button with the editor's own Apex
 * client, and by GLC's ingest finalize with the machine client — it is a function,
 * not a route, so both callers share the whole path.
 *
 * The collection set is read from `cms_config` at publish time, exactly as the
 * build-time pipeline did (`getCMSitems`): a new post archetype in Apex shows up
 * with no code change. Only the projection (`snapshot-projection.js`) is GLC-shaped.
 */
import { fetchAllPages } from '../../cms/pagination.js';
import { collectArchetypeReferences, createArchetypesDataEntry } from '../../cms/archetype-data.js';
import type { ApexAdminClient } from '../bff/apex-admin-client';
import { CONTENT_KEY } from './read';
import type { ContentSnapshot, ContentStore } from './read';

const PLATFORM = '/api/platform/v1';
/** KV holds 25 MiB per value; refuse well short of it rather than fail the put. */
const MAX_BYTES = 20 * 1_048_576;
type Pagination = { total_count: number; current_page: number; total_pages: number };
const SORT_NEWEST = { sorts: ['created_at desc'] };

interface CollectionSpec {
	name: string;
	type: string;
	path: string;
	filters: Record<string, unknown>;
	perPage?: number;
}

interface CmsConfig {
	posts?: Array<{ archetype_schema: { slug: string; plural_name: string; account_id?: string } }>;
	content_library?: Array<{
		archetype_schema: { slug: string; plural_name: string; account_id?: string };
	}>;
	asset_library?: Array<{ gallery: { id: string; name: string } }>;
}

/** A raw collection as fetched: the snapshot name, the cms_config kind, the records. */
export interface RawCollection {
	name: string;
	type: string;
	data: unknown[];
}
export interface ProjectedFile {
	name: string;
	records: unknown;
}
/**
 * What a site does to the raw collections before they are stored — GLC projects
 * sermons and pages; a plainer site keeps them raw.
 */
export type SiteProjection = (
	raw: RawCollection[],
	context: { apex: ApexAdminClient }
) => Promise<{ files: ProjectedFile[]; warnings: string[] }>;

export interface PublishOptions {
	apex: ApexAdminClient;
	kv: ContentStore;
	project?: SiteProjection;
	/** The Apex account this deployment is pinned to; the publish refuses any other. */
	accountId: string | undefined;
	publishedBy: string;
	/** A collection that was non-empty and comes back empty is refused unless this is set. */
	allowEmpty?: boolean;
	now?: number;
}

export type PublishResult =
	| {
			ok: true;
			version: string;
			counts: Record<string, number>;
			previous: Record<string, number> | null;
			warnings: string[];
	  }
	| {
			ok: false;
			error: 'account_unpinned' | 'account_mismatch' | 'empty_collection' | 'too_large';
			detail: string;
	  };

export class ContentPublishError extends Error {
	status: number;
	constructor(detail: string, status = 502) {
		super(detail);
		this.name = 'ContentPublishError';
		this.status = status;
	}
}

export async function publishContent(options: PublishOptions): Promise<PublishResult> {
	const { apex, kv } = options;
	if (!options.accountId) {
		return {
			ok: false,
			error: 'account_unpinned',
			detail: 'PRIVATE_APEX_ACCOUNT_ID is not set; a publish must be pinned to one Apex account.'
		};
	}

	const configResponse = await apex.readCmsConfig();
	if (!configResponse.ok)
		throw new ContentPublishError(`cms_config: Apex ${configResponse.status}`);
	const config = unwrapCmsConfig(configResponse.body);
	const accountId = accountIdOf(config);
	if (accountId !== options.accountId) {
		return {
			ok: false,
			error: 'account_mismatch',
			detail: `cms_config belongs to account ${accountId ?? 'unknown'}, not ${options.accountId}.`
		};
	}

	const specs = collectionSpecs(config);
	const raw: RawCollection[] = await inBatches(specs, 5, async (spec) => ({
		name: spec.name,
		type: spec.type,
		data: await listAll(apex, spec.path, spec.filters, `${spec.type}:${spec.name}`, spec.perPage)
	}));

	// One read per post archetype — the article/sermon bodies live there.
	const references = collectArchetypeReferences(
		raw as Parameters<typeof collectArchetypeReferences>[0]
	);
	const archetypes = await inBatches(references, 5, async ({ archetypeSlug, archetypeId }) => {
		const path = `${PLATFORM}/specification/archetype_schemas/${encodeURIComponent(archetypeSlug)}/archetypes/${encodeURIComponent(archetypeId)}`;
		const response = await apex.get(path, {});
		if (!response.ok)
			throw new ContentPublishError(`archetype ${archetypeId}: Apex ${response.status}`);
		return (response.body as { data?: unknown })?.data ?? response.body;
	});
	raw.push(createArchetypesDataEntry([archetypes]));

	// The site's projection: raw collections in, the shapes its loaders read out
	// (plus any warnings it wants an editor to see). Default: the raw collections,
	// keyed by their snapshot names.
	const project = options.project ?? identityProjection;
	const { files, warnings } = await project(raw, { apex });

	const previousRaw = await kv.get(CONTENT_KEY);
	const previous = previousRaw ? (JSON.parse(previousRaw) as ContentSnapshot).counts : null;
	const counts = Object.fromEntries(
		files.map((file) => [file.name, Array.isArray(file.records) ? file.records.length : 0])
	);
	if (!options.allowEmpty) {
		for (const [name, count] of Object.entries(counts)) {
			const before = previous?.[name] ?? 0;
			if (count === 0 && before > 0) {
				return {
					ok: false,
					error: 'empty_collection',
					detail: `${name} came back empty (the site has ${before}); publish again with allowEmpty to confirm.`
				};
			}
		}
	}

	const now = new Date(options.now ?? Date.now());
	const version = `${now.getTime().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
	const snapshot: ContentSnapshot = {
		version,
		publishedAt: now.toISOString(),
		publishedBy: options.publishedBy,
		accountId,
		counts,
		warnings,
		collections: Object.fromEntries(files.map((file) => [file.name, file.records as unknown[]]))
	};
	// `version` is the first property, which is what lets `readContent` skip the parse.
	const serialised = JSON.stringify(snapshot);
	const bytes = new TextEncoder().encode(serialised).byteLength;
	if (bytes > MAX_BYTES) {
		return {
			ok: false,
			error: 'too_large',
			detail: `the snapshot is ${(bytes / 1_048_576).toFixed(1)} MiB; KV holds 25 MiB per value and this refuses above 20.`
		};
	}
	await kv.put(CONTENT_KEY, serialised);
	return { ok: true, version, counts, previous, warnings };
}

function unwrapCmsConfig(body: unknown): CmsConfig {
	const data = (body as { data?: unknown })?.data ?? body;
	if (!data || typeof data !== 'object')
		throw new ContentPublishError('cms_config: unexpected shape');
	return data as CmsConfig;
}

function accountIdOf(config: CmsConfig): string | null {
	const ids = new Set(
		[...(config.posts ?? []), ...(config.content_library ?? [])]
			.map((item) => item.archetype_schema?.account_id)
			.filter((id): id is string => typeof id === 'string' && id.length > 0)
	);
	return ids.size === 1 ? [...ids][0] : null;
}

/** Mirrors the build pipeline's `getCMSitems`: posts, content library, galleries, then the fixed three. */
function collectionSpecs(config: CmsConfig): CollectionSpec[] {
	return [
		...(config.posts ?? []).map((item) => ({
			name: item.archetype_schema.plural_name,
			type: 'posts',
			path: `${PLATFORM}/cms/post_archetype_views/search_and_filter`,
			filters: {
				q: {
					archetype_schema_slug_eq: item.archetype_schema.slug,
					status_eq: 'published',
					...SORT_NEWEST
				}
			}
		})),
		...(config.content_library ?? []).map((item) => ({
			name: item.archetype_schema.plural_name,
			type: 'content_library',
			path: `${PLATFORM}/specification/archetypes/search_and_filter`,
			filters: { q: { archetype_schema_slug_eq: item.archetype_schema.slug, ...SORT_NEWEST } }
		})),
		...(config.asset_library ?? []).map((item) => ({
			name: item.gallery.name,
			type: 'asset_library',
			path: `${PLATFORM}/cms/gallery_items/search_and_filter`,
			filters: { q: { gallery_id_eq: item.gallery.id, ...SORT_NEWEST } },
			perPage: 500
		})),
		{
			name: 'documents',
			type: 'documents',
			path: `${PLATFORM}/cms/documents/search_and_filter`,
			filters: { q: SORT_NEWEST }
		},
		{
			name: 'tags',
			type: 'tags',
			path: `${PLATFORM}/tags/search_and_filter`,
			filters: { q: SORT_NEWEST }
		},
		{
			name: 'pages',
			type: 'pages',
			path: `${PLATFORM}/cms/pages/search_and_filter`,
			filters: { q: SORT_NEWEST }
		}
	];
}

async function listAll(
	apex: ApexAdminClient,
	path: string,
	filters: Record<string, unknown>,
	label: string,
	perPage?: number
): Promise<unknown[]> {
	const response = await fetchAllPages(
		async (pageFilters) => {
			const page = await apex.get(path, pageFilters);
			if (!page.ok) throw new ContentPublishError(`${label}: Apex ${page.status}`);
			return page.body as { data: { id: string }[]; pagination: Pagination };
		},
		filters,
		perPage ? { label, perPage } : { label }
	);
	return response.data;
}

export async function identityProjection(raw: RawCollection[]) {
	return {
		files: raw.map((c) => ({ name: c.name.replaceAll(' ', '_'), records: c.data })),
		warnings: [] as string[]
	};
}

async function inBatches<T, R>(
	items: T[],
	size: number,
	fn: (item: T) => Promise<R>
): Promise<R[]> {
	const out: R[] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
	}
	return out;
}
