/**
 * The v14 IndexedDB container (L58) — one owner for the store names, the row
 * codec (v1 update rows, v2 snapshot rows: P5), the open, the non-creating probe and the ONE verify-or-stamp rule,
 * shared by the provider and the migrator. Rows are append-only for every
 * writer (a provider's compaction appends its snapshot before deleting the
 * rows it subsumes).
 */
import * as idb from 'lib0-v14/indexeddb';
import {
	GENERATION_KEY,
	GenerationMismatchError,
	isGenerationRecord,
	STORED_GENERATION_RECORD
} from '../protocols/envelope.js';
import { gunzip, packed } from '../storage.js';

export const UPDATES = 'updates';
export const CUSTOM = 'custom';

/** Open (creating when absent) a container with its two stores. */
export const openContainer = (dbName: string): Promise<IDBDatabase> =>
	idb.openDB(dbName, (db) => idb.createStores(db, [[UPDATES, { autoIncrement: true }], [CUSTOM]]));

/** A row is the update's bytes in a buffer of their own. */
export const encodeRow = (update: Uint8Array): ArrayBuffer => update.slice().buffer;

export const decodeRow = (row: unknown): Uint8Array => {
	if (row instanceof ArrayBuffer) return new Uint8Array(row);
	if (row instanceof Uint8Array) return row;
	throw new TypeError('Stored Yjs update is not binary data');
};

/**
 * A snapshot row (P5, storage `'v2'`): the document in the v2 encoding,
 * gzip-compressed where the platform has `CompressionStream` (and that
 * makes it smaller). Update rows stay v1 `ArrayBuffer`s. A build before
 * 0.1.0-next.23 reads such a row as no update at all (`decodeRow` throws),
 * so it fails to load the store instead of misreading it.
 */
export type SnapshotRow = { v2: ArrayBuffer };

export const snapshotRow = async (updateV2: Uint8Array): Promise<SnapshotRow> => ({
	v2: (await packed(updateV2)).slice().buffer
});

/** A stored row as the update to apply: `{ v2 }` for a snapshot row (inflated). */
export const readRow = async (row: unknown): Promise<Uint8Array | { v2: Uint8Array }> => {
	if (typeof row === 'object' && row !== null && 'v2' in row) {
		const bytes = (row as SnapshotRow).v2;
		if (!(bytes instanceof ArrayBuffer)) throw new TypeError('Stored snapshot is not binary data');
		return { v2: await gunzip(new Uint8Array(bytes)) };
	}
	return decodeRow(row);
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
		await idb.rtop(custom.put({ ...STORED_GENERATION_RECORD }, GENERATION_KEY));
	} else if (!isGenerationRecord(found)) {
		throw new GenerationMismatchError(name, found);
	}
};

/**
 * Open `dbName` only if it exists — never creates (B1): an
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
