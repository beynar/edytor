/**
 * Non-destructive v13 → v14 persistence migration.
 *
 * - READS every row of the legacy `<name>` database's `updates` store (the
 *   v13 y-indexeddb layout) in one readonly transaction, and materializes the
 *   logical JSON a v13 editor produced (`legacy-schema.ts`).
 * - WRITES the import into the generation `edytor-v14-g5:<name>`: the row is
 *   APPENDED and the `active` record written in ONE transaction, so a
 *   completed import is visible iff both committed. The store is append-only
 *   for this writer as for the provider; the legacy database is never
 *   written, so rollback stays available.
 * - A first import is a fresh identity appended beside whatever a live
 *   provider already stored. `force` is a replace-edit instead (D-22): it
 *   hydrates the generation, restores every legacy id in place
 *   (restore-definition — delete marks cleared, type, data, placement and
 *   content rewritten, every other block deleted) and appends that diff, so
 *   a forced re-migration reproduces the legacy ids and two devices forcing
 *   independently converge on one copy.
 *
 * CRDT identity, history and undo do not survive a first import (it is a
 * JSON-level import); logical `b_*`/`i_*` ids do, and verification compares
 * them.
 *
 * Attempt vs progress (O79): the attempt is a `navigator.locks` lock named
 * {@link migrationBcRoom} — crash-released, so no lease, owner or poll
 * exists; where the platform has none (Node 22) an in-process mutex stands
 * in (U-5). Progress is only the durable record, which is never `pending`:
 * `status()` reports `pending` while the lock is held, and `wait: false`
 * asks for the lock `ifAvailable` and returns `busy`.
 */
import * as idb from 'lib0-v14/indexeddb';
import * as f from 'lib0-v14/function';
import type { EngineApi, EngineDoc, YDoc } from '../engine-api.js';
import { bindEdytorDoc } from '../edytor-doc.js';
import { bindLegacyReader } from './legacy-schema.js';
import { generationDbName } from '../protocols/envelope.js';
import {
	CUSTOM,
	decodeRow,
	encodeRow,
	readRow,
	openContainer,
	openIfExists,
	UPDATES,
	verifyOrStamp
} from '../providers/container.js';
import {
	jsonBlockToSpec,
	sanitizeWireJson,
	type JSONBlock,
	type JSONDoc
} from '../../utils/json.js';

const MIGRATION_KEY = 'migration';

/** The name of the migration lock of logical document `name`. */
export const migrationBcRoom = (name: string): string => `edytor-v14-migration:${name}`;

export type MigrationStatus = 'none' | 'pending' | 'active' | 'failed' | 'rolledback';

/** Durable progress. `pending` is never stored: it is the lock, reported by `status()`. */
export type MigrationRecord = {
	v: 1;
	status: MigrationStatus;
	migratedAt?: number;
	rolledbackAt?: number;
	sourceRows?: number;
	sourceBytes?: number;
	error?: string;
};

export type MigrationPhase = 'claim' | 'read' | 'materialize' | 'rebuild' | 'verify' | 'persist';

export type MigrateResult = {
	/** `active` also covers `already-active` and `nothing-to-migrate`. */
	status: 'active' | 'busy' | 'failed' | 'rolledback';
	alreadyActive?: boolean;
	empty?: boolean;
	/** The migrated v14 doc (present when this call ran the import). */
	doc?: YDoc;
	/**
	 * The migrated state (present when this call ran the import) — restore it
	 * through the document admission path: `loadDocument(result.update)`
	 * lands a `hydrated` document through the gate every load crosses.
	 * The appended row is its diff against what the generation held (the
	 * whole state for a first import).
	 */
	update?: Uint8Array;
	/** The materialized logical JSON with its ids (present when this call ran the import). */
	json?: JSONDoc;
	sourceRows?: number;
	error?: string;
};

export type MigrateOptions = {
	/** Legacy database name — defaults to the logical `name` (the v13 layout). */
	sourceName?: string;
	/** Re-run even when already `active` or `rolledback` — restores the legacy ids in place. */
	force?: boolean;
	/** `false`: return `busy` instead of queueing behind another tab's attempt. */
	wait?: boolean;
	/** Phase observer — invoked BEFORE each phase; throwing simulates a crash. */
	onPhase?: (phase: MigrationPhase) => void | Promise<void>;
	/** @deprecated No-op: the attempt is a crash-released lock, not a lease. */
	leaseMs?: number;
	/** @deprecated No-op: waiting is queueing on the lock. */
	waitMs?: number;
	/** @deprecated No-op: nothing polls. */
	pollMs?: number;
	/** @deprecated No-op: no durable owner exists. */
	owner?: string;
};

