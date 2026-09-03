/**
 * The shapes the admin already works in, written down once.
 *
 * The admin's browser modules (`bff-client.js`, `page-draft.js`,
 * `transcript-draft.js`, …) are `@ts-nocheck` on purpose — they sit beside the
 * legacy-compiled components and are covered by their own unit tests. That
 * suppresses errors INSIDE those files; it does not stop their JSDoc from typing
 * everything that imports them. So the annotations live at those modules' public
 * signatures and point here, and the components get real types without a single
 * line of runtime code changing.
 *
 * Nothing here is invented. Every field is one the browser code actually reads,
 * and each shape is checked against the BFF operation that produces it
 * (`src/lib/server/bff/operations/*.ts`) — the browser talks to nothing else.
 * Where the producer is genuinely free-form — a block entity's `fields_data` is
 * whatever Apex validated for that template's fields — the type says `unknown`
 * and the reader narrows, rather than asserting a shape nobody guarantees.
 */

// ── Pages (plan §8, 3a) ─────────────────────────────────────────────────────

/**
 * The tiptap-shaped value a `rich_text` field stores, as Apex's validator and the
 * public renderer both read it (`rich-text.js`).
 */
export interface RichTextValue {
	editor: string;
	html: string;
	content: object;
}

/** One `meta_properties` entry on a page. The SEO tab shows the `web` group. */
export interface AdminPageMetaProperty {
	name?: string | null;
	group?: string | null;
	value?: string | null;
}

/**
 * The entity behind a block or a repeatable item — where a section's field values
 * live, and the thing a dirty-field save PATCHes.
 */
export interface AdminEntity {
	id: string;
	entity_type_id?: string | null;
	/** Apex-validated JSON, keyed by the template contract's field names. */
	fields_data?: Record<string, unknown>;
}

/** The template a block instantiates, as the hydrated page read carries it. */
export interface AdminPageBlockTemplate {
	id?: string;
	slug?: string;
	name?: string | null;
}

/** A repeatable item inside a section (Apex: a child template instance). */
export interface AdminChildTemplateInstance {
	id: string;
	page_block_template?: AdminPageBlockTemplate | null;
	entity?: AdminEntity | null;
}

/** What a page block points at. Only the template-instance case is authored here. */
export interface AdminBlockable {
	id: string;
	page_block_template_id?: string;
	page_block_template?: AdminPageBlockTemplate | null;
	entity?: AdminEntity | null;
	child_template_instances?: AdminChildTemplateInstance[];
}

/** One section on a page. */
export interface AdminPageBlock {
	id: string;
	label?: string | null;
	position?: number;
	blockable_type?: string;
	blockable?: AdminBlockable | null;
}

/**
 * A page as the BFF hands it over — `GET /api/admin/pages/:id` unwraps Apex's
 * `{ data: … }` envelope, and `GET /api/admin/pages` returns an array of the same
 * records. Everything but `id` is optional because the projection is Apex's, not
 * ours: the list carries `blocks`/`updated_at`/`status`, and the editor's read
 * additionally carries `meta_properties`.
 */
export interface AdminPage {
	id: string;
	title?: string | null;
	slug?: string | null;
	summary?: string | null;
	status?: string | null;
	archived_at?: string | null;
	updated_at?: string | null;
	blocks?: AdminPageBlock[];
	meta_properties?: AdminPageMetaProperty[];
}

/** `GET /api/admin/pages/:id` — the page plus the stale guard's baseline token. */
export interface AdminPageLoad {
	page: AdminPage;
	version: string;
}

/** The local page-draft the editor mutates (`page-draft.js`). */
export interface AdminPageDraft {
	pageId: string;
	baselineVersion: string;
	page: AdminPage;
	/** Entity ids whose `fields_data` the editor changed. */
	dirtyEntityIds: Set<string>;
	structureDirty: boolean;
	/** Real ids of removed blocks, sent as `{ id, _destroy: true }`. */
	deletedBlockIds: string[];
}

