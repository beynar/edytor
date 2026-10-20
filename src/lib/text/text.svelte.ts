import { cleanups } from '$lib/utils.js';
import type { Edytor } from '../edytor.svelte.js';
import { type JSONText } from '$lib/utils/json.js';
import type { Block } from '../block/block.svelte.js';
import { segmentJSON } from '$lib/session/handles.js';
import type { Segment } from '$lib/crdt/parts.js';

/**
 * An id-only, read-only text handle: the `ordinal`-th text segment of block
 * `blockId` — no identity across commits beyond that position. Getters read
 * the document index; writes are the view's operations in block offsets
 * (`edytor.insertText(text.parent.id, text.segStart + offset, …)`). `node`
 * is the element that renders the segment (a Surface fact). A reactive
 * reader of a getter depends on the block's cell, so it re-runs when a
 * commit changes the block's content.
 */
export class Text {
	readonly = false;
	readonly edytor: Edytor;
	readonly blockId: string;
	/** The segment's position among its block's text segments. */
	readonly ordinal: number;
	readonly id: string;
	node: HTMLElement | undefined;

	constructor(edytor: Edytor, blockId: string, ordinal: number) {
		this.edytor = edytor;
		this.blockId = blockId;
		this.ordinal = ordinal;
		this.id = `t:${blockId}:${ordinal}`;
	}

	get parent(): Block {
		return this.edytor.idToBlock.block(this.blockId);
	}

	/** This segment in its block's parts. */
	get #parts() {
		if ($effect.tracking()) this.edytor.cells?.get(this.blockId);
		return this.edytor.idToBlock.parts(this.blockId);
	}
	get #part(): Segment | undefined {
		return this.#parts.find(
			(part): part is Segment => part.kind === 'text' && part.segOrd === this.ordinal
		);
	}

	/** Position among the block's content parts. */
	get index(): number {
		const parts = this.#parts;
		return parts.indexOf(this.#part!);
	}

	get value(): JSONText[] {
		return segmentJSON(this.#part?.runs ?? []);
	}

	/** The segment's text. */
	get stringContent(): string {
		return this.#part?.text ?? '';
	}

	get isEmpty(): boolean {
		return this.length === 0;
	}

	get endsWithNewline(): boolean {
		return this.stringContent.endsWith('\n');
	}

	get length(): number {
		return this.stringContent.length;
	}

	/** Display offset of this segment inside its block's content (atoms count 1). */
	get segStart(): number {
		return this.#part?.start ?? 0;
	}

	/** The segment is shown by a live block. */
	get isInDocument(): boolean {
		return this.parent.isInTree && this.#part !== undefined;
	}

	/**
	 * Re-create this block's text elements from its cell — the repair of a
	 * DOM the browser or a foreign script changed (typing and model commits
	 * never remount). Never while the IME owns the element. A remount under
	 * the caret is a render the projector displays after (`mounted`).
	 */
	refreshFromModel = () => {
		if (this.edytor.pin.owns(this.node)) return;
		this.edytor.cells?.remount(this.parent.id);
	};

	/**
	 * The runs of `[start, end)` (segment offsets), each with a copy of its
	 * marks: the MODEL runs (`value`), never the rendered ones — a kind's
	 * `transformText` decorations (code tokens) are no marks of the text.
	 */
	getMarksAtRange = (start: number, end: number): JSONText[] => {
		const result: JSONText[] = [];
		let offset = 0;
		for (const { text, marks } of this.value) {
			const until = offset + text.length;
			// From the run holding `start`, every run starting before `end`.
			if (result.length ? offset < end : start >= offset && start < until)
				result.push({
					text: text.slice(Math.max(0, start - offset), end - offset),
					marks: { ...marks }
				});
			offset = until;
		}
		return result;
	};

	/** @internal */
	attach = (node: HTMLElement) => {
		this.node = node;
		this.edytor.nodeToText.set(node, this);
		// Registered, it takes the attribute table's attributes (`surface/attributes.ts`).
		const release = this.edytor.surface.register(node, 'text', this.parent.id);
		const pluginDestroy = cleanups(this.edytor.plugins, (plugin) =>
			plugin.onTextAttached?.({ node, text: this })
		);

		// A display that waited for a mounted destination runs in the next pass.
		this.edytor.projector?.mounted(this);

		return {
			destroy: () => {
				if (this.node === node) this.node = undefined;
				if (this.edytor.nodeToText.get(node) === this) this.edytor.nodeToText.delete(node);
				release();
				pluginDestroy.forEach((destroy) => destroy());
			}
		};
	};
}
