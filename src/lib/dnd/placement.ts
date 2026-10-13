/**
 * Where a drop lands in a view (Notion's rules): the one resolution a block
 * handle's drag and a file dragged from outside both read, and the drop
 * indicator draws (`dropIndicator.ts`). A drag is what it carries
 * (`Drag`: the blocks it moves, none for files) and the placements the
 * document takes for it (`fits`); the rows are the view's drop targets
 * (`targetOf`). The block handles wire it to the drag library; a file drag
 * reads it from the host's own `dragover` (the media plugins' `plugins/fileDrop.ts`).
 */
import type { Block } from '$lib/block/block.svelte.js';
import type { BlockMovePosition } from '$lib/session/moves.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { HIDDEN, hidden } from '$lib/selection/visibility.js';
import type { DropIndicator } from './dropIndicator.js';
import {
	dropReach,
	getOwnRowBottom,
	isBeside,
	marginAt,
	nestIndent,
	overEmptyBody,
	ownRow,
	ownTextRow,
	type DropPlacement
} from './geometry.js';
import { stacks } from './stacking.js';

export type Input = { clientX: number; clientY: number };

/** What a drag carries: the blocks it moves (none for files), and whether a placement takes it. */
export type Drag = {
	group: readonly Block[];
	fits: (placement: DropPlacement) => boolean;
};

/** How far beside a target's box it stays the drop target (`getIsSticky`), across and along. */
export const SLOP_X = 20;
export const SLOP_Y = 24;
/** The right beside band: the row's last 15% (Notion), at least this many px. */
const RIGHT_BAND = 0.15;
const RIGHT_BAND_MIN = 32;
/** The handle column's width when the drag's handle cannot be measured (`+`, grip and gap). */
const HANDLE_COLUMN = 50;

/** Where a block's own text starts: its level's column. */
const column = (block: Block) => ownTextRow(block.node!).left;

/**
 * A block a drop may land at (a drop target): a movable block, not a
 * table's row (its row menus move it) nor a cell.
 */
export const isDropTarget = (edytor: Edytor, block: Block) =>
	block.movable && !edytor.facade.isTableRow(block.id);

type ResolverContext = {
	/** The drop target block of a block element, if it is one. */
	targetOf: (node: HTMLElement) => Block | undefined;
	/** The drag's handle (its width is the handle column's), if any. */
	handle: () => HTMLElement | null;
	/** The indicator showing the drag's placement (a margin's reorder holds while it shows). */
	indicator: DropIndicator;
};

export class DropResolver {
	constructor(
		private readonly edytor: Edytor,
		private readonly ctx: ResolverContext
	) {}

	targetOf = (node: HTMLElement) => this.ctx.targetOf(node);
	isTarget = (node: HTMLElement) => this.ctx.targetOf(node) !== undefined;

	/**
	 * The placement over `row` at the pointer: a beside band of the row first
	 * (`beside`; `false` when the document refuses it: nothing shows), else
	 * the row's halves, the top one first when `before` (the pointer's half,
	 * or the one a sticky target holds).
	 */
	at(drag: Drag, row: Block, input: Input, before: boolean): DropPlacement | null | false {
		const aside = this.beside(drag, row, input);
		if (aside !== undefined) return aside ?? false;
		const { before: top, after } = this.zones(drag, row, input);
		return this.pick(drag, before ? [top, after] : [after, top]);
	}

	/**
	 * The drop target under the pointer for a drag the host's own events see
	 * (a file's): the innermost target element at the point, `null` outside
	 * the blocks and in the handle column (the margins answer there,
	 * `margin`).
	 */
	hitAt(input: Input): HTMLElement | null {
		const root = this.edytor.node;
		if (!root || this.inHandleColumn(input.clientX)) return null;
		for (const hit of root.ownerDocument.elementsFromPoint?.(input.clientX, input.clientY) ?? [])
			for (
				let at = hit.closest<HTMLElement>('[data-edytor-block="true"]');
				at && root.contains(at);
				at = at.parentElement?.closest<HTMLElement>('[data-edytor-block="true"]') ?? null
			)
				if (this.isTarget(at)) return at;
		return null;
	}