/** The two status events the BFF's status route accepts. Nothing archives. */
export type AdminStatusEvent = 'publish' | 'unpublish';

// ── The template contract (cms/config/page-block-templates.v1.json) ──────────

/** One field of a template, as the committed contract spells it. */
export interface AdminContractField {
	name: string;
	displayName?: string;
	validatorKind?: string | null;
	role?: string | null;
	textInclusion?: string[] | null;
}

/** A template in the committed contract — the admin's field-def source of truth. */
export interface AdminBlockTemplateContract {
	slug: string;
	name: string;
	description?: string;
	templateKind?: string;
	placement?: string;
	dataSource?: string;
	children?: string[];
	fields?: AdminContractField[];
}

/** A contract field normalized to what `BlockFieldEditor` reads. */
export interface AdminFieldDef {
	field_name: string;
	display_name: string;
	validator_kind: string | null;
	role: string | null;
	text_inclusion: string[] | null;
}

/**
 * A provisioned Apex template, from `GET /api/admin/page-block-templates`. The
 * committed contract knows the slug; only this read knows the Apex id, which is
 * what adding a section needs.
 */
export interface AdminTemplateSummary {
	id: string;
	slug: string;
	name: string;
	entity_type_id: string | null;
}

/** slug → provisioned template. A slug the account has not provisioned is absent. */
export type AdminTemplateRegistry = Record<string, AdminTemplateSummary>;

// ── Sermon transcripts (plan §8, 3b) ────────────────────────────────────────

// ── Articles, authors, resources (plan §8, 3d) ──────────────────────────────

/**
 * One item of an asset-library gallery.
 *
 * There is no thumbnail field, and its absence is the honest answer rather than an
 * omission: `medium` and `thumbnail` are `has_one … as: :record` associations that
 * are simply MISSING from the read until bytes are attached, and no bytes can be
 * attached against local Apex (§2.7 — the signed upload URL points at a port it does
 * not serve). Their shape has therefore never been observed. Declaring a
 * `thumbnailUrl` on a guess would be a field that silently stays empty forever.
 * It arrives with upload bring-up, together with the shape that proves it.
 */
export interface AdminGalleryItem {
	id: string;
	galleryId: string;
	caption: string;
	alt: string;
	position: number;
	/** ISO 8601, from Apex. The Images list sorts newest-first on it. */
	createdAt: string;
}

/**
 * One field of the `#tab-details` block, as `EntityForm.svelte` draws it. The kinds
 * are the prototype's `fieldHTML()` set and 3d introduces no sixth one.
 * `pair: true` puts consecutive fields side by side in a `.two` row — Title/Slug,
 * and a resource's Type/URL.
 */
export interface AdminFieldDescriptor {
	name: string;
	label: string;
	kind?: 'text' | 'mono' | 'multiline';
	pair?: boolean;
	placeholder?: string;
	rows?: number;
	hint?: string;
}

/**
 * The local draft of a content-library record (`entity-draft.js`). Values are
 * `string` and never `null` — clearing a field is `''`, because `null` destroys the
 * row upstream and strands the old value where the public site reads it.
 */
export interface AdminEntityDraft {
	/** The content-library schema slug; a site may narrow it to its own union. */
	kind: string;
	entityId: string;
	baselineVersion: string;
	fields: Record<string, string>;
	baselineFields: Record<string, string>;
	/** Field names whose value differs from the baseline. */
	dirtyFields: Set<string>;
}

/** What `saveEntity()` resolves to (`save-entity.js`). */
export type SaveEntityResult =
	| { ok: true; refreshed: boolean }
	| { ok: false; stale?: boolean; stage?: string; status?: number; message: string };

// ── The BFF client (bff-client.js) ──────────────────────────────────────────

/**
 * What a mutation resolves to. `bff-client.js` normalizes every non-GET into
 * `{ ok, status, …parsed body }`, so callers branch without a try/catch; the
 * body's own keys differ per route and are read by name where they are known.
 */
