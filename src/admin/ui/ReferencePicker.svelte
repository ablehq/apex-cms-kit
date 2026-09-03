<!--
	The reference picker — the prototype's one dialog pattern (§1.6: heading, search,
	close, then a searchable body of choices), pointed at a collection of records
	rather than at a set of section templates. In 3d it is the AUTHOR picker.

	It is deliberately the same shape as `AddSectionDialog.svelte`, down to the `.card`
	markup, because the prototype defines one dialog and this admin should not grow a
	second dialog vocabulary. What differs is the source: the cards here are RECORDS
	the account holds, handed in by the screen that already loaded them.

	Why the name is a prop rather than something this component fetches: Apex does not
	inline a referenced record's display name — an article's author arrives as an id
	with `relatable_data.primitives: null` — so names are resolved by joining against
	the collection, and the screen that shows the picker has already loaded it for its
	own list. One read, not two, and no way for the two to disagree.

	CLEAR IS A FIRST-CLASS CHOICE, not an omission. "No author" is a real state of an
	article, and clearing the reference is the only way to say it, so it is a card in
	the same grid as the authors rather than a subtlety hidden behind an empty search.

	Legacy Svelte mode.
-->
<script>
	/**
	 * @typedef {{ id: string, name: string, hint?: string }} ReferenceChoice
	 */

	export let open = false;
	/** @type {ReferenceChoice[]} the collection to choose from, already loaded. */
	export let items = [];
	/** The id currently referenced, so the picker can mark it. @type {string | null} */
	export let selectedId = null;
	export let title = 'Choose an author';
	export let searchPlaceholder = 'Search authors';
	/** The card that clears the reference. Empty string hides it. */
	export let clearLabel = 'No author';
	export let clearHint = 'Leave this article unattributed.';
	/** Shown when the collection itself is empty — genuinely empty, not broken. */
	export let emptyMessage = 'There are no authors yet.';
	/** @type {(id: string | null) => void} `null` clears the reference. */
	export let onPick = () => {};
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

	$: if (open && searchEl) searchEl.focus();

	function close() {
		query = '';
		onClose();
	}

	/** @param {string | null} id */
	function pick(id) {
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
							aria-current={selectedId ? undefined : 'true'}
							on:click={() => pick(null)}
						>
							<b>{clearLabel}</b>
							<small>{clearHint}</small>
							<em>{selectedId ? '' : 'current'}</em>
						</button>
					{/if}
					{#each choices as item (item.id)}
						<button
							class="card"
							type="button"
							aria-current={item.id === selectedId ? 'true' : undefined}
							on:click={() => pick(item.id)}
						>
							<b>{item.name || '(unnamed)'}</b>
							<small>{item.hint ?? ''}</small>
							<em>{item.id === selectedId ? 'current' : ''}</em>
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
		</div>
	</div>
{/if}
