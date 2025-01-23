<script lang="ts">
	import { Text } from '../text/text.svelte.js';
	import Marks from './Marks.svelte';
	let {
		text
	}: {
		text: Text;
	} = $props();

	$inspect(text.children);
</script>

<span use:text.attach style:white-space="break-spaces">
	{#if text.isEmpty}
		&#8203;
	{:else}
		{#each text.children as delta (delta.text)}
			{#if delta.marks.length}
				<Marks {delta} index={0} {text} />
			{:else}
				{delta.text}
			{/if}
		{/each}
	{/if}
</span>
