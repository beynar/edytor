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
 *        ├ id / type / data                payload attrs
 *        ├ del.<writer>                     per-writer delete marks (any live mark = deleted)
 *        ├ content → node('content')       BACKING text (atoms never move/copy — U04)
 *        ├ slices → node('slices')         ordered slice/merge claim records (U04)
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
 *   block (and thereby its subtree, since children keep pointing at it) is
 *   hidden regardless of which placement candidate wins — explicit deletion
 *   beats concurrent move. Deleting marks the block and every block it
 *   displays through merge claims (R3); undo removes only the undoer's mark.
 *
 * Content ownership semantics (see docs/crdt-v14-text-ownership-adr.md, U04):
 *
 * - A block's visible content is the concatenation of its `slices` claims —
 *   anchored ranges into backing texts (`{t,s,e}`) plus merge claims
 *   (`{m}`) that adopt another list's claims wholesale. Split divides the
 *   slice list; merge appends a claim — no atom is ever copied.
 * - `owner(b)` resolves the claim graph: the max-stamp merge claim on `b`'s
 *   list wins; a merged block is hidden (`owner(b) !== b`) and its atoms
 *   route to the claimer. Per-atom contested ranges resolve by claim-item
 *   stamp. A delete-marked block hides every atom its records win.
 *
 * The module is engine-agnostic: `bindModel(Y)` takes the vendored module
 * surface so this file type-checks against structural interfaces and never
 * imports vendor `.js` (which `pnpm check` must not traverse).
 */
import type { EngineApi, EngineDoc, EngineNode } from '../engine-api.js';
import { decodeRank, encodeRank, rankBetween, RANK_VMIN } from './rank.js';
import {
	AT,
	AT_NODE,
	BLOCK_NODE,
	CONTENT,
	CONTENT_NODE,
	DATA,
	DEL_PREFIX,
	hasDeleteMark,
	ID,
	INLINE_NODE,
	NONCE,
	REGISTRY_KEY,
	SLICES,
	SLICES_NODE,
	TYPE
} from '../schema.js';
import { nonceOf, randOf } from '../rand.js';
import { bindRuns } from '../text/runs.js';
import {
	bindText,
	computeOwners,
	DEAD,
	type Owner,
	type Ownership,
	type SlicePayload,
	type SliceRecord,
	type TextBlockRec
} from '../text/model.js';
import { cloneJson, jsonEquals } from '../../utils/json.js';

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
 * the U04 slice-claim state (backing text + ordered claim entries).
 */
