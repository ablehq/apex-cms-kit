export interface ApexAdminClientOptions {
	/** Fixed Apex origin, e.g. https://gospellife.in or the local http://localhost:3001. */
	baseUrl: string;
	/** The signed-in editor's Apex staff bearer token (from their server-side session). */
	token: string;
	fetchImpl?: typeof globalThis.fetch;
	/**
	 * Request-scoped abort signal (3c, F9/NEW-D5). The ingest surface builds one
	 * client per request and passes its SHARED 25-second upstream deadline here, so
	 * every Apex call the request makes draws down one budget — five slow calls
	 * exhaust it exactly as one would. When absent, nothing changes for existing
	 * callers: no timeout is imposed at this layer.
	 */
	signal?: AbortSignal;
	/**
	 * The content-library schema slugs this site may read and write through the
	 * content-library methods. Omitted: no narrowing (GLC's behaviour today).
	 */
	allowedSchemaSlugs?: readonly string[];
}

export interface ApexResponse {
	status: number;
	ok: boolean;
	body: unknown;
	/**
	 * True only when the shared deadline aborted this call (status is 0). A typed
	 * failure, not an exception, so a route maps it to its own error code without
	 * a try/catch at every call site. Absent on every non-aborted response.
	 */
	aborted?: boolean;
	/**
	 * True when the fetch itself failed (DNS, TLS, reset) on a signal-carrying
	 * call (status is 0). Same typed-failure discipline as `aborted`; callers
	 * without a signal see the exception instead, unchanged.
	 */
	networkError?: boolean;
}

export const PAGES_BASE = '/api/platform/v1/cms/pages';
export const ENTITY_TYPES_BASE = '/api/platform/v1/content_library/entity_types';
export const GALLERY_BASE = '/api/platform/v1/cms/gallery_items';
export const MEDIA_BASE = '/api/platform/v1/media';
/**
 * PLATFORM route, not `/api/v1/…`. Read this before "simplifying" either half.
 *
 * BOTH routes exist upstream and BOTH work — but each takes a DIFFERENT body, and
 * the route and the body must be changed together or not at all. Measured against
 * local Apex on 2026-07-31, all four combinations:
 *
 *   /api/v1/media/signed_upload_url           {file:{…}} envelope  → 200
 *   /api/v1/media/signed_upload_url           flat scalars         → 422 "param is
 *                                                  missing … : file"   (probe G4)
 *   /api/platform/v1/media/signed_upload_url  {file:{…}} envelope  → 422 "Filename
 *                                                  can't be blank, …"
 *   /api/platform/v1/media/signed_upload_url  flat scalars         → 200 (G5/G6)
 *
 * So the earlier `/api/v1` + envelope pairing was NOT broken; it was one of the two
 * self-consistent pairs. It moved here for one reason: the FINALIZE leg of this same
 * upload (`MEDIA_BASE`, below) is `/api/platform/v1/media`, so the flow used to mint
 * a `signed_id` on one API tree and redeem it on another. Both legs now live on the
 * platform tree, which is also the surface the 3d probe matrix records as canonical
 * and the tree every other route in this file already uses.
 *
 * The mismatched pairs both fail LOUDLY (422), never silently — so a half-applied
 * change here cannot lose data the way the `archetypes`-vs-`archetype_models` write
 * hazard documented on `updateSermonTranscript` can.
 */
export const SIGNED_UPLOAD = '/api/platform/v1/media/signed_upload_url';
export const ARCHETYPES_BASE = '/api/platform/v1/specification/archetypes';
export const ARCHETYPE_SCHEMAS_BASE = '/api/platform/v1/specification/archetype_schemas';
export const TAGS_BASE = '/api/platform/v1/tags';
export const TAGGINGS_BASE = '/api/platform/v1/taggings';
export const POSTS_BASE = '/api/platform/v1/cms/posts';
export const DOCUMENTS_BASE = '/api/platform/v1/cms/documents';
export const POST_VIEWS_BASE = '/api/platform/v1/cms/post_archetype_views';
export const CMS_CONFIG = '/api/platform/v1/cms_config';

export type PageStatusEvent = 'publish' | 'unpublish';

/**
 * The `Cms::Post` status vocabulary the admin uses. Apex's AASM knows more events
 * (`schedule`, `archive`, `edit`, …); these two are the only ones any 3d screen can
 * ask for, so nothing else is expressible.
 */
