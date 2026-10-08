/**
 * Websocket provider for the vendored v14 engine — port of
 * `y-websocket@3.0.0` `src/y-websocket.js` (MIT © Kevin Jahns — see
 * `src/lib/crdt/vendor/yjs/LICENSE`).
 *
 * Retained surface (D-24 G-e): `status`/`synced`/`connection-*` events,
 * `connect()`/`disconnect()`, awareness injection, auth `params` (read at
 * every dial, so a refreshed token reaches the next connection),
 * `WebSocketPolyfill`, outbound chunking of frames over `maxFrameBytes` (H6),
 * exponential-backoff reconnect (`maxBackoffTime`,
 * growing to 30 s for a room that stays unreachable), liveness (a text
 * `ping` after 15 s of silence; a text `pong` counts as heard),
 * `resyncInterval`, and the BroadcastChannel leg (cross-tab sync, on by
 * default; `disableBc` opts out). A refusal close (`1008`, `4xxx`) is
 * terminal: no redial — except `4401` (expired credentials), which emits
 * `expired` and redials after the backoff with the re-read `params`. A dial
 * that neither opens nor fails is closed after `connectTimeout` (10 s by
 * default, `Infinity` waits forever), like a failed one. Retired:
 * `protocols`, the `sync` alias, `wsconnecting`.
 *
 * Cross-tab: tabs of one room share a BroadcastChannel named after the
 * server URL and room, so they sync with each other with or without the
 * socket. An update heard from another tab is relayed to the server on
 * this tab's socket (never back to the channel): an offline tab's edits
 * reach the server as soon as any tab of the room is online. A socket the
 * room made read-only gets this document's own edits only.
 *
 * The generation gate (`protocols/envelope.ts`, R13): every websocket
 * frame is tagged `varuint GENERATION | messageType | payload`. Inbound
 * frames of any other generation are dropped before decode and reported
 * via `'protocol-mismatch'`. A v13
 * y-websocket server in the room therefore cannot feed updates to this
 * provider (and vice versa) — see docs/crdt-v14-providers.md §server
 * classification: only an OPAQUE v1-update relay stays compatible; a server
 * that participates in sync (like upstream `y-websocket-server`) must itself
 * run the vendored v14 engine + v14 protocol modules.
 *
 * The room half — enveloped dispatch, the join rule, the inbound refusal,
 * awareness publish/query, the departure announcement, the outbound
 * quarantine and the provider lifecycle — is shared with the IndexedDB
 * provider in `room.ts` (S1). This file keeps the transport edges: the
 * socket lifecycle, reconnect backoff, liveness, the auth reply, and the
 * connection's `synced` (transient: it resets with the socket; `hasSynced`
 * is the lifetime fact). `resyncInterval` is not a correctness dependency:
 * the join rule exchanges what each side lacks on every (re)connect. It
 * re-sends a Step1 on the live socket for harnesses that drop frames
 * there (TCP never does).
 */
import * as bc from 'lib0-v14/broadcastchannel';
import * as decoding from 'lib0-v14/decoding';
import * as time from 'lib0-v14/time';
import * as math from 'lib0-v14/math';
import * as url from 'lib0-v14/url';
import { Awareness, removeAwarenessStates } from '../protocols/awareness.js';
import { IsolatedObservable } from '../protocols/observable.js';
import {
	messagePermissionDenied,
	messageReadOnly,
	READ_ONLY_DENIAL,
	readAuthMessage
} from '../protocols/auth.js';
import { bindSync, type IdSet, type SyncProtocol } from '../protocols/sync.js';
import {
	assertRoomId,
	beginDestroy,
	bindRoomProtocol,
	chunkFrame,
	CLOSE,
	createChunkReader,
	emitFailed,
	initLifecycle,
	isRefusal,
	LOCAL_PRESENCE_LOSS,
	markSynced,
	messageAuth,
	messageChunk,
	messageSaved,
	messageSync,
	MAX_FRAME_BYTES,
	SyncRefusedError,
	type LifecycleHost,
	type ProtocolMismatch,
	type RoomMessageHandler,
	type SchemaMismatchDetail
} from './room.js';
import type { EngineApi, YDoc } from '../engine-api.js';
import { asEngineDoc } from '../structs.js';
import { ATTRIBUTION_ROOT } from '../schema.js';
import { ATTRIBUTION_ORIGIN } from '../attribution/attribution.js';

