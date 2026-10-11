<script lang="ts">
	import { getContext, untrack } from 'svelte';
	import type { Block } from '$lib/block/block.svelte.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import { MEDIA_ICONS, mediaLabelsOf, mediaView, type MediaKind } from './media.js';
	import { MediaEmptyController } from './empty.svelte.js';
	import { fileUploads } from '../uploads.svelte.js';

	/**
	 * A media block's empty state: a `MediaEmptyController`, which the view's
	 * `empty` snippet for the kind draws. The kind in the block's view
	 * (`mediaView`) stores the link, or an uploaded file's URL (only on a
	 * block still empty when it lands). A readonly view, or a suggestion's
	 * preview (no `block`), may not write: no control may run `upload` (or a
	 * bookmark's `unfurl`). A pasted or dropped file (`media.files`) shows
	 * its upload (`pending`); a failed one opens the panel with its error;
	 * data answered while the block was not shown fills it as soon as it
	 * shows.
	 */
	let {
		block,
		kind
	}: {
		block: Block | undefined;
		/** Whose words it shows, in the labels of the view rendering it (a suggestion's preview included). */
		kind: MediaKind;
	} = $props();
	/** The view rendering it (a suggestion's preview included): whose labels it shows. */
	const view = getContext<Edytor>('edytor');
	const panel = untrack(() => {
		/** The kind in the block's view: its `upload`, how it stores a source. */
		const own = mediaView(block?.edytor, kind);
		const store = (value: string, file?: File) => Boolean(block && own?.store(block, value, file));
		return new MediaEmptyController(
			block,
			kind,
			MEDIA_ICONS[kind],
			() => mediaLabelsOf(view, kind),
			{
				accept: kind === 'video' || kind === 'audio' ? `${kind}/*` : undefined,
				upload: own?.upload,
				link: (value) => store(value),
				file: (picked, src) => store(src, picked)
			}
		);
	});
	const empty = untrack(() => mediaView(block?.edytor ?? view, kind)?.empty);
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
