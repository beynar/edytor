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
 *   `destroy()`, departure (`pagehide`) + doc-`destroy` cleanup.
 *
 * The generation gate (see `protocols/envelope.ts`):
 *
 * - STORAGE: the database name is `edytor-v14-g5:<name>` (`edytor-v14:<name>` up to schema generation 4); legacy v13
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
import * as bc from 'lib0-v14/broadcastchannel';
import * as encoding from 'lib0-v14/encoding';
import { Awareness } from '../protocols/awareness.js';
import { IsolatedObservable } from '../protocols/observable.js';
import { bindSync, type SyncProtocol } from '../protocols/sync.js';
import {
	GENERATION_KEY,
	generationDbName,
	PREVIOUS_GENERATION_PREFIX,
	STORED_GENERATION_RECORD
} from '../protocols/envelope.js';
import { bindGenerations } from '../migration/generation.js';
import {
	CUSTOM as customStoreName,
	encodeRow,
	openContainer,
	openIfExists,
	readRow,
	snapshotRow,
	type SnapshotRow,
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
	/** Stay off the BroadcastChannel room (no cross-tab sync): storage only. */
	disableBc?: boolean;
	/**
	 * Convert the generation-4 store of the same name (`edytor-v14:<name>`)
	 * into this one when this one is empty (the generation cutover): its
	 * visible document is read as JSON and seeded as this generation's.
	 * For a document stored only here; a document a room keeps takes its
	 * state from the room instead (two replicas seeding different
	 * conversions of one document would collide). Default `false`;
	 * `createIndexeddbSync` sets it.
	 */
	convertPrevious?: boolean;
};

export type IndexeddbProvider = ReturnType<typeof bindIndexeddbProvider>;

/** Instance type of the bound provider class. */
export type IndexeddbPersistenceApi = InstanceType<IndexeddbProvider['IndexeddbPersistence']>;

/**
 * Bind the IndexedDB persistence provider to the vendored v14 engine module.
 */
