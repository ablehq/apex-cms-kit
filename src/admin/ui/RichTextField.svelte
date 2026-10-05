<!--
	The rich-text control the prototype draws: a bordered well with a B / I / H2 /
	Link / List bar over a serif writing surface.

	No dependency. The surface is a `contenteditable`, the bar is
	`document.execCommand`, and the stored value is the tiptap-shaped
	`{ editor, html, content }` that Apex's `rich_text` validator and the public
	renderer both already speak (rich-text.js). execCommand is deprecated and
	imperfect, and it is also the only formatting engine every browser ships; the
	alternative was a 200 KB editor dependency for five buttons, which the plan and
	the prototype both refuse.

	The emitted value is built from the PREVIOUS stored value
	(`plainToRichText(html, value, {defaultEditor})`), so a field whose HTML did not
	move comes back byte for byte — same `editor`, same `content`, same object.
	Editors are still using Apex's own CMS UI on these same records, and what that UI
	does with a value whose `editor` flipped and whose `content` was emptied is
	verified by nobody.

	A value this control cannot READ — GLC's `{editor, content_html}` article blocks —
	puts the surface into a read-only state with a notice instead of presenting the
	field as empty. Displaying `''` and then storing it on the next keystroke is how
	an article body disappears.

	The one subtlety is not fighting the caret. `applied` remembers the HTML this
	component last put into — or last took out of — the element, so an external
	change (a save's reconcile, a reload) rewrites the surface while the editor's own
	keystrokes never do. Nothing is written back into a focused element.

	The bar follows the caret (`rich-text-bar.js`): B, I, H2 and List show pressed when
	the selection already has them, and pressing one again undoes it — H2 included,
	which turns a heading back into a paragraph. Enter after a heading starts a `<p>`,
	not the `<div>` Chrome starts by default: every value here is paragraphs, and a
	site's stylesheet styles `p`.

	Paste is forced to plain text: it keeps a paste from Word out of the page. The Link
	button refuses anything that is not `http` / `https` / `mailto` / `tel` or a path
	on this site — a courtesy to the person typing, not a boundary. The boundary is
	server-side, in `sanitize/write-boundary`.

	Legacy Svelte mode.
-->
<script>
	import { plainToRichText, richTextHtml } from '../rich-text.js';
	import { BAR_IDLE, barState, headingBlock } from '../rich-text-bar.js';

	/**
	 * The stored field value: the tiptap-shaped `{ editor, html, content }`, a bare
	 * HTML string, or nothing. `unknown` rather than a union, because the value comes
	 * out of a block entity's `fields_data` — Apex-validated JSON this component does
	 * not get to choose the shape of — and `htmlOf` below narrows it in one place.
	 * @type {unknown}
	 */
	export let value = '';
	export let disabled = false;
	export let ariaLabel = '';
	/**
	 * The editor name written into a value that HAS NONE — a Poovayya archetype
	 * primitive is stored `editor: null`. A stored non-empty name always wins.
	 *
	 * Per SITE, and ALL THREE SITES PASS `quilljs`. This used to say "GLC's page
	 * fields are tiptap"; live Apex says otherwise — 19 `quilljs` values to 1
	 * `tiptap` across every GLC archetype schema and entity type, and all 19 carry
	 * `content: {}` as well, so an empty `content` is the flattening defect's
	 * footprint on every value rather than a mark of a dialect. The 19:1 count is
	 * what carries it (Opus review of fix pass 3, finding 2; re-measured in the
	 * review of fix pass 4). `'tiptap'` is what this component did before the prop
	 * existed, so a site that passes nothing is unchanged — but no site here should
	 * be taking the default.
	 * @type {string}
	 */
	export let defaultEditor = 'tiptap';
	/** @type {(next: import('../types').RichTextValue) => void} */
	export let onChange = () => {};

	/** The writing surface, from `bind:this` — set once the component is mounted,
	 * which is the only time anything below runs. @type {HTMLDivElement} */
	let el;
	/** @type {string | null} */
	let applied = null;
	/** Which of the bar's toggles the selection already has. */
	let bar = BAR_IDLE;

	// `richTextHtml` answers a typed result rather than a string, so a shape this
	// control cannot read is VISIBLE here instead of arriving as `''`.
	$: read = richTextHtml(value);
	$: unreadable = !read.ok;
	$: incoming = read.ok ? read.html : '';
	$: if (el && read.ok && incoming !== applied && el !== documentActiveElement()) {
		applied = incoming;
		el.innerHTML = incoming;
	}

	function documentActiveElement() {
		return typeof document === 'undefined' ? null : document.activeElement;
	}

	function emit() {
		// Never write back over a value this control could not display: `el.innerHTML`
		// is empty because the value was unreadable, not because anyone deleted it.
		if (unreadable) return;
		// `value` is passed as the previous value, which is what lets an unchanged field
		// come back byte-identical rather than reshaped.
		const next = plainToRichText(el.innerHTML, value, { defaultEditor });
		// Remember what we produced so the reactive write-back above does not treat our
		// own edit as an external change and reset the caret.
		const readBack = richTextHtml(next);
		applied = readBack.ok ? readBack.html : '';
		onChange(next);
	}

	/**
	 * @param {string} command
	 * @param {string} [argument]
	 */
	function exec(command, argument) {
		if (disabled || !el) return;
		el.focus();
		if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
			document.execCommand(command, false, argument);
		}
		emit();
		// A command can change the formatting without moving the selection (B on a
		// collapsed caret), and then no `selectionchange` arrives to say so.
		refreshBar();
	}

	function refreshBar() {
		if (!el || typeof document === 'undefined') return;
		bar = barState(document.getSelection(), el, (command) => document.queryCommandState(command));
	}

	function heading() {
		if (disabled || !el) return;
		// Read now rather than from `bar`, which is only as fresh as the last
		// `selectionchange`, and that event is queued.
		const now = barState(document.getSelection(), el, (command) =>
			document.queryCommandState(command)
		);
		exec('formatBlock', headingBlock(now.heading));
	}

	function onFocus() {
		// Document-wide in the browser, and every surface on the page wants it.
		if (typeof document.execCommand === 'function') {
			document.execCommand('defaultParagraphSeparator', false, 'p');
		}
	}

	/**
	 * The protocols a link may use. What is being kept out is `javascript:` — the
	 * stored HTML is rendered on the public site with `{@html}`, so a link typed here
	 * is script an anonymous visitor would run — and `data:` / `vbscript:` with it.
	 *
	 * The check RESOLVES rather than string-matching, because the URL parser is the
	 * only thing that agrees with the browser about what `java<TAB>script:…` means. A
	 * root-relative or in-page href resolves against this origin and so lands on
	 * `https:`, which is why they need no case of their own.
	 *
	 * This is a courtesy to the person typing, NOT the boundary. The boundary is
	 * server-side, in `sanitize/write-boundary`, because this route into the field is
	 * not the only one.
	 */
	const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:'];

	/**
	 * @param {string} href
	 * @returns {boolean}
	 */
	function isSafeHref(href) {
		try {
			return SAFE_PROTOCOLS.includes(new URL(href, window.location.origin).protocol);
		} catch {
			return false;
		}
	}

	function link() {
		if (disabled || typeof window === 'undefined') return;
		const typed = window.prompt('Link to which address?');
		if (typed === null) return;
		const href = typed.trim();
		if (!href) return;
		if (!isSafeHref(href)) {
			// Said rather than silently dropped: a link that vanishes without a word
			// reads as a bug in the editor.
			window.alert(
				'That link was not added. Use a web address (https://…), an email (mailto:…), a phone number (tel:…), or a path on this site (/… or #…).'
			);
			return;
		}
		exec('createLink', href);
	}

	/** @param {ClipboardEvent} event */
	function onPaste(event) {
		const text = event.clipboardData && event.clipboardData.getData('text/plain');
		if (text === null || text === undefined) return;
		event.preventDefault();
		exec('insertText', text);
	}
