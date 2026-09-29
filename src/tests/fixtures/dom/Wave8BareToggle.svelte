<script module lang="ts">
	/**
	 * The toggle override pattern of customization/blocks.mdx with no child
	 * wrapper: each child block's element sits directly under `<details>`
	 * (YW-12). Placed before the rich-text plugin, its definition wins.
	 */
	import type { BlockSnippetPayload, Plugin } from '$lib/plugins.js';

	export const bareTogglePlugin: Plugin = () => ({
		blocks: {
			toggle: {
				continues: true,
				container: true,
				element: 'details',
				viewState: ['open'],
				snippet: bareToggle
			}
		}
	});
</script>

{#snippet bareToggle({ content, children }: BlockSnippetPayload)}
	<summary>{@render content()}</summary>
	{@render children?.()}
{/snippet}
