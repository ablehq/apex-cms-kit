<!--
	"+ Add" on the sections outline opens the prototype's card picker: the section
	types grouped the way a church editor thinks about them, each card carrying the
	name, the one-line description and the template slug in mono, with a search box
	over the top.

	The cards come from the committed template contract's `placement: 'section'`
	templates, and a card is only clickable when that template has been PROVISIONED
	in this Apex account (the registry the page editor read from
	`/api/admin/page-block-templates`). An unprovisioned template is shown, disabled,
	saying so — the alternative is a card that looks fine and fails on Save.

	The grouping is the prototype's own; the contract has no group field, so it lives
	here, next to the screen that shows it. Anything a future template adds that is
	not named here falls into "Other" rather than disappearing.

	Legacy Svelte mode.
-->
<script>
	import { placeableTemplates, getChildTemplates } from '../template-contract.js';

	export let open = false;
	/** @type {import('../types').AdminTemplateRegistry} slug → provisioned Apex template. */
	export let registry = {};
	/** @type {(slug: string) => void} */
	export let onPick = () => {};
	export let onClose = () => {};

	/**
	 * @typedef {import('../types').AdminBlockTemplateContract} AdminBlockTemplateContract
	 */

	const GROUPS = [
		[
			'Page structure',
			['glc-hero', 'glc-page-heading', 'glc-section-heading', 'glc-prose', 'glc-pullquote']
		],
		['Church', ['glc-service-times', 'glc-sermons-strip', 'glc-doctrine-list', 'glc-contact-form']],
		['Lists and media', ['glc-link-list', 'glc-video-grid']]
	];

	// The one section whose content is not written but derived — the strip of recent
	// messages, filled from the published sermons.
	const DERIVED = new Set(['glc-sermons-strip']);

	let query = '';
	/** The search box, from `bind:this` — only read after mount. @type {HTMLInputElement} */
	let searchEl;

	const templates = placeableTemplates();

	/** @param {string} slug */
	function groupOf(slug) {
		for (const [name, slugs] of GROUPS) if (slugs.includes(slug)) return name;
		return 'Other';
	}

	/** @param {AdminBlockTemplateContract} template */
	function kindOf(template) {
		if (DERIVED.has(template.slug)) return 'automatic';
		return getChildTemplates(template.slug).length > 0 ? 'repeatable' : '';
	}

	/**
	 * @param {AdminBlockTemplateContract} template
	 * @param {string} needle
	 */
	function matches(template, needle) {
		if (!needle) return true;
		return `${template.name} ${template.description ?? ''} ${template.slug}`
			.toLowerCase()
			.includes(needle);
	}

	$: needle = query.trim().toLowerCase();
	$: groups = [...GROUPS.map(([name]) => name), 'Other']
		.map((name) => ({
			name,
			items: templates.filter(
				(template) => groupOf(template.slug) === name && matches(template, needle)
			)
		}))
		.filter((group) => group.items.length > 0);

	$: if (open && searchEl) searchEl.focus();

	function close() {
		query = '';
		onClose();
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
		<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="add-section-title">
			<header>
				<h2 id="add-section-title">Add a section</h2>
				<input
					class="search"
					type="search"
					placeholder="Search sections"
					aria-label="Search sections"
					style="margin-left:auto"
					bind:this={searchEl}
					bind:value={query}
				/>
				<button class="btn btn-sm btn-quiet" type="button" aria-label="Close" on:click={close}>
					✕
				</button>
			</header>

			<div class="body">
				{#each groups as group (group.name)}
					<div class="grp">
						<span class="label">{group.name}</span>
						<div class="cards">
							{#each group.items as template (template.slug)}
								<button
									class="card"
									type="button"
									disabled={!registry[template.slug] || !registry[template.slug].id}
									title={registry[template.slug] && registry[template.slug].id
										? ''
										: 'This section type is not provisioned in this account yet. Ask a developer to run the template provisioner.'}
									on:click={() => onPick(template.slug)}
								>
									<b>{template.name}</b>
									<small>{template.description ?? ''}</small>
									<em>
										{template.slug}{kindOf(template) ? ` · ${kindOf(template)}` : ''}
									</em>
								</button>
							{/each}
						</div>
					</div>
				{:else}
					<p class="muted">No section type matches “{query}”.</p>
				{/each}
			</div>
		</div>
	</div>
{/if}
