<script module lang="ts">
	import type { Plugin } from '$lib/plugins.js';
	import type { MediaPluginOptions } from './media.js';
	import { sourcePlugin } from './SourceBlock.svelte';

	/**
	 * Notion's video block: a video file (an `http(s)` link, or an upload
	 * through `upload`) in the browser's player, with an editable caption.
	 * A YouTube or Vimeo link is an embed (`createEmbedPlugin()`). Void: its only
	 * text is the caption.
	 */
	export const createVideoPlugin = (options: MediaPluginOptions = {}): Plugin =>
		sourcePlugin('video', options, ['movie', 'mp4', 'clip']);
</script>
