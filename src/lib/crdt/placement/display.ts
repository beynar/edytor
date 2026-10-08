/**
 * Where a block displays: its display slot (read-time promotion out of a
 * deleted, childless or passing parent, the line and layout rules), the
 * children index and document order built from it, the text order of a
 * text's pieces (`textRanker`), liveness, and the inverse of the claim
 * owners. Pure over replicated state and the ownership the caller passes.
 */
import { DEAD, type Owner } from '../text/model.js';
import { promotedRank } from './source.js';
import type {
	BlockId,
	BlockRec,
	ChildSlot,
	DisplayOwnership,
	DocOrder,
	ModelView,
	ResolvedPlacement
} from './model.js';

/**
 * Split pieces in text order (`order.split.text`): the blocks whose streams lie in one
 * backing text and that still stand where they were made (their winning
 * placement is their first candidate, `1.<client>`: no move, outdent or
 * lift since) under one parent show in their streams' order in that text —
 * the order of the boundaries that delimit them, the same on every
 * replica — at the ranks they hold between them: the i-th of them in the
 * text takes the i-th smallest of their ranks. Ranks written at a split
 * (`sourceRank`) are a guess made on one replica's text; the boundaries are
 * the replicated fact, so two peers splitting one block at once keep the
 * text's order whatever each saw (an unseen edit after one's own split
 * point included). A block moved since stands where it was moved.
 *
 * `inText(home)`: the blocks of `home`'s text, in text order (segment 0's
 * first). Memoized per (text, parent) until `forget(home)`.
 */
export const textRanker = (
	blocks: ReadonlyMap<BlockId, BlockRec>,
	placements: ReadonlyMap<BlockId, ResolvedPlacement>,
	homeOf: (b: BlockId) => BlockId | undefined,
	inText: (home: BlockId) => readonly BlockId[]
) => {
	const memo = new Map<string, Map<BlockId, string>>();
	const keysOf = new Map<BlockId, Set<string>>();
	/** `b` stands where it was made: its placement is its first candidate's. */
	const unmoved = (b: BlockId): boolean => {
		const c = blocks.get(b)?.cands[0];
		const pl = placements.get(b);
		if (c === undefined || pl === undefined || c.seq !== 1 || c.r !== pl.rank) return false;
		return pl.parent === (c.p !== null && !blocks.has(c.p) ? null : c.p);
	};
	const group = (home: BlockId, parent: BlockId | null): Map<BlockId, string> => {
		const members: BlockId[] = [];
		for (const b of inText(home))
			if (placements.get(b)?.parent === parent && unmoved(b)) members.push(b);
		const out = new Map<BlockId, string>();
		if (members.length < 2) return out;
		const rankOf = (b: BlockId) => placements.get(b)!.rank;
		// One client's blocks keep its own order (it ranked them knowing each
		// other); the text decides between different clients' (concurrent
		// splits). Each client's members, sorted by rank, fill that client's
		// places in the text order.
		const byClient = new Map<number, BlockId[]>();
		for (const b of members) {
			const c = blocks.get(b)!.cands[0]!.client;
			const list = byClient.get(c);
			if (list === undefined) byClient.set(c, [b]);
			else list.push(b);
		}
		if (byClient.size < 2) return out;
		for (const list of byClient.values())
			list.sort((x, y) => bySlot({ id: x, rank: rankOf(x) }, { id: y, rank: rankOf(y) }));
		const next = new Map<number, number>();
		const order = members.map((b) => {
			const c = blocks.get(b)!.cands[0]!.client;
			const i = next.get(c) ?? 0;
			next.set(c, i + 1);
			return byClient.get(c)![i]!;
		});
		const ranks = members.map(rankOf).sort();
		order.forEach((b, i) => out.set(b, ranks[i]));
		return out;
	};
	return {
		rank: (id: BlockId, parent: BlockId | null, rank: string): string => {
			const home = homeOf(id);
			// A text no other block shares (most blocks' own): nothing to order.
			if (home === undefined || inText(home).length < 2) return rank;
			const key = `${home}\u0000${parent}`;
			let ranks = memo.get(key);
			if (ranks === undefined) {
				memo.set(key, (ranks = group(home, parent)));
				let keys = keysOf.get(home);
				if (keys === undefined) keysOf.set(home, (keys = new Set()));
				keys.add(key);
			}
			return ranks.get(id) ?? rank;
		},
		/**
		 * Decide `home`'s text again (its segments or a member's placement
		 * changed); the blocks whose text-order rank changed.
		 */
		regroup: (home: BlockId): Set<BlockId> => {
			const before = new Map<BlockId, string>();
			for (const key of keysOf.get(home) ?? [])
				for (const [b, r] of memo.get(key) ?? []) before.set(b, r);
			for (const key of keysOf.get(home) ?? []) memo.delete(key);
			const keys = new Set<string>();
			keysOf.set(home, keys);
			const changed = new Set<BlockId>();
			const parents = new Set<BlockId | null>();
			const row = inText(home);
			if (row.length >= 2)
				for (const b of row) {
					const pl = placements.get(b);
					if (pl !== undefined) parents.add(pl.parent);
				}
			for (const parent of parents) {
				const key = `${home}\u0000${parent}`;
				const ranks = group(home, parent);
				memo.set(key, ranks);
				keys.add(key);
				for (const [b, r] of ranks) if (before.get(b) !== r) changed.add(b);
			}
			for (const [b, r] of before) {
				const now = memo.get(`${home}\u0000${placements.get(b)?.parent}`)?.get(b);
				if (now !== r) changed.add(b);
			}
			return changed;
		},
		/** Drop what was decided for `home`'s text (every one, without it). */
		forget: (home?: BlockId): void => {
			if (home === undefined) {
				memo.clear();
				keysOf.clear();
				return;
			}
			for (const key of keysOf.get(home) ?? []) memo.delete(key);
			keysOf.delete(home);
		}
	};
};

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

