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
					snippet: image
				}
			}
		};
	};
</script>

{#snippet image({ block, content }: BlockSnippetPayload)}
	<figure class="flex flex-col gap-1" use:block.attach>
		<button type="button">click me</button>
		<input type="text" />
		<img src={'https://placehold.co/600x400'} alt="" />
		<figcaption class="text-sm block">
			{@render content()}
		</figcaption>
	</figure>
{/snippet}
