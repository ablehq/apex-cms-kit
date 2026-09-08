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
	/** Every control read-only while a save is in flight. */
	export let disabled = false;
	/**
	 * Resolve a gallery-item id to a thumbnail URL, when the site can. Returning
	 * `null` (the default) draws the placeholder frame and the id, which is the
	 * honest answer for a site whose BFF has no media read.
	 * @type {(id: string) => string | null}
	 */
	export let mediaUrl = () => null;
	// DECLARED BEFORE the prop that defaults to it. A `const` in a Svelte <script> is
	// in its temporal dead zone until its own line runs, and the default initializer
	// below runs when a parent OMITS the prop — which, since the P5 fix pass, ALL
	// THREE SITES do. With the const further down the file this threw `Cannot access
	// 'DELETE_MARKER' before initialization` and took out the whole block field
	// editor. It used to be reachable only from GLC, because Godrej and Poovayya
	// passed `emptyValue` explicitly; now every mount runs this line.
	/**
	 * Apex's spelling for "clear this field", not ours: `PropertySetFormHelper`
	 * merges a PATCH's `fields_data` into the stored property set and drops every
	 * NIL attribute as "not supplied", so `null` is a silent no-op — Apex answers
	 * 200 and keeps the old row. Only `"__delete__"` removes a row of any kind.
	 *
	 * `emptyValue` reaches EXACTLY ONE call site: the Remove button inside the
	 * `ref/model/Cms::GalleryItem` branch below. So the only field kind it can ever
	 * be sent on is a REFERENCE, and there `''` is validated like any other id and
	 * fails. Measured against local Apex on THREE surfaces, all three sites' own:
	 *
	 *   GLC `pages.logo`, record route (2026-08-31)  `null` → 200, the logo
	 *     survives · `''` → 422 "Logo does not exist in model Cms::GalleryItem" ·
	 *     `"__delete__"` → 200 and the key is gone.
	 *   Poovayya `practice_area.image` and Godrej `team_member.image`, record route
	 *     (2026-09-08)  `''` → 422 and THE OLD ID SURVIVES · `"__delete__"` → 200,
	 *     the key is removed from `primitives` and the archetype ITEM ROW SURVIVES
	 *     with `fields_data: {}`.
	 *   An `image-block` entity's `image`, entities endpoint (2026-09-08)  `''` →
	 *     422 "Image does not exist in model Cms::GalleryItem" and the old id
	 *     survives · `"__delete__"` → 200 and `fields_data` is `{}`.
	 *
	 * An earlier version of this block said a site whose fields are archetype
	 * primitives should pass `''`, and that the marker "destroys the item row and
	 * strands the old value in `archetype.primitives`". Both of those were inherited,
	 * not measured, and the third and second lines above are what actually happens:
	 * the marker removes the KEY and keeps the row. Poovayya and Godrej both passed
	 * `''` on that reasoning, which made Remove a 422 on every media field on both
	 * sites; the P5 fix pass dropped it from both.
	 */
	const DELETE_MARKER = '__delete__';

	/**
	 * What Remove emits on a media field. Apex's delete marker by default — the one
	 * spelling that clears a value rather than being merged away as "no change".
	 *
	 * NO SITE OVERRIDES THIS, and after the measurements above none should: the prop
	 * only ever reaches a `ref/model/…` field, and on every such field on every
	 * tenant `''` is a 422. It stays a prop rather than a constant because Apex has a
	 * `media` field kind too, on which a blank IS an explicit clear — no schema on
	 * these three sites declares one, and a site that does can say so here rather
	 * than fork the component.
	 * @type {string}
	 */
	export let emptyValue = DELETE_MARKER;
	/**
	 * Forwarded to every `RichTextField` below: the editor name written into a
	 * rich-text value that has NONE (a Poovayya archetype primitive is stored
	 * `editor: null`). A stored non-empty name always wins over it.
	 *
	 * Per SITE. GLC's page fields are tiptap — which is this default, so GLC needs no
	 * change — while Godrej's and Poovayya's stored values are quilljs with populated
	 * Quill deltas, and both pass `defaultEditor="quilljs"`.
	 * @type {string}
	 */
	export let defaultEditor = 'tiptap';
	/**
	 * Optional per-field help, by field name — for fields whose NAME does not say
	 * what they are for.
	 * @type {Record<string, string>}
	 */
	export let hints = {};
	/** @type {(name: string, value: unknown) => void} */
	export let onChange = () => {};
	/** @type {((name: string) => void) | null} */
	export let onPickMedia = null;

	// Which plain-text fields are machine-facing, and so set in the mono face. The
	// prototype's rule, applied by name because that is what the contract gives us.
	const MACHINE = /(^|_)(anchor_id|href|url|key|slug|id|refs|count)$/u;

	/**
	 * ONE FIELD'S CURRENT VALUE — and it takes the BAG AS AN ARGUMENT, deliberately.
	 *
	 * `fields_data` is Apex-validated JSON, so what a key holds depends on the field's
	 * validator kind; each control below narrows it.
	 *
	 * It used to close over `fieldsData` and take only the name. Svelte's legacy
	 * compiler works out a template expression's dependencies from the identifiers IN
	 * THE EXPRESSION, so `{valueOf(def.field_name)}` depended on `def` and on nothing
	 * else: a `fieldsData` that CHANGED never re-rendered anything here. The typed-in
	 * case hid it — the DOM already holds what was typed — but the case where the
	 * value changes from OUTSIDE the control did not:
	 *
	 *   MEASURED IN REAL CHROME (Fable FF2, 2026-09-08): pick an image in the media
	 *   dialog and the frame still reads "No image yet" until the page is reloaded,
	 *   while Save persists the id perfectly. It looks like the picker did nothing.
	 *
	 * Passing `fieldsData` at every call site puts it in the expression, which is what
	 * makes the template depend on it. Same for `mediaIdOf`.
	 * @param {Record<string, unknown>} data
	 * @param {string} name
	 */
	function valueOf(data, name) {
		return data ? data[name] : undefined;
	}

	/**
	 * The gallery-item id a media field is CURRENTLY showing. A pending Remove sits
	 * in the draft as the delete marker until the save round-trips, and that marker
	 * is a protocol token, not an id — so the frame reads it as empty and offers
	 * Upload again rather than printing `__delete__` where the filename goes.
	 * @param {Record<string, unknown>} data
	 * @param {string} name
	 * @returns {string}
	 */
	function mediaIdOf(data, name) {
		const value = valueOf(data, name);
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
							checked={Boolean(valueOf(fieldsData, def.field_name))}
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
							value={valueOf(fieldsData, def.field_name) ?? ''}
							on:change={(event) => onChange(def.field_name, event.currentTarget.value)}
						>
							{#each def.text_inclusion as option (option)}
								<option value={option}>{option}</option>
							{/each}
						</select>
					{:else if def.validator_kind === 'rich_text'}
						<RichTextField
							value={valueOf(fieldsData, def.field_name)}
							ariaLabel={def.display_name}
							{defaultEditor}
							onChange={(next) => onChange(def.field_name, next)}
						/>
					{:else if def.validator_kind === 'text_array'}
						<input
							class="inp mono"
							type="text"
							aria-labelledby="lbl-{def.field_name}"
							value={textArrayToString(valueOf(fieldsData, def.field_name))}
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
							value={`${valueOf(fieldsData, def.field_name) ?? ''}`}
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
							{#if mediaIdOf(fieldsData, def.field_name) && mediaUrl(mediaIdOf(fieldsData, def.field_name))}
								<img
									class="thumb"
									src={mediaUrl(mediaIdOf(fieldsData, def.field_name))}
									alt=""
									aria-hidden="true"
								/>
							{:else}
								<span class="thumb" aria-hidden="true">
									<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25">
										<rect x="3" y="4" width="18" height="16" rx="2" />
										<circle cx="8.5" cy="9.5" r="1.6" />
										<path d="M3 16.5l5-4 4 3 3-2.5 6 5" />
									</svg>
								</span>
							{/if}
							<div>
								<div class="tpl">{mediaIdOf(fieldsData, def.field_name) || 'No image yet'}</div>
								<div style="display:flex;gap:.35rem;margin-top:.4rem">
									<button
										class="btn btn-sm"
										type="button"
										on:click={() => onPickMedia && onPickMedia(def.field_name)}
										disabled={disabled || !onPickMedia}
									>
										{mediaIdOf(fieldsData, def.field_name) ? 'Replace' : 'Upload'}
									</button>
									<button
										class="btn btn-sm btn-quiet danger"
										type="button"
										disabled={disabled || !mediaIdOf(fieldsData, def.field_name)}
										on:click={() => onChange(def.field_name, emptyValue)}
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
							value={valueOf(fieldsData, def.field_name) ?? ''}
							on:input={(event) => onChange(def.field_name, event.currentTarget.value)}
						/>
					{/if}
				{/if}
			</div>
		{/each}
	</div>
{/if}
