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
 *   compacted `encodeStateAsUpdate` snapshot and deletes prior rows.
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
import * as decoding from 'lib0-v14/decoding';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from '../protocols/awareness.js';
import { bindSync, type SyncProtocol } from '../protocols/sync.js';
import {
	PROTOCOL_VERSION,
	generationDbName,
	GENERATION_KEY,
	GENERATION_RECORD,
	GenerationMismatchError,
	readProtocolVersion,
	writeProtocolVersion,
	type GenerationRecord
} from '../protocols/envelope.js';
import { checkSchema, SchemaMismatchError, type SchemaProblem } from '../edytor-doc.js';
import type { EngineApi, YDoc } from '../engine-api.js';

const customStoreName = 'custom';
const updatesStoreName = 'updates';
const messageSync = 0;
const messageQueryAwareness = 3;
const messageAwareness = 1;

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
	/** The ObservableV2 emit channel (typed per-event on the real provider). */
	emit?: {
		(event: 'schema-mismatch', args: [SchemaMismatchDetail, unknown]): void;
		(event: 'message-error', args: [unknown, unknown]): void;
	};
};

export type IndexeddbPersistenceOptions = {
	awareness?: Awareness;
};

export type ProtocolMismatch = { expected: number; found: number | null };

/**
 * Schema-gate signal detail — emitted on `'schema-mismatch'` (and mirrored
 * through `'message-error'` carrying the {@link SchemaMismatchError}) when a
 * doc's replicated state violates the schema gate:
 *
 * - `unversioned` — replicated registry content without `meta.v` (rogue or
 *   legacy write). The update is QUARANTINED: not persisted, not broadcast,
 *   and never applied to a hydrating doc.
 * - `unsupported` — `meta.v` names a version this build does not speak.
 *   Content still syncs (a replica cannot refuse structs it already shares a
 *   protocol with) but the signal lets operators detect peer skew.
 */
export type SchemaMismatchDetail = { docName: string; problem: SchemaProblem };

export type IndexeddbProvider = ReturnType<typeof bindIndexeddbProvider>;

/** Instance type of the bound provider class. */
export type IndexeddbPersistenceApi = InstanceType<IndexeddbProvider['IndexeddbPersistence']>;

/**
 * Bind the IndexedDB persistence provider to the vendored v14 engine module.
 */
