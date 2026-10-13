import type { Attachment } from 'svelte/attachments';
import type { Block } from '$lib/block/block.svelte.js';
import type { MediaKind } from './media.js';
import { fileUploads, type FileUpload } from '../uploads.svelte.js';
import { listen } from '$lib/utils/listen.js';

/** Each media kind's icon (the image's too): its menu row, its empty block, its paste offer. */
export const MEDIA_ICONS: Record<MediaKind | 'image', string> = {
	image: '🖼',
	embed: '⧉',
	bookmark: '🔖',
	file: '📎',
	video: '🎬',
	audio: '🎵'
};

/**
 * Why the last link or upload was not embedded: no source the kind takes
 * (`invalid`), an inline image over the cap (`inline`), a failed upload.
 */
export type MediaEmptyFailure = 'invalid' | 'inline' | 'upload';

/** What an empty block reads of its kind in a view: how it stores a source. */
export type EmptyView = {
	/** Store a link (or the URL an upload of `file` answered) on `block`: why it did not, or `null`. */
	store: (block: Block, value: string, file?: File) => MediaEmptyFailure | null;
};

/**
 * An empty image or media block's state (an image, an embed, a bookmark, a
 * file, a video, an audio track: Notion's "Add …"): the panel's `open`
 * state, the link field's `draft`, why the last link or upload was not
 * embedded (`failed`), and the upload of a pasted or dropped file
 * (`pending`); `embed` and `upload` set the source. What an image or media
 * plugin's `empty` snippet receives (one per empty block shown).
 */
export class MediaEmptyController {
	/** The link panel is open. */
	open = $state(false);
	/** The link field's text. */
	draft = $state('');
	/** Why the last link or upload was not embedded (`null`: it was, or none was tried). */
	failed = $state<MediaEmptyFailure | null>(null);

	constructor(
		/** The empty block; none in a suggestion's preview. */
		readonly block: Block | undefined,
		/** Which kind it is (your words for it: its button, placeholder, errors). */
		readonly kind: MediaKind | 'image',
		/** The kind in the block's view. */
		private view: EmptyView | undefined
	) {}

	/** The kind's icon (an emoji). */
	get icon() {
		return MEDIA_ICONS[this.kind];
	}

	/** The file picker's `accept`: `image/*`, `video/*`, `audio/*`, else any file. */
	get accept() {
		const { kind } = this;
		return kind === 'image' || kind === 'video' || kind === 'audio' ? `${kind}/*` : undefined;
	}

	/**
	 * No control may write: a readonly view, or a suggestion's preview (no
	 * block). Show a passive placeholder then.
	 */
	get readonly() {
		return !this.block || this.block.edytor.readonly;
	}

	/** The kind's plugin was given an `upload`: offer Upload. */
	get canUpload() {
		const { block } = this;
		return Boolean(block && fileUploads(block.edytor) && block.definition.upload);
	}

	/** The upload of a pasted or dropped file into this block, if any (its `status`, `progress`, `preview`). */
	get pending(): FileUpload | undefined {
		const { block } = this;
		return block ? fileUploads(block.edytor)?.of(block.id) : undefined;
	}

	/**
	 * The file uploading into this block, shown at once: its object URL
	 * (this view's only, never stored; revoked once the upload ends), else `null`.
	 */
	get preview(): string | null {
		const { pending } = this;
		return pending?.status === 'uploading' ? pending.preview : null;
	}

	/** The share of the upload sent, `0` to `1`; `null` before a report, or with no upload. */
	get progress(): number | null {
		const { pending } = this;
		return pending?.status === 'uploading' ? pending.progress : null;
	}

	/** Store `value` on the block: why it did not take it, or `null`. */
	#store = (value: string, file?: File) =>
		this.block && this.view ? this.view.store(this.block, value, file) : 'invalid';

	/** Embed `value` (default the `draft`): the block takes the link, or `failed` says why not. */
	embed = (value: string = this.draft) => {
		this.failed = this.#store(value);
		if (!this.failed && this.block) fileUploads(this.block.edytor)?.clear(this.block.id);
	};

	/**
	 * Upload `file` with its kind's uploader (its plugin's `upload`), the
	 * block showing it meanwhile (`pending`, `preview`, `progress`), and
	 * store the URL it answers, only on the block as it was picked from:
	 * still in the tree, of its kind and empty (a peer may have set a
	 * source, or deleted it, meanwhile).
	 */
	upload = async (picked: File) => {
		const { block } = this;
		const uploads = this.canUpload && fileUploads(block?.edytor);
		if (!uploads || !block || block.edytor.readonly) return;
		const { edytor, id, type } = block;
		const stored = await uploads.pick(id, picked, (src) => {
			const live = edytor.idToBlock.get(id);
			if (!live?.isInTree || live.type !== type || edytor.readonly) return;
			if (edytor.facade.blockDataOf(id)?.src !== undefined) return;
			this.failed = this.#store(src, picked);
		});
		if (!stored) this.failed = 'upload';
	};

	/** The link field (`{@attach empty.field}`): Enter embeds its `draft`. */
	field: Attachment<HTMLInputElement> = (node) => {
		const keydown = (event: KeyboardEvent) => {
			if (event.key !== 'Enter' || event.isComposing) return;
			event.preventDefault();
			this.embed();
		};
		return listen(node, 'keydown', keydown);
	};
}
