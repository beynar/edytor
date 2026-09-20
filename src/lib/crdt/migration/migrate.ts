/**
 * Non-destructive v13 → v14 persistence migration.
 *
 * What it does — and what it deliberately does NOT do:
 *
 * - READS the legacy generation: every row of the old `<name>` database's
 *   `updates` store (the v13 y-indexeddb layout this app shipped). Rows are
 *   V1 updates; the vendored v14 `applyUpdate` decodes them.
 * - MATERIALIZES the logical JSON (`migration/legacy-schema.ts`) — the same
 *   tree a v13 editor produced — and re-imports it through the v14
 *   document-level `init`/insert path.
 * - WRITES the result into the NEW generation (`edytor-v14:<name>`) as a
 *   single compacted snapshot row, then flips a `migration` record in the
 *   `custom` store to `active`.
 * - The legacy database is NEVER written to or deleted — rollback is a
 *   record flip plus clearing the new generation's rows.
 *
 * What does not survive (by design — this is a JSON-level import):
 *
 * - CRDT item identities (`client:clock`), CRDT history, and collaborative
 *   undo — the migrated doc is a fresh document containing the same logical
 *   content. Logical block/inline ids (`b_*`, `i_*`) DO survive as data.
 * - Presence/awareness state.
 * - Offline v13 writes made AFTER the cutover: they land in the untouched
 *   legacy generation and are not live-mapped (recovery path: re-run
 *   `migrate({force:true})` — it re-imports the legacy doc wholesale).
 *
 * Arbitration: the `migration` record in the new generation's `custom`
 * store is claimed inside ONE `readwrite` IndexedDB transaction — IDB
 * serializes read-write transactions over the same store, so the first tab
 * to commit `{status:'pending', owner, leaseUntil}` owns the migration.
 * Other callers observe the record and wait for `active` (poll +
 * BroadcastChannel nudge on room `edytor-v14-migration:<name>`). A pending
 * lease that expires (crashed tab) is reclaimed by the next caller.
 *
 * Interruption safety: every phase is idempotent. `persist` writes the
 * snapshot under a FIXED updates-store key (never clears the store — a
 * live v14 provider's rows must survive a late migration); `activate` is a
 * single record write. Resuming after a crash re-runs the whole import into
 * the same generation — it cannot duplicate identities because the migrated
 * doc is rebuilt from scratch and overwrites the same snapshot key.
 *
 * Live-generation coexistence (gate-2): a provider that already opened the
 * generation keeps its rows. The migrated snapshot never contains the
 * deterministic `edytor:bootstrap` block — non-empty legacy content is
 * imported under its own ids, and an empty legacy doc persists as a
 * meta-only update — so merging snapshot + live rows can never LWW-race
 * the live doc's bootstrap identity.
 */
import * as idb from 'lib0-v14/indexeddb';
import * as bc from 'lib0-v14/broadcastchannel';
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';
import * as f from 'lib0-v14/function';
import type { EngineApi, EngineDoc, YDoc } from '../engine-api.js';
import { bindEdytorDoc } from '../edytor-doc.js';
import { bindLegacyReader } from './legacy-schema.js';
import {
	generationDbName,
	writeProtocolVersion,
	GENERATION_KEY,
	GENERATION_RECORD
} from '../protocols/envelope.js';
import type { BlockSpec, ContentItem } from '../placement/model.js';
import {
	cloneJson,
	type JSONBlock,
	type JSONDoc,
	type JSONInlineBlock,
	type JSONText
} from '../../utils/json.js';

const updatesStoreName = 'updates';
const customStoreName = 'custom';
const MIGRATION_KEY = 'migration';
/** messageType inside the version envelope for migration announcements. */
const messageMigration = 7;
/**
 * Fixed updates-store key for the migrated snapshot row. The store is
 * auto-increment (generated keys start at 1), so key `0` never collides
 * with provider rows — re-runs overwrite the same key (idempotent) while
 * live provider rows are preserved (additive persist, no `clear()`).
 * A provider-side compaction snapshot still absorbs the migrated content,
 * so the row may later be trimmed without loss.
 */
const MIGRATION_SNAPSHOT_KEY = 0;

export const migrationBcRoom = (name: string): string => `edytor-v14-migration:${name}`;

export type MigrationStatus = 'none' | 'pending' | 'active' | 'failed' | 'rolledback';

