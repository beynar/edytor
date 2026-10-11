import type { Edytor } from '../edytor.svelte.js';
import { type JSONText } from '$lib/utils/json.js';
import type { Block } from '../block/block.svelte.js';
import { segmentJSON, type ContentPart } from '$lib/session/handles.js';

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

	/** This segment in its block's parts, and its position among them. */
	get #at(): { part?: Extract<ContentPart, { kind: 'text' }>; index: number } {
		if ($effect.tracking()) this.edytor.cells?.get(this.blockId);
		const parts = this.edytor.idToBlock.parts(this.blockId);
		for (let index = 0, k = 0; index < parts.length; index++) {
			const part = parts[index]!;
			if (part.kind === 'text' && k++ === this.ordinal) return { part, index };
		}
		return { index: -1 };
	}

	/** Position among the block's content parts. */
	get index(): number {
		return this.#at.index;
	}

	get value(): JSONText[] {
		return segmentJSON(this.#at.part?.items ?? []);
	}

	/** The segment's text. */
	get stringContent(): string {
		return this.#at.part?.items.map((item) => item.text).join('') ?? '';
	}

	get isEmpty(): boolean {
		return this.length === 0;
	}

	get endsWithNewline(): boolean {
		return this.stringContent.endsWith('\n');
	}

	get length(): number {
		return this.#at.part?.length ?? 0;
	}

	/** Display offset of this segment inside its block's content (atoms count 1). */
	get segStart(): number {
		return this.#at.part?.start ?? 0;
	}

	/** The segment is shown by a live block. */
	get isInDocument(): boolean {
		return this.parent.isInTree && this.#at.part !== undefined;
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
		const release = this.edytor.surface.register(node, 'text', this.parent.id);
		node.setAttribute('data-edytor-id', `${this.id}`);
		node.setAttribute('data-edytor-text', `true`);

		const pluginDestroy = this.edytor.plugins.flatMap((plugin) => {
			const action = plugin.onTextAttached?.({ node, text: this });
			return typeof action === 'function' ? [action] : [];
		});
		let insideVoid = false;
		for (let block: Block | undefined = this.parent; block && !insideVoid; block = block.parent)
			insideVoid = !!block.definition.void;

		if (insideVoid) {
			node.setAttribute('contenteditable', 'true');
			node.style.outline = 'none';
		}

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
