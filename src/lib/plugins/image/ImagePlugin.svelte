<script module lang="ts">
	import type { Plugin, BlockSnippetPayload } from '$lib/plugins.js';
	import type { Block } from '$lib/block/block.svelte.js';
	import ImageEmpty from './ImageEmpty.svelte';
	import { imageKinds } from '$lib/crdt/semantics.js';
	import {
		MAX_INLINE_IMAGE_BYTES,
		oversizedInlineImage,
		safeImageSrc,
		storableImageSrc
	} from './image.js';

	export { MAX_INLINE_IMAGE_BYTES, oversizedInlineImage, safeImageSrc, storableImageSrc };

	export type ImagePluginOptions = {
		/** Upload a picked file and answer its URL; without it only links are embedded. */
		upload?: (file: File) => Promise<string>;
	};

	const escape = (value: string) => value.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

	const options = new WeakMap<Block, ImagePluginOptions>();
	const imagePlugins = new WeakSet<Plugin>();

	/** Recognize any image plugin instance (the component's default yields to yours). */
	export const isImagePlugin = (plugin: Plugin) => imagePlugins.has(plugin);

	/**
	 * Notion's image block: an "Add an image" panel until it has a source (a
	 * pasted link, or an upload when `upload` is given), then the image with
	 * an editable caption. Void: its only text is the caption.
	 */
	export const createImagePlugin = (pluginOptions: ImagePluginOptions = {}): Plugin => {
		const plugin: Plugin = () => ({
			onBlockAttached: ({ block }) => {
				options.set(block, pluginOptions);
				return () => options.delete(block);
			},
			blocks: {
				image: {
					...imageKinds.image,
					snippet: image,
					element: 'figure',
					presets: [
						{
							label: 'Image',
							icon: '🖼',
							keywords: ['picture', 'photo', 'img'],
							group: 'Media'
						}
					],
					html: (block, caption) => {
						const src = safeImageSrc(block.data?.src);
						return `<figure>${src ? `<img src="${escape(src)}" alt="">` : ''}<figcaption>${caption}</figcaption></figure>`;
					},
					// A pasted inline image over the cap is not imported (H6).
					parse: (el) => {
						const src =
							el.localName === 'figure' &&
							storableImageSrc(el.querySelector('img')?.getAttribute('src'));
						return src ? { src } : undefined;
					}
				}
			}
		});

		imagePlugins.add(plugin);
		return plugin;
	};

	/** The image block, links only. */
	export const imagePlugin = createImagePlugin();
</script>

{#snippet image({ block, content }: BlockSnippetPayload<{ src?: string }>)}
	{@const src = safeImageSrc(block.data.src)}
	{#if src}
		<div use:block.void data-edytor-image>
			<img {src} alt="" draggable="false" />
		</div>
	{:else}
		<div use:block.void data-edytor-image-empty>
			<!-- A suggestion's preview (no handle) shows the passive placeholder. -->
			<ImageEmpty block={block.handle} upload={block.handle && options.get(block.handle)?.upload} />
		</div>
	{/if}
	<!-- The core renders the kind's <figure> around this markup. -->
	<!-- svelte-ignore a11y_figcaption_parent -->
	<figcaption>{@render content()}</figcaption>
{/snippet}
