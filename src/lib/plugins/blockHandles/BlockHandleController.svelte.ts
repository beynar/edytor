import type { ElementDropTargetEventPayloadMap } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

import type { Block } from '$lib/block/block.svelte.js';
import type {
	BlockMoveDirection,
	BlockMovePosition,
	BlockMoveRequest
} from '$lib/session/moves.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { draggable, dropTargetForElements } from '$lib/dnd/pragmatic.js';

const blockDragMimeType = 'application/x-edytor-block-id';

/** Alt+arrow on a handle: one relative step. */
const keyMoves: Record<string, BlockMoveDirection> = {
	ArrowUp: 'up',
	ArrowDown: 'down',
	ArrowRight: 'in',
	ArrowLeft: 'out'
};

type DragLocation = ElementDropTargetEventPayloadMap['onDrag']['location'];

type DropPlacement = { target: Block; node: HTMLElement; position: BlockMovePosition };

type BlockHandleControllerOptions = {
	draggable: boolean;
	onActivate?: (payload: { block: Block; anchor: HTMLElement }) => void;
};

const getOwnRowBottom = (node: HTMLElement) => {
	const rect = node.getBoundingClientRect();
	// Block nodes wrap their children in the DOM; the parent's placement
	// bands belong to its own row, ending where the first child begins.
	const firstChild = node.querySelector<HTMLElement>('[data-edytor-block="true"]');
	const childRect = firstChild?.getBoundingClientRect();
	return childRect &&
		childRect.height > 0 &&
		childRect.top >= rect.top &&
		childRect.top < rect.bottom
		? childRect.top
		: rect.bottom;
};

const getDropPlacement = (
	target: Block,
	node: HTMLElement,
	input: { clientX: number },
	position: BlockMovePosition
): DropPlacement => {
	const parent = target.parent;
	// The left gutter at a nested block's edge means "place at my parent's
	// level". This also gives the last root block an outdent target without
	// requiring a following root sibling or a separate end-zone element.
	if (
		position !== 'inside' &&
		parent &&
		!parent.isRoot &&
		parent.node &&
		input.clientX <= node.getBoundingClientRect().left + 20
	) {
		return { target: parent, node: parent.node, position };
	}
	return { target, node, position };
};

export class BlockHandleController {
	private readonly owner = {};
	private indicatorNode: HTMLElement | null = null;
	private indicatorOverlay: HTMLElement | null = null;
	private activeDropTarget: HTMLElement | null = null;
	private activePlacement: DropPlacement | null = null;
	private readonly repositionIndicator = () => this.positionIndicator();

	constructor(
		private edytor: Edytor,
		private options: BlockHandleControllerOptions = { draggable: true }
	) {}

	get readonly() {
		return this.edytor.readonly;
	}

	get draggable() {
		return this.options.draggable;
	}

	selectBlock(block: Block) {
		if (this.edytor.readonly || !block.movable) {
			return;
		}

		this.edytor.selection.selectBlocks(block);
	}

	activateBlock(block: Block, anchor: HTMLElement) {
		if (this.edytor.readonly || !block.movable) {
			return;
		}
		this.selectBlock(block);
		this.options.onActivate?.({ block, anchor });
	}

	registerHandle(element: HTMLElement, block: Block) {
		if (!this.options.draggable) {
			return () => {};
		}
		return draggable({
			element,
			canDrag: () => !this.edytor.readonly && block.movable,
			getInitialData: () => ({ owner: this.owner, blockId: block.id }),
			getInitialDataForExternal: () => ({ [blockDragMimeType]: block.id }),
			onDragStart: () => {
				if (!this.edytor.selection.selectedBlocks.has(block)) {
					this.selectBlock(block);
				}
			},
			// PDD notifies the source before drop targets. Keep the shown
			// placement until the target has committed its move.
			onDrop: () => queueMicrotask(() => this.clearIndicator())
		});
	}

