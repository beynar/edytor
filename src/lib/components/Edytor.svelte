<script lang="ts" module>
	import { Edytor, useEdytor, type Snippets } from '../edytor.svelte.js';
	import { Awareness } from 'y-protocols/awareness';
	export { Edytor as EdytorContext, useEdytor };
	import type { Plugin } from '$lib/plugins.js';
	const defaultValue: JSONDoc = {
		children: [
			{
				type: 'paragraph',
				content: [{ text: 'Prout', marks: { bold: true } }]
			},
			{
				type: 'paragraph',
				content: [
					{ text: 'Hello', marks: { bold: true } },
					{ text: '', marks: { void: true } },
					{ text: ' World', marks: { bold: true } }
				],
				children: [
					{
						type: 'paragraph',
						content: [{ text: 'Prout', marks: { bold: true } }]
					}
				]
			},
			{
				type: 'code',
				content: [{ text: 'caption' }],
				children: [{ type: 'codeLine', content: [{ text: '\t\tconsole.log("hello")' }] }]
			},
			{
				type: 'paragraph',
				content: [
					{ text: 'Hello', marks: { bold: true } },
					{ text: '', marks: { void: true } },
					{ text: ' World', marks: { bold: true } }
				]
			}
		]
	};
</script>

<script lang="ts">
	import Block from './Block.svelte';
	import * as Y from 'yjs';
	import type { JSONBlock, JSONDoc } from '../utils/json.js';
	import { onMount, setContext } from 'svelte';
	import type { HotKey } from '$lib/hotkeys.js';
	import type { EdytorSelection } from '$lib/selection/selection.svelte.js';

	let {
		plugins,
		class: className,
		edytor = $bindable(),
		doc,
		readonly = false,
		value = $bindable(defaultValue),
		hotKeys,
		sync,
		awareness,
		onChange,
		onSelectionChange,
		...snippets
	}: Snippets & {
		plugins?: Plugin[];
		class?: string;
		edytor?: Edytor;
		doc?: Y.Doc;
		awareness?: Awareness;
		readonly?: boolean;
		hotKeys?: Record<string, HotKey>;
		onChange?: (value: JSONBlock) => void;
		onSelectionChange?: (selection: EdytorSelection) => void;
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
		plugins,
		doc,
		awareness,
		hotKeys,
		onSelectionChange,
		onChange,
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