export const bindIndexeddbProvider = (Y: EngineApi) => {
	const syncProtocol: SyncProtocol = bindSync(Y);

	/**
	 * Schema gate (gate-2 attack 1a). Two regimes:
	 *
	 * - `unversioned` — replicated registry content with no `meta.v`. The
	 *   update is QUARANTINED: callers must not persist it, broadcast it, or
	 *   apply it into a hydrating doc. An uninitialized doc can still carry
	 *   engine-level state (a completely untouched doc reads clean — `null`).
	 * - `unsupported` — `meta.v` names a version this build does not speak.
	 *   Content keeps syncing (a replica cannot refuse structs it already
	 *   shares a protocol with) but the signal makes peer skew observable.
	 *
	 * Signals: `'schema-mismatch'` (structured detail) + `'message-error'`
	 * (the same condition as a {@link SchemaMismatchError}) so the generic
	 * error channel sees every failure mode. Emitted once per problem-state
	 * transition, not per update.
	 */
	const emitSchemaProblem = (p: IdbPersistenceLike, problem: SchemaProblem): void => {
		if (!p.emit) return;
		const detail: SchemaMismatchDetail = { docName: p.name, problem };
		p.emit('schema-mismatch', [detail, p]);
		p.emit('message-error', [new SchemaMismatchError(p.name, problem), p]);
	};

	/** Gate the provider's own doc; returns the detected problem (or null). */
	const gateSchema = (p: IdbPersistenceLike): SchemaProblem | null => {
		const problem = checkSchema(p.doc as unknown as import('../engine-api.js').EngineDoc);
		const key = problem === null ? null : `${problem.kind}:${problem.version ?? '?'}`;
		if (key !== (p._schemaGateKey ?? null)) {
			p._schemaGateKey = key;
			if (problem !== null) emitSchemaProblem(p, problem);
		}
		return problem;
	};

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
					// Schema gate on hydration (gate-2 attack 1a): apply the rows
					// to a SCRATCH doc seeded with the doc's current state first.
					// If the merged result carries registry content without
					// meta.v (hostile/bogus rows in the store), the batch is
					// quarantined — nothing is applied to the real doc. A
					// supported-or-empty result applies normally; an unsupported
					// version applies and is signaled.
					const scratch = new Y.Doc();
					Y.applyUpdate(scratch, Y.encodeStateAsUpdate(idbPersistence.doc));
					for (const update of updates) {
						Y.applyUpdate(scratch, decodeStoredUpdate(update));
					}
					const problem = checkSchema(scratch as unknown as import('../engine-api.js').EngineDoc);
					if (problem?.kind !== 'unversioned') {
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
					}
					if (problem !== null) emitSchemaProblem(idbPersistence, problem);
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
	 */
	const storeState = (idbPersistence: IdbPersistenceLike, forceStore = true) =>
		fetchUpdates(idbPersistence).then((updatesStore) => {
			// Schema gate: never persist a snapshot of unversioned content.
			if (gateSchema(idbPersistence)?.kind === 'unversioned') return;
			if (forceStore || idbPersistence._dbsize >= PREFERRED_TRIM_SIZE) {
				idb
					.addAutoKey(updatesStore, encodeUpdateForStore(Y.encodeStateAsUpdate(idbPersistence.doc)))
					.then(() =>
						idb.del(updatesStore, idb.createIDBKeyRangeUpperBound(idbPersistence._dbref, true))
					)
					.then(() =>
						idb.count(updatesStore).then((cnt) => {
							idbPersistence._dbsize = cnt;
						})
					);
			}
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

			this._bcSubscriber = (data, origin) => {
				if (origin !== this) {
					try {
						const encoder = this.readMessage(new Uint8Array(data), false);
						// Only publish a real reply. A handler with nothing to say
						// leaves just the envelope header (version word + mirrored
						// message type = 2 bytes); upstream checked `> 1` because an
						// empty reply there is a single byte. Publishing the bare
						// header produces a truncated frame that throws in the
						// receiver's readSyncMessage.
						if (encoding.length(encoder) > 2) {
							bc.publish(this.dbName, encoding.toUint8Array(encoder), this);
						}
					} catch (error) {
						// lib0 delivers same-tab publishes synchronously — a
						// malformed message must not propagate into the publisher's
						// call stack (it would surface as a load/connect failure
						// on the peer). Drop it and report instead.
						this.emit('message-error', [error, this]);
					}
				}
			};

			this._awarenessUpdateHandler = ({ added, updated, removed }, _origin) => {
				const changedClients = added.concat(updated).concat(removed);
				const encoder = encoding.createEncoder();
				writeProtocolVersion(encoder);
				encoding.writeVarUint(encoder, messageAwareness);
				encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(this.awareness, changedClients));
				this.broadcastMessage(encoding.toUint8Array(encoder));
			};

			this._db.then((db) => {
				if (this._destroyed) {
					db.close();
					return;
				}
				this.db = db;
				const beforeApplyUpdatesCallback = (updatesStore: IDBObjectStore) => {
					// Schema gate: a doc carrying unversioned registry content
					// (rogue write before provider attach) is quarantined — its
					// state is never persisted to the generation DB.
					if (gateSchema(this)?.kind !== 'unversioned') {
						return idb.addAutoKey(updatesStore, encodeUpdateForStore(Y.encodeStateAsUpdate(doc)));
					}
					return undefined;
				};
				const afterApplyUpdatesCallback = () => {
					if (this._destroyed) return;
					this.connectBc();
				};
				fetchUpdates(this, beforeApplyUpdatesCallback, afterApplyUpdatesCallback).catch((error) => {
					// Fail closed: no sync, no BC room join, whenSynced rejects.
					this.loadError = error;
					this._rejectSynced?.(error);
					this.emit('load-error', [error, this]);
				});
			});

			this._storeTimeout = 1000;
			this._storeTimeoutId = null;

			this._storeUpdate = (update: Uint8Array, origin: unknown) => {
				// Schema gate (gate-2 attack 1a): an update that leaves the doc
				// carrying replicated registry content without `meta.v` is
				// quarantined — never persisted, never broadcast. 'unsupported'
				// meta.v is signaled but still flows.
				const gated = origin !== this && gateSchema(this)?.kind === 'unversioned';
				if (this.db && origin !== this && !gated) {
					const [updatesStore] = idb.transact(this.db, [updatesStoreName]);
					idb.addAutoKey(updatesStore, encodeUpdateForStore(update));
					if (++this._dbsize >= PREFERRED_TRIM_SIZE) {
						if (this._storeTimeoutId !== null) {
							clearTimeout(this._storeTimeoutId);
						}
						this._storeTimeoutId = setTimeout(() => {
							storeState(this, false);
							this._storeTimeoutId = null;
						}, this._storeTimeout);
					}
				}
				// Broadcast the update to other tabs
				if (origin !== this && !gated) {
					const encoder = encoding.createEncoder();
					writeProtocolVersion(encoder);
					encoding.writeVarUint(encoder, messageSync);
					syncProtocol.writeUpdate(encoder, update);
					this.broadcastMessage(encoding.toUint8Array(encoder));
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

		messageHandlers: Record<
			number,
			(
				encoder: encoding.Encoder,
				decoder: decoding.Decoder,
				provider: IndexeddbPersistence,
				emitSynced: boolean
			) => void
		> = {
			[messageSync]: (encoder, decoder, provider, _emitSynced) => {
				encoding.writeVarUint(encoder, messageSync);
				// A corrupt update payload inside a VALID v14 envelope is a
				// per-message failure — surfaced through 'message-error'
				// (gate-2: sync.ts's catch alone was invisible to consumers).
				syncProtocol.readSyncMessage(decoder, encoder, provider.doc, provider, (error) =>
					provider.emit('message-error', [error, provider])
				);
				// Post-apply schema check: a remote update may have moved the
				// doc into an unsupported-version state (peer skew signal).
				gateSchema(provider);
			},
			[messageQueryAwareness]: (encoder, _decoder, provider) => {
				encoding.writeVarUint(encoder, messageAwareness);
				encoding.writeVarUint8Array(
					encoder,
					encodeAwarenessUpdate(
						provider.awareness,
						Array.from(provider.awareness.getStates().keys())
					)
				);
			},
			[messageAwareness]: (_encoder, decoder, provider) => {
				applyAwarenessUpdate(provider.awareness, decoding.readVarUint8Array(decoder), provider);
			}
		};

		/**
		 * Decode one room message. The protocol-version word is verified
		 * before anything else — a foreign message (v13 writer, corrupt
		 * frame) is dropped and reported; its payload is never decoded.
		 */
		readMessage = (buf: Uint8Array, emitSynced: boolean): encoding.Encoder => {
			const decoder = decoding.createDecoder(buf);
			const encoder = encoding.createEncoder();
			if (!readProtocolVersion(decoder)) {
				this.emit('protocol-mismatch', [
					{ expected: PROTOCOL_VERSION, found: buf.length > 0 ? buf[0] : null },
					this
				]);
				return encoder;
			}
			writeProtocolVersion(encoder);
			const messageType = decoding.readVarUint(decoder);
			const messageHandler = this.messageHandlers[messageType];
			if (messageHandler) {
				messageHandler(encoder, decoder, this, emitSynced);
			} else {
				// Fail closed + observable: a VALID v14 envelope carrying a
				// message type no handler claims is still surfaced — protocol
				// skew (a newer peer, a buggy peer) must not be silent
				// (gate-2 attack 1c).
				this.emit('message-error', [new Error(`Unknown v14 message type ${messageType}`), this]);
			}
			return encoder;
		};

		broadcastMessage(buf: Uint8Array) {
			if (this.bcconnected) {
				bc.publish(this.dbName, buf, this);
			}
		}

		connectBc() {
			if (!this.bcconnected) {
				bc.subscribe(this.dbName, this._bcSubscriber);
				this.bcconnected = true;
			}
			// Sync initial state
			const encoderSync = encoding.createEncoder();
			writeProtocolVersion(encoderSync);
			encoding.writeVarUint(encoderSync, messageSync);
			syncProtocol.writeSyncStep1(encoderSync, this.doc);
			bc.publish(this.dbName, encoding.toUint8Array(encoderSync), this);

			const encoderState = encoding.createEncoder();
			writeProtocolVersion(encoderState);
			encoding.writeVarUint(encoderState, messageSync);
			syncProtocol.writeSyncStep2(encoderState, this.doc);
			bc.publish(this.dbName, encoding.toUint8Array(encoderState), this);

			// Sync awareness state
			const encoderAwarenessQuery = encoding.createEncoder();
			writeProtocolVersion(encoderAwarenessQuery);
			encoding.writeVarUint(encoderAwarenessQuery, messageQueryAwareness);
			bc.publish(this.dbName, encoding.toUint8Array(encoderAwarenessQuery), this);

			const encoderAwarenessState = encoding.createEncoder();
			writeProtocolVersion(encoderAwarenessState);
			encoding.writeVarUint(encoderAwarenessState, messageAwareness);
			encoding.writeVarUint8Array(
				encoderAwarenessState,
				encodeAwarenessUpdate(this.awareness, [this.doc.clientID])
			);
			bc.publish(this.dbName, encoding.toUint8Array(encoderAwarenessState), this);

			this.synced = true;
			this.emit('synced', [this]);
		}

		disconnectBc() {
			// Notify other clients about disconnection
			const encoder = encoding.createEncoder();
			writeProtocolVersion(encoder);
			encoding.writeVarUint(encoder, messageAwareness);
			encoding.writeVarUint8Array(
				encoder,
				encodeAwarenessUpdate(this.awareness, [this.doc.clientID], new Map())
			);
			this.broadcastMessage(encoding.toUint8Array(encoder));

			if (this.bcconnected) {
				bc.unsubscribe(this.dbName, this._bcSubscriber);
				this.bcconnected = false;
			}
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
			this.disconnectBc();
			if (this._ownsAwareness) {
				this.awareness.destroy();
			}
			return this._db.then((db) => {
				db.close();
			});
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
		fetchUpdates,
		storeState,
		clearDocument,
		PREFERRED_TRIM_SIZE
	};
};