export type PostStatusEvent = 'publish' | 'unpublish';

/**
 * A content-library field map. The value type is `string`, NOT `string | null`, and
 * that is load-bearing rather than tidy: sending `null` for a primitive destroys the
 * `archetype_item` row upstream AND strands the old value in `archetype.primitives`,
 * which is the exact key the public site renders (probe N2). Clearing a field is
 * `''`. `containsNullPrimitive` in `authorization.ts` enforces the same rule at
 * runtime for values that arrive over the wire; this type enforces it for values
 * written in our own code.
 */
export type ContentLibraryFields = Record<string, NonNullable<unknown>>;

/**
 * One entry of a `has_many` reference write. Apex's upsert takes the WHOLE desired
 * set as hashes: an entry that names only the target keeps or adds it, and
 * `{item_id, _destroy: true}` removes one — where `item_id` is the JOIN ROW's id,
 * never the referenced record's. Sending only the additions silently drops the
 * removals; sending target ids where join ids belong removes the wrong rows.
 */
export type HasManyEntry = Record<string, string> | { item_id: string; _destroy: true };

/**
 * The four scalars `POST /api/platform/v1/media/signed_upload_url` wants, at the TOP
 * level of the body (probes G5/G6). This is a named type rather than
 * `Record<string, unknown>` so the call site cannot drift back into an envelope
 * without the compiler noticing.
 */
export interface SignedUploadFile {
	filename: string;
	byte_size: number;
	content_type: string;
	checksum: string;
}

/** The `Cms::GalleryItem` fields the images screen may write (probe G3). */
export interface GalleryItemFields {
	caption?: string;
	alt?: string;
	position?: number;
}

export function assertUuid(id: string): void {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)) {
		// Belt-and-suspenders: the route already zod-validates the id, but the client
		// refuses to interpolate anything that could smuggle a path separator, a dot
		// segment or a percent-encoding into the URL.
		throw new Error('invalid uuid');
	}
}

/**
 * One `search_and_filter` query string. `defaults` first, then the caller's own
 * filters, then `fixed` LAST — so a fixed filter (the schema slug, the gallery id)
 * always wins and a caller cannot widen the set it is allowed to see.
 */
export function searchParams(
	query: Record<string, string | number> = {},
	fixed: Record<string, string> = {}
): string {
	const params = new URLSearchParams({ per_page: '100', page: '1' });
	for (const [key, value] of Object.entries(query)) params.set(key, String(value));
	for (const [key, value] of Object.entries(fixed)) params.set(key, value);
	return params.toString();
}

/** The block-structure payload the page PATCH carries (already serialized by the caller). */
export interface PageStructureBody {
	title?: string;
	slug?: string;
	summary?: string;
	blocks_attributes?: unknown[];
	meta_properties_attributes?: unknown[];
}

export interface ApexAdminClient {
	listPages(query: Record<string, string | number>): Promise<ApexResponse>;
	listPageBlockTemplates(): Promise<ApexResponse>;
	getPage(pageId: string): Promise<ApexResponse>;
	updatePageStructure(pageId: string, body: PageStructureBody): Promise<ApexResponse>;
	updateEntityFields(
		entityTypeId: string,
		entityId: string,
		fieldsData: Record<string, unknown>
	): Promise<ApexResponse>;
	changePageStatus(pageId: string, statusEvent: PageStatusEvent): Promise<ApexResponse>;
	createGalleryItem(galleryId: string, caption: string, alt: string): Promise<ApexResponse>;
	createSignedUploadUrl(file: SignedUploadFile): Promise<ApexResponse>;
	createMedium(body: Record<string, unknown>): Promise<ApexResponse>;
	/**
	 * One ransack page of media, for the finalize reap (audio reap plan, D-8).
	 * `search_and_filter` defaults to `created_at desc` when `q[sorts]` is empty
	 * (`api/resources_controller.rb:187`), so the rows arrive NEWEST FIRST — the
	 * order the grandparent rule is stated in — without asking for a sort.
	 */
	listMedia(query?: Record<string, string | number>, signal?: AbortSignal): Promise<ApexResponse>;
	/**
	 * `DELETE {MEDIA_BASE}/:id`. Apex answers 200 WITH a JSON envelope — not
	 * `head :ok` — and a missing (or another account's) id is a 404 JSON body,
	 * not a raised error, so the reap can treat every outcome as a status to
	 * record rather than an exception to survive. The per-call signal is the
	 * reap's own short deadline (D-5): these calls are awaited before the
	 * finalize 200 returns, and on the shared budget alone a hung Apex would
	 * time out the PUBLISH.
	 */
	deleteMedium(id: string, signal?: AbortSignal): Promise<ApexResponse>;

