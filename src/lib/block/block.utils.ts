import { Block } from '$lib/block/block.svelte.js';
import { Text } from '$lib/text/text.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { id, prevent } from '$lib/utils.js';
import { cloneJson, type JSONBlock, type JSONInlineBlock, type JSONText } from '$lib/utils/json.js';
import type { YTextLike } from '$lib/crdt/compat.js';
import type { ContentItem } from '$lib/crdt/index.js';
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
	deleteContentWithinSelection: {};
};

export function batch<T extends (...args: any[]) => any, O extends keyof BlockOperations>(
	operation: O,
	func: T
): T {
	return function (this: Block, payload: BlockOperations[O]): ReturnType<T> {
		if (this.edytor.readonly) {
			return undefined as ReturnType<T>;
		}

		let finalPayload = payload;

		for (const plugin of this.edytor.plugins) {
			// @ts-expect-error
			const normalizedPayload = plugin.onBeforeOperation?.({
				operation,
				payload,
				block: this,
				prevent
			}) as BlockOperations[O] | undefined;
			if (normalizedPayload) {
				finalPayload = normalizedPayload;
				break;
			}
		}

		const result = this.edytor.transact(() => func.bind(this)(finalPayload));

		for (const plugin of this.edytor.plugins) {
			plugin.onAfterOperation?.({
				operation,
				payload,
				block: this
			}) as BlockOperations[O] | undefined;
		}

		return result;
	} as T;
}

const appendJsonTextToYText = (target: YTextLike, value: JSONText[]) => {
	if (value.length === 0) {
		return;
	}

	target.applyDelta([
		{ retain: target.length },
		...value.map(({ text, marks }) => ({
			insert: text,
			attributes: marks
		}))
	]);
};

export function addChildBlock(
	this: Block,
	{ block, index = this.yChildren.length }: BlockOperations['addChildBlock']
) {
	if (index < 0) {
		index = 0;
	} else if (index > this.yChildren.length) {
		index = this.yChildren.length;
	}
	const newBlock = new Block({
		parent: this,
		edytor: this.edytor,
		block: block || {
			type: this.edytor.getDefaultBlock()
		}
	});
	this.yChildren.insert(index, [newBlock.yBlock]);
	this.normalizeChildren();
	return newBlock;
}

