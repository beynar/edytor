/**
 * The index's self-checks (`indexChecks`, installed by the test lanes'
 * setup, `src/tests/setup/index-checks.ts`): after every fold each fact the
 * index maintains incrementally equals its rebuild from the replicated
 * state, and after every report the published tree equals a fresh walk; the
 * first difference throws.
 */
import { sameIds } from '../../lib/utils/json.js';
import {
	type BlockId,
	type ChildSlot,
	childrenIndex,
	resolvePlacements
} from '../../lib/crdt/placement/model.js';
import {
	type Claim,
	DEAD,
	type Owner,
	type Stream,
	type TextRow,
	claimGraph,
	cmpStamp,
	delimiters,
	placeText,
	scanText
} from '../../lib/crdt/text/model.js';
import { boundAt, rowLength, type LiveRow } from '../../lib/crdt/text/rows.js';
import type { IndexAnchored } from '../../lib/crdt/text/index/anchored.js';
import type { IndexCache } from '../../lib/crdt/text/index/cache.js';
import type { IndexClaims } from '../../lib/crdt/text/index/claims.js';
import type { IndexFold } from '../../lib/crdt/text/index/fold.js';
import type { IndexLayout } from '../../lib/crdt/text/index/layout.js';
import type { IndexPlacement } from '../../lib/crdt/text/index/placement.js';
import type { IndexReporter } from '../../lib/crdt/text/index/report.js';
import { keyOf } from '../../lib/crdt/text/index/shared.js';
import type { IndexState, Published } from '../../lib/crdt/text/index/state.js';
import type { IndexStreams } from '../../lib/crdt/text/index/streams.js';

/** The inverse of `ownerOf` over `blocks`: each live owner → the blocks it displays. */
export const displayIndex = (
	blocks: ReadonlyMap<BlockId, unknown>,
	ownerOf: (b: BlockId) => Owner
): Map<BlockId, BlockId[]> => {
	const by = new Map<BlockId, BlockId[]>();
	for (const b of blocks.keys()) {
		const owner = ownerOf(b);
		if (typeof owner !== 'string') continue;
		const list = by.get(owner);
		if (list === undefined) by.set(owner, [b]);
		else list.push(b);
	}
	return by;
};

/** The row agrees with a fresh scan of its text (the index's self-check). */
export const sameRow = (row: LiveRow, scan: TextRow): boolean => {
	if (row.key !== scan.key || row.bounds.length !== scan.bounds.length) return false;
	if (rowLength(row) !== scan.len) return false;
	for (let j = 0; j < scan.bounds.length; j++)
		if (boundAt(row, j) !== scan.bounds[j].at) return false;
	return true;
};

