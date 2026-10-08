/**
 * Admission: every client frame, from its bytes to its acknowledgement.
 * The frame quota and the chunk sequences, the generation word, the rate
 * and document quotas, the read-only denial, the attribution of new
 * structs (`ReplicaRegistry`), forged marks and attribution entries
 * (`forged.ts`), the cap on waiting deletes, the inbound schema refusal,
 * validation (`RoomValidation`), and the store-before-ack `messageSaved`.
 * A refused frame is never applied, stored or relayed; only the client's
 * undecodable bytes are its fault (`malformed`), the room's own faults
 * close 1011.
 */
import { Y } from '../../crdt/engine.js';
import * as E from '../../crdt/protocol.js';
import { ChunkLimitError, ChunkSequenceError, CLOSE } from '../../crdt/providers/room.js';
import type { YDoc } from '../../crdt/index.js';
import { MAX_WAITING_DELETES, noTimers, type Attachment } from '../DocumentRoom.js';
import { STORAGE_FAILURE, now, sync, tally, type Decoded, type RoomContext } from './context.js';
import {
	attributionWrites,
	BINDING_PREFIX,
	forgedAttributionDeletes,
	forgedDeletes,
	forgedWriters
} from './forged.js';
import {
	MalformedFrame,
	decode,
	readOnlyDenialFrame,
	savedFrame,
	step1Frame,
	storedStep2,
	updateFrame
} from './frames.js';
import { StorageFault } from './replicas.js';
import {
	addIds,
	deletesUpdate,
	forgetWaiting,
	freedBy,
	heldDeletes,
	newWriters,
	pendingDeletes,
	rangeCount,
	releasedWaiting,
	replacedEntries,
	stateVector,
	storedStruct,
	unheldDeletes,
	withoutClients
} from './updates.js';

/** The provider's keepalive text frame, and the room's answer. */
export const PING = 'ping';
export const PONG = 'pong';

/** Seconds of the update rate a socket may spend at once. */
const BURST_SECONDS = 10;

/** Each socket's allowance (a token bucket; memory: a wake refills it). */
export type Allowances = WeakMap<WebSocket, { tokens: number; at: number }>;

/**
 * A token bucket per socket, refilled at `perSecond` up to ten seconds'
 * worth: takes one token. `false`: over the rate.
 */
export const allowance = (allowances: Allowances, ws: WebSocket, perSecond: number): boolean => {
	const now = Date.now();
	const burst = perSecond * BURST_SECONDS;
	const held = allowances.get(ws) ?? { tokens: burst, at: now };
	const tokens = Math.min(burst, held.tokens + ((now - held.at) / 1000) * perSecond);
	if (tokens < 1) {
		allowances.set(ws, { tokens, at: now });
		return false;
	}
	allowances.set(ws, { tokens: tokens - 1, at: now });
	return true;
};

/** A chunk sequence the room does not take at its start: past the rate, or past the room's buffer. */
class ChunksRefused extends Error {
	constructor(
		readonly quota: 'rate' | 'buffer',
		readonly detail: Record<string, number>
	) {
		super(`chunks: ${quota}`);
	}
}

export class Admission {
	/** Each socket's update allowance. */
	private readonly allowances: Allowances = new WeakMap();
	/**
	 * Each socket's chunked frame in flight, released when it ends or its
	 * socket closes (memory: a wake loses it, and the socket is faulted).
	 */
	private readonly chunkReaders = new Map<WebSocket, E.ChunkReader>();

	constructor(private readonly room: RoomContext) {}

	/** Release `ws`'s chunk sequence in flight (it closed, or was closed). */
	forget(ws: WebSocket) {
		this.chunkReaders.delete(ws);
	}

	/** One message of a document socket (`AttachedDocument.webSocketMessage`). */
	message(ws: WebSocket, message: string | ArrayBuffer) {
		const room = this.room;
		noTimers(() => {
			// A refused socket is closing: frames it had in flight are dropped unread.
			if (ws.readyState !== WebSocket.OPEN) return;
			if (message === PING) return ws.send(PONG);
			if (typeof message === 'string') {
				return room.refuse(ws, { reason: 'malformed', detail: 'text frame' });
			}
			room.storage.heal();
			const doc = room.live;
			if (doc === null) return room.refuseContainer(ws);
			const attachment = ws.deserializeAttachment() as Attachment | null;
			if (!attachment?.user) return room.refuse(ws, { reason: 'identity', detail: null });
			if (attachment.expiresAt != null && room.clock() >= attachment.expiresAt) {
				return room.access.endAccess([ws], 'expired', CLOSE.expired, 'expired');
			}
			try {
				this.onFrame(ws, attachment, doc, new Uint8Array(message));
			} finally {
				room.presence.release();
			}
		});
	}

