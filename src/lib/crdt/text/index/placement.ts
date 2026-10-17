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
 * block's edge is accepted unless its display parent chain reaches back
 * to it; the oldest edge of such a cycle is rejected and its block shows
 * at the root's tail (`placement/resolve.ts`), so a cycle resolves
 * locally: no global pass. A placed block's order key is found from its
 * sequence neighbours (`placement/keys.ts`), never by walking the parent's
 * sequence. The layout rules re-run only on the layouts a change reaches.
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
import { keyBetween } from '../../placement/keys.js';
import {
	NO_SLOT,
	blockBefore,
	byTail,
	cycleThrough,
	collectSlots,
	edgeOf,
	homeOf,
	registryOwners,
	resolveAll,
	slotOwner,
	type Edge,
	type Slots
} from '../../placement/resolve.js';
import { before, cmpStamp, isBlockSlot, type Entry, type Stamp } from '../../placement/slots.js';
import { Y } from '../../engine.js';
import { engineOps } from '../../structs.js';
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
		collected = collectSlots(doc, registryOwners(registry, kept), kept);
		collectedAt = ix.seqEpoch;
		for (const [b, refs] of collected.slots) slotsByBlock.set(b, refs);
	};
	/** `id`'s home slot among the slots naming its registry id (`null`: none). */
	const homeFor = (id: BlockId): ReturnType<typeof homeOf> => {
		if (!slotsRead) readSlots();
		return homeOf(registry, kept, slotsByBlock, id);
	};
	/** `id`'s display edge, read from the engine (`null`: no slot, or gone). */
	const edgeOfBlock = (id: BlockId): Edge | null => {
		const home = blocks.get(id)?.home ?? homeFor(id);
		return home === null ? null : edgeOf(doc, registry, kept, home);
	};
	/** The owner of the sequence `id`'s slot shows in (`null`: the root), as the engine stands. */
	const edgeParent = (id: BlockId): BlockId | null | undefined => edgeOfBlock(id)?.parent;
	/** The raw children of `parent` in order (every block whose edge parent it is), kept sorted by key. */
	const rawList = (parent: BlockId | null): ChildSlot[] => {
		let l = rawOrder.get(parent);
		if (l === undefined) rawOrder.set(parent, (l = []));
		return l;
	};
	const setPlacement = (id: BlockId, pl: ResolvedPlacement | undefined): void => {
		ix.foldStats.placed++;
		const old = placementsMap.get(id);
		if (old !== undefined) {
			const l = rawList(old.parent);
			const at = seek(l, { id, rank: old.rank });
			if (l[at]?.id === id) l.splice(at, 1);
			if (l.length === 0) rawOrder.delete(old.parent);
		}
		if (pl === undefined) placementsMap.delete(id);
		else {
			placementsMap.set(id, pl);
			const l = rawList(pl.parent);
			const slot = { id, rank: pl.rank };
			l.splice(seek(l, slot), 0, slot);
		}
	};
	/**
	 * The key `id` takes under `edge.parent`: between the key of the block
	 * before its displaying unit in the sequence (placed first when it is
	 * a pending seed; walked past when it shows elsewhere) and the next key
	 * of that list.
	 */
	const keyFor = (id: BlockId, edge: Edge, place: (b: BlockId) => void): string => {
		const isBlock = (e: Entry) => isBlockSlot(e.value);
		const home = blocks.get(id)?.home ?? homeFor(id)!;
		let prev = blockBefore(doc, registry, kept, home, edge);
		let lrank: string | undefined;
		for (let guard = 0; prev !== null && guard < 256; guard++) {
			// A slot that is not its block's home (a second creation of one id) places nothing.
			const h = blocks.get(prev.block)?.home ?? homeFor(prev.block);
			if (h !== null && h.c === prev.entry.unit.c && h.k === prev.entry.unit.k) {
				place(prev.block);
				const pl = placementsMap.get(prev.block);
				if (pl !== undefined && pl.parent === edge.parent && !rejected.has(prev.block)) {
					lrank = pl.rank;
					break;
				}
			}
			const e = before(doc, prev.entry, isBlock);
			if (e === null) break;
			prev = {
				entry: e,
				block: slotOwner(registry, kept, (e.value as { b: BlockId }).b, e.unit.c)
			};
		}
		const list = rawOrder.get(edge.parent as BlockId | null) ?? [];
		const i = lrank === undefined ? 0 : seek(list, { id: '', rank: lrank }) + 1;
		return keyBetween(lrank, list[i]?.rank);
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
	/** Show `id` at the root's tail: its edge rejected (a cycle), or none. */
	const reject = (id: BlockId, edge: Edge | null): void => {
		edges.set(id, edge);
		if (placementsMap.has(id)) setPlacement(id, undefined);
		rejected.add(id);
		setPlacement(id, { parent: null, rank: tailKey(id, edge?.stamp ?? NO_SLOT), home: false });
	};
	/**
	 * Accept `id`'s `edge`, unless it closes a cycle through the accepted
	 * edges and the claim owners: then the cycle's oldest edge is rejected
	 * (its block shows at the root's tail, its subtree with it), and `id`'s
	 * is accepted when it is not that one. `place` places a pending
	 * neighbour first. Returns the blocks whose placement changed.
	 */
	const accept = (id: BlockId, edge: Edge, place: (b: BlockId) => void): BlockId[] => {
		const changed = [id];
		const parent = edge.parent;
		if (parent === undefined || (parent !== null && !blocks.has(parent))) {
			reject(id, edge);
			return changed;
		}
		const cycle = cycleThrough(placementsMap, ownerOf, id, parent);
		if (cycle !== null) {
			let [min, minStamp] = [id, edge.stamp];
			for (const m of cycle) {
				const e = m === id ? edge : edges.get(m);
				if (m !== id && e && cmpStamp(e.stamp, minStamp) < 0) [min, minStamp] = [m, e.stamp];
			}
			if (min === id) {
				reject(id, edge);
				return changed;
			}
			reject(min, edges.get(min) ?? null);
			changed.push(min);
		}
		edges.set(id, edge);
		rejected.delete(id);
		if (placementsMap.has(id)) setPlacement(id, undefined);
		setPlacement(id, { parent, rank: keyFor(id, edge, place), home: edge.via === null });
		return changed;
	};
	/** The same display edge: the same sequence, the same record, the same stamp. */
	const sameEdge = (a: Edge, b: Edge): boolean =>
		a.parent === b.parent && a.via === b.via && cmpStamp(a.stamp, b.stamp) === 0;
	/**
	 * Try every rejected block again (a changed edge may have broken its
	 * cycle, or made it the one to reject): accepted ones join `moved`.
	 */
	const retryRejected = (moved: Set<BlockId>): void => {
		for (let round = 0; round < rejected.size + 2 && rejected.size > 0; round++) {
			let changed = false;
			const tail = [...rejected]
				.map((x) => ({ id: x, stamp: edges.get(x)?.stamp ?? NO_SLOT }))
				.sort(byTail);
			for (const { id } of tail) {
				const edge = edgeOfBlock(id);
				if (edge === null || edge.parent === undefined) continue;
				if (edge.parent !== null && !blocks.has(edge.parent)) continue;
				const cycle = cycleThrough(placementsMap, ownerOf, id, edge.parent);
				if (cycle !== null) {
					let oldest = edge.stamp;
					for (const m of cycle) {
						const e = edges.get(m);
						if (m !== id && e && cmpStamp(e.stamp, oldest) < 0) oldest = e.stamp;
					}
					if (oldest === edge.stamp) continue; // still the one to reject
				}
				for (const x of accept(id, edge, () => {})) moved.add(x);
				changed = true;
			}
			if (!changed) break;
		}
	};
	/** Everything rebuilt from the sequences (the first build, roles). */
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
		const resolved = resolveAll(
			doc,
			blocks,
			ownerOf,
			kept,
			collected !== null && collectedAt === ix.seqEpoch ? collected : undefined
		);
		collected = null;
		placementsMap.clear();
		rawOrder.clear();
		edges.clear();
		rejected.clear();
		slotsByBlock.clear();
		for (const [b, refs] of resolved.slots) slotsByBlock.set(b, refs);
		slotsRead = true;
		for (const rec of blocks.values()) rec.home = resolved.homes.get(rec.id) ?? null;
		for (const [id, pl] of resolved.placements) setPlacement(id, pl);
		for (const [id, e] of resolved.edges) edges.set(id, e);
		for (const id of resolved.rejected) rejected.add(id);
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
					rejected.delete(id);
					moved.add(id);
				}
				return;
			}
			const edge = edgeOfBlock(id);
			const old = edges.get(id);
			// The same edge, placed: its key still orders it (its neighbours' keys are theirs).
			if (edge !== null && old && !rejected.has(id) && placementsMap.has(id) && sameEdge(edge, old))
				return;
			if (edge === null) {
				reject(id, null);
				moved.add(id);
			} else for (const x of accept(id, edge, place)) moved.add(x);
		};
		for (const id of [...seeds]) place(id);
		// A changed claim owner can close a cycle through a display edge that did not change.
		for (const o of ownerChanged)
			for (const c of [...(rawOrder.get(o) ?? [])]) {
				const edge = edges.get(c.id);
				if (!edge || rejected.has(c.id) || edge.parent === undefined) continue;
				if (cycleThrough(placementsMap, ownerOf, c.id, edge.parent) !== null)
					for (const x of accept(c.id, edge, () => {})) moved.add(x);
			}
		if (rejected.size > 0 && (moved.size > 0 || ownerChanged.size > 0)) retryRejected(moved);
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
		edgeParent,
		noteFollowing,
		ensurePlacements,
		typeOf,
		order
	};
};

export type IndexPlacement = ReturnType<typeof indexPlacement>;
