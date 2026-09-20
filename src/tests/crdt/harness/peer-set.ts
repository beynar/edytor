/**
 * Independent-replica harness for the vendored Yjs v14 engine (U02).
 *
 * Properties that make this a *replica* harness rather than a shared-doc test:
 *
 * - `createPeerSet` builds ONE seed document, serializes it with
 *   `encodeStateAsUpdate`, and creates every peer by APPLYING that update to a
 *   fresh `Y.Doc`. Peers are never initialized independently from JSON, so all
 *   replicas share CRDT identities for seeded content.
 * - Each peer owns a real `Y.Doc`; messages flow through explicit per-edge
 *   outbox queues so tests control delivery order, duplication, batching,
 *   partitions and sync strategy exactly.
 * - `clientID`s are deterministic: the vendored engine assigns a random
 *   `doc.clientID` in the `Doc` constructor (there is no constructor option —
 *   verified in `src/utils/Doc.js`), so the harness overwrites `doc.clientID`
 *   immediately after construction and before any local operation, the same
 *   technique upstream's own `testHelper` uses (`y.clientID = i`).
 *
 *   Determinism contract (gate-1 fix): every identity a run can mint is a
 *   pure function of `(rngSeed, peerIndex[, reloadGeneration])`:
 *
 *   - the SEED doc gets the fixed clientID {@link SEED_DOC_CLIENT_ID} (it is
 *     a writer — `modelSpecSeed` allocates ranks — so its id lands in rank
 *     tiebreaks and item ids inside the seed update);
 *   - peer `i` gets `firstClientId + i`, where `firstClientId` defaults to
 *     `1 + (rngSeed mod 2^20)`; reloads draw from the same counter;
 *   - every doc's `rand` stream (in-gap rank randomness, `EngineDoc.rand`)
 *     is `mulberry32` keyed by `(rngSeed, peerIndex, generation)` — the seed
 *     doc uses peerIndex −1 / generation 0, and a reload bumps the
 *     generation, so a committed corpus seed replays byte-identically.
 * - Transaction origins distinguish local vs remote application: local ops run
 *   inside `peer.transact(fn, origin)` (default `peer.localOrigin`); remote
 *   update application uses `applyUpdate(doc, update, remoteOrigin(from))`
 *   where `remoteOrigin` carries the {@link REMOTE} marker key. A peer's
 *   `update` listener enqueues only non-remote updates into peer outboxes.
 * - Reload replaces a peer's `Doc` with a fresh one built from its persisted
 *   snapshot or its full update log, then assigns a fresh deterministic
 *   clientID (persistence does not restore clientIDs — a reloaded doc is a new
 *   writer, matching real y-indexeddb semantics) and the next-generation
 *   deterministic rand stream.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { mulberry32 } from './rng.js';

/**
 * Fixed clientID of the ephemeral seed document. Well above the peer range
 * (`firstClientId` defaults under 2^20) so a seed write can never alias a
 * peer writer in a rank tiebreak.
 */
export const SEED_DOC_CLIENT_ID = 0x5eed0000;

/** Marker key on transaction origins used for remote-applied updates. */
export const REMOTE = 'crdt-harness/remote';

/** Build the transaction origin used when applying a remote peer's update. */
export const remoteOrigin = (from: string) => ({ [REMOTE]: true, from });

/** True iff the transaction origin marks a remote-applied update. */
export const isRemoteOrigin = (origin: unknown): boolean =>
	origin != null && typeof origin === 'object' && (origin as any)[REMOTE] === true;

export type PeerName = string;

/**
 * A directed link from one peer to another. `queue` holds encoded updates in
 * FIFO order; `up=false` models a partition — queued messages are retained but
 * never flushed until the link heals (store-and-forward). `dropQueued` models
 * real message loss and forces later state-vector resync.
 */
type Edge = { queue: Uint8Array[]; up: boolean };

const edgeKey = (from: PeerName, to: PeerName) => `${from}>${to}`;

export class Peer {
	readonly name: PeerName;
	/** Position in `set.peers` — keys the deterministic rand stream. */
	readonly index: number;
	doc: InstanceType<typeof Y.Doc>;
	/** Stable object used as the default transaction origin for local ops. */
	readonly localOrigin: { peer: PeerName };
	/** Every update ever applied to this doc, local and remote, in apply order. */
	readonly updateLog: Uint8Array[] = [];
	/** Last snapshot produced by `persist()` (or the seed at construction). */
	persisted: Uint8Array;
	undoManager: InstanceType<typeof Y.UndoManager> | null = null;
	/** Reload count — the rand-stream generation. */
	private randGen = 0;
	private readonly set: PeerSet;

