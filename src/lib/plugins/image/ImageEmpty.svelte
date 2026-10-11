<script lang="ts">
	import { getContext, untrack, type Snippet } from 'svelte';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { Block } from '$lib/block/block.svelte.js';
	import { imageLabels } from './image.js';
	import { ImageEmptyController } from './empty.svelte.js';
	import type { FileUploads, Uploader } from '../uploads.svelte.js';

	/**
	 * An empty image: its state is an `ImageEmptyController` (a readonly view,
	 * or a suggestion's preview, no `block`, may not write), which the
	 * plugin's `empty` snippet draws. A pasted or dropped file whose upload
	 * failed (`error`) opens it with its error; embedding a source forgets
	 * it. A block whose upload answered while it was not shown (`landed`: its
	 * paste undone, then redone) gets that URL as soon as it shows here.
	 */
	let {
		block,
		upload,
		uploads,
		error = null,
		landed = false,
		emptyOf
	}: {
		block: Block | undefined;
		upload?: Uploader;
		uploads?: FileUploads;
		error?: 'upload' | null;
		landed?: boolean;
		/** A view's `empty` snippet: the rendering view's, a suggestion's preview included. */
		emptyOf: (edytor: Edytor) => Snippet<[ImageEmptyController]> | undefined;
	} = $props();

	// After the flush that shows the block: never inside the transaction that showed it.
	$effect(() => {
		if (landed && block && !block.edytor.readonly) {
			const id = block.id;
			untrack(() => uploads?.fill(id));
		}
	});
	/** The view rendering it (a suggestion's preview included): its words and its `empty`. */
	const view = getContext<Edytor>('edytor');
	const labels = imageLabels.of(view);
	const empty = untrack(() => emptyOf(block?.edytor ?? view));
	const panel = untrack(() => new ImageEmptyController(block, labels, { upload, uploads, error }));
</script>

{#if empty}{@render empty(panel)}{/if}
