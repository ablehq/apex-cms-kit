<!--
	The page editor, as the approved prototype draws it: a breadcrumb and the page's
	name, the three tabs (Sections / Details / SEO), and on the right the save state
	beside Preview, Save, and the one gold button that changes what the public sees.
	Below, an outline of the page's sections on the left — drag to reorder, order
	here is the order on the page — and one section at a time on the canvas.

	Underneath it is the M1 model, unchanged: edits mutate a LOCAL page-draft;
	reordering is local and never persists on drag; ONE explicit `savePage()` writes
	the dirty entity PATCHes and then the structure, in that order, stopping on the
	first failure; Publish is the same call with a trailing status event and never
	dispatches after a partial failure; a section the editor just added gets a real
	id from a structure save BEFORE its fields unlock (the temp-id rule). No
	autosave, no debounce, no coordinator.

	Legacy Svelte mode. The browser talks only to the same-origin BFF.
-->
<script>
	import { onMount, onDestroy } from 'svelte';
	import {
		createDraft,
		getBlocks,
		setField,
		setChildField,
		setPageField,
		setBlockOrder,
		reorderBlocks,
		removeBlock,
		addTemplateBlock,
		canEditFields,
		isDirty
	} from '../page-draft.js';
	import { savePage } from '../save-page.js';
	import {
		getFieldDefs,
		getTemplate,
		getChildTemplates,
		isDerivedTemplate
	} from '../template-contract.js';
	import { getOutlineInsertionIndex } from '../outline-drag.js';
	import BlockFieldEditor from './BlockFieldEditor.svelte';
	import AddSectionDialog from './AddSectionDialog.svelte';
	import MediaPickerModal from './MediaPickerModal.svelte';
	import { clockTime } from './format.js';

	/**
	 * @typedef {import('../types').AdminPage} AdminPage
	 * @typedef {import('../types').AdminPageBlock} AdminPageBlock
	 * @typedef {import('../types').AdminChildTemplateInstance} AdminChildTemplateInstance
	 * @typedef {import('../types').AdminStatusEvent} AdminStatusEvent
	 */

	/** @type {AdminPage} the hydrated Apex page (from GET /api/admin/pages/:id) */
	export let initialPage;
	export let initialVersion = '';
	/** @type {import('../types').BffClient} the same-origin BFF client */
	export let client;
	export let galleryId = '';
	/** @type {import('../types').AdminTemplateRegistry} slug → template. */
	export let templateRegistry = {};

	// The one section whose content is derived rather than written — the strip of
	// recent messages, filled from the published sermons.

	let draft = createDraft(initialPage, initialVersion);
	let tab = 'sections';
	let selectedId = getBlocks(draft)[0]?.id || '';
	let saving = false;
	let errorMessage = '';
	let stale = false;
	/** @type {AdminStatusEvent | null} */
	let lastStatusEvent = null;
	/** @type {string | Date | null} */
	let lastSavedAt = initialPage && initialPage.updated_at ? initialPage.updated_at : null;
	let addOpen = false;
	/** Child id → whether its field editor is open. @type {Record<string, boolean>} */
	let openChildren = {};

	// Section drag state (pointer-based, local only).
	/** @type {HTMLLIElement[]} */
	let rowEls = [];
	/** @type {number | null} */
	let dragIndex = null;

	// Media modal state.
	let mediaOpen = false;
	/** @type {string | null | undefined} */
	let mediaBlockId = null;
	/** @type {string | null} */
	let mediaFieldName = null;

	$: blocks = getBlocks(draft);
	$: dirty = isDirty(draft);
	$: status = draft.page.status;
	$: if (blocks.length && !blocks.some((block) => block.id === selectedId)) {
		selectedId = blocks[0].id;
	}
	$: selected = blocks.find((block) => block.id === selectedId) || null;
	$: selectedSlug = selected ? (selected.blockable?.page_block_template?.slug ?? '') : '';
	$: selectedTemplate = getTemplate(selectedSlug);
	$: selectedChildren = selected ? (selected.blockable?.child_template_instances ?? []) : [];

	function touch() {
		draft = draft; // re-trigger legacy reactivity after an in-place mutation
	}

	/** @param {AdminPageBlock | null | undefined} block */
	function slugOf(block) {
		return block?.blockable?.page_block_template?.slug ?? '';
	}

	/**
	 * The badge the outline shows: `auto` for a derived strip, `N items` for a repeatable.
	 * @param {AdminPageBlock | null | undefined} block
	 */
	function badgeOf(block) {
		const slug = slugOf(block);
		if (isDerivedTemplate(slug)) return 'auto';
		const children = block?.blockable?.child_template_instances;
		if (getChildTemplates(slug).length > 0) return `${children ? children.length : 0} items`;
		return '';
	}

	/** @param {AdminPageBlock | null | undefined} block */
	function nameOf(block) {
		return block?.label || getTemplate(slugOf(block))?.name || slugOf(block) || 'Section';
	}

	/**
	 * A child's own name, taken from whichever of its fields reads as a title.
	 * @param {AdminChildTemplateInstance} child
	 */
	function childName(child) {
		const data = child?.entity?.fields_data ?? {};
		for (const key of ['title', 'label', 'name', 'key', 'numeral']) {
			const value = data[key];
			if (typeof value === 'string' && value.trim()) return value.trim();
		}
		return child?.page_block_template?.name || 'Item';
	}

	/** @param {AdminChildTemplateInstance} child */
	function childDefs(child) {
		return getFieldDefs(child?.page_block_template?.slug);
	}

	/**
	 * The block argument is the selected section, which the markup only offers
	 * inside `{#if selected}` — but a `let` binding's narrowing does not survive
	 * into a handler closure, so the nullable type is the honest one and
	 * `page-draft.js` already treats an absent block as a no-op.
	 *
	 * @param {AdminPageBlock | null} block
	 * @param {string} fieldName
	 * @param {unknown} value
	 */
	function onFieldChange(block, fieldName, value) {
		setField(draft, block?.id, fieldName, value);
		touch();
	}

	/**
	 * @param {AdminPageBlock | null} block
	 * @param {AdminChildTemplateInstance} child
	 * @param {string} fieldName
	 * @param {unknown} value
	 */
	function onChildFieldChange(block, child, fieldName, value) {
		setChildField(draft, block?.id, child.id, fieldName, value);
		touch();
	}

	/**
	 * @param {'title' | 'slug' | 'summary'} name
	 * @param {string} value
	 */
	function onPageField(name, value) {
		setPageField(draft, name, value);
		touch();
	}

	/** @param {string} name */
	function metaValue(name) {
		const props = draft.page.meta_properties;
		if (!Array.isArray(props)) return '';
		const found = props.find((prop) => prop && prop.name === name && prop.group === 'web');
		return found ? (found.value ?? '') : '';
	}

	/** @param {AdminPageBlock | null} block */
	function onRemove(block) {
		if (!confirm(`Remove the “${nameOf(block)}” section from this page?`)) return;
		removeBlock(draft, block?.id);
		touch();
	}

	/**
	 * Duplicate — the prototype's affordance, wired to what genuinely exists. There
	 * is no clone operation, so this adds a new block of the same template carrying a
	 * copy of the section's own field values, and reorders it into place directly
	 * after its original. Both halves are existing page-draft calls.
	 *
	 * It is offered only for a section with no repeatable items, because copying
	 * those would mean minting child instances, and `page-draft.js` has no API for
	 * that. A half-copy that silently dropped the items would be worse than an
	 * honest refusal.
	 *
	 * @param {AdminPageBlock | null} block
	 */
	async function onDuplicate(block) {
		const slug = slugOf(block);
		const apexTemplate = templateRegistry[slug];
		if (!apexTemplate?.id) {
			errorMessage =
				'This section type is not provisioned yet. Ask a developer to run the template provisioner.';
			return;
		}
		const created = addTemplateBlock(draft, {
			templateId: apexTemplate.id,
			templateSlug: slug,
			label: `${nameOf(block)} copy`,
			entityTypeId: apexTemplate.entity_type_id ?? '',
			fieldsData: structuredClone(block?.blockable?.entity?.fields_data ?? {})
		});
		const order = [];
		for (const candidate of getBlocks(draft)) {
			if (candidate.id === created.id) continue;
			order.push(candidate.id);
			if (candidate.id === block?.id) order.push(created.id);
		}
		setBlockOrder(draft, order);
		selectedId = created.id;
		touch();
		// Temp-id rule: persist immediately so the copy gets a real id and unlocks.
		await runSave(null);
	}

	/** @param {string} slug */
	async function onAddSection(slug) {
		addOpen = false;
		const apexTemplate = templateRegistry[slug];
		if (!apexTemplate?.id) {
			errorMessage =
				'This section type is not provisioned yet. Ask a developer to run the template provisioner.';
			return;
		}
		const created = addTemplateBlock(draft, {
			templateId: apexTemplate.id,
			templateSlug: slug,
			label: getTemplate(slug)?.name || slug,
			entityTypeId: apexTemplate.entity_type_id ?? '',
			fieldsData: {}
		});
		selectedId = created.id;
		touch();
		// Temp-id fix: persist immediately so the new block gets a real id (and its
		// entity), which unlocks its fields.
		await runSave(null);
	}

	/** @param {string} childId */
	function toggleChild(childId) {
		openChildren = { ...openChildren, [childId]: !openChildren[childId] };
	}

	// ── Pointer drag (grip) — local reorder only, never persists on drag ──
	/**
	 * @param {PointerEvent} event
	 * @param {number} index
	 */
	function startDrag(event, index) {
		event.preventDefault();
		dragIndex = index;
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', endDrag);
		window.addEventListener('pointercancel', endDrag);
	}

	/** @param {PointerEvent} event */
	function onPointerMove(event) {
		if (dragIndex === null) return;
		const rows = rowEls.filter(Boolean);
		const target = getOutlineInsertionIndex(event.clientY, rows);
		// getOutlineInsertionIndex returns an insertion slot [0..n]; convert to a
		// destination index for the moved row.
		let dest = target > dragIndex ? target - 1 : target;
		dest = Math.max(0, Math.min(dest, rows.length - 1));
		if (dest !== dragIndex) {
			reorderBlocks(draft, dragIndex, dest);
			dragIndex = dest;
			touch();
		}
	}

	function endDrag() {
		dragIndex = null;
		// Same guard, same reason as the article editor's `endDrag`: `onDestroy` runs
		// server-side too. This form is only ever instantiated `{#if loaded}`, so it
		// does not render on the server today and the bug is latent here rather than
		// live — which is exactly why it should be closed now, while it costs a line,
		// instead of the first time somebody makes this form render before its data.
		if (typeof window === 'undefined') return;
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', endDrag);
		window.removeEventListener('pointercancel', endDrag);
	}

	// ── Media ──
	/**
	 * @param {AdminPageBlock | null} block
	 * @param {string} fieldName
	 */
	function openMedia(block, fieldName) {
		mediaBlockId = block?.id;
		mediaFieldName = fieldName;
		mediaOpen = true;
	}

	/** @param {string} galleryItemId */
	function onMediaSelected(galleryItemId) {
		if (mediaBlockId && mediaFieldName) {
			setField(draft, mediaBlockId, mediaFieldName, galleryItemId);
			touch();
		}
	}

	// ── Save / Publish (the one path) ──
	/** @param {AdminStatusEvent | null} statusEvent */
	async function runSave(statusEvent) {
		if (saving) return false;
		saving = true;
		errorMessage = '';
		stale = false;
		lastStatusEvent = statusEvent;
		try {
			const result = await savePage(draft, client, statusEvent ? { statusEvent } : {});
			if (!result.ok) {
				errorMessage = result.message;
				stale = Boolean(result.stale);
				return false;
			}
			lastSavedAt = new Date();
			return true;
		} catch {
			// A `fetch` that REJECTS — offline, DNS, a reset connection. `bff-client`'s
			// `mutate()` normalizes an HTTP failure to `{ ok: false }` but nothing
			// normalizes a rejection, so without this the throw escapes past
			// `saving = false` and Save/Publish stay disabled for the rest of the
			// session with the whole page draft still unsaved. `savePage` writes in
			// stages, so a rejection mid-way may have landed some of them.
			errorMessage =
				'Could not reach the server, so the save may be incomplete. Save again to retry.';
			return false;
		} finally {
			saving = false;
			touch();
		}
	}

	function onSave() {
		void runSave(null);
	}
	function onPublish() {
		void runSave('publish');
	}
	function onUnpublish() {
		void runSave('unpublish');
	}
	function onRetry() {
		void runSave(lastStatusEvent);
	}

	async function onReload() {
		const fresh = await client.getPage(draft.pageId);
		draft = createDraft(fresh.page, fresh.version);
		errorMessage = '';
		stale = false;
	}

	// ── Keyboard: the prototype's ⌘S / Ctrl-S ──
	/** @param {KeyboardEvent} event */
	function onKeydown(event) {
		if ((event.metaKey || event.ctrlKey) && event.key === 's') {
			event.preventDefault();
			if (dirty && !saving) onSave();
		}
	}

	// ── Unsaved-changes guard ──
	/** @param {BeforeUnloadEvent} event */
	function beforeUnload(event) {
		if (isDirty(draft)) {
			event.preventDefault();
			event.returnValue = '';
		}
	}
	onMount(() => window.addEventListener('beforeunload', beforeUnload));
	onDestroy(() => {
		if (typeof window !== 'undefined') window.removeEventListener('beforeunload', beforeUnload);
		endDrag();
	});