	constructor(set: PeerSet, name: PeerName, doc: InstanceType<typeof Y.Doc>, index: number) {
		this.set = set;
		this.name = name;
		this.index = index;
		this.localOrigin = { peer: name };
		this.#attach(doc);
	}

	#attach(doc: InstanceType<typeof Y.Doc>) {
		this.doc = doc;
		this.persisted = Y.encodeStateAsUpdate(doc);
		doc.on('update', (update: Uint8Array, origin: unknown) => {
			this.updateLog.push(update);
			// Remote-applied updates never re-enter the network: they already
			// arrived from a peer queue / sync exchange.
			if (!isRemoteOrigin(origin)) {
				for (const other of this.set.peers) {
					if (other !== this) this.set.enqueue(this.name, other.name, update);
				}
			}
		});
	}

	/**
	 * Run a local transaction tagged with an origin (default `localOrigin`) so
	 * tests can distinguish local vs remote-applied transactions and scope
	 * UndoManager tracking.
	 */
	transact<T>(fn: () => T, origin: unknown = this.localOrigin): T {
		return this.doc.transact(fn, origin);
	}

	/** Current encoded state vector (what this peer has seen). */
	stateVector(): Uint8Array {
		return Y.encodeStateVector(this.doc);
	}

	/** Persist the current state (e.g. an IndexedDB snapshot). */
	persist(): void {
		this.persisted = Y.encodeStateAsUpdate(this.doc);
	}

	/**
	 * Replace this peer's document with a fresh `Y.Doc` reconstructed from the
	 * persisted snapshot (`'snapshot'`, default) or by replaying the full update
	 * log (`'log'`). A fresh deterministic clientID is assigned afterwards —
	 * the reloaded doc is a new writer. Undo history does not survive reload.
	 */
	reload(mode: 'snapshot' | 'log' = 'snapshot'): void {
		const doc = new Y.Doc({ guid: this.set.guid });
		// Copy before clearing/reattaching (#attach would overwrite persisted
		// with the empty doc's state).
		const sourceLog = this.updateLog.slice();
		const snapshot = this.persisted;
		this.updateLog.length = 0;
		this.undoManager = null;
		this.#attach(doc);
		if (mode === 'snapshot') {
			Y.applyUpdate(doc, snapshot, remoteOrigin('persist'));
		} else {
			// Apply in recorded order; dependencies are resolved by the engine.
			for (const update of sourceLog) {
				Y.applyUpdate(doc, update, remoteOrigin('persist'));
			}
		}
		this.persisted = Y.encodeStateAsUpdate(doc);
		doc.clientID = this.set.nextClientId();
		// A reloaded doc is a new writer — fresh deterministic rand stream too
		// (same contract as construction: keyed by (rngSeed, index, generation)).
		doc.rand = this.set.randFor(this.index, ++this.randGen);
	}

	/**
	 * Enable a local UndoManager tracking only this peer's local origin.
	 * `opts.scope` narrows the scope to a subtree (e.g. the model registry
	 * node); the doc-wide default matches upstream behavior.
	 */
	enableUndo(
		opts: Record<string, unknown> & { scope?: unknown } = {}
	): InstanceType<typeof Y.UndoManager> {
		const { scope, ...rest } = opts;
		this.undoManager = new Y.UndoManager((scope ?? this.doc) as never, {
			trackedOrigins: new Set([this.localOrigin]),
			...rest
		});
		return this.undoManager;
	}
}

export type SeedUpdate = Uint8Array | ((doc: InstanceType<typeof Y.Doc>) => void);

export class PeerSet {
	readonly guid: string;
	readonly peers: Peer[] = [];
	private readonly edges = new Map<string, Edge>();
	private clientIdCounter: number;
	/** Keys every deterministic rand stream vended by {@link randFor}. */
	readonly rngSeed: number;

	private constructor(guid: string, firstClientId: number, rngSeed: number) {
		this.guid = guid;
		this.clientIdCounter = firstClientId;
		this.rngSeed = rngSeed;
	}

	nextClientId(): number {
		return this.clientIdCounter++;
	}

