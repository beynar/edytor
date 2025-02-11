<script module lang="ts">
	import type { Plugin, BlockSnippetPayload } from '$lib/plugins.js';
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
		<img src={'https://placehold.co/600x400'} />
		<figcaption class="text-sm block">
			{@render content()}
		</figcaption>
	</figure>
{/snippet}