/**
 * THE liveness answer: `id` carries no live delete mark, owns
 * itself (`own.hidden` covers both: a delete-marked or unknown block owns
 * `DEAD`), and every display ancestor is live — i.e. it renders in
 * `project()`. Every op precondition, read and view consumer asks this.
 * O(depth).
 */
export const isLiveIn = (v: Pick<ModelView, 'placements' | 'own'>, id: BlockId): boolean => {
	const { placements, own } = v;
	const seen = new Set<BlockId>();
	for (let cur: BlockId | null = id; cur !== null; ) {
		if (seen.has(cur) || own.hidden(cur)) return false;
		seen.add(cur);
		const pl = placements.get(cur);
		const dp: Owner | null = pl === undefined ? DEAD : displayParentOf(own, pl, placements, cur);
		if (dp === DEAD) return false;
		cur = dp;
	}
	return true;
};

/**
 * Where a placement DISPLAYS: its display parent and its rank in that
 * parent's children list. A live parent shows its children; a merged-away
 * one resolves to its claim owner, the merge destination (B+C merged while
 * A+B merged: C's children land on B, B is claimed by A → they display
 * under A). A delete-marked parent hides no unmarked child — promotion is
 * derived at read time (`del.blocks.promote`): the child takes the
 * deleted parent's slot, ranked just after it ({@link promotedRank}),
 * recursively. So whatever a peer split off, inserted or moved under a
 * block another writer deleted stays in the document. A childless owner (a
 * void kind, `own.childless`) sheds its children the same way: a
 * block a peer nests or splits under a block another peer retypes to a void
 * kind takes the void's slot on every replica, and returns under it if the
 * retype is undone. A block that displays out of an island — promoted out
 * of a deleted one, or under the owner of a merged-away one — names it
 * (`reset`, the innermost): while it still has the island's default child
 * kind it displays as its display parent's default child, as a delete or
 * merge of the island retypes the children it saw. A container (a list) is
 * a `reset` too: an item a peer adds to a list another peer's edit removes
 * shows as a paragraph, not as a bare item; a block promoted
 * INTO a container names the block it is promoted out of, so it shows as
 * the container's item as a delete's write makes it. A code line a peer adds
 * under a code block another peer deletes or merges shows as a paragraph,
 * not as a code line outside its code block. A line of an island declared
 * `lines` holds no children: they take the island's
 * slot, ranked in the line's order, with the island as `reset` — a block a
 * peer nested under a code line while an undone delete had made it a
 * paragraph shows right after the code block, and stays there when the
 * line is deleted. The layout rules pass the same way (`layout.*`):
 * a layout sheds a child that is no item of it into its own slot, right
 * after it (`own.sheds`, by the stored kind of `id`, the block placed), and
 * a block the layout rules do not display (`own.passes`: an empty or bare
 * item, a layout showing one item or none) hands its children its slot,
 * as a deleted one does — so the rank a dissolve's write gives the blocks
 * it moves (`promotedRank` of the layout's, then the item's) is the one
 * read here. `DEAD` only when the placement chain never reaches a live
 * parent (an unknown block).
 */
