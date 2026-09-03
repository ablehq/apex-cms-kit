<!--
	One section's fields, in the prototype's idiom: a small caps label over a ruled
	line, never a box; the serif for anything a human wrote and the mono for anything
	a machine reads (anchors, hrefs, keys, ids); rich text in its bordered well; and
	media as a thumbnail with Replace / Remove beside it.

	The field list and each field's control come from the COMMITTED template contract
	(template-contract.js), so what is drawn cannot drift from what Apex validates.
	Every control calls `onChange(fieldName, value)`, which mutates the local draft
	(page-draft.setField) and marks that entity dirty; nothing here touches the
	network. When `editable` is false — a block whose real id has not been minted yet
	— the fields are replaced by a "save first" notice, so a field can never be
	edited before its entity exists server-side (the temp-id rule).

	Legacy Svelte mode.
-->
<script>
	import RichTextField from './RichTextField.svelte';

	/** @type {import('../types').AdminFieldDef[]} */
	export let fieldDefs = [];
	/** @type {Record<string, unknown>} */
	export let fieldsData = {};
	export let editable = true;
	/** @type {(name: string, value: unknown) => void} */
	export let onChange = () => {};
	/** @type {((name: string) => void) | null} */
	export let onPickMedia = null;

	// Which plain-text fields are machine-facing, and so set in the mono face. The
	// prototype's rule, applied by name because that is what the contract gives us.
	const MACHINE = /(^|_)(anchor_id|href|url|key|slug|id|refs|count)$/u;

	/**
	 * Apex's spelling for "clear this field", not ours: `PropertySetFormHelper`
	 * merges a PATCH's `fields_data` into the stored property set and drops every
	 * NIL attribute as "not supplied", so `null` is a silent no-op — Apex answers
	 * 200 and keeps the old row. Only `"__delete__"` removes a row of any kind.
	 *
	 * The ports clear media with `''`, which is right for THEIR field: on Apex's
	 * `media` kind a blank counts as an explicit clear. GLC's one media field is
	 * `ref/model/Cms::GalleryItem`, a REFERENCE, and there `''` is validated like
	 * any other id — measured against local Apex on 2026-08-31: `null` → 200 and
	 * the logo survives, `''` → 422 "Logo does not exist in model
	 * Cms::GalleryItem", `"__delete__"` → 200 and the key is gone.
	 */
	const DELETE_MARKER = '__delete__';

	/**
	 * One field's stored value. `fields_data` is Apex-validated JSON, so what a key
	 * holds depends on the field's validator kind; each control below narrows it.
	 * @param {string} name
	 * @returns {unknown}
	 */
	function valueOf(name) {
		return fieldsData ? fieldsData[name] : undefined;
	}

	/**
	 * The gallery-item id a media field is CURRENTLY showing. A pending Remove sits
	 * in the draft as the delete marker until the save round-trips, and that marker
	 * is a protocol token, not an id — so the frame reads it as empty and offers
	 * Upload again rather than printing `__delete__` where the filename goes.
	 * @param {string} name
	 * @returns {string}
	 */
	function mediaIdOf(name) {
		const value = valueOf(name);
		return typeof value === 'string' && value !== DELETE_MARKER ? value : '';
	}

	/** @param {string} name */
	function isMachine(name) {
		return MACHINE.test(name);
	}

	/**
	 * @param {unknown} value
	 * @returns {string}
	 */
	function textArrayToString(value) {
		return Array.isArray(value) ? value.join(', ') : `${value ?? ''}`;
	}

	/**
	 * @param {unknown} value
	 * @returns {string[]}
	 */
	function stringToTextArray(value) {
		return `${value ?? ''}`
			.split(',')
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}
</script>

