/**
 * The room's version history (`room.history.*`): the half-day slots a
 * change opens and their close (a version written to the history store),
 * the retention sweep, reading a version, restoring one as a forward edit
 * and undoing that restore. The stores themselves are `../history.ts`.
 */
import { Y } from '../../crdt/engine.js';
import * as E from '../../crdt/protocol.js';
import { gunzip, packed } from '../../crdt/storage.js';
import type { JSONDoc, YDoc, YUndoManager } from '../../crdt/index.js';
import {
	PURGE_ORIGIN,
	RESTORE_ORIGIN,
	noTimers,
	type Attachment,
	type RestoreResult,
	type SocketIdentity
} from '../DocumentRoom.js';
import {
	DEFAULT_RETENTION_DAYS,
	HISTORY_MAX_VALUE_BYTES,
	fitMetadata,
	historyEntry,
	historyKey,
	historyPrefix,
	parseHistoryKey,
	resolveHistoryStore,
	slotAt,
	slotEnd,
	validTimeZone,
	type HistoryEntry,
	type HistoryOptions,
	type HistoryStore
} from '../history.js';
import { DAY, crdt, knob, type Decoded, type Item, type RoomContext } from './context.js';
import { admit, deletesUpdate, liveState } from './updates.js';

/** A retention sweep that failed runs again this much later (`room.history.retention`). */
const RETENTION_RETRY = 3600_000;

/** The last restore: its step, kept for `undoRestore`. */
type RestoreStep = {
	key: string;
	user: string | null;
	at: number;
	inserts: Decoded['ds'];
	deletes: Decoded['ds'];
};

/** A slot's version, captured at its close. */
type Version = { key: string; raw: Uint8Array; blocks: number; editors: string[]; at: number };

/** The history settings, resolved. */
type HistoryConfig = Required<Omit<HistoryOptions, 'store'>> & { store: HistoryStore };

export class RoomHistory {
	/** The verified users the open slot recorded (memory: a wake records them again, `OR IGNORE`). */
	readonly slotEditors = new Set<string>();
	/** Who the room writes for while a restore or its undo runs (the slot's editor). */
	private writer: string | null = null;
	/** The last restore's step (`room.history.undo`), read from the `restore` table at load. */
	private restoreStep: RestoreStep | null = null;
	/** The history recording restores (`RESTORE_ORIGIN`), on the live facade. */
	private restoreManager: YUndoManager | null = null;
	/** The version writes in flight (`historyWritten()`). */
	private writing: Promise<unknown> = Promise.resolve();
	private _config: HistoryConfig | null | undefined;

	constructor(private readonly room: RoomContext) {}

	/** The history settings, resolved at first use (`null`: none; an unknown time zone is noted `history`). */
	get config(): HistoryConfig | null {
		if (this._config !== undefined) return this._config;
		const room = this.room;
		const h = room.options.history;
		if (!h?.store) return (this._config = null);
		const timeZone = h.timeZone ?? 'UTC';
		if (!validTimeZone(timeZone)) {
			room.note({ reason: 'history', detail: { timeZone } });
			return (this._config = null);
		}
		let store: HistoryStore;
		try {
			store = resolveHistoryStore(h.store, {
				sql: room.sql,
				transactionSync: (closure) => room.ctx.storage.transactionSync(closure),
				tablePrefix: room.tablePrefix
			});
		} catch (error) {
			room.note({ reason: 'history', detail: { store: String(error) } });
			return (this._config = null);
		}
		const own = knob(store.maxValueBytes, HISTORY_MAX_VALUE_BYTES, Number.MAX_SAFE_INTEGER);
		return (this._config = {
			store,
			retentionDays: knob(h.retentionDays, DEFAULT_RETENTION_DAYS, 36_500),
			timeZone,
			maxValueBytes: knob(h.maxValueBytes, own, own)
		});
	}

	// ── Slots (`room.history.slots`) ─────────────────────────────────────

