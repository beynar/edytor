/**
 * View-side command adapter for block operations: each delegates to one document operation.
 *
 * These functions are the `BlockOperations` layer bound onto `Block` via
 * `batch()`, which dispatches each call as a command (admission, plugin
 * interception, one transaction: `session/commands.ts`). The functions own
 * path/offset resolution (target paths → parent blocks, a text's `segStart`,
 * sibling lookup for `nestBlock`), the plan of an operation
 * that is one document op (`prepare*`) and its normalization requests.
 *
 * OPERATIONS READ AND WRITE ONLY THE DOCUMENT: `Block`/`Text` are id-only
 * handles whose getters read the index, so what a caller needs after the
 * write (the new block, the text after an inserted atom, the caret a range op
 * decided) is the op's document result as a handle (`batch`'s `resolve`) —
 * inside an outer transaction too.
 *
 * STRUCTURAL PERMISSION IS DOCUMENT-OWNED: every op delegates to
 * `block.model.*` (the facade through `DocBlock`) and treats a `refused` result
 * as "refused" — no view-side re-checks of the rules the document already
 * enforces (island sealing, void/island destinations, own-subtree moves,
 * merges across island boundaries; see `edytor-doc.ts` `canPlace` and
 * `canMerge`). Removing a view-side semantic guard must never
 * change document behavior — if a rule matters here it belongs in the
 * facade, not in this file.
 *
 * Content preparation produces `BlockSpec`/`ContentItem` DIRECTLY from
 * JSON (`jsonBlockToSpec`/`jsonContentToItems` in `utils/json.ts`): specs are
 * data (`new Block({block})` is gone). The live-content invariant
 * (text-first/text-last, no adjacent same-kind parts) is derived by the
 * document's projection on read, so stored content needs no
 * pre-normalization.
 */
import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';
import type { TextOperations } from '$lib/text/text.utils.js';
import type { Flow, FlowTarget } from '$lib/crdt/flow.js';
import type { Plan, Prepared } from '$lib/crdt/edytor-doc.js';
import { REFUSED } from '$lib/crdt/doc/plan.js';
import type { DataPatch } from '$lib/crdt/data.js';
import type { ResolvedAt } from '$lib/session/suggestions.svelte.js';
import { id } from '$lib/utils.js';
import {
	cloneJson,
	jsonBlockToSpec,
	jsonContentToItems,
	type JSONBlock,
	type JSONInlineBlock
} from '$lib/utils/json.js';
import { InlineBlock } from './inlineBlock.svelte.js';

/** A move beside `target`, to its `side` (`prepare.placeBeside`, `layout.place-beside`). */
export type BlockBeside = { target: Block; side: 'left' | 'right' };

