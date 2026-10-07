import { SvelteMap } from 'svelte/reactivity';
import type { Edytor } from '$lib/edytor.svelte.js';
import { pasteFlow } from '$lib/clipboard/insertClipboardFragment.js';
import { jsonBlockToSpec } from '$lib/utils/json.js';
import { id as mint } from '$lib/utils.js';
import { safeImageSrc, storableImageSrc } from './image.js';

/** An image block waiting for its upload (this view only), or whose upload failed. */
export type ImageUpload = {
	readonly status: 'uploading' | 'failed';
	/** The file, shown while it uploads (a `blob:` URL; `null` where there is none). */
	readonly preview: string | null;
};

/**
 * The uploads of pasted and dropped image files (WU-21), one per view:
 * session state, never in the document. `insert` places one empty image
 * block per file at the selection, as a paste places an image line
 * (`flow.apart`, one command, one undo step), and the block shows the file
 * uploading (`of`); the URL `upload` answers fills its `src` outside the
 * history (`dispatcher.outside`), so the paste stays the one step that
 * undoes it. A peer sees the empty block until the URL lands. A failed
 * upload, or an answer that is no image source, leaves the block empty with
 * its error; an image undone (or deleted) before its upload lands gets
 * nothing.
 */
export class ImageUploads {
	#uploads = new SvelteMap<string, ImageUpload>();

	constructor(
		private edytor: Edytor,
		private upload: (file: File) => Promise<string>
	) {}

	/** The upload of block `id` in this view (reactive), if any. */
	of = (id: string): ImageUpload | undefined => this.#uploads.get(id);

	/** Place an image block per file at the selection (one paste), then upload each. */
	insert = (files: readonly File[]) => {
		const { edytor } = this;
		if (!files.length) return;
		const lines = files.map(() =>
			jsonBlockToSpec({ id: mint('b'), type: 'image', data: {}, content: [] })
		);
		edytor.dispatcher.run('insertFromPaste', () => pasteFlow(edytor, { lines }));
		files.forEach((file, index) => {
			const id = lines[index]!.id;
			// Refused, or placed as no image (a code line takes plain lines, `flow.lines`).
			if (!edytor.facade.isVisibleBlock(id) || edytor.facade.blockTypeOf(id) !== 'image') return;
			const preview = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null;
			this.#uploads.set(id, { status: 'uploading', preview });
			void this.#send(id, file, preview);
		});
	};

	/** Forget the block's upload state (its error, once the user embeds another source). */
	clear = (id: string) => {
		this.#uploads.delete(id);
	};

	/** Release every preview. */
	destroy = () => {
		for (const { preview } of this.#uploads.values()) if (preview) URL.revokeObjectURL(preview);
		this.#uploads.clear();
	};

	#send = async (id: string, file: File, preview: string | null) => {
		let src: string | null = null;
		try {
			src = storableImageSrc(await this.upload(file));
		} catch {
			src = null;
		}
		const { edytor } = this;
		if (preview) URL.revokeObjectURL(preview);
		const block = edytor.idToBlock.get(id);
		// Gone (undone, deleted), or given a source meanwhile (a peer, the link field): nothing to fill.
		if (!block?.isInTree || edytor.destroyed || safeImageSrc(block.data.src)) {
			this.#uploads.delete(id);
			return;
		}
		if (src) {
			edytor.dispatcher.outside(() => (block.data.src = src));
			if (edytor.dispatcher.last?.status === 'applied') {
				this.#uploads.delete(id);
				return;
			}
		}
		this.#uploads.set(id, { status: 'failed', preview: null });
	};
}
