/**
 * View-side command adapter for block operations (U2 delegation contract).
 *
 * These functions are the `BlockOperations` layer bound onto `Block` via
 * `batch()`, which dispatches each call as a command (admission, plugin
 * interception, one transaction: `session/commands.ts`). The functions own
 * path/offset resolution (target paths → parent blocks, a text's `segStart`,
 * sibling lookup for `nestBlock`), the plan of an operation
 * that is one document op (`prepare*`) and its normalization requests.
 *
 * OPERATIONS READ AND WRITE ONLY THE DOCUMENT (R3): `Block`/`Text` are id-only
 * handles whose getters read the index (R4), so what a caller needs after the
 * write (the new block, the text after an inserted atom, the caret a range op
 * decided) is the op's document result as a handle (`batch`'s `resolve`) —
 * inside an outer transaction too.
 *
 * STRUCTURAL PERMISSION IS DOCUMENT-OWNED: every op delegates to
 * `block.model.*` (the facade through `DocBlock`) and treats a `refused` result
 * as "refused" — no view-side re-checks of the rules the document already
 * enforces (island sealing, void/island destinations, own-subtree moves,
 * merges across island boundaries; see `edytor-doc.ts` `canPlace` and
 * `canMerge`, R5). Removing a view-side semantic guard must never
 * change document behavior — if a rule matters here it belongs in the
 * facade, not in this file.
 *
 * Content preparation produces `BlockSpec`/`ContentItem` DIRECTLY from
 * JSON (`jsonBlockToSpec`/`jsonContentToItems` in `utils/json.ts`): specs are
 * data (K5: `new Block({block})` is gone). The live-content invariant
 * (text-first/text-last, no adjacent same-kind parts) is derived by the
 * document's projection on read, so stored content needs no
 * pre-normalization.
 */
import type { Block } from '$lib/block/block.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { ChangePayload } from '$lib/plugins.js';
import type { Flow, FlowTarget } from '$lib/crdt/flow.js';
import type { Plan, Prepared } from '$lib/crdt/edytor-doc.js';
import { id } from '$lib/utils.js';
import {
	cloneJson,
	jsonBlockToSpec,
	jsonContentToItems,
	type JSONBlock,
	type JSONInlineBlock,
	type JSONText
} from '$lib/utils/json.js';
import { InlineBlock } from './inlineBlock.svelte.js';