{#if !editable}
	<p class="notice">Save the page once to create this section, then its fields become editable.</p>
{:else if fieldDefs.length === 0}
	<p class="notice">This section has no editable fields.</p>
{:else}
	<div class="fields">
		{#each fieldDefs as def (def.field_name)}
			<div class="f">
				{#if def.validator_kind === 'boolean'}
					<label class="bool">
						<input
							type="checkbox"
							checked={Boolean(valueOf(def.field_name))}
							on:change={(event) => onChange(def.field_name, event.currentTarget.checked)}
						/>
						{def.display_name}
					</label>
				{:else}
					<span class="label" id="lbl-{def.field_name}">{def.display_name}</span>

					{#if Array.isArray(def.text_inclusion) && def.text_inclusion.length && def.validator_kind !== 'text_array'}
						<select
							class="inp"
							aria-labelledby="lbl-{def.field_name}"
							value={valueOf(def.field_name) ?? ''}
							on:change={(event) => onChange(def.field_name, event.currentTarget.value)}
						>
							{#each def.text_inclusion as option (option)}
								<option value={option}>{option}</option>
							{/each}
						</select>
					{:else if def.validator_kind === 'rich_text'}
						<RichTextField
							value={valueOf(def.field_name)}
							ariaLabel={def.display_name}
							onChange={(next) => onChange(def.field_name, next)}
						/>
					{:else if def.validator_kind === 'text_array'}
						<input
							class="inp mono"
							type="text"
							aria-labelledby="lbl-{def.field_name}"
							value={textArrayToString(valueOf(def.field_name))}
							on:input={(event) =>
								onChange(def.field_name, stringToTextArray(event.currentTarget.value))}
						/>
						<p class="notice">Separate each value with a comma.</p>
					{:else if def.validator_kind === 'multiline_text'}
						<!--
							A textarea's value is a string, and `fields_data` holds whatever Apex
							validated for this field, so the coercion is spelled out rather than left
							to the DOM.
						-->
						<textarea
							class="inp"
							rows="3"
							aria-labelledby="lbl-{def.field_name}"
							value={`${valueOf(def.field_name) ?? ''}`}
							on:input={(event) => onChange(def.field_name, event.currentTarget.value)}
						></textarea>
					{:else if def.validator_kind === 'ref/model/Cms::GalleryItem'}
						<!--
							CAPABILITY GAP — the thumbnail. The value is a gallery-item id and the
							BFF has no media READ operation, so there is no URL to show a picture
							from. The prototype's frame and its Replace / Remove are here, with the
							id in mono where the filename would be. Uploading a NEW image is real
							and goes through the BFF.
						-->
						<div class="media">
							<span class="thumb" aria-hidden="true">
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25">
									<rect x="3" y="4" width="18" height="16" rx="2" />
									<circle cx="8.5" cy="9.5" r="1.6" />
									<path d="M3 16.5l5-4 4 3 3-2.5 6 5" />
								</svg>
							</span>
							<div>
								<div class="tpl">{mediaIdOf(def.field_name) || 'No image yet'}</div>
								<div style="display:flex;gap:.35rem;margin-top:.4rem">
									<button
										class="btn btn-sm"
										type="button"
										on:click={() => onPickMedia && onPickMedia(def.field_name)}
										disabled={!onPickMedia}
									>
										{mediaIdOf(def.field_name) ? 'Replace' : 'Upload'}
									</button>
									<button
										class="btn btn-sm btn-quiet danger"
										type="button"
										disabled={!mediaIdOf(def.field_name)}
										on:click={() => onChange(def.field_name, DELETE_MARKER)}
									>
										Remove
									</button>
								</div>
							</div>
						</div>
					{:else}
						<input
							class="inp {isMachine(def.field_name) ? 'mono' : ''}"
							type="text"
							aria-labelledby="lbl-{def.field_name}"
							spellcheck={!isMachine(def.field_name)}
							value={valueOf(def.field_name) ?? ''}
							on:input={(event) => onChange(def.field_name, event.currentTarget.value)}
						/>
					{/if}
				{/if}
			</div>
		{/each}
	</div>
{/if}