	/** The placement over the row of drop target `node` at the pointer (`rowAt`, its own row's half: `at`). */
	over(drag: Drag, node: HTMLElement, input: Input): DropPlacement | null | false {
		const target = this.targetOf(node);
		if (!target) return null;
		const row = this.rowAt(drag, target, node, input);
		if (!row.node) return null;
		const rect = ownRow(row.node);
		return this.at(drag, row, input, input.clientY < rect.top + rect.height / 2);
	}

	/**
	 * The editor's content column (`start`…`end`, the root's content box:
	 * where its blocks' boxes start and end), the width of the handle column
	 * left of it (the drag's handle, measured: `+`, grip and the gap to the
	 * block) and how far the drag reaches past them (`dropReach`, the
	 * `--edytor-drop-reach` the root inherits).
	 */
	gutter(root: HTMLElement) {
		const style = root.ownerDocument.defaultView?.getComputedStyle(root);
		const rect = root.getBoundingClientRect();
		const px = (value: string | undefined) => parseFloat(value ?? '') || 0;
		const start = rect.left + root.clientLeft + px(style?.paddingLeft);
		const end = rect.right - px(style?.borderRightWidth) - px(style?.paddingRight);
		const width = this.ctx.handle()?.isConnected
			? this.ctx.handle()!.getBoundingClientRect().width
			: 0;
		return { start, end, handles: width > 0 ? width : HANDLE_COLUMN, reach: dropReach(style) };
	}

	/** Whether `x` is in the handle column left of the editor's blocks (`gutter`): the page target's. */
	inHandleColumn(x: number) {
		const root = this.edytor.node;
		return !!root && marginAt(x, this.gutter(root))?.zone === 'handles';
	}

	/**
	 * A placement in the editor's margins at the pointer (`dnd.reach`), within
	 * the editor's height, for the row the content's near edge shows at the
	 * pointer's height (`rowAt`: a nested block's own row; over a layout, the
	 * row of its first column on the left, of its last on the right, never
	 * another), by the zone the pointer is in (`marginAt`):
	 * - the handle column left of the blocks (`gutter`): that row's reorder
	 *   (`reorder`): a drag straight down the handles reorders, row after
	 *   row, gaps included (never a beside band);
	 * - the first `BESIDE_MARGIN` px past it on the left, and past the
	 *   content's right edge: the beside band of that side (`beside`, as if
	 *   the pointer were at that edge) when the document has a layout kind
	 *   and the row offers one (a refused band shows nothing);
	 * - elsewhere within the reach (and there without a band): the reorder,
	 *   on the left the handle column's, on the right the one the row's
	 *   right edge offers (its halves as just inside the content, so nothing
	 *   jumps as the pointer leaves it).
	 * `undefined` past the reach, above or below the editor, and inside the
	 * content (the blocks' own targets answer there).
	 */
	margin(drag: Drag, { clientX: x, clientY: y }: Input) {
		const root = this.edytor.node;
		if (!root) return undefined;
		const box = root.getBoundingClientRect();
		if (y < box.top || y > box.bottom) return undefined;
		const gutter = this.gutter(root);
		const zone = marginAt(x, gutter);
		if (!zone) return undefined;
		const right = zone.side === 'right';
		const band = zone.zone === 'beside' && this.layouts;
		const edge = right ? gutter.end - 1 : gutter.start + 1;
		const hits = root.ownerDocument.elementsFromPoint?.(edge, y) ?? [];
		const hit = hits.find((at) => {
			const block = at.closest<HTMLElement>('[data-edytor-block="true"]');
			return block && root.contains(block) && this.isTarget(block);
		});
		const node = hit?.closest<HTMLElement>('[data-edytor-block="true"]');
		const target = node && this.targetOf(node);
		// Between two rows where the margin reorders (a margin, a layout's
		// edge), the reorder shown stays, as a block's sticky slop keeps it.
		const shown = !band && this.ctx.indicator.target === root.ownerDocument.body;
		const held = shown ? this.ctx.indicator.placement : null;
		const stay = held && !isBeside(held.position) ? held : undefined;
		if (!node || !target) return stay;
		const { facade } = this.edytor;
		let row = this.rowAt(drag, target, node, { clientX: edge, clientY: y });
		// Over a layout's edge, its first or last column's row at that height.
		if (facade.isLayout(row.id)) {
			const items = row.children.filter((item) => item.node && this.isTarget(item.node));
			const rect = (right ? items.at(-1) : items[0])?.node?.getBoundingClientRect();
			if (!rect || rect.width === 0) return undefined;
			const inner = right ? rect.right - 1 : rect.left + 1;
			row = this.rowAt(drag, target, node, { clientX: inner, clientY: y });
		}
		if (facade.isLayout(row.id) || !row.node) return stay;
		if (band) {
			const aside = this.beside(
				drag,
				row,
				{ clientX: right ? Infinity : -Infinity, clientY: y },
				zone.side
			);
			// A band the document refuses shows nothing; a row offering none (a
			// nested row on the left, a layout that would stack) reorders.
			if (aside !== undefined) return aside ?? undefined;
		}
		const rect = ownRow(row.node);
		if (right) {
			const at = { clientX: Math.min(x, rect.right - 1), clientY: y };
			return this.pick(drag, this.halves(drag, row, at, rect)) ?? undefined;
		}
		return this.reorder(drag, row, { clientX: x, clientY: y }) ?? undefined;
	}

