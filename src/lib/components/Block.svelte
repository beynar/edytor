<script module lang="ts">
	import { DEV } from 'esm-env';
	import type { Edytor } from '../edytor.svelte.js';
	import type { Block as BlockWrapper } from '../block/block.svelte.js';

	const reported = new WeakMap<Edytor, Set<string>>();

	/**
	 * Dev check of the declared `rendersContent` (O22, F-S14): a kind whose
	 * snippet rendered `content()` against its declaration is reported once
	 * per editor — an undeclared phantom slot would take carets and endpoints
	 * the user cannot see.
	 */
	const checkRendersContent = (block: BlockWrapper, rendered: boolean) => {
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
	import { getContext } from 'svelte';
	import Child from './Block.svelte';
	import Content from './Content.svelte';

	let {
		id
	}: {
		id: string;
	} = $props();

	const edytor = getContext<Edytor>('edytor');
	// The structure renders from the cell (R2); the snippet still receives the
	// block's wrapper until R4 hands extensions view objects.
	const cell = $derived(edytor.cells?.get(id));
	const block = $derived(edytor.idToBlock.get(id));
	const snippet = $derived(cell && edytor.getBlockDefinition('block', cell.type).snippet);
	const snippetKey = $derived(
		cell?.type === 'heading' ? `${cell.type}:${cell.data?.level ?? 'h1'}` : cell?.type
	);

	// The snippet key `content()` last rendered under — read after each render.
	let contentRenderedFor: string | null | undefined = null;
	$effect(() => {
		if (DEV && block) checkRendersContent(block, contentRenderedFor === snippetKey);
	});
</script>

<!--
-->{#snippet content()}<!--
--><Content
		{id}
		onrender={DEV ? () => (contentRenderedFor = snippetKey) : undefined}
	/><!--
-->{/snippet}<!--
-->{#snippet children()}<!--
--->{#each cell?.childIds ?? [] as child (child)}<!--
--><Child
			id={child}
		/><!--
-->{/each}<!--
-->{/snippet}<!--
-->{#if cell && block && snippet}<!--
-->{#key snippetKey}<!--
-->{@render snippet(
			{
				block,
				content,
				children: cell.childIds.length ? children : null
			}
		)}<!--
-->{/key}<!--
-->{/if}<!--
-->
