/**
 * Room protocol — the transport-agnostic half of the two providers.
 *
 * Both providers speak the same enveloped protocol
 * (`protocols/envelope.ts`) — the IndexedDB provider on one
 * BroadcastChannel room per document, the websocket provider on its
 * socket plus the same BroadcastChannel room (cross-tab, on by default): the generation word,
 * the message-type dispatch, the sync handler, and the awareness
 * publish/query flow are identical between them — this module is their
 * ONE owner. It owns:
 *
 * - the two schema rules that bytes of a proven generation
 *   still need: the inbound refusal of an update that writes a foreign
 *   schema stamp (reported, never integrated), and the outbound quarantine
 *   of a read-only document (it answers no state request, publishes no
 *   update);
 * - ONE join rule, derived from state vectors, identical on the socket and
 *   the BroadcastChannel and correct behind an opaque relay: joining
 *   sends a hello (Step1 + presence); a Step1 is answered with a Step2 and,
 *   when the asker holds anything we lack, with our own Step1. Once two
 *   replicas have each received one Step1 from the other, each holds the
 *   other's state — no periodic resync is needed for that;
 * - the provider lifecycle: `hasSynced` (lifetime) apart from a
 *   transport's `connected`/`synced` (transient), the terminal `failed`
 *   (once, never after `hasSynced`), `whenSynced`, the destroy guard, and
 *   the departure announcement (leaving the page destroys the provider,
 *   which announces its presence removal on every transport it speaks).
 *
 * `bindRoomProtocol(syncProtocol, behavior)` is bound once per provider
 * class; the returned handle takes the provider instance on every call.
 * Real per-provider differences stay in the behavior hooks:
 *
 * - `broadcast` — ws sends room traffic on its socket and the BC channel;
 *   idb's on the BC channel (`roomChannel`).
 * - `tabOrigin` — ws applies an update heard from another tab under its own
 *   origin, so it can relay that update to the server (idb skips it: the
 *   other tab stored it in the same database).
 * - `heard` — ws claims its connection's `synced` when it holds a member's
 *   state (an applied Step2, or a Step1 it covers, received on the
 *   socket); idb's `synced` is its local-hydration claim.
 * - `handlers` — ws adds `messageAuth` (the auth reply exists only on a
 *   server socket — a BC room has no authority to deny).
 */
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';
import * as promise from 'lib0-v14/promise';
import {
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	type Awareness,
	type AwarenessStates,
	type AwarenessUpdate
} from '../protocols/awareness.js';
import type { SyncProtocol } from '../protocols/sync.js';
import { callEach } from '../protocols/observable.js';
import {
	BARE_REPLY_LENGTH,
	frame,
	GENERATION,
	writeProtocolVersion
} from '../protocols/envelope.js';
import { checkSchema, SchemaMismatchError, type SchemaProblem } from '../admission.js';
import type { YDoc } from '../engine-api.js';
import { asEngineDoc } from '../structs.js';

export const messageSync = 0;
export const messageAwareness = 1;
export const messageAuth = 2;
export const messageQueryAwareness = 3;
/** Server → client: the room persisted everything under this state vector (store-before-ack). */
export const messageSaved = 4;
/** Server → client: one piece of a frame too large to send whole (bounded catch-up). */
export const messageChunk = 5;
/**
 * Both ways: a document's comment threads (`protocols/comments.ts`): a
 * client subscribes, the room answers every thread, then each change. The
 * room sends it only to a socket that subscribed.
 */
export const messageComments = 6;
/**
 * Client → server, after a re-seed (`room.reseed.protocol`): the client's
 * whole old document, its unsaved edits in it, for the room to rebase onto
 * the current epoch. Sent only when the room asks (its epoch notice).
 */
export const messageRebase = 7;

/** A WebSocket message limit on Cloudflare (32 MiB): a larger frame is sent as chunks. */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

const chunkStart = 0;
const chunkPart = 1;
const chunkEnd = 2;

