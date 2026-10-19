/**
 * Compact, durable, per-BLOCK attribution on the existing owners.
 *
 * One block gets one small replicated record plus one block-node attr:
 *
 * - `<blockId>` → nested node on the `blockattr` root
 *   (`SCHEMA.roots.blockAttribution`) carrying `c` (createdBy actorId)
 *   and `k/<actorId>` → true contributor membership.
 * - `l` (lastChangedBy) lives on the block node itself —
 *   `SCHEMA.blockAttrs.lastChanged` — an LWW attr resolved by the
 *   engine's deterministic item ordering (no wall-clock claims).
 *
 * Why the split:
 *
 * - `createdBy`/`contributors` are MONOTONIC — `contributors` is a
 *   union set: entries are only ever added, never removed, so two
 *   replicas' adds converge by construction, and undo MUST NOT restore
 *   a "before I contributed" state. They sit on the `blockattr` root,
 *   which stays OUTSIDE `createUndoManager`'s scope — undo cannot
 *   strip them.
 * - `lastChangedBy` must RESTORE on undo (undo alice's only edit →
 *   `l` reverts to the previous author). The block node is inside the
 *   registry subtree — already in the UndoManager's scope — so the
 *   engine's item-level undo restores the previous `l` item for free.
 *
 * INCARNATIONS — a public block id is recyclable (a caller id created
 * again after its creation was undone, or concurrently by two peers), and a
 * delayed remote write always addresses the incarnation its author saw.
 * Every block node carries the replicated nonce `n` of its incarnation;
 * every record is stamped (`i`) with the nonce it belongs
 * to, and `ensureRecord` swaps in a FRESH record whenever the live node's
 * nonce doesn't match — a late write to a dead incarnation lands on an
 * orphaned record the recreated block never reads. An undo/redo copy of the
 * node carries `n` with it, so it keeps its record on every replica.
 *
 * Suppression, per the ledger contract:
 *
 * - `l` writes are suppressed ONLY when THIS replica already owns the
 *   surviving `l` map item AND its value matches — item WRITER identity,
 *   not a per-replica value cache. A second replica of the same actor
 *   must write its own `l` item: undo of the earlier replica's stamp
 *   then resolves to the next SURVIVING writer's item instead of
 *   resurrecting a stale value. (The engine's redoItem walk keeps the
 *   newer surviving item as the map tip, so a delayed same-actor stamp
 *   also wins over an undo of the item it replaced.)
 * - Contributor adds are value-suppressed (`k/<actor>` written only
 *   when absent) — union semantics make the check trivially safe.
 * - Semantic no-ops (same-value type/data, empty ranges, pure moves)
 *   are suppressed by the CALLERS: ops stamp only after a real write.
 *
 * Known residual: record nodes are LWW map entries — concurrent FIRST
 * touches of a record-less block (foreign/migrated docs may lack records)
 * can lose one contributor add. Convergent; heals on the next touch.
 *
 * All writes are plain `setAttr`s performed by the owning facade op
 * INSIDE the operation's transaction — the metadata commits in the
 * same update as the content write. No observer-driven follow-up
 * transaction (the retired `a/` per-content capture pipeline is untouched
 * and still coexists on the `attribution` root).
 */
import type { EngineApi, EngineDoc, EngineNode } from '../engine-api.js';
import { REGISTRY_KEY, type BlockId } from '../placement/model.js';
import { BLOCK_ATTR_ROOT, isNodeLike, LAST_CHANGED_ATTR, NONCE } from '../schema.js';
import { attrItems, newNode as makeNode } from '../structs.js';

/** The durable per-block attribution record a replica sees. */
export type ActorId = string;

export type BlockAttribution = {
	/** The actor that created the block — assigned at creation, never rewritten. */
	createdBy?: ActorId;
	/**
	 * Union set of actors that committed an edit addressing this block id,
	 * plus the pre-split snapshot a split/merge copies to siblings —
	 * block-identity LINEAGE, add-only. Not authorship of the text
	 * currently rendered here (a concurrent split can carry an actor's
	 * atoms into a sibling the actor never addressed).
	 */
	contributors: ReadonlySet<ActorId>;
	/** The actor whose state change currently wins the LWW resolution. */
	lastChangedBy?: ActorId;
};

