<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ImageControls } from './controls.svelte.js';

	/**
	 * The image chrome (`ImageControls`), in the overlay: a resize handle on
	 * each side of the hovered image (Notion's pill, at mid-height), and the
	 * plugin's `toolbar` snippet at its top right (the alignments, the alt
	 * text field). The toolbar's role and marks (`bar`) and the alt field's
	 * keys and focus (`altField`) are the controller's attachments.
	 */
	let { controls, toolbar }: { controls: ImageControls; toolbar?: Snippet<[ImageControls]> } =
		$props();

	// The view turning readonly mid-drag drops the preview at once.
	$effect(() => {
		if (controls.readonly) controls.lock();
	});
	// The selected image changed: the chrome measures again.
	$effect(() => {
		void controls.selected;
		controls.invalidate();
	});

	/** The handle's hit box: 16px wide, inside the image's edge. */
	const HANDLE = 16;
</script>

<div role="presentation">
	{#if controls.shown && controls.box}
		{@const box = controls.box}
		<!-- The toolbar and the alt panel hang from the image's top right corner. -->
		{@const right = `${box.x + box.width - 6}px`}
		{#each ['left', 'right'] as const as side (side)}
			<div
				data-edytor-image-resize={side}
				aria-hidden="true"
				style:left="{side === 'left' ? box.x : box.x + box.width - HANDLE}px"
				style:top="{box.y}px"
				style:width="{HANDLE}px"
				style:height="{box.height}px"
				data-dragging={controls.drag ? 'true' : undefined}
				data-selecting={controls.selecting ? 'true' : undefined}
				{@attach controls.band.press((event) => controls.start(event, side))}
			></div>
		{/each}
		{#if !controls.drag && toolbar}
			<div
				data-edytor-image-toolbar-slot
				style:left={right}
				style:top="{box.y + 6}px"
				data-selecting={controls.selecting ? 'true' : undefined}
			>
				{@render toolbar(controls)}
			</div>
		{/if}
	{/if}
</div>

<style>
	[data-edytor-image-resize] {
		position: absolute;
		cursor: col-resize;
		touch-action: none;
	}

	/* A text selection in progress: the chrome takes no pointer. */
	[data-selecting='true'] {
		pointer-events: none;
	}

	/* Notion's handle: a dark pill with a light ring, at mid-height, inside the edge. */
	[data-edytor-image-resize]::after {
		content: '';
		position: absolute;
		top: 50%;
		left: 5px;
		width: 6px;
		height: min(48px, 50%);
		transform: translateY(-50%);
		border-radius: 20px;
		background: var(--edytor-image-handle-color, rgba(15, 15, 15, 0.6));
		box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.9);
		opacity: 0.8;
	}

	[data-edytor-image-resize]:hover::after,
	[data-edytor-image-resize][data-dragging='true']::after {
		opacity: 1;
	}

	/* The toolbar's place: the image's top right, sized to its markup. */
	[data-edytor-image-toolbar-slot] {
		position: absolute;
		width: max-content;
		transform: translateX(-100%);
	}
</style>
