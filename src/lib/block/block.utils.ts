/**
 * View-side command adapter for block operations (U2 delegation contract).
 *
 * These functions are the `BlockOperations` layer bound onto `Block` via
 * `batch()`, which dispatches each call as a command (admission, plugin
 * interception, one transaction: `session/commands.ts`). The functions own
 * path/offset resolution (target paths → parent blocks, `partOffsetOf`
 * segment offsets, sibling lookup for `nestBlock`), the plan of an operation
 * that is one document op (`prepare*`), and post-op mirror maintenance
 * (`flushMirror`, normalization requests).
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
 * JSON (`jsonBlockToSpec`/`jsonContentToItems` in `utils/json.ts`) — never
 * through disposable `Block` trees. `groupContent` remains only for
 * DETACHED spec mirrors (`new Block({block})` pre-admission `content`
 * parts and `suggestText` staging): the live-content invariant
 * (text-first/text-last, no adjacent same-kind parts) is derived by the
 * document's projection on read, so stored content needs no
 * pre-normalization.
 */
import { Block } from '$lib/block/block.svelte.js';
import { Text } from '$lib/text/text.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { ChangePayload } from '$lib/plugins.js';
import type { Flow, FlowTarget } from '$lib/crdt/flow.js';
import type { Prepared } from '$lib/crdt/edytor-doc.js';
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
	removeBlock: {
		keepChildren: boolean;
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
	deleteContentForward: {
		text: Text;
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
	deleteBlocks: { blocks: Block[]; snapshot?: boolean };
};

/**
 * Bind an operation onto its wrapper: every call is dispatched as a command
 * (`session/commands.ts`): admission, hooks before any write (on the command
 * and, when `prepare` answers one document plan, on each planned step), one
 * transaction, normalization, the result. `func` receives the prepared plan.
 */
export function batch<T extends (...args: any[]) => any, O extends keyof BlockOperations>(
	operation: O,
	func: T,
	prepare?: (payload: BlockOperations[O]) => Prepared
): T {
	return function (this: Block, payload: BlockOperations[O]): ReturnType<T> {
		return this.edytor.dispatcher.dispatch(
			operation,
			payload,
			{ block: this },
			func,
			prepare
		) as ReturnType<T>;
	} as T;
}

const REFUSED: Prepared = { status: 'refused', ids: [] };

export function addChildBlock(
	this: Block,
	{ block, index = this.children.length }: BlockOperations['addChildBlock']
) {
	if (index < 0) {
		index = 0;
	} else if (index > this.children.length) {
		index = this.children.length;
	}
	const newBlock = new Block({
		parent: this,
		edytor: this.edytor,
		block: block || {
			type: this.edytor.defaultChild(this)
		}
	});
	this.insertChildren(index, [newBlock]);
	this.normalizeChildren();
	return newBlock;
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
	const newBlocks = blocks.map((block) => new Block({ parent: this, edytor: this.edytor, block }));
	this.insertChildren(index, newBlocks);
	this.normalizeChildren();
	return newBlocks;
}

export function insertBlockAfter(
	this: Block,
	{ block }: BlockOperations['insertBlockAfter']
): Block | null {
	if (!this.parent) {
		return null;
	}
	const result = this.parent.addChildBlock({
		block,
		index: this.index + 1
	});
	this.parent?.normalizeChildren();

	return result;
}

export function insertBlockBefore(
	this: Block,
	{ block }: BlockOperations['insertBlockBefore']
): Block | null {
	if (!this.parent) {
		return null;
	}
	const result = this.parent.addChildBlock({
		block,
		index: this.index
	});
	this.parent?.normalizeChildren();

	return result;
}

export function prepareSplit(this: Block, { index, text }: BlockOperations['splitBlock']) {
	if (!text || !this.parent || !this.model) return REFUSED;
	// G5: the sibling takes its parent's default child type and no data.
	const tail = { type: this.edytor.defaultChild(this.parent), data: {} };
	const offset = this.partOffsetOf(text) + index;
	return this.edytor.facade.prepare.splitBlock(this.model.id, offset, id('b'), tail);
}

export function splitBlock(
	this: Block,
	payload: BlockOperations['splitBlock'],
	plan = prepareSplit.call(this, payload)
): Block | null {
	if (!('writes' in plan)) return null;
	this.edytor.facade.apply(plan);
	this.edytor.flushMirror();
	this.parent?.normalizeChildren();
	return this.edytor.idToBlock.get(plan.effect.creates[0]!) ?? null;
}

export function removeBlock(
	this: Block,
	{ keepChildren = false }: BlockOperations['removeBlock'] = { keepChildren: false }
) {
	const model = this.model;
	if (!this.parent || !model || !this._live) {
		return;
	}
	model.delete({ keepChildren });
	this.edytor.flushMirror();
	this.parent?.normalizeChildren();
}

export function mergeBlockBackward(this: Block): Block | null {
	const model = this.model;
	if (!this.parent || !model) {
		return null;
	}
	const [target] = model.mergeBackward().ids;
	this.edytor.flushMirror();
	this.parent?.normalizeChildren();
	return target ? (this.edytor.idToBlock.get(target) ?? null) : null;
}

export function mergeBlockForward(this: Block): Block | null {
	const model = this.model;
	if (!this.parent || !model) {
		return null;
	}
	const [target] = model.mergeForward().ids;
	this.edytor.flushMirror();
	this.parent?.normalizeChildren();
	return target ? (this.edytor.idToBlock.get(target) ?? null) : null;
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
	return this.edytor.facade.prepare.moveBlock(this.model.id, {
		parent: parent._blockId ?? null,
		index
	});
}

export function moveBlock(
	this: Block,
	payload: BlockOperations['moveBlock'],
	plan = prepareMove.call(this, payload)
): Block | null {
	if (!('writes' in plan)) return null;
	const from = this.parent;
	this.edytor.facade.apply(plan);
	this.edytor.flushMirror();
	from?.normalizeChildren();
	this.parent?.normalizeChildren();
	return this;
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
	const ids = blocks.map((block) => block._blockId);
	if (!parent || ids.some((blockId) => blockId == null)) return REFUSED;
	return this.edytor.facade.prepare.moveBlocks(ids as string[], {
		parent: parent._blockId ?? null,
		index
	});
}

export function moveBlocks(
	this: Block,
	payload: BlockOperations['moveBlocks'],
	plan = prepareMoves.call(this, payload)
): Block[] {
	if (!('writes' in plan)) return [];
	const { blocks } = payload;
	// Source parents captured pre-move — reconcile reassigns `parent`.
	const parents = new Set(blocks.flatMap((block) => (block.parent ? [block.parent] : [])));
	this.edytor.facade.apply(plan);
	this.edytor.flushMirror();
	for (const block of [...parents, ...blocks.map((block) => block.parent)])
		block?.normalizeChildren();
	return blocks;
}

export function unNestBlock(this: Block): Block | null {
	const { parent } = this;
	const model = this.model;
	if (!parent || !model) {
		return null;
	}

	const grandParent = parent.parent;

	// `model.unNest()` (facade `unNestBlock`) owns the refusal rules:
	// top-level blocks, island-sealed blocks and sealed destinations.
	if (model.unNest().status === 'refused') {
		return null;
	}
	this.edytor.flushMirror();
	parent.normalizeChildren();
	grandParent?.normalizeChildren();
	return this;
}

export function nestBlock(this: Block): Block | null {
	// Admission resolves the nest target — the previous sibling — and the
	// facade owns permission: `nestBlock` refuses void/island/inside-island
	// targets and island-sealed sources (`canPlace`).
	const previousBlock = this.previousBlock;
	const model = this.model;
	if (!previousBlock || !this.parent || !model || previousBlock._blockId == null) {
		return null;
	}
	if (model.nestUnder(previousBlock._blockId).status === 'refused') {
		return null;
	}
	this.edytor.flushMirror();
	this.parent?.normalizeChildren();
	previousBlock.normalizeChildren();
	return this;
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
	if (!('writes' in plan)) return;
	this.edytor.facade.apply(plan);
	this.edytor.flushMirror();
	this.normalizeChildren();
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
	this.edytor.flushMirror();
	this.normalizeContent();
}

export function removeInlineBlock(
	this: Block,
	{ index }: BlockOperations['removeInlineBlock']
): void {
	const part = this.content.at(index);
	if (part && part instanceof InlineBlock) {
		this.deleteParts(index, 1);
		this.normalizeContent();
	}
}

export const groupContent = (
	content?: (JSONText | JSONInlineBlock)[]
): (JSONText[] | JSONInlineBlock)[] => {
	const isInlineJSONBlock = (
		part?: JSONText | JSONInlineBlock | JSONText[]
	): part is JSONInlineBlock => {
		return part ? 'type' in part : false;
	};
	// this function group JSONBlock.content texts together in order to avoid having successive inline Y.Text as it would be ineficient.
	if (!content) return [[{ text: '' }]];
	const groupedContent = content.reduce(
		(acc, part) => {
			const isInlineBlock = 'type' in part;
			if (isInlineBlock) {
				if (isInlineJSONBlock(acc.at(-1))) {
					// Make sure that two consecutive inline blocks are separated by a text block
					acc.push([{ text: '' }]);
				}
				acc.push(part);
			} else {
				const lastPart = acc.at(-1);
				if (acc.length && lastPart && Array.isArray(lastPart)) {
					lastPart.push(part);
				} else {
					acc.push([part]);
				}
			}
			return acc;
		},
		[] as (JSONText[] | JSONInlineBlock)[]
	);

	if (isInlineJSONBlock(groupedContent.at(0))) {
		// Make sure that the first part is an inline block
		groupedContent.unshift([{ text: '' }]);
	}

	if (isInlineJSONBlock(groupedContent.at(-1))) {
		// Make sure that the last part is a text block
		groupedContent.push([{ text: '' }]);
	}

	return groupedContent;
};

export function addInlineBlock(
	this: Block,
	{ index, block, text }: BlockOperations['addInlineBlock']
): Text {
	const newInlineBlock = new InlineBlock({
		parent: this,
		block
	});
	const pendingMarks =
		text.markOnNextInsert === undefined ? undefined : { ...text.markOnNextInsert };
	// The tail of the split text keeps its atoms in the engine — the new text
	// wrapper is adopted onto the segment after the inserted inline.
	const newText = new Text({
		parent: this,
		content: text._sliceFrom(index)
	});
	if (pendingMarks !== undefined) {
		text.markOnNextInsert = undefined;
		newText.markOnNextInsert = pendingMarks;
	}

	const model = this.model;
	if (model) {
		const offset = this.partOffsetOf(text) + index;
		model.insertInline(offset, {
			id: newInlineBlock.id,
			type: newInlineBlock.type,
			...(newInlineBlock.data ? { data: cloneJson(newInlineBlock.data) } : {})
		});
		this._pendingParts.set(text.index + 1, newInlineBlock);
		this._pendingParts.set(text.index + 2, newText);
		this.edytor.flushMirror();
	} else {
		this.insertParts(text.index + 1, [newInlineBlock, newText]);
	}
	this.normalizeContent();
	if (pendingMarks !== undefined) {
		queueMicrotask(() => {
			const insertedText = this.edytor.getTextById(newText.id) ?? newText;
			insertedText.markOnNextInsert = pendingMarks;
		});
	}
	return newText;
}

/**
 * Bound for plugin-driven re-normalization passes (D25). A
 * `normalizeContent`/`normalizeChildren` hook that keeps returning work
 * re-enters the batched op recursively — without a cap a non-converging
 * plugin overflows the stack. The counter lives on the block
 * (`_normalizationDepth`) and is shared by both hooks so a
 * content→children→content ping-pong is bounded too; the depth is per
 * call-chain (incremented before the re-entry, decremented after), so
 * legitimate multi-pass normalization still converges.
 */
const MAX_NORMALIZATION_DEPTH = 50;

export function normalizeContent(this: Block): void {
	if (this.edytor.dispatcher.defer(this, normalizeContent)) return;
	// The v14 content model maintains the part invariants by construction —
	// projected content always derives to text-first/text-last/non-adjacent
	// parts — so the only remaining normalization is the plugin hook.
	const pluginNormalization = this.definition?.normalizeContent?.({ block: this });
	if (pluginNormalization) {
		pluginNormalization();
		if (this._normalizationDepth >= MAX_NORMALIZATION_DEPTH) {
			console.warn(
				`edytor: normalizeContent on block "${this.id}" exceeded ${MAX_NORMALIZATION_DEPTH} passes — a plugin normalizer is not converging; skipping further passes`
			);
			return;
		}
		this._normalizationDepth += 1;
		try {
			this.normalizeContent();
		} finally {
			this._normalizationDepth -= 1;
		}
	}
}

export function normalizeChildren(this: Block): void {
	if (this.edytor.dispatcher.defer(this, normalizeChildren)) return;
	if (this.type === 'root' && this.children.length === 0) {
		const newBlock = new Block({
			parent: this,
			edytor: this.edytor,
			block: { type: this.edytor.defaultChild(this), children: [] }
		});
		this.insertChildren(0, [newBlock]);
		return this.normalizeChildren();
	}
	const pluginNormalization = this.definition?.normalizeChildren?.({ block: this });

	if (pluginNormalization) {
		pluginNormalization();
		if (this._normalizationDepth >= MAX_NORMALIZATION_DEPTH) {
			console.warn(
				`edytor: normalizeChildren on block "${this.id}" exceeded ${MAX_NORMALIZATION_DEPTH} passes — a plugin normalizer is not converging; skipping further passes`
			);
			return;
		}
		this._normalizationDepth += 1;
		try {
			this.normalizeChildren();
		} finally {
			this._normalizationDepth -= 1;
		}
	}
}

export function suggestText(this: Block, { value }: BlockOperations['suggestText']) {
	if (typeof value === 'string') {
		this.suggestions = [[{ text: value }]];
	} else if (value) {
		this.suggestions = groupContent(value);
	} else {
		this.suggestions = null;
	}
}

export function acceptSuggestedText(this: Block) {
	const suggestions = this.rawSuggestions;
	if (!suggestions) {
		return;
	}
	const editableSuggestions = suggestions.map((part) => {
		if ('type' in part) {
			return new InlineBlock({
				parent: this,
				block: part
			});
		} else {
			return new Text({
				parent: this,
				content: part
			});
		}
	});
	this.insertParts(this.content.length, editableSuggestions);

	this.suggestions = null;
	this.normalizeContent();
}

export function deleteContentAtRange(
	this: Block,
	{ start, end }: BlockOperations['deleteContentAtRange']
) {
	const [startIndex, startOffset] = start;
	const [endIndex, endOffset] = end;

	const startPart = this.content.at(startIndex);
	const endPart = this.content.at(endIndex);
	const model = this.model;
	if (!startPart || !endPart || !model) {
		return;
	}
	const startAtom = this.partOffsetOf(startPart) + startOffset;
	const endAtom = this.partOffsetOf(endPart) + endOffset;
	if (endAtom > startAtom) {
		model.deleteText(startAtom, endAtom - startAtom);
	}
	this.edytor.flushMirror();
	this.normalizeContent();
}