	/**
	 * The deterministic rand stream for one doc — `mulberry32` keyed by
	 * `(rngSeed, peerIndex, generation)`. peerIndex `-1` is the seed doc;
	 * `generation` increments per reload so a reloaded writer does not
	 * replay the exact digit sequence of its previous incarnation.
	 */
	randFor(peerIndex: number, generation: number): () => number {
		const h =
			(Math.imul((this.rngSeed ^ 0x5eed) >>> 0, 0x9e3779b1) ^
				Math.imul((peerIndex + 2) >>> 0, 0x85ebca6b) ^
				Math.imul((generation + 1) >>> 0, 0xc2b2ae35)) >>>
			0;
		return mulberry32(h);
	}

	get A(): Peer {
		return this.peers[0];
	}
	get B(): Peer {
		return this.peers[1];
	}
	get C(): Peer {
		return this.peers[2];
	}

	peer(name: PeerName | number): Peer {
		if (typeof name === 'number') return this.peers[name];
		const found = this.peers.find((p) => p.name === name);
		if (!found) throw new Error(`unknown peer ${name}`);
		return found;
	}

	/**
	 * Queue a locally generated update for a directed edge. Called by Peer
	 * update listeners; also usable directly for handcrafted message flow.
	 */
	enqueue(from: PeerName, to: PeerName, update: Uint8Array): void {
		this.edge(from, to).queue.push(update);
	}

	private edge(from: PeerName, to: PeerName): Edge {
		const key = edgeKey(from, to);
		let e = this.edges.get(key);
		if (!e) {
			e = { queue: [], up: true };
			this.edges.set(key, e);
		}
		return e;
	}

	/** Pending (queued, undelivered) update count on edge from→to. */
	pending(from: PeerName, to: PeerName): number {
		return this.edge(from, to).queue.length;
	}

	/** Total pending updates across all edges. */
	get pendingCount(): number {
		let n = 0;
		this.edges.forEach((e) => (n += e.queue.length));
		return n;
	}

	/** Take two peers' links down in both directions (queue retains messages). */
	partition(a: PeerName, b: PeerName): void {
		this.edge(a, b).up = false;
		this.edge(b, a).up = false;
	}

	/** Restore both directions of a link; queued messages become deliverable. */
	heal(a: PeerName, b: PeerName): void {
		this.edge(a, b).up = true;
		this.edge(b, a).up = true;
	}

	/** Cut all of a peer's links (offline). `healPeer` reverses it. */
	isolate(name: PeerName): void {
		for (const other of this.peers) {
			if (other.name !== name) this.partition(name, other.name);
		}
	}

	healPeer(name: PeerName): void {
		for (const other of this.peers) {
			if (other.name !== name) this.heal(name, other.name);
		}
	}

	/** Discard queued messages on an edge — real message loss. */
	dropQueued(from: PeerName, to: PeerName): number {
		const e = this.edge(from, to);
		const n = e.queue.length;
		e.queue = [];
		return n;
	}

	/**
	 * Flush queued updates from→to while the edge is up.
	 * `reverse` delivers newest-first; `times` re-applies each update
	 * (duplicate delivery must be idempotent); `batch` merges the queue into a
	 * single update via `mergeUpdates` before applying.
	 * Returns the number of queue entries applied (0 when the link is down).
	 */
	deliver(
		from: PeerName,
		to: PeerName,
		opts: { reverse?: boolean; times?: number; batch?: boolean } = {}
	): number {
		const e = this.edge(from, to);
		if (!e.up || e.queue.length === 0) return 0;
		const queued = e.queue;
		e.queue = [];
		const target = this.peer(to);
		const origin = remoteOrigin(from);
		if (opts.batch) {
			const merged = Y.mergeUpdates(queued);
			for (let i = 0; i < (opts.times ?? 1); i++) {
				Y.applyUpdate(target.doc, merged, origin);
			}
			return queued.length;
		}
		const ordered = opts.reverse ? queued.slice().reverse() : queued;
		for (const update of ordered) {
			for (let i = 0; i < (opts.times ?? 1); i++) {
				Y.applyUpdate(target.doc, update, origin);
			}
		}
		return ordered.length;
	}

	/** Drain every up edge once. Remote application never re-enqueues. */
	deliverAll(): number {
		let applied = 0;
		for (const [key, e] of this.edges) {
			if (!e.up || e.queue.length === 0) continue;
			const [from, to] = key.split('>');
			applied += this.deliver(from, to);
		}
		return applied;
	}