// @todo - this should depend on awareness.outdatedTime
const messageReconnectTimeout = 30000;
/** Silence after which the socket is sent one text `ping` (a room auto-answers `pong`). */
const messagePingTimeout = 15000;
/** Consecutive dials that never synced before the backoff cap starts to grow. */
const unreachableAfter = 8;
/** The backoff cap an unreachable room grows to. */
const unreachableBackoffTime = 30000;
/** A dial that has neither opened nor failed after this long is closed like a failed one. */
const defaultConnectTimeout = 10000;

export type WebsocketProviderEvents = {
	status: (event: { status: 'connected' | 'disconnected' | 'connecting' }) => void;
	synced: (state: boolean) => void;
	'connection-close': (event: CloseEvent | null, provider: unknown) => void;
	'connection-error': (event: Event, provider: unknown) => void;
	'protocol-mismatch': (mismatch: ProtocolMismatch, provider: unknown) => void;
	/**
	 * Fired when a v14-tagged frame could not be decoded (truncated/corrupt
	 * frame or an unknown message type), or when a sync payload failed to
	 * apply. The frame is dropped, never applied. Also mirrors inbound
	 * refusals so the error channel sees every failure mode.
	 */
	'message-error': (error: unknown, provider: unknown) => void;
	/** A received update wrote a foreign schema stamp and was refused (SchemaMismatchDetail). */
	'schema-mismatch': (detail: SchemaMismatchDetail, provider: unknown) => void;
	/**
	 * The count of local updates the room has not yet acknowledged as
	 * persisted changed (store-before-ack: a `messageSaved` frame carries
	 * the room's state vector after it stored what it holds).
	 */
	saved: (state: { saved: boolean; unsaved: number }, provider: unknown) => void;
	/** Server refused access — the auth reply carried a denial reason. */
	'permission-denied': (reason: string, provider: unknown) => void;
	/**
	 * The server closed the socket with a refusal code (`1008`, `4xxx`):
	 * the provider stopped dialing. Fired once, synced before or not.
	 */
	refused: (refusal: SyncRefusedError, provider: unknown) => void;
	/**
	 * The server closed the socket with `4401`: the credentials expired.
	 * Put a fresh token in `params` before the redial, due in `nextRetryMs`
	 * (`attempts`: dials in a row that never synced, as for `unreachable`).
	 */
	expired: (
		state: { reason: string; attempts: number; nextRetryMs: number },
		provider: unknown
	) => void;
	/**
	 * A dial ended before its connection synced (refused upgrade, dropped
	 * handshake, server down, not open within `connectTimeout`): `attempts`
	 * in a row, the next in `nextRetryMs`. Also a room fault (`1011`) after
	 * a sync: `attempts` counts the faults since the room last stored every
	 * local update.
	 */
	unreachable: (state: { attempts: number; nextRetryMs: number }, provider: unknown) => void;
	/**
	 * Terminal sync failure: the provider never synced —
	 * destroyed before any handshake completed, refused, or the server
	 * denied permission. Emitted at most once; never once `hasSynced`, never
	 * on a transient (reconnectable) disconnect.
	 */
	failed: (error: unknown, provider: unknown) => void;
};

export type WebsocketPolyfill = {
	new (url: string): WebSocket;
	prototype: WebSocket;
	readonly OPEN: number;
};

