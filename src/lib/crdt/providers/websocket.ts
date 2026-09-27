/**
 * Websocket provider for the vendored v14 engine — port of
 * `y-websocket@3.0.0` `src/y-websocket.js` (MIT © Kevin Jahns — see
 * `src/lib/crdt/vendor/yjs/LICENSE`).
 *
 * Semantics preserved: `sync`/`synced`/`status`/`connection-*` events,
 * `connect()`/`disconnect()`, awareness injection, query `params`,
 * `protocols`, `WebSocketPolyfill`, `resyncInterval`, exponential-backoff
 * reconnect (`maxBackoffTime`), `disableBc`, and BroadcastChannel cross-tab
 * fan-out on `serverUrl + '/' + roomname`.
 *
 * The generation gate (`protocols/envelope.ts`, R13): every websocket
 * frame and every BC message is tagged `varuint GENERATION | messageType |
 * payload`. Inbound frames of any other generation are dropped before
 * decode and reported via `'protocol-mismatch'`. A v13
 * y-websocket server in the room therefore cannot feed updates to this
 * provider (and vice versa) — see docs/crdt-v14-providers.md §server
 * classification: only an OPAQUE v1-update relay stays compatible; a server
 * that participates in sync (like upstream `y-websocket-server`) must itself
 * run the vendored v14 engine + v14 protocol modules.
 *
 * The room half — enveloped dispatch, the join rule, the inbound refusal,
 * awareness publish/query, the BroadcastChannel subscriber + join/leave
 * sequences, the outbound quarantine and the provider lifecycle — is shared
 * with the IndexedDB provider in `room.ts` (S1). This file keeps the
 * transport edges: the socket lifecycle, reconnect backoff, liveness, the
 * auth reply, and the connection's `synced` (transient: it resets with the
 * socket; `hasSynced` is the lifetime fact). `resyncInterval` is an
 * optional loss-healing timer, not a correctness dependency: the join rule
 * already exchanges what each side lacks on every (re)connect.
 */
import * as bc from 'lib0-v14/broadcastchannel';
import * as time from 'lib0-v14/time';
import { ObservableV2 } from 'lib0-v14/observable';
import * as math from 'lib0-v14/math';
import * as url from 'lib0-v14/url';
import { Awareness, removeAwarenessStates } from '../protocols/awareness.js';
import { messagePermissionDenied, readAuthMessage } from '../protocols/auth.js';
import { bindSync, type SyncProtocol } from '../protocols/sync.js';
import {
	beginDestroy,
	bindRoomProtocol,
	emitFailed,
	initLifecycle,
	markSynced,
	messageAuth,
	messageAwareness,
	messageQueryAwareness,
	messageSync,
	type LifecycleHost,
	type ProtocolMismatch,
	type RoomMessageHandler,
	type SchemaMismatchDetail
} from './room.js';
import type { EngineApi, YDoc } from '../engine-api.js';

export { messageSync, messageAwareness, messageAuth, messageQueryAwareness };

// @todo - this should depend on awareness.outdatedTime
const messageReconnectTimeout = 30000;

export type WebsocketProviderEvents = {
	status: (event: { status: 'connected' | 'disconnected' | 'connecting' }) => void;
	sync: (state: boolean) => void;
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
	new (url: string, protocols?: string | string[]): WebSocket;
	prototype: WebSocket;
	readonly OPEN: number;
};

