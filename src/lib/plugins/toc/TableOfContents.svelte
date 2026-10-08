<script lang="ts">
	import { getContext } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { ownText } from '$lib/surface/attributes.js';
	import { reveal } from '$lib/selection/replaceSelection.js';
	import type { TocHeadingLevel } from './toc.js';

	/**
	 * The document's headings, live, in reading order (Notion's table of
	 * contents): read from the view's cells, so an edit anywhere re-renders
	 * only the entries it changes. Each entry scrolls its heading into view,
	 * opening the closed toggles it sits in; the selection stays.
	 */
	let { level }: { level: TocHeadingLevel } = $props();
	const edytor = getContext<Edytor>('edytor');

	type Entry = { id: string; level: number; text: string };
	const entries = $derived.by(() => {
		const cells = edytor.cells;
		const found: Entry[] = [];
		const walk = (ids: readonly string[]) => {
			for (const id of ids) {
				const cell = cells?.get(id);
				if (!cell) continue;
				const depth = level({ type: cell.type, data: cell.data ?? {} });
				if (depth) found.push({ id, level: depth, text: ownText(cell.runs).trim() });
				walk(cell.childIds);
			}
		};
		walk(cells?.rootIds ?? []);
		return found;
	});
	/** The shallowest level shown: it sits at the start, deeper ones one step in per level. */
	const top = $derived(Math.min(...entries.map((entry) => entry.level)));

	const go = (id: string) => {
		const block = edytor.idToBlock.get(id);
		if (!block?.node) return;
		reveal(block);
		block.node.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
	};
</script>

{#if entries.length}
	{#each entries as entry (entry.id)}
		<button
			type="button"
			data-edytor-toc-entry
			data-level={entry.level}
			data-untitled={entry.text ? undefined : 'true'}
			style:--edytor-toc-depth={entry.level - top}
			onmousedown={(event) => event.preventDefault()}
			onclick={() => go(entry.id)}>{entry.text || 'Untitled'}</button
		>
	{/each}
{:else}
	<p data-edytor-toc-empty>Add headings to create a table of contents.</p>
{/if}

<style>
	/*
	 * The entries' structure, at zero specificity (`:where`): one line each,
	 * one nesting step in per level; a theme draws them (`themes/notion.css`).
	 */
	:global(:where([data-edytor-toc-entry])) {
		display: block;
		width: 100%;
		margin: 0;
		padding: 0;
		padding-inline-start: calc(var(--edytor-toc-depth, 0) * var(--edytor-nest-indent, 24px));
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-align: start;
		cursor: pointer;
	}
	:global(:where([data-edytor-toc-empty])) {
		margin: 0;
		opacity: 0.6;
	}
</style>
