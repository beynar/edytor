/**
 * Storage and compaction: the document's rows in the object's SQLite
 * storage, the live document restored from them (or seeded from
 * `onLoad`), every integrated update appended before it is relayed, the
 * snapshot that replaces the rows at compaction, and the `onSave` mirror.
 * Memory never runs ahead of storage: a failed append rebuilds the live
 * document from the rows.
 */
import { Y } from '../../crdt/engine.js';
import * as E from '../../crdt/protocol.js';
import {
	isGenerationRecord,
	STORED_GENERATION_RECORD,
	storageOf,
	type StorageFormat
} from '../../crdt/protocols/envelope.js';
import { gunzip, isGzip, packed } from '../../crdt/storage.js';
import type { JSONBlock, JSONDoc, YDoc } from '../../crdt/index.js';
import type { Attachment, LoadedDocument, ReplicaOwner, StoredRecord } from '../DocumentRoom.js';
import { SOCKET_TAG, noTimers } from './shared.js';
import { parseReplica } from './access.js';
import { crdt, encodeJSON, now, tally, type Decoded, type RoomContext } from './context.js';
import { updateFrame } from './frames.js';
import {
	addIds,
	admit,
	deletesUpdate,
	forgetWaiting,
	liveState,
	pendingDeletes,
	rangeCount,
	roomDoc,
	stateVector
} from './updates.js';

/** A stored record's kind. `pending`: deletes of items the room does not hold yet (they wait for them). */
type RowKind = StoredRecord['kind'];
type Row = { kind: RowKind; record: number; part: number; parts: number; bytes: ArrayBuffer };

/** The probe append's rollback (`RoomStorage.answers`): thrown inside its transaction. */
const PROBED = new Error('storage probe');

/** Longest wait between the save alarms of a room that cannot read its rows. */
const MAX_SAVE_RETRY = 5 * 60_000;

/** A stored record missing some of its rows, or one that does not inflate: the container is corrupt, not the read. */
class TornRecord extends Error {
	constructor(detail = 'torn record') {
		super(detail);
	}
}

/** A compressed record this instance has not inflated (only `start` can): the next dial reads it again. */
class CompressedRecord extends Error {
	constructor() {
		super('compressed record not inflated');
	}
}

/**
 * What `onLoad` returned, as one update and its registry (`null`: none
 * came with it). JSON is seeded into a scratch doc. Any other shape is
 * refused (TypeError) — it would otherwise seed an empty document that
 * `onSave` later writes over the real one.
 */
const loadedUpdate = (
	found: LoadedDocument,
	seed: (value: JSONDoc) => Uint8Array
): { update: Uint8Array; replicas: ReplicaOwner[] | null } => {
	if (found instanceof Uint8Array) return { update: found, replicas: null };
	if (typeof found === 'object' && found !== null) {
		if ('update' in found && found.update instanceof Uint8Array) {
			const replicas = found.replicas;
			const valid = (owner: ReplicaOwner) =>
				parseReplica(owner?.replica) !== null &&
				typeof owner.user === 'string' &&
				owner.user.length <= 256;
			if (Array.isArray(replicas) && replicas.every(valid))
				return { update: found.update, replicas };
		} else if ('children' in found && Array.isArray(found.children)) {
			return { update: seed(found as JSONDoc), replicas: [] };
		}
	}
	throw new TypeError('onLoad returned neither a JSONDoc, a v14 update nor { update, replicas }');
};

/** How many blocks `children` holds, nested ones included. */
const countBlocks = (children: readonly JSONBlock[]): number =>
	children.reduce((n, block) => n + 1 + countBlocks(block.children ?? []), 0);

/** Rows grouped into their records, in write order; a record missing rows throws. */
const reassemble = (
	rows: Row[]
): Array<{ kind: RowKind; record: number; bytes: Uint8Array<ArrayBuffer> }> => {
	const byRecord = new Map<number, Row[]>();
	for (const row of rows) {
		const parts = byRecord.get(row.record) ?? [];
		parts.push(row);
		byRecord.set(row.record, parts);
	}
	return [...byRecord.values()].map((parts) => {
		if (parts.length !== parts[0].parts) throw new TornRecord();
		parts.sort((a, b) => a.part - b.part);
		const bytes = new Uint8Array(parts.reduce((n, p) => n + p.bytes.byteLength, 0));
		let at = 0;
		for (const part of parts) {
			bytes.set(new Uint8Array(part.bytes), at);
			at += part.bytes.byteLength;
		}
		return { kind: parts[0].kind, record: parts[0].record, bytes };
	});
};

