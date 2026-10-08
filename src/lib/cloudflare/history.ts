/**
 * Version history (`room.history.*` in
 * `docs/editor-delete-contract.md`): the half-day slots, their keys and
 * their metadata, and the stores a room keeps its versions in
 * (`room.history.store`): {@link HistoryStore}, and the adapters
 * {@link kvHistory}, {@link r2History} and {@link roomHistory}. Pure
 * helpers and adapters the room (`DocumentRoom.ts`) schedules and writes
 * with; Worker-safe (`Intl` only, no timers).
 */

/**
 * The structural subset of a KV namespace {@link kvHistory} uses — a
 * Workers `KVNamespace` binding satisfies it, and so does an in-memory
 * fake. As `history.store` it goes through {@link kvHistory}.
 */
export type KVLike = {
	put(
		key: string,
		value: ArrayBuffer | ArrayBufferView | string,
		options?: { expirationTtl?: number; metadata?: unknown }
	): Promise<unknown>;
	get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
	list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
		keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
		list_complete: boolean;
		cursor?: string;
	}>;
	delete?(key: string): Promise<unknown>;
};

/** The structural subset of an R2 bucket {@link r2History} uses (a Workers `R2Bucket` binding satisfies it). */
export type R2BucketLike = {
	put(
		key: string,
		value: ArrayBuffer | ArrayBufferView,
		options?: { customMetadata?: Record<string, string> }
	): Promise<unknown>;
	get(key: string): Promise<{
		arrayBuffer(): Promise<ArrayBuffer>;
		customMetadata?: Record<string, string>;
	} | null>;
	list(options?: {
		prefix?: string;
		cursor?: string;
		limit?: number;
		include?: Array<'httpMetadata' | 'customMetadata'>;
	}): Promise<{
		objects: Array<{ key: string; customMetadata?: Record<string, string> }>;
		truncated: boolean;
		cursor?: string;
	}>;
	delete(keys: string | string[]): Promise<unknown>;
};

/** One stored version as a {@link HistoryStore} lists it. */
export type HistoryStoreRecord = {
	key: string;
	/** When it expires (ms since the epoch); `null` when the store does not know (it never expires by the room). */
	expiresAt: number | null;
	/** The metadata the room wrote with it ({@link HistoryMetadata}). */
	metadata: unknown;
};

/**
 * Where a room keeps its versions (`room.history.store`). Any object with
 * these members works; the room owns everything else: the keys (one room's
 * share a prefix), the values (compressed bytes, at most `maxValueBytes`),
 * the metadata, and the retention — it never lists or reads a version past
 * its `expiresAt`, and, unless the store expires values itself
 * (`nativeTtl`), its alarm deletes each one when it expires.
 */
export type HistoryStore = {
	/** The largest value the store takes: a larger version is skipped (logged `history`), never split. */
	readonly maxValueBytes: number;
	/** The store deletes a value at its `expiresAt` itself (KV's TTL): the room's alarm never deletes. */
	readonly nativeTtl?: boolean;
	/** Store `value` at `key` (replacing any value there) with its expiry and metadata. */
	put(
		key: string,
		value: Uint8Array,
		options: { expiresAt: number; metadata: HistoryMetadata }
	): Promise<void>;
	/** The value at `key`, with its expiry when the store knows it, or `null`. */
	get(key: string): Promise<{ value: Uint8Array; expiresAt: number | null } | null>;
	/** One page of the keys starting with `prefix`; `cursor` continues a listing, and is absent on its last page. */
	list(
		prefix: string,
		cursor?: string
	): Promise<{ entries: HistoryStoreRecord[]; cursor?: string }>;
	/** Delete `key` (a missing key is no error). */
	delete(key: string): Promise<void>;
};

/** What a {@link HistoryStoreFactory} gets: the room's own storage. */
export type HistoryRoomStorage = {
	readonly sql: SqlStorage;
	transactionSync<T>(closure: () => T): T;
	/** The room's table prefix (`''` for `DocumentRoom`, `'edytor_'` by default for `attachRoom`). */
	readonly tablePrefix: string;
};

/** A store built from the room's own storage at first use ({@link roomHistory}). */
export type HistoryStoreFactory = (room: HistoryRoomStorage) => HistoryStore;

