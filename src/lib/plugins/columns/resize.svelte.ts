import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { pin } from '$lib/surface/overlay.js';
import { BandDrag, bandKey } from '../bands.svelte.js';
import { bandOf, gapBefore } from './gaps.js';
import { stacks } from '$lib/dnd/stacking.js';
import { columnsEnglish, labelsOf } from '$lib/labels.js';

/** The guide line's width (the hover guide's and the drag's). */
export const GUIDE = 2;

/** A column's weight: `data.width`, a positive number, else 1. */
export const weightOf = (data: Record<string, unknown> | undefined) => {
	const width = data?.width;
	return typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : 1;
};

/** The band's middle in a gap `width` px wide, from the gap's left. */
const middleOf = (width: number) => {
	const band = bandOf({ left: 0, right: width });
	return band.left + band.width / 2;
};

/** The resize band in the gap between the columns `left` and `right` (`bandOf`), layer-relative. */
export type Strip = {
	/** The layout, and the columns on each side. */
	layout: string;
	left: string;
	right: string;
	/** The left column's share of the pair's weights, in percent (`aria-valuenow`). */
	value: number;
	x: number;
	top: number;
	width: number;
	height: number;
};

/** A strip being dragged: the two columns as the drag found them, in client px. */
type Drag = {
	left: Block;
	right: Block;
	/** Where the pointer went down, and where it is. */
	from: number;
	at: number;
	/** The left column's width. */
	width: number;
	/** The layout's width, the pair's, and the narrowest either may get. */
	span: number;
	sum: number;
	min: number;
	/** The left column's left edge and the gap after it. */
	start: number;
	gap: number;
	top: number;
	height: number;
};

/**
 * The column resize (`docs/columns-plan.md`, "Resize"), chrome in the
 * overlay: while the pointer is over a layout (not readonly, not stacked),
 * a band in each gap between two shown columns (`bandOf`: `BAND` px centered
 * in the gap, the layout's height), above the block handles,
 * whose `+` and grip sit together flush with the block (`gaps.ts`, one
 * measurement):
 * wherever its gray guide shows (`--edytor-columns-resize-color`, Notion's,
 * at any height, block rows included), a press resizes. Dragging one
 * resizes both columns live (Notion) and writes nothing: the drag's weights
 * are a view-only preview (`preview`) the column kind's element reads
 * (`weight`), so only this view sees them and no peer gets a frame. The
 * release writes the two columns' `data.width` weights, keeping their sum,
 * in one `edytor.transact` (two `setData` commands: one undo step), and
 * drops the preview in the same flush; Escape, a cancel or the view turning
 * readonly drops it alone, at once (`band`).
 * Neither column goes under `minWidth` × the layout's width, in the view
 * only (the document stores weights). Positions are read in the overlay's
 * measure, once per frame.
 *
 * The keyboard (WAI-ARIA window splitter): a band is a focusable vertical
 * separator, valued by the left column's share of the pair; its arrows move
 * the gap (`key`). The bands of the layout holding the caret are in the
 * page too, so the keyboard reaches them, and a focused band stays while it
 * holds the focus.
 */
export class ColumnResize {
	/** The layout under the pointer. */
	hovered = $state<string | null>(null);
	/** The layout whose band holds the focus. */
	focused = $state<string | null>(null);
	/** A block drag is in progress: no strip takes the pointer. */
	dragging = $state(false);
	/** The measured strips of the hovered layout. */
	strips = $state.raw<Strip[]>([]);
	/** The strip's drag in progress (`band.drag`). */
	band: BandDrag<Drag>;
	/** The guide's layer-relative box while a strip drags. */
	guide = $state<{ x: number; top: number; height: number } | null>(null);
	/** The two dragged columns' weights at the pointer, by id, while a strip drags (view only). */
	preview = $state.raw<Readonly<Record<string, number>> | null>(null);

	constructor(
		private edytor: Edytor,
		private minWidth: number
	) {
		this.band = new BandDrag(edytor);
	}

	/** The words the bands say (the view's `columns` labels). */
	get labels() {
		return labelsOf(this.edytor, 'columns', columnsEnglish);
	}

	/** The view is readonly (reactive). */
	get readonly() {
		return this.edytor.readonly;
	}

