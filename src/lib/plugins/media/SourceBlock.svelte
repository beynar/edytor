<script module lang="ts">
	import type { BlockDefinition, BlockSnippetPayload, Plugin } from '$lib/plugins.js';
	import MediaEmpty from './MediaEmpty.svelte';
	import { labelsOf, mediaEnglish } from '$lib/labels.js';
	import { fileUploads } from '../uploads.svelte.js';
	import {
		claimed,
		escapeHtml,
		fileNameOf,
		mediaPlugin,
		mediaSourceOf,
		mediaView,
		safeMediaSrc,
		type MediaPluginOptions
	} from './media.js';

	type SourceKind = 'video' | 'audio' | 'file';

	/** The files each kind takes: a video, an audio track, any other file. */
	const ACCEPTS: Record<SourceKind, (file: File) => boolean> = {
		video: (file) => /^video\//i.test(file.type),
		audio: (file) => /^audio\//i.test(file.type),
		file: () => true
	};

	/**
	 * The data a source stores: a `safeMediaSrc`, and a file's name (the
	 * uploaded `file`'s, else its URL's last segment) and size; `null` for
	 * no source.
	 */
	const sourceData = (kind: SourceKind, value: string, file?: File) => {
		const src = safeMediaSrc(value);
		if (!src) return null;
		return kind === 'file'
			? { src, name: file?.name || fileNameOf(src), ...(file ? { size: file.size } : {}) }
			: { src };
	};

	/**
	 * The plugin of a kind holding one source (a video, an audio track, an
	 * attachment; Notion's): a media kind (`mediaPlugin`) drawn by this
	 * snippet, a link or an uploaded file stored as one data write (a file's
	 * whole data, its source, name and size; a video's or audio track's
	 * `src`), and with an `upload`, the pasted and dropped files it takes
	 * (`media.files`, its first listing in a view). A video or an audio track
	 * exports as its tag in a `figure` and imports from one (bare, or in a
	 * `figure`) with a safe `src` or `source`; the file kind brings its own
	 * (`record`).
	 */
	export const sourcePlugin = (
		kind: SourceKind,
		options: MediaPluginOptions,
		keywords: string[],
		record: Partial<BlockDefinition> = {
			html: (block, caption) => {
				const src = safeMediaSrc(block.data?.src);
				// The tag, then its attributes: `<video src="…" controls></video>`.
				const media = src ? `<${kind}` + ` src="${escapeHtml(src)}" controls></${kind}>` : '';
				return `<figure>${media}<figcaption>${caption}</figcaption></figure>`;
			},
			parse: (el) => {
				const src = mediaSourceOf(claimed(el, kind));
				return src ? { src } : undefined;
			}
		}
	): Plugin =>
		mediaPlugin(kind, options, keywords, (edytor, claims) => {
			const { upload } = options;
			const uploads = claims && upload ? fileUploads(edytor) : undefined;
			if (upload)
				uploads?.register({
					type: kind,
					accepts: ACCEPTS[kind],
					fallback: kind === 'file',
					upload,
					data: (file, answer) => sourceData(kind, answer, file),
					filled: (data) => safeMediaSrc(data.src) !== null
				});
			return {
				store: (block, value, file) => {
					const data = sourceData(kind, value, file);
					if (!data) return 'invalid';
					if (kind === 'file') block.edytor.patchData(block.id, [{ path: [], value: data }]);
					else block.edytor.patchData(block.id, [{ path: ['src'], value: data.src }]);
					return null;
				},
				hooks: uploads ? { onPaste: uploads.paste } : {},
				record: { snippet: source, ...record }
			};
		});
</script>

<!--
	A file (its name and size, linking to it), a video or an audio track in
	the browser's player, or the empty block until it has a source; its
	caption below.
-->
{#snippet source({ block, content }: BlockSnippetPayload<Record<string, unknown>>)}
	{@const src = safeMediaSrc(block.data.src)}
	{#if src && block.type === 'file'}
		{@const name =
			typeof block.data.name === 'string' && block.data.name ? block.data.name : fileNameOf(src)}
		{@const size =
			typeof block.data.size === 'number'
				? labelsOf(block.handle?.edytor, 'media', mediaEnglish).fileSize(block.data.size)
				: ''}
		<div use:block.void data-edytor-file>
			<a
				href={src}
				target="_blank"
				rel="noopener noreferrer nofollow"
				download={name}
				draggable="false"
			>
				<span aria-hidden="true">📎</span>
				<span data-edytor-file-name>{name}</span>
				{#if size}<span data-edytor-file-size>{size}</span>{/if}
			</a>
		</div>
	{:else if src && block.type === 'video'}
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
	{:else if src}
		<div use:block.void data-edytor-audio>
			<audio {src} controls preload="metadata" style="display: block; width: 100%"></audio>
		</div>
	{:else}
		<div use:block.void data-edytor-media-empty>
			<MediaEmpty
				block={block.handle}
				kind={block.type as SourceKind}
				viewOf={(edytor) => mediaView(edytor, block.type as SourceKind)}
			/>
		</div>
	{/if}
	<!-- The core renders the kind's <figure> around this markup. -->
	<!-- svelte-ignore a11y_figcaption_parent -->
	<figcaption>{@render content()}</figcaption>
{/snippet}