export const displaySlotOf = (
	own: DisplayOwnership,
	placements: ReadonlyMap<BlockId, ResolvedPlacement>,
	pl: ResolvedPlacement,
	id: BlockId
): { parent: Owner | null; rank: string; reset: BlockId | null } => {
	let { parent, rank } = pl;
	// A piece of a text shown under its own placement's parent takes its text-order rank;
	// a table's cell its column's (`table.columns`).
	const direct = (owner: BlockId | null): string => {
		if (owner !== pl.parent) return rank;
		const ruled = owner === null ? undefined : own.slotRank?.(owner, id, rank);
		if (ruled !== undefined) return ruled;
		return own.textRank === undefined ? rank : own.textRank(id, owner, rank);
	};
	let reset: BlockId | null = null;
	/** The first parent it is promoted out of (a deleted or childless one). */
	let promoted: BlockId | null = null;
	const resets = (b: BlockId) => own.island?.(b) === true || own.container?.(b) === true;
	for (let hops = 0; parent !== null; hops++) {
		const owner = own.ownerOf(parent);
		if (reset === null && owner !== parent && resets(parent)) reset = parent;
		const out = owner === DEAD ? parent : owner;
		const shows =
			owner !== DEAD &&
			own.childless?.(owner) !== true &&
			own.passes?.(owner) !== true &&
			own.sheds?.(owner, id) !== true;
		// A line holds no children — a deleted or childless one
		// neither: they take its island's slot, never the island.
		const line =
			own.lined &&
			(shows ? lineSlotOf(own, placements, owner) : storedLineSlotOf(own, placements, out));
		if (line) {
			const slot = displaySlotOf(own, placements, placements.get(line.parent)!, line.parent);
			const inner = promotedRank(line.rank, rank);
			return {
				parent: slot.parent,
				rank: promotedRank(slot.rank, inner),
				reset: reset ?? line.parent
			};
		}
		// Promoted into a container: it shows as one of its items.
		if (shows && reset === null && promoted !== null && own.container?.(owner) === true)
			reset = promoted;
		if (shows) return { parent: owner, rank: hops === 0 ? direct(owner) : rank, reset };
		promoted ??= out;
		const up = placements.get(out);
		if (up === undefined || hops > placements.size) return { parent: DEAD, rank, reset };
		if (reset === null && resets(out)) reset = out;
		rank = promotedRank(up.rank, rank);
		parent = up.parent;
	}
	return { parent: null, rank: pl.parent === null ? direct(null) : rank, reset };
};

