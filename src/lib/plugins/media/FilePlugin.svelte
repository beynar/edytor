<script module lang="ts">
	import type { Snippet } from 'svelte';
	import type { Plugin } from '$lib/plugins.js';
	import { escapeHtml, fileNameOf, safeMediaSrc, type FileRowPayload } from './media.js';
	import { sourcePlugin } from './SourceBlock.svelte';

	export type { FileRowPayload };

	export type FilePluginOptions = {
		/**
		 * A file's row once it has a source (default: Notion's, a paperclip,
		 * its name and size): `<a href={row.src} {@attach row.link}>`, which
		 * downloads the file. The first file plugin listed in a view gives its row.
		 */
		row?: Snippet<[FileRowPayload]>;
	};

	/**
	 * Notion's file block: an attachment, uploaded through `upload` (or
	 * linked), shown as its name and size, linking to the file, with an
	 * editable caption. Void: its only text is the caption.
	 */
	export const createFilePlugin = (options: FilePluginOptions = {}): Plugin =>
		sourcePlugin(
			'file',
			['attachment', 'upload', 'pdf', 'document'],
			{
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
			},
			{ row: options.row }
		);
</script>
