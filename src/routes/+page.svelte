<script lang="ts">
	import Edytor, { EdytorContext } from '$lib/components/Edytor.svelte';
	import hljs from 'highlight.js';
	import 'highlight.js/styles/github-dark.css';
	import javascript from 'highlight.js/lib/languages/json';
	import { IndexeddbPersistence } from '../lib/localProvider.js';
	import { onMount } from 'svelte';
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
	<div class="col-span-2 card rounded bg-neutral-800 p-2">
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
			sync={({ doc, synced }) => {
				// provider = new IndexeddbPersistence('haha-2', doc);
				provider = new IndexeddbPersistence(crypto.randomUUID(), doc);
				provider.on('synced', () => {
					synced(provider);
				});
			}}
			readonly={false}
			class="outline-none"
			bind:edytor
		>
			{#snippet boldMark({ content, mark, text })}
				<b>{@render content()}</b>
			{/snippet}

			{#snippet italicMark({ content, mark, text })}
				<i>{@render content()}</i>
			{/snippet}

			{#snippet paragraphBlock({ block, content, children })}
				<div use:block.attach>
					<p>
						{@render content()}
					</p>
					{#if children}
						<div style="padding-left: 20px">
							{@render children()}
						</div>
					{/if}
				</div>
			{/snippet}
			{#snippet quoteBlock({ block, content, children })}
				<div use:block.attach>
					<p>
						{@render content()}
					</p>
					{#if children}
						<div style="padding-left: 20px">
							{@render children()}
						</div>
					{/if}
				</div>
			{/snippet}
		</Edytor>
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
						isAtStart: edytor?.selection?.state?.isAtStart,
						isAtEnd: edytor?.selection?.state?.isAtEnd,
						text: edytor?.selection?.state?.content,
						yTextContent: edytor?.selection?.state?.yTextContent
					},
					null,
					2
				)}></pre>
		{/key}
	</div>
</div>