export interface BffMutationResult {
	ok: boolean;
	status: number;
	[key: string]: unknown;
}

/**
 * What a failed READ rejects with. `bff-client.js` throws a plain `Error` with the
 * HTTP status attached, which is how the routes tell "session ended" (401) from
 * everything else.
 */
export interface BffRequestError extends Error {
	status?: number;
}

/**
 * The 2xx body of `POST /api/admin/media/uploads` (`operations/media.ts`): the
 * gallery item the BFF created, plus the ActiveStorage direct-upload signature the
 * browser PUTs the bytes to. A failure comes back as `{ ok: false, status, error }`
 * instead, which is why the caller checks `ok` before it reads any of this.
 */
export interface MediaUploadSignature extends BffMutationResult {
	/** The operation answers 502 rather than return without one. */
	galleryItemId: string;
	uploadUrl: string | null;
	uploadHeaders: Record<string, string>;
	signedId: string | null;
}

/**
 * The browser's only door to the server. Every method calls a same-origin
 * `/api/admin/*` route; nothing here has, or could read, an Apex token.
 */
export interface BffClient {
	login(email: string, password: string): Promise<BffMutationResult>;
	logout(): Promise<BffMutationResult>;
	listPages(query?: {
		status?: 'draft' | 'published' | 'all';
		page?: number;
		per_page?: number;
	}): Promise<AdminPage[]>;
	listTemplates(): Promise<AdminTemplateSummary[]>;
	getPage(pageId: string): Promise<AdminPageLoad>;
	readVersion(pageId: string): Promise<{ version: string }>;
	patchEntityFields(
		entityTypeId: string,
		entityId: string,
		fieldsData: Record<string, unknown>
	): Promise<BffMutationResult>;
	savePageStructure(pageId: string, payload: unknown): Promise<BffMutationResult>;
	changePageStatus(pageId: string, statusEvent: AdminStatusEvent): Promise<BffMutationResult>;
	signMediaUpload(payload: unknown): Promise<MediaUploadSignature>;
	finalizeMediaUpload(payload: unknown): Promise<BffMutationResult>;
	/**
	 * Fetch every collection from Apex as this editor and publish the snapshot. NOT an Apex
	 * call. Resolves — never throws — so a deployment that cannot publish comes back
	 * as `{ ok: false, status: 501, error, detail }` and the rail can print `detail`.
	 */
	publishSite(options?: { allowEmpty?: boolean }): Promise<BffMutationResult>;
	/** What the site is serving, and whether publishing is configured. */
	siteStatus(): Promise<SiteStatus>;

	// ── Images (3d) ───────────────────────────────────────────────────────────
	/**
	 * The whole `images` gallery, plus the bring-up gate. `uploadEnabled` is a SERVER
	 * fact (§2.7): byte upload cannot complete against an Apex whose signed upload URL
	 * names a port it does not serve, so the screen disables the control and shows
	 * `uploadDisabledReason` rather than offering an upload that never finishes.
	 * There is no `createImage` for the same reason — an image without bytes is a
	 * caption attached to nothing.
	 */
	listImages(): Promise<{
		images: AdminGalleryItem[];
		galleryId: string;
		uploadEnabled: boolean;
		uploadDisabledReason: string;
	}>;
	updateImage(
		imageId: string,
		fields: { caption?: string; alt?: string }
	): Promise<BffMutationResult>;
	/** No in-use guard exists — nothing in Apex can say what references an image. */
	deleteImage(imageId: string): Promise<BffMutationResult>;
}

/** The 2xx body of `GET /api/admin/site/publish` (`operations/publish-site.ts`). */
export interface SiteStatus {
	/** The manifest of the published snapshot, or null when nothing is published. */
	published: import('../server/content/read').ContentManifest | null;
}

/** What `savePage()` resolves to (`save-page.js`). */
export type SavePageResult =
	| { ok: true; refreshed: boolean }
	| { ok: false; stale?: boolean; stage?: string; status?: number; message: string };