export type BlockOperations = {
	removeInlineBlock: {
		index: number;
	};
	/**
	 * Patch the block's `data` (with `atom`, that inline atom's; on the root,
	 * the document's), in order: each patch sets the value at its path, or
	 * deletes it when it has no `value`. `block.data`'s proxy, `setData` and
	 * `atom.setData` issue it.
	 */
	patchData: {
		ops: DataPatch[];
		atom?: string;
	};
	addChildBlock: {
		block: JSONBlock;
		index: number;
	};
	addChildBlocks: {
		blocks: JSONBlock[];
		index: number;
	};
	insertBlockAfter: {
		block: JSONBlock;
	};
	insertBlockBefore: {
		block: JSONBlock;
	};
	splitBlock: {
		index: number;
		text: Text;
	};
	/** A copy of the block and its subtree right after it, under fresh ids. */
	duplicateBlock: {};
	/** The children take the block's slot unless `keepChildren: false` (the whole subtree). */
	removeBlock: {
		keepChildren?: boolean;
	};
	unNestBlock: {};
	mergeBlockBackward: {};
	mergeBlockForward: {};
	nestBlock: {};
	setBlock: {
		value: Partial<JSONBlock>;
	};
	addInlineBlock: {
		index: number;
		block: JSONInlineBlock;
		text: Text;
	};
	/** `beside`: placed beside a target (`left`/`right` moves); `path` is then the target's. */
	moveBlock: {
		path: number[];
		beside?: BlockBeside;
	};
	moveBlocks: {
		blocks: Block[];
		path: number[];
		beside?: BlockBeside;
	};
	pushContentIntoBlock: {
		value: (Text | InlineBlock)[];
	};
	normalizeContent: {};
	normalizeChildren: {};
	/** A suggestion placed in the document (`edytor.suggestions`, `suggestion.accept()`). */
	acceptSuggestion: {
		suggestion: { id: string; at: ResolvedAt; content: readonly JSONBlock[] };
	};
	/**
	 * Find and replace (`plugins/find`): each match's text replaced by
	 * `replacement`, one plan, one undo step (its steps: a
	 * `deleteContentAtRange` and an `insertText` per match).
	 */
	replaceMatches: {
		matches: { block: string; offset: number; length: number }[];
		replacement: string;
	};
	/**
	 * A comment thread's anchor (`plugins/comments`): its `comment:<thread>`
	 * mark over each run of the text it was made on, one plan, one undo step
	 * (its steps: a `formatRange` per run).
	 */
	addComment: {
		thread: string;
		runs: { block: string; offset: number; length: number }[];
	};
	deleteContentAtRange: {
		start: [number, number];
		end: [number, number];
	};
	deleteContentWithinSelection: {
		replace?: boolean;
	};
	insertFlow: { flow: Flow; target: FlowTarget };
	/**
	 * A text range dragged inside the editor and dropped at `to` (block
	 * offsets): its content placed at `to`, then the range deleted — or,
	 * with `copy` (Alt), only placed. Both are prepared before any write:
	 * hooks see the placement's planned steps and the deletion's, and a
	 * veto or a refusal of either writes nothing.
	 */
	moveText: {
		from: { start: { block: string; offset: number }; end: { block: string; offset: number } };
		to: { block: string; offset: number };
		copy: boolean;
	};
	deleteBlocks: { blocks: Block[] };
	/** Wrap sibling blocks in a new layout of `kind` and `columns` items, one block per item (`layout.wrap`). */
	wrapBlocks: { blocks: Block[]; kind?: string; columns?: number };
	/** A divider at the caret: its steps are the conversion, insertion or split it plans. */
	insertDivider: {};
	/** A table's row at `index`, one empty cell per column (`table.insert-row`). */
	insertTableRow: { index: number };
	/** A table's rows, with their cells (`table.delete-row`). */
	deleteTableRows: { rows: Block[] };
	/** A table's column at `index`, an empty cell in every row (`table.insert-column`). */
	insertTableColumn: { index: number; width?: number };
	/** A table's column, by id or position, with its cells (`table.delete-column`). */
	deleteTableColumn: { column: string | number };
	/** A table's column moved to position `to` (`table.move-column`). */
	moveTableColumn: { column: string | number; to: number };
	/** A table's rows moved to position `to` among its rows (`table.move-row`). */
	moveTableRows: { rows: Block[]; to: number };
	/** The cell a row shows none of in `column`, created (`table.pad`). */
	fillTableCell: { row: string; column: string | number };
};

/**
 * Bind an operation onto its wrapper: every call is dispatched as a command
 * (`session/commands.ts`): admission, hooks before any write, one
 * transaction, normalization, the result. `func` answers the op's document
 * result; `resolve` turns it into wrappers after the commit patched them.
 */
export function batch<
	T extends (...args: any[]) => any,
	O extends keyof BlockOperations,
	R = ReturnType<T>
>(
	operation: O,
	func: T,
	resolve?: (this: any, out: ReturnType<T> | undefined, payload: Parameters<T>[0]) => R
): (...args: PayloadOf<Parameters<T>>) => R {
	const body = function (this: Block, _: unknown, payload: unknown) {
		return func.call(this, payload);
	};
	return planned<Block, [unknown], ReturnType<T>, R>(operation, undefined, body, resolve) as (
		...args: PayloadOf<Parameters<T>>
	) => R;
}

/** What a wrapper's command is about: a text segment's, its block (`ChangePayload`'s text arm). */
const contextOf = (self: Block | Text | Edytor) =>
	'ordinal' in self ? { block: self.parent, text: self } : { block: self };

/**
 * Bind an operation that is one document plan onto its wrapper (a block, a
 * text segment or the view): `prepare` answers the plan, so hooks see the
 * command and each planned step before any write; `apply` writes it in the
 * command's one transaction (a step of a running command prepares it there)
 * and answers the op's document result, which `resolve` turns into wrappers
 * after the commit patched them. A plan refused at preparation is still
 * applied (writing nothing): `apply` answers its refusal.
 */
