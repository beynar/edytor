import type { ElementDropTargetEventPayloadMap } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

import type { Block } from '$lib/block/block.svelte.js';
import type {
	BlockMoveDirection,
	BlockMovePosition,
	BlockMoveRequest
} from '$lib/session/moves.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { CommandResult } from '$lib/session/commands.js';
import { noSelection, project, type SelectionValue } from '$lib/session/selection.js';
import {
	draggable,
	dropTargetForElements,
	setCustomNativeDragPreview
} from '$lib/dnd/pragmatic.js';
import {
	getSelectionBlocks,
	movable,
	outermost,
	selectMoved,
	shownText
} from '$lib/selection/replaceSelection.js';
import { dragPreview } from './dragPreview.js';

const blockDragMimeType = 'application/x-edytor-block-id';

/** The DOM event a handle click dispatches on the editor when no `onActivate` is set. */
export const BLOCK_ACTIVATE_EVENT = 'edytor-block-activate';
export type BlockActivation = { block: Block; anchor: HTMLElement };

/**
 * The DOM event the `+` dispatches on the editor. A menu answers it with
 * `preventDefault()` (the slash menu does), adds nothing until a row is
 * picked, then calls `insert(then)`; unanswered, the `+` inserts at once.
 */
export const BLOCK_ADD_EVENT = 'edytor-block-add';
export type BlockAddition = {
	block: Block;
	/** The `+` clicked, else the block's element. */
	anchor: HTMLElement | null;
	/**
	 * Add an empty block of the parent's default kind below `block` (above
	 * with Alt; an empty block of that kind is reused), put the caret in it
	 * and run `then`, as one undo step. Answers `then`'s result. When `then`
	 * answers `false` or its command is refused (by the document or an
	 * extension's veto) with nothing applied, the addition is taken back in
	 * the same transaction: the document, its undo and redo steps and the
	 * selection are as before, and `dispatcher.last` reads `refused`.
	 */
	insert: (then?: () => unknown) => unknown;
};

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

/**
 * Whether the pointer is over the own row of a block other than `node` and
 * its descendants. A container (a list) has no row of its own: its padding
 * above its first item is none (`hasOwnRow`).
 */
const overOtherRow = (
	node: HTMLElement,
	input: { clientX: number; clientY: number },
	hasOwnRow: (over: HTMLElement) => boolean
) => {
	const hit = node.ownerDocument.elementFromPoint?.(input.clientX, input.clientY);
	const over = hit?.closest<HTMLElement>('[data-edytor-block="true"]');
	if (!over || node.contains(over) || !hasOwnRow(over)) return false;
	return input.clientY < getOwnRowBottom(over);
};

/** The first line of a block's own text (not a child's), or the block's box. */
const ownTextRow = (node: HTMLElement) => {
	const text = Array.from(node.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')).find(
		(element) => element.closest('[data-edytor-block="true"]') === node
	);
	const row = text?.getClientRects()[0];
	return row && row.height > 0 ? row : node.getBoundingClientRect();
};

/**
 * One nesting step, a nested child's indent when the target has no visible
 * child to measure: the `--edytor-nest-indent` the children container is
 * indented by (in px), else its default.
 */
const NEST_INDENT = 24;
const nestIndent = (node: HTMLElement) => {
	const value = node.ownerDocument.defaultView
		?.getComputedStyle(node)
		.getPropertyValue('--edytor-nest-indent')
		.trim();
	return value?.endsWith('px') ? parseFloat(value) : NEST_INDENT;
};
/** Notion's drop bar: 4px of translucent blue. */
const DROP_INDICATOR_COLOR = 'rgba(35, 131, 226, 0.43)';
/** The nest backdrop's theming variable (its defaults are in `BlockHandle.svelte`). */
const BACKDROP_COLOR = '--edytor-drop-backdrop-color';
const BAR = 4;
/**
 * Notion's nest backdrop: a soft rounded tint over the future parent's own
 * row, drawn by the overlay layer under the drop line — never a style on the
 * block, so rounded block styles and nesting cannot bend it. One per drag,
 * made at its start so it fades in (`data-shown`) and out.
 */
const backdrop = (document: Document) => {
	const node = document.createElement('div');
	node.dataset.edytorDropBackdrop = 'true';
	node.setAttribute('aria-hidden', 'true');
	return node;
};