	/** The verified user a stored change is written for (a socket's, or the restorer's), or `null`. */
	editorOf(origin: unknown): string | null {
		if (this.writer !== null) return this.writer;
		const socket = origin as { deserializeAttachment?: () => unknown } | null;
		if (typeof socket?.deserializeAttachment !== 'function') return null;
		const user = (socket.deserializeAttachment() as Attachment | null)?.user;
		return typeof user === 'string' && user !== '' && !this.slotEditors.has(user) ? user : null;
	}

	/** Record `editor` as one of the open slot's (inside the change's storage transaction). */
	storeEditor(editor: string) {
		this.room.sql.exec(
			`INSERT OR IGNORE INTO ${this.room.tables.editors} (user) VALUES (?)`,
			editor
		);
	}

	/**
	 * A change was stored at `at`: open the history slot it falls in — a
	 * purge opens none: it changes nothing a reader sees.
	 */
	noteChange(origin: unknown, at: number) {
		const config = this.config;
		const { scheduler } = this.room;
		if (config === null || origin === PURGE_ORIGIN || scheduler.due('history') !== undefined)
			return;
		scheduler.schedule('history', slotEnd(at, config.timeZone));
	}

	/** Before a write: a slot past its end is captured as it is, and written. */
	closeSlotIfPast() {
		const room = this.room;
		if ((room.scheduler.due('history') ?? Infinity) > room.clock()) return;
		const captured = this.captureSlot();
		if (captured === null) return;
		const job = this.putSlot(captured);
		this.writing = Promise.all([this.writing, job]);
		room.ctx.waitUntil?.(job);
	}

	/** Close the open slot: capture it now, write it (the alarm, a start past its end). */
	async closeSlot(): Promise<void> {
		const captured = this.captureSlot();
		if (captured !== null) await this.putSlot(captured);
	}

	/**
	 * The open slot's version, read now (synchronous: nothing writes
	 * between the read and the slot's close), and the slot closed.
	 */
	private captureSlot(): Version | null {
		const room = this.room;
		const { scheduler } = room;
		const end = scheduler.due('history');
		if (end === undefined) return null;
		const config = this.config;
		if (config === null) {
			scheduler.unschedule('history');
			return null;
		}
		if (room.live === null) {
			// No document to read (its rows unreadable, or refused): that slot is skipped.
			scheduler.unschedule('history');
			this.skipVersion({
				key: historyKey(this.room.roomId, slotAt(end - 1, config.timeZone)),
				error: 'room unavailable'
			});
			return null;
		}
		return noTimers(() => {
			const doc = room.live!;
			const key = historyKey(this.room.roomId, slotAt(end - 1, config.timeZone));
			const editors = room.sql
				.exec<{ user: string }>(`SELECT user FROM ${room.tables.editors} ORDER BY rowid`)
				.toArray()
				.map(({ user }) => user);
			const raw = liveState(doc);
			const blocks = room.facade.listBlockIds().length;
			room.sql.exec(`DELETE FROM ${room.tables.editors}`);
			this.slotEditors.clear();
			scheduler.unschedule('history');
			if (key === null) {
				this.skipVersion({ room: this.room.roomId, reason: 'key longer than 512 bytes' });
				return null;
			}
			return { key, raw, blocks, editors, at: room.clock() };
		});
	}

	/** Write a captured version (`room.history.value`); a failure is noted `history` and the slot skipped. */
	private async putSlot(version: Version): Promise<void> {
		const room = this.room;
		const config = this.config!;
		try {
			const bytes = await packed(version.raw);
			if (bytes.length > config.maxValueBytes) {
				return this.skipVersion({
					key: version.key,
					bytes: bytes.length,
					limit: config.maxValueBytes
				});
			}
			const metadata = fitMetadata({
				bytes: bytes.length,
				blocks: version.blocks,
				editors: version.editors,
				at: version.at
			});
			const expiresAt = version.at + config.retentionDays * DAY;
			await config.store.put(version.key, bytes, { expiresAt, metadata });
			// A store that expires nothing itself: the alarm deletes it then (`room.history.retention`).
			if (!config.store.nativeTtl) room.scheduler.schedule('retention', expiresAt, 'earlier');
			room.counters.history.written++;
			room.counters.history.lastKey = version.key;
			room.log({
				edytor: 'history',
				key: version.key,
				bytes: bytes.length,
				editors: version.editors.length
			});
		} catch (error) {
			this.skipVersion({ key: version.key, error: String(error) });
		}
	}

