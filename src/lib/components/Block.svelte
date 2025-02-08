<script lang="ts">
	import { Block } from '../block/block.svelte.js';
	import Child from './Block.svelte';
	import Content from './Content.svelte';

	let {
		block
	}: {
		block: Block;
	} = $props();

	const snippet = $derived(block.definition.snippet);
</script>

{#snippet content()}
	<Content {block} />
{/snippet}

{#snippet children()}
	{#each block.children as child (child.id)}
		<Child block={child} />
	{/each}
{/snippet}

{#if snippet}
	{@render snippet({ block, content, children: block.children.length ? children : null })}
{/if}
