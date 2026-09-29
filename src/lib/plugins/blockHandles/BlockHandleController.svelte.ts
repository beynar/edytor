import type { ElementDropTargetEventPayloadMap } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

import type { Block } from '$lib/block/block.svelte.js';
import type {
	BlockMoveDirection,
	BlockMovePosition,
	BlockMoveRequest
} from '$lib/session/moves.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { draggable, dropTargetForElements } from '$lib/dnd/pragmatic.js';
import { outermost } from '$lib/selection/replaceSelection.js';

const blockDragMimeType = 'application/x-edytor-block-id';

/** The DOM event a handle click dispatches on the editor when no `onActivate` is set. */
export const BLOCK_ACTIVATE_EVENT = 'edytor-block-activate';
export type BlockActivation = { block: Block; anchor: HTMLElement };

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
	onActivate?: (activation: BlockActivation) => void;
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

/** The first line of a block's own text (not a child's), or the block's box. */
const ownTextRow = (node: HTMLElement) => {
	const text = Array.from(node.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')).find(
		(element) => element.closest('[data-edytor-block="true"]') === node
	);
	const row = text?.getClientRects()[0];
	return row && row.height > 0 ? row : node.getBoundingClientRect();
};

/** A nested child's indent when the target has no visible child to measure. */
const NEST_INDENT = 24;
/** Notion's drop bar: 4px of translucent blue. */
const DROP_INDICATOR_COLOR = 'rgba(35, 131, 226, 0.43)';
const BAR = 4;

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
	/** The indicator's measure in the overlay, while one is shown. */
	private offIndicator: (() => void) | null = null;
	/** Candidate drop targets; registered with the drag library only during our drag. */
	private readonly targets = new Map<HTMLElement, Block>();
	private readonly registered = new Map<HTMLElement, () => void>();
	/** The block whose handle is the source of the drag in progress (its handle stays mounted). */
	dragging = $state<string | null>(null);

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
		if (!this.edytor.readonly && block.movable) this.edytor.selection.selectBlocks(block);
	}

	/**
	 * Make `node` the block's grip: dragging (when draggable), a click that
	 * selects the block and opens its menu, and the Alt+arrow moves.
	 */
	grip = (block: Block) => (node: HTMLElement) => {
		const click = (event: MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
			this.activateBlock(block, node);
		};
		const pointerdown = (event: PointerEvent) => event.stopPropagation();
		const keydown = (event: KeyboardEvent) => this.handleKeyDown(event, block);
		node.addEventListener('click', click);
		node.addEventListener('pointerdown', pointerdown);
		node.addEventListener('keydown', keydown);
		const unregister = this.registerHandle(node, block);
		return {
			destroy: () => {
				node.removeEventListener('click', click);
				node.removeEventListener('pointerdown', pointerdown);
				node.removeEventListener('keydown', keydown);
				unregister();
			}
		};
	};

	/** Select the block (a block selection holding it stays) and open its menu. */
	activateBlock(block: Block, anchor: HTMLElement) {
		if (this.edytor.readonly || !block.movable) return;
		if (!this.edytor.selection.selectedBlocks.has(block)) this.selectBlock(block);
		if (this.options.onActivate) this.options.onActivate({ block, anchor });
		// Without a callback, a block menu plugin may answer the activation.
		else
			this.edytor.node?.dispatchEvent(
				new CustomEvent<BlockActivation>(BLOCK_ACTIVATE_EVENT, { detail: { block, anchor } })
			);
	}

	/**
	 * Notion's `+`: a new block below (above with Alt) opened on the slash
	 * menu; an empty block of the default kind takes the `/` itself. One user
	 * command: its own undo step, however soon it follows typing.
	 */
	addBlock(block: Block, above = false) {
		const { edytor } = this;
		const { parent } = block;
		if (edytor.readonly || !parent) return;
		edytor.expectInternalFocus();
		edytor.node?.focus({ preventScroll: true });
		edytor.dispatcher.run('insertBlock', () => {
			const type = edytor.defaultChild(parent);
			const spec = { block: { type } };
			const target =
				block.type === type && block.isEmpty
					? block
					: above
						? block.insertBlockBefore(spec)
						: block.insertBlockAfter(spec);
			const text = target?.firstText;
			if (!text) return;
			// The caret is the model's: the projector shows it once the block mounts.
			edytor.dispatcher.caret(text, 0);
			text.insertText({ value: '/', start: 0, end: 0 });
			edytor.dispatcher.caret(text, 1);
		});
	}

	registerHandle(element: HTMLElement, block: Block) {
		if (!this.options.draggable) return () => {};
		return draggable({
			element,
			canDrag: () => !this.edytor.readonly && block.movable,
			getInitialData: () => ({ owner: this.owner, blockId: block.id }),
			getInitialDataForExternal: () => ({ [blockDragMimeType]: block.id }),
			// Drop targets exist from the start of our drag (before any target is looked up).
			onGenerateDragPreview: () => {
				this.dragging = block.id;
				for (const [node, target] of this.targets) this.registerDropTarget(node, target);
			},
			onDragStart: () => {
				if (!this.edytor.selection.selectedBlocks.has(block)) this.selectBlock(block);
			},
			// PDD notifies the source before drop targets. Keep the shown
			// placement and the targets until the target has committed its move.
			onDrop: () =>
				queueMicrotask(() => {
					this.clearIndicator();
					for (const off of this.registered.values()) off();
					this.registered.clear();
					this.dragging = null;
				})
		});
	}

	/** A candidate drop target; registered at once when our drag is in progress. */
	addDropTarget(node: HTMLElement, target: Block) {
		if (!this.options.draggable) return () => {};
		this.targets.set(node, target);
		if (this.dragging) this.registerDropTarget(node, target);
		return () => {
			if (this.targets.get(node) === target) this.targets.delete(node);
			this.registered.get(node)?.();
			this.registered.delete(node);
			if (this.activeDropTarget === node) this.clearIndicator();
		};
	}

	private registerDropTarget(node: HTMLElement, target: Block) {
		if (this.registered.has(node)) return;
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
				if (!dragSource || this.edytor.readonly || this.activeDropTarget !== node) return false;
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
				if (this.activeDropTarget === node) this.clearIndicator();
			},
			onDrop: ({ location, source }) => {
				if (location.current.dropTargets[0]?.element !== node) return;
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
						blocks: this.dragBlocks(dragSource),
						target: placement.target,
						position: placement.position
					});
				}
			}
		});
		this.registered.set(node, cleanup);
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
			blocks: this.dragBlocks(source),
			target,
			position
		});
	}

	/**
	 * The blocks a drag from `source` moves: the selection when it holds
	 * `source` (a selected block's selected descendants ride with it), when
	 * what remains shares one parent; else `source` alone.
	 */
	dragBlocks(source: Block) {
		const { selectedBlocks } = this.edytor.selection;
		if (!selectedBlocks.has(source) || selectedBlocks.size <= 1) return [source];
		const roots = outermost(selectedBlocks);
		const parent = roots[0]?.parent;
		return parent && roots.every((block) => block.parent === parent)
			? roots.toSorted(this.edytor.compareBlocks)
			: [source];
	}

	private resolvePlacement(
		source: Block,
		target: Block,
		node: HTMLElement,
		input: { clientX: number; clientY: number }
	): DropPlacement | null {
		const positions: BlockMovePosition[] = ['before', 'inside', 'after'];
		const [before, inside, after] = positions.map((position) => {
			const placement = getDropPlacement(target, node, input, position);
			return this.canDrop(source, placement.target, placement.position) ? placement : undefined;
		});
		if (!before && !inside && !after) return null;
		// The row's top quarter places before, its bottom quarter after, the
		// middle inside; without `inside`, each edge takes its half.
		const rect = node.getBoundingClientRect();
		const rowHeight = Math.max(0, getOwnRowBottom(node) - rect.top);
		const offset = rowHeight ? (input.clientY - rect.top) / rowHeight : 0.5;
		const edge = inside ? 0.25 : 0.5;
		if (before && offset < edge) return before;
		if (after && offset > 1 - edge) return after;
		return inside ?? after ?? before ?? null;
	}

	private getDragSource(data: Record<string, unknown>) {
		if (data.owner !== this.owner || typeof data.blockId !== 'string') return null;
		return this.edytor.idToBlock.get(data.blockId) ?? null;
	}

	private showIndicator(
		node: HTMLElement,
		target: Block,
		location: DragLocation,
		data: Record<string, unknown>
	) {
		const [current] = location.current.dropTargets;
		if (current?.element !== node || current.isActiveDueToStickiness) return;
		const source = this.getDragSource(data);
		const placement = source && this.resolvePlacement(source, target, node, location.current.input);
		if (!placement) return;
		if (
			this.activeDropTarget === node &&
			this.indicatorNode === placement.node &&
			placement.node.dataset.edytorBlockDropPosition === placement.position
		) {
			this.edytor.overlay.invalidate();
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
		overlay.style.setProperty('--edytor-drop-indicator-color', color || DROP_INDICATOR_COLOR);
		const layer = this.edytor.overlay.layer;
		layer?.append(overlay);
		this.indicatorOverlay = overlay;
		// Placed at once (it must not show at the layer's origin for a frame), then per frame.
		if (layer) this.positionIndicator(layer.getBoundingClientRect())?.();
		this.offIndicator = this.edytor.overlay.add((origin) => this.positionIndicator(origin));
	}

	/**
	 * Layer-relative geometry (R11) of Notion's plain bar: centered between the
	 * two siblings of the slot, or — inside the target — where the child lands,
	 * indented to the child's column.
	 */
	private positionIndicator(origin: DOMRect) {
		const placement = this.activePlacement;
		const overlay = this.indicatorOverlay;
		if (!placement || !overlay) return;
		const rect = placement.node.getBoundingClientRect();
		const place = (left: number, width: number, center: number) => () => {
			overlay.style.left = `${left - origin.left}px`;
			overlay.style.width = `${width}px`;
			overlay.style.top = `${center - BAR / 2 - origin.top}px`;
		};
		if (placement.position === 'inside') {
			// Where the child lands (the gap after the last visible child, else after
			// the target's own row), from the child's indent to the target's right edge.
			const row = ownTextRow(placement.node);
			const { target } = placement;
			const lastNode = target.children.at(-1)?.node;
			const last = lastNode?.getBoundingClientRect();
			const shown = last && last.height > 0 ? last : null;
			const next = target.parent?.children[target.index + 1]?.node?.getBoundingClientRect();
			const end = shown ? shown.bottom : getOwnRowBottom(placement.node);
			const land = next && next.top >= end ? (end + next.top) / 2 : end + 4;
			const left = shown && lastNode ? ownTextRow(lastNode).left : row.left + NEST_INDENT;
			return place(left, Math.max(16, rect.right - left), land);
		}

		const siblings = placement.target.parent?.children;
		const index = placement.target.index + (placement.position === 'after' ? 1 : 0);
		const previous = siblings?.[index - 1]?.node?.getBoundingClientRect();
		const next = siblings?.[index]?.node?.getBoundingClientRect();
		if (previous && next && previous.bottom <= next.top) {
			const left = Math.min(previous.left, next.left);
			const width = Math.max(previous.right, next.right) - left;
			return place(left, width, (previous.bottom + next.top) / 2);
		}
		const edge = placement.position === 'before' ? rect.top : rect.bottom;
		return place(rect.left, rect.width, edge);
	}

	private clearIndicator() {
		if (this.indicatorNode) {
			delete this.indicatorNode.dataset.edytorBlockDropPosition;
			this.indicatorNode = null;
		}
		this.offIndicator?.();
		this.offIndicator = null;
		this.indicatorOverlay?.remove();
		this.indicatorOverlay = null;
		this.activeDropTarget = null;
		this.activePlacement = null;
	}
}
