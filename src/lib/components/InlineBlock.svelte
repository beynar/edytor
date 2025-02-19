<script lang="ts">
	import { InlineBlock } from '$lib/block/inlineBlock.svelte.js';

	let {
		block
	}: {
		block: InlineBlock;
	} = $props();

	const snippet = $derived(block.definition.snippet);
</script>

<span data-edytor-inline-block use:block.attach>
	{@render snippet({ block })}
</span>