/**
 * Split `whole` (a complete frame) into frames of at most `maxFrameBytes`:
 * itself when it fits, else `start(total)`, `part(bytes)`…, `end`. A
 * receiver applies the reassembled frame only once `end` arrives.
 */
export const chunkFrame = (whole: Uint8Array, maxFrameBytes = MAX_FRAME_BYTES): Uint8Array[] => {
	if (whole.length <= maxFrameBytes) return [whole];
	const size = Math.max(1, maxFrameBytes - 16); // header: generation, type, kind, length
	const frames = [
		frame(messageChunk, (e) => {
			encoding.writeVarUint(e, chunkStart);
			encoding.writeVarUint(e, whole.length);
		})
	];
	for (let at = 0; at < whole.length; at += size) {
		const bytes = whole.subarray(at, at + size);
		frames.push(
			frame(messageChunk, (e) => {
				encoding.writeVarUint(e, chunkPart);
				encoding.writeVarUint8Array(e, bytes);
			})
		);
	}
	frames.push(frame(messageChunk, (e) => encoding.writeVarUint(e, chunkEnd)));
	return frames;
};

/**
 * A chunk sequence its reader refuses ({@link createChunkReader}): one
 * announcing a frame larger than the reader takes (`total` over `limit`),
 * or a part or end with no sequence started (one lost, or never sent).
 */
export class ChunkError extends Error {
	constructor(
		readonly total?: number,
		readonly limit?: number
	) {
		super(
			limit === undefined
				? 'chunk without a start'
				: `chunked frame of ${total} bytes exceeds ${limit}`
		);
		this.name = 'ChunkError';
	}
}

/** A chunk reader ({@link createChunkReader}): feed it chunk bodies; `buffered` is what it holds. */
export type ChunkReader = {
	(decoder: decoding.Decoder): Uint8Array | null;
	/** Bytes held for the sequence in flight: its announced size, allocated at its start (0: none). */
	readonly buffered: number;
};

/**
 * The receiving half of {@link chunkFrame}, one per connection: feed it
 * each chunk frame's body (after the message type); it returns the whole
 * frame on `end`, `null` before. An out-of-order or oversized sequence
 * throws and resets; a sequence announcing more than `maxBytes` throws
 * {@link ChunkError} at its start, before anything is buffered. A
 * sequence is assembled into ONE buffer of its announced size, allocated
 * at its start (`buffered`), never into parts copied at its end.
 * `admit(total)` is asked at each start, before that allocation: it may
 * throw to refuse the sequence, or return `false` to skip it (its parts
 * are read and dropped, and its end returns `null`).
 */
export const createChunkReader = (
	maxBytes = Infinity,
	admit: (total: number) => boolean = () => true
): ChunkReader => {
	let open = false;
	let whole: Uint8Array | null = null;
	let total = 0;
	let received = 0;
	const reset = () => {
		open = false;
		whole = null;
		total = 0;
		received = 0;
	};
	const read = (decoder: decoding.Decoder): Uint8Array | null => {
		try {
			const kind = decoding.readVarUint(decoder);
			if (kind === chunkStart) {
				reset();
				const announced = decoding.readVarUint(decoder);
				if (announced > maxBytes) throw new ChunkError(announced, maxBytes);
				whole = admit(announced) ? new Uint8Array(announced) : null;
				total = announced;
				open = true;
				return null;
			}
			if (!open) throw new ChunkError();
			if (kind === chunkPart) {
				const bytes = decoding.readVarUint8Array(decoder);
				if (received + bytes.length > total) throw new Error('chunked frame longer than announced');
				whole?.set(bytes, received);
				received += bytes.length;
				return null;
			}
			if (kind !== chunkEnd || received !== total) throw new Error('incomplete chunked frame');
			const done = whole;
			reset();
			return done;
		} catch (error) {
			reset();
			throw error;
		}
	};
	return Object.defineProperty(read, 'buffered', {
		get: () => (whole as Uint8Array | null)?.length ?? 0
	}) as ChunkReader;
};

