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
 *        ├ del                              explicit-delete flag (presence = deleted)
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
 * - `del` is an independent replicated flag: a flagged block (and thereby its
 *   subtree, since children keep pointing at it) is hidden regardless of
 *   which placement candidate wins — explicit deletion beats concurrent move.
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
 *   stamp. `del` makes the block's own content dead outright.
 *
 * The module is engine-agnostic: `bindModel(Y)` takes the vendored module
 * surface so this file type-checks against structural interfaces and never
 * imports vendor `.js` (which `pnpm check` must not traverse).
 */
import type { EngineApi, EngineDoc, EngineNode } from '../engine-api.js';
import { encodeRank, rankBetween, RANK_VMIN } from './rank.js';
import {
	bindText,
	computeOwners,
	readSliceEntries,
	type Owner,
	type Ownership,
	type SliceRecord,
	type TextBlockRec
} from '../text/model.js';
import { cloneJson } from '../../utils/json.js';

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

export const REGISTRY_KEY = 'blocks';
const AT = 'at';
const CONTENT = 'content';
const SLICES = 'slices';
const DEL = 'del';
const TYPE = 'type';
const DATA = 'data';
const ID = 'id';
const BLOCK_NODE = 'block';
const CONTENT_NODE = 'content';
const SLICES_NODE = 'slices';
const AT_NODE = 'at';
const INLINE_NODE = 'inline';

/**
 * Deterministic bottom rank — the fallback rank for blocks whose candidates
 * were all cycle-rejected AND that carry no rank at all (e.g. every
 * placement write was undone). `''` is NOT a valid rank string and crashes
 * `rankBetween`; the minimal encodable rank sorts before everything, which
 * matches the previous intent (orphans rehome to the front of the root).
 */
const MIN_RANK = encodeRank([{ v: RANK_VMIN, t: 0 }]);

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
type BlockRec = TextBlockRec & {
	node: EngineNode;
	type: string;
	data: unknown;
	cands: PlacementCand[];
};

/** Resolved placement after acyclic acceptance. */
export type ResolvedPlacement = {
	parent: BlockId | null;
	rank: string;
	/** Which candidate index produced this (0 = argmax, >0 = cycle fallback). */
	via: number;
};

