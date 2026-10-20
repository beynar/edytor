<script lang="ts">
	import { onMount } from 'svelte';
	import { rangeRects, type RemoteSelectionRect } from '$lib/collaboration/remoteSelection.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { SharedSuggestionsController } from './shared.svelte.js';

	/**
	 * A shared suggestion's pending runs in the overlay (`sugg.view.runs`),
	 * one rectangle per line box, measured once per frame: each inserted run
	 * carries `data-edytor-suggestion-inserted`, each deleted one
	 * `data-edytor-suggestion-deleted`, in its author's colour
	 * (`--edytor-range-color`).
	 */
	let { edytor, shared }: { edytor: Edytor; shared: SharedSuggestionsController } = $props();

	type Run = RemoteSelectionRect & { kind: string; color?: string };
	let rects: Run[] = $state([]);

	const runs = () =>
		shared.changes().flatMap((c) => {
			const block = edytor.idToBlock.get(c.block);
			const [start, end] = [
				block?.textAtOffset(c.offset),
				block?.textAtOffset(c.offset + c.length)
			];
			return c.length && start && end && (c.kind === 'insert' || c.kind === 'delete')
				? [
						{
							start,
							end,
							kind: c.kind === 'insert' ? 'inserted' : 'deleted',
							color: shared.colorOf(c.suggestion)
						}
					]
				: [];
		});

	onMount(() =>
		edytor.overlay.add((origin) => {
			const next = runs().flatMap(({ start, end, kind, color }) =>
				rangeRects(edytor, start, end, origin).map((rect) => ({ ...rect, kind, color }))
			);
			if (next.length || rects.length) return () => (rects = next);
		})
	);
	// What the runs read changed: the overlay measures again.
	$effect(() => {
		void runs();
		edytor.overlay.invalidate();
	});
</script>

<div data-edytor-suggestion-runs contenteditable="false" aria-hidden="true">
	{#each rects as rect, index (index)}
		<span
			{...{ [`data-edytor-suggestion-${rect.kind}`]: '' }}
			style:left={`${rect.left}px`}
			style:top={`${rect.top}px`}
			style:width={`${rect.width}px`}
			style:height={`${rect.height}px`}
			style:--edytor-range-color={rect.color}
		></span>
	{/each}
</div>

<style>
	[data-edytor-suggestion-runs] {
		position: absolute;
		left: 0;
		top: 0;
		z-index: 19;
		pointer-events: none;
	}
	[data-edytor-suggestion-runs] > span {
		position: absolute;
	}
</style>
