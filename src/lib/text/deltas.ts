// Delta helpers shared by the live Text wrapper and serialisation paths.
// `runsToDeltas` is the v14 replacement for the old `toDeltas(Y.Text)`: the
// maintained runs view already merges adjacent same-mark text, so a segment's
// text items map one-to-one onto JSON deltas without touching engine internals.
import type { JSONText, SerializableContent } from '../utils/json.ts';
import type { ContentRun } from '$lib/crdt/index.js';

export type Mark = [string, SerializableContent];
export type JSONDelta = {
	text: string;
	marks: Mark[];
	id: string;
};

export const jsonToDelta = (text: JSONText[]): JSONDelta[] => {
	return text.map((t) => ({
		text: t.text,
		marks: Object.entries(t.marks || {}),
		id: crypto.randomUUID()
	}));
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

/**
 * Merge adjacent deltas with identical marks for DOM rendering.
 *
 * The editing surface must emit ONE mark element per visual run — a
 * browser mutation inside a mark otherwise leaves adjacent same-mark
 * elements behind, and Svelte's expression diff skips unchanged
 * `{delta.text}` writes, duplicating text into the browser-mutated node
 * (the 'lead!!' reconcile regression).
 */
const renderMarksKey = (marks: readonly Mark[]): string =>
	marks.length === 0
		? ''
		: JSON.stringify(
				marks
					.filter(([, value]) => value !== undefined)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			);

export const mergeRenderDeltas = (deltas: readonly JSONDelta[]): JSONDelta[] => {
	const result: JSONDelta[] = [];
	for (const delta of deltas) {
		const last = result[result.length - 1];
		// Marks compare by canonical VALUE — a freshly-inserted run's marks
		// payload may be an equal-but-not-identical object to its neighbour's
		// interned instance (e.g. typing at a link boundary).
		if (last && renderMarksKey(last.marks) === renderMarksKey(delta.marks)) {
			last.text += delta.text;
			continue;
		}
		result.push({ ...delta, marks: [...delta.marks] });
	}
	return result;
};

/** Convenience overload for whole-run lists (filters to text runs). */
export const toDeltas = (
	runs: readonly (ContentRun | { text: string; marks?: Record<string, unknown> })[]
) => {
	const items = runs.filter(
		(run) =>
			(run as { kind?: string }).kind === undefined || (run as { kind?: string }).kind === 'text'
	) as { text: string; marks?: Record<string, unknown> }[];
	return runsToDeltas(items);
};
