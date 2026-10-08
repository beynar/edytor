/**
 * The claim graph (P3: maintained): each block's owner along the max-stamp
 * claims (`top`), the blocks each owner displays, and what a structural
 * change of a block invalidates.
 */
import type { BlockId } from '../../placement/model.js';
import { type Claim, DEAD, type Owner, type Stamp, claimGraph, cmpStamp } from '../model.js';
import { addTo, dropFrom } from './shared.js';
import type { FoldCtx, IndexState } from './state.js';

/** The claim graph of one doc's index, over its state. */
export const indexClaims = (ix: IndexState) => {
	const { blocks, listConsumers, displaysMap, ownerSeeds, ownerChanged } = ix;

	// ── the claim graph (P3: maintained) ─────────────────────────────
	// `top(m)` is the max-stamp claim on `m` held by a live block; each
	// block's owner follows `top` up (`claimGraph`). A structural change
	// of a block (its claims, its delete mark, its record) re-decides the
	// `top` of the blocks it claims (before and after) and the owners of
	// those blocks and of every block whose `top` chain reaches them —
	// never the whole graph.
	const owners = new Map<BlockId, Owner>();
	const topOf = new Map<BlockId, { claimer: BlockId; stamp: Stamp }>();
	/** Claimer → the blocks it tops. */
	const topInv = new Map<BlockId, Set<BlockId>>();
	/** Claimed block → the blocks whose claims list names it (live or not). */
	const claimersOf = new Map<BlockId, Set<BlockId>>();
	let ownersBuilt = false;
	/** The max-stamp claim on `m` held by a live block. */
	const topClaim = (m: BlockId): { claimer: BlockId; stamp: Stamp } | undefined => {
		let best: { claimer: BlockId; stamp: Stamp } | undefined;
		for (const holder of claimersOf.get(m) ?? []) {
			const rec = blocks.get(holder);
			if (rec === undefined || rec.deleted) continue;
			for (const c of rec.claims)
				if (c.m === m && (best === undefined || cmpStamp(c.stamp, best.stamp) > 0))
					best = { claimer: holder, stamp: c.stamp };
		}
		return best;
	};
	const setTop = (m: BlockId, t: { claimer: BlockId; stamp: Stamp } | undefined): boolean => {
		const old = topOf.get(m);
		if (old?.claimer === t?.claimer && (old === undefined || cmpStamp(old.stamp, t!.stamp) === 0))
			return false;
		if (old !== undefined) dropFrom(topInv, old.claimer, m);
		if (t === undefined) topOf.delete(m);
		else {
			topOf.set(m, t);
			addTo(topInv, t.claimer, m);
		}
		return true;
	};
	/** `owner(b)` along `top` (`claimGraph`'s walk), memoized into `owners`. */
	const walkOwner = (b: BlockId): void => {
		const path: BlockId[] = [];
		let cur = b;
		let result: Owner;
		for (;;) {
			const known = owners.get(cur);
			if (known !== undefined) {
				result = known;
				break;
			}
			const rec = blocks.get(cur);
			if (!rec || rec.deleted) {
				result = DEAD;
				break;
			}
			const at = path.indexOf(cur);
			if (at >= 0) {
				let best = topOf.get(path[at])!;
				for (const member of path.slice(at)) {
					const t = topOf.get(member)!;
					if (cmpStamp(t.stamp, best.stamp) > 0) best = t;
				}
				result = best.claimer;
				break;
			}
			const t = topOf.get(cur);
			if (t === undefined) {
				result = cur;
				break;
			}
			path.push(cur);
			cur = t.claimer;
		}
		if (blocks.has(cur)) owners.set(cur, result);
		for (const x of path) owners.set(x, result);
	};
	const setDisplay = (b: BlockId, from: Owner | undefined, to: Owner | undefined): void => {
		if (typeof from === 'string') dropFrom(displaysMap, from, b);
		if (typeof to === 'string') addTo(displaysMap, to, b);
	};
	const ensureOwners = (): void => {
		if (!ownersBuilt) {
			ownersBuilt = true;
			ownerSeeds.clear();
			const graph = claimGraph(blocks);
			owners.clear();
			for (const [b, o] of graph.owners) if (blocks.has(b)) owners.set(b, o);
			topOf.clear();
			topInv.clear();
			claimersOf.clear();
			for (const [holder, rec] of blocks)
				for (const c of rec.claims) addTo(claimersOf, c.m, holder);
			for (const m of claimersOf.keys()) setTop(m, topClaim(m));
			displaysMap.clear();
			for (const b of blocks.keys()) setDisplay(b, undefined, owners.get(b));
			return;
		}
		if (ownerSeeds.size === 0) return;
		// The tops a seed's claims (now, and those it dropped: noted in `claimersOf` changes) decide.
		const affected = new Set<BlockId>();
		const stack: BlockId[] = [];
		for (const x of ownerSeeds) {
			stack.push(x);
			for (const m of claimTargets.get(x) ?? []) if (setTop(m, topClaim(m))) stack.push(m);
			for (const c of blocks.get(x)?.claims ?? []) if (setTop(c.m, topClaim(c.m))) stack.push(c.m);
		}
		ownerSeeds.clear();
		claimTargets.clear();
		for (let x = stack.pop(); x !== undefined; x = stack.pop()) {
			if (affected.has(x)) continue;
			affected.add(x);
			for (const m of topInv.get(x) ?? []) stack.push(m);
		}
		const before = new Map<BlockId, Owner | undefined>();
		for (const x of affected) {
			before.set(x, owners.get(x));
			owners.delete(x);
		}
		for (const x of affected) if (blocks.has(x)) walkOwner(x);
		for (const [x, was] of before) {
			const now = owners.get(x);
			if (now === was) continue;
			setDisplay(x, was, now);
			ownerChanged.add(x);
		}
	};
	/** The claims each seed held before its record changed (their tops are re-decided too). */
	const claimTargets = new Map<BlockId, Set<BlockId>>();
	const ownerOf = (b: BlockId): Owner => {
		ensureOwners();
		return owners.get(b) ?? DEAD;
	};

	/** The live claimer of the max-stamp claim on `m` (`DisplayOwnership.top`). */
	const top = (m: BlockId): BlockId | undefined => {
		ensureOwners();
		return topOf.get(m)?.claimer;
	};

	/** The blocks `owner` displays (the delete step's marks). */
	const displays = (owner: BlockId): readonly BlockId[] => {
		ensureOwners();
		return [...(displaysMap.get(owner) ?? [])];
	};

	/** Union-ever claim targets per holder (never shrinks: a dropped claim still invalidates). */
	const effects = new Map<BlockId, Set<BlockId>>();
	const noteEffects = (id: BlockId, claims: readonly Claim[]): void => {
		let fx = effects.get(id);
		if (fx === undefined) effects.set(id, (fx = new Set()));
		for (const c of claims) fx.add(c.m);
	};
	/** `id`'s claims went from `before` to `after`: its claim facts follow. */
	const noteClaims = (id: BlockId, before: readonly Claim[], after: readonly Claim[]): void => {
		noteEffects(id, after);
		const was = new Set(before.map((c) => c.m));
		const now = new Set(after.map((c) => c.m));
		for (const m of was)
			if (!now.has(m)) {
				dropFrom(claimersOf, m, id);
				addTo(claimTargets, id, m);
			}
		for (const m of now) if (!was.has(m)) addTo(claimersOf, m, id);
		ownerSeeds.add(id);
	};
	/** A structural change of `id`: its readers, and the blocks it claims, re-read. */
	const invalidateBlock = (id: BlockId, ctx: FoldCtx, claimsBefore: Claim[] = []): void => {
		ctx.invalidated.add(id);
		for (const c of listConsumers.get(id) ?? []) ctx.invalidated.add(c);
		for (const m of new Set([...(effects.get(id) ?? []), ...claimsBefore.map((c) => c.m)])) {
			ctx.invalidated.add(m);
			for (const c of listConsumers.get(m) ?? []) ctx.invalidated.add(c);
		}
	};

	return {
		ensureOwners,
		ownerOf,
		top,
		displays,
		noteClaims,
		invalidateBlock
	};
};

export type IndexClaims = ReturnType<typeof indexClaims>;
