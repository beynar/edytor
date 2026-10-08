/**
 * The room's explicit context: what every part of an attached document
 * shares — the Durable Object state, the options, the live document and
 * its facade, the flags of what is running, the counters and diagnostics —
 * and the primitives each part uses (log a refusal, send, broadcast, close
 * a socket). Each part (`storage`, `scheduler`, `admission`, …) is one
 * module under `room/`, wired by `AttachedDocument` (`DocumentRoom.ts`);
 * a part reaches another only through this context.
 */
import { Y } from '../../crdt/engine.js';
import * as E from '../../crdt/protocol.js';
import { CLOSE } from '../../crdt/providers/room.js';
import { asEngineDoc } from '../../crdt/structs.js';
import { defaultSemantics, facadeConfigOf, semanticsDigest } from '../../crdt/semantics.js';
import type { DocumentSemanticsConfig, EdytorDoc, JSONDoc, YDoc } from '../../crdt/index.js';
import type {
	AttachRoomOptions,
	AttachedDocument,
	Refusal,
	RoomLogEntry,
	Timing
} from '../DocumentRoom.js';
import { MAX_REFUSALS, ROOM_ORIGIN, SOCKET_TAG, noTimers } from './shared.js';
import type { RoomAccess } from './access.js';
import type { Admission } from './admission.js';
import type { RoomComments } from './comments.js';
import type { RoomHistory } from './history.js';
import type { RoomMoves } from './moves.js';
import type { RoomPresence } from './presence.js';
import type { RoomPurge } from './purge.js';
import type { ReplicaRegistry } from './replicas.js';
import type { Scheduler } from './scheduler.js';
import type { RoomStorage } from './storage.js';
import type { RoomValidation } from './validation.js';

/** The engine API the room is built on (the Worker-safe CRDT entry). */
export const crdt = E.bindCrdt(Y);
export const sync = crdt.sync;

/** A decoded update, and its parts. */
export type Decoded = ReturnType<typeof Y.decodeUpdate>;
export type Struct = Decoded['structs'][number];
export type Item = InstanceType<typeof Y.Item>;

/** A day, in ms: the purge task's period. */
export const DAY = 86_400_000;

/** The 1011 close of a storage fault: the provider redials and resends. */
export const STORAGE_FAILURE = 'storage failure';

/** A positive integer knob (`fallback` otherwise), at most `max`. */
export const knob = (value: unknown, fallback: number, max = fallback) => {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};

export const now = (): number =>
	typeof performance !== 'undefined' && typeof performance.now === 'function'
		? performance.now()
		: Date.now();

const timing = (): Timing => ({ count: 0, totalMs: 0, maxMs: 0, lastMs: 0 });
export const tally = (t: Timing, ms: number) => {
	t.count++;
	t.totalMs += ms;
	t.maxMs = Math.max(t.maxMs, ms);
	t.lastMs = ms;
};

export const encodeJSON = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** A semantics config as the facade's lookups — own keys only: block types come off the wire. */
const lookups = (semantics: DocumentSemanticsConfig) => facadeConfigOf(semantics);

/** The room's limits, resolved from its options (`AttachedDocument`'s public knobs). */
export type RoomLimits = Readonly<{
	maxRowBytes: number;
	maxFrameBytes: number;
	compactAfter: number;
	saveAfter: number;
	maxDocumentBytes: number;
	documentWarning: number;
	maxInboundFrameBytes: number;
	maxBufferedBytes: number;
	maxUpdatesPerSecond: number;
	maxPresenceBytes: number;
	maxPresencePerSecond: number;
	maxPresenceFanout: number;
}>;

/** The room's SQL tables, named from its `tablePrefix`. */
export type RoomTables = {
	rows: string;
	replicas: string;
	meta: string;
	epochs: string;
	editors: string;
	restore: string;
	moves: string;
	late: string;
	threads: string;
	comments: string;
};

/** The room's public diagnostics, kept on the `AttachedDocument` itself. */
export type RoomState = Pick<
	AttachedDocument,
	'failure' | 'presence' | 'refusals' | 'refusalCounts' | 'origin'
>;

/** The counters `metrics()` reads. */
const counters = () => ({
	compaction: { ...timing(), lastBytes: 0 },
	fold: timing(),
	fanOut: { messages: 0, bytes: 0 },
	history: { written: 0, skipped: 0, lastKey: null as string | null },
	purge: {
		runs: 0,
		horizon: null as number | null,
		removed: 0,
		emptied: 0,
		marks: 0,
		records: 0,
		candidates: 0,
		claims: 0,
		merged: 0
	},
	since: Date.now()
});

