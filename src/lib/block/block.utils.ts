import { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { prevent } from '$lib/utils.js';
import type { JSONBlock } from '$lib/utils/json.js';

export type BlockOperations = {
	addBlock: {
		block: JSONBlock;
		index: number;
	};
	addBlocks: {
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
				text: this.content,
				prevent
			}) as BlockOperations[O] | undefined;
			if (normalizedPayload) {
				finalPayload = normalizedPayload;
				break;
			}
		}

		const result = this.edytor.transact(() => func.bind(this)(finalPayload));

		for (const plugin of this.edytor.plugins) {
			// @ts-expect-error
			plugin.onAfterOperation?.({
				operation,
				payload,
				block: this
			}) as BlockOperations[O] | undefined;
		}

		return result;
	} as T;
}

export function addBlock(
	this: Block | Edytor,
	{ block, index = this.yChildren.length }: BlockOperations['addBlock']
) {
	const newBlock = new Block({ parent: this, block });
	this.yChildren.insert(index, [newBlock.yBlock]);
	return newBlock;
}

export function addBlocks(
	this: Block | Edytor,
	{ blocks, index = this.yChildren.length }: BlockOperations['addBlocks']
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
	return this.parent.addBlock({
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
	return this.parent.addBlock({
		block: {
			...block,
			children: this.value.children
		},
		index: this.index
	});
}

export function splitBlock(
	this: Block,
	{ index = this.edytor.selection.state.yStart }: BlockOperations['splitBlock']
) {
	const content = this.content.splitText({ index });

	const hasChildren = this.children.length >= 1;

	// Add the current children to the new block if any
	const newBlock = this.parent.addBlock({
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
	if (!isEmpty) {
		// Add the current content to the previous block content
		closestPreviousBlock.content.yText.applyDelta([
			{ retain: closestPreviousBlock.content.yText.length },
			...this.content.yText.toDelta()
		]);

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

	this.content.yText.applyDelta([
		{ retain: this.content.yText.length },
		...nextBlock.content.yText.toDelta()
	]);

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

export function nestBlock(this: Block) {
	const previousBlock = this.previousBlock;
	if (!previousBlock) return;

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
	this.edytor.selection.setAtTextOffset(newBlock.content);
}

export function setBlock(this: Block, { value }: BlockOperations['setBlock']) {
	this.edytor.doc.transact(() => {
		if (value.type) {
			this.type = value.type;
		}
		if (value.content) {
			this.content.setText({ value: value.content });
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
					return this.addBlock({ block: child, index: i });
				}
			});

			childrenToRemove && this.yChildren.delete(newChildrenCount, childrenToRemove);
		}
	});
}
