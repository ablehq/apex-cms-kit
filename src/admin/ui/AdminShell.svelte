<!--
	The admin chrome, as the approved prototype draws it: a 204px rail on a sunk
	ground carrying the workspace mark, the destination list — Pages · Messages ·
	Articles · Authors · Resources, a rule, Images — and a foot that says what the
	site is doing and offers the one button that would change it.

	Three of those destinations (Articles, Authors, Resources) and the Images library
	are phase 3d and are NOT built. They are in the rail because the prototype puts
	them there and because a church editor should be able to see the shape of the
	whole workspace; each leads to a screen that says plainly that it is not built
	yet, rather than to a blank.

	Legacy Svelte idiom, inside the `runes: false` admin exemption (svelte.config.js).
	`$app/stores` (not `$app/state`) is deliberate: it is a real store, so `$page`
	tracks inside a legacy-compiled component.
-->
<script>
	import { page } from '$app/stores';
	import { createBffClient } from '../bff-client.js';

	/**
	 * The signed-in editor, from `+layout.server.ts`'s read of the server-side
	 * session, or null when there is none. Chrome only — a name on screen proves
	 * nothing; every BFF call re-resolves the session itself.
	 * @type {{ email: string, name: string | null } | null}
	 */
	/** The site's name in the rail. */
	export let brand = 'Apex';
	/** Rail entries: `{ href, label, count? }`; a `null` entry is a divider. */
	export let nav = [];
	/** @type {{ email: string, name: string | null } | null} */
	export let editor = null;

	/**
	 * What the SITE is serving, and whether this deployment can publish at all —
	 * from `+layout.server.ts`'s read of the published snapshot's manifest and the
	 * publish bindings. `null` on the login page, which has no workspace to describe.
	 * @type {{ configured: boolean, published: import('../types').SiteStatus['published'] } | null}
	 */
	export let site = null;

	let signingOut = false;
	let publishing = false;
	/** The last thing the publish path actually said. Never a guess. */
	let publishMessage = '';
	let publishFailed = false;
	/** Apex answered with an emptied collection; the rail then offers "Publish anyway". */
	let publishNeedsConfirm = false;
	const client = createBffClient();

	$: pathname = $page.url.pathname;

	/** @param {string} prefix */
	function isActive(prefix) {
		return pathname === prefix || pathname.startsWith(`${prefix}/`);
	}

	async function signOut() {
		if (signingOut) return;
		signingOut = true;
		try {
			await client.logout();
		} finally {
			// A full load regardless of the outcome: the session row is already gone
			// server-side, so the next document request must be re-evaluated from scratch.
			window.location.assign('/admin/login');
		}
	}

	/**
	 * Publish. The one control in the admin that changes what a visitor sees: it
	 * fetches everything from Apex and writes the KV snapshot the site reads.
	 *
	 * The server's answer is reported verbatim. When this deployment has no way to
	 * publish, that answer is a 501 whose `detail` names the binding that is missing,
	 * and that sentence is what appears here — the button neither pretends to have
	 * worked nor throws. When it does dispatch, the message says what was STARTED,
	 * not that it finished: a refresh takes about a minute, and this request cannot
	 * know how it ends.
	 */
	async function publishSite(allowEmpty = false) {
		if (publishing) return;
		publishing = true;
		publishFailed = false;
		publishNeedsConfirm = false;
		publishMessage = '';
		try {
			const result = await client.publishSite(allowEmpty ? { allowEmpty: true } : {});
			publishFailed = !result.ok;
			publishNeedsConfirm = !result.ok && result.error === 'empty_collection';
			if (result.ok) {
				// The server's own counts, so the sentence is what is live, not a guess.
				const counts = result.counts && typeof result.counts === 'object' ? result.counts : {};
				const summary = Object.entries(counts)
					.map(([name, count]) => `${count} ${name.replaceAll('_', ' ')}`)
					.join(', ');
				const warnings = Array.isArray(result.warnings) ? result.warnings : [];
				publishMessage =
					(summary ? `Published — ${summary}. Live within a couple of minutes.` : 'Published.') +
					(warnings.length ? ` ${warnings.length} warning(s): ${warnings.join(' ')}` : '');
			} else {
				const detail = typeof result.detail === 'string' ? result.detail : '';
				publishMessage = detail || `Publish failed (${result.status}).`;
			}
		} catch (error) {
			publishFailed = true;
			publishMessage = (error instanceof Error && error.message) || 'Publish could not be started.';
		} finally {
			publishing = false;
		}
	}
</script>

<div class="app">
	<aside class="rail">
		<span class="mark">{brand}<span>Admin</span></span>

		<nav aria-label="Admin">
			{#each nav as item}
				{#if item === null}
					<hr />
				{:else}
					<a href={item.href} aria-current={isActive(item.href) ? 'page' : undefined}>
						{item.label}
						{#if item.count}
							<span class="count" title={item.countTitle || String(item.count)}>{item.count}</span>
						{/if}
					</a>
				{/if}
			{/each}
		</nav>

		<div class="rail-foot">
			{#if editor}
				<span class="who" title={editor.email}>{editor.name || editor.email}</span>
				<button class="btn btn-sm btn-quiet" type="button" on:click={signOut} disabled={signingOut}>
					{signingOut ? 'Signing out…' : 'Sign out'}
				</button>
			{:else}
				<!--
					Unreachable in practice: `+layout.server.ts` redirects anyone without a
					session to /admin/login before this shell renders. Kept as an honest
					statement rather than a link, so a load that ever forgets the redirect
					shows nothing that looks signed in.
				-->
				<span class="who">Not signed in</span>
			{/if}

			<!--
				"What's live", stated as fact. An editor's saves are in Apex the moment
				they succeed; the public site is NOT Apex — it serves the published
				snapshot in KV, and only a publish moves that. Saying so is the
				difference between "my reorder did nothing" and "my reorder is saved and
				waiting to go out".
			-->
			{#if site}
				<small>
					Your saves are live in <b>Apex</b>.<br />
					{#if site.published}
						The site serves what was published
						{new Date(site.published.publishedAt).toLocaleString()} by
						<b>{site.published.publishedBy}</b>.<br />
					{:else}
						Nothing has been published from this deployment yet.<br />
					{/if}
					Publishing fetches everything from Apex and makes it live.
				</small>
			{/if}

			<button
				class="btn"
				type="button"
				on:click={() => publishSite(false)}
				disabled={publishing}
				aria-describedby={publishMessage ? 'publish-note' : undefined}
			>
				{publishing ? 'Publishing…' : 'Publish site'}
			</button>

			{#if publishMessage}
				<small id="publish-note" class="notice" class:danger={publishFailed} aria-live="polite">
					{publishMessage}
					{#if publishNeedsConfirm}
						<button
							class="linky"
							type="button"
							on:click={() => publishSite(true)}
							disabled={publishing}
						>
							Publish anyway
						</button>
					{/if}
				</small>
			{:else if site && !site.configured}
				<small class="notice"
					>Publishing is not configured on this deployment: no CONTENT binding.</small
				>
			{/if}
		</div>
	</aside>

	<div><slot /></div>
</div>
