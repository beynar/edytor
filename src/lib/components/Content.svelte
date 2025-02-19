<script lang="ts">
	import { Block } from '$lib/block/block.svelte.js';
	import { Text } from '$lib/text/text.svelte.js';
	import RenderText from './Text.svelte';
	import RenderInlineBlock from './InlineBlock.svelte';
	import { InlineBlock } from '$lib/block/inlineBlock.svelte.js';

	let {
		block
	}: {
		block: Block;
	} = $props();
</script>

<!--
-->{#snippet renderContent(
	content: (Text | InlineBlock)[]
)}<!--
	-->{#each content as blockOrText (blockOrText.id)}<!--
		-->{#if 'children' in blockOrText}<!--
--><RenderText
				text={blockOrText}
			/><!--
		-->{:else}<!--
--><RenderInlineBlock
				block={blockOrText}
			/><!--
		-->{/if}<!--
	-->{/each}<!--
-->{/snippet}<!--
-->{@render renderContent(
	block.content
)}<!--
-->{#if block?.content.length === 1 && (block.content[0] as Text)?.isEmpty && block.edytor.placeholder}<!--
	--><span
		data-edytor-text-placeholder
		contentEditable="false"
		style="user-select: none;"
	>
		{#if typeof block.edytor.placeholder === 'string'}
			{block.edytor.placeholder}
		{:else}
			{@render block.edytor.placeholder({ block })}
		{/if}
	</span><!--
-->{/if}<!--
-->{#if block?.suggestions}<!--
	--><span
		data-edytor-text-suggestion
		contentEditable="false"
		style="user-select: none; pointer-events: none"
		><!--
-->{@render renderContent(block.suggestions)}<!--
	--></span
	><!--
-->{/if}<!--
-->
