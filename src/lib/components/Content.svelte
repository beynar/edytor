<script lang="ts">
	import { getContext } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { ReadonlyText } from './readonlyElements.svelte.js';
	import type { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
	import { placeholderOf, segmentDeltas, type Part, type Segment } from '$lib/surface/cells.js';
	import RenderText from './Text.svelte';
	import RenderInlineBlock from './InlineBlock.svelte';

	let {
		id,
		onrender
	}: {
		id: string;
		/** Dev check (O22): told when the kind's snippet rendered `content()`. */
		onrender?: () => void;
	} = $props();

	// Called once per mount: the kind's snippet rendered `content()`.
	(() => onrender?.())();

	const edytor = getContext<Edytor>('edytor');
	const cell = $derived(edytor.cells?.get(id));
	/** The cell's segments and atoms — the frozen list while the IME pin holds this cell. */
	const parts = $derived(cell ? edytor.pin.parts(cell) : []);
	/** Each part with its text ordinal (the wrapper operations still use, R3/R4). */
	const items = $derived.by(() => {
		let ordinal = 0;
		return parts.map((part) => ({ part, ordinal: part.kind === 'text' ? ordinal++ : -1 }));
	});
	/** Bumped only by the observer's repair of foreign damage: re-creates the text elements. */
	const epoch = $derived(edytor.cells?.epoch(id) ?? 0);
	const transform = $derived(cell && edytor.getBlockDefinition('block', cell.type).transformText);
	// The placeholder is withheld only in the block a composition is in (§2.4).
	const placeholder = $derived(
		cell ? placeholderOf(cell, edytor.composition.host?.parent.id === id) : false
	);

	/** Segments are keyed causally (the preceding atom's id, or `start`), never by ordinal. */
	const keyOf = ({ part }: { part: Part }) =>
		part.kind === 'text' ? `s:${part.key}:${epoch}` : `a:${part.id}`;

	const view = (segment: Segment) =>
		edytor.pin.render(id, segment.key) ?? {
			deltas: segmentDeltas(cell!, segment, transform),
			empty: segment.text === ''
		};

	// Suggestions are session state (L12): ghost text through the readonly wrappers (R5 → view objects).
	const suggestions = $derived(edytor.idToBlock.get(id)?.suggestions ?? null);
</script>

<!--
-->{#each items as item (keyOf(item))}<!--
	-->{#if item.part.kind === 'text'}<!--
		-->{@const shown =
			view(item.part)}<!--
--><RenderText
			text={edytor.textAt(id, item.ordinal)}
			deltas={shown.deltas}
			empty={shown.empty}
			newline={item.part.text.endsWith('\n')}
			{placeholder}
		/><!--
	-->{:else}<!--
--><RenderInlineBlock
			block={edytor.atomAt(id, item.part.id)}
		/><!--
	-->{/if}<!--
-->{/each}<!--
-->{#if suggestions}<!--
	--><span
		data-edytor-text-suggestion
		contentEditable="false"
		style="user-select: none; pointer-events: none"
		><!--
		-->{#each suggestions as suggestion, index (index)}<!--
			-->{#if 'stringContent' in suggestion}<!--
--><RenderText
					text={suggestion}
					deltas={(suggestion as unknown as ReadonlyText).renderChildren}
					empty={suggestion.isEmpty}
					newline={suggestion.endsWithNewline}
				/><!--
			-->{:else}<!--
--><RenderInlineBlock
					block={suggestion as InlineBlock}
				/><!--
			-->{/if}<!--
		-->{/each}<!--
	--></span
	><!--
-->{/if}<!--
-->
