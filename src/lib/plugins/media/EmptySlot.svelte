<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { Block } from '$lib/block/block.svelte.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { MediaKind } from './media.js';
	import { MediaEmptyController, type EmptyView } from './empty.svelte.js';

	/** Each view's empty-block markup (the first media empty plugin listed claims it). */
	export const emptyHosts = new WeakMap<object, Snippet<[MediaEmptyController]>>();
</script>

<script lang="ts">
	import { getContext, untrack } from 'svelte';
	import { fileUploads } from '../uploads.svelte.js';

	/**
	 * Where an empty image or media block shows its empty state: a
	 * `MediaEmptyController`, which the view's `empty` snippet (the media
	 * empty plugin's) draws, when one is listed (else nothing). The view
	 * rendering it is the block's, or a suggestion preview's. The kind in the
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
		/** The kind in a view: how it stores a source. */
		viewOf: (edytor: Edytor | undefined) => EmptyView | undefined;
	} = $props();
	const view = getContext<Edytor>('edytor');
	const empty = untrack(() => emptyHosts.get(block?.edytor ?? view));
	const panel = untrack(() => new MediaEmptyController(block, kind, viewOf(block?.edytor)));
	/** The upload of a pasted or dropped file into this block, if any. */
	const pending = $derived(empty && panel.pending);
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
