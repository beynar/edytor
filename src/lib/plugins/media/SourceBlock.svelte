<script module lang="ts">
	import { capped, mediaForms } from '$lib/export/forms.js';
	import type { Block } from '$lib/block/block.svelte.js';
	import type { BlockSnippetPayload, Plugin } from '$lib/plugins.js';
	import EmptySlot from './EmptySlot.svelte';
	import Control from '../Control.svelte';
	import { labelsOf, mediaEnglish } from '$lib/labels.js';
	import { emptyHosts } from './EmptySlot.svelte';
	import UploadPreview from './UploadPreview.svelte';
	import { fileUploads, uploadHooks, type Uploader } from '../uploads.svelte.js';
	import {
		EMBED_ALLOW,
		EMBED_SANDBOX,
		embedSourceOf,
		fileNameFor,
		fileNameOf,
		safeWebUrl,
		type BookmarkCardPayload,
		type EmbedFallbackPayload,
		type MediaKind,
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

	/** The view's markup for a file's row, a bookmark's card, an unplayable embed's link, if the app gave one. */
	const rowOf = mediaControl('file', 'row');
	const cardOf = mediaControl('bookmark', 'card');
	const fallbackOf = mediaControl('embed', 'fallback');

	/**
	 * The view's embed allowlist: the first embed plugin listed in it (first
	 * wins, as for the kind). Never a broader list: no entry plays nothing.
	 */
	const providers = (block: Block | undefined) =>
		mediaView(block?.edytor, 'embed')?.providers ?? [];

	/** The fields of a bookmark's `preview` it stores and shows: text capped, images `safeWebUrl` only. */
	export const previewData = (preview: Record<string, unknown> | null | undefined) => {
		const fields = {
			title: capped(preview?.title, 300),
			description: capped(preview?.description, 1000),
			image: safeWebUrl(preview?.image) ?? undefined,
			icon: safeWebUrl(preview?.icon) ?? undefined
		};
		return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
	};

	/** A file's row: its source, name and size, and whether it is uploading. */
	const fileRow = (
		block: Block | undefined,
		src: string,
		name: string,
		size: number | undefined,
		progress?: number | null
	): FileRowPayload => ({
		block,
		src,
		name,
		size,
		sizeLabel:
			size === undefined ? '' : labelsOf(block?.edytor, 'media', mediaEnglish).fileSize(size),
		uploading: progress !== undefined,
		progress: progress ?? null,
		link: mediaLink({ draggable: 'false', download: name })
	});

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
	 * `figure`) with a safe `src` or `source`, a file as its link; the file
	 * kind brings its `row` markup (`own`).
	 */
	export const sourcePlugin = (
		kind: SourceKind,
		keywords: string[],
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
					...mediaForms()[kind]
				}
			};
		});

	export { source };
</script>

<!--
	A media block: a file (its name and size, linking to it), a video or an
	audio track in the browser's player, an embed's player (or its link), a
	bookmark's card, or the empty block until it has a source; its caption below.
-->
{#snippet source({ block, content }: BlockSnippetPayload<Record<string, unknown>>)}
	{@const url = safeWebUrl(block.data.url)}
	{@const src =
		block.type === 'embed' || block.type === 'bookmark' ? url : safeMediaSrc(block.data.src)}
	{@const player =
		block.type === 'embed' && block.handle ? embedSourceOf(url, providers(block.handle)) : null}
	{@const pending =
		block.handle && !src ? fileUploads(block.handle.edytor)?.of(block.id) : undefined}
	{#if player}
		{@const { height, aspectRatio = '16 / 9' } = player.provider}
		<div
			use:block.void
			data-edytor-embed
			style:aspect-ratio={height ? undefined : aspectRatio}
			style:height={height ? `${height}px` : undefined}
		>
			<iframe
				src={player.src}
				title={player.provider.name}
				sandbox={EMBED_SANDBOX}
				allow={EMBED_ALLOW}
				referrerpolicy="strict-origin-when-cross-origin"
				loading="lazy"
				allowfullscreen
				style="display: block; width: 100%; height: 100%; border: 0"
			></iframe>
		</div>
	{:else if url && block.type === 'embed'}
		<!-- A link no provider plays (a peer may store any), or a suggestion's preview (no handle, so no
		view's allowlist): a plain link, never a frame. -->
		<div use:block.void data-edytor-embed-unsupported>
			<Control
				own={fallbackOf}
				initial={link}
				payload={{ block: block.handle, url, link: mediaLink() }}
			/>
		</div>
	{:else if url && block.type === 'bookmark'}
		<div use:block.void data-edytor-bookmark>
			<Control
				own={cardOf}
				initial={card}
				payload={{
					block: block.handle,
					url,
					...previewData(block.data),
					link: mediaLink({ draggable: 'false' })
				} as BookmarkCardPayload}
			/>
		</div>
	{:else if src && block.type === 'file'}
		<div use:block.void data-edytor-file>
			<Control
				own={rowOf}
				{initial}
				payload={fileRow(
					block.handle,
					src,
					fileNameFor(block.data, src),
					typeof block.data.size === 'number' ? block.data.size : undefined
				)}
			/>
		</div>
	{:else if !src && pending?.status === 'uploading' && !emptyHosts.has(block.handle!.edytor)}
		<!-- An upload with no empty markup to draw it: the file's name and size at once, its progress. -->
		<div use:block.void data-edytor-media-empty>
			{#if block.type === 'file' && pending.preview}
				<Control
					own={rowOf}
					{initial}
					payload={fileRow(
						block.handle,
						pending.preview,
						pending.name,
						pending.size,
						pending.progress
					)}
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
				kind={block.type as MediaKind}
				viewOf={(edytor) => mediaView(edytor, block.type as MediaKind)}
			/>
		</div>
	{/if}
	<!-- The core renders the kind's <figure> around this markup. -->
	<!-- svelte-ignore a11y_figcaption_parent -->
	<figcaption>{@render content()}</figcaption>
{/snippet}

<!-- An embed no provider plays: the link itself. -->
{#snippet link({ url, link }: EmbedFallbackPayload)}
	<a href={url} target="_blank" rel={LINK_REL} {@attach link}>{url}</a>
{/snippet}

<!-- Notion's card: the page's title, description and URL (with its icon) beside its cover. -->
{#snippet card({ url, title, description, image, icon, link }: BookmarkCardPayload)}
	<a href={url} target="_blank" rel={LINK_REL} draggable="false" {@attach link}>
		<span data-edytor-bookmark-text>
			<span data-edytor-bookmark-title>{title ?? url}</span>
			{#if description}<span data-edytor-bookmark-description>{description}</span>{/if}
			<span data-edytor-bookmark-url>
				{#if icon}<img src={icon} alt="" draggable="false" />{/if}<span>{url}</span>
			</span>
		</span>
		{#if image}
			<span data-edytor-bookmark-cover><img src={image} alt="" draggable="false" /></span>
		{/if}
	</a>
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
