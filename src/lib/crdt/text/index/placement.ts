/**
 * Placements and the children index (maintained), the display
 * ownership the display reads (`ownShim`), and THE shown-kind rule
 * (`typeOf`).
 *
 * A structural change re-decides only what it can change: the display
 * edge of the blocks whose slot, record or mover changed (fork patch
 * YP22), and the display slot of every block whose slot walk
 * (`displaySlotOf`) reads one that changed — its stored subtree, through
 * the blocks it displays — patched into the parents' child lists. A
 * block's candidate edges are its live move records, strongest first, then
 * its home slot; it shows at the first that closes no cycle through the
 * accepted edges (`settle`): the later move wins, and the block whose edge
 * is the oldest of a cycle falls back to its next candidate, back where it
 * stood (its previous record, else home; the root's tail only when every
 * candidate closes a cycle), so a cycle resolves locally: no global pass.
 * The first build places every block the same way (their unique acyclic
 * acceptance, whatever the order; the tests' greedy rebuild,
 * `src/tests/oracles/placements.ts`, is what the self-checks compare). A
 * placed block's order key is found from its sequence neighbours
 * (`placement/keys.ts`), never by walking the parent's sequence; a rebuild
 * keys every list once, in its sequence's order. The layout rules re-run
 * only on the layouts a change reaches.
 */
import {
	type BlockId,
	type ChildSlot,
	type DisplayOwnership,
	type DocOrder,
	type ResolvedPlacement,
	bySlot,
	childrenIndex,
	displaySlotOf,
	documentOrder
} from '../../placement/model.js';
import { denseKey, keyBetween } from '../../placement/keys.js';
import {
	NO_SLOT,
	byTail,
	candidatesOf,
	cycleThrough,
	edgeParentOf,
	collectSlots,
	homeOf,
	registryOwners,
	ownerOfNode,
	slotOwner,
	slotsBefore,
	type Edge,
	type SlotRef,
	type Slots
} from '../../placement/resolve.js';
import {
	cmpStamp,
	isBlockSlot,
	isRecord,
	sameUnit,
	type BlockSlot,
	type SeqItem,
	type Stamp,
	type Unit
} from '../../placement/slots.js';
import type { EngineNode } from '../../engine-api.js';
import { Y } from '../../engine.js';
import { engineOps, firstItem } from '../../structs.js';
import { DEAD, displayOf } from '../model.js';
import type { IndexClaims } from './claims.js';
import type { IndexLayout } from './layout.js';
import type { IndexState, Slot } from './state.js';
import type { IndexStreams } from './streams.js';