	/** One frame: whole as it came, or reassembled from its chunks. */
	private onFrame(ws: WebSocket, attachment: Attachment, doc: YDoc, bytes: Uint8Array) {
		const room = this.room;
		const limit = room.limits.maxInboundFrameBytes;
		// The frame quota (H3): never decoded past it.
		if (bytes.length > limit) {
			return this.overQuota(ws, attachment.user, 'frame', { bytes: bytes.length, limit });
		}
		const decoder = E.createDecoder(bytes);
		// 1 · Admission: the generation word, before anything is decoded.
		if (!E.readProtocolVersion(decoder)) {
			return room.refuse(ws, { reason: 'generation', detail: bytes[0] });
		}
		try {
			const type = decode(() => E.readVarUint(decoder));
			if (type === E.messageChunk) return this.onChunk(ws, attachment, doc, decoder);
			if (type === E.messageSync) return this.onSync(ws, attachment, doc, decoder);
			if (type === E.messageAwareness) {
				const entries = decode(() => E.readAwarenessEntries(E.readVarUint8Array(decoder)));
				return room.presence.onPresence(ws, attachment, doc, entries);
			}
			if (type === E.messageQueryAwareness) {
				// A query costs a snapshot of every entry: past the rate, dropped.
				if (!room.presence.allow(ws)) return room.presence.overRate(ws, attachment);
				return room.send(ws, room.presence.snapshot());
			}
			room.refuse(ws, { reason: 'malformed', detail: `message type ${type}` });
		} catch (error) {
			// Only the client's bytes are its fault: the room's own faults close 1011.
			if (error instanceof MalformedFrame) {
				room.refuse(ws, { reason: 'malformed', detail: error.message });
			} else {
				this.fault(ws, error);
			}
		}
	}

	/**
	 * One chunk of a frame too large to send whole (a provider's
	 * reconnect diff): buffered per socket into one buffer of the
	 * sequence's announced size, the whole frame handled once its sequence
	 * ends (`net.chunk.inbound`). A sequence announcing more than
	 * `maxInboundFrameBytes` is a frame quota refusal, before anything is
	 * buffered; its start is admitted by {@link admitChunks}. A part with no
	 * sequence started — the room woke between two chunks and lost the
	 * buffer — faults the socket (1011): its provider redials and resends.
	 */
	private onChunk(ws: WebSocket, attachment: Attachment, doc: YDoc, decoder: E.Decoder) {
		const room = this.room;
		let read = this.chunkReaders.get(ws);
		if (read === undefined) {
			read = E.createChunkReader(room.limits.maxInboundFrameBytes, (total) =>
				this.admitChunks(ws, total)
			);
			this.chunkReaders.set(ws, read);
		}
		let whole: Uint8Array | null;
		try {
			whole = read(decoder);
		} catch (error) {
			this.chunkReaders.delete(ws);
			if (error instanceof ChunkLimitError) {
				return this.overQuota(ws, attachment.user, 'frame', {
					bytes: error.total,
					limit: error.limit
				});
			}
			if (error instanceof ChunksRefused) {
				if (error.quota === 'rate') {
					return this.overQuota(ws, attachment.user, 'rate', error.detail);
				}
				// The room's buffer is full, not the sender at fault: it redials.
				room.note({
					reason: 'quota',
					detail: { user: attachment.user, quota: 'buffer', ...error.detail }
				});
				room.log({ edytor: 'quota', user: attachment.user, quota: 'buffer' });
				room.presence.depart(ws);
				return room.close(ws, CLOSE.fault, 'room busy');
			}
			if (error instanceof ChunkSequenceError) {
				room.note({ reason: 'internal', detail: `chunks: ${error.message}` });
				room.presence.depart(ws);
				return room.close(ws, CLOSE.fault, 'chunk sequence lost');
			}
			throw new MalformedFrame(String(error));
		}
		if (whole !== null) this.onFrame(ws, attachment, doc, whole);
	}

