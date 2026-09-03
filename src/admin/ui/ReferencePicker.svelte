<!--
	The reference picker — the prototype's one dialog pattern (heading, search,
	close, then a searchable body of choices), pointed at a collection of records.
	Ported from `gospel-life-church/src/lib/admin/ui/ReferencePicker.svelte`.

	It is deliberately the same shape as the media picker, down to the `.card`
	markup, because the prototype defines one dialog and this admin should not grow a
	second dialog vocabulary. What differs is the source: the cards here are RECORDS
	the account holds, handed in by the screen that already loaded them.

	Why the name is a prop rather than something this component fetches: Apex does
	not inline a referenced record's display name — a reference arrives as an id with
	`relatable_data: []` — so names are resolved by joining against the collection,
	and the screen showing the picker has already loaded it for its own list. One
	read, not two, and no way for the two to disagree.

	── THE ONE DEVIATION THIS PLAN MAKES (§5.0, deviation 1) ─────────────────────
	GLC's picker is SINGLE-select: one `selectedId`, a one-id callback, used only as
	the article author picker. Godrej's `partner.focus_area` is `has_many`, and so
	are both post types' `focus_area` and `partner`. That is an ARITY change to this
	component, not a new component: the same `.card` grid, the same dialog markup,
	with a SET instead of an id.

	`multiple` switches it. In multi mode a card TOGGLES and the dialog stays open —
	choosing three focus areas should not mean opening the dialog three times — and
	the clear card means "select none" rather than "no author". In single mode the
	behaviour is GLC's exactly: pick, and the dialog closes.

	CLEAR IS A FIRST-CLASS CHOICE, not an omission. "No author" is a real state of a
	post, and clearing the reference is the only way to say it, so it is a card in
	the same grid rather than a subtlety hidden behind an empty search.
-->
<script>
	/**
	 * @typedef {{ id: string, name: string, hint?: string }} ReferenceChoice
	 */

	export let open = false;
	/** @type {ReferenceChoice[]} the collection to choose from, already loaded. */
	export let items = [];
	/** Single-select: the id currently referenced. @type {string | null} */
	export let selectedId = null;
	/** Multi-select: the ids currently referenced. @type {string[]} */
	export let selectedIds = [];
	/** Whether this is a `has_many` relation. */
	export let multiple = false;
	export let title = 'Choose a record';
	export let searchPlaceholder = 'Search';
	/** The card that clears the reference. Empty string hides it. */
	export let clearLabel = 'None';
	export let clearHint = 'Leave this unset.';
	/** Shown when the collection itself is empty — genuinely empty, not broken. */
	export let emptyMessage = 'There is nothing to choose from yet.';
	/** Single-select. `null` clears. @type {(id: string | null) => void} */
	export let onPick = () => {};
	/** Multi-select. The FULL desired set. @type {(ids: string[]) => void} */
	export let onPickMany = () => {};
	export let onClose = () => {};

	let query = '';
	/** The search box, from `bind:this` — only read after mount. @type {HTMLInputElement} */
	let searchEl;

	/**
	 * @param {ReferenceChoice} item
	 * @param {string} needle
	 */
	function matches(item, needle) {
		if (!needle) return true;
		return `${item.name} ${item.hint ?? ''}`.toLowerCase().includes(needle);
	}

	$: needle = query.trim().toLowerCase();
	$: choices = (Array.isArray(items) ? items : []).filter((item) => matches(item, needle));
	$: chosen = new Set(multiple ? (selectedIds ?? []) : selectedId ? [selectedId] : []);
	$: if (open && searchEl) searchEl.focus();

	function close() {
		query = '';
		onClose();
	}

	/** @param {string} id */
	function toggle(id) {
		// The FULL desired set travels, never a diff: the browser knows what the
		// editor selected and nothing else. The server diffs it against a fresh read,
		// which is the only place the join-row ids a removal needs actually exist.
		const next = new Set(selectedIds ?? []);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		onPickMany([...next]);
	}

	/** @param {string | null} id */
	function pick(id) {
		if (multiple) {
			if (id === null) onPickMany([]);
			else toggle(id);
			return;
		}
		query = '';
		onPick(id);
	}

	/** @param {KeyboardEvent} event */
	function onKeydown(event) {
		if (event.key === 'Escape') close();
	}

	/** @param {MouseEvent} event */
	function onScrimClick(event) {
		if (event.target === event.currentTarget) close();
	}
</script>

<svelte:window on:keydown={onKeydown} />

{#if open}
	<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
	<div class="adm-scrim" on:click={onScrimClick}>
		<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="reference-picker-title">
			<header>
				<h2 id="reference-picker-title">{title}</h2>
				<input
					class="search"
					type="search"
					placeholder={searchPlaceholder}
					aria-label={searchPlaceholder}
					style="margin-left:auto"
					bind:this={searchEl}
					bind:value={query}
				/>
				<button class="btn btn-sm btn-quiet" type="button" aria-label="Close" on:click={close}>
					✕
				</button>
			</header>

			<div class="body">
				<div class="cards">
					{#if clearLabel}
						<button
							class="card"
							type="button"
							aria-current={chosen.size === 0 ? 'true' : undefined}
							on:click={() => pick(null)}
						>
							<b>{clearLabel}</b>
							<small>{clearHint}</small>
							<em>{chosen.size === 0 ? 'current' : ''}</em>
						</button>
					{/if}
					{#each choices as item (item.id)}
						<button
							class="card"
							type="button"
							aria-current={chosen.has(item.id) ? 'true' : undefined}
							on:click={() => pick(item.id)}
						>
							<b>{item.name || '(unnamed)'}</b>
							<small>{item.hint ?? ''}</small>
							<em>{chosen.has(item.id) ? (multiple ? 'selected' : 'current') : ''}</em>
						</button>
					{/each}
				</div>
				{#if choices.length === 0}
					<p class="muted">
						{#if needle}
							Nothing matches “{query}”.
						{:else}
							{emptyMessage}
						{/if}
					</p>
				{/if}
			</div>

			{#if multiple}
				<!--
					A multi-select needs a way out that is not "pick something". Single-select
					closes on the pick, so it has no foot at all — GLC's shape, unchanged.
				-->
				<div class="foot">
					<button class="btn btn-primary" type="button" on:click={close}>Done</button>
				</div>
			{/if}
		</div>
	</div>
{/if}
