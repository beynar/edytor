<script lang="ts">
	import { getContext } from 'svelte';
	import type { Block } from '$lib/block/block.svelte.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { BlockView } from '$lib/plugins.js';
	import { richTextLabels } from './labels.js';

	/**
	 * A to-do's checkbox, named in the labels of the view rendering it (a
	 * suggestion's preview included).
	 */
	let {
		block,
		toggle
	}: { block: BlockView<{ checked?: boolean }>; toggle: (block: Block) => void } = $props();
	const labels = richTextLabels.of(getContext<Edytor>('edytor'));
</script>

<input
	type="checkbox"
	checked={Boolean(block.data.checked)}
	contenteditable="false"
	aria-label={labels.checkbox}
	data-edytor-todo-checkbox
	onmousedown={(event) => event.preventDefault()}
	onclick={(event) => {
		// Never cancel the click: the browser reverts a canceled checkbox click after
		// its handlers, over the re-render this write makes, so the box would show the
		// old state here while peers show the new one. Toggle the document, then show
		// what it holds (a refused write, readonly or vetoed, shows unchanged).
		// A suggestion's preview (no handle) writes nothing.
		if (block.handle) toggle(block.handle);
		event.currentTarget.checked = Boolean(block.data.checked);
	}}
/>
