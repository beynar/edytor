<script module lang="ts">
	import type { Snippet } from 'svelte';
	import type { Plugin, BlockSnippetPayload } from '$lib/plugins.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import ImageEmpty from './ImageEmpty.svelte';
	import ImageChrome from './ImageChrome.svelte';
	import { imageKinds } from '$lib/crdt/semantics.js';
	import {
		imageAlignOf,
		imageAltOf,
		imageWidthOf,
		imageLabels,
		imgData,
		isImageFile,
		MAX_INLINE_IMAGE_BYTES,
		MIN_IMAGE_WIDTH,
		oversizedInlineImage,
		safeImageSrc,
		storableImageSrc,
		type ImageAlign
	} from './image.js';
	import { ImageControls } from './controls.svelte.js';
	import type { ImageEmptyController } from './empty.svelte.js';
	import { fileUploads, type FileUploads, type Uploader } from '../uploads.svelte.js';
	import { onPress } from '$lib/events/onFocus.js';
	import { keywordsOf, labelsWith, type PartialLabels } from '$lib/labels.js';

	export {
		MAX_INLINE_IMAGE_BYTES,
		MIN_IMAGE_WIDTH,
		oversizedInlineImage,
		safeImageSrc,
		storableImageSrc,
		type ImageAlign
	};

	export type ImagePluginOptions = {
		/**
		 * Upload a file and answer its URL. Adds an Upload button to the empty
		 * block, and claims pasted and dropped image files: each is placed as an
		 * image block at once (one undo step) and filled with the URL this
		 * answers (the block shows the progress it reports). Without it only
		 * links are embedded.
		 */
		upload?: Uploader;
		/** The words the block, its empty panel and its chrome show, over the English ones. */
		labels?: PartialLabels<'image'>;
		/**
		 * The slash menu's keywords of the image command (`block.image`), which
		 * replace its own.
		 */
		keywords?: Partial<Record<string, string[]>>;
		/**
		 * Replace the toolbar over the hovered image (the alignments and the alt
		 * field); it renders while `controls.shown` and no handle drags, at the
		 * image's top right (`controls.box`). The resize handles stay the
		 * plugin's. Keep its behaviour with `{@attach controls.bar}` on the
		 * toolbar and `{@attach controls.altField}` on the alt field.
		 */
		toolbar?: Snippet<[ImageControls]>;
		/**
		 * Replace an empty image's markup (Notion's "Add an image" and its link
		 * panel, or the placeholder of a readonly view): it receives the
		 * block's `ImageEmptyController` (`open`, `draft`, `failed`, `embed`,
		 * `upload`, `readonly`).
		 */
		empty?: Snippet<[ImageEmptyController]>;
	};

	/** The data an image block reads (all optional). */
	export type ImageData = { src?: string; alt?: string; width?: number; align?: ImageAlign };

	const escape = (value: string) => value.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
	const px = (width: number | undefined) => (width === undefined ? undefined : `${width}px`);

	/** One view's image state: its plugin's `upload`, the chrome, the uploads in flight. */
	type View = {
		upload?: Uploader;
		controls: ImageControls;
		uploads?: FileUploads;
		empty?: Snippet<[ImageEmptyController]>;
	};
	/** By view; the first image plugin of a view owns it, as its kind's definition (first wins). */
	const views = new WeakMap<Edytor, View>();
	const imagePlugins = new WeakSet<Plugin>();

	/** Recognize any image plugin instance (the component's default yields to yours). */
	export const isImagePlugin = (plugin: Plugin) => imagePlugins.has(plugin);

	/**
	 * Notion's image block: an "Add an image" panel until it has a source (a
	 * pasted link, or an upload when `upload` is given), then the image with
	 * an editable caption, its alt text, width and alignment set from the
	 * chrome the plugin shows over it. Void: its only text is the caption.
	 */
	export const createImagePlugin = (pluginOptions: ImagePluginOptions = {}): Plugin => {
		const { upload } = pluginOptions;
		const labels = labelsWith('image', pluginOptions.labels);
		const plugin: Plugin = (edytor) => {
			imageLabels.claim(edytor, labels);
			const own: View = {
				upload,
				controls: new ImageControls(edytor, labels),
				uploads: upload ? fileUploads(edytor) : undefined,
				empty: pluginOptions.empty
			};
			// The records read with no view (`plugin(undefined)`) keep no state.
			if (edytor && !views.has(edytor)) {
				views.set(edytor, own);
				if (upload)
					own.uploads?.register({
						type: 'image',
						accepts: isImageFile,
						upload,
						data: (_file, answer) => {
							const src = storableImageSrc(answer);
							return src ? { src } : null;
						},
						filled: (data) => safeImageSrc(data.src) !== null,
						preview: true
					});
			}
			const owns = () => views.get(edytor) === own;
			return {
				// Pasted or dropped files (a drop replays the paste hooks): the
				// view's uploads place a block per file of every kind that uploads.
				onPaste: (payload) => {
					if (owns()) own.uploads?.paste(payload);
				},
				// The chrome: in the overlay, for the image under the pointer.
				onEdytorAttached: ({ node }) => {
					if (!owns()) return;
					const { controls } = own;
					const over = (event: PointerEvent) => controls.hover(event.target);
					const leave = (event: PointerEvent) =>
						!controls.drag && controls.leave(event.relatedTarget);
					const layer = edytor.overlay.layer;
					// A press outside the alt panel closes it (WebKit's lone `mousedown` too).
					const offPress = onPress(edytor, node.ownerDocument, controls.pressed, true);
					node.addEventListener('pointerover', over);
					node.addEventListener('pointerleave', leave);
					layer?.addEventListener('pointerleave', leave);
					const unmount = edytor.overlay.mount(
						ImageChrome,
						{ controls, toolbar: pluginOptions.toolbar },
						'edytor-image-chrome',
						// Above the block handles (5) and the column bands (6): it sits on the image.
						7,
						controls.measure
					);
					return () => {
						node.removeEventListener('pointerover', over);
						node.removeEventListener('pointerleave', leave);
						layer?.removeEventListener('pointerleave', leave);
						offPress();
						unmount();
						own.uploads?.destroy();
					};
				},
				blocks: {
					image: {
						...imageKinds.image,
						snippet: image,
						element: 'figure',
						presets: [
							{
								label: labels.image,
								icon: '🖼',
								keywords: keywordsOf(
									'block.image',
									['picture', 'photo', 'img'],
									pluginOptions.keywords
								),
								group: 'Media'
							}
						],
						html: (block, caption) => {
							const src = safeImageSrc(block.data?.src);
							const width = imageWidthOf(block.data);
							const align = imageAlignOf(block.data);
							const img = src
								? `<img src="${escape(src)}" alt="${escape(imageAltOf(block.data))}"${width ? ` width="${Math.round(width)}"` : ''}>`
								: '';
							const at = align === 'center' ? '' : ` data-align="${align}"`;
							return `<figure${at}>${img}<figcaption>${caption}</figcaption></figure>`;
						},
						// A `figure` holding an `img`, or a bare `img`, with an accepted
						// source; a pasted inline image over the cap is not imported.
						parse: (el) => {
							if (el.localName === 'img') return imgData(el) ?? undefined;
							const data = el.localName === 'figure' && imgData(el.querySelector('img'));
							if (!data) return undefined;
							const align = el.getAttribute('data-align');
							return align === 'left' || align === 'right' ? { ...data, align } : data;
						}
					}
				}
			};
		};

		imagePlugins.add(plugin);
		return plugin;
	};

	/** The image block, links only. */
	export const imagePlugin = createImagePlugin();
