<script lang="ts">
	import { getContext } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { ownText } from '$lib/surface/attributes.js';
	import { reveal } from '$lib/selection/replaceSelection.js';
	import { labelsOf, tocEnglish } from '$lib/labels.js';
	import { keepSelection } from '../chrome.js';
	import { richTextHeadingLevel, tocViews, type TocEntryPayload } from './toc.js';

	/**
	 * The document's headings, live, in reading order (Notion's table of
	 * contents): read from the view's cells, so an edit anywhere re-renders
	 * only the entries it changes. Each entry scrolls its heading into view,
	 * opening the closed toggles it sits in; the selection stays. The app's
	 * `entry` and `empty` snippets draw them, else this markup.
	 */
	const edytor = getContext<Edytor>('edytor');
	const labels = labelsOf(edytor, 'toc', tocEnglish);
	const { headingLevel: level = richTextHeadingLevel, entry, empty } = tocViews.get(edytor) ?? {};

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

	const payloadOf = ({ id, level, text }: Entry): TocEntryPayload => ({
		id,
		level,
		depth: level - top,
		text,
		label: text || labels.untitled,
		go: () => go(id),
		attributes: {
			'data-edytor-toc-entry': '',
			'data-level': level,
			'data-untitled': text ? undefined : 'true',
			style: `--edytor-toc-depth: ${level - top}`,
			onmousedown: keepSelection,
			onclick: () => go(id)
		}
	});
</script>

{#if entries.length}
	{#each entries as found (found.id)}
		{@const payload = payloadOf(found)}
		{#if entry}{@render entry(payload)}{:else}<button type="button" {...payload.attributes}
				>{payload.label}</button
			>{/if}
	{/each}
{:else if empty}
	{@render empty({ label: labels.empty })}
{:else}
	<p data-edytor-toc-empty>{labels.empty}</p>
{/if}
