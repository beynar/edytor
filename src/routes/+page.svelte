<script lang="ts">
	import Edytor, { EdytorContext } from '$lib/components/Edytor.svelte';
	import { IndexeddbPersistence } from '../lib/localProvider.js';
	import { onMount } from 'svelte';
	import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
	import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
	import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
	import { arrowMovePlugin } from '$lib/plugins/arrowMove/arrowMove.js';
	import { imagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';
	import { Inspect } from 'svelte-inspect-value';

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
<div class="grid grid-cols-4 gap-2 p-10">
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
				plugins={[arrowMovePlugin, imagePlugin, codePlugin, mentionPlugin, richTextPlugin]}
				sync={({ doc, synced }) => {
					// provider = new IndexeddbPersistence('haha-2', doc);
					provider = new IndexeddbPersistence(crypto.randomUUID(), doc);
					provider.on('synced', () => {
						synced(provider);
					});
				}}
				onChange={(e) => {
					// console.log('change', edytor?.doc.toJSON());
				}}
				readonly={false}
				class="outline-none"
				bind:edytor
			>
				{#snippet placeholder({ block })}
					{#if block.focused}
						<span>Write something here ...</span>
					{/if}
				{/snippet}
			</Edytor>
			<!-- {#if edytor && edytor.value}
				<ReadonlyEditor
					plugins={[codePlugin, imagePlugin, mentionPlugin, richTextPlugin]}
					value={{ children: edytor?.root?.value.children || [] }}
					class="outline-none"
				/>
			{/if} -->
		</div>
	</div>
	<div class="col-span-2">
		<Inspect
			name="Edytor"
			noanimate
			showTypes={false}
			showLength={false}
			theme="stereo"
			expandLevel={2}
			value={edytor?.root?.value}
		/>

		<hr class="my-2" />
		<Inspect
			name="Selection"
			noanimate
			showTypes={false}
			showLength={false}
			theme="stereo"
			value={{
				start: edytor?.selection?.state?.start,
				end: edytor?.selection?.state?.end,
				yStart: edytor?.selection?.state?.yStart,
				yEnd: edytor?.selection?.state?.yEnd,
				length: edytor?.selection?.state?.length,
				isAtStartOfBlock: edytor?.selection?.state?.isAtStartOfBlock,
				isAtEndOfBlock: edytor?.selection?.state?.isAtEndOfBlock,
				text: edytor?.selection?.state?.content,
				yTextContent: edytor?.selection?.state?.yTextContent
			}}
		/>
	</div>
</div>

<style lang="postcss">
	:global {
		[data-edytor-focused] {
			@apply bg-blue-100/10;
		}
		[data-edytor-selected] {
			@apply bg-blue-500/50 ring-2 ring-blue-500 rounded;
		}
		[data-edytor-text-suggestion] {
			@apply opacity-65 italic;
		}
		*:has([data-edytor-text-placeholder]) {
			@apply relative;
		}
		[data-edytor-text-placeholder] {
			@apply opacity-65 italic caret-transparent;
		}
	}
</style>
