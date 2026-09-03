<!--
	MediaPickerModal — restyled into the prototype's dialog idiom, behaviour
	unchanged. Upload-only: browse-and-reuse needs a media READ operation the BFF
	does not have (02 §5 puts it in phase 5), which is also why the Images screen in
	the rail says it is not built.

	Keus's version uploaded with a raw Apex token in the browser; this one goes only
	through the same-origin BFF media ops (bff-client.signMediaUpload /
	finalizeMediaUpload). The one direct browser request is the PUT of the file bytes
	to the ActiveStorage SIGNED URL — storage, not Apex, no credential. The
	content-MD5 checksum is computed locally (md5.js), so no spark-md5 dependency.

	`galleryId` is passed in (its source — the workspace asset library — is wired at
	bring-up). With none, the modal says so rather than silently failing.

	Legacy Svelte mode.
-->
<script>
	import { md5Base64 } from '../md5.js';

	export let open = false;
	export let galleryId = '';
	/** @type {import('../types').BffClient | null} the same-origin BFF client */
	export let client = null;
	/** @type {(galleryItemId: string) => void} */
	export let onSelect = () => {};
	export let onClose = () => {};

	/** @type {File | null} */
	let file = null;
	let previewUrl = '';
	let title = '';
	let alt = '';
	let uploading = false;
	let error = '';

	function reset() {
		file = null;
		title = '';
		alt = '';
		error = '';
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
		previewUrl = chosen.type.startsWith('image/') ? URL.createObjectURL(chosen) : '';
		if (!title) title = chosen.name;
	}

	async function save() {
		if (!file || !galleryId || !client) return;
		uploading = true;
		error = '';
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const signed = await client.signMediaUpload({
				galleryId,
				title,
				alt,
				file: {
					byte_size: file.size,
					content_type: file.type,
					filename: file.name,
					checksum: md5Base64(bytes)
				}
			});
			if (!signed.ok || !signed.uploadUrl || !signed.signedId) {
				error = 'Could not start the upload. Try again.';
				return;
			}
			const put = await fetch(signed.uploadUrl, {
				method: 'PUT',
				headers: signed.uploadHeaders || {},
				body: file
			});
			if (!put.ok) {
				error = 'The file could not be stored. Try again.';
				return;
			}
			const finalized = await client.finalizeMediaUpload({
				galleryItemId: signed.galleryItemId,
				signedId: signed.signedId,
				contentType: file.type
			});
			if (!finalized.ok) {
				error = 'The upload did not finish. Try again.';
				return;
			}
			onSelect(signed.galleryItemId);
			close();
		} catch {
			error = 'The upload failed. Try again.';
		} finally {
			uploading = false;
		}
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
				<h2 id="media-dialog-title">Upload an image</h2>
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
				{#if !galleryId}
					<p class="notice">No upload destination is configured for this workspace yet.</p>
				{:else}
					<div class="fields">
						<div class="f">
							<label class="label" for="media-file">File</label>
							<input
								id="media-file"
								class="inp mono"
								type="file"
								accept="image/*"
								on:change={pickFile}
							/>
						</div>
						{#if previewUrl}
							<img src={previewUrl} alt={title} style="max-width:100%;max-height:220px;" />
						{/if}
						<div class="f">
							<label class="label" for="media-title">Title</label>
							<input id="media-title" class="inp" type="text" bind:value={title} />
						</div>
						<div class="f">
							<label class="label" for="media-alt">Alt text</label>
							<input id="media-alt" class="inp" type="text" bind:value={alt} />
						</div>
					</div>
				{/if}

				{#if error}<p class="err" role="alert">{error}</p>{/if}
			</div>

			<div class="foot">
				<button type="button" class="btn" on:click={close}>Cancel</button>
				<button
					type="button"
					class="btn btn-primary"
					disabled={!file || !galleryId || uploading}
					on:click={save}
				>
					{uploading ? 'Uploading…' : 'Save image'}
				</button>
			</div>
		</div>
	</div>
{/if}