	private skipVersion(detail: Record<string, unknown>) {
		this.room.counters.history.skipped++;
		this.room.note({ reason: 'history', detail });
	}

	/** The history settings, or a throw: the room keeps no history. */
	private requireHistory() {
		const config = this.config;
		if (config === null) throw new Error('this room keeps no history (the `history` option)');
		return config;
	}

	/** Resolves once the versions the room is writing are stored. */
	async written(): Promise<void> {
		await this.writing;
	}

	// ── Versions ─────────────────────────────────────────────────────────

	/** The room's versions, newest first (`AttachedDocument.listHistory`). */
	async list(): Promise<HistoryEntry[]> {
		const config = this.requireHistory();
		const now = this.room.clock();
		const out: HistoryEntry[] = [];
		for await (const { key, expiresAt, metadata } of this.storedVersions(config.store)) {
			// Past its expiry it is gone, whether or not the store deleted it yet.
			if (expiresAt !== null && expiresAt <= now) continue;
			const entry = historyEntry(this.room.roomId, key, metadata, expiresAt);
			if (entry !== null) out.push(entry);
		}
		return out.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
	}

	/** Every version key the store holds under this room's prefix, page by page. */
	private async *storedVersions(store: HistoryStore) {
		const prefix = historyPrefix(this.room.roomId);
		let cursor: string | undefined;
		do {
			const page = await store.list(prefix, cursor);
			yield* page.entries;
			cursor = page.cursor;
		} while (cursor !== undefined);
	}

	/**
	 * The `retention` task (`room.history.retention`), for a store that
	 * expires nothing itself: delete every version past its expiry, then
	 * re-arm at the next one's. A failure is noted `history` and retried
	 * an hour later.
	 */
	async expireVersions(): Promise<void> {
		const room = this.room;
		const { scheduler } = room;
		const config = this.config;
		if (config === null || config.store.nativeTtl) return scheduler.unschedule('retention');
		const now = room.clock();
		let next = Infinity;
		try {
			const expired: string[] = [];
			for await (const { key, expiresAt } of this.storedVersions(config.store)) {
				if (expiresAt === null || parseHistoryKey(this.room.roomId, key) === null) continue;
				if (expiresAt <= now) expired.push(key);
				else next = Math.min(next, expiresAt);
			}
			for (const key of expired) await config.store.delete(key);
		} catch (error) {
			room.note({ reason: 'history', detail: { retention: true, error: String(error) } });
			return scheduler.schedule('retention', now + RETENTION_RETRY, 'replace');
		}
		if (next === Infinity) scheduler.unschedule('retention');
		else scheduler.schedule('retention', next, 'replace');
	}

	/** Version `key` as JSON (`AttachedDocument.readHistory`). */
	async read(key: string): Promise<JSONDoc | null> {
		const room = this.room;
		const config = this.requireHistory();
		if (parseHistoryKey(this.room.roomId, key) === null) return null;
		const found = await config.store.get(key);
		if (found === null || (found.expiresAt !== null && found.expiresAt <= room.clock()))
			return null;
		const bytes = await gunzip(found.value);
		return noTimers(() => {
			let doc: YDoc;
			try {
				doc = admit([{ v2: bytes }], `room ${room.ctx.id} version ${key}`, () => null);
			} catch (error) {
				// A version written by generation 4 reads through its JSON (`room.generation.convert`).
				const problem = (error as { problem?: { kind?: string; version?: number } }).problem;
				if (problem?.kind !== 'unsupported' || problem.version !== E.PREVIOUS_SCHEMA) throw error;
				return crdt.generations.previousJSON([{ v2: bytes }], (d) => room.facadeOf(d));
			}
			const facade = room.facadeOf(doc);
			try {
				return facade.toJSON();
			} finally {
				facade.dispose();
				doc.destroy();
			}
		});
	}

