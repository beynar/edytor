<script lang="ts">
	import { onMount } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import {
		getRenderedRemoteSelections,
		type RenderedRemoteSelection,
		type RemoteSelectionRect
	} from './remoteSelection.js';

	let { edytor }: { edytor: Edytor } = $props();

	/** The peers' carets and ranges, positioned by the overlay once per frame. */
	let selections: RenderedRemoteSelection[] = $state([]);

	const rectStyle = (rect: RemoteSelectionRect, color: string) =>
		`left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:${color};`;

	const cursorStyle = (rect: RemoteSelectionRect, color: string) =>
		`left:${rect.left}px;top:${rect.top}px;height:${rect.height}px;background:${color};`;

	const rectKey = (rect: RemoteSelectionRect) =>
		`${rect.left}:${rect.top}:${rect.width}:${rect.height}`;

	onMount(() => {
		// A peer change ('change': an entry added, removed or changed) repositions;
		// commits, resizes and scrolls reach the overlay on their own.
		const off = edytor.overlay.add((origin) => {
			const next = getRenderedRemoteSelections(edytor, origin);
			if (next.length || selections.length) return () => (selections = next);
		});
		edytor.awareness.on('change', edytor.overlay.invalidate);
		return () => {
			off();
			edytor.awareness.off('change', edytor.overlay.invalidate);
		};
	});
</script>

<div data-edytor-remote-presence contenteditable="false" aria-hidden="true">
	{#each selections as selection (selection.clientId)}
		{#each selection.rects as rect, rectIndex (`${rectIndex}:${rectKey(rect)}`)}
			<span
				data-edytor-remote-selection
				data-client-id={selection.clientId}
				style={rectStyle(rect, selection.color)}
			></span>
		{/each}
		<span
			data-edytor-remote-cursor
			data-edytor-remote-block={selection.block ? '' : undefined}
			data-client-id={selection.clientId}
			style={cursorStyle(selection.cursor, selection.color)}
		>
			{#if selection.label}
				<span data-edytor-remote-cursor-label style:background={selection.color}>
					{selection.label}
				</span>
			{/if}
		</span>
	{/each}
</div>

<style>
	[data-edytor-remote-presence] {
		left: 0;
		top: 0;
		pointer-events: none;
		position: absolute;
		z-index: 20;
	}

	[data-edytor-remote-selection] {
		opacity: 0.18;
		position: absolute;
	}

	[data-edytor-remote-cursor] {
		border-radius: 999px;
		position: absolute;
		width: 2px;
	}

	[data-edytor-remote-cursor-label] {
		border-radius: 999px;
		color: white;
		font: 500 11px/1.4 sans-serif;
		left: 0;
		padding: 1px 6px;
		position: absolute;
		top: -1.6em;
		transform: translateX(-1px);
		white-space: nowrap;
	}
</style>
