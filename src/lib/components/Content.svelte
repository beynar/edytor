<script lang="ts">
	import { Block } from '$lib/block/block.svelte.js';
	import { Text } from '$lib/text/text.svelte.js';
	import RenderText from './Text.svelte';
	import RenderInlineBlock from './InlineBlock.svelte';

	let {
		block
	}: {
		block: Block;
	} = $props();
</script>

{#each block.content as blockOrText (blockOrText.id)}
	{#if blockOrText instanceof Text}
		<RenderText text={blockOrText} />
	{:else}
		<RenderInlineBlock block={blockOrText} />
	{/if}
{/each}
