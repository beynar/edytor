<script lang="ts">
	import { Text } from '$lib/text/text.svelte.js';
	import Mark from './Mark.svelte';
	import type { JSONDelta } from '$lib/text/deltas.js';

	let {
		delta,
		text,
		index
	}: {
		text: Text;
		delta: JSONDelta;
		index: number;
	} = $props();

	const mark = $derived(delta.marks[index]);
	const definition = $derived(text.edytor.marks.get(mark?.[0]));
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
		<span data-edytor-mark-void contenteditable="false">
			{@render definition.snippet({ content, mark: mark?.[1], text })}
		</span>
	{:else}
		{@render definition.snippet({ content, mark: mark?.[1], text })}
	{/if}
{:else}
	{@render content()}
{/if}
