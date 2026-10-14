import { untrack } from 'svelte';
import { autoScrollFor } from '$lib/dnd/autoScroll.js';

import type { Block } from '$lib/block/block.svelte.js';
import type { BlockMoveDirection, BlockMoveRequest } from '$lib/session/moves.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { CommandResult } from '$lib/session/commands.js';
import {
	blockSelection,
	noSelection,
	project,
	type SelectionValue
} from '$lib/session/selection.js';
import {
	dropTargetForElements,
	type ElementDropTargetEventPayloadMap
} from '$lib/dnd/pragmatic.js';
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
import { siblingSlot } from '$lib/session/handles.js';
import type { Popup, PopupOpener } from '$lib/surface/popups.svelte.js';
import { dragSource, ghost } from './dragPreview.js';
import { DropIndicator } from '$lib/dnd/dropIndicator.js';
import { DropResolver, SLOP_X, SLOP_Y, type Drag, type Input } from '$lib/dnd/placement.js';
import { getOwnRowBottom, ownRow, type DropPlacement } from '$lib/dnd/geometry.js';
import { all, listen } from '$lib/utils/listen.js';
import type { Attachment } from 'svelte/attachments';

/**
 * The DOM event a grip click dispatches on the editor (the one way to
 * answer it: the block menu's, or your own). A menu that takes the keyboard answers it with `preventDefault()`
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

/** The drop target data keys of the row at the pointer (`rowAt`) and of its half (the top one). */
const ROW = 'edytorRow';
const BEFORE = 'edytorBefore';
/** The drop target data key of a beside band beyond the editor's edges (`margin`). */
const MARGIN = 'edytorMargin';

