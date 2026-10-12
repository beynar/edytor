<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { Plugin } from '$lib/plugins.js';
	import { emptyHosts } from './EmptySlot.svelte';
	import Self from './MediaEmpty.svelte';

	export type MediaEmptyOptions = {
		/**
		 * An empty image's or media block's markup and its words (Notion's "Add
		 * an image", "Embed a video"… and their link panel, a pasted or dropped
		 * file's upload, or a readonly view's placeholder): it receives the
		 * block's `MediaEmptyController` (`kind` says which: image, embed,
		 * bookmark, file, video, audio).
		 */
		empty: Snippet<[MediaEmptyController]>;
	};

	/**
	 * The empty image and media blocks' chrome: your `empty` snippet for each
	 * of them (without the plugin, an empty block shows nothing). The first
	 * listed claims the view.
	 */
	export const createMediaEmptyPlugin =
		({ empty }: MediaEmptyOptions): Plugin =>
		(edytor) => {
			if (edytor && !emptyHosts.has(edytor)) emptyHosts.set(edytor, { Host: Self, empty });
			return {};
		};
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import type { Block } from '$lib/block/block.svelte.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import type { MediaKind } from './media.js';
	import { MediaEmptyController, type EmptyView } from './empty.svelte.js';
	import { fileUploads } from '../uploads.svelte.js';

	/**
	 * An image's or a media block's empty state: a `MediaEmptyController`,
	 * which the view's `empty` snippet draws. The kind in the
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
		viewOf,
		empty
	}: {
		block: Block | undefined;
		kind: MediaKind | 'image';
		/** The kind in a view: how it stores a source. */
		viewOf: (edytor: Edytor | undefined) => EmptyView | undefined;
		/** The view's `empty` snippet. */
		empty: Snippet<[MediaEmptyController]>;
	} = $props();
	const panel = untrack(() => new MediaEmptyController(block, kind, viewOf(block?.edytor)));
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

{@render empty(panel)}
