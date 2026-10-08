import type { Attachment } from 'svelte/attachments';
import type { Block } from '$lib/block/block.svelte.js';
import type { MediaKindLabels, MediaLabels } from '$lib/labels.js';
import type { MediaKind } from './media.js';
import { fileUploads, type FileUpload, type Uploader } from '../uploads.svelte.js';

/** Why the last link or upload was not embedded. */
export type MediaEmptyFailure = 'invalid' | 'upload';

/**
 * An empty media block's state (an embed, a bookmark, a file, a video, an
 * audio track: the image's pattern, Notion's): the panel's `open` state,
 * the link field's `draft`, why the last link or upload was not embedded
 * (`failed`), and the upload of a pasted or dropped file (`pending`);
 * `embed` and `upload` set the source. What a media plugin's `empty`
 * snippet receives (one per empty block shown).
 */
export class MediaEmptyController {
	/** The link panel is open. */
	open = $state(false);
	/** The link field's text. */
	draft = $state('');
	/** Why the last link or upload was not embedded (`false`: it was, or none was tried). */
	failed = $state<MediaEmptyFailure | false>(false);

	constructor(
		/** The empty block; none in a suggestion's preview. */
		readonly block: Block | undefined,
		/** Which media kind it is: whose words it shows. */
		readonly kind: MediaKind,
		/** The kind's icon (an emoji). */
		readonly icon: string,
		private words: () => MediaLabels,
		private options: {
			/** The file picker's `accept`. */
			accept?: string;
			upload?: Uploader;
			/** Store a link; answers whether the block took it. */
			link: (value: string) => boolean;
			/** Store an uploaded file's URL; answers whether the block took it. */
			file?: (file: File, src: string) => boolean;
		}
	) {}

	/** The words of the view rendering it (a suggestion's preview included). */
	get labels(): MediaLabels {
		return this.words();
	}

	/** The kind's own words (its button, placeholder, submit and invalid link text). */
	get kindLabels(): MediaKindLabels & { addOrUpload?: string } {
		return this.labels[this.kind];
	}

	/** The button and placeholder text ("Embed a link"; the file's names its upload). */
	get label() {
		const words = this.kindLabels;
		return this.options.upload && words.addOrUpload ? words.addOrUpload : words.add;
	}

	/** The file picker's `accept`. */
	get accept() {
		return this.options.accept;
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

	/** The upload of a pasted or dropped file into this block, if any (its `status`, `progress`). */
	get pending(): FileUpload | undefined {
		const { block } = this;
		return block ? fileUploads(block.edytor)?.of(block.id) : undefined;
	}

	/** Open or close the link panel. */
	toggle = () => {
		this.open = !this.open;
	};

	/** Embed `value` (default the `draft`): the block takes the link, or `failed` says it did not. */
	embed = (value: string = this.draft) => {
		this.failed = this.options.link(value) ? false : 'invalid';
		if (!this.failed && this.block) fileUploads(this.block.edytor)?.clear(this.block.id);
	};

	/**
	 * Upload `file` with the plugin's `upload` and store the URL it answers,
	 * only on the block as it was picked from: still in the tree, of its kind
	 * and empty (a peer may have set a source, or deleted it, meanwhile).
	 */
	upload = async (picked: File) => {
		const { block } = this;
		const { upload, file, link } = this.options;
		if (!upload || !block || block.edytor.readonly) return;
		const { edytor, id, type } = block;
		let src: string;
		try {
			src = await upload(picked, { progress: () => {} });
		} catch {
			this.failed = 'upload';
			return;
		}
		const live = edytor.idToBlock.get(id);
		if (!live?.isInTree || live.type !== type || edytor.readonly) return;
		if (edytor.facade.blockDataOf(id)?.src !== undefined) return;
		this.failed = (file ? file(picked, src) : link(src)) ? false : 'invalid';
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
