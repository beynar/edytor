/**
 * Websocket provider for the vendored v14 engine — port of
 * `y-websocket@3.0.0` `src/y-websocket.js` (MIT © Kevin Jahns — see
 * `src/lib/crdt/vendor/yjs/LICENSE`).
 *
 * Retained surface (D-24 G-e): `status`/`synced`/`connection-*` events,
 * `connect()`/`disconnect()`, awareness injection, auth `params` (read at
 * every dial, so a refreshed token reaches the next connection),
 * `WebSocketPolyfill`, exponential-backoff reconnect (`maxBackoffTime`),
 * liveness, and `resyncInterval`. Retired: `protocols`, the `sync` alias,
 * `wsconnecting`, and the BroadcastChannel leg with `disableBc` (cross-tab
 * sync is the IndexedDB provider's).
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
import * as time from 'lib0-v14/time';
import * as decoding from 'lib0-v14/decoding';
import { ObservableV2 } from 'lib0-v14/observable';
import * as math from 'lib0-v14/math';
import * as url from 'lib0-v14/url';
import { Awareness, removeAwarenessStates } from '../protocols/awareness.js';
import { messagePermissionDenied, readAuthMessage } from '../protocols/auth.js';
import { bindSync, type SyncProtocol } from '../protocols/sync.js';
import {
	beginDestroy,
	bindRoomProtocol,
	createChunkReader,
	emitFailed,
	initLifecycle,
	markSynced,
	messageAuth,
	messageChunk,
	messageSaved,
	type LifecycleHost,
	type ProtocolMismatch,
	type RoomMessageHandler,
	type SchemaMismatchDetail
} from './room.js';
import type { EngineApi, YDoc } from '../engine-api.js';

// @todo - this should depend on awareness.outdatedTime
const messageReconnectTimeout = 30000;

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
	 * Terminal sync failure (the D4 contract): the provider never synced —
	 * destroyed before any handshake completed, or the server denied
	 * permission. Emitted at most once; never once `hasSynced`, never on a
	 * transient (reconnectable) disconnect.
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

	/** Room traffic goes out on the socket while it is open. */
	const send = (provider: Provider, buf: Uint8Array) => {
		const ws = provider.ws;
		if (provider.wsconnected && ws && ws.readyState === ws.OPEN) ws.send(buf);
	};

	/**
	 * The shared room protocol (S1). The transport edges stay here:
	 * `messageAuth` exists only on a server socket, and `heard` claims the
	 * connection's `synced`.
	 */
	const room = bindRoomProtocol<Provider>(syncProtocol, {
		docName: (provider) => provider.roomname,
		broadcast: send,
		handlers: {
			[messageAuth]: (_encoder, decoder, provider) => {
				const authType = readAuthMessage(decoder, provider.doc, (_ydoc, reason) => {
					// Observable, and a terminal sync failure (D4): a denied
					// provider can never reach `synced` — reported at most once.
					provider.emit('permission-denied', [reason, provider]);
					emitFailed(provider, new Error(`permission denied: ${reason}`));
				});
				if (authType !== messagePermissionDenied) {
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
			provider.synced = true;
		}
	});
	// The room's acknowledgement and its bounded catch-up (a frame too large
	// for one message arrives as chunks and is read only once complete).
	room.messageHandlers[messageSaved] = (_encoder, decoder, provider) =>
		provider._acknowledge(decoding.readVarUint8Array(decoder));
	room.messageHandlers[messageChunk] = (_encoder, decoder, provider, emitSynced) => {
		const whole = provider._chunks(decoder);
		if (whole !== null) room.readMessage(provider, whole, emitSynced, (buf) => send(provider, buf));
	};

	type StateVector = Map<number, number>;
	const stateVector = (doc: YDoc): StateVector => Y.decodeStateVector(Y.encodeStateVector(doc));
	const covers = (acked: StateVector, sv: StateVector) => {
		for (const [client, clock] of sv) if ((acked.get(client) ?? 0) < clock) return false;
		return true;
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
		if (ws === provider.ws) {
			provider.emit('connection-close', [event, provider]);
			provider.ws = null;
			ws.close();
			if (provider.wsconnected) {
				provider.wsconnected = false;
				provider.synced = false;
				// update awareness (all users except local left)
				removeAwarenessStates(
					provider.awareness,
					Array.from(provider.awareness.getStates().keys()).filter(
						(client) => client !== provider.doc.clientID
					),
					provider
				);
				provider.emit('status', [{ status: 'disconnected' }]);
			} else {
				provider.wsUnsuccessfulReconnects++;
			}
			// Start with no reconnect timeout and increase by exponential
			// backoff starting with 100ms.
			setTimeout(
				setupWS,
				math.min(math.pow(2, provider.wsUnsuccessfulReconnects) * 100, provider.maxBackoffTime),
				provider
			);
		}
	};

	const setupWS = (provider: Provider) => {
		if (provider.shouldConnect && provider.ws === null) {
			const websocket = new provider._WS(provider.url);
			websocket.binaryType = 'arraybuffer';
			provider.ws = websocket;
			provider.wsconnected = false;
			provider.synced = false;
			provider._chunks = createChunkReader();

			websocket.onmessage = (event) => {
				provider.wsLastMessageReceived = time.getUnixTime();
				try {
					room.readMessage(provider, new Uint8Array(event.data as ArrayBuffer), true, (buf) =>
						websocket.send(buf)
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
				provider.wsLastMessageReceived = time.getUnixTime();
				provider.wsconnected = true;
				provider.wsUnsuccessfulReconnects = 0;
				provider.emit('status', [{ status: 'connected' }]);
				// The join rule: say hello; the members answer what we lack.
				for (const buf of room.hello(provider)) websocket.send(buf);
			};
			provider.emit('status', [{ status: 'connecting' }]);
		}
	};

	class WebsocketProvider extends ObservableV2<WebsocketProviderEvents> {
		serverUrl: string;
		roomname: string;
		doc: YDoc;
		awareness: Awareness;
		params: Record<string, string>;
		maxBackoffTime: number;
		_WS: WebsocketPolyfill;
		shouldConnect: boolean;
		ws: WebSocket | null = null;
		wsconnected = false;
		wsUnsuccessfulReconnects = 0;
		wsLastMessageReceived = 0;
		_synced = false;
		/** Reassembles this socket's chunked frames (reset per connection). */
		_chunks = createChunkReader();
		/** The doc's state vector after each local update not yet acknowledged (monotone). */
		_pending: StateVector[] = [];
		/** The room's last acknowledged state vector. */
		_acked: StateVector = new Map();
		messageHandlers: Record<number, RoomMessageHandler<WebsocketProvider>> = room.messageHandlers;
		// The room lifecycle (O74) — installed by `initLifecycle`.
		hasSynced!: boolean;
		whenSynced!: Promise<unknown>;
		_destroyed!: boolean;
		_failedEmitted?: boolean;
		_settleSynced!: LifecycleHost['_settleSynced'];
		_leave!: () => void;
		_resync: ReturnType<typeof setInterval> | undefined;
		_checkInterval: ReturnType<typeof setInterval>;
		_updateHandler: (update: Uint8Array, origin: unknown) => void;
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
				maxBackoffTime = 2500
			}: WebsocketProviderOptions = {}
		) {
			super();
			this.serverUrl = serverUrl.replace(/\/+$/, '');
			this.roomname = roomname;
			this.doc = doc;
			this.awareness = awareness;
			this.params = params;
			this.maxBackoffTime = maxBackoffTime;
			this._WS = WebSocketPolyfill;
			this.shouldConnect = connect;
			initLifecycle(this, () => this.destroy());
			if (resyncInterval > 0) {
				this._resync = setInterval(() => send(this, room.step1(this)), resyncInterval);
			}
			// Local doc updates go to the room (`broadcastUpdate` quarantines
			// a read-only document).
			this._updateHandler = (update, origin) => {
				if (origin === this) return;
				room.broadcastUpdate(this, update);
				this._track();
			};
			// What the doc already holds is unsaved until the room covers it.
			this._track();
			this.doc.on('update', this._updateHandler);
			this._awarenessUpdateHandler = room.awarenessUpdateHandler(this);
			awareness.on('update', this._awarenessUpdateHandler);
			this._checkInterval = setInterval(() => {
				if (
					this.wsconnected &&
					messageReconnectTimeout < time.getUnixTime() - this.wsLastMessageReceived
				) {
					// no message received in a long time - not even our own awareness
					// updates (which are updated every 15 seconds)
					closeWebsocketConnection(this, this.ws as WebSocket, null);
				}
			}, messageReconnectTimeout / 10);
			if (connect) {
				this.connect();
			}
		}

		get url(): string {
			const encodedParams = url.encodeQueryParams(this.params);
			return (
				this.serverUrl +
				'/' +
				this.roomname +
				(encodedParams.length === 0 ? '' : '?' + encodedParams)
			);
		}

		/** Local updates the room has not acknowledged as persisted yet. */
		get unsaved(): number {
			return this._pending.length;
		}

		/** The room has persisted everything this replica wrote (store-before-ack). */
		get saved(): boolean {
			return this._pending.length === 0;
		}

		_track(): void {
			const sv = stateVector(this.doc);
			if (covers(this._acked, sv)) return;
			this._pending.push(sv);
			this.emit('saved', [{ saved: false, unsaved: this._pending.length }, this]);
		}

		/** A `messageSaved` frame: the room stored everything under `sv`. */
		_acknowledge(sv: Uint8Array): void {
			this._acked = Y.decodeStateVector(sv);
			const before = this._pending.length;
			this._pending = this._pending.filter((entry) => !covers(this._acked, entry));
			if (this._pending.length !== before) {
				this.emit('saved', [{ saved: this.saved, unsaved: this._pending.length }, this]);
			}
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
			if (this.ws !== null) {
				// The departure announcement, then the socket closes.
				send(this, room.goodbye(this));
				closeWebsocketConnection(this, this.ws, null);
			}
		}

		connect(): void {
			this.shouldConnect = true;
			if (!this.wsconnected && this.ws === null) {
				setupWS(this);
			}
		}
	}

	return { WebsocketProvider };
};
