<script module lang="ts">
	import type { Plugin, BlockSnippetPayload } from '$lib/plugins.js';
	import type { Block } from '$lib/block/block.svelte.js';
	import type { Edytor } from '$lib/edytor.svelte.js';
	import MediaEmpty from './MediaEmpty.svelte';
	import { mediaKinds } from '$lib/crdt/semantics.js';
	import { keywordsOf, labelsWith } from '$lib/labels.js';
	import {
		escapeHtml,
		fileNameOf,
		mediaLabels,
		safeMediaSrc,
		mediaUploads,
		type MediaPluginOptions
	} from './media.js';

	const uploadOf = new WeakMap<Edytor, MediaPluginOptions['upload']>();

	/** Store a file's source, name and size on `block` as one data write; answers whether it did. */
	const attach = (block: Block | undefined, value: string, name?: string, size?: number) => {
		const src = safeMediaSrc(value);
		if (!block || !src) return false;
		block.setData({ src, name: name || fileNameOf(src), ...(size !== undefined ? { size } : {}) });
		return true;
	};

	/**
	 * Notion's file block: an attachment, uploaded through `upload` (or
	 * linked), shown as its name and size, linking to the file, with an
	 * editable caption. Void: its only text is the caption.
	 */
	export const createFilePlugin =
		(options: MediaPluginOptions = {}): Plugin =>
		(edytor) => {
			// First wins, as for the kind: a second listing never replaces it.
			const first = !!edytor && !uploadOf.has(edytor);
			if (first) uploadOf.set(edytor, options.upload);
			const onPaste = first ? mediaUploads(edytor, 'file', options.upload) : undefined;
			const labels = labelsWith('media', options.labels);
			mediaLabels.file.claim(edytor, labels);
			return {
				...(onPaste ? { onPaste } : {}),
				blocks: {
					file: {
						...mediaKinds.file,
						snippet: file,
						element: 'figure',
						presets: [
							{
								label: labels.file.label,
								icon: '📎',
								keywords: keywordsOf(
									'block.file',
									['attachment', 'upload', 'pdf', 'document'],
									options.keywords
								),
								group: 'Media'
							}
						],
						html: (block, caption) => {
							const src = safeMediaSrc(block.data?.src);
							const name = String(block.data?.name || (src && fileNameOf(src)) || '');
							const link = src ? `<a href="${escapeHtml(src)}">${escapeHtml(name)}</a>` : '';
							return `<figure data-edytor-file>${link}<figcaption>${caption}</figcaption></figure>`;
						},
						plain: (block, caption) =>
							[safeMediaSrc(block.data?.src), caption].filter(Boolean).join('\n'),
						// Its own export: a `figure[data-edytor-file]` holding the link.
						parse: (el) => {
							if (el.localName !== 'figure' || !el.hasAttribute('data-edytor-file')) return;
							const anchor = el.querySelector('a[href]');
							const src = safeMediaSrc(anchor?.getAttribute('href'));
							const name = anchor?.textContent?.trim().slice(0, 300);
							return src ? { src, name: name || fileNameOf(src) } : undefined;
						}
					}
				}
			};
		};

	/** The file block, links only. */
	export const filePlugin = createFilePlugin();
</script>

{#snippet file({ block, content }: BlockSnippetPayload<Record<string, unknown>>)}
	{@const src = safeMediaSrc(block.data.src)}
	{#if src}
		{@const name =
			typeof block.data.name === 'string' && block.data.name ? block.data.name : fileNameOf(src)}
		{@const size =
			typeof block.data.size === 'number'
				? mediaLabels.file.of(block.handle?.edytor).fileSize(block.data.size)
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
	{:else}
		{@const upload = block.handle && uploadOf.get(block.handle.edytor)}
		<div use:block.void data-edytor-media-empty>
			<MediaEmpty
				block={block.handle}
				kind="file"
				icon="📎"
				{upload}
				link={(value) => attach(block.handle, value)}
				file={(picked, src) => attach(block.handle, src, picked.name, picked.size)}
			/>
		</div>
	{/if}
	<!-- The core renders the kind's <figure> around this markup. -->
	<!-- svelte-ignore a11y_figcaption_parent -->
	<figcaption>{@render content()}</figcaption>
{/snippet}