export type MigrationRecord = {
	v: 1;
	status: MigrationStatus;
	/** Claim owner (a random per-call id). */
	owner?: string;
	/** Claim expiry — unix ms after which a stale `pending` may be reclaimed. */
	leaseUntil?: number;
	migratedAt?: number;
	rolledbackAt?: number;
	sourceRows?: number;
	sourceBytes?: number;
	error?: string;
};

export type MigrationPhase =
	| 'claim'
	| 'read'
	| 'materialize'
	| 'rebuild'
	| 'verify'
	| 'persist'
	| 'activate'
	| 'announce';

export type MigrateResult = {
	/** `active` also covers `already-active` and `nothing-to-migrate`. */
	status: 'active' | 'busy' | 'failed' | 'rolledback';
	alreadyActive?: boolean;
	empty?: boolean;
	/** The rebuilt v14 doc (present when this call ran the import). */
	doc?: YDoc;
	/** The materialized logical JSON (present when this call ran the import). */
	json?: JSONDoc;
	sourceRows?: number;
	error?: string;
};

export type MigrateOptions = {
	/** Legacy database name — defaults to the logical `name` (the v13 layout). */
	sourceName?: string;
	/** Claim lease in ms (default 30s); a crashed owner's claim expires after this. */
	leaseMs?: number;
	/** How long to wait for another owner's migration to activate (default 30s). */
	waitMs?: number;
	/** Poll interval while waiting (default 150ms). */
	pollMs?: number;
	/** Claim owner id (default: random per call). */
	owner?: string;
	/** Re-run even when already `active` or `rolledback`. */
	force?: boolean;
	/** Don't wait for a live `pending` claim — return `busy` immediately. */
	wait?: boolean;
	/** Phase observer — invoked BEFORE each phase; throwing simulates a crash. */
	onPhase?: (phase: MigrationPhase) => void | Promise<void>;
};

