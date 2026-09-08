<!--
	MediaPickerModal — pick an existing item from a gallery, or upload a new one.

	Keus's version uploaded with a raw Apex token in the browser. This one runs the
	shared `uploadMedia` helper, whose only direct request is the PUT of the bytes to
	the ActiveStorage SIGNED URL — storage, not Apex, and no credential. Everything
	else goes through the same-origin BFF.

	── IT TAKES A GALLERY NAME, NOT AN ID ────────────────────────────────────────
	Gallery ids are ACCOUNT-SCOPED, so a browser holding one is a browser holding a
	value that is wrong on another deployment. The name is resolved server-side from
	`cms_config` on every request. It also removes a whole class of bug this component
	used to have: every mount had to fetch `listImages()` first just to learn an id,
	and GLC's page editor never did — so its picker rendered "No upload destination is
	configured" and could never upload at all.

	`uploadEnabled` is how a caller that DID look says what it found, without the id
	coming back into the browser. Three states, and the default is the permissive one,
	because the bug above was caused by treating "I have not asked" as "it is absent".
	Poovayya's record editor is the only caller that passes it today.

	── NOT IMAGE-ONLY ANY MORE ───────────────────────────────────────────────────
	`accept`, `hasAlt` and the labels come from the gallery's entry in
	`media-types.js`, so the same component serves Files and Videos: a PDF gets a PDF
	chooser and no alt-text field, because alt text on a PDF is a field that means
	nothing. A caller can still override any of them.

	Legacy Svelte mode.
-->
<script>
	import { CAPTION_MAX_LENGTH, galleryMedia, MAX_UPLOAD_LABEL } from '../media-types.js';
	import { uploadMedia } from '../upload-media.js';

	export let open = false;
	/** @type {string} `images` | `files` | `videos` — a NAME, never an id. */
	export let gallery = 'images';
	/** @type {import('../types').BffClient | null} the same-origin BFF client */
	export let client = null;
	/**
	 * Items to BROWSE, when the site has already listed them. Empty means upload
	 * only, which is what a site whose BFF has no media list can offer.
	 * @type {Array<{ id: string, url?: string | null, caption?: string, alt?: string }>}
	 */
	export let images = [];
	/**
	 * Whether this ACCOUNT actually has the gallery, when the caller has read it.
	 *
	 *   `null` (default) — NOT KNOWN. Upload is offered. This is the state every site
	 *     that does not list its gallery is in, and it must stay permissive: see the
	 *     docblock above, where requiring evidence is the bug GLC shipped.
	 *   `true`  — the site listed the gallery and it is there.
	 *   `false` — the site listed the gallery and it is NOT there. Upload is refused
	 *     HERE, with a reason, rather than accepted and failed at finalize after the
	 *     bytes have already been pushed to storage.
	 *
	 * A failed READ is `null`, not `false`: "I could not ask" is not "it is absent",
	 * and an upload resolves its own destination server-side from the gallery NAME
	 * without needing this list at all.
	 * @type {boolean | null}
	 */
	export let uploadEnabled = null;
	/**
	 * What to say when `uploadEnabled` is `false`. A caller that knows more about its
	 * own configuration can say something more useful.
	 * @type {string | null}
	 */
	export let uploadDisabledReason = null;
	/** @type {(galleryItemId: string) => void} */
	export let onSelect = () => {};
	export let onClose = () => {};
	/** Called after a successful upload, so a caller can refresh its list. */
	export let onUploaded = () => {};
	/** Overrides for the gallery's defaults. Null means "use the gallery's own". */
	/** @type {string | null} */
	export let accept = null;
	/** @type {boolean | null} */
	export let hasAlt = null;

	$: media = galleryMedia(gallery);
	$: acceptAttr = accept ?? media?.accept ?? '';
	$: showAlt = hasAlt ?? media?.hasAlt ?? false;
	$: noun = gallery === 'videos' ? 'video' : gallery === 'files' ? 'file' : 'image';

	/** @type {File | null} */
	let file = null;
	let previewUrl = '';
	let title = '';
	let alt = '';
	/** @type {'idle' | 'preparing' | 'uploading' | 'saving'} */
	let phase = 'idle';
	let error = '';

	$: busy = phase !== 'idle';

	/**
	 * ── ONE DIALOG SESSION ────────────────────────────────────────────────────
	 * This component is not remounted between uses: a page form opens it for one
	 * field, closes it, and opens the same instance again for another. `save()`
	 * therefore outlives the dialog it was started from, and until this counter
	 * existed it spoke for whichever dialog happened to be open when it finished.
	 *
	 * Probed: start an upload for field A, press Close, open the picker for field
	 * B, and when A lands it calls the CURRENT `onSelect` — so A's image is filed
	 * in B's field — then resets the state B is using and closes B's dialog.
	 *
	 * The counter advances on every transition of `open`, however it was caused:
	 * the ✕, a tile, a successful upload, or the parent setting the prop itself.
	 * An upload captures it at Save and is only allowed to speak if it still
	 * matches. Closing is deliberately NOT disabled while busy — a 25 MB upload on
	 * a slow link would trap an editor in a dialog they no longer want — so the
	 * invalidation, not a disabled button, is what makes this hold.
	 *
	 * An invalidated upload is not cancelled and cannot be: the bytes are already
	 * on their way and the item is created server-side. It simply stops speaking.
	 * The item is really in the gallery and the caller's next list read shows it.
	 */
	let session = 0;
	let wasOpen = open;
	$: if (open !== wasOpen) {
		wasOpen = open;
		session += 1;
	}

	function reset() {
		file = null;
		title = '';
		alt = '';
		error = '';
		phase = 'idle';
		if (previewUrl) {
			URL.revokeObjectURL(previewUrl);
			previewUrl = '';
		}
	}

	/** @param {Event & { currentTarget: HTMLInputElement }} event */
	function pickFile(event) {
		const chosen = event.currentTarget.files && event.currentTarget.files[0];
		if (!chosen) return;
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		file = chosen;
		error = '';
		previewUrl = chosen.type.startsWith('image/') ? URL.createObjectURL(chosen) : '';
		if (!title) title = chosen.name;
	}

	async function save() {
		// `uploadEnabled === false` is checked HERE too, not only in the markup. The
		// markup hides the form; this refuses the call, so a stale `file` from before
		// the caller learned the gallery was absent cannot still be sent.
		if (!file || !media || !client || busy || uploadEnabled === false) return;
		error = '';
		// The destination is captured HERE, so a `gallery` that changes while the
		// bytes are in flight cannot misfile what is already on its way.
		const destination = gallery;
		// And the SESSION is captured here, so an upload that outlives its dialog
		// cannot select into, reset, or close a later one.
		const mine = session;
		const result = await uploadMedia(client, {
			gallery: destination,
			file,
			title,
			alt: showAlt ? alt : '',
			// Guarded as well: without this a stale upload's progress would put
			// "Uploading…" on a dialog it has nothing to do with, and mark it busy.
			onPhase: (next) => {
				if (mine === session) phase = next;
			}
		});
		if (mine !== session) return;
		phase = 'idle';
		if (!result.ok) {
			error = result.message;
			return;
		}
		onSelect(result.galleryItemId);
		onUploaded(result.galleryItemId);
		close();
	}

	function close() {
		reset();
		open = false;
		onClose();
	}