export type ProtocolMismatch = { expected: number; found: number | null };

/**
 * Inbound refusal detail — emitted on `'schema-mismatch'` (and mirrored
 * through `'message-error'` as a {@link SchemaMismatchError}) when a
 * received update would write a foreign schema stamp (`unsupported`
 * version, `foreign` manifest, or a deleted stamp — `unversioned`). The
 * update is never integrated, persisted, or rebroadcast.
 */
export type SchemaMismatchDetail = { docName: string; problem: SchemaProblem };

/** An awareness frame carrying `clients`' entries of `states` (default: their current ones). */
const awarenessFrame = (awareness: Awareness, clients: number[], states?: AwarenessStates) =>
	frame(messageAwareness, (e) =>
		encoding.writeVarUint8Array(e, encodeAwarenessUpdate(awareness, clients, states))
	);

/** A tab channel's subscriber: the bytes and who published them (`null`: another tab). */
type TabSubscriber = (data: ArrayBuffer | Uint8Array, origin: unknown) => void;
const channels = new Map<string, { bc: BroadcastChannel; subs: Set<TabSubscriber> }>();
const channelNamed = (room: string) => {
	let c = channels.get(room);
	if (c === undefined) {
		const subs = new Set<TabSubscriber>();
		const bc = new BroadcastChannel(room);
		bc.onmessage = (e: MessageEvent) => subs.forEach((sub) => sub(e.data, null));
		channels.set(room, (c = { bc, subs }));
	}
	return c;
};

/**
 * The tabs of one browser, by room name: one `BroadcastChannel` per room,
 * shared by this tab's subscribers. A publish reaches the other tabs and,
 * at once, this tab's other subscribers (with the publisher as origin).
 */
export const tabs = {
	subscribe: (room: string, f: TabSubscriber): void => void channelNamed(room).subs.add(f),
	unsubscribe: (room: string, f: TabSubscriber): void => {
		const c = channels.get(room);
		if (c?.subs.delete(f) && c.subs.size === 0) {
			c.bc.close();
			channels.delete(room);
		}
	},
	publish: (room: string, data: Uint8Array | ArrayBuffer, origin: unknown = null): void => {
		const c = channelNamed(room);
		c.bc.postMessage(data);
		c.subs.forEach((sub) => sub(data, origin));
	}
};

/** The outbound quarantine: a read-only document does not spread. */
export const quarantined = (doc: YDoc): boolean => checkSchema(asEngineDoc(doc)) !== null;

/** The lifecycle a provider carries — installed by {@link initLifecycle}. */
export type LifecycleHost = {
	/** Lifetime: the provider has held the room's (or its store's) state once. */
	hasSynced: boolean;
	/** Resolves on the first sync; rejects on the terminal failure. */
	whenSynced: Promise<unknown>;
	_destroyed: boolean;
	_failedEmitted?: boolean;
	_settleSynced: [(value: unknown) => void, (reason: Error) => void];
	_leave: () => void;
	emit?(event: 'failed', args: [unknown, unknown]): void;
};

type Listeners = { on?(e: string, f: () => void): void; off?(e: string, f: () => void): void };
type PageEvents = {
	addEventListener?(e: string, f: (event: { persisted?: boolean }) => void): void;
	removeEventListener?(e: string, f: (event: { persisted?: boolean }) => void): void;
};

/** When a subscriber of {@link onPageLeave} runs: a session's last writes, then the transports. */
export type PageLeavePhase = 'write' | 'transport';

/** One page's departure: its subscribers by phase, and the listener's removal. */
type Departure = { leaving: Record<PageLeavePhase, Set<() => void>>; uninstall: () => void };
/**
 * The departures installed, by the page's `addEventListener` (one per realm
 * in a browser; a harness simulating several pages in one realm gives each
 * its own) or, in Node, by the process.
 */
const departures = new WeakMap<object, Departure>();