// `BLOCK_ATTR_ROOT`/`LAST_CHANGED_ATTR` live in the shared
// `../schema.js` leaf — re-exported so existing import sites stay.
export { BLOCK_ATTR_ROOT, LAST_CHANGED_ATTR };

const REC_NODE = 'brec';
const CREATED_KEY = 'c';
const CONTRIBUTOR_PREFIX = 'k/';
/** Incarnation stamp on a record: the nonce `n` of the node it belongs to. */
const INCARNATION_KEY = 'i';

const recordOf = (doc: EngineDoc, id: BlockId): EngineNode | null => {
	const v = doc.get(BLOCK_ATTR_ROOT).getAttr(id);
	return isNodeLike(v) ? v : null;
};

const blockNodeOf = (doc: EngineDoc, id: BlockId): EngineNode | null => {
	const v = doc.get(REGISTRY_KEY).getAttr(id);
	return isNodeLike(v) ? v : null;
};

/**
 * Reads resolve whatever record node the block's attr currently elects.
 * Isolation is enforced on the WRITE side — `ensureRecord` swaps a fresh
 * record in when the attr winner's incarnation stamp doesn't match the live
 * block node's nonce — and the attr winner is already convergent.
 */

/** Client id of the replica that wrote the CURRENT `l` map item (null when none/deleted). */
const lTipWriter = (node: EngineNode): number | null => {
	type Tip = { id?: { client: number; clock: number }; deleted?: boolean };
	const item = attrItems<Tip | null>(node).get(LAST_CHANGED_ATTR);
	return item != null && !item.deleted && item.id !== undefined ? item.id.client : null;
};

/** The `k/` member set on a `b/` record node. */
export const contributorsOfRecord = (rec: EngineNode | null): Set<ActorId> => {
	const out = new Set<ActorId>();
	if (rec === null) return out;
	for (const key of rec.attrKeys()) {
		if (key.startsWith(CONTRIBUTOR_PREFIX) && rec.getAttr(key) === true) {
			out.add(key.slice(CONTRIBUTOR_PREFIX.length));
		}
	}
	return out;
};

/**
 * Read one block's attribution. O(1) in doc size — one root-attr lookup
 * plus one block-node attr lookup. Returns `undefined` when the block
 * carries no attribution at all (system/foreign content stays unlabeled).
 */
export const blockAttributionOf = (doc: EngineDoc, id: BlockId): BlockAttribution | undefined => {
	const node = blockNodeOf(doc, id);
	const rec = recordOf(doc, id);
	const l = node?.getAttr(LAST_CHANGED_ATTR);
	let createdBy: ActorId | undefined;
	if (rec !== null) {
		const c = rec.getAttr(CREATED_KEY);
		if (typeof c === 'string') createdBy = c;
	}
	const contributors = contributorsOfRecord(rec);
	if (createdBy === undefined && contributors.size === 0 && typeof l !== 'string') {
		return undefined;
	}
	return {
		createdBy,
		contributors,
		lastChangedBy: typeof l === 'string' ? l : undefined
	};
};

/**
 * Bound write helpers. `stampChange`/`stampCreated`/`unionContributors`
 * must be called INSIDE the operation's `doc.transact` — they perform
 * plain setAttrs so the metadata commits in the same update.
 */