export type WebsocketProviderOptions = {
	connect?: boolean;
	awareness?: Awareness;
	/** Query parameters (auth tokens), read at every dial. */
	params?: Record<string, string>;
	WebSocketPolyfill?: WebsocketPolyfill;
	/**
	 * Re-send a Step1 every `resyncInterval` ms on the live socket (off by
	 * default): heals frames a test harness drops; the join rule needs no timer.
	 */
	resyncInterval?: number;
	/** Max reconnect backoff (exponential backoff is used). */
	maxBackoffTime?: number;
	/**
	 * ms a dial may take to open before it is closed like a failed one
	 * (default 10 000; `Infinity` waits for as long as the browser does).
	 */
	connectTimeout?: number;
	/** Opt out of cross-tab sync over the BroadcastChannel (on by default). */
	disableBc?: boolean;
	/**
	 * Largest frame sent whole (default 32 MiB, Cloudflare's WebSocket
	 * message limit): a larger one — a reconnect's backlog, a big paste —
	 * goes out as a chunk sequence the room reassembles.
	 */
	maxFrameBytes?: number;
};

export type WebsocketProviderApi = InstanceType<
	ReturnType<typeof bindWebsocketProvider>['WebsocketProvider']
>;

/**
 * Bind the websocket provider to the vendored v14 engine module.
 */
