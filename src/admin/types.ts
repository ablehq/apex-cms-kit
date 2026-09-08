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
 * The value a `rich_text` field stores, as Apex's validator and the public renderer
 * both read it (`rich-text.js`).
 *
 * `editor` is nullable ON THE INPUT SIDE and only there: every Poovayya archetype
 * primitive is stored with `editor: null` (measured across all twelve `team_member`
 * records), so a type that insists on a string describes a shape two of the three
 * sites do not hold. What `plainToRichText` RETURNS always names an editor — the
 * stored one, or the site's `defaultEditor`.
 *
 * `content` is a Quill delta (`{ops: […]}`) when `editor` is `quilljs` and a
 * ProseMirror document (`{}` when empty) when it is `tiptap`. The two are not
 * interchangeable; `rich-text.js` branches rather than guessing.
 */
export interface RichTextValue {
	editor: string | null;
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
	/** GLC's page-block templates carry one; a content-library field def does not. */
	role?: string | null;
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

/** One word of the account's tag vocabulary, as `TagPicker.svelte` lists it. */
export interface AdminTag {
	id: string;
	name: string;
}

/**
 * One item of an asset-library gallery.
 *
 * `url` was withheld while no bytes could be attached: `medium` and `thumbnail` are
 * `has_one … as: :record` associations that are simply MISSING from the read until
 * something is attached, so their shape had never been observed and declaring a field
 * on a guess would have been one that silently stayed empty forever. Uploads are now
 * proved end to end against real Apex for all three galleries, and
 * `summarizeGalleryImage` has been composing this URL from `medium.file.key` all
 * along — so the type now declares what the rows have been carrying. Without it,
 * `npm run check` refuses a screen that reads it.
 *
 * `null` is a real answer, not an error, in three cases: the item has no bytes yet,
 * the deployment has no assets prefix, or the gallery is `files`/`videos`, where a
 * Cloudflare IMAGE transform is meaningless.
 */
export interface AdminGalleryItem {
	id: string;
	galleryId: string;
	caption: string;
	alt: string;
	position: number;
	/** ISO 8601, from Apex. The Images list sorts newest-first on it. */
	createdAt: string;
	/** A thumbnail to draw, when one can be composed. See above for the three nulls. */
	url: string | null;
	/**
	 * The stored file's type and size — `''` and `0` when nothing is attached. A
	 * thumbnail exists for images alone, so for a file or a video these two are the
	 * only evidence a row can show that the bytes landed. Apex returns no filename.
	 */
	contentType: string;
	byteSize: number;
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
	| {
			ok: false;
			stale?: boolean;
			stage?: string;
			status?: number;
			/**
			 * The operation's own refusal code, when it has one — `unbacked-record`,
			 * `child-list-write-failed`. Named rather than left to the index signature
			 * so a screen that branches on it is type-checked, and so the two refusals
			 * whose default message is a LIE are visible in the type.
			 */
			code?: string;
			/**
			 * False only for a refusal a retry can never fix (`unbacked-record`: the
			 * refusal is a property of the record, not of the request). A screen can
			 * hide its "Save again" affordance rather than offering a dead end.
			 */
			retryable?: boolean;
			message: string;
	  };

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

/** The four scalars the signed-upload leg takes, at the TOP level of the body. */
export interface MediaUploadFile {
	byte_size: number;
	content_type: string;
	filename: string;
	checksum: string;
}

/**
 * The body of `POST /api/admin/media/uploads`. The gallery is a NAME — the ids are
 * account-scoped, so the server resolves them from `cms_config` per request and no
 * browser is ever trusted with one.
 */
export interface MediaUploadRequest {
	gallery: string;
	file: MediaUploadFile;
}

/**
 * The 2xx body of `POST /api/admin/media/uploads` (`operations/media.ts`): the
 * ActiveStorage direct-upload signature the browser PUTs the bytes to. A failure comes
 * back as `{ ok: false, status, error }` instead, which is why the caller checks `ok`
 * before it reads any of this.
 *
 * There is deliberately NO `galleryItemId` here: signing creates nothing upstream. The
 * gallery item is created at finalize, after the bytes exist, so no failure on this
 * path can leave an item behind.
 */
export interface MediaUploadSignature extends BffMutationResult {
	uploadUrl: string | null;
	uploadHeaders: Record<string, string>;
	signedId: string | null;
}

/**
 * The body of `POST /api/admin/media`. The caption and alt travel HERE rather than
 * with the signature, because this is the leg that creates the item.
 */
export interface MediaFinalizeRequest {
	gallery: string;
	signedId: string;
	title?: string;
	alt?: string;
}

/** The 2xx body of `POST /api/admin/media`: the item this leg created, and its medium. */
export interface MediaFinalizeResult extends BffMutationResult {
	galleryItemId: string | null;
	mediumId: string | null;
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
	/** `{ ok, page, version }` on 201; `409 slug-taken` and `400 reserved-slug` are the refusals. */
	createPage(payload: {
		title: string;
		slug: string;
		summary?: string;
	}): Promise<BffMutationResult>;
	readVersion(pageId: string): Promise<{ version: string }>;
	patchEntityFields(
		entityTypeId: string,
		entityId: string,
		fieldsData: Record<string, unknown>
	): Promise<BffMutationResult>;
	savePageStructure(pageId: string, payload: unknown): Promise<BffMutationResult>;
	changePageStatus(pageId: string, statusEvent: AdminStatusEvent): Promise<BffMutationResult>;
	/**
	 * Named payloads, not `unknown`: the bodies changed shape when the item moved to
	 * the finalize leg, and a caller still sending `{ galleryId, title, alt, file }`
	 * should be a compile error rather than a 400 discovered at runtime.
	 */
	signMediaUpload(payload: MediaUploadRequest): Promise<MediaUploadSignature>;
	finalizeMediaUpload(payload: MediaFinalizeRequest): Promise<MediaFinalizeResult>;
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
	 * The whole `images` gallery. There is no `createImage`: an image is created by
	 * uploading bytes, and an image without bytes is a caption attached to nothing.
	 * Whether a site offers an upload control is that site's own policy.
	 */
	listImages(): Promise<{ images: AdminGalleryItem[]; galleryId: string }>;
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