/** The part of the Web Locks API the migrator uses. */
type Locks = {
	request<T>(
		name: string,
		options: { ifAvailable?: boolean; mode?: 'shared' | 'exclusive' },
		fn: (lock: unknown) => T | Promise<T>
	): Promise<T>;
	query(): Promise<{ held?: { name?: string; mode?: string }[] }>;
};

/** U-5: where `navigator.locks` is absent, an in-process mutex (exclusive only) with its surface. */
const tails = new Map<string, Promise<unknown>>();
const inProcess: Locks = {
	request: (name, { ifAvailable }, fn) => {
		if (ifAvailable && tails.has(name)) return Promise.resolve(fn(null));
		const run = (tails.get(name) ?? Promise.resolve()).then(() => fn({ name }));
		const tail = run.then(f.nop, f.nop);
		tails.set(name, tail);
		void tail.then(() => tails.get(name) === tail && tails.delete(name));
		return run;
	},
	query: async () => ({ held: [...tails.keys()].map((name) => ({ name })) })
};
const locks = (): Locks =>
	(globalThis as { navigator?: { locks?: Locks } }).navigator?.locks ?? inProcess;

const readRecord = async (db: IDBDatabase): Promise<MigrationRecord> =>
	((await idb.rtop(idb.transact(db, [CUSTOM], 'readonly')[0].get(MIGRATION_KEY))) as
		| MigrationRecord
		| undefined) ?? { v: 1, status: 'none' };

/**
 * The legacy rows, in ONE readonly transaction — the fence (D23): a live v13
 * writer's rows land entirely before or after this snapshot (later rows are
 * the `force` path's). Never creates the legacy database.
 */
const readLegacyRows = async (sourceName: string): Promise<Uint8Array[]> => {
	const db = await openIfExists(sourceName);
	try {
		if (!db?.objectStoreNames.contains(UPDATES)) return [];
		return (await idb.getAll(idb.transact(db, [UPDATES], 'readonly')[0])).map(decodeRow);
	} finally {
		db?.close();
	}
};

/**
 * Give id-less legacy blocks and atoms a deterministic `mig-<path>` id — the
 * one id policy: the import is built from, and verified against, this JSON.
 */
const withFallbackIds = (b: JSONBlock, path: string): JSONBlock => {
	const out: JSONBlock = { ...b, id: b.id ?? `mig-${path}` };
	if (b.content && b.content.length > 0) {
		out.content = b.content.map((item, i) =>
			'text' in item ? item : { ...item, id: item.id ?? `mig-${path}-i${i}` }
		);
	}
	if (b.children && b.children.length > 0) {
		out.children = b.children.map((c, i) => withFallbackIds(c, `${path}.${i}`));
	}
	return out;
};

export type Migration = ReturnType<typeof bindMigration>;

/**
 * Bind the migration path to the vendored v14 engine module.
 */
