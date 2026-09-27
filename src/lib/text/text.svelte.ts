import { Edytor } from '../edytor.svelte.js';
import { type JSONText, type SerializableContent } from '$lib/utils/json.js';
import { Block } from '../block/block.svelte.js';
import {
	batch,
	deleteText,
	removeMarksFromText,
	getMarksAtRange,
	insertText,
	markText,
	setText,
	splitText
} from './text.utils.js';
import { deltaToJson, runsToDeltas } from './deltas.js';
import { climb } from '$lib/selection/selection.utils.js';
import type { OpResult } from '$lib/crdt/index.js';
import type { ContentPart } from '$lib/session/handles.js';

/** A write through the block's model that the document did not refuse. */
const accepted = (r: OpResult | undefined): boolean => r !== undefined && r.status !== 'refused';

/**
 * An id-only text handle (§2.4 "Handles", R4): the `ordinal`-th text segment
 * of block `blockId` — no identity across commits beyond that position (K5).
 * Getters read the document index; mutators write through the block's model.
 * `node` is the element that renders the segment (a Surface fact).
 */
export class Text {
	readonly = false;
	readonly edytor: Edytor;
	readonly blockId: string;
	/** The segment's position among its block's text segments. */
	readonly ordinal: number;
	readonly id: string;
	node: HTMLElement | undefined;
	// Used when user toggles mark without selection range.
	markOnNextInsert: undefined | Record<string, SerializableContent | null> = undefined;

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
		return deltaToJson(runsToDeltas(this.#at.part?.items ?? [])[0]);
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

	// ── segment writes ───────────────────────────────────────────────────
	//
	// `insertAt`/`deleteAt`/`formatAt` are the offset-based primitives the
	// operation layer (`text.utils`), event handlers and plugins call. Offsets
	// are SEGMENT-LOCAL display atoms (UTF-16 units); `segStart` maps them into
	// the block's display space (read from the index, so a write after another
	// in the same transaction lands right).

	/** Insert `text` (optionally marked) at segment-local `offset`. */
	insertAt = (offset: number, text: string, marks?: Record<string, unknown> | null): boolean =>
		accepted(this.parent.model?.insertText(this.segStart + offset, text, marks ?? undefined));

	/** Delete `length` atoms at segment-local `offset`. */
	deleteAt = (offset: number, length: number): boolean =>
		accepted(this.parent.model?.deleteText(this.segStart + offset, length));

	/** Multi-mark format over `[offset, offset+length)` — `null` values remove the mark. */
	formatAt = (offset: number, length: number, attributes: Record<string, unknown>): boolean =>
		accepted(this.parent.model?.format(this.segStart + offset, length, attributes));

	private batch = batch.bind(this);
	getMarksAtRange = getMarksAtRange.bind(this);
	insertText = this.batch('insertText', insertText.bind(this));
	deleteText = this.batch('deleteText', deleteText.bind(this));
	splitText = this.batch('splitText', splitText.bind(this));
	setText = this.batch('setText', setText.bind(this));
	markText = this.batch('markText', markText.bind(this));
	removeMarksFromText = this.batch('removeMarksFromText', removeMarksFromText.bind(this));

	attach = (node: HTMLElement) => {
		this.node = node;
		this.edytor.nodeToText.set(node, this);
		node.setAttribute('data-edytor-id', `${this.id}`);
		node.setAttribute('data-edytor-text', `true`);

		let pluginDestroy = this.edytor.plugins.reduce(
			(acc, plugin) => {
				const action = plugin.onTextAttached?.({ node, text: this });
				action && acc.push(action);
				return acc;
			},
			[] as (() => void)[]
		);
		let insideVoid = this.parent.definition.void;
		climb(this.parent, (block) => {
			if (block instanceof Block && block.definition.void) {
				insideVoid = true;
				return true;
			}
		});

		if (insideVoid) {
			node.contentEditable = 'true';
			node.style.outline = 'none';
		}

		// A display that waited for a mounted destination runs in the next pass.
		this.edytor.projector?.mounted(this);

		return {
			destroy: () => {
				if (this.node === node) this.node = undefined;
				if (this.edytor.nodeToText.get(node) === this) this.edytor.nodeToText.delete(node);
				pluginDestroy.forEach((destroy) => destroy());
			}
		};
	};
}
