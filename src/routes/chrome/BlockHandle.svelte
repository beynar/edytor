<script lang="ts">
	import type { BlockHandleSnippetPayload } from '$lib/index.js';

	/**
	 * Notion's block handle, drawn for `blockHandles={{ handle }}`: the `+`
	 * (Alt+click adds above, or a column beside a block in a column) and the
	 * ⋮⋮ grip (drag, click for the block menu, Alt+arrows).
	 */
	let { handle }: { handle: BlockHandleSnippetPayload } = $props();
	const { block, grip } = $derived(handle);
	const labels = $derived(handle.labels);
</script>

<button
	type="button"
	class="edytor-block-add"
	contenteditable="false"
	hidden={handle.readonly}
	data-testid="block-add"
	aria-label={handle.beside ? labels.addBeside(handle.label) : labels.add(handle.label)}
	aria-expanded={handle.expanded.add ? 'true' : undefined}
	aria-controls={handle.controls.add}
	aria-haspopup={handle.haspopup.add}
	title={handle.beside ? labels.addBesideHint : labels.addHint}
	onmousedown={(event) => event.preventDefault()}
	onpointerdown={(event) => event.stopPropagation()}
	onclick={(event) => {
		event.preventDefault();
		event.stopPropagation();
		handle.add(event.altKey, event.currentTarget);
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
	hidden={handle.readonly}
	data-testid="block-handle"
	data-block-id={block.id}
	aria-label={labels.grip(handle.label)}
	aria-expanded={handle.expanded.grip ? 'true' : undefined}
	aria-controls={handle.controls.grip}
	aria-haspopup={handle.haspopup.grip}
	aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowRight Alt+ArrowLeft"
	data-draggable={handle.draggable ? 'true' : undefined}
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

	/* Over a gap between two columns, the `+` is compact (the handle spans the gap). */
	:global([data-edytor-block-handle-host][data-over-gap='true']) .edytor-block-add {
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
		background: var(--edytor-drop-indicator-color, rgba(35, 131, 226, 0.43));
	}

	/* Notion's nest backdrop: the future parent's own row, softly tinted. */
	:global([data-edytor-drop-backdrop]) {
		border-radius: 4px;
		/* One plain color: lightningcss rewrites light-dark() into variables it
		 * only defines beside a `color-scheme`, voiding the background. */
		background: var(--edytor-drop-backdrop-color, rgba(35, 131, 226, 0.14));
		opacity: 0;
		transition: opacity 120ms ease;
	}

	:global([data-edytor-drop-backdrop][data-shown='true']) {
		opacity: 1;
	}
</style>
