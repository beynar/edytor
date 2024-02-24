<script lang="ts">
	import { useEdytor } from '$lib/hooks/useEdytor.svelte.js';

	import type { Snippet } from 'svelte';
	let { renderMarks, renderBlocks } = $props<{
		renderMarks: Snippet<[Record<string, any>, Snippet]>;
		renderBlocks: Snippet<[Record<string, any>, Snippet, Snippet]>;
	}>();
	import Block from './Block.svelte';
	import { setCursorAtPosition } from '$lib/utils/setCursor.js';
	const edytor = useEdytor({
		endpoint: '/',
		renderMarks,
		renderBlocks,
		id: 'id',
		readonly: false,
		value: {
			children: [
				{
					type: 'paragraph',
					content: [
						{ text: 'H', marks: [{ bold: true }] },
						{ text: 'ello world', marks: [{ italic: true }] }
					],
					children: [
						{
							type: 'paragraph',
							content: [{ text: 'Hello', marks: [{ bold: true }, { italic: true }] }]
						},
						{
							type: 'paragraph',
							content: [{ text: 'world', marks: [{ bold: true }, { italic: true }] }]
						}
					]
				},
				{
					type: 'paragraph',
					content: [{ text: 'Hello world', marks: [{ bold: true }, { italic: true }] }]
				},
				{
					type: 'paragraph',
					content: [{ text: 'Hello world' }],
					children: [
						{
							type: 'paragraph',
							content: [{ text: 'Hello', marks: [{ bold: true }, { italic: true }] }]
						},
						{
							type: 'paragraph',
							content: [{ text: 'world', marks: [{ bold: true }, { italic: true }] }]
						}
					]
				},
				{
					type: 'paragraph',
					content: [{ text: 'Hello world', marks: [{ bold: true }, { italic: true }] }]
				}
			]
		}
	});
</script>

<button
	on:click={() => {
		console.log(edytor.doc.getArray('children').toJSON());
	}}
>
	hello
</button>

<button
	on:click={async () => {
		const firstElement = edytor.container?.querySelector('span[data-edytor-id]');
		setCursorAtPosition(firstElement?.getAttribute('data-edytor-id'), 0);
		const wait = (t:number) =>
			new Promise((res) => {
				setTimeout(res, t);
			});
		let offset = 0;
		await wait(10);

		for (let i = 0; i < 100; i++) {
			if(i===1){
				await wait(1000)
			}
			if(i %2 ){
				await wait(100)
			}
			edytor.onBeforeInput({ inputType: 'insertText', data: `${offset}-` });
			offset += 1;
		}
	}}
>
	insert bunch of text
</button>

<button
	on:click={() => {
		const type = edytor.children[0].get('type') === 'blockquote' ? 'paragraph' : 'blockquote';
		console.log({ type });
		edytor.children[0].set('type', type);
	}}
>
	set block
</button>

<div data-edytor use:edytor.attach>
	{#each edytor.children || [] as yBlock (`${yBlock._item?.id.client}-${yBlock._item?.id.clock}`)}
		<Block {yBlock} />
	{/each}
</div>
