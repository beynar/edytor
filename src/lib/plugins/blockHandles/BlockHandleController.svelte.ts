import { autoScrollFor } from './autoScroll.js';
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
	attachInstruction,
	draggable,
	dropTargetForElements,
	extractInstruction,
	setCustomNativeDragPreview,
	type Availability,
	type Instruction
} from '$lib/dnd/pragmatic.js';
import { HIDDEN, hidden } from '$lib/selection/visibility.js';
import {
	getSelectionBlocks,
	holdsBlocks,
	movable,
	outermost,
	selectMoved,
	shownText
} from '$lib/selection/replaceSelection.js';
import { takeKeys } from '$lib/events/onFocus.js';
import { kindLabel } from '$lib/kinds.js';
import { englishLabels, type BlockHandlesLabels } from '$lib/labels.js';
import type { Popup, PopupOpener } from '$lib/surface/popups.svelte.js';
import { dragPreview } from './dragPreview.js';
import { stacks } from '../columns/stacking.js';

const blockDragMimeType = 'application/x-edytor-block-id';

/**
 * The DOM event a handle click dispatches on the editor when no `onActivate`
 * is set. A menu that takes the keyboard answers it with `preventDefault()`
 * (the block menu does); unanswered, the editor takes the focus, so the keys
 * act on the selected block (Backspace deletes it, Shift+arrows extend it).
 */
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
type DropTargetRecord = DragLocation['current']['dropTargets'][number];

type DropPlacement = {
	target: Block;
	node: HTMLElement;
	position: BlockMovePosition;
	/** The pointer's half was refused (the hitbox's `blocked`): this is the placement it gave way to. */
	blocked?: boolean;
};

/** The drop target data key of the row the hitbox measured (`rowAt`). */
const ROW = 'edytorRow';
/** The drop target data key of a beside band beyond the editor's edges (`margin`). */
const MARGIN = 'edytorMargin';

/** How far beside a target's box it stays the drop target (`getIsSticky`), across and along. */
const SLOP_X = 20;
const SLOP_Y = 24;
/** The right beside band: the row's last 15% (Notion), at least this many px. */
const RIGHT_BAND = 0.15;
const RIGHT_BAND_MIN = 32;
/**
 * How far the beside bands reach into the page margins, within a row's
 * height: left, beyond the handle column; right, beyond the editor's edge.
 */
const MARGIN_X = 120;
/** The handle column's width when the drag's handle cannot be measured (`+`, grip and gap). */
const HANDLE_COLUMN = 50;

const isBeside = (position: BlockMovePosition): position is 'left' | 'right' =>
	position === 'left' || position === 'right';