/** The page (Node: the process) leaves for good: the writes first, then the transports, each isolated. */
const leave = (departure: Departure) => {
	for (const phase of ['write', 'transport'] as const)
		callEach(`[edytor] page leave (${phase})`, [...departure.leaving[phase]]);
};

/**
 * Be told when the page leaves for good: a `pagehide` of a page the
 * back/forward cache keeps nothing of (a kept page may come back as it was),
 * or, in Node, the process's `exit`. One listener for the page; its
 * subscribers run in two phases whatever order they subscribed in — a
 * session's last writes (`write`: a history's release, `hist.release.end`)
 * before the transports' teardown (`transport`: each provider), so those
 * writes go out while the sockets and stores are still open (listener order
 * on the window is registration order in Chromium, capturing or not).
 * Returns the unsubscribe.
 */
export const onPageLeave = (fn: () => void, phase: PageLeavePhase): (() => void) => {
	const page = globalThis as PageEvents;
	const proc = (globalThis as { process?: Listeners }).process ?? {};
	const key: object = page.addEventListener ?? proc;
	let departure = departures.get(key);
	if (departure === undefined) {
		const created: Departure = {
			leaving: { write: new Set(), transport: new Set() },
			uninstall: () => {}
		};
		if (page.addEventListener) {
			const hide = (event: { persisted?: boolean }) => void (event.persisted || leave(created));
			const remove = page.removeEventListener;
			page.addEventListener('pagehide', hide);
			created.uninstall = () => remove?.call(page, 'pagehide', hide);
		} else {
			const exit = () => leave(created);
			proc.on?.('exit', exit);
			created.uninstall = () => proc.off?.('exit', exit);
		}
		departures.set(key, (departure = created));
	}
	const own = departure;
	own.leaving[phase].add(fn);
	return () => {
		own.leaving[phase].delete(fn);
		if (own.leaving.write.size + own.leaving.transport.size === 0 && departures.get(key) === own) {
			own.uninstall();
			departures.delete(key);
		}
	};
};

/**
 * Install the lifecycle on a provider: `hasSynced`, `whenSynced`, and the
 * departure announcement. `beforeunload` only announces it (`depart`): an
 * app's unsaved-changes prompt fires it and the user may stay, so the
 * provider keeps running and its presence returns at the next renewal.
 * Leaving the page for good ({@link onPageLeave}'s `transport` phase)
 * destroys the provider, whose teardown announces it.
 */
export const initLifecycle = (
	host: LifecycleHost,
	destroy: () => unknown,
	depart: () => void = () => {}
): void => {
	host.hasSynced = false;
	host._destroyed = false;
	host.whenSynced = promise.create((resolve, reject) => {
		host._settleSynced = [resolve, reject];
	});
	// A consumer that never attaches a catch must not crash the process.
	host.whenSynced.catch(() => {});
	const page = globalThis as PageEvents;
	page.addEventListener?.('beforeunload', depart);
	const off = onPageLeave(() => void destroy(), 'transport');
	host._leave = () => {
		page.removeEventListener?.('beforeunload', depart);
		off();
	};
};

/** The first sync — lifetime. Returns `true` only the first time. */
export const markSynced = (host: LifecycleHost): boolean => {
	if (host.hasSynced) return false;
	host.hasSynced = true;
	host._settleSynced[0](host);
	return true;
};

/** Report `error` on `provider`'s error channel (`'message-error'`): a frame, a payload or a storage failure. */
export const fault = (
	provider: { emit?(event: 'message-error', args: [unknown, unknown]): void },
	error: unknown
): void => provider.emit?.('message-error', [error, provider]);

/** A message type no handler claims inside a valid envelope: protocol skew, reported, never dropped silently. */
export const unknownType = (
	provider: { emit?(event: 'message-error', args: [unknown, unknown]): void },
	what: string,
	type: number
): void => fault(provider, new Error(`Unknown ${what} message type ${type}`));

/**
 * Terminal `'failed'` emission (the sync-failure contract): fires at
 * most once per provider, only while it has never synced — destroy before
 * sync, a persistence load failure, or a permission-denied auth verdict.
 * A transient disconnect never reaches here, and a provider that synced
 * once never fails (`hasSynced`, not the connection's `synced`).
 */
