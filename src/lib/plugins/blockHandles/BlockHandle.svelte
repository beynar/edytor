<script lang="ts">
	import type { Block } from '$lib/block/block.svelte.js';
	import type { BlockHandleController } from './BlockHandleController.svelte.js';

	let { block, controller }: { block: Block; controller: BlockHandleController } = $props();
	const registerHandle = (node: HTMLElement) => ({
		destroy: controller.registerHandle(node, block)
	});
</script>

<button
	type="button"
	class="edytor-block-handle"
	contenteditable="false"
	use:registerHandle
	hidden={controller.readonly}
	data-testid="block-handle"
	data-block-id={block.id}
	aria-label={`Move ${block.type} block`}
	aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowRight Alt+ArrowLeft"
	onclick={(event) => {
		event.preventDefault();
		event.stopPropagation();
		controller.activateBlock(block, event.currentTarget);
	}}
	onpointerdown={(event) => {
		event.stopPropagation();
	}}
	onkeydown={(event) => controller.handleKeyDown(event, block)}
	data-draggable={controller.draggable ? 'true' : undefined}
>
	<svg viewBox="0 0 14 18" width="14" height="18" aria-hidden="true" focusable="false">
		<circle cx="4" cy="4" r="1.35" />
		<circle cx="10" cy="4" r="1.35" />
		<circle cx="4" cy="9" r="1.35" />
		<circle cx="10" cy="9" r="1.35" />
		<circle cx="4" cy="14" r="1.35" />
		<circle cx="10" cy="14" r="1.35" />
	</svg>
</button>

<style>
	.edytor-block-handle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		padding: 0;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: #9b9a97;
		cursor: pointer;
	}

	.edytor-block-handle[data-draggable='true'] {
		cursor: grab;
	}

	.edytor-block-handle[hidden] {
		display: none;
	}

	.edytor-block-handle:hover,
	.edytor-block-handle:focus-visible {
		background: #f1f1ef;
		color: #37352f;
	}

	.edytor-block-handle[data-draggable='true']:active {
		cursor: grabbing;
	}

	.edytor-block-handle svg {
		fill: currentColor;
	}

	:global([data-edytor-drop-indicator]) {
		position: absolute;
		z-index: 100;
		box-sizing: border-box;
		height: 2px;
		border: 0;
		border-radius: 0;
		background: var(--edytor-drop-indicator-color, #2383e2);
		pointer-events: none;
	}

	:global([data-edytor-drop-indicator][data-position='before']::before),
	:global([data-edytor-drop-indicator][data-position='after']::before) {
		position: absolute;
		left: -4px;
		top: -3px;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--edytor-drop-indicator-color, #2383e2);
		content: '';
	}

	:global([data-edytor-drop-indicator][data-position='inside']) {
		border: 2px solid var(--edytor-drop-indicator-color, #2383e2);
		background: transparent;
	}
</style>
