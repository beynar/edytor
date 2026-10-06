/**
 * Placement engine (U03) — the Edytor document model on vendored Yjs v14.
 *
 * Architecture: every block is a stable registry entry keyed by its logical
 * id; displayed structure is DERIVED from per-block placement candidate
 * records, never from physical nesting.
 *
 * ```
 * doc.get('blocks')                        registry — flat map, block-id → node
 *   └ <blockId>  node('block')             stable identity; survives every move
 *        ├ id / type / data / n            payload attrs (n: incarnation nonce)
 *        ├ del.<writer>                     per-writer delete marks (any live mark = deleted)
 *        ├ content → node('content')       BACKING text of a block created fresh (R2)
 *        ├ claims → node('claims')         ordered merge claims `{m}` (R2)
 *        └ at → node('at')                 placement candidate map
 *             └ "<seq>.<clientId>" → { p: parentId|null, r: rank }
 * ```
 *
 * Placement record semantics (see docs/crdt-v14-move-adr.md):
 *
 * - `{p, r}` is written atomically as ONE attr value under an ever-increasing
 *   per-writer key `seq.clientId`. Parent and rank can never merge across
 *   records — the atomicity requirement.
 * - Winner per block = the max candidate under total order
 *   `(seq, clientId, blockId)` — LWW over replicated, delivery-order-free
 *   metadata. Candidates beyond the top two are tombstoned on write
 *   (compaction); the runner-up is kept as the acyclic fallback.
 * - Projection resolves placements greedily in that order: accept a
 *   candidate's parent edge iff its DISPLAY edge `owner(p)` cannot close a
 *   cycle through already accepted display edges; otherwise try the next
 *   candidate; a block with no acceptable candidate is rehomed at the root
 *   (deterministic, acyclic, pure — no repair writes). The acyclic relation
 *   is the COMPOSED one — raw placements are acyclic but merge claims can
 *   redirect a display edge back into the block's own subtree.
 * - Delete marks `del.<writer>` are independent replicated attrs: a marked
 *   block is hidden regardless of which placement candidate wins — explicit
 *   deletion beats concurrent move. Deleting marks the block and every
 *   block it displays through merge claims (R3), a whole-subtree delete
 *   every member; undo removes only the undoer's mark. An unmarked block
 *   under a marked one is promoted into its slot at read time
 *   (`displaySlotOf`), so a concurrent child is never hidden with it; a
 *   block under a void kind (`DisplayOwnership.childless`) likewise.
 *
 * Content ownership (R2, `text/model.ts`): a block displays its stream —
 * delimited by boundary items in a backing text — then the displays of the
 * blocks it claims. A split inserts one boundary; a merge appends one claim;
 * no text is ever copied.
 *
 * The module is engine-agnostic: `bindModel(Y)` takes the vendored module
 * surface so this file type-checks against structural interfaces and never
 * imports vendor `.js` (which `pnpm check` must not traverse).
 */
import type { EngineApi, EngineDoc, EngineItemRef, EngineNode } from '../engine-api.js';
import { decodeRank, encodeRank, rankAfter, rankBetween, RANK_VMIN } from './rank.js';
import {
	AT,
	AT_NODE,
	BLOCK_NODE,
	CONTENT,
	CONTENT_NODE,
	DEL_PREFIX,
	hasDeleteMark,
	ID,
	CLAIMS,
	CLAIMS_NODE,
	INLINE_NODE,
	isNodeLike,
	NONCE,
	REGISTRY_KEY,
	TYPE,
	WITHDRAW_PREFIX
} from '../schema.js';
import { nonceOf, randOf } from '../rand.js';
import { bindRuns } from '../text/runs.js';
import { writeRunMarks } from '../text/marks.js';
import {
	bindText,
	computeOwners,
	DEAD,
	type MergeClaim,
	type Owner,
	type Ownership,
	type TextBlockRec
} from '../text/model.js';
import { cloneJson } from '../../utils/json.js';
import { dataLeaves, patchWrites, writeLeaves } from '../data.js';
import { incarnationNode, isIncarnationId, keepRegistryLosers } from '../incarnations.js';

/** Logical block identifier — caller-assigned, immutable per block. */
export type BlockId = string;

/** Where a block goes: `parent` = logical block id or `null` for root. */
export type Destination = { parent: BlockId | null; index: number };

/** One inline content element in a block spec / projection. */
export type ContentItem =
	| { kind: 'text'; text: string; marks?: Record<string, unknown> }
	| { kind: 'inline'; id: string; type: string; data?: Record<string, unknown> };

/** Declarative block description used for inserts (and by seeders). */
export type BlockSpec = {
	id: BlockId;
	type: string;
	data?: Record<string, unknown>;
	content?: ContentItem[];
	children?: BlockSpec[];
};

export type InlineSpec = { id: string; type: string; data?: Record<string, unknown> };

/** The tail block's type/data, decided once by a split (default: copied from the source). */
export type SplitTail = { type: string; data?: Record<string, unknown> };

/** Canonical projected block — the comparison surface for convergence. */
export type ProjectedBlock = {
	id: BlockId;
	type: string;
	data?: Record<string, unknown>;
	content: ContentItem[];
	children: ProjectedBlock[];
	/** Set when the registry node could not be read completely. */
	malformed?: true;
};

export type ProjectedDoc = { children: ProjectedBlock[] };

export { REGISTRY_KEY };

