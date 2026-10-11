/**
 * One semantic rule for grapheme and word boundaries, shared by caret jumps
 * (session/navigation.ts) and deletion (beforeInputDeleteCommands.ts): a
 * character at a caret is one grapheme (`Intl.Segmenter`);
 * a word is a run of Unicode letters, numbers, or `_`; whitespace and
 * punctuation are boundaries. When no word run remains in the direction,
 * the boundary is the boundary run's far edge — a trailing `· ` is still
 * consumed to the text end, matching platform word-delete. Offsets are
 * UTF-16; the patterns read code points, so a surrogate pair counts as one
 * character but keeps its two-unit width.
 *
 * The rule is deliberately text-local: callers decide the scope
 * (navigation traverses across texts/blocks, word deletion clamps to the
 * current Text).
 */

/** The last word before the end, and the boundary run after it. */
const BEFORE = /[\p{L}\p{N}_]+[^\p{L}\p{N}_]*$/u;
/** The boundary run from the start, and the first word after it. */
const AFTER = /^[^\p{L}\p{N}_]*[\p{L}\p{N}_]+/u;

export const getPreviousWordStartOffset = (value: string, offset: number) => {
	const head = value.slice(0, Math.max(0, offset));
	// Only a boundary run precedes the caret: its far edge is still a boundary.
	return BEFORE.exec(head)?.index ?? (head ? 0 : offset);
};

export const getNextWordEndOffset = (value: string, offset: number) => {
	const tail = value.slice(Math.max(0, offset));
	const word = AFTER.exec(tail);
	return word ? value.length - tail.length + word[0].length : tail ? value.length : offset;
};

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The offsets where `value`'s graphemes start, then its length. */
const graphemeEdges = (value: string): number[] => [
	...Array.from(graphemes.segment(value), (s) => s.index),
	value.length
];

const clamp = (value: string, offset: number) => Math.min(Math.max(offset, 0), value.length);

/** The start of the grapheme before `offset` (0 at the start). */
export const getPreviousGraphemeStart = (value: string, offset: number) =>
	graphemeEdges(value).findLast((edge) => edge < clamp(value, offset)) ?? 0;

/** The end of the grapheme after `offset` (`offset`, clamped, at the end). */
export const getNextGraphemeEnd = (value: string, offset: number) => {
	const at = clamp(value, offset);
	return graphemeEdges(value).find((edge) => edge > at) ?? at;
};
