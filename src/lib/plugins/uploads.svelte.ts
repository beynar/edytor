import { SvelteMap } from 'svelte/reactivity';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { PluginDefinitions, PluginOperations } from '$lib/plugins.js';
import { pasteFlow } from '$lib/clipboard/insertClipboardFragment.js';
import { jsonBlockToSpec } from '$lib/utils/json.js';
import { id as mint } from '$lib/utils.js';
import { placeNew } from '$lib/session/moves.js';
import type { DropAt } from '$lib/session/attempt.js';
import {
	claimUploads,
	viewUploads,
	type FileDropPort,
	type ViewUploads
} from '$lib/session/uploads.js';
import { fileDragEnd, fileDragOver, fileDropAt } from './fileDrop.js';

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
			/**
			 * The file, shown while it uploads: its object URL (`blob:`), this
			 * view's only, never stored; `null` where there is none.
			 */
			readonly preview: string | null;
			/** The file's name and size in bytes, shown at once. */
			readonly name: string;
			readonly size: number;
			/** The share sent, `0` to `1`; `null` until `upload` reports one. */
			readonly progress: number | null;
	  }
	| { readonly status: 'failed' }
	| { readonly status: 'landed'; readonly data: Record<string, unknown> };

/**
 * What files a kind takes (its record's `upload`, `BlockDefinition`): which,
 * who sends them (`send`, its plugin's `upload` option) and the data an
 * upload's answer writes. A kind without it takes no files.
 */
export type KindUpload = {
	/** Upload a file of this kind and answer its URL (its plugin's `upload`). */
	send: Uploader;
	/** Whether it takes `file`. */
	accepts: (file: File) => boolean;
	/** It takes any file no other kind takes (the file block): asked last. */
	fallback?: boolean;
	/** The data the answered URL writes (`null`: no source this kind stores). */
	data: (file: File, answer: string) => Record<string, unknown> | null;
	/** Whether the block has a source already (a peer's, a link's): its upload then writes nothing. */
	filled: (data: Record<string, unknown>) => boolean;
};

/** A kind that takes files, and its type. */
type UploadKind = KindUpload & { type: string };

/**
 * The view's uploads (`media.files`), one per view, claimed by the first
 * media plugin listed with an `upload`: the uploads of pasted, dropped and
 * picked files (an empty block's Upload), session state, never in the
 * document. A kind takes files by its record's `upload`, and sends them
 * with its `send` (its plugin's uploader); a paste or a drop (a drop replays
 * the paste hooks) of files the kinds take places one empty block per
 * file, each of the kind that takes it (`fallback` last), in the
 * clipboard's order, as one paste (one command, one undo step), and each
 * block shows its upload (`of`).
 * The data an upload answers fills the block outside the history
 * (`dispatcher.outside`), so the paste stays the one step that undoes it.
 * A failed upload, or an answer that is no source, leaves the block empty
 * with its error until a source is embedded (`clear`). Data answered while
 * the block is not shown (its paste undone, the block deleted) is held
 * (`landed`) and written when the block shows again with no source
 * (`fill`, asked by the empty block's render), so a redo brings it back
 * whole.
 */
export class FileUploads implements ViewUploads {
	#uploads = new SvelteMap<string, FileUpload>();

	constructor(private edytor: Edytor) {}

