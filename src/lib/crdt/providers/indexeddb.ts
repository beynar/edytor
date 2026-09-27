/**
 * IndexedDB + BroadcastChannel provider for the vendored v14 engine — port of
 * `src/lib/localProvider.ts` (itself a fork of y-indexeddb
 * `IndexeddbPersistence` + y-websocket cross-tab sync, MIT © Kevin Jahns).
 *
 * Semantics preserved from the v13 provider:
 *
 * - `updates` object store (auto-increment keys) holds raw V1 update rows
 *   wrapped in a fresh ArrayBuffer (`container.ts`); `custom` holds the
 *   generation record.
 * - `PREFERRED_TRIM_SIZE = 500`: past it, a debounced `storeState` appends a
 *   compacted `encodeStateAsUpdate` snapshot and deletes prior rows. Every
 *   row of a proven generation is applied, so the snapshot represents them
 *   all; only a read-only document (outbound quarantine) never compacts.
 * - BC room carries sync (0), awareness (1) and query-awareness (3)
 *   messages; joining says hello (Step1 + presence) and the room's join
 *   rule exchanges what each side lacks (`room.ts`).
 * - `synced`/`whenSynced` (the room lifecycle: `synced` is the lifetime
 *   hydration claim), `bcconnected`, `_ownsAwareness`, idempotent
 *   `destroy()`, departure (`beforeunload`) + doc-`destroy` cleanup.
 *
 * The generation gate (R13, D-2 — see `protocols/envelope.ts`):
 *
 * - STORAGE: the database name is `edytor-v14:<name>`; legacy v13
 *   databases (`<name>`) are never opened here. A `generation` record
 *   (engine, protocol, schema) in `custom` is written on creation and
 *   verified before any row is applied — a container of another
 *   generation fails the load; nothing inside a row is inspected.
 * - TRANSPORT: every BC message carries this build's generation word;
 *   anything else is dropped before decode ('protocol-mismatch').
 * - A read-only document (a foreign stamp got in) is neither persisted,
 *   compacted nor broadcast (outbound quarantine).
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
import { generationDbName } from '../protocols/envelope.js';
import {
	CUSTOM as customStoreName,
	decodeRow,
	encodeRow,
	openContainer,
	UPDATES as updatesStoreName,
	verifyOrStamp
} from './container.js';
import {
	beginDestroy,
	bindRoomProtocol,
	emitFailed,
	initLifecycle,
	markSynced,
	quarantined,
	type LifecycleHost,
	type ProtocolMismatch,
	type RoomMessageHandler,
	type SchemaMismatchDetail
} from './room.js';
import type { EngineApi, YDoc } from '../engine-api.js';

export type { ProtocolMismatch, SchemaMismatchDetail };

export const PREFERRED_TRIM_SIZE = 500;

type IdbPersistenceLike = {
	db: IDBDatabase | null;
	name: string;
	doc: YDoc;
	_dbref: number;
	_dbsize: number;
	_destroyed: boolean;
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
	 * The shared room protocol (S1) — dispatch, the join rule, awareness
	 * flow, BC subscriber + join/leave, the lifecycle. This provider keeps
	 * only its transport edge: room traffic is BC-only, and `synced` is the
	 * local-hydration claim, not a handshake verdict.
	 */
	const room = bindRoomProtocol<IndexeddbPersistence>(syncProtocol, {
		docName: (p) => p.name,
		roomChannel: (p) => p.dbName,
		broadcast: (p, buf) => p.broadcastMessage(buf)
	});

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
		return verifyOrStamp(idbPersistence.name, updatesStore, customStore)
			.then(() =>
				idb.getAll(updatesStore, idb.createIDBKeyRangeLowerBound(idbPersistence._dbref, false))
			)
			.then((updates) => {
				if (!idbPersistence._destroyed) {
					beforeApplyUpdatesCallback(updatesStore);
					Y.transact(
						idbPersistence.doc,
						() => {
							updates.forEach((update) => Y.applyUpdate(idbPersistence.doc, decodeRow(update)));
						},
						idbPersistence,
						false
					);
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
	 * Every applied row is represented in the snapshot, so deleting
	 * `key < _dbref` is always safe; a read-only document (outbound
	 * quarantine) never compacts.
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
				if (quarantined(idbPersistence.doc)) return undefined;
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
							.addAutoKey(updatesStore, encodeRow(Y.encodeStateAsUpdate(idbPersistence.doc)))
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
		 * never applied to the doc. Also mirrors inbound refusals so the
		 * error channel alone observes every failure mode.
		 */
		'message-error': (error: unknown, provider: IndexeddbPersistence) => void;
		/** A received update wrote a foreign schema stamp and was refused (SchemaMismatchDetail). */
		'schema-mismatch': (detail: SchemaMismatchDetail, provider: IndexeddbPersistence) => void;
		/**
		 * Terminal sync failure (the D4 contract): the provider never
		 * synced — destroyed before hydrating or a persistence load
		 * failure. Emitted at most once; never once `synced`.
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
		db: IDBDatabase | null;
		_db: Promise<IDBDatabase>;
		// The room lifecycle (O74) — installed by `initLifecycle`.
		_destroyed!: boolean;
		hasSynced!: boolean;
		whenSynced!: Promise<IndexeddbPersistence>;
		_failedEmitted?: boolean;
		_settleSynced!: LifecycleHost['_settleSynced'];
		_leave!: () => void;
		/** Set when loading persisted state failed (generation mismatch, …). */
		loadError: unknown = null;
		_storeTimeout: number;
		_storeTimeoutId: ReturnType<typeof setTimeout> | null;
		_storeUpdate: (update: Uint8Array, origin: unknown) => void;
		awareness: Awareness;
		bcconnected = false;
		_ownsAwareness: boolean;
		_bcSubscriber: (data: ArrayBuffer, origin: unknown) => void;
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
			this.db = null;
			this.awareness = options.awareness ?? new Awareness(doc);
			this._ownsAwareness = !options.awareness;

			this._db = openContainer(this.dbName);

			this.destroy = this.destroy.bind(this);
			initLifecycle(this, this.destroy);

			this._bcSubscriber = room.bcSubscriber(this);
			this._awarenessUpdateHandler = room.awarenessUpdateHandler(this);

			// Fail closed: no sync, no BC room join, whenSynced rejects, and
			// the terminal 'failed' fires — the provider can never reach
			// synced once loading its persisted state has failed (D4).
			const onLoadError = (error: unknown) => {
				this.loadError = error;
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
					// A read-only doc's pre-hydration state is never persisted.
					const beforeApplyUpdatesCallback = (updatesStore: IDBObjectStore) => {
						if (!quarantined(doc)) {
							idb.addAutoKey(updatesStore, encodeRow(Y.encodeStateAsUpdate(doc)));
						}
					};
					// Hydrated: join the room and claim `synced` (lifetime).
					const afterApplyUpdatesCallback = () => {
						if (this._destroyed) return;
						this.connectBc();
						if (markSynced(this)) this.emit('synced', [this]);
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
				// Outbound quarantine: a read-only doc is never persisted
				// (`broadcastUpdate` applies the same rule to the room).
				if (origin === this || quarantined(doc)) return;
				if (this.db) {
					try {
						const [updatesStore] = idb.transact(this.db, [updatesStoreName]);
						// Storage failures must surface — never an unobserved
						// rejection (the error channel observes every failure mode).
						idb.addAutoKey(updatesStore, encodeRow(update)).catch((error) => {
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
				room.broadcastUpdate(this, update);
			};

			doc.on('update', this._storeUpdate);
			this.awareness.on('update', this._awarenessUpdateHandler);
			doc.on('destroy', this.destroy);
		}

		/** The lifetime hydration claim. */
		get synced(): boolean {
			return this.hasSynced;
		}

		/**
		 * The room dispatch table — owned by `room.ts` (S1):
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

		/** Join the BC room (after hydration; again after `disconnectBc`). */
		connectBc() {
			room.connectBc(this);
		}

		disconnectBc() {
			room.disconnectBc(this);
		}

		/**
		 * Destroy the provider (idempotent): unsubscribe BC, stop storing,
		 * close the DB. Does NOT remove stored data — `clearDocument` does.
		 */
		destroy(): Promise<void> {
			// The destroy guard — a provider that never synced settles its
			// waiters: `whenSynced` rejects (D22) and 'failed' fires once.
			if (!beginDestroy(this, `IndexeddbPersistence "${this.name}"`)) {
				return Promise.resolve();
			}
			if (this._storeTimeoutId) {
				clearTimeout(this._storeTimeoutId);
			}
			this.doc.off('update', this._storeUpdate);
			this.doc.off('destroy', this.destroy);
			this.awareness.off('update', this._awarenessUpdateHandler);
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
	}

	return {
		IndexeddbPersistence,
		storeState,
		clearDocument,
		PREFERRED_TRIM_SIZE
	};
};