	// ── Phase 3d: authors, resources, articles, tags, galleries ─────────────
	//
	// There is deliberately NO method that writes to
	// `…/archetype_schemas/:slug/archetypes/:id`. That is the surface the snapshot
	// pipeline READS from, so pointing a write at it is the obvious guess — and Apex
	// answers 200 and persists nothing (probes W1/W2, risk R1). Every write below
	// goes to `archetype_models`, `cms/posts` or `cms/documents`.
	//
	// There is also deliberately NO `deleteTag`. `DELETE /tags/:id` cascades ACROSS
	// THE WHOLE ACCOUNT — one call un-tagged every record on it (probe T6, risk R4).
	// Un-tagging one record is `deleteTagging`, which is correctly scoped (T7).

	/** Authors / resources list. The schema filter is applied here, not by the caller. */
	listContentLibrary(slug: string, query?: Record<string, string | number>): Promise<ApexResponse>;
	getContentLibraryRecord(slug: string, id: string): Promise<ApexResponse>;
	createContentLibraryRecord(
		slug: string,
		fields: ContentLibraryFields,
		references?: Record<string, HasManyEntry[] | string | null>
	): Promise<ApexResponse>;
	updateContentLibraryRecord(
		slug: string,
		id: string,
		fields: ContentLibraryFields,
		references?: Record<string, HasManyEntry[] | string | null>
	): Promise<ApexResponse>;
	deleteContentLibraryRecord(slug: string, id: string): Promise<ApexResponse>;
	getDocument(documentId: string): Promise<ApexResponse>;
	updateDocumentBlocks(documentId: string, blocks: unknown[]): Promise<ApexResponse>;
	changePostStatus(postId: string, statusEvent: PostStatusEvent): Promise<ApexResponse>;

	listTags(query?: Record<string, string | number>): Promise<ApexResponse>;
	createTag(name: string): Promise<ApexResponse>;
	listTaggings(query?: Record<string, string | number>): Promise<ApexResponse>;
	createTagging(tagId: string, taggableId: string): Promise<ApexResponse>;
	deleteTagging(taggingId: string): Promise<ApexResponse>;

	listGalleryItems(galleryId: string): Promise<ApexResponse>;
	updateGalleryItem(galleryItemId: string, fields: GalleryItemFields): Promise<ApexResponse>;
	deleteGalleryItem(galleryItemId: string): Promise<ApexResponse>;

	/** The registry gallery ids come from — they are account-scoped (risk R14). */
	readCmsConfig(): Promise<ApexResponse>;
	/**
	 * A GET of any platform-API path with a (possibly nested) query, serialised the
	 * way Apex's `search_and_filter` expects (`q[slug_eq]=…`, `q[sorts][]=…`). The
	 * publish (`content/publish.ts`) reads every collection through this one method
	 * instead of a fixed function per endpoint; the path must stay under
	 * `/api/platform/v1/`.
	 */
	get(path: string, query: Record<string, unknown>): Promise<ApexResponse>;
	/** A raw call on the client's origin with its token — for a site's own extension methods. */
	request(path: string, init: RequestInit): Promise<ApexResponse>;
}

function flattenQuery(query: Record<string, unknown>, prefix = '', into = new URLSearchParams()) {
	for (const [key, value] of Object.entries(query)) {
		const name = prefix ? `${prefix}[${key}]` : key;
		if (Array.isArray(value)) for (const item of value) into.append(`${name}[]`, String(item));
		else if (value && typeof value === 'object')
			flattenQuery(value as Record<string, unknown>, name, into);
		else if (value !== undefined && value !== null) into.set(name, String(value));
	}
	return into;
}