	/**
	 * Admit a chunk sequence's start (`net.chunk.inbound`), before its
	 * buffer is allocated: a read-only socket's is skipped, never buffered
	 * (it could only carry a write: denied, the socket stays); the start
	 * counts against the update rate; and the sequences in flight on every
	 * socket share `maxBufferedBytes` ({@link ChunksRefused}).
	 */
	private admitChunks(ws: WebSocket, total: number): boolean {
		const room = this.room;
		const attachment = ws.deserializeAttachment() as Attachment;
		if (attachment.readOnly) {
			room.note({ reason: 'read-only', detail: attachment.user });
			room.send(ws, readOnlyDenialFrame());
			return false;
		}
		if (!this.allow(ws))
			throw new ChunksRefused('rate', { perSecond: room.limits.maxUpdatesPerSecond });
		let buffered = 0;
		for (const [other, read] of this.chunkReaders) if (other !== ws) buffered += read.buffered;
		const limit = room.limits.maxBufferedBytes;
		if (buffered + total > limit) {
			throw new ChunksRefused('buffer', { bytes: total, buffered, limit });
		}
		return true;
	}

	/** What the room buffers for chunk sequences in flight (`metrics().buffered`). */
	buffered(): { sequences: number; bytes: number } {
		let sequences = 0;
		let bytes = 0;
		for (const read of this.chunkReaders.values()) {
			if (read.buffered === 0) continue;
			sequences++;
			bytes += read.buffered;
		}
		return { sequences, bytes };
	}

	/**
	 * A quota refused the socket's frame: it is not applied, and the
	 * socket is closed `4413` (`quota: <name>`), a refusal its provider
	 * reports (`onSyncRefused`) and does not redial. Never a dropped frame
	 * on a live socket: the sender's later frames would build on it and
	 * wait in the room's memory for good, unstored and unacknowledged; and
	 * a redial would resend it and meet the same quota.
	 */
	private overQuota(
		ws: WebSocket,
		user: string,
		quota: 'document' | 'rate' | 'frame',
		detail: Record<string, number>
	) {
		const room = this.room;
		room.note({ reason: 'quota', detail: { user, quota, ...detail } });
		room.log({ edytor: 'quota', user, quota });
		this.chunkReaders.delete(ws);
		room.presence.depart(ws);
		room.close(ws, CLOSE.quota, `quota: ${quota}`);
	}

	/**
	 * The update rate quota: a token bucket per socket, refilled at
	 * `maxUpdatesPerSecond` up to ten seconds' worth. `false`: over it.
	 * Presence messages draw from a bucket of their own (`RoomPresence`).
	 */
	private allow(ws: WebSocket): boolean {
		return allowance(this.allowances, ws, this.room.limits.maxUpdatesPerSecond);
	}

	/**
	 * The document quota: would `incoming` bytes take the document
	 * past `maxDocumentBytes`? Its measure is what its records hold and what
	 * the engine holds waiting; update records count until compaction
	 * collapses them, so it compacts first when they would.
	 */
	private overDocument(incoming: number, freed: number): boolean {
		const room = this.room;
		const { storage } = room;
		const limit = room.limits.maxDocumentBytes;
		// A frame that deletes at least what it adds always applies: a full
		// document can still be trimmed.
		if (incoming <= freed) return false;
		const usage = () =>
			storage.documentBytes +
			(room.live?.store.pendingStructs?.update.length ?? 0) +
			incoming -
			freed;
		if (usage() <= limit) return false;
		if (storage.updates > 0) {
			try {
				storage.compact();
			} catch (error) {
				room.note({ reason: 'storage', detail: `compaction: ${String(error)}` });
			}
		}
		return usage() > limit;
	}

