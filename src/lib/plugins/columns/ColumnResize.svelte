<script lang="ts">
	import { GUIDE, type ColumnResize } from './resize.svelte.js';

	/**
	 * The resize bands of the hovered layout and the guide of a drag
	 * (`ColumnResize`), in the overlay: each band the gap's left part, above
	 * the block handles (their `+` and grip together right of it, `gaps.ts`);
	 * hovered, it shows a gray guide in its middle: where the guide shows, a
	 * press resizes. A band is a focusable separator: its arrows resize
	 * (`resize.key`), focused it shows its guide in the resize color.
	 */
	let { resize }: { resize: ColumnResize } = $props();

	// The view turning readonly mid-drag drops the preview at once (round 4).
	$effect(() => {
		if (resize.readonly) resize.lock();
	});
</script>

<div role="presentation">
	{#if resize.shown}
		{#each resize.strips as strip (`${strip.left}|${strip.right}`)}
			<!-- A focusable separator is a widget (WAI-ARIA window splitter): its keys resize. -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
			<div
				data-edytor-column-resize
				data-left={strip.left}
				data-right={strip.right}
				role="separator"
				tabindex="0"
				aria-label="Resize columns"
				aria-orientation="vertical"
				aria-valuenow={strip.value}
				aria-valuemin="0"
				aria-valuemax="100"
				aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End"
				style:left="{strip.x}px"
				style:top="{strip.top}px"
				style:width="{strip.width}px"
				style:height="{strip.height}px"
				style:cursor="col-resize"
				style:--edytor-column-resize-guide-width="{GUIDE}px"
				data-dragging={resize.drag ? 'true' : undefined}
				data-selecting={resize.selecting ? 'true' : undefined}
				onpointerdown={(event) => resize.start(event, strip)}
				onmousedown={(event) => resize.mousedown(event, strip)}
				onkeydown={(event) => resize.key(event, strip)}
				onfocus={() => resize.focus(strip, true)}
				onblur={() => resize.focus(strip, false)}
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

	/* A text selection in progress: the band takes no pointer (and shows no guide). */
	[data-edytor-column-resize][data-selecting='true'] {
		pointer-events: none;
	}

	/* Notion's hover guide: a thin gray rule in the band's middle. */
	[data-edytor-column-resize]::after {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		left: calc(50% - var(--edytor-column-resize-guide-width) / 2);
		width: var(--edytor-column-resize-guide-width);
		background: var(--edytor-columns-resize-color, rgba(55, 53, 47, 0.16));
		opacity: 0;
		pointer-events: none;
		transition: opacity 80ms ease;
	}

	[data-edytor-column-resize]:hover:not([data-dragging='true'])::after {
		opacity: 1;
	}

	/* Focused from the keyboard: the guide shows in the resize color. */
	[data-edytor-column-resize]:focus-visible {
		outline: none;
	}
	[data-edytor-column-resize]:focus-visible::after {
		opacity: 1;
		background: var(--edytor-column-resize-color, rgba(35, 131, 226, 0.43));
	}

	/* Notion's resize line: a thin blue rule where the gap will be. */
	[data-edytor-column-resize-guide] {
		position: absolute;
		width: 2px;
		background: var(--edytor-column-resize-color, rgba(35, 131, 226, 0.43));
		pointer-events: none;
	}
</style>
