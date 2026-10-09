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
	/** A live atom's element registers with its handle; a suggestion's has none. */
	const attach = (node: HTMLElement) => block?.attach(node);
	// The snippet's view object: declared values, reactive through the part.
	const view: InlineBlockView = {
		get id() {
			return block?.id ?? part.id ?? '';
		},
		get type() {
			return part.type;
		},
		get data() {
			return block ? block.data : (part.data ?? {});
		},
		get selected() {
			return block?.selected ?? false;
		},
		get handle() {
			return block;
		}
	};
</script>

<!-- `Content` renders only the atoms whose kind has a snippet: the span is the root, no anchor. -->
<span data-edytor-inline-block use:attach>{@render snippet?.({ block: view })}</span>
