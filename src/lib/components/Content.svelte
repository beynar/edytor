<script lang="ts">
	import { getContext } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { segmentDeltas, type Part, type Segment } from '$lib/surface/cells.js';
	import RenderText from './Text.svelte';
	import RenderInlineBlock from './InlineBlock.svelte';
	import type { JSONText } from '$lib/utils/json.js';

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
	/** Each part with its text ordinal (its text handle's position). */
	const items = $derived.by(() => {
		let ordinal = 0;
		return parts.map((part) => ({ part, ordinal: part.kind === 'text' ? ordinal++ : -1 }));
	});
	/** Bumped only by the observer's repair of foreign damage: re-creates the text elements. */
	const epoch = $derived(edytor.cells?.epoch(id) ?? 0);
	const transform = $derived(cell && edytor.definitionOf(cell.type).transformText);
	// The placeholder attribute (§2.4): withheld in the block a composition is in.
	const placeholder = $derived(edytor.placeholderAt(id));

	/** Segments are keyed causally (the preceding atom's id, or `start`), never by ordinal. */
	const keyOf = ({ part }: { part: Part }) =>
		part.kind === 'text' ? `s:${part.key}:${epoch}` : `a:${part.id}`;

	const view = (segment: Segment) =>
		edytor.pin.render(id, segment.key) ?? {
			deltas: segmentDeltas(cell!, segment, transform),
			empty: segment.text === ''
		};

	// Suggestions are session state (L12), rendered from their JSON as declared view values (L48).
	const suggestions = $derived(edytor.selection.suggestions.get(id) ?? null);
	const ghost = (runs: JSONText[]) => {
		const text = runs.map((run) => run.text).join('');
		const segment = { kind: 'text', key: 'ghost', text, runs } as unknown as Segment;
		return { deltas: segmentDeltas(cell!, segment, transform), empty: !text, text };
	};
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
			part={item.part}
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
			-->{#if Array.isArray(suggestion)}<!--
				-->{@const shown =
					ghost(suggestion)}<!--
--><RenderText
					text={undefined}
					deltas={shown.deltas}
					empty={shown.empty}
					newline={shown.text.endsWith('\n')}
				/><!--
			-->{:else}<!--
--><RenderInlineBlock
					block={undefined}
					part={suggestion}
				/><!--
			-->{/if}<!--
		-->{/each}<!--
	--></span
	><!--
-->{/if}<!--
-->
