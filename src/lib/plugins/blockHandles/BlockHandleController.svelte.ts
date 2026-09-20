import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import {
	canMoveBlockTo,
	getDragBlocks,
	moveBlocksTo,
	type DropPosition
} from './blockHandleOperations.js';

const blockDragMimeType = 'application/x-edytor-block-id';

const getDropPosition = (event: DragEvent, node: HTMLElement): DropPosition => {
	const rect = node.getBoundingClientRect();
	const offset = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
	if (offset < 0.25) {
		return 'before';
	}
	if (offset > 0.75) {
		return 'after';
	}
	return 'inside';
};

export class BlockHandleController {
	private dragSourceId: string | null = null;

	constructor(private edytor: Edytor) {}

	selectBlock(block: Block) {
		if (this.edytor.readonly || !this.canUseHandle(block)) {
			return;
		}

		this.edytor.selection.selectBlocks(block);
	}

	startDrag(event: DragEvent, block: Block) {
		if (this.edytor.readonly || !this.canUseHandle(block)) {
			event.preventDefault();
			return;
		}

		this.dragSourceId = block.id;
		event.dataTransfer?.setData(blockDragMimeType, block.id);
		event.dataTransfer?.setData('text/plain', block.id);
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
		}
		if (!this.edytor.selection.selectedBlocks.has(block)) {
			this.selectBlock(block);
		}
	}

	handleDragOver(event: DragEvent, target: Block, node: HTMLElement) {
		const source = this.getDragSource(event);
		const position = getDropPosition(event, node);
		if (!source || !this.canDrop(source, target, position)) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'move';
		}
		node.dataset.edytorBlockDropPosition = position;
	}

	handleDragLeave(node: HTMLElement) {
		delete node.dataset.edytorBlockDropPosition;
	}

	handleDrop(event: DragEvent, target: Block, node: HTMLElement) {
		const source = this.getDragSource(event);
		const position = getDropPosition(event, node);
		delete node.dataset.edytorBlockDropPosition;
		this.dragSourceId = null;

		if (!source || !this.canDrop(source, target, position)) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		moveBlocksTo(this.edytor, getDragBlocks(this.edytor, source), target, position);
	}

	handleKeyDown(event: KeyboardEvent, block: Block) {
		if (this.edytor.readonly || !event.altKey) {
			return;
		}

		if (event.key === 'ArrowUp' && block.previousBlock) {
			event.preventDefault();
			event.stopPropagation();
			moveBlocksTo(this.edytor, [block], block.previousBlock, 'before');
			return;
		}

		if (event.key === 'ArrowDown' && block.nextBlock) {
			event.preventDefault();
			event.stopPropagation();
			moveBlocksTo(this.edytor, [block], block.nextBlock, 'after');
			return;
		}

		if (event.key === 'ArrowRight' && block.previousBlock) {
			event.preventDefault();
			event.stopPropagation();
			moveBlocksTo(this.edytor, [block], block.previousBlock, 'inside');
		}
	}

	private canUseHandle(block: Block) {
		return !block.isRoot && Boolean(block.parent) && !block.insideIsland;
	}

	private canDrop(source: Block, target: Block, position: DropPosition) {
		const blocks = getDragBlocks(this.edytor, source);
		return blocks.every((block) => canMoveBlockTo(block, target, position));
	}

	private getDragSource(event: DragEvent) {
		const sourceId = event.dataTransfer?.getData(blockDragMimeType) || this.dragSourceId;
		return sourceId ? (this.edytor.idToBlock.get(sourceId) ?? null) : null;
	}
}
