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
export type ContentLibraryFields = Record<string, string>;

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

/**
 * Read the record out of an Apex envelope: `{ data: {...} }`, or the object
 * itself when Apex answered flat. Lived in `operations/media.ts` while it was
 * the only caller; `operations/ingest-audio.ts` is the second use, so it moves
 * here — one reader, so the two cannot drift about what an Apex body is.
 */
export function unwrapData(body: unknown): Record<string, unknown> | null {
	if (body && typeof body === 'object') {
		const maybe = body as { data?: unknown };
		if (maybe.data && typeof maybe.data === 'object') return maybe.data as Record<string, unknown>;
		if ('id' in (body as object)) return body as Record<string, unknown>;
	}
	return null;
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
	listContentLibrary(
		slug: string,
		query?: Record<string, string | number>
	): Promise<ApexResponse>;
	getContentLibraryRecord(slug: string, id: string): Promise<ApexResponse>;
	createContentLibraryRecord(
		slug: string,
		fields: ContentLibraryFields
	): Promise<ApexResponse>;
	updateContentLibraryRecord(
		slug: string,
		id: string,
		fields: ContentLibraryFields
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

export function createApexAdminClient(options: ApexAdminClientOptions): ApexAdminClient {
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
					'q[archetype_schema_slug_eq]': encodeURIComponent(slug)
				})}`,
				{ method: 'GET' }
			);
		},
		async getContentLibraryRecord(slug, id) {
			assertUuid(id);
			// The READ surface — the same one the snapshot pipeline hydrates from. It
			// is read-only here BY CONSTRUCTION: no method in this client PATCHes it.
			return call(
				`${ARCHETYPE_SCHEMAS_BASE}/${encodeURIComponent(slug)}/archetypes/${encodeURIComponent(id)}`,
				{ method: 'GET' }
			);
		},
		async createContentLibraryRecord(slug, fields) {
			return call(`${ARCHETYPE_SCHEMAS_BASE}/${encodeURIComponent(slug)}/archetype_models`, {
				method: 'POST',
				body: JSON.stringify(fields)
			});
		},
		async updateContentLibraryRecord(slug, id, fields) {
			assertUuid(id);
			// FLAT keys on `archetype_models` — the one write of the five that persists
			// (probes W1–W5). The other four are documented on `updateSermonTranscript`
			// above; two of them answer 200 and drop the payload on the floor.
			return call(
				`${ARCHETYPE_SCHEMAS_BASE}/${encodeURIComponent(slug)}/archetype_models/${encodeURIComponent(id)}`,
				{ method: 'PATCH', body: JSON.stringify(fields) }
			);
		},
		async deleteContentLibraryRecord(slug, id) {
			assertUuid(id);
			// Deleting an AUTHOR silently strips the author from every article that
			// referenced it — 200, no error, no dangling id (probe A5, risk R5). Apex
			// will not stop you, so the delete-author OPERATION counts references first
			// and refuses without an explicit confirmation. This method is the raw call.
			return call(
				`${ARCHETYPE_SCHEMAS_BASE}/${encodeURIComponent(slug)}/archetype_models/${encodeURIComponent(id)}`,
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
