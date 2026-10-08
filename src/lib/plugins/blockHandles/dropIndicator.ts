/**
 * The drop indicator of the block handles' drag (Notion): a 4px bar where
 * the blocks land (between rows, inside a block at its child column, or
 * beside a block or a column, vertical), and the nest backdrop over the
 * future parent's own row. Both live in the overlay layer, measured each
 * frame. The controller decides the placement; this draws it.
 */
import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import {
	getOwnRowBottom,
	isBeside,
	nestIndent,
	ownRow,
	ownTextRow,
	type DropPlacement
} from './geometry.js';

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

/** What the indicator reads of the controller: the dragged blocks and the beside resolution. */
type IndicatorContext = {
	group: () => readonly Block[];
	besideOf: (block: Block) => Block;
	layoutOf: (outer: Block) => { item: Block; layout: Block | null } | null;
};

export class DropIndicator {
	/** The drop target whose placement shows, and that placement. */
	target: HTMLElement | null = null;
	placement: DropPlacement | null = null;
	#node: HTMLElement | null = null;
	#overlay: HTMLElement | null = null;
	/** The indicator's measure in the overlay, while one is shown. */
	#off: (() => void) | null = null;
	/**
	 * The nest backdrop: one per drag, in the overlay; `data-shown` while the
	 * placement nests (it fades out in place, then goes with the drag).
	 */
	#backdrop: HTMLElement | null = null;

	constructor(
		private readonly edytor: Edytor,
		private readonly ctx: IndicatorContext
	) {}

	/** A drag starts: its backdrop, made now so it fades in. */
	begin = (document: Document) => {
		this.#backdrop?.remove();
		this.#backdrop = backdrop(document);
		this.edytor.overlay.layer?.prepend(this.#backdrop);
	};

	/** The drag ended: nothing shows. */
	end = () => {
		this.clear();
		this.#backdrop?.remove();
		this.#backdrop = null;
	};

	/** Show `placement` on drop target `node` (the same placement again only re-measures). */
	show = (node: HTMLElement, placement: DropPlacement) => {
		const shown = this.placement;
		if (
			this.target === node &&
			shown?.target === placement.target &&
			shown.position === placement.position &&
			shown.blocked === placement.blocked
		) {
			this.edytor.overlay.invalidate();
			return;
		}
		this.clear();
		this.target = node;
		this.placement = placement;
		this.#node = placement.node;
		placement.node.dataset.edytorBlockDropPosition = placement.position;
		this.#draw(placement);
	};

	#draw(placement: DropPlacement) {
		const document = placement.node.ownerDocument;
		const overlay = document.createElement('div');
		overlay.dataset.edytorDropIndicator = 'true';
		overlay.dataset.position = placement.position;
		if (placement.blocked) overlay.dataset.blocked = 'true';
		overlay.setAttribute('aria-hidden', 'true');
		const count = this.ctx.group().length;
		// How many blocks move, as data only: the bar shows no badge.
		if (count > 1) overlay.dataset.count = String(count);
		const color = document.defaultView
			?.getComputedStyle(placement.node)
			.getPropertyValue('--edytor-drop-indicator-color')
			.trim();
		overlay.style.setProperty('--edytor-drop-indicator-color', color || DROP_INDICATOR_COLOR);
		const layer = this.edytor.overlay.layer;
		layer?.append(overlay);
		this.#overlay = overlay;
		const measure = (origin: DOMRect) => {
			const writes = [this.#position(origin), this.#positionBackdrop(placement, origin)];
			return () => writes.forEach((write) => write?.());
		};
		// Placed at once (it must not show at the layer's origin for a frame), then per frame.
		if (layer) measure(layer.getBoundingClientRect())();
		this.#off = this.edytor.overlay.add(measure);
	}

	/**
	 * The block a placement makes the dragged blocks' parent when the drop
	 * nests them: for `inside`, the target, or the item a container nests
	 * them under (`nestParent`, as the move does); for before/after, the
	 * target's parent unless it already holds them all (a plain reorder) or
	 * is the root. A container shows no row of its own (a list): none.
	 */
	#nestParent({ target, position }: DropPlacement) {
		const { edytor } = this;
		const group = this.ctx.group();
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
	#positionBackdrop(placement: DropPlacement, origin: DOMRect) {
		const backdrop = this.#backdrop;
		if (!backdrop) return;
		const parent = this.#nestParent(placement);
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
	#position(origin: DOMRect) {
		const placement = this.placement;
		const overlay = this.#overlay;
		if (!placement || !overlay) return;
		if (isBeside(placement.position)) return this.#positionBeside(placement, origin);
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
	#positionBeside(placement: DropPlacement, origin: DOMRect) {
		const overlay = this.#overlay;
		const outer = this.ctx.besideOf(placement.target);
		if (!overlay || !outer.node) return;
		const right = placement.position === 'right';
		const at = this.ctx.layoutOf(outer);
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

	/** Hide the bar (the backdrop fades out where it was) and forget the placement. */
	clear = () => {
		if (this.#node) {
			delete this.#node.dataset.edytorBlockDropPosition;
			this.#node = null;
		}
		this.#off?.();
		this.#off = null;
		// Fades out where it was; the next nesting placement shows it again.
		if (this.#backdrop) delete this.#backdrop.dataset.shown;
		this.#overlay?.remove();
		this.#overlay = null;
		this.target = null;
		this.placement = null;
	};
}