export type BlockRec = TextBlockRec & {
	node: EngineNode;
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
 * The document index as one consistent replicated-state view — the shared
 * currency of commands, anchors, projection and the change report.
 * `blocks`/`own` are always current; `placements`, `kids` (the
 * `childrenIndex` buckets) and `order` are rebuilt lazily, so pure-content
 * ops never pay for them. Owned by the doc's index (`text/runs.ts`).
 */
export type ModelView = {
	blocks: Map<BlockId, BlockRec>;
	own: Ownership;
	placements: Map<BlockId, ResolvedPlacement>;
	kids: Map<BlockId | null, { id: BlockId; rank: string }[]>;
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

const isNodeLike = (v: unknown): v is EngineNode =>
	v != null && typeof (v as { getAttr?: unknown }).getAttr === 'function';

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
 * (claims live on `slices` records), the acceptance test composes the
 * two: the candidate's tentative display edge is `ownerOf(p)` — a live
 * self-owned block, `null` (root), or `DEAD` (deleted parent — a sink
 * that hides the subtree and can never close a cycle).
 *
 * `ownerOf` is injectable so callers can share an ownership context they
 * already computed; standalone callers get the map derived from the
 * block records (pure over replicated state — claims are `slices` items).
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
	/** The display edge an accepted placement installs: `owner(parent)`. */
	const displayEdge = (pl: ResolvedPlacement): Owner | null =>
		pl.parent === null ? null : owner!(pl.parent);
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
		const rec = blocks.get(cand.blockId)!;
		let p = cand.p;
		if (p !== null && !blocks.has(p)) p = null; // parent never integrated → root
		if (p !== null) {
			const d = owner(p); // the display edge this candidate installs
			// A DEAD display parent (deleted target) hides the block with
			// its subtree — a sink, never a cycle member. Otherwise reject
			// the candidate iff `d` can already reach the block through
			// accepted display edges — i.e. the block is a display ancestor
			// of `d`. Because accepted edges are acyclic by induction, the
			// walk always terminates.
			if (d !== DEAD) {
				let cur: BlockId | null = d;
				let cyclic = false;
				while (cur !== null) {
					if (cur === cand.blockId) {
						cyclic = true;
						break;
					}
					const cp = accepted.get(cur);
					if (cp === undefined) break; // edge not yet accepted → cannot cycle
					const e = displayEdge(cp);
					if (e === DEAD) break;
					cur = e;
				}
				if (cyclic) continue; // try this block's next candidate
			}
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
		const dp = pl === undefined ? DEAD : displayParentOf(own, pl);
		if (dp === DEAD) return false;
		cur = dp;
	}
	return true;
};

/**
 * The parent under which `id` actually DISPLAYS. Normally the resolved
 * placement parent — but when that parent is merged-away (its slice list
 * is claimed, `owner(parent) !== parent`), the child follows the claim to
 * the merge destination: `owner(parent)`. This prevents hidden orphans in
 * chained/overlapping merges (B+C merged while A+B merged: C's children
 * land on B, B is claimed by A → children display under A).
 *
 * A `del`-flagged (or unreachable) parent resolves to owner `DEAD` → the
 * child stays hidden with its subtree — explicit deletion does NOT
 * promote or rehome descendants (MV06 contract preserved).
 */
export const displayParentOf = (own: Ownership, pl: ResolvedPlacement): Owner | null => {
	if (pl.parent === null) return null;
	// Unclaimed parent → itself; merged-away → the claim owner;
	// DEAD (deleted/unreachable) → the child is hidden with the subtree.
	return own.ownerOf(pl.parent);
};

/**
 * All visible children's lists at once: `parent|null → {id, rank}[]` sorted
 * by `(rank, id)` — ONE pass over `placements` plus one sort per list. This
 * is the order the projection emits.
 */
export const childrenIndex = (
	placements: Map<BlockId, ResolvedPlacement>,
	own: Ownership
): Map<BlockId | null, { id: BlockId; rank: string }[]> => {
	const index = new Map<BlockId | null, { id: BlockId; rank: string }[]>();
	for (const [id, pl] of placements) {
		if (own.hidden(id)) continue;
		const dp = displayParentOf(own, pl);
		// Hidden-with-subtree blocks (a DEAD display parent) appear in no list.
		if (dp === DEAD) continue;
		const bucket = index.get(dp);
		if (bucket) bucket.push({ id, rank: pl.rank });
		else index.set(dp, [{ id, rank: pl.rank }]);
	}
	for (const bucket of index.values()) {
		bucket.sort((a, b) =>
			a.rank === b.rank ? a.id.localeCompare(b.id) : a.rank < b.rank ? -1 : 1
		);
	}
	return index;
};

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
	/** Construct a detached v14 node, viewed through the structural interface. */
	const newNode = (name: string): EngineNode => new Y.Node(name) as unknown as EngineNode;

	/** The U04 text-ownership engine (anchors, slice claims, ownership). */
	const T = bindText(Y);
	/** The doc's index — every read of derived state goes through it. */
	const R = bindRuns(Y);

	// ── registry / record access ────────────────────────────────────────

	const registryOf = (doc: EngineDoc): EngineNode => doc.get(REGISTRY_KEY);

	const blockNodeOf = (doc: EngineDoc, id: BlockId): EngineNode | null => {
		const v = registryOf(doc).getAttr(id);
		return isNodeLike(v) ? v : null;
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
		if (atom.data !== undefined) node.setAttr(DATA, atom.data);
		return node;
	};

	/**
	 * Serialize one backing-text node's sequence into ContentItem runs —
	 * the full-range case of the direct sequence walk (WU8), mid-transaction
	 * safe the same way `toDelta()` was. Live inline nodes come back as
	 * `{kind:'inline'}` items identical to the old delta-JSON conversion.
	 */
	const contentItemsOf = (content: EngineNode): ContentItem[] =>
		content.doc === null ? [] : (T.itemsOfRange(content, 0, content.length) as ContentItem[]);

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
			const dp = displayParentOf(own, pl);
			if (dp === DEAD) break; // deleted ancestor sink — subtree hidden, not cyclic
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
	 * `rankBetween(prev, right)`.
	 */
	const ranksAt = (
		siblings: readonly { rank: string }[],
		index: number,
		count: number,
		clientId: number,
		rand?: () => number
	): string[] => {
		let left = siblings[index - 1]?.rank;
		const right = siblings[index]?.rank;
		if (left !== undefined && right !== undefined && left >= right) {
			return new Array<string>(count).fill(left);
		}
		const out: string[] = [];
		for (let i = 0; i < count; i++) {
			const r = rankBetween(left, right, clientId, rand);
			out.push(r);
			left = r;
		}
		return out;
	};

	/**
	 * One registry entry: the block node with its `content`/`slices`/`at`
	 * maps, `records` on its slice list and the atomic first placement
	 * candidate `{p, r}` stamped `1.clientID`. Pre-integration writes
	 * materialize when the node integrates (the registry write comes last).
	 */
	const createBlock = (
		doc: EngineDoc,
		id: BlockId,
		type: unknown,
		data: unknown,
		place: PlacementValue,
		records: SlicePayload[],
		items: readonly ContentItem[] = []
	): void => {
		const node = newNode(BLOCK_NODE);
		node.setAttr(ID, id);
		node.setAttr(NONCE, nonceOf(doc));
		node.setAttr(TYPE, type);
		if (data !== undefined) node.setAttr(DATA, data);
		const content = newNode(CONTENT_NODE);
		node.setAttr(CONTENT, content);
		const slices = newNode(SLICES_NODE);
		node.setAttr(SLICES, slices);
		const at = newNode(AT_NODE);
		node.setAttr(AT, at);
		let clen = 0;
		for (const item of items) {
			if (item.kind === 'text') {
				content.insert(clen, item.text, item.marks);
				clen += item.text.length;
			} else {
				content.insert(clen++, [buildInline(item)]);
			}
		}
		if (records.length > 0) slices.insert(0, records);
		at.setAttr(`1.${doc.clientID}`, place);
		registryOf(doc).setAttr(id, node);
	};

	/**
	 * Give `node` a fresh backing text holding `sp.content` and a fresh slice
	 * list with one self record over the whole text (`g`: its generation —
	 * 0 for a new block). Pre-integration writes materialize when the node
	 * integrates.
	 */
	const writeContent = (node: EngineNode, sp: BlockSpec, g = 0): void => {
		const content = newNode(CONTENT_NODE);
		node.setAttr(CONTENT, content);
		let clen = 0;
		for (const item of sp.content ?? []) {
			if (item.kind === 'text') {
				content.insert(clen, item.text, item.marks);
				clen += item.text.length;
			} else {
				content.insert(clen, [buildInline(item)]);
				clen += 1;
			}
		}
		const slices = newNode(SLICES_NODE);
		node.setAttr(SLICES, slices);
		slices.insert(0, [
			{
				t: sp.id,
				s: { i: null, a: -1 },
				e: { i: null, a: 0 },
				...(g > 0 && { g })
			} satisfies SliceRecord
		]);
	};

	/**
	 * Restore definition (O24, D-22 — migration only; a first import
	 * restores into an empty doc): make `specs` the whole visible document
	 * under their own ids, in ONE transaction. An
	 * existing id keeps its registry entry: every delete mark is cleared and
	 * its type, data, placement and content are rewritten in place (a fresh
	 * backing text whose self record outranks every claim ever written on that
	 * text, so records of split-off or merged-in blocks can win none of it);
	 * an absent id is created. Every other block gets this writer's delete
	 * mark. Ranks are derived from the tree alone and the rewrites are
	 * last-writer-wins attrs, so two replicas restoring the same specs
	 * converge on one copy.
	 */
	const restoreBlocks = (doc: EngineDoc, specs: BlockSpec[]): void =>
		doc.transact(() => {
			const { maxG } = view(doc).own;
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
					}
					for (const key of [...node.attrKeys()]) {
						if (key.startsWith(DEL_PREFIX)) node.deleteAttr(key);
					}
					if (node.getAttr(TYPE) !== sp.type) node.setAttr(TYPE, sp.type);
					if (sp.data === undefined) node.deleteAttr(DATA);
					else if (!jsonEquals(node.getAttr(DATA), sp.data)) node.setAttr(DATA, sp.data);
					writeContent(node, sp, (maxG.get(sp.id) ?? 0) + 1);
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
	 * Materialize one spec subtree: the block owns its whole backing text
	 * (one `{B, E}` self-record); children recurse under a fresh
	 * sequential rank chain (a new block has no siblings to interleave with).
	 */
	const materializeSpec = (
		doc: EngineDoc,
		sp: BlockSpec,
		parent: BlockId | null,
		rank: string
	): void => {
		const self: SliceRecord = { t: sp.id, s: { i: null, a: -1 }, e: { i: null, a: 0 } };
		createBlock(doc, sp.id, sp.type, sp.data, { p: parent, r: rank }, [self], sp.content);
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
			if (seen.has(sp.id) || blockNodeOf(doc, sp.id) !== null) return true;
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
	 * `place`: `id`'s slice list is divided at `offset` and the tail records
	 * move into the new block's `slices` — no atom is copied, so an offline
	 * edit to the tail keeps landing on the same backing items and is
	 * claimed by the new block after convergence. `tail` is the new block's
	 * type/data, decided once by the plan. Children are a separate step.
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
		const split = T.splitSlices(doc, blocks, own, id, offset)!;
		const data = tail.data === undefined ? undefined : cloneJson(tail.data);
		createBlock(doc, newId, tail.type, data, place, split.tail);
	};

	// ── queries ─────────────────────────────────────────────────────────

	/**
	 * Canonical projection: pure derivation from replicated state — the
	 * visible tree of live blocks ordered by `(rank, id)`, children of
	 * deleted/merged-away/invalid parents pruned (hidden-with-subtree
	 * policy). Content is the ownership-projected slice list.
	 */
	const project = (doc: EngineDoc): ProjectedDoc => ({ children: R.attach(doc).project() });

	/** `positionOf` in a view: the display parent and the index among its visible children. */
	const positionInView = (v: ModelView, id: BlockId): Destination | null => {
		if (!isLiveIn(v, id)) return null;
		const dp = displayParentOf(v.own, v.placements.get(id)!) as BlockId | null;
		const index = (v.kids.get(dp) ?? []).findIndex((s) => s.id === id);
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
		contentItemsOf,
		// write primitives (the document's prepared plans apply these)
		buildInline,
		isSelfOrDescendant,
		ranksAt,
		writePlacement,
		materializeSpec,
		collides,
		writeSplit,
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
