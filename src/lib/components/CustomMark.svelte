<script lang="ts">
	import { getContext } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { Text } from '$lib/text/text.svelte.js';
	import type { RenderDelta } from '$lib/surface/cells.js';
	import Mark, { customAt, registerMark } from './Mark.svelte';
	import CustomMark from './CustomMark.svelte';

	/**
	 * Mark `index` of `delta` drawn by its record's snippet, inside the core's
	 * `<span data-edytor-mark>`: the snippet's `content()` is the marks after
	 * it, then the text.
	 */
	let {
		delta,
		text,
		index
	}: {
		text: Text | undefined;
		delta: RenderDelta;
		index: number;
	} = $props();

	const edytor = getContext<Edytor>('edytor');
	const mark = $derived(delta.marks[index]);
	const definition = $derived(edytor.marks.get(mark?.[0] ?? ''));
	/** Another mark inside this one. */
	const inner = $derived(index + 1 < delta.marks.length);
	/** The text, as `content()`'s own text node when no mark is inside. */
	const own = $derived(inner ? '' : delta.text);
	const register = (node: HTMLElement) => registerMark(edytor, text, node, mark?.[0]);
</script>

{#snippet content()}{own}{#if !inner}{:else if customAt(edytor, delta, index + 1)}<CustomMark
			index={index + 1}
			{delta}
			{text}
		/>{:else}<Mark index={index + 1} {delta} {text} />{/if}{/snippet}

<!-- The core's element around a custom snippet: a static `span` (no anchor of its own). -->
<span
	data-edytor-mark={mark?.[0]}
	data-edytor-mark-void={definition?.void ? '' : undefined}
	contenteditable={definition?.void ? 'false' : undefined}
	use:register>{@render definition?.snippet?.({ content, mark: mark?.[1], text: text! })}</span
>
