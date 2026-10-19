<script lang="ts" module>
	import type { PresencePoint } from '$lib/collaboration/awarenessSelection.js';
	import type { Edytor } from '$lib/edytor.svelte.js';

	/** A run of text the overlay marks: its ends, and whether it is the current one (`data-current`). */
	export type MarkedRange = { start: PresencePoint; end: PresencePoint; current?: boolean };

	/** The run of `length` at block offset `offset` of block `id` (none where it is not shown). */
	export const runOf = (
		edytor: Edytor,
		id: string,
		offset: number,
		length: number,
		current?: boolean
	): MarkedRange[] => {
		const block = edytor.idToBlock.get(id);
		const [start, end] = [block?.textAtOffset(offset), block?.textAtOffset(offset + length)];
		return start && end ? [{ start, end, current }] : [];
	};
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { rangeRects, type RemoteSelectionRect } from '$lib/collaboration/remoteSelection.js';

	/**
	 * Runs of text marked in the overlay (never inside the host), one
	 * rectangle per line box, measured once per frame: the find matches, the
	 * text a `replace` suggestion removes, the comment being written. Each
	 * rectangle carries `data-edytor-<name>` (`data-current` on the current
	 * run's); the layer is `z`.
	 */
	let {
		edytor,
		name,
		z,
		ranges
	}: { edytor: Edytor; name: string; z: number; ranges: () => MarkedRange[] } = $props();

	let rects: (RemoteSelectionRect & { current?: boolean })[] = $state([]);

	onMount(() =>
		edytor.overlay.add((origin) => {
			const next = ranges().flatMap(({ start, end, current }) =>
				rangeRects(edytor, start, end, origin).map((rect) => ({ ...rect, current }))
			);
			if (next.length || rects.length) return () => (rects = next);
		})
	);
	// What the runs read changed: the overlay measures again.
	$effect(() => {
		void ranges();
		edytor.overlay.invalidate();
	});
</script>

<div data-edytor-ranges={name} contenteditable="false" aria-hidden="true" style:z-index={z}>
	{#each rects as rect, index (index)}
		<span
			{...{ [`data-edytor-${name}`]: '' }}
			data-current={rect.current || undefined}
			style:left={`${rect.left}px`}
			style:top={`${rect.top}px`}
			style:width={`${rect.width}px`}
			style:height={`${rect.height}px`}
		></span>
	{/each}
</div>

<style>
	[data-edytor-ranges] {
		position: absolute;
		left: 0;
		top: 0;
		pointer-events: none;
	}
	[data-edytor-ranges] > span {
		position: absolute;
	}
	:global([data-edytor-find-match]) {
		border-radius: 2px;
		background: var(--edytor-find-match, rgb(255 212 0 / 0.3));
		mix-blend-mode: multiply;
	}
	:global([data-edytor-find-match][data-current]) {
		background: var(--edytor-find-current, rgb(255 166 0 / 0.55));
	}
	:global([data-edytor-suggestion-range]) {
		background: var(--edytor-suggestion-removed, rgb(235 87 87 / 0.18));
		border-bottom: 1px solid var(--edytor-suggestion-removed-line, rgb(235 87 87 / 0.6));
	}
	:global([data-edytor-comment-draft]) {
		background: var(--edytor-comment-active, rgb(255 212 0 / 0.42));
		mix-blend-mode: multiply;
	}
</style>