/** The self-checks of one doc's index, over every part they compare. */
export const indexSelfChecks = (
	ix: IndexState &
		IndexClaims &
		IndexStreams &
		IndexAnchored &
		IndexLayout &
		IndexPlacement &
		IndexCache &
		IndexFold &
		IndexReporter
) => {
	const {
		blocks,
		displaysMap,
		rows,
		streamIx,
		placementsMap,
		following,
		cache,
		dirty,
		ownerOf,
		streamOf,
		sameClaims,
		targetOf,
		dissolve,
		ranker,
		ownShim,
		own0,
		noteFollowing,
		ensurePlacements,
		computeFresh,
		unfolded,
		reachable
	} = ix;

	/** {@link indexChecks}: every incrementally maintained fact equals its rebuild. */
	const check = (): void => {
		// A queued transaction whose writes this fold has not seen yet
		// (a follow-up a cleanup started): the index lags it until its
		// own fold, so there is nothing to compare yet.
		if (unfolded()) return;
		const fail = (what: string): never => {
			throw new Error(`[edytor index] ${what} differs from its rebuild`);
		};
		const scans = new Map<BlockId, TextRow>();
		for (const rec of blocks.values())
			if (rec.content) scans.set(rec.id, scanText(rec.id, rec.content));
		for (const home of rows.keys()) if (!scans.has(home)) fail(`row ${home}`);
		for (const [home, scan] of scans) {
			const row = rows.get(home);
			if (row === undefined || row.text !== scan.text || !sameRow(row, scan)) fail(`row ${home}`);
		}
		const want = delimiters(blocks, scans.values());
		if (want.size !== ix.delim.size || [...want].some(([b, k]) => ix.delim.get(b) !== k))
			fail('delimiters');
		const streamSig = (st: Stream | undefined) =>
			st && `${st.home}:${st.start}-${st.end}/${st.inert.join(',')}`;
		const placed = new Set<BlockId>();
		for (const [home, scan] of scans)
			for (const st of placeText(scan, want)) {
				placed.add(st.block);
				if (streamSig(streamOf(st.block)) !== streamSig(st))
					fail(`stream of ${st.block} in ${home}`);
			}
		for (const b of streamIx.keys()) if (!placed.has(b)) fail(`stream of ${b}`);
		// The anchored claims (`merge.claim.anchor`): each record's effective claims, from scratch.
		{
			const moved = new Map<BlockId, Claim[]>();
			const stays = new Map<BlockId, Claim[]>();
			for (const [h, rec] of blocks) {
				const list = rec.listClaims ?? rec.claims;
				const own: Claim[] = [];
				for (const c of list) {
					const [t] = targetOf(h, c);
					if (t === h) own.push(c);
					else {
						let into = moved.get(t);
						if (into === undefined) moved.set(t, (into = []));
						into.push({ ...c, holder: h });
					}
				}
				stays.set(h, own);
			}
			for (const [b, rec] of blocks) {
				const extra = (moved.get(b) ?? []).sort((x, y) => cmpStamp(x.stamp, y.stamp));
				if (!sameClaims(rec.claims, [...stays.get(b)!, ...extra])) fail(`claims of ${b}`);
			}
		}
		for (const [b, c] of cache) {
			if (dirty.has(b)) continue;
			const fresh = computeFresh(b).fresh;
			if (keyOf(fresh) !== keyOf(c.runs)) fail(`runs of ${b}`);
		}
		// The claim graph, placements, children index and layout rules.
		ensurePlacements();
		const graph = claimGraph(blocks);
		for (const b of blocks.keys()) {
			if (ownerOf(b) !== (graph.owners.get(b) ?? DEAD)) fail(`owner of ${b}`);
			if (ownShim.top(b) !== graph.top.get(b)) fail(`top of ${b}`);
		}
		const shown = displayIndex(blocks, ownerOf);
		for (const [o, list] of shown)
			if (
				list.length !== (displaysMap.get(o)?.size ?? 0) ||
				list.some((b) => !displaysMap.get(o)!.has(b))
			)
				fail(`displays of ${o}`);
		for (const o of displaysMap.keys()) if (!shown.has(o)) fail(`displays of ${o}`);
		const resolved = resolvePlacements(blocks, ownerOf);
		if (resolved.size !== placementsMap.size) fail('placements');
		for (const [b, pl] of resolved) {
			const mine = placementsMap.get(b);
			if (mine?.parent !== pl.parent || mine.rank !== pl.rank) fail(`placement of ${b}`);
		}
		const same = (x: Map<BlockId | null, ChildSlot[]>, y: Map<BlockId | null, ChildSlot[]>) =>
			x.size === y.size && [...x].every(([p, l]) => keyOf(l) === keyOf(y.get(p) ?? null));
		// The text orders decided afresh: a stale one shows as a slot mismatch.
		ranker.forget();
		const k0 = childrenIndex(placementsMap, own0);
		if (!same(k0, ix.kids0)) fail('children index (before the layout rules)');
		const out = dissolve(k0);
		if (out.size !== ix.dissolved.size || [...out].some((b) => !ix.dissolved.has(b)))
			fail('dissolved');
		if (!same(childrenIndex(placementsMap, ownShim), ix.kidsMap)) fail('children index');
		for (const [p, l] of ix.kidsMap)
			for (const { id, rank, reset } of l) {
				const slot = ix.slots.get(id);
				if (slot?.parent !== p || slot.rank !== rank || slot.reset !== reset) fail(`slot of ${id}`);
			}
		const follow = new Set(following);
		for (const id of ix.slots.keys()) noteFollowing(id);
		if (follow.size !== following.size || [...follow].some((b) => !following.has(b)))
			fail('following');
	};
	/** {@link indexChecks}: the published tree the report advanced equals a fresh walk. */
	const checkPublished = (pub: Published): void => {
		// Payloads from the published nodes: the check reads no runs.
		const want = reachable(pub.nodes);
		const fail = (what: string): never => {
			throw new Error(`[edytor index] published ${what} differs from its rebuild`);
		};
		if (want.order.size !== pub.order.size) fail('lists');
		for (const [p, ids] of want.order)
			if (!sameIds(ids, pub.order.get(p) ?? [])) fail(`list of ${p}`);
		if (want.nodes.size !== pub.nodes.size) fail('blocks');
		for (const [id, n] of want.nodes) {
			const m = pub.nodes.get(id);
			if (m?.parent !== n.parent || m.index !== n.index) fail(`slot of ${id}`);
		}
	};

	return {
		check,
		checkPublished
	};
};

export type IndexSelfChecks = ReturnType<typeof indexSelfChecks>;