export const bindIndexeddbProvider = (Y: EngineApi) => {
	const syncProtocol: SyncProtocol = bindSync(Y);
	const generations = bindGenerations(Y);

	/**
	 * The generation cutover of a local store (`IndexeddbPersistenceOptions.convertPrevious`):
	 * when `db` is empty and the generation-4 store of `name` exists, its
	 * visible document is read as JSON and this generation's seed of it is
	 * written as `db`'s first row, with the generation record, in one
	 * transaction. The generation-4 store is left as it was.
	 */
	const convertPrevious = async (name: string, db: IDBDatabase): Promise<void> => {
		const [updates, custom] = idb.transact(db, [updatesStoreName, customStoreName], 'readonly');
		// Both requests before either settles: one transaction.
		const reads = [idb.get(custom, GENERATION_KEY), idb.count(updates)] as const;
		const found = await reads[0];
		if (found !== undefined || (await reads[1]) > 0) return;
		const old = await openIfExists(PREVIOUS_GENERATION_PREFIX + name);
		if (old === null) return;
		try {
			if (!old.objectStoreNames.contains(customStoreName)) return;
			const [oldUpdates, oldCustom] = idb.transact(
				old,
				[updatesStoreName, customStoreName],
				'readonly'
			);
			const reads = [idb.get(oldCustom, GENERATION_KEY), idb.getAll(oldUpdates)] as const;
			const record = await reads[0];
			const stored = await reads[1];
			if (!generations.isPreviousGenerationRecord(record)) return;
			const rows = await promise.all(stored.map(readRow));
			if (rows.length === 0) return;
			const seed = generations.seedOf(generations.previousJSONWith(rows));
			const [newUpdates, newCustom] = idb.transact(db, [updatesStoreName, customStoreName]);
			await promise.all([
				idb.rtop(newCustom.put({ ...STORED_GENERATION_RECORD }, GENERATION_KEY)),
				idb.addAutoKey(newUpdates, encodeRow(seed))
			]);
		} finally {
			old.close();
		}
	};

	/**
	 * The shared room protocol — dispatch, the join rule, awareness
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
	 * otherwise-mismatched) generation are never applied. The storage
	 * transaction reads everything it needs first (rows, last key, count):
	 * a snapshot row inflates asynchronously, after it ends.
	 */
	const fetchUpdates = (
		idbPersistence: IdbPersistenceLike,
		beforeApplyUpdatesCallback: (store: IDBObjectStore) => void = () => {},
		afterApplyUpdatesCallback: () => void = () => {}
	): Promise<void> => {
		const db = idbPersistence.db as IDBDatabase;
		const [updatesStore, customStore] = idb.transact(db, [updatesStoreName, customStoreName]);
		return verifyOrStamp(idbPersistence.name, updatesStore, customStore)
			.then(() =>
				idb.getAll(updatesStore, idb.createIDBKeyRangeLowerBound(idbPersistence._dbref, false))
			)
			.then((rows) => {
				// The pre-hydration state row is written before the last key is read.
				if (!idbPersistence._destroyed) beforeApplyUpdatesCallback(updatesStore);
				return promise
					.all([idb.getLastKey(updatesStore), idb.count(updatesStore)])
					.then(([lastKey, cnt]) => {
						idbPersistence._dbref = (lastKey as number) + 1;
						idbPersistence._dbsize = cnt;
						return promise.all(rows.map(readRow));
					});
			})
			.then((updates) => {
				if (idbPersistence._destroyed) return;
				Y.transact(
					idbPersistence.doc,
					() => {
						for (const update of updates) {
							if (update instanceof Uint8Array) Y.applyUpdate(idbPersistence.doc, update);
							else Y.applyUpdateV2(idbPersistence.doc, update.v2);
						}
					},
					idbPersistence,
					false
				);
				afterApplyUpdatesCallback();
			});
	};

	/** One transaction: the snapshot row, the rows below `below` deleted, the record stamped `'v2'`. */
	const writeSnapshot = (idbPersistence: IdbPersistenceLike, row: SnapshotRow, below: number) => {
		const db = idbPersistence.db as IDBDatabase;
		const [updatesStore, customStore] = idb.transact(db, [updatesStoreName, customStoreName]);
		// Track transaction commit: listeners attach while it is still active.
		const tx = updatesStore.transaction;
		const transactionDone = promise.create((resolve, reject) => {
			tx.addEventListener('complete', () => resolve(undefined));
			tx.addEventListener('abort', () =>
				reject(new Error(`IndexedDB transaction aborted${tx.error ? `: ${String(tx.error)}` : ''}`))
			);
		});
		return promise
			.all([
				idb
					// A structured-clone object row (lib0 types rows as binary).
					.addAutoKey(updatesStore, row as unknown as ArrayBuffer)
					.then(() => idb.del(updatesStore, idb.createIDBKeyRangeUpperBound(below, true)))
					.then(() => idb.rtop(customStore.put({ ...STORED_GENERATION_RECORD }, GENERATION_KEY)))
					.then(() =>
						idb.count(updatesStore).then((cnt) => {
							idbPersistence._dbsize = cnt;
						})
					),
				transactionDone
			])
			.then(() => undefined);
	};

	/**
	 * Persist the current state: fetch pending rows, then (when `forceStore`
	 * or past `PREFERRED_TRIM_SIZE`) append a compacted snapshot and delete
	 * the rows it subsumes. The snapshot is v2, gzip-compressed where the
	 * platform can, and the container's generation record is stamped
	 * with its storage format in the same transaction.
	 *
	 * Every applied row is represented in the snapshot, so deleting
	 * `key < _dbref` (read before the snapshot is compressed: rows stored
	 * meanwhile stay) is always safe; a read-only document (outbound
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
			.then(() => {
				if (quarantined(idbPersistence.doc)) return undefined;
				if (!forceStore && idbPersistence._dbsize < PREFERRED_TRIM_SIZE) {
					return undefined;
				}
				const below = idbPersistence._dbref;
				return snapshotRow(Y.encodeStateAsUpdateV2(idbPersistence.doc)).then((row) =>
					idbPersistence._destroyed ? undefined : writeSnapshot(idbPersistence, row, below)
				);
			});

	/**
	 * Delete a v14 generation database by LOGICAL name (the `edytor-v14-g5:`
	 * prefix is applied here; a generation-4 store, `edytor-v14:`, is left). Never touches the legacy v13 database.
	 */
	const clearDocument = (name: string) => idb.deleteDB(generationDbName(name));

	/**
	 * Each provider's doc-`destroy` listener: it ends the provider (it never
	 * rejects: the close is caught). Kept off the class, so it is not part
	 * of the provider's public shape.
	 */
	const destroyWithDoc = new WeakMap<object, () => void>();

	class IndexeddbPersistence extends IsolatedObservable<{
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
		 * Terminal sync failure: the provider never
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
		// The room lifecycle — installed by `initLifecycle`.
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
		disableBc: boolean;
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
			this.disableBc = options.disableBc === true;

			this._db = openContainer(this.dbName).then((db) =>
				options.convertPrevious === true
					? convertPrevious(name, db).then(
							() => db,
							(error) => {
								db.close();
								throw error;
							}
						)
					: db
			);

			this.destroy = this.destroy.bind(this);
			initLifecycle(this, this.destroy, () => room.depart(this));

			this._bcSubscriber = room.bcSubscriber(this);
			this._awarenessUpdateHandler = room.awarenessUpdateHandler(this);

			// Fail closed: no sync, no BC room join, whenSynced rejects, and
			// the terminal 'failed' fires — the provider can never reach
			// synced once loading its persisted state has failed.
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
							idb
								.addAutoKey(updatesStore, encodeRow(Y.encodeStateAsUpdate(doc)))
								.catch((error) => this.emit('message-error', [error, this]));
						}
					};
					// Hydrated: join the room and claim `synced` (lifetime).
					const afterApplyUpdatesCallback = () => {
						if (this._destroyed) return;
						if (!this.disableBc) this.connectBc();
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
				// The OPEN itself can fail — without this catch the
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
			const onDocDestroy = (): void => void this.destroy();
			destroyWithDoc.set(this, onDocDestroy);
			doc.on('destroy', onDocDestroy);
		}

		/** The lifetime hydration claim. */
		get synced(): boolean {
			return this.hasSynced;
		}

		/**
		 * The room dispatch table — owned by `room.ts`:
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
			// waiters: `whenSynced` rejects and 'failed' fires once.
			if (!beginDestroy(this, `IndexeddbPersistence "${this.name}"`)) {
				return Promise.resolve();
			}
			if (this._storeTimeoutId) {
				clearTimeout(this._storeTimeoutId);
			}
			this.doc.off('update', this._storeUpdate);
			const onDocDestroy = destroyWithDoc.get(this);
			if (onDocDestroy) this.doc.off('destroy', onDocDestroy);
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
