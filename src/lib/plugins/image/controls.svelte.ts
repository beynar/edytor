import type { Edytor } from '$lib/edytor.svelte.js';
import type { ImageToolbar } from './toolbar.svelte.js';
import { BandDrag } from '../bands.svelte.js';
import { layerBox, pin, sameValues } from '$lib/surface/overlay.js';
import { imageAlignOf, imageWidthOf, MIN_IMAGE_WIDTH, type ImageAlign } from './image.js';

/** The hovered image, layer-relative: the `img` box, and its frame's width (the most it may take). */
export type ImageBox = {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	align: ImageAlign;
};

/** A resize handle being dragged, in client px. */
type Drag = {
	id: string;
	side: 'left' | 'right';
	/** Where the pointer went down, and where it is. */
	from: number;
	at: number;
	/** The image's width at the press, and the widest it may get (its frame's). */
	width: number;
	max: number;
	/** A centered image grows on both sides: twice the pointer's move. */
	factor: number;
};

/** The image element of a shown image block (none while it uploads); an image holds no block. */
const imageOf = (node: Element | null | undefined) =>
	node?.querySelector<HTMLImageElement>('[data-edytor-image] > img') ?? null;

/**
 * The image chrome (Notion's), in the overlay: on the image under
 * the pointer of an editable view, a resize handle on each side and a
 * toolbar (alignment, alt text). Dragging a handle resizes the image live
 * and writes nothing: the width is a view-only preview the kind's snippet
 * reads (`width`), so only this view sees it and no peer gets a frame; the
 * release writes `data.width` (CSS px, one `patchData` command, one undo
 * step). A centered image grows on both sides (twice the pointer's move),
 * an image aligned left or right from the side the handle is on. It is
 * held between `MIN_IMAGE_WIDTH` and its block's width. Escape, a cancel or
 * the view turning readonly drop the preview at once. Positions are read in
 * the overlay's measure, once per frame.
 */
export class ImageControls {
	/** The image block under the pointer. */
	hovered = $state<string | null>(null);
	/** The image the toolbar holds (its alt field is open): the chrome stays on it. @internal */
	held = $state<string | null>(null);
	/** The measured box of the image the chrome is on. */
	box = $state<ImageBox | null>(null);
	/** The dragged image's width at the pointer (view only). @internal */
	preview = $state.raw<{ id: string; width: number } | null>(null);
	/** The handles' gesture (a resize band's: press, view-only preview, one write). @internal */
	readonly band: BandDrag<Drag>;

	/** The view's image toolbar, when its plugin is listed. @internal */
	toolbar: ImageToolbar | undefined;

	constructor(
		/** @internal */
		readonly edytor: Edytor
	) {
		this.band = new BandDrag(edytor);
	}

	/** The handle being dragged. */
	get drag() {
		return this.band.drag;
	}

	/** The view is readonly (reactive). */
	get readonly() {
		return this.edytor.readonly;
	}

	/** A text selection is in progress: the chrome takes no pointer. */
	get selecting() {
		return this.band.selecting;
	}

	/** The image block that is the whole block selection, if any (reactive): the keyboard's image. */
	get selected() {
		const value = this.edytor.selection.value;
		if (value.kind !== 'blocks' || value.ids.length !== 1) return null;
		const id = value.ids[0]!;
		return this.edytor.facade.blockTypeOf(id) === 'image' ? id : null;
	}

	/**
	 * The image the chrome is on: the dragged one, the one whose alt is
	 * edited, the hovered one, else the selected one (no pointer needed).
	 */
	get target() {
		return this.drag?.id ?? this.held ?? this.hovered ?? this.selected;
	}

	/** Whether the chrome shows: over an image of an editable view, or while a handle drags. */
	get shown() {
		return this.box !== null && (this.drag !== null || !this.edytor.readonly);
	}

