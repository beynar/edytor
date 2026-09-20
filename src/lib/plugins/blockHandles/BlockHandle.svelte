<script lang="ts">
	import type { Block } from '$lib/block/block.svelte.js';
	import type { BlockHandleController } from './BlockHandleController.svelte.js';

	let { block, controller }: { block: Block; controller: BlockHandleController } = $props();
</script>

<button
	type="button"
	class="mr-1 cursor-grab rounded border border-neutral-300 bg-neutral-100 px-1 text-xs text-neutral-700"
	contenteditable="false"
	draggable="true"
	data-testid="block-handle"
	data-block-id={block.id}
	aria-label={`Move ${block.type} block`}
	aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowRight"
	onclick={(event) => {
		event.preventDefault();
		event.stopPropagation();
		controller.selectBlock(block);
	}}
	onpointerdown={(event) => {
		event.stopPropagation();
	}}
	ondragstart={(event) => controller.startDrag(event, block)}
	onkeydown={(event) => controller.handleKeyDown(event, block)}
	data-block-handle-label="::"
></button>

<style>
	button::before {
		content: attr(data-block-handle-label);
	}
</style>
