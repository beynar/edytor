import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { takeKeys } from '$lib/events/onFocus.js';
import { stacks } from './stacking.js';

/** The guide line's width (the hover guide's and the drag's). */
export const GUIDE = 2;

/** A column's weight (D5): `data.width`, a positive number, else 1. */
export const weightOf = (data: Record<string, unknown> | undefined) => {
	const width = data?.width;
	return typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : 1;
};

/** A strip over the gap between the columns `left` and `right`, layer-relative. */
export type Strip = {
	left: string;
	right: string;
	x: number;
	top: number;
	width: number;
	height: number;
};

/** A strip being dragged: the two columns as the drag found them, in client px. */
type Drag = {
	strip: Strip;
	left: Block;
	right: Block;
	/** Where the pointer went down, and where it is. */
	from: number;
	at: number;
	/** The left column's width, the pair's, and the narrowest either may get. */
	width: number;
	sum: number;
	min: number;
	/** The left column's left edge and the gap after it. */
	start: number;
	gap: number;
	top: number;
	height: number;
};

/**
 * The column resize (docs/columns-plan.md D5, §5 "Resize"), chrome in the
 * overlay: while the pointer is over a layout (not readonly, not stacked),
 * a strip over each gap between two shown columns, the gap's width and the
 * layout's height, under the block handles (a shown handle takes the
 * pointer over its part of the gap; one not shown takes none); hovering it
 * shows a gray guide in the gap's middle (`--edytor-columns-resize-color`),
 * as Notion; dragging one shows the blue guide and writes nothing; the release writes the two
 * columns' `data.width` weights, keeping their sum, in one `edytor.transact`
 * (two `setData` commands: one undo step). Neither column goes under
 * `minWidth` × the layout's width, in the view only (the document stores
 * weights). Positions are read in the overlay's measure, once per frame.
 */
export class ColumnResize {
	/** The layout under the pointer. */
	hovered = $state<string | null>(null);
	/** A block drag is in progress: no strip takes the pointer. */
	dragging = $state(false);
	/** The measured strips of the hovered layout. */
	strips = $state<Strip[]>([]);
	/** The strip being dragged. */
	drag = $state<Drag | null>(null);
	/** The guide's layer-relative box while a strip drags. */
	guide = $state<{ x: number; top: number; height: number } | null>(null);
	/** The overlay host the strips live in (a pointer leaving the editor for it keeps them). */
	host: HTMLElement | null = null;

	constructor(
		private edytor: Edytor,
		private minWidth: number
	) {}

	/** Whether the strips show: over a layout of an editable view, or while one drags. */
	get shown() {
		return this.drag !== null || (!this.edytor.readonly && !this.dragging && !!this.hovered);
	}

	/** The pointer is over `target`: the layout holding it (the innermost), if any. */
	hover = (target: EventTarget | null) => {
		const { facade } = this.edytor;
		let layout: string | null = null;
		for (
			let node = (target as Element | null)?.closest?.<HTMLElement>('[data-edytor-block="true"]');
			node;
			node = node.parentElement?.closest<HTMLElement>('[data-edytor-block="true"]')
		) {
			const id = node.dataset.edytorId;
			if (id && facade.isLayout(id)) {
				layout = id;
				break;
			}
		}
		if (layout === this.hovered) return;
		this.hovered = layout;
		this.edytor.overlay.invalidate();
	};

	/** The pointer left for `to`: the strips stay while it is over them or the editor. */
	leave = (to: EventTarget | null) => {
		const node = to instanceof Node ? to : null;
		if (node && (this.host?.contains(node) || this.edytor.node?.contains(node))) return;
		this.hovered = null;
	};

	/** The overlay measure: the hovered layout's gaps, and the guide of a drag. */
	measure = (host: HTMLElement, origin: DOMRect) => {
		const strips = this.shown ? this.gaps(origin) : [];
		const drag = this.drag;
		const guide = drag && {
			x: drag.start + this.widthAt(drag) + drag.gap / 2 - GUIDE / 2 - origin.left,
			top: drag.top - origin.top,
			height: drag.height
		};
		return () => {
			// Layer-relative, as the rest of the overlay's chrome.
			Object.assign(host.style, { position: 'absolute', left: '0px', top: '0px' });
			if (!sameStrips(strips, this.strips)) this.strips = strips;
			this.guide = guide;
		};
	};