const randomOwner = (): string =>
	`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const decodeStoredUpdate = (update: unknown): Uint8Array => {
	if (update instanceof ArrayBuffer) return new Uint8Array(update);
	if (update instanceof Uint8Array) return update;
	throw new TypeError('Stored Yjs update is not binary data');
};

const openGenerationDB = (dbName: string): Promise<IDBDatabase> =>
	idb.openDB(dbName, (db) =>
		idb.createStores(db, [['updates', { autoIncrement: true }], ['custom']])
	);

/**
 * Open the legacy DB read-only WITHOUT creating it. `idb.openDB(name,
 * () => {})` on a never-existing name leaves a v1 database with no object
 * stores behind — poison for a later v13 provider open, whose store
 * creation only runs inside `onupgradeneeded` (gate-2 legacy-DB probe).
 * Opening with no explicit version and ABORTING the upgrade transaction
 * rolls creation back entirely: existing DBs open normally, absent ones
 * yield `null`.
 */
const openLegacyDb = (dbName: string): Promise<IDBDatabase | null> => {
	const idbFactory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
	if (!idbFactory) return Promise.resolve(null);
	return new Promise((resolve, reject) => {
		let abortedCreate = false;
		const request = idbFactory.open(dbName);
		request.onupgradeneeded = () => {
			// Brand-new database — abort so no store-less shell persists.
			abortedCreate = true;
			request.transaction?.abort();
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => (abortedCreate ? resolve(null) : reject(request.error));
		request.onblocked = () =>
			reject(new Error(`legacy database "${dbName}" is blocked by an open connection`));
	});
};

const readMigrationRecord = (db: IDBDatabase): Promise<MigrationRecord | undefined> => {
	const [custom] = idb.transact(db, [customStoreName], 'readonly');
	return idb.rtop(custom.get(MIGRATION_KEY)) as Promise<MigrationRecord | undefined>;
};

/**
 * JSONDoc → BlockSpec conversion. Logical ids are preserved as data
 * (`b_*`/`i_*` keep their values); blocks lacking an id get a deterministic
 * `mig-` fallback so concurrent migrators produce identical specs.
 */
const blockToSpec = (b: JSONBlock, path: string): BlockSpec => {
	const spec: BlockSpec = {
		id: b.id ?? `mig-${path}`,
		type: b.type
	};
	if (b.data != null) spec.data = cloneJson(b.data) as Record<string, unknown>;
	if (b.content && b.content.length > 0) {
		spec.content = b.content.map((item, i): ContentItem => {
			if ('text' in item) {
				const t: JSONText = item;
				const ci: ContentItem = { kind: 'text', text: t.text };
				if (t.marks) ci.marks = cloneJson(t.marks) as Record<string, unknown>;
				return ci;
			}
			const inline: JSONInlineBlock = item;
			return {
				kind: 'inline',
				id: inline.id ?? `mig-${path}-i${i}`,
				type: inline.type,
				...(inline.data != null ? { data: cloneJson(inline.data) as Record<string, unknown> } : {})
			};
		});
	}
	if (b.children && b.children.length > 0) {
		spec.children = b.children.map((c, i) => blockToSpec(c, `${path}.${i}`));
	}
	return spec;
};

/**
 * Apply the SAME `mig-` fallback ids `blockToSpec` assigns to the expected
 * JSON — verification compares the produced document against THIS
 * normalized shape, so an id-less legacy block verifies instead of
 * dead-ending on `produced.id='mig-…'` vs `expected.id=undefined`
 * (gate-2 verify probe).
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

	const announce = (name: string, record: MigrationRecord): void => {
		const encoder = encoding.createEncoder();
		writeProtocolVersion(encoder);
		encoding.writeVarUint(encoder, messageMigration);
		encoding.writeVarString(encoder, JSON.stringify(record));
		bc.publish(migrationBcRoom(name), encoding.toUint8Array(encoder), null);
	};

	/**
	 * Read the migration record of a generation DB. `status:'none'` covers a
	 * missing record AND a missing DB (nothing has ever been migrated).
	 */
	const status = async (name: string): Promise<MigrationRecord> => {
		const dbName = generationDbName(name);
		const db = await openGenerationDB(dbName);
		try {
			return (await readMigrationRecord(db)) ?? { v: 1, status: 'none' };
		} finally {
			db.close();
		}
	};

	/**
	 * Wait until the generation's migration record leaves `pending` (or
	 * appears as `active`/`failed`/`rolledback`). Polls `custom` every
	 * `pollMs` and subscribes to the migration BC room for the fast path.
	 */
	const waitForSettled = (
		name: string,
		{ waitMs = 30_000, pollMs = 150 }: { waitMs?: number; pollMs?: number } = {}
	): Promise<MigrationRecord> => {
		const dbName = generationDbName(name);
		const room = migrationBcRoom(name);
		return new Promise((resolve) => {
			let settled = false;
			let db: IDBDatabase | null = null;
			let timer: ReturnType<typeof setTimeout> | null = null;
			let interval: ReturnType<typeof setInterval> | null = null;
			const deadline = Date.now() + waitMs;
			const sub = () => void check();
			const finish = (rec: MigrationRecord) => {
				if (settled) return;
				settled = true;
				if (interval) clearInterval(interval);
				if (timer) clearTimeout(timer);
				bc.unsubscribe(room, sub);
				db?.close();
				resolve(rec);
			};
			const check = async () => {
				if (!db) return;
				try {
					const rec = (await readMigrationRecord(db as IDBDatabase)) ?? {
						v: 1 as const,
						status: 'none' as const
					};
					// A live pending claim keeps us waiting; an expired lease is
					// already reclaimable — treat it as settled immediately.
					const leaseExpired = rec.status === 'pending' && (rec.leaseUntil ?? 0) <= Date.now();
					if (rec.status !== 'pending' || leaseExpired || Date.now() > deadline) finish(rec);
				} catch {
					if (Date.now() > deadline) finish({ v: 1, status: 'failed', error: 'poll failed' });
				}
			};
			openGenerationDB(dbName).then((opened) => {
				db = opened;
				bc.subscribe(room, sub);
				interval = setInterval(() => void check(), pollMs);
				timer = setTimeout(() => void check(), Math.min(pollMs, 50));
				void check();
			});
		});
	};

	/**
	 * Run the migration for logical document `name`.
	 *
	 * - `active` already → `{status:'active', alreadyActive:true}` (idempotent).
	 * - Another owner mid-flight → waits for settle, then re-reads (with
	 *   `wait:false` → `{status:'busy'}`).
	 * - `rolledback` → `{status:'rolledback'}` unless `force`.
	 * - Otherwise claims, imports, verifies, persists, activates.
	 */
	const migrate = async (name: string, opts: MigrateOptions = {}): Promise<MigrateResult> => {
		const {
			sourceName = name,
			leaseMs = 30_000,
			waitMs = 30_000,
			pollMs = 150,
			owner = randomOwner(),
			force = false,
			wait = true,
			onPhase
		} = opts;
		const dbName = generationDbName(name);
		const phase = async (p: MigrationPhase) => {
			await onPhase?.(p);
		};

		// ── claim ──────────────────────────────────────────────────────────
		await phase('claim');
		const db = await openGenerationDB(dbName);
		let claimed = false;
		try {
			for (;;) {
				// One readwrite transaction: read + conditional write is atomic —
				// IDB serializes read-write transactions over the same store.
				const [custom] = idb.transact(db, [customStoreName]);
				const outcome = await (
					idb.rtop(custom.get(MIGRATION_KEY)) as Promise<MigrationRecord | undefined>
				).then((rec) => {
					const stale = rec?.status === 'pending' && (rec.leaseUntil ?? 0) <= Date.now();
					const claimable =
						rec == null ||
						force ||
						stale ||
						rec.status === 'failed' ||
						(rec.status !== 'active' && rec.status !== 'pending' && rec.status !== 'rolledback');
					if (claimable) {
						const next: MigrationRecord = {
							v: 1,
							status: 'pending',
							owner,
							leaseUntil: Date.now() + leaseMs
						};
						return idb.rtop(custom.put(next, MIGRATION_KEY)).then(() => 'claimed' as const);
					}
					return rec.status as MigrationStatus;
				});

				if (outcome === 'claimed') {
					claimed = true;
					break;
				}
				if (outcome === 'active' && !force) {
					return { status: 'active', alreadyActive: true };
				}
				if (outcome === 'rolledback' && !force) {
					return { status: 'rolledback' };
				}
				if (outcome === 'pending' && !wait) {
					return { status: 'busy' };
				}
				// Someone else owns the claim (or a race resolved) — wait for
				// settlement, then loop to re-read the final record.
				const settled = await waitForSettled(name, { waitMs, pollMs });
				if (settled.status === 'active') return { status: 'active', alreadyActive: true };
				if (settled.status === 'pending' && !wait) return { status: 'busy' };
				if (settled.status === 'rolledback' && !force) return { status: 'rolledback' };
				// stale/failed/expired — loop to try claiming again
			}

			// Stamp the generation record immediately — the claimed DB is a
			// v14 generation from this point on, so a provider opening it
			// (e.g. after `activate`) passes the storage gate.
			{
				const [custom] = idb.transact(db, [customStoreName]);
				await idb.rtop(custom.put({ ...GENERATION_RECORD }, GENERATION_KEY));
			}

			// ── read legacy rows ─────────────────────────────────────────────
			await phase('read');
			const legacyRows = await (async (): Promise<Uint8Array[]> => {
				// openLegacyDb never CREATES the legacy database — an absent
				// one resolves to null (no store-less shell left behind).
				const dbLegacy = await openLegacyDb(sourceName);
				if (dbLegacy === null) return [];
				try {
					if (!dbLegacy.objectStoreNames.contains(updatesStoreName)) return [];
					const [updatesStore] = idb.transact(dbLegacy, [updatesStoreName], 'readonly');
					const rows = await idb.getAll(updatesStore);
					return (rows as unknown[]).map(decodeStoredUpdate);
				} finally {
					dbLegacy.close();
				}
			})();

			const markFailed = async (error: string): Promise<MigrateResult> => {
				const [custom] = idb.transact(db, [customStoreName]);
				const rec: MigrationRecord = {
					v: 1,
					status: 'failed',
					owner,
					error,
					migratedAt: Date.now()
				};
				await idb.rtop(custom.put(rec, MIGRATION_KEY));
				announce(name, rec);
				return { status: 'failed', error };
			};

			if (legacyRows.length === 0) {
				// Nothing to carry over — the new generation is authoritative and
				// empty; activate so subsequent opens skip the whole flow.
				await phase('activate');
				const [custom] = idb.transact(db, [customStoreName]);
				const rec: MigrationRecord = {
					v: 1,
					status: 'active',
					owner,
					migratedAt: Date.now(),
					sourceRows: 0,
					sourceBytes: 0
				};
				await idb.rtop(custom.put(rec, MIGRATION_KEY));
				await phase('announce');
				announce(name, rec);
				return { status: 'active', empty: true, sourceRows: 0 };
			}

			// ── materialize ──────────────────────────────────────────────────
			await phase('materialize');
			let json: JSONDoc;
			try {
				// Throws PendingLegacyUpdatesError when rows carry structs whose
				// CRDT deps never landed — a truncated document must not
				// activate (retryable: a later run sees the deps if they sync).
				json = reader.readLegacyJSON(legacyRows);
			} catch (error) {
				return markFailed(`legacy decode failed: ${(error as Error).message}`);
			}

			// ── rebuild through the document-level init/insert path ──────────
			await phase('rebuild');
			const doc = new Y.Doc();
			const specs = json.children.map((b, i) => blockToSpec(b, `${i}`));
			if (specs.length === 0) {
				// Meta-only snapshot: a content-free migration stamps the
				// version record WITHOUT the deterministic bootstrap block, so
				// merging into a live generation can never LWW-race a
				// provider's own `edytor:bootstrap` node (gate-2 live probe).
				(doc as unknown as EngineDoc).transact(() => {
					const meta = (doc as unknown as EngineDoc).get(edytorDoc.META_KEY);
					meta.setAttr(edytorDoc.SCHEMA.metaAttrs.version, edytorDoc.SCHEMA_VERSION);
					meta.setAttr(edytorDoc.SCHEMA.metaAttrs.schema, edytorDoc.SCHEMA_NAME);
				});
			} else {
				edytorDoc.init(doc as unknown as EngineDoc, { content: specs });
			}
			const snapshot = Y.encodeStateAsUpdate(doc);

			// ── verify: materialize the NEW doc and compare logical JSON ─────
			await phase('verify');
			const verifyDoc = new Y.Doc();
			Y.applyUpdate(verifyDoc, snapshot);
			const produced = edytorDoc.create(verifyDoc as unknown as EngineDoc).toJSON();
			// Expected JSON carries the SAME `mig-` fallback ids blockToSpec
			// assigned — an id-less legacy block verifies instead of
			// dead-ending on produced-vs-expected id mismatch.
			const expected: JSONDoc = {
				children: json.children.map((b, i) => withFallbackIds(b, `${i}`))
			};
			if (!f.equalityDeep(produced, expected)) {
				return markFailed(
					'verification failed: migrated document does not reproduce the legacy logical JSON'
				);
			}

			// ── persist snapshot into the new generation ─────────────────────
			await phase('persist');
			{
				const [updatesStore] = idb.transact(db, [updatesStoreName]);
				// ADDITIVE persist (gate-2 live-generation probe): the snapshot
				// is written under a FIXED key so re-runs are idempotent, and
				// the store is NEVER cleared — rows a live v14 provider already
				// wrote survive the migration and keep integrating.
				const stored = new Uint8Array(snapshot.byteLength);
				stored.set(snapshot);
				await idb.rtop(updatesStore.put(stored.buffer, MIGRATION_SNAPSHOT_KEY));
			}

			// ── activate the generation pointer ──────────────────────────────
			await phase('activate');
			const sourceBytes = legacyRows.reduce((n, r) => n + r.byteLength, 0);
			{
				const [custom] = idb.transact(db, [customStoreName]);
				const rec: MigrationRecord = {
					v: 1,
					status: 'active',
					owner,
					migratedAt: Date.now(),
					sourceRows: legacyRows.length,
					sourceBytes
				};
				await idb.rtop(custom.put(rec, MIGRATION_KEY));
				await phase('announce');
				announce(name, rec);
			}
			return {
				status: 'active',
				doc,
				json: expected,
				sourceRows: legacyRows.length
			};
		} finally {
			db.close();
		}
	};

	/**
	 * Roll back a migration: mark the generation `rolledback` and clear its
	 * update rows. The legacy generation is untouched (it never is), so a
	 * v13 stack works again on its own data. A subsequent `migrate` must
	 * pass `force:true` — rollback is an explicit operator decision.
	 */
	const rollback = async (name: string): Promise<void> => {
		const db = await openGenerationDB(generationDbName(name));
		try {
			const [updatesStore, custom] = idb.transact(db, [updatesStoreName, customStoreName]);
			const rec: MigrationRecord = {
				v: 1,
				status: 'rolledback',
				rolledbackAt: Date.now()
			};
			await idb.rtop(custom.put(rec, MIGRATION_KEY));
			await idb.rtop(updatesStore.clear());
			announce(name, rec);
		} finally {
			db.close();
		}
	};

	return { migrate, rollback, status, waitForSettled };
};
