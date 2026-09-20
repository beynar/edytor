<script lang="ts">
	import type { JSONBlock } from '$lib/utils/json.js';
	import { type EdytorProps } from './Edytor.svelte';
	import { createReadonlyBlock } from './readonlyElements.svelte.js';
	import Block from './Block.svelte';
	import { Edytor } from '$lib/edytor.svelte.js';
	import { untrack } from 'svelte';

	let {
		value,
		class: className,
		plugins,
		...snippets
	}: Omit<
		EdytorProps,
		| 'awareness'
		| 'readonly'
		| 'hotKeys'
		| 'onChange'
		| 'onSelectionChange'
		| 'sync'
		| 'edytor'
		| 'doc'
	> = $props();

	const generateReadonlyBlock = (block: JSONBlock) => {
		return createReadonlyBlock({
			block,
			edytor,
			parent: edytor
		});
	};

	const children = $derived(value!.children.map(generateReadonlyBlock));

	const initialReadonlyOptions = untrack(() => ({
		snippets,
		readonly: true,
		plugins,
		value
	}));

	const edytor = new Edytor(initialReadonlyOptions);
</script>

<div
	class={className}
	data-edytor
	contenteditable="false"
	role="textbox"
	aria-multiline="true"
	aria-readonly="true"
>
	{#each children || [] as block (block.id)}
		<Block {block} />
	{/each}
</div>
