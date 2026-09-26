/**
 * IndexedDB + BroadcastChannel provider for the vendored v14 engine — port of
 * `src/lib/localProvider.ts` (itself a fork of y-indexeddb
 * `IndexeddbPersistence` + y-websocket cross-tab sync, MIT © Kevin Jahns).
 *
 * Semantics preserved from the v13 provider:
 *
 * - `updates` object store (auto-increment keys) holds raw V1 update rows
 *   wrapped in a fresh ArrayBuffer (`encodeUpdateForStore`); `custom` holds
 *   provider metadata via `get`/`set`/`del`.
 * - `PREFERRED_TRIM_SIZE = 500`: past it, a debounced `storeState` appends a
 *   compacted `encodeStateAsUpdate` snapshot and deletes prior rows — but
 *   ONLY while every stored row was admitted: a refused hydration
 *   (`_hydrationRefused`) blocks compaction entirely for the instance, so
 *   bytes the snapshot never represented are never deleted (R2).
 * - BC room carries sync (0), awareness (1) and query-awareness (3)
 *   messages; connect publishes SyncStep1+SyncStep2+QueryAwareness+state.
 * - `synced`/`whenSynced`, `bcconnected`, `_ownsAwareness`, idempotent
 *   `destroy()`, `beforeunload` + doc-`destroy` cleanup.
 *
 * U07 differences (the version gate — see `protocols/envelope.ts`):
 *
 * - STORAGE: the database name is `edytor-v14:<name>` — a separate storage
 *   generation. Legacy v13 databases (`<name>`) are never opened here and
 *   their rows are never applied; a `generation` record in `custom` is
 *   written on creation and verified before any row is applied.
 * - TRANSPORT: every BC message is tagged with `PROTOCOL_VERSION` (14).
 *   Messages without it — e.g. a v13 peer writing to this room — are dropped
 *   before `readSyncMessage`; 'protocol-mismatch' is emitted instead.
 *
 * The engine module is injected (`bindIndexeddbProvider(Y)`) — `src/lib`
 * never runtime-imports the vendored `.js`.
 */
import * as idb from 'lib0-v14/indexeddb';
import * as promise from 'lib0-v14/promise';
import { ObservableV2 } from 'lib0-v14/observable';
import * as bc from 'lib0-v14/broadcastchannel';
import * as encoding from 'lib0-v14/encoding';
import { Awareness } from '../protocols/awareness.js';
import { bindSync, type SyncProtocol } from '../protocols/sync.js';
import {
	generationDbName,
	GENERATION_KEY,
	GENERATION_RECORD,
	GenerationMismatchError,
	type GenerationRecord
} from '../protocols/envelope.js';
// Gate vocabulary via the shared admission doorway (U8) — see admission.ts.
import { checkSchema, SchemaMismatchError, type SchemaProblem } from '../admission.js';
import {
	bindRoomProtocol,
	emitFailed,
	emitSchemaProblem as emitSchemaProblemAt,
	gateSchema as gateSchemaAt,
	type ProtocolMismatch,
	type RoomMessageHandler,
	type SchemaMismatchDetail
} from './room.js';
import type { EngineApi, YDoc } from '../engine-api.js';

export type { ProtocolMismatch, SchemaMismatchDetail };

const customStoreName = 'custom';
const updatesStoreName = 'updates';

export const PREFERRED_TRIM_SIZE = 500;

const encodeUpdateForStore = (update: Uint8Array): ArrayBuffer => {
	const storedUpdate = new Uint8Array(update.byteLength);
	storedUpdate.set(update);
	return storedUpdate.buffer;
};

const decodeStoredUpdate = (update: unknown): Uint8Array => {
	if (update instanceof ArrayBuffer) {
		return new Uint8Array(update);
	}
	if (update instanceof Uint8Array) {
		return update;
	}
	throw new TypeError('Stored Yjs update is not binary data');
};

const isGenerationRecord = (v: unknown): v is GenerationRecord =>
	typeof v === 'object' &&
	v !== null &&
	(v as GenerationRecord).engine === GENERATION_RECORD.engine &&
	(v as GenerationRecord).protocol === GENERATION_RECORD.protocol;