/** How many blocks move: the badge on the drag preview and the drop indicator. */
const countBadge = (document: Document, count: number) => {
	const badge = document.createElement('span');
	badge.dataset.edytorDragCount = 'true';
	badge.textContent = String(count);
	Object.assign(badge.style, {
		position: 'absolute',
		top: '-8px',
		right: '-8px',
		minWidth: '18px',
		height: '18px',
		padding: '0 5px',
		boxSizing: 'border-box',
		borderRadius: '9px',
		background: 'rgb(35, 131, 226)',
		color: 'white',
		font: '600 11px/18px system-ui, sans-serif',
		textAlign: 'center'
	});
	return badge;
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
	/** The indicator's measure in the overlay, while one is shown. */
	private offIndicator: (() => void) | null = null;
	/**
	 * The nest backdrop: one per drag, in the overlay; `data-shown` while the
	 * placement nests (it fades out in place, then goes with the drag).
	 */
	private backdrop: HTMLElement | null = null;
	/** Candidate drop targets; registered with the drag library only during our drag. */
	private readonly targets = new Map<HTMLElement, Block>();
	private readonly registered = new Map<HTMLElement, () => void>();
	/** The block whose handle is the source of the drag in progress (its handle stays mounted). */
	dragging = $state<string | null>(null);
	/** The blocks the drag in progress moves (`dragBlocks` when it started). */
	private group: Block[] = [];
	/** The selection the drag in progress replaced when it started: its undo step restores it. */
	private held: SelectionValue | null = null;
	/** The selection a grip click replaced (`before`), while the one it made (`after`) stands. */
	private gripped: { before: SelectionValue; after: SelectionValue } | null = null;

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

	/**
	 * Select the block — a block selection holding it stays; over a text
	 * range across blocks, the blocks it covers (`select`) — and open its
	 * menu.
	 */
	activateBlock(block: Block, anchor: HTMLElement) {
		if (this.edytor.readonly || !block.movable) return;
		const { selection } = this.edytor;
		const before = selection.value;
		if (!selection.selectedBlocks.has(block)) this.select(block);
		this.gripped = { before, after: selection.value };
		if (this.options.onActivate) this.options.onActivate({ block, anchor });
		// Without a callback, a block menu plugin may answer the activation.
		else
			this.edytor.node?.dispatchEvent(
				new CustomEvent<BlockActivation>(BLOCK_ACTIVATE_EVENT, { detail: { block, anchor } })
			);
	}

	/**
	 * The `+`: offers the new block to a menu (`BLOCK_ADD_EVENT`), which adds
	 * it once the user picks what to insert; with none answering, adds it now
	 * (`BlockAddition.insert`). A user command: its own undo step, however
	 * soon it follows typing.
	 */
	addBlock(block: Block, above = false, anchor: HTMLElement | null = block.node ?? null) {
		const { edytor } = this;
		if (edytor.readonly || !block.parent) return;
		this.ungrip();
		const insert = (then?: () => unknown) => {
			const { dispatcher, facade, selection, undoManager: um } = edytor;
			const held = selection.value;
			let refused: CommandResult | undefined;
			edytor.expectInternalFocus();
			edytor.node?.focus({ preventScroll: true });
			// The addition and `then` are one transaction: one update, one undo
			// step. Refused with nothing applied, the addition is taken back inside
			// it, and the history captures nothing (its undo and redo steps stay).
			const capture = um?.captureTransaction;
			if (um && capture) um.captureTransaction = (tr) => !refused && capture(tr);
			let out: unknown;
			try {
				out = dispatcher.run('insertBlock', () =>
					edytor.transact(() => {
						const type = block.parent && edytor.defaultChild(block.parent);
						if (!type) return;
						const spec = { block: { type } };
						const reused = block.type === type && block.isEmpty;
						const target = reused
							? block
							: above
								? block.insertBlockBefore(spec)
								: block.insertBlockAfter(spec);
						// The caret is the model's: the projector shows it once the block mounts.
						if (target?.firstText) dispatcher.caret(target.firstText, 0);
						if (!target || !then) return;
						const [added, before] = [facade.version, dispatcher.last];
						const result = then();
						// `then`'s own refusal (not one left from before), with nothing applied.
						const last = dispatcher.last !== before ? dispatcher.last : null;
						if (facade.version !== added || (result !== false && last?.status !== 'refused'))
							return result;
						refused =
							last?.status === 'refused' ? last : { operation: 'insertBlock', status: 'refused' };
						// The take-back of this command's own uncommitted write, not a user command.
						if (!reused) facade.apply(facade.prepare.deleteBlocks([target.id]));
						// Still answered: the command scope settles a vetoed async command's rejection.
						return result;
					})
				);
			} finally {
				if (um && capture) um.captureTransaction = capture;
			}
			if (!refused) return out;
			selection.select(held);
			dispatcher.last = refused;
			return false;
		};
		const detail: BlockAddition = { block, anchor, insert };
		const event = new CustomEvent(BLOCK_ADD_EVENT, { cancelable: true, detail });
		if (edytor.node?.dispatchEvent(event) !== false) insert();
	}

	/**
	 * A `+` while the block selection a grip click made still stands (its
	 * menu open, or closed leaving it, a divider's): that selection was the
	 * menu's, so the selection held before the grip comes back — for none,
	 * or a caret whose place is gone, a caret at the start of the grip
	 * block's first line — and the `+` holds that one (its menu's Escape
	 * gives it back).
	 */
	private ungrip() {
		const { gripped } = this;
		this.gripped = null;
		const { selection, facade } = this.edytor;
		// Only while the grip's own selection value stands (any other selection write replaced it).
		if (!gripped || selection.value !== gripped.after || gripped.after.kind !== 'blocks') return;
		const { before, after } = gripped;
		if (before === after) return;
		if (before.kind !== 'none' && project(before, facade).start) return selection.select(before);
		const grip = this.edytor.idToBlock.get(after.ids[0]!);
		const text = grip && shownText(grip, 'first');
		// A block with no text (a divider): no selection, as before the grip.
		if (text) this.edytor.dispatcher.caret(text, 0);
		else selection.select(noSelection);
	}

	registerHandle(element: HTMLElement, block: Block) {
		if (!this.options.draggable) return () => {};
		return draggable({
			element,
			canDrag: () => !this.edytor.readonly && block.movable,
			getInitialData: () => ({ owner: this.owner, blockId: block.id }),
			getInitialDataForExternal: () => ({ [blockDragMimeType]: block.id }),
			// The moved blocks are known, and drop targets exist, from the start of
			// our drag (before any target is looked up).
			onGenerateDragPreview: ({ nativeSetDragImage, location }) => {
				this.dragging = block.id;
				const group = (this.group = this.dragBlocks(block));
				// A ghost of the moved blocks as they look (Notion), cloned now and
				// removed with the drag library's container once the drag starts.
				const root = this.edytor.node;
				const nodes = group.flatMap((moved) => (moved.node ? [moved.node] : []));
				if (nativeSetDragImage && root && nodes.length) {
					const count = group.length;
					const badge = count > 1 ? countBadge(element.ownerDocument, count) : undefined;
					const preview = dragPreview(root, nodes, location.current.input, badge);
					setCustomNativeDragPreview({
						nativeSetDragImage,
						getOffset: preview.offset,
						render: ({ container }) => container.append(preview.element)
					});
				}
				for (const [node, target] of this.targets) this.registerDropTarget(node, target);
				this.backdrop?.remove();
				this.backdrop = backdrop(element.ownerDocument);
				this.edytor.overlay.layer?.prepend(this.backdrop);
			},
			// The moved blocks show selected while they move (a text range becomes their
			// block selection); the drop's undo step restores the selection held before.
			onDragStart: () => {
				const { selectedBlocks, value } = this.edytor.selection;
				if (this.group.every((moved) => selectedBlocks.has(moved))) return;
				this.held = value;
				this.select(block);
			},
			// PDD notifies the source before drop targets. Keep the shown
			// placement and the targets until the target has committed its move.
			onDrop: () =>
				queueMicrotask(() => {
					this.clearIndicator();
					this.backdrop?.remove();
					this.backdrop = null;
					for (const off of this.registered.values()) off();
					this.registered.clear();
					this.dragging = null;
					this.group = [];
					this.held = null;
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
			// Held across a small gap beside the block, never over another block's own row
			// (its parent's, which the drag library would otherwise let it keep).
			getIsSticky: ({ source, input }) => {
				const dragSource = this.getDragSource(source.data);
				if (!dragSource || this.edytor.readonly || this.activeDropTarget !== node) return false;
				const rect = node.getBoundingClientRect();
				return (
					input.clientX >= rect.left - 20 &&
					input.clientX <= rect.right + 20 &&
					input.clientY >= rect.top - 24 &&
					input.clientY <= rect.bottom + 24 &&
					!overOtherRow(
						node,
						input,
						(over) => !this.edytor.idToBlock.get(over.dataset.edytorId ?? '')?.isContainer
					)
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
					const moved = this.moveAndSelect({
						blocks: this.moving(dragSource),
						target: placement.target,
						position: placement.position
					});
					if (moved.length && this.held) this.edytor.history.began(this.held);
				}
			}
		});
		this.registered.set(node, cleanup);
	}

	/**
	 * Alt+arrow: one step for the blocks a drag of this handle moves. A text
	 * range over them stays, as Mod+Shift+arrow keeps it; else they end
	 * selected as after a drop (`moveAndSelect`).
	 */
	handleKeyDown(event: KeyboardEvent, block: Block) {
		const direction = event.altKey ? keyMoves[event.key] : undefined;
		if (this.edytor.readonly || !direction) return;
		event.preventDefault();
		event.stopPropagation();
		const request = { blocks: this.dragBlocks(block), direction };
		if (this.inRange(block)) this.edytor.moveBlocks(request);
		else this.moveAndSelect(request);
	}

	/**
	 * Move, then select what moved — the drag's rule (`onDragStart`): a group
	 * the block selection holds keeps it (a moved block's selected children
	 * too); any other group ends selected alone.
	 */
	private moveAndSelect(request: BlockMoveRequest) {
		const { selectedBlocks } = this.edytor.selection;
		const holds = request.blocks.every((block) => selectedBlocks.has(block));
		const before = holds ? [...selectedBlocks] : [];
		const moved = this.edytor.moveBlocks(request);
		if (moved.length) selectMoved(this.edytor, moved, before);
		return moved;
	}

	private canDrop(source: Block, target: Block, position: BlockMovePosition) {
		return this.edytor.canMoveBlocks({ blocks: this.moving(source), target, position });
	}

	/** The blocks a drop of `source` moves: the drag's own group, fixed when it started. */
	private moving(source: Block) {
		// A member a collaborator deleted meanwhile is left out; the others still move.
		const group = this.dragging === source.id ? this.group.filter((block) => block.isInTree) : [];
		return group.length ? group : this.dragBlocks(source);
	}

	/**
	 * The blocks the selection covers — a block selection's blocks as
	 * clicked (a selected list is one block: its item's handle drags the
	 * item), or the blocks a text range spans (`getSelectionBlocks`, the
	 * resolver Tab and Turn into read), a code line as its code block
	 * (`movable`) — when `source` is one of them; else `source` alone.
	 */
	private covered(source: Block) {
		const { selectedBlocks, state } = this.edytor.selection;
		if (!selectedBlocks.size && state.isCollapsed) return [source];
		const covered = movable(selectedBlocks.size ? selectedBlocks : getSelectionBlocks(this.edytor));
		return covered.includes(source) ? covered : [source];
	}

	/** Whether a text range (no block selection) covers `source` (`covered`). */
	private inRange(source: Block) {
		const { selectedBlocks, state } = this.edytor.selection;
		return (
			!selectedBlocks.size &&
			!state.isCollapsed &&
			movable(getSelectionBlocks(this.edytor)).includes(source)
		);
	}

	/**
	 * The blocks a drag (or an Alt+arrow) from `source`'s handle moves
	 * (Notion): the outermost of those the selection covers (`covered`), in
	 * document order — a block's children and a closed toggle's hidden body
	 * travel with it; else `source` alone.
	 */
	dragBlocks(source: Block) {
		return outermost(this.covered(source)).sort(this.edytor.compareBlocks);
	}

	/**
	 * Select for a gesture on `source`'s handle: over a text range across
	 * blocks, every block it covers (children too, as Turn into reads them);
	 * else `source`.
	 */
	private select(source: Block) {
		const { selection } = this.edytor;
		selection.selectBlocks(...(selection.selectedBlocks.size ? [source] : this.covered(source)));
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
		// Notion's zones: the row's top half places before, its bottom half
		// after — or inside, when the pointer is also more than one nesting
		// step right of the block's text start. A zone the document refuses
		// gives way to the next one that fits.
		const rect = node.getBoundingClientRect();
		const rowHeight = Math.max(0, getOwnRowBottom(node) - rect.top);
		const offset = rowHeight ? (input.clientY - rect.top) / rowHeight : 0.5;
		const nests = Boolean(inside) && input.clientX > ownTextRow(node).left + nestIndent(node);
		const [lower, other] = nests ? [inside, after] : [after, inside];
		return (offset < 0.5 ? (before ?? lower ?? other) : (lower ?? other ?? before)) ?? null;
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
		const count = this.group.length;
		if (count > 1) {
			// The count sits in the gutter at the bar's start, where the handles are.
			overlay.dataset.count = String(count);
			const badge = countBadge(document, count);
			Object.assign(badge.style, { top: `${BAR / 2 - 9}px`, right: 'auto', left: '-26px' });
			overlay.append(badge);
		}
		const color = document.defaultView
			?.getComputedStyle(placement.node)
			.getPropertyValue('--edytor-drop-indicator-color')
			.trim();
		overlay.style.setProperty('--edytor-drop-indicator-color', color || DROP_INDICATOR_COLOR);
		const layer = this.edytor.overlay.layer;
		layer?.append(overlay);
		this.indicatorOverlay = overlay;
		const measure = (origin: DOMRect) => {
			const writes = [this.positionIndicator(origin), this.positionBackdrop(placement, origin)];
			return () => writes.forEach((write) => write?.());
		};
		// Placed at once (it must not show at the layer's origin for a frame), then per frame.
		if (layer) measure(layer.getBoundingClientRect())();
		this.offIndicator = this.edytor.overlay.add(measure);
	}

	/**
	 * The block a placement makes the dragged blocks' parent when the drop
	 * nests them: for `inside`, the target, or the item a container nests
	 * them under (`nestParent`, as the move does); for before/after, the
	 * target's parent unless it already holds them all (a plain reorder) or
	 * is the root. A container shows no row of its own (a list): none.
	 */
	private nestParent({ target, position }: DropPlacement) {
		const { edytor, group } = this;
		const ids = group.map((block) => block.id);
		const parent =
			position === 'inside'
				? (edytor.idToBlock.get(edytor.facade.nestParent(ids, target.id)) ?? target)
				: target.parent;
		if (!parent?.node || parent.isRoot || parent.isContainer) return null;
		if (position !== 'inside' && group.every((block) => block.parent === parent)) return null;
		return parent;
	}

	/**
	 * Layer-relative geometry of the nest backdrop (`backdrop`): the future
	 * parent's box (`nestParent`, read per frame: a peer's change may change
	 * it), down to where its first child begins; hidden when the placement
	 * does not nest.
	 */
	private positionBackdrop(placement: DropPlacement, origin: DOMRect) {
		const { backdrop } = this;
		if (!backdrop) return;
		const parent = this.nestParent(placement);
		const node = parent?.node;
		if (!parent || !node?.isConnected) return () => delete backdrop.dataset.shown;
		const rect = node.getBoundingClientRect();
		const height = Math.max(0, getOwnRowBottom(node) - rect.top);
		const color = node.ownerDocument.defaultView
			?.getComputedStyle(node)
			.getPropertyValue(BACKDROP_COLOR)
			.trim();
		return () => {
			backdrop.dataset.blockId = parent.id;
			if (color) backdrop.style.setProperty(BACKDROP_COLOR, color);
			else backdrop.style.removeProperty(BACKDROP_COLOR);
			Object.assign(backdrop.style, {
				left: `${rect.left - origin.left}px`,
				top: `${rect.top - origin.top}px`,
				width: `${rect.width}px`,
				height: `${height}px`
			});
			backdrop.dataset.shown = 'true';
		};
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
			const left =
				shown && lastNode ? ownTextRow(lastNode).left : row.left + nestIndent(placement.node);
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
		// Fades out where it was; the next nesting placement shows it again.
		if (this.backdrop) delete this.backdrop.dataset.shown;
		this.indicatorOverlay?.remove();
		this.indicatorOverlay = null;
		this.activeDropTarget = null;
		this.activePlacement = null;
	}
}