	// ── Restores (`room.history.restore`, `room.history.undo`) ───────────

	/** The last restore's deleted content, kept for its undo (`prepareRoomDoc`). */
	get restoreKeep(): Decoded['ds'] | null {
		return this.restoreStep?.deletes ?? null;
	}

	/** Restore version `key` as a forward edit (`AttachedDocument.restoreHistory`). */
	async restore(key: string, options: { user?: string } = {}): Promise<RestoreResult> {
		const room = this.room;
		const json = await this.read(key);
		if (json === null) return { status: 'refused', key };
		await room.storage.retryStart();
		return noTimers(() => {
			if (room.busy) {
				throw new Error('restoreHistory inside a transaction or its change events: defer it');
			}
			room.storage.heal();
			const doc = room.requireDoc();
			this.closeSlotIfPast();
			const history = this.restoreHistoryOf();
			// One level: the previous restore's step goes.
			this.dropRestore();
			this.writer = options.user ?? null;
			let report!: ReturnType<typeof crdt.doc.restoreTo>;
			room.transacting = true;
			try {
				room.facade.transact(() => {
					report = crdt.doc.restoreTo(doc as never, room.facade, json);
				}, RESTORE_ORIGIN);
			} finally {
				room.transacting = false;
				this.writer = null;
			}
			if (room.unstored !== null) {
				const error = room.unstored;
				room.storage.heal();
				throw error;
			}
			const step = history.undoStack.at(-1) as unknown as RestoreStep | undefined;
			if (step === undefined) return { status: 'noop', key, ...report };
			const kept: RestoreStep = {
				key,
				user: options.user ?? null,
				at: room.clock(),
				inserts: step.inserts,
				deletes: step.deletes
			};
			room.sql.exec(
				`INSERT OR REPLACE INTO ${room.tables.restore} (id, key, user, at, inserts, deletes) VALUES (0, ?, ?, ?, ?, ?)`,
				kept.key,
				kept.user,
				kept.at,
				deletesUpdate(kept.inserts),
				deletesUpdate(kept.deletes)
			);
			this.restoreStep = kept;
			room.log({ edytor: 'restore', key, user: kept.user, undo: false });
			room.storage.compactIfDue();
			return { status: 'applied', key, ...report };
		});
	}

	/** Undo the last restore (`AttachedDocument.undoRestore`). */
	async undoRestore(options: { user?: string } = {}): Promise<{ status: 'applied' | 'noop' }> {
		const room = this.room;
		await room.storage.retryStart();
		return noTimers(() => {
			if (room.busy) {
				throw new Error('undoRestore inside a transaction or its change events: defer it');
			}
			room.storage.heal();
			room.requireDoc();
			const step = this.restoreStep;
			if (step === null) return { status: 'noop' };
			const history = this.restoreHistoryOf();
			// A woken room rebuilds the step from its table.
			if (history.undoStack.length === 0) {
				history.undoStack.push({
					inserts: step.inserts,
					deletes: step.deletes,
					meta: new Map()
				} as never);
			}
			this.closeSlotIfPast();
			this.writer = options.user ?? step.user;
			let undone: unknown;
			room.transacting = true;
			try {
				undone = history.undo();
			} finally {
				room.transacting = false;
				this.writer = null;
			}
			if (room.unstored !== null) {
				const error = room.unstored;
				room.storage.heal();
				throw error;
			}
			this.dropRestore();
			room.log({ edytor: 'restore', key: step.key, user: options.user ?? null, undo: true });
			room.storage.compactIfDue();
			return { status: undone ? 'applied' : 'noop' };
		});
	}