export class RoomContext {
	readonly ctx: DurableObjectState;
	readonly sql: SqlStorage;
	readonly options: AttachRoomOptions;
	readonly limits: RoomLimits;
	readonly tablePrefix: string;
	readonly tables: RoomTables;
	/** The room's clock (`now`). */
	readonly clock: () => number;
	/** The public diagnostics (`failure`, `presence`, `refusals`, `refusalCounts`, `origin`). */
	readonly state: RoomState;
	/** The counters `metrics()` reads. */
	readonly counters = counters();
	/** The live document (`null`: the stored container was refused, or could not be read). */
	live: YDoc | null = null;
	/** A failed append: the live doc holds what storage does not, until it is rebuilt. */
	unstored: unknown = null;
	/** Inside `transact`, its commit included (a nested call is refused but while `fn` runs). */
	transacting = false;
	/** Inside `transact`'s `fn`: a nested call joins the enclosing transaction. */
	running = false;
	/** Inside a client frame's apply, its events included: the frame's handler settles it. */
	handling = false;

	// The parts, wired by `AttachedDocument`.
	storage!: RoomStorage;
	scheduler!: Scheduler;
	admission!: Admission;
	replicas!: ReplicaRegistry;
	validation!: RoomValidation;
	history!: RoomHistory;
	purge!: RoomPurge;
	moves!: RoomMoves;
	presence!: RoomPresence;
	access!: RoomAccess;
	comments!: RoomComments;

	private _facade: EdytorDoc | null = null;
	private _lookups: ReturnType<typeof lookups> | null = null;
	private _digest: Record<string, string> | null = null;

	constructor(
		ctx: DurableObjectState,
		options: AttachRoomOptions,
		limits: RoomLimits,
		state: RoomState
	) {
		this.ctx = ctx;
		this.options = options;
		this.limits = limits;
		this.state = state;
		this.sql = ctx.storage.sql;
		const prefix = options.tablePrefix ?? 'edytor_';
		if (!/^\w*$/.test(prefix)) throw new Error(`invalid table prefix ${prefix}`);
		this.tablePrefix = prefix;
		this.tables = {
			rows: `${prefix}rows`,
			replicas: `${prefix}replicas`,
			meta: `${prefix}meta`,
			epochs: `${prefix}epochs`,
			editors: `${prefix}editors`,
			restore: `${prefix}restore`,
			moves: `${prefix}moves`,
			late: `${prefix}late`,
			threads: `${prefix}threads`,
			comments: `${prefix}comments`
		};
		this.clock = options.now ?? Date.now;
	}

	/** The room's id: its name (`getByName`), else the object's id. */
	get roomId(): string {
		return this.ctx.id.name ?? this.ctx.id.toString();
	}

	// ── The document ─────────────────────────────────────────────────────

	/** The room's block roles, read at first use (a subclass's fields exist by then). */
	get lookups(): ReturnType<typeof lookups> {
		return (this._lookups ??= lookups(this.options.semantics ?? defaultSemantics));
	}

	/** The digest of the room's block roles a client's advertised one is compared with. */
	get digest(): Record<string, string> {
		return (this._digest ??= semanticsDigest(this.options.semantics ?? defaultSemantics));
	}

	/** A facade over `doc` obeying the room's block roles (`semantics`). */
	facadeOf(doc: YDoc): EdytorDoc {
		return crdt.doc.create(asEngineDoc(doc), this.lookups) as EdytorDoc;
	}

	/**
	 * The facade over the live document. Read while the room is idle, it
	 * first drops a direct write whose append failed (`heal`).
	 */
	get facade(): EdytorDoc {
		noTimers(() => this.storage.heal());
		return (this._facade ??= this.facadeOf(this.requireDoc()));
	}

	/** Dispose of the facade over the live document (a new one is made at the next read). */
	disposeFacade() {
		this._facade?.dispose();
		this._facade = null;
	}

	/** The document as JSON. */
	read(): JSONDoc {
		noTimers(() => this.storage.heal());
		return this.facade.toJSON();
	}

	requireDoc(): YDoc {
		if (this.live === null) throw this.state.failure ?? new Error('room has no document');
		return this.live;
	}

