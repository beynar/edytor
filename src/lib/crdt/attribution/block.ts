/**
 * U1 — compact, durable, per-BLOCK attribution on the existing owners.
 *
 * One block gets one small replicated record plus one block-node attr:
 *
 * - `b/<blockId>` → nested node on the `blockattr` root
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
 * Every block node carries the replicated nonce `n` of its incarnation
 * (O23); every `b/<id>` record is stamped (`i`) with the nonce it belongs
 * to, and `ensureRecord` swaps in a FRESH record whenever the live node's
 * nonce doesn't match — a late write to a dead incarnation lands on an
 * orphaned record the recreated block never reads. An undo/redo copy of the
 * node carries `n` with it, so it keeps its record on every replica (F7).
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
 * Known residual: `b/<id>` nodes are LWW map entries — concurrent FIRST
 * touches of a record-less block (foreign/migrated docs may lack records)
 * can lose one contributor add. Convergent; heals on the next touch.
 *
 * All writes are plain `setAttr`s performed by the owning facade op
 * INSIDE the operation's transaction — the metadata commits in the
 * same update as the content write. No observer-driven follow-up
 * transaction (the U6 `a/` per-content capture pipeline is untouched
 * and still coexists on the `attribution` root).
 */
import type { EngineApi, EngineDoc, EngineNode } from '../engine-api.js';
import { REGISTRY_KEY, type BlockId } from '../placement/model.js';
import { BLOCK_ATTR_ROOT, isNodeLike, LAST_CHANGED_ATTR, NONCE, REC_PREFIX } from '../schema.js';
import { attrItems, newNode as makeNode, onTransaction } from '../structs.js';

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

/**
 * One bounded-lineage checkpoint on a block's `brec` record — the block's
 * subtree JSON captured JUST BEFORE a displacing edit: an `l` handoff
 * (another actor's first write), a delete, or an undo/redo touching the
 * block. Entries live as list items on the record node itself, appended
 * and ring-trimmed to the document's configured depth inside the owning
 * op's transaction — they die with the record on reincarnation. Compact
 * wire keys keep the replicated payload small; the public surface
 * (`attribution.history`) re-expands them.
 */
export type LineageEntry = {
	/** The displaced owner — the `l` winner when captured (absent when unattributed). */
	a?: ActorId;
	/** The actor whose edit displaced the state (or whose undo/redo touched the block). */
	by: ActorId;
	/**
	 * Ring position at append — a display aid only. It can REPEAT (after a
	 * trim the position counter rewinds, and concurrent replicas assign
	 * the same position independently): never an entry id — list order is
	 * the truth.
	 */
	s: number;
	/** Wall-clock capture time — display only, never ordering. */
	t?: number;
	/** The displaced subtree snapshot (a `JSONBlock`). */
	j: unknown;
	/**
	 * The appending writer's configured ring depth. THE retention bound is
	 * the MAX of surviving entries' `d` — enforced identically by
	 * `appendLineage` (same-tx trim), `attachRingTrim` (receive-side
	 * repair), and `history()` (read view), so a shallow replica can never
	 * evict a deeper writer's surviving history on ANY path. Entries
	 * written before `d` existed leave it absent → the ring is exempt from
	 * trimming entirely (the writers' bound is unknowable — evict
	 * nothing).
	 */
	d?: number;
};

/**
 * The ring's retention bound — the deepest `lineage.depth` any surviving
 * entry's writer was configured with. `POSITIVE_INFINITY` when ANY entry
 * lacks `d` (pre-watermark data): without knowing every writer's bound,
 * no entry may be evicted on their behalf.
 */
export const lineageWatermarkOf = (entries: LineageEntry[]): number => {
	let wm = 0;
	for (const e of entries) {
		if (typeof e.d !== 'number' || !Number.isFinite(e.d)) return Number.POSITIVE_INFINITY;
		if (e.d > wm) wm = e.d;
	}
	return wm;
};

// `BLOCK_ATTR_ROOT`/`LAST_CHANGED_ATTR`/`REC_PREFIX` live in the shared
// `../schema.js` leaf (S10) — re-exported so existing import sites stay.
export { BLOCK_ATTR_ROOT, LAST_CHANGED_ATTR };

const REC_NODE = 'brec';
const CREATED_KEY = 'c';
const CONTRIBUTOR_PREFIX = 'k/';
/** Incarnation stamp on a `b/` record: the nonce `n` of the node it belongs to. */
const INCARNATION_KEY = 'i';

const recKey = (id: BlockId): string => `${REC_PREFIX}${id}`;

const recordOf = (doc: EngineDoc, id: BlockId): EngineNode | null => {
	const v = doc.get(BLOCK_ATTR_ROOT).getAttr(recKey(id));
	return isNodeLike(v) ? v : null;
};

const blockNodeOf = (doc: EngineDoc, id: BlockId): EngineNode | null => {
	const v = doc.get(REGISTRY_KEY).getAttr(id);
	return isNodeLike(v) ? v : null;
};

/**
 * Reads resolve whatever record node the `b/<id>` attr currently elects.
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
 * Read one block's lineage ring, oldest → newest — or `undefined` when
 * the block carries no record. Entries are the stored content values;
 * callers deep-copy before exposing them publicly.
 */
export const lineageOf = (doc: EngineDoc, id: BlockId): LineageEntry[] | undefined => {
	const rec = recordOf(doc, id);
	return rec === null ? undefined : (rec.toArray() as LineageEntry[]);
};

/**
 * Bound write helpers. `stampChange`/`stampCreated`/`unionContributors`
 * must be called INSIDE the operation's `doc.transact` — they perform
 * plain setAttrs so the metadata commits in the same update.
 */