/** The `history` option: where and how long the room keeps its versions. */
export type HistoryOptions = {
	/**
	 * The store: a {@link HistoryStore} ({@link kvHistory}, {@link r2History}
	 * or your own) or {@link roomHistory}`()`. A KV namespace goes through
	 * {@link kvHistory}.
	 */
	store: HistoryStore | HistoryStoreFactory;
	/** How long a version is kept, in days (default 30). */
	retentionDays?: number;
	/** The IANA time zone whose noon and midnight end the slots (default `'UTC'`). */
	timeZone?: string;
	/**
	 * The largest value written, in bytes; can only lower the store's own
	 * `maxValueBytes`. A larger version is skipped.
	 */
	maxValueBytes?: number;
};

/** KV's largest value: a version above it is skipped, never split. */
export const HISTORY_MAX_VALUE_BYTES = 25 * 1024 * 1024;
/** KV's largest metadata (serialized JSON); every store gets metadata under it. */
export const HISTORY_MAX_METADATA_BYTES = 1024;
/** The largest value {@link r2History} writes (R2 takes more; the room holds a version in memory). */
export const R2_HISTORY_MAX_VALUE_BYTES = 128 * 1024 * 1024;
/** {@link roomHistory}'s defaults: the largest version, and the most its table holds. */
export const ROOM_HISTORY_MAX_VALUE_BYTES = 32 * 1024 * 1024;
export const ROOM_HISTORY_MAX_BYTES = 256 * 1024 * 1024;
/** KV's longest key, in bytes. */
const MAX_KEY_BYTES = 512;
/** The default retention, in days (also the default purge horizon). */
export const DEFAULT_RETENTION_DAYS = 30;

/** A half of a local date: `am` before 12:00, `pm` until 24:00. */
export type Slot = 'am' | 'pm';

/** One stored version, as `listHistory` returns it. */
export type HistoryEntry = {
	/** The store key (`history/<room>/<YYYY-MM-DD>-am|pm`). */
	key: string;
	/** The local date, `YYYY-MM-DD`, in the room's time zone. */
	date: string;
	slot: Slot;
	/** Stored (compressed) bytes. */
	bytes: number;
	/** Visible blocks. */
	blocks: number;
	/** The verified users whose edits the room stored during the slot. */
	editors: string[];
	/** Editors left out to keep the metadata under KV's limit. */
	more: number;
	/** When the version was written (ms since the epoch). */
	at: number;
	/** When it expires (ms since the epoch), `null` when its store does not say. */
	expiresAt: number | null;
};

/** A version's metadata, as the room writes it to the store. */
export type HistoryMetadata = {
	bytes: number;
	blocks: number;
	editors: string[];
	more?: number;
	at: number;
};

const formats = new Map<string, Intl.DateTimeFormat>();

/** The formatter of `timeZone` (throws `RangeError` for an unknown zone). */
const formatOf = (timeZone: string): Intl.DateTimeFormat => {
	let format = formats.get(timeZone);
	if (format === undefined) {
		format = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit'
		});
		formats.set(timeZone, format);
	}
	return format;
};

/** Whether `timeZone` is a zone this runtime knows. */
export const validTimeZone = (timeZone: unknown): timeZone is string => {
	if (typeof timeZone !== 'string' || timeZone === '') return false;
	try {
		formatOf(timeZone);
		return true;
	} catch {
		return false;
	}
};

/** The local date and half of instant `t` in `timeZone`. */
export const slotAt = (t: number, timeZone: string): { date: string; slot: Slot } => {
	const parts: Record<string, string> = {};
	for (const { type, value } of formatOf(timeZone).formatToParts(t)) parts[type] = value;
	const year = parts.year.padStart(4, '0');
	return {
		date: `${year}-${parts.month}-${parts.day}`,
		slot: Number(parts.hour) < 12 ? 'am' : 'pm'
	};
};

const sameSlot = (a: { date: string; slot: Slot }, b: { date: string; slot: Slot }) =>
	a.date === b.date && a.slot === b.slot;

/**
 * The first instant after `t` that falls in another slot: the local noon
 * or midnight ending `t`'s slot, found by bisection over the zone's own
 * clock (any offset, daylight saving included), to the millisecond.
 */
export const slotEnd = (t: number, timeZone: string): number => {
	const start = slotAt(t, timeZone);
	let lo = t;
	// A slot is at most 13 hours long (12, plus a daylight-saving hour).
	let hi = t + 14 * 3600_000;
	while (sameSlot(slotAt(hi, timeZone), start)) hi += 12 * 3600_000;
	while (hi - lo > 1) {
		const mid = lo + Math.floor((hi - lo) / 2);
		if (sameSlot(slotAt(mid, timeZone), start)) lo = mid;
		else hi = mid;
	}
	return hi;
};