export type WebsocketProviderOptions = {
	connect?: boolean;
	awareness?: Awareness;
	params?: Record<string, string>;
	protocols?: string[];
	WebSocketPolyfill?: WebsocketPolyfill;
	/**
	 * Request room state every `resyncInterval` milliseconds — an optional
	 * loss-healing timer (off by default; the join rule needs no timer).
	 */
	resyncInterval?: number;
	/** Max reconnect backoff (exponential backoff is used). */
	maxBackoffTime?: number;
	/** Disable cross-tab BroadcastChannel communication. */
	disableBc?: boolean;
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

	const permissionDeniedHandler = (provider: Provider, reason: string) => {
		// Observable event instead of console.warn — a denied peer must be
		// visible to consumers (auth failures are indistinguishable from a
		// silent disconnect otherwise). A denied handshake is also a
		// terminal sync failure (D4): on a server that refuses it, the
		// provider can never reach `synced` — reported at most once.
		provider.emit('permission-denied', [reason, provider]);
		emitFailed(provider, new Error(`permission denied: ${reason}`));
	};

	/**
	 * The shared room protocol (S1). The transport edges stay here:
	 * `messageAuth` exists only on a server socket (a BC room has no
	 * authority to deny), and `heard` claims the connection's `synced`.
	 */
	const room = bindRoomProtocol<Provider>(syncProtocol, {
		docName: (provider) => provider.roomname,
		roomChannel: (provider) => provider.bcChannel,
		broadcast: (provider, buf) => broadcastMessage(provider, buf),
		handlers: {
			[messageAuth]: (_encoder, decoder, provider) => {
				const authType = readAuthMessage(decoder, provider.doc, (_ydoc, reason) =>
					permissionDeniedHandler(provider, reason)
				);
				if (authType !== messagePermissionDenied) {
					// Same contract as unknown sync subtypes — a valid v14
					// envelope carrying an auth type we do not speak is protocol
					// skew; report it rather than dropping silently.
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
			provider.wsconnecting = false;
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
			const websocket = new provider._WS(provider.url, provider.protocols);
			websocket.binaryType = 'arraybuffer';
			provider.ws = websocket;
			provider.wsconnecting = true;
			provider.wsconnected = false;
			provider.synced = false;

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
				provider.wsconnecting = false;
				provider.wsconnected = true;
				provider.wsUnsuccessfulReconnects = 0;
				provider.emit('status', [{ status: 'connected' }]);
				// The join rule: say hello; the members answer what we lack.
				for (const buf of room.hello(provider)) websocket.send(buf);
			};
			provider.emit('status', [{ status: 'connecting' }]);
		}
	};

	const broadcastMessage = (provider: Provider, buf: Uint8Array) => {
		const ws = provider.ws;
		if (provider.wsconnected && ws && ws.readyState === ws.OPEN) {
			ws.send(buf);
		}
		if (provider.bcconnected) {
			bc.publish(provider.bcChannel, buf, provider);
		}
	};

	class WebsocketProvider extends ObservableV2<WebsocketProviderEvents> {
		serverUrl: string;
		bcChannel: string;
		maxBackoffTime: number;
		params: Record<string, string>;
		protocols: string[];
		roomname: string;
		doc: YDoc;
		_WS: WebsocketPolyfill;
		awareness: Awareness;
		wsconnected: boolean;
		wsconnecting: boolean;
		bcconnected: boolean;
		disableBc: boolean;
		wsUnsuccessfulReconnects: number;
		messageHandlers: Record<number, RoomMessageHandler<WebsocketProvider>>;
		_synced: boolean;
		ws: WebSocket | null;
		wsLastMessageReceived: number;
		shouldConnect: boolean;
		// The room lifecycle (O74) — installed by `initLifecycle`.
		hasSynced!: boolean;
		whenSynced!: Promise<unknown>;
		_destroyed!: boolean;
		_failedEmitted?: boolean;
		_settleSynced!: LifecycleHost['_settleSynced'];
		_leave!: () => void;
		_resyncInterval: ReturnType<typeof setInterval> | 0;
		_checkInterval: ReturnType<typeof setInterval>;
		_bcSubscriber: (data: ArrayBuffer, origin: unknown) => void;
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
				protocols = [],
				WebSocketPolyfill = WebSocket as unknown as WebsocketPolyfill,
				resyncInterval = -1,
				maxBackoffTime = 2500,
				disableBc = false
			}: WebsocketProviderOptions = {}
		) {
			super();
			// ensure that serverUrl does not end with /
			while (serverUrl[serverUrl.length - 1] === '/') {
				serverUrl = serverUrl.slice(0, serverUrl.length - 1);
			}
			this.serverUrl = serverUrl;
			this.bcChannel = serverUrl + '/' + roomname;
			this.maxBackoffTime = maxBackoffTime;
			this.params = params;
			this.protocols = protocols;
			this.roomname = roomname;
			this.doc = doc;
			this._WS = WebSocketPolyfill;
			this.awareness = awareness;
			this.wsconnected = false;
			this.wsconnecting = false;
			this.bcconnected = false;
			this.disableBc = disableBc;
			this.wsUnsuccessfulReconnects = 0;
			this.messageHandlers = room.messageHandlers;
			this._synced = false;
			this.ws = null;
			this.wsLastMessageReceived = 0;
			this.shouldConnect = connect;
			this._resyncInterval = 0;
			initLifecycle(this, () => this.destroy());
			if (resyncInterval > 0) {
				this._resyncInterval = setInterval(() => {
					if (this.ws && this.ws.readyState === this._WS.OPEN) {
						this.ws.send(room.step1(this));
					}
				}, resyncInterval);
			}

			this._bcSubscriber = room.bcSubscriber(this);
			// Listens to doc updates and sends them to remote peers (ws and bc)
			this._updateHandler = (update, origin) => {
				// `broadcastUpdate` quarantines a read-only document.
				if (origin !== this) room.broadcastUpdate(this, update);
			};
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

		/** This connection has held a room member's state (transient). */
		get synced(): boolean {
			return this._synced;
		}

		set synced(state: boolean) {
			if (this._synced !== state) {
				this._synced = state;
				if (state) markSynced(this);
				this.emit('synced', [state]);
				this.emit('sync', [state]);
			}
		}

		destroy(): void {
			// The destroy guard: idempotent, and the terminal failure of a
			// provider that never synced (a synced one that merely lost its
			// socket did not fail — `hasSynced`, D37).
			if (!beginDestroy(this, `WebsocketProvider "${this.roomname}"`)) return;
			if (this._resyncInterval !== 0) {
				clearInterval(this._resyncInterval);
			}
			clearInterval(this._checkInterval);
			this.disconnect();
			this.awareness.off('update', this._awarenessUpdateHandler);
			this.doc.off('update', this._updateHandler);
			super.destroy();
		}

		connectBc(): void {
			if (this.disableBc) {
				return;
			}
			room.connectBc(this);
		}

		disconnectBc(): void {
			room.disconnectBc(this);
		}

		disconnect(): void {
			this.shouldConnect = false;
			this.disconnectBc();
			if (this.ws !== null) {
				closeWebsocketConnection(this, this.ws, null);
			}
		}

		connect(): void {
			this.shouldConnect = true;
			if (!this.wsconnected && this.ws === null) {
				setupWS(this);
				this.connectBc();
			}
		}
	}

	return { WebsocketProvider };
};
