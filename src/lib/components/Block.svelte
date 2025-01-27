<script lang="ts">
	import { Block } from '../block/block.svelte.js';
	import Text from './Text.svelte';
	import RenderBlock from './Block.svelte';

	let {
		block
	}: {
		block: Block;
	} = $props();

	const snippet = $derived(block.edytor.snippets[`${block.type}Block`]);
</script>

{#snippet content()}
	<Text text={block.content} />
{/snippet}

{#snippet children()}
	{#each block.children as child (child.id)}
		<RenderBlock block={child} />
	{/each}
{/snippet}

{#if snippet}
	{@render snippet({ block, content, children: block.children.length ? children : null })}
{:else}
	<div use:block.attach>
		<p>{@render content()}</p>
		<div>
			{@render children()}
		</div>
	</div>
{/if}
