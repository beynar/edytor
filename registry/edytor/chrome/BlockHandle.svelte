<script lang="ts">
	import { Button } from '$registry/ui/button/index.js';
	import { words } from './words.svelte.js';
	import type { BlockHandleSnippetPayload } from 'edytor';

	/**
	 * Notion's block handle, drawn for `blockHandles={{ handle }}`: the `+`
	 * (Alt+click adds above, or a column beside a block in a column) and the
	 * ⋮⋮ grip (drag, click for the block menu, Alt+arrows).
	 */
	let { handle }: { handle: BlockHandleSnippetPayload } = $props();
	const { block, grip, plus } = $derived(handle);
	const labels = $derived(words.blockHandles);
</script>

<Button
	variant="ghost"
	class="edytor-block-add"
	contenteditable="false"
	hidden={handle.readonly}
	data-testid="block-add"
	aria-label={handle.beside ? labels.addBeside(handle.label) : labels.add(handle.label)}
	title={handle.beside ? labels.addBesideHint : labels.addHint}
	{@attach plus}
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
</Button><Button
	variant="ghost"
	class="edytor-block-handle"
	contenteditable="false"
	hidden={handle.readonly}
	data-testid="block-handle"
	data-block-id={block.id}
	aria-label={labels.grip(handle.label)}
	data-draggable={handle.draggable ? 'true' : undefined}
	{@attach grip}
>
	<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true" focusable="false">
		<circle cx="2.5" cy="3" r="1.3" />
		<circle cx="7.5" cy="3" r="1.3" />
		<circle cx="2.5" cy="8" r="1.3" />
		<circle cx="7.5" cy="8" r="1.3" />
		<circle cx="2.5" cy="13" r="1.3" />
		<circle cx="7.5" cy="13" r="1.3" />
	</svg>
</Button>

<style>
	:global(.edytor-block-handle),
	:global(.edytor-block-add) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		padding: 0;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--muted-foreground);
		cursor: pointer;
		transition: background-color 80ms ease;
	}

	:global(.edytor-block-handle) {
		width: 18px;
	}

	/* Over a gap between two columns, the `+` is compact (the handle spans the gap). */
	:global([data-edytor-block-handle-host][data-over-gap='true']) :global(.edytor-block-add) {
		width: 18px;
	}

	:global(.edytor-block-handle[data-draggable='true']) {
		cursor: grab;
	}

	:global(.edytor-block-handle[hidden]),
	:global(.edytor-block-add[hidden]) {
		display: none;
	}

	:global(.edytor-block-handle:hover),
	:global(.edytor-block-handle:focus-visible),
	:global(.edytor-block-add:hover),
	:global(.edytor-block-add:focus-visible) {
		background: var(--accent);
		outline: 0;
	}

	:global(.edytor-block-handle[data-draggable='true']:active) {
		cursor: grabbing;
	}

	:global(.edytor-block-handle svg) {
		fill: currentColor;
	}
</style>
