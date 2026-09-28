/**
 * The marks of an insertion (O29, §4.3 `session/editing/text`): ONE rule for
 * every path that inserts text — typing, soft break, IME commit, native
 * adoption, plain paste, programmatic `insertText`. Yjs v14 inserts
 * unformatted text unless every mark is named, so the editor always decides.
 *
 * explicit (the caller's own marks) → a replaced range's common marks →
 * pending marks (a caret fact, values kept) → the neighbour before, else
 * after → each mark record's edge policy (O69), which reads the admitted
 * edge side (R4) and never the DOM.
 */
import type { Text } from '$lib/text/text.svelte.js';
import { jsonEquals as same, type JSONText, type SerializableContent } from '$lib/utils/json.js';

/**
 * R4: at a collapsed caret, whether the DOM point lay inside the mark
 * elements rendering the character before it. Admitted by the DOM-point
 * interpreter; `undefined` (no DOM point, no mark before) reads as inside.
 */
export type EdgeSide = 'inside' | 'outside';
/** O69: whether a mark grows at its edges — always, never, or by the admitted side (trailing edge). */
export type MarkEdge = 'inclusive' | 'exclusive' | 'side-dependent';
export type Marks = Record<string, SerializableContent>;
/** Marks staged at a caret for the next insertion: the full set, values kept (`null` = off). */
export type PendingMarks = Record<string, SerializableContent | null>;

/** `marks` without its unset (`null`) entries. */
export const activeMarks = (marks?: PendingMarks | null): Marks =>
	Object.fromEntries(Object.entries(marks ?? {}).filter(([, value]) => value !== null)) as Marks;

/** The marks every non-empty part carries with one value. */
const commonMarks = (parts: JSONText[]): Marks => {
	const [first, ...rest] = parts.filter((part) => part.text.length > 0);
	return Object.fromEntries(
		Object.entries(activeMarks(first?.marks)).filter(([mark, value]) =>
			rest.every((part) => same(part.marks?.[mark], value))
		)
	);
};

/** The side the selection admitted for a caret at `text`/`offset`, if it sits there. */
export const admittedSide = (text: Text, offset: number): EdgeSide | undefined => {
	const state = text.edytor.selection.state;
	return state.isCollapsed && state.startText === text && state.yStart === offset
		? state.edge
		: undefined;
};

export const marksForInsertion = (
	text: Text,
	offset: number,
	{
		replaced,
		side = admittedSide(text, offset),
		pending
	}: { replaced?: JSONText[]; side?: EdgeSide; pending?: PendingMarks } = {}
): Marks => {
	if (replaced) return commonMarks(replaced);
	if (pending) return activeMarks(pending);
	const at = (start: number) =>
		start >= 0 && start < text.length
			? activeMarks(text.getMarksAtRange(start, start + 1)[0]?.marks)
			: {};
	const before = at(offset - 1);
	const after = at(offset);
	const fromBefore = Object.keys(before).length > 0;
	const [base, other] = fromBefore ? [before, after] : [after, before];
	return Object.fromEntries(
		Object.entries(base).filter(([mark, value]) => {
			const edge = text.edytor.marks.get(mark)?.edge ?? 'inclusive';
			if (edge === 'inclusive' || same(other[mark], value)) return true;
			// At an edge: an exclusive mark stops; a side-dependent one grows at
			// its leading edge and at its trailing edge only from inside.
			return edge === 'side-dependent' && (!fromBefore || side !== 'outside');
		})
	);
};
