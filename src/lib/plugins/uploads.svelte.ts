import { SvelteMap } from 'svelte/reactivity';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { PluginOperations } from '$lib/plugins.js';
import { pasteFlow } from '$lib/clipboard/insertClipboardFragment.js';
import { jsonBlockToSpec } from '$lib/utils/json.js';
import { id as mint } from '$lib/utils.js';

/** What an `upload` may report while it runs. */
export type UploadReport = {
	/** The share sent so far, `0` to `1`: the block shows it as a bar. */
	progress(fraction: number): void;
};

/**
 * Upload a file and answer its URL. `report.progress` (optional to call)
 * draws the block's bar; without it the bar is indeterminate.
 */
export type Uploader = (file: File, report: UploadReport) => Promise<string>;

/**
 * A block's upload in this view: running (its preview and progress),
 * failed, or answered while the block was not shown (`landed`: an undone
 * paste), its data held until the block shows again.
 */
export type FileUpload =
	| {
			readonly status: 'uploading';
			/** The file, shown while it uploads (a `blob:` URL; `null` where there is none). */
			readonly preview: string | null;
			/** The share sent, `0` to `1`; `null` until `upload` reports one. */
			readonly progress: number | null;
	  }
	| { readonly status: 'failed' }
	| { readonly status: 'landed'; readonly data: Record<string, unknown> };

/** A kind that takes files: which, through what upload, and the data an upload writes. */
export type UploadKind = {
	type: string;
	/** Whether it takes `file`. */
	accepts: (file: File) => boolean;
	/** It takes any file no other kind takes (the file block): asked last. */
	fallback?: boolean;
	upload: Uploader;
	/** The data the answered URL writes (`null`: no source this kind stores). */
	data: (file: File, answer: string) => Record<string, unknown> | null;
	/** Whether the block has a source already (a peer's, a link's): its upload then writes nothing. */
	filled: (data: Record<string, unknown>) => boolean;
	/** Show the file while it uploads (an image's `blob:` preview). */
	preview?: boolean;
};

/**
 * The view's uploads of pasted and dropped files (`media.files`), one per
 * view: session state, never in the document. The kinds given an `upload`
 * register here; a paste or a drop (a drop replays the paste hooks) of
 * files the kinds take places one empty block per file, each of the kind
 * that takes it (`fallback` last), in the clipboard's order, as one paste
 * (one command, one undo step), and each block shows its upload (`of`).
 * The data an upload answers fills the block outside the history
 * (`dispatcher.outside`), so the paste stays the one step that undoes it.
 * A failed upload, or an answer that is no source, leaves the block empty
 * with its error until a source is embedded (`clear`). Data answered while
 * the block is not shown (its paste undone, the block deleted) is held
 * (`landed`) and written when the block shows again with no source
 * (`fill`, asked by the empty block's render), so a redo brings it back
 * whole.
 */
export class FileUploads {
	#kinds: UploadKind[] = [];
	#uploads = new SvelteMap<string, FileUpload>();

	constructor(private edytor: Edytor) {}

