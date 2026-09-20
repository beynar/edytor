<script lang="ts">
	import Edytor, { type EdytorContext } from '$lib/components/Edytor.svelte';
	import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
	import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
	import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
	import { arrowMovePlugin } from '$lib/plugins/arrowMove/arrowMove.js';
	import { imagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';
	import { markdownShortcutsPlugin } from '$lib/plugins/markdownShortcuts.js';
	import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
	import { toolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
	import type { JSONDoc } from '$lib/utils/json.js';

	let edytor = $state<EdytorContext>();
	const plugins = [
		arrowMovePlugin,
		imagePlugin,
		codePlugin,
		markdownShortcutsPlugin,
		mentionPlugin,
		slashMenuPlugin,
		toolbarPlugin,
		richTextPlugin
	];
	const demoValue = {
		children: [
			{
				type: 'paragraph',
				content: [
					{ text: 'hello', marks: { bold: true } },
					{ type: 'mention' },
					{ text: 'World', marks: { bold: true } },
					{ type: 'mention' },
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
	} satisfies JSONDoc;
</script>

<main class="min-h-screen bg-stone-950 px-5 py-8 text-stone-100 sm:px-8 lg:px-12">
	<div class="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[280px_minmax(0,1fr)]">
		<aside class="space-y-5">
			<div>
				<p class="text-xs font-semibold uppercase tracking-[0.28em] text-amber-300/80">
					Edytor Lab
				</p>
				<h1 class="mt-3 text-3xl font-semibold tracking-tight text-stone-50">
					Clean editing surface
				</h1>
				<p class="mt-3 text-sm leading-6 text-stone-400">
					A local playground for typing, splitting, marks, slash commands, and browser behavior.
				</p>
			</div>

			<div class="flex flex-wrap gap-2">
				<button
					type="button"
					onclick={() => {
						edytor?.clear();
					}}
					class="rounded-full bg-amber-300 px-4 py-2 text-sm font-semibold text-stone-950 transition hover:bg-amber-200"
				>
					Clear
				</button>
				<button
					type="button"
					onclick={(e) => {
						e.preventDefault();
						edytor?.selection.state.startText?.setText({
							value: [{ text: 'WAZA', marks: { bold: true } }]
						});
					}}
					class="rounded-full border border-stone-700 px-4 py-2 text-sm text-stone-200 transition hover:border-stone-500 hover:bg-stone-900"
				>
					Set text
				</button>
				<button
					type="button"
					onclick={(e) => {
						e.preventDefault();
						edytor?.selection.state.startText?.parent?.setBlock({
							value: {
								type: 'heading',
								data: { level: 'h2' },
								content: [{ text: 'heading', marks: { bold: true, italic: true } }],
								children: []
							}
						});
					}}
					class="rounded-full border border-stone-700 px-4 py-2 text-sm text-stone-200 transition hover:border-stone-500 hover:bg-stone-900"
				>
					Set block
				</button>
			</div>
		</aside>

		<section
			class="rounded-[2rem] border border-stone-800 bg-stone-100 p-4 text-stone-950 shadow-2xl shadow-black/30 sm:p-6"
		>
			<div
				class="min-h-[32rem] rounded-[1.5rem] bg-white px-5 py-6 shadow-inner shadow-stone-300/60 sm:px-8"
			>
				<Edytor {plugins} value={demoValue} readonly={false} class="outline-none" bind:edytor>
					{#snippet placeholder({ block })}
						{#if block.focused}
							<span>Write something here ...</span>
						{/if}
					{/snippet}
				</Edytor>
			</div>
		</section>
	</div>
</main>

<style lang="postcss">
	@reference "tailwindcss";
	:global {
		[data-edytor-focused] {
			@apply bg-amber-100/70;
		}
		[data-edytor-selected] {
			@apply rounded bg-amber-300/55 ring-2 ring-amber-400;
		}
		[data-edytor-text-suggestion] {
			@apply opacity-60 italic;
		}
		*:has([data-edytor-text-placeholder]) {
			@apply relative;
		}
		[data-edytor-text-placeholder] {
			@apply text-stone-400 italic caret-transparent;
		}
	}
</style>