/** The deletes of the `pending` records among `records`. */
const storedPending = (
	records: Array<{ kind: RowKind; bytes: Uint8Array<ArrayBuffer> }>
): Decoded['ds'] => {
	const pending = records.filter((record) => record.kind === 'pending');
	return pending.length === 0
		? Y.createIdSet()
		: Y.decodeUpdate(Y.mergeUpdates(pending.map((record) => record.bytes))).ds;
};

export class RoomStorage {
	/** The failure is the storage's (a failed read, `onLoad`'s store down): the next dial starts again. */
	retryable = false;
	/** Update records since the last compaction. */
	updates = 0;
	/** What the records hold, uncompressed (the generation record aside): the document quota's measure. */
	documentBytes = 0;
	/** The waiting deletes stored as `pending` records (the engine may hold more, in memory). */
	storedWaiting: Decoded['ds'] = Y.createIdSet();
	/**
	 * The failed append that last rebuilt the live doc (`room.storage.outage`):
	 * until storage takes an append again ({@link answers}), a frame that
	 * would write is closed before it is applied, so an outage rebuilds once.
	 */
	outage: unknown = null;
	private nextRecord = 0;
	/** The snapshot compression in flight (`compressed()`). */
	private compressing: Promise<unknown> = Promise.resolve();
	/** The raw bytes of the compressed snapshot record (`records` reads it; only `start` can inflate). */
	private inflated: { record: number; bytes: Uint8Array<ArrayBuffer> } | null = null;
	/** Alarms in a row that found the rows unreadable: each re-arms later. */
	private saveRetries = 0;

	constructor(private readonly room: RoomContext) {}

	/**
	 * Restore from storage, or seed from `onLoad`. Never throws: a throw
	 * out of `blockConcurrencyWhile` resets the object on every request.
	 */
	async start() {
		const room = this.room;
		try {
			// The alarm already set: a wake keeps every task due (`room.alarm.tasks`).
			await room.scheduler.readAlarm();
			await this.inflate();
			noTimers(() => this.load());
			if (room.state.origin.kind === 'fresh' && room.live !== null) await this.seed();
			// A slot that ended while the room slept is written now (`room.history.slots`).
			if (room.live !== null && (room.scheduler.due('history') ?? Infinity) <= room.clock()) {
				await room.history.closeSlot();
			}
		} catch (error) {
			this.fail(error, !(error instanceof TornRecord));
		}
	}

	/**
	 * Inflate a compressed snapshot record for `records`, which reads
	 * synchronously (a rebuild does): decompression is asynchronous, so
	 * only `start` can. One that does not inflate is a corrupt container.
	 */
	private async inflate() {
		this.inflated = null;
		let rows: Row[];
		try {
			rows = this.room.sql
				.exec<Row>(
					`SELECT kind, record, part, parts, bytes FROM ${this.room.tables.rows} WHERE kind = 'snapshot' ORDER BY seq`
				)
				.toArray();
		} catch {
			return; // no table yet, or a failed read: `load` reports it
		}
		for (const { record, bytes } of reassemble(rows)) {
			if (!isGzip(bytes)) continue;
			try {
				this.inflated = { record, bytes: (await gunzip(bytes)) as Uint8Array<ArrayBuffer> };
			} catch (error) {
				throw new TornRecord(`snapshot does not inflate: ${String(error)}`);
			}
		}
	}

	/** A read of the rows or `onLoad` failed (storage was down): start again. */
	async retryStart() {
		if (this.room.live !== null || !this.retryable) return;
		await this.room.ctx.blockConcurrencyWhile(async () => {
			if (this.room.live === null && this.retryable) await this.start();
		});
	}

	private fail(error: unknown, retryable: boolean) {
		const room = this.room;
		room.state.failure = error instanceof Error ? error : new Error(String(error));
		this.retryable = retryable;
		room.unstored = null;
		room.disposeFacade();
		room.live?.destroy();
		room.live = null;
	}

