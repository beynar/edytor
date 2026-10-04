import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { isLonePress, takeKeys } from '$lib/events/onFocus.js';
import { bandOf, gapBefore } from './gaps.js';
import { stacks } from './stacking.js';

/** The guide line's width (the hover guide's and the drag's). */
export const GUIDE = 2;

/** A column's weight (D5): `data.width`, a positive number, else 1. */
export const weightOf = (data: Record<string, unknown> | undefined) => {
	const width = data?.width;
	return typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : 1;
};

/** The resize band in the gap between the columns `left` and `right` (`bandOf`), layer-relative. */
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
 * a band in each gap between two shown columns (`bandOf`: the gap's left
 * `BAND` px, the layout's height), above the block handles, whose `+` and
 * grip sit together right of it, flush with the block (`gaps.ts`, one
 * measurement):
 * wherever its gray guide shows (`--edytor-columns-resize-color`, Notion's,
 * at any height, block rows included), a press resizes. Dragging one
 * resizes both columns live (Notion) and writes nothing: the drag's weights
 * are a view-only preview (`preview`) the column kind's element reads
 * (`weight`), so only this view sees them and no peer gets a frame. The
 * release writes the two columns' `data.width` weights, keeping their sum,
 * in one `edytor.transact` (two `setData` commands: one undo step), and
 * drops the preview in the same flush; Escape, a cancel or the view turning
 * readonly drops it alone, at once.
 * Neither column goes under `minWidth` × the layout's width, in the view
 * only (the document stores weights). Positions are read in the overlay's
 * measure, once per frame.
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
	/** Ends the drag in progress without a write (Escape, a cancel, the view turning readonly). */
	#cancel: (() => void) | null = null;
	/** The two dragged columns' weights at the pointer, by id, while a strip drags (view only). */
	preview = $state.raw<Readonly<Record<string, number>> | null>(null);

	constructor(
		private edytor: Edytor,
		private minWidth: number
	) {}

	/** The view is readonly (reactive). */
	get readonly() {
		return this.edytor.readonly;
	}

	/** A text selection is in progress (`selection.dragging`): the strips take no pointer. */
	get selecting() {
		return this.drag === null && this.edytor.selection.dragging;
	}

	/** Whether the strips show: over a layout of an editable view, or while one drags. */
	get shown() {
		return this.drag !== null || (!this.edytor.readonly && !this.dragging && !!this.hovered);
	}

	/** A column's weight as shown: the drag's preview while a strip drags it, else its stored one. */
	weight = (id: string | undefined, data: Record<string, unknown> | undefined) =>
		(id === undefined ? undefined : this.preview?.[id]) ?? weightOf(data);

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

	/**
	 * The pointer left for `to`: the bands stay while it is over the editor
	 * or its overlay (a band, a column block's handle in the gap).
	 */
	leave = (to: EventTarget | null) => {
		const node = to instanceof Node ? to : null;
		const { edytor } = this;
		if (node && (edytor.overlay.layer?.contains(node) || edytor.node?.contains(node))) return;
		this.hovered = null;
	};

	/** The overlay measure: the hovered layout's gaps, and the guide of a drag. */
	measure = (host: HTMLElement, origin: DOMRect) => {
		const strips = this.shown ? this.gaps(origin) : [];
		const drag = this.drag;
		const guide = drag && {
			// Where the hover guide showed: the band's middle, never the gap's (it would jump onto the `+`).
			x:
				drag.start +
				this.widthAt(drag) +
				bandOf({ left: 0, right: drag.gap }).width / 2 -
				GUIDE / 2 -
				origin.left,
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

	/** The bands of the hovered layout (`bandOf` each gap): none when it stacks or shows fewer than two columns. */
	private gaps(origin: DOMRect): Strip[] {
		const id = this.drag?.left.parent?.id ?? this.hovered;
		const layout = id ? this.edytor.idToBlock.get(id) : undefined;
		const node = layout?.node;
		if (!layout || !node?.isConnected) return [];
		const box = node.getBoundingClientRect();
		if (stacks(box.width)) return [];
		const shown = layout.children.filter(
			(item) => (item.node?.getBoundingClientRect().width ?? 0) > 0
		);
		return shown.slice(1).flatMap((item, index) => {
			const gap = gapBefore(item);
			if (!gap) return [];
			const band = bandOf(gap);
			return [
				{
					left: shown[index]!.id,
					right: item.id,
					x: band.left - origin.left,
					top: box.top - origin.top,
					width: band.width,
					height: box.height
				}
			];
		});
	}

	/** The left column's width at the drag's pointer, held to the minimum on both sides. */
	private widthAt({ width, sum, min, from, at }: Drag) {
		const lo = Math.min(min, width);
		const hi = Math.max(sum - min, width);
		return Math.min(hi, Math.max(lo, width + at - from));
	}

	/**
	 * A `mousedown` on `strip`: no native selection starts there; the press
	 * itself when no `pointerdown` came before it (`isLonePress`: WebKit's
	 * first press after a block drag), which starts the drag as one would.
	 */
	mousedown = (event: MouseEvent, strip: Strip) => {
		event.preventDefault();
		if (isLonePress(this.edytor, event)) this.start(event, strip);
	};

	/**
	 * Press on `strip`: the drag starts, nothing is written until the release.
	 * A `pointerdown` tracks its pointer (captured, on the document); a lone
	 * `mousedown` (`mousedown`) tracks the mouse on the window, its
	 * `mousemove`s and its `mouseup`, with the same preview, minimum, Escape
	 * and release.
	 */
	start = (event: PointerEvent | MouseEvent, strip: Strip) => {
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
		const pointer = event.type === 'pointerdown';
		if (pointer) target?.setPointerCapture?.((event as PointerEvent).pointerId);
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
		const tracked = pointer ? document : document?.defaultView;
		const [moves, ups] = pointer ? ['pointermove', 'pointerup'] : ['mousemove', 'mouseup'];
		const move = (moved: MouseEvent) => {
			if (!this.drag) return;
			if (!edytor.dispatcher.permits()) return end(moved);
			this.drag.at = moved.clientX;
			this.preview = this.weights(this.drag);
			edytor.overlay.invalidate();
		};
		const end = (ended: Event) => {
			tracked?.removeEventListener(moves, move as EventListener);
			tracked?.removeEventListener(ups, end);
			tracked?.removeEventListener('pointercancel', end);
			document?.removeEventListener('keydown', escape, true);
			const drag = this.drag;
			this.drag = null;
			this.guide = null;
			this.#cancel = null;
			edytor.overlay.invalidate();
			if (drag && ended.type === ups) {
				drag.at = (ended as MouseEvent).clientX;
				this.release(drag);
				// The editor holds the keys after the release (Notion: Mod+Z right after).
				takeKeys(edytor);
			}
			// After the release's write: the stored weights replace the preview in one flush.
			this.preview = null;
		};
		const escape = (key: KeyboardEvent) => {
			if (key.key !== 'Escape') return;
			key.preventDefault();
			key.stopPropagation();
			end(key);
		};
		this.#cancel = () => end(new Event('cancel'));
		tracked?.addEventListener(moves, move as EventListener);
		tracked?.addEventListener(ups, end);
		if (pointer) tracked?.addEventListener('pointercancel', end);
		document?.addEventListener('keydown', escape, true);
		edytor.overlay.invalidate();
	};

	/**
	 * The view turned readonly (or the document read-only): a drag in progress
	 * ends at once, its preview dropped, nothing written (its release would be
	 * refused anyway). Called by the strips' component when `readonly` flips.
	 */
	lock = () => {
		if (this.drag && !this.edytor.dispatcher.permits()) this.#cancel?.();
	};

	/** The two columns' weights at the drag's pointer, keeping their stored sum; `null` before it moved. */
	private weights(drag: Drag): Record<string, number> | null {
		const width = this.widthAt(drag);
		const { left, right, sum } = drag;
		if (Math.abs(width - drag.width) < 0.5 || sum <= 0) return null;
		const pair = weightOf(left.data) + weightOf(right.data);
		const weight = (pair * width) / sum;
		return { [left.id]: weight, [right.id]: pair - weight };
	}

	/** The release: both weights, keeping their sum, one undo step; nothing when nothing moved. */
	private release(drag: Drag) {
		const weights = this.weights(drag);
		const { left, right } = drag;
		if (!weights || !left.isInTree || !right.isInTree) return;
		this.edytor.transact(() => {
			left.setData({ ...left.data, width: weights[left.id]! });
			right.setData({ ...right.data, width: weights[right.id]! });
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
