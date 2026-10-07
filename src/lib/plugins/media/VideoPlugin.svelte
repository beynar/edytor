<script module lang="ts">
	import type { Plugin, BlockSnippetPayload } from '$lib/plugins.js';
	import type { Block } from '$lib/block/block.svelte.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import MediaEmpty from './MediaEmpty.svelte';
	import { mediaKinds } from '$lib/crdt/semantics.js';
	import {
		claimed,
		escapeHtml,
		mediaSourceOf,
		safeMediaSrc,
		type MediaPluginOptions
	} from './media.js';

	const uploadOf = new WeakMap<Edytor, MediaPluginOptions['upload']>();

	const videoLink = (block: Block | undefined, value: string) => {
		const src = safeMediaSrc(value);
		if (!block || !src) return false;
		block.data.src = src;
		return true;
	};

	/**
	 * Notion's video block: a video file (an `http(s)` link, or an upload
	 * through `upload`) in the browser's player, with an editable caption.
	 * A YouTube or Vimeo link is an embed (`embedPlugin`). Void: its only
	 * text is the caption.
	 */
	export const createVideoPlugin =
		(options: MediaPluginOptions = {}): Plugin =>
		(edytor) => {
			// First wins, as for the kind: a second listing never replaces it.
			if (!uploadOf.has(edytor)) uploadOf.set(edytor, options.upload);
			return {
				blocks: {
					video: {
						...mediaKinds.video,
						snippet: video,
						element: 'figure',
						presets: [
							{ label: 'Video', icon: '🎬', keywords: ['movie', 'mp4', 'clip'], group: 'Media' }
						],
						html: (block, caption) => {
							const src = safeMediaSrc(block.data?.src);
							const media = src ? `<video src="${escapeHtml(src)}" controls></video>` : '';
							return `<figure>${media}<figcaption>${caption}</figcaption></figure>`;
						},
						// A `video` (bare, or in a `figure`) with a safe `src` or `source`.
						parse: (el) => {
							const src = mediaSourceOf(claimed(el, 'video'));
							return src ? { src } : undefined;
						}
					}
				}
			};
		};

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
				label="Embed a video"
				icon="🎬"
				placeholder="Paste the video link…"
				submit="Embed video"
				invalid="That doesn't look like a video link or upload."
				accept="video/*"
				upload={block.handle && uploadOf.get(block.handle.edytor)}
				link={(value) => videoLink(block.handle, value)}
			/>
		</div>
	{/if}
	<!-- The core renders the kind's <figure> around this markup. -->
	<!-- svelte-ignore a11y_figcaption_parent -->
	<figcaption>{@render content()}</figcaption>
{/snippet}