	/**
	 * The halves of `row` (`zones`) at the pointer, the one it is in first:
	 * the top half of `rect` (its own row by default) before, the bottom one
	 * after; with `plain`, only before or after a block — never inside one.
	 */
	halves(drag: Drag, row: Block, input: Input, rect: DOMRect, plain = false) {
		const zones = this.zones(drag, row, input);
		const [before, after] = [zones.before, zones.after].map((half) =>
			plain ? half.filter((placement) => placement.position !== 'inside') : half
		) as [DropPlacement[], DropPlacement[]];
		return input.clientY < rect.top + rect.height / 2 ? [before, after] : [after, before];
	}

	/**
	 * The first placement of `halves` the document takes (a refused one gives
	 * way to the next, then to the other half's), `blocked` when the first
	 * half took none; `null` when none fits.
	 */
	pick(drag: Drag, halves: DropPlacement[][]): DropPlacement | null {
		const fits = drag.fits;
		const placement = halves.flat().find(fits);
		return placement ? { ...placement, blocked: !halves[0]!.some(fits) } : null;
	}

	/**
	 * The handle column's reorder over `row` at the pointer: its plain halves
	 * (`halves`, the pointer's x picking the level); `null` when neither half
	 * fits. Over an item of a container the dragged blocks do not fit in (a
	 * paragraph over a list's item: the document refuses every placement at
	 * the item's level), the container is the row: its whole box, the upper
	 * half before it, the lower half after it (round 4), so a drag down the
	 * handles meets the list as one row it can pass.
	 */
	reorder(drag: Drag, row: Block, input: Input): DropPlacement | null {
		const fits = drag.fits;
		let halves = this.halves(drag, row, input, ownRow(row.node!), true);
		for (
			let at = row.parent;
			!halves[0]!.some(fits) && at?.node && !at.isRoot && at.isContainer;
			at = at.parent
		)
			halves = this.halves(drag, at, input, at.node.getBoundingClientRect(), true);
		return this.pick(drag, halves);
	}

