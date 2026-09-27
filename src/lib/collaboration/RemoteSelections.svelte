<script lang="ts">
	import { onMount } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import {
		getRenderedRemoteSelections,
		type RenderedRemoteSelection,
		type RemoteSelectionRect
	} from './remoteSelection.js';

	let { edytor }: { edytor: Edytor } = $props();

	let presenceRevision = $state(0);
	const selections: RenderedRemoteSelection[] = $derived.by(() => {
		void presenceRevision;
		return getRenderedRemoteSelections(edytor);
	});

	const rectStyle = (rect: RemoteSelectionRect, color: string) =>
		`left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:${color};`;

	const cursorStyle = (rect: RemoteSelectionRect, color: string) =>
		`left:${rect.left}px;top:${rect.top}px;height:${rect.height}px;background:${color};`;

	const rectKey = (rect: RemoteSelectionRect) =>
		`${rect.left}:${rect.top}:${rect.width}:${rect.height}`;

	const refresh = () => {
		presenceRevision += 1;
	};

	onMount(() => {
		// U8a — 'change' only: it fires exactly when a presence map entry is
		// added/removed/deep-changed, while 'update' additionally fires on
		// clock-only heartbeat refreshes AND (locally) on every setLocalState
		// — subscribing to both recomputed geometry twice per real change.
		// 'change' is the minimal sufficient signal; doc 'update' covers
		// remote edits moving the anchors we resolve.
		edytor.awareness.on('change', refresh);
		edytor.doc.on('update', refresh);
		refresh();

		return () => {
			edytor.awareness.off('change', refresh);
			edytor.doc.off('update', refresh);
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
		inset: 0;
		pointer-events: none;
		position: fixed;
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
