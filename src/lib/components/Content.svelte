<script lang="ts">
	import { getContext } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import {
		partsOf,
		segmentDeltas,
		type Cell,
		type Part,
		type Segment
	} from '$lib/surface/cells.js';
	import type { ContentRun } from '$lib/crdt/index.js';
	import { jsonContentToItems } from '$lib/utils/json.js';
	import RenderText from './Text.svelte';
	import RenderInlineBlock from './InlineBlock.svelte';

	let {
		id,
		preview,
		onrender
	}: {
		id: string;
		/** A suggestion's block content (`Block`'s `preview`): ghost parts only. */
		preview?: readonly ContentRun[];
		/** Dev check: told when the kind's snippet rendered `content()`. */
		onrender?: () => void;
	} = $props();

	// Called once per mount: the kind's snippet rendered `content()`.
	(() => onrender?.())();

	const edytor = getContext<Edytor>('edytor');
	const cell = $derived(preview ? undefined : edytor.cells?.get(id));
	/** The cell's segments and atoms — the frozen list while the IME pin holds this cell. */
	const parts = $derived(cell ? edytor.pin.parts(cell) : []);
	/** Each part with its text ordinal (its text handle's position). */
	const items = $derived.by(() => {
		let ordinal = 0;
		return parts.map((part) => ({ part, ordinal: part.kind === 'text' ? ordinal++ : -1 }));
	});
	/** Bumped only by the observer's repair of foreign damage: re-creates the text elements. */
	const epoch = $derived(edytor.cells?.epoch(id) ?? 0);
	const type = $derived(cell?.type ?? edytor.cells?.get(id)?.type);
	const transform = $derived(type ? edytor.definitionOf(type).transformText : undefined);
	// The placeholder attribute: withheld in the block a composition is in.
	const placeholder = $derived(edytor.placeholderAt(id));

	/** Segments are keyed causally (the preceding atom's id, or `start`), never by ordinal. */
	const keyOf = ({ part }: { part: Part }) =>
		part.kind === 'text' ? `s:${part.key}:${epoch}` : `a:${part.id}`;

	const view = (segment: Segment) =>
		edytor.pin.render(id, segment.key) ?? {
			deltas: segmentDeltas(cell!, segment, transform),
			empty: segment.text === ''
		};

	/** A suggestion's text after this block's (`end`): its first block's content. */
	const ghosts = $derived(
		preview
			? []
			: edytor.suggestions
					.at(id)
					.end.map((s) =>
						partsOf(jsonContentToItems(s.content[0]?.content ?? [], false, () => s.id))
					)
	);
	/** Session content, rendered from JSON as declared view values: no handle, no caret. */
	const ghost = (segment: Segment) => ({
		deltas: segmentDeltas(
			{ id, type: type ?? '', data: undefined } as Cell,
			segment,
			preview ? undefined : transform
		),
		empty: !segment.text
	});
</script>

<!--
-->{#snippet session(
	parts: readonly Part[]
)}<!--
	-->{#each parts as part, index (index)}<!--
		-->{#if part.kind === 'text'}<!--
			-->{@const shown =
				ghost(part)}<!--
--><RenderText
				text={undefined}
				deltas={shown.deltas}
				empty={shown.empty}
				newline={part.text.endsWith('\n')}
			/><!--
		-->{:else}<!--
--><RenderInlineBlock
				block={undefined}
				{part}
			/><!--
		-->{/if}<!--
	-->{/each}<!--
-->{/snippet}<!--
-->{#if preview}<!--
	-->{@render session(
		partsOf(preview)
	)}<!--
-->{/if}<!--
-->{#each items as item (keyOf(item))}<!--
	-->{#if item.part.kind === 'text'}<!--
		-->{@const shown =
			view(item.part)}<!--
		-->{@const rest = edytor.pin.rest(id, item.part.key)}<!--
--><RenderText
			text={edytor.textAt(id, item.ordinal)}
			deltas={shown.deltas}
			empty={shown.empty}
			newline={item.part.text.endsWith('\n')}
			{placeholder}
		/><!--
		-->{#if rest.length}<!--
			--><RenderText
				text={undefined}
				deltas={rest}
				empty={false}
				newline={false}
				rest
			/><!--
		-->{/if}<!--
	-->{:else}<!--
--><RenderInlineBlock
			block={edytor.atomAt(id, item.part.id)}
			part={item.part}
		/><!--
	-->{/if}<!--
-->{/each}<!--
-->{#each ghosts as parts, index (index)}<!--
	--><span
		data-edytor-text-suggestion
		contentEditable="false"
		style="user-select: none; pointer-events: none">{@render session(parts)}</span
	><!--
-->{/each}<!--
-->
