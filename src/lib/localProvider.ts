import * as Y from 'yjs';
import * as idb from 'lib0/indexeddb';
import * as promise from 'lib0/promise';
import { ObservableV2 } from 'lib0/observable';
import * as bc from 'lib0/broadcastchannel';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';

const customStoreName = 'custom';
const updatesStoreName = 'updates';
const messageSync = 0;
const messageQueryAwareness = 3;
const messageAwareness = 1;

export const PREFERRED_TRIM_SIZE = 500;

type IdbPersistence = {
	db: IDBDatabase | null;
	doc: Y.Doc;
	_dbref: number;
	_dbsize: number;
	_destroyed: boolean;
};

/**
 * @param {IndexeddbPersistence} idbPersistence
 * @param {function(IDBObjectStore):void} [beforeApplyUpdatesCallback]
 * @param {function(IDBObjectStore):void} [afterApplyUpdatesCallback]
 */
export const fetchUpdates = (
	idbPersistence: IdbPersistence,
	beforeApplyUpdatesCallback: (store: IDBObjectStore) => void = () => {},
	afterApplyUpdatesCallback: (store: IDBObjectStore) => void = () => {}
) => {
	const [updatesStore] = idb.transact(idbPersistence.db as IDBDatabase, [updatesStoreName]);
	return idb
		.getAll(updatesStore, idb.createIDBKeyRangeLowerBound(idbPersistence._dbref, false))
		.then((updates) => {
			if (!idbPersistence._destroyed) {
				beforeApplyUpdatesCallback(updatesStore);
				Y.transact(
					idbPersistence.doc,
					() => {
						updates.forEach((val) => Y.applyUpdate(idbPersistence.doc, val));
					},
					idbPersistence,
					false
				);
				afterApplyUpdatesCallback(updatesStore);
			}
		})
		.then(() =>
			idb.getLastKey(updatesStore).then((lastKey) => {
				idbPersistence._dbref = lastKey + 1;
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
 * @param {IndexeddbPersistence} idbPersistence
 * @param {boolean} forceStore
 */
export const storeState = (idbPersistence: IdbPersistence, forceStore = true) =>
	fetchUpdates(idbPersistence).then((updatesStore) => {
		if (forceStore || idbPersistence._dbsize >= PREFERRED_TRIM_SIZE) {
			idb
				.addAutoKey(updatesStore, Y.encodeStateAsUpdate(idbPersistence.doc))
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
 * @param {string} name
 */
export const clearDocument = (name: string) => idb.deleteDB(name);

/**
 * @extends Observable<string>
 */
export class IndexeddbPersistence extends ObservableV2<{
	synced: (provider: IndexeddbPersistence) => void;
}> {
	doc: Y.Doc;
	name: string;
	_dbref: number;
	_dbsize: number;
	_destroyed: boolean;
	db: IDBDatabase | null;
	synced: boolean;
	_db: Promise<IDBDatabase>;
	whenSynced: Promise<IndexeddbPersistence>;
	_storeTimeout: number;
	_storeTimeoutId: number | null;
	_storeUpdate: (update: Uint8Array, origin: any) => void;
	awareness: awarenessProtocol.Awareness;
	bcconnected: boolean = false;
	private _bcSubscriber: (data: ArrayBuffer, origin: any) => void;
	private _awarenessUpdateHandler: (
		{ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
		_origin: any
	) => void;

	/**
	 * @param {string} name
	 * @param {Y.Doc} doc
	 */
	constructor(name: string, doc: Y.Doc) {
		super();
		this.doc = doc;
		this.name = name;
		this._dbref = 0;
		this._dbsize = 0;
		this._destroyed = false;
		this.db = null;
		this.synced = false;
		this.awareness = new awarenessProtocol.Awareness(doc);

		this._db = idb.openDB(name, (db) =>
			idb.createStores(db, [['updates', { autoIncrement: true }], ['custom']])
		);

		this.whenSynced = promise.create((resolve) => this.on('synced', () => resolve(this)));

		this._bcSubscriber = (data, origin) => {
			if (origin !== this) {
				const encoder = this.readMessage(new Uint8Array(data), false);
				if (encoding.length(encoder) > 1) {
					bc.publish(this.name, encoding.toUint8Array(encoder), this);
				}
			}
		};

		this._awarenessUpdateHandler = ({ added, updated, removed }, _origin) => {
			const changedClients = added.concat(updated).concat(removed);
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, messageAwareness);
			encoding.writeVarUint8Array(
				encoder,
				awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
			);
			this.broadcastMessage(encoding.toUint8Array(encoder));
		};

		this._db.then((db) => {
			this.db = db;
			const beforeApplyUpdatesCallback = (updatesStore: IDBObjectStore) =>
				idb.addAutoKey(updatesStore, Y.encodeStateAsUpdate(doc));
			const afterApplyUpdatesCallback = () => {
				if (this._destroyed) return this;
				this.connectBc();
			};
			fetchUpdates(this as IdbPersistence, beforeApplyUpdatesCallback, afterApplyUpdatesCallback);
		});

		this._storeTimeout = 1000;
		this._storeTimeoutId = null;

		this._storeUpdate = (update: Uint8Array, origin: any) => {
			if (this.db && origin !== this) {
				const [updatesStore] = idb.transact(this.db, [updatesStoreName]);
				idb.addAutoKey(updatesStore, update);
				if (++this._dbsize >= PREFERRED_TRIM_SIZE) {
					if (this._storeTimeoutId !== null) {
						clearTimeout(this._storeTimeoutId);
					}
					this._storeTimeoutId = setTimeout(() => {
						storeState(this as IdbPersistence, false);
						this._storeTimeoutId = null;
					}, this._storeTimeout);
				}
			}
			// Broadcast the update to other tabs
			if (origin !== this) {
				const encoder = encoding.createEncoder();
				encoding.writeVarUint(encoder, messageSync);
				syncProtocol.writeUpdate(encoder, update);
				this.broadcastMessage(encoding.toUint8Array(encoder));
			}
		};

		doc.on('update', this._storeUpdate);
		this.awareness.on('update', this._awarenessUpdateHandler);
		this.destroy = this.destroy.bind(this);
		doc.on('destroy', this.destroy);
		(globalThis as any).addEventListener('beforeunload', () => this.destroy());
	}

	private messageHandlers: Record<
		number,
		(
			encoder: encoding.Encoder,
			decoder: decoding.Decoder,
			provider: IndexeddbPersistence,
			_emitSynced: boolean
		) => void
	> = {
		[messageSync]: (
			encoder: encoding.Encoder,
			decoder: decoding.Decoder,
			provider: IndexeddbPersistence,
			_emitSynced: boolean
		) => {
			encoding.writeVarUint(encoder, messageSync);
			const syncMessageType = syncProtocol.readSyncMessage(
				decoder,
				encoder,
				provider.doc,
				provider
			);
			if (syncMessageType === syncProtocol.messageYjsSyncStep2 && !provider.synced) {
				//
			}
		},
		[messageQueryAwareness]: (
			encoder: encoding.Encoder,
			_decoder: decoding.Decoder,
			provider: IndexeddbPersistence
		) => {
			encoding.writeVarUint(encoder, messageAwareness);
			encoding.writeVarUint8Array(
				encoder,
				awarenessProtocol.encodeAwarenessUpdate(
					provider.awareness,
					Array.from(provider.awareness.getStates().keys())
				)
			);
		},
		[messageAwareness]: (
			_encoder: encoding.Encoder,
			decoder: decoding.Decoder,
			provider: IndexeddbPersistence
		) => {
			awarenessProtocol.applyAwarenessUpdate(
				provider.awareness,
				decoding.readVarUint8Array(decoder),
				provider
			);
		}
	};

	private readMessage = (buf: Uint8Array, emitSynced: boolean): encoding.Encoder => {
		const decoder = decoding.createDecoder(buf);
		const encoder = encoding.createEncoder();
		const messageType = decoding.readVarUint(decoder);
		const messageHandler = this.messageHandlers[messageType];
		if (messageHandler) {
			messageHandler(encoder, decoder, this, emitSynced);
		}
		return encoder;
	};

	private broadcastMessage(buf: Uint8Array) {
		if (this.bcconnected) {
			bc.publish(this.name, buf, this);
		}
	}

	private connectBc() {
		if (!this.bcconnected) {
			bc.subscribe(this.name, this._bcSubscriber);
			this.bcconnected = true;
		}
		// Sync initial state
		const encoderSync = encoding.createEncoder();
		encoding.writeVarUint(encoderSync, messageSync);
		syncProtocol.writeSyncStep1(encoderSync, this.doc);
		bc.publish(this.name, encoding.toUint8Array(encoderSync), this);

		const encoderState = encoding.createEncoder();
		encoding.writeVarUint(encoderState, messageSync);
		syncProtocol.writeSyncStep2(encoderState, this.doc);
		bc.publish(this.name, encoding.toUint8Array(encoderState), this);

		// Sync awareness state
		const encoderAwarenessQuery = encoding.createEncoder();
		encoding.writeVarUint(encoderAwarenessQuery, messageQueryAwareness);
		bc.publish(this.name, encoding.toUint8Array(encoderAwarenessQuery), this);

		const encoderAwarenessState = encoding.createEncoder();
		encoding.writeVarUint(encoderAwarenessState, messageAwareness);
		encoding.writeVarUint8Array(
			encoderAwarenessState,
			awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID])
		);
		bc.publish(this.name, encoding.toUint8Array(encoderAwarenessState), this);

		this.synced = true;
		this.emit('synced', [this]);
	}

	private disconnectBc() {
		// Notify other clients about disconnection
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, messageAwareness);
		encoding.writeVarUint8Array(
			encoder,
			awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID], new Map())
		);
		this.broadcastMessage(encoding.toUint8Array(encoder));

		if (this.bcconnected) {
			bc.unsubscribe(this.name, this._bcSubscriber);
			this.bcconnected = false;
		}
	}

	/**
	 * Destroys this instance and removes all data from indexeddb.
	 *
	 * @return {Promise<void>}
	 */
	destroy() {
		if (this._storeTimeoutId) {
			clearTimeout(this._storeTimeoutId);
		}
		this.doc.off('update', this._storeUpdate);
		this.doc.off('destroy', this.destroy);
		this.awareness.off('update', this._awarenessUpdateHandler);
		this._destroyed = true;
		this.disconnectBc();
		return this._db.then((db) => {
			db.close();
		});
	}

	/**
	 * @param {String | number | ArrayBuffer | Date} key
	 * @return {Promise<String | number | ArrayBuffer | Date | any>}
	 */
	get(key: string | number | ArrayBuffer | Date) {
		return this._db.then((db) => {
			const [custom] = idb.transact(db, [customStoreName], 'readonly');
			return idb.get(custom, key);
		});
	}

	/**
	 * @param {String | number | ArrayBuffer | Date} key
	 * @param {String | number | ArrayBuffer | Date} value
	 * @return {Promise<String | number | ArrayBuffer | Date>}
	 */
	set(key: string | number | ArrayBuffer | Date, value: string | number | ArrayBuffer | Date) {
		return this._db.then((db) => {
			const [custom] = idb.transact(db, [customStoreName]);
			return idb.put(custom, value, key);
		});
	}

	/**
	 * @param {String | number | ArrayBuffer | Date} key
	 * @return {Promise<undefined>}
	 */
	del(key: string | number | ArrayBuffer | Date) {
		return this._db.then((db) => {
			const [custom] = idb.transact(db, [customStoreName]);
			return idb.del(custom, key);
		});
	}
}
