<script module lang="ts">
	import { mediaForms } from '$lib/export/forms.js';
	import type { BlockDefinition, BlockSnippetPayload, Plugin } from '$lib/plugins.js';
	import EmptySlot from './EmptySlot.svelte';
	import Control from '../Control.svelte';
	import { labelsOf, mediaEnglish } from '$lib/labels.js';
	import { emptyHosts } from './EmptySlot.svelte';
	import UploadPreview from './UploadPreview.svelte';
	import { fileUploads, uploadHooks, type Uploader } from '../uploads.svelte.js';
	import {
		fileNameOf,
		mediaControl,
		mediaLink,
		mediaPlugin,
		mediaView,
		safeMediaSrc,
		LINK_REL,
		type FileRowPayload,
		type MediaView
	} from './media.js';

	type SourceKind = 'video' | 'audio' | 'file';

	/** The view's file row markup, if the app gave one. */
	const rowOf = mediaControl('file', 'row');

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
	 * `src`), and with an `upload` (its uploader), the pasted, dropped and
	 * picked files it takes (`media.files`). A video or an audio track
	 * exports as its tag in a `figure` and imports from one (bare, or in a
	 * `figure`) with a safe `src` or `source`; the file kind brings its own
	 * (`record`), and its `row` markup (`own`).
	 */
	export const sourcePlugin = (
		kind: SourceKind,
		keywords: string[],
		record: Partial<BlockDefinition> = mediaForms()[kind as 'video' | 'audio'],
		own: Pick<MediaView, 'row'> = {},
		upload?: Uploader
	): Plugin =>
		mediaPlugin(kind, keywords, (edytor) => {
			return {
				...own,
				hooks: uploadHooks(edytor, upload),
				store: (block, value, file) => {
					const data = sourceData(kind, value, file);
					if (!data) return 'invalid';
					if (kind === 'file') block.edytor.patchData(block.id, [{ path: [], value: data }]);
					else block.edytor.patchData(block.id, [{ path: ['src'], value: data.src }]);
					return null;
				},
				record: {
					snippet: source,
					// Its files, with an `upload`: an Upload and pasted or dropped files.
					...(upload && {
						upload: {
							send: upload,
							accepts: ACCEPTS[kind],
							fallback: kind === 'file',
							data: (file: File, answer: string) => sourceData(kind, answer, file),
							filled: (data: Record<string, unknown>) => safeMediaSrc(data.src) !== null
						}
					}),
					...record
				}
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
	{@const pending =
		block.handle && !src ? fileUploads(block.handle.edytor)?.of(block.id) : undefined}
	{#if src && block.type === 'file'}
		{@const name =
			typeof block.data.name === 'string' && block.data.name ? block.data.name : fileNameOf(src)}
		{@const size = typeof block.data.size === 'number' ? block.data.size : undefined}
		<div use:block.void data-edytor-file>
			<Control
				own={rowOf}
				{initial}
				payload={{
					block: block.handle,
					src,
					name,
					size,
					sizeLabel:
						size === undefined
							? ''
							: labelsOf(block.handle?.edytor, 'media', mediaEnglish).fileSize(size),
					uploading: false,
					progress: null,
					link: mediaLink({ draggable: 'false', download: name })
				}}
			/>
		</div>
	{:else if !src && pending?.status === 'uploading' && !emptyHosts.has(block.handle!.edytor)}
		<!-- An upload with no empty markup to draw it: the file's name and size at once, its progress. -->
		<div use:block.void data-edytor-media-empty>
			{#if block.type === 'file' && pending.preview}
				<Control
					own={rowOf}
					{initial}
					payload={{
						block: block.handle,
						src: pending.preview,
						name: pending.name,
						size: pending.size,
						sizeLabel: labelsOf(block.handle?.edytor, 'media', mediaEnglish).fileSize(pending.size),
						uploading: true,
						progress: pending.progress,
						link: mediaLink({ draggable: 'false', download: pending.name })
					}}
				/>
			{:else}
				<UploadPreview upload={pending} />
			{/if}
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
			<EmptySlot
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

<!-- A file: its name and size, a link downloading it. -->
{#snippet initial({ src, name, sizeLabel, link, uploading, progress }: FileRowPayload)}
	<a href={src} target="_blank" rel={LINK_REL} draggable="false" download={name} {@attach link}>
		<span aria-hidden="true">📎</span>
		<span data-edytor-file-name>{name}</span>
		{#if sizeLabel}<span data-edytor-file-size>{sizeLabel}</span>{/if}
	</a>
	{#if uploading}<progress data-edytor-file-progress value={progress ?? undefined} max="1"
		></progress>{/if}
{/snippet}