/** Placement maintenance of one doc's index, over its state, claims, streams and layout rules. */
export const indexPlacement = (ix: IndexState & IndexClaims & IndexStreams & IndexLayout) => {
	const {
		doc,
		registry,
		blocks,
		displaysMap,
		ownerChanged,
		placementsMap,
		following,
		dirtyLists,
		leftLists,
		placementSeeds,
		stateSeeds,
		kindsOf,
		slotsByBlock,
		rawOrder,
		edges,
		fallen,
		rejected,
		ensureOwners,
		ownerOf,
		top,
		streamOf,
		streamsIn,
		streamAt,
		role,
		lineKind,
		itemKind,
		rowKind,
		rowOfTable,
		declaredRows,
		cellKind,
		cellRank,
		declaredItems,
		dissolve,
		redissolve
	} = ix;
	const kept = engineOps(Y).isKeptReplaced;

	// ── placements and the children index (maintained) ────────────
	/** The document holds a layout or an item kind: `kids0` and `kidsMap` differ. */
	let layoutMode = false;
	/** The line kinds the roles declare, and those of the lines islands the document holds. */
	let lineKinds = new Set<string>();
	let orderCache: DocOrder | null = null;
	let layoutBlocks = 0;
	let itemBlocks = 0;
	/** Tables, rows and cells (`table.*`): their rules run in the layout pass. */
	let tableBlocks = 0;
	const lineCounts = new Map<string, number>();
	const ownShim: DisplayOwnership = {
		ownerOf,
		hidden: (b) => ownerOf(b) !== b || ix.dissolved.has(b),
		childless: (b) => role(b, (r, type) => r.childless(type)) === true,
		island: (b) => role(b, (r, type) => r.island(type)) === true,
		container: (b) => role(b, (r, type) => r.container(type)) === true,
		lined: (b) => lineKind(b) !== undefined,
		passes: (b) => ix.dissolved.has(b),
		sheds: (owner, child) => {
			// A layout shows only its items, a table its rows, a row its cells.
			const only = itemKind(owner) ?? rowKind(owner) ?? cellKind(owner);
			return only !== undefined && blocks.get(child)?.type !== only;
		},
		slotRank: (owner, id) => cellRank(owner, id),
		top,
		claimIndex: (holder, m) => blocks.get(holder)?.claims.findIndex((c) => c.m === m) ?? -1,
		streamOf,
		streamsIn,
		streamAt,
		display: (b) => displayOf(b, blocks, ownShim)
	};
	/** Re-count `id`'s kind facts; a fact the roles never declared forces a full pass. */
	const noteKind = (id: BlockId): void => {
		const old = kindsOf.get(id);
		const type = blocks.get(id)?.type;
		const now =
			type === undefined
				? undefined
				: {
						layout: itemKind(id) !== undefined,
						item: ix.itemKinds.has(type),
						line: lineKind(id),
						table: rowKind(id) !== undefined,
						row: ix.rowKinds.has(type),
						cell: ix.cellKinds.has(type)
					};
		const tableish = (k: { table: boolean; row: boolean; cell: boolean } | undefined) =>
			k?.table || k?.row || k?.cell ? 1 : 0;
		tableBlocks += tableish(now) - tableish(old);
		if (old?.layout) layoutBlocks--;
		if (old?.item) itemBlocks--;
		if (old?.line !== undefined) lineCounts.set(old.line, lineCounts.get(old.line)! - 1);
		if (now === undefined) kindsOf.delete(id);
		else kindsOf.set(id, now);
		if (now?.layout) layoutBlocks++;
		if (now?.item) itemBlocks++;
		if (now?.line !== undefined) lineCounts.set(now.line, (lineCounts.get(now.line) ?? 0) + 1);
		const item = itemKind(id);
		if (item !== undefined && !ix.itemKinds.has(item)) ix.placementFull = true;
		if (now?.line !== undefined && !lineKinds.has(now.line)) ix.placementFull = true;
		// A table of a kind whose row the index does not know yet: its rows and cells change kind facts.
		const rows = type === undefined ? undefined : rowOfTable(type);
		if (rows !== undefined && ix.rowKinds.get(rows[0]) !== rows[1]) ix.placementFull = true;
		if (layoutMode !== layoutBlocks + itemBlocks + tableBlocks > 0) ix.placementFull = true;
	};
	/** The ownership the layout rules read: none of their decisions applied. */
	const own0: DisplayOwnership = {
		...ownShim,
		hidden: (b) => ownerOf(b) !== b,
		passes: () => false
	};
	/** `id`'s slot in the index `own` reads (none: hidden, or under no live parent). */
	const slotIn = (own: DisplayOwnership, id: BlockId): Slot | undefined => {
		const pl = placementsMap.get(id);
		if (pl === undefined || !blocks.has(id) || own.hidden(id)) return undefined;
		const { parent, rank, reset } = displaySlotOf(own, placementsMap, pl, id);
		if (parent === DEAD) return undefined;
		return reset === null ? { parent, rank } : { parent, rank, reset };
	};
	/** The index of the first slot of `list` not before `x`. */
	const seek = (list: readonly ChildSlot[], x: { id: BlockId; rank: string }): number => {
		let lo = 0;
		let hi = list.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (bySlot(list[mid], x) < 0) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	};
	/**
	 * Re-decide the slots of `affected` in `kids`/`slotMap` (read through
	 * `own`), patching the child lists they leave or join (each list
	 * copied once: a list a reader holds never changes under it). Returns
	 * the blocks whose slot changed, with their parents before and after.
	 */
	const patch = (
		kids: Map<BlockId | null, ChildSlot[]>,
		slotMap: Map<BlockId, Slot>,
		own: DisplayOwnership,
		affected: Iterable<BlockId>
	): Map<BlockId, [BlockId | null | undefined, BlockId | null | undefined]> => {
		const changed = new Map<BlockId, [BlockId | null | undefined, BlockId | null | undefined]>();
		const copies = new Map<BlockId | null, ChildSlot[]>();
		const list = (p: BlockId | null): ChildSlot[] => {
			let l = copies.get(p);
			if (l === undefined) copies.set(p, (l = [...(kids.get(p) ?? [])]));
			return l;
		};
		for (const id of affected) {
			const old = slotMap.get(id);
			const next = slotIn(own, id);
			if (
				old?.parent === next?.parent &&
				old?.rank === next?.rank &&
				old?.reset === next?.reset &&
				(old === undefined) === (next === undefined)
			)
				continue;
			if (old !== undefined) {
				const l = list(old.parent);
				const at = seek(l, { id, rank: old.rank });
				if (l[at]?.id === id) l.splice(at, 1);
			}
			if (next !== undefined) {
				const l = list(next.parent);
				const slot: ChildSlot =
					next.reset === undefined
						? { id, rank: next.rank }
						: { id, rank: next.rank, reset: next.reset };
				l.splice(seek(l, slot), 0, slot);
				slotMap.set(id, next);
			} else {
				slotMap.delete(id);
				if (kids === ix.kidsMap) leftLists.add(id);
			}
			changed.set(id, [old?.parent, next?.parent]);
		}
		for (const [p, l] of copies) {
			if (l.length === 0) kids.delete(p);
			else kids.set(p, l);
			if (kids === ix.kidsMap) dirtyLists.add(p);
		}
		return changed;
	};
	/** `seeds` and every block whose slot walk reads one of them: stored subtrees, through what each displays. */
	const reach = (seeds: Iterable<BlockId>): Set<BlockId> => {
		const out = new Set<BlockId>();
		const stack = [...seeds];
		for (let x = stack.pop(); x !== undefined; x = stack.pop()) {
			if (out.has(x)) continue;
			out.add(x);
			for (const c of rawOrder.get(x) ?? []) stack.push(c.id);
			for (const d of displaysMap.get(x) ?? [])
				if (d !== x) for (const c of rawOrder.get(d) ?? []) stack.push(c.id);
		}
		return out;
	};
	/** Whether `id` shows as its slot's kind (`following`): read from its slot and kinds. */
	const noteFollowing = (id: BlockId): void => {
		const slot = ix.slots.get(id);
		const follows =
			slot !== undefined &&
			(slot.reset !== undefined ||
				(slot.parent !== null && lineKind(slot.parent) !== undefined) ||
				lineKinds.has(blocks.get(id)?.type ?? ''));
		if (follows) following.add(id);
		else following.delete(id);
	};

	// ── edges, keys and acceptance ─────────────────────────────────
	/**
	 * Whether the slot map has been read from the sequences: once, before the
	 * first rebuild (a shell settled on the first fold asks for a home), then
	 * the fold keeps it and every rebuild fills it again.
	 */
	let slotsRead = false;
	/** What the first read collected, for a rebuild while no sequence changed since (one scan). */
	let collected: Slots | null = null;
	let collectedAt = -1;
	const readSlots = (): void => {
		slotsRead = true;
		slotsByBlock.clear();
		// Every registry node, its kept incarnations too (the records may not all be built yet).
		collected = collectSlots(doc, registryOwners(registry, kept));
		collectedAt = ix.seqEpoch;
		for (const [b, refs] of collected.slots) slotsByBlock.set(b, refs);
	};
	/** Put `ref` (`null`: none) where the slot map holds unit `u` of the slots naming id `b`. */
	const putSlot = (b: BlockId, u: Unit, ref: SlotRef | null): void => {
		const list = (slotsByBlock.get(b) ?? []).filter((x) => !sameUnit(x, u));
		if (ref !== null) list.push(ref);
		if (list.length === 0) slotsByBlock.delete(b);
		else slotsByBlock.set(b, list);
	};
	/** `id`'s home slot among the slots naming its registry id (`null`: none). */
	const homeFor = (id: BlockId): ReturnType<typeof homeOf> => {
		if (!slotsRead) readSlots();
		return homeOf(registry, kept, slotsByBlock, id);
	};
	/**
	 * Re-own the home slots of `node`'s sequence after the registry value it
	 * stands for changed (a concurrent creation of one id won or lost, its
	 * losing incarnation shown or not): each slot's parent is the node's owner
	 * now, and its block re-placed; a node that is no block of the document
	 * any more holds no slot (as a rebuild reads it).
	 */
	const reslot = (node: EngineNode): void => {
		if (!slotsRead) return; // the first read collects them as they are
		const owner = ownerOfNode(registry, kept, node);
		for (let it = firstItem<SeqItem>(node); it !== null; it = it.right) {
			const arr = it.content.arr;
			if (isRecord(it) || arr === undefined || it.gone === true) continue;
			for (let j = 0; j < arr.length; j++) {
				const v = arr[j];
				if (!isBlockSlot(v)) continue;
				const [c, k] = [it.id.client, it.id.clock + j];
				putSlot(v.b, { c, k }, owner === undefined ? null : { parent: owner, c, k });
				const b = slotOwner(registry, kept, v.b, c);
				for (const id of new Set([v.b, b])) {
					const rec = blocks.get(id);
					if (rec !== undefined) rec.home = homeOf(registry, kept, slotsByBlock, id);
					placementSeeds.add(id);
				}
			}
		}
	};
	/** `id`'s candidate edges, read from the engine: its live records, strongest first, then home (`[]`: no slot, or gone). */
	const candidatesFor = (id: BlockId): Edge[] => {
		const home = blocks.get(id)?.home ?? homeFor(id);
		return home === null ? [] : candidatesOf(doc, registry, kept, home);
	};
	/** The owner of the sequence `id`'s slot shows in as the engine stands (its mover's, else home's; `null`: the root). */
	const edgeParent = (id: BlockId): BlockId | null | undefined => {
		const home = blocks.get(id)?.home ?? homeFor(id);
		return home === null ? undefined : edgeParentOf(doc, registry, kept, home);
	};
	/** The raw children of `parent` in order (every block whose edge parent it is), kept sorted by key. */
	const rawList = (parent: BlockId | null): ChildSlot[] => {
		let l = rawOrder.get(parent);
		if (l === undefined) rawOrder.set(parent, (l = []));
		return l;
	};
	/** Counts the placement writes: a key's walk that saw one happen under it walks again. */
	let placedEpoch = 0;
	/** Whether a placement is keyed as it is decided: not while a rebuild places every block (it keys them after, in one pass). */
	let keyed = true;
	const setPlacement = (id: BlockId, pl: ResolvedPlacement | undefined): void => {
		ix.foldStats.placed++;
		placedEpoch++;
		const old = placementsMap.get(id);
		if (keyed && old !== undefined) {
			const l = rawList(old.parent);
			const at = seek(l, { id, rank: old.rank });
			if (l[at]?.id === id) l.splice(at, 1);
			if (l.length === 0) rawOrder.delete(old.parent);
		}
		if (pl === undefined) placementsMap.delete(id);
		else {
			placementsMap.set(id, pl);
			if (!keyed) return;
			const l = rawList(pl.parent);
			const slot = { id, rank: pl.rank };
			l.splice(seek(l, slot), 0, slot);
		}
	};
	/**
	 * The key `id` takes under `edge.parent`: between the key of the nearest
	 * block shown where it stands before `id`'s place in the sequence (placed
	 * first when it is a pending seed; walked past when it shows elsewhere)
	 * and the next key of that list. Placing a pending neighbour can drop a
	 * block the walk already passed back into that stretch (a cycle's
	 * fallback, back where it stood): a walk under which a placement changed
	 * walks again, so the key it returns reads one state.
	 */
	const keyFor = (id: BlockId, edge: Edge, place: (b: BlockId) => void): string => {
		for (;;) {
			const before = placedEpoch;
			const lrank = leftKey(id, edge, place);
			if (placedEpoch !== before) continue;
			const list = rawOrder.get(edge.parent as BlockId | null) ?? [];
			const i = lrank === undefined ? 0 : seek(list, { id: '', rank: lrank }) + 1;
			return keyBetween(lrank, list[i]?.rank);
		}
	};
	/** The key of the nearest block shown before `id`'s place at `edge`, under its parent (`undefined`: none). */
	const leftKey = (id: BlockId, edge: Edge, place: (b: BlockId) => void): string | undefined => {
		const home = blocks.get(id)?.home ?? homeFor(id)!;
		for (const e of slotsBefore(doc, edge, home)) {
			const b = slotOwner(registry, kept, (e.value as { b: BlockId }).b, e.unit.c);
			// `id` itself (its place before this one) keys nothing.
			if (b === id) continue;
			// A slot that is not its block's home (a second creation of one id) places nothing.
			const h = blocks.get(b)?.home ?? homeFor(b);
			if (h === null || !sameUnit(h, e.unit)) continue;
			place(b);
			const pl = placementsMap.get(b);
			const shows = edges.get(b);
			if (
				pl !== undefined &&
				pl.parent === edge.parent &&
				!rejected.has(b) &&
				shows != null &&
				shows.via === e.via
			)
				return pl.rank;
		}
		return undefined;
	};
	/** The key of `id` at the root's tail, among the rejected by stamp then id, after the last top-level block. */
	const tailKey = (id: BlockId, stamp: Stamp): string => {
		const tail = [...rejected]
			.filter((x) => x !== id)
			.map((x) => ({ id: x, stamp: edges.get(x)?.stamp ?? NO_SLOT }))
			.sort(byTail);
		const list = rawOrder.get(null) ?? [];
		const me = { id, stamp };
		let at = 0;
		while (at < tail.length && byTail(tail[at]!, me) < 0) at++;
		const prev =
			at > 0
				? placementsMap.get(tail[at - 1]!.id)?.rank
				: list[list.length - tail.length - 1]?.rank;
		const next = at < tail.length ? placementsMap.get(tail[at]!.id)?.rank : undefined;
		return keyBetween(prev, next);
	};
	/** Show `id` at the root's tail: every edge closes a cycle, or none. */
	const reject = (id: BlockId, edge: Edge | null): void => {
		edges.set(id, edge);
		if (placementsMap.has(id)) setPlacement(id, undefined);
		fallen.delete(id);
		rejected.add(id);
		const rank = keyed ? tailKey(id, edge?.stamp ?? NO_SLOT) : '';
		setPlacement(id, { parent: null, rank, home: false });
	};
	/** The same display edge: the same sequence, the same record, the same stamp. */
	const sameEdge = (a: Edge, b: Edge): boolean =>
		a.parent === b.parent && a.via === b.via && cmpStamp(a.stamp, b.stamp) === 0;
	/** Whether `edge` (of `id`) is a place `id` may take now: a live parent, and no cycle it would be the oldest edge of. */
	const admits = (id: BlockId, edge: Edge): { ok: boolean; drop: BlockId | null } => {
		const parent = edge.parent;
		if (parent === undefined || (parent !== null && !blocks.has(parent)))
			return { ok: false, drop: null };
		const cycle = cycleThrough(placementsMap, ownerOf, id, parent);
		if (cycle === null) return { ok: true, drop: null };
		let [min, minStamp] = [id, edge.stamp];
		for (const m of cycle) {
			const e = m === id ? edge : edges.get(m);
			if (m !== id && e && cmpStamp(e.stamp, minStamp) < 0) [min, minStamp] = [m, e.stamp];
		}
		return min === id ? { ok: false, drop: null } : { ok: true, drop: min };
	};
	/**
	 * Place `id` at its strongest candidate edge from `from` on that closes no
	 * cycle it would be the oldest edge of (the later move wins). When the
	 * edge closes a cycle through an older edge, that edge's block is dropped
	 * to its next candidate (back where it stood before that move), and so on
	 * down its records to home; a block every candidate of which fails shows
	 * at the root's tail. `place` places a pending neighbour first. Returns
	 * the blocks whose placement changed.
	 */
	const settle = (id: BlockId, place: (b: BlockId) => void, from = 0): BlockId[] => {
		const changed = [id];
		const cands = candidatesFor(id);
		for (let n = from; n < cands.length; n++) {
			const edge = cands[n]!;
			// The key first: its walk places the pending neighbours, so the cycle
			// check reads them placed (a neighbour placed after it could close a
			// cycle through `id` that no check saw).
			const rank = keyed ? keyFor(id, edge, place) : '';
			const { ok, drop } = admits(id, edge);
			if (!ok) continue;
			edges.set(id, edge);
			rejected.delete(id);
			if (n > 0) fallen.add(id);
			else fallen.delete(id);
			if (placementsMap.has(id)) setPlacement(id, undefined);
			setPlacement(id, { parent: edge.parent as BlockId | null, rank, home: edge.via === null });
			if (drop !== null) {
				const now = edges.get(drop);
				const at = now ? candidatesFor(drop).findIndex((c) => sameEdge(c, now)) : -1;
				changed.push(...settle(drop, () => {}, at + 1));
			}
			return changed;
		}
		reject(id, cands[0] ?? null);
		return changed;
	};
	/** Whether a candidate stronger than `id`'s accepted edge would take it now. */
	const canRise = (id: BlockId): boolean => {
		const cands = candidatesFor(id);
		const now = edges.get(id);
		const at = rejected.has(id) || !now ? cands.length : cands.findIndex((c) => sameEdge(c, now));
		for (let n = 0; n < (at < 0 ? cands.length : at); n++)
			if (admits(id, cands[n]!).ok) return true;
		return false;
	};
	/**
	 * Try every block below its strongest edge again (a changed edge may have
	 * broken its cycle, or made another the one to drop): those that rise join
	 * `moved`.
	 */
	const retryFallen = (moved: Set<BlockId>): void => {
		for (let round = 0; round < fallen.size + rejected.size + 2; round++) {
			let changed = false;
			const below = [...rejected, ...fallen]
				.map((x) => ({ id: x, stamp: candidatesFor(x)[0]?.stamp ?? NO_SLOT }))
				.sort((a, b) => -byTail(a, b));
			for (const { id } of below) {
				if (!canRise(id)) continue;
				for (const x of settle(id, () => {})) moved.add(x);
				changed = true;
			}
			if (!changed) break;
		}
	};
	/**
	 * Everything rebuilt from the sequences (the first build, roles): every
	 * block placed as an edit places one (`settle`, then `retryFallen`) —
	 * the one acyclic acceptance, whatever the order the blocks come in —
	 * then keyed in one pass over each sequence's places (dense keys in its
	 * order), the root's tail after the last top-level block.
	 */
	const rebuildPlacements = (): void => {
		ix.placementFull = false;
		placementSeeds.clear();
		stateSeeds.clear();
		ownerChanged.clear();
		ix.itemKinds = declaredItems();
		for (const b of blocks.keys()) {
			const item = itemKind(b);
			if (item !== undefined) ix.itemKinds.add(item);
		}
		lineKinds = new Set(ix.roles?.lineKinds());
		ix.rowKinds = declaredRows();
		for (const b of blocks.keys()) {
			const type = blocks.get(b)?.type;
			const rows = type === undefined ? undefined : rowOfTable(type);
			if (rows !== undefined && rowKind(b) !== undefined) ix.rowKinds.set(rows[0], rows[1]);
		}
		ix.cellKinds = new Set(ix.rowKinds.values());
		kindsOf.clear();
		[layoutBlocks, itemBlocks, tableBlocks] = [0, 0, 0];
		lineCounts.clear();
		for (const b of blocks.keys()) noteKind(b);
		for (const line of lineCounts.keys()) lineKinds.add(line);
		ix.placementFull = false;
		// The first read's slots while no sequence changed since (one scan).
		const { slots, places } =
			collected !== null && collectedAt === ix.seqEpoch
				? collected
				: collectSlots(doc, blocks.values());
		collected = null;
		slotsByBlock.clear();
		for (const [b, refs] of slots) slotsByBlock.set(b, refs);
		slotsRead = true;
		placementsMap.clear();
		edges.clear();
		rawOrder.clear();
		fallen.clear();
		rejected.clear();
		keyed = false;
		for (const id of blocks.keys()) settle(id, () => {});
		if (fallen.size + rejected.size > 0) retryFallen(new Set());
		keyed = true;
		// The lists in key order: a block where its edge shows it, in its sequence's order.
		for (const [owner, list] of places)
			for (const e of list) {
				const b = slotOwner(registry, kept, (e.value as BlockSlot).b, e.unit.c);
				const pl = placementsMap.get(b);
				const h = blocks.get(b)?.home;
				if (pl?.parent !== owner || rejected.has(b) || !h || !sameUnit(h, e.unit)) continue;
				if (edges.get(b)?.via !== e.via) continue;
				const l = rawList(owner);
				pl.rank = denseKey(l.length);
				l.push({ id: b, rank: pl.rank });
			}
		const tail = [...rejected].map((x) => ({ id: x, stamp: edges.get(x)?.stamp ?? NO_SLOT }));
		for (const { id } of tail.sort(byTail)) {
			const l = rawList(null);
			const pl = placementsMap.get(id)!;
			pl.rank = keyBetween(l[l.length - 1]?.rank, undefined);
			l.push({ id, rank: pl.rank });
		}
		layoutMode = layoutBlocks + itemBlocks + tableBlocks > 0;
		ix.dissolved = new Set();
		const index = (map: Map<BlockId | null, ChildSlot[]>) => {
			const at = new Map<BlockId, Slot>();
			for (const [parent, list] of map)
				for (const { id, rank, reset } of list)
					at.set(id, reset === undefined ? { parent, rank } : { parent, rank, reset });
			return at;
		};
		ix.kids0 = childrenIndex(placementsMap, own0);
		ix.slots0 = index(ix.kids0);
		if (layoutMode) {
			ix.dissolved = dissolve(ix.kids0);
			ix.kidsMap = childrenIndex(placementsMap, ownShim);
			ix.slots = index(ix.kidsMap);
		} else [ix.kidsMap, ix.slots] = [ix.kids0, ix.slots0];
		following.clear();
		for (const id of ix.slots.keys()) noteFollowing(id);
		orderCache = null;
		ix.kidsVersion++;
		ix.allListsDirty = true;
	};
	const ensurePlacements = (): void => {
		ensureOwners();
		if (ix.placementFull) return rebuildPlacements();
		if (placementSeeds.size + stateSeeds.size + ownerChanged.size === 0) return;
		const moved = new Set<BlockId>();
		const seeds = new Set(placementSeeds);
		const done = new Set<BlockId>();
		/** Place one seed (its left neighbour first, when it is a seed too). */
		const place = (id: BlockId): void => {
			if (done.has(id) || !seeds.has(id)) return;
			done.add(id);
			if (!blocks.has(id)) {
				if (placementsMap.has(id)) {
					setPlacement(id, undefined);
					edges.delete(id);
					fallen.delete(id);
					rejected.delete(id);
					moved.add(id);
				}
				return;
			}
			const top = candidatesFor(id)[0] ?? null;
			const old = edges.get(id);
			// The same edge, placed at its strongest: its key still orders it (its neighbours' keys are theirs).
			if (
				top !== null &&
				old &&
				!rejected.has(id) &&
				!fallen.has(id) &&
				placementsMap.has(id) &&
				sameEdge(top, old)
			)
				return;
			for (const x of settle(id, place)) moved.add(x);
		};
		for (const id of [...seeds]) place(id);
		// A changed claim owner can close a cycle through a display edge that did not change.
		for (const o of ownerChanged)
			for (const c of [...(rawOrder.get(o) ?? [])]) {
				const edge = edges.get(c.id);
				if (!edge || rejected.has(c.id) || edge.parent === undefined) continue;
				if (cycleThrough(placementsMap, ownerOf, c.id, edge.parent) !== null)
					for (const x of settle(c.id, () => {})) moved.add(x);
			}
		if (rejected.size + fallen.size > 0 && (moved.size > 0 || ownerChanged.size > 0))
			retryFallen(moved);
		const seeds2 = new Set<BlockId>([...moved, ...stateSeeds, ...ownerChanged]);
		const kinds = [...stateSeeds];
		placementSeeds.clear();
		stateSeeds.clear();
		ownerChanged.clear();
		const affected = reach(seeds2);
		let touched: Iterable<BlockId> = affected;
		const changed = patch(ix.kids0, ix.slots0, own0, affected);
		let any = changed.size > 0;
		if (layoutMode) {
			const flips = redissolve(changed, kinds);
			const again = flips.size > 0 ? reach([...affected, ...flips]) : affected;
			any = patch(ix.kidsMap, ix.slots, ownShim, again).size > 0 || any;
			touched = again;
		}
		for (const id of touched) noteFollowing(id);
		if (any) {
			orderCache = null;
			ix.kidsVersion++;
		}
	};

	/**
	 * A plain block (the document's default kind) directly in a container
	 * whose item is a kind of its own that renders content (a list) shows
	 * as that item — the read-time side of the facade's `fitted`: a race
	 * (a peer's lift of an item another peer's outdent moves, a concurrent
	 * undo of a retype) or an explicit write never shows a bare paragraph
	 * in a list. Anywhere else it shows `plain`.
	 */
	const itemOf = (under: BlockId, plain: string): string => {
		const parent = typeOf(under);
		if (!ix.roles!.container(parent)) return plain;
		const item = ix.roles!.defaultChild(parent);
		return ix.roles!.rendersContent(item) ? item : plain;
	};

	/**
	 * The kind `id` displays as — THE shown-kind rule, read from its slot
	 * and the role table. A block directly in an island declared `lines`
	 * shows its line kind. A block of a line kind anywhere else shows its
	 * display parent's default child — an undo can put a line a peer
	 * retyped back in its island, or leave one a peer moved away outside
	 * it — and so does a block displayed out of an island
	 * or a container (a list) that still has its default child
	 * kind, unless an outer container shows it as one of its
	 * items (a nested list's item). A block that renders
	 * content never shows as a kind that does not: a line kind
	 * then shows the document's default kind. A block stored as the
	 * document's default kind directly in a list shows as its item
	 * (`itemOf`). Any other shows its stored kind (a retype shows). Read from the stored kinds
	 * at call time: a retype rebuilds no placement.
	 */
	const typeOf = (id: BlockId): string => {
		const stored = blocks.get(id)?.type ?? 'unknown';
		const slot = ix.slots.get(id);
		if (ix.roles === null || slot === undefined) return stored;
		const { parent: under, reset } = slot;
		const line = under === null || lineKinds.size === 0 ? undefined : lineKind(under);
		if (line !== undefined) return line;
		const lined = lineKinds.has(stored);
		const from = reset === undefined ? undefined : (blocks.get(reset)?.type ?? null);
		if (!lined && (from === undefined || stored !== ix.roles.defaultChild(from)))
			return stored === ix.roles.defaultChild(null) && under !== null
				? itemOf(under, stored)
				: stored;
		// Out of a removed list, inside an outer list of its kind: still an item. A
		// container whose item is the document's default kind (a column) holds no
		// items of its own: a paragraph under one is no list's item.
		if (!lined && typeof from === 'string' && ix.roles.container(from))
			for (let u = under; u !== null; u = ix.slots.get(u)?.parent ?? null) {
				const t = typeOf(u);
				if (
					ix.roles.container(t) &&
					ix.roles.defaultChild(t) === stored &&
					stored !== ix.roles.defaultChild(null)
				)
					return stored;
			}
		const kind = ix.roles.defaultChild(under === null ? null : typeOf(under));
		if (ix.roles.rendersContent(kind) || !ix.roles.rendersContent(stored)) return kind;
		// Never a line kind outside its island, even where the slot's kind shows nothing.
		return lined ? ix.roles.defaultChild(null) : stored;
	};

	/** The document order, cached until a child list changes. */
	const order = (): DocOrder => (orderCache ??= documentOrder(ix.kidsMap));

	return {
		ownShim,
		own0,
		noteKind,
		homeFor,
		putSlot,
		edgeParent,
		noteFollowing,
		ensurePlacements,
		reslot,
		typeOf,
		order
	};
};

export type IndexPlacement = ReturnType<typeof indexPlacement>;