/** The key prefix of `room`'s versions (its id percent-encoded). */
export const historyPrefix = (room: string): string => `history/${encodeURIComponent(room)}/`;

/** The key of `room`'s version for `slot` (`null` past KV's key limit). */
export const historyKey = (room: string, slot: { date: string; slot: Slot }): string | null => {
	const key = `${historyPrefix(room)}${slot.date}-${slot.slot}`;
	return new TextEncoder().encode(key).length <= MAX_KEY_BYTES ? key : null;
};

/** The date and slot a key of `room` names, or `null` for any other key. */
export const parseHistoryKey = (
	room: string,
	key: unknown
): { date: string; slot: Slot } | null => {
	if (typeof key !== 'string') return null;
	const prefix = historyPrefix(room);
	if (!key.startsWith(prefix)) return null;
	const match = /^(\d{4}-\d{2}-\d{2})-(am|pm)$/.exec(key.slice(prefix.length));
	return match ? { date: match[1], slot: match[2] as Slot } : null;
};

/**
 * Metadata under KV's 1,024 bytes: the editors that fit, in order, and how
 * many were left out (`more`).
 */
export const fitMetadata = (
	meta: Omit<HistoryMetadata, 'more'>,
	limit = HISTORY_MAX_METADATA_BYTES
): HistoryMetadata => {
	const size = (m: HistoryMetadata) => new TextEncoder().encode(JSON.stringify(m)).length;
	const editors = [...meta.editors];
	let fitted: HistoryMetadata = { ...meta, editors };
	while (size(fitted) > limit && editors.length > 0) {
		editors.pop();
		fitted = { ...meta, editors: [...editors], more: meta.editors.length - editors.length };
	}
	return fitted;
};

/** A listed key as a {@link HistoryEntry} (`null` for a key of another shape). */
export const historyEntry = (
	room: string,
	name: string,
	metadata: unknown,
	expiresAt: number | null = null
): HistoryEntry | null => {
	const slot = parseHistoryKey(room, name);
	if (slot === null) return null;
	const m = (metadata ?? {}) as Partial<HistoryMetadata>;
	const number = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
	return {
		key: name,
		date: slot.date,
		slot: slot.slot,
		bytes: number(m.bytes),
		blocks: number(m.blocks),
		editors: Array.isArray(m.editors) ? m.editors.filter((e) => typeof e === 'string') : [],
		more: number(m.more),
		at: number(m.at),
		expiresAt
	};
};

// ── Stores (`room.history.store`) ─────────────────────────────────────

const bytesOf = (value: ArrayBuffer | ArrayBufferView): Uint8Array =>
	value instanceof ArrayBuffer
		? new Uint8Array(value)
		: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