type BlockHandleControllerOptions = {
	draggable: boolean;
	onActivate?: (activation: BlockActivation) => void;
	labels?: BlockHandlesLabels;
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

/** Whether no block follows `block` at any level: below it, the document ends. */
const endsDocument = (block: Block) => {
	for (let level: Block | undefined = block; level && !level.isRoot; level = level.parent)
		if (level.nextBlock) return false;
	return true;
};

/** A block's own row: its box down to where its first child begins. */
const ownRow = (node: HTMLElement) => {
	const rect = node.getBoundingClientRect();
	return new DOMRect(
		rect.left,
		rect.top,
		rect.width,
		Math.max(0, getOwnRowBottom(node) - rect.top)
	);
};

/** The first line of a block's own text (not a child's), or the block's box. */
const ownTextRow = (node: HTMLElement) => {
	const text = Array.from(node.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')).find(
		(element) => element.closest('[data-edytor-block="true"]') === node
	);
	const row = text?.getClientRects()[0];
	return row && row.height > 0 ? row : node.getBoundingClientRect();
};
/** Where a block's own text starts: its level's column. */
const column = (block: Block) => ownTextRow(block.node!).left;

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
	/** Releases this drag's auto-scroll registrations (window and scrolling ancestors). */
	private scrolling: (() => void) | null = null;
	/** The blocks the drag in progress moves (`dragBlocks` when it started). */
	private group: Block[] = [];
	/** The selection the drag in progress replaced when it started: its undo step restores it. */
	private held: SelectionValue | null = null;
	/** The handle the drag in progress started from: its width is the handle column's. */
	private handle: HTMLElement | null = null;
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

	/** The words the handles say (the plugin's `labels`): read them in a custom `handle`. */
	get labels(): BlockHandlesLabels {
		return this.options.labels ?? englishLabels.blockHandles;
	}

	/**
	 * The block's kind as people read it (`kindLabel`: "Heading 1"), its
	 * handle's name; reactive through the block's cell (a Turn into renames it).
	 */
	labelOf = (block: Block) => {
		void this.edytor.cells?.get(block.id)?.type;
		return kindLabel(this.edytor, block);
	};

	/** The popup the `+` or the grip of `block` opened, while it is open (`edytor.popups`). */
	opened = (block: Block, control: PopupOpener['control']): Popup | undefined =>
		this.edytor.popups.openedBy(block.id, control);

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
		if (this.options.onActivate) return this.options.onActivate({ block, anchor });
		// Without a callback, a block menu plugin may answer the activation; with
		// none answering, the keys go to the editor, over the block selection
		// (Notion), not to the grip (its own focus: not a user gesture).
		const event = new CustomEvent<BlockActivation>(BLOCK_ACTIVATE_EVENT, {
			cancelable: true,
			detail: { block, anchor }
		});
		if (this.edytor.node?.dispatchEvent(event) === false) return;
		takeKeys(this.edytor);
	}

	/**
	 * Whether the `+`'s Alt+click on `block` adds a column right of its
	 * column (a block directly in a layout's column, as Notion) rather than a
	 * block above it.
	 */
	addsColumn(block: Block) {
		const parent = block.parent;
		return !!parent && !parent.isRoot && this.edytor.facade.isLayoutItem(parent.id);
	}

	/**
	 * The `+`: offers the new block to a menu (`BLOCK_ADD_EVENT`), which adds
	 * it once the user picks what to insert; with none answering, adds it now
	 * (`BlockAddition.insert`). A user command: its own undo step, however
	 * soon it follows typing. `alt` (Alt+click) adds it above, or, for a block
	 * directly in a column (`addsColumn`), in a new column right of that
	 * column: the empty block is inserted after `block` and moved beside it
	 * (`moveBlocks`, `right`: `layout.place-beside`), in the same transaction.
	 */
	addBlock(block: Block, alt = false, anchor: HTMLElement | null = block.node ?? null) {
		const { edytor } = this;
		if (edytor.readonly || !block.parent) return;
		this.ungrip();
		const column = alt && this.addsColumn(block);
		const above = alt && !column;
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
						const reused = !column && block.type === type && block.isEmpty;
						const target = reused
							? block
							: above
								? block.insertBlockBefore(spec)
								: block.insertBlockAfter(spec);
						// A new column right of the block's: the one move path places it.
						if (target && column)
							edytor.moveBlocks({ blocks: [target], target: block, position: 'right' });
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
				this.handle = element.closest<HTMLElement>('[data-edytor-block-handle-host]') ?? element;
				const group = (this.group = this.dragBlocks(block));
				// A ghost of the moved blocks as they look (Notion), cloned now and
				// removed with the drag library's container once the drag starts.
				const root = this.edytor.node;
				const nodes = group.flatMap((moved) => (moved.node ? [moved.node] : []));
				if (nativeSetDragImage && root && nodes.length) {
					const preview = dragPreview(root, nodes, location.current.input);
					setCustomNativeDragPreview({
						nativeSetDragImage,
						getOffset: preview.offset,
						render: ({ container }) => container.append(preview.element)
					});
				}
				for (const [node, target] of this.targets) this.registerDropTarget(node, target);
				this.registerMarginTarget(element.ownerDocument.body);
				this.scrolling?.();
				this.scrolling = root ? autoScrollFor(root, (data) => data.owner === this.owner) : null;
				this.backdrop?.remove();
				this.backdrop = backdrop(element.ownerDocument);
				this.edytor.overlay.layer?.prepend(this.backdrop);
			},
			// The moved blocks show selected while they move (a text range becomes their
			// block selection); the drop's undo step restores the selection held before.
			onDragStart: () => {
				const { selectedBlocks, value } = this.edytor.selection;
				if (holdsBlocks(selectedBlocks, this.group)) return;
				this.held = value;
				this.select(block);
			},
			// PDD notifies the source before drop targets. Keep the shown
			// placement and the targets until the target has committed its move.
			// A drop on one of ours gives the keys to the editor (Notion: Mod+Z
			// right after a drag), whatever it selected.
			onDrop: ({ location }) =>
				queueMicrotask(() => {
					if (location.current.dropTargets.length) takeKeys(this.edytor);
					this.clearIndicator();
					this.backdrop?.remove();
					this.backdrop = null;
					this.scrolling?.();
					this.scrolling = null;
					for (const off of this.registered.values()) off();
					this.registered.clear();
					this.dragging = null;
					this.handle = null;
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
			// A beside band counts: a row whose halves are both refused still takes it.
			// In the handle column a block (one reaching into it, a list item's
			// marker) hands the pointer to the page target, whose rule is the
			// row at the pointer's height (`margin`): never a placement held from
			// a row passed on the way.
			canDrop: ({ source, input }) => {
				if (this.inHandleColumn(input.clientX)) return false;
				const row = this.rowAt(source.data, target, node, input);
				if (Object.values(this.operations(source.data, row, input)).includes('available'))
					return true;
				const dragSource = this.getDragSource(source.data);
				return Boolean(dragSource && this.beside(dragSource, row, input));
			},
			// Atlassian's list-item hitbox splits the row the pointer is on into its
			// halves (`operations`); nesting is no band of it (combine is
			// not-available): the pointer's x decides it (`zones`).
			getData: ({ source, input }) => {
				const row = this.rowAt(source.data, target, node, input);
				return attachInstruction(
					{ [ROW]: row.id },
					{
						input,
						// The hitbox reads only this box: the row's own, not its subtree's.
						element: { getBoundingClientRect: () => ownRow(row.node!) } as Element,
						operations: this.operations(source.data, row, input)
					}
				);
			},
			// Held while it or a target inside it holds the placement (the drag library
			// keeps an inner target only while every outer one of its chain sticks),
			// across a small gap beside the block — below the document's last block, all
			// the way down (Notion) — never over another block's own row (its parent's,
			// which the drag library would otherwise let it keep), nor over another column.
			getIsSticky: ({ source, input }) => {
				const dragSource = this.getDragSource(source.data);
				const active = this.activeDropTarget;
				if (!dragSource || this.edytor.readonly || !active || !node.contains(active)) return false;
				const rect = node.getBoundingClientRect();
				return (
					input.clientX >= rect.left - SLOP_X &&
					input.clientX <= rect.right + SLOP_X &&
					input.clientY >= rect.top - SLOP_Y &&
					(input.clientY <= rect.bottom + SLOP_Y || endsDocument(target)) &&
					!this.overOtherColumn(target, input.clientX) &&
					!overOtherRow(
						node,
						input,
						(over) => !this.edytor.idToBlock.get(over.dataset.edytorId ?? '')?.isContainer
					)
				);
			},
			onDragEnter: ({ location, source }) => this.showIndicator(node, location, source.data),
			onDrag: ({ location, source }) => this.showIndicator(node, location, source.data),
			// The target left hands the placement to the innermost one still current (an
			// outer target of its chain that sticks), before the next move asks it to stick.
			onDragLeave: ({ location, source }) => {
				if (this.activeDropTarget !== node) return;
				this.clearIndicator();
				const [current] = location.current.dropTargets;
				if (current) this.showIndicator(current.element as HTMLElement, location, source.data);
			},
			onDrop: ({ location, source }) => {
				const [current] = location.current.dropTargets;
				if (current?.element !== node) return;
				const dragSource = this.getDragSource(source.data);
				const placement =
					this.activeDropTarget === node && this.activePlacement
						? this.activePlacement
						: this.placement(current, source.data, location.current.input) || null;
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
	 * The editor's margins (Notion): during our drag, the page (`body`) is a
	 * drop target only where `margin` gives a placement — the handle column
	 * left of the blocks (a reorder of the row there), the page margin beyond
	 * it and the one right of the editor (beside bands), within a row's
	 * height — so a row is reached from outside it too, row after row;
	 * anywhere else the block targets (and their stickiness) stand.
	 */
	private registerMarginTarget(node: HTMLElement) {
		if (this.registered.has(node)) return;
		const cleanup = dropTargetForElements({
			element: node,
			canDrop: ({ source, input }) => {
				const dragSource = this.getDragSource(source.data);
				return Boolean(dragSource && this.margin(dragSource, input));
			},
			getData: () => ({ [MARGIN]: true }),
			onDragEnter: ({ location, source }) => this.showIndicator(node, location, source.data),
			onDrag: ({ location, source }) => this.showIndicator(node, location, source.data),
			onDragLeave: ({ location, source }) => {
				if (this.activeDropTarget !== node) return;
				this.clearIndicator();
				const [current] = location.current.dropTargets;
				if (current) this.showIndicator(current.element as HTMLElement, location, source.data);
			},
			onDrop: ({ location, source }) => {
				const [current] = location.current.dropTargets;
				if (current?.element !== node) return;
				const dragSource = this.getDragSource(source.data);
				const placement =
					this.activeDropTarget === node && this.activePlacement
						? this.activePlacement
						: dragSource && this.margin(dragSource, location.current.input);
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
	 * The editor's left gutter: where its blocks' text starts (the root's
	 * content box), and the width of the handle column left of it (the drag's
	 * handle, measured: `+`, grip and the gap to the block).
	 */
	private gutter(root: HTMLElement) {
		const style = root.ownerDocument.defaultView?.getComputedStyle(root);
		const start =
			root.getBoundingClientRect().left +
			root.clientLeft +
			(parseFloat(style?.paddingLeft ?? '') || 0);
		const width = this.handle?.isConnected ? this.handle.getBoundingClientRect().width : 0;
		return { start, handles: width > 0 ? width : HANDLE_COLUMN };
	}

	/** Whether `x` is in the handle column left of the editor's blocks (`gutter`): the page target's. */
	private inHandleColumn(x: number) {
		const root = this.edytor.node;
		if (!root) return false;
		const { start, handles } = this.gutter(root);
		return x < start && x >= start - handles;
	}

	/**
	 * A placement in the editor's margins at the pointer, for the row the
	 * editor's near edge shows at the pointer's height (`rowAt`: a column's
	 * block, a nested block's own row):
	 * - in the handle column left of the blocks (`gutter`), that row's
	 *   reorder (`reorder`): a drag straight down the handles reorders, row
	 *   after row, gaps included (never a beside band);
	 * - beyond it (up to `MARGIN_X`), the band left of that row;
	 * - right of the editor (up to `MARGIN_X`), the band right of it;
	 * the bands are `beside`'s, as if the pointer were at that edge, only
	 * when the document has a layout kind. `undefined` elsewhere.
	 */
	private margin(source: Block, { clientX: x, clientY: y }: { clientX: number; clientY: number }) {
		const root = this.edytor.node;
		if (!root || this.edytor.readonly) return undefined;
		const box = root.getBoundingClientRect();
		if (y < box.top || y > box.bottom) return undefined;
		const { start, handles } = this.gutter(root);
		const handle = this.inHandleColumn(x);
		const left = x < start - handles && x >= start - handles - MARGIN_X;
		const right = x > box.right && x <= box.right + MARGIN_X;
		if (!handle && (!this.layouts || (!left && !right))) return undefined;
		const edge = right ? box.right - 1 : Math.max(box.left, start) + 1;
		const hits = root.ownerDocument.elementsFromPoint?.(edge, y) ?? [];
		const hit = hits.find((at) => {
			const block = at.closest<HTMLElement>('[data-edytor-block="true"]');
			return block && root.contains(block) && this.targets.has(block);
		});
		const node = hit?.closest<HTMLElement>('[data-edytor-block="true"]');
		const target = node && this.targets.get(node);
		// Between two rows of the handle column (a margin, a layout's edge), the
		// reorder shown stays, as a block's sticky slop keeps it.
		const shown = handle && this.activeDropTarget === root.ownerDocument.body;
		const held = shown ? this.activePlacement : null;
		const stay = held && !isBeside(held.position) ? held : undefined;
		if (!node || !target) return stay;
		const data = { owner: this.owner, blockId: source.id };
		const { facade } = this.edytor;
		let row = this.rowAt(data, target, node, { clientX: edge, clientY: y });
		// Over a layout's edge, its first or last column's row at that height.
		if (facade.isLayout(row.id)) {
			const items = row.children.filter((item) => item.node && this.targets.has(item.node));
			const rect = (right ? items.at(-1) : items[0])?.node?.getBoundingClientRect();
			if (!rect || rect.width === 0) return undefined;
			const inner = right ? rect.right - 1 : rect.left + 1;
			row = this.rowAt(data, target, node, { clientX: inner, clientY: y });
		}
		if (facade.isLayout(row.id) || !row.node) return stay;
		if (handle) return this.reorder(source, row, { clientX: x, clientY: y }) ?? undefined;
		const band = this.beside(
			source,
			row,
			{ clientX: left ? -Infinity : Infinity, clientY: y },
			left ? 'left' : 'right'
		);
		return band ?? undefined;
	}

	/**
	 * The handle column's reorder over `row` at the pointer: the hitbox's
	 * halves as its own drop target gives them (`zones`, the pointer's x
	 * picking the level), its own row's top half before, the bottom half
	 * after, only before or after a block — never inside one; `null` when
	 * neither half fits. Over an item of a container the dragged blocks do not
	 * fit in (a paragraph over a list's item: the document refuses every
	 * placement at the item's level), the container is the row: its whole box,
	 * the upper half before it, the lower half after it (round 4), so a drag
	 * down the handles meets the list as one row it can pass.
	 */
	private reorder(
		source: Block,
		row: Block,
		input: { clientX: number; clientY: number }
	): DropPlacement | null {
		const fits = this.fits(source);
		const halvesOf = (row: Block, rect: DOMRect) => {
			const zones = this.zones(source, row, input);
			const [before, after] = [zones.before, zones.after].map((half) =>
				half.filter((placement) => placement.position !== 'inside')
			) as [DropPlacement[], DropPlacement[]];
			return input.clientY < rect.top + rect.height / 2 ? [before, after] : [after, before];
		};
		let halves = halvesOf(row, ownRow(row.node!));
		for (
			let at = row.parent;
			!halves[0]!.some(fits) && at?.node && !at.isRoot && at.isContainer;
			at = at.parent
		)
			halves = halvesOf(at, at.node.getBoundingClientRect());
		const placement = halves.flat().find(fits);
		return placement ? { ...placement, blocked: !halves[0]!.some(fits) } : null;
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
		// A layout the selection covers whole counts as held (D3): its blocks stay selected.
		const holds = holdsBlocks(selectedBlocks, request.blocks);
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

	/** Whether the drag of `source` may land at a placement. */
	private fits = (source: Block) => (placement: DropPlacement) =>
		this.canDrop(source, placement.target, placement.position);

	/**
	 * The hitbox's operations over `row` for our drag: reorder-before and
	 * reorder-after, each `blocked` when the document refuses every
	 * placement of that half (`zones`), none outside our drag.
	 */
	private operations(
		data: Record<string, unknown>,
		row: Block,
		input: { clientX: number }
	): Partial<Record<Instruction['operation'], Availability>> {
		const source = this.getDragSource(data);
		if (!source || this.edytor.readonly) return {};
		const { before, after } = this.zones(source, row, input);
		const offer = (half: DropPlacement[]) =>
			half.some(this.fits(source)) ? 'available' : 'blocked';
		return { 'reorder-before': offer(before), 'reorder-after': offer(after) };
	}

	/**
	 * The block whose row the pointer is on over `node`: the last shown drop
	 * target in it whose row starts at or above the pointer (beside a nested
	 * block, over its ancestors' indent, the pointer is on that block's
	 * row), else `target`, over its own row (`emptied`). A layout's columns
	 * sit side by side: only the one under the pointer is measured (between
	 * two of them, the layout is the row: its gap).
	 */
	private rowAt(
		data: Record<string, unknown>,
		target: Block,
		node: HTMLElement,
		{ clientX, clientY }: { clientX: number; clientY: number }
	) {
		const source = this.getDragSource(data);
		const lift = (row: Block) => (source ? this.emptied(source, row) : row);
		if (clientY < getOwnRowBottom(node)) return lift(target);
		const { facade } = this.edytor;
		let row = target;
		let aside: HTMLElement | null = null;
		// In document order, rows start lower and lower (within a column): measure
		// none below the pointer, none a closed toggle hides (each read would force
		// a layout), and nothing in a column the pointer is not over.
		for (const inner of node.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')) {
			if (aside?.contains(inner)) continue;
			const block = this.targets.get(inner);
			if (!block || inner.closest(HIDDEN)) continue;
			const rect = inner.getBoundingClientRect();
			if (facade.isLayoutItem(block.id) && (clientX < rect.left || clientX > rect.right)) {
				aside = inner;
				continue;
			}
			if (rect.top > clientY) break;
			if (rect.height > 0) row = block;
		}
		return lift(row);
	}

	/** Whether the document has a layout kind: only then are there beside placements. */
	private get layouts() {
		for (const definition of this.edytor.blocks.values()) if (definition.layout) return true;
		return false;
	}

	/**
	 * The block a beside placement over `block` stands beside: the document's
	 * own resolution (`facade.besideAt`, `placeBeside`'s): a list item's list,
	 * a code line's code block, a toggle's child itself, an item itself.
	 */
	private besideOf(block: Block) {
		return this.edytor.idToBlock.get(this.edytor.facade.besideAt(block.id)) ?? block;
	}

	/** The item (and its layout) a beside placement at `outer` (`besideOf`) adds a column beside. */
	private layoutOf(outer: Block) {
		const { facade } = this.edytor;
		const item = facade.isLayoutItem(outer.id)
			? outer
			: outer.parent && !outer.parent.isRoot && facade.isLayoutItem(outer.parent.id)
				? outer.parent
				: null;
		return item ? { item, layout: item.parent ?? null } : null;
	}

	/**
	 * Whether `x` is over a column other than one holding `block`: a sticky
	 * target never holds the pointer across a column boundary.
	 */
	private overOtherColumn(block: Block, x: number) {
		const { facade } = this.edytor;
		for (let at: Block | undefined = block; at && !at.isRoot; at = at.parent) {
			if (!facade.isLayoutItem(at.id)) continue;
			const item = at;
			const over = item.parent?.children.some((other) => {
				const rect = other !== item ? other.node?.getBoundingClientRect() : undefined;
				return rect !== undefined && rect.width > 0 && x >= rect.left && x <= rect.right;
			});
			if (over) return true;
		}
		return false;
	}

	/**
	 * Notion's beside bands over `row` (`docs/columns-plan.md`, "View layer"), only while the
	 * pointer is within its own row's height, the document has a layout kind
	 * and the layout the drop makes or grows does not stack (`stacks`):
	 * - right: the row's last 15% (at least 32px), and the slop past it;
	 * - left: the slop left of the row (its sticky margin, left of its text
	 *   column), only for a row whose parent is the root or a column (a
	 *   list's item: its list's) — a nested row keeps the pointer's x for its
	 *   levels (`zones`) — and only
	 *   inside the editor (a column's gap): left of the editor's blocks is the
	 *   handle column, which reorders (`margin`);
	 * - over a layout's gap (the row is the layout): right of the column
	 *   before it, a new column between.
	 * `undefined` outside the bands (the hitbox's halves stand), else the
	 * placement, or `null` when the document refuses it: a refused band shows
	 * nothing.
	 */
	private beside(
		source: Block,
		row: Block,
		{ clientX: x, clientY: y }: { clientX: number; clientY: number },
		band?: 'left' | 'right'
	): DropPlacement | null | undefined {
		if (!row.node || this.edytor.readonly || !this.layouts) return undefined;
		const group = this.moving(source);
		if (group.some((moved) => moved === row || row.isChildOf(moved))) return undefined;
		const { facade } = this.edytor;
		let placement: DropPlacement | undefined;
		if (facade.isLayout(row.id)) {
			const rect = row.node.getBoundingClientRect();
			if (y < rect.top || y > rect.bottom || stacks(rect.width)) return undefined;
			const items = row.children.filter((item) => item.node && this.targets.has(item.node));
			for (const [index, item] of items.entries()) {
				const next = items[index + 1]?.node?.getBoundingClientRect();
				const own = item.node!.getBoundingClientRect();
				if (next && x >= own.right && x <= next.left)
					placement = { target: item, node: item.node!, position: 'right' };
			}
		} else {
			const rect = ownRow(row.node);
			if (y < rect.top || y > rect.bottom) return undefined;
			const outer = this.besideOf(row);
			const width = (this.layoutOf(outer)?.layout ?? outer).node?.getBoundingClientRect().width;
			if (width === undefined || stacks(width)) return undefined;
			// A container's item (a list's) stands at its container's level, as the
			// document resolves it (`besideAt`): left of a root list's item is left of the list.
			let at = row;
			while (
				at.parent &&
				!at.parent.isRoot &&
				at.parent.isContainer &&
				!facade.isLayoutItem(at.parent.id)
			)
				at = at.parent;
			const parent = at.parent;
			const level = !parent || parent.isRoot || facade.isLayoutItem(parent.id);
			if (
				band === 'right' ||
				(!band && x >= rect.right - Math.max(RIGHT_BAND_MIN, rect.width * RIGHT_BAND))
			)
				placement = { target: row, node: row.node, position: 'right' };
			else if (
				level &&
				(band === 'left' ||
					(!band && x < rect.left && x >= rect.left - SLOP_X && x >= this.inside(rect.left)))
			)
				placement = { target: row, node: row.node, position: 'left' };
		}
		if (!placement) return undefined;
		return this.fits(source)(placement) ? placement : null;
	}

	/** Where the editor's blocks start (`gutter`), or `fallback` without a host. */
	private inside(fallback: number) {
		const root = this.edytor.node;
		return root ? this.gutter(root).start : fallback;
	}

	/** The children a block shows: none for a closed toggle's, or a container's items. */
	private shown(block: Block) {
		return block.isContainer
			? []
			: block.children.filter(
					(child) => child.node && this.targets.has(child.node) && !hidden(child)
				);
	}

	/**
	 * Over a dragged block, the parent it leaves when that parent shows no
	 * other child: the gap under the parent's own row, which reparents as
	 * the parent's lower half does (`zones`). Else `row`.
	 */
	private emptied(source: Block, row: Block) {
		const group = this.moving(source);
		const parent = group.find((moved) => moved === row || row.isChildOf(moved))?.parent;
		if (!parent?.node || parent.isRoot || !this.targets.has(parent.node)) return row;
		const shown = this.shown(parent);
		return shown.length && shown.every((child) => group.includes(child)) ? parent : row;
	}

	/**
	 * The placements over `row`, each half's in preference order (a refused
	 * one gives way to the next, then to the other half's):
	 * - the top half: before it;
	 * - the bottom half of a block whose children show (not a closed toggle):
	 *   its first child's slot. Pragmatic drag and drop's tree rule: an
	 *   expanded item offers no "after" on its own row;
	 * - else, after it at the level whose text column is nearest the pointer:
	 *   the last block of a nested group reparents to any ancestor it ends,
	 *   down to the root. Past one nesting step right of its text start,
	 *   inside it (its last child) first. A block every shown child of which
	 *   is dragged is not expanded: its levels, never inside it when the drag
	 *   moves only its children (they would stay where they are).
	 * None over a dragged block's own row or its subtree: released there, the
	 * drag changes nothing (its levels would outdent it) — unless it empties
	 * its parent's shown children (`emptied`): that parent's row.
	 */
	private zones(source: Block, row: Block, { clientX }: { clientX: number }) {
		const group = this.moving(source);
		if (group.some((moved) => moved === row || row.isChildOf(moved)))
			return { before: [], after: [] };
		const at = (target: Block | undefined, position: BlockMovePosition): DropPlacement[] =>
			target?.node ? [{ target, node: target.node, position }] : [];
		const before = at(row, 'before');
		const shown = this.shown(row);
		const first = shown.find((child) => !group.includes(child));
		if (first) return { before, after: at(first, 'before') };
		// A group moved out from under its parent leaves the block before it last.
		const next = (block: Block) => {
			let next = block.nextBlock;
			while (next && group.includes(next)) next = next.nextBlock;
			return next;
		};
		const levels = [row];
		for (let level = row; !next(level) && level.parent?.node && !level.parent.isRoot; )
			levels.push((level = level.parent));
		const distance = (level: Block) => Math.abs(column(level) - clientX);
		const after = levels
			.sort((a, b) => distance(a) - distance(b))
			.flatMap((level) => at(level, 'after'));
		const stays = shown.length > 0 && group.every((moved) => moved.parent === row);
		const inside = stays ? [] : at(row, 'inside');
		const nests = clientX > column(row) + nestIndent(row.node!);
		return { before, after: nests ? [...inside, ...after] : [...after, ...inside] };
	}

	/**
	 * The placement a drop target record offers: a beside band of the row
	 * first (`beside`; `false` when the document refuses it: nothing shows),
	 * else the row and the half the hitbox attached (kept while the target is
	 * sticky), the pointer live.
	 */
	private placement(
		record: DropTargetRecord,
		data: Record<string, unknown>,
		input: { clientX: number; clientY: number }
	): DropPlacement | null | false {
		const source = this.getDragSource(data);
		if (record.data[MARGIN]) return (source && this.margin(source, input)) ?? false;
		const instruction: Instruction | null = extractInstruction(record.data);
		const row = this.edytor.idToBlock.get(record.data[ROW] as string);
		if (!source || !instruction || !row?.node) return null;
		const aside = this.beside(source, row, input);
		if (aside !== undefined) return aside ?? false;
		const { before, after } = this.zones(source, row, input);
		const halves = instruction.operation === 'reorder-before' ? [before, after] : [after, before];
		const placement = halves.flat().find(this.fits(source));
		return placement ? { ...placement, blocked: instruction.blocked } : null;
	}

	private getDragSource(data: Record<string, unknown>) {
		if (data.owner !== this.owner || typeof data.blockId !== 'string') return null;
		return this.edytor.idToBlock.get(data.blockId) ?? null;
	}

	private showIndicator(node: HTMLElement, location: DragLocation, data: Record<string, unknown>) {
		const [current] = location.current.dropTargets;
		if (current?.element !== node) return;
		const placement = this.placement(current, data, location.current.input);
		// A refused beside band shows nothing.
		if (placement === false) return this.clearIndicator();
		if (!placement) return;
		const shown = this.activePlacement;
		if (
			this.activeDropTarget === node &&
			shown?.target === placement.target &&
			shown.position === placement.position &&
			shown.blocked === placement.blocked
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
		if (placement.blocked) overlay.dataset.blocked = 'true';
		overlay.setAttribute('aria-hidden', 'true');
		const count = this.group.length;
		// How many blocks move, as data only: the bar shows no badge.
		if (count > 1) overlay.dataset.count = String(count);
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
		// Beside: a column of a layout, never a nest.
		if (isBeside(position)) return null;
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
		const rect = ownRow(node);
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
				height: `${rect.height}px`
			});
			backdrop.dataset.shown = 'true';
		};
	}

	/**
	 * Layer-relative geometry of Notion's plain bar: centered between the
	 * two siblings of the slot, or — inside the target — where the child lands,
	 * indented to the child's column.
	 */
	private positionIndicator(origin: DOMRect) {
		const placement = this.activePlacement;
		const overlay = this.indicatorOverlay;
		if (!placement || !overlay) return;
		if (isBeside(placement.position)) return this.positionBeside(placement, origin);
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

	/**
	 * A beside placement's bar: vertical, 4px, at the edge of the block it
	 * stands beside (`besideOf`: the whole list beside an item), its height;
	 * when it adds a column to a layout, the layout's height, in the middle
	 * of the gap to the neighbouring column, else at the layout's edge.
	 */
	private positionBeside(placement: DropPlacement, origin: DOMRect) {
		const overlay = this.indicatorOverlay;
		const outer = this.besideOf(placement.target);
		if (!overlay || !outer.node) return;
		const right = placement.position === 'right';
		const at = this.layoutOf(outer);
		let edge: number;
		let box: DOMRect;
		if (at?.layout?.node && at.item.node) {
			box = at.layout.node.getBoundingClientRect();
			const own = at.item.node.getBoundingClientRect();
			const near = (right ? at.item.nextBlock : at.item.previousBlock)?.node;
			const next = near?.getBoundingClientRect();
			const shown = next && next.width > 0 ? next : null;
			if (!shown) edge = right ? box.right : box.left;
			else edge = right ? (own.right + shown.left) / 2 : (shown.right + own.left) / 2;
		} else {
			box = outer.node.getBoundingClientRect();
			edge = right ? box.right : box.left;
		}
		return () => {
			Object.assign(overlay.style, {
				left: `${edge - BAR / 2 - origin.left}px`,
				top: `${box.top - origin.top}px`,
				width: `${BAR}px`,
				height: `${box.height}px`
			});
		};
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
