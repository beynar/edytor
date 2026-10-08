import type { Attachment } from 'svelte/attachments';
import type { Block } from '$lib/block/block.svelte.js';
import type { ImageLabels } from '$lib/labels.js';
import { MAX_INLINE_IMAGE_BYTES, oversizedInlineImage, safeImageSrc } from './image.js';
import type { FileUploads, Uploader } from '../uploads.svelte.js';

/** Why the last link or upload was not embedded. */
export type ImageEmptyFailure = 'invalid' | 'inline' | 'upload';

/**
 * An empty image block's state (Notion's "Add an image"): the panel's
 * `open` state, the link field's `draft`, and why the last link or upload
 * was not embedded (`failed`); `embed` and `upload` set the source. What an
 * image plugin's `empty` snippet receives (one per empty block shown).
 */
export class ImageEmptyController {
	/** The link panel is open. */
	open = $state(false);
	/** The link field's text. */
	draft = $state('');
	/** Why the last link or upload was not embedded (`null`: it was, or none was tried). */
	failed = $state<ImageEmptyFailure | null>(null);
	/** The cap on an inline (`data:`) image, written for people (`2 MB`). */
	readonly inlineLimit: string = `${MAX_INLINE_IMAGE_BYTES / (1024 * 1024)} MB`;

	constructor(
		/** The empty block; none in a suggestion's preview. */
		readonly block: Block | undefined,
		/** The words of the view rendering it (a suggestion's preview included). */
		readonly labels: ImageLabels,
		private options: {
			upload?: Uploader;
			uploads?: FileUploads;
			/** A pasted or dropped file's upload failed: the panel opens with its error. */
			error?: 'upload' | null;
		} = {}
	) {
		if (options.error) [this.open, this.failed] = [true, options.error];
	}

	/**
	 * No control may write: a readonly view, or a suggestion's preview (no
	 * block). Show a passive placeholder then.
	 */
	get readonly() {
		return !this.block || this.block.edytor.readonly;
	}

	/** The plugin has an `upload`: offer Upload. */
	get canUpload() {
		return Boolean(this.options.upload);
	}

	/** Open or close the link panel. */
	toggle = () => {
		this.open = !this.open;
	};

	/**
	 * Embed `value` (default the `draft`): an accepted source (`safeImageSrc`)
	 * becomes the block's `src` (one `patchData`); an inline image over the
	 * cap is never stored (`failed` says why).
	 */
	embed = (value: string = this.draft) => {
		const src = safeImageSrc(value);
		// An inline image over the cap is never stored: it would weigh on every sync.
		this.failed = !src ? 'invalid' : oversizedInlineImage(src) ? 'inline' : null;
		if (src && this.failed === null && this.block) {
			this.block.data.src = src;
			this.options.uploads?.clear(this.block.id);
		}
	};

	/** Upload `file` with the plugin's `upload` and embed the URL it answers. */
	upload = async (file: File) => {
		const { upload } = this.options;
		if (!upload || this.readonly) return;
		try {
			this.embed(await upload(file, { progress: () => {} }));
		} catch {
			this.failed = 'upload';
		}
	};

	/** The link field (`{@attach empty.field}`): Enter embeds its `draft`. */
	field: Attachment<HTMLInputElement> = (node) => {
		const keydown = (event: KeyboardEvent) => {
			if (event.key !== 'Enter' || event.isComposing) return;
			event.preventDefault();
			this.embed();
		};
		node.addEventListener('keydown', keydown);
		return () => node.removeEventListener('keydown', keydown);
	};
}