export function addChildBlocks(
	this: Block,
	{ blocks, index = this.yChildren.length }: BlockOperations['addChildBlocks']
) {
	if (index < 0) {
		index = 0;
	} else if (index > this.yChildren.length) {
		index = this.yChildren.length;
	}
	const newBlocks = blocks.map((block) => new Block({ parent: this, edytor: this.edytor, block }));
	this.yChildren.insert(
		index,
		newBlocks.map((block) => block.yBlock)
	);
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

export function splitBlock(
	this: Block,
	{ index, text }: BlockOperations['splitBlock']
): Block | null {
	if (!text || !this.parent || !this._bound || this._blockId == null) {
		return null;
	}
	const facade = this.edytor.facade!;
	const newId = id('b');
	const offset = this.partOffsetOf(text) + index;
	if (!facade.splitBlock(this._blockId, offset, newId)) {
		return null;
	}
	// Baseline semantics: the sibling takes the default block type (and no
	// data) — the engine copies type+data, so reset both in the same
	// transaction.
	facade.setBlockType(newId, this.edytor.getDefaultBlock(this.parent));
	facade.setBlockData(newId, {});
	this.edytor.flushMirror();
	this.parent?.normalizeChildren();
	return this.edytor.idToBlock.get(newId) ?? null;
}

export function removeBlock(
	this: Block,
	{ keepChildren = false }: BlockOperations['removeBlock'] = { keepChildren: false }
) {
	if (!this.parent || !this._bound || this._blockId == null || !this._live) {
		return;
	}
	this.edytor.facade!.deleteBlock(this._blockId, { keepChildren });
	this.edytor.flushMirror();
	this.parent?.normalizeChildren();
}

export function mergeBlockBackward(this: Block): Block | null {
	if (!this.parent || !this._bound || this._blockId == null) {
		return null;
	}
	const targetId = this.edytor.facade!.mergeBackward(this._blockId);
	this.edytor.flushMirror();
	this.parent?.normalizeChildren();
	return targetId ? (this.edytor.idToBlock.get(targetId) ?? null) : null;
}

export function mergeBlockForward(this: Block): Block | null {
	if (!this.parent || !this._bound || this._blockId == null) {
		return null;
	}
	const targetId = this.edytor.facade!.mergeForward(this._blockId);
	this.edytor.flushMirror();
	this.parent?.normalizeChildren();
	return targetId ? (this.edytor.idToBlock.get(targetId) ?? null) : null;
}

export function moveBlock(this: Block, { path }: BlockOperations['moveBlock']): Block | null {
	const targetPath = [...path];
	if (!targetPath.length || targetPath.some((p) => isNaN(p) || p < 0) || !this.parent) {
		return null;
	}

	if (this.path.some((p, i) => targetPath[i] === p) && this.path.length < targetPath.length) {
		// this prevent a block from being moved into itself
		return null;
	}

	const lastIndex = targetPath.pop();
	let currentBlock: Block = this.edytor.root!;

	while (targetPath.length > 0 && currentBlock) {
		const index = targetPath.shift();
		if (typeof index !== 'number' || isNaN(index)) break;
		currentBlock = currentBlock.children[index!];
	}

	if (
		!currentBlock ||
		this.insideIsland ||
		currentBlock.definition.void ||
		currentBlock.definition.island ||
		currentBlock.insideIsland ||
		!this._bound ||
		this._blockId == null
	) {
		return null;
	}
	// The facade move preserves block identity — the baseline rebuilt the
	// block from JSON, but `crdtId`/wrapper stability is the intended v14
	// improvement and reconcile keeps the same wrapper registered.
	if (
		!this.edytor.facade!.moveBlock(this._blockId, {
			parent: currentBlock._blockId ?? null,
			index: lastIndex!
		})
	) {
		return null;
	}
	this.edytor.flushMirror();
	this.parent.normalizeChildren();
	currentBlock.normalizeChildren();
	return this;
}

export function unNestBlock(this: Block): Block | null {
	const { parent } = this;
	if (!parent || !this._bound || this._blockId == null) {
		return null;
	}

	const grandParent = parent.parent;

	if (!grandParent) {
		return null;
	}

	if (!this.edytor.facade!.unNestBlock(this._blockId)) {
		return null;
	}
	this.edytor.flushMirror();
	parent.normalizeChildren();
	grandParent.normalizeChildren();
	return this;
}

export function nestBlock(this: Block): Block | null {
	const previousBlock = this.previousBlock;
	if (
		!previousBlock ||
		previousBlock?.definition?.void ||
		previousBlock?.definition?.island ||
		!this.parent ||
		!this._bound ||
		this._blockId == null ||
		previousBlock._blockId == null
	) {
		return null;
	}
	if (!this.edytor.facade!.nestBlock(this._blockId, previousBlock._blockId)) {
		return null;
	}
	this.edytor.flushMirror();
	this.parent?.normalizeChildren();
	previousBlock.normalizeChildren();
	return this;
}

export function setBlock(this: Block, { value }: BlockOperations['setBlock']) {
	if (!this._bound || this._blockId == null) {
		return;
	}
	const content: ContentItem[] | undefined = value.content?.map((part): ContentItem => {
		if ('type' in part) {
			return {
				kind: 'inline',
				id: part.id ?? id('i'),
				type: part.type,
				...(part.data ? { data: cloneJson(part.data) } : {})
			};
		}
		return {
			kind: 'text',
			text: part.text,
			...(part.marks ? { marks: cloneJson(part.marks) } : {})
		};
	});
	this.edytor.facade!.setBlock(this._blockId, {
		...(value.type !== undefined ? { type: value.type } : {}),
		...(value.data !== undefined ? { data: cloneJson(value.data) } : {}),
		...(content !== undefined ? { content } : {}),
		...(value.children !== undefined
			? {
					children: value.children.map((child) =>
						new Block({ parent: this, edytor: this.edytor, block: child })._toSpec()
					)
				}
			: {})
	});
	this.edytor.flushMirror();

	this.normalizeChildren();
	this.normalizeContent();
}

export function pushContentIntoBlock(
	this: Block,
	{ value }: BlockOperations['pushContentIntoBlock']
) {
	if (!this._bound || this._blockId == null) {
		return;
	}
	const facade = this.edytor.facade!;
	const blockId = this._blockId;
	// Live display length — the maintained runs view is commit-synced, so
	// `facade.displayLength` would return stale offsets mid-transaction.
	const liveDisplayLength = () =>
		(this.edytor.projectedBlock(blockId)?.content ?? []).reduce(
			(n, item) => n + (item.kind === 'text' ? item.text.length : 1),
			0
		);
	for (const part of value) {
		const offset = liveDisplayLength();
		if (part instanceof InlineBlock) {
			facade.insertInline(blockId, offset, {
				id: part.id,
				type: part.type,
				...(part.data ? { data: cloneJson(part.data) } : {})
			});
		} else {
			for (const item of part.value) {
				const at = liveDisplayLength();
				if (item.text.length) {
					facade.insertText(blockId, at, item.text, item.marks as Record<string, unknown>);
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
		this.yContent.delete(index, 1);
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

	if (this._bound && this._blockId != null) {
		const offset = this.partOffsetOf(text) + index;
		this.edytor.facade!.insertInline(this._blockId, offset, {
			id: newInlineBlock.id,
			type: newInlineBlock.type,
			...(newInlineBlock.data ? { data: cloneJson(newInlineBlock.data) } : {})
		});
		this._pendingParts.set(text.index + 1, newInlineBlock);
		this._pendingParts.set(text.index + 2, newText);
		this.edytor.flushMirror();
	} else {
		this.yContent.insert(text.index + 1, [newInlineBlock.yBlock, newText.yText]);
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

export function normalizeContent(this: Block): void {
	// The v14 content model maintains the part invariants by construction —
	// projected content always derives to text-first/text-last/non-adjacent
	// parts — so the only remaining normalization is the plugin hook.
	const pluginNormalization = this.definition?.normalizeContent?.({ block: this });
	if (pluginNormalization) {
		pluginNormalization();
		this.normalizeContent();
	}
}

export function normalizeChildren(this: Block): void {
	if (this.type === 'root' && this.yChildren.length === 0) {
		const newBlock = new Block({
			parent: this,
			edytor: this.edytor,
			block: { type: this.edytor.getDefaultBlock(this), children: [] }
		});
		this.yChildren.insert(0, [newBlock.yBlock]);
		return this.normalizeChildren();
	}
	const pluginNormalization = this.definition?.normalizeChildren?.({ block: this });

	if (pluginNormalization) {
		pluginNormalization();
		this.normalizeChildren();
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
	this.yContent.insert(
		this.content.length,
		editableSuggestions.map((suggestion) =>
			'yBlock' in suggestion ? suggestion.yBlock : suggestion.yText
		)
	);

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
	if (!startPart || !endPart || !this._bound || this._blockId == null) {
		return;
	}
	const startAtom = this.partOffsetOf(startPart) + startOffset;
	const endAtom = this.partOffsetOf(endPart) + endOffset;
	if (endAtom > startAtom) {
		this.edytor.facade!.deleteText(this._blockId, startAtom, endAtom - startAtom);
	}
	this.edytor.flushMirror();
	this.normalizeContent();
}
