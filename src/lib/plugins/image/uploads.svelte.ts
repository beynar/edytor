import { SvelteMap } from 'svelte/reactivity';
import type { Edytor } from '$lib/edytor.svelte.js';
import { pasteFlow } from '$lib/clipboard/insertClipboardFragment.js';
import { jsonBlockToSpec } from '$lib/utils/json.js';
import { id as mint } from '$lib/utils.js';
import { safeImageSrc, storableImageSrc } from './image.js';

/**
 * An image block's upload in this view: waiting for its URL, failed, or
 * answered while the block was not shown (`landed`: an undone paste), its
 * URL held until the block shows again.
 */
export type ImageUpload =
	| {
			readonly status: 'uploading';
			/** The file, shown while it uploads (a `blob:` URL; `null` where there is none). */
			readonly preview: string | null;
	  }
	| { readonly status: 'failed' }
	| { readonly status: 'landed'; readonly src: string };

/**
 * The uploads of pasted and dropped image files, one per view: session
 * state, never in the document. `insert` places one empty image block per
 * file at the selection, as a paste places an image line (`flow.apart`, one
 * command, one undo step), and the block shows the file uploading (`of`);
 * the URL `upload` answers fills its `src` outside the history
 * (`dispatcher.outside`), so the paste stays the one step that undoes it. A
 * peer sees the empty block until the URL lands. A failed upload, or an
 * answer that is no image source, leaves the block empty with its error
 * until a source is embedded (`clear`). A URL answered while the block is
 * not shown (its paste undone, the block deleted) is held (`landed`) and
 * written when the block shows again with no source (`fill`, asked by the
 * empty block's render), so a redo brings the image back whole.
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

	/** Forget the block's upload (a source was embedded: its error, or a held URL, no longer applies). */
	clear = (id: string) => {
		const upload = this.#uploads.get(id);
		if (upload?.status === 'uploading') return;
		this.#uploads.delete(id);
	};

	/**
	 * The block shows again with no source: write the URL its upload
	 * answered while it was not shown. Asked by the empty block's render,
	 * never inside a transaction.
	 */
	fill = (id: string) => {
		const upload = this.#uploads.get(id);
		if (upload?.status !== 'landed') return;
		const block = this.edytor.idToBlock.get(id);
		if (!block?.isInTree || this.edytor.destroyed) return;
		if (safeImageSrc(block.data.src)) return this.#uploads.delete(id);
		this.#write(id, upload.src);
	};

	/** Release every preview. */
	destroy = () => {
		for (const upload of this.#uploads.values())
			if (upload.status === 'uploading' && upload.preview) URL.revokeObjectURL(upload.preview);
		this.#uploads.clear();
	};

	#send = async (id: string, file: File, preview: string | null) => {
		let src: string | null;
		try {
			src = storableImageSrc(await this.upload(file));
		} catch {
			src = null;
		}
		const { edytor } = this;
		if (preview) URL.revokeObjectURL(preview);
		if (edytor.destroyed) return;
		const block = edytor.idToBlock.get(id);
		// Given a source meanwhile (a peer, the link field): nothing to fill.
		if (block?.isInTree && safeImageSrc(block.data.src)) return this.#uploads.delete(id);
		if (!src) return this.#uploads.set(id, { status: 'failed' });
		// Not shown (undone, deleted): held until it shows again (`fill`).
		if (!block?.isInTree) return this.#uploads.set(id, { status: 'landed', src });
		this.#write(id, src);
	};

	/** The URL's write, outside the history; refused (readonly), it is held for the next show. */
	#write = (id: string, src: string) => {
		const { edytor } = this;
		const block = edytor.idToBlock.get(id)!;
		edytor.dispatcher.outside(() => (block.data.src = src));
		if (edytor.dispatcher.last?.status === 'applied') this.#uploads.delete(id);
		else this.#uploads.set(id, { status: 'landed', src });
	};
}
