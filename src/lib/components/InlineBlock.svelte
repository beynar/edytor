<script lang="ts">
	import { getContext } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
	import type { InlineBlockView } from '$lib/plugins.js';
	import type { AtomPart } from '$lib/surface/cells.js';
	import type { JSONInlineBlock } from '$lib/utils/json.js';

	/** An atom: its cell part and handle, or a suggestion's JSON (no handle, never selected). */
	let {
		block,
		part
	}: {
		block: InlineBlock | undefined;
		part: AtomPart | JSONInlineBlock;
	} = $props();

	const edytor = getContext<Edytor>('edytor');
	const snippet = $derived(edytor.inlineBlocks.get(part.type)?.snippet);
	// The snippet's view object (R4, L48): declared values, reactive through the part.
	const view: InlineBlockView = {
		get id() {
			return block?.id ?? part.id ?? '';
		},
		get type() {
			return part.type;
		},
		get data() {
			return part.data ?? {};
		},
		get selected() {
			return block?.selected ?? false;
		},
		get handle() {
			return block;
		},
		attach: (node: HTMLElement) => block?.attach(node)
	};
</script>

{#if snippet}
	{#if block}
		<span data-edytor-inline-block use:block.attach>
			{@render snippet({ block: view })}
		</span>
	{:else}
		<span data-edytor-inline-block>{@render snippet({ block: view })}</span>
	{/if}
{/if}
