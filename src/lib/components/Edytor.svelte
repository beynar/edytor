<script lang="ts" module>
	import { Edytor, useEdytor, type Snippets } from '../edytor.svelte.js';
	import { Awareness } from 'y-protocols/awareness';

	export { Edytor as EdytorContext, useEdytor };

	const defaultValue: JSONDoc = {
		children: Array.from({ length: 2 }, () => ({
			type: 'paragraph',
			content: [
				{ text: 'Hello', marks: { bold: true, italic: true } },
				{ text: 'World', marks: { bold: true } }
			]
		}))
	};

	console.log({ defaultValue });
</script>

<script lang="ts">
	import Block from './Block.svelte';
	import * as Y from 'yjs';
	import type { JSONDoc } from '../utils/json.js';
	import { type HotKeys } from '../events/onKeyDown.js';
	import { onMount, setContext } from 'svelte';

	let {
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
		edytor: Edytor;
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
		sync: !sync,
		value
	});

	onMount(() => {
		sync?.({
			doc: edytor.doc,
			awareness: edytor.awareness,
			synced: () => {
				edytor.sync(value);
			}
		});
	});

	setContext('edytor', edytor);
</script>

<button
	onclick={(e) => {
		e.preventDefault();
		e.stopPropagation();
		edytor.selection.state.startText?.mark({
			type: 'bold',
			value: true,
			toggleIfExists: true
		});
	}}
>
	format
</button>

<button
	onclick={(e) => {
		e.preventDefault();
		e.stopPropagation();
		// edytor.children[0].content.setChildren();
		edytor.children[0].content.yText.applyDelta([{ delete: 1 }]);
	}}
>
	set first text
</button>

{#if edytor.synced}
	<div use:edytor.attach data-edytor>
		{#each edytor.children || [] as block (block.id)}
			<Block {block} />
		{/each}
	</div>
{/if}
