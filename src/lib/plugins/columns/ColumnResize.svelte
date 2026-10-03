<script lang="ts">
	import { STRIP, type ColumnResize } from './resize.svelte.js';

	/**
	 * The resize strips of the hovered layout and the guide of a drag
	 * (`ColumnResize`), in the overlay: each strip at the left of its gap,
	 * the grips at its right.
	 */
	let { resize }: { resize: ColumnResize } = $props();
</script>

<div
	bind:this={resize.host}
	onpointerleave={(event) => !resize.drag && resize.leave(event.relatedTarget)}
	role="presentation"
>
	{#if resize.shown}
		{#each resize.strips as strip (`${strip.left}|${strip.right}`)}
			<div
				data-edytor-column-resize
				data-left={strip.left}
				data-right={strip.right}
				aria-hidden="true"
				style:left="{strip.x}px"
				style:top="{strip.top}px"
				style:width="{STRIP}px"
				style:height="{strip.height}px"
				style:cursor="col-resize"
				onpointerdown={(event) => resize.start(event, strip)}
				onmousedown={(event) => event.preventDefault()}
			></div>
		{/each}
	{/if}
	{#if resize.guide}
		<div
			data-edytor-column-resize-guide
			aria-hidden="true"
			style:left="{resize.guide.x}px"
			style:top="{resize.guide.top}px"
			style:height="{resize.guide.height}px"
		></div>
	{/if}
</div>

<style>
	[data-edytor-column-resize] {
		position: absolute;
		touch-action: none;
	}

	/* Notion's resize line: a thin blue rule where the gap will be. */
	[data-edytor-column-resize-guide] {
		position: absolute;
		width: 2px;
		background: var(--edytor-column-resize-color, rgba(35, 131, 226, 0.43));
		pointer-events: none;
	}
</style>