	/** Generation cutover (`AttachedDocument.reset`). */
	async reset(): Promise<void> {
		const room = this.room;
		if (!(room.state.failure instanceof E.GenerationMismatchError)) {
			throw new Error('reset() only replaces a container of another generation');
		}
		const { tables, sql } = room;
		await room.ctx.blockConcurrencyWhile(async () => {
			room.ctx.storage.transactionSync(() => {
				sql.exec(`DELETE FROM ${tables.rows}`);
				sql.exec(`DELETE FROM ${tables.replicas}`);
				sql.exec(`DELETE FROM ${tables.meta}`);
				for (const table of [
					tables.epochs,
					tables.editors,
					tables.restore,
					tables.moves,
					tables.late
				])
					sql.exec(`DROP TABLE IF EXISTS ${table}`);
			});
			room.scheduler.forget();
			room.history.forget();
			room.moves.forget();
			room.state.presence.clear();
			await this.start();
		});
	}

	/**
	 * Seed a fresh room from `onLoad`. Nothing is stored before it settles:
	 * a throw or nothing leaves the room fresh, asked again at the next
	 * start (after a throw, also at the next dial). The payload is admitted
	 * like a stored container, then stored as one snapshot record with its
	 * registry, atomically. The deletes it carries of items it lacks (an
	 * `onSave` mirror holds the waiting ones) are stored apart, as one
	 * `pending` record, as a frame's are: acknowledged by id, reclaimed by
	 * compaction.
	 */
	private async seed() {
		const room = this.room;
		let found: LoadedDocument | null | undefined;
		try {
			found = await room.options.onLoad?.();
		} catch (error) {
			return this.fail(error, true);
		}
		if (found == null) return;
		noTimers(() => {
			let doc: YDoc;
			let replicas: ReplicaOwner[] | null;
			try {
				// JSON is seeded deterministically: a client seeding the same value writes the same update.
				const loaded = loadedUpdate(found, ({ children, data }) => {
					const scratch = crdt.createDoc();
					const facade = room.facadeOf(scratch);
					facade.seed(children, data);
					facade.dispose();
					const update = Y.encodeStateAsUpdate(scratch);
					scratch.destroy();
					return update;
				});
				doc = admit(loaded.update, `room ${room.ctx.id} onLoad`, () => room.history.restoreKeep);
				replicas = loaded.replicas;
			} catch (error) {
				return this.fail(error, false);
			}
			const waiting = pendingDeletes(doc);
			const snapshot = liveState(doc);
			let record = -1;
			try {
				room.ctx.storage.transactionSync(() => {
					record = this.insert('snapshot', snapshot);
					this.touch();
					if (!waiting.isEmpty()) this.insert('pending', deletesUpdate(waiting));
					// Without a registry, every id with content is left claimable (user
					// ''). As in `register`, an unowned row never replaces an owner a
					// dial registered while the room stayed fresh.
					const owners =
						replicas ?? [...stateVector(doc).keys()].map((replica) => ({ replica, user: '' }));
					for (const { replica, user } of owners) {
						room.sql.exec(
							`INSERT ${user ? 'OR REPLACE' : 'OR IGNORE'} INTO ${room.tables.replicas} (replica, user) VALUES (?, ?)`,
							replica,
							user
						);
					}
				});
			} catch (error) {
				return this.fail(error, true);
			}
			room.live?.destroy();
			this.adopt(doc);
			this.storedWaiting = waiting;
			this.compressLater(record, snapshot);
		});
	}

