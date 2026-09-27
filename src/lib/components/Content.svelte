<script lang="ts">
	import { Block } from '$lib/block/block.svelte.js';
	import { Text } from '$lib/text/text.svelte.js';
	import RenderText from './Text.svelte';
	import RenderInlineBlock from './InlineBlock.svelte';
	import type { InlineBlock } from '$lib/block/inlineBlock.svelte.js';

	let {
		block,
		onrender
	}: {
		block: Block;
		/** Dev check (O22): told when the kind's snippet rendered `content()`. */
		onrender?: () => void;
	} = $props();

	// Called once per mount: the kind's snippet rendered `content()`.
	(() => onrender?.())();

	const getContentKey = (blockOrText: Text | InlineBlock) =>
		blockOrText instanceof Text ? `${blockOrText.id}:${blockOrText.domVersion}` : blockOrText.id;
</script>

<!--
-->{#snippet renderContent(
	content: (Text | InlineBlock)[]
)}<!--
	-->{#each content as blockOrText (getContentKey(blockOrText))}<!--
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