</script>

{#if open}
	<div class="adm-scrim">
		<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="media-dialog-title">
			<header>
				<h2 id="media-dialog-title">
					{images.length
						? `Choose ${noun === 'image' ? 'an' : 'a'} ${noun}`
						: `Upload ${noun === 'image' ? 'an' : 'a'} ${noun}`}
				</h2>
				<button
					class="btn btn-sm btn-quiet"
					type="button"
					aria-label="Close"
					style="margin-left:auto"
					on:click={close}
				>
					✕
				</button>
			</header>

			<div class="body">
				{#if images.length}
					<!--
						Browse: a site that can list its gallery shows what is already there,
						because uploading a second copy of an image you already have is the
						thing an editor does when a picker only offers Upload.
					-->
					<ul class="media-grid">
						{#each images as image (image.id)}
							<li>
								<button
									class="media-tile"
									type="button"
									title={image.caption || image.alt || image.id}
									on:click={() => {
										onSelect(image.id);
										close();
									}}
								>
									{#if image.url}
										<img src={image.url} alt={image.alt || ''} loading="lazy" />
									{:else}
										<span class="tpl">{image.caption || image.id}</span>
									{/if}
								</button>
							</li>
						{/each}
					</ul>
					<p class="notice">…or upload a new one.</p>
				{/if}
				{#if !media}
					<p class="notice">There is no “{gallery}” library to upload to.</p>
				{:else if uploadEnabled === false}
					<!--
						The caller LOOKED and the gallery is not on this account. Refusing here
						is the whole point: without it the editor fills in a file and a caption,
						presses Save, the bytes go to storage, and finalize is the first thing
						that fails — after the upload, with nothing to show for it.
					-->
					<p class="notice">
						{uploadDisabledReason ??
							`This workspace has no “${gallery}” library yet, so there is nowhere to upload to.`}
					</p>
				{:else}
					<div class="fields">
						<div class="f">
							<label class="label" for="media-file">File</label>
							<input
								id="media-file"
								class="inp mono"
								type="file"
								accept={acceptAttr}
								disabled={busy}
								on:change={pickFile}
							/>
							<p class="hint">{media.label}, up to {MAX_UPLOAD_LABEL}.</p>
						</div>
						{#if previewUrl}
							<img src={previewUrl} alt={title} style="max-width:100%;max-height:220px;" />
						{/if}
						<div class="f">
							<label class="label" for="media-title">Title</label>
							<!-- The server caps both of these at CAPTION_MAX_LENGTH. Without the attribute the
							     cap was reachable by paste, and the refusal arrived AFTER the upload. -->
							<input
								id="media-title"
								class="inp"
								type="text"
								maxlength={CAPTION_MAX_LENGTH}
								bind:value={title}
								disabled={busy}
							/>
						</div>
						{#if showAlt}
							<div class="f">
								<label class="label" for="media-alt">Alt text</label>
								<input
									id="media-alt"
									class="inp"
									type="text"
									maxlength={CAPTION_MAX_LENGTH}
									bind:value={alt}
									disabled={busy}
								/>
							</div>
						{/if}
					</div>
				{/if}

				{#if error}<p class="err" role="alert">{error}</p>{/if}
			</div>

			<div class="foot">
				<button type="button" class="btn" on:click={close} disabled={busy}>Cancel</button>
				<button
					type="button"
					class="btn btn-primary"
					disabled={!file || !media || busy || uploadEnabled === false}
					on:click={save}
				>
					<!--
						Three words, not two: hashing 25 MiB on the main thread takes about
						half a second before a single byte is sent, and a button that says
						"Uploading…" while nothing is uploading is a small lie the editor
						can see through when the network panel is empty.
					-->
					{phase === 'preparing'
						? 'Preparing…'
						: phase === 'uploading'
							? 'Uploading…'
							: phase === 'saving'
								? 'Saving…'
								: `Save ${noun}`}
				</button>
			</div>
		</div>
	</div>
{/if}
