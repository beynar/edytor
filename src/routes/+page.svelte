<script lang="ts">
	import Edytor, { EdytorContext } from '$lib/components/Edytor.svelte';
	import hljs from 'highlight.js';
	import 'highlight.js/styles/github-dark.css';
	import javascript from 'highlight.js/lib/languages/json';
	import { IndexeddbPersistence } from '../lib/localProvider.js';
	import { onMount } from 'svelte';
	import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
	import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
	import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
	import { arrowMovePlugin } from '$lib/plugins/arrowMove/arrowMove.js';
	import ReadonlyEditor from '$lib/components/ReadonlyEditor.svelte';

	hljs.registerLanguage('javascript', javascript);
	const highlight = (node: HTMLElement, json: string) => {
		const highlighted = hljs.highlight(json, { language: 'json' }).value;
		node.innerHTML = highlighted;
	};

	let edytor = $state<EdytorContext>();

	let provider = $state<any>();

	onMount(() => {
		return () => {
			provider.destroy();
		};
	});

	let value = $state<{ children: any[] }>({
		children: [
			{
				type: 'paragraph',
				content: 'hello',
				children: []
			}
		]
	});
</script>

<button
	onclick={() => {
		const indexedDB = window.indexedDB;
		indexedDB.databases().then((databases) => {
			databases.forEach((database) => {
				indexedDB.deleteDatabase(database.name);
			});
		});
	}}
>
	clear
</button>
<div class="grid grid-cols-3 p-10">
	<div class="col-span-2">
		<div class="card rounded bg-neutral-800 p-2">
			<button
				onclick={(e) => {
					e.preventDefault();
					edytor?.selection.state.startText?.set([{ text: 'WAZA', marks: { bold: true } }]);
				}}
			>
				set text
			</button>
			<button
				onclick={(e) => {
					e.preventDefault();
					edytor?.selection.state.startText?.parent?.set({
						type: 'quote',
						content: [{ text: 'quote', marks: { bold: true, italic: true } }],
						children: []
					});
				}}
			>
				set block
			</button>
			<button
				onclick={(e) => {
					e.preventDefault();
					console.log({
						doc: edytor?.doc.toJSON(),
						value: edytor?.value
					});
				}}
			>
				get value
			</button>
			<Edytor
				plugins={[arrowMovePlugin, codePlugin, mentionPlugin, richTextPlugin]}
				sync={({ doc, synced }) => {
					// provider = new IndexeddbPersistence('haha-2', doc);
					provider = new IndexeddbPersistence(crypto.randomUUID(), doc);
					provider.on('synced', () => {
						synced(provider);
					});
				}}
				onChange={(e) => {
					console.log('change', edytor?.doc.toJSON());
				}}
				readonly={false}
				class="outline-none"
				bind:edytor
			/>
			{#if edytor && edytor.value}
				<ReadonlyEditor
					plugins={[codePlugin, mentionPlugin, richTextPlugin]}
					value={{ children: edytor.value.children }}
					class="outline-none"
				/>
			{/if}
		</div>
		<div class="card rounded bg-neutral-800 p-2 mt-2">
			<pre>
{JSON.stringify(edytor?.value, null, 2)}
		</pre>
		</div>
	</div>
	<div>
		{#key edytor?.selection.state}
			<pre
				use:highlight={JSON.stringify(
					{
						start: edytor?.selection?.state?.start,
						end: edytor?.selection?.state?.end,
						yStart: edytor?.selection?.state?.yStart,
						yEnd: edytor?.selection?.state?.yEnd,
						length: edytor?.selection?.state?.length,
						isAtStartOfBlock: edytor?.selection?.state?.isAtStartOfBlock,
						isAtEndOfBlock: edytor?.selection?.state?.isAtEndOfBlock,
						text: edytor?.selection?.state?.content,
						yTextContent: edytor?.selection?.state?.yTextContent
					},
					null,
					2
				)}></pre>
		{/key}
	</div>
</div>

<style lang="postcss">
	:global {
		[data-edytor-focused] {
			@apply bg-blue-100/10;
		}
		[data-edytor-selected] {
			@apply bg-red-100/50;
		}
		[data-edytor-text-suggestion] {
			@apply opacity-65 italic;
		}
	}
</style>
