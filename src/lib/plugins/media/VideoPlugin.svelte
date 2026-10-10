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
	 * Notion's video block: a video file (an `http(s)` link, or an upload
	 * through `upload`) in the browser's player, with an editable caption.
	 * A YouTube or Vimeo link is an embed (`embedPlugin`). Void: its only
	 * text is the caption.
	 */
	export const createVideoPlugin = (options: MediaPluginOptions = {}): Plugin =>
		sourcePlugin('video', options, '🎬', ['movie', 'mp4', 'clip'], () => ({ snippet: video }));

	/** The video block, links only. */
	export const videoPlugin = createVideoPlugin();
</script>

{#snippet video({ block, content }: BlockSnippetPayload<{ src?: string }>)}
	{@const src = safeMediaSrc(block.data.src)}
	{#if src}
		<div use:block.void data-edytor-video>
			<!-- svelte-ignore a11y_media_has_caption -->
			<video
				{src}
				controls
				preload="metadata"
				playsinline
				draggable="false"
				style="display: block; width: 100%"
			></video>
		</div>
	{:else}
		<div use:block.void data-edytor-media-empty>
			<MediaEmpty
				block={block.handle}
				kind="video"
				icon="🎬"
				accept="video/*"
				upload={mediaEmpty.upload(block.handle?.edytor, 'video')}
				link={(value) => storeSource(block.handle, value)}
			/>
		</div>
	{/if}
	<!-- The core renders the kind's <figure> around this markup. -->
	<!-- svelte-ignore a11y_figcaption_parent -->
	<figcaption>{@render content()}</figcaption>
{/snippet}
