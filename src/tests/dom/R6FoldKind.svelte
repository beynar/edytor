<script module lang="ts">
	/**
	 * arch-v2 R6 fixture (F-O2): extension view state rendered into the host
	 * (L13) — a kind whose snippet draws local fold state around its slots.
	 * The extension bumps the render epoch (`surface.update`) on each change.
	 */
	import type { BlockSnippetPayload, Plugin } from '$lib/plugins.js';

	export const fold = $state({ open: true });

	export const foldPlugin: Plugin = () => ({ blocks: { fold: { snippet } } });
</script>

{#snippet snippet({ content, children }: BlockSnippetPayload)}
	<div data-fold={fold.open ? 'open' : 'closed'}>
		{#if !fold.open}<span contenteditable="false">▸</span>{/if}{@render content()}
	</div>
	{@render children?.()}
{/snippet}
