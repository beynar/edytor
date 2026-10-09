/**
 * The overlay (its geometry): chrome — block
 * handles, the drop indicator, menus, remote carets and range highlights —
 * lives in one layer next to the contenteditable host, never inside it.
 *
 * Chrome registers a measure; the overlay runs every measure once per frame,
 * and only when something moved the host's geometry: a commit, a resize of
 * the host, of a block near the viewport (`observe`: a layout change no
 * commit made, such as a font or a kind's markup that loads later) or of the
 * window, a scroll of any scroll container, a readonly change or a peer
 * change. Measures read layout first (with the layer's
 * origin, so positions are layer-relative and follow the host through page
 * and container scrolls) and return their writes, which run after every read.
 */
import { mount, unmount, type Component } from 'svelte';

/**
 * Whether the browser does not render `node`: an ancestor's
 * `content-visibility: auto` skips it off screen, or it is not
 * displayed. Its geometry is not computed — reading it would force a layout
 * of that subtree, every frame a measure asks — so measures read its nearest
 * rendered ancestor instead (`checkVisibility`; where it is missing, every
 * node counts as rendered).
 */
export const renderSkipped = (node: Element): boolean =>
	(
		node as Element & { checkVisibility?: (options: { contentVisibilityAuto: boolean }) => boolean }
	).checkVisibility?.({ contentVisibilityAuto: true }) === false;

/** `node`, or its nearest ancestor whose rendering the browser does not skip. */
export const rendered = (node: Element): Element => {
	let at: Element = node;
	while (at.parentElement !== null && renderSkipped(at)) at = at.parentElement;
	return at;
};

/** Reads layout with the layer's origin; returns the writes to apply after every read. */
export type Measure = (origin: DOMRect) => (() => void) | void;

/** The band around the viewport whose blocks' resizes are watched, in screens above and below. */
const WATCHED_SCREENS = 1;

export class Overlay {
	/** The layer: absolutely positioned at its static place right after the host. */
	layer: HTMLElement | null = null;
	#measures = new Set<Measure>();
	#frame: number | null = null;
	/** The block elements whose resizes invalidate (`observe`). */
	#observed = new Set<Element>();
	/** Of those, the host's children near the viewport the ResizeObserver watches (`#watch`). */
	#watched = new Set<Element>();
	#host: HTMLElement | null = null;
	#resize: ResizeObserver | null = null;

	/**
	 * Invalidate whenever `node` (a block's element) changes size: what lays the
	 * blocks out again with no commit, no scroll and no resize of the host — a
	 * font or a stylesheet that loads, a kind's markup drawn later (KaTeX, an
	 * image), a host whose height its page fixes — moves the blocks under the
	 * chrome. Watched while it is a top-level block near the viewport
	 * (`#watch`): a nested block's resize resizes its top-level block, and a
	 * block farther away moves no chrome in view (one above it scrolls the
	 * page, by scroll anchoring, or resizes the host). Answers the release.
	 */
	observe = (node: Element) => {
		this.#observed.add(node);
		this.invalidate();
		return () => {
			this.#observed.delete(node);
			if (this.#watched.delete(node)) this.#resize?.unobserve(node);
		};
	};

	/**
	 * Watch the observed top-level blocks within `WATCHED_SCREENS` of the
	 * viewport: a binary search over the host's children (vertical order),
	 * O(log n) boxes a frame where watching every block made each frame's
	 * resize check cost the whole page.
	 */
	#watch = () => {
		const host = this.#host;
		const resize = this.#resize;
		const view = host?.ownerDocument.defaultView;
		if (!host || !resize || !view) return;
		const kids = host.children;
		const screen = view.innerHeight;
		const search = (past: (rect: DOMRect) => boolean) => {
			let [lo, hi] = [0, kids.length];
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (past(kids[mid]!.getBoundingClientRect())) lo = mid + 1;
				else hi = mid;
			}
			return lo;
		};
		const first = search((rect) => rect.bottom < -WATCHED_SCREENS * screen);
		const last = search((rect) => rect.top <= (1 + WATCHED_SCREENS) * screen);
		const next = new Set<Element>();
		for (let i = first; i < last; i++) if (this.#observed.has(kids[i]!)) next.add(kids[i]!);
		for (const node of this.#watched)
			if (!next.has(node)) {
				this.#watched.delete(node);
				resize.unobserve(node);
			}
		for (const node of next)
			if (!this.#watched.has(node)) {
				this.#watched.add(node);
				resize.observe(node);
			}
	};

	/** Run `measure` on every invalidated frame, starting with the next one. */
	add = (measure: Measure) => {
		this.#measures.add(measure);
		this.invalidate();
		return () => void this.#measures.delete(measure);
	};

	/** Position the chrome in the next frame (once, however many invalidations). */
	invalidate = () => {
		const view = this.layer?.ownerDocument.defaultView;
		if (this.#frame !== null || !view) return;
		if (view.requestAnimationFrame) this.#frame = view.requestAnimationFrame(this.#run);
		else {
			this.#frame = 0;
			queueMicrotask(this.#run);
		}
	};

	#run = () => {
		this.#frame = null;
		const origin = this.layer?.getBoundingClientRect();
		if (!origin) return;
		this.#watch();
		const writes = Array.from(this.#measures, (measure) => measure(origin));
		for (const write of writes) write?.();
	};

	/**
	 * Mount `component` in a fixed host of the layer (`data-<name>`), placed by
	 * `measure` on every invalidated frame — a measure like any other: it reads
	 * (the host, the layer's origin) and returns the host's style writes.
	 * Answers the teardown.
	 */
	mount = <Props extends Record<string, unknown>>(
		component: Component<Props>,
		props: Props,
		name: string,
		zIndex: number,
		measure: (host: HTMLElement, origin: DOMRect) => (() => void) | void
	) => {
		const host = (this.layer?.ownerDocument ?? document).createElement('div');
		host.setAttribute(`data-${name}`, 'true');
		host.style.cssText = `position: fixed; z-index: ${zIndex}`;
		this.layer?.append(host);
		const instance = mount(component, { target: host, props });
		const off = this.add((origin) => measure(host, origin));
		return () => {
			off();
			void unmount(instance);
			host.remove();
		};
	};

	/**
	 * Create the layer after `host`; invalidated by resizes (the host's, its
	 * blocks', the window's) and by scrolls of any container.
	 */
	attach = (host: HTMLElement) => {
		const document = host.ownerDocument;
		const view = document.defaultView;
		const layer = document.createElement('div');
		layer.dataset.edytorOverlay = '';
		layer.style.cssText = 'position: absolute; width: 0; height: 0';
		host.after(layer);
		this.layer = layer;
		const resize =
			typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(this.invalidate);
		this.#resize = resize;
		this.#host = host;
		resize?.observe(host);
		document.addEventListener('scroll', this.invalidate, { capture: true, passive: true });
		view?.addEventListener('resize', this.invalidate);
		this.invalidate();
		return () => {
			resize?.disconnect();
			this.#watched.clear();
			if (this.#resize === resize) this.#resize = null;
			if (this.#host === host) this.#host = null;
			document.removeEventListener('scroll', this.invalidate, { capture: true });
			view?.removeEventListener('resize', this.invalidate);
			if (this.#frame) view?.cancelAnimationFrame?.(this.#frame);
			this.#frame = null;
			layer.remove();
			if (this.layer === layer) this.layer = null;
		};
	};
}