export const bindBlockAttribution = (Y: EngineApi) => {
	const newNode = (name: string): EngineNode => makeNode(Y, name);

	/**
	 * Get-or-create the record for `node`'s incarnation (its nonce).
	 * A record stamped for another incarnation is dead state — a fresh record
	 * replaces it as the attr winner (the orphan stays readable only as the
	 * last-incarnation fallback). `node` defaults to the id's current registry
	 * node; call inside a transaction.
	 */
	const ensureRecord = (doc: EngineDoc, id: BlockId, node?: EngineNode | null): EngineNode => {
		const n = (node === undefined ? blockNodeOf(doc, id) : node)?.getAttr(NONCE);
		const existing = recordOf(doc, id);
		if (existing !== null && (n === undefined || existing.getAttr(INCARNATION_KEY) === n)) {
			return existing;
		}
		const rec = newNode(REC_NODE);
		doc.get(BLOCK_ATTR_ROOT).setAttr(id, rec);
		if (n !== undefined) rec.setAttr(INCARNATION_KEY, n);
		return rec;
	};

	const addContributor = (rec: EngineNode, actorId: ActorId): void => {
		const key = CONTRIBUTOR_PREFIX + actorId;
		// `!== true` (not `=== undefined`) — a cleared stale membership reads
		// `false` and must still be re-added.
		if (rec.getAttr(key) !== true) rec.setAttr(key, true);
	};

	const stampLastChanged = (doc: EngineDoc, node: EngineNode, actorId: ActorId): void => {
		// Suppress ONLY when this replica already owns the surviving `l`
		// item with the same value — the item's writer, not a per-replica
		// value cache, decides. A second replica of the same actor must
		// write its own item: undo of an earlier replica's `l` item then
		// exposes the NEXT surviving writer's stamp instead of resurrecting
		// a stale value.
		if (node.getAttr(LAST_CHANGED_ATTR) === actorId && lTipWriter(node) === doc.clientID) {
			return;
		}
		node.setAttr(LAST_CHANGED_ATTR, actorId);
	};

	return {
		/** Scaffolding with no authorship — used by init for system blocks. */
		ensureRecord,
		/**
		 * A streamless block's nonce was re-minted `from` → `to` (its own text):
		 * its record, when stamped for `from`, moves to `to`, so the
		 * block keeps `createdBy` and its contributors. Every replica writes
		 * the same value.
		 */
		retarget: (doc: EngineDoc, id: BlockId, from: unknown, to: unknown): void => {
			const rec = recordOf(doc, id);
			if (rec !== null && from !== undefined && rec.getAttr(INCARNATION_KEY) === from)
				rec.setAttr(INCARNATION_KEY, to);
		},
		/**
		 * The actor changed the block's state: `contributors.add(actor)` and
		 * `lastChangedBy = actor`, each independently suppressed.
		 */
		stampChange: (doc: EngineDoc, node: EngineNode, id: BlockId, actorId: ActorId): void => {
			addContributor(ensureRecord(doc, id, node), actorId);
			stampLastChanged(doc, node, actorId);
		},
		/**
		 * New block authored by `actorId`: `createdBy` (write-once), the
		 * creator joins `contributors`, `lastChangedBy = actorId`.
		 * `inheritFrom` (split) instead copies the SOURCE block's contributor
		 * set verbatim — the split is authored via `createdBy`/`lastChangedBy`.
		 */
		stampCreated: (
			doc: EngineDoc,
			node: EngineNode,
			id: BlockId,
			actorId: ActorId,
			inheritFrom?: BlockId
		): void => {
			const rec = ensureRecord(doc, id, node);
			const created = rec.getAttr(CREATED_KEY);
			if (created !== actorId) rec.setAttr(CREATED_KEY, actorId);
			if (created !== undefined && created !== actorId) {
				// A DIFFERENT actor already authored this incarnation's
				// record — a genuine authorship conflict (concurrent create
				// of the same id, or a migrated/foreign doc): the rewrite
				// above landed, so the previous owner's contributor set is
				// cleared alongside (cleared to `false`, never deleted —
				// `contributorsOfRecord` treats `!== true` as absent, and
				// item-level LWW keeps the clear convergent). Same-actor
				// re-stamps skip this so repeat `stampCreated` calls can't
				// wipe contributors added between them.
				for (const key of rec.attrKeys()) {
					if (key.startsWith(CONTRIBUTOR_PREFIX)) rec.setAttr(key, false);
				}
			}
			if (inheritFrom !== undefined) {
				for (const a of contributorsOfRecord(recordOf(doc, inheritFrom))) {
					addContributor(rec, a);
				}
			} else {
				addContributor(rec, actorId);
			}
			stampLastChanged(doc, node, actorId);
		},
		/**
		 * Merge: the survivor unions the absorbed block's contributor set.
		 * The merger itself lands via `stampChange` on the survivor.
		 */
		unionContributors: (doc: EngineDoc, intoId: BlockId, fromId: BlockId): void => {
			const from = recordOf(doc, fromId);
			if (from === null) return;
			const into = ensureRecord(doc, intoId, blockNodeOf(doc, intoId));
			for (const a of contributorsOfRecord(from)) addContributor(into, a);
		}
	};
};

export type BlockAttributionApi = ReturnType<typeof bindBlockAttribution>;
