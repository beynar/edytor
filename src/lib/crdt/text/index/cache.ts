/**
 * The run cache: each block's visible runs as a frozen snapshot, recomputed
 * when a fold invalidates it, sharing unchanged runs and interned payloads.
 */
import { cloneJsonSafe } from '../../../utils/json.js';
import type { BlockId } from '../../placement/model.js';
import { type RangeReadStats, canonKey, deepFreeze, displayOf } from '../model.js';
import type { ContentRun, RunViewDebug } from '../runs.js';
import type { IndexPlacement } from './placement.js';
import { type Deps, runEquals } from './shared.js';
import type { IndexState } from './state.js';

export const indexCache = (ix: IndexState & IndexPlacement) => {
	const { T, blocks, textConsumers, listConsumers, cache, dirty, foldStats, frames, ownShim } = ix;

	const rangeStats: RangeReadStats = { items: 0, markers: 0 };

	// ── run cache ────────────────────────────────────────────────────
	const internMap = new Map<string, unknown>();
	const debug: RunViewDebug = {
		recomputes: 0,
		recomputed: new Set<BlockId>(),
		get itemsWalked() {
			return rangeStats.items;
		},
		get markersWalked() {
			return rangeStats.markers;
		},
		get frames() {
			return frames.size;
		},
		get folds() {
			return foldStats.folds;
		},
		get foldedPairs() {
			return foldStats.pairs;
		},
		get foldedStructs() {
			return foldStats.structs;
		},
		reset() {
			debug.recomputes = 0;
			debug.recomputed.clear();
			foldStats.folds = 0;
			foldStats.pairs = 0;
			foldStats.structs = 0;
			rangeStats.items = 0;
			rangeStats.markers = 0;
		}
	};

	// ── interning / freezing ─────────────────────────────────────────
	// `cloneJsonSafe` is total even against hostile replicated payloads,
	// and interning the normalized form keys it by its own canonical shape.
	// The shared instance is built FROM that key (sorted keys): it must not
	// remember the key order its first reader happened to fold, or
	// `toJSON` would depend on when the view was read.
	const intern = <T>(v: T): T => {
		const key = canonKey(cloneJsonSafe(v));
		let f = internMap.get(key) as T | undefined;
		if (f === undefined) internMap.set(key, (f = deepFreeze(JSON.parse(key)) as T));
		return f;
	};

	// ── dep bookkeeping ──────────────────────────────────────────────

	const drop = (index: Map<BlockId, Set<BlockId>>, keys: Set<BlockId>, b: BlockId) => {
		for (const k of keys) {
			const set = index.get(k);
			set?.delete(b);
			if (set?.size === 0) index.delete(k);
		}
	};
	const add = (index: Map<BlockId, Set<BlockId>>, keys: Set<BlockId>, b: BlockId) => {
		for (const k of keys) {
			let set = index.get(k);
			if (set === undefined) index.set(k, (set = new Set()));
			set.add(b);
		}
	};
	const applyDeps = (b: BlockId, deps: Deps): void => {
		const old = cache.get(b)?.deps;
		if (old) {
			drop(textConsumers, old.texts, b);
			drop(listConsumers, old.lists, b);
		}
		add(textConsumers, deps.texts, b);
		add(listConsumers, deps.lists, b);
	};

	// ── snapshot construction ────────────────────────────────────────

	const freezeFresh = (r: ContentRun): ContentRun => Object.freeze(r) as ContentRun;

	/** The normalized fresh runs of `b` (interned payloads, equal marks merged) and their deps. */
	const computeFresh = (b: BlockId): { fresh: ContentRun[]; deps: Deps } => {
		const deps: Deps = { texts: new Set(), lists: new Set([b]) };
		const segs =
			displayOf(b, blocks, ownShim, (x, home) => {
				deps.lists.add(x);
				if (home !== undefined) deps.texts.add(home);
				// Every claim on a walked list is read, followed or not: a claim
				// skipped for a dead target or a higher claimer becomes effective
				// when that target revives or its winning claim goes away.
				for (const c of blocks.get(x)?.claims ?? []) deps.lists.add(c.m);
			}) ?? [];
		const fresh: ContentRun[] = [];
		for (const item of T.readSegs(segs, rangeStats)) {
			if (item.kind === 'text') {
				const last = fresh[fresh.length - 1];
				const marks = item.marks === undefined ? undefined : intern(item.marks);
				if (last && last.kind === 'text' && last.marks === marks) {
					(last as { text: string }).text += item.text;
				} else {
					fresh.push({
						kind: 'text',
						text: item.text,
						...(marks === undefined ? {} : { marks })
					} as ContentRun);
				}
			} else {
				fresh.push({
					kind: 'inline',
					id: item.id,
					type: item.type,
					...(item.data === undefined ? {} : { data: intern(item.data) })
				} as ContentRun);
			}
		}
		return { fresh, deps };
	};

	/**
	 * Structural sharing: reuse unchanged run objects from `old` — maximal
	 * equal prefix + equal suffix; `old` itself when every run is identical.
	 */
	const reconcile = (
		old: readonly ContentRun[] | undefined,
		fresh: ContentRun[]
	): readonly ContentRun[] => {
		if (!old) return Object.freeze(fresh.map(freezeFresh));
		let s = 0;
		const n = Math.min(old.length, fresh.length);
		while (s < n && runEquals(old[s], fresh[s])) s++;
		if (s === old.length && s === fresh.length) return old;
		let eo = old.length - 1;
		let ef = fresh.length - 1;
		while (eo >= s && ef >= s && runEquals(old[eo], fresh[ef])) {
			eo--;
			ef--;
		}
		const out: ContentRun[] = new Array(fresh.length);
		for (let i = 0; i < s; i++) out[i] = old[i];
		for (let i = s; i <= ef; i++) out[i] = freezeFresh(fresh[i]);
		for (let i = eo + 1; i < old.length; i++) out[fresh.length - (old.length - i)] = old[i];
		return Object.freeze(out);
	};

	// ── recompute ────────────────────────────────────────────────────

	const computeRuns = (b: BlockId): void => {
		const old = cache.get(b);
		const { fresh, deps } = computeFresh(b);
		const runs = reconcile(old?.runs, fresh);
		applyDeps(b, deps);
		cache.set(b, { runs, deps });
		dirty.delete(b);
		debug.recomputes++;
		debug.recomputed.add(b);
	};

	return {
		intern,
		computeFresh,
		computeRuns,
		debug
	};
};

export type IndexCache = ReturnType<typeof indexCache>;