/**
 * The slot of `b` when it is a line — it displays (or, deleted, would
 * display) directly under a `lines` island ({@link DisplayOwnership.lined}) — else
 * `null`. A block a peer nests under a line, while an undone delete or merge
 * of the island had made the line a plain block, displays right after the
 * island instead: visible, and outside the island's seal.
 */
const lineSlotOf = (
	own: DisplayOwnership,
	placements: ReadonlyMap<BlockId, ResolvedPlacement>,
	b: BlockId
): { parent: BlockId; rank: string } | null => {
	const pl = placements.get(b);
	if (pl === undefined || pl.parent === null) return null;
	// Fast path: a live parent that shows its children (`b` among them) and is no lined island.
	const p = own.ownerOf(pl.parent);
	if (
		p === pl.parent &&
		own.childless?.(p) !== true &&
		own.lined?.(p) !== true &&
		own.passes?.(p) !== true &&
		own.sheds?.(p, b) !== true
	)
		return null;
	const slot = displaySlotOf(own, placements, pl, b);
	if (slot.parent === null || slot.parent === DEAD || own.lined?.(slot.parent) !== true)
		return null;
	return { parent: slot.parent, rank: slot.rank };
};

/**
 * The slot of a deleted or childless `b` when it is stored directly under a
 * live `lines` island, else `null` — one read, no walk: the promotion walk
 * asks it at every hop.
 */
const storedLineSlotOf = (
	own: DisplayOwnership,
	placements: ReadonlyMap<BlockId, ResolvedPlacement>,
	b: BlockId
): { parent: BlockId; rank: string } | null => {
	const pl = placements.get(b);
	if (pl === undefined || pl.parent === null || own.ownerOf(pl.parent) !== pl.parent) return null;
	return own.lined?.(pl.parent) === true ? { parent: pl.parent, rank: pl.rank } : null;
};

/** The parent under which block `id`'s placement DISPLAYS ({@link displaySlotOf}). */
export const displayParentOf = (
	own: DisplayOwnership,
	pl: ResolvedPlacement,
	placements: ReadonlyMap<BlockId, ResolvedPlacement>,
	id: BlockId
): Owner | null => displaySlotOf(own, placements, pl, id).parent;

/**
 * All visible children's lists at once: `parent|null → {id, rank}[]` sorted
 * by `(rank, id)` — ONE pass over `placements` plus one sort per list. This
 * is the order the projection emits; a promoted block's `rank` is its
 * promoted one ({@link displaySlotOf}).
 */
export const childrenIndex = (
	placements: Map<BlockId, ResolvedPlacement>,
	own: DisplayOwnership
): Map<BlockId | null, ChildSlot[]> => {
	const index = new Map<BlockId | null, ChildSlot[]>();
	for (const [id, pl] of placements) {
		if (own.hidden(id)) continue;
		const { parent, rank, reset } = displaySlotOf(own, placements, pl, id);
		if (parent === DEAD) continue;
		const slot: ChildSlot = reset === null ? { id, rank } : { id, rank, reset };
		const bucket = index.get(parent);
		if (bucket) bucket.push(slot);
		else index.set(parent, [slot]);
	}
	for (const bucket of index.values()) bucket.sort(bySlot);
	return index;
};

/** The order of a children list: by rank, ties by id. */
export const bySlot = (
	a: { id: BlockId; rank: string },
	b: { id: BlockId; rank: string }
): number => (a.rank === b.rank ? a.id.localeCompare(b.id) : a.rank < b.rank ? -1 : 1);

export const documentOrder = (kids: ModelView['kids']): DocOrder => {
	const ids: BlockId[] = [];
	const at = new Map<BlockId, number>();
	const stack = [...(kids.get(null) ?? [])].reverse();
	for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
		at.set(next.id, ids.length);
		ids.push(next.id);
		const own = kids.get(next.id) ?? [];
		for (let i = own.length - 1; i >= 0; i--) stack.push(own[i]);
	}
	return { ids, at };
};
