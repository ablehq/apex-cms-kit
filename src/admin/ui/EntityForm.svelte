<!--
	The prototype's `#tab-details` field block (lines 1125–1147), driven by a field
	descriptor list instead of being written out three times.

	It is the whole of an Authors or a Resources editor — the prototype draws no
	editor for either, and its own `#tab-details` is already a standalone full-canvas
	form, so using it unchanged is the most literal reading available. It is also an
	Article's Details tab and its SEO tab, which are the same markup with different
	labels. One component, because the alternative is four copies of a `.fields`
	block that drift.

	The kinds are exactly the prototype's `fieldHTML()` set (lines 1747–1766) and 3d
	introduces no sixth one: `text`, `mono` (slug / url / date), `multiline`. `.two`
	is the prototype's side-by-side pairing — Title/Slug, and a Resource's Type/URL —
	and it is expressed as `pair: true` on consecutive descriptors rather than as
	nesting, so a descriptor list stays a flat list.

	Two deliberate departures from the prototype's markup, both already made by
	`PageForm.svelte` and both about the form being real rather than a mock:

	  * real `<input>` / `<textarea>` elements, not `contenteditable` divs. The
	    prototype uses `contenteditable` because it has nothing to submit; a real
	    editor needs a value, an `input` event and a label that focuses its control.
	  * a `<label for>` rather than a `<span class="label">`, so the label is
	    attached to the field for a screen reader and for a click.

	Values are strings and are handed back as strings. A field cleared to `''` is a
	CLEAR; there is no code path here that can produce `null`, which upstream would
	destroy the field's row and leave the old text stranded where the public site
	reads it.

	Legacy Svelte mode.
-->
<script>
	/**
	 * @typedef {import('../types').AdminFieldDescriptor} AdminFieldDescriptor
	 */

	/** @type {AdminFieldDescriptor[]} */
	export let fields = [];
	/** @type {Record<string, string>} name → current value. */
	export let values = {};
	export let heading = 'Details';
	export let hint = '';
	/** Set while a save is in flight, so a field cannot be edited mid-write. */
	export let disabled = false;
	/**
	 * Called on every keystroke with the field name and its new value. The caller
	 * writes it into its own draft — this component holds no state of its own, which
	 * is what keeps the one dirty-flag in the draft rather than split across two
	 * places that can disagree.
	 *
	 * @type {(name: string, value: string) => void}
	 */
	export let onChange = () => {};
	/** Distinguishes this form's input ids from another form's on the same screen. */
	export let idPrefix = 'entity';

	/**
	 * Group consecutive `pair: true` descriptors into rows. Two per row, because
	 * `.two` is `repeat(auto-fit, minmax(220px, 1fr))` and a third field would wrap
	 * to a second line looking like a mistake.
	 *
	 * Every row is rendered inside a `.two`, including single-field ones. That is not
	 * sloppiness and it is not a layout difference: `auto-fit` collapses the empty
	 * tracks and `1fr` gives the survivor the free space, so one `.f` inside `.two`
	 * occupies exactly the width it would have as a bare grid item of `.fields`. The
	 * alternative is the same twenty lines of input markup written twice, which is
	 * how two "identical" fields end up subtly different a year later.
	 *
	 * @param {AdminFieldDescriptor[]} list
	 */
	function toRows(list) {
		const rows = [];
		let pending = null;
		for (const field of list) {
			if (field.pair) {
				if (pending) {
					pending.push(field);
					rows.push(pending);
					pending = null;
				} else {
					pending = [field];
				}
				continue;
			}
			if (pending) {
				rows.push(pending);
				pending = null;
			}
			rows.push([field]);
		}
		if (pending) rows.push(pending);
		return rows;
	}

	/** @param {AdminFieldDescriptor} field */
	function inputClass(field) {
		return field.kind === 'mono' ? 'inp mono' : 'inp';
	}

	/** @param {AdminFieldDescriptor} field */
	function valueOf(field) {
		const value = values ? values[field.name] : '';
		return typeof value === 'string' ? value : '';
	}

	$: rows = toRows(Array.isArray(fields) ? fields : []);
</script>

<div class="canvas-head"><h2>{heading}</h2></div>
{#if hint}<p class="hint">{hint}</p>{/if}

<div class="fields">
	{#each rows as row, rowIndex (rowIndex)}
		<div class="two">
			{#each row as field (field.name)}
				<div class="f">
					<label class="label" for="{idPrefix}-{field.name}">{field.label}</label>
					{#if field.kind === 'multiline'}
						<textarea
							id="{idPrefix}-{field.name}"
							class={inputClass(field)}
							rows={field.rows ?? 3}
							{disabled}
							placeholder={field.placeholder ?? ''}
							value={valueOf(field)}
							on:input={(event) => onChange(field.name, event.currentTarget.value)}
						></textarea>
					{:else}
						<input
							id="{idPrefix}-{field.name}"
							class={inputClass(field)}
							type="text"
							spellcheck={field.kind === 'mono' ? 'false' : 'true'}
							{disabled}
							placeholder={field.placeholder ?? ''}
							value={valueOf(field)}
							on:input={(event) => onChange(field.name, event.currentTarget.value)}
						/>
					{/if}
					{#if field.hint}<p class="hint">{field.hint}</p>{/if}
				</div>
			{/each}
		</div>
	{/each}
</div>