type IdbPersistenceLike = {
	db: IDBDatabase | null;
	name: string;
	doc: YDoc;
	_dbref: number;
	_dbsize: number;
	_destroyed: boolean;
	/** Last signaled schema-gate state key — dedupes 'schema-mismatch' emits. */
	_schemaGateKey?: string | null;
	/**
	 * Set when `fetchUpdates` refused stored rows (schema boundary — during
	 * hydration or a later `storeState` fetch). `synced` is suppressed and
	 * `whenSynced` rejects when set during hydration — the provider still
	 * joins the BC room so subsequent VALID peer updates keep flowing
	 * (recoverability). While set, `storeState` never compacts: the live
	 * doc does not represent every stored row, so no snapshot may subsume
	 * them (R2).
	 */
	_hydrationRefused?: SchemaProblem | null;
	/** The ObservableV2 emit channel (typed per-event on the real provider). */
	emit?: {
		(event: 'schema-mismatch', args: [SchemaMismatchDetail, unknown]): void;
		(event: 'message-error', args: [unknown, unknown]): void;
	};
};

export type IndexeddbPersistenceOptions = {
	awareness?: Awareness;
};

export type IndexeddbProvider = ReturnType<typeof bindIndexeddbProvider>;

/** Instance type of the bound provider class. */
export type IndexeddbPersistenceApi = InstanceType<IndexeddbProvider['IndexeddbPersistence']>;

/**
 * Bind the IndexedDB persistence provider to the vendored v14 engine module.
 */
