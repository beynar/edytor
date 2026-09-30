<script lang="ts">
	import type { Block } from '$lib/block/block.svelte.js';
	import type { BlockHandleController } from './BlockHandleController.svelte.js';

	import type { Snippet } from 'svelte';
	import type { BlockHandleSnippetPayload } from './blockHandlesPlugin.js';

	let {
		block,
		controller,
		handle
	}: {
		block: Block;
		controller: BlockHandleController;
		handle?: Snippet<[BlockHandleSnippetPayload]>;
	} = $props();
	const grip = $derived(controller.grip(block));
</script>

{#if handle}
	{@render handle({
		block,
		grip,
		add: (above = false) => controller.addBlock(block, above),
		readonly: controller.readonly,
		draggable: controller.draggable
	})}
{:else}
	<button
		type="button"
		class="edytor-block-add"
		contenteditable="false"
		hidden={controller.readonly}
		data-testid="block-add"
		aria-label="Add a block below (Alt: above)"
		title="Click to add below
Alt-click to add a block above"
		onmousedown={(event) => event.preventDefault()}
		onpointerdown={(event) => event.stopPropagation()}
		onclick={(event) => {
			event.preventDefault();
			event.stopPropagation();
			controller.addBlock(block, event.altKey, event.currentTarget);
		}}
	>
		<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
			<path
				d="M8 2.75v10.5M2.75 8h10.5"
				fill="none"
				stroke="currentColor"
				stroke-width="1.4"
				stroke-linecap="round"
			/>
		</svg>
	</button><button
		type="button"
		class="edytor-block-handle"
		contenteditable="false"
		use:grip
		hidden={controller.readonly}
		data-testid="block-handle"
		data-block-id={block.id}
		aria-label={`Move ${block.type} block`}
		aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowRight Alt+ArrowLeft"
		data-draggable={controller.draggable ? 'true' : undefined}
	>
		<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true" focusable="false">
			<circle cx="2.5" cy="3" r="1.3" />
			<circle cx="7.5" cy="3" r="1.3" />
			<circle cx="2.5" cy="8" r="1.3" />
			<circle cx="7.5" cy="8" r="1.3" />
			<circle cx="2.5" cy="13" r="1.3" />
			<circle cx="7.5" cy="13" r="1.3" />
		</svg>
	</button>
{/if}

<style>
	.edytor-block-handle,
	.edytor-block-add {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		padding: 0;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: #ada9a3;
		cursor: pointer;
		transition: background-color 80ms ease;
	}

	.edytor-block-handle {
		width: 18px;
	}

	.edytor-block-handle[data-draggable='true'] {
		cursor: grab;
	}

	.edytor-block-handle[hidden],
	.edytor-block-add[hidden] {
		display: none;
	}

	.edytor-block-handle:hover,
	.edytor-block-handle:focus-visible,
	.edytor-block-add:hover,
	.edytor-block-add:focus-visible {
		background: rgba(33, 27, 23, 0.06);
		outline: 0;
	}

	.edytor-block-handle[data-draggable='true']:active {
		cursor: grabbing;
	}

	.edytor-block-handle svg {
		fill: currentColor;
	}

	/* Notion's drop bar: plain, 4px, indented when the block nests. */
	:global([data-edytor-drop-indicator]) {
		position: absolute;
		z-index: 100;
		box-sizing: border-box;
		height: 4px;
		border: 0;
		border-radius: 0;
		background: var(--edytor-drop-indicator-color, rgba(35, 131, 226, 0.43));
		pointer-events: none;
	}

	/* Notion's nest backdrop: the future parent's own row, softly tinted. */
	:global([data-edytor-drop-backdrop]) {
		position: absolute;
		z-index: 99;
		border-radius: 4px;
		/* One plain color: lightningcss rewrites light-dark() into variables it
		 * only defines beside a `color-scheme`, voiding the background. */
		background: var(--edytor-drop-backdrop-color, rgba(35, 131, 226, 0.14));
		opacity: 0;
		pointer-events: none;
		transition: opacity 120ms ease;
	}

	:global([data-edytor-drop-backdrop][data-shown='true']) {
		opacity: 1;
	}
</style>
