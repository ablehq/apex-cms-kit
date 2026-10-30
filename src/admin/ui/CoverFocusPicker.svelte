<!--
	The cover's FOCUS POINT: the spot that has to stay in view when the site crops
	the cover to a frame of a different shape (`cms/cover-focus.js`).

	The editor clicks (or drags, or uses the arrow keys; Shift moves 10) on the
	whole, uncropped photo; the dot is the focus. Underneath, each frame the SITE
	says it crops this cover to (`frames`, width ÷ height, e.g. a card at 4 / 3 and
	a full-width banner at 1440 / 552) is drawn with the same `object-fit: cover` +
	`object-position` a page uses, so what the editor sees here is what the page
	will show. The widest frame's visible strip is also outlined on the photo.

	It holds no state: `focus` comes from the post draft and every move goes to
	`onChange`, which a post editor wires to `setPostCoverFocus` (`admin/post-draft.js`).
	The focus is two whole percentages from the top-left, or `null` for the centre.

	Styling: the shared admin classes for the readout's button (`.btn`, `.btn-sm`,
	`.btn-quiet`) and the shared tokens (`--rule`, `--sunk`, `--ink`, `--ink-soft`,
	`--ink-faint`). The scoped rules below are only what the admin stylesheet has no
	class for: the photo stage, the dot, the dimmed area outside the strip and the
	grid of crop previews.
-->
<script>
	/** The cover image URL. */
	export let src;
	/** @type {{ x: number, y: number } | null} */
	export let focus = null;
	export let disabled = false;
	/**
	 * The frames the site crops this cover to, as width ÷ height.
	 * @type {{ label: string, ratio: number }[]}
	 */
	export let frames = [];
	/** @type {(focus: { x: number, y: number } | null) => void} */
	export let onChange = () => {};

	/** @type {HTMLImageElement | undefined} */
	let photo;
	/** The photo's own width ÷ height, once it has loaded. */
	let photoRatio = 0;
	let dragging = false;

	$: point = focus ?? { x: 50, y: 50 };
	$: position = `${point.x}% ${point.y}%`;
	$: widest = frames.reduce(
		(best, frame) => (!best || frame.ratio > best.ratio ? frame : best),
		/** @type {{ label: string, ratio: number } | null} */ (null)
	);
	$: band = widest && photoRatio ? visibleBand(photoRatio, widest.ratio, point) : null;

	/** @param {number} n */
	const clamp = (n) => Math.min(100, Math.max(0, Math.round(n)));

	/**
	 * The part of the photo a frame shows, in percent of the photo, under
	 * `object-fit: cover` with `object-position: x% y%`: the image is scaled to fill
	 * the frame, and the overflow is split so the point at x% of the photo sits at x%
	 * of the frame.
	 * @param {number} photo the photo's width ÷ height
	 * @param {number} frame the frame's width ÷ height
	 * @param {{ x: number, y: number }} at
	 */
	function visibleBand(photo, frame, at) {
		if (frame >= photo) {
			const height = (photo / frame) * 100;
			return { left: 0, width: 100, top: ((100 - height) * at.y) / 100, height };
		}
		const width = (frame / photo) * 100;
		return { top: 0, height: 100, left: ((100 - width) * at.x) / 100, width };
	}

	/** @param {PointerEvent} event */
	function pointAt(event) {
		if (!photo) return;
		const rect = photo.getBoundingClientRect();
		if (!rect.width || !rect.height) return;
		onChange({
			x: clamp(((event.clientX - rect.left) / rect.width) * 100),
			y: clamp(((event.clientY - rect.top) / rect.height) * 100)
		});
	}

	/** @param {PointerEvent & { currentTarget: HTMLButtonElement }} event */
	function onPointerDown(event) {
		if (disabled || event.button !== 0) return;
		dragging = true;
		event.currentTarget.setPointerCapture(event.pointerId);
		pointAt(event);
	}

	/** @param {PointerEvent} event */
	function onPointerMove(event) {
		if (dragging) pointAt(event);
	}

	function onPointerEnd() {
		dragging = false;
	}

	/** @param {KeyboardEvent} event */
	function onKeydown(event) {
		if (disabled) return;
		const step = event.shiftKey ? 10 : 1;
		/** @type {Record<string, [number, number]>} */
		const moves = {
			ArrowLeft: [-step, 0],
			ArrowRight: [step, 0],
			ArrowUp: [0, -step],
			ArrowDown: [0, step]
		};
		const move = moves[event.key];
		if (!move) return;
		event.preventDefault();
		onChange({ x: clamp(point.x + move[0]), y: clamp(point.y + move[1]) });
	}

	function onPhotoLoad() {
		if (photo?.naturalWidth && photo.naturalHeight) {
			photoRatio = photo.naturalWidth / photo.naturalHeight;
		}
	}