/**
 * The Apex client (plan §8, 3a; ADR-1 as revised 2026-07-31). Every Apex call the
 * BFF makes runs server-side with the SIGNED-IN EDITOR's own Apex staff token,
 * taken from their server-side session — which is why Apex's own audit now names
 * the person who made a change instead of a shared `glc-admin-bff` machine login.
 * NO Apex token of any kind ever reaches the browser.
 *
 * The token is a plain constructor argument, so this client is not tied to how the
 * caller got one. PHASE 3c's INGEST path is a machine caller by design and will
 * construct this same client with a machine token of its own — nothing here needs
 * to change for it, and nothing it needs has been removed (see
 * `src/routes/api/ingest/+server.ts` and `docs/runbooks/glc-admin-bff-token.md` §2).
 * What no longer exists is a machine principal in the ADMIN path.
 *
 * Boundary hygiene on the upstream side: a fresh `Headers` (inbound cookies and
 * arbitrary headers are never forwarded), a FIXED origin the request can never be
 * redirected off of (`redirect: 'manual'`, origin re-checked), and upstream
 * `Set-Cookie` is never propagated (only the JSON body is read).
 *
 * ONE read here carries a correctness obligation beyond transport: the ingest
 * catalogue page (`listSermonsPage`) is read under a FIXED ASCENDING ORDER —
 * Arpan's ruling of 2026-08-09, option B (stable ordering plus a tripwire), on
 * codex round-3 blocker #2. Apex serves `search_and_filter` from a live table
 * with no ordering guarantee, so stable pagination TOTALS never proved the pages
 * came from one snapshot. `CATALOGUE_SORTS` below is the ordering half; the
 * tripwire half lives on `sweepSermonCatalogue` in `ingest-reservation.ts`.
 */