export function planned<S extends Block | Text | Edytor, A extends unknown[], X, R = X>(
	operation: keyof BlockOperations | keyof TextOperations,
	prepare: ((this: S, ...payload: A) => Prepared) | undefined,
	apply: (this: S, plan: Prepared, payload: A[0]) => X,
	resolve?: (this: S, out: X | undefined, payload: A[0]) => R
): (...args: PayloadOf<A>) => R {
	return function (this: S, ...[payload]: PayloadOf<A>): R {
		const { dispatcher } = this.edytor;
		const plan = prepare && ((p: A[0]) => prepare.call(this, ...([p] as A)));
		const out = dispatcher.dispatch<A[0], X>(
			operation,
			payload,
			contextOf(this),
			(p, prepared = plan?.(p)) => apply.call(this, prepared!, p),
			plan
		);
		return dispatcher.answer(resolve ? resolve.call(this, out, payload) : (out as R));
	};
}

/**
 * A mutator's public parameters: its payload alone (optional when the op's
 * is). The plan the dispatcher passes the op is not the caller's.
 */
export type PayloadOf<A extends unknown[]> = A extends []
	? []
	: A extends [infer P, ...unknown[]]
		? [payload: P]
		: A extends [(infer P)?, ...unknown[]]
			? [payload?: P]
			: [];

/**
 * The handle of block `id` (null: refused at preparation, or gone; undefined:
 * the command did not run). Inside an outer transaction too: the index shows
 * the block that transaction created.
 */
export function blockOf(this: Block, id: string | null | undefined): Block | null | undefined {
	return id === undefined ? undefined : (id && this.edytor.idToBlock.get(id)) || null;
}

/**
 * An op's body over its prepared plan: write it and request normalization of
 * the blocks it touched (captured before the write). Answers the applied
 * plan, or null when it was refused.
 */
const applyPlan = (block: Block, plan: Prepared, touched: (Block | null | undefined)[]) => {
	if (!('writes' in plan)) return null;
	block.edytor.facade.apply(plan);
	for (const parent of touched) parent?.normalizeChildren();
	return plan;
};

/** The document's name for `block`'s child list: `null` for the root. */
const ref = (block: Block) => (block.isRoot ? null : block.id);

/**
 * Dispatch `operation` on `block` as the one plan `prepare` answers (a
 * composed command: hooks see it and each planned step, one transaction).
 * `then` runs in that transaction once the plan applied, with the payload
 * hooks left. Answers the applied plan, or null when refused.
 */
export const dispatchPlan = <O extends keyof BlockOperations>(
	block: Block,
	operation: O,
	payload: BlockOperations[O],
	prepare: (payload: BlockOperations[O]) => Prepared,
	touched: (Block | null | undefined)[] = [block.parent],
	then?: (payload: BlockOperations[O]) => void
): Plan | null =>
	block.edytor.dispatcher.dispatch(
		operation,
		payload,
		{ block },
		(p, plan = prepare(p)) => {
			const applied = applyPlan(block, plan, touched);
			if (applied) then?.(p);
			return applied;
		},
		prepare
	) ?? null;

/** One child at `index` (a default-kind block without `block`); see {@link addChildBlocks}. */
export function addChildBlock(this: Block, { block, index }: BlockOperations['addChildBlock']) {
	const blocks = [block || { type: this.edytor.defaultChild(this) }];
	return addChildBlocks.call(this, { blocks, index })[0]!;
}

/** Children at `index`, clamped to the child list (at its end by default); ids kept or minted. */
export function addChildBlocks(
	this: Block,
	{ blocks, index = this.children.length }: BlockOperations['addChildBlocks']
) {
	index = Math.max(0, Math.min(index, this.children.length));
	const specs = blocks.map((block) => ({ ...block, id: block.id ?? id('b') }));
	this.insertChildren(index, specs);
	this.normalizeChildren();
	return specs.map((spec) => this.edytor.idToBlock.block(spec.id));
}

/** Insert `block` as a sibling of `this`, `after` it or before it. */
const prepareSibling = (self: Block, block: JSONBlock, after: boolean): Prepared =>
	self.parent
		? self.edytor.facade.prepare.insertBlocks(
				{ parent: ref(self.parent), index: self.index + (after ? 1 : 0) },
				[jsonBlockToSpec(block)]
			)
		: REFUSED;

