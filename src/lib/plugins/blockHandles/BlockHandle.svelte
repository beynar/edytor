<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Block } from '$lib/block/block.svelte.js';
	import type { BlockHandleController } from './BlockHandleController.svelte.js';
	import type { BlockHandleSnippetPayload } from './blockHandlesPlugin.js';

	/** One block's handle: the app's `handle` snippet, with the block's payload (reactive). */
	let {
		block,
		controller,
		handle
	}: {
		block: Block;
		controller: BlockHandleController;
		handle: Snippet<[BlockHandleSnippetPayload]>;
	} = $props();
	const grip = $derived(controller.grip(block));
	/** The menus this handle's `+` and grip opened, while open: their `aria-expanded`. */
	const added = $derived(controller.opened(block, 'add'));
	const gripped = $derived(controller.opened(block, 'grip'));
</script>

{@render handle({
	block,
	label: controller.labelOf(block),
	grip,
	add: (alt = false, anchor) => controller.addBlock(block, alt, anchor ?? block.node ?? null),
	beside: controller.addsColumn(block),
	readonly: controller.readonly,
	draggable: controller.draggable,
	expanded: { add: added !== undefined, grip: gripped !== undefined },
	controls: { add: added?.id, grip: gripped?.id },
	haspopup: { add: added?.haspopup, grip: gripped?.haspopup }
})}