export const emitFailed = (host: LifecycleHost, error: unknown): void => {
	if (host._failedEmitted || host.hasSynced) return;
	host._failedEmitted = true;
	host._settleSynced[1](error instanceof Error ? error : new Error(String(error)));
	host.emit?.('failed', [error, host]);
};

/**
 * The close codes of the edytor room (`edytor/cloudflare`) and its router,
 * as the websocket provider reads them. Only `expired` and `fault` are
 * redialed; every other code here is a {@link isRefusal refusal}.
 */
export const CLOSE = {
	/** A refused frame or container (policy violation). */
	refused: 1008,
	/** A fault of the room (storage, engine): redialed, backed off until the room saves again. */
	fault: 1011,
	/**
	 * The room changed the user's access (`setAccess(user, 'write')` on a
	 * read-only socket): redialed at once, so `authorize` grants it anew.
	 */
	accessChanged: 1012,
	/** A document id the room cannot have (empty, `.`/`..`, over 256 characters, a lone surrogate). */
	invalidDocument: 4400,
	/** Expired credentials: redialed once `params` carries a fresh token. */
	expired: 4401,
	/** The host's authorization denied the dial. */
	denied: 4403,
	/** The dialed replica is bound to another user. */
	replicaTaken: 4409,
	/**
	 * The room re-seeded the document (`room.reseed.protocol`; the reason is
	 * the room's epoch): a refusal of this document, once a client with
	 * unsaved edits redialed and handed them over. The new epoch is a new
	 * document's. Also the answer to a copy the room cannot rebase (an
	 * epoch past the cuts it keeps, or a later one) and to an older epoch's
	 * content on a socket of the current one.
	 */
	reseeded: 4410,
	/**
	 * A room quota refused the socket's write (`quota: document`,
	 * `quota: rate`, `quota: frame`): the frame was not applied, and a
	 * redial would resend it and meet the same quota.
	 */
	quota: 4413
} as const;

/**
 * Whether a room (document) id can reach its own room: 1–256 characters,
 * not `.` or `..` — URL parsing collapses a dot segment (`%2E` included),
 * so the dial would reach another path — and no lone surrogate, which
 * `encodeURIComponent` cannot encode. The provider refuses any other id at
 * construction; `routeDocumentSocket` closes it `4400`.
 */
export const validRoomId = (id: string): boolean =>
	id.length > 0 && id.length <= 256 && id !== '.' && id !== '..' && !/\p{Cs}/u.test(id);

/** Throw a clear error for a room id no dial can carry ({@link validRoomId}). */
export const assertRoomId = (id: string): void => {
	if (validRoomId(id)) return;
	throw new TypeError(
		`room id ${JSON.stringify(id)} cannot be dialed: 1-256 characters, not "." or "..", no lone surrogate`
	);
};

/** A close code that refuses this client for good: policy (`1008`) or an application code (`4xxx`) but `expired`. */
export const isRefusal = (code: number): boolean =>
	code === CLOSE.refused || (code >= 4000 && code < 5000 && code !== CLOSE.expired);

/**
 * A terminal refusal: the server closed the socket with a policy code
 * ({@link isRefusal}), so the next dial would be refused the same way (a
 * stale generation, another user's replica, a foreign stamp). The provider
 * stops dialing and the document does not seed.
 */
export class SyncRefusedError extends Error {
	/** The close code. */
	code: number;
	/** The close reason the server gave, e.g. `refused: generation`. */
	reason: string;

	constructor(code: number, reason = '') {
		super(`sync refused (${code})${reason ? `: ${reason}` : ''}`);
		this.name = 'SyncRefusedError';
		this.code = code;
		this.reason = reason;
	}
}

/**
 * The awareness origin of presences dropped because this replica lost its
 * transport (a closed socket, a destroyed provider). They are gone for this
 * replica only: no provider relays the removal, so sibling tabs sharing the
 * store's channel keep the peers they still hear.
 */
