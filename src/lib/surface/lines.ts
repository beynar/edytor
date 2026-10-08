/**
 * Line boxes (a Surface fact): where a caret shows, and whether two carets
 * show on one line. The one measurement the vertical keys read: a table
 * cell's edge lines (`table.keys`) and the last line of the document's last
 * stop (`nav.trailing.exit`, through `edytor.ports.surface.sameLine`).
 * Where nothing is laid out (a server, jsdom) there is no box: the callers
 * read the text's line breaks instead.
 */
import type { Text } from '$lib/text/text.svelte.js';
import { domPointOf } from './projector.svelte.js';

/**
 * The box of the caret at `offset` in `text`, read from the character after
 * it (`after`: its left edge) or the one before it (its right edge), the
 * other one where there is none; `null` where nothing is laid out (no layout
 * engine). An offset where a line wraps is on both lines: `after` reads it
 * on the later one, `before` on the earlier one.
 */
export const caretBox = (text: Text, offset: number, after: boolean): DOMRect | null => {
	const element = text.node;
	if (!element) return null;
	const range = element.ownerDocument.createRange();
	const box = (from: number): DOMRect | null => {
		if (from < 0 || from >= text.stringContent.length) return null;
		const [startNode, start] = domPointOf(element, from);
		const [endNode, end] = domPointOf(element, from + 1);
		range.setStart(startNode, start);
		range.setEnd(endNode, end);
		// No layout engine (a server, jsdom) lays nothing out: no box.
		const list = typeof range.getClientRects === 'function' ? range.getClientRects() : null;
		return [...(list ?? [])].find((r) => r.width > 0 || r.height > 0) ?? null;
	};
	const next = box(offset);
	const previous = box(offset - 1);
	const edge = (r: DOMRect, right: boolean) =>
		new DOMRect(right ? r.right : r.left, r.top, 0, r.height);
	if (after) return next ? edge(next, false) : previous && edge(previous, true);
	return previous ? edge(previous, true) : next && edge(next, false);
};

/** `a` and `b` are on one line box: their vertical middles are within half a line of each other. */
export const sameLine = (a: DOMRect, b: DOMRect) =>
	Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) < Math.max(a.height, b.height) / 2;

/**
 * Whether the carets `a` and `b` show on one line box, each read on the
 * earlier line where it wraps (an offset where a line wraps counts on the
 * line it ends); `null` where either has no box (nothing laid out, an empty
 * text).
 */
export const onOneLine = (
	a: { text: Text; offset: number },
	b: { text: Text; offset: number }
): boolean | null => {
	const [x, y] = [caretBox(a.text, a.offset, false), caretBox(b.text, b.offset, false)];
	return x && y ? sameLine(x, y) : null;
};
