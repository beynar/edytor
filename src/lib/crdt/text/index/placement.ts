/**
 * Placements and the children index (P3: maintained), the display
 * ownership the display reads (`ownShim`), and THE shown-kind rule
 * (`typeOf`).
 *
 * A structural change re-decides only what it can change: the winning
 * placement of the blocks whose candidates (or whose parent's
 * registry entry) changed, and the display slot of every block whose
 * slot walk (`displaySlotOf`) reads one that changed — its stored
 * subtree, through the blocks it displays — patched into the parents'
 * child lists. While every block shows its winning candidate (no
 * cycle rejected, none rehomed), a block's placement is its argmax
 * (`resolvePlacements` accepts it), so only a cycle through a changed
 * display edge needs the global resolution, which then runs whole.
 * The layout rules re-run only on the layouts a change reaches.
 */
import {
	type BlockId,
	type BlockRec,
	type ChildSlot,
	type DisplayOwnership,
	type DocOrder,
	type ResolvedPlacement,
	bySlot,
	childrenIndex,
	displaySlotOf,
	documentOrder,
	resolvePlacements,
	textRanker
} from '../../placement/model.js';
import { DEAD, displayOf } from '../model.js';
import type { IndexClaims } from './claims.js';
import type { IndexLayout } from './layout.js';
import { addTo, dropFrom } from './shared.js';
import type { IndexState, Slot } from './state.js';
import type { IndexStreams } from './streams.js';