	/** Take files for `kind` (the first registration of a type wins, as its definition). */
	register = (kind: UploadKind) => {
		if (!this.#kinds.some(({ type }) => type === kind.type)) this.#kinds.push(kind);
	};

	/** The kind that takes `file`, if any. */
	kindOf = (file: File): UploadKind | undefined =>
		this.#kinds.find((kind) => !kind.fallback && kind.accepts(file)) ??
		this.#kinds.find((kind) => kind.fallback && kind.accepts(file));

	/** The upload of block `id` in this view (reactive), if any. */
	of = (id: string): FileUpload | undefined => this.#uploads.get(id);

	/**
	 * The paste hook of every kind that registered (the first one asked
	 * claims for them all): the files a kind takes, unless the HTML beside
	 * them shows text (an office app puts a picture of copied text on the
	 * clipboard).
	 */
	paste: NonNullable<PluginOperations['onPaste']> = ({ e, prevent }) => {
		if (this.edytor.readonly || !this.#kinds.length) return;
		const files = Array.from(e.clipboardData?.files ?? []).filter((file) => this.kindOf(file));
		if (files.length && !showsText(e.clipboardData?.getData('text/html')))
			prevent(() => this.insert(files));
	};

	/** Place a block per file at the selection (one paste), then upload each. */
	insert = (files: readonly File[]) => {
		const { edytor } = this;
		const placed = files.flatMap((file) => {
			const kind = this.kindOf(file);
			return kind ? [{ file, kind, id: mint('b') }] : [];
		});
		if (!placed.length) return;
		const lines = placed.map(({ kind, id }) =>
			jsonBlockToSpec({ id, type: kind.type, data: {}, content: [] })
		);
		edytor.dispatcher.run('insertFromPaste', () => pasteFlow(edytor, { lines }));
		for (const { file, kind, id } of placed) {
			// Refused, or placed as no such block (a code line takes plain lines, `flow.lines`).
			if (!edytor.facade.isVisibleBlock(id) || edytor.facade.blockTypeOf(id) !== kind.type)
				continue;
			const preview =
				kind.preview && typeof URL.createObjectURL === 'function'
					? URL.createObjectURL(file)
					: null;
			this.#uploads.set(id, { status: 'uploading', preview, progress: null });
			void this.#send(id, kind, file, preview);
		}
	};

	/** Forget the block's upload (a source was embedded: its error, or held data, no longer applies). */
	clear = (id: string) => {
		const upload = this.#uploads.get(id);
		if (upload?.status === 'uploading') return;
		this.#uploads.delete(id);
	};

	/**
	 * The block shows again with no source: write the data its upload
	 * answered while it was not shown. Asked by the empty block's render,
	 * never inside a transaction.
	 */
	fill = (id: string) => {
		const upload = this.#uploads.get(id);
		if (upload?.status !== 'landed') return;
		const block = this.edytor.idToBlock.get(id);
		if (!block?.isInTree || this.edytor.destroyed) return;
		const kind = this.#kinds.find(({ type }) => type === block.type);
		if (!kind || kind.filled(block.data)) return this.#uploads.delete(id);
		this.#write(id, upload.data);
	};

	/** Release every preview. */
	destroy = () => {
		for (const upload of this.#uploads.values())
			if (upload.status === 'uploading' && upload.preview) URL.revokeObjectURL(upload.preview);
		this.#uploads.clear();
	};

	#send = async (id: string, kind: UploadKind, file: File, preview: string | null) => {
		const report: UploadReport = {
			progress: (fraction) => {
				const upload = this.#uploads.get(id);
				if (upload?.status !== 'uploading' || !Number.isFinite(fraction)) return;
				this.#uploads.set(id, { ...upload, progress: Math.min(1, Math.max(0, fraction)) });
			}
		};
		let data: Record<string, unknown> | null;
		try {
			data = kind.data(file, await kind.upload(file, report));
		} catch {
			data = null;
		}
		const { edytor } = this;
		if (preview) URL.revokeObjectURL(preview);
		if (edytor.destroyed) return;
		const block = edytor.idToBlock.get(id);
		// Given a source meanwhile (a peer, the link field): nothing to fill.
		if (block?.isInTree && kind.filled(block.data)) return this.#uploads.delete(id);
		if (!data) return this.#uploads.set(id, { status: 'failed' });
		// Not shown (undone, deleted): held until it shows again (`fill`).
		if (!block?.isInTree) return this.#uploads.set(id, { status: 'landed', data });
		this.#write(id, data);
	};

	/** The data's write, outside the history; refused (readonly), it is held for the next show. */
	#write = (id: string, data: Record<string, unknown>) => {
		const { edytor } = this;
		const block = edytor.idToBlock.get(id)!;
		edytor.dispatcher.outside(() =>
			block.patchData({ ops: Object.entries(data).map(([key, value]) => ({ path: [key], value })) })
		);
		if (edytor.dispatcher.last?.status === 'applied') this.#uploads.delete(id);
		else this.#uploads.set(id, { status: 'landed', data });
	};
}

/** Whether pasted `html` shows text (then it is imported, its files a picture of it). */
const showsText = (html: string | undefined) =>
	!!html &&
	typeof DOMParser !== 'undefined' &&
	!!new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim();

const views = new WeakMap<Edytor, FileUploads>();

/** The view's file uploads (made at the first ask; `undefined` with no view). */
export const fileUploads = (edytor: Edytor | undefined): FileUploads | undefined => {
	if (!edytor) return undefined;
	let uploads = views.get(edytor);
	if (!uploads) views.set(edytor, (uploads = new FileUploads(edytor)));
	return uploads;
};