export const LOCAL_PRESENCE_LOSS = Symbol('local presence loss');

/**
 * The destroy guard: `false` when already destroyed; otherwise marks the
 * provider destroyed, drops the departure hook, and reports the terminal
 * failure of a provider that never synced.
 */
export const beginDestroy = (host: LifecycleHost, name: string): boolean => {
	if (host._destroyed) return false;
	host._destroyed = true;
	host._leave();
	emitFailed(host, new Error(`${name} was destroyed before it synced`));
	return true;
};

/**
 * One dispatch-table entry: decode `decoder`, write any reply into
 * `encoder`; a returned frame is a follow-up sent after the reply.
 */
export type RoomMessageHandler<P> = (
	encoder: encoding.Encoder,
	decoder: decoding.Decoder,
	provider: P,
	emitSynced: boolean
) => Uint8Array | void;

/** The provider surface the room protocol drives. */
export type RoomProvider<P> = LifecycleHost & {
	doc: YDoc;
	awareness: Awareness;
	/** Dispatch table — assigned from the bound room handle at construction. */
	messageHandlers: Record<number, RoomMessageHandler<P>>;
	emit?(event: 'schema-mismatch', args: [SchemaMismatchDetail, unknown]): void;
	emit?(event: 'message-error', args: [unknown, unknown]): void;
	emit?(event: 'protocol-mismatch', args: [ProtocolMismatch, unknown]): void;
	emit?(event: 'failed', args: [unknown, unknown]): void;
};

/** A provider that joins the BroadcastChannel room. */
export type BcMember = {
	bcconnected: boolean;
	_bcSubscriber: (data: ArrayBuffer | Uint8Array, origin: unknown) => void;
};

/** Per-provider hooks — the real differences between the two transports. */
export type RoomBehavior<P> = {
	/** Logical document/room name for `SchemaMismatchDetail` + errors. */
	docName(provider: P): string;
	/** The BroadcastChannel room the provider syncs on. */
	roomChannel?(provider: P): string;
	/** Provider-originated room traffic: ws sends on the socket and the BC channel; idb on the BC channel. */
	broadcast(provider: P, buf: Uint8Array): void;
	/** The transaction origin of an update heard on the BC channel (default: the provider). */
	tabOrigin?(provider: P): unknown;
	/** Extra dispatch entries beyond sync/query-awareness/awareness (ws: auth). */
	handlers?: Record<number, RoomMessageHandler<P>>;
	/**
	 * The provider now holds a room member's state, learned on its
	 * `emitSynced` channel: an applied Step2, or a Step1 whose state vector
	 * it covers. ws claims its connection's `synced` here; idb leaves it
	 * unset (its `synced` is the local-hydration claim).
	 */
	heard?(provider: P): void;
};

/**
 * Bind the shared room protocol for one provider class. The returned
 * handle owns: message dispatch (`readMessage`/`messageHandlers`), the
 * sync handler (join rule, inbound refusal), awareness message flow, the
 * BC subscriber + the join/leave sequences (outbound quarantine).
 */