/** Placement maintenance of one doc's index, over its state, claims, streams and layout rules. */
export const indexPlacement = (ix: IndexState & IndexClaims & IndexStreams & IndexLayout) => {
	const {
		blocks,
		displaysMap,
		ownerChanged,
		streamIx,
		placed,
		placementsMap,
		regroup,
		byArgParent,
		following,
		dirtyLists,
		leftLists,
		placementSeeds,
		stateSeeds,
		kindsOf,
		ensureOwners,
		ownerOf,
		top,
		streamOf,
		streamsIn,
		streamAt,
		role,
		lineKind,
		itemKind,
		declaredItems,
		dissolve,
		redissolve
	} = ix;

	// ── placements and the children index (P3: maintained) ────────────
	/** The blocks of `home`'s text, in text order (segment 0's first). */
	const rowBlocks = (home: BlockId): BlockId[] => {
		const at = placed.get(home);
		if (at === undefined) return [];
		return at.head === null ? at.blocks : [at.head, ...at.blocks];
	};
	const ranker = textRanker(blocks, placementsMap, (b) => streamIx.get(b)?.home, rowBlocks);
	/** Resolved parent → the blocks placed under it. */
	const kidsOf = new Map<BlockId | null, Set<BlockId>>();
	/** The document holds a layout or an item kind: `kids0` and `kidsMap` differ. */
	let layoutMode = false;
	/** The line kinds the roles declare, and those of the lines islands the document holds. */
	let lineKinds = new Set<string>();
	let orderCache: DocOrder | null = null;
	/** Some block shows no argmax candidate (a cycle rejected one, or none): passes run whole. */
	let irregular = false;
	let layoutBlocks = 0;
	let itemBlocks = 0;
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
			const item = itemKind(owner);
			return item !== undefined && blocks.get(child)?.type !== item;
		},
		top,
		streamOf,
		streamsIn,
		streamAt,
		display: (b) => displayOf(b, blocks, ownShim),
		textRank: (id, parent, rank) => ranker.rank(id, parent, rank)
	};
	/** Re-count `id`'s kind facts; a fact the roles never declared forces a full pass. */
	const noteKind = (id: BlockId): void => {
		const old = kindsOf.get(id);
		const type = blocks.get(id)?.type;
		const now =
			type === undefined
				? undefined
				: { layout: itemKind(id) !== undefined, item: ix.itemKinds.has(type), line: lineKind(id) };
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
		if (layoutMode !== layoutBlocks + itemBlocks > 0) ix.placementFull = true;
	};
	/** The argmax candidate's parent (a registry entry or the root), and its index entry. */
	const argParent = (rec: BlockRec | undefined): BlockId | null | undefined => rec?.cands[0]?.p;
	const noteCands = (id: BlockId, before: BlockId | null | undefined): void => {
		const after = argParent(blocks.get(id));
		if (before === after) return;
		if (typeof before === 'string') dropFrom(byArgParent, before, id);
		if (typeof after === 'string') addTo(byArgParent, after, id);
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
			for (const c of kidsOf.get(x) ?? []) stack.push(c);
			for (const d of displaysMap.get(x) ?? [])
				if (d !== x) for (const c of kidsOf.get(d) ?? []) stack.push(c);
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
	/** The placement `resolvePlacements` gives `id` while every block shows its argmax. */
	const argmaxOf = (id: BlockId): ResolvedPlacement | null | undefined => {
		const rec = blocks.get(id);
		if (rec === undefined) return undefined;
		const c = rec.cands[0];
		if (c === undefined) return null;
		const p = c.p !== null && !blocks.has(c.p) ? null : c.p;
		return { parent: p, rank: c.r };
	};
	/** A display edge walk from `id`'s parent reaches `id` (or loops): the argmax graph has a cycle. */
	const cyclic = (id: BlockId): boolean => {
		let steps = 0;
		for (let cur = placementsMap.get(id)?.parent ?? null; cur !== null; ) {
			const o = ownerOf(cur);
			const at = o === DEAD ? cur : o;
			if (at === id || ++steps > blocks.size) return true;
			const cp = placementsMap.get(at);
			if (cp === undefined) return false;
			cur = cp.parent;
		}
		return false;
	};
	const setPlacement = (id: BlockId, pl: ResolvedPlacement | undefined): void => {
		const old = placementsMap.get(id);
		if (old !== undefined) dropFrom(kidsOf, old.parent, id);
		if (pl === undefined) placementsMap.delete(id);
		else {
			placementsMap.set(id, pl);
			addTo(kidsOf, pl.parent, id);
		}
	};
	/** Everything rebuilt from the records (the first build, roles, an irregular state). */
	const rebuildPlacements = (): void => {
		ix.placementFull = false;
		ranker.forget();
		regroup.clear();
		placementSeeds.clear();
		stateSeeds.clear();
		ownerChanged.clear();
		ix.itemKinds = declaredItems();
		for (const b of blocks.keys()) {
			const item = itemKind(b);
			if (item !== undefined) ix.itemKinds.add(item);
		}
		lineKinds = new Set(ix.roles?.lineKinds());
		kindsOf.clear();
		[layoutBlocks, itemBlocks] = [0, 0];
		lineCounts.clear();
		for (const b of blocks.keys()) noteKind(b);
		for (const line of lineCounts.keys()) lineKinds.add(line);
		ix.placementFull = false;
		const resolved = resolvePlacements(blocks, ownerOf);
		placementsMap.clear();
		kidsOf.clear();
		irregular = false;
		for (const [id, pl] of resolved) {
			setPlacement(id, pl);
			const arg = argmaxOf(id);
			if (!arg || arg.parent !== pl.parent || arg.rank !== pl.rank) irregular = true;
		}
		layoutMode = layoutBlocks + itemBlocks > 0;
		ix.dissolved = new Set();
		const index = (own: DisplayOwnership, map: Map<BlockId | null, ChildSlot[]>) => {
			const at = new Map<BlockId, Slot>();
			for (const [parent, list] of map)
				for (const { id, rank, reset } of list)
					at.set(id, reset === undefined ? { parent, rank } : { parent, rank, reset });
			void own;
			return at;
		};
		ix.kids0 = childrenIndex(placementsMap, own0);
		ix.slots0 = index(own0, ix.kids0);
		if (layoutMode) {
			ix.dissolved = dissolve(ix.kids0);
			ix.kidsMap = childrenIndex(placementsMap, ownShim);
			ix.slots = index(ownShim, ix.kidsMap);
		} else [ix.kidsMap, ix.slots] = [ix.kids0, ix.slots0];
		following.clear();
		for (const id of ix.slots.keys()) noteFollowing(id);
		orderCache = null;
		ix.kidsVersion++;
		ix.allListsDirty = true;
	};
	const ensurePlacements = (): void => {
		ensureOwners();
		if (ix.placementFull || irregular) {
			if (ix.placementFull || placementSeeds.size + stateSeeds.size + ownerChanged.size > 0)
				rebuildPlacements();
			return;
		}
		if (placementSeeds.size + stateSeeds.size + ownerChanged.size + regroup.size === 0) return;
		const moved = new Set<BlockId>();
		for (const id of placementSeeds) {
			// D-18: a candidate change (a move, even to the same slot) re-decides its text's order.
			const home = streamIx.get(id)?.home;
			if (home !== undefined) regroup.add(home);
			const next = argmaxOf(id);
			if (next === null) return rebuildPlacements();
			const old = placementsMap.get(id);
			if (old?.parent === next?.parent && old?.rank === next?.rank) continue;
			setPlacement(id, next);
			moved.add(id);
		}
		// A changed display edge closing a cycle needs the global resolution.
		for (const id of moved) if (cyclic(id)) return rebuildPlacements();
		for (const o of ownerChanged)
			for (const c of kidsOf.get(o) ?? []) if (cyclic(c)) return rebuildPlacements();
		const seeds = new Set<BlockId>([...moved, ...stateSeeds, ...ownerChanged]);
		// D-18: every block of a text whose pieces' order may have changed re-reads its slot.
		for (const home of regroup)
			for (const b of ranker.regroup(home)) if (placementsMap.has(b)) seeds.add(b);
		regroup.clear();
		const kinds = [...stateSeeds];
		placementSeeds.clear();
		stateSeeds.clear();
		ownerChanged.clear();
		const affected = reach(seeds);
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
	 * The kind `id` displays as — THE shown-kind rule, read from its slot
	 * and the role table. A block directly in an island declared `lines`
	 * shows its line kind. A block of a line kind anywhere else shows its
	 * display parent's default child — an undo can put a line a peer
	 * retyped back in its island, or leave one a peer moved away outside
	 * it (FW-01 sweep) — and so does a block displayed out of an island
	 * or a container (a list, DR-crdt-2) that still has its default child
	 * kind (RW-01), unless an outer container shows it as one of its
	 * items (a nested list's item, SW8-roles-4). A block that renders
	 * content never shows as a kind that does not (DR-crdt-1): a line kind
	 * then shows the document's default kind (ZW-06). A block stored as the
	 * document's default kind directly in a list shows as its item
	 * (`itemOf`, AW-04). Any other shows its stored kind (a retype shows). Read from the stored kinds
	 * at call time: a retype rebuilds no placement.
	 */
	/**
	 * A plain block (the document's default kind) directly in a container
	 * whose item is a kind of its own that renders content (a list) shows
	 * as that item — the read-time side of the facade's `fitted`: a race
	 * (a peer's lift of an item another peer's outdent moves, a concurrent
	 * undo of a retype) or an explicit write never shows a bare paragraph
	 * in a list (AW-04). Anywhere else it shows `plain`.
	 */
	const itemOf = (under: BlockId, plain: string): string => {
		const parent = typeOf(under);
		if (!ix.roles!.container(parent)) return plain;
		const item = ix.roles!.defaultChild(parent);
		return ix.roles!.rendersContent(item) ? item : plain;
	};

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
		// Never a line kind outside its island, even where the slot's kind shows nothing (ZW-06).
		return lined ? ix.roles.defaultChild(null) : stored;
	};

	/** The document order, cached until a child list changes. */
	const order = (): DocOrder => (orderCache ??= documentOrder(ix.kidsMap));

	return {
		ranker,
		ownShim,
		own0,
		noteKind,
		argParent,
		noteCands,
		noteFollowing,
		ensurePlacements,
		typeOf,
		order
	};
};

export type IndexPlacement = ReturnType<typeof indexPlacement>;
