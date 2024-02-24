<script lang="ts">
	import { useBlock } from '$lib/hooks/useBlock.svelte.js';
	import Text from './Text.svelte';
	import { useEdytor } from '$lib/hooks/useEdytor.svelte.js';
	import type { YBlock } from '$lib/utils/json.js';
	let { yBlock } = $props<{
		yBlock: YBlock;
	}>();

	const block = useBlock(yBlock);
	const edytor = useEdytor();
	const renderBlocks = edytor.renderBlocks;
	block.observe();
</script>

{#snippet content()}
	<Text yText={block.content} />
{/snippet}

{#snippet children()}
	{#each block.children || [] as yBlock (`${yBlock._item?.id.client}-${yBlock._item?.id.clock}`)}
		<svelte:self {yBlock} />
	{/each}
{/snippet}

{@render renderBlocks(
	{ block: block.block, yBlock, attributes: {}, node: block.node },
	content,
	children
)}
