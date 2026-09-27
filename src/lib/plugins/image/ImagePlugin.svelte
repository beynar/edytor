<script module lang="ts">
	import type { Plugin, BlockSnippetPayload } from '$lib/plugins.js';
	// File paste/drop payloads (`clipboardData.files` / `dataTransfer.files`)
	// already route through the plugin `onPaste` hook — claiming is done via
	// `prevent`. The image upload/insert consumer is intentionally not wired
	// yet: add `onPaste: ({ prevent, e }) => { const files = e.clipboardData?.files; ... }`
	// here (or in a dedicated upload plugin) when it is.
	export const imagePlugin: Plugin = (edytor) => {
		return {
			blocks: {
				image: {
					void: true,
					snippet: image,
					element: { tag: 'figure', attributes: { class: 'flex flex-col gap-1' } },
					html: (_, caption) => `<figure><figcaption>${caption}</figcaption></figure>`
				}
			}
		};
	};
</script>

{#snippet image({ content }: BlockSnippetPayload)}
	<button type="button">click me</button>
	<input type="text" />
	<img src={'https://placehold.co/600x400'} alt="" />
	<!-- The core renders the kind's <figure> around this markup. -->
	<!-- svelte-ignore a11y_figcaption_parent -->
	<figcaption class="text-sm block">
		{@render content()}
	</figcaption>
{/snippet}