	registerDropTarget(node: HTMLElement, target: Block) {
		if (!this.options.draggable) {
			return () => {};
		}
		const cleanup = dropTargetForElements({
			element: node,
			canDrop: ({ source, input }) => {
				const dragSource = this.getDragSource(source.data);
				return (
					!this.edytor.readonly &&
					Boolean(dragSource && this.resolvePlacement(dragSource, target, node, input))
				);
			},
			getIsSticky: ({ source, input }) => {
				const dragSource = this.getDragSource(source.data);
				if (!dragSource || this.edytor.readonly || this.activeDropTarget !== node) {
					return false;
				}
				const rect = node.getBoundingClientRect();
				return (
					input.clientX >= rect.left - 20 &&
					input.clientX <= rect.right + 20 &&
					input.clientY >= rect.top - 24 &&
					input.clientY <= rect.bottom + 24
				);
			},
			onDragEnter: ({ location, source }) =>
				this.showIndicator(node, target, location, source.data),
			onDrag: ({ location, source }) => this.showIndicator(node, target, location, source.data),
			onDragLeave: () => {
				if (this.activeDropTarget === node) {
					this.clearIndicator();
				}
			},
			onDrop: ({ location, source }) => {
				if (location.current.dropTargets[0]?.element !== node) {
					return;
				}
				const dragSource = this.getDragSource(source.data);
				const placement =
					this.activeDropTarget === node && this.activePlacement
						? this.activePlacement
						: dragSource && this.resolvePlacement(dragSource, target, node, location.current.input);
				this.clearIndicator();
				if (
					dragSource &&
					placement &&
					this.canDrop(dragSource, placement.target, placement.position)
				) {
					this.moveAndSelect({
						blocks: this.getDragBlocks(dragSource),
						target: placement.target,
						position: placement.position
					});
				}
			}
		});
		return () => {
			if (this.activeDropTarget === node) {
				this.clearIndicator();
			}
			cleanup();
		};
	}

	handleKeyDown(event: KeyboardEvent, block: Block) {
		const direction = event.altKey ? keyMoves[event.key] : undefined;
		if (this.edytor.readonly || !direction) return;
		event.preventDefault();
		event.stopPropagation();
		this.moveAndSelect({ blocks: [block], direction });
	}

	private moveAndSelect(request: BlockMoveRequest) {
		const moved = this.edytor.moveBlocks(request);
		if (moved.length) this.edytor.selection.selectBlocks(...moved);
	}

	private canDrop(source: Block, target: Block, position: BlockMovePosition) {
		return this.edytor.canMoveBlocks({
			blocks: this.getDragBlocks(source),
			target,
			position
		});
	}

	private getDragBlocks(source: Block) {
		const selected = Array.from(this.edytor.selection.selectedBlocks);
		if (!selected.includes(source) || selected.length <= 1) {
			return [source];
		}
		const parent = selected[0]?.parent;
		return parent && selected.every((block) => block.parent === parent)
			? selected.toSorted(this.edytor.compareBlocks)
			: [source];
	}

	private resolvePlacement(
		source: Block,
		target: Block,
		node: HTMLElement,
		input: { clientX: number; clientY: number }
	): DropPlacement | null {
		const positions: BlockMovePosition[] = ['before', 'inside', 'after'];
		const available = positions
			.map((position) => getDropPlacement(target, node, input, position))
			.filter((placement) => this.canDrop(source, placement.target, placement.position));
		if (!available.length) {
			return null;
		}

		const rect = node.getBoundingClientRect();
		const rowHeight = Math.max(0, getOwnRowBottom(node) - rect.top);
		const offset = rowHeight ? (input.clientY - rect.top) / rowHeight : 0.5;
		if (available.length === 1) {
			return available[0];
		}
		if (available.length === 3) {
			if (offset < 0.25) {
				return available[0];
			}
			return offset > 0.75 ? available[2] : available[1];
		}
		if (available[0].position === 'before' && available[1].position === 'after') {
			return offset < 0.5 ? available[0] : available[1];
		}
		if (available[0].position === 'before') {
			return offset < 0.25 ? available[0] : available[1];
		}
		return offset > 0.75 ? available[1] : available[0];
	}