	/**
	 * Restore the live doc from the stored rows. A read of the rows that
	 * fails is the storage's fault: retryable, the next dial loads again
	 * (at cold start, at a retry, after a rebuild). A container that reads
	 * but cannot be restored (a torn record, another generation, bytes the
	 * engine refuses) is refused for good.
	 */
	private load() {
		const room = this.room;
		const { sql, tables } = room;
		room.state.failure = null;
		this.retryable = false;
		let records: StoredRecord[];
		try {
			sql.exec(
				`CREATE TABLE IF NOT EXISTS ${tables.rows} (
					seq INTEGER PRIMARY KEY AUTOINCREMENT,
					kind TEXT NOT NULL,
					record INTEGER NOT NULL,
					part INTEGER NOT NULL,
					parts INTEGER NOT NULL,
					bytes BLOB NOT NULL
				)`
			);
			sql.exec(
				`CREATE TABLE IF NOT EXISTS ${tables.replicas} (replica INTEGER PRIMARY KEY, user TEXT NOT NULL)`
			);
			sql.exec(
				`CREATE TABLE IF NOT EXISTS ${tables.meta} (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`
			);
			sql.exec(
				`CREATE TABLE IF NOT EXISTS ${tables.epochs} (at INTEGER PRIMARY KEY, sv BLOB NOT NULL)`
			);
			sql.exec(`CREATE TABLE IF NOT EXISTS ${tables.editors} (user TEXT PRIMARY KEY)`);
			sql.exec(
				`CREATE TABLE IF NOT EXISTS ${tables.restore} (
					id INTEGER PRIMARY KEY CHECK (id = 0),
					key TEXT NOT NULL,
					user TEXT,
					at INTEGER NOT NULL,
					inserts BLOB NOT NULL,
					deletes BLOB NOT NULL
				)`
			);
			room.scheduler.readDues();
			room.history.loadRestore();
			this.nextRecord = 0;
			records = this.records();
		} catch (error) {
			return this.fail(error, !(error instanceof TornRecord));
		}
		try {
			if (records.length === 0) {
				// A fresh room: the generation record is written with the first stored record.
				room.state.origin = { kind: 'fresh' };
				this.documentBytes = 0;
				this.storedWaiting = Y.createIdSet();
				this.adopt(roomDoc(() => room.history.restoreKeep));
				return;
			}
			const [generation, ...rest] = records;
			const found = JSON.parse(new TextDecoder().decode(generation.bytes));
			// A container of generation 4 converts through its JSON (`room.generation.convert`).
			if (generation.kind === 'generation' && E.isPreviousGenerationRecord(found)) {
				return this.convert(rest);
			}
			if (generation.kind !== 'generation' || !isGenerationRecord(found)) {
				throw new E.GenerationMismatchError(`room ${room.ctx.id}`, found);
			}
			// Applied in one transaction, never merged first: a merge of the
			// records keeps every keystroke's struct and the deleted content.
			const doc = admit(
				rest.map((record) => (record.v2 ? { v2: record.bytes } : record.bytes)),
				`room ${room.ctx.id}`,
				() => room.history.restoreKeep
			);
			this.documentBytes = rest.reduce((n, record) => n + record.bytes.length, 0);
			this.adopt(doc);
			// Every delete the engine holds waiting came from the rows.
			this.storedWaiting = pendingDeletes(doc);
			room.state.origin = { kind: 'restored', records: rest.length };
			this.updates = rest.filter((record) => record.kind !== 'snapshot').length;
		} catch (error) {
			this.fail(error, false);
		}
	}

	/**
	 * The generation cutover at load (`room.generation.convert`): the
	 * records of a generation-4 container are read as JSON
	 * (`crdt.generations.previousJSON`), which this generation seeds as
	 * `onLoad`'s JSON is (deterministic: every replica converting the same
	 * state writes the same update), and the container is replaced by it in
	 * one storage transaction: rows, replicas, purge epochs, slot editors
	 * and the stored restore go; the document data, the alarm's due tasks
	 * and `lastUpdated` stay. What a generation-4 client never sent is not
	 * in it; history, attribution and CRDT identity do not cross.
	 */
	private convert(records: StoredRecord[]) {
		const room = this.room;
		const { sql, tables } = room;
		const json = crdt.generations.previousJSON(
			records.map((record) => (record.v2 ? { v2: record.bytes } : record.bytes)),
			(doc) => room.facadeOf(doc)
		);
		const scratch = crdt.createDoc();
		const facade = room.facadeOf(scratch);
		facade.seed(json.children, json.data);
		facade.dispose();
		const update = Y.encodeStateAsUpdate(scratch);
		scratch.destroy();
		const doc = admit(update, `room ${room.ctx.id} conversion`, () => room.history.restoreKeep);
		const snapshot = liveState(doc);
		room.ctx.storage.transactionSync(() => {
			for (const table of [
				tables.rows,
				tables.replicas,
				tables.epochs,
				tables.editors,
				tables.restore
			])
				sql.exec(`DELETE FROM ${table}`);
			this.nextRecord = 0;
			this.insert('snapshot', snapshot);
			this.touch();
			for (const replica of stateVector(doc).keys())
				sql.exec(
					`INSERT OR IGNORE INTO ${tables.replicas} (replica, user) VALUES (?, '')`,
					replica
				);
		});
		room.history.clearRestore();
		this.documentBytes = snapshot.length;
		this.updates = 0;
		this.storedWaiting = Y.createIdSet();
		this.adopt(doc);
		room.state.origin = { kind: 'converted', from: E.PREVIOUS_SCHEMA, records: records.length };
		room.log({
			edytor: 'convert',
			from: E.PREVIOUS_SCHEMA,
			to: E.SCHEMA_VERSION,
			blocks: countBlocks(json.children),
			bytes: snapshot.length
		});
	}