export type BlockOperations = {
	removeInlineBlock: {
		index: number;
	};
	/** Replace the `data` of inline atom `id` shown in the block. */
	setInlineData: {
		id: string;
		data: Record<string, unknown>;
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
	moveBlock: {
		path: number[];
	};
	moveBlocks: {
		blocks: Block[];
		path: number[];
	};
	pushContentIntoBlock: {
		value: (Text | InlineBlock)[];
	};
	normalizeContent: {};
	normalizeChildren: {};
	suggestText: {
		value: (JSONText | JSONInlineBlock)[] | string | null;
	};
	acceptSuggestedText: {};
	deleteContentAtRange: {
		start: [number, number];
		end: [number, number];
	};
	deleteContentWithinSelection: {
		replace?: boolean;
	};
	insertFlow: { flow: Flow; target: FlowTarget };
	deleteBlocks: { blocks: Block[] };
	/** A divider at the caret: its steps are the conversion, insertion or split it plans. */
	insertDivider: {};
};

/**
 * Bind an operation onto its wrapper: every call is dispatched as a command
 * (`session/commands.ts`): admission, hooks before any write (on the command
 * and, when `prepare` answers one document plan, on each planned step), one
 * transaction, normalization, the result. `func` receives the prepared plan
 * and answers the op's document result; `resolve` turns it into wrappers
 * after the commit patched them.
 */
export function batch<
	T extends (...args: any[]) => any,
	O extends keyof BlockOperations,
	R = ReturnType<T>
>(
	operation: O,
	func: T,
	prepare?: (payload: BlockOperations[O]) => Prepared,
	resolve?: (this: any, out: ReturnType<T> | undefined, payload: Parameters<T>[0]) => R
): (...args: Parameters<T>) => R {
	return function (this: Block, ...[payload]: Parameters<T>): R {
		const out = this.edytor.dispatcher.dispatch(
			operation,
			payload,
			{ block: this },
			(p, plan) => func.call(this, p, plan),
			prepare && ((p) => prepare.call(this, p))
		);
		return resolve ? resolve.call(this, out, payload) : (out as R);
	};
}

/**
 * The handle of block `id` (null: refused at preparation, or gone; undefined:
 * the command did not run). Inside an outer transaction too: the index shows
 * the block that transaction created.
 */
export function blockOf(this: Block, id: string | null | undefined): Block | null | undefined {
	return id === undefined ? undefined : (id && this.edytor.idToBlock.get(id)) || null;
}

const REFUSED: Prepared = { status: 'refused', ids: [] };

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
 * Answers the applied plan, or null when refused.
 */
export const dispatchPlan = <O extends keyof BlockOperations>(
	block: Block,
	operation: O,
	payload: BlockOperations[O],
	prepare: (payload: BlockOperations[O]) => Prepared,
	touched: (Block | null | undefined)[] = [block.parent]
): Plan | null =>
	block.edytor.dispatcher.dispatch(
		operation,
		payload,
		{ block },
		(p, plan = prepare(p)) => applyPlan(block, plan, touched),
		prepare
	) ?? null;

export function addChildBlock(
	this: Block,
	{ block, index = this.children.length }: BlockOperations['addChildBlock']
) {
	if (index < 0) {
		index = 0;
	} else if (index > this.children.length) {
		index = this.children.length;
	}
	const spec = { ...(block || { type: this.edytor.defaultChild(this) }), id: block?.id ?? id('b') };
	this.insertChildren(index, [spec]);
	this.normalizeChildren();
	return this.edytor.idToBlock.block(spec.id);
}

export function addChildBlocks(
	this: Block,
	{ blocks, index = this.children.length }: BlockOperations['addChildBlocks']
) {
	if (index < 0) {
		index = 0;
	} else if (index > this.children.length) {
		index = this.children.length;
	}
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

export function prepareInsertAfter(this: Block, { block }: { block: JSONBlock }) {
	return prepareSibling(this, block, true);
}

export function prepareInsertBefore(this: Block, { block }: { block: JSONBlock }) {
	return prepareSibling(this, block, false);
}

/** Apply `plan` under `this`'s parent; the id it answers first (inserted or surviving). */
function resultOf(this: Block, plan: Prepared): string | null {
	return applyPlan(this, plan, [this.parent])?.ids[0] ?? null;
}

export function insertBlockAfter(
	this: Block,
	payload: BlockOperations['insertBlockAfter'],
	plan = prepareInsertAfter.call(this, payload)
): string | null {
	return resultOf.call(this, plan);
}

export function insertBlockBefore(
	this: Block,
	payload: BlockOperations['insertBlockBefore'],
	plan = prepareInsertBefore.call(this, payload)
): string | null {
	return resultOf.call(this, plan);
}

export function prepareDuplicate(this: Block) {
	if (!this.parent || !this.isInTree) return REFUSED;
	return this.edytor.facade.prepare.duplicateBlock(this.id, (_, kind) =>
		id(kind === 'block' ? 'b' : 'i')
	);
}

export function duplicateBlock(
	this: Block,
	_: BlockOperations['duplicateBlock'] = {},
	plan = prepareDuplicate.call(this)
): string | null {
	return resultOf.call(this, plan);
}

export function prepareSplit(this: Block, { index, text }: BlockOperations['splitBlock']) {
	if (!text || !this.parent || !this.model) return REFUSED;
	// G5: the sibling takes its parent's default child type and no data — a
	// list-like kind (`continues`) keeps its own, with its first preset's data.
	const { continues, presets } = this.definition;
	const tail = continues
		? { type: this.type, data: { ...(presets?.[0]?.data ?? {}) } }
		: { type: this.edytor.defaultChild(this.parent), data: {} };
	const offset = text.segStart + index;
	return this.edytor.facade.prepare.splitBlock(this.model.id, offset, id('b'), tail);
}

export function splitBlock(
	this: Block,
	payload: BlockOperations['splitBlock'],
	plan = prepareSplit.call(this, payload)
): string | null {
	return applyPlan(this, plan, [this.parent])?.effect.creates[0] ?? null;
}

export function prepareRemove(
	this: Block,
	{ keepChildren = true }: { keepChildren?: boolean } = {}
) {
	if (!this.parent || !this.model || !this.isInTree) return REFUSED;
	return this.edytor.facade.prepare.deleteBlock(this.model.id, { keepChildren });
}

export function removeBlock(
	this: Block,
	payload: BlockOperations['removeBlock'] = {},
	plan = prepareRemove.call(this, payload)
) {
	applyPlan(this, plan, [this.parent]);
}

export function prepareMergeBackward(this: Block) {
	return this.parent && this.model
		? this.edytor.facade.prepare.mergeBackward(this.model.id)
		: REFUSED;
}

export function prepareMergeForward(this: Block) {
	return this.parent && this.model
		? this.edytor.facade.prepare.mergeForward(this.model.id)
		: REFUSED;
}

export function mergeBlockBackward(
	this: Block,
	_: BlockOperations['mergeBlockBackward'] = {},
	plan = prepareMergeBackward.call(this)
): string | null {
	return resultOf.call(this, plan);
}

export function mergeBlockForward(
	this: Block,
	_: BlockOperations['mergeBlockForward'] = {},
	plan = prepareMergeForward.call(this)
): string | null {
	return resultOf.call(this, plan);
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
	if (!parent || !this.model) return REFUSED;
	return this.edytor.facade.prepare.moveBlock(this.model.id, { parent: ref(parent), index });
}

export function moveBlock(
	this: Block,
	payload: BlockOperations['moveBlock'],
	plan = prepareMove.call(this, payload)
): Block | null {
	return applyPlan(this, plan, [this.parent, parentAt(this.edytor, payload.path)[0]]) ? this : null;
}

/**
 * Grouped move — the operation-layer counterpart of `moveBlock` for
 * drags/multi-moves (D5). `path` is the same view-tree address shape:
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

export function moveBlocks(
	this: Block,
	payload: BlockOperations['moveBlocks'],
	plan = prepareMoves.call(this, payload)
): Block[] {
	const { blocks, path } = payload;
	const parents = new Set([...blocks.map((block) => block.parent), parentAt(this.edytor, path)[0]]);
	return applyPlan(this, plan, [...parents]) ? blocks : [];
}

/**
 * The facade owns the refusal rules (`unNestBlock`: top-level blocks,
 * island-sealed blocks and sealed destinations).
 */
export function prepareUnNest(this: Block) {
	return this.parent && this.model
		? this.edytor.facade.prepare.unNestBlock(this.model.id)
		: REFUSED;
}

export function unNestBlock(
	this: Block,
	_: BlockOperations['unNestBlock'] = {},
	plan = prepareUnNest.call(this)
): Block | null {
	return applyPlan(this, plan, [this.parent, this.parent?.parent, this]) ? this : null;
}

/**
 * Admission resolves the nest target — the previous sibling — and the
 * facade owns permission: `nestBlock` refuses void/island/inside-island
 * targets and island-sealed sources (`canPlace`).
 */
export function prepareNest(this: Block) {
	const target = this.previousBlock?.id;
	return this.parent && this.model && target != null
		? this.edytor.facade.prepare.nestBlock(this.model.id, target)
		: REFUSED;
}

export function nestBlock(
	this: Block,
	_: BlockOperations['nestBlock'] = {},
	plan = prepareNest.call(this)
): Block | null {
	return applyPlan(this, plan, [this.parent, this.previousBlock]) ? this : null;
}

export function prepareSet(this: Block, { value }: BlockOperations['setBlock']) {
	if (!this.model) return REFUSED;
	// Spec preparation is pure JSON → `ContentItem`/`BlockSpec` conversion:
	// the document stores the items verbatim and derives the content
	// invariant on projection.
	return this.edytor.facade.prepare.setBlock(this.model.id, {
		...(value.type !== undefined ? { type: value.type } : {}),
		...(value.data !== undefined ? { data: cloneJson(value.data) } : {}),
		...(value.content !== undefined ? { content: jsonContentToItems(value.content) } : {}),
		...(value.children !== undefined
			? { children: value.children.map((child) => jsonBlockToSpec(child)) }
			: {})
	});
}

export function setBlock(
	this: Block,
	payload: BlockOperations['setBlock'],
	plan = prepareSet.call(this, payload)
) {
	if (!applyPlan(this, plan, [this])) return;
	this.normalizeContent();
}

export function pushContentIntoBlock(
	this: Block,
	{ value }: BlockOperations['pushContentIntoBlock']
) {
	const model = this.model;
	if (!model) {
		return;
	}
	for (const part of value) {
		const offset = model.length;
		if (part instanceof InlineBlock) {
			model.insertInline(offset, {
				id: part.id,
				type: part.type,
				...(part.data ? { data: cloneJson(part.data) } : {})
			});
		} else {
			for (const item of part.value) {
				const at = model.length;
				if (item.text.length) {
					model.insertText(at, item.text, item.marks as Record<string, unknown>);
				}
			}
		}
	}
	this.normalizeContent();
}

export function prepareRemoveInline(this: Block, { index }: { index: number }) {
	const part = this.content.at(index);
	return part instanceof InlineBlock && this.model
		? this.edytor.facade.prepare.removeInline(this.model.id, part.id)
		: REFUSED;
}

export function removeInlineBlock(
	this: Block,
	payload: BlockOperations['removeInlineBlock'],
	plan = prepareRemoveInline.call(this, payload)
): void {
	if (applyPlan(this, plan, [])) this.normalizeContent();
}

export function prepareSetInline(this: Block, { id, data }: BlockOperations['setInlineData']) {
	return this.model ? this.edytor.facade.prepare.setInlineData(this.model.id, id, data) : REFUSED;
}

export function setInlineData(
	this: Block,
	payload: BlockOperations['setInlineData'],
	plan = prepareSetInline.call(this, payload)
): void {
	applyPlan(this, plan, []);
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

/** The text after atom `atom` of this block; the caret's pending marks follow it there (L4). */
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
 * block is requested again (bounded by the dispatcher's pass limit, D25).
 */
export function normalizeContent(this: Block): void {
	if (this.edytor.dispatcher.defer(this, normalizeContent)) return;
	// The v14 content model maintains the part invariants by construction —
	// projected content always derives to text-first/text-last/non-adjacent
	// parts — so the only remaining normalization is the plugin hook.
	const work = this.definition?.normalizeContent?.({ block: this });
	if (work) {
		this.edytor.dispatcher.write(work);
		this.normalizeContent();
	}
}

export function normalizeChildren(this: Block): void {
	if (this.edytor.dispatcher.defer(this, normalizeChildren)) return;
	// An emptied root writes nothing: the view shows its virtual paragraph (`doc.empty.virtual`).
	const work = this.definition?.normalizeChildren?.({ block: this });
	if (work) {
		this.edytor.dispatcher.write(work);
		this.normalizeChildren();
	}
}

export function suggestText(this: Block, { value }: BlockOperations['suggestText']) {
	if (typeof value === 'string') {
		this.suggestions = [[{ text: value }]];
	} else if (value) {
		// Runs of text group into one ghost text; an atom stands alone.
		this.suggestions = value.reduce(
			(parts, part) => {
				const last = parts.at(-1);
				if ('type' in part) parts.push(part);
				else if (Array.isArray(last)) last.push(part);
				else parts.push([part]);
				return parts;
			},
			[] as (JSONText[] | JSONInlineBlock)[]
		);
	} else {
		this.suggestions = null;
	}
}

export function acceptSuggestedText(this: Block) {
	const suggestions = this.suggestions;
	if (!suggestions) {
		return;
	}
	this.insertParts(this.content.length, suggestions);

	this.suggestions = null;
	this.normalizeContent();
}

export function prepareDeleteRange(
	this: Block,
	{
		start: [startIndex, startOffset],
		end: [endIndex, endOffset]
	}: { start: number[]; end: number[] }
) {
	const parts = this.edytor.idToBlock.parts(this.id);
	const [startPart, endPart] = [parts.at(startIndex!), parts.at(endIndex!)];
	if (!startPart || !endPart || !this.model) return REFUSED;
	const at = startPart.start + startOffset!;
	const length = Math.max(0, endPart.start + endOffset! - at);
	return this.edytor.facade.prepare.deleteText(this.model.id, at, length);
}

export function deleteContentAtRange(
	this: Block,
	payload: BlockOperations['deleteContentAtRange'],
	plan = prepareDeleteRange.call(this, payload)
) {
	if (applyPlan(this, plan, [])) this.normalizeContent();
}
