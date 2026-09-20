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
	const snippetKey = $derived(
		block.type === 'heading' ? `${block.type}:${block.data.level ?? 'h1'}` : block.type
	);
	const getBlockRenderKey = (child: Block) => child.id;
</script>

<!--
-->{#snippet content()}<!--
--><Content
		{block}
	/><!--
-->{/snippet}<!--
-->{#snippet children()}<!--
--->{#each block.children as child (getBlockRenderKey(child))}<!--
--><Child
			block={child}
		/><!--
-->{/each}<!--
-->{/snippet}<!--
-->{#key snippetKey}<!--
-->{@render snippet({
		block,
		content,
		children: block.children.length ? children : null
	})}<!--
-->{/key}<!--
-->
