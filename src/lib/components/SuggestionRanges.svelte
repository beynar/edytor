<script lang="ts">
	import { onMount } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { SuggestionRange } from '$lib/session/suggestions.svelte.js';
	import { rangeRects, type RemoteSelectionRect } from '$lib/collaboration/remoteSelection.js';

	let { edytor }: { edytor: Edytor } = $props();

	/**
	 * The text a `replace` suggestion removes when accepted, marked in the
	 * overlay (R11: never inside the host): its rects, once per frame.
	 */
	let rects: RemoteSelectionRect[] = $state([]);

	onMount(() => {
		const off = edytor.overlay.add((origin) => {
			const next = edytor.suggestions.list.flatMap(({ at }) => {
				if (!('replace' in at) || Array.isArray(at.replace)) return [];
				const { anchor, focus } = at.replace as SuggestionRange;
				const [a, b] = [anchor, focus].map(edytor.selection.resolveTextAnchor);
				return a && b ? rangeRects(edytor, a, b, origin) : [];
			});
			if (next.length || rects.length) return () => (rects = next);
		});
		return off;
	});
	$effect(() => {
		void edytor.suggestions.revision;
		edytor.overlay.invalidate();
	});
</script>

<div data-edytor-suggestion-ranges contenteditable="false" aria-hidden="true">
	{#each rects as rect, index (index)}
		<span
			data-edytor-suggestion-range
			style:left={`${rect.left}px`}
			style:top={`${rect.top}px`}
			style:width={`${rect.width}px`}
			style:height={`${rect.height}px`}
		></span>
	{/each}
</div>

<style>
	[data-edytor-suggestion-ranges] {
		position: absolute;
		left: 0;
		top: 0;
		pointer-events: none;
		z-index: 19;
	}
	[data-edytor-suggestion-range] {
		position: absolute;
		background: var(--edytor-suggestion-removed, rgb(235 87 87 / 0.18));
		border-bottom: 1px solid var(--edytor-suggestion-removed-line, rgb(235 87 87 / 0.6));
	}
</style>