	/** An image's width as shown, in px: the drag's preview while a handle drags it, else `data.width`. @internal */
	width = (id: string | undefined, data: Record<string, unknown> | undefined) =>
		(id !== undefined && this.preview?.id === id ? this.preview.width : undefined) ??
		imageWidthOf(data);

	/** The pointer is over `target`: the image block holding it, if any. @internal */
	hover = (target: EventTarget | null) => {
		const frame = (target as Element | null)?.closest?.('[data-edytor-image]');
		const block = frame?.closest<HTMLElement>('[data-edytor-block="true"]');
		const id = block && imageOf(block) ? (block.dataset.edytorId ?? null) : null;
		if (id === this.hovered) return;
		this.hovered = id;
		this.edytor.overlay.invalidate();
	};

	/** The pointer left for `to`: the chrome stays while it is over the editor's overlay. @internal */
	leave = (to: EventTarget | null) => {
		const node = to instanceof Node ? to : null;
		if (node && this.edytor.overlay.layer?.contains(node)) return;
		if (node && this.edytor.node?.contains(node)) return this.hover(node);
		this.hovered = null;
		this.edytor.overlay.invalidate();
	};

	/** The overlay measure: the target image's box. @internal */
	measure = (host: HTMLElement, origin: DOMRect) => {
		const id = this.target;
		const block = id ? this.edytor.idToBlock.get(id) : undefined;
		const rect = layerBox(imageOf(block?.node), origin);
		const box: ImageBox | null =
			id && block && rect ? { id, ...rect, align: imageAlignOf(block.data) } : null;
		return () => {
			// Layer-relative, as the rest of the overlay's chrome.
			pin(host);
			if (!sameValues(box, this.box)) this.box = box;
			if (!box && this.held === id) this.held = null;
		};
	};

	/** Measure again in the overlay's next frame. @internal */
	invalidate = () => this.edytor.overlay.invalidate();

	/**
	 * Press on a handle (`{@attach band.press(…)}`): the drag starts, nothing
	 * is written until the release.
	 * @internal
	 */
	start = (event: PointerEvent | MouseEvent, side: Drag['side']) => {
		const { edytor } = this;
		const box = this.box;
		if (!edytor.dispatcher.permits() || !box) return;
		const img = imageOf(edytor.idToBlock.get(box.id)?.node);
		const frame = img?.parentElement;
		if (!img || !frame) return;
		const drag: Drag = {
			id: box.id,
			side,
			from: event.clientX,
			at: event.clientX,
			width: img.getBoundingClientRect().width,
			max: frame.getBoundingClientRect().width,
			factor: box.align === 'center' ? 2 : 1
		};
		this.band.start(
			event,
			drag,
			(done) => {
				if (done) this.#release(done);
				// After the release's write: the stored width replaces the preview in one flush.
				this.preview = null;
			},
			() => {
				const moving = this.band.drag;
				if (moving) this.preview = { id: moving.id, width: widthAt(moving) };
			}
		);
	};

	/** The view turned readonly: a drag in progress ends at once, nothing written. @internal */
	lock = () => {
		this.band.lock();
		this.held = null;
	};

	/** The release: `data.width`, rounded to the px, one undo step; nothing when nothing moved. */
	#release(drag: Drag) {
		const block = this.edytor.idToBlock.get(drag.id);
		const width = Math.round(widthAt(drag));
		if (!block?.isInTree || Math.abs(widthAt(drag) - drag.width) < 1) return;
		if (imageWidthOf(block.data) !== width)
			block.edytor.patchData(block.id, [{ path: ['width'], value: width }]);
	}
}

/** The image's width at the drag's pointer, held between the minimum and its frame's width. */
const widthAt = ({ side, from, at, width, max, factor }: Drag) => {
	const lo = Math.min(MIN_IMAGE_WIDTH, width);
	const hi = Math.max(max, width);
	return Math.min(hi, Math.max(lo, width + (side === 'right' ? 1 : -1) * factor * (at - from)));
};

/** Each view's image chrome (the first image plugin listed claims it). */
export const imageControls = new WeakMap<object, ImageControls>();