export function prepareInsertAfter(this: Block, { block }: BlockOperations['insertBlockAfter']) {
	return prepareSibling(this, block, true);
}

export function prepareInsertBefore(this: Block, { block }: BlockOperations['insertBlockBefore']) {
	return prepareSibling(this, block, false);
}

/** The blocks whose child lists an op's write normalizes. */
type Touched = (Block | null | undefined)[];

/**
 * An op's write: apply its plan, normalizing the child lists of the blocks
 * `touched` names (read before the write; default: the block's parent), then
 * answer what `answer` reads of the applied plan (`null`: refused).
 */
const writes = <X, P = unknown>(
	answer: (this: Block, plan: Plan | null, payload: P) => X,
	touched: (block: Block, payload: P) => Touched = (block) => [block.parent]
) =>
	function (this: Block, plan: Prepared, payload: P): X {
		return answer.call(this, applyPlan(this, plan, touched(this, payload)), payload);
	};
const none = (): Touched => [];
/** The handle itself once the plan applied. */
function self(this: Block, plan: Plan | null): Block | null {
	return plan ? this : null;
}

/** The id the plan answers first (inserted or surviving). */
export const firstId = writes((plan) => plan?.ids[0] ?? null);
/** The block the plan created (a split's tail). */
export const createdId = writes((plan) => plan?.effect.creates[0] ?? null);
export const written = writes(() => {});
/** Normalizing no child list; the block's content once written. */
export const contentWritten = writes(function (plan) {
	if (plan) this.normalizeContent();
}, none);
/** A data patch: nothing normalized. */
export const patched = writes(() => {}, none);

export function prepareDuplicate(this: Block, _: BlockOperations['duplicateBlock'] = {}) {
	return this.edytor.facade.prepare.duplicateBlock(this.id, (_, kind) =>
		id(kind === 'block' ? 'b' : 'i')
	);
}

/** A kind's fresh data: its first preset's (a new to-do is unchecked). */
export const freshData = (block: Block): NonNullable<JSONBlock['data']> => ({
	...(block.definition.presets?.[0]?.data ?? {})
});

/**
 * The line Enter starts after `block` (a split's tail, a new sibling): a
 * list-like kind (`continues`) itself, with fresh data; any other, its
 * parent's default child.
 */
export const nextLine = (block: Block): JSONBlock =>
	block.definition.continues
		? { type: block.type, data: freshData(block) }
		: { type: block.edytor.defaultChild(block.parent!) };

export function prepareSplit(this: Block, { index, text }: BlockOperations['splitBlock']) {
	if (!text || !this.parent) return REFUSED;
	const { type, data = {} } = nextLine(this);
	const offset = text.segStart + index;
	return this.edytor.facade.prepare.splitBlock(this.id, offset, id('b'), { type, data });
}

/**
 * A split whose children stay with the block (a container's header): the
 * tail, of `tail`'s kind, becomes the block's first child (`child`) or its
 * next sibling. One plan: the document's split step, placed here, without
 * the move that gives the tail the children.
 */
export function prepareSplitKeepingChildren(
	this: Block,
	{ index, text }: BlockOperations['splitBlock'],
	tail: { type: string; data?: Record<string, unknown> },
	child: boolean
): Prepared {
	if (!text || !this.parent) return REFUSED;
	const { facade } = this.edytor;
	const born = id('b');
	const split = facade.prepare.splitBlock(this.id, text.segStart + index, born, tail);
	const step = 'writes' in split ? split.writes[0] : undefined;
	if (step?.op !== 'splitBlock') return REFUSED;
	if (!child) return facade.compose({ ...(split as Plan), writes: [step] });
	// The rank of a first child, and the document's answer on placing the kind there.
	const slot = facade.prepare.insertBlocks({ parent: this.id, index: 0 }, [
		{ id: born, type: tail.type }
	]);
	const first = 'writes' in slot ? slot.writes[0] : undefined;
	if (first?.op !== 'insertBlocks') return REFUSED;
	const placed = { ...step, parent: this.id, rank: first.ranks[0]! };
	return facade.compose({ ...(split as Plan), writes: [placed] });
}