export const bindMigration = (Y: EngineApi) => {
	const reader = bindLegacyReader(Y);
	const edytorDoc = bindEdytorDoc(Y);

	/** The durable record — NON-CREATING (D23): probing never leaves a database behind. */
	const stored = async (name: string): Promise<MigrationRecord> => {
		const db = await openIfExists(generationDbName(name));
		try {
			return db?.objectStoreNames.contains(CUSTOM)
				? await readRecord(db)
				: { v: 1, status: 'none' };
		} finally {
			db?.close();
		}
	};

	/** `pending` while a tab holds the attempt (a waiter's shared hold is not one); the durable record otherwise. */
	const status = async (name: string): Promise<MigrationRecord> => {
		const { held = [] } = await locks().query();
		return held.some((lock) => lock.name === migrationBcRoom(name) && lock.mode !== 'shared')
			? { v: 1, status: 'pending' }
			: stored(name);
	};

	/** Resolve with the durable record once no tab holds the attempt (the options are no-ops, D-15). */
	const waitForSettled = (
		name: string,
		_options?: { waitMs?: number; pollMs?: number }
	): Promise<MigrationRecord> =>
		locks().request(migrationBcRoom(name), { mode: 'shared' }, () => stored(name));

	/** One attempt, run while holding the lock. */
	const attempt = async (
		name: string,
		{ sourceName = name, force = false, onPhase }: MigrateOptions
	): Promise<MigrateResult> => {
		await onPhase?.('claim');
		const db = await openContainer(generationDbName(name));
		try {
			const record = await readRecord(db);
			if (!force && record.status === 'active') return { status: 'active', alreadyActive: true };
			if (!force && record.status === 'rolledback') return { status: 'rolledback' };

			/** Progress, atomically: the appended row (if any) and the record. */
			const commit = async (next: Omit<MigrationRecord, 'v'>, row?: Uint8Array) => {
				const [updates, custom] = idb.transact(db, [UPDATES, CUSTOM]);
				try {
					await verifyOrStamp(name, updates, custom);
					if (row) await idb.addAutoKey(updates, encodeRow(row));
					await idb.rtop(custom.put({ v: 1, ...next }, MIGRATION_KEY));
				} catch (error) {
					try {
						updates.transaction.abort();
					} catch {
						// Already finished — the failed request aborted it.
					}
					throw error;
				}
			};
			const failed = async (error: string): Promise<MigrateResult> => {
				await commit({ status: 'failed', error, migratedAt: Date.now() });
				return { status: 'failed', error };
			};

			await onPhase?.('read');
			const rows = await readLegacyRows(sourceName);
			const sourceRows = rows.length;
			if (sourceRows === 0) {
				await onPhase?.('persist');
				await commit({ status: 'active', migratedAt: Date.now(), sourceRows, sourceBytes: 0 });
				return { status: 'active', empty: true, sourceRows };
			}

			await onPhase?.('materialize');
			let legacy: JSONDoc;
			try {
				// Throws PendingLegacyUpdatesError when rows carry structs whose
				// deps never landed — a truncated document must not activate.
				// Every string becomes well-formed UTF-16 (F2-M1), as the wire
				// would deliver it, so verify compares normalized JSON.
				legacy = sanitizeWireJson(reader.readLegacyJSON(rows));
			} catch (error) {
				return failed(`legacy decode failed: ${(error as Error).message}`);
			}
			const json: JSONDoc = { children: legacy.children.map((b, i) => withFallbackIds(b, `${i}`)) };

			await onPhase?.('rebuild');
			const doc = new Y.Doc();
			if (force) {
				const [updates, custom] = idb.transact(db, [UPDATES, CUSTOM]);
				await verifyOrStamp(name, updates, custom);
				// Rows first (one transaction), then inflate: a snapshot row is v2, maybe gzip (P5).
				for (const row of await idb.getAll(updates)) {
					const update = await readRow(row);
					if (update instanceof Uint8Array) Y.applyUpdate(doc, update);
					else Y.applyUpdateV2(doc, update.v2);
				}
			}
			const base = Y.encodeStateVector(doc);
			edytorDoc.restore(
				doc as unknown as EngineDoc,
				json.children.map((b) => jsonBlockToSpec(b))
			);
			const update = Y.encodeStateAsUpdate(doc);

			await onPhase?.('verify');
			const check = new Y.Doc();
			Y.applyUpdate(check, update);
			if (!f.equalityDeep(edytorDoc.create(check as unknown as EngineDoc).toJSON(), json)) {
				return failed(
					'verification failed: migrated document does not reproduce the legacy logical JSON'
				);
			}

			await onPhase?.('persist');
			const sourceBytes = rows.reduce((n, r) => n + r.byteLength, 0);
			await commit(
				{ status: 'active', migratedAt: Date.now(), sourceRows, sourceBytes },
				Y.encodeStateAsUpdate(doc, base)
			);
			return { status: 'active', doc, update, json, sourceRows };
		} finally {
			db.close();
		}
	};

	/**
	 * Run the migration for logical document `name`: `active` already →
	 * `{alreadyActive: true}`; `rolledback` → `{status: 'rolledback'}` unless
	 * `force`; another tab mid-attempt → queue behind it (`wait: false` →
	 * `busy`); otherwise import, verify and commit.
	 */
	const migrate = (name: string, options: MigrateOptions = {}): Promise<MigrateResult> =>
		locks().request(migrationBcRoom(name), { ifAvailable: options.wait === false }, (lock) =>
			lock === null ? { status: 'busy' as const } : attempt(name, options)
		);

	/**
	 * Roll back: mark the generation `rolledback` and clear its rows. The
	 * legacy database is untouched, so a v13 stack works again on its own
	 * data; a later `migrate` needs `force` — rollback is an operator decision.
	 */
	const rollback = async (name: string): Promise<void> => {
		const db = await openContainer(generationDbName(name));
		try {
			const [updates, custom] = idb.transact(db, [UPDATES, CUSTOM]);
			const record: MigrationRecord = { v: 1, status: 'rolledback', rolledbackAt: Date.now() };
			await idb.rtop(custom.put(record, MIGRATION_KEY));
			await idb.rtop(updates.clear());
		} finally {
			db.close();
		}
	};

	return { migrate, rollback, status, waitForSettled };
};
