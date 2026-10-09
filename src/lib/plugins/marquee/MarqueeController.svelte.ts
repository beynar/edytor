/**
 * The marquee gesture of one view (`sel.marquee`, Notion's rubber band): a
 * press in the editor's empty area, then a drag past `threshold`, draws a
 * rectangle and selects, live, the blocks it meets (`marqueeBlocks`)
 * through the one selection writer (`selection.select`). The press reaches
 * it classified: the host's own area by `events/onFocus.ts`
 * (`pointer.marginPress`), the handle gutter and the app's container by the
 * plugin's `onPress` listeners. Between the press and the release it owns
 * the pointer's moves, the scroll that extends the rectangle, Escape, and
 * the browser's selection start (cancelled).
 */
import type { Edytor } from '$lib/edytor.svelte.js';
import type { SelectionValue } from '$lib/session/selection.js';
import { blockSelection, noSelection } from '$lib/session/selection.js';
import type { MarginPoint } from '$lib/selection/pointer.svelte.js';
import { takeKeys } from '$lib/events/onFocus.js';
import { marqueeBlocks, type MarqueeRect } from './marquee.js';

/** Within this distance (px) of the scroller's top or bottom edge, the page scrolls. */
const EDGE = 48;
/** The fastest auto-scroll, in px a frame: at the edge or past it. */
const SPEED = 24;

/** What a `box` snippet receives: the rectangle and what it selects (reactive). */
export type MarqueeBoxPayload = {
	/** The rectangle, in viewport (client) coordinates. */
	rect: DOMRectReadOnly;
	/** How many blocks are selected (the ones Shift or Mod kept included). */
	count: number;
	/** The selected blocks' ids, in the order the selection lists them. */
	ids: readonly string[];
	/** Shift or Mod was held at the press: the rectangle adds to the selection there was. */
	adding: boolean;
};

type Press = {
	/** The press point in the host's frame: it follows the host through every scroll. */
	x: number;
	y: number;
	point: MarginPoint;
	/** A press on the host's own area: its click is the host's (`marginClick`). */
	host: boolean;
	/** The selection before the press: Escape gives it back. */
	before: SelectionValue;
	/** The block ids Shift or Mod keeps. */
	base: readonly string[];
	off: (() => void)[];
};

const sameIds = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((id, i) => id === b[i]);

export class MarqueeController {
	/** The rectangle while the marquee shows (client coordinates), else `null` (reactive). */
	rect = $state.raw<DOMRectReadOnly | null>(null);
	/** The block ids the marquee selects (reactive). */
	ids = $state.raw<readonly string[]>([]);
	/** Shift or Mod was held at the press (reactive). */
	adding = $state(false);

	#press: Press | null = null;
	/** The drag passed the threshold: the rectangle shows. */
	#active = false;
	/** The pointer, in client coordinates. */
	#pointer = { x: 0, y: 0 };
	#frame: number | null = null;
	/** The editor's nearest scrolling ancestor (`null`: the page), read when the rectangle starts. */
	#scroller: Element | null = null;

	constructor(
		readonly edytor: Edytor,
		private readonly threshold: number
	) {}

	/** Whether a press is down that may still become (or is) a marquee. */
	get pressing() {
		return this.#press !== null;
	}

	/** What a `box` snippet receives. */
	get payload(): MarqueeBoxPayload | null {
		const { rect } = this;
		return rect && { rect, count: this.ids.length, ids: this.ids, adding: this.adding };
	}