</script>

<div class="cf">
	<button
		type="button"
		class="cf-stage"
		class:dragging
		{disabled}
		aria-label="Focus point, {point.x}% across and {point.y}% down. Click the photo or use the arrow keys to move it."
		on:pointerdown={onPointerDown}
		on:pointermove={onPointerMove}
		on:pointerup={onPointerEnd}
		on:pointercancel={onPointerEnd}
		on:keydown={onKeydown}
	>
		<img bind:this={photo} {src} alt="" draggable="false" on:load={onPhotoLoad} />
		{#if band}
			<span
				class="cf-band"
				style:left="{band.left}%"
				style:top="{band.top}%"
				style:width="{band.width}%"
				style:height="{band.height}%"
				aria-hidden="true"
			></span>
		{/if}
		<span class="cf-dot" style:left="{point.x}%" style:top="{point.y}%" aria-hidden="true"></span>
	</button>

	<div class="cf-read">
		<span>
			{#if focus}
				Focus: {focus.x}% across, {focus.y}% down
			{:else}
				Focus: centre
			{/if}
			{#if band && widest}
				<span class="cf-key">· the outlined strip is what a {widest.label.toLowerCase()} shows</span
				>
			{/if}
		</span>
		{#if focus}
			<button class="btn btn-sm btn-quiet" type="button" {disabled} on:click={() => onChange(null)}>
				Reset to centre
			</button>
		{/if}
	</div>

	{#if frames.length > 0}
		<div class="cf-frames">
			{#each frames as frame (frame.label)}
				<figure class="cf-frame">
					<div class="cf-crop" style:aspect-ratio={frame.ratio}>
						<img {src} alt="" draggable="false" style:object-position={position} />
					</div>
					<figcaption>{frame.label}</figcaption>
				</figure>
			{/each}
		</div>
	{/if}
</div>

<style>
	.cf {
		margin-top: 0.9rem;
	}
	.cf-stage {
		position: relative;
		display: inline-block;
		max-width: 100%;
		padding: 0;
		border: 1px solid var(--rule);
		border-radius: 3px;
		background: var(--sunk);
		overflow: hidden;
		cursor: crosshair;
		touch-action: none;
		line-height: 0;
	}
	.cf-stage:disabled {
		cursor: default;
		opacity: 0.7;
	}
	.cf-stage:focus-visible {
		outline: 2px solid var(--ink);
		outline-offset: 2px;
	}
	.cf-stage img {
		display: block;
		max-width: 100%;
		max-height: 360px;
		width: auto;
		height: auto;
		user-select: none;
		pointer-events: none;
	}
	/* Everything outside the widest frame's strip is dimmed. */
	.cf-band {
		position: absolute;
		box-shadow: 0 0 0 9999px rgba(20, 20, 20, 0.38);
		outline: 1px dashed rgba(255, 255, 255, 0.9);
		pointer-events: none;
	}
	.cf-dot {
		position: absolute;
		width: 22px;
		height: 22px;
		border: 2px solid #fff;
		border-radius: 50%;
		background: rgba(20, 20, 20, 0.25);
		box-shadow:
			0 0 0 1px rgba(20, 20, 20, 0.6),
			0 1px 4px rgba(20, 20, 20, 0.5);
		transform: translate(-50%, -50%);
		pointer-events: none;
	}
	.dragging .cf-dot {
		width: 26px;
		height: 26px;
	}
	.cf-read {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.4rem 0.8rem;
		margin-top: 0.45rem;
		color: var(--ink-soft);
		font-size: 13px;
	}
	.cf-key {
		color: var(--ink-faint);
	}
	.cf-frames {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 0.9rem;
		margin-top: 0.9rem;
	}
	.cf-frame {
		margin: 0;
	}
	.cf-crop {
		width: 100%;
		overflow: hidden;
		border-radius: 2px;
		background: var(--sunk);
	}
	.cf-crop img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.cf-frame figcaption {
		margin-top: 0.3rem;
		color: var(--ink-faint);
		font-size: 12px;
		line-height: 1.35;
	}
</style>