	/** The bytes of the stored `pending` records (uncompressed, as every record but a snapshot). */
	pendingBytes(): number {
		return (
			this.room.sql
				.exec<{
					n: number | null;
				}>(`SELECT SUM(length(bytes)) AS n FROM ${this.room.tables.rows} WHERE kind = 'pending'`)
				.one().n ?? 0
		);
	}

	/**
	 * Reassembled logical records in write order (of one kind, with
	 * `only`); a torn record throws. A v2 container's snapshot is v2
	 * (`v2`), inflated when it is stored compressed.
	 */
	records(only?: RowKind): StoredRecord[] {
		const rows = this.room.sql
			.exec<Row>(
				`SELECT kind, record, part, parts, bytes FROM ${this.room.tables.rows}${only ? ' WHERE kind = ?' : ''} ORDER BY seq`,
				...(only ? [only] : [])
			)
			.toArray();
		for (const row of rows) this.nextRecord = Math.max(this.nextRecord, row.record + 1);
		const records = reassemble(rows);
		// The container's storage format, from its generation record.
		let format: StorageFormat = 'v1';
		if (records[0]?.kind === 'generation') {
			try {
				const found = JSON.parse(new TextDecoder().decode(records[0].bytes));
				if (isGenerationRecord(found) || E.isPreviousGenerationRecord(found))
					format = storageOf(found);
			} catch {
				// `load` refuses it
			}
		}
		return records.map((record) => {
			const v2 = format === 'v2' && record.kind === 'snapshot';
			if (!v2 || !isGzip(record.bytes)) return { ...record, v2 };
			if (this.inflated?.record !== record.record) throw new CompressedRecord();
			return { ...record, bytes: this.inflated.bytes, v2 };
		});
	}

	/**
	 * One logical record split into rows ≤ `maxRowBytes` (callers run it in
	 * a transaction). The first record of an empty container brings the
	 * generation record with it.
	 */
	insert(kind: RowKind, bytes: Uint8Array): number {
		if (this.nextRecord === 0 && kind !== 'generation') {
			this.insert('generation', encodeJSON(STORED_GENERATION_RECORD));
		}
		const record = this.nextRecord++;
		this.writeRecord(kind, record, bytes);
		if (kind !== 'generation') this.documentBytes += bytes.length;
		return record;
	}

	/** Record `record`'s rows (at the row positions `seqs`, when given). */
	private writeRecord(kind: RowKind, record: number, bytes: Uint8Array, seqs?: number[]) {
		const { sql, tables, limits } = this.room;
		const parts = Math.max(1, Math.ceil(bytes.length / limits.maxRowBytes));
		for (let part = 0; part < parts; part++) {
			const row = bytes.slice(part * limits.maxRowBytes, (part + 1) * limits.maxRowBytes);
			if (seqs) {
				sql.exec(
					`INSERT INTO ${tables.rows} (seq, kind, record, part, parts, bytes) VALUES (?, ?, ?, ?, ?, ?)`,
					seqs[part],
					kind,
					record,
					part,
					parts,
					row
				);
			} else {
				sql.exec(
					`INSERT INTO ${tables.rows} (kind, record, part, parts, bytes) VALUES (?, ?, ?, ?, ?)`,
					kind,
					record,
					part,
					parts,
					row
				);
			}
		}
	}