	/**
	 * A primary press from a mouse or a pen, already classified as the
	 * editor's empty area (`host`: the host's own; else the handle gutter or
	 * the app's container). Answers whether the marquee took it.
	 */
	press = (event: MouseEvent, host: boolean): boolean => {
		const node = this.edytor.node;
		const document = node?.ownerDocument;
		const view = document?.defaultView;
		if (this.#press || !node || !document || !view || event.button !== 0) return false;
		if ((event as PointerEvent).pointerType === 'touch') return false;
		const box = node.getBoundingClientRect();
		const mod = this.edytor.keymap.isMac ? event.metaKey : event.ctrlKey;
		const adding = event.shiftKey || mod;
		const before = this.edytor.selection.value;
		const { clientX, clientY, shiftKey, altKey, metaKey, ctrlKey } = event;
		// The press is the marquee's: the browser starts no selection of its own and moves no focus.
		if (event.type === 'mousedown') event.preventDefault();
		const cancel = (event: Event) => event.preventDefault();
		const compat = (event: MouseEvent) => {
			if (event.button === 0) event.preventDefault();
		};
		const listen = <E extends Event>(
			target: EventTarget,
			type: string,
			listener: (event: E) => void,
			options: AddEventListenerOptions = {}
		) => {
			target.addEventListener(type, listener as EventListener, options);
			return () => target.removeEventListener(type, listener as EventListener, options);
		};
		this.#press = {
			x: clientX - box.left,
			y: clientY - box.top,
			point: { clientX, clientY, shiftKey, altKey, metaKey, ctrlKey },
			host,
			before,
			base: adding && before.kind === 'blocks' ? before.ids : [],
			// WebKit after a native drag sends a lone `mousedown` and may skip the
			// pointer events of the press: its mouse events end it too.
			off: [
				listen(document, 'pointermove', this.#moved, { capture: true }),
				listen(document, 'mousemove', this.#moved, { capture: true }),
				listen(document, 'pointerup', this.#released, { capture: true }),
				listen(document, 'mouseup', this.#released, { capture: true }),
				listen(document, 'pointercancel', this.cancel, { capture: true }),
				listen(document, 'mousedown', compat, { capture: true }),
				listen(document, 'selectstart', cancel, { capture: true }),
				listen(document, 'dragstart', cancel, { capture: true }),
				listen(document, 'scroll', this.#scrolled, { capture: true, passive: true }),
				listen(view, 'keydown', this.#key, { capture: true })
			]
		};
		this.#pointer = { x: clientX, y: clientY };
		this.adding = adding;
		return true;
	};

	#moved = (event: MouseEvent) => {
		const press = this.#press;
		if (!press) return;
		this.#pointer = { x: event.clientX, y: event.clientY };
		if (!this.#active) {
			const { clientX, clientY } = press.point;
			if (Math.hypot(event.clientX - clientX, event.clientY - clientY) < this.threshold) return;
			this.#active = true;
			this.#scroller = this.edytor.node ? scrollerOf(this.edytor.node) : null;
			// The editor takes the keys: Delete, Mod+C, Tab and the arrows act on the selection.
			takeKeys(this.edytor);
		}
		this.#update();
		this.#autoScroll();
	};

	/** The page scrolled under the drag: the rectangle keeps its start where it was in the page. */
	#scrolled = () => {
		if (this.#active) this.#update();
	};

	/** The rectangle from the press to the pointer, and the selection it makes. */
	#update = () => {
		const press = this.#press;
		const node = this.edytor.node;
		if (!press || !node) return;
		const box = node.getBoundingClientRect();
		const [x, y] = [box.left + press.x, box.top + press.y];
		const { x: px, y: py } = this.#pointer;
		const area: MarqueeRect = {
			left: Math.min(x, px),
			top: Math.min(y, py),
			right: Math.max(x, px, Math.min(x, px) + 1),
			bottom: Math.max(y, py, Math.min(y, py) + 1)
		};
		const base = new Set(press.base);
		const hits = marqueeBlocks(this.edytor, area).flatMap((block) =>
			base.has(block.id) ? [] : [block.id]
		);
		const ids = [...press.base, ...hits];
		this.rect = new DOMRectReadOnly(
			area.left,
			area.top,
			area.right - area.left,
			area.bottom - area.top
		);
		if (!sameIds(ids, this.ids)) {
			this.ids = ids;
			this.edytor.selection.select(ids.length ? blockSelection(ids) : noSelection);
		}
		this.edytor.overlay.invalidate();
	};

	/** The distance to scroll this frame (negative: up), from the pointer's place by the scroller's edges. */
	#step = (): { scroller: Element | null; by: number } | null => {
		const node = this.edytor.node;
		const view = node?.ownerDocument.defaultView;
		if (!node || !view) return null;
		const scroller = this.#scroller;
		const box = scroller?.getBoundingClientRect();
		const top = Math.max(box?.top ?? 0, 0);
		const bottom = Math.min(box?.bottom ?? view.innerHeight, view.innerHeight);
		const y = this.#pointer.y;
		const near = (distance: number) => Math.ceil(SPEED * Math.min(1, (EDGE - distance) / EDGE));
		const by = y < top + EDGE ? -near(y - top) : y > bottom - EDGE ? near(bottom - y) : 0;
		return by ? { scroller, by } : null;
	};

	/**
	 * Browser rule `marquee.auto-scroll` (one named frame loop): while the
	 * pointer is within `EDGE` of the scroller's top or bottom (the editor's
	 * nearest scrolling ancestor, else the page), it scrolls a step a frame,
	 * faster nearer the edge, and the rectangle extends with it. It stops
	 * when the pointer leaves the band, the scroller cannot go further, or
	 * the gesture ends.
	 */
	#autoScroll = () => {
		const view = this.edytor.node?.ownerDocument.defaultView;
		if (this.#frame !== null || !this.#active || !view?.requestAnimationFrame || !this.#step())
			return;
		this.#frame = view.requestAnimationFrame(() => {
			this.#frame = null;
			const step = this.#step();
			if (!step || !this.#active) return;
			const target = step.scroller ?? view.document.scrollingElement;
			if (!target) return;
			const before = target.scrollTop;
			target.scrollTop += step.by;
			// The scroller is at its end: the loop waits for the next move.
			if (target.scrollTop === before) return;
			this.#update();
			this.#autoScroll();
		});
	};

	#released = () => {
		const press = this.#press;
		if (!press) return;
		const click = !this.#active;
		this.#end();
		// A press released where it began is a click: the host's own (the trailing paragraph, a caret).
		if (click && press.host) this.edytor.selection.pointer.marginClick(press.point);
	};

	/** Escape: the selection from before the press comes back, and the gesture ends. */
	#key = (event: KeyboardEvent) => {
		if (event.key !== 'Escape' || !this.#press) return;
		event.preventDefault();
		event.stopPropagation();
		this.cancel();
	};

	/** End the gesture and give back the selection from before the press. */
	cancel = () => {
		const press = this.#press;
		if (!press) return;
		const active = this.#active;
		this.#end();
		if (active) this.edytor.selection.select(press.before);
	};

	#end = () => {
		const press = this.#press;
		this.#press = null;
		this.#active = false;
		press?.off.forEach((off) => off());
		if (this.#frame !== null)
			this.edytor.node?.ownerDocument.defaultView?.cancelAnimationFrame(this.#frame);
		this.#frame = null;
		this.rect = null;
		this.ids = [];
		this.adding = false;
		this.edytor.overlay.invalidate();
	};

	destroy = () => this.#end();
}

/** The editor's nearest ancestor that scrolls vertically, else `null` (the page). */
const scrollerOf = (node: HTMLElement): Element | null => {
	const view = node.ownerDocument.defaultView;
	const { body, documentElement } = node.ownerDocument;
	for (let at = node.parentElement; at && at !== body && at !== documentElement; ) {
		const { overflowY } = view!.getComputedStyle(at);
		if (/auto|scroll|overlay/.test(overflowY) && at.scrollHeight > at.clientHeight) return at;
		at = at.parentElement;
	}
	return null;
};
