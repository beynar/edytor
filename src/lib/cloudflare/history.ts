/**
 * Version history in KV (H11, `room.history.*` in
 * `docs/editor-delete-contract.md`): the half-day slots, their keys and
 * their metadata. Pure helpers the room (`DocumentRoom.ts`) schedules and
 * writes with; Worker-safe (`Intl` only, no timers).
 */

/**
 * The structural subset of a KV namespace the room uses — a Workers
 * `KVNamespace` binding satisfies it, and so does an in-memory fake.
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
};

/** The `history` option: where and how long the room keeps its versions. */
export type HistoryOptions = {
	/** The KV namespace (any {@link KVLike}). */
	store: KVLike;
	/** How long a version is kept, in days (KV's `expirationTtl`; default 30). */
	retentionDays?: number;
	/** The IANA time zone whose noon and midnight end the slots (default `'UTC'`). */
	timeZone?: string;
	/**
	 * The largest value written, in bytes; can only be lowered (default
	 * {@link HISTORY_MAX_VALUE_BYTES}, KV's limit). A larger version is skipped.
	 */
	maxValueBytes?: number;
};

/** KV's largest value: a version above it is skipped, never split. */
export const HISTORY_MAX_VALUE_BYTES = 25 * 1024 * 1024;
/** KV's largest metadata (serialized JSON). */
export const HISTORY_MAX_METADATA_BYTES = 1024;
/** KV's longest key, in bytes. */
const MAX_KEY_BYTES = 512;
/** The default retention, in days (also the default purge horizon). */
export const DEFAULT_RETENTION_DAYS = 30;

/** A half of a local date: `am` before 12:00, `pm` until 24:00. */
export type Slot = 'am' | 'pm';

/** One stored version, as `listHistory` returns it. */
export type HistoryEntry = {
	/** The KV key (`history/<room>/<YYYY-MM-DD>-am|pm`). */
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
};

/** A version's KV metadata. */
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
	metadata: unknown
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
		at: number(m.at)
	};
};
