/**
 * Handles (plan §2.4 "Handles", §4.3 `session/handles.ts`, R4): the id-only
 * `Block`, `Text` and `InlineBlock` that extensions, normalizers and the
 * view's own code hold. A handle's getters read the document index — which
 * folds mid-transaction behind its watermark, so a read inside a command
 * sees the writes before it — and its mutators issue commands. Nothing is
 * mirrored or adopted: a block the current transaction created has a handle
 * at once.
 *
 * One handle per id: blocks by id, texts by (block, ordinal) — a text is the
 * `ordinal`-th segment of its block and has no identity across commits
 * (K5) —, atoms by atom id. The cache is pruned from a commit's `removed`;
 * a handle for a dead id answers through `isInTree` / `isInDocument`.
 */
import { Block } from '../block/block.svelte.js';
import { InlineBlock } from '../block/inlineBlock.svelte.js';
import { Text } from '../text/text.svelte.js';
import type { ContentItem, ContentRun, DocChange } from '../crdt/index.js';
import type { Edytor } from '../edytor.svelte.js';

export type TextRunItem = { text: string; marks?: Record<string, unknown> };

/** A block's content as the index shows it: text segments between atoms, each at its display start. */
export type ContentPart =
	| { kind: 'text'; start: number; items: TextRunItem[]; length: number }
	| { kind: 'inline'; start: number; item: ContentItem & { kind: 'inline' } };

/** Segments and atoms, alternating, starting and ending with a segment. */
export const contentParts = (items: readonly ContentItem[]): ContentPart[] => {
	const parts: ContentPart[] = [];
	let segment: TextRunItem[] = [];
	let start = 0;
	let at = 0;
	const close = () => {
		parts.push({ kind: 'text', start, items: segment, length: at - start });
		segment = [];
	};
	for (const item of items) {
		if (item.kind === 'text') {
			segment.push({ text: item.text, ...(item.marks ? { marks: item.marks } : {}) });
			at += item.text.length;
			continue;
		}
		close();
		parts.push({ kind: 'inline', start: at, item });
		start = ++at;
	}
	close();
	return parts;
};

const ROOT = contentParts([]);

export class Handles {
	readonly root: Block;
	#blocks = new Map<string, Block>();
	#texts = new Map<string, Text[]>();
	#atoms = new Map<string, InlineBlock>();
	/** Each block's parts at the index version they were read (the last read of a dead block). */
	#parts = new Map<string, { runs: readonly ContentRun[]; parts: ContentPart[] }>();

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
	parts = (id: string): ContentPart[] => {
		if (id === 'root') return ROOT;
		const { facade } = this.edytor;
		const memo = this.#parts.get(id);
		const runs = facade.runs(id);
		if (memo?.runs === runs) return memo.parts;
		// A dead block keeps what it last showed (a write's intent is minted from it).
		if (memo && !facade.isVisibleBlock(id)) return memo.parts;
		const parts = contentParts(runs as readonly ContentItem[]);
		this.#parts.set(id, { runs, parts });
		return parts;
	};

	/** Forget the handles of the blocks a commit removed. */
	prune = (change: DocChange) => {
		for (const id of change.removed) {
			for (const part of this.#parts.get(id)?.parts ?? [])
				if (part.kind === 'inline' && this.#atoms.get(part.item.id)?.blockId === id)
					this.#atoms.delete(part.item.id);
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
