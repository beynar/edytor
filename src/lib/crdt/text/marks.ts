/**
 * Paired marks in the document layer (H5, fork patch P13; contract rows
 * `mark.*` in `docs/editor-delete-contract.md`).
 *
 * A mark write is one operation: a start and an end item paired by the
 * operation's id, its value (`null`: the mark off over the range) and a
 * Lamport timestamp (`vendor/yjs/src/utils/marks.js`). A character shows,
 * per mark, the value of the open operation with the greatest timestamp,
 * so overlapping same-value marks union and a later write wins only where
 * it covers. Two comments never clip each other when each is its own mark
 * (`comment:<id>`: a key `name:<id>` takes the edge of the `name` record).
 *
 * The edge of a mark (its record's `edge`, adopted by the document as
 * semantics) decides where a concurrent insert at each end of an operation
 * lands, at integration: `inclusive` takes it in at both ends, `exclusive`
 * at neither, `side-dependent` at its start only (a peer typing after a
 * link stays out of it). A local insertion's marks stay `marksForInsertion`'s
 * (the view's one rule): the text is placed in its gap, then whatever its
 * placement shows that the rule did not ask for is written as operations
 * over the inserted text alone ({@link fitMarks}).
 *
 * Worker-safe: no view import.
 */
import type { EngineDoc, EngineNode } from '../engine-api.js';
import { jsonEquals } from '../../utils/json.js';

/** Whether a mark grows at its edges — always, never, or at its start only. */
export type MarkEdge = 'inclusive' | 'exclusive' | 'side-dependent';

/** The engine's sides (P13): `0` attaches an item to the content before it, `1` after. */
const LEFT = 0;
const RIGHT = 1;

const edges = new WeakMap<object, (mark: string) => MarkEdge | undefined>();

/** Register the document's mark edges (the facade does, from its adopted semantics). */
export const setMarkEdges = (doc: EngineDoc, edgeOf: (mark: string) => MarkEdge | undefined) =>
	void edges.set(doc as object, edgeOf);

/** The record a mark key names: `comment:c1` → `comment` (a key of its own otherwise). */
export const markName = (key: string): string => {
	const at = key.indexOf(':');
	return at > 0 ? key.slice(0, at) : key;
};

/** `mark`'s edge on `doc` (`inclusive` unless its semantics say otherwise). */
export const edgeOf = (doc: EngineDoc, mark: string): MarkEdge => {
	const of = edges.get(doc as object);
	return of?.(mark) ?? of?.(markName(mark)) ?? 'inclusive';
};

/**
 * The sides of `mark`'s start and end items: an expanding start attaches
 * left (a concurrent insert at it lands inside), a non-expanding one right;
 * an expanding end attaches right, a non-expanding one left.
 */
export const sidesOf = (doc: EngineDoc, mark: string): [number, number] => {
	const edge = edgeOf(doc, mark);
	if (edge === 'inclusive') return [LEFT, RIGHT];
	if (edge === 'exclusive') return [RIGHT, LEFT];
	return [LEFT, LEFT];
};

type MarkNode = EngineNode & {
	mark(index: number, length: number, mark: string, value: unknown, s: number, e: number): void;
	insertInGap(index: number, content: string | unknown[]): void;
};

/** Write one operation per entry of `marks` (`null`: off) over `[index, index + length)`. */
export const writeMarks = (
	doc: EngineDoc,
	text: EngineNode,
	index: number,
	length: number,
	marks: Record<string, unknown>,
	sides?: [number, number]
): void => {
	if (length <= 0) return;
	for (const [mark, value] of Object.entries(marks)) {
		const [s, e] = sides ?? sidesOf(doc, mark);
		(text as MarkNode).mark(index, length, mark, value ?? null, s, e);
	}
};

/**
 * Make `[index, index + length)` (one run, in one gap: its marks are the
 * same throughout) show exactly `want`: an operation for each mark whose
 * value there (`have`, read after the insert) differs. These operations
 * are the insertion's own, so they never grow (`exclusive` at both ends):
 * what a peer inserts beside the run concurrently keeps the marks of where
 * it lands.
 */
export const fitMarks = (
	doc: EngineDoc,
	text: EngineNode,
	index: number,
	length: number,
	have: Record<string, unknown> | undefined,
	want: Record<string, unknown> | undefined
): void => {
	const diff: Record<string, unknown> = {};
	for (const key of new Set([...Object.keys(have ?? {}), ...Object.keys(want ?? {})])) {
		const target = want?.[key] ?? null;
		if (!jsonEquals(have?.[key] ?? null, target)) diff[key] = target;
	}
	writeMarks(doc, text, index, length, diff, [RIGHT, LEFT]);
};

/**
 * Write the marks of `runs` (consecutive pieces of a text from `start`,
 * each `length` units with its `marks`) as operations: per mark, one per
 * stretch of consecutive runs with one value.
 */
export const writeRunMarks = (
	doc: EngineDoc,
	text: EngineNode,
	start: number,
	runs: readonly { length: number; marks?: Record<string, unknown> }[]
): void => {
	const keys = new Set(runs.flatMap((r) => Object.keys(r.marks ?? {})));
	for (const key of keys) {
		let at = start;
		let from = -1;
		let value: unknown = null;
		const flush = (end: number) => {
			if (from >= 0 && value !== null && value !== undefined)
				writeMarks(doc, text, from, end - from, { [key]: value });
			from = -1;
			value = null;
		};
		for (const run of runs) {
			const v = run.marks?.[key] ?? null;
			if (from < 0 || !jsonEquals(v, value)) {
				flush(at);
				if (v !== null) [from, value] = [at, v];
			}
			at += run.length;
		}
		flush(at);
	}
};
