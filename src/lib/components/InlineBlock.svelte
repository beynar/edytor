<script lang="ts">
	import type { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
	import type { InlineBlockView } from '$lib/plugins.js';
	import type { AtomPart } from '$lib/surface/cells.js';

	/** An atom's handle (a suggestion's: its readonly stand-in) and, in the document, its cell part. */
	let {
		block,
		part
	}: {
		block: InlineBlock | undefined;
		part?: AtomPart;
	} = $props();

	const snippet = $derived(block?.edytor.inlineBlocks.get(part?.type ?? block.type)?.snippet);
	// The snippet's view object (R4): declared values, reactive through the cell part.
	const view = $derived<InlineBlockView | undefined>(
		block && {
			id: block.id,
			get type() {
				return part?.type ?? block.type;
			},
			get data() {
				return part ? (part.data ?? {}) : block.data;
			},
			get selected() {
				return !block.readonly && block.selected;
			},
			handle: block,
			attach: block.attach
		}
	);
</script>

{#if block && view && snippet}
	<span data-edytor-inline-block use:block.attach>
		{@render snippet({ block: view })}
	</span>
{/if}
