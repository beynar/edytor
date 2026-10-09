<script module lang="ts">
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { Text } from '$lib/text/text.svelte.js';
	import type { RenderDelta } from '$lib/surface/cells.js';

	/** Mark `index` of `delta` renders a custom snippet (`CustomMark`), not a tag (`Mark`). */
	export const customAt = (edytor: Edytor, delta: RenderDelta, index: number) =>
		Boolean(edytor.marks.get(delta.marks[index]?.[0] ?? '')?.snippet);

	/** The core mark element is registered; a suggestion's ghost mark has no text and is not. */
	export const registerMark = (
		edytor: Edytor,
		text: Text | undefined,
		node: HTMLElement,
		name: string | undefined
	) => {
		const release = text && edytor.surface.register(node, 'mark', text.parent.id, name);
		return { destroy: () => release?.() };
	};
</script>

<script lang="ts">
	import { getContext } from 'svelte';
	import Mark from './Mark.svelte';
	import CustomMark from './CustomMark.svelte';

	/**
	 * Mark `index` of `delta` as the element of its tag, around the marks
	 * after it, then its text. `Text` passes only the marks this view renders
	 * (a tag or a snippet); a snippet's mark is `CustomMark`.
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
	/** The text, the element's own text node when no mark is inside (no anchor of its own). */
	const own = $derived(inner ? '' : delta.text);
	const register = (node: HTMLElement) => registerMark(edytor, text, node, mark?.[0]);
</script>

<!-- One core element per mark, the kind's tag (`render.markers`: its text needs no anchor). -->
<svelte:element
	this={definition?.tag}
	{...definition?.attributes?.(mark?.[1])}
	data-edytor-mark={mark?.[0]}
	data-edytor-mark-void={definition?.void ? '' : undefined}
	contenteditable={definition?.void ? 'false' : undefined}
	use:register
	>{own}{#if !inner}{:else if customAt(edytor, delta, index + 1)}<CustomMark
			index={index + 1}
			{delta}
			{text}
		/>{:else}<Mark index={index + 1} {delta} {text} />{/if}</svelte:element
>