	private onSync(ws: WebSocket, attachment: Attachment, doc: YDoc, decoder: E.Decoder) {
		const room = this.room;
		const syncType = decode(() => E.readVarUint(decoder));
		// The rate quota (H3) counts every sync message, a Step1 too (it costs a Step2).
		if (!this.allow(ws)) {
			return this.overQuota(ws, attachment.user, 'rate', {
				perSecond: room.limits.maxUpdatesPerSecond
			});
		}
		if (syncType === E.messageYjsSyncStep1) {
			const sv = decode(() => {
				const sv = E.readVarUint8Array(decoder);
				Y.decodeStateVector(sv);
				return sv;
			});
			room.send(ws, storedStep2(doc, sv));
			if (!attachment.readOnly && sync.lacks(doc, sv)) room.send(ws, step1Frame(doc));
			return room.send(ws, savedFrame(doc));
		}
		if (syncType !== E.messageYjsSyncStep2 && syncType !== E.messageYjsUpdate) {
			return room.refuse(ws, { reason: 'malformed', detail: `sync type ${syncType}` });
		}
		// A SyncStep2 is v2 on the wire (P5): every path below reads v1.
		const update = decode(() => {
			const payload = E.readVarUint8Array(decoder);
			return syncType === E.messageYjsSyncStep2 ? sync.step2Update(payload) : payload;
		});
		const started = now();
		try {
			this.onUpdate(ws, attachment, doc, update);
		} finally {
			tally(room.counters.fold, now() - started);
		}
	}

