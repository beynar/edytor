<script module lang="ts">
	import type { Plugin, BlockSnippetPayload } from '$lib/plugins.js';
	import MediaEmpty from './MediaEmpty.svelte';
	import {
		mediaEmpty,
		safeMediaSrc,
		sourcePlugin,
		storeSource,
		type MediaPluginOptions
	} from './media.js';

	/**
	 * Notion's audio block: an audio file (an `http(s)` link, or an upload
	 * through `upload`) in the browser's player, with an editable caption.
	 * Void: its only text is the caption.
	 */
	export const createAudioPlugin = (options: MediaPluginOptions = {}): Plugin =>
		sourcePlugin('audio', options, '🎵', ['sound', 'music', 'mp3'], () => ({ snippet: audio }));

	/** The audio block, links only. */
	export const audioPlugin = createAudioPlugin();
</script>

{#snippet audio({ block, content }: BlockSnippetPayload<{ src?: string }>)}
	{@const src = safeMediaSrc(block.data.src)}
	{#if src}
		<div use:block.void data-edytor-audio>
			<audio {src} controls preload="metadata" style="display: block; width: 100%"></audio>
		</div>
	{:else}
		<div use:block.void data-edytor-media-empty>
			<MediaEmpty
				block={block.handle}
				kind="audio"
				icon="🎵"
				accept="audio/*"
				upload={mediaEmpty.upload(block.handle?.edytor, 'audio')}
				link={(value) => storeSource(block.handle, value)}
			/>
		</div>
	{/if}
	<!-- The core renders the kind's <figure> around this markup. -->
	<!-- svelte-ignore a11y_figcaption_parent -->
	<figcaption>{@render content()}</figcaption>
{/snippet}
