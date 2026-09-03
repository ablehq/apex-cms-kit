<!--
	The tag picker — the prototype's one dialog pattern (lines 1286–1301: heading +
	search + close, then a searchable body of choices), reused for tags exactly as
	`AddSectionDialog.svelte` reuses it for section types.

	It emits the FULL DESIRED SET, never a diff. That is not a stylistic choice: the
	upstream `POST /taggings` is not idempotent — an identical retry returns 200 and
	creates a second row — so the BFF reconciles a whole set instead of appending,
	and the only thing this component can usefully hand it is that set.

	WHAT THIS COMPONENT DELIBERATELY CANNOT DO — delete a tag.

	`DELETE /tags/:id` removes the word from the account's vocabulary and cascades to
	every tagging on it: one call un-tagged every record on the account. So "×" on a
	chip here removes the tag FROM THIS RESOURCE and nothing else, the copy says so
	in those words, and there is no affordance anywhere in this file for the other
	operation — no menu item, no long-press, no shift-click. An editor cannot reach
	the account-wide delete by misreading this UI, because it is not in it. (It is
	also not in the BFF, not in `bff-client.js` and not in the Apex client, so this
	is the outermost of four.)

	Creating a tag IS offered, inline, because the alternative is an editor leaving
	the record to go and make one. It is list-then-create and the server adopts an
	existing name rather than erroring, so typing a name that already exists just
	selects it.

	No new CSS: every class here is already in `admin.css` (`.dlg`, `.search`,
	`.cards`, `.card`, `.btn`, `.label`, `.muted`, `.notice`, `.hint`). The one
	visual state the stylesheet has no rule for — a SELECTED card — is an inline
	`border-color: var(--gold)`, the same token the prototype reserves for "the one
	thing on screen that commits", and it is theme-aware because the token is.

	Legacy Svelte mode.
-->
<script>
	/** @typedef {import('../types').AdminTag} AdminTag */

	/** The whole account vocabulary. @type {AdminTag[]} */
	export let tags = [];
	/** The currently desired set, as tag ids. @type {string[]} */
	export let selected = [];
	/**
	 * Called with the FULL new desired set whenever it changes. The caller holds it
	 * and hands it to the save; this component keeps no state but the dialog's.
	 * @type {(tagIds: string[]) => void}
	 */
	export let onChange = () => {};
	/**
	 * Create (or adopt) a tag by name and resolve to it, or to null if it failed.
	 * The caller owns the network, exactly as it does for every other field. The
	 * default refuses rather than throwing, so a picker mounted without it simply
	 * offers no "add" affordance.
	 * @type {(name: string) => Promise<AdminTag | null>}
	 */
	export let onCreate = async () => null;
	export let disabled = false;

	let open = false;
	let query = '';
	let creating = false;
	let createError = '';
	/** The search box, from `bind:this` — only read after mount. @type {HTMLInputElement} */
	let searchEl;

	/**
	 * The selected tags, in the order the editor chose them, skipping any id the
	 * vocabulary does not know. A tag id with no tag is not rendered blank — the row
	 * simply is not there, and the reconciliation will not be asked to keep it.
	 *
	 * @param {string[]} ids
	 * @param {Map<string, AdminTag>} vocabulary
	 * @returns {AdminTag[]}
	 */
	function resolve(ids, vocabulary) {
		const found = [];
		for (const id of ids) {
			const tag = vocabulary.get(id);
			if (tag) found.push(tag);
		}
		return found;
	}

	$: byId = new Map(tags.map((tag) => [tag.id, tag]));
	$: chosen = resolve(selected, byId);
	$: needle = query.trim().toLowerCase();
	$: matches = tags.filter((tag) => !needle || tag.name.toLowerCase().includes(needle));
	// Offer "create" only when the typed name is not already a tag — case-insensitively,
	// because a vocabulary with both `Devotional` and `devotional` in it helps nobody.
	$: exact = tags.some((tag) => tag.name.toLowerCase() === query.trim().toLowerCase());
	$: canCreate = query.trim().length > 0 && !exact;

	$: if (open && searchEl) searchEl.focus();

	/** @param {string} tagId */
	function toggle(tagId) {
		if (disabled) return;
		onChange(
			selected.includes(tagId) ? selected.filter((id) => id !== tagId) : [...selected, tagId]
		);
	}

	async function create() {
		if (creating) return;
		creating = true;
		createError = '';
		try {
			const tag = await onCreate(query.trim());
			if (!tag) {
				createError = 'That tag could not be created. Try again.';
				return;
			}
			if (!selected.includes(tag.id)) onChange([...selected, tag.id]);
			query = '';
		} catch {
			// `onCreate` reaches the network, and a `fetch` that REJECTS never becomes a
			// null return — see the same catch on the Articles list.
			createError = 'That tag could not be created. Try again.';
		} finally {
			creating = false;
		}
	}

	function close() {
		open = false;
		query = '';
		createError = '';
	}

	/** @param {KeyboardEvent} event */
	function onKeydown(event) {
		if (open && event.key === 'Escape') close();
	}

	/** @param {MouseEvent} event */
	function onScrimClick(event) {
		if (event.target === event.currentTarget) close();
	}
