/**
 * What the chrome over a view's blocks shares (the table's grips and
 * bands, the column resize): its listeners on the host, the overlay and the
 * page, and a resize band's gesture.
 */
import type { Attachment } from 'svelte/attachments';
import type { Edytor } from '$lib/edytor.svelte.js';
import { trackDrag } from '$lib/dnd/track.js';
import { isLonePress, takeKeys } from '$lib/events/onFocus.js';

/** Listen for each of the space-separated `types` on `target`; answers the cleanup. */
export const listen = <E extends Event>(
	target: EventTarget | null | undefined,
	types: string,
	listener: (event: E) => void,
	capture = false
) => {
	const all = types.split(' ');
	for (const type of all) target?.addEventListener(type, listener as EventListener, capture);
	return () => {
		for (const type of all) target?.removeEventListener(type, listener as EventListener, capture);
	};
};

/**
 * The pointer over a view for its chrome: `over` hears it over the host,
 * `leave` it leaving the host or the overlay for `relatedTarget`, and
 * `drag` every drag starting (`dragstart`) or ending (`dragend`, `drop`)
 * in the page. Answers the cleanup.
 */
export const hoverChrome = (
	edytor: Edytor,
	node: HTMLElement,
	over: (target: EventTarget | null) => void,
	leave: (to: EventTarget | null) => void,
	drag: (event: Event) => void
) => {
	const out = (event: PointerEvent) => leave(event.relatedTarget);
	const offs = [
		listen(node, 'pointerover', (event) => over(event.target)),
		listen(node, 'pointerleave', out),
		listen(edytor.overlay.layer, 'pointerleave', out),
		listen(node.ownerDocument, 'dragstart dragend drop', drag, true)
	];
	return () => offs.forEach((off) => off());
};

/**
 * A resize band's gesture (a table column's, a layout gap's): a press
 * drags a view-only preview (`drag`, its `at` the pointer's x) and the
 * release writes once; Escape, a cancel or the view turning readonly
 * (`lock`) drop the preview, nothing written. A focused band's keys are its
 * own (`key`).
 */
export class BandDrag<D extends { at: number }> {
	/** The drag in progress. */
	drag = $state<D | null>(null);
	/** Ends the drag in progress without a write. */
	#cancel: (() => void) | null = null;

	constructor(private edytor: Edytor) {}

	/** A text selection is in progress (`selection.dragging`): the bands take no pointer. */
	get selecting() {
		return this.drag === null && this.edytor.selection.dragging;
	}

	/**
	 * A band's press (`{@attach band.press(start)}`): its `pointerdown`, or
	 * its lone `mousedown` (`isLonePress`: WebKit's first press after a
	 * block drag); no `mousedown` there starts a native selection.
	 */
	press =
		(start: (event: PointerEvent | MouseEvent) => void): Attachment<HTMLElement> =>
		(node) => {
			const offs = [
				listen(node, 'pointerdown', start),
				listen(node, 'mousedown', (event: MouseEvent) => {
					event.preventDefault();
					if (isLonePress(this.edytor, event)) start(event);
				})
			];
			return () => offs.forEach((off) => off());
		};

	/**
	 * Start `drag` from `event` (a primary press in an editable view, none in
	 * progress): `moved` hears each move, `end` the release (the drag at its
	 * x) or `null` when it ends without one.
	 */
	start(
		event: PointerEvent | MouseEvent,
		drag: D,
		end: (drag: D | null) => void,
		moved?: () => void
	) {
		if (event.button !== 0 || this.edytor.readonly || this.drag) return;
		this.drag = drag;
		this.#cancel = trackDrag(
			this.edytor,
			event,
			(x) => {
				if (!this.drag) return;
				this.drag.at = x;
				moved?.();
			},
			(x) => {
				const drag = this.drag;
				this.drag = null;
				this.#cancel = null;
				end(drag && x !== null ? { ...drag, at: x } : null);
			}
		);
	}

	/**
	 * The view turned readonly (or the document read-only): a drag in progress
	 * ends at once, its preview dropped, nothing written.
	 */
	lock = () => {
		if (this.drag && !this.edytor.dispatcher.permits()) this.#cancel?.();
	};

	/**
	 * A key on a focused band: every key there is the band's, never the
	 * editor's; Escape gives the keys back to the editor. The step `steps`
	 * gives the key, when one does and a write may start (no drag in progress).
	 */
	key(event: KeyboardEvent, steps: Record<string, number>): number | undefined {
		event.stopPropagation();
		if (event.key === 'Escape') {
			event.preventDefault();
			takeKeys(this.edytor);
			return;
		}
		const step = steps[event.key];
		if (step === undefined) return;
		event.preventDefault();
		return this.drag || !this.edytor.dispatcher.permits() ? undefined : step;
	}
}