	/**
	 * Compress snapshot `record` in place once it is stored: gzip is
	 * asynchronous, and the store-before-ack path is not. Its rows are
	 * rewritten (at their positions) only while it is still the stored
	 * snapshot and only when that shrinks it; the raw bytes stay in memory
	 * (`inflated`) for a rebuild's synchronous read. A platform without
	 * `CompressionStream` keeps it raw.
	 */
	private compressLater(record: number, raw: Uint8Array) {
		const room = this.room;
		const job = packed(raw)
			.then((bytes) =>
				noTimers(() => {
					if (bytes === raw) return;
					const rows = room.sql
						.exec<{
							seq: number;
						}>(
							`SELECT seq FROM ${room.tables.rows} WHERE record = ? AND kind = 'snapshot' ORDER BY part`,
							record
						)
						.toArray();
					// Replaced since (a compaction, a reset): nothing to do.
					if (rows.length !== Math.max(1, Math.ceil(raw.length / room.limits.maxRowBytes))) return;
					room.ctx.storage.transactionSync(() => {
						room.sql.exec(`DELETE FROM ${room.tables.rows} WHERE record = ?`, record);
						this.writeRecord(
							'snapshot',
							record,
							bytes,
							rows.map((row) => row.seq)
						);
					});
					this.inflated = { record, bytes: raw.slice() };
				})
			)
			.catch((error) => room.note({ reason: 'storage', detail: `compression: ${String(error)}` }));
		this.compressing = job;
		room.ctx.waitUntil?.(job);
	}

	/** Resolves once the snapshot compression in flight, if any, is stored. */
	async compressed(): Promise<void> {
		await this.compressing;
	}