</script>

<svelte:document on:selectionchange={refreshBar} />

<div class="rich">
	<div class="rich-bar">
		<button
			type="button"
			title="Bold"
			aria-pressed={bar.bold}
			{disabled}
			on:mousedown|preventDefault={() => exec('bold')}
		>
			<b>B</b>
		</button>
		<button
			type="button"
			title="Italic"
			aria-pressed={bar.italic}
			{disabled}
			on:mousedown|preventDefault={() => exec('italic')}
		>
			<i>I</i>
		</button>
		<button
			type="button"
			title={bar.heading ? 'Back to a paragraph' : 'Heading'}
			aria-pressed={bar.heading}
			{disabled}
			on:mousedown|preventDefault={heading}
		>
			H2
		</button>
		<button type="button" title="Link" {disabled} on:mousedown|preventDefault={link}>Link</button>
		<button
			type="button"
			title="Bulleted list"
			aria-pressed={bar.list}
			{disabled}
			on:mousedown|preventDefault={() => exec('insertUnorderedList')}
		>
			List
		</button>
	</div>
	<div
		class="rich-body"
		bind:this={el}
		contenteditable={!disabled && !unreadable}
		role="textbox"
		aria-multiline="true"
		aria-label={ariaLabel}
		spellcheck="false"
		on:focus={onFocus}
		on:input={emit}
		on:paste={onPaste}
	></div>
	{#if unreadable}
		<p class="notice">
			This field is stored in a format this editor cannot show. It has been left exactly as it is;
			edit it in the CMS instead.
		</p>
	{/if}
</div>
