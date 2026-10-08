<script lang="ts">
	import { onMount } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { rangeRects, type RemoteSelectionRect } from '$lib/collaboration/remoteSelection.js';
	import { hidden } from '$lib/selection/visibility.js';
	import type { FindController } from './FindController.svelte.js';

	let { edytor, find }: { edytor: Edytor; find: FindController } = $props();

	/** Matches highlighted at most: past it, the count still tells. */
	const MAX_HIGHLIGHTS = 1000;

	type Highlight = RemoteSelectionRect & { current: boolean };

	/**
	 * Each shown match's rects, in the overlay (never inside the host),
	 * measured once per frame. A match in a closed toggle's body shows none
	 * until it is current, which opens the toggle.
	 */
	let rects: Highlight[] = $state([]);

	onMount(() =>
		edytor.overlay.add((origin) => {
			const next: Highlight[] = [];
			const { matches, current } = find;
			for (let index = 0; index < matches.length && index < MAX_HIGHLIGHTS; index++) {
				const { block: id, offset, length } = matches[index]!;
				const block = edytor.idToBlock.get(id);
				if (!block || hidden(block)) continue;
				const [start, end] = [block.textAtOffset(offset), block.textAtOffset(offset + length)];
				if (!start || !end) continue;
				for (const rect of rangeRects(edytor, start, end, origin))
					next.push({ ...rect, current: index === current });
			}
			if (next.length || rects.length) return () => (rects = next);
		})
	);
	$effect(() => {
		void find.matches;
		void find.current;
		edytor.overlay.invalidate();
	});
</script>

<div data-edytor-find-matches contenteditable="false" aria-hidden="true">
	{#each rects as rect, index (index)}
		<span
			data-edytor-find-match
			data-current={rect.current || undefined}
			style:left={`${rect.left}px`}
			style:top={`${rect.top}px`}
			style:width={`${rect.width}px`}
			style:height={`${rect.height}px`}
		></span>
	{/each}
</div>

<style>
	[data-edytor-find-matches] {
		position: absolute;
		left: 0;
		top: 0;
		pointer-events: none;
		z-index: 18;
	}
	[data-edytor-find-match] {
		position: absolute;
		border-radius: 2px;
		background: var(--edytor-find-match, rgb(255 212 0 / 0.3));
		mix-blend-mode: multiply;
	}
	[data-edytor-find-match][data-current] {
		background: var(--edytor-find-current, rgb(255 166 0 / 0.55));
	}
</style>
