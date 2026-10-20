/**
 * Handles: the id-only
 * `Block`, `Text` and `InlineBlock` that extensions, normalizers and the
 * view's own code hold. A handle's getters read the document index — which
 * folds mid-transaction behind its watermark, so a read inside a command
 * sees the writes before it — and its mutators issue commands. Nothing is
 * mirrored or adopted: a block the current transaction created has a handle
 * at once.
 *
 * One handle per id: blocks by id, texts by (block, ordinal) — a text is the
 * `ordinal`-th segment of its block and has no identity across commits
 * —, atoms by atom id. The cache is pruned from a commit's `removed`;
 * a handle for a dead id answers through `isInTree` / `isInDocument`.
 */
import { Block } from '../block/block.svelte.js';
import { InlineBlock } from '../block/inlineBlock.svelte.js';
import { Text } from '../text/text.svelte.js';
import type { Destination, DocChange } from '../crdt/index.js';
import { partsOf, type Part } from '../crdt/parts.js';
import type { Edytor } from '../edytor.svelte.js';
import type { JSONText } from '../utils/json.js';

export type TextRunItem = { text: string; marks?: Record<string, unknown> };

export type { Part as ContentPart } from '../crdt/parts.js';

/**
 * A text segment's items as `JSONText` runs (`text.value`): empty items
 * dropped, adjacent runs with the same marks joined, each run's marks a
 * copy (none when it has no mark).
 */
export const segmentJSON = (items: readonly TextRunItem[]): JSONText[] => {
	const out: JSONText[] = [];
	for (const { text, marks = {} } of items) {
		if (!text) continue;
		const keys = Object.keys(marks);
		const last = out.at(-1);
		const held = last?.marks ?? {};
		if (last && Object.keys(held).length === keys.length && keys.every((k) => held[k] === marks[k]))
			last.text += text;
		else out.push(keys.length ? { text, marks: { ...marks } as JSONText['marks'] } : { text });
	}
	return out;
};

const ROOT = partsOf([]);

/** The destination right after `block` among its siblings (`after: false`, right before it). */
export const siblingSlot = (block: Block, after = true): Destination => {
	const parent = block.parent;
	return {
		parent: !parent || parent.isRoot ? null : parent.id,
		index: block.index + Number(after)
	};
};

export class Handles {
	readonly root: Block;
	#blocks = new Map<string, Block>();
	#texts = new Map<string, Text[]>();
	#atoms = new Map<string, InlineBlock>();
	/** Each block's parts as last read (a dead block's: what it last showed). */
	#parts = new Map<string, readonly Part[]>();

	constructor(private edytor: Edytor) {
		this.root = new Block(edytor, 'root');
	}

	/** The handle of block `id`, live or not (the one a caller held stays the same object). */
	block = (id: string): Block => {
		if (id === 'root') return this.root;
		let block = this.#blocks.get(id);
		if (!block) this.#blocks.set(id, (block = new Block(this.edytor, id)));
		return block;
	};

	/** The handle of live block `id`; none for a dead or unknown id. */
	get = (id: string): Block | undefined =>
		id === 'root' || (id && this.edytor.facade.isVisibleBlock(id)) ? this.block(id) : undefined;

	has = (id: string) => this.get(id) !== undefined;

	/** The `ordinal`-th text segment of block `blockId`. */
	text = (blockId: string, ordinal: number): Text => {
		const texts = this.#texts.get(blockId) ?? this.#texts.set(blockId, []).get(blockId)!;
		return (texts[ordinal] ??= new Text(this.edytor, blockId, ordinal));
	};

	/** The text whose id is `id` (`t:<block>:<ordinal>`), while its segment exists. */
	textById = (id: string): Text | undefined => {
		const at = id.lastIndexOf(':');
		const block = this.get(id.slice(2, at));
		const ordinal = Number(id.slice(at + 1));
		const text = block?.content.filter((part) => part instanceof Text)[ordinal];
		return text instanceof Text ? text : undefined;
	};

	/** The handle of atom `atomId`, shown in block `blockId`. */
	atom = (blockId: string, atomId: string): InlineBlock => {
		let atom = this.#atoms.get(atomId);
		if (!atom) this.#atoms.set(atomId, (atom = new InlineBlock(this.edytor, blockId, atomId)));
		atom.blockId = blockId;
		return atom;
	};

	/**
	 * Block `id`'s content parts — from its runs, which the index keeps per
	 * block and reads-your-writes (a write elsewhere re-derives nothing here).
	 */
	parts = (id: string): readonly Part[] => {
		if (id === 'root') return ROOT;
		const parts = partsOf(this.edytor.facade.runs(id));
		const last = this.#parts.get(id);
		// A dead block keeps what it last showed (a write's intent is minted from it).
		if (last && last !== parts && !this.edytor.facade.isVisibleBlock(id)) return last;
		this.#parts.set(id, parts);
		return parts;
	};

	/** Forget the handles of the blocks a commit removed. */
	prune = (change: DocChange) => {
		for (const id of change.removed) {
			for (const part of this.#parts.get(id) ?? [])
				if (part.kind === 'inline' && this.#atoms.get(part.id)?.blockId === id)
					this.#atoms.delete(part.id);
			this.#blocks.delete(id);
			this.#texts.delete(id);
			this.#parts.delete(id);
		}
	};

	clear = () => {
		this.#blocks.clear();
		this.#texts.clear();
		this.#atoms.clear();
		this.#parts.clear();
	};
}
