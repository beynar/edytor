<script module lang="ts">
	import { escapeHtml } from '$lib/clipboard/serializeClipboardFragment.js';
	import type { Plugin, BlockSnippetPayload } from '$lib/plugins.js';
	import { branded } from '../brand.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import EmptySlot from '../media/EmptySlot.svelte';
	import ImageChrome from './ImageChrome.svelte';
	import { imageKinds } from '$lib/crdt/semantics.js';
	import {
		imageAlignOf,
		imageAltOf,
		imageWidthOf,
		imgData,
		isImageFile,
		MAX_INLINE_IMAGE_BYTES,
		MIN_IMAGE_WIDTH,
		oversizedInlineImage,
		safeImageSrc,
		storableImageSrc,
		type ImageAlign
	} from './image.js';
	import { ImageControls, imageControls } from './controls.svelte.js';
	import { MEDIA_ICONS, type EmptyView } from '../media/empty.svelte.js';
	import { imageEnglish, keywordsOf, labelsOf } from '$lib/labels.js';
	import { listen } from '$lib/utils/listen.js';

	export {
		MAX_INLINE_IMAGE_BYTES,
		MIN_IMAGE_WIDTH,
		oversizedInlineImage,
		safeImageSrc,
		storableImageSrc,
		type ImageAlign
	};

	/** The data an image block reads (all optional). */
	export type ImageData = { src?: string; alt?: string; width?: number; align?: ImageAlign };

	const px = (width: number | undefined) => (width === undefined ? undefined : `${width}px`);

	/** One view's image state: its source rule, the chrome. */
	type View = EmptyView & { controls: ImageControls };
	/** By view; the first image plugin of a view owns it, as its kind's definition (first wins). */
	const views = new WeakMap<Edytor, View>();

	/**
	 * Notion's image block: an "Add an image" panel until it has a source (a
	 * pasted link, or an upload when `upload` is given), then the image with
	 * an editable caption, its alt text, width and alignment set from the
	 * chrome the plugin shows over it. Void: its only text is the caption.
	 */
	export const createImagePlugin = (): Plugin => {
		const plugin: Plugin = (edytor) => {
			const labels = labelsOf(edytor, 'image', imageEnglish);
			const own: View = {
				controls: new ImageControls(edytor),
				// An accepted source; an inline image over the cap is never stored.
				store: (block, value) => {
					const src = safeImageSrc(value);
					if (!src) return 'invalid';
					if (oversizedInlineImage(src)) return 'inline';
					block.edytor.patchData(block.id, [{ path: ['src'], value: src }]);
					return null;
				}
			};
			// The records read with no view (`plugin(undefined)`) keep no state.
			if (edytor && !views.has(edytor)) {
				views.set(edytor, own);
				imageControls.set(edytor, own.controls);
			}
			const owns = () => views.get(edytor) === own;
			return {
				// The chrome: in the overlay, for the image under the pointer.
				onEdytorAttached: ({ node }) => {
					if (!owns()) return;
					const { controls } = own;
					const over = (event: PointerEvent) => controls.hover(event.target);
					const leave = (event: PointerEvent) =>
						!controls.drag && controls.leave(event.relatedTarget);
					const layer = edytor.overlay.layer;
					const off = listen(node, 'pointerover', over);
					const off2 = listen(node, 'pointerleave', leave);
					const off3 = listen(layer, 'pointerleave', leave);
					const unmount = edytor.overlay.mount(
						ImageChrome,
						{ controls },
						'edytor-image-chrome',
						// Above the block handles (5) and the column bands (6): it sits on the image.
						7,
						controls.measure
					);
					return () => {
						off();
						off2();
						off3();
						unmount();
					};
				},
				blocks: {
					image: {
						...imageKinds.image,
						snippet: image,
						element: 'figure',
						// Image files: with the uploads plugin, an Upload and pasted or dropped files.
						upload: {
							accepts: isImageFile,
							data: (_file, answer) => {
								const src = storableImageSrc(answer);
								return src ? { src } : null;
							},
							filled: (data) => safeImageSrc(data.src) !== null,
							preview: true
						},
						presets: [
							{
								label: labels.image,
								icon: MEDIA_ICONS.image,
								keywords: keywordsOf(edytor, 'block.image', ['picture', 'photo', 'img']),
								group: 'Media'
							}
						],
						html: (block, caption) => {
							const src = safeImageSrc(block.data?.src);
							const width = imageWidthOf(block.data);
							const align = imageAlignOf(block.data);
							const img = src
								? `<img src="${escapeHtml(src)}" alt="${escapeHtml(imageAltOf(block.data))}"${width ? ` width="${Math.round(width)}"` : ''}>`
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

		return branded('image', plugin);
	};
</script>

<!-- No whitespace before the caption (one node per block less to walk). -->
<!-- prettier-ignore -->
{#snippet image({ block, content }: BlockSnippetPayload<ImageData>)}
	<!-- A suggestion's preview (no handle) reads only its data. -->
	{@const view = block.handle ? views.get(block.handle.edytor) : undefined}
	{@const src = safeImageSrc(block.data.src)}
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
	{:else}
		<div use:block.void data-edytor-image-empty>
			<EmptySlot
				block={block.handle}
				kind="image"
				viewOf={(edytor) => (edytor ? views.get(edytor) : undefined)}
			/>
		</div>
	{/if}<!--
	The core renders the kind's <figure> around this markup.
	--><!-- svelte-ignore a11y_figcaption_parent --><figcaption>{@render content()}</figcaption>
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
</style>