export const bindBlockAttribution = (Y: EngineApi) => {
	const newNode = (name: string): EngineNode => makeNode(Y, name);

	/**
	 * Get-or-create the `b/<id>` record for `node`'s incarnation (its nonce).
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
		doc.get(BLOCK_ATTR_ROOT).setAttr(recKey(id), rec);
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
		 * A streamless block's nonce was re-minted `from` → `to` (its own text,
		 * R2): its record, when stamped for `from`, moves to `to`, so the
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
		},
		/**
		 * Append a displaced-state checkpoint to the block's ring and trim
		 * to the ring's watermark — `max` of surviving entries' `d`,
		 * including the fresh one. The caller captures `entry.j` BEFORE its
		 * model write (see `lineagePending` in `edytor-doc.ts`) and calls
		 * this only after the write proves out, so a refused write appends
		 * nothing. The watermark is THE retention policy — identical on
		 * append, on receive (`attachRingTrim`), and on read — so a shallow
		 * replica never evicts a deeper writer's surviving history, and the
		 * bound shrinks only once the deepest entries have themselves
		 * aged out. Concurrent appends under partition can still merge a
		 * ring past the watermark — neither side saw the other's entry —
		 * which the receive-side repair converges back.
		 */
		appendLineage: (
			doc: EngineDoc,
			id: BlockId,
			entry: Omit<LineageEntry, 's' | 'd'>,
			depth: number
		): void => {
			const rec = ensureRecord(doc, id);
			rec.insert(rec.length, [{ ...entry, s: rec.length, d: depth }]);
			const wm = lineageWatermarkOf(rec.toArray() as LineageEntry[]);
			if (rec.length > wm) rec.delete(0, rec.length - wm);
		},
		/**
		 * The block's lineage ring, oldest → newest — or `undefined` when
		 * the block has no record at all. Entries are the stored content
		 * values; the public surface copies them before handing them out.
		 */
		lineageOf,
		/**
		 * Attach the doc's shared ring-watermark repair — once per doc for
		 * the doc's lifetime (module-level dedupe). See the module-level comment
		 * below.
		 */
		attachRingTrim: (doc: EngineDoc): void => {
			if (ringTrimAttached.has(doc)) return;
			ringTrimAttached.set(doc, true);
			const trimToWatermark = (rec: EngineNode): void => {
				const wm = lineageWatermarkOf(rec.toArray() as LineageEntry[]);
				if (rec.length > wm) rec.delete(0, rec.length - wm);
			};
			onTransaction<unknown>(doc, 'afterTransaction', (transaction) => {
				try {
					const changed = (transaction as { changed?: Map<unknown, Set<string | null>> })?.changed;
					if (changed === undefined) return;
					let over: EngineNode[] | undefined;
					for (const type of changed.keys()) {
						const rec = type as EngineNode;
						if (
							rec?.name === REC_NODE &&
							rec.length > lineageWatermarkOf(rec.toArray() as LineageEntry[])
						) {
							(over ??= []).push(rec);
						}
					}
					if (over === undefined) return;
					// A follow-up transaction in the same cleanup sweep — the
					// trim deletes exactly the items the next append would
					// evict, so concurrent trims (each replica runs this on
					// the same merged state) delete the SAME items and stay
					// convergent. The watermark never goes below a surviving
					// entry's own configured depth.
					doc.transact(() => {
						for (const rec of over!) trimToWatermark(rec);
					}, LINEAGE_TRIM_ORIGIN);
				} catch (err) {
					// A failure here must never propagate — throwing inside
					// `afterTransaction` would break the host transaction's
					// cleanup sweep. An untrimmed ring still converges.
					console.error('[edytor-doc] lineage ring trim failed; leaving over-cap state', err);
				}
			});
			// Install-time sweep: a doc that arrived over-cap BEFORE this
			// listener existed — `loadDocument`/`attachDocument` integrate
			// the payload before the facade composes — never fires the
			// hook above for that data. One O(records) pass converges it.
			try {
				const root = doc.get(BLOCK_ATTR_ROOT);
				let over: EngineNode[] | undefined;
				for (const key of root.attrKeys()) {
					if (!key.startsWith(REC_PREFIX)) continue;
					const rec = root.getAttr(key);
					if (
						isNodeLike(rec) &&
						rec.name === REC_NODE &&
						rec.length > lineageWatermarkOf(rec.toArray() as LineageEntry[])
					) {
						(over ??= []).push(rec);
					}
				}
				if (over !== undefined) {
					doc.transact(() => {
						for (const rec of over!) trimToWatermark(rec);
					}, LINEAGE_TRIM_ORIGIN);
				}
			} catch (err) {
				console.error('[edytor-doc] lineage ring sweep failed; leaving over-cap state', err);
			}
		}
	};
};

/**
 * Per-doc attach table for the shared ring-trim listener — module level
 * (not binding- or facade-scoped) so the listener is installed ONCE per
 * doc across every binding's facade `create()`, and never detached: a
 * ring pushed over its watermark by concurrent appends is converged even
 * after the last facade disposes. The `WeakMap` entry and the doc-held
 * listener die with the doc — no leak.
 */
const ringTrimAttached = new WeakMap<EngineDoc, true>();

/**
 * Origin of the ring-trim's delete writes — an origin no UndoManager
 * tracks, so trims never enter an undo stack and never recurse (the trim
 * only deletes ring items: the follow-up `afterTransaction` pass finds
 * the ring at exactly the watermark and stops).
 */
const LINEAGE_TRIM_ORIGIN = Symbol('edytor.lineage-trim');

export type BlockAttributionApi = ReturnType<typeof bindBlockAttribution>;
