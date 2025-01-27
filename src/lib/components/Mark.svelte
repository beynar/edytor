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
	const snippet = $derived(text.edytor.snippets[`${mark?.[0]}Mark`]);
</script>

{#snippet content()}
	{#if delta.marks[index + 1]}
		<Mark index={index + 1} {delta} {text} />
	{:else}
		{delta.text}
	{/if}
{/snippet}

{#if snippet}
	{@render snippet({ content, mark: mark?.[1], text })}
{:else}
	{@render content()}
{/if}