export function prepareRemove(
	this: Block,
	{ keepChildren = true }: BlockOperations['removeBlock'] = {}
) {
	if (!this.parent) return REFUSED;
	return this.edytor.facade.prepare.deleteBlock(this.id, { keepChildren });
}

export function prepareMergeBackward(this: Block, _: BlockOperations['mergeBlockBackward'] = {}) {
	return this.parent ? this.edytor.facade.prepare.mergeBackward(this.id) : REFUSED;
}

export function prepareMergeForward(this: Block, _: BlockOperations['mergeBlockForward'] = {}) {
	return this.parent ? this.edytor.facade.prepare.mergeForward(this.id) : REFUSED;
}

/** The destination parent a view-tree path (`[...parentPath, index]`) names. */
const parentAt = (edytor: Block['edytor'], path: number[]): [Block | undefined, number] => {
	let parent: Block | undefined = edytor.root!;
	for (const index of path.slice(0, -1)) parent = parent?.children[index];
	return [parent, path.at(-1)!];
};

export function prepareMove(this: Block, { path }: BlockOperations['moveBlock']) {
	// Admission: the caller path is a view-tree address — validate its shape
	// and resolve it to the destination PARENT block + index. Structural
	// permission is the document's (`canPlace`: island seals, void/island
	// destinations, moves into the block's own subtree).
	if (!path.length || path.some((p) => isNaN(p) || p < 0) || !this.parent) return REFUSED;
	const [parent, index] = parentAt(this.edytor, path);
	if (!parent) return REFUSED;
	return this.edytor.facade.prepare.moveBlock(this.id, { parent: ref(parent), index });
}

export const moveBlock = writes(
	self,
	(block, { path }: BlockOperations['moveBlock']): Touched => [
		block.parent,
		parentAt(block.edytor, path)[0]
	]
);

/**
 * Grouped move — the operation-layer counterpart of `moveBlock` for
 * drags/multi-moves. `path` is the same view-tree address shape:
 * the prefix resolves the destination PARENT block, the last element is
 * the FINAL index — already discounted for the moved members by the
 * caller (the `facade.moveBlocks` contract, which counts the
 * destination's children with the moved members excluded). Structural
 * permission stays in the facade.
 */
export function prepareMoves(this: Block, { blocks, path }: BlockOperations['moveBlocks']) {
	if (!path.length || path.some((p) => isNaN(p) || p < 0) || !blocks.length) return REFUSED;
	const [parent, index] = parentAt(this.edytor, path);
	if (!parent || blocks.some((block) => block.isRoot)) return REFUSED;
	return this.edytor.facade.prepare.moveBlocks(
		blocks.map((block) => block.id),
		{ parent: ref(parent), index }
	);
}

export const moveBlocks = writes(
	(plan, { blocks }: BlockOperations['moveBlocks']): Block[] => (plan ? blocks : []),
	(block, { blocks, path }): Touched => [
		...new Set([...blocks.map((block) => block.parent), parentAt(block.edytor, path)[0]])
	]
);

/**
 * The facade owns the refusal rules (`unNestBlock`: a block shown nowhere,
 * top-level blocks, island-sealed blocks and sealed destinations).
 */
export function prepareUnNest(this: Block, _: BlockOperations['unNestBlock'] = {}) {
	return this.edytor.facade.prepare.unNestBlock(this.id);
}

export const unNestBlock = writes(
	self,
	(block): Touched => [block.parent, block.parent?.parent, block]
);

/**
 * Admission resolves the nest target — the previous sibling — and the
 * facade owns permission: `nestBlock` refuses void/island/inside-island
 * targets and island-sealed sources (`canPlace`).
 */
export function prepareNest(this: Block, _: BlockOperations['nestBlock'] = {}) {
	const target = this.previousBlock?.id;
	return target != null ? this.edytor.facade.prepare.nestBlock(this.id, target) : REFUSED;
}

export const nestBlock = writes(self, (block): Touched => [block.parent, block.previousBlock]);

/** The document refuses the root and a dead block (`setBlock`: not live). */
export function prepareSet(this: Block, { value }: BlockOperations['setBlock']) {
	// Spec preparation is pure JSON → `ContentItem`/`BlockSpec` conversion:
	// the document stores the items verbatim and derives the content
	// invariant on projection.
	return this.edytor.facade.prepare.setBlock(this.id, {
		...(value.type !== undefined ? { type: value.type } : {}),
		...(value.data !== undefined ? { data: cloneJson(value.data) } : {}),
		...(value.content !== undefined ? { content: jsonContentToItems(value.content) } : {}),
		...(value.children !== undefined
			? { children: value.children.map((child) => jsonBlockToSpec(child)) }
			: {})
	});
}

