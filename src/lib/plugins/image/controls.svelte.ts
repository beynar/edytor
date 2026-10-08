import type { Edytor } from '$lib/edytor.svelte.js';
import { englishLabels, type ImageLabels } from '$lib/labels.js';
import { isLonePress, takeKeys } from '$lib/events/onFocus.js';
import {
	imageAlignOf,
	imageAltOf,
	imageWidthOf,
	MIN_IMAGE_WIDTH,
	type ImageAlign
} from './image.js';

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
	node?.querySelector<HTMLImageElement>(
		'[data-edytor-image]:not([data-edytor-image-uploading]) > img'
	) ?? null;

/**
 * The image chrome (WU-21, Notion's), in the overlay: on the image under
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
	/** The image whose alt field is open: the chrome stays on it. */
	editing = $state<string | null>(null);
	/** The measured box of the image the chrome is on. */
	box = $state<ImageBox | null>(null);
	/** The handle being dragged. */
	drag = $state<Drag | null>(null);
	/** The dragged image's width at the pointer (view only). */
	preview = $state.raw<{ id: string; width: number } | null>(null);
	/** Ends the drag in progress without a write. */
	#cancel: (() => void) | null = null;

	constructor(
		private edytor: Edytor,
		/** The words the chrome shows (the plugin's `labels`). */
		readonly labels: ImageLabels = englishLabels.image
	) {}

	/** The view is readonly (reactive). */
	get readonly() {
		return this.edytor.readonly;
	}

	/** A text selection is in progress: the chrome takes no pointer. */
	get selecting() {
		return this.drag === null && this.edytor.selection.dragging;
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
		return this.drag?.id ?? this.editing ?? this.hovered ?? this.selected;
	}

	/** Whether the chrome shows: over an image of an editable view, or while a handle drags. */
	get shown() {
		return this.box !== null && (this.drag !== null || !this.edytor.readonly);
	}

	/** An image's width as shown, in px: the drag's preview while a handle drags it, else `data.width`. */
	width = (id: string | undefined, data: Record<string, unknown> | undefined) =>
		(id !== undefined && this.preview?.id === id ? this.preview.width : undefined) ??
		imageWidthOf(data);

	/** The pointer is over `target`: the image block holding it, if any. */
	hover = (target: EventTarget | null) => {
		const frame = (target as Element | null)?.closest?.('[data-edytor-image]');
		const block = frame?.closest<HTMLElement>('[data-edytor-block="true"]');
		const id = block && imageOf(block) ? (block.dataset.edytorId ?? null) : null;
		if (id === this.hovered) return;
		this.hovered = id;
		this.edytor.overlay.invalidate();
	};

	/** The pointer left for `to`: the chrome stays while it is over the editor's overlay. */
	leave = (to: EventTarget | null) => {
		const node = to instanceof Node ? to : null;
		if (node && this.edytor.overlay.layer?.contains(node)) return;
		if (node && this.edytor.node?.contains(node)) return this.hover(node);
		this.hovered = null;
		this.edytor.overlay.invalidate();
	};

	/** The overlay measure: the target image's box. */
	measure = (host: HTMLElement, origin: DOMRect) => {
		const id = this.target;
		const block = id ? this.edytor.idToBlock.get(id) : undefined;
		const img = imageOf(block?.node);
		const rect = img?.isConnected ? img.getBoundingClientRect() : null;
		const box: ImageBox | null =
			id && block && rect
				? {
						id,
						x: rect.left - origin.left,
						y: rect.top - origin.top,
						width: rect.width,
						height: rect.height,
						align: imageAlignOf(block.data)
					}
				: null;
		return () => {
			// Layer-relative, as the rest of the overlay's chrome.
			Object.assign(host.style, { position: 'absolute', left: '0px', top: '0px' });
			if (!sameBox(box, this.box)) this.box = box;
			if (!box && this.editing === id) this.editing = null;
		};
	};

	/** Measure again in the overlay's next frame. */
	invalidate = () => this.edytor.overlay.invalidate();

	/** Set the target image's alignment: one `patchData` command. */
	align = (align: ImageAlign) => {
		const block = this.#block();
		if (block && imageAlignOf(block.data) !== align) block.data.align = align;
	};

	/** The target image's alt text. */
	get alt() {
		return imageAltOf(this.#block()?.data);
	}

	/** Write the alt text as it is typed: the dispatcher groups the keystrokes into one step. */
	setAlt = (alt: string) => {
		const block = this.#block();
		if (block && imageAltOf(block.data) !== alt) block.data.alt = alt;
	};

	/** Open (or close) the alt field of the target image. */
	toggleAlt = () => {
		this.editing = this.editing ? null : (this.box?.id ?? null);
		this.edytor.overlay.invalidate();
	};

	/**
	 * A press anywhere (`onPress`, capture): one outside the alt panel and the
	 * toolbar (whose Alt button toggles it) closes the field, so the chrome
	 * follows the pointer again.
	 */
	pressed = (event: MouseEvent) => {
		const target = event.target as Element | null;
		if (this.editing === null) return;
		if (target?.closest?.('[data-edytor-image-alt-panel], [data-edytor-image-toolbar]')) return;
		this.closeAlt();
	};

	/** Focus left the alt field: for somewhere outside its panel, the field closes. */
	blurred = (event: FocusEvent) => {
		const to = event.relatedTarget;
		const panel = (event.currentTarget as Element | null)?.closest('[data-edytor-image-alt-panel]');
		// No new focus (the window went to the background): the field stays.
		if (!(to instanceof Node) || panel?.contains(to)) return;
		this.closeAlt();
	};

	/** Close the alt field; with `keys`, the editor takes the keys back. */
	closeAlt = (keys = false) => {
		if (this.editing === null) return;
		this.editing = null;
		this.edytor.overlay.invalidate();
		if (keys) takeKeys(this.edytor);
	};

	#block = () => {
		const id = this.box?.id;
		const block = id ? this.edytor.idToBlock.get(id) : undefined;
		return block?.isInTree ? block : undefined;
	};

	/**
	 * A `mousedown` on a handle: no native selection starts there; the press
	 * itself when no `pointerdown` came before it (`isLonePress`: WebKit's
	 * first press after a drag), which starts the drag as one would.
	 */
	mousedown = (event: MouseEvent, side: Drag['side']) => {
		event.preventDefault();
		if (isLonePress(this.edytor, event)) this.start(event, side);
	};

	/**
	 * Press on a handle: the drag starts, nothing is written until the
	 * release. A `pointerdown` tracks its pointer (captured, on the document);
	 * a lone `mousedown` tracks the mouse on the window.
	 */
	start = (event: PointerEvent | MouseEvent, side: Drag['side']) => {
		const { edytor } = this;
		const box = this.box;
		if (event.button !== 0 || !edytor.dispatcher.permits() || this.drag || !box) return;
		const img = imageOf(edytor.idToBlock.get(box.id)?.node);
		const frame = img?.parentElement;
		if (!img || !frame) return;
		event.preventDefault();
		event.stopPropagation();
		const target = event.currentTarget as HTMLElement | null;
		const pointer = event.type === 'pointerdown';
		if (pointer) target?.setPointerCapture?.((event as PointerEvent).pointerId);
		this.drag = {
			id: box.id,
			side,
			from: event.clientX,
			at: event.clientX,
			width: img.getBoundingClientRect().width,
			max: frame.getBoundingClientRect().width,
			factor: box.align === 'center' ? 2 : 1
		};
		const document = target?.ownerDocument ?? edytor.node?.ownerDocument;
		const tracked = pointer ? document : document?.defaultView;
		const [moves, ups] = pointer ? ['pointermove', 'pointerup'] : ['mousemove', 'mouseup'];
		const move = (moved: MouseEvent) => {
			const drag = this.drag;
			if (!drag) return;
			if (!edytor.dispatcher.permits()) return end(moved);
			drag.at = moved.clientX;
			this.preview = { id: drag.id, width: widthAt(drag) };
			edytor.overlay.invalidate();
		};
		const end = (ended: Event) => {
			tracked?.removeEventListener(moves, move as EventListener);
			tracked?.removeEventListener(ups, end);
			tracked?.removeEventListener('pointercancel', end);
			document?.removeEventListener('keydown', escape, true);
			const drag = this.drag;
			this.drag = null;
			this.#cancel = null;
			edytor.overlay.invalidate();
			if (drag && ended.type === ups) {
				drag.at = (ended as MouseEvent).clientX;
				this.#release(drag);
				// The editor holds the keys after the release (Notion: Mod+Z right after).
				takeKeys(edytor);
			}
			// After the release's write: the stored width replaces the preview in one flush.
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

	/** The view turned readonly: a drag in progress ends at once, nothing written. */
	lock = () => {
		if (this.drag && !this.edytor.dispatcher.permits()) this.#cancel?.();
		this.editing = null;
	};

	/** The release: `data.width`, rounded to the px, one undo step; nothing when nothing moved. */
	#release(drag: Drag) {
		const block = this.edytor.idToBlock.get(drag.id);
		const width = Math.round(widthAt(drag));
		if (!block?.isInTree || Math.abs(widthAt(drag) - drag.width) < 1) return;
		if (imageWidthOf(block.data) !== width) block.data.width = width;
	}
}

/** The image's width at the drag's pointer, held between the minimum and its frame's width. */
const widthAt = ({ side, from, at, width, max, factor }: Drag) => {
	const lo = Math.min(MIN_IMAGE_WIDTH, width);
	const hi = Math.max(max, width);
	return Math.min(hi, Math.max(lo, width + (side === 'right' ? 1 : -1) * factor * (at - from)));
};

const sameBox = (a: ImageBox | null, b: ImageBox | null) =>
	a === b ||
	(a !== null &&
		b !== null &&
		a.id === b.id &&
		a.x === b.x &&
		a.y === b.y &&
		a.width === b.width &&
		a.height === b.height &&
		a.align === b.align);
