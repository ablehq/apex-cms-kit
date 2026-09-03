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

	The one subtlety is not fighting the caret. `applied` remembers the HTML this
	component last put into — or last took out of — the element, so an external
	change (a save's reconcile, a reload) rewrites the surface while the editor's own
	keystrokes never do. Nothing is written back into a focused element.

	Paste is forced to plain text: it keeps a paste from Word out of the page, and it
	is the whole of this control's sanitization story on the way in.

	Legacy Svelte mode.
-->
<script>
	import { plainToRichText } from '../rich-text.js';

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
	/** @type {(next: import('../types').RichTextValue) => void} */
	export let onChange = () => {};

	/** The writing surface, from `bind:this` — set once the component is mounted,
	 * which is the only time anything below runs. @type {HTMLDivElement} */
	let el;
	/** @type {string | null} */
	let applied = null;

	/**
	 * @param {unknown} stored
	 * @returns {string}
	 */
	function htmlOf(stored) {
		if (stored && typeof stored === 'object') return 'html' in stored ? `${stored.html ?? ''}` : '';
		return `${stored ?? ''}`;
	}

	$: incoming = htmlOf(value);
	$: if (el && incoming !== applied && el !== documentActiveElement()) {
		applied = incoming;
		el.innerHTML = incoming;
	}

	function documentActiveElement() {
		return typeof document === 'undefined' ? null : document.activeElement;
	}

	function emit() {
		const next = plainToRichText(el.innerHTML);
		// Remember what we produced so the reactive write-back above does not treat our
		// own edit as an external change and reset the caret.
		applied = next.html;
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
	}

	function link() {
		if (disabled) return;
		const href = typeof window === 'undefined' ? null : window.prompt('Link to which address?');
		if (!href) return;
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

<div class="rich">
	<div class="rich-bar">
		<button type="button" title="Bold" {disabled} on:mousedown|preventDefault={() => exec('bold')}>
			<b>B</b>
		</button>
		<button
			type="button"
			title="Italic"
			{disabled}
			on:mousedown|preventDefault={() => exec('italic')}
		>
			<i>I</i>
		</button>
		<button
			type="button"
			title="Heading"
			{disabled}
			on:mousedown|preventDefault={() => exec('formatBlock', '<h2>')}
		>
			H2
		</button>
		<button type="button" title="Link" {disabled} on:mousedown|preventDefault={link}>Link</button>
		<button
			type="button"
			title="Bulleted list"
			{disabled}
			on:mousedown|preventDefault={() => exec('insertUnorderedList')}
		>
			List
		</button>
	</div>
	<div
		class="rich-body"
		bind:this={el}
		contenteditable={!disabled}
		role="textbox"
		aria-multiline="true"
		aria-label={ariaLabel}
		spellcheck="false"
		on:input={emit}
		on:paste={onPaste}
	></div>
</div>