	/** A client's Step2 or Update: admitted, applied, stored, relayed, validated, acknowledged. */
	private onUpdate(ws: WebSocket, attachment: Attachment, doc: YDoc, update: Uint8Array) {
		const room = this.room;
		const { replicas, storage } = room;
		// 2 · Access: a read-only socket writes nothing (it stays, and is told).
		if (attachment.readOnly) {
			room.note({ reason: 'read-only', detail: attachment.user });
			return room.send(ws, readOnlyDenialFrame());
		}
		// 3 · Attribution: new structs only under client ids this user may
		// write under; another user's are stripped, the rest applied.
		const decoded = decode(() => Y.decodeUpdate(update));
		// The document quota (H3), net of what the frame deletes.
		if (
			decoded.structs.some((struct) => !(struct instanceof Y.Skip)) &&
			this.overDocument(update.length, freedBy(doc, decoded.ds))
		) {
			return this.overQuota(ws, attachment.user, 'document', {
				bytes: storage.documentBytes,
				incoming: update.length,
				limit: room.limits.maxDocumentBytes
			});
		}
		const sv = stateVector(doc);
		const orphans = new Set<number>();
		const stripped = replicas.attribute(attachment, newWriters(decoded, sv), sv, orphans);
		// Per-writer block marks (H2): only `n` writes or deletes `del.<n>` /
		// `wd.<n>`. A client writing another's is stripped whole, as a client
		// under another user's id is; a delete of another's mark is dropped.
		const forgers = forgedWriters(doc, decoded.structs, stripped);
		const owners = new Map<number, boolean>();
		const mayDelete = (writer: number) => {
			if (writer === attachment.replica) return true;
			if (!owners.has(writer)) owners.set(writer, replicas.ownerOf(writer) === attachment.user);
			return owners.get(writer)!;
		};
		const forgedMarks = decoded.ds.isEmpty()
			? Y.createIdSet()
			: forgedDeletes(doc, decoded.ds, mayDelete);
		if (forgers.size > 0 || !forgedMarks.isEmpty()) {
			for (const client of forgers) stripped.add(client);
			room.note({
				reason: 'mark',
				detail: { user: attachment.user, writers: [...forgers], ranges: rangeCount(forgedMarks) }
			});
		}
		// Attribution (`room.attribution.trust`): a replica binds only
		// itself, to its verified user, and a user writes only its own
		// profile. Another's entry is collected (its clock kept as a GC), a
		// delete of one dropped; a binding of the sender's own replica to
		// another actor, or of an id it claimed, is rebound below.
		const owns = (client: number) => client === attachment.replica || mayDelete(client);
		const attribution = attributionWrites(
			doc,
			decoded.structs,
			stripped,
			attachment.user,
			owns,
			(client) => replicas.ownerOf(client)
		);
		// The deletes of entries stripped or collected structs replace go with
		// them (`withoutClients`): only the frame's other deletes are checked.
		const forgedEntries = decoded.ds.isEmpty()
			? { ids: Y.createIdSet(), keys: [] }
			: forgedAttributionDeletes(
					doc,
					Y.diffIdSet(
						decoded.ds,
						replacedEntries(
							doc,
							decoded.structs,
							(item) => stripped.has(item.id.client) || attribution.collected.has(item)
						)
					),
					attachment.user,
					owns
				);
		if (attribution.keys.length > 0 || forgedEntries.keys.length > 0) {
			room.note({
				reason: 'forged',
				detail: {
					user: attachment.user,
					keys: [...new Set([...attribution.keys, ...forgedEntries.keys])]
				}
			});
		}
		// Waiting deletes are capped: a frame that would pass the cap has them dropped.
		const waiting = pendingDeletes(doc);
		const unheld = decoded.ds.isEmpty() ? null : unheldDeletes(decoded, stripped, doc);
		const overflow =
			unheld && rangeCount(waiting) + rangeCount(unheld) > MAX_WAITING_DELETES ? unheld : null;
		if (overflow !== null) {
			room.note({
				reason: 'waiting',
				detail: { user: attachment.user, ranges: rangeCount(overflow) }
			});
		}
		const dropped =
			overflow === null && forgedMarks.isEmpty() && forgedEntries.ids.isEmpty()
				? null
				: addIds(
						addIds(addIds(Y.createIdSet(), overflow ?? Y.createIdSet()), forgedMarks),
						forgedEntries.ids
					);
		const admitted =
			stripped.size === 0 && dropped === null && attribution.collected.size === 0
				? update
				: withoutClients(decoded, stripped, doc, dropped ?? undefined, attribution.collected);
		// A history slot past its end is written as it was, before the frame (H11).
		room.history.closeSlotIfPast();
		// Validation (H2) reads the document as it was, and records the frame.
		const validation = room.validation.active ? room.validation.begin(doc, ws) : null;
		// 4 · Schema: the inbound refusal of a foreign stamp (the update's,
		// or a pending one it would release — discarded, the sender kept).
		// Integrating persists (the doc's update handler) before the ack.
		let failure: unknown = null;
		validation?.history?.trackedOrigins.add(ws);
		let outcome: ReturnType<typeof sync.applyRemote>;
		try {
			outcome = room.handle(() =>
				sync.applyRemote(doc, admitted, ws, (error) => {
					failure = error;
				})
			);
		} finally {
			validation?.history?.trackedOrigins.delete(ws);
		}
		const { applied, problem, discarded } = outcome;
		if (room.unstored !== null) return this.fault(ws, room.unstored);
		if (problem !== null) return room.refuse(ws, { reason: 'schema', detail: problem });
		// The bytes decoded: an update the engine could not apply is its fault.
		if (!applied) return this.fault(ws, failure ?? new Error('update not applied'));
		// The entries the frame's own still-waiting rewrites replace.
		const stay =
			doc.store.pendingStructs === null
				? Y.createIdSet()
				: replacedEntries(
						doc,
						decoded.structs,
						({ id }) => !stripped.has(id.client) && storedStruct(doc, id.client, id.clock) === null
					);
		const released = room.handle(() =>
			this.settleDeletes(ws, attachment.user, doc, waiting, stay, discarded !== undefined)
		);
		if (room.unstored !== null) return this.fault(ws, room.unstored);
		if (discarded) room.note({ reason: 'schema', detail: { discarded } });
		if (validation !== null) {
			room.validation.settle(validation, attachment);
			if (room.unstored !== null) return this.fault(ws, room.unstored);
		}
		// A claimed orphan's binding, which its relayer's frame may have lost.
		for (const client of orphans) attribution.rebind.add(BINDING_PREFIX + client);
		if (attribution.rebind.size > 0) {
			room.handle(() => replicas.rebind(doc, attribution.rebind, attachment.user));
			if (room.unstored !== null) return this.fault(ws, room.unstored);
		}
		// A dropped delete is not acknowledged: its sender stays unsaved.
		room.send(ws, savedFrame(doc, addIds(this.storedDeletes(doc, decoded.ds), released)));
		// Waiting writes the frame released are other sockets' (a relayer's
		// edit that built on an author's lost one): they are stored now, with
		// the deletes that waited with them.
		if (releasedWaiting(decoded.structs, stripped, sv, stateVector(doc))) {
			room.broadcast(savedFrame(doc, released), ws);
		}
		storage.compactIfDue();
	}

