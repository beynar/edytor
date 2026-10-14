<script module lang="ts">
	import type { Plugin } from '$lib/plugins.js';
	import { sourcePlugin } from './SourceBlock.svelte';
	import type { Uploader } from '../uploads.svelte.js';

	export type VideoPluginOptions = {
		/**
		 * Upload a video file and answer its URL: an empty block's Upload, and
		 * the pasted and dropped video files, each placed as a block at once
		 * (one undo step), showing its name and progress, then filled with the
		 * URL this answers. Without it, videos are only linked.
		 */
		upload?: Uploader;
	};

	/**
	 * Notion's video block: a video file (an `http(s)` link, or an upload
	 * through `upload`) in the browser's player, with an editable caption.
	 * A YouTube or Vimeo link is an embed (`createEmbedPlugin()`). Void: its only
	 * text is the caption.
	 */
	export const createVideoPlugin = ({ upload }: VideoPluginOptions = {}): Plugin =>
		sourcePlugin('video', ['movie', 'mp4', 'clip'], {}, upload);
</script>
