<script module lang="ts">
	import type { Plugin, BlockSnippetPayload } from '$lib/plugins.js';
	import type { Block } from '$lib/block/block.svelte.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import MediaEmpty from './MediaEmpty.svelte';
	import { mediaKinds } from '$lib/crdt/semantics.js';
	import { keywordsOf, labelsWith } from '$lib/labels.js';
	import {
		claimed,
		escapeHtml,
		mediaLabels,
		mediaSourceOf,
		safeMediaSrc,
		type MediaPluginOptions
	} from './media.js';

	const uploadOf = new WeakMap<Edytor, MediaPluginOptions['upload']>();

	const audioLink = (block: Block | undefined, value: string) => {
		const src = safeMediaSrc(value);
		if (!block || !src) return false;
		block.data.src = src;
		return true;
	};

	/**
	 * Notion's audio block: an audio file (an `http(s)` link, or an upload
	 * through `upload`) in the browser's player, with an editable caption.
	 * Void: its only text is the caption.
	 */
	export const createAudioPlugin =
		(options: MediaPluginOptions = {}): Plugin =>
		(edytor) => {
			// First wins, as for the kind: a second listing never replaces it.
			if (!uploadOf.has(edytor)) uploadOf.set(edytor, options.upload);
			const labels = labelsWith('media', options.labels);
			mediaLabels.audio.claim(edytor, labels);
			return {
				blocks: {
					audio: {
						...mediaKinds.audio,
						snippet: audio,
						element: 'figure',
						presets: [
							{
								label: labels.audio.label,
								icon: '🎵',
								keywords: keywordsOf('block.audio', ['sound', 'music', 'mp3'], options.keywords),
								group: 'Media'
							}
						],
						html: (block, caption) => {
							const src = safeMediaSrc(block.data?.src);
							const media = src ? `<audio src="${escapeHtml(src)}" controls></audio>` : '';
							return `<figure>${media}<figcaption>${caption}</figcaption></figure>`;
						},
						// An `audio` (bare, or in a `figure`) with a safe `src` or `source`.
						parse: (el) => {
							const src = mediaSourceOf(claimed(el, 'audio'));
							return src ? { src } : undefined;
						}
					}
				}
			};
		};

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
				upload={block.handle && uploadOf.get(block.handle.edytor)}
				link={(value) => audioLink(block.handle, value)}
			/>
		</div>
	{/if}
	<!-- The core renders the kind's <figure> around this markup. -->
	<!-- svelte-ignore a11y_figcaption_parent -->
	<figcaption>{@render content()}</figcaption>
{/snippet}
