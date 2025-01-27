<script lang="ts" module>
	import { Edytor, useEdytor, type Snippets } from '../edytor.svelte.js';
	import { Awareness } from 'y-protocols/awareness';
	export { Edytor as EdytorContext, useEdytor };

	const defaultValue: JSONDoc = {
		children: [
			{
				type: 'paragraph',
				content: [{ text: 'Prout', marks: { bold: true } }]
			},
			{
				type: 'paragraph',
				content: [{ text: 'Prout', marks: { bold: true } }]
			},
			{
				type: 'paragraph',
				content: [{ text: `OO OO`, marks: { bold: true, italic: true } }],
				children: [
					{
						type: 'paragraph',
						content: [{ text: `ONE `, marks: { bold: true, italic: true } }],
						children: [
							{
								type: 'paragraph',
								content: [{ text: 'TWO', marks: { bold: true } }]
							}
						]
					},
					{
						type: 'paragraph',
						content: [{ text: 'THREE', marks: { bold: true } }]
					},
					{
						type: 'paragraph',
						content: [{ text: 'FOUR', marks: { bold: true } }]
					}
				]
			},
			{
				type: 'paragraph',
				content: [{ text: 'FIVE', marks: { bold: true } }]
			}
		]
	};
</script>

<script lang="ts">
	import Block from './Block.svelte';
	import * as Y from 'yjs';
	import type { JSONDoc } from '../utils/json.js';
	import { type HotKeys } from '../events/onKeyDown.js';
	import { onMount, setContext } from 'svelte';

	let {
		class: className,
		edytor = $bindable(),
		doc,
		readonly = false,
		value = defaultValue,
		hotKeys = {
			'mod+b': { toggleMark: 'bold' },
			'mod+i': { toggleMark: 'italic' },
			'mod+u': { toggleMark: 'underline' },
			'mod+`': { toggleMark: 'code' },
			'mod+k': { toggleMark: 'link' }
		},
		sync,
		awareness,
		...snippets
	}: Snippets & {
		class?: string;
		edytor?: Edytor;
		doc?: Y.Doc;
		awareness?: Awareness;
		readonly?: boolean;
		hotKeys?: HotKeys;
		value?: JSONDoc;
		sync?: ({
			doc,
			awareness,
			synced
		}: {
			doc: Y.Doc;
			awareness: Awareness;
			synced: (provider?: any) => void;
		}) => void;
	} = $props();

	edytor = new Edytor({
		snippets,
		readonly,
		doc,
		awareness,
		hotKeys,
		sync: !!sync,
		value
	});

	onMount(() => {
		if (!readonly && sync) {
			sync({
				doc: edytor.doc,
				awareness: edytor.awareness,
				synced: () => {
					edytor.sync(value);
				}
			});
		}
	});

	setContext('edytor', edytor);
</script>

{#if edytor.synced || readonly}
	<div class={className} use:edytor.attach data-edytor>
		{#each edytor.children || [] as block (block.id)}
			<Block {block} />
		{/each}
	</div>
{/if}
