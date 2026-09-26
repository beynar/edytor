import type { Block } from './block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';

export type BlockMovePosition = 'before' | 'after' | 'inside';

export type BlockMoveRequest = {
	/** Blocks are placed in this order. */
	blocks: Block[];
	target: Block;
	position: BlockMovePosition;
};

const getParentPath = (parent: Block) => (parent.isRoot ? [] : parent.path);

const getSingleMovePath = (source: Block, target: Block, position: BlockMovePosition) => {
	if (position === 'inside') {
		const index =
			source.parent === target && source.index < target.children.length
				? target.children.length - 1
				: target.children.length;
		return [...target.path, Math.max(0, index)];
	}

	const parent = target.parent;
	if (!parent) {
		return null;
	}

	const rawIndex = target.index + (position === 'after' ? 1 : 0);
	const index = source.parent === parent && source.index < rawIndex ? rawIndex - 1 : rawIndex;
	return [...getParentPath(parent), Math.max(0, index)];
};

const getDropTarget = (target: Block, position: BlockMovePosition) => {
	if (position === 'inside') {
		return { parent: target, index: target.children.length };
	}

	return target.parent
		? { parent: target.parent, index: target.index + (position === 'after' ? 1 : 0) }
		: null;
};

const canMoveBlockTo = (source: Block, target: Block, position: BlockMovePosition) => {
	if (source.isRoot || !source.parent || source.insideIsland) {
		return false;
	}
	if (target.isRoot || source === target || target.isChildOf(source) || target.insideIsland) {
		return false;
	}
	const destinationParent = position === 'inside' ? target : target.parent;
	if (!destinationParent) {
		return false;
	}
	return (
		destinationParent.isRoot ||
		(!destinationParent.definition.void &&
			!destinationParent.definition.island &&
			!destinationParent.insideIsland)
	);
};

/** Structural eligibility for the relative move; plugins can still prevent the command. */
export const canMoveBlocks = (edytor: Edytor, { blocks, target, position }: BlockMoveRequest) => {
	if (
		edytor.readonly ||
		(position !== 'before' && position !== 'after' && position !== 'inside') ||
		!blocks.length ||
		(blocks.length > 1 && new Set(blocks).size !== blocks.length) ||
		target.edytor !== edytor ||
		!target.isInTree
	) {
		return false;
	}
	return blocks.every(
		(block) => block.edytor === edytor && block.isInTree && canMoveBlockTo(block, target, position)
	);
};

/** Move relative to a live block, preserving identity and one history step. */
export const moveBlocks = (edytor: Edytor, request: BlockMoveRequest): Block[] => {
	if (!canMoveBlocks(edytor, request)) {
		return [];
	}
	const { blocks, target, position } = request;
	if (blocks.length === 1) {
		const [source] = blocks;
		const path = getSingleMovePath(source, target, position);
		const movedBlock = path ? source.moveBlock({ path }) : null;
		if (!movedBlock) {
			return [];
		}
		return [movedBlock];
	}

	const dropTarget = getDropTarget(target, position);
	if (!dropTarget) {
		return [];
	}
	let index = dropTarget.index;
	// The facade's index counts children with the moved members excluded.
	index -= blocks.filter(
		(block) => block.parent === dropTarget.parent && block.index < dropTarget.index
	).length;
	const moved = blocks[0].moveBlocks({
		blocks,
		path: [...getParentPath(dropTarget.parent), Math.max(0, index)]
	});
	return moved ?? [];
};
