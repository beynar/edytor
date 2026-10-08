/**
 * The adoption diff: the change between a text and what the
 * browser made of it is what lies between their common prefix and suffix —
 * everything else keeps its atoms (anchors, carets, marks, a peer's
 * concurrent insert). When the edge is ambiguous (a doubled letter, a
 * repeated word) the change slides to end where `caret` says: the offset in
 * `after` where the owning attempt expects the caret, else the DOM caret.
 * With no preference the change starts after the longest common prefix.
 */
export type TextChange = { at: number; remove: number; insert: string };

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

export const diffText = (
	before: string,
	after: string,
	caret = after.length
): TextChange | null => {
	if (before === after) return null;
	const min = Math.min(before.length, after.length);
	let from = 0;
	while (from < min && before.charCodeAt(from) === after.charCodeAt(from)) from++;
	let [toA, toB] = [before.length, after.length];
	while (toA > 0 && toB > 0 && before.charCodeAt(toA - 1) === after.charCodeAt(toB - 1)) {
		toA--;
		toB--;
	}
	if (Math.min(toA, toB) < from) {
		// A pure insertion or deletion inside a repeat: any start in
		// [lo, from] yields `after`; take the one ending at the caret.
		const size = Math.abs(after.length - before.length);
		const inserted = after.length > before.length ? size : 0;
		const lo = Math.min(toA, toB);
		let start = Math.max(lo, Math.min(from, caret - inserted));
		if (start > lo && isLowSurrogate(before.charCodeAt(start))) start--;
		[from, toA, toB] = [start, start + size - inserted, start + inserted];
	}
	return { at: from, remove: toA - from, insert: after.slice(from, toB) };
};