export const bindIndexeddbProvider = (Y: EngineApi) => {
	const syncProtocol: SyncProtocol = bindSync(Y);

	/**
	 * The shared room protocol (S1) — dispatch, gated sync handling,
	 * awareness flow, BC subscriber + connect/disconnect sequences. This
	 * provider keeps only its transport edge: room traffic is BC-only, and
	 * `synced` is the local-hydration claim made in `connectBc` (suppressed
	 * by the `_hydrationRefused` latch), not a handshake verdict.
	 */
	const room = bindRoomProtocol<IndexeddbPersistence>(syncProtocol, {
		docName: (p) => p.name,
		roomChannel: (p) => p.dbName,
		broadcast: (p, buf) => p.broadcastMessage(buf)
	});

	const emitSchemaProblem = (p: IdbPersistenceLike, problem: SchemaProblem): void =>
		emitSchemaProblemAt(p, p.name, problem);

	/** Gate the provider's own doc; returns the detected problem (or null). */
	const gateSchema = (p: IdbPersistenceLike): SchemaProblem | null => gateSchemaAt(p, p.name);

	/**
	 * Apply all stored update rows (from `_dbref` on) to the doc. Verifies the
	 * generation record before touching the doc — rows from a foreign (v13 or
	 * otherwise-mismatched) generation are never applied.
	 */
	const fetchUpdates = (
		idbPersistence: IdbPersistenceLike,
		beforeApplyUpdatesCallback: (store: IDBObjectStore) => void = () => {},
		afterApplyUpdatesCallback: (store: IDBObjectStore) => void = () => {}
	) => {
		const db = idbPersistence.db as IDBDatabase;
		const [updatesStore, customStore] = idb.transact(db, [updatesStoreName, customStoreName]);
		return idb
			.get(customStore, GENERATION_KEY)
			.then((generation) => {
				if (generation === undefined) {
					// No generation record yet. Only an EMPTY updates store can be
					// stamped — a populated store without a record is a foreign DB
					// that happens to share our name; refuse to apply its rows.
					return idb.count(updatesStore).then((cnt) => {
						if (cnt > 0) {
							throw new GenerationMismatchError(idbPersistence.name, generation);
						}
						return idb.rtop(customStore.put({ ...GENERATION_RECORD }, GENERATION_KEY));
					});
				}
				if (!isGenerationRecord(generation)) {
					throw new GenerationMismatchError(idbPersistence.name, generation);
				}
				return undefined;
			})
			.then(() =>
				idb.getAll(updatesStore, idb.createIDBKeyRangeLowerBound(idbPersistence._dbref, false))
			)
			.then((updates) => {
				if (!idbPersistence._destroyed) {
					beforeApplyUpdatesCallback(updatesStore);
					// Application-schema boundary on hydration: stage the rows
					// onto a scratch doc seeded with the doc's current state.
					// Fast path — the merged result is clean, apply the whole
					// batch. Cold path — at least one row would move the doc
					// into a schema-problem state; re-stage row by row and apply
					// only the rows that keep the merged doc clean. Refused
					// rows stay in the store untouched (non-destructive) and
					// are reported via 'schema-mismatch'; hydration refusal
					// also suppresses `synced` and rejects `whenSynced` (the
					// doc does NOT reflect accepted stored state) while the
					// provider still joins the BC room for recoverability.
					const liveSnapshot = Y.encodeStateAsUpdate(idbPersistence.doc);
					const scratch = new Y.Doc();
					Y.applyUpdate(scratch, liveSnapshot);
					for (const update of updates) {
						Y.applyUpdate(scratch, decodeStoredUpdate(update));
					}
					const problem = checkSchema(scratch as unknown as import('../engine-api.js').EngineDoc);
					if (problem === null) {
						Y.transact(
							idbPersistence.doc,
							() => {
								updates.forEach((update) =>
									Y.applyUpdate(idbPersistence.doc, decodeStoredUpdate(update))
								);
							},
							idbPersistence,
							false
						);
					} else {
						let accepted = new Y.Doc();
						Y.applyUpdate(accepted, liveSnapshot);
						const acceptedRows: Uint8Array[] = [];
						let lastProblem = problem;
						for (const stored of updates) {
							const row = decodeStoredUpdate(stored);
							Y.applyUpdate(accepted, row);
							const rowProblem = checkSchema(
								accepted as unknown as import('../engine-api.js').EngineDoc
							);
							if (rowProblem === null) {
								acceptedRows.push(row);
							} else {
								// This row is the poison — never applied, never
								// persisted-as-accepted. Rebuild the staging doc
								// from the accepted prefix so following rows are
								// judged against clean state.
								lastProblem = rowProblem;
								const rebuilt = new Y.Doc();
								Y.applyUpdate(rebuilt, liveSnapshot);
								for (const r of acceptedRows) Y.applyUpdate(rebuilt, r);
								accepted = rebuilt;
							}
						}
						Y.transact(
							idbPersistence.doc,
							() => {
								acceptedRows.forEach((row) => Y.applyUpdate(idbPersistence.doc, row));
							},
							idbPersistence,
							false
						);
						emitSchemaProblem(idbPersistence, lastProblem);
						idbPersistence._hydrationRefused = lastProblem;
					}
					afterApplyUpdatesCallback(updatesStore);
				}
			})
			.then(() =>
				idb.getLastKey(updatesStore).then((lastKey) => {
					idbPersistence._dbref = (lastKey as number) + 1;
				})
			)
			.then(() =>
				idb.count(updatesStore).then((cnt) => {
					idbPersistence._dbsize = cnt;
				})
			)
			.then(() => updatesStore);
	};

	/**
	 * Persist the current state: fetch pending rows, then (when `forceStore`
	 * or past `PREFERRED_TRIM_SIZE`) append a compacted snapshot and delete
	 * the rows it subsumes.
	 *
	 * Refusal ↔ compaction contract (R2): the delete range `key < _dbref`
	 * may only remove rows whose content the replacement snapshot
	 * represents. A clean live schema is NOT proof of that — once
	 * `fetchUpdates` refused ANY stored row (`_hydrationRefused`), the live
	 * doc permanently lacks those bytes and no snapshot of it can subsume
	 * them. The smallest provably-safe policy is to skip compaction
	 * entirely for the instance: nothing is deleted, so every refused row
	 * and every row its updates depend on (regardless of row order — a
	 * dep may sit before or after the refused row) survives byte-for-byte.
	 * A selective scheme would have to prove each excluded row plus its
	 * dependency closure is preserved; blocking needs no such proof. The
	 * fetch still runs, so valid peer rows keep hydrating. `_dbref` still
	 * advances past refused rows (they are not re-staged per fetch); it is
	 * a fetch cursor only — never again a safe delete boundary.
	 *
	 * The returned promise settles only after the storage transaction
	 * commits (the upstream version dropped the write/delete chain —
	 * callers could not observe completion or failure). Request and
	 * transaction failures reject; the timed caller surfaces them on
	 * 'message-error'.
	 */
	const storeState = (idbPersistence: IdbPersistenceLike, forceStore = true) =>
		promise
			.resolve(null)
			// Deferred: a synchronous transact/fetch failure (closed or
			// missing handle) must surface as a rejection, not a throw.
			.then(() => fetchUpdates(idbPersistence))
			.then((updatesStore) => {
				// Schema boundary: never persist a snapshot of schema-problem
				// content (unversioned OR unsupported).
				if (gateSchema(idbPersistence) !== null) return undefined;
				// Refusal gate (R2): checked AFTER the fetch so rows refused
				// during THIS fetch are covered too.
				if (idbPersistence._hydrationRefused != null) return undefined;
				if (!forceStore && idbPersistence._dbsize < PREFERRED_TRIM_SIZE) {
					return undefined;
				}
				// Track transaction commit: listeners attach while the
				// transaction is still active — this callback runs inside
				// the last fetch request's success microtask, before the
				// transaction can finish.
				const tx = updatesStore.transaction;
				const transactionDone = promise.create((resolve, reject) => {
					tx.addEventListener('complete', () => resolve(undefined));
					tx.addEventListener('abort', () =>
						reject(
							new Error(`IndexedDB transaction aborted${tx.error ? `: ${String(tx.error)}` : ''}`)
						)
					);
				});
				return promise
					.all([
						idb
							.addAutoKey(
								updatesStore,
								encodeUpdateForStore(Y.encodeStateAsUpdate(idbPersistence.doc))
							)
							.then(() =>
								idb.del(updatesStore, idb.createIDBKeyRangeUpperBound(idbPersistence._dbref, true))
							)
							.then(() =>
								idb.count(updatesStore).then((cnt) => {
									idbPersistence._dbsize = cnt;
								})
							),
						transactionDone
					])
					.then(() => undefined);
			});

	/**
	 * Delete a v14 generation database by LOGICAL name (the `edytor-v14:`
	 * prefix is applied here). Never touches the legacy v13 database.
	 */
	const clearDocument = (name: string) => idb.deleteDB(generationDbName(name));

	class IndexeddbPersistence extends ObservableV2<{
		synced: (provider: IndexeddbPersistence) => void;
		'protocol-mismatch': (mismatch: ProtocolMismatch, provider: IndexeddbPersistence) => void;
		/** Fired when loading persisted state failed (e.g. a generation mismatch). `whenSynced` rejects. */
		'load-error': (error: unknown, provider: IndexeddbPersistence) => void;
		/**
		 * Fired when a received room message was tagged v14 but could not be
		 * decoded (truncated/corrupt frame or an unknown message type), or
		 * when a sync payload failed to apply. The message is dropped — it is
		 * never applied to the doc. Also mirrors schema-gate violations so
		 * the error channel alone observes every failure mode.
		 */
		'message-error': (error: unknown, provider: IndexeddbPersistence) => void;
		/**
		 * The document's replicated state violates the application-schema
		 * gate (`meta.v` absent with content present = quarantined;
		 * `meta.v` unsupported = synced but flagged). See SchemaMismatchDetail.
		 */
		'schema-mismatch': (detail: SchemaMismatchDetail, provider: IndexeddbPersistence) => void;
		/**
		 * Terminal sync failure (the D4 contract): the provider can never
		 * reach `synced` — destroyed before syncing, a persistence load
		 * failure, or refused hydration. Emitted at most once; never after
		 * `synced === true`.
		 */
		failed: (error: unknown, provider: IndexeddbPersistence) => void;
	}> {
		doc: YDoc;
		/** Logical document name (without the generation prefix). */
		name: string;
		/** Actual IndexedDB name — the v14 storage generation. */
		dbName: string;
		_dbref: number;
		_dbsize: number;
		_destroyed: boolean;
		db: IDBDatabase | null;
		synced: boolean;
		_db: Promise<IDBDatabase>;
		whenSynced: Promise<IndexeddbPersistence>;
		_rejectSynced: ((reason?: unknown) => void) | null = null;
		/** Set when loading persisted state failed (generation mismatch, …). */
		loadError: unknown = null;
		/**
		 * Set when hydration refused stored rows (schema boundary): `synced`
		 * is suppressed and `whenSynced` rejects — see `connectBc`.
		 */
		_hydrationRefused: SchemaProblem | null;
		/** Latch — 'failed' emits at most once (see `emitFailed` in room.ts). */
		_failedEmitted?: boolean;
		_storeTimeout: number;
		_storeTimeoutId: ReturnType<typeof setTimeout> | null;
		_storeUpdate: (update: Uint8Array, origin: unknown) => void;
		awareness: Awareness;
		bcconnected = false;
		_ownsAwareness: boolean;
		_bcSubscriber: (data: ArrayBuffer, origin: unknown) => void;
		_beforeUnloadHandler: () => void;
		_awarenessUpdateHandler: (
			updates: { added: number[]; updated: number[]; removed: number[] },
			origin: unknown
		) => void;

		constructor(name: string, doc: YDoc, options: IndexeddbPersistenceOptions = {}) {
			super();
			this.doc = doc;
			this.name = name;
			this.dbName = generationDbName(name);
			this._dbref = 0;
			this._dbsize = 0;
			this._destroyed = false;
			this._hydrationRefused = null;
			this.db = null;
			this.synced = false;
			this.awareness = options.awareness ?? new Awareness(doc);
			this._ownsAwareness = !options.awareness;

			this._db = idb.openDB(this.dbName, (db) =>
				idb.createStores(db, [['updates', { autoIncrement: true }], ['custom']])
			);

			this.whenSynced = promise.create((resolve, reject) => {
				this._rejectSynced = (reason?: unknown) =>
					reject(reason instanceof Error ? reason : new Error(String(reason)));
				this.on('synced', () => resolve(this));
			});
			// Consumers that never attach a catch still shouldn't crash the
			// process on a rejected whenSynced — the 'load-error' event is the
			// diagnostic channel.
			this.whenSynced.catch(() => {});

			this._bcSubscriber = room.bcSubscriber(this);
			this._awarenessUpdateHandler = room.awarenessUpdateHandler(this);

			// Fail closed: no sync, no BC room join, whenSynced rejects, and
			// the terminal 'failed' fires — the provider can never reach
			// synced once loading its persisted state has failed (D4).
			const onLoadError = (error: unknown) => {
				this.loadError = error;
				this._rejectSynced?.(error);
				this.emit('load-error', [error, this]);
				emitFailed(this, error);
			};

			this._db
				.then((db) => {
					if (this._destroyed) {
						db.close();
						return;
					}
					this.db = db;
					const beforeApplyUpdatesCallback = (updatesStore: IDBObjectStore) => {
						// Schema boundary: a doc already in a schema-problem state
						// (rogue/unsupported write before provider attach) is
						// quarantined — its state is never persisted to the
						// generation DB.
						if (gateSchema(this) === null) {
							return idb.addAutoKey(updatesStore, encodeUpdateForStore(Y.encodeStateAsUpdate(doc)));
						}
						return undefined;
					};
					const afterApplyUpdatesCallback = () => {
						if (this._destroyed) return;
						// Hydration refused stored rows → the doc does NOT reflect
						// accepted stored state: `synced` stays suppressed and
						// `whenSynced` rejects, but the provider still joins the
						// BC room — subsequent VALID peer updates keep flowing
						// (recoverability). `connectBc` itself enforces the latch
						// (D10) — the synced claim cannot be re-enabled by a
						// later disconnect/reconnect.
						this.connectBc();
						const refused = this._hydrationRefused;
						if (refused !== null) {
							const error = new SchemaMismatchError(this.name, refused);
							this._rejectSynced?.(error);
							emitFailed(this, error);
						}
					};
					// Deferred call: a synchronous fetchUpdates throw (closed
					// handle, transact failure) reaches the same .catch — every
					// load failure lands on 'load-error', not an unhandled
					// rejection inside this .then.
					promise
						.resolve(null)
						.then(() => fetchUpdates(this, beforeApplyUpdatesCallback, afterApplyUpdatesCallback))
						.catch(onLoadError);
				})
				// The OPEN itself can fail (D22) — without this catch the
				// rejection was unhandled: fetchUpdates never ran, whenSynced
				// never settled, and destroy() rejected on the same promise.
				.catch(onLoadError);

			this._storeTimeout = 1000;
			this._storeTimeoutId = null;

			this._storeUpdate = (update: Uint8Array, origin: unknown) => {
				// Schema boundary: an update leaving the doc in ANY
				// schema-problem state (unversioned OR unsupported) is
				// quarantined — never persisted, never broadcast.
				const gated = origin !== this && gateSchema(this) !== null;
				if (this.db && origin !== this && !gated) {
					try {
						const [updatesStore] = idb.transact(this.db, [updatesStoreName]);
						// Storage failures must surface — never an unobserved
						// rejection (the error channel observes every failure mode).
						idb.addAutoKey(updatesStore, encodeUpdateForStore(update)).catch((error) => {
							this.emit('message-error', [error, this]);
						});
						if (++this._dbsize >= PREFERRED_TRIM_SIZE) {
							if (this._storeTimeoutId !== null) {
								clearTimeout(this._storeTimeoutId);
							}
							this._storeTimeoutId = setTimeout(() => {
								this._storeTimeoutId = null;
								// The timed caller has no promise consumer — surface
								// compaction/storage failures on the error channel.
								storeState(this, false).catch((error) => this.emit('message-error', [error, this]));
							}, this._storeTimeout);
						}
					} catch (error) {
						// A synchronous transact failure (e.g. a handle closed
						// mid-session) still lands on the error channel rather
						// than propagating into the doc's update dispatch.
						this.emit('message-error', [error, this]);
					}
				}
				// Broadcast the update to other tabs
				if (origin !== this && !gated) {
					room.broadcastUpdate(this, update);
				}
			};

			doc.on('update', this._storeUpdate);
			this.awareness.on('update', this._awarenessUpdateHandler);
			this.destroy = this.destroy.bind(this);
			this._beforeUnloadHandler = () => this.destroy();
			doc.on('destroy', this.destroy);
			(globalThis as { addEventListener?: (t: string, f: () => void) => void }).addEventListener?.(
				'beforeunload',
				this._beforeUnloadHandler
			);
		}

		/**
		 * The room dispatch table — owned by `room.ts` (S1): gated
		 * `messageSync`, awareness publish/query. This provider adds no
		 * extra handlers (auth exists only on a server socket).
		 */
		messageHandlers: Record<number, RoomMessageHandler<IndexeddbPersistence>> =
			room.messageHandlers;

		/**
		 * Decode one room message — the dispatch lives in `room.ts`; kept as
		 * a public seam (the gate-2 probes call it directly).
		 */
		readMessage = (buf: Uint8Array, emitSynced: boolean): encoding.Encoder =>
			room.readMessage(this, buf, emitSynced);

		broadcastMessage(buf: Uint8Array) {
			if (this.bcconnected) {
				bc.publish(this.dbName, buf, this);
			}
		}

		/**
		 * Join the BC room. The `synced` claim consults the refusal latch
		 * INTERNALLY (D10): hydration-refused providers stay in the room
		 * for subsequent VALID peer updates, but a `disconnectBc()` +
		 * `connectBc()` cycle can no longer bypass `_hydrationRefused` and
		 * claim a `synced` that `whenSynced` still rejects. (Residual: no
		 * heal path — a doc cleaned by later peer updates keeps the latch +
		 * rejected `whenSynced` for this instance's lifetime.)
		 */
		connectBc() {
			room.connectBc(this);
			if (this._hydrationRefused === null) {
				this.synced = true;
				this.emit('synced', [this]);
			}
		}

		disconnectBc() {
			room.disconnectBc(this);
		}

		/**
		 * Destroy the provider (idempotent): unsubscribe BC, stop storing,
		 * close the DB. Does NOT remove stored data — `clearDocument` does.
		 */
		destroy(): Promise<void> {
			if (this._destroyed) {
				return Promise.resolve();
			}
			if (this._storeTimeoutId) {
				clearTimeout(this._storeTimeoutId);
			}
			(
				globalThis as { removeEventListener?: (t: string, f: () => void) => void }
			).removeEventListener?.('beforeunload', this._beforeUnloadHandler);
			this.doc.off('update', this._storeUpdate);
			this.doc.off('destroy', this.destroy);
			this.awareness.off('update', this._awarenessUpdateHandler);
			this._destroyed = true;
			// A provider destroyed before ever syncing can never reach
			// synced (D4) — settle the pending waiters: `whenSynced` rejects
			// (D22) and 'failed' fires (at most once, never once synced).
			if (!this.synced) {
				const error = new Error(
					`IndexeddbPersistence "${this.name}" was destroyed before it synced`
				);
				this._rejectSynced?.(error);
				emitFailed(this, error);
			}
			this.disconnectBc();
			if (this._ownsAwareness) {
				this.awareness.destroy();
			}
			return this._db.then(
				(db) => {
					db.close();
				},
				() => {
					// The open itself already failed — 'load-error' reported it;
					// there is no handle to close. destroy() still resolves.
				}
			);
		}

		get(key: IDBValidKey): Promise<unknown> {
			return this._db.then((db) => {
				const [custom] = idb.transact(db, [customStoreName], 'readonly');
				return idb.rtop(custom.get(key));
			});
		}

		set(key: IDBValidKey, value: unknown): Promise<IDBValidKey> {
			return this._db.then((db) => {
				const [custom] = idb.transact(db, [customStoreName]);
				return idb.rtop(custom.put(value, key));
			});
		}

		del(key: IDBValidKey): Promise<undefined> {
			return this._db.then((db) => {
				const [custom] = idb.transact(db, [customStoreName]);
				return idb.rtop(custom.delete(key));
			});
		}
	}

	return {
		IndexeddbPersistence,
		storeState,
		clearDocument,
		PREFERRED_TRIM_SIZE
	};
};
