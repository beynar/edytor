<script module lang="ts">
	import { DEV } from 'esm-env';
	import type { Edytor } from '../edytor.svelte.js';

	const reported = new WeakMap<Edytor, Set<string>>();

	/**
	 * Dev check of the declared `rendersContent` (O22, F-S14): a kind whose
	 * snippet rendered `content()` against its declaration is reported once
	 * per editor — an undeclared phantom slot would take carets and endpoints
	 * the user cannot see.
	 */
	const checkRendersContent = (block: Block, rendered: boolean) => {
		const kinds = reported.get(block.edytor) ?? new Set<string>();
		if (block.rendersContent === rendered || kinds.has(block.type)) return;
		reported.set(block.edytor, kinds.add(block.type));
		console.warn(
			`[edytor] block kind "${block.type}" declares rendersContent: ${!rendered} but its ` +
				`snippet ${rendered ? 'renders' : 'does not render'} content().`
		);
	};
</script>

<script lang="ts">
	import { Block } from '../block/block.svelte.js';
	import Child from './Block.svelte';
	import Content from './Content.svelte';

	let {
		block
	}: {
		block: Block;
	} = $props();

	const snippet = $derived(block.definition.snippet);
	const snippetKey = $derived(
		block.type === 'heading' ? `${block.type}:${block.data.level ?? 'h1'}` : block.type
	);
	const getBlockRenderKey = (child: Block) => child.id;

	// The snippet key `content()` last rendered under — read after each render.
	let contentRenderedFor: string | null = null;
	$effect(() => {
		if (DEV) checkRendersContent(block, contentRenderedFor === snippetKey);
	});
</script>

<!--
-->{#snippet content()}<!--
--><Content
		{block}
		onrender={DEV ? () => (contentRenderedFor = snippetKey) : undefined}
	/><!--
-->{/snippet}<!--
-->{#snippet children()}<!--
--->{#each block.children as child (getBlockRenderKey(child))}<!--
--><Child
			block={child}
		/><!--
-->{/each}<!--
-->{/snippet}<!--
-->{#key snippetKey}<!--
-->{@render snippet({
		block,
		content,
		children: block.children.length ? children : null
	})}<!--
-->{/key}<!--
-->
