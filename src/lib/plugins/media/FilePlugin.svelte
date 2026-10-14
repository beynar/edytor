<script module lang="ts">
	import type { Snippet } from 'svelte';
	import type { Plugin } from '$lib/plugins.js';
	import { type FileRowPayload } from './media.js';
	import { sourcePlugin } from './SourceBlock.svelte';
	import type { Uploader } from '../uploads.svelte.js';

	export type { FileRowPayload };

	export type FilePluginOptions = {
		/**
		 * A file's row once it has a source (default: Notion's, a paperclip,
		 * its name and size): `<a href={row.src} {@attach row.link}>`, which
		 * downloads the file. The first file plugin listed in a view gives its row.
		 */
		row?: Snippet<[FileRowPayload]>;
		/**
		 * Upload a file and answer its URL: an empty file block's Upload, and
		 * the pasted and dropped files no other kind takes, each placed as a
		 * file block at once (one undo step), its row showing the file's name,
		 * size and progress, then filled with the URL this answers. Without
		 * it, files are only linked.
		 */
		upload?: Uploader;
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
			{ row: options.row },
			options.upload
		);
</script>