const isNodeLike = (v: unknown): v is EngineNode =>
	v != null && typeof (v as { getAttr?: unknown }).getAttr === 'function';

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

	// ── registry / record access ────────────────────────────────────────

	const registryOf = (doc: EngineDoc): EngineNode => doc.get(REGISTRY_KEY);

	const blockNodeOf = (doc: EngineDoc, id: BlockId): EngineNode | null => {
		const v = registryOf(doc).getAttr(id);
		return isNodeLike(v) ? v : null;
	};

	/** A live block = registry entry exists and carries no `del` flag. */
	const liveNodeOf = (doc: EngineDoc, id: BlockId): EngineNode | null => {
		const n = blockNodeOf(doc, id);
		return n !== null && n.getAttr(DEL) === undefined ? n : null;
	};

	const isLive = (doc: EngineDoc, id: BlockId): boolean => liveNodeOf(doc, id) !== null;

	/** Visible in the projected tree = `isLive` AND not merged away. */
	const isVisibleId = (doc: EngineDoc, id: BlockId): boolean => {
		const { blocks, own } = view(doc);
		return isVisible(blocks, own, id);
	};

	/** Parse the `at` map of a block node into sorted candidates. */
	const candidatesOf = (node: EngineNode): PlacementCand[] => {
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

	/** Read every registry entry into a record map. */
	const collectBlocks = (doc: EngineDoc): Map<BlockId, BlockRec> => {
		const blocks = new Map<BlockId, BlockRec>();
		registryOf(doc).forEachAttr((v: unknown, id: string) => {
			if (!isNodeLike(v)) return;
			const content = v.getAttr(CONTENT);
			const slices = v.getAttr(SLICES);
			const type = v.getAttr(TYPE);
			const slicesNode = isNodeLike(slices) ? slices : undefined;
			blocks.set(id, {
				id,
				node: v,
				type: typeof type === 'string' ? type : 'unknown',
				data: v.getAttr(DATA),
				deleted: v.getAttr(DEL) !== undefined,
				content: isNodeLike(content) ? content : undefined,
				slicesNode,
				// Legacy rows without a `slices` node are treated as one whole
				// self-slice — the pre-U04 schema degrades to intact content.
				entries: slicesNode
					? readSliceEntries(slicesNode)
					: [
							{
								payload: { t: id, s: { i: null, a: -1 }, e: { i: null, a: 0 } },
								stamp: { c: -1, k: -1 },
								seqIndex: 0,
								item: null
							}
						],
				cands: candidatesOf(v)
			});
		});
		return blocks;
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

	// ── pure projection ──────────────────────────────────────────────────

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
	 * self-owned block, `null` (root), or `'dead'` (deleted parent — a sink
	 * that hides the subtree and can never close a cycle).
	 *
	 * `ownerOf` is injectable so `view()` can share the ownership context it
	 * already computed; standalone callers get the map derived from the
	 * block records (pure over replicated state — claims are `slices` items).
	 */
	const resolvePlacements = (
		blocks: Map<BlockId, BlockRec>,
		ownerOf?: (b: BlockId) => Owner
	): Map<BlockId, ResolvedPlacement> => {
		let owner = ownerOf;
		if (!owner) {
			const owners = computeOwners(blocks);
			owner = (b: BlockId): Owner => owners.get(b) ?? 'dead';
		}
		/** The display edge an accepted placement installs: `owner(parent)`. */
		const displayEdge = (pl: ResolvedPlacement): BlockId | null | 'dead' =>
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
			const via = rec.cands.findIndex((c) => c.key === cand.key);
			let p = cand.p;
			if (p !== null && !blocks.has(p)) p = null; // parent never integrated → root
			if (p !== null) {
				const d = owner(p); // the display edge this candidate installs
				// A 'dead' display parent (deleted target) hides the block with
				// its subtree — a sink, never a cycle member. Otherwise reject
				// the candidate iff `d` can already reach the block through
				// accepted display edges — i.e. the block is a display ancestor
				// of `d`. Because accepted edges are acyclic by induction, the
				// walk always terminates.
				if (d !== 'dead') {
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
						if (e === 'dead') break;
						cur = e;
					}
					if (cyclic) continue; // try this block's next candidate
				}
			}
			accepted.set(cand.blockId, { parent: p, rank: cand.r, via });
		}
		// Fallback: blocks whose candidates were all cycle-rejected (or that
		// carry none) are rehomed at the root under their argmax rank; a block
		// with no surviving candidate gets the deterministic bottom rank.
		for (const [id, rec] of blocks) {
			if (!accepted.has(id)) {
				accepted.set(id, { parent: null, rank: rec.cands[0]?.r ?? MIN_RANK, via: -1 });
			}
		}
		return accepted;
	};

	/** Visible = not `del`-flagged and owns its own slice list (not merged away). */
	const isVisible = (blocks: Map<BlockId, BlockRec>, own: Ownership, id: BlockId): boolean => {
		const rec = blocks.get(id);
		return rec !== undefined && !rec.deleted && !own.hidden(id);
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
	const displayParentOf = (own: Ownership, pl: ResolvedPlacement): BlockId | null | 'dead' => {
		if (pl.parent === null) return null;
		// Unclaimed parent → itself; merged-away → the claim owner;
		// 'dead' (deleted/unreachable) → the child is hidden with the subtree.
		return own.ownerOf(pl.parent);
	};

	/**
	 * Ordered `{id, rank}` children of `parent` (null = root): every visible
	 * block whose resolved placement points at `parent`, sorted by
	 * `(rank, id)`. This is the same ordering the projector emits.
	 *
	 * O(#placements) per call — use {@link childrenIndex} when every parent's
	 * list is needed (one pass total instead of one pass per parent).
	 */
	const childrenOf = (
		blocks: Map<BlockId, BlockRec>,
		placements: Map<BlockId, ResolvedPlacement>,
		own: Ownership,
		parent: BlockId | null
	): { id: BlockId; rank: string }[] => {
		const out: { id: BlockId; rank: string }[] = [];
		for (const [id, pl] of placements) {
			if (displayParentOf(own, pl) !== parent) continue;
			if (!isVisible(blocks, own, id)) continue;
			out.push({ id, rank: pl.rank });
		}
		out.sort((a, b) => (a.rank === b.rank ? a.id.localeCompare(b.id) : a.rank < b.rank ? -1 : 1));
		return out;
	};

	/**
	 * All visible children's lists at once: `parent|null → sorted {id, rank}[]`
	 * — ONE pass over `placements` plus one sort per list, so a whole-tree walk
	 * is O(n) instead of the O(n²) of calling {@link childrenOf} per node
	 * (U11 measurement: the per-node scan was ~10ms of an ~11ms projection
	 * at 1,000 blocks). Ordering is identical to `childrenOf`.
	 */
	const childrenIndex = (
		blocks: Map<BlockId, BlockRec>,
		placements: Map<BlockId, ResolvedPlacement>,
		own: Ownership
	): Map<BlockId | null, { id: BlockId; rank: string }[]> => {
		const index = new Map<BlockId | null, { id: BlockId; rank: string }[]>();
		for (const [id, pl] of placements) {
			if (!isVisible(blocks, own, id)) continue;
			const dp = displayParentOf(own, pl);
			// 'dead' display parents never match a real parent in `childrenOf`
			// either — hidden-with-subtree blocks appear in no list.
			if (dp === 'dead') continue;
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

	/** Convenience: collect + resolve placements + ownership once per call. */
	const view = (doc: EngineDoc) => {
		const blocks = collectBlocks(doc);
		const own = T.computeOwnership(doc, blocks);
		return {
			blocks,
			placements: resolvePlacements(blocks, own.ownerOf),
			own
		};
	};

	/** Visible children of `parent` in projection order. */
	const liveChildrenOf = (
		doc: EngineDoc,
		parent: BlockId | null,
		exclude?: Set<BlockId>
	): { id: BlockId; rank: string }[] => {
		const { blocks, placements, own } = view(doc);
		const kids = childrenOf(blocks, placements, own, parent);
		return exclude ? kids.filter((k) => !exclude.has(k.id)) : kids;
	};

	// ── content (rich-text sequence) helpers ────────────────────────────

	const contentOf = (node: EngineNode): EngineNode | undefined => {
		const c = node.getAttr(CONTENT);
		return isNodeLike(c) ? c : undefined;
	};

	const buildInline = (atom: InlineSpec): EngineNode => {
		const node = newNode(INLINE_NODE);
		node.setAttr(ID, atom.id);
		node.setAttr(TYPE, atom.type);
		// Clone at the replicated boundary: the engine stores payloads by
		// reference, so a caller-held `data` object would alias into shared
		// state (mutating the caller's object post-insert would corrupt the
		// doc and replicate the corruption — gate-2 finding 11).
		if (atom.data !== undefined) node.setAttr(DATA, cloneJson(atom.data));
		return node;
	};

	/**
	 * `slices` write handle for a block — created by `insertBlock`/`splitBlock`;
	 * legacy rows (pre-U04 schema) may lack it and get one lazily in the
	 * writing transaction.
	 */
	const slicesNodeOf = (node: EngineNode): EngineNode => {
		const existing = node.getAttr(SLICES);
		if (isNodeLike(existing)) return existing;
		const created = newNode(SLICES_NODE);
		node.setAttr(SLICES, created);
		return created;
	};

	/** Serialize one backing-text node's sequence into ContentItem runs. */
	const contentItemsOf = (content: EngineNode): ContentItem[] => {
		const items: ContentItem[] = [];
		// `toDelta()` re-renders live items — mid-transaction safe, unlike the
		// commit-synced `.delta` cache. Inline atoms stay live YNode children
		// in fresh renders; `.delta` serialized them as `{attrs:{k:{value}}}`.
		const inlineAttrs = (entry: unknown): { id: unknown; type: unknown; data: unknown } => {
			if (isNodeLike(entry)) {
				return { id: entry.getAttr(ID), type: entry.getAttr(TYPE), data: entry.getAttr(DATA) };
			}
			const attrs = (entry as { attrs?: Record<string, unknown> })?.attrs ?? {};
			const attrVal = (a: unknown) =>
				a !== null && typeof a === 'object' && 'value' in (a as object)
					? (a as { value: unknown }).value
					: a;
			return { id: attrVal(attrs.id), type: attrVal(attrs.type), data: attrVal(attrs.data) };
		};
		for (const op of (content.toDelta().toJSON() as { children?: unknown[] }).children ?? []) {
			const o = op as { type?: string; insert?: unknown; format?: Record<string, unknown> };
			if (o.type !== 'insert') continue;
			if (typeof o.insert === 'string') {
				// JSON-payload contract: never emit a `marks` key whose value is
				// `undefined` — `JSON.stringify` would drop it silently and the
				// dev-time cloneJson guard flags it.
				items.push({
					kind: 'text',
					text: o.insert,
					...(o.format === undefined ? {} : { marks: o.format })
				});
			} else if (Array.isArray(o.insert)) {
				for (const entry of o.insert) {
					const { id, type, data } = inlineAttrs(entry);
					items.push({
						kind: 'inline',
						id: id as string,
						type: type as string,
						...(data === undefined ? {} : { data: data as Record<string, unknown> })
					});
				}
			}
		}
		return items;
	};

	/**
	 * Append content items to a content node (mark-preserving). The offset is
	 * tracked locally rather than read back — `length` is an invalid read on
	 * not-yet-integrated nodes (the engine warns and returns garbage), so this
	 * works on detached subtrees too.
	 */
	const appendItems = (content: EngineNode, items: ContentItem[]): void => {
		let off = content.doc === null ? 0 : content.length;
		for (const item of items) {
			if (item.kind === 'text') {
				content.insert(
					off,
					item.text,
					item.marks === undefined ? undefined : cloneJson(item.marks)
				);
				off += item.text.length;
			} else {
				content.insert(off, [buildInline(item)]);
				off += 1;
			}
		}
	};

	/** Content items strictly after `offset` positions (marks preserved). */
	const contentTail = (content: EngineNode, offset: number): ContentItem[] => {
		const items: ContentItem[] = [];
		const attrVal = (a: unknown) =>
			a !== null && typeof a === 'object' && 'value' in (a as object)
				? (a as { value: unknown }).value
				: a;
		const inlineAttrs = (entry: unknown): { id: unknown; type: unknown; data: unknown } => {
			if (isNodeLike(entry)) {
				return { id: entry.getAttr(ID), type: entry.getAttr(TYPE), data: entry.getAttr(DATA) };
			}
			const attrs = (entry as { attrs?: Record<string, unknown> })?.attrs ?? {};
			return { id: attrVal(attrs.id), type: attrVal(attrs.type), data: attrVal(attrs.data) };
		};
		let pos = 0;
		for (const op of (content.toDelta().toJSON() as { children?: unknown[] }).children ?? []) {
			const o = op as { type?: string; insert?: unknown; format?: Record<string, unknown> };
			if (o.type !== 'insert') continue;
			if (typeof o.insert === 'string') {
				const start = pos;
				pos += o.insert.length;
				if (pos <= offset) continue;
				items.push({
					kind: 'text',
					text: o.insert.slice(Math.max(0, offset - start)),
					...(o.format === undefined ? {} : { marks: o.format })
				});
			} else if (Array.isArray(o.insert)) {
				for (const entry of o.insert) {
					pos += 1;
					if (pos <= offset) continue;
					const { id, type, data } = inlineAttrs(entry);
					items.push({
						kind: 'inline',
						id: id as string,
						type: type as string,
						...(data === undefined ? {} : { data: data as Record<string, unknown> })
					});
				}
			}
		}
		return items;
	};

	// ── structural predicates ───────────────────────────────────────────

	/**
	 * True iff `maybeAncestor` is `id` itself or lies on `id`'s
	 * DISPLAY-ancestor chain — the composed relation `owner(parent)`
	 * (`displayParentOf`), not the raw placement chain. A merge claim can
	 * place a block inside another's display subtree without appearing in
	 * its raw ancestry, so the local invalid-op rejection must see through
	 * the claim redirect — this is exactly the relation `resolvePlacements`
	 * keeps acyclic. Used for the local invalid-move/merge rejections: an op
	 * that would nest a block under its own display subtree is refused
	 * without mutation.
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
			if (dp === 'dead') break; // deleted ancestor sink — subtree hidden, not cyclic
			cur = dp;
		}
		return false;
	};

	// ── ops ─────────────────────────────────────────────────────────────

	/**
	 * Rank for inserting at `index` into the sibling list `siblings`.
	 * Equal-rank neighbors can occur after cycle-fallback rehoming (two blocks
	 * may carry the same rank string minted in different sibling lists): no
	 * string sorts strictly between equal strings, so the new block JOINS the
	 * tie — the `(rank, id)` sort places it deterministically inside the tie
	 * group.
	 */
	const rankAt = (
		siblings: { rank: string }[],
		index: number,
		clientId: number,
		rand?: () => number
	): string => {
		const left = siblings[index - 1]?.rank;
		const right = siblings[index]?.rank;
		if (left !== undefined && right !== undefined && left >= right) return left;
		return rankBetween(left, right, clientId, rand);
	};

	/**
	 * The doc's in-gap rank randomness source (`EngineDoc.rand` — a test
	 * harness determinism hook; production docs get `Math.random`).
	 */
	const randOf = (doc: EngineDoc): (() => number) => doc.rand ?? Math.random;

	/**
	 * Insert a new block (and its spec children, recursively) at `dest`.
	 * No-op `false` when the parent is unresolvable/deleted or ANY id in the
	 * spec tree is already taken — the registry is keyed by id, so a spec id
	 * colliding with an existing entry (live or deleted) is refused rather
	 * than overwriting it. Validation is all-or-nothing BEFORE any mutation:
	 * a nested-child collision must not partially insert the spec nor
	 * tombstone the victim's registry item (gate-1 finding: `registry.setAttr`
	 * on an existing id silently replaces content, slices, placements and
	 * engine identity in place). Ids duplicated WITHIN the spec are rejected
	 * the same way.
	 */
	const insertBlock = (doc: EngineDoc, dest: Destination, spec: BlockSpec): boolean => {
		if (dest.parent !== null && !isVisibleId(doc, dest.parent)) return false;
		{
			const specIds = new Set<BlockId>();
			const stack: BlockSpec[] = [spec];
			while (stack.length > 0) {
				const sp = stack.pop()!;
				if (specIds.has(sp.id) || blockNodeOf(doc, sp.id) !== null) return false;
				specIds.add(sp.id);
				for (const child of sp.children ?? []) stack.push(child);
			}
		}
		return doc.transact(() => {
			const insertOne = (sp: BlockSpec, parent: BlockId | null, rank: string): void => {
				const node = newNode(BLOCK_NODE);
				node.setAttr(ID, sp.id);
				node.setAttr(TYPE, sp.type);
				if (sp.data !== undefined) node.setAttr(DATA, cloneJson(sp.data));
				const content = newNode(CONTENT_NODE);
				node.setAttr(CONTENT, content);
				const slices = newNode(SLICES_NODE);
				node.setAttr(SLICES, slices);
				const at = newNode(AT_NODE);
				node.setAttr(AT, at);
				// Pre-integration writes materialize when the subtree integrates.
				let clen = 0;
				for (const item of sp.content ?? []) {
					if (item.kind === 'text') {
						// Clone caller mark payloads — `insert` keeps the format
						// object by reference (see buildInline / gate-2 f.11).
						content.insert(
							clen,
							item.text,
							item.marks === undefined ? undefined : cloneJson(item.marks)
						);
						clen += item.text.length;
					} else {
						content.insert(clen, [buildInline(item)]);
						clen += 1;
					}
				}
				// The block owns its whole backing text by default.
				slices.insert(0, [
					{ t: sp.id, s: { i: null, a: -1 }, e: { i: null, a: 0 } } satisfies SliceRecord
				]);
				at.setAttr(`1.${doc.clientID}`, { p: parent, r: rank });
				registryOf(doc).setAttr(sp.id, node);
				// Children get sequential ranks among themselves.
				let left: string | undefined;
				for (const child of sp.children ?? []) {
					const cr = rankBetween(left, undefined, doc.clientID, randOf(doc));
					insertOne(child, sp.id, cr);
					left = cr;
				}
			};
			const sibs = liveChildrenOf(doc, dest.parent);
			const idx = Math.max(0, Math.min(dest.index, sibs.length));
			insertOne(spec, dest.parent, rankAt(sibs, idx, doc.clientID, randOf(doc)));
			return true;
		});
	};

	/** Explicit delete: set the `del` flag. Payload/placements retained. */
	const deleteBlock = (doc: EngineDoc, id: BlockId): boolean => {
		const node = blockNodeOf(doc, id);
		if (!node) return false;
		if (node.getAttr(DEL) !== undefined) return true; // already deleted — idempotent
		return doc.transact(() => {
			node.setAttr(DEL, true);
			return true;
		});
	};

	/**
	 * Relocate `id` to `dest` (final-index semantics: `dest.index` counts the
	 * destination's children with `id` already removed). Local invalid moves —
	 * unknown/deleted block, unknown/deleted parent, or a destination inside
	 * the block's own subtree — return false without mutating.
	 */
	const moveBlock = (doc: EngineDoc, id: BlockId, dest: Destination): boolean => {
		const node = liveNodeOf(doc, id);
		if (!node) return false;
		if (dest.parent !== null && !isVisibleId(doc, dest.parent)) return false;
		const { placements, own } = view(doc);
		if (dest.parent !== null && isSelfOrDescendant(placements, own, dest.parent, id)) {
			return false; // would nest a block under its own display subtree — reject, no mutation
		}
		return doc.transact(() => {
			const sibs = liveChildrenOf(doc, dest.parent, new Set([id]));
			const idx = Math.max(0, Math.min(dest.index, sibs.length));
			writePlacement(doc, node, dest.parent, rankAt(sibs, idx, doc.clientID, randOf(doc)));
			return true;
		});
	};

	/**
	 * Grouped move: relocate `ids` (in given source order) to consecutive
	 * positions starting at `dest.index` — ONE transaction, so one undo step.
	 * Conflicts resolve per member (each block writes its own candidate); a
	 * member separately moved later wins or loses by the normal order.
	 * All-or-nothing locally: any unresolvable member or invalid destination
	 * aborts the whole group without mutating.
	 */
	const moveBlocks = (doc: EngineDoc, ids: BlockId[], dest: Destination): boolean => {
		if (ids.length === 0) return false;
		const nodes: EngineNode[] = [];
		for (const id of ids) {
			const n = liveNodeOf(doc, id);
			if (!n) return false;
			nodes.push(n);
		}
		if (dest.parent !== null && !isVisibleId(doc, dest.parent)) return false;
		const { placements, own } = view(doc);
		if (dest.parent !== null) {
			for (const id of ids) {
				if (isSelfOrDescendant(placements, own, dest.parent, id)) return false;
			}
		}
		const members = new Set(ids);
		return doc.transact(() => {
			const sibs = liveChildrenOf(doc, dest.parent, members);
			const idx = Math.max(0, Math.min(dest.index, sibs.length));
			let left = sibs[idx - 1]?.rank;
			const right = sibs[idx]?.rank;
			for (let i = 0; i < ids.length; i++) {
				const r = rankBetween(left, right, doc.clientID, randOf(doc));
				writePlacement(doc, nodes[i], dest.parent, r);
				left = r;
			}
			return true;
		});
	};

	/** Convenience: move `id` to the last position under `newParentId`. */
	const nestBlock = (doc: EngineDoc, id: BlockId, newParentId: BlockId): boolean => {
		if (!isVisibleId(doc, newParentId)) return false;
		return moveBlock(doc, id, {
			parent: newParentId,
			index: liveChildrenOf(doc, newParentId).length
		});
	};

	/** Convenience: move `id` beside its parent (index = parent index + 1). */
	const unNestBlock = (doc: EngineDoc, id: BlockId): boolean => {
		const pos = positionOf(doc, id);
		if (!pos || pos.parent === null) return false;
		const ppos = positionOf(doc, pos.parent);
		if (!ppos) return false;
		return moveBlock(doc, id, { parent: ppos.parent, index: ppos.index + 1 });
	};

	/**
	 * Split `id` at content `offset`: the block's slice list is materialized
	 * into anchored records and divided at `offset`; the tail records move
	 * into the new sibling `newId`'s `slices` — no atom is copied, so an
	 * offline edit to the tail keeps landing on the same backing items and is
	 * claimed by the sibling after convergence. The block's children are
	 * reparented onto the sibling (the existing editor contract), each via a
	 * normal placement write.
	 */
	const splitBlock = (doc: EngineDoc, id: BlockId, offset: number, newId: BlockId): boolean => {
		const node = liveNodeOf(doc, id);
		if (!node) return false;
		if (blockNodeOf(doc, newId) !== null) return false;
		const pos = positionOf(doc, id);
		if (!pos) return false; // block not visible (ancestor deleted) — no-op
		return doc.transact(() => {
			const { blocks, placements, own } = view(doc);
			if (!isVisible(blocks, own, id)) return false;
			const split = T.splitSlices(doc, blocks, own, id, offset);
			if (!split) return false;
			// New sibling immediately after `id` under the same parent.
			const sibs = childrenOf(blocks, placements, own, pos.parent);
			const myIdx = sibs.findIndex((s) => s.id === id);
			const rank = rankAt(sibs, myIdx + 1, doc.clientID, randOf(doc));
			const sibling = newNode(BLOCK_NODE);
			sibling.setAttr(ID, newId);
			sibling.setAttr(TYPE, node.getAttr(TYPE));
			const data = node.getAttr(DATA);
			if (data !== undefined) sibling.setAttr(DATA, cloneJson(data));
			// Own empty backing text (future inserts/undo targets) + tail claims.
			sibling.setAttr(CONTENT, newNode(CONTENT_NODE));
			const sSlices = newNode(SLICES_NODE);
			sibling.setAttr(SLICES, sSlices);
			const atNode = newNode(AT_NODE);
			sibling.setAttr(AT, atNode);
			if (split.tail.length > 0) sSlices.insert(0, split.tail);
			atNode.setAttr(`1.${doc.clientID}`, { p: pos.parent, r: rank });
			registryOf(doc).setAttr(newId, sibling);
			// Children follow the split — reparent each onto `newId` in order.
			let left: string | undefined;
			for (const k of childrenOf(blocks, placements, own, id)) {
				const r = rankBetween(left, undefined, doc.clientID, randOf(doc));
				writePlacement(doc, blocks.get(k.id)!.node, newId, r);
				left = r;
			}
			return true;
		});
	};

	/**
	 * Merge `fromId` into `intoId`: appends one merge-claim record `{m:fromId}`
	 * to `intoId`'s slice list and reparents `fromId`'s children. `fromId` is
	 * NOT `del`-flagged — it is hidden derivatively because the claim makes
	 * `owner(fromId) = intoId`, so an undone or dead claim restores it.
	 * Content is never copied: `fromId`'s atoms stay in its backing text and
	 * are displayed by `intoId` through the claim.
	 */
	const mergeBlocks = (doc: EngineDoc, fromId: BlockId, intoId: BlockId): boolean => {
		if (fromId === intoId) return false;
		const from = liveNodeOf(doc, fromId);
		const into = liveNodeOf(doc, intoId);
		if (!from || !into) return false;
		const { blocks, placements, own } = view(doc);
		if (!isVisible(blocks, own, fromId) || !isVisible(blocks, own, intoId)) return false;
		// Composed-cycle guard: the claim `{m:fromId}` redirects the display
		// parent of every placement-child of `fromId`'s claimed set to
		// `intoId`. If `intoId` displays inside `fromId`'s subtree, the claim
		// closes a cycle in the composed relation (`intoId → … → fromId →
		// intoId`) that the raw placement graph cannot see — the subtree
		// would be live but unreachable on every replica. Reject without
		// mutating, like the invalid-move rejection (concurrent versions of
		// the same cycle that no local guard can see are resolved
		// deterministically acyclic by `resolvePlacements`).
		if (isSelfOrDescendant(placements, own, intoId, fromId)) return false;
		return doc.transact(() => {
			// `from`'s children append at the end of `into`'s child list — read
			// BEFORE the claim hides `from` (its children stay visible either
			// way, but the sibling order is read from the pre-claim state).
			const intoKids = childrenOf(blocks, placements, own, intoId);
			const fromKids = childrenOf(blocks, placements, own, fromId);
			T.claimInto(blocks, fromId, intoId);
			let left = intoKids[intoKids.length - 1]?.rank;
			for (const k of fromKids) {
				const r = rankBetween(left, undefined, doc.clientID, randOf(doc));
				writePlacement(doc, blockNodeOf(doc, k.id)!, intoId, r);
				left = r;
			}
			return true;
		});
	};

	// ── inline content ops ──────────────────────────────────────────────

	/**
	 * Shared op prelude: resolve the ownership view once, refuse ops on
	 * non-visible targets (deleted or merged-away blocks have no display and
	 * cannot accept edits).
	 */
	const ownView = (doc: EngineDoc, id: BlockId) => {
		const { blocks, own } = view(doc);
		if (!isVisible(blocks, own, id)) return null;
		return { blocks, own };
	};

	const insertText = (
		doc: EngineDoc,
		id: BlockId,
		offset: number,
		text: string,
		marks?: Record<string, unknown>
	): boolean => {
		if (!liveNodeOf(doc, id)) return false;
		return doc.transact(() => {
			const v = ownView(doc, id);
			if (!v) return false;
			return T.insertIntoText(doc, v.blocks, v.own, id, offset, text, marks);
		});
	};

	const deleteText = (doc: EngineDoc, id: BlockId, offset: number, length: number): boolean => {
		if (!liveNodeOf(doc, id)) return false;
		return doc.transact(() => {
			const v = ownView(doc, id);
			if (!v) return false;
			return T.deleteRange(doc, v.blocks, v.own, id, offset, length);
		});
	};

	const formatRange = (
		doc: EngineDoc,
		id: BlockId,
		offset: number,
		length: number,
		formats: Record<string, unknown>
	): boolean => {
		if (!liveNodeOf(doc, id)) return false;
		return doc.transact(() => {
			const v = ownView(doc, id);
			if (!v) return false;
			return T.formatRangeIn(doc, v.blocks, v.own, id, offset, length, formats);
		});
	};

	const setMark = (
		doc: EngineDoc,
		id: BlockId,
		offset: number,
		length: number,
		name: string,
		value: unknown
	): boolean => formatRange(doc, id, offset, length, { [name]: value });

	const unsetMark = (
		doc: EngineDoc,
		id: BlockId,
		offset: number,
		length: number,
		name: string
	): boolean => formatRange(doc, id, offset, length, { [name]: null });

	const insertInline = (doc: EngineDoc, id: BlockId, offset: number, atom: InlineSpec): boolean => {
		if (!liveNodeOf(doc, id)) return false;
		return doc.transact(() => {
			const v = ownView(doc, id);
			if (!v) return false;
			return T.insertIntoText(doc, v.blocks, v.own, id, offset, buildInline(atom));
		});
	};

	const removeInline = (doc: EngineDoc, id: BlockId, inlineId: string): boolean => {
		if (!liveNodeOf(doc, id)) return false;
		return doc.transact(() => {
			const v = ownView(doc, id);
			if (!v) return false;
			for (const seg of T.flatten(id, v.blocks, v.own)) {
				const text = v.blocks.get(seg.t)?.content;
				if (!text) continue;
				// `toArray` returns CONTENT elements — a multi-char string is
				// ONE element — so the array index is not the sequence
				// position. Track positions explicitly.
				const arr = text.toArray();
				let p = 0;
				for (const entry of arr) {
					const elen = typeof entry === 'string' ? entry.length : 1;
					if (isNodeLike(entry) && entry.getAttr(ID) === inlineId && p >= seg.i0 && p < seg.i1) {
						text.delete(p, 1);
						return true;
					}
					p += elen;
				}
			}
			return false;
		});
	};

	/**
	 * Replace an inline atom's `data` payload (metadata update — AN03).
	 * Identity is preserved: the same atom node stays in place, only its
	 * `data` attr is rewritten. Returns false when the atom is not found in
	 * `id`'s owned content.
	 */
	const setInlineData = (
		doc: EngineDoc,
		id: BlockId,
		inlineId: string,
		data: Record<string, unknown>
	): boolean => {
		if (!liveNodeOf(doc, id)) return false;
		return doc.transact(() => {
			const v = ownView(doc, id);
			if (!v) return false;
			for (const seg of T.flatten(id, v.blocks, v.own)) {
				const text = v.blocks.get(seg.t)?.content;
				if (!text) continue;
				const arr = text.toArray();
				let p = 0;
				for (const entry of arr) {
					const elen = typeof entry === 'string' ? entry.length : 1;
					if (isNodeLike(entry) && entry.getAttr(ID) === inlineId && p >= seg.i0 && p < seg.i1) {
						// Clone the caller payload — setAttr stores by reference.
						entry.setAttr(DATA, cloneJson(data));
						return true;
					}
					p += elen;
				}
			}
			return false;
		});
	};

	// ── queries ─────────────────────────────────────────────────────────

	/**
	 * Canonical projection: pure derivation from replicated state — the
	 * visible tree of live blocks ordered by `(rank, id)`, children of
	 * deleted/merged-away/invalid parents pruned (hidden-with-subtree
	 * policy). Content is the ownership-projected slice list.
	 */
	const project = (doc: EngineDoc): ProjectedDoc => {
		const { blocks, placements, own } = view(doc);
		// ONE O(n) bucketing pass (U11: per-node `childrenOf` scans made this
		// O(n²) — ~10ms of an ~11ms projection at 1,000 blocks).
		const kidsByParent = childrenIndex(blocks, placements, own);
		const emit = (id: BlockId): ProjectedBlock | null => {
			if (!isVisible(blocks, own, id)) return null;
			const rec = blocks.get(id)!;
			const data = rec.data;
			const projected: ProjectedBlock = {
				id,
				type: rec.type,
				data:
					data === undefined || data === null
						? undefined
						: (cloneJson(data) as Record<string, unknown>),
				content: rec.content ? (T.contentItemsOf(id, blocks, own) as ContentItem[]) : [],
				children: []
			};
			if (!rec.content) projected.malformed = true;
			for (const k of kidsByParent.get(id) ?? []) {
				const child = emit(k.id);
				if (child) projected.children.push(child);
			}
			return projected;
		};
		const children: ProjectedBlock[] = [];
		for (const k of kidsByParent.get(null) ?? []) {
			const b = emit(k.id);
			if (b) children.push(b);
		}
		return { children };
	};

	/**
	 * `positionOf` against an already-collected view — the public
	 * {@link positionOf} delegates to this after calling {@link view}. Callers
	 * walking several positions (paths, ancestors, doc-order neighbours) share
	 * ONE view instead of re-collecting per step (U11: navigation helpers
	 * were O(depth × collect) — ~1.2ms × depth at 1,000 blocks).
	 */
	const positionInView = (
		blocks: Map<BlockId, BlockRec>,
		placements: Map<BlockId, ResolvedPlacement>,
		own: Ownership,
		id: BlockId
	): Destination | null => {
		if (!isVisible(blocks, own, id)) return null;
		const pl = placements.get(id);
		if (!pl) return null;
		const dp = displayParentOf(own, pl);
		if (dp === 'dead') return null;
		// Walk the ancestry chain of display parents: any dead or invisible
		// ancestor hides the whole subtree.
		let cur: BlockId | null = dp;
		const seen = new Set<BlockId>();
		while (cur !== null && !seen.has(cur)) {
			seen.add(cur);
			if (!isVisible(blocks, own, cur)) return null;
			const cp = placements.get(cur);
			if (!cp) return null;
			const next = displayParentOf(own, cp);
			if (next === 'dead') return null;
			cur = next;
		}
		const sibs = childrenOf(blocks, placements, own, dp);
		const index = sibs.findIndex((s) => s.id === id);
		return index < 0 ? null : { parent: dp, index };
	};

	/**
	 * `{parent, index}` of `id` in the visible tree, or null when hidden/absent.
	 * `parent` is the DISPLAY parent (merged-away ancestors resolve to their
	 * owner — see `displayParentOf`).
	 */
	const positionOf = (doc: EngineDoc, id: BlockId): Destination | null => {
		const { blocks, placements, own } = view(doc);
		return positionInView(blocks, placements, own, id);
	};

	/** Pre-order ids of the visible tree. */
	const listBlockIds = (doc: EngineDoc): BlockId[] => {
		const out: BlockId[] = [];
		const walk = (bs: ProjectedBlock[]) => {
			for (const b of bs) {
				out.push(b.id);
				walk(b.children);
			}
		};
		walk(project(doc).children);
		return out;
	};

	/** Flat text of a block's OWNED content (atoms render as ''). */
	const blockText = (doc: EngineDoc, id: BlockId): string | null => {
		const node = liveNodeOf(doc, id);
		if (!node) return null;
		const { blocks, own } = view(doc);
		if (!isVisible(blocks, own, id)) return null;
		return T.blockTextOf(id, blocks, own);
	};

	/**
	 * Engine identity of the registry entry (`client:clock` of its item), or
	 * null when the block is absent from the visible tree (deleted, or hidden
	 * under a deleted/unreachable ancestor).
	 */
	const crdtId = (doc: EngineDoc, id: BlockId): string | null => {
		if (positionOf(doc, id) === null) return null;
		const node = blockNodeOf(doc, id);
		const item = node?._item;
		if (!node || !item || item.deleted || !item.id) return null;
		return `${item.id.client}:${item.id.clock}`;
	};

	/** Live engine handle for a logical id, or null when absent/deleted. */
	const resolveBlock = (doc: EngineDoc, id: BlockId): EngineNode | null => liveNodeOf(doc, id);

	return {
		// constants
		REGISTRY_KEY,
		// records / projection internals (exported for tests + ADR probes)
		registryOf,
		blockNodeOf,
		liveNodeOf,
		candidatesOf,
		collectBlocks,
		resolvePlacements,
		childrenOf,
		childrenIndex,
		positionInView,
		contentItemsOf,
		// structural ops
		insertBlock,
		deleteBlock,
		moveBlock,
		moveBlocks,
		nestBlock,
		unNestBlock,
		splitBlock,
		mergeBlocks,
		// content ops
		insertText,
		deleteText,
		setMark,
		unsetMark,
		insertInline,
		removeInline,
		setInlineData,
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