/** A finite number, or `null`. */
const finite = (value: unknown): number | null => {
	const n = typeof value === 'string' && value !== '' ? Number(value) : value;
	return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/**
 * Versions in a Workers KV namespace (the room history's first store): KV's
 * TTL expires them (`nativeTtl`, `expirationTtl` = the retention, at least
 * KV's 60 s), its listing's `expiration` is each one's `expiresAt`, its
 * metadata the room's. Values up to KV's 25 MiB. Versions written by
 * 0.1.0-next.24 and next.25 (a bare namespace as the store) read as they are.
 */
export const kvHistory = (namespace: KVLike): HistoryStore => ({
	maxValueBytes: HISTORY_MAX_VALUE_BYTES,
	nativeTtl: true,
	async put(key, value, { expiresAt, metadata }) {
		const ttl = Math.max(60, Math.ceil((expiresAt - metadata.at) / 1000));
		await namespace.put(key, value, { expirationTtl: ttl, metadata });
	},
	async get(key) {
		const value = await namespace.get(key, 'arrayBuffer');
		return value === null ? null : { value: new Uint8Array(value), expiresAt: null };
	},
	async list(prefix, cursor) {
		const page = await namespace.list({ prefix, cursor });
		return {
			entries: page.keys.map(({ name, expiration, metadata }) => {
				const seconds = finite(expiration);
				return { key: name, expiresAt: seconds === null ? null : seconds * 1000, metadata };
			}),
			cursor: page.list_complete ? undefined : page.cursor
		};
	},
	async delete(key) {
		await namespace.delete?.(key);
	}
});

/** The R2 custom metadata keys {@link r2History} writes. */
const R2_META = 'edytor';
const R2_EXPIRES = 'edytor-expires';

/**
 * Versions in an R2 bucket: one object per version, the room's metadata
 * and the expiry in its custom metadata (`edytor`, `edytor-expires`), a
 * listing by prefix. R2 expires nothing by itself here, so the room's
 * alarm deletes each version at its expiry (an R2 lifecycle rule on the
 * `history/` prefix may also do it, a day late at most). Values up to
 * {@link R2_HISTORY_MAX_VALUE_BYTES}.
 */
export const r2History = (bucket: R2BucketLike): HistoryStore => ({
	maxValueBytes: R2_HISTORY_MAX_VALUE_BYTES,
	async put(key, value, { expiresAt, metadata }) {
		await bucket.put(key, value, {
			customMetadata: { [R2_META]: JSON.stringify(metadata), [R2_EXPIRES]: String(expiresAt) }
		});
	},
	async get(key) {
		const object = await bucket.get(key);
		if (object === null) return null;
		return {
			value: new Uint8Array(await object.arrayBuffer()),
			expiresAt: finite(object.customMetadata?.[R2_EXPIRES])
		};
	},
	async list(prefix, cursor) {
		const page = await bucket.list({ prefix, cursor, include: ['customMetadata'] });
		return {
			entries: page.objects.map(({ key, customMetadata }) => {
				let metadata: unknown = undefined;
				try {
					metadata = JSON.parse(customMetadata?.[R2_META] ?? 'null') ?? undefined;
				} catch {
					// another writer's object under the prefix: listed without metadata
				}
				return { key, expiresAt: finite(customMetadata?.[R2_EXPIRES]), metadata };
			}),
			cursor: page.truncated ? page.cursor : undefined
		};
	},
	async delete(key) {
		await bucket.delete(key);
	}
});

/** One row of {@link roomHistory}'s table is at most this (Durable Object SQLite rows: 2 MB). */
const ROOM_HISTORY_PART_BYTES = 1024 * 1024;
/** Keys a {@link roomHistory} listing page returns. */
const ROOM_HISTORY_PAGE = 100;

/**
 * Versions in the room's own SQLite storage, in its `history` table
 * (`edytor_history` with `attachRoom`'s default prefix): no binding.
 * A version is stored atomically (one `transactionSync`, split into rows
 * of 1 MiB under the platform's 2 MB). It is counted apart from the
 * document quota (`maxDocumentBytes` measures what clients send; history
 * is the room's own), against its own cap, `maxBytes` (default
 * {@link ROOM_HISTORY_MAX_BYTES}): a version that would pass it deletes
 * the oldest versions first. The room's alarm deletes each version at its
 * expiry. `maxValueBytes` (default {@link ROOM_HISTORY_MAX_VALUE_BYTES})
 * caps one version. A generation cutover (`reset()`) keeps the table.
 */
export const roomHistory =
	(options: { maxBytes?: number; maxValueBytes?: number } = {}): HistoryStoreFactory =>
	({ sql, transactionSync, tablePrefix }) => {
		const positive = (value: unknown, fallback: number) =>
			typeof value === 'number' && Number.isFinite(value) && value > 0
				? Math.floor(value)
				: fallback;
		const maxBytes = positive(options.maxBytes, ROOM_HISTORY_MAX_BYTES);
		const maxValueBytes = Math.min(
			positive(options.maxValueBytes, ROOM_HISTORY_MAX_VALUE_BYTES),
			maxBytes
		);
		if (!/^\w*$/.test(tablePrefix)) throw new Error(`invalid table prefix ${tablePrefix}`);
		const table = `${tablePrefix}history`;
		let created = false;
		const ready = () => {
			if (created) return;
			sql.exec(
				`CREATE TABLE IF NOT EXISTS ${table} (
					key TEXT NOT NULL,
					part INTEGER NOT NULL,
					parts INTEGER NOT NULL,
					at INTEGER NOT NULL,
					expires_at INTEGER NOT NULL,
					metadata TEXT NOT NULL,
					value BLOB NOT NULL,
					PRIMARY KEY (key, part)
				)`
			);
			created = true;
		};
		return {
			maxValueBytes,
			async put(key, value, { expiresAt, metadata }) {
				if (value.length > maxValueBytes) {
					throw new Error(`version of ${value.length} bytes over ${maxValueBytes}`);
				}
				ready();
				const parts = Math.max(1, Math.ceil(value.length / ROOM_HISTORY_PART_BYTES));
				transactionSync(() => {
					sql.exec(`DELETE FROM ${table} WHERE key = ?`, key);
					for (let part = 0; part < parts; part++) {
						const slice = value.subarray(
							part * ROOM_HISTORY_PART_BYTES,
							(part + 1) * ROOM_HISTORY_PART_BYTES
						);
						sql.exec(
							`INSERT INTO ${table} (key, part, parts, at, expires_at, metadata, value) VALUES (?, ?, ?, ?, ?, ?, ?)`,
							key,
							part,
							parts,
							metadata.at,
							expiresAt,
							JSON.stringify(metadata),
							slice
						);
					}
					// The cap: the oldest other versions go first.
					const total = () =>
						sql.exec<{ n: number | null }>(`SELECT SUM(length(value)) AS n FROM ${table}`).one()
							.n ?? 0;
					while (total() > maxBytes) {
						const oldest = sql
							.exec<{
								key: string;
							}>(`SELECT key FROM ${table} WHERE key != ? ORDER BY at, key LIMIT 1`, key)
							.toArray()[0];
						if (oldest === undefined) break;
						sql.exec(`DELETE FROM ${table} WHERE key = ?`, oldest.key);
					}
				});
			},
			async get(key) {
				ready();
				const rows = sql
					.exec<{
						part: number;
						parts: number;
						expires_at: number;
						value: ArrayBuffer;
					}>(`SELECT part, parts, expires_at, value FROM ${table} WHERE key = ? ORDER BY part`, key)
					.toArray();
				if (rows.length === 0 || rows.length !== rows[0].parts) return null;
				const value = new Uint8Array(rows.reduce((n, row) => n + row.value.byteLength, 0));
				let at = 0;
				for (const row of rows) {
					value.set(bytesOf(row.value), at);
					at += row.value.byteLength;
				}
				return { value, expiresAt: rows[0].expires_at };
			},
			async list(prefix, cursor) {
				ready();
				const rows = sql
					.exec<{
						key: string;
						expires_at: number;
						metadata: string;
					}>(
						`SELECT key, expires_at, metadata FROM ${table} WHERE part = 0 AND substr(key, 1, ?) = ? AND key > ? ORDER BY key LIMIT ?`,
						prefix.length,
						prefix,
						cursor ?? '',
						ROOM_HISTORY_PAGE + 1
					)
					.toArray();
				const page = rows.slice(0, ROOM_HISTORY_PAGE);
				return {
					entries: page.map((row) => ({
						key: row.key,
						expiresAt: row.expires_at,
						metadata: JSON.parse(row.metadata)
					})),
					cursor: rows.length > ROOM_HISTORY_PAGE ? page.at(-1)!.key : undefined
				};
			},
			async delete(key) {
				ready();
				sql.exec(`DELETE FROM ${table} WHERE key = ?`, key);
			}
		};
	};

/** A {@link HistoryStore} (its numeric `maxValueBytes` and its `delete` say so). */
const isHistoryStore = (store: unknown): store is HistoryStore =>
	typeof (store as HistoryStore | null)?.maxValueBytes === 'number' &&
	typeof (store as HistoryStore).delete === 'function';

/** An R2 bucket binding (it has multipart uploads; a KV namespace does not). */
export const isR2Bucket = (store: unknown): store is R2BucketLike =>
	typeof (store as { createMultipartUpload?: unknown } | null)?.createMultipartUpload ===
		'function' && typeof (store as R2BucketLike).list === 'function';

/**
 * The store `history.store` names, built for this room: a
 * {@link HistoryStore} as it is, a factory ({@link roomHistory}) over the
 * room's storage. Anything else (a KV namespace itself) is refused: it goes
 * through {@link kvHistory}.
 */
export const resolveHistoryStore = (
	store: HistoryOptions['store'],
	room: HistoryRoomStorage
): HistoryStore => {
	if (typeof store === 'function') return store(room);
	if (isHistoryStore(store)) return store;
	throw new TypeError(
		'history.store: not a HistoryStore. Wrap a KV namespace in kvHistory(namespace), an R2 bucket in r2History(bucket)'
	);
};