	/** The history recording restores, on the live facade (`RESTORE_ORIGIN` only, one step each). */
	private restoreHistoryOf(): YUndoManager {
		return (this.restoreManager ??= this.room.facade.createUndoManager({
			captureTimeout: 0,
			trackedOrigins: new Set([RESTORE_ORIGIN])
		}));
	}

	/** Read the last restore's step from its table (at load). */
	loadRestore() {
		const row = this.room.sql
			.exec<{
				key: string;
				user: string | null;
				at: number;
				inserts: ArrayBuffer;
				deletes: ArrayBuffer;
			}>(`SELECT key, user, at, inserts, deletes FROM ${this.room.tables.restore} WHERE id = 0`)
			.toArray()[0];
		this.restoreStep =
			row === undefined
				? null
				: {
						key: row.key,
						user: row.user,
						at: row.at,
						inserts: Y.decodeUpdate(new Uint8Array(row.inserts)).ds,
						deletes: Y.decodeUpdate(new Uint8Array(row.deletes)).ds
					};
	}

	/** Forget the last restore's step (its table was emptied: a conversion). */
	clearRestore() {
		this.restoreStep = null;
	}

	/** Forget the restore's step and the open slot's editors (a reset dropped their tables). */
	forget() {
		this.restoreStep = null;
		this.slotEditors.clear();
	}

	/** The live document was replaced: the restore history recorded the old one. */
	detach() {
		this.restoreManager = null;
	}

	/** A restore past the purge horizon `at` can no longer be undone. */
	expireRestore(at: number) {
		if (this.restoreStep !== null && this.restoreStep.at <= at) this.dropRestore();
	}

	/**
	 * Forget the last restore's step: its table row goes, then what it kept
	 * is released and collected (the next compaction stores it collected).
	 */
	private dropRestore() {
		const room = this.room;
		const step = this.restoreStep;
		if (step === null) return;
		this.restoreStep = null;
		room.sql.exec(`DELETE FROM ${room.tables.restore}`);
		const history = this.restoreManager;
		if (history !== null) room.facade.releaseHistory(history);
		const doc = room.live;
		if (doc === null) return;
		const d = doc as unknown as { gc: boolean; gcFilter: (it: Item) => boolean };
		doc.transact((tr: unknown) => {
			Y.iterateStructsByIdSet(tr as never, step.deletes as never, (struct: unknown) => {
				const it = struct as Item & { keep?: boolean; gc(tr: unknown, parentGCd: boolean): void };
				if (it instanceof Y.Item && it.deleted && it.keep !== true && d.gc && d.gcFilter(it))
					it.gc(tr, false);
			});
		});
	}

	// ── Over HTTP (`routeDocumentHistory`) ──────────────────────────────

	/**
	 * One history request: `list`, `read` (a version as JSON), and,
	 * for a write identity, `restore` and `undo`. `404` when the room keeps
	 * no history or holds no such version, `403` for a read-only identity's
	 * write, `503` when the room cannot serve it.
	 */
	async request(op: string, identity: SocketIdentity, key: string | null): Promise<Response> {
		if (this.config === null) return new Response('no history', { status: 404 });
		try {
			if (op === 'list') return Response.json(await this.list());
			if (op === 'read') {
				const json = key === null ? null : await this.read(key);
				return json === null
					? new Response('no such version', { status: 404 })
					: Response.json(json);
			}
			if (op !== 'restore' && op !== 'undo')
				return new Response('unknown request', { status: 400 });
			if (identity.readOnly) return new Response('read-only', { status: 403 });
			if (op === 'undo') return Response.json(await this.undoRestore({ user: identity.user }));
			if (key === null) return new Response('version key required', { status: 400 });
			const result = await this.restore(key, { user: identity.user });
			return Response.json(result, { status: result.status === 'refused' ? 404 : 200 });
		} catch (error) {
			this.room.note({ reason: 'internal', detail: `history: ${String(error)}` });
			return new Response('room unavailable', { status: 503 });
		}
	}
}
