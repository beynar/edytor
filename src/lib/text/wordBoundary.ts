/**
 * One semantic rule for word boundaries, shared by caret word jumps
 * (session/navigation.ts) and word deletion (beforeInputDeleteCommands.ts):
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