type BlockHandleControllerOptions = {
	draggable: boolean;
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

export class BlockHandleController {
	private readonly owner = {};
	/** Candidate drop targets; registered with the drag library only during our drag. */
	private readonly targets = new Map<HTMLElement, Block>();
	private readonly registered = new Map<HTMLElement, () => void>();
	/** The block whose handle is the source of the drag in progress (its handle stays mounted). */
	dragging = $state<string | null>(null);
	/** Releases this drag's auto-scroll registrations (window and scrolling ancestors). */
	private scrolling: (() => void) | null = null;
	/** The blocks the drag in progress moves (`dragBlocks` when it started). */
	private group: Block[] = [];
	/** The drop bar and the nest backdrop in the overlay, while our drag runs. */
	private readonly indicator: DropIndicator;
	/** Where a drop lands (the one resolution a file drag reads too). */
	private readonly drop: DropResolver;
	/** The selection the drag in progress replaced when it started: its undo step restores it. */
	private held: SelectionValue | null = null;
	/** The handle the drag in progress started from: its width is the handle column's. */
	private handle: HTMLElement | null = null;
	/** The selection a grip click replaced (`before`), while the one it made (`after`) stands. */
	private gripped: { before: SelectionValue; after: SelectionValue } | null = null;

	constructor(
		private edytor: Edytor,
		private options: BlockHandleControllerOptions = { draggable: true }
	) {
		this.drop = new DropResolver(edytor, {
			targetOf: (node) => this.targets.get(node),
			handle: () => this.handle,
			indicator: (this.indicator = new DropIndicator(edytor, {
				group: () => this.group,
				besideOf: (block) => this.drop.besideOf(block),
				layoutOf: (outer) => this.drop.layoutOf(outer)
			}))
		});
	}

	get readonly() {
		return this.edytor.readonly;
	}

	get draggable() {
		return this.options.draggable;
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
	 * The block's grip (`{@attach handle.grip}`): dragging (when draggable),
	 * a click that selects the block and opens its menu, the Alt+arrow moves
	 * (`aria-keyshortcuts`), and the ARIA of the menu it opened.
	 */
	grip =
		(block: Block): Attachment<HTMLElement> =>
		(node) => {
			node.setAttribute(
				'aria-keyshortcuts',
				'Alt+ArrowUp Alt+ArrowDown Alt+ArrowRight Alt+ArrowLeft'
			);
			this.#opener(node, block, 'grip');
			return untrack(() =>
				all(
					listen(node, 'click', (event) => {
						event.preventDefault();
						event.stopPropagation();
						this.#activateBlock(block, node);
					}),
					listen(node, 'pointerdown', (event) => event.stopPropagation()),
					listen(node, 'keydown', (event: KeyboardEvent) => this.#handleKeyDown(event, block)),
					this.registerHandle(node, block)
				)
			);
		};

	/**
	 * The block's `+` (`{@attach handle.plus}`): a click offers what to add
	 * below (Alt+click above, or a column beside: `addBlock`) under it; a
	 * press keeps the editor's focus; the ARIA of the menu it opened.
	 */
	plus =
		(block: Block): Attachment<HTMLElement> =>
		(node) => {
			this.#opener(node, block, 'add');
			return all(
				listen(node, 'mousedown', (event) => event.preventDefault()),
				listen(node, 'pointerdown', (event) => event.stopPropagation()),
				listen(node, 'click', (event: MouseEvent) => {
					event.preventDefault();
					event.stopPropagation();
					this.addBlock(block, event.altKey, node);
				})
			);
		};

	/**
	 * Keep `node`'s `aria-expanded`, `aria-controls` and `aria-haspopup` in
	 * step with the menu its `control` of `block` opened, while it is open.
	 */
	#opener(node: HTMLElement, block: Block, control: PopupOpener['control']) {
		$effect(() => {
			const popup = this.opened(block, control);
			const values = { expanded: popup && 'true', controls: popup?.id, haspopup: popup?.haspopup };
			for (const [name, value] of Object.entries(values)) {
				if (value === undefined) node.removeAttribute(`aria-${name}`);
				else node.setAttribute(`aria-${name}`, String(value));
			}
		});
	}

	/**
	 * Select the block — a block selection holding it stays; over a text
	 * range across blocks, the blocks it covers (`select`) — and open its
	 * menu.
	 */
	#activateBlock(block: Block, anchor: HTMLElement) {
		if (this.edytor.readonly || !block.movable) return;
		const { selection } = this.edytor;
		const before = selection.value;
		if (!selection.selectedBlocks.has(block)) this.select(block);
		this.gripped = { before, after: selection.value };
		// A block menu plugin (or the app) may answer the activation; with none
		// answering, the keys go to the editor, over the block selection
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
		this.#ungrip();
		const column = alt && this.addsColumn(block);
		const above = alt && !column;
		const insert = (then?: () => unknown) => {
			const { dispatcher, facade, selection, undoManager: um } = edytor;
			const held = selection.value;
			let refused: CommandResult | undefined;
			takeKeys(edytor);
			// The addition and `then` are one transaction: one update, one undo
			// step. Refused with nothing applied, the addition is taken back inside
			// it, and the history captures nothing (its undo and redo steps stay).
			const capture = um?.captureTransaction;
			if (um && capture) um.captureTransaction = (tr) => !refused && capture(tr);
			let out: unknown;
			try {
				out = dispatcher.run('insertBlocks', () =>
					edytor.transact(() => {
						const type = block.parent && edytor.defaultChild(block.parent);
						if (!type) return;
						const reused = !column && block.type === type && block.isEmpty;
						const target = reused
							? block
							: edytor.idToBlock.get(
									edytor.insertBlocks(siblingSlot(block, !above), [{ type }]).ids[0] ?? ''
								);
						// A new column right of the block's: the one move path places it.
						if (target && column)
							edytor.move({ blocks: [target], target: block, position: 'right' });
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
							last?.status === 'refused' ? last : { operation: 'insertBlocks', status: 'refused' };
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
			dispatcher.record(refused);
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
	#ungrip() {
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

	registerHandle(element: HTMLElement, block: Block): () => void {
		if (!this.options.draggable) return () => {};
		return dragSource(element, {
			canDrag: () => !this.edytor.readonly && block.movable,
			data: () => ({ owner: this.owner, blockId: block.id }),
			id: () => block.id,
			// The moved blocks are known, and drop targets exist, from the start of
			// our drag (before any target is looked up).
			begin: (pointer, setImage) => {
				this.dragging = block.id;
				this.handle = element.closest<HTMLElement>('[data-edytor-block-handle-host]') ?? element;
				const group = (this.group = this.dragBlocks(block));
				// A ghost of the moved blocks as they look (Notion), cloned now and
				// removed with the drag library's container once the drag starts.
				const root = this.edytor.node;
				const nodes = group.flatMap((moved) => (moved.node ? [moved.node] : []));
				ghost(setImage, root, nodes, pointer);
				for (const [node, target] of this.targets) this.#registerDropTarget(node, target);
				this.#registerDropTarget(element.ownerDocument.body, null);
				this.scrolling?.();
				this.scrolling = root ? autoScrollFor(root, (data) => data.owner === this.owner) : null;
				this.indicator.begin(element.ownerDocument);
			},
			// The moved blocks show selected while they move (a text range becomes their
			// block selection); the drop's undo step restores the selection held before.
			start: () => {
				const { selectedBlocks, value } = this.edytor.selection;
				if (holdsBlocks(selectedBlocks, this.group)) return;
				this.held = value;
				this.select(block);
			},
			// Kept the shown placement and the targets until the target has
			// committed its move. A drop on one of ours gives the keys to the
			// editor (Notion: Mod+Z right after a drag), whatever it selected.
			end: (dropped) => {
				if (dropped) takeKeys(this.edytor);
				this.indicator.end();
				this.scrolling?.();
				this.scrolling = null;
				for (const off of this.registered.values()) off();
				this.registered.clear();
				this.dragging = null;
				this.handle = null;
				this.group = [];
				this.held = null;
			}
		});
	}

	/** A candidate drop target; registered at once when our drag is in progress. */
	addDropTarget(node: HTMLElement, target: Block) {
		if (!this.options.draggable) return () => {};
		this.targets.set(node, target);
		if (this.dragging) this.#registerDropTarget(node, target);
		return () => {
			if (this.targets.get(node) === target) this.targets.delete(node);
			this.registered.get(node)?.();
			this.registered.delete(node);
			if (this.indicator.target === node) this.indicator.clear();
		};
	}

	/**
	 * A block's drop target (`target`), or the page's (`body`, `null`): the
	 * editor's margins (Notion, `dnd.reach`), a drop target only where
	 * `margin` gives a placement — the handle column left of the blocks, the
	 * page margin past it and the one right of the content, up to the drop
	 * reach, within the editor's height — so a row is reached from outside it
	 * too, row after row; anywhere else the block targets (and their
	 * stickiness) stand, and a block target holding the pointer (its sticky
	 * slop) answers before the page.
	 */
	#registerDropTarget(node: HTMLElement, target: Block | null) {
		if (this.registered.has(node)) return;
		type Event = { location: DragLocation; source: { data: Record<string, unknown> } };
		const show = ({ location, source }: Event) => this.#showIndicator(node, location, source.data);
		const cleanup = dropTargetForElements({
			element: node,
			// A beside band counts: a row whose halves are both refused still takes it.
			// In the handle column a block (one reaching into it, a list item's
			// marker) hands the pointer to the page target, whose rule is the
			// row at the pointer's height (`margin`): never a placement held from
			// a row passed on the way.
			canDrop: ({ source, input }) => {
				const dragSource = this.#getDragSource(source.data);
				if (!dragSource) return false;
				const drag = this.#drag(dragSource);
				if (!target) return Boolean(this.drop.margin(drag, input));
				if (this.drop.inHandleColumn(input.clientX)) return false;
				const row = this.drop.rowAt(drag, target, node, input);
				const { before, after } = this.drop.zones(drag, row, input);
				return [...before, ...after].some(drag.fits) || Boolean(this.drop.beside(drag, row, input));
			},
			// The row at the pointer and the half of its own row (not its subtree's)
			// the pointer is in: held while the target is sticky (the drag library
			// keeps a sticky record's data).
			getData: ({ source, input }) => {
				const dragSource = this.#getDragSource(source.data);
				if (!target || !dragSource) return { [MARGIN]: true };
				const row = this.drop.rowAt(this.#drag(dragSource), target, node, input);
				const rect = ownRow(row.node!);
				return { [ROW]: row.id, [BEFORE]: input.clientY < rect.top + rect.height / 2 };
			},
			// Held while it or a target inside it holds the placement (the drag library
			// keeps an inner target only while every outer one of its chain sticks),
			// across a small gap beside the block — below the document's last block, all
			// the way down (Notion) — never over another block's own row (its parent's,
			// which the drag library would otherwise let it keep), nor over another column.
			getIsSticky: ({ source, input }) => {
				const active = this.indicator.target;
				if (!target || !this.#getDragSource(source.data) || !active || !node.contains(active))
					return false;
				const rect = node.getBoundingClientRect();
				return (
					input.clientX >= rect.left - SLOP_X &&
					input.clientX <= rect.right + SLOP_X &&
					input.clientY >= rect.top - SLOP_Y &&
					(input.clientY <= rect.bottom + SLOP_Y || endsDocument(target)) &&
					!this.drop.overOtherColumn(target, input.clientX) &&
					!overOtherRow(
						node,
						input,
						(over) => !this.edytor.idToBlock.get(over.dataset.edytorId ?? '')?.isContainer
					)
				);
			},
			onDragEnter: show,
			onDrag: show,
			// The target left hands the placement to the innermost one still current (an
			// outer target of its chain that sticks), before the next move asks it to stick.
			onDragLeave: ({ location, source }: Event) => {
				if (this.indicator.target !== node) return;
				this.indicator.clear();
				const [current] = location.current.dropTargets;
				if (current) this.#showIndicator(current.element as HTMLElement, location, source.data);
			},
			onDrop: ({ location, source }: Event) => {
				const [current] = location.current.dropTargets;
				if (current?.element !== node) return;
				const dragSource = this.#getDragSource(source.data);
				const placement =
					this.indicator.target === node && this.indicator.placement
						? this.indicator.placement
						: dragSource && this.placement(current, dragSource, location.current.input);
				this.indicator.clear();
				if (!dragSource || !placement) return;
				const { target, position } = placement;
				const request = { blocks: this.moving(dragSource), target, position };
				if (!this.edytor.canMove(request)) return;
				const moved = this.#moveAndSelect(request);
				if (moved.length && this.held) this.edytor.history.began(this.held);
			}
		});
		this.registered.set(node, cleanup);
	}

	/**
	 * Alt+arrow: one step for the blocks a drag of this handle moves. A text
	 * range over them stays, as Mod+Shift+arrow keeps it; else they end
	 * selected as after a drop (`#moveAndSelect`).
	 */
	#handleKeyDown(event: KeyboardEvent, block: Block) {
		const direction = event.altKey ? keyMoves[event.key] : undefined;
		if (this.edytor.readonly || !direction) return;
		event.preventDefault();
		event.stopPropagation();
		const request = { blocks: this.dragBlocks(block), direction };
		if (this.#covered(block)?.range) this.edytor.move(request);
		else this.#moveAndSelect(request);
	}

	/**
	 * Move, then select what moved — the drag's rule (`onDragStart`): a group
	 * the block selection holds keeps it (a moved block's selected children
	 * too); any other group ends selected alone.
	 */
	#moveAndSelect(request: BlockMoveRequest) {
		const { selectedBlocks } = this.edytor.selection;
		// A layout the selection covers whole counts as held: its blocks stay selected.
		const holds = holdsBlocks(selectedBlocks, request.blocks);
		const before = holds ? [...selectedBlocks] : [];
		const moved = this.edytor.move(request);
		if (moved.length) selectMoved(this.edytor, moved, before);
		return moved;
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
	 * resolver Tab and Turn into read; `range`), a code line as its code
	 * block (`movable`) — when `source` is one of them; else none.
	 */
	#covered(source: Block) {
		const { selectedBlocks, projection } = this.edytor.selection;
		const range = !selectedBlocks.size;
		if (range && projection.isCollapsed) return null;
		const covered = movable(range ? getSelectionBlocks(this.edytor) : selectedBlocks);
		return covered.includes(source) ? { covered, range } : null;
	}

	/** The blocks the selection covers when `source` is one of them, else `source` alone. */
	private covered = (source: Block) => this.#covered(source)?.covered ?? [source];

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
		const blocks = selection.selectedBlocks.size ? [source] : this.covered(source);
		selection.select(blockSelection(blocks.map((block) => block.id)));
	}

	/** The drag of `source`: the blocks it moves, and the placements the document takes for them. */
	#drag(source: Block): Drag {
		const group = this.moving(source);
		return {
			group,
			fits: ({ target, position }) => this.edytor.canMove({ blocks: group, target, position })
		};
	}

	/**
	 * The placement a drop target record offers: the page's margins
	 * (`margin`), else a beside band of the row first (`beside`; `false` when
	 * the document refuses it: nothing shows), else the row's halves, the one
	 * the record took first (held while the target is sticky), the pointer
	 * live.
	 */
	private placement(
		record: DropTargetRecord,
		source: Block,
		input: Input
	): DropPlacement | null | false {
		const drag = this.#drag(source);
		if (record.data[MARGIN]) return this.drop.margin(drag, input) ?? false;
		const row = this.edytor.idToBlock.get(record.data[ROW] as string);
		if (!row?.node) return null;
		return this.drop.at(drag, row, input, Boolean(record.data[BEFORE]));
	}

	/** The block our drag moves from (none in a read-only view). */
	#getDragSource(data: Record<string, unknown>) {
		if (data.owner !== this.owner || typeof data.blockId !== 'string' || this.edytor.readonly)
			return null;
		return this.edytor.idToBlock.get(data.blockId) ?? null;
	}

	#showIndicator(node: HTMLElement, location: DragLocation, data: Record<string, unknown>) {
		const [current] = location.current.dropTargets;
		if (current?.element !== node) return;
		const source = this.#getDragSource(data);
		const placement = source && this.placement(current, source, location.current.input);
		// A refused beside band shows nothing.
		if (placement === false) return this.indicator.clear();
		if (placement) this.indicator.show(node, placement);
	}
}
