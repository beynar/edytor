<script lang="ts">
	import { getContext } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { Text } from '$lib/text/text.svelte.js';
	import type { RenderDelta } from '$lib/surface/cells.js';
	import Mark from './Mark.svelte';

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
	const definition = $derived(edytor.marks.get(mark?.[0]));
	/** The core mark element is registered (R11); a suggestion's ghost mark has no text and is not. */
	const register = (node: HTMLElement) => {
		const release = text && edytor.surface.register(node, 'mark', text.parent.id, mark?.[0]);
		return { destroy: () => release?.() };
	};
</script>

{#snippet content()}
	{#if delta.marks[index + 1]}
		<Mark index={index + 1} {delta} {text} />
	{:else}
		{delta.text}
	{/if}
{/snippet}

{#if definition?.snippet}
	{#if definition.void}
		<span data-edytor-mark={mark?.[0]} data-edytor-mark-void contenteditable="false" use:register>
			{@render definition.snippet({ content, mark: mark?.[1], text: text! })}
		</span>
	{:else}
		<span data-edytor-mark={mark?.[0]} use:register>
			{@render definition.snippet({ content, mark: mark?.[1], text: text! })}
		</span>
	{/if}
{:else}
	{@render content()}
{/if}
