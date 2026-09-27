<script module lang="ts">
	import { DEV } from 'esm-env';
	import type { Edytor } from '../edytor.svelte.js';
	import type { Block as BlockHandle } from '../block/block.svelte.js';
	import type { BlockView } from '../plugins.js';

	const reported = new WeakMap<Edytor, Set<string>>();

	/** A snippet's view object (R4): declared values read from the cell and the selection. */
	const viewOf = (edytor: Edytor, id: string): BlockView => {
		const handle = edytor.idToBlock.block(id);
		return {
			id,
			get type() {
				return edytor.cells?.get(id)?.type ?? handle.type;
			},
			get data() {
				return edytor.cells?.get(id)?.data ?? {};
			},
			get selected() {
				return handle.selected;
			},
			get focused() {
				return handle.focused;
			},
			handle,
			attach: handle.attach,
			void: handle.void
		};
	};

	/**
	 * Dev check of the declared `rendersContent` (O22, F-S14): a kind whose
	 * snippet rendered `content()` against its declaration is reported once
	 * per editor — an undeclared phantom slot would take carets and endpoints
	 * the user cannot see.
	 */
	const checkRendersContent = (block: BlockHandle, rendered: boolean) => {
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
	// The structure renders from the cell (R2); the snippet receives a view object (R4).
	const cell = $derived(edytor.cells?.get(id));
	const block = $derived(viewOf(edytor, id));
	const snippet = $derived(cell && edytor.getBlockDefinition('block', cell.type).snippet);
	const snippetKey = $derived(
		cell?.type === 'heading' ? `${cell.type}:${cell.data?.level ?? 'h1'}` : cell?.type
	);

	// The snippet key `content()` last rendered under — read after each render.
	let contentRenderedFor: string | null | undefined = null;
	$effect(() => {
		if (DEV) checkRendersContent(block.handle, contentRenderedFor === snippetKey);
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
-->{#if cell && snippet}<!--
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
