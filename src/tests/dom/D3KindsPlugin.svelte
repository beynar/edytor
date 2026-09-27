<script module lang="ts">
	/**
	 * arch-v2 D3 DOM fixture kinds: an island that renders its content and
	 * children (`box`), a leaf that renders its content (`line`), and a
	 * container whose snippet renders no `content()` while declaring nothing
	 * (`panel` — the undeclared phantom the F-S14 dev check reports).
	 */
	import type { BlockSnippetPayload, Plugin } from '$lib/plugins.js';

	export const d3KindsPlugin: Plugin = () => ({
		blocks: {
			box: { snippet: box, island: true },
			line: { snippet: line },
			panel: { snippet: panel, element: 'section' }
		}
	});
</script>

{#snippet box({ content, children }: BlockSnippetPayload)}
	<div>{@render content()}</div>
	{@render children?.()}
{/snippet}

{#snippet line({ content }: BlockSnippetPayload)}
	{@render content()}
{/snippet}

{#snippet panel({ children }: BlockSnippetPayload)}
	{@render children?.()}
{/snippet}