	/**
	 * A delete of items the room does not hold (a relayer's delete of an
	 * author's edit a restore lost) waits in the engine for them: it is
	 * stored as it arrives, so it survives eviction and compaction and
	 * applies when the author's edit returns. Except the entries the frame's
	 * own still-waiting rewrites replace (`stay`): those deletes wait with
	 * the rewrites in memory, as the rewrites may never integrate. A frame
	 * that released a pending forged stamp discarded every waiting delete
	 * (`applyRemote`): the stored ones go too. The deletes the frame applied
	 * from the waiting ones go back to its sender, whom the relay of the
	 * update skips; they are returned. The cap holds here too: deletes of
	 * the frame's own structs that wait for an origin (stored, or kept in
	 * memory with its rewrites) pass the check before applying; when the
	 * frame's new waiting deletes take the room past
	 * {@link MAX_WAITING_DELETES}, they are all dropped (refusal `waiting`,
	 * the sender's), unstored and unacknowledged. A replaced entry is
	 * deleted by its rewrite anyway, should that integrate.
	 */
	private settleDeletes(
		ws: WebSocket,
		user: string,
		doc: YDoc,
		waiting: Decoded['ds'],
		stay: Decoded['ds'],
		discarded: boolean
	): Decoded['ds'] {
		const room = this.room;
		const { storage } = room;
		let now = pendingDeletes(doc);
		const fresh = discarded ? now : Y.diffIdSet(now, waiting);
		if (!fresh.isEmpty() && rangeCount(now) > MAX_WAITING_DELETES) {
			room.note({ reason: 'waiting', detail: { user, ranges: rangeCount(fresh) } });
			forgetWaiting(doc, fresh);
			now = pendingDeletes(doc);
		}
		const added = Y.diffIdSet(discarded ? now : Y.diffIdSet(now, waiting), stay);
		const released = heldDeletes(doc, Y.diffIdSet(waiting, now));
		if (discarded || !added.isEmpty()) {
			const before = storage.documentBytes;
			const pending = discarded ? storage.pendingBytes() : 0;
			try {
				room.ctx.storage.transactionSync(() => {
					if (discarded) room.sql.exec(`DELETE FROM ${room.tables.rows} WHERE kind = 'pending'`);
					if (!added.isEmpty()) storage.insert('pending', deletesUpdate(added));
					storage.touch();
				});
				storage.documentBytes -= pending;
				storage.updates++;
			} catch (error) {
				storage.documentBytes = before;
				room.unstored = error;
				return released;
			}
			storage.scheduleSave();
			storage.storedWaiting = addIds(discarded ? Y.createIdSet() : storage.storedWaiting, added);
		}
		if (!released.isEmpty()) room.send(ws, updateFrame(deletesUpdate(released)));
		return released;
	}

	/**
	 * Of `deletes`, those the room stored — applied, or waiting in a
	 * `pending` record — and so acknowledges by id: never one it dropped
	 * (the waiting cap, a stripped rewrite's replaced entry) or keeps
	 * waiting in memory only.
	 */
	private storedDeletes(doc: YDoc, deletes: Decoded['ds']): Decoded['ds'] {
		const unheld = Y.diffIdSet(deletes, heldDeletes(doc, deletes));
		return Y.diffIdSet(deletes, Y.diffIdSet(unheld, this.room.storage.storedWaiting));
	}

	/**
	 * A fault of the room while it handled `ws`'s frame, never the client's
	 * doing (so never a refusal): a failed append (`unstored`) or registry
	 * write (`storage`), the engine or a send (`internal`). After a failed
	 * append or an engine fault the live doc may hold what storage does
	 * not: it is rebuilt from the stored rows alone (as a restart would),
	 * so nothing unstored is ever served or acknowledged. The socket is
	 * closed 1011: its provider redials, the join rule finds what the room
	 * lacks, and the edit is resent and stored.
	 */
	private fault(ws: WebSocket, error: unknown) {
		const room = this.room;
		// A failed append outranks whatever surfaced it.
		const append = room.unstored !== null;
		const registry = !append && error instanceof StorageFault;
		const storage = append || registry;
		room.note({
			reason: storage ? 'storage' : 'internal',
			detail: String(append ? room.unstored : error)
		});
		room.log({
			edytor: 'fault',
			reason: storage ? 'storage' : 'internal',
			detail: String(append ? room.unstored : error)
		});
		// Only a registry fault leaves the live doc as stored.
		if (!registry && room.live !== null) room.storage.rebuild();
		room.presence.depart(ws);
		room.close(ws, CLOSE.fault, storage ? STORAGE_FAILURE : 'internal error');
	}
}