	/** Compaction (`AttachedDocument.compact`). */
	compact(): { rows: number } {
		const room = this.room;
		const { sql, tables } = room;
		return noTimers(() => {
			this.heal();
			const doc = room.requireDoc();
			const started = now();
			// Only the waiting deletes are read back: the snapshot is the live doc.
			const pending = this.records('pending');
			// The live state, never a merge of the records: memory never
			// runs ahead of storage, so it is what they hold, collected.
			const snapshot = liveState(doc);
			const sockets = new Set<number>();
			for (const ws of room.ctx.getWebSockets(SOCKET_TAG)) {
				const replica = (ws.deserializeAttachment() as Attachment | null)?.replica;
				if (replica != null) sockets.add(replica);
			}
			const registered = sql
				.exec<{ replica: number }>(`SELECT replica FROM ${tables.replicas}`)
				.toArray()
				.map(({ replica }) => replica);
			const known = new Set([...registered, ...sockets]);
			// Waiting deletes stay apart (a discarded forgery drops them,
			// `settleDeletes`): the stored ones the engine still holds waiting.
			const all = pendingDeletes(doc);
			const stored = storedPending(pending);
			const waiting = Y.diffIdSet(stored, Y.diffIdSet(stored, all));
			const still = addIds(Y.createIdSet(), waiting, (client) => known.has(client));
			// Memory never runs ahead of storage: the live state vector is the stored one.
			const kept = new Set([...stateVector(doc).keys(), ...sockets, ...still.clients.keys()]);
			let record = -1;
			const measured = this.documentBytes;
			try {
				room.ctx.storage.transactionSync(() => {
					sql.exec(`DELETE FROM ${tables.rows}`);
					this.documentBytes = 0;
					// The container is now this build's format (a v1 one migrates here).
					this.insert('generation', encodeJSON(STORED_GENERATION_RECORD));
					record = this.insert('snapshot', snapshot);
					if (!still.isEmpty()) this.insert('pending', deletesUpdate(still));
					for (const replica of registered) {
						if (!kept.has(replica)) {
							sql.exec(`DELETE FROM ${tables.replicas} WHERE replica = ?`, replica);
						}
					}
				});
			} catch (error) {
				this.documentBytes = measured;
				throw error;
			}
			this.updates = 0;
			this.storedWaiting = still;
			this.compressLater(record, snapshot);
			// Unknown ids' deletes go, the ones waiting in memory with a rewrite too.
			forgetWaiting(
				doc,
				addIds(Y.createIdSet(), all, (client) => !known.has(client))
			);
			const rows = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${tables.rows}`).one().n;
			const ms = now() - started;
			tally(room.counters.compaction, ms);
			room.counters.compaction.lastBytes = snapshot.length;
			room.log({
				edytor: 'compaction',
				ms,
				bytes: snapshot.length,
				records: still.isEmpty() ? 2 : 3,
				rows
			});
			return { rows };
		});
	}

	/**
	 * Automatic compaction, once the message that made it due is
	 * acknowledged. A failure is logged and retried after half the
	 * threshold; the edit is already stored and nobody is closed.
	 */
	compactIfDue() {
		const { compactAfter } = this.room.limits;
		if (this.updates < compactAfter || this.room.live === null) return;
		try {
			this.compact();
		} catch (error) {
			this.room.note({ reason: 'storage', detail: `compaction: ${String(error)}` });
			this.updates = Math.floor(compactAfter / 2);
		}
	}

	/**
	 * Whether storage takes an update append (`room.storage.outage`): always
	 * outside an outage; during one, a probe append of an empty row, rolled
	 * back, asks it. The outage ends at the first probe or append that
	 * succeeds.
	 */
	answers(): boolean {
		if (this.outage === null) return true;
		const { sql, tables } = this.room;
		try {
			this.room.ctx.storage.transactionSync(() => {
				sql.exec(
					`INSERT INTO ${tables.rows} (kind, record, part, parts, bytes) VALUES ('update', -1, 0, 1, ?)`,
					new Uint8Array(0)
				);
				throw PROBED;
			});
		} catch (error) {
			if (error !== PROBED) {
				this.outage = error;
				return false;
			}
		}
		this.outage = null;
		return true;
	}

	/** Record now as the last stored change (callers run it in the change's transaction). */
	touch() {
		this.room.sql.exec(
			`INSERT OR REPLACE INTO ${this.room.tables.meta} (key, value) VALUES ('updated', ?)`,
			Date.now()
		);
	}

	/** When the room last stored a change (`AttachedDocument.lastUpdated`). */
	lastUpdated(): number | null {
		try {
			return (
				this.room.sql
					.exec<{
						value: number;
					}>(`SELECT value FROM ${this.room.tables.meta} WHERE key = 'updated'`)
					.toArray()[0]?.value ?? null
			);
		} catch {
			return null; // no table yet
		}
	}

	/** What the rows take: bytes, logical records, rows. */
	usage(): { bytes: number; records: number; rows: number } {
		return this.room.sql
			.exec<{
				bytes: number | null;
				records: number;
				rows: number;
			}>(
				`SELECT SUM(length(bytes)) AS bytes, COUNT(DISTINCT record) AS records, COUNT(*) AS rows FROM ${this.room.tables.rows}`
			)
			.one() as { bytes: number; records: number; rows: number };
	}

	/** Drop every waiting delete, stored or in memory (`AttachedDocument.dropWaitingDeletes`). */
	dropWaitingDeletes(): { ranges: number } {
		const room = this.room;
		return noTimers(() => {
			this.heal();
			const doc = room.requireDoc();
			const dropped = pendingDeletes(doc);
			const pending = this.pendingBytes();
			room.ctx.storage.transactionSync(() => {
				room.sql.exec(`DELETE FROM ${room.tables.rows} WHERE kind = 'pending'`);
			});
			this.documentBytes -= pending;
			this.storedWaiting = Y.createIdSet();
			forgetWaiting(doc, dropped);
			this.scheduleSave();
			return { ranges: rangeCount(dropped) };
		});
	}

	/**
	 * Drop the live doc for the stored rows (a failed append, an engine
	 * fault): `doc` and `facade` are replaced, and subscriptions on the old
	 * ones end. A read that fails now is retryable: the next dial loads
	 * again. The room's own writes (`waiting`) change nothing the engine
	 * holds waiting (updates missing a dependency, deletes kept in memory):
	 * that is carried over, not lost as at a restart.
	 */
	rebuild(waiting = false) {
		const room = this.room;
		const stale = room.live;
		if (room.unstored !== null) this.outage = room.unstored;
		room.live = null;
		room.unstored = null;
		this.load();
		const doc = room.live as YDoc | null;
		if (waiting && stale !== null && doc !== null) {
			doc.store.pendingStructs = stale.store.pendingStructs;
			doc.store.pendingDs = stale.store.pendingDs;
		}
		stale?.destroy();
	}

	/**
	 * A room-side write outside `transact` (straight through `facade`)
	 * whose append failed left the live doc ahead of storage: rebuild it
	 * before anything is served, read or acknowledged. Only while the room
	 * is idle (not `busy`): from inside a transaction, a frame's apply or
	 * their events (a `facade.onChange` subscriber, a
	 * `doc.on('afterAllTransactions')` listener), the failure stays for
	 * the handler — a frame's faults its sender, `transact` throws it.
	 */
	heal() {
		const room = this.room;
		if (room.unstored === null || room.live === null || room.busy) return;
		room.note({ reason: 'storage', detail: String(room.unstored) });
		this.rebuild(true);
	}

	private adopt(doc: YDoc) {
		const room = this.room;
		room.validation.reset();
		room.history.detach();
		room.disposeFacade();
		room.live = doc;
		// Every INTEGRATED update is persisted first, then relayed to
		// everyone but its sender (the socket is the transaction origin).
		// A failed append relays nothing; the sender's handler rebuilds.
		// Nothing may throw out of here: the engine would never emit
		// `update` again (compaction runs later, in `compactIfDue`).
		doc.on('update', (update: Uint8Array, origin: unknown, _doc: unknown, tr: unknown) => {
			if (room.unstored !== null) return;
			const editor = room.history.editorOf(origin);
			try {
				room.ctx.storage.transactionSync(() => {
					this.insert('update', update);
					this.touch();
					if (editor !== null) room.history.storeEditor(editor);
				});
				if (editor !== null) room.history.slotEditors.add(editor);
				this.outage = null;
				this.updates++;
				room.broadcast(updateFrame(update), origin);
				this.scheduleSave();
				this.noteChange(origin);
			} catch (error) {
				room.unstored = error;
			}
			try {
				room.moves.noteLateEdits(tr as { changed?: Map<unknown, Set<string | null>> });
			} catch (error) {
				room.note({ reason: 'internal', detail: `move: ${String(error)}` });
			}
		});
	}

	/**
	 * A change was stored: arm the purge tick (`room.purge.timing`) and open
	 * the history slot it falls in (`room.history.slots`).
	 */
	private noteChange(origin: unknown) {
		const at = this.room.clock();
		this.room.purge.noteChange(at);
		this.room.history.noteChange(origin, at);
	}

	// ── The `onSave` mirror ─────────────────────────────────────────────

	/** The `save` task: `onSave` with the document, or the save kept due while the rows cannot be read. */
	async save(): Promise<void> {
		const room = this.room;
		const { scheduler } = room;
		if (!room.options.onSave) return scheduler.unschedule('save');
		if (room.live === null) {
			if (!this.retryable) return scheduler.unschedule('save');
			const wait = Math.min(room.limits.saveAfter * 2 ** ++this.saveRetries, MAX_SAVE_RETRY);
			return scheduler.schedule('save', room.clock() + wait, 'replace');
		}
		this.saveRetries = 0;
		const due = scheduler.due('save')!;
		// Cleared first: a change during `onSave` arms the next one.
		scheduler.unschedule('save');
		// One synchronous read: the registry matches the state it is saved with.
		const saved = {
			value: room.read(),
			update: Y.encodeStateAsUpdate(room.live),
			replicas: room.sql
				.exec<ReplicaOwner>(`SELECT replica, user FROM ${room.tables.replicas} ORDER BY replica`)
				.toArray()
		};
		try {
			await room.options.onSave(saved);
		} catch (error) {
			scheduler.schedule('save', due);
			throw error;
		}
	}

	/** The first unsaved change arms the save alarm; a save already due keeps its time. */
	scheduleSave() {
		const room = this.room;
		if (room.options.onSave) room.scheduler.schedule('save', room.clock() + room.limits.saveAfter);
	}
}