export const bindWebsocketProvider = (Y: EngineApi) => {
	const syncProtocol: SyncProtocol = bindSync(Y);

	type Provider = WebsocketProvider;

	/**
	 * One frame on `ws`: whole, or as a chunk sequence when it is larger
	 * than `maxFrameBytes` (H6). A text frame (the keepalive) goes as it is.
	 */
	const sendOn = (provider: Provider, ws: WebSocket, buf: Uint8Array | string) => {
		if (typeof buf === 'string') return ws.send(buf);
		for (const piece of chunkFrame(buf, provider.maxFrameBytes)) ws.send(piece);
	};

	/** Traffic for the server goes out on the socket while it is open. */
	const send = (provider: Provider, buf: Uint8Array | string) => {
		const ws = provider.ws;
		if (provider.wsconnected && ws && ws.readyState === ws.OPEN) sendOn(provider, ws, buf);
	};

	/** Traffic for the other tabs goes out on the channel. */
	const toTabs = (provider: Provider, buf: Uint8Array) => {
		if (provider.bcconnected) bc.publish(provider.bcChannel, buf, provider);
	};

	/** Room traffic goes to the server and to the other tabs. */
	const broadcast = (provider: Provider, buf: Uint8Array) => {
		send(provider, buf);
		toTabs(provider, buf);
	};

	/**
	 * The shared room protocol (S1). The transport edges stay here:
	 * `messageAuth` exists only on a server socket, and `heard` claims the
	 * connection's `synced`.
	 */
	const room = bindRoomProtocol<Provider>(syncProtocol, {
		docName: (provider) => provider.roomname,
		roomChannel: (provider) => provider.bcChannel,
		broadcast,
		tabOrigin: (provider) => provider._fromTab,
		handlers: {
			[messageAuth]: (_encoder, decoder, provider) => {
				const authType = readAuthMessage(
					decoder,
					provider.doc,
					(_ydoc, reason) => {
						// Observable: a refused write. A read-only socket still syncs:
						// nothing it writes can be stored, so nothing is tracked. Any
						// other denial is a terminal sync failure (D4), reported at
						// most once.
						const readOnly = reason === READ_ONLY_DENIAL;
						if (readOnly) provider._writes.deny();
						provider.emit('permission-denied', [reason, provider]);
						if (!readOnly) emitFailed(provider, new Error(`permission denied: ${reason}`));
					},
					// The room's notice at the join: a state, not a refusal (no event).
					() => provider._writes.deny()
				);
				if (authType !== messagePermissionDenied && authType !== messageReadOnly) {
					// An auth type we do not speak inside a valid v14 envelope is
					// protocol skew — reported, never dropped silently.
					provider.emit('message-error', [
						new Error(`Unknown auth message type ${authType}`),
						provider
					]);
				}
			}
		},
		heard: (provider) => {
			provider.wsUnsuccessfulReconnects = 0;
			provider.synced = true;
		}
	});
	// The room's acknowledgement and its bounded catch-up (a frame too large
	// for one message arrives as chunks and is read only once complete).
	room.messageHandlers[messageSaved] = (_encoder, decoder, provider) => {
		const { stateVector, deletes } = syncProtocol.readSaved(decoder);
		provider._writes.acknowledge(stateVector, deletes);
	};
	// The room asks a socket that may write for its state (a Step1): after
	// a read-only connection, what this actor wrote counts again.
	const syncHandler = room.messageHandlers[messageSync];
	room.messageHandlers[messageSync] = (encoder, decoder, provider, emitSynced) => {
		if (emitSynced && decoding.peekVarUint(decoder) === syncProtocol.messageYjsSyncStep1)
			provider._writes.allow();
		return syncHandler(encoder, decoder, provider, emitSynced);
	};
	room.messageHandlers[messageChunk] = (_encoder, decoder, provider, emitSynced) => {
		const whole = provider._chunks(decoder);
		if (whole !== null) room.readMessage(provider, whole, emitSynced, (buf) => send(provider, buf));
	};

	type StateVector = Map<number, number>;
	/** A local update the room has not acknowledged: the clocks it writes, and its deletes still unacknowledged. */
	type Unsaved = { sv: StateVector; deletes: IdSet };
	/**
	 * The clocks `doc` holds, less the actor dictionary's records at each
	 * client's end (bookkeeping, not content: a read-only socket is never
	 * asked for them, so they would stay unsaved for good).
	 */
	const contentState = (doc: YDoc): StateVector => {
		const dictionary = doc.share.get(ATTRIBUTION_ROOT);
		const sv: StateVector = new Map();
		for (const [client, structs] of doc.store.clients) {
			for (let i = structs.length - 1; i >= 0; i--) {
				const struct = structs[i];
				if (struct instanceof Y.Item && struct.parent === dictionary) continue;
				sv.set(client, struct.id.clock + struct.length);
				break;
			}
		}
		return sv;
	};
	/**
	 * The clocks an update `doc` integrated writes, per client — not the
	 * whole document's: structs heard from the room that it later lost (a
	 * restore from a lagging snapshot) are not this replica's to save. The
	 * actor dictionary's records are bookkeeping (as in {@link contentState}),
	 * whatever the origin: a local copy replays an earlier session's.
	 */
	const written = (doc: YDoc, { structs }: ReturnType<typeof Y.decodeUpdate>): StateVector => {
		const dictionary = doc.share.get(ATTRIBUTION_ROOT);
		const sv: StateVector = new Map();
		for (const struct of structs) {
			if (struct instanceof Y.Skip) continue;
			const { client, clock } = struct.id;
			const stored = doc.store.clients.get(client);
			const end = stored?.at(-1);
			const item =
				stored && end && clock < end.id.clock + end.length
					? stored[Y.findIndexSS(stored, clock)]
					: null;
			if (item instanceof Y.Item && item.parent === dictionary) continue;
			sv.set(client, math.max(sv.get(client) ?? 0, clock + struct.length));
		}
		return sv;
	};
	const covers = (acked: StateVector, sv: StateVector) =>
		[...sv].every(([client, clock]) => (acked.get(client) ?? 0) >= clock);
	/** The actor a replica id is bound to (`c/<client>`, the document's replicated actor dictionary). */
	const actorOf = (doc: YDoc, client: number): unknown =>
		doc.share.has(ATTRIBUTION_ROOT)
			? asEngineDoc(doc).get(ATTRIBUTION_ROOT).getAttr(`c/${client}`)
			: undefined;
	/** Deterministic seeds are written under ids below 2^26 (`seedUpdate` in `edytor-doc.ts`). */
	const seedBand = 2 ** 26;
	/**
	 * Whether a replica id writes for this replica's actor: its own id, every
	 * id the actor dictionary binds to the same actor (its sessions before a
	 * reload, its other tabs), and a seed writer (content any replica may
	 * write, never stripped). Another actor's structs are not this replica's
	 * to save: a room restored from a lagging snapshot strips them for good.
	 * A doc without a binding for its own id (a raw doc) owns all.
	 */
	const ownerOf = (doc: YDoc) => {
		const actor = actorOf(doc, doc.clientID);
		return (client: number) =>
			actor === undefined ||
			client === doc.clientID ||
			client < seedBand ||
			actorOf(doc, client) === actor;
	};
	/**
	 * The ledger of this actor's writes the room has not acknowledged as
	 * stored (store-before-ack): the one owner of `saved`, `unsaved`,
	 * `readOnly` and the room faults counted against them. `changed` runs
	 * when the count of pending updates changes.
	 */
	class OwnWrites {
		/** Each local update not yet acknowledged: the clocks it writes and its unacknowledged deletes. */
		pending: Unsaved[] = [];
		/** The room's last acknowledged state vector. */
		acked: StateVector = new Map();
		/** The room said this socket may not write: nothing is tracked. */
		readOnly = false;
		/** Room faults (`1011`) since the room last covered every local update: they grow the backoff. */
		faults = 0;

		/** A room fault closed the socket: the count of faults in a row. */
		fault(): number {
			return ++this.faults;
		}

		constructor(
			readonly doc: YDoc,
			readonly changed: (unsaved: number) => void
		) {}

		/** What this actor already wrote: unsaved until the room covers it. */
		trackDocument(): void {
			this.track(contentState(this.doc), this.doc.store.ds);
		}

		/**
		 * Track an update (the clocks it writes, its `deletes`) unless the room
		 * already covers it: only this actor's clocks count, and a delete,
		 * which names no author, only in an update that writes no other
		 * actor's structs (a peer's edit replayed from the local store).
		 */
		track(sv: StateVector, deletes: IdSet): void {
			if (this.readOnly) return;
			const own = ownerOf(this.doc);
			const mine: StateVector = new Map([...sv].filter(([client]) => own(client)));
			if (mine.size < sv.size) deletes = Y.createIdSet();
			if (covers(this.acked, mine) && deletes.isEmpty()) return;
			this.pending.push({ sv: mine, deletes });
			this.changed(this.pending.length);
		}

		/**
		 * A `messageSaved` frame: the room stored everything under `sv`, and
		 * `deletes` (the deletes of the message it answers that it stored,
		 * applied or waiting for their items).
		 */
		acknowledge(sv: Uint8Array, deletes: IdSet | null = null): void {
			this.acked = Y.decodeStateVector(sv);
			const before = this.pending.length;
			this.pending = this.pending.filter((entry) => {
				if (deletes && !entry.deletes.isEmpty())
					entry.deletes = Y.diffIdSet(entry.deletes, deletes);
				return !(covers(this.acked, entry.sv) && entry.deletes.isEmpty());
			});
			// The room saves again: a later fault (1011) redials promptly.
			if (this.pending.length === 0) this.faults = 0;
			if (this.pending.length !== before) this.changed(this.pending.length);
		}

		/**
		 * The room refuses this socket's writes (its read-only notice, or a
		 * refused write): none can be stored, so none is pending — saved.
		 */
		deny(): void {
			this.readOnly = true;
			this.faults = 0;
			if (this.pending.length === 0) return;
			this.pending = [];
			this.changed(0);
		}

		/** The room asks a read-only socket for its state again: what this actor wrote is unsaved until stored. */
		allow(): void {
			if (!this.readOnly) return;
			this.readOnly = false;
			this.trackDocument();
		}
	}

	/**
	 * `100 ms × 2ⁿ` for the n-th dial in a row that never synced, or the
	 * n-th room fault (`1011`) since the room last saved everything; capped
	 * at `maxBackoffTime`; past `unreachableAfter` the cap itself doubles,
	 * up to `unreachableBackoffTime`.
	 */
	const reconnectDelay = (provider: Provider) => {
		const n = provider.wsUnsuccessfulReconnects + provider._writes.faults;
		const grown = provider.maxBackoffTime * math.pow(2, n - unreachableAfter);
		const cap =
			n > unreachableAfter
				? math.max(provider.maxBackoffTime, math.min(unreachableBackoffTime, grown))
				: provider.maxBackoffTime;
		return math.min(math.pow(2, n) * 100, cap);
	};

	/**
	 * Outsource so a new websocket connection is created immediately —
	 * `ws.onclose` is not always fired on network issues.
	 */
	const closeWebsocketConnection = (
		provider: Provider,
		ws: WebSocket,
		event: CloseEvent | null
	) => {
		if (ws !== provider.ws) return;
		clearTimeout(provider._connectTimer);
		provider.emit('connection-close', [event, provider]);
		provider.ws = null;
		ws.close();
		const heard = provider.synced;
		if (provider.wsconnected) {
			provider.wsconnected = false;
			provider.synced = false;
			// Every other presence left — for this replica only: the
			// origin keeps the store from relaying the loss to other tabs.
			// Their clocks go too, so the present peers a room sends on
			// the next join show at once instead of after each renewal.
			const peers = Array.from(provider.awareness.getStates().keys()).filter(
				(client) => client !== provider.doc.clientID
			);
			removeAwarenessStates(provider.awareness, peers, LOCAL_PRESENCE_LOSS);
			for (const client of peers) provider.awareness.meta.delete(client);
			provider.emit('status', [{ status: 'disconnected' }]);
		}
		if (event && isRefusal(event.code)) {
			// Terminal: the next dial would be refused the same way.
			provider.shouldConnect = false;
			const refusal = new SyncRefusedError(event.code, event.reason);
			provider.emit('refused', [refusal, provider]);
			emitFailed(provider, refusal);
			return;
		}
		if (!provider.shouldConnect) return;
		// A dial that never synced counts (an opened-then-refused socket
		// too, so it cannot redial at once); a synced one starts over —
		// unless the room faulted (1011): hearing it proved nothing saves.
		const fault = heard && event?.code === CLOSE.fault;
		if (!heard) provider.wsUnsuccessfulReconnects++;
		const faults = fault ? provider._writes.fault() : 0;
		const nextRetryMs = reconnectDelay(provider);
		const attempts = provider.wsUnsuccessfulReconnects;
		if (event?.code === CLOSE.expired) {
			provider.emit('expired', [{ reason: event.reason, attempts, nextRetryMs }, provider]);
		} else if (!heard || fault) {
			// A fault: reachable, but not storing — the faults in a row since it last saved everything.
			provider.emit('unreachable', [
				{ attempts: fault ? faults : attempts, nextRetryMs },
				provider
			]);
		}
		setTimeout(setupWS, nextRetryMs, provider);
	};

	const setupWS = (provider: Provider) => {
		if (provider.shouldConnect && provider.ws === null) {
			const websocket = new provider._WS(provider.url);
			websocket.binaryType = 'arraybuffer';
			provider.ws = websocket;
			provider.wsconnected = false;
			provider.synced = false;
			provider._chunks = createChunkReader();
			// A dial the network silently drops would wait for the browser's
			// own timeout (minutes): give up on it like on a failed one.
			if (Number.isFinite(provider.connectTimeout)) {
				provider._connectTimer = setTimeout(() => {
					if (!provider.wsconnected) closeWebsocketConnection(provider, websocket, null);
				}, provider.connectTimeout);
			}

			websocket.onmessage = (event) => {
				provider.wsLastMessageReceived = time.getUnixTime();
				// A keepalive reply (a server's text auto-response): liveness only.
				if (event.data === 'pong') return;
				try {
					room.readMessage(provider, new Uint8Array(event.data as ArrayBuffer), true, (buf) =>
						sendOn(provider, websocket, buf)
					);
				} catch (error) {
					provider.emit('message-error', [error, provider]);
				}
			};
			websocket.onerror = (event) => {
				provider.emit('connection-error', [event, provider]);
			};
			websocket.onclose = (event) => {
				closeWebsocketConnection(provider, websocket, event);
			};
			websocket.onopen = () => {
				clearTimeout(provider._connectTimer);
				provider.wsLastMessageReceived = time.getUnixTime();
				provider.wsconnected = true;
				provider.emit('status', [{ status: 'connected' }]);
				// The join rule: say hello; the members answer what we lack.
				for (const buf of room.hello(provider)) sendOn(provider, websocket, buf);
			};
			provider.emit('status', [{ status: 'connecting' }]);
		}
	};

	class WebsocketProvider extends IsolatedObservable<WebsocketProviderEvents> {
		serverUrl: string;
		roomname: string;
		doc: YDoc;
		awareness: Awareness;
		params: Record<string, string>;
		maxBackoffTime: number;
		/** ms a dial may take to open (`Infinity`: no limit). */
		connectTimeout: number;
		/** Largest frame sent whole; larger ones are chunked. */
		maxFrameBytes: number;
		_WS: WebsocketPolyfill;
		shouldConnect: boolean;
		ws: WebSocket | null = null;
		wsconnected = false;
		/** The BroadcastChannel room shared by this room's tabs. */
		bcChannel: string;
		bcconnected = false;
		disableBc: boolean;
		_bcSubscriber: (data: ArrayBuffer, origin: unknown) => void;
		/** The transaction origin of updates heard from another tab. */
		_fromTab = {};
		wsUnsuccessfulReconnects = 0;
		wsLastMessageReceived = 0;
		/** When this silence was pinged (one ping per silence). */
		wsLastPingSent = 0;
		_synced = false;
		/** Reassembles this socket's chunked frames (reset per connection). */
		_chunks = createChunkReader();
		/** This actor's writes pending the room's acknowledgement. */
		_writes: OwnWrites;
		messageHandlers: Record<number, RoomMessageHandler<WebsocketProvider>> = room.messageHandlers;
		// The room lifecycle (O74) — installed by `initLifecycle`.
		hasSynced!: boolean;
		whenSynced!: Promise<unknown>;
		_destroyed!: boolean;
		_failedEmitted?: boolean;
		_settleSynced!: LifecycleHost['_settleSynced'];
		_leave!: () => void;
		_resync: ReturnType<typeof setInterval> | undefined;
		/** Closes the current dial if it has not opened in time. */
		_connectTimer: ReturnType<typeof setTimeout> | undefined;
		_checkInterval: ReturnType<typeof setInterval>;
		_updateHandler: (
			update: Uint8Array,
			origin: unknown,
			doc?: unknown,
			transaction?: { local: boolean }
		) => void;
		_awarenessUpdateHandler: (
			updates: { added: number[]; updated: number[]; removed: number[] },
			origin: unknown
		) => void;

		constructor(
			serverUrl: string,
			roomname: string,
			doc: YDoc,
			{
				connect = true,
				awareness = new Awareness(doc),
				params = {},
				WebSocketPolyfill = WebSocket as unknown as WebsocketPolyfill,
				resyncInterval = 0,
				maxBackoffTime = 2500,
				connectTimeout = defaultConnectTimeout,
				disableBc = false,
				maxFrameBytes = MAX_FRAME_BYTES
			}: WebsocketProviderOptions = {}
		) {
			assertRoomId(roomname);
			super();
			this.serverUrl = serverUrl.replace(/\/+$/, '');
			this.roomname = roomname;
			this.bcChannel = this.serverUrl + '/' + roomname;
			this.disableBc = disableBc;
			this.doc = doc;
			this.awareness = awareness;
			this.params = params;
			this.maxBackoffTime = maxBackoffTime;
			this.connectTimeout = connectTimeout;
			this.maxFrameBytes =
				Number.isInteger(maxFrameBytes) && maxFrameBytes > 64 ? maxFrameBytes : MAX_FRAME_BYTES;
			this._WS = WebSocketPolyfill;
			this.shouldConnect = connect;
			initLifecycle(
				this,
				() => this.destroy(),
				() => room.depart(this)
			);
			if (resyncInterval > 0) {
				this._resync = setInterval(() => send(this, room.step1(this)), resyncInterval);
			}
			this._bcSubscriber = room.bcSubscriber(this);
			// Local doc updates go to the room; another tab's go to the server
			// only (`broadcastUpdate` quarantines a read-only document). A
			// socket the room made read-only gets this document's own edits
			// alone (each is denied): what a tab or a store delivered, and the
			// actor records, would draw denials nobody made.
			this._updateHandler = (update, origin, _doc, transaction) => {
				if (origin === this) return;
				const heard = origin === this._fromTab;
				if (!this.readOnly) room.broadcastUpdate(this, update, heard ? send : broadcast);
				else if (!heard) {
					const own = transaction?.local !== false && origin !== ATTRIBUTION_ORIGIN;
					room.broadcastUpdate(this, update, own ? broadcast : toTabs);
				}
				// The actor dictionary's records are bookkeeping, not content.
				if (origin === ATTRIBUTION_ORIGIN) return;
				const decoded = Y.decodeUpdate(update);
				this._writes.track(written(this.doc, decoded), decoded.ds);
			};
			this._writes = new OwnWrites(doc, (unsaved) =>
				this.emit('saved', [{ saved: unsaved === 0, unsaved }, this])
			);
			this._writes.trackDocument();
			this.doc.on('update', this._updateHandler);
			this._awarenessUpdateHandler = room.awarenessUpdateHandler(this);
			awareness.on('update', this._awarenessUpdateHandler);
			this._checkInterval = setInterval(() => {
				if (!this.wsconnected) return;
				const now = time.getUnixTime();
				const silence = now - this.wsLastMessageReceived;
				if (messageReconnectTimeout < silence) {
					// no message received in a long time - not even the answer to
					// our ping, nor the echo of our presence (renewed every 15 s)
					closeWebsocketConnection(this, this.ws as WebSocket, null);
				} else if (
					messagePingTimeout <= silence &&
					this.wsLastPingSent <= this.wsLastMessageReceived
				) {
					this.wsLastPingSent = now;
					send(this, 'ping');
				}
			}, messageReconnectTimeout / 10);
			if (connect) {
				this.connect();
			}
		}

		/**
		 * The dial URL: the room name as one encoded path segment (any id —
		 * `/`, `%`, `#`, `?` included — reaches its own room; the server
		 * decodes it). `''`, `.`, `..`, an id over 256 characters and one with a
		 * lone surrogate are refused at construction ({@link assertRoomId}). `params` are read at every dial (a refreshed token
		 * reaches the next connection), with `replica` = this document's
		 * client id unless `params` names one: the room binds the socket's
		 * writes to it.
		 */
		get url(): string {
			const query = url.encodeQueryParams({ replica: String(this.doc.clientID), ...this.params });
			return `${this.serverUrl}/${encodeURIComponent(this.roomname)}?${query}`;
		}

		/** Updates of this document's actor the room has not acknowledged as persisted yet. */
		get unsaved(): number {
			return this._writes.pending.length;
		}

		/**
		 * The room has persisted everything this document's actor wrote
		 * (store-before-ack): every tracked update's structs are under an
		 * acknowledged state vector and its deletes were acknowledged by id.
		 */
		get saved(): boolean {
			return this.unsaved === 0;
		}

		/**
		 * The room said this connection may read but not write (its notice
		 * at the join, or a refused write): nothing this actor writes counts
		 * as unsaved. `false` again once a dial may write.
		 */
		get readOnly(): boolean {
			return this._writes.readOnly;
		}

		/** This connection has held a room member's state (transient). */
		get synced(): boolean {
			return this._synced;
		}

		set synced(state: boolean) {
			if (this._synced !== state) {
				this._synced = state;
				if (state) markSynced(this);
				this.emit('synced', [state]);
			}
		}

		destroy(): void {
			// The destroy guard: idempotent, and the terminal failure of a
			// provider that never synced (a synced one that merely lost its
			// socket did not fail — `hasSynced`, D37).
			if (!beginDestroy(this, `WebsocketProvider "${this.roomname}"`)) return;
			clearInterval(this._resync);
			clearInterval(this._checkInterval);
			this.disconnect();
			this.awareness.off('update', this._awarenessUpdateHandler);
			this.doc.off('update', this._updateHandler);
			super.destroy();
		}

		disconnect(): void {
			this.shouldConnect = false;
			// The departure announcement (socket and tabs), then both close.
			if (this.ws !== null || this.bcconnected) room.disconnectBc(this);
			if (this.ws !== null) closeWebsocketConnection(this, this.ws, null);
		}

		connect(): void {
			this.shouldConnect = true;
			if (!this.wsconnected && this.ws === null) {
				setupWS(this);
				if (!this.disableBc) room.connectBc(this);
			}
		}
	}

	return { WebsocketProvider };
};