	/**
	 * Incremental sync between two peers: exchange state vectors and ship only
	 * what the other side is missing (sync step 1/2 without a protocol). Does
	 * not touch queued outbox messages — they remain deliverable.
	 */
	syncPeer(a: PeerName, b: PeerName): void {
		const pa = this.peer(a);
		const pb = this.peer(b);
		Y.applyUpdate(
			pb.doc,
			Y.encodeStateAsUpdate(pa.doc, Y.encodeStateVector(pb.doc)),
			remoteOrigin(a)
		);
		Y.applyUpdate(
			pa.doc,
			Y.encodeStateAsUpdate(pb.doc, Y.encodeStateVector(pa.doc)),
			remoteOrigin(b)
		);
	}

	/** Complete-state sync: both peers exchange their entire encoded state. */
	syncPeerFull(a: PeerName, b: PeerName): void {
		const pa = this.peer(a);
		const pb = this.peer(b);
		Y.applyUpdate(pb.doc, Y.encodeStateAsUpdate(pa.doc), remoteOrigin(a));
		Y.applyUpdate(pa.doc, Y.encodeStateAsUpdate(pb.doc), remoteOrigin(b));
	}

	/** Sync every ordered pair (`'incremental'` default, or `'full'`). */
	syncAll(mode: 'incremental' | 'full' = 'incremental'): void {
		for (const a of this.peers) {
			for (const b of this.peers) {
				if (a === b) continue;
				if (mode === 'incremental') this.syncPeer(a.name, b.name);
				else this.syncPeerFull(a.name, b.name);
			}
		}
	}
}

export type PeerSetOpts = {
	/** doc guid shared by all replicas (and preserved across reloads). */
	guid?: string;
	/**
	 * First assigned clientID; peers get `firstClientId + i`, reloads
	 * continue the counter. Defaults to `1 + (rngSeed mod 2^20)` so the
	 * corpus's per-seed id space varies while staying replay-deterministic.
	 */
	firstClientId?: number;
	/**
	 * Seed for the per-doc rand streams (`EngineDoc.rand` — rank in-gap
	 * picks) and the default `firstClientId` base. `0` when unset.
	 * Determinism contract: `(rngSeed, peerIndex[, generation])` fixes every
	 * identity a run can mint.
	 */
	rngSeed?: number;
	/** peer names, defaults to A,B,C,… */
	names?: string[];
};

/**
 * Build `n` independent replicas of ONE seed document.
 *
 * `seed` is either an encoded update or a function that populates a fresh
 * `Y.Doc`; either way exactly one seed doc is built, serialized via
 * `encodeStateAsUpdate`, and every peer is created by applying that single
 * update — never by independently re-running JSON initialization.
 */
export const createPeerSet = (n: number, seed?: SeedUpdate, opts: PeerSetOpts = {}): PeerSet => {
	const guid = opts.guid ?? 'peer-set';
	const rngSeed = opts.rngSeed ?? 0;
	const set = new PeerSet(guid, opts.firstClientId ?? 1 + (rngSeed % 2 ** 20), rngSeed);
	let seedUpdate: Uint8Array;
	if (seed instanceof Uint8Array) {
		seedUpdate = seed;
	} else {
		const seedDoc = new Y.Doc({ guid });
		// The seed doc writes too (modelSpecSeed allocates ranks through
		// insertBlock) — pin its identity or the seed bytes, hence every
		// peer's initial state, would differ run to run.
		seedDoc.clientID = SEED_DOC_CLIENT_ID;
		seedDoc.rand = set.randFor(-1, 0);
		seed?.(seedDoc);
		seedUpdate = Y.encodeStateAsUpdate(seedDoc);
	}
	const names = opts.names ?? Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i));
	for (let i = 0; i < n; i++) {
		const doc = new Y.Doc({ guid });
		Y.applyUpdate(doc, seedUpdate, remoteOrigin('seed'));
		doc.clientID = set.nextClientId();
		doc.rand = set.randFor(i, 0);
		const peer = new Peer(set, names[i], doc, i);
		// The seed was applied before the listener attached; record it so the
		// update log is a complete history (entry 0 = seed) for 'log' reloads.
		peer.updateLog.push(seedUpdate);
		set.peers.push(peer);
	}
	return set;
};

/** Two-peer convenience wrapper. */
export const createPeerPair = (seed?: SeedUpdate, opts: PeerSetOpts = {}) =>
	createPeerSet(2, seed, opts);

/** Three-peer convenience wrapper. */
export const createPeerTriple = (seed?: SeedUpdate, opts: PeerSetOpts = {}) =>
	createPeerSet(3, seed, opts);
