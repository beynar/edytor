<script lang="ts">
	import * as Y from 'yjs';
	import { useEdytor } from '../hooks/useEdytor.svelte.js';
	import { useText } from '$lib/hooks/useText.svelte.js';

	let { yText } = $props<{
		yText: Y.Text;
	}>();

	const edytor = useEdytor();

	const text = useText(yText);
	text.observe();
	const renderMarks = edytor.renderMarks;
</script>

<span use:text.node style:white-space="break-spaces">
	{#each text.marks as { marks, text: content }, index (index)}
		{#snippet textMarks(index, mark, nextMark)}
			{#snippet children()}
				{#if nextMark}
					{@render textMarks(index + 1, nextMark, marks?.[index + 2])}
				{:else}
					{content}
				{/if}
			{/snippet}
			{@render renderMarks({ mark, node: text.node }, children)}
		{/snippet}
		{@render textMarks(0, marks[0], marks[1])}
	{/each}
</span>