	/**
	 * The block whose row the pointer is on over `node`: the last shown drop
	 * target in it whose row starts at or above the pointer (beside a nested
	 * block, over its ancestors' indent, the pointer is on that block's
	 * row), else `target`, over its own row (`emptied`). A layout's columns
	 * sit side by side: only the one under the pointer is measured (between
	 * two of them, the layout is the row: its gap).
	 */
	rowAt(drag: Drag, target: Block, node: HTMLElement, { clientX, clientY }: Input) {
		const lift = (row: Block) => this.emptied(drag, row);
		if (clientY < getOwnRowBottom(node)) return lift(target);
		const { facade } = this.edytor;
		let row = target;
		let aside: HTMLElement | null = null;
		// In document order, rows start lower and lower (within a column): measure
		// none below the pointer, none a closed toggle hides (each read would force
		// a layout), and nothing in a column the pointer is not over.
		for (const inner of node.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')) {
			if (aside?.contains(inner)) continue;
			const block = this.targetOf(inner);
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
	get layouts() {
		for (const definition of this.edytor.blocks.values()) if (definition.layout) return true;
		return false;
	}

	/**
	 * The block a beside placement over `block` stands beside: the document's
	 * own resolution (`facade.besideAt`, `placeBeside`'s): a list item's list,
	 * a code line's code block, a toggle's child itself, an item itself.
	 */
	besideOf(block: Block) {
		return this.edytor.idToBlock.get(this.edytor.facade.besideAt(block.id)) ?? block;
	}

	/** The item (and its layout) a beside placement at `outer` (`besideOf`) adds a column beside. */
	layoutOf(outer: Block) {
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
	overOtherColumn(block: Block, x: number) {
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
	beside(
		drag: Drag,
		row: Block,
		{ clientX: x, clientY: y }: Input,
		band?: 'left' | 'right'
	): DropPlacement | null | undefined {
		if (!row.node || !this.layouts) return undefined;
		if (this.carrier(drag, row)) return undefined;
		const { facade } = this.edytor;
		let placement: DropPlacement | undefined;
		if (facade.isLayout(row.id)) {
			const rect = row.node.getBoundingClientRect();
			if (y < rect.top || y > rect.bottom || stacks(rect.width)) return undefined;
			const items = row.children.filter((item) => item.node && this.isTarget(item.node));
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
		return drag.fits(placement) ? placement : null;
	}

	/** Where the editor's blocks start (`gutter`), or `fallback` without a host. */
	inside(fallback: number) {
		const root = this.edytor.node;
		return root ? this.gutter(root).start : fallback;
	}

	/** The children a block shows: none for a closed toggle's, or a container's items. */
	shown(block: Block) {
		return block.isContainer
			? []
			: block.children.filter((child) => child.node && this.isTarget(child.node) && !hidden(child));
	}

	/**
	 * Over a dragged block, the parent it leaves when that parent shows no
	 * other child: the gap under the parent's own row, which reparents as
	 * the parent's lower half does (`zones`). Else `row`.
	 */
	emptied(drag: Drag, row: Block) {
		const group = drag.group;
		const parent = this.carrier(drag, row)?.parent;
		if (!parent?.node || parent.isRoot || !this.isTarget(parent.node)) return row;
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
	 * its parent's shown children (`emptied`): that parent's row. Over the
	 * hint of the row's empty body (`body.hint`: an open toggle's, a
	 * callout's), inside it first, either half.
	 */
	zones(drag: Drag, row: Block, { clientX, clientY }: Input) {
		if (this.carrier(drag, row)) return { before: [], after: [] };
		const group = drag.group;
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
		if (overEmptyBody(row.node!, clientY))
			return { before: [...inside, ...before], after: [...inside, ...after] };
		const nests = clientX > column(row) + nestIndent(row.node!);
		return { before, after: nests ? [...inside, ...after] : [...after, ...inside] };
	}

	/** The dragged block that is `row` or holds it: its row offers nothing (it moves with the drag). */
	carrier(drag: Drag, row: Block) {
		return drag.group.find((moved) => moved === row || row.isChildOf(moved));
	}
}