	/** The kinds that take files (their records' `upload`), in registration order. */
	get #kinds(): UploadKind[] {
		return [...this.edytor.blocks].flatMap(([type, { upload }]) =>
			upload ? [{ type, ...upload }] : []
		);
	}

	/** The kind that takes `file`, if any. */
	#kindOf = (file: File): UploadKind | undefined =>
		this.#kinds.find((kind) => !kind.fallback && kind.accepts(file)) ??
		this.#kinds.find((kind) => kind.fallback && kind.accepts(file));

	/** The kind that takes `file`, if any. */
	kindOf = (file: File) => this.#kindOf(file)?.type;

	/** Files dragged from outside: the drop indicator and the placement (`fileDrop.ts`). */
	readonly drop: FileDropPort = {
		over: (event) => fileDragOver(this.edytor, event) !== null,
		at: (event) => fileDropAt(this.edytor, event),
		end: () => fileDragEnd(this.edytor)
	};

	/** The upload of block `id` in this view (reactive), if any. */
	of = (id: string): FileUpload | undefined => this.#uploads.get(id);

	/**
	 * The paste hook: the files a kind takes, unless the HTML beside them
	 * shows text (an office app puts a picture of copied text on the
	 * clipboard).
	 */
	paste: NonNullable<PluginOperations['onPaste']> = ({ e, prevent, at }) => {
		if (this.edytor.readonly) return;
		const files = Array.from(e.clipboardData?.files ?? []).filter((file) => this.#kindOf(file));
		if (files.length && !showsText(e.clipboardData?.getData('text/html')))
			prevent(() => this.insert(files, at));
	};

	/**
	 * Place a block per file at the selection (one paste), or at a drop's
	 * placement (`at`: beside, before, after or inside a block, one command),
	 * then upload each.
	 */
	insert = (files: readonly File[], at?: DropAt) => {
		const { edytor } = this;
		const placed = files.flatMap((file) => {
			const kind = this.#kindOf(file);
			return kind ? [{ file, kind, id: mint('b') }] : [];
		});
		if (!placed.length) return;
		const lines = placed.map(({ kind, id }) =>
			jsonBlockToSpec({ id, type: kind.type, data: {}, content: [] })
		);
		const target = at && edytor.idToBlock.get(at.block);
		if (at && target)
			edytor.dispatcher.run('insertFromDrop', () =>
				placeNew(
					edytor,
					placed.map(({ kind, id }) => ({ id, type: kind.type })),
					target,
					at.position
				)
			);
		else edytor.dispatcher.run('insertFromPaste', () => pasteFlow(edytor, { lines }));
		for (const { file, kind, id } of placed) {
			// Refused, or placed as no such block (a code line takes plain lines, `flow.lines`).
			if (!edytor.facade.isVisibleBlock(id) || edytor.facade.blockTypeOf(id) !== kind.type)
				continue;
			void this.#send(id, kind, file);
		}
	};

	/**
	 * Upload `file`, picked on the empty block `id` (its Upload), with its
	 * kind's uploader, the block showing it meanwhile, and hand the answer to
	 * `land` before the preview goes (so the block never shows nothing
	 * between them): `false` when it failed (the block then shows no
	 * upload; the caller says why).
	 */
	pick = async (id: string, file: File, land: (answer: string) => void): Promise<boolean> => {
		const kind = this.edytor.idToBlock.get(id)?.definition.upload;
		if (!kind) return false;
		try {
			land(await this.#run(id, kind, file));
			return true;
		} catch {
			return false;
		} finally {
			this.#settle(id);
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
		const kind = block.definition.upload;
		if (!kind || kind.filled(block.data)) return this.#uploads.delete(id);
		this.#write(id, upload.data);
	};

	/** Release every preview. */
	destroy = () => {
		for (const upload of this.#uploads.values())
			if (upload.status === 'uploading' && upload.preview) URL.revokeObjectURL(upload.preview);
		this.#uploads.clear();
	};

	/**
	 * Send `file` with the kind's uploader, block `id` showing it meanwhile
	 * (`uploading`: its object URL, name, size and progress): the answer.
	 * The object URL stays until `#settle` (after the answer is stored, so
	 * the block never shows nothing between them).
	 */
	#run = (id: string, kind: KindUpload, file: File) => {
		const preview = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null;
		this.#uploads.set(id, {
			status: 'uploading',
			preview,
			name: file.name,
			size: file.size,
			progress: null
		});
		const report: UploadReport = {
			progress: (fraction) => {
				const upload = this.#uploads.get(id);
				if (upload?.status !== 'uploading' || !Number.isFinite(fraction)) return;
				this.#uploads.set(id, { ...upload, progress: Math.min(1, Math.max(0, fraction)) });
			}
		};
		return kind.send(file, report);
	};

	/** The upload of `id` ended: revoke its object URL and forget it, if it still runs. */
	#settle = (id: string) => {
		const upload = this.#uploads.get(id);
		if (upload?.status !== 'uploading') return;
		if (upload.preview) URL.revokeObjectURL(upload.preview);
		this.#uploads.delete(id);
	};

	#send = async (id: string, kind: UploadKind, file: File) => {
		let data: Record<string, unknown> | null;
		try {
			data = kind.data(file, await this.#run(id, kind, file));
		} catch {
			data = null;
		}
		const { edytor } = this;
		if (edytor.destroyed) return;
		const block = edytor.idToBlock.get(id);
		const upload = this.#uploads.get(id);
		const preview = upload?.status === 'uploading' ? upload.preview : null;
		// Given a source meanwhile (a peer, the link field): nothing to fill.
		if (block?.isInTree && kind.filled(block.data)) this.#uploads.delete(id);
		else if (!data) this.#uploads.set(id, { status: 'failed' });
		// Not shown (undone, deleted): held until it shows again (`fill`).
		else if (!block?.isInTree) this.#uploads.set(id, { status: 'landed', data });
		else this.#write(id, data);
		if (preview) URL.revokeObjectURL(preview);
	};

	/** The data's write, outside the history; refused (readonly), it is held for the next show. */
	#write = (id: string, data: Record<string, unknown>) => {
		const { edytor } = this;
		edytor.dispatcher.outside(() =>
			edytor.patchData(
				id,
				Object.entries(data).map(([key, value]) => ({ path: [key], value }))
			)
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

/** The view's uploads, when a media plugin with an `upload` is listed. */
export const fileUploads = (edytor: Edytor | undefined): FileUploads | undefined => {
	const uploads = viewUploads(edytor);
	return uploads instanceof FileUploads ? uploads : undefined;
};

/**
 * The hooks of a media plugin given an `upload` (its kind's record carries
 * it, `KindUpload.send`): the first such plugin listed in a view claims the
 * view's one `FileUploads` and runs its paste hook (a drop replays it) and
 * teardown; the others add none.
 */
export const uploadHooks = (
	edytor: Edytor | undefined,
	upload: Uploader | undefined
): PluginOperations & PluginDefinitions => {
	if (!edytor || !upload || viewUploads(edytor)) return {};
	const uploads = new FileUploads(edytor);
	claimUploads(edytor, uploads);
	return { onPaste: uploads.paste, onEdytorAttached: () => uploads.destroy };
};
