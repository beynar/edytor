<script lang="ts">
	import { onMount } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { hidden } from '$lib/selection/visibility.js';
	import { renderSkipped } from '$lib/surface/overlay.js';
	import type { VersionChange } from './diff.js';

	let { edytor, changes }: { edytor: Edytor; changes: () => ReadonlyMap<string, VersionChange> } =
		$props();

	/** Blocks highlighted at most: past it, the panel's counts still tell. */
	const MAX_HIGHLIGHTS = 2000;
	/** The tint starts this far left of the block, so its bar clears the text. */
	const OUTSET = 6;

	type Highlight = {
		id: string;
		change: VersionChange;
		left: number;
		top: number;
		width: number;
		height: number;
	};

	/**
	 * Each differing block's own row (its box down to where its children
	 * begin), in the overlay (never inside the host), measured once per
	 * frame. A block in a closed toggle's body, or one the browser does not
	 * render, shows none.
	 */
	let rows: Highlight[] = $state([]);

	onMount(() =>
		edytor.overlay.add((origin) => {
			const next: Highlight[] = [];
			for (const [id, change] of changes()) {
				if (next.length >= MAX_HIGHLIGHTS) break;
				const block = edytor.idToBlock.get(id);
				const node = block?.node;
				if (!block || !node || hidden(block) || renderSkipped(node)) continue;
				const rect = node.getBoundingClientRect();
				const children = node.querySelector(':scope > [data-edytor-children]');
				const bottom = children ? children.getBoundingClientRect().top : rect.bottom;
				if (rect.width === 0 && rect.height === 0) continue;
				next.push({
					id,
					change,
					left: rect.left - origin.left - OUTSET,
					top: rect.top - origin.top,
					width: rect.width + OUTSET,
					height: Math.max(0, bottom - rect.top)
				});
			}
			if (next.length || rows.length) return () => (rows = next);
		})
	);
	$effect(() => {
		void changes();
		edytor.overlay.invalidate();
	});
</script>

<div data-edytor-version-changes contenteditable="false" aria-hidden="true">
	{#each rows as row (row.id)}
		<span
			data-edytor-version-change={row.change}
			data-block-id={row.id}
			style:left={`${row.left}px`}
			style:top={`${row.top}px`}
			style:width={`${row.width}px`}
			style:height={`${row.height}px`}
		></span>
	{/each}
</div>

<style>
	[data-edytor-version-changes] {
		position: absolute;
		left: 0;
		top: 0;
		pointer-events: none;
		z-index: 17;
	}
	[data-edytor-version-change] {
		position: absolute;
		border-radius: 3px;
		mix-blend-mode: multiply;
		box-shadow: inset 3px 0 0 var(--edytor-version-bar);
		background: var(--edytor-version-tint);
	}
	[data-edytor-version-change='added'] {
		--edytor-version-bar: var(--edytor-version-added-bar, rgb(68 131 97));
		--edytor-version-tint: var(--edytor-version-added, rgb(68 131 97 / 0.12));
	}
	[data-edytor-version-change='removed'] {
		--edytor-version-bar: var(--edytor-version-removed-bar, rgb(212 76 71));
		--edytor-version-tint: var(--edytor-version-removed, rgb(212 76 71 / 0.12));
	}
	[data-edytor-version-change='changed'] {
		--edytor-version-bar: var(--edytor-version-changed-bar, rgb(203 145 47));
		--edytor-version-tint: var(--edytor-version-changed, rgb(203 145 47 / 0.14));
	}
</style>