	/**
	 * Inside a room `transact` (its commit included), a client frame's apply
	 * or any transaction's events: a write now could not be stored before
	 * it returns, and a failed append belongs to what is being handled.
	 */
	get busy(): boolean {
		return this.transacting || this.handling || (this.live?._transactionCleanups.length ?? 0) > 0;
	}

	/** Run a frame's apply: nothing its listeners do heals it. */
	handle<T>(fn: () => T): T {
		this.handling = true;
		try {
			return fn();
		} finally {
			this.handling = false;
		}
	}

	/** A room transaction (`AttachedDocument.transact`). */
	transact<T>(fn: (facade: EdytorDoc) => T): T {
		if (this.running) return fn(this.facade);
		return noTimers(() => {
			if (this.busy) {
				throw new Error(
					'room transact inside another transaction or its change events: its write could not be stored before it returns; defer it (queueMicrotask)'
				);
			}
			this.storage.heal();
			const doc = this.requireDoc();
			this.history.closeSlotIfPast();
			if (!crdt.doc.isInitialized(asEngineDoc(doc))) this.facade.seed([]);
			let result!: T;
			let thrown = null as { error: unknown } | null;
			this.transacting = true;
			try {
				this.facade.transact(() => {
					this.running = true;
					try {
						result = fn(this.facade);
					} finally {
						this.running = false;
					}
				}, ROOM_ORIGIN);
			} catch (error) {
				thrown = { error };
			} finally {
				this.transacting = false;
			}
			// A failed append outranks fn's error: only the stored rows are kept.
			if (this.unstored !== null) {
				const error = this.unstored;
				this.storage.heal();
				throw error;
			}
			this.storage.compactIfDue();
			if (thrown !== null) throw thrown.error;
			return result;
		});
	}

	// ── Diagnostics ──────────────────────────────────────────────────────

	/** Log a refusal: the newest {@link MAX_REFUSALS} are kept, every reason is counted. */
	note(refusal: Refusal) {
		const { refusals, refusalCounts } = this.state;
		refusals.push(refusal);
		if (refusals.length > MAX_REFUSALS) refusals.shift();
		refusalCounts[refusal.reason] = (refusalCounts[refusal.reason] ?? 0) + 1;
	}

	/** Write one log entry — the `log` option's, `console.log` by default. */
	log(entry: RoomLogEntry) {
		const log = this.options.log;
		if (log === false) return;
		try {
			if (log) log(entry);
			else console.log(JSON.stringify(entry));
		} catch {
			// a log never fails the room
		}
	}

	// ── Sockets ──────────────────────────────────────────────────────────

	/** Send one frame — as chunks when it exceeds `maxFrameBytes` (bounded catch-up). */
	send(ws: WebSocket, bytes: Uint8Array) {
		for (const piece of E.chunkFrame(bytes, this.limits.maxFrameBytes)) ws.send(piece);
	}

	broadcast(bytes: Uint8Array, except: unknown) {
		const pieces = E.chunkFrame(bytes, this.limits.maxFrameBytes);
		for (const ws of this.ctx.getWebSockets(SOCKET_TAG)) {
			if (ws === except || ws.readyState !== WebSocket.OPEN) continue;
			try {
				for (const piece of pieces) ws.send(piece);
				this.counters.fanOut.messages += pieces.length;
				this.counters.fanOut.bytes += bytes.length;
			} catch {
				// a socket that died mid-broadcast gets its close event
			}
		}
	}

	close(ws: WebSocket, code: number, reason: string) {
		this.admission.forget(ws);
		try {
			ws.close(code, reason);
		} catch {
			// already closing
		}
	}

	/** A refused frame is dropped whole and its socket closed (1008 policy violation). */
	refuse(ws: WebSocket, refusal: Refusal) {
		this.note(refusal);
		this.presence.depart(ws);
		this.close(ws, CLOSE.refused, `refused: ${refusal.reason}`);
	}

	/**
	 * No document to serve: a container that cannot be restored is
	 * refused for good (1008, the provider stops dialing); a failed read of
	 * the rows or an `onLoad` that threw is retried at the next dial (1011,
	 * the provider redials).
	 */
	refuseContainer(ws: WebSocket) {
		if (!this.storage.retryable)
			return this.refuse(ws, { reason: 'container', detail: this.state.failure?.message });
		this.note({ reason: 'container', detail: this.state.failure?.message });
		this.close(ws, CLOSE.fault, 'room unavailable');
	}
}
