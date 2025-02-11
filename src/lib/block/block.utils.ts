import { Block } from '$lib/block/block.svelte.js';
import { Text } from '$lib/text/text.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { prevent } from '$lib/utils.js';
import type { JSONBlock, JSONInlineBlock, JSONText } from '$lib/utils/json.js';
import { InlineBlock } from './inlineBlock.svelte.js';
import * as Y from 'yjs';

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
		value: JSONBlock;
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
	suggestText: {
		value: (JSONText | JSONInlineBlock)[] | string | null;
	};
	acceptSuggestedText: {};
	deleteContentAtRange: {
		start: [number, number];
		end: [number, number];
	};
};

export function batch<T extends (...args: any[]) => any, O extends keyof BlockOperations>(
	operation: O,
	func: T
): T {
	return function (this: Block, payload: BlockOperations[O]): ReturnType<T> {
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

export function addChildBlock(
	this: Block | Edytor,
	{ block, index = this.yChildren.length }: BlockOperations['addChildBlock']
) {
	const newBlock = new Block({ parent: this, block });
	this.yChildren.insert(index, [newBlock.yBlock]);
	return newBlock;
}

export function addChildBlocks(
	this: Block | Edytor,
	{ blocks, index = this.yChildren.length }: BlockOperations['addChildBlocks']
) {
	const newBlocks = blocks.map((block) => new Block({ parent: this, block }));
	this.yChildren.insert(
		index,
		newBlocks.map((block) => block.yBlock)
	);
	return newBlocks;
}

export function insertBlockAfter(
	this: Block,
	{ block }: BlockOperations['insertBlockAfter']
): Block {
	this.yChildren.delete(0, this.children.length);
	return this.parent.addChildBlock({
		block: {
			...block,
			children: this.value.children
		},
		index: this.index + 1
	});
}

export function insertBlockBefore(
	this: Block,
	{ block }: BlockOperations['insertBlockBefore']
): Block {
	return this.parent.addChildBlock({
		block: {
			...block,
			children: this.value.children
		},
		index: this.index
	});
}

export function splitBlock(
	this: Block,
	{ index, text }: BlockOperations['splitBlock']
): Block | null {
	if (!text) {
		return null;
	}
	const splittedContent = text.splitText({ index });
	const indexOfContent = this.content.indexOf(text);
	const remainingContent = this.content.slice(indexOfContent + 1).map((part) => part.value);
	const content: (JSONText | JSONInlineBlock)[] = [splittedContent, ...remainingContent].flat();
	const hasChildren = this.children.length >= 1;

	// Add the current children to the new block if any
	this.yContent.delete(indexOfContent + 1, this.content.length - indexOfContent - 1);
	const newBlock = this.parent.addChildBlock({
		block: {
			type: this.edytor.getDefaultBlock(this.parent),
			content,
			children: this.value.children
		},
		index: this.parent.children.indexOf(this) + 1
	});

	// If the block has children, we need to remove its children and insert them into the new block
	if (hasChildren) {
		this.yChildren.delete(0, this.children.length);
	}

	return newBlock;
}

export function removeBlock(
	this: Block,
	{ keepChildren = false }: BlockOperations['removeBlock'] = { keepChildren: false }
) {
	// Get the current index from yChildren array since this.index may be stale when removing multiple blocks at once
	const index = this.parent.yChildren.toArray().indexOf(this.yBlock);
	this.parent.yChildren.delete(index, 1);

	if (keepChildren && this.hasChildren) {
		this.parent.yChildren.insert(
			this.index,
			this.value.children!.map((child) => {
				const newBlock = new Block({
					parent: this.parent,
					block: child
				});
				return newBlock.yBlock;
			})
		);
	}
}

export function mergeBlockBackward(this: Block): Block | undefined {
	const { closestPreviousBlock, isEmpty } = this;
	const { children = [] } = this.value;

	if (!closestPreviousBlock) {
		return this.isEmpty ? this.mergeBlockForward() : undefined;
	}

	// Add the current content to the previous block content
	closestPreviousBlock.pushContentIntoBlock({ value: this.content });
	if (!isEmpty) {
		// If the current block has children, we need to unnest them and insert them into the current parent
		if (children.length > 0) {
			// Unnest children if any
			this.parent.yChildren.insert(
				this.index,
				children.map((child) => {
					const newBlock = new Block({
						parent: this.parent,
						block: child
					});
					return newBlock.yBlock;
				})
			);
		}
	}
	// Remove the current block from its position
	this.parent.yChildren.delete(this.index + this.children.length, 1);

	return closestPreviousBlock;
}
export function mergeBlockForward(this: Block): Block | undefined {
	const nextBlock = this.closestNextBlock;

	if (!nextBlock) return undefined;
	this.pushContentIntoBlock({ value: nextBlock.content });

	if (nextBlock.children.length > 0) {
		nextBlock.parent.yChildren.insert(
			nextBlock.index + 1,
			nextBlock.children.map((child) => {
				const newBlock = new Block({
					parent: nextBlock.parent,
					block: child.value
				});
				return newBlock.yBlock;
			})
		);
	}
	nextBlock.parent.yChildren.delete(nextBlock.index, 1);
	return nextBlock;
}

export function moveBlock(this: Block, { path }: BlockOperations['moveBlock']): Block | undefined {
	console.log([...path]);
	if (!path.length || path.some((p) => isNaN(p) || p < 0)) {
		return;
	}
	const lastIndex = path.pop();
	let currentBlock: Edytor | Block = this.edytor;

	while (path.length > 0) {
		const index = path.shift();
		if (typeof index !== 'number' || isNaN(index)) break;
		currentBlock = currentBlock.children[index!];
	}

	if (!currentBlock) return;
	this.edytor.idToBlock.delete(this.id);
	this.parent.yChildren.delete(this.index, 1);
	const newBlock = new Block({
		parent: currentBlock,
		block: this.value
	});
	currentBlock.yChildren.insert(lastIndex!, [newBlock.yBlock]);
	return newBlock;
}

export function unNestBlock(this: Block): Block | null {
	const { parent, index } = this;

	if (parent instanceof Block) {
		const grandParent = parent.parent as Block;
		const newBlock = new Block({
			parent: grandParent,
			block: this.value
		});
		grandParent.yChildren.insert(parent.index + 1, [newBlock.yBlock]);
		this.parent.yChildren.delete(index, 1);
		return newBlock;
	}
	return null;
}

export function nestBlock(this: Block): Block | null {
	const previousBlock = this.previousBlock;
	if (!previousBlock || previousBlock?.definition?.void || previousBlock?.definition?.island) {
		return null;
	}
	const newBlock = new Block({
		parent: previousBlock,
		block: { ...this.value, children: [] }
	});
	previousBlock.yChildren.insert(previousBlock.children.length, [newBlock.yBlock]);
	if (this.value.children && this.value.children.length) {
		previousBlock.yChildren.insert(
			previousBlock.children.length + 1,
			this.value.children.map((child) => {
				const newBlock = new Block({
					parent: previousBlock,
					block: child
				});
				return newBlock.yBlock;
			})
		);
	}
	this.parent.yChildren.delete(this.index, 1);
	return newBlock;
}

export function setBlock(this: Block, { value }: BlockOperations['setBlock']) {
	this.edytor.doc.transact(() => {
		if (value.type) {
			this.type = value.type;
		}
		if (value.content) {
			let newContentCount = value.content.length;
			let oldContentCount = this.content.length;
			const contentToRemove = oldContentCount - newContentCount;
			contentToRemove && this.yContent.delete(newContentCount, contentToRemove);
			const groupedContent = groupContent(value.content);
			this.yContent.insert(
				0,
				groupedContent.map((part) => {
					if ('type' in part) {
						const newInlineBlock = new InlineBlock({
							parent: this,
							block: part
						});
						return newInlineBlock.yBlock;
					} else {
						const newText = new Text({
							parent: this,
							content: part
						});
						return newText.yText;
					}
				})
			);
		} else {
			this.yContent.delete(0, this.content.length);
		}
		if (value.children) {
			let newChildrenCount = value.children.length;
			let oldChildrenCount = this.children.length;
			const childrenToRemove = oldChildrenCount - newChildrenCount;
			this.children = value.children.map((child, i) => {
				const existingChild = this.children[i];
				if (existingChild) {
					existingChild.setBlock({ value: child });
					return existingChild;
				} else {
					return this.addChildBlock({ block: child, index: i });
				}
			});

			childrenToRemove && this.yChildren.delete(newChildrenCount, childrenToRemove);
		} else {
			this.yChildren.delete(0, this.children.length);
		}
	});
}

export function pushContentIntoBlock(
	this: Block,
	{ value }: BlockOperations['pushContentIntoBlock']
) {
	const content = this.content.filter((part) =>
		part instanceof Text ? !part.yText._item?.deleted : !part.yBlock._item?.deleted
	);
	let index = content.length;
	for (const part of value) {
		if (part instanceof InlineBlock) {
			// is an inline block needed to be added
			const newInlineBlock = new InlineBlock({
				parent: this,
				block: part
			});
			this.yContent.insert(index, [newInlineBlock.yBlock]);
			index++;
		} else {
			const lastPart = content[index - 1];
			console.log({ lastPart });
			if (lastPart instanceof Text) {
				const delta = part.yText.toDelta();
				lastPart.yText.applyDelta([{ retain: lastPart.yText.length }, ...delta]);
			} else {
				const newText = new Text({
					parent: this,
					content: part.value
				});
				this.yContent.insert(index, [newText.yText]);
				index++;
			}
		}
	}
	console.log(this.yContent.toArray());
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
	// TODO
	const newInlineBlock = new InlineBlock({
		parent: this,
		block
	});
	const newText = new Text({
		parent: this,
		content: text.splitText({ index })
	});

	this.yContent.insert(text.index + 1, [newInlineBlock.yBlock, newText.yText]);
	this.normalizeContent();
	return newText;
}

export function normalizeContent(this: Block): void {
	const content = this.yContent.toArray().filter((part) => !part._item?.deleted);

	// Ensure content starts with Text
	if (content.length === 0 || !(content[0] instanceof Y.Text)) {
		const emptyText = new Text({
			parent: this,
			content: [{ text: '' }]
		});
		this.yContent.insert(0, [emptyText.yText]);
		return this.normalizeContent();
	}

	// Ensure content ends with Text
	if (!(content[content.length - 1] instanceof Y.Text)) {
		const emptyText = new Text({
			parent: this,
			content: [{ text: '' }]
		});
		this.yContent.insert(content.length, [emptyText.yText]);
		return this.normalizeContent();
	}

	// First handle consecutive text blocks
	const consecutiveTexts = content.reduce(
		(acc, part, index) => {
			const nextPart = content[index + 1];
			if (part instanceof Y.Text && nextPart instanceof Y.Text) {
				acc.push([part, nextPart]);
			}
			return acc;
		},
		[] as [Y.Text, Y.Text][]
	);

	if (consecutiveTexts.length > 0) {
		const [first, second] = consecutiveTexts[0];
		const delta = second.toDelta();
		first.applyDelta([{ retain: first.length }, ...delta]);
		this.yContent.delete(content.indexOf(second), 1);
		return this.normalizeContent();
	}

	// Then handle consecutive inline blocks
	const consecutiveInlineBlocks = content.reduce(
		(acc, part, index) => {
			const nextPart = content[index + 1];
			if (part instanceof Y.Map && nextPart instanceof Y.Map) {
				acc.push([part, nextPart]);
			}
			return acc;
		},
		[] as [Y.Map<any>, Y.Map<any>][]
	);

	if (consecutiveInlineBlocks.length > 0) {
		const [first, second] = consecutiveInlineBlocks[0];
		const emptyText = new Text({
			parent: this,
			content: [{ text: '' }]
		});
		const index = content.indexOf(second);
		this.yContent.insert(index, [emptyText.yText]);
		return this.normalizeContent();
	}
	const pluginNormalization = this.definition?.normalizeContent?.({ block: this });
	if (pluginNormalization) {
		pluginNormalization();
		this.normalizeContent();
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
	if (!this.suggestions) {
		return;
	}
	const editableSuggestions = this.suggestions.map((part) => {
		if ('type' in part) {
			return new InlineBlock({
				parent: this,
				block: part.value
			});
		} else {
			return new Text({
				parent: this,
				content: part.value
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

	let numberToDelete = 0;
	this.content.slice(startIndex, endIndex + 1).forEach((part, index) => {
		const isFirstPart = index === 0;
		const isLastPart = index === endIndex - startIndex;

		if (part instanceof Text) {
			if (isFirstPart) {
				// Delete from offset to end
				part.yText.delete(startOffset, part.yText.length - startOffset);
			} else if (isLastPart) {
				// Delete from start to offset
				part.yText.delete(0, endOffset);
			} else {
				numberToDelete++;
				// Delete entire text element
			}
		} else {
			// For inline blocks, always delete the entire element
			numberToDelete++;
		}
	});
	this.yContent.delete(startIndex + 1, numberToDelete);

	this.normalizeContent();
}