</script>

{#snippet image({ block, content }: BlockSnippetPayload<ImageData>)}
	<!-- A suggestion's preview (no handle) reads only its data. -->
	{@const view = block.handle ? views.get(block.handle.edytor) : undefined}
	{@const src = safeImageSrc(block.data.src)}
	{@const upload = src ? undefined : view?.uploads?.of(block.id)}
	{#if src}
		<div use:block.void data-edytor-image data-align={imageAlignOf(block.data)}>
			<img
				{src}
				alt={imageAltOf(block.data)}
				draggable="false"
				style:width={px(
					view ? view.controls.width(block.id, block.data) : imageWidthOf(block.data)
				)}
			/>
		</div>
	{:else if upload?.status === 'uploading'}
		<div use:block.void data-edytor-image data-edytor-image-uploading data-align="center">
			{#if upload.preview}<img src={upload.preview} alt="" draggable="false" />{/if}
			<span data-edytor-image-progress role="status">
				<progress value={upload.progress ?? undefined} max="1"></progress>
				{imageLabels.of(block.handle?.edytor).uploading}
			</span>
		</div>
	{:else}
		<div use:block.void data-edytor-image-empty>
			<ImageEmpty
				block={block.handle}
				upload={view?.upload}
				uploads={view?.uploads}
				error={upload?.status === 'failed' ? 'upload' : null}
				landed={upload?.status === 'landed'}
				empty={view?.empty}
			/>
		</div>
	{/if}
	<!-- The core renders the kind's <figure> around this markup. -->
	<!-- svelte-ignore a11y_figcaption_parent -->
	<figcaption>{@render content()}</figcaption>
{/snippet}

<style>
	/* Where an image narrower than its block sits (Notion's alignment). */
	[data-edytor-image] {
		display: flex;
		position: relative;
		justify-content: center;
	}
	[data-edytor-image][data-align='left'] {
		justify-content: flex-start;
	}
	[data-edytor-image][data-align='right'] {
		justify-content: flex-end;
	}
	[data-edytor-image] img {
		max-width: 100%;
	}
	[data-edytor-image-uploading] {
		min-height: 48px;
		border-radius: 4px;
		background: rgba(55, 53, 47, 0.04);
	}
	[data-edytor-image-uploading] img {
		opacity: 0.5;
	}
	[data-edytor-image-progress] {
		position: absolute;
		top: 8px;
		right: 8px;
		padding: 2px 8px;
		border-radius: 4px;
		background: rgba(15, 15, 15, 0.6);
		color: #fff;
		font-size: 12px;
	}
</style>