/**
 * Tiebreak for rehome ranks — the placement fallback is PURE replicated
 * state (identical on every replica), so the minted rank must not depend
 * on the local `doc.clientID` or `Math.random`: a fixed value keeps the
 * resolution deterministic everywhere. Ordering between rehomed blocks is
 * carried by the `v` digit (each successive rehome mints below the last).
 */
const REHOME_TIE = 0;

/**
 * Deterministic rank strictly below `min` — the candidate-less rehome
 * fallback (U5 fix). The old floor sentinel `encodeRank([{v: RANK_VMIN,
 * t: 0}])` sorted first but was un-insertable-above: `rankBetween(
 * undefined, that)` hits the `rSeg.v <= RANK_VMIN` guard and throws
 * `RankSpaceExhausted` — reachable with ZERO boundary inserts (corpus
 * seed 96). Minting `min[0].v - 1` keeps the documented "orphans rehome
 * to the FRONT of the root" behavior while leaving digit headroom for
 * legal inserts above the rehomed block.
 *
 * `min` = the current minimum rank among placements displaying at the
 * root, `undefined` when the root list is empty (mint `{v:0}` — the same
 * canonical first key `rankBetween(undefined, undefined)` emits). At the
 * absolute floor (`min[0].v` already `RANK_VMIN` — unreachable through
 * any legal write; nothing sorts below it) join `min`'s tie instead of
 * minting an unencodable digit.
 */
const rehomeRankBelow = (min: string | undefined): string => {
	if (min === undefined) return encodeRank([{ v: 0, t: REHOME_TIE }]);
	const v = decodeRank(min)[0].v;
	if (v <= RANK_VMIN) return min;
	return encodeRank([{ v: v - 1, t: REHOME_TIE }]);
};

/** Placement value written atomically as one attr: `{p, r}`. */
export type PlacementValue = { p: BlockId | null; r: string };

/** A parsed placement candidate (key + value). */
export type PlacementCand = {
	key: string;
	seq: number;
	client: number;
	p: BlockId | null;
	r: string;
};

/** Total order on candidate stamps — matches the ADR's conflict order. */
const cmpStamp = (aSeq: number, aClient: number, bSeq: number, bClient: number): number =>
	aSeq - bSeq || aClient - bClient;

/** Global acceptance order: (seq, clientId, blockId) descending. */
type OrderedCand = PlacementCand & { blockId: BlockId };

/**
 * Internal per-block record: the registry node plus decoded placement
 * candidates sorted by `(seq, client)` descending (index 0 = argmax), plus
 * the text-ownership facts (nonce, own text, merge claims).
 */
export type BlockRec = TextBlockRec & {
	type: string;
	data: unknown;
	cands: PlacementCand[];
};

/** Resolved placement after acyclic acceptance. */
export type ResolvedPlacement = {
	parent: BlockId | null;
	rank: string;
};

/**
 * Ownership as the display reads it, with the role table's answer for each
 * block's stored kind (`text/runs.ts` `DisplayRoles`). Absent: no roles
 * (pure engine behavior).
 */
export type DisplayOwnership = Ownership & {
	/**
	 * The live block `b` displays no children (a void role, UW-21b): they
	 * take its slot like a deleted parent's ({@link displaySlotOf}).
	 */
	childless?: (b: BlockId) => boolean;
	/**
	 * `b` (live or deleted) is an island: a block promoted or merged out of
	 * it keeps no container-only kind (`reset`).
	 */
	island?: (b: BlockId) => boolean;
	/**
	 * `b` (live or deleted) is a container — it renders no content and is
	 * neither void nor an island (a list): a block promoted out of it keeps
	 * no container-only kind either (`reset`, DR-crdt-2).
	 */
	container?: (b: BlockId) => boolean;
	/**
	 * The island `b` is declared `lines`: each direct child is a line, and a
	 * line holds no children (FW-01, XW-03, {@link displaySlotOf}).
	 */
	lined?: (b: BlockId) => boolean;
	/**
	 * The live block `b` does not display by the layout rules — an empty or
	 * bare item, a layout showing one item or none (`layout.empty-item`,
	 * `layout.bare-item`, `layout.single`): it is hidden, and its children
	 * take its slot like a deleted parent's ({@link displaySlotOf}).
	 */
	passes?: (b: BlockId) => boolean;
	/**
	 * The live layout `owner` does not display `child`, which is no item of
	 * it (`layout.only-items`): `child` takes the layout's slot, right after
	 * it ({@link displaySlotOf}).
	 */
	sheds?: (owner: BlockId, child: BlockId) => boolean;
	/**
	 * The rank `id` displays at directly under `parent` (its placement's own
	 * parent) — `rank` unless it is a piece of a text (`order.split.text`,
	 * D-18, {@link textRanker}).
	 */
	textRank?: (id: BlockId, parent: BlockId | null, rank: string) => string;
};

/**
 * D-18 (H9, `order.split.text`): the blocks whose streams lie in one
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

/** One entry of a children list: `reset` — the island it displays out of ({@link displaySlotOf}). */
export type ChildSlot = { id: BlockId; rank: string; reset?: BlockId };

/**
 * The document index as one consistent replicated-state view — the shared
 * currency of commands, anchors, projection and the change report.
 * `blocks`/`own` are always current; `placements`, `kids` (the
 * `childrenIndex` buckets) and `order` are rebuilt lazily, so pure-content
 * ops never pay for them. Owned by the doc's index (`text/runs.ts`).
 */