	private getDragSource(data: Record<string, unknown>) {
		if (data.owner !== this.owner || typeof data.blockId !== 'string') {
			return null;
		}
		return this.edytor.idToBlock.get(data.blockId) ?? null;
	}

	private showIndicator(
		node: HTMLElement,
		target: Block,
		location: DragLocation,
		data: Record<string, unknown>
	) {
		if (location.current.dropTargets[0]?.element !== node) {
			return;
		}
		if (location.current.dropTargets[0].isActiveDueToStickiness) {
			return;
		}
		const source = this.getDragSource(data);
		const placement = source && this.resolvePlacement(source, target, node, location.current.input);
		if (!placement) {
			return;
		}
		if (
			this.activeDropTarget === node &&
			this.indicatorNode === placement.node &&
			placement.node.dataset.edytorBlockDropPosition === placement.position
		) {
			this.positionIndicator();
			return;
		}
		this.clearIndicator();
		this.activeDropTarget = node;
		this.activePlacement = placement;
		this.indicatorNode = placement.node;
		placement.node.dataset.edytorBlockDropPosition = placement.position;
		this.showOverlay(placement);
	}

	private showOverlay(placement: DropPlacement) {
		const document = placement.node.ownerDocument;
		const overlay = document.createElement('div');
		overlay.dataset.edytorDropIndicator = 'true';
		overlay.dataset.position = placement.position;
		overlay.setAttribute('aria-hidden', 'true');
		const color = document.defaultView
			?.getComputedStyle(placement.node)
			.getPropertyValue('--edytor-drop-indicator-color')
			.trim();
		overlay.style.setProperty('--edytor-drop-indicator-color', color || '#2383e2');
		document.body.append(overlay);
		this.indicatorOverlay = overlay;
		this.positionIndicator();
		document.defaultView?.addEventListener('scroll', this.repositionIndicator, true);
		document.defaultView?.addEventListener('resize', this.repositionIndicator);
	}

	private positionIndicator() {
		const placement = this.activePlacement;
		const overlay = this.indicatorOverlay;
		if (!placement || !overlay) {
			return;
		}
		const rect = placement.node.getBoundingClientRect();
		if (placement.position === 'inside') {
			overlay.style.left = `${rect.left}px`;
			overlay.style.width = `${rect.width}px`;
			overlay.style.top = `${rect.top}px`;
			overlay.style.height = `${Math.max(2, getOwnRowBottom(placement.node) - rect.top)}px`;
			return;
		}

		const siblings = placement.target.parent?.children;
		const index = placement.target.index + (placement.position === 'after' ? 1 : 0);
		const previous = siblings?.[index - 1]?.node?.getBoundingClientRect();
		const next = siblings?.[index]?.node?.getBoundingClientRect();
		if (previous && next && previous.bottom <= next.top) {
			const left = Math.min(previous.left, next.left);
			overlay.style.left = `${left}px`;
			overlay.style.width = `${Math.max(previous.right, next.right) - left}px`;
			overlay.style.top = `${(previous.bottom + next.top) / 2 - 1}px`;
		} else {
			overlay.style.left = `${rect.left}px`;
			overlay.style.width = `${rect.width}px`;
			overlay.style.top = `${placement.position === 'before' ? rect.top - 1 : rect.bottom - 1}px`;
		}
	}

	private clearIndicator() {
		if (this.indicatorNode) {
			delete this.indicatorNode.dataset.edytorBlockDropPosition;
			this.indicatorNode = null;
		}
		const view = this.indicatorOverlay?.ownerDocument.defaultView;
		view?.removeEventListener('scroll', this.repositionIndicator, true);
		view?.removeEventListener('resize', this.repositionIndicator);
		this.indicatorOverlay?.remove();
		this.indicatorOverlay = null;
		this.activeDropTarget = null;
		this.activePlacement = null;
	}
}
