<script module lang="ts">
	import type { Plugin } from '$lib/plugins.js';
	import type { MediaPluginOptions } from './media.js';
	import { sourcePlugin } from './SourceBlock.svelte';

	/**
	 * Notion's audio block: an audio file (an `http(s)` link, or an upload
	 * through `upload`) in the browser's player, with an editable caption.
	 * Void: its only text is the caption.
	 */
	export const createAudioPlugin = (options: MediaPluginOptions = {}): Plugin =>
		sourcePlugin('audio', options, ['sound', 'music', 'mp3']);

	/** The audio block, links only. */
	export const audioPlugin = createAudioPlugin();
</script>
