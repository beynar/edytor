<script lang="ts">
	import { getContext, untrack } from 'svelte';
	import type { Block } from '$lib/block/block.svelte.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { MediaKind } from './media.js';
	import { MediaEmptyController, type EmptyView } from './empty.svelte.js';
	import { fileUploads } from '../uploads.svelte.js';

	/**
	 * An image's or a media block's empty state: a `MediaEmptyController`,
	 * which the view's `empty` snippet for the kind draws. The kind in the
	 * block's view (`viewOf`) stores the link, or an uploaded file's URL
	 * (only on a block still empty when it lands). A readonly view, or a
	 * suggestion's preview (no `block`), may not write: no control may run
	 * `upload`. A pasted or dropped file shows its upload (`pending`); a
	 * failed one opens the panel with its error; data answered while the
	 * block was not shown fills it as soon as it shows.
	 */
	let {
		block,
		kind,
		viewOf
	}: {
		block: Block | undefined;
		kind: MediaKind | 'image';
		/** The kind in a view: its `empty`, `upload` and `store`. */
		viewOf: (edytor: Edytor | undefined) => EmptyView | undefined;
	} = $props();
	/** The view rendering it (a suggestion's preview included): whose `empty` it draws. */
	const view = getContext<Edytor>('edytor');
	const panel = untrack(() => new MediaEmptyController(block, kind, viewOf(block?.edytor)));
	const empty = untrack(() => viewOf(block?.edytor ?? view)?.empty);
	/** The upload of a pasted or dropped file into this block, if any. */
	const pending = $derived(panel.pending);
	// After the flush that shows the block: never inside the transaction that showed it.
	$effect(() => {
		if (pending?.status === 'landed' && block && !block.edytor.readonly) {
			const id = block.id;
			untrack(() => fileUploads(block.edytor)?.fill(id));
		}
	});
	// The panel opens on a failed upload, with its error; the user closes it.
	$effect(() => {
		if (pending?.status === 'failed')
			untrack(() => {
				panel.open = true;
				panel.failed = 'upload';
			});
	});
</script>

{#if empty}{@render empty(panel)}{/if}