export type ModelView = {
	blocks: Map<BlockId, BlockRec>;
	own: DisplayOwnership;
	placements: Map<BlockId, ResolvedPlacement>;
	kids: Map<BlockId | null, ChildSlot[]>;
	/** Document order over `kids` — lazy, like `kids`. */
	order: DocOrder;
	/**
	 * Canonicalize a JSON payload into its shared immutable instance —
	 * deep-frozen and interned by canonical key (so equal payloads are `===`
	 * across `project()`/`contentItems()`/`runs()`). The publication boundary for
	 * item `marks`/`data` (R4): range-read items carry borrowed references
	 * into cursor/checkpoint/replicated state, and substituting the
	 * interned clone is what keeps a caller's mutation out of the engine.
	 */
	intern: <T>(value: T) => T;
	/**
	 * The blocks `owner` displays (itself included while it owns its own
	 * display) — the inverse of `own.ownerOf`, rebuilt with it (a delete
	 * marks what its target displays; a block set deletes many).
	 */
	displays: (owner: BlockId) => readonly BlockId[];
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

/** Parse the `at` map of a block node into sorted candidates. */
export const candidatesOf = (node: EngineNode): PlacementCand[] => {
	const at = node.getAttr(AT);
	const cands: PlacementCand[] = [];
	if (isNodeLike(at)) {
		at.forEachAttr((v: unknown, key: string) => {
			const dot = key.indexOf('.');
			const val = v as PlacementValue;
			if (dot <= 0 || val == null || typeof val !== 'object' || typeof val.r !== 'string') return;
			cands.push({
				key,
				seq: Number(key.slice(0, dot)),
				client: Number(key.slice(dot + 1)),
				p: (val.p as BlockId | null) ?? null,
				r: val.r
			});
		});
	}
	cands.sort((a, b) => cmpStamp(b.seq, b.client, a.seq, a.client));
	return cands;
};

/**
 * Resolve every block's winning placement, in global candidate order
 * `(seq, clientId, blockId)` descending. A candidate is accepted iff its
 * DISPLAY edge cannot reach back to the block through already-accepted
 * display edges; rejected candidates fall through to the block's next
 * candidate, then to a deterministic root fallback. Pure — reads only
 * replicated state, writes nothing.
 *
 * The relation kept acyclic is the COMPOSED display-parent relation
 * `b ↦ owner(parent(b))` (see `displayParentOf`): a placement parent that
 * was merged away resolves to its claim owner, so the raw `pl.parent`
 * graph being acyclic is NOT sufficient — a merge claim can redirect a
 * display edge back into the block's own subtree (e.g. `A` merged into
 * `B` while `B` sits under `A`, or `del` resurrection re-arming a claim).
 * Because the claim-owner map is computed independently of placements
 * (claims live on `claims` lists), the acceptance test composes the
 * two: the candidate's tentative display edge is `ownerOf(p)` — a live
 * self-owned block or `null` (root). A deleted parent is no sink: its
 * unmarked children display in its slot (read-time promotion,
 * {@link displaySlotOf}), so the walk passes through it along its own
 * accepted placement.
 *
 * `ownerOf` is injectable so callers can share an ownership context they
 * already computed; standalone callers get the map derived from the
 * block records (pure over replicated state — claims are `claims` items).
 */
export const resolvePlacements = (
	blocks: Map<BlockId, BlockRec>,
	ownerOf?: (b: BlockId) => Owner
): Map<BlockId, ResolvedPlacement> => {
	let owner = ownerOf;
	if (!owner) {
		const owners = computeOwners(blocks);
		owner = (b: BlockId): Owner => owners.get(b) ?? DEAD;
	}
	const ordered: OrderedCand[] = [];
	for (const [id, rec] of blocks) {
		for (const c of rec.cands) ordered.push({ ...c, blockId: id });
	}
	ordered.sort(
		(a, b) => cmpStamp(b.seq, b.client, a.seq, a.client) || b.blockId.localeCompare(a.blockId)
	);
	const accepted = new Map<BlockId, ResolvedPlacement>();
	for (const cand of ordered) {
		if (accepted.has(cand.blockId)) continue;
		let p = cand.p;
		if (p !== null && !blocks.has(p)) p = null; // parent never integrated → root
		if (p !== null) {
			// Reject the candidate iff the block already is a display
			// ancestor of `p` through accepted edges: a live parent's edge
			// is its owner's, a deleted one is walked itself (its children
			// take its slot). Accepted edges are acyclic by induction, so
			// the walk always terminates.
			let cyclic = false;
			for (let cur: BlockId | null = p; cur !== null; ) {
				const o = owner(cur);
				const at = o === DEAD ? cur : o;
				if (at === cand.blockId) {
					cyclic = true;
					break;
				}
				const cp = accepted.get(at);
				if (cp === undefined) break; // edge not yet accepted → cannot cycle
				cur = cp.parent;
			}
			if (cyclic) continue; // try this block's next candidate
		}
		accepted.set(cand.blockId, { parent: p, rank: cand.r });
	}
	// Fallback: blocks whose candidates were all cycle-rejected are rehomed
	// at the root under their argmax rank; a block with NO surviving
	// candidate mints a deterministic rank strictly below the current root
	// minimum (rehomeRankBelow — the U5 fix; see its comment). The mint
	// must stay deterministic across replicas: it depends only on the
	// accepted map + block ids, never on clientID/Math.random.
	const rehomed: BlockRec[] = [];
	for (const [id, rec] of blocks) {
		if (accepted.has(id)) continue;
		if (rec.cands.length > 0) {
			accepted.set(id, { parent: null, rank: rec.cands[0].r });
		} else {
			rehomed.push(rec);
		}
	}
	if (rehomed.length > 0) {
		// Minimum rank among placements that DISPLAY at the root (a `null`
		// parent edge is the only way a display edge is `null` — `owner()`
		// never returns null). Superset-of-visible is fine: minting below
		// even an invisible sibling still sorts the rehome first among the
		// visible list.
		let min: string | undefined;
		for (const pl of accepted.values()) {
			if (pl.parent === null && (min === undefined || pl.rank < min)) min = pl.rank;
		}
		// Descending-id mint order → ascending-id display order, the same
		// (rank, id)-tie order the old shared MIN_RANK produced. Each mint
		// goes below the running minimum, so stacked rehomes always get
		// distinct deterministic ranks.
		rehomed.sort((a, b) => b.id.localeCompare(a.id));
		for (const rec of rehomed) {
			min = rehomeRankBelow(min);
			accepted.set(rec.id, { parent: null, rank: min });
		}
	}
	return accepted;
};

/**
 * THE liveness answer (R3, O5): `id` carries no live delete mark, owns
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
 * The rank separator of a promoted slot: the lowest segment a rank can hold
 * (`rankBetween` only copies it from a promoted bound), so `slot + PROMOTED + rank` sorts after
 * `slot` and before every rank the slot's list minted after it — also one
 * that extends `slot`, as an insert between two adjacent digits does.
 */
const PROMOTED = encodeRank([{ v: RANK_VMIN, t: 0 }]);

/**
 * The rank of a block promoted into the slot ranked `slot` (read-time
 * promotion, and a promote-delete's planned moves): a valid rank, so an
 * insert beside a promoted block ranks against it like any other.
 */
export const promotedRank = (slot: string, rank: string): string => slot + PROMOTED + rank;

/**
 * Which side of a gap `(X, Y)` a block ranked by its source comes from
 * ({@link sourceRank}), in the order every serial run puts them: the
 * pieces a split of `X` creates, then the blocks leaving `X` for the gap
 * right after it (its children, a list's last items), then the blocks
 * leaving `Y` for the gap right before it (a list's first items).
 */
export const SOURCE_SIDE = { pieces: 0, after: 1, before: 2 } as const;

/**
 * The rank of a block ranked by where it came from for the gap
 * `(left, right)` right beside its source, not by who moved it (CW-01).
 * Two peers splitting or lifting out of the same block at once rank their
 * blocks in the same gap; ranks drawn at random there (and tied by client
 * id) sorted one peer's blocks before the other's whatever the text order.
 * Here the rank is a base every replica that saw the same gap computes
 * alike (the gap's midpoint, a fixed tie), then the `side` it comes from
 * ({@link SOURCE_SIDE}: blocks from different sources share the gap, and
 * their paths are not comparable, DR-crdt-6), then the ranks down the
 * block's `path` in its source (the block it stands at), each closed by
 * the lowest segment (a shorter rank then sorts first, as a prefix does),
 * then its `part` there (the caller's order among what stands at one
 * block), its first segment tied by `clientId`: two peers' blocks at one
 * part never share a rank (a later insert between two equal ranks could
 * not land between them), and each peer's blocks there stay together. A
 * segment tied by `clock`, the client's own next clock, follows that first
 * one: one client never mints one rank twice in a gap, even when the block
 * it first minted it for was deleted there and a peer's undo brings it
 * back (DW-05), and what one gesture minted (the lines of one paste)
 * sorts before what its later gestures mint there, never among it (FX-06).
 * `null` on a degenerate gap (`left >= right`): the caller ranks it as any
 * insert.
 */
export const sourceRank = (
	left: string | undefined,
	right: string | undefined,
	side: number,
	path: readonly string[],
	part: readonly number[],
	clientId: number,
	clock: number
): string | null => {
	if (left !== undefined && right !== undefined && left >= right) return null;
	const closed = path.flatMap((r) => [...decodeRank(r), { v: RANK_VMIN, t: SOURCE_TIE }]);
	const [first, ...rest] = part;
	const parts = [
		{ v: first, t: clientId },
		{ v: 0, t: clock },
		...rest.map((v) => ({ v, t: SOURCE_TIE }))
	];
	const own = [{ v: side, t: SOURCE_TIE }, ...closed, ...parts];
	return rankBetween(left, right, SOURCE_TIE, () => 0.5) + encodeRank(own);
};
/** The tie of a source rank's own segments: the same on every replica. */
const SOURCE_TIE = 0;

/**
 * Where a placement DISPLAYS: its display parent and its rank in that
 * parent's children list. A live parent shows its children; a merged-away
 * one resolves to its claim owner, the merge destination (B+C merged while
 * A+B merged: C's children land on B, B is claimed by A → they display
 * under A). A delete-marked parent hides no unmarked child — promotion is
 * derived at read time (`del.blocks.promote`, UW-08): the child takes the
 * deleted parent's slot, ranked just after it ({@link promotedRank}),
 * recursively. So whatever a peer split off, inserted or moved under a
 * block another writer deleted stays in the document. A childless owner (a
 * void kind, `own.childless`) sheds its children the same way (UW-21b): a
 * block a peer nests or splits under a block another peer retypes to a void
 * kind takes the void's slot on every replica, and returns under it if the
 * retype is undone. A block that displays out of an island — promoted out
 * of a deleted one, or under the owner of a merged-away one — names it
 * (`reset`, the innermost): while it still has the island's default child
 * kind it displays as its display parent's default child, as a delete or
 * merge of the island retypes the children it saw. A container (a list) is
 * a `reset` too: an item a peer adds to a list another peer's edit removes
 * shows as a paragraph, not as a bare item (DR-crdt-2); a block promoted
 * INTO a container names the block it is promoted out of, so it shows as
 * the container's item as a delete's write makes it (SW9-containers-3). A code line a peer adds
 * under a code block another peer deletes or merges shows as a paragraph,
 * not as a code line outside its code block. A line of an island declared
 * `lines` holds no children (FW-01): they take the island's
 * slot, ranked in the line's order, with the island as `reset` — a block a
 * peer nested under a code line while an undone delete had made it a
 * paragraph shows right after the code block, and stays there when the
 * line is deleted (XW-10). The layout rules pass the same way (`layout.*`):
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
	// D-18: a piece of a text shown under its own placement's parent takes its text-order rank.
	const direct = (owner: BlockId | null): string =>
		own.textRank === undefined || owner !== pl.parent ? rank : own.textRank(id, owner, rank);
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
		// A line holds no children (FW-01) — a deleted or childless one
		// neither (XW-10): they take its island's slot, never the island.
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
		// Promoted into a container: it shows as one of its items (SW9-containers-3).
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

/**
 * Document order (O7): ONE pre-order over the visible blocks of a children
 * index — `ids` in reading order, `at` the position of each id. Every
 * consumer (ops, view walkers, block selection, clipboard, drag groups)
 * reads this; island sealing is a policy the caller applies on top.
 */
export type DocOrder = { ids: readonly BlockId[]; at: ReadonlyMap<BlockId, number> };

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

/**
 * Bind the placement model to a concrete engine surface.
 *
 * `Y` must be the vendored v14 module (`import * as Y from
 * 'lib/crdt/vendor/yjs'`). Consumers inject it so this file stays free of
 * runtime vendor imports (see `engine-api.ts`).
 */
export const bindModel = (Y: EngineApi) => {
	// Fork P14 (H13, `id.same.concurrent`): every document of this engine keeps
	// a registry value a concurrent creation of the same id replaced.
	Y.Doc.keepReplaced ??= keepRegistryLosers;
	/** Construct a detached v14 node, viewed through the structural interface. */
	const newNode = (name: string): EngineNode => new Y.Node(name) as unknown as EngineNode;

	/** The text-ownership engine (streams, claims, anchors). */
	const T = bindText(Y);
	/** The doc's index — every read of derived state goes through it. */
	const R = bindRuns(Y);

	// ── registry / record access ────────────────────────────────────────

	const registryOf = (doc: EngineDoc): EngineNode => doc.get(REGISTRY_KEY);

	const blockNodeOf = (doc: EngineDoc, id: BlockId): EngineNode | null => {
		const registry = registryOf(doc);
		const v = registry.getAttr(id);
		if (isNodeLike(v)) return v;
		// A losing incarnation (H13) under its derived id.
		return isIncarnationId(id)
			? incarnationNode(registry, id, (item) => Y.isKeptReplaced(item as never))
			: null;
	};

	/**
	 * The registry node when it carries no delete mark — the DELETED half of
	 * deleted-vs-hidden (a block under a deleted parent is hidden, not
	 * deleted). Not a targetability answer: ops ask {@link isLive}.
	 */
	const liveNodeOf = (doc: EngineDoc, id: BlockId): EngineNode | null => {
		const n = blockNodeOf(doc, id);
		return n !== null && !hasDeleteMark(n) ? n : null;
	};

	/** {@link isLiveIn} over the doc's current view. */
	const isLive = (doc: EngineDoc, id: BlockId): boolean => isLiveIn(view(doc), id);

	/**
	 * The history's creation rule (P12 `withdraw`, `hist.undo.withdraw`): an
	 * undo never deletes a block the undone step created. Its node and
	 * structure (attrs, placement candidates, the content and claims nodes)
	 * stay and the undoer's withdraw mark is written on it; what the step wrote
	 * inside the content and claims nodes (the undoer's own text, atoms,
	 * boundaries, claims) is deleted as usual. The index shows a withdrawn
	 * block while it holds another writer's content.
	 */
	const withdrawOnUndo =
		(doc: EngineDoc) =>
		(item: EngineItemRef, stackItem: { inserts: { hasId(id: unknown): boolean } }): boolean => {
			const registry = registryOf(doc);
			let below: EngineItemRef = null;
			let cur = item;
			while (cur?.parent !== registry) {
				below = cur;
				cur = (cur?.parent as EngineNode | undefined)?._item ?? null;
				if (cur === null) return false;
			}
			if (!stackItem.inserts.hasId(cur.id)) return false;
			if (below === null) {
				const node = (cur as { content: { type: EngineNode } }).content.type;
				node.setAttr(WITHDRAW_PREFIX + doc.clientID, true);
				return true;
			}
			return below === item || (below.parentSub !== CONTENT && below.parentSub !== CLAIMS);
		};

	// ── placement write ──────────────────────────────────────────────────

	/**
	 * Atomically append one placement candidate `{p, r}` to a block's `at`
	 * map, stamped `seq = localMax+1, client = doc.clientID`, then compact:
	 * candidates below the top-2 are tombstoned (the runner-up survives as
	 * the acyclic fallback; deeper history is re-created by undo anyway).
	 * Must run inside a transaction.
	 */
	const writePlacement = (doc: EngineDoc, node: EngineNode, p: BlockId | null, r: string): void => {
		const at = node.getAttr(AT);
		if (!isNodeLike(at)) throw new Error(`writePlacement: block missing at-map`);
		const cands = candidatesOf(node);
		const seq = (cands[0]?.seq ?? 0) + 1;
		// Tombstone everything below the runner-up (top-2 kept).
		for (const c of cands.slice(2)) at.deleteAttr(c.key);
		at.setAttr(`${seq}.${doc.clientID}`, { p, r });
	};

	// ── derived state ───────────────────────────────────────────────────

	/** The doc's index as a `ModelView` — folded up to the open transaction's last write. */
	const view = (doc: EngineDoc): ModelView => R.attach(doc).view();

	// ── content (rich-text sequence) helpers ────────────────────────────

	/** A detached inline-atom node (inputs arrive normalized by the facade's ingress, O1). */
	const buildInline = (atom: InlineSpec): EngineNode => {
		const node = newNode(INLINE_NODE);
		node.setAttr(ID, atom.id);
		node.setAttr(TYPE, atom.type);
		writeLeaves(node, dataLeaves(atom.data));
		return node;
	};

	// ── structural predicates ───────────────────────────────────────────

	/**
	 * True iff `maybeAncestor` is `id` itself or lies on `id`'s
	 * DISPLAY-ancestor chain — the composed relation `owner(parent)`
	 * (`displayParentOf`), not the raw placement chain. A merge claim can
	 * place a block inside another's display subtree without appearing in
	 * its raw ancestry, so the merge refusal must see through the claim
	 * redirect — this is exactly the relation `resolvePlacements` keeps
	 * acyclic: a merge that would close a cycle is refused without mutation.
	 */
	const isSelfOrDescendant = (
		placements: Map<BlockId, ResolvedPlacement>,
		own: Ownership,
		id: BlockId,
		maybeAncestor: BlockId
	): boolean => {
		let cur: BlockId | null = id;
		const seen = new Set<BlockId>();
		while (cur !== null && !seen.has(cur)) {
			if (cur === maybeAncestor) return true;
			seen.add(cur);
			const pl = placements.get(cur);
			if (pl === undefined) break;
			const dp = displayParentOf(own, pl, placements, cur);
			if (dp === DEAD) break; // unknown ancestor — hidden, not cyclic
			cur = dp;
		}
		return false;
	};

	// ── write primitives ────────────────────────────────────────────────
	// The document's prepared plans (R6) decide every write; these only
	// perform one planned step and never refuse. Must run inside a transaction.

	/**
	 * `count` consecutive insertion ranks at `index` into the sibling list
	 * `siblings`.
	 *
	 * Degenerate seams (`left >= right`) are legal replicated states, not
	 * caller errors: equal-rank neighbours occur after cycle-fallback
	 * rehoming (two blocks may carry the same rank string minted in
	 * different sibling lists), and `rankBetween` THROWS on them — so
	 * callers must guard. No string sorts strictly between equal strings,
	 * so each new member takes `left` verbatim: it JOINS the tie and the
	 * `(rank, id)` display sort orders the whole group deterministically.
	 * On a valid seam the emitted chain is `rankBetween(left, right)` then
	 * `rankBetween(prev, right)` — with `run`, `rankAfter` (an insert: after a
	 * block this client ranked, in its run there, H1).
	 */
	const ranksAt = (
		siblings: readonly { rank: string }[],
		index: number,
		count: number,
		clientId: number,
		rand?: () => number,
		run = false
	): string[] => {
		let left = siblings[index - 1]?.rank;
		const right = siblings[index]?.rank;
		if (left !== undefined && right !== undefined && left >= right) {
			return new Array<string>(count).fill(left);
		}
		const out: string[] = [];
		for (let i = 0; i < count; i++) {
			// An insert extends this client's run after a block it ranked (H1).
			const r = run
				? rankAfter(left, right, clientId, rand)
				: rankBetween(left, right, clientId, rand);
			out.push(r);
			left = r;
		}
		return out;
	};

	/**
	 * One registry entry: the block node with its `claims` list (holding
	 * `claims`), its own backing text holding `items` (none for a split-born
	 * block: its stream lives in the text it was split from), and the atomic
	 * first placement candidate `{p, r}` stamped `1.clientID`. Pre-integration
	 * writes materialize when the node integrates (the registry write comes last).
	 */
	const createBlock = (
		doc: EngineDoc,
		id: BlockId,
		type: unknown,
		data: unknown,
		place: PlacementValue,
		claims: MergeClaim[],
		items: readonly ContentItem[] | null,
		n: number = nonceOf(doc)
	): void => {
		const node = newNode(BLOCK_NODE);
		node.setAttr(ID, id);
		node.setAttr(NONCE, n);
		node.setAttr(TYPE, type);
		writeLeaves(node, dataLeaves(data));
		const content = items === null ? null : textOf(items);
		if (content !== null) node.setAttr(CONTENT, content);
		const list = newNode(CLAIMS_NODE);
		node.setAttr(CLAIMS, list);
		if (claims.length > 0) list.insert(0, claims);
		const at = newNode(AT_NODE);
		node.setAttr(AT, at);
		at.setAttr(`1.${doc.clientID}`, place);
		registryOf(doc).setAttr(id, node);
		if (content !== null) markText(doc, content, items!);
	};

	/** A detached backing text holding `items`, unmarked ({@link markText} marks it once integrated). */
	const textOf = (items: readonly ContentItem[]): EngineNode => {
		const content = newNode(CONTENT_NODE);
		let clen = 0;
		for (const item of items) {
			if (item.kind === 'text') {
				content.insert(clen, item.text);
				clen += item.text.length;
			} else {
				content.insert(clen++, [buildInline(item)]);
			}
		}
		return content;
	};

	/** H5: the marks of `items`, written as paired operations on their integrated text. */
	const markText = (doc: EngineDoc, content: EngineNode, items: readonly ContentItem[]): void =>
		writeRunMarks(
			doc,
			content,
			0,
			items.map((item) =>
				item.kind === 'text'
					? { length: item.text.length, marks: item.marks as Record<string, unknown> | undefined }
					: { length: 1 }
			)
		);

	/**
	 * Restore definition (O24, D-22 — migration only; a first import
	 * restores into an empty doc): make `specs` the whole visible document
	 * under their own ids, in ONE transaction. An existing id keeps its
	 * registry entry: every delete mark is cleared and its type, data,
	 * placement and content are rewritten in place — a fresh own text holding
	 * the spec's content and an empty claims list; a block whose stream still
	 * starts at a live boundary gets a new nonce, so that boundary goes inert
	 * and the own text is its stream (R2). An absent id is created. Every other
	 * block gets this writer's delete mark. Ranks are derived from the tree
	 * alone and the rewrites are last-writer-wins attrs, so two replicas
	 * restoring the same specs converge on one copy.
	 */
	const restoreBlocks = (doc: EngineDoc, specs: BlockSpec[]): void =>
		doc.transact(() => {
			const { own } = view(doc);
			const keep = new Set<BlockId>();
			const restore = (list: BlockSpec[], parent: BlockId | null): void => {
				let rank: string | undefined;
				for (const sp of list) {
					keep.add(sp.id);
					let node = blockNodeOf(doc, sp.id);
					if (node === null) {
						node = newNode(BLOCK_NODE);
						node.setAttr(ID, sp.id);
						node.setAttr(NONCE, nonceOf(doc));
						node.setAttr(AT, newNode(AT_NODE));
						registryOf(doc).setAttr(sp.id, node);
					} else if (own.streamOf(sp.id)?.home !== sp.id && own.streamOf(sp.id) !== undefined) {
						node.setAttr(NONCE, nonceOf(doc));
					}
					for (const key of [...node.attrKeys()]) {
						if (key.startsWith(DEL_PREFIX) || key.startsWith(WITHDRAW_PREFIX)) node.deleteAttr(key);
					}
					if (node.getAttr(TYPE) !== sp.type) node.setAttr(TYPE, sp.type);
					writeLeaves(node, patchWrites(node, [{ path: [], value: sp.data ?? {} }]) ?? []);
					const text = textOf(sp.content ?? []);
					node.setAttr(CONTENT, text);
					markText(doc, text, sp.content ?? []);
					node.setAttr(CLAIMS, newNode(CLAIMS_NODE));
					rank = rankBetween(rank, undefined, 0, () => 0);
					writePlacement(doc, node, parent, rank);
					restore(sp.children ?? [], sp.id);
				}
			};
			restore(specs, null);
			registryOf(doc).forEachAttr((node: unknown, id: string) => {
				if (!keep.has(id) && isNodeLike(node) && !hasDeleteMark(node)) {
					node.setAttr(DEL_PREFIX + doc.clientID, true);
				}
			});
		});

	/**
	 * Materialize one spec subtree: the block owns its backing text (its
	 * stream from index 0); children recurse under a fresh sequential rank
	 * chain (a new block has no siblings to interleave with).
	 */
	const materializeSpec = (
		doc: EngineDoc,
		sp: BlockSpec,
		parent: BlockId | null,
		rank: string
	): void => {
		createBlock(doc, sp.id, sp.type, sp.data, { p: parent, r: rank }, [], sp.content ?? []);
		let left: string | undefined;
		for (const child of sp.children ?? []) {
			const r = rankBetween(left, undefined, doc.clientID, randOf(doc));
			materializeSpec(doc, child, sp.id, r);
			left = r;
		}
	};

	/**
	 * Does any id of `specs` (whole subtrees) collide — with another spec id,
	 * or with any registry entry, live or deleted? The registry is keyed by
	 * id, so writing a taken id would replace that block in place (D-12).
	 */
	const collides = (doc: EngineDoc, specs: readonly BlockSpec[]): boolean => {
		const seen = new Set<BlockId>();
		const stack = [...specs];
		while (stack.length > 0) {
			const sp = stack.pop()!;
			// A derived incarnation id (U+0000) is never a caller's (H13).
			if (seen.has(sp.id) || isIncarnationId(sp.id) || blockNodeOf(doc, sp.id) !== null)
				return true;
			seen.add(sp.id);
			stack.push(...(sp.children ?? []));
		}
		return false;
	};

	/**
	 * The seed writer's bulk insert (R1: the document is written by document
	 * operations and, once, by the seed writer — `init`, the local
	 * materializer): `specs` (whole subtrees, in list order) at `dest` in one
	 * transaction, all-or-nothing — `false` without writing when the parent
	 * is not live or any id collides. Document operations never call it:
	 * they prepare their inserts (`insertBlocks` in the facade).
	 */
	const insertBlocks = (doc: EngineDoc, dest: Destination, specs: BlockSpec[]): boolean => {
		if (specs.length === 0) return true;
		if (dest.parent !== null && !isLive(doc, dest.parent)) return false;
		if (collides(doc, specs)) return false;
		return doc.transact(() => {
			const sibs = view(doc).kids.get(dest.parent) ?? [];
			const at = Math.max(0, Math.min(dest.index, sibs.length));
			const ranks = ranksAt(sibs, at, specs.length, doc.clientID, randOf(doc));
			specs.forEach((sp, i) => materializeSpec(doc, sp, dest.parent, ranks[i]!));
			return true;
		});
	};

	/**
	 * Split `id` at content `offset` into the new block `newId` placed at
	 * `place`: one boundary item for `newId` at the end of the gap at `offset`
	 * (P7) and the merge claims that follow it re-inserted on the new block —
	 * no text is copied, so an offline edit to the tail keeps landing on the
	 * same items and displays in the new block after convergence. `tail` is
	 * the new block's type/data, decided once by the plan. Children are a
	 * separate step. `id` must have a stream or a claim ({@link ownText}).
	 */
	const writeSplit = (
		doc: EngineDoc,
		id: BlockId,
		offset: number,
		newId: BlockId,
		tail: SplitTail,
		place: PlacementValue
	): void => {
		const { blocks, own } = view(doc);
		const n = nonceOf(doc);
		const claims = T.splitAt(blocks, own, id, offset, newId, n);
		const data = tail.data === undefined ? undefined : cloneJson(tail.data);
		createBlock(doc, newId, tail.type, data, place, claims, null, n);
	};

	/**
	 * Give the streamless block `id` its own text (`T.ownText`: a derived
	 * writer, a re-minted nonce) — before the first write that needs a stream.
	 */
	const ownText = (doc: EngineDoc, id: BlockId) => T.ownText(doc, view(doc).blocks.get(id)!);

	// ── queries ─────────────────────────────────────────────────────────

	/**
	 * Canonical projection: pure derivation from replicated state — the
	 * visible tree of live blocks ordered by `(rank, id)`, children of a
	 * merged-away parent under its owner, those of a deleted parent in its
	 * slot ({@link displaySlotOf}). Content is each block's display (R2).
	 */
	const project = (doc: EngineDoc): ProjectedDoc => ({ children: R.attach(doc).project() });

	/**
	 * `positionOf` in a view: the display parent and the index among its
	 * visible children — a binary search by the block's display rank (the
	 * list's own order), not a scan of its siblings.
	 */
	const positionInView = (v: ModelView, id: BlockId): Destination | null => {
		if (!isLiveIn(v, id)) return null;
		const slot = displaySlotOf(v.own, v.placements, v.placements.get(id)!, id);
		const dp = slot.parent as BlockId | null;
		const list = v.kids.get(dp) ?? [];
		let [lo, hi] = [0, list.length];
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (bySlot(list[mid], { id, rank: slot.rank }) < 0) lo = mid + 1;
			else hi = mid;
		}
		const index = list[lo]?.id === id ? lo : list.findIndex((s) => s.id === id);
		return index < 0 ? null : { parent: dp, index };
	};

	/**
	 * `{parent, index}` of `id` in the visible tree, or null when hidden/absent.
	 * `parent` is the DISPLAY parent (merged-away ancestors resolve to their
	 * owner — see `displayParentOf`).
	 */
	const positionOf = (doc: EngineDoc, id: BlockId): Destination | null =>
		positionInView(view(doc), id);

	/** Pre-order ids of the visible tree — the document order (O7). */
	const listBlockIds = (doc: EngineDoc): BlockId[] => [...view(doc).order.ids];

	/** Flat text of a block's OWNED content (atoms render as ''). */
	const blockText = (doc: EngineDoc, id: BlockId): string | null => {
		const v = view(doc);
		return isLiveIn(v, id) ? T.blockTextOf(id, v.blocks, v.own) : null;
	};

	/**
	 * Engine identity of the registry entry (`client:clock` of its item), or
	 * null when the block is absent from the visible tree (deleted, or hidden
	 * under a deleted/unreachable ancestor).
	 */
	const crdtId = (doc: EngineDoc, id: BlockId): string | null => {
		if (!isLive(doc, id)) return null;
		const node = blockNodeOf(doc, id);
		const item = node?._item;
		if (!node || !item || item.deleted || !item.id) return null;
		return `${item.id.client}:${item.id.clock}`;
	};

	/** Engine handle for a logical id, or null when absent or delete-marked (debug surface). */
	const resolveBlock = (doc: EngineDoc, id: BlockId): EngineNode | null => liveNodeOf(doc, id);

	return {
		// constants
		REGISTRY_KEY,
		// records / projection internals (exported for tests + ADR probes)
		registryOf,
		blockNodeOf,
		liveNodeOf,
		isLive,
		candidatesOf,
		/** The doc's index as a `ModelView`. */
		view,
		resolvePlacements,
		childrenIndex,
		positionInView,
		// write primitives (the document's prepared plans apply these)
		buildInline,
		isSelfOrDescendant,
		ranksAt,
		writePlacement,
		withdrawOnUndo,
		materializeSpec,
		collides,
		writeSplit,
		ownText,
		// the seed writer's bulk insert
		insertBlocks,
		insertBlock: (doc: EngineDoc, dest: Destination, spec: BlockSpec) =>
			insertBlocks(doc, dest, [spec]),
		restoreBlocks,
		// queries
		project,
		positionOf,
		listBlockIds,
		blockText,
		crdtId,
		resolveBlock
	};
};

export type PlacementModel = ReturnType<typeof bindModel>;