</script>

<svelte:window on:keydown={onKeydown} />

<div class="f">
	<span class="label" id="tag-picker-label">Tags</span>
	<div class="acts-static">
		{#each chosen as tag (tag.id)}
			<span class="st st-live">
				{tag.name}
				<button
					class="btn btn-sm btn-quiet"
					type="button"
					{disabled}
					title="Remove “{tag.name}” from this resource. The tag itself stays available for everything else."
					aria-label="Remove {tag.name} from this resource"
					on:click={() => toggle(tag.id)}
				>
					✕
				</button>
			</span>
		{:else}
			<span class="muted">No tags yet.</span>
		{/each}
		<button class="btn btn-sm" type="button" {disabled} on:click={() => (open = true)}>
			Choose tags
		</button>
	</div>
	<p class="hint">
		Tags group resources on the public /resources page. Removing one here removes it from this
		resource only — every other resource keeps it.
	</p>
</div>

{#if open}
	<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
	<div class="adm-scrim" on:click={onScrimClick}>
		<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="tag-picker-title">
			<header>
				<h2 id="tag-picker-title">Tags</h2>
				<input
					class="search"
					type="search"
					placeholder="Search or add a tag"
					aria-label="Search or add a tag"
					style="margin-left:auto"
					bind:this={searchEl}
					bind:value={query}
				/>
				<button class="btn btn-sm btn-quiet" type="button" aria-label="Close" on:click={close}>
					✕
				</button>
			</header>

			<div class="body">
				{#if createError}<p class="err" role="alert">{createError}</p>{/if}

				{#if matches.length > 0}
					<div class="cards">
						{#each matches as tag (tag.id)}
							<button
								class="card"
								type="button"
								aria-pressed={selected.includes(tag.id)}
								style={selected.includes(tag.id) ? 'border-color: var(--gold)' : ''}
								on:click={() => toggle(tag.id)}
							>
								<b>{tag.name}</b>
								<em>{selected.includes(tag.id) ? 'on this resource' : 'not on this resource'}</em>
							</button>
						{/each}
					</div>
				{:else if !canCreate}
					<p class="muted">
						{#if needle}No tag matches “{query}”.{:else}No tags yet — type a name to add the first
							one.{/if}
					</p>
				{/if}

				{#if canCreate}
					<p>
						<button class="btn btn-sm" type="button" disabled={creating} on:click={create}>
							{creating ? 'Adding…' : `Add “${query.trim()}”`}
						</button>
					</p>
				{/if}

				<!--
					Said plainly, because the destructive operation this UI does not offer is
					the one an editor might otherwise go looking for.
				-->
				<p class="notice">
					Tags are shared across the whole site. Nothing here deletes a tag — turning one off takes
					it off this resource and leaves it on every other.
				</p>
			</div>

			<div class="foot">
				<button class="btn" type="button" on:click={close}>Done</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/*
		One rule, scoped to this component, for one thing the prototype's stylesheet
		has no class for: a row of chips that must wrap. `.acts` is the closest
		existing class and is deliberately not reused — it is `opacity: 0` until its
		row is hovered, which is right for a table and wrong for a form field.
	*/
	.acts-static {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
	}
</style>
