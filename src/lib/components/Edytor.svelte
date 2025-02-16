<script lang="ts" module>
	import { Edytor, useEdytor, type Snippets } from '../edytor.svelte.js';
	import { Awareness } from 'y-protocols/awareness';
	export { Edytor as EdytorContext, useEdytor };
	import type { Plugin } from '$lib/plugins.js';
	import type { Block as BlockType } from '$lib/block/block.svelte.js';
	const defaultValue: JSONDoc = {
		children: [
			{
				type: 'paragraph',
				content: [{ text: 'One', marks: { bold: true } }]
			},

			{
				type: 'image',
				content: [{ text: 'Caption' }]
			},
			{
				type: 'paragraph',
				content: [
					{ text: 'One', marks: { bold: true } },
					{ text: ' Two', marks: { italic: true } }
				]
			},
			{
				type: 'paragraph',
				content: [{ text: '' }]
			},
			{
				type: 'paragraph',
				content: [
					{ text: 'Three', marks: { italic: true } },
					{ text: ' Four', marks: { bold: true } },
					{ text: '' }
				]
			},

			{
				type: 'paragraph',
				content: [
					{ text: 'Hello', marks: { bold: true } },
					{ text: '', marks: { void: true } },
					{ text: ' World', marks: { bold: true } }
				]
			},
			{
				type: 'paragraph',
				content: [
					{ text: 'hello', marks: { bold: true } },
					{
						type: 'mention'
					},
					{ text: 'World', marks: { bold: true } },
					{
						type: 'mention'
					},
					{ text: 'Prout', marks: { bold: true } }
				],

				children: [
					{
						type: 'paragraph',
						content: [{ text: 'One', marks: { bold: true } }],
						children: [
							{
								type: 'paragraph',
								content: [{ text: 'Two', marks: { bold: true } }]
							}
						]
					}
				]
			},
			{
				type: 'code',
				content: [{ text: 'caption yo' }],
				children: [{ type: 'codeLine', content: [{ text: '\t\tconsole.log("hello")' }] }]
			}
		]
	};

	export type EdytorProps = Snippets & {
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
		placeholder?: string | Snippet<[{ block: BlockType }]>;
		sync?: ({
			doc,
			awareness,
			synced
		}: {
			doc: Y.Doc;
			awareness: Awareness;
			synced: (provider?: any) => void;
		}) => void;
	};
</script>

<script lang="ts">
	import * as Y from 'yjs';
	import type { JSONBlock, JSONDoc } from '../utils/json.js';
	import { onMount, setContext, type Snippet } from 'svelte';
	import type { HotKey } from '$lib/hotkeys.js';
	import type { EdytorSelection } from '$lib/selection/selection.svelte.js';
	import ReadonlyEditor from './ReadonlyEditor.svelte';
	import Block from './Block.svelte';

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
		placeholder,
		...snippets
	}: EdytorProps = $props();

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
		value,
		placeholder
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
	<div class={className} use:edytor.attach data-edytor contenteditable={!readonly}>
		{#each edytor.root?.children || [] as block (block.id)}
			<Block {block} />
		{/each}
	</div>
{/if}
