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
			panel: { snippet: panel }
		}
	});
</script>

{#snippet box({ block, content, children }: BlockSnippetPayload)}
	<div use:block.attach>
		<div>{@render content()}</div>
		{@render children?.()}
	</div>
{/snippet}

{#snippet line({ block, content }: BlockSnippetPayload)}
	<div use:block.attach>{@render content()}</div>
{/snippet}

{#snippet panel({ block, children }: BlockSnippetPayload)}
	<section use:block.attach>{@render children?.()}</section>
{/snippet}
