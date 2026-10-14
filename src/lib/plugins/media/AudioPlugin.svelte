<script module lang="ts">
	import type { Plugin } from '$lib/plugins.js';
	import { sourcePlugin } from './SourceBlock.svelte';
	import type { Uploader } from '../uploads.svelte.js';

	export type AudioPluginOptions = {
		/**
		 * Upload a audio file and answer its URL: an empty block's Upload, and
		 * the pasted and dropped audio files, each placed as a block at once
		 * (one undo step), showing its name and progress, then filled with the
		 * URL this answers. Without it, audios are only linked.
		 */
		upload?: Uploader;
	};

	/**
	 * Notion's audio block: an audio file (an `http(s)` link, or an upload
	 * through `upload`) in the browser's player, with an editable caption.
	 * Void: its only text is the caption.
	 */
	export const createAudioPlugin = ({ upload }: AudioPluginOptions = {}): Plugin =>
		sourcePlugin('audio', ['sound', 'music', 'mp3'], {}, upload);
</script>