	/**
	 * The layout whose bands show: the one a strip drags, else the one under
	 * the pointer, the one a band holds the focus of, the innermost one
	 * holding the selection's start (the keyboard's).
	 */
	get #layout(): string | null {
		const { facade, selection, idToBlock } = this.edytor;
		const layout = this.band.drag?.left.parent?.id ?? this.hovered ?? this.focused;
		if (layout) return layout;
		const start = selection.projection.start?.block;
		for (let at = start && idToBlock.get(start); at && !at.isRoot; at = at.parent)
			if (at.id && facade.isLayout(at.id)) return at.id;
		return null;
	}

	/** Whether the strips show: for a layout of an editable view, or while one drags. */
	get shown() {
		return this.band.drag !== null || (!this.edytor.readonly && !this.dragging && !!this.#layout);
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
			node && !layout;
			node = node.parentElement?.closest<HTMLElement>('[data-edytor-block="true"]')
		) {
			const id = node.dataset.edytorId;
			if (id && facade.isLayout(id)) layout = id;
		}
		if (layout === this.hovered) return;
		this.hovered = layout;
		this.edytor.overlay.invalidate();
	};

	/**
	 * The pointer left for `to`: the bands stay while it is over the editor
	 * or its overlay (a band, a column block's handle in the gap), or a strip drags.
	 */
	leave = (to: EventTarget | null) => {
		const node = to instanceof Node ? to : null;
		const { edytor } = this;
		if (
			this.band.drag ||
			(node && (edytor.overlay.layer?.contains(node) || edytor.node?.contains(node)))
		)
			return;
		this.hovered = null;
	};

	/** The overlay measure: the hovered layout's gaps, and the guide of a drag. */
	measure = (host: HTMLElement, origin: DOMRect) => {
		const strips = this.shown ? this.#gaps(origin) : [];
		const drag = this.band.drag;
		const guide = drag && {
			// Where the hover guide showed: the band's middle, the gap's (`bandOf`).
			x: drag.start + this.#widthAt(drag) + middleOf(drag.gap) - GUIDE / 2 - origin.left,
			top: drag.top - origin.top,
			height: drag.height
		};
		return () => {
			// Layer-relative, as the rest of the overlay's chrome.
			pin(host);
			if (JSON.stringify(strips) !== JSON.stringify(this.strips)) this.strips = strips;
			this.guide = guide;
		};
	};

	/** The bands of the hovered layout (`bandOf` each gap): none when it stacks or shows fewer than two columns. */
	#gaps(origin: DOMRect): Strip[] {
		const id = this.#layout;
		const layout = id ? this.edytor.idToBlock.get(id) : undefined;
		const box = layout?.node?.isConnected ? layout.node.getBoundingClientRect() : undefined;
		if (!layout || !box || stacks(box.width)) return [];
		const shown = layout.children.filter(
			(item) => (item.node?.getBoundingClientRect().width ?? 0) > 0
		);
		return shown.slice(1).flatMap((item, index) => {
			const gap = gapBefore(item);
			if (!gap) return [];
			const band = bandOf(gap);
			const before = shown[index]!;
			const [left, right] = [before, item].map((column) => this.weight(column.id, column.data));
			return [
				{
					layout: layout.id,
					left: before.id,
					right: item.id,
					value: Math.round((100 * left!) / (left! + right!)),
					x: band.left - origin.left,
					top: box.top - origin.top,
					width: band.width,
					height: box.height
				}
			];
		});
	}

	/** The left column's width at the drag's pointer, held to the minimum on both sides. */
	#widthAt({ width, sum, min, from, at }: Drag) {
		const lo = Math.min(min, width);
		const hi = Math.max(sum - min, width);
		return Math.min(hi, Math.max(lo, width + at - from));
	}

	/**
	 * Press on `strip` (`band.press`): the drag starts (`trackDrag`), nothing
	 * is written until the release.
	 */
	start = (event: PointerEvent | MouseEvent, strip: Strip) => {
		const pair = this.band.drag ? null : this.#pair(strip, event.clientX);
		if (!pair) return;
		this.band.start(
			event,
			pair,
			(drag) => {
				this.guide = null;
				if (drag) this.#release(drag);
				// After the release's write: the stored weights replace the preview in one flush.
				this.preview = null;
			},
			() => (this.preview = this.#weights(this.band.drag!))
		);
	};

	/** `strip`'s two columns as they are now, measured, a drag from `from`; `null` when one is gone. */
	#pair(strip: Strip, from: number): Drag | null {
		const left = this.edytor.idToBlock.get(strip.left);
		const right = this.edytor.idToBlock.get(strip.right);
		const [a, b, box] = [left, right, left?.parent].map((block) =>
			block?.node?.getBoundingClientRect()
		);
		if (!left || !right || !a || !b || !box) return null;
		return {
			left,
			right,
			from,
			at: from,
			width: a.width,
			span: box.width,
			sum: a.width + b.width,
			min: this.minWidth * box.width,
			start: a.left,
			gap: b.left - a.right,
			top: box.top,
			height: box.height
		};
	}

	/**
	 * A key on a focused band: ArrowRight/ArrowLeft move the gap by 1% of the
	 * layout's width (Shift: 10%), Home/End to the narrowest either column
	 * may get (the drag's minimum); each press writes both weights, keeping
	 * their sum, as one undo step (`#release`). Every key there is the band's,
	 * never the editor's; Escape gives the keys back to the editor.
	 */
	key = (event: KeyboardEvent, strip: Strip) => {
		const step = bandKey(this.edytor, this.band, event, {
			ArrowLeft: -1,
			ArrowRight: 1,
			Home: -Infinity,
			End: Infinity
		});
		const pair = step && this.#pair(strip, 0);
		if (!pair) return;
		pair.at = Number.isFinite(step) ? step! * (event.shiftKey ? 0.1 : 0.01) * pair.span : step!;
		this.#release(pair);
		this.edytor.overlay.invalidate();
	};

	/** A band took (`true`) or lost the focus: its layout's bands stay while it holds it. */
	focus = (strip: Strip, focused: boolean) => {
		this.focused = focused ? strip.layout : null;
		this.edytor.overlay.invalidate();
	};

	/** The two columns' weights at the drag's pointer, keeping their stored sum; `null` before it moved. */
	#weights(drag: Drag): Record<string, number> | null {
		const width = this.#widthAt(drag);
		const { left, right, sum } = drag;
		if (Math.abs(width - drag.width) < 0.5 || sum <= 0) return null;
		const pair = weightOf(left.data) + weightOf(right.data);
		const weight = (pair * width) / sum;
		return { [left.id]: weight, [right.id]: pair - weight };
	}

	/** The release: both weights, keeping their sum, one undo step; nothing when nothing moved. */
	#release(drag: Drag) {
		const weights = this.#weights(drag);
		const { left, right } = drag;
		if (!weights || !left.isInTree || !right.isInTree) return;
		this.edytor.transact(() => {
			for (const column of [left, right])
				this.edytor.patchData(column.id, [{ path: ['width'], value: weights[column.id]! }]);
		});
	}
}
