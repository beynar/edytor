<script lang="ts">
	import { Text } from '../text/text.svelte.js';
	import Mark from './Mark.svelte';
	let {
		text
	}: {
		text: Text;
	} = $props();
</script>

<span use:text.attach style:white-space="break-spaces">
	{#if text.isEmpty}
		&#8203;
	{:else}
		{#each text.children as delta (delta.id)}
			{#if delta.marks.length}
				<Mark {delta} index={0} {text} />
			{:else}
				{delta.text}
			{/if}
		{/each}
	{/if}
</span>
