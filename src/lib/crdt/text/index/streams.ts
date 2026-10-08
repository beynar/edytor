/**
 * The stream table: one maintained row per backing text, the
 * delimiting boundary of each block, and each block's segment.
 */
import type { BlockId } from '../../placement/model.js';
import { type Stream, byId, scanText } from '../model.js';
import {
	type LiveRow,
	headOf,
	placeRow,
	rowOf,
	segmentAt,
	segmentOfCut,
	streamOfSegment
} from '../rows.js';
import type { IndexState, Placed } from './state.js';

/** The stream table of one doc's index, over its state. */
export const indexStreams = (ix: IndexState) => {
	const {
		blocks,
		listConsumers,
		rows,
		streamIx,
		placed,
		homeOfText,
		anchoredIn,
		retargets,
		unresolved,
		regroup
	} = ix;

	// ── the stream table ────────────────────────────────────
	// One maintained row per backing text (keyed by its home block): its
	// live boundaries and the units between them (`text/rows.ts`), the
	// delimiting boundary of each block, and each block's segment. An edit
	// that writes or removes no boundary moves its row by its units
	// (`shiftGap`); a row is rescanned only when its boundary set (or its
	// text) changed, and only the delimiters of the blocks its boundaries
	// name are re-decided, so only the rows those delimiters cut re-place.
	/** Every live boundary naming a block, by block: key → its row and nonce. */
	const boundsBy = new Map<BlockId, Map<string, { home: BlockId; n: unknown }>>();
	const streamOf = (b: BlockId): Stream | undefined => {
		const at = streamIx.get(b);
		const row = at && rows.get(at.home);
		if (row === undefined) return undefined;
		const k = segmentOfCut(row, at!.cut);
		return k < 0 ? undefined : streamOfSegment(row, k, b);
	};
	const streamsIn = (home: BlockId): Stream[] => {
		const row = rows.get(home);
		const out: Stream[] = [];
		for (let k = 0; row !== undefined && k <= row.cuts.length; k++) {
			const b = headOf(row, k);
			if (b !== null) out.push(streamOfSegment(row, k, b));
		}
		return out;
	};
	const streamAt = (home: BlockId, i: number): Stream | undefined => {
		const row = rows.get(home);
		if (row === undefined) return undefined;
		const k = segmentAt(row, i);
		const b = headOf(row, k);
		if (b === null) return undefined;
		const st = streamOfSegment(row, k, b);
		return st.start <= i && i <= st.end ? st : undefined;
	};
	/** Record `home`'s new row (or none); the blocks its boundary set change names join `named`. */
	const setRow = (home: BlockId, row: LiveRow | undefined, named: Set<BlockId>): void => {
		const old = rows.get(home);
		if (row === undefined) rows.delete(home);
		else {
			rows.set(home, row);
			homeOfText.set(row.text, home);
		}
		if (old?.key === row?.key) return;
		for (const b of old?.bounds ?? []) {
			if (row?.keyIndex.has(b.key)) continue;
			const by = boundsBy.get(b.s);
			// A text can change homes (a key's node becomes a losing incarnation,
			// `id.same.concurrent`): drop the entry only while it is still this row's.
			if (by?.get(b.key)?.home === home) by.delete(b.key);
			if (by?.size === 0) boundsBy.delete(b.s);
			named.add(b.s);
		}
		for (const b of row?.bounds ?? []) {
			if (old?.keyIndex.has(b.key)) continue;
			let by = boundsBy.get(b.s);
			if (by === undefined) boundsBy.set(b.s, (by = new Map()));
			by.set(b.key, { home, n: b.n });
			named.add(b.s);
		}
	};
	/** A fresh row of `home`'s text (none without one). */
	const scanRow = (home: BlockId): LiveRow | undefined => {
		const text = blocks.get(home)?.content;
		return text === undefined ? undefined : rowOf(scanText(home, text));
	};
	/** Re-decide the delimiting boundary of each block in `named`; the rows a change cuts join `homes`. */
	const refreshDelims = (named: Iterable<BlockId>, homes: Set<BlockId>): void => {
		for (const s of named) {
			const n = blocks.get(s)?.n;
			let best: string | undefined;
			if (blocks.has(s))
				for (const [key, b] of boundsBy.get(s) ?? [])
					if (b.n === n && (best === undefined || byId(key, best) < 0)) best = key;
			const old = ix.delim.get(s);
			if (old === best) continue;
			if (best === undefined) ix.delim.delete(s);
			else ix.delim.set(s, best);
			const was = old === undefined ? undefined : boundsBy.get(s)?.get(old)?.home;
			if (was !== undefined) homes.add(was);
			if (best !== undefined) homes.add(boundsBy.get(s)!.get(best)!.home);
			if (rows.has(s) || placed.has(s)) homes.add(s);
		}
	};
	/**
	 * Place `home`'s row; invalidate the blocks whose segment changed (or
	 * appeared, or went). A segment is its two delimiting cuts, so only the
	 * segments between the longest common prefix and suffix of the old and
	 * new cut lists can differ: the others keep their entries untouched.
	 */
	const placeHome = (home: BlockId, invalidated: Set<BlockId>): void => {
		const row = rows.get(home);
		const before = placed.get(home) ?? { head: null, keys: [], blocks: [] };
		const now: Placed = { head: null, keys: [], blocks: [] };
		if (row !== undefined) {
			placeRow(row, ix.delim);
			now.head = row.head;
			for (const j of row.cuts) {
				now.keys.push(row.bounds[j].key);
				now.blocks.push(row.bounds[j].s);
			}
		}
		if (row === undefined) placed.delete(home);
		else placed.set(home, now);
		// Its cuts may move the claims anchored in its text (`merge.claim.anchor`).
		for (const h of anchoredIn.get(home) ?? []) retargets.add(h);
		for (const h of unresolved) retargets.add(h);
		// A change of the text's segments re-decides its pieces' order.
		if (
			before.head !== now.head ||
			before.blocks.length !== now.blocks.length ||
			before.blocks.some((b, i) => now.blocks[i] !== b)
		)
			regroup.add(home);
		const [a, b] = [before.keys, now.keys];
		let p = 0;
		while (p < a.length && p < b.length && a[p] === b[p]) p++;
		let q = 0;
		while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
		// Segment k ends at cut k: it changed iff k lies in [p, n - q] (segment 0 also with its block).
		const from = before.head === now.head ? p : 0;
		const changed = (blk: BlockId | null): void => {
			if (blk === null) return;
			invalidated.add(blk);
			for (const c of listConsumers.get(blk) ?? []) invalidated.add(c);
		};
		const blockOf = (x: Placed, k: number) => (k === 0 ? x.head : x.blocks[k - 1]);
		for (let k = from; k <= a.length - q; k++) {
			const blk = blockOf(before, k);
			if (blk !== null && streamIx.get(blk)?.home === home) streamIx.delete(blk);
			changed(blk);
		}
		for (let k = from; k <= b.length - q; k++) {
			const blk = blockOf(now, k);
			if (blk === null) continue;
			streamIx.set(blk, { home, cut: k === 0 ? null : b[k - 1] });
			changed(blk);
		}
	};
	/** Rebuild the delimiters and every row's segments (the first build). */
	const rebuildTable = (invalidated: Set<BlockId>): void => {
		boundsBy.clear();
		for (const [home, row] of rows)
			for (const b of row.bounds) {
				let by = boundsBy.get(b.s);
				if (by === undefined) boundsBy.set(b.s, (by = new Map()));
				by.set(b.key, { home, n: b.n });
			}
		ix.delim = new Map();
		const homes = new Set<BlockId>([...rows.keys(), ...placed.keys()]);
		refreshDelims(boundsBy.keys(), homes);
		for (const home of homes) placeHome(home, invalidated);
	};

	return {
		streamOf,
		streamsIn,
		streamAt,
		setRow,
		scanRow,
		refreshDelims,
		placeHome,
		rebuildTable
	};
};

export type IndexStreams = ReturnType<typeof indexStreams>;