export const setBlock = writes(
	function (plan) {
		if (plan) this.normalizeContent();
	},
	(block): Touched => [block]
);

export function pushContentIntoBlock(
	this: Block,
	{ value }: BlockOperations['pushContentIntoBlock']
) {
	const model = this.model;
	if (!model) return;
	for (const part of value) {
		if (part instanceof InlineBlock) {
			const { id, type, data } = part;
			model.insertInline(model.length, { id, type, ...(data ? { data: cloneJson(data) } : {}) });
		} else {
			for (const { text, marks } of part.value)
				if (text.length) model.insertText(model.length, text, marks as Record<string, unknown>);
		}
	}
	this.normalizeContent();
}

export function prepareRemoveInline(this: Block, { index }: BlockOperations['removeInlineBlock']) {
	const part = this.content.at(index);
	return part instanceof InlineBlock
		? this.edytor.facade.prepare.removeInline(this.id, part.id)
		: REFUSED;
}

export function preparePatch(this: Block, { ops, atom }: BlockOperations['patchData']) {
	const target = this.isRoot ? null : atom === undefined ? this.id : { block: this.id, atom };
	return this.edytor.facade.prepare.patchData(target, ops);
}

/**
 * Insert an inline atom at `index` of `text`. Answers the atom's id; the
 * batched operation resolves it to the text after the atom once committed
 * ({@link textAfterAtom}), where the caret's pending marks follow.
 */
export function addInlineBlock(
	this: Block,
	{ index, block, text }: BlockOperations['addInlineBlock']
): string {
	const atom = { ...block, id: block.id ?? id('i') };
	this.model?.insertInline(text.segStart + index, {
		id: atom.id,
		type: atom.type,
		...(atom.data ? { data: cloneJson(atom.data) } : {})
	});
	this.normalizeContent();
	return atom.id;
}

/** The text after atom `atom` of this block; the caret's pending marks follow it there. */
export function textAfterAtom(this: Block, atom: string | undefined): Text | null | undefined {
	if (atom === undefined) return undefined;
	const at = this.content.findIndex((part) => part.id === atom);
	const after = at < 0 ? undefined : this.content[at + 1];
	if (!after || after instanceof InlineBlock) return null;
	const { selection } = this.edytor;
	const pending = selection.pending;
	const caret = pending && selection.textValue(after, 0);
	if (caret && caret.kind === 'text') selection.select(Object.freeze({ ...caret, pending }));
	return after;
}

/**
 * Normalization runs at the end of the command's transaction
 * (`Dispatcher.drain`): a normalizer reads handles over the index; when a
 * plugin hook answers work, the work runs in the same transaction and the
 * block is requested again (bounded by the dispatcher's pass limit). The
 * v14 content model maintains the part invariants by construction, so the
 * only normalization left is the kind's hook; an emptied root writes nothing
 * (the view shows its virtual paragraph, `doc.empty.virtual`).
 */
const normalizer = (hook: 'normalizeContent' | 'normalizeChildren') =>
	function normalize(this: Block): void {
		if (this.edytor.dispatcher.defer(this, normalize)) return;
		const work = this.definition[hook]?.({ block: this });
		if (work) {
			this.edytor.dispatcher.write(work);
			this[hook]();
		}
	};
export const normalizeContent = normalizer('normalizeContent');
export const normalizeChildren = normalizer('normalizeChildren');

export function prepareDeleteRange(
	this: Block,
	{
		start: [startIndex, startOffset],
		end: [endIndex, endOffset]
	}: BlockOperations['deleteContentAtRange']
) {
	const parts = this.edytor.idToBlock.parts(this.id);
	const [startPart, endPart] = [parts.at(startIndex), parts.at(endIndex)];
	if (!startPart || !endPart) return REFUSED;
	const at = startPart.start + startOffset;
	const length = Math.max(0, endPart.start + endOffset - at);
	return this.edytor.facade.prepare.deleteText(this.id, at, length);
}
