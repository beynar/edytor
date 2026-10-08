/**
 * Anchored merge claims (`merge.claim.anchor`): the effective claimer of
 * each claim a split its writer did not see moves to the piece that ends
 * its region, re-decided after each fold's texts.
 */
import type { BlockId } from '../../placement/model.js';
import type { StoreStruct } from '../../structs.js';
import { type Claim, cmpStamp, isBoundary } from '../model.js';
import {
	type LiveRow,
	type RowItem,
	gapOfItem,
	headOf,
	segmentOfCut,
	segmentOfGap
} from '../rows.js';
import type { IndexClaims } from './claims.js';
import { addTo, dropFrom } from './shared.js';
import type { FoldCtx, IndexState } from './state.js';

export const indexAnchored = (ix: IndexState & IndexClaims) => {
	const {
		doc,
		blocks,
		rows,
		streamIx,
		homeOfText,
		attachOf,
		foreignOf,
		anchoredIn,
		retargets,
		unresolved,
		reclaim,
		noteClaims,
		invalidateBlock
	} = ix;

	// ── anchored merge claims (`merge.claim.anchor`, H9's second half) ──
	// A claim written since 0.1.0-next.26 carries the end of its holder's
	// stream as its writer saw it (`a`: the last unit, `r`: the item after
	// it). A split the writer did not see moves it to the piece that ends
	// that region: its EFFECTIVE claimer is the block of the segment just
	// before `r` (the text's last segment when `r` is null), if that is
	// the holder's segment or one after it in the holder's row. Records
	// carry their list (`listClaims`) and their effective claims
	// (`claims`: their own that stay, then those other holders' anchors
	// move to them, by stamp); every reader of claims reads the effective
	// ones. Targets change only with a row's cuts: re-decided after each
	// fold's texts for the holders whose record changed and those anchored
	// in a re-placed row.
	const anchorHomes = new Map<BlockId, Set<BlockId>>();
	const sameClaims = (x: readonly Claim[], y: readonly Claim[]): boolean =>
		x.length === y.length &&
		x.every(
			(c, i) =>
				c.m === y[i].m &&
				c.holder === y[i].holder &&
				c.seqIndex === y[i].seqIndex &&
				cmpStamp(c.stamp, y[i].stamp) === 0
		);
	/** `b`'s effective claims: its own that stay with it, then the others' moved to it, by stamp. */
	function effectiveClaims(b: BlockId, list: readonly Claim[]): Claim[] {
		const targets = attachOf.get(b);
		const own = targets === undefined ? list : list.filter((_, i) => (targets[i] ?? b) === b);
		const holders = foreignOf.get(b);
		if (holders === undefined) return own as Claim[];
		const moved: Claim[] = [];
		for (const h of holders) {
			const hr = blocks.get(h);
			const ts = attachOf.get(h);
			if (hr === undefined || ts === undefined) continue;
			(hr.listClaims ?? hr.claims).forEach((c, i) => {
				if (ts[i] === b) moved.push({ ...c, holder: h });
			});
		}
		moved.sort((x, y) => cmpStamp(x.stamp, y.stamp));
		return [...own, ...moved];
	}
	type StoreLike = {
		getClock(client: number): number;
		getItem(id: { client: number; clock: number }): unknown;
	};
	const store = (doc as unknown as { store: StoreLike }).store;
	/** The struct holding unit `ref`, and the unit's offset in it (`null`: none held). */
	const unitAt = (ref: { c: number; k: number }): [RowItem & StoreStruct, number] | null => {
		if (store.getClock(ref.c) <= ref.k) return null;
		const s = store.getItem({ client: ref.c, clock: ref.k }) as unknown as RowItem &
			StoreStruct & { parent?: unknown };
		if (s?.parent === undefined || s.parent === null) return null;
		return [s, ref.k - s.id.clock];
	};
	/** The gap of row `row` unit `off` of `it` lies in (`-1`: stale, the walk met an unknown boundary). */
	const gapOfUnit = (row: LiveRow, it: RowItem, off: number): number => {
		const arr = it.content?.arr;
		if (!it.deleted && it.countable !== false && arr !== undefined) {
			const key = (k: number) => row.keyIndex.get(`${it.id.client}:${it.id.clock + k}`);
			for (let k = off; k >= 0; k--)
				if (isBoundary(arr[k])) {
					const j = key(k);
					if (j === undefined) return -1;
					// The unit itself, a boundary: the units before it.
					return k === off ? j : j + 1;
				}
			for (let k = off + 1; k < it.length; k++)
				if (isBoundary(arr[k])) {
					const j = key(k);
					return j === undefined ? -1 : j;
				}
		}
		return gapOfItem(row, it);
	};
	/** The effective claimer of `holder`'s claim `c`. */
	const targetOf = (holder: BlockId, c: Claim): [BlockId] => {
		if (c.a === undefined) return [holder];
		const at = streamIx.get(holder);
		const row = at && rows.get(at.home);
		if (row === undefined) return [holder];
		const a = unitAt(c.a);
		if (a === null || (a[0] as { parent?: unknown }).parent !== row.text) return [holder];
		const k0 = segmentOfCut(row, at!.cut);
		let gap = row.bounds.length;
		if (c.r != null) {
			const r = unitAt(c.r);
			if (r === null || (r[0] as { parent?: unknown }).parent !== row.text) return [holder];
			gap = gapOfUnit(row, r[0], r[1]);
		}
		if (k0 < 0 || gap < 0) return [holder];
		const k = segmentOfGap(row, gap);
		const target = k < k0 ? null : headOf(row, k);
		return [target ?? holder];
	};
	/**
	 * The rows whose placement may move `holder`'s anchored claim `c`: its
	 * stream's and its anchor's text's. `null` while it is unresolved — the
	 * holder has no stream, or an anchor names a unit not integrated yet
	 * (a payload is no dependency: the claim can arrive first) — and
	 * re-decided at every fold.
	 */
	const watchOf = (holder: BlockId, c: Claim): BlockId[] | null => {
		if (c.a !== undefined && unitAt(c.a) === null) return null;
		if (c.r != null && unitAt(c.r) === null) return null;
		const homes: BlockId[] = [];
		const own = streamIx.get(holder)?.home;
		if (own !== undefined) homes.push(own);
		const a = c.a === undefined ? null : unitAt(c.a);
		const text = a === null ? undefined : homeOfText.get((a[0] as { parent: object }).parent);
		if (text !== undefined && text !== own) homes.push(text);
		return homes.length === 0 ? null : homes;
	};
	/**
	 * The retarget pass: re-decide the targets of the holders queued, move
	 * their claims between effective claimers, and re-read the claims of
	 * every block that gained or lost one (its claim facts and readers).
	 */
	const applyRetargets = (ctx: FoldCtx | null): void => {
		for (const h of retargets) {
			const rec = blocks.get(h);
			const before = attachOf.get(h);
			for (const home of anchorHomes.get(h) ?? []) dropFrom(anchoredIn, home, h);
			anchorHomes.delete(h);
			let after: BlockId[] | undefined;
			unresolved.delete(h);
			for (const [i, c] of (rec?.listClaims ?? []).entries()) {
				if (c.a === undefined) continue;
				const [t] = targetOf(h, c);
				const watch = watchOf(h, c);
				if (watch === null) unresolved.add(h);
				else
					for (const home of watch) {
						addTo(anchoredIn, home, h);
						addTo(anchorHomes, h, home);
					}
				if (t !== h) (after ??= new Array((rec!.listClaims ?? []).length).fill(h))[i] = t;
			}
			const was = new Set(before ?? []);
			const now = new Set(after ?? []);
			for (const t of was) if (t !== h && !now.has(t)) dropFrom(foreignOf, t, h);
			for (const t of now) if (t !== h) addTo(foreignOf, t, h);
			if (after === undefined) attachOf.delete(h);
			else attachOf.set(h, after);
			if (before !== undefined || after !== undefined) {
				reclaim.add(h);
				for (const t of was) reclaim.add(t);
				for (const t of now) reclaim.add(t);
			}
		}
		retargets.clear();
		for (const b of reclaim) {
			const rec = blocks.get(b);
			if (rec === undefined) continue;
			const before = rec.claims;
			const after = effectiveClaims(b, rec.listClaims ?? before);
			if (sameClaims(before, after)) continue;
			rec.claims = after;
			noteClaims(b, before, after);
			if (ctx !== null) invalidateBlock(b, ctx, before);
		}
		reclaim.clear();
	};

	return {
		sameClaims,
		effectiveClaims,
		targetOf,
		applyRetargets
	};
};

export type IndexAnchored = ReturnType<typeof indexAnchored>;
