/**
 * The v14 IndexedDB container — one owner for the store names, the row
 * codec (every row an update in the engine's one encoding, a snapshot
 * gzip-compressed where that makes it smaller), the open, the non-creating
 * probe and the ONE verify-or-stamp rule. Rows are append-only for every
 * writer (a provider's compaction appends its snapshot before deleting the
 * rows it subsumes).
 */
import * as idb from 'lib0-v14/indexeddb';
import {
	GENERATION_KEY,
	GenerationMismatchError,
	GENERATION_RECORD,
	isGenerationRecord
} from '../protocols/envelope.js';
import { gunzip, packed } from '../storage.js';

export const UPDATES = 'updates';
export const CUSTOM = 'custom';

/** Open (creating when absent) a container with its two stores. */
export const openContainer = (dbName: string): Promise<IDBDatabase> =>
	idb.openDB(dbName, (db) => idb.createStores(db, [[UPDATES, { autoIncrement: true }], [CUSTOM]]));

/** A row is the update's bytes in a buffer of their own. */
export const encodeRow = (update: Uint8Array): ArrayBuffer => update.slice().buffer;

/** A snapshot row: the document's state, gzip-compressed where that makes it smaller. */
export const snapshotRow = async (update: Uint8Array): Promise<ArrayBuffer> =>
	encodeRow(await packed(update));

/** A stored row as the update to apply (a compressed snapshot inflated). */
export const readRow = async (row: unknown): Promise<Uint8Array> => {
	if (!(row instanceof ArrayBuffer)) throw new TypeError('Stored Yjs update is not binary data');
	return gunzip(new Uint8Array(row));
};

/**
 * The one verify-or-stamp rule: a container carrying this generation's
 * record passes; an EMPTY container without a record is stamped; anything
 * else (a populated store without a record, a foreign record) throws
 * {@link GenerationMismatchError} — nothing inside a row is inspected.
 */
export const verifyOrStamp = async (
	name: string,
	updates: IDBObjectStore,
	custom: IDBObjectStore
): Promise<void> => {
	const found = await idb.get(custom, GENERATION_KEY);
	if (found === undefined && (await idb.count(updates)) === 0) {
		await idb.rtop(custom.put({ ...GENERATION_RECORD }, GENERATION_KEY));
	} else if (!isGenerationRecord(found)) {
		throw new GenerationMismatchError(name, found);
	}
};

/**
 * Open `dbName` only if it exists — never creates: an
 * `indexedDB.open` on an absent name leaves a store-less v1 database behind,
 * poison for a later creating open (store creation runs only inside
 * `onupgradeneeded`). `indexedDB.databases()`, where available, answers
 * absence without a handle; otherwise the upgrade of a brand-new database is
 * aborted, which rolls its creation back. Absent → `null`.
 */
export const openIfExists = async (dbName: string): Promise<IDBDatabase | null> => {
	const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
	if (!factory) return null;
	const infos = await factory.databases?.().catch(() => undefined);
	if (infos && !infos.some((info) => info.name === dbName)) return null;
	return new Promise((resolve, reject) => {
		let created = false;
		const request = factory.open(dbName);
		request.onupgradeneeded = () => {
			created = true;
			request.transaction?.abort();
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => (created ? resolve(null) : reject(request.error));
		request.onblocked = () =>
			reject(new Error(`database "${dbName}" is blocked by an open connection`));
	});
};
