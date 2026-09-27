// Delta helpers for the Text wrapper's JSON value (since R2 nothing renders
// from them; the components render cell deltas): the runs view already merges
// adjacent same-mark text, so a segment's text items map one-to-one onto JSON
// deltas without touching engine internals.
import type { JSONText, SerializableContent } from '../utils/json.ts';

export type Mark = [string, SerializableContent];
export type JSONDelta = {
	text: string;
	marks: Mark[];
	id: string;
};

export const deltaToJson = (delta: JSONDelta[]): JSONText[] => {
	return delta.map((d) => {
		const result: JSONText = {
			text: d.text,
			marks: Object.fromEntries(d.marks)
		};
		if (d.marks.length === 0) {
			delete result.marks;
		}
		return result;
	});
};

/**
 * Convert a text segment's run items into render deltas.
 * `items` are the `{kind:'text'}` entries of one logical text segment (the
 * runs between two inline atoms — or the whole content when no inline is
 * present). Adjacent same-mark items are already merged by the runs view;
 * the guard below keeps the contract total for unmerged item lists
 * (detached spec buffers, `project()` raw items).
 *
 * Returns `[deltas, isEmpty]` mirroring the historical `toDeltas` signature.
 */
export const runsToDeltas = (
	items: readonly {
		text: string;
		marks?: Record<string, unknown>;
	}[]
) => {
	const result: JSONDelta[] = [];
	let isEmpty = true;

	for (const item of items) {
		if (!item.text) continue;
		const marks = Object.entries(item.marks ?? {}) as Mark[];
		const last = result[result.length - 1];
		if (
			last &&
			last.marks.length === marks.length &&
			last.marks.every(([k, v]) => (item.marks as Record<string, unknown> | undefined)?.[k] === v)
		) {
			last.text += item.text;
		} else {
			result.push({
				text: item.text,
				marks,
				id: crypto.randomUUID()
			});
		}
		isEmpty = false;
	}

	return [result, isEmpty] as const;
};
