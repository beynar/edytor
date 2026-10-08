<script lang="ts">
	import { getContext } from 'svelte';
	import type { Edytor } from '../edytor.svelte.js';
	import type { Suggestion } from '../session/suggestions.svelte.js';
	import { previewCells } from '../surface/cells.js';
	import Block from './Block.svelte';

	/**
	 * A block suggestion's preview (`session/suggestions`): its blocks, rendered
	 * by their kinds like the document's, in a non-editable group at its place
	 * in the flow. View-only: registered with the observer as such (never
	 * compared), no handle, no caret, no pointer inside; a press is cancelled.
	 */
	let { suggestion }: { suggestion: Suggestion } = $props();

	const edytor = getContext<Edytor>('edytor');
	// At an `end`, the first block is the ghost text after the block's own.
	const cells = $derived(
		previewCells(
			'end' in suggestion.at ? suggestion.content.slice(1) : suggestion.content,
			suggestion.id
		)
	);
	const cancel = (event: Event) => event.preventDefault();
</script>

<div
	data-edytor-suggestion={suggestion.id}
	data-status={suggestion.status}
	contenteditable="false"
	aria-label={suggestion.label ?? edytor.labels.suggestion}
	role="group"
	use:edytor.surface.preview={suggestion.id}
	onmousedown={cancel}
>
	{#each cells as cell (cell.id)}<Block id={cell.id} preview={cell} />{/each}
</div>

<style>
	[data-edytor-suggestion] {
		user-select: none;
		-webkit-user-select: none;
	}
	/* The content is shown, not used: no link, box or button inside answers a pointer. */
	[data-edytor-suggestion] > :global(*) {
		pointer-events: none;
	}
</style>
