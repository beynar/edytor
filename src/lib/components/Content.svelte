<script lang="ts">
	import { getContext } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import {
		START,
		partsOf,
		segmentDeltas,
		type AtomPart,
		type Cell,
		type Part,
		type RenderDelta,
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
	/** Bumped only by the observer's repair of foreign damage: re-creates the text elements. */
	const epoch = $derived(edytor.cells?.epoch(id) ?? 0);
	const type = $derived(cell?.type ?? edytor.cells?.get(id)?.type);
	const transform = $derived(type ? edytor.definitionOf(type).transformText : undefined);
	// The placeholder attribute: withheld in the block a composition is in.
	const placeholder = $derived(edytor.placeholderAt(id));

	/** An empty content's one text (`partsOf`: a content starts with a text). */
	const EMPTY: Segment = { kind: 'text', key: START, text: '', runs: [] };

	/** Whether this view renders an atom of `part`'s kind (its record has a snippet). */
	const rendersAtom = (part: AtomPart) => Boolean(edytor.inlineBlocks.get(part.type)?.snippet);

	/** Segments are keyed causally (the preceding atom's id, or `start`), never by ordinal. */
	const keyOf = (part: Part) => (part.kind === 'text' ? `s:${part.key}:${epoch}` : `a:${part.id}`);

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

	/** The parts this content renders: a preview's (session parts, no handle), else the cell's. */
	const own = $derived(preview ? partsOf(preview) : parts);
	/**
	 * The first text, before any atom (its key is always `start`): a static
	 * element of the content, re-created only by an epoch bump. The rest is
	 * one keyed list after it: two anchors for the whole content
	 * (`render.markers`).
	 */
	const first = $derived((own[0]?.kind === 'text' ? own[0] : undefined) ?? EMPTY);
	const firstShown = $derived(preview ? ghost(first) : view(first));

	type Entry =
		| { key: string; kind: 'text'; part: Segment; ordinal: number }
		| { key: string; kind: 'rest'; deltas: readonly RenderDelta[] }
		| { key: string; kind: 'atom'; part: AtomPart }
		| { key: string; kind: 'ghost'; parts: readonly Part[] };
	/**
	 * What follows the first text, in order: the atoms and texts (with their
	 * text ordinal, their handle's position), each text followed by the rest
	 * a live composition merged into it (`pin.rest`), then the suggestions'
	 * text after the block's.
	 */
	const entries = $derived.by(() => {
		const list: Entry[] = [];
		let ordinal = 0;
		for (const part of own) {
			if (part.kind !== 'text') {
				// An atom whose kind renders nothing (no snippet in this view) takes no place.
				if (rendersAtom(part)) list.push({ key: keyOf(part), kind: 'atom', part });
				continue;
			}
			if (ordinal) list.push({ key: keyOf(part), kind: 'text', part, ordinal });
			ordinal++;
			const rest = preview ? [] : edytor.pin.rest(id, part.key);
			if (rest.length) list.push({ key: `r:${part.key}`, kind: 'rest', deltas: rest });
		}
		ghosts.forEach((parts, index) => list.push({ key: `g:${index}`, kind: 'ghost', parts }));
		return list;
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
		-->{:else if rendersAtom(part)}<!--
--><RenderInlineBlock
				block={undefined}
				{part}
			/><!--
		-->{/if}<!--
	-->{/each}<!--
-->{/snippet}<!--
-->{#key epoch}<RenderText
		text={preview ? undefined : edytor.textAt(id, 0)}
		deltas={firstShown.deltas}
		empty={firstShown.empty}
		newline={first.text.endsWith('\n')}
		placeholder={preview ? null : placeholder}
	/>{/key}<!--
-->{#each entries as entry (entry.key)}<!--
	-->{#if entry.kind === 'text'}<!--
		-->{@const shown =
			preview ? ghost(entry.part) : view(entry.part)}<!--
--><RenderText
			text={preview ? undefined : edytor.textAt(id, entry.ordinal)}
			deltas={shown.deltas}
			empty={shown.empty}
			newline={entry.part.text.endsWith('\n')}
			placeholder={preview ? null : placeholder}
		/><!--
	-->{:else if entry.kind === 'atom'}<!--
--><RenderInlineBlock
			block={preview ? undefined : edytor.atomAt(id, entry.part.id)}
			part={entry.part}
		/><!--
	-->{:else if entry.kind === 'rest'}<!--
--><RenderText
			text={undefined}
			deltas={entry.deltas}
			empty={false}
			newline={false}
			rest
		/><!--
	-->{:else}<!--
	--><span
			data-edytor-text-suggestion
			contentEditable="false"
			style="user-select: none; pointer-events: none">{@render session(entry.parts)}</span
		><!--
	-->{/if}<!--
-->{/each}<!--
-->
