<script module lang="ts">
	import type { Plugin } from '$lib/plugins.js';
	import { escapeHtml, fileNameOf, safeMediaSrc, type MediaPluginOptions } from './media.js';
	import { sourcePlugin } from './SourceBlock.svelte';

	/**
	 * Notion's file block: an attachment, uploaded through `upload` (or
	 * linked), shown as its name and size, linking to the file, with an
	 * editable caption. Void: its only text is the caption.
	 */
	export const createFilePlugin = (options: MediaPluginOptions = {}): Plugin =>
		sourcePlugin('file', options, ['attachment', 'upload', 'pdf', 'document'], {
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
		});

	/** The file block, links only. */
	export const filePlugin = createFilePlugin();
</script>