export const bindRoomProtocol = <P extends RoomProvider<P>>(
	syncProtocol: SyncProtocol,
	behavior: RoomBehavior<P>
) => {
	const step1 = (provider: P) =>
		frame(messageSync, (e) => syncProtocol.writeSyncStep1(e, provider.doc));

	const messageHandlers: Record<number, RoomMessageHandler<P>> = {
		[messageSync]: (encoder, decoder, provider, emitSynced) => {
			encoding.writeVarUint(encoder, messageSync);
			const syncMessageType = decoding.readVarUint(decoder);
			if (syncMessageType === syncProtocol.messageYjsSyncStep1) {
				// The join rule. Reply with what the asker lacks (unless we
				// are read-only — outbound quarantine); ask back when the
				// asker holds anything we lack; otherwise we hold its state.
				const sv = decoding.readVarUint8Array(decoder);
				if (!quarantined(provider.doc)) syncProtocol.writeSyncStep2(encoder, provider.doc, sv);
				if (syncProtocol.lacks(provider.doc, sv)) return step1(provider);
				if (emitSynced) behavior.heard?.(provider);
				return;
			}
			if (
				syncMessageType === syncProtocol.messageYjsSyncStep2 ||
				syncMessageType === syncProtocol.messageYjsUpdate
			) {
				// Inbound refusal: an update writing a foreign stamp never
				// integrates and is reported once. A corrupt payload inside a
				// valid envelope surfaces through 'message-error'.
				// A pending forged stamp this update would release is discarded
				// (`discarded`) and reported the same way.
				const update = decoding.readVarUint8Array(decoder);
				const origin = emitSynced ? provider : (behavior.tabOrigin?.(provider) ?? provider);
				const onError = (error: Error) => fault(provider, error);
				const { applied, problem, discarded } = syncProtocol.applyRemote(
					provider.doc,
					update,
					origin,
					onError
				);
				const refused = problem ?? discarded;
				if (refused) {
					const docName = behavior.docName(provider);
					provider.emit?.('schema-mismatch', [{ docName, problem: refused }, provider]);
					fault(provider, new SchemaMismatchError(docName, refused));
				}
				// Only an ACCEPTED Step2 is a held member state — a refused
				// one never claims the handshake.
				if (emitSynced && applied && syncMessageType === syncProtocol.messageYjsSyncStep2) {
					behavior.heard?.(provider);
				}
				return;
			}
			// Unknown sync subtype inside a valid envelope — observable.
			unknownType(provider, 'sync', syncMessageType);
		},
		[messageQueryAwareness]: (encoder, _decoder, provider) => {
			encoding.writeVarUint(encoder, messageAwareness);
			encoding.writeVarUint8Array(
				encoder,
				encodeAwarenessUpdate(provider.awareness, Array.from(provider.awareness.getStates().keys()))
			);
		},
		[messageAwareness]: (_encoder, decoder, provider) => {
			applyAwarenessUpdate(provider.awareness, decoding.readVarUint8Array(decoder), provider);
		},
		...behavior.handlers
	};

	/**
	 * Decode one room message. The generation word is verified before
	 * anything else — a foreign message (v13 writer, another schema
	 * generation, corrupt frame) is dropped and reported; its payload is
	 * never decoded. Returns the reply; with `send`, the reply (when it
	 * carries anything — longer than `BARE_REPLY_LENGTH`) and any follow-up
	 * go out on the channel the message came from.
	 */
	const readMessage = (
		provider: P,
		buf: Uint8Array,
		emitSynced: boolean,
		send?: (frame: Uint8Array) => void
	): encoding.Encoder => {
		const decoder = decoding.createDecoder(buf);
		const encoder = encoding.createEncoder();
		const found = decoding.readVarUint(decoder);
		if (found !== GENERATION) {
			provider.emit?.('protocol-mismatch', [{ expected: GENERATION, found }, provider]);
			return encoder;
		}
		writeProtocolVersion(encoder);
		const messageType = decoding.readVarUint(decoder);
		const messageHandler = provider.messageHandlers[messageType];
		if (!messageHandler) {
			// Fail closed + observable: a VALID envelope carrying a message
			// type no handler claims is protocol skew — never silent.
			unknownType(provider, 'v14', messageType);
			return encoder;
		}
		const followUp = messageHandler(encoder, decoder, provider, emitSynced);
		if (send && encoding.length(encoder) > BARE_REPLY_LENGTH) send(encoding.toUint8Array(encoder));
		if (send && followUp) send(followUp);
		return encoder;
	};

	const channelOf = (provider: P) => behavior.roomChannel!(provider);

	/** The BC subscriber: replies go back on the room channel. */
	const bcSubscriber = (provider: P) => {
		const send = (buf: Uint8Array) => tabs.publish(channelOf(provider), buf, provider);
		return (data: ArrayBuffer | Uint8Array, origin: unknown): void => {
			if (origin === provider) return;
			try {
				readMessage(provider, new Uint8Array(data), false, send);
			} catch (error) {
				// same-tab publishes are delivered synchronously — a malformed
				// message must not propagate into the publisher's call stack.
				fault(provider, error);
			}
		};
	};

	/**
	 * Awareness change → room publish (`behavior.broadcast` picks the
	 * transports) — never a change this provider just heard: echoing a
	 * departing peer's removal back to it makes that peer re-announce itself
	 * (the awareness "still alive" rule), so its presence never leaves —
	 * nor a {@link LOCAL_PRESENCE_LOSS}, which is true for this replica only.
	 */
	const awarenessUpdateHandler = (provider: P) => {
		return ({ added, updated, removed }: AwarenessUpdate, origin: unknown): void => {
			if (origin === provider || origin === LOCAL_PRESENCE_LOSS) return;
			const changed = added.concat(updated).concat(removed);
			behavior.broadcast(provider, awarenessFrame(provider.awareness, changed));
		};
	};

	/**
	 * Encode a local doc update as a sync message and broadcast it to the
	 * room (or on `via` alone) — unless the document is read-only (outbound
	 * quarantine).
	 */
	const broadcastUpdate = (
		provider: P,
		update: Uint8Array,
		via: (provider: P, buf: Uint8Array) => void = behavior.broadcast
	): void => {
		if (quarantined(provider.doc)) return;
		via(
			provider,
			frame(messageSync, (e) => syncProtocol.writeUpdate(e, update))
		);
	};

	/**
	 * The hello a joining member sends on a channel: its Step1 (the join
	 * rule does the rest) and its own presence.
	 */
	const hello = (provider: P): Uint8Array[] => [
		step1(provider),
		awarenessFrame(provider.awareness, [provider.doc.clientID])
	];

	/** Join the BroadcastChannel room: hello, and ask the tabs for their presence. */
	const connectBc = (provider: P & BcMember): void => {
		const channel = channelOf(provider);
		if (!provider.bcconnected) {
			tabs.subscribe(channel, provider._bcSubscriber);
			provider.bcconnected = true;
		}
		const [sv, presence] = hello(provider);
		for (const buf of [sv, frame(messageQueryAwareness, () => {}), presence]) {
			tabs.publish(channel, buf, provider);
		}
	};

	/** The departure announcement — our presence, removed — on every transport the provider speaks. */
	const depart = (provider: P): void =>
		behavior.broadcast(
			provider,
			awarenessFrame(provider.awareness, [provider.doc.clientID], new Map())
		);

	/**
	 * Wire `provider` to its room: its BroadcastChannel subscriber, `onUpdate`
	 * on its document's updates and its presence changes to the room
	 * (`awarenessUpdateHandler`). The teardown removes both listeners.
	 */
	const listen = (
		provider: P & BcMember,
		onUpdate: (
			update: Uint8Array,
			origin: unknown,
			doc?: unknown,
			transaction?: { local: boolean }
		) => void
	): (() => void) => {
		provider._bcSubscriber = bcSubscriber(provider);
		const onPresence = awarenessUpdateHandler(provider);
		provider.doc.on('update', onUpdate);
		provider.awareness.on('update', onPresence);
		return () => {
			provider.awareness.off('update', onPresence);
			provider.doc.off('update', onUpdate);
		};
	};

	/** Leave the room: announce the presence removal, then unsubscribe the BC channel. */
	const disconnectBc = (provider: P & BcMember): void => {
		depart(provider);
		if (provider.bcconnected) {
			tabs.unsubscribe(channelOf(provider), provider._bcSubscriber);
			provider.bcconnected = false;
		}
	};

	return {
		messageHandlers,
		readMessage,
		bcSubscriber,
		awarenessUpdateHandler,
		broadcastUpdate,
		step1,
		hello,
		depart,
		connectBc,
		disconnectBc,
		listen
	};
};
