/**
 * Bounded formatted range reads over a backing text, and the publication
 * boundary of what they emit (interned, frozen payloads).
 *
 * Reads go through the vendored `Y.RangeCursor` (fork patch YP5): it walks the live item
 * list with the same `readItemPieces` dispatch `toDelta` consumes and seeds
 * itself from the engine's search-marker checkpoints, so a read costs the
 * checkpoint gap plus the range. Emitted `marks` ALIAS the cursor's format
 * state: consumers treat them as read-only (the index interns them).
 */
import type { EngineNode } from '../engine-api.js';
import { ID, TYPE } from '../schema.js';
import { readData } from '../data.js';
import { isBoundary } from './items.js';
import type { RangeCursor, RangeItem, RangeReadStats } from './model.js';

/** Canonical JSON key (sorted keys, recursive) — mark-set equality/interning. */
export const canonKey = (v: unknown): string => {
	if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
	if (Array.isArray(v)) return `[${v.map(canonKey).join(',')}]`;
	const keys = Object.keys(v as Record<string, unknown>).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonKey((v as Record<string, unknown>)[k])}`).join(',')}}`;
};

const marksEqual = (
	a: Record<string, unknown> | undefined,
	b: Record<string, unknown> | undefined
): boolean => a === b || (a !== undefined && b !== undefined && canonKey(a) === canonKey(b));

/** Recursively freeze a JSON payload (the interners' canonical copies). */
export const deepFreeze = <T>(v: T): T => {
	if (v !== null && typeof v === 'object') {
		for (const k of Object.keys(v as Record<string, unknown>))
			deepFreeze((v as Record<string, unknown>)[k]);
		Object.freeze(v);
	}
	return v;
};

/**
 * Publication boundary for range-read items: a text item's `marks` can
 * alias the cursor's format state and an inline item's `data` IS the
 * replicated attr object, so each payload is swapped for `intern`'s frozen
 * canonical copy before it leaves the document layer.
 */
export const protectItems = (items: RangeItem[], intern: <T>(v: T) => T): RangeItem[] => {
	for (const item of items) {
		if (item.kind === 'text') {
			if (item.marks !== undefined) item.marks = intern(item.marks);
		} else if (item.data !== undefined) {
			item.data = intern(item.data);
		}
	}
	return items;
};

/** One inline-atom element → its `ContentItem` shape. */
export const inlineItemOf = (entry: unknown): RangeItem => {
	const node = entry as EngineNode;
	const data = readData(node);
	return {
		kind: 'inline',
		id: node.getAttr(ID) as string,
		type: node.getAttr(TYPE) as string,
		...(data === undefined ? {} : { data: data as Record<string, unknown> })
	};
};

/**
 * Read `[i0, i1)` through the cursor: text pieces as UTF-16 slices under their
 * folded marks (adjacent equal marks merge), inline atoms one item each.
 * Boundary items are skipped — the one read predicate stream ownership needs.
 */
export const readRange = (
	cur: RangeCursor,
	i0: number,
	i1: number,
	stats?: RangeReadStats,
	items: RangeItem[] = []
): RangeItem[] => {
	for (const piece of cur.read(i0, i1, stats)) {
		if (piece.deleted || piece.len === 0) continue;
		const c = piece.content;
		if (typeof c.str === 'string') {
			const marks = piece.formats;
			const slice = c.str.slice(piece.offset, piece.offset + piece.len);
			const last = items[items.length - 1];
			if (last !== undefined && last.kind === 'text' && marksEqual(last.marks, marks)) {
				(last as { text: string }).text += slice;
			} else {
				items.push({ kind: 'text', text: slice, ...(marks === undefined ? {} : { marks }) });
			}
		} else if (typeof c.getContent === 'function') {
			const arr = c.getContent();
			for (let k = piece.offset; k < piece.offset + piece.len; k++) {
				if (!isBoundary(arr[k])) items.push(inlineItemOf(arr[k]));
			}
		}
	}
	return items;
};