export function createApexAdminClient(options: ApexAdminClientOptions): ApexAdminClient {
	/**
	 * Narrow a schema slug to the site's content-library set at RUNTIME as well as at
	 * compile time — so a `@ts-nocheck` module, a test, or a future JS caller cannot
	 * reach a POST archetype, whose fields must never be written on this surface. A
	 * site that passes no allowlist gets today's behaviour: any slug.
	 */
	function contentLibrarySlug(slug: string): string {
		const allowed = options.allowedSchemaSlugs;
		if (allowed && !allowed.includes(slug)) {
			throw new Error(`not a content-library archetype schema: ${slug}`);
		}
		return encodeURIComponent(slug);
	}
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	if (!options.baseUrl) throw new Error('Apex base URL is not configured');
	if (!options.token) throw new Error('Apex admin token is not configured');
	const origin = new URL(options.baseUrl).origin;

	async function call(path: string, init: RequestInit): Promise<ApexResponse> {
		const url = new URL(path, `${origin}/`);
		// The path is always a fixed literal built below — never a caller-supplied
		// hostname — but re-check the origin so a future edit can't drift off it.
		if (url.origin !== origin) throw new Error('refusing off-origin Apex call');

		const headers = new Headers();
		headers.set('authorization', `Bearer ${options.token}`);
		headers.set('accept', 'application/json');
		if (init.body !== undefined && init.body !== null) {
			headers.set('content-type', 'application/json');
		}

		// A per-call signal, when a method passes one, NARROWS the shared budget for
		// that one call — today only the reap's short deadline (D-5). Every existing
		// method passes none, so nothing else changes.
		const signal = init.signal ?? options.signal;

		// A deadline that already ran out refuses BEFORE the fetch: once the shared
		// budget is spent, every further call in the request is an immediate typed
		// failure rather than a doomed upstream round trip.
		if (signal?.aborted) {
			return { status: 0, ok: false, body: null, aborted: true };
		}

		let response: Response;
		try {
			response = await fetchImpl(url, {
				...init,
				headers,
				redirect: 'manual',
				signal
			});
		} catch (error) {
			if (signal?.aborted) {
				return { status: 0, ok: false, body: null, aborted: true };
			}
			// On the signal-carrying (ingest) path every network fault — DNS, TLS,
			// connection reset — is a typed failure so the route answers its
			// contracted 502 {"error":"upstream_error"} and writes its audit row,
			// instead of leaking a framework 500 with neither. Callers that pass no
			// signal (the admin) keep today's propagation, so their error handling
			// is unchanged.
			if (signal) {
				return { status: 0, ok: false, body: null, networkError: true };
			}
			throw error;
		}
		// A 3xx from Apex is never followed — treat it as a failure rather than
		// chase a redirect to who-knows-where.
		if (response.status >= 300 && response.status < 400) {
			return { status: response.status, ok: false, body: null };
		}
		let body: unknown = null;
		const contentType = response.headers.get('content-type') ?? '';
		if (contentType.includes('application/json')) {
			body = await response.json().catch(() => null);
		}
		// Note: upstream Set-Cookie is intentionally never read or propagated.
		return { status: response.status, ok: response.ok, body };
	}

	return {
		async listPages(query) {
			const params = new URLSearchParams();
			for (const [key, value] of Object.entries(query)) params.set(key, String(value));
			const suffix = params.toString();
			return call(`${PAGES_BASE}/search_and_filter${suffix ? `?${suffix}` : ''}`, {
				method: 'GET'
			});
		},
		async listPageBlockTemplates() {
			return call('/api/platform/v1/cms/page_block_templates/search_and_filter?per_page=100', {
				method: 'GET'
			});
		},
		async getPage(pageId) {
			assertUuid(pageId);
			return call(`${PAGES_BASE}/${encodeURIComponent(pageId)}`, { method: 'GET' });
		},
		async updatePageStructure(pageId, body) {
			assertUuid(pageId);
			return call(`${PAGES_BASE}/${encodeURIComponent(pageId)}`, {
				method: 'PATCH',
				body: JSON.stringify(body)
			});
		},
		async updateEntityFields(entityTypeId, entityId, fieldsData) {
			assertUuid(entityTypeId);
			assertUuid(entityId);
			return call(
				`${ENTITY_TYPES_BASE}/${encodeURIComponent(entityTypeId)}/entities/${encodeURIComponent(entityId)}`,
				{ method: 'PATCH', body: JSON.stringify({ fields_data: fieldsData }) }
			);
		},
		async changePageStatus(pageId, statusEvent) {
			assertUuid(pageId);
			// The ENDPOINT is `status_event`; the BODY KEY is `event`. They are not the
			// same word, and the mismatch is the whole bug this call shipped with.
			//
			// Measured against a real local Apex on 2026-07-31, on a published page,
			// re-reading the page after each attempt (a 200 is not evidence — the re-read
			// is):
			//
			//   POST …/pages/:id/status_event  {"status_event":"unpublish"} → 422
			//        {"message":"Invalid status event "}   re-read: still `published`
			//   POST …/pages/:id/status_event  {"event":"unpublish"}        → 200
			//                                              re-read: `draft`
			//
			// So every publish and unpublish the admin has ever issued 422'd and changed
			// nothing, silently, because the BFF only surfaced it as a generic 502. The
			// repo's own page-authoring script (`cms/scripts/page-authoring-api.ts`) has
			// always sent `{ event }` — the two callers had drifted apart.
			//
			// Our OWN wire name stays `status_event` (the browser body, the route schema,
			// the audit action). It names Apex's endpoint, it is unambiguous in a JSON
			// body that has no surrounding path to disambiguate a bare `event`, and it is
			// already the shipped same-origin contract. This one line is the ONLY place
			// the two vocabularies meet, which is where a translation belongs.
			return call(`${PAGES_BASE}/${encodeURIComponent(pageId)}/status_event`, {
				method: 'POST',
				body: JSON.stringify({ event: statusEvent })
			});
		},
		async createGalleryItem(galleryId, caption, alt) {
			assertUuid(galleryId);
			return call(GALLERY_BASE, {
				method: 'POST',
				body: JSON.stringify({ gallery_id: galleryId, caption, alt })
			});
		},
		async createSignedUploadUrl(file) {
			// FLAT scalars, NOT a `{file: {…}}` envelope — the platform route reads
			// the four keys off the TOP level of `params`, so wrapping them makes
			// every one of them invisible to it ("Filename can't be blank, …").
			// The pairing is explained in full on `SIGNED_UPLOAD` above; the short
			// version is that route and body shape are a matched set.
			//
			// The keys are named ONE BY ONE rather than spread, so an extra key on
			// the caller's object can never reach Apex — the BFF's `signBodySchema`
			// (`operations/media.ts`) is `.strict()` on the same four, so the two
			// ends agree by construction.
			return call(SIGNED_UPLOAD, {
				method: 'POST',
				body: JSON.stringify({
					filename: file.filename,
					byte_size: file.byte_size,
					content_type: file.content_type,
					checksum: file.checksum
				})
			});
		},
		async createMedium(body) {
			return call(MEDIA_BASE, { method: 'POST', body: JSON.stringify(body) });
		},
		async listMedia(query = {}, signal) {
			return call(`${MEDIA_BASE}/search_and_filter?${searchParams(query)}`, {
				method: 'GET',
				signal
			});
		},
		async deleteMedium(id, signal) {
			assertUuid(id);
			return call(`${MEDIA_BASE}/${encodeURIComponent(id)}`, { method: 'DELETE', signal });
		},

		// ── Phase 3d ────────────────────────────────────────────────────────────

		async listContentLibrary(slug, query = {}) {
			// The schema filter is set HERE and last, so a caller cannot widen the
			// catalogue by passing its own `q[archetype_schema_slug_eq]`.
			return call(
				`${ARCHETYPES_BASE}/search_and_filter?${searchParams(query, {
					'q[archetype_schema_slug_eq]': contentLibrarySlug(slug)
				})}`,
				{ method: 'GET' }
			);
		},
		async getContentLibraryRecord(slug, id) {
			assertUuid(id);
			// The READ surface — the same one the snapshot pipeline hydrates from. It
			// is read-only here BY CONSTRUCTION: no method in this client PATCHes it.
			return call(
				`${ARCHETYPE_SCHEMAS_BASE}/${contentLibrarySlug(slug)}/archetypes/${encodeURIComponent(id)}`,
				{ method: 'GET' }
			);
		},
		async createContentLibraryRecord(slug, fields, references = {}) {
			return call(`${ARCHETYPE_SCHEMAS_BASE}/${contentLibrarySlug(slug)}/archetype_models`, {
				method: 'POST',
				body: JSON.stringify({ ...fields, ...references })
			});
		},
		async updateContentLibraryRecord(slug, id, fields, references = {}) {
			assertUuid(id);
			// FLAT keys on `archetype_models` — the one write of the five that persists
			// (probes W1–W5). The other four are documented on `updateSermonTranscript`
			// above; two of them answer 200 and drop the payload on the floor.
			return call(
				`${ARCHETYPE_SCHEMAS_BASE}/${contentLibrarySlug(slug)}/archetype_models/${encodeURIComponent(id)}`,
				// Reference values ride in the same body under their item name: a `has_one`
				// is a bare id (or `null` to clear), a `has_many` the all-hash diff array
				// documented on `HasManyEntry`.
				{ method: 'PATCH', body: JSON.stringify({ ...fields, ...references }) }
			);
		},
		async deleteContentLibraryRecord(slug, id) {
			assertUuid(id);
			// Deleting an AUTHOR silently strips the author from every article that
			// referenced it — 200, no error, no dangling id (probe A5, risk R5). Apex
			// will not stop you, so the delete-author OPERATION counts references first
			// and refuses without an explicit confirmation. This method is the raw call.
			return call(
				`${ARCHETYPE_SCHEMAS_BASE}/${contentLibrarySlug(slug)}/archetype_models/${encodeURIComponent(id)}`,
				{ method: 'DELETE' }
			);
		},
		async getDocument(documentId) {
			assertUuid(documentId);
			return call(`${DOCUMENTS_BASE}/${encodeURIComponent(documentId)}`, { method: 'GET' });
		},
		async updateDocumentBlocks(documentId, blocks) {
			assertUuid(documentId);
			// NOT A REPLACEMENT — it APPENDS. `blocks_attributes` is ordinary Rails
			// `accepts_nested_attributes_for`: an entry with no id CREATES, an entry with
			// an id UPDATES (including `blockable_attributes.id` for the inner row), and a
			// row simply omitted from the body SURVIVES untouched. Measured against real
			// local Apex on 2026-07-31, re-reading the document after each write: a
			// 3-block document PATCHed with 1 new block came back with **4 blocks**.
			//
			// So a caller that "serializes the whole document every time" DOUBLES the
			// article's body on every save, and doubles it again on the next one. The
			// browser is allowed to think in whole documents; the translation to Apex's
			// diff lives in `operations/save-body-article.ts` (`buildBlocksAttributes`),
			// which keeps by id, creates the id-less, and `_destroy`s what the editor
			// removed. Do not "simplify" that diff away — deleting it is not a
			// refactor, it is the doubling bug.
			return call(`${DOCUMENTS_BASE}/${encodeURIComponent(documentId)}`, {
				method: 'PATCH',
				body: JSON.stringify({ blocks_attributes: blocks })
			});
		},
		async changePostStatus(postId, statusEvent) {
			assertUuid(postId);
			// Same trap as `changePageStatus` above, on the post side: the ENDPOINT is
			// `status_event`, the BODY KEY is `event`. Measured against real local Apex
			// on 2026-07-31, re-reading the post after each attempt because a status
			// code is not evidence:
			//
			//   POST …/posts/:id/status_event  {"status_event":"publish"} → 422
			//        {"message":"Invalid status event "}   re-read: still `draft`
			//   POST …/posts/:id/status_event  {"event":"publish"}        → 200
			//                                              re-read: `published`
			//
			// The admin's own wire name stays `statusEvent` (the browser body, the route
			// schema, the audit action); this line is the only place the two
			// vocabularies meet, which is where a translation belongs.
			return call(`${POSTS_BASE}/${encodeURIComponent(postId)}/status_event`, {
				method: 'POST',
				body: JSON.stringify({ event: statusEvent })
			});
		},

		async listTags(query = {}) {
			return call(`${TAGS_BASE}/search_and_filter?${searchParams(query)}`, { method: 'GET' });
		},
		async createTag(name) {
			// `Tag` validates uniqueness per tenant, so a duplicate name is a LOUD 422
			// `"Name has already been taken"` (probe T9) rather than a second row. The
			// operation above this treats that 422 as "it already exists, adopt it" —
			// list-then-create, adopt on 422 — never as an error to show an editor.
			return call(TAGS_BASE, { method: 'POST', body: JSON.stringify({ name }) });
		},
		async listTaggings(query = {}) {
			return call(`${TAGGINGS_BASE}/search_and_filter?${searchParams(query)}`, { method: 'GET' });
		},
		async createTagging(tagId, taggableId) {
			assertUuid(tagId);
			assertUuid(taggableId);
			// NOT IDEMPOTENT: an identical retry returns 200 and creates a SECOND row
			// (probe T4 — `Tagging` has no uniqueness validation and no unique index).
			// So no caller may retry this blindly; the reconciling operation reads the
			// current set first, POSTs only what is missing, and deletes duplicates.
			//
			// `taggable_type` is a fixed literal, never a parameter: the only thing 3d
			// tags is a `Specification::Archetype`.
			return call(TAGGINGS_BASE, {
				method: 'POST',
				body: JSON.stringify({
					tag_id: tagId,
					taggable_type: 'Specification::Archetype',
					taggable_id: taggableId
				})
			});
		},
		async deleteTagging(taggingId) {
			assertUuid(taggingId);
			// The correctly scoped un-tag (probe T7) — it removes ONE association and
			// leaves every other record's taggings intact. This is the only deletion in
			// the tagging surface the admin exposes.
			return call(`${TAGGINGS_BASE}/${encodeURIComponent(taggingId)}`, { method: 'DELETE' });
		},

		async listGalleryItems(galleryId) {
			assertUuid(galleryId);
			return call(
				`${GALLERY_BASE}/search_and_filter?${searchParams(
					{ per_page: 500 },
					{ 'q[gallery_id_eq]': galleryId }
				)}`,
				{ method: 'GET' }
			);
		},
		async updateGalleryItem(galleryItemId, fields) {
			assertUuid(galleryItemId);
			return call(`${GALLERY_BASE}/${encodeURIComponent(galleryItemId)}`, {
				method: 'PATCH',
				body: JSON.stringify(fields)
			});
		},
		async deleteGalleryItem(galleryItemId) {
			assertUuid(galleryItemId);
			return call(`${GALLERY_BASE}/${encodeURIComponent(galleryItemId)}`, { method: 'DELETE' });
		},

		async get(path, query) {
			// Normalise first, so `..` segments or an embedded `?` cannot walk out of the
			// platform API; the query is built structurally from `query` alone.
			const url = new URL(path, `${origin}/`);
			if (url.origin !== origin || url.search || !url.pathname.startsWith('/api/platform/v1/')) {
				throw new Error('refusing a read outside the platform API');
			}
			return call(`${url.pathname}?${flattenQuery(query).toString()}`, { method: 'GET' });
		},

		async readCmsConfig() {
			// Gallery ids are ACCOUNT-SCOPED. Hard-coding the dev account's ids is how
			// the images screen would break on production (risk R14), so they are
			// resolved from here at request time — exactly as the snapshot pipeline
			// already does. Schema SLUGS are the opposite: fixed literals, above.
			return call(CMS_CONFIG, { method: 'GET' });
		},
		request(path, init) {
			return call(path, init);
		}
	};
}
