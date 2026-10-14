<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { MediaEmptyController } from './empty.svelte.js';
	import type { Plugin } from '$lib/plugins.js';
	import { emptyHosts } from './EmptySlot.svelte';

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
			if (edytor && !emptyHosts.has(edytor)) emptyHosts.set(edytor, empty);
			return {};
		};
</script>
