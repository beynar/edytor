import { tick } from 'svelte';

import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';

export type DropPosition = 'before' | 'after' | 'inside';

type DropTarget = {
	index: number;
	parent: Block;
};

const comparePath = (a: Block, b: Block) => {
	const length = Math.max(a.path.length, b.path.length);
	for (let index = 0; index < length; index++) {
		const left = a.path[index] ?? -1;
		const right = b.path[index] ?? -1;
		if (left !== right) {
			return left - right;
		}
	}
	return 0;
};

const getParentPath = (parent: Block) => (parent.isRoot ? [] : parent.path);

const getSingleMovePath = (source: Block, target: Block, position: DropPosition) => {
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

const getDropTarget = (target: Block, position: DropPosition): DropTarget | null => {
	if (position === 'inside') {
		return {
			parent: target,
			index: target.children.length
		};
	}

	if (!target.parent) {
		return null;
	}

	return {
		parent: target.parent,
		index: target.index + (position === 'after' ? 1 : 0)
	};
};

const isMovableSource = (block: Block) =>
	!block.isRoot && Boolean(block.parent) && !block.insideIsland;

export const canMoveBlockTo = (source: Block, target: Block, position: DropPosition) => {
	if (!isMovableSource(source) || target.isRoot || source === target || target.isChildOf(source)) {
		return false;
	}

	if (target.insideIsland) {
		return false;
	}

	if (position === 'inside') {
		return !target.definition.void && !target.definition.island;
	}

	return true;
};

export const getDragBlocks = (edytor: Edytor, source: Block) => {
	const selectedBlocks = Array.from(edytor.selection.selectedBlocks);
	if (!selectedBlocks.includes(source) || selectedBlocks.length <= 1) {
		return [source];
	}

	const parent = selectedBlocks[0]?.parent;
	if (!parent || selectedBlocks.some((block) => block.parent !== parent)) {
		return [source];
	}

	return selectedBlocks.toSorted(comparePath);
};

export const moveBlocksTo = (
	edytor: Edytor,
	sources: Block[],
	target: Block,
	position: DropPosition
) => {
	const blocks = sources.length ? sources : [];
	if (!blocks.every((block) => canMoveBlockTo(block, target, position))) {
		return [];
	}

	if (blocks.length === 1) {
		const [source] = blocks;
		const path = getSingleMovePath(source, target, position);
		const movedBlock = path ? source.moveBlock({ path }) : null;
		if (movedBlock) {
			void tick().then(() => edytor.selection.selectBlocks(movedBlock));
			return [movedBlock];
		}
		return [];
	}

	// Grouped drag = ONE facade `moveBlocks` transaction: the live blocks are
	// relocated (identity preserved) and history sees a single undo step —
	// the plan's grouped-move contract. The pre-v14 path cloned the blocks'
	// JSON, deleted the sources and re-inserted the same ids; the engine
	// refuses spec ids colliding with retained registry entries, which
	// silently dropped every dragged block.
	const dropTarget = getDropTarget(target, position);
	if (!dropTarget) {
		return [];
	}

	let index = dropTarget.index;
	if (position !== 'inside') {
		// `facade.moveBlocks` takes a final index — it counts the
		// destination's children with the moved members already excluded.
		// `dropTarget.index` is pre-removal, so discount sources sharing the
		// drop parent that sit before the raw index.
		index -= blocks.filter(
			(block) => block.parent === dropTarget.parent && block.index < dropTarget.index
		).length;
	}

	const ids = blocks.map((block) => block._blockId);
	if (ids.some((blockId) => blockId == null)) {
		return [];
	}

	const moved = edytor.transact(() =>
		edytor.facade!.moveBlocks(ids as string[], {
			parent: dropTarget.parent._blockId ?? null,
			index
		})
	);
	if (!moved) {
		return [];
	}
	edytor.flushMirror();
	void tick().then(() => edytor.selection.selectBlocks(...blocks));
	return blocks;
};