	/** The strips of the hovered layout: none when it stacks or shows fewer than two columns. */
	private gaps(origin: DOMRect): Strip[] {
		const id = this.drag?.left.parent?.id ?? this.hovered;
		const layout = id ? this.edytor.idToBlock.get(id) : undefined;
		const node = layout?.node;
		if (!layout || !node?.isConnected) return [];
		const box = node.getBoundingClientRect();
		if (stacks(box.width)) return [];
		const items = layout.children.flatMap((item) => {
			const rect = item.node?.getBoundingClientRect();
			return rect && rect.width > 0 ? [{ item, rect }] : [];
		});
		return items.slice(1).map(({ item, rect }, index) => {
			const before = items[index]!;
			return {
				left: before.item.id,
				right: item.id,
				x: before.rect.right - origin.left,
				top: box.top - origin.top,
				width: Math.max(0, rect.left - before.rect.right),
				height: box.height
			};
		});
	}

	/** The left column's width at the drag's pointer, held to the minimum on both sides. */
	private widthAt({ width, sum, min, from, at }: Drag) {
		const lo = Math.min(min, width);
		const hi = Math.max(sum - min, width);
		return Math.min(hi, Math.max(lo, width + at - from));
	}

	/** Press on `strip`: the drag starts, nothing is written until the release. */
	start = (event: PointerEvent, strip: Strip) => {
		const { edytor } = this;
		if (event.button !== 0 || edytor.readonly || this.drag) return;
		const left = edytor.idToBlock.get(strip.left);
		const right = edytor.idToBlock.get(strip.right);
		const layout = left?.parent;
		const [a, b, box] = [left, right, layout].map((block) => block?.node?.getBoundingClientRect());
		if (!left || !right || !a || !b || !box) return;
		event.preventDefault();
		event.stopPropagation();
		const target = event.currentTarget as HTMLElement | null;
		target?.setPointerCapture?.(event.pointerId);
		this.drag = {
			strip,
			left,
			right,
			from: event.clientX,
			at: event.clientX,
			width: a.width,
			sum: a.width + b.width,
			min: this.minWidth * box.width,
			start: a.left,
			gap: b.left - a.right,
			top: box.top,
			height: box.height
		};
		const document = target?.ownerDocument ?? edytor.node?.ownerDocument;
		const move = (moved: PointerEvent) => {
			if (!this.drag) return;
			this.drag.at = moved.clientX;
			edytor.overlay.invalidate();
		};
		const end = (ended: Event) => {
			document?.removeEventListener('pointermove', move);
			document?.removeEventListener('pointerup', end);
			document?.removeEventListener('pointercancel', end);
			document?.removeEventListener('keydown', escape, true);
			const drag = this.drag;
			this.drag = null;
			this.guide = null;
			edytor.overlay.invalidate();
			if (drag && ended.type === 'pointerup') {
				drag.at = (ended as PointerEvent).clientX;
				this.release(drag);
				// The editor holds the keys after the release (Notion: Mod+Z right after).
				takeKeys(edytor);
			}
		};
		const escape = (key: KeyboardEvent) => {
			if (key.key !== 'Escape') return;
			key.preventDefault();
			key.stopPropagation();
			end(key);
		};
		document?.addEventListener('pointermove', move);
		document?.addEventListener('pointerup', end);
		document?.addEventListener('pointercancel', end);
		document?.addEventListener('keydown', escape, true);
		edytor.overlay.invalidate();
	};

	/** The release: both weights, keeping their sum, one undo step; nothing when nothing moved. */
	private release(drag: Drag) {
		const width = this.widthAt(drag);
		const { left, right, sum } = drag;
		if (Math.abs(width - drag.width) < 0.5 || sum <= 0) return;
		if (!left.isInTree || !right.isInTree) return;
		const pair = weightOf(left.data) + weightOf(right.data);
		const weight = (pair * width) / sum;
		this.edytor.transact(() => {
			left.setData({ ...left.data, width: weight });
			right.setData({ ...right.data, width: pair - weight });
		});
	}
}

const sameStrips = (a: Strip[], b: Strip[]) =>
	a.length === b.length &&
	a.every(
		(strip, index) =>
			strip.left === b[index]!.left &&
			strip.right === b[index]!.right &&
			strip.x === b[index]!.x &&
			strip.top === b[index]!.top &&
			strip.width === b[index]!.width &&
			strip.height === b[index]!.height
	);
