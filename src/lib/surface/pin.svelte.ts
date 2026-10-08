/**
 * The IME host pin.
 *
 * While a composition session owns a text element, the renderer must never
 * rewrite or remount the node the IME is anchored to. The pin freezes, at the
 * session's start, the host cell's segment list (so a peer's atom inserted in
 * that block cannot re-key the composing segment) and the host segment's
 * render (the DOM the IME anchored to). While the browser draws the preview
 * itself the frozen render stays; a preview the model draws is spliced into
 * the frozen render without the replaced start target. Releasing the pin is
 * the one catch-up patch: the host cell renders from its current runs again.
 */
import type { BlockId } from '../crdt/index.js';
import {
	partsOf,
	renderDeltas,
	segmentDeltas,
	type Cell,
	type Part,
	type RenderDelta,
	type Segment,
	type TextTransform
} from './cells.js';

type Item = { text: string; marks?: Record<string, unknown> };
type Preview = { text: string; marks?: Record<string, unknown>; native: boolean };

type Held = {
	/** The host cell and its segment. */
	block: BlockId;
	key: string;
	/** The host cell's segment list at the start. */
	parts: readonly Part[];
	/** The host segment's render at the start, and whether it showed the empty filler. */
	frozen: RenderDelta[];
	empty: boolean;
	/** The frozen render before and after the start target (the preview goes between). */
	head: Item[];
	tail: Item[];
	/** What the first write merged in after the host's own text (a range across texts). */
	merged: Item[];
	/** `merged` is shown after the host element, not inside it (`merge`). */
	beside: boolean;
	/** The element the IME owns, and the session's preview (none before the first). */
	element: HTMLElement | null;
	preview: Preview | null;
};

const textOf = (items: readonly { text: string }[]) => items.map((item) => item.text).join('');

/** The items of `deltas` before and after unit `at`. */
const cut = (deltas: readonly RenderDelta[], at: number): [Item[], Item[]] => {
	const out: [Item[], Item[]] = [[], []];
	let pos = 0;
	for (const { text, marks } of deltas) {
		const item = marks.length ? { text, marks: Object.fromEntries(marks) } : { text };
		const k = Math.max(0, Math.min(text.length, at - pos));
		pos += text.length;
		if (k) out[0].push({ ...item, text: text.slice(0, k) });
		if (k < text.length) out[1].push({ ...item, text: text.slice(k) });
	}
	return out;
};

export class Pin {
	#held = $state.raw<Held | null>(null);

	/** Freeze `cell`'s segment list and the render of `segment`, without `[from, to)`. */
	acquire = (
		cell: Cell,
		segment: Segment,
		transform: TextTransform | undefined,
		from: number,
		to: number,
		element: HTMLElement | null
	) => {
		const frozen = segmentDeltas(cell, segment, transform);
		this.#held = {
			block: cell.id,
			key: segment.key,
			parts: partsOf(cell.runs),
			frozen,
			empty: segment.text === '',
			head: cut(frozen, from)[0],
			tail: cut(frozen, Math.max(from, to))[1],
			merged: [],
			beside: false,
			element,
			// Until the first preview the render stays as the IME found it: a
			// write now would collapse its DOM range before it replaces it.
			preview: null
		};
	};

	/** The session's preview (the browser draws it itself when `native`). */
	show = (text: string, marks: Record<string, unknown> | undefined, native: boolean) => {
		const held = this.#held;
		const set = marks && Object.entries(marks).filter(([, value]) => value != null);
		if (held)
			this.#held = { ...held, preview: { text, marks: set && Object.fromEntries(set), native } };
	};

	/**
	 * The first write replaced a range across texts: the host's
	 * cell lost the segments and atoms it covered, and the rest of its end text
	 * now follows the preview in the host, as its own nodes, so the IME's node
	 * is never rewritten. Across blocks they follow the frozen render inside the
	 * host element; inside one block (`beside`: across an inline atom) they go
	 * in their own element right after it (`rest`), as there the IME's write
	 * moves the host element's render anchors into the next segment's (Chromium).
	 */
	merge = (cell: Cell, items: Item[], beside: boolean) => {
		const held = this.#held;
		if (held) this.#held = { ...held, parts: partsOf(cell.runs), merged: items, beside };
	};

	/** The session ended: the host renders from its cell again (the catch-up patch). */
	release = () => (this.#held = null);

	/** `node` lies inside the pinned element. */
	owns = (node: Node | null | undefined) => Boolean(node && this.#held?.element?.contains(node));

	/** The segment list `cell` renders: frozen while it hosts the pin. */
	parts = (cell: Cell): readonly Part[] =>
		this.#held?.block === cell.id ? this.#held.parts : partsOf(cell.runs);

	/** The pinned render of segment `key` of `block`, or null when it is not the host. */
	render = (block: BlockId, key: string): { deltas: RenderDelta[]; empty: boolean } | null => {
		const held = this.#held;
		if (!held || held.block !== block || held.key !== key) return null;
		const { preview, head, tail, beside } = held;
		const merged = beside ? [] : held.merged;
		if (!preview || preview.native)
			return {
				deltas: [...held.frozen, ...renderDeltas(merged)],
				empty: held.empty && !textOf(merged)
			};
		const items = [...head, preview, ...tail, ...merged];
		return { deltas: renderDeltas(items), empty: !textOf(items) };
	};

	/** What follows the pinned segment `key` of `block` in its own element (`merge`, `beside`). */
	rest = (block: BlockId, key: string): RenderDelta[] => {
		const held = this.#held;
		const shown = held?.beside && held.block === block && held.key === key;
		return shown ? renderDeltas(held.merged) : [];
	};

	/**
	 * What the IME shows in the pinned element: its text between the frozen
	 * head and tail. None while the element still shows the start target
	 * untouched (no preview yet): that text is the document's, not the
	 * IME's.
	 */
	imeBuffer = (): string | null => {
		const held = this.#held;
		if (!held?.element) return null;
		const dom = (held.element.textContent ?? '').replace(/\u200B/g, '');
		if (!held.preview && dom === textOf(held.frozen)) return null;
		const inside = held.beside ? held.tail : [...held.tail, ...held.merged];
		const [head, tail] = [textOf(held.head), textOf(inside)];
		if (dom.length < head.length + tail.length) return null;
		return dom.startsWith(head) && dom.endsWith(tail)
			? dom.slice(head.length, dom.length - tail.length)
			: null;
	};
}
