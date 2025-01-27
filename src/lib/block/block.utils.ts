import { Block } from '$lib/block/block.svelte.js';
import { Text } from '$lib/text/text.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';

export function batch<T extends (...args: any[]) => any>(func: T): T {
	return function (this: Edytor, ...args: Parameters<T>): ReturnType<T> {
		return this.edytor.doc.transact(() => {
			const result = func.bind(this)(...args);
			return result;
		});
	} as T;
}

export function addChild(
	this: Block | Edytor,
	block: JSONBlock,
	index: number = this.yChildren.length
) {
	const newBlock = new Block({ parent: this, block });
	this.yChildren.insert(index, [newBlock.yBlock]);
	return newBlock;
}

export function addChildBehind(this: Block, block: JSONBlock): Block | null {
	const nextBlock = this.closestNextBlock;
	if (!nextBlock) return null;
	const newBlock = new Block({ parent: this, block });
	this.yChildren.insert(this.index, [newBlock.yBlock]);
	return newBlock as Block;
}

export function addChildWithCurrentChildren(this: Block, block: JSONBlock): Block {
	const newBlock = new Block({
		parent: this.parent,
		block: {
			...block,
			children: this.value.children
		}
	});
	this.yChildren.delete(0, this.children.length);
	this.parent.yChildren.insert(this.index + 1, [newBlock.yBlock]);
	return newBlock;
}

export function split(this: Block, index: number = this.edytor.selection.state.yStart) {
	const content = this.content.split(index);

	const hasChildren = this.children.length > 1;

	// Add the current children to the new block if any
	const newBlock = this.parent.addChild(
		{ type: this.type, content, children: this.value.children },
		this.parent.children.indexOf(this) + 1
	);

	if (hasChildren) {
		// If the block has children, we need to remove its children and insert them into the new block
		this.yChildren.delete(0, this.children.length);
	}

	return newBlock;
}

export function remove(this: Block) {
	this.parent.yChildren.delete(this.index, 1);
}
export function removeAndUnnestChildren(this: Block) {
	const {
		index,
		value: { children = [] }
	} = this;
	// Remove the current block from its position
	this.parent.yChildren.delete(index, 1);
	if (children.length) {
		// Insert the children of the current block at the current block's position
		this.parent.yChildren.insert(
			index,
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

export function mergeBlockBackward(this: Block): Block | null {
	const previousBlock = this.closestPreviousBlock;
	const { children = [] } = this.value;
	if (!previousBlock) return null;

	// Add the current content to the previous block content
	previousBlock.content.yText.applyDelta([
		{ retain: previousBlock.content.yText.length },
		...this.content.yText.toDelta()
	]);

	if (children.length > 0) {
		// Unnest children if any
		previousBlock.yChildren.insert(
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

	// Remove the current block from its position
	this.parent.yChildren.delete(this.index + this.children.length, 1);

	return previousBlock;
}
export function mergeBlockForward(this: Block) {
	const nextBlock = this.closestNextBlock;
	if (!nextBlock) return;

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
}

export function unNest(this: Block): Block | null {
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

export function nest(this: Block) {
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

export function set(this: Block, value: JSONBlock) {
	console.log(this.yBlock.toJSON());
	this.edytor.doc.transact(() => {
		if (value.type) {
			this.type = value.type;
		}
		if (value.content) {
			this.content.set(value.content);
		}
		if (value.children) {
			let newChildrenCount = value.children.length;
			let oldChildrenCount = this.children.length;
			const childrenToRemove = oldChildrenCount - newChildrenCount;
			this.children = value.children.map((child, i) => {
				const existingChild = this.children[i];
				if (existingChild) {
					existingChild.set(child);
					return existingChild;
				} else {
					return this.addChild(child, i);
				}
			});

			childrenToRemove && this.yChildren.delete(newChildrenCount, childrenToRemove);
		}
	});
	console.log(this.yBlock.toJSON());
}