</script>

<svelte:window on:keydown={onKeydown} />

<div class="head">
	<a class="crumb" href="/admin/pages">Pages</a>
	<h1>{draft.page.title || '(untitled)'}</h1>

	<div class="tabs" role="tablist" aria-label="Page" style="margin-left:.5rem">
		<button
			class="tab"
			role="tab"
			type="button"
			aria-selected={tab === 'sections'}
			on:click={() => (tab = 'sections')}
		>
			Sections
		</button>
		<button
			class="tab"
			role="tab"
			type="button"
			aria-selected={tab === 'details'}
			on:click={() => (tab = 'details')}
		>
			Details
		</button>
		<button
			class="tab"
			role="tab"
			type="button"
			aria-selected={tab === 'seo'}
			on:click={() => (tab = 'seo')}
		>
			SEO
		</button>
	</div>

	<div class="head-end">
		<span
			class="state"
			aria-live="polite"
			data-save-state={saving ? 'saving' : dirty ? 'dirty' : 'saved'}
		>
			{#if saving}
				Saving…
			{:else if dirty}
				<b>Unsaved changes</b>
			{:else if lastSavedAt}
				Saved <b>{clockTime(lastSavedAt)}</b>
			{:else}
				Saved
			{/if}
		</span>
		<!--
			Preview now opens the DRAFT preview — this page drawn by the site’s own block
			components from what is in Apex, published or not. It used to point at the page’s
			PUBLIC address, which serves the last published snapshot; a control called Preview
			that shows you the previous release is not a preview, and putting the caveat in a
			`title` did not make it one.

			It still cannot show work that has not been saved — the preview renders
			server-side, and the server only ever sees a save. That is said on the preview
			itself, and offered as a choice in the canvas below whenever the draft is dirty,
			rather than hidden in a tooltip.
		-->
		<a class="btn" href="/admin/pages/{draft.pageId}/preview" target="_blank" rel="noreferrer">
			Preview
		</a>
		<button class="btn" type="button" on:click={onSave} disabled={saving || !dirty}>Save</button>
		{#if status === 'published'}
			<button class="btn btn-primary" type="button" on:click={onUnpublish} disabled={saving}>
				Unpublish
			</button>
		{:else}
			<button class="btn btn-primary" type="button" on:click={onPublish} disabled={saving}>
				Publish
			</button>
		{/if}
	</div>
</div>

<div class="editor">
	<aside class="outline" style="visibility:{tab === 'sections' ? 'visible' : 'hidden'}">
		<div class="outline-head">
			<span class="label">Sections</span>
			<button
				class="btn btn-sm btn-quiet"
				type="button"
				style="margin-left:auto"
				on:click={() => (addOpen = true)}
			>
				+ Add
			</button>
		</div>

		<ul class="ol">
			{#each blocks as block, index (block.id)}
				<li
					data-selected={block.id === selectedId}
					class={dragIndex === index ? 'dragging' : ''}
					bind:this={rowEls[index]}
				>
					<button
						class="grip"
						type="button"
						aria-label="Drag to reorder {nameOf(block)}"
						on:pointerdown={(event) => startDrag(event, index)}
					>
						⣿
					</button>
					<button
						class="nm"
						type="button"
						aria-current={block.id === selectedId ? 'true' : undefined}
						on:click={() => {
							selectedId = block.id;
							tab = 'sections';
						}}
					>
						{nameOf(block)}
					</button>
					<span class="kd">{badgeOf(block)}</span>
				</li>
			{/each}
		</ul>

		<p class="muted" style="font-size:12px">
			Drag to reorder. Order here is the order on the page.
		</p>
	</aside>

	<div class="canvas">
		<!--
			The honest half of Preview. The preview renders on the server from what Apex
			holds, so it CANNOT contain edits that have not been saved — no amount of UI
			would make it. Rather than let the button quietly imply otherwise, the gap is
			stated here while it exists, with the fix offered beside it: save, then preview.
		-->
		{#if dirty}
			<p class="notice">
				<b>Preview shows your last save.</b> These changes are not in it yet — the preview is
				rendered from what is stored in Apex, not from this browser.
				<button class="btn btn-sm" type="button" on:click={onSave} disabled={saving}>
					{saving ? 'Saving…' : 'Save first'}
				</button>
			</p>
		{/if}
		{#if errorMessage}
			<p class="err" role="alert">
				{errorMessage}
				{#if stale}
					<button class="btn btn-sm" type="button" on:click={onReload}>Reload page</button>
				{:else}
					<button class="btn btn-sm" type="button" on:click={onRetry}>Retry</button>
				{/if}
			</p>
		{/if}

		{#if tab === 'sections'}
			{#if !selected}
				<p class="muted">This page has no sections yet. Use “+ Add” to place the first one.</p>
			{:else}
				<div class="canvas-head">
					<h2>{nameOf(selected)}</h2>
					<span class="tpl">{selectedSlug}</span>
				</div>
				<p class="hint">
					{selectedTemplate ? (selectedTemplate.description ?? '') : ''}
					{#if isDerivedTemplate(selectedSlug)}
						The messages themselves come from published sermons — there is nothing to write here.
					{/if}
				</p>

				<BlockFieldEditor
					fieldDefs={getFieldDefs(selectedSlug)}
					fieldsData={selected.blockable?.entity?.fields_data ?? {}}
					editable={canEditFields(selected)}
					onChange={(name, value) => onFieldChange(selected, name, value)}
					onPickMedia={(name) => openMedia(selected, name)}
				/>

				{#if selectedChildren.length > 0}
					<div style="display:flex;align-items:center;gap:.6rem;margin-top:2rem">
						<span class="label">
							{getChildTemplates(selectedSlug)[0]?.name || 'Items'} · {selectedChildren.length}
						</span>
						<!--
							CAPABILITY GAP — adding and removing repeatable items. The serializer
							can carry child instances, but `page-draft.js` — the reviewed,
							load-bearing draft model — exposes no add/remove-child API, and this
							rebuild does not reimplement it outside that module. The existing items
							ARE fully editable (setChildField), and so is their order on the page.
						-->
						<button
							class="btn btn-sm btn-quiet"
							type="button"
							style="margin-left:auto"
							disabled
							title="Adding an item to a repeatable section is not wired up yet. Existing items are fully editable."
						>
							+ Add item
						</button>
					</div>

					<div class="children">
						{#each selectedChildren as child (child.id)}
							<div class="child">
								<div class="child-row">
									<span class="nm">{childName(child)}</span>
									<span>
										<button
											class="chev"
											type="button"
											aria-expanded={Boolean(openChildren[child.id])}
											on:click={() => toggleChild(child.id)}
										>
											{openChildren[child.id] ? '▾ Close' : '▸ Edit'}
										</button>
										<button
											class="btn btn-sm btn-quiet danger"
											type="button"
											disabled
											title="Removing an item from a repeatable section is not wired up yet."
										>
											Remove
										</button>
									</span>
								</div>
								{#if openChildren[child.id]}
									<div class="child-body">
										<BlockFieldEditor
											fieldDefs={childDefs(child)}
											fieldsData={child.entity?.fields_data ?? {}}
											editable={canEditFields(selected)}
											onChange={(name, value) => onChildFieldChange(selected, child, name, value)}
											onPickMedia={null}
										/>
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}

				<div class="foot-acts">
					<button
						class="btn btn-sm btn-quiet"
						type="button"
						disabled={saving || selectedChildren.length > 0}
						title={selectedChildren.length > 0
							? 'A section with repeatable items cannot be duplicated — its items would be dropped.'
							: 'Adds a copy of this section, with its field values, directly below it.'}
						on:click={() => onDuplicate(selected)}
					>
						Duplicate section
					</button>
					<button
						class="btn btn-sm btn-quiet danger"
						type="button"
						on:click={() => onRemove(selected)}
					>
						Remove section
					</button>
				</div>
			{/if}
		{:else if tab === 'details'}
			<div class="canvas-head"><h2>Details</h2></div>
			<p class="hint">How this page is identified and linked.</p>
			<div class="fields">
				<div class="two">
					<div class="f">
						<label class="label" for="page-title">Title</label>
						<input
							id="page-title"
							class="inp"
							type="text"
							value={draft.page.title ?? ''}
							on:input={(event) => onPageField('title', event.currentTarget.value)}
						/>
					</div>
					<div class="f">
						<label class="label" for="page-slug">Slug</label>
						<input
							id="page-slug"
							class="inp mono"
							type="text"
							spellcheck="false"
							value={draft.page.slug ?? ''}
							on:input={(event) => onPageField('slug', event.currentTarget.value)}
						/>
					</div>
				</div>
				<div class="f">
					<label class="label" for="page-summary">Summary</label>
					<textarea
						id="page-summary"
						class="inp"
						rows="3"
						value={draft.page.summary ?? ''}
						on:input={(event) => onPageField('summary', event.currentTarget.value)}
					></textarea>
				</div>
			</div>
		{:else}
			<div class="canvas-head"><h2>SEO</h2></div>
			<p class="hint">What search engines and link previews show.</p>
			<!--
				CAPABILITY GAP — the SEO fields. Apex stores them as `meta_properties` in
				the `web` group and the page read carries them, so the stored values are
				shown; nothing can change them. The structure route's body permits title,
				slug, summary and blocks only, and inventing a meta-property write path to
				satisfy a mock is exactly what this rebuild was told not to do.
			-->
			<div class="fields">
				<div class="f">
					<label class="label" for="seo-title">Meta title</label>
					<input id="seo-title" class="inp" type="text" value={metaValue('title')} disabled />
				</div>
				<div class="f">
					<label class="label" for="seo-description">Meta description</label>
					<input
						id="seo-description"
						class="inp"
						type="text"
						value={metaValue('description')}
						disabled
					/>
				</div>
				<div class="f">
					<label class="label" for="seo-keywords">Meta keywords</label>
					<input
						id="seo-keywords"
						class="inp mono"
						type="text"
						value={metaValue('keywords')}
						disabled
					/>
				</div>
				<p class="notice">
					These are read from Apex and shown as stored. The admin cannot write them yet — the page
					save carries title, slug, summary and sections only.
				</p>
			</div>
		{/if}
	</div>
</div>

<AddSectionDialog
	open={addOpen}
	registry={templateRegistry}
	onPick={onAddSection}
	onClose={() => (addOpen = false)}
/>

<MediaPickerModal bind:open={mediaOpen} {galleryId} {client} onSelect={onMediaSelected} />
