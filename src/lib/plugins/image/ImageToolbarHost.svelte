<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ImageToolbar } from './toolbar.svelte.js';

	/**
	 * The image toolbar's place: the app's `toolbar` at the top right of the
	 * image the chrome is on, while it shows and no handle drags.
	 */
	let { toolbar, snippet }: { toolbar: ImageToolbar; snippet: Snippet<[ImageToolbar]> } = $props();
	const controls = $derived(toolbar.controls);
</script>

{#if controls.shown && controls.box && !controls.drag}
	{@const box = controls.box}
	<div
		data-edytor-image-toolbar-slot
		style:left="{box.x + box.width - 6}px"
		style:top="{box.y + 6}px"
		data-selecting={controls.selecting ? 'true' : undefined}
	>
		{@render snippet(toolbar)}
	</div>
{/if}

<style>
	/* The toolbar's place: the image's top right, sized to its markup. */
	[data-edytor-image-toolbar-slot] {
		position: absolute;
		width: max-content;
		transform: translateX(-100%);
	}

	/* A text selection in progress: the chrome takes no pointer. */
	[data-selecting='true'] {
		pointer-events: none;
	}
</style>
