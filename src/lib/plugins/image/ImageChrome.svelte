<script lang="ts">
	import type { ImageControls } from './controls.svelte.js';

	/**
	 * The image chrome (`ImageControls`), in the overlay: a resize handle on
	 * each side of the hovered image (Notion's pill, at mid-height), and the
	 * image toolbar plugin's toolbar (the app's markup) at its top right,
	 * while no handle drags.
	 */
	let { controls }: { controls: ImageControls } = $props();

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
		{#if controls.toolbar && !controls.drag}
			<div
				data-edytor-image-toolbar-slot
				style:left="{box.x + box.width - 6}px"
				style:top="{box.y + 6}px"
				data-selecting={controls.selecting ? 'true' : undefined}
			>
				{@render controls.toolbar.snippet(controls.toolbar)}
			</div>
		{/if}
	{/if}
</div>

<style>
	/* The toolbar's place: the image's top right, sized to its markup. */
	[data-edytor-image-toolbar-slot] {
		position: absolute;
		width: max-content;
		transform: translateX(-100%);
	}

	[data-edytor-image-resize] {
		position: absolute;
		cursor: col-resize;
		touch-action: none;
	}

	/* A text selection in progress: the chrome takes no pointer. */
	[data-selecting='true'] {
		pointer-events: none;
	}

	/* The handle's pill: at mid-height, inside the edge. Painted by a theme
	 * (`edytor/themes/notion.css`: Notion's dark pill with a light ring). */
	[data-edytor-image-resize]::after {
		content: '';
		position: absolute;
		top: 50%;
		left: 5px;
		width: 6px;
		height: min(48px, 50%);
		transform: translateY(-50%);
	}
</style>
