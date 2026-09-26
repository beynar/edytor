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
 * The room half — enveloped dispatch, the sync handler (inbound refusal),
 * awareness publish/query, the BroadcastChannel subscriber +
 * connect/disconnect sequences, and the outbound quarantine — is shared with the IndexedDB
 * provider in `room.ts` (S1). This file keeps the transport edges: the
 * socket lifecycle, reconnect backoff, the auth reply, and the
 * SyncStep2-handshake `synced` verdict (+ the `syncSettleMs` ambiguity
 * window).
 */
import * as bc from 'lib0-v14/broadcastchannel';
import * as time from 'lib0-v14/time';
import * as encoding from 'lib0-v14/encoding';
import { ObservableV2 } from 'lib0-v14/observable';
import * as math from 'lib0-v14/math';
import * as url from 'lib0-v14/url';
import * as env from 'lib0-v14/environment';
import { Awareness, encodeAwarenessUpdate, removeAwarenessStates } from '../protocols/awareness.js';
import { messagePermissionDenied, readAuthMessage } from '../protocols/auth.js';
import { bindSync, type SyncProtocol } from '../protocols/sync.js';
import { BARE_REPLY_LENGTH, writeProtocolVersion } from '../protocols/envelope.js';
import {
	bindRoomProtocol,
	emitFailed,
	messageAuth,
	messageAwareness,
	messageQueryAwareness,
	messageSync,
	type ProtocolMismatch,
	type RoomMessageHandler,
	type SchemaMismatchDetail
} from './room.js';
import type { EngineApi, YDoc } from '../engine-api.js';

export { messageSync, messageAwareness, messageAuth, messageQueryAwareness };

type NodeProcess = {
	on(event: string, f: () => void): void;
	off(event: string, f: () => void): void;
};
const nodeProcess = (): NodeProcess | undefined =>
	(globalThis as { process?: NodeProcess }).process;

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
	 * Terminal sync failure (the D4 contract): the provider can never
	 * reach `synced` — destroyed before the handshake completed, or the
	 * server denied permission. Emitted at most once; never after
	 * `synced === true`, never on a transient (reconnectable) disconnect.
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
	/** Request server state every `resyncInterval` milliseconds. */
	resyncInterval?: number;
	/** Max reconnect backoff (exponential backoff is used). */
	maxBackoffTime?: number;
	/** Disable cross-tab BroadcastChannel communication. */
	disableBc?: boolean;
	/**
	 * Settle window for an ambiguous empty SyncStep2. An opaque relay
	 * broadcasts every SyncStep2 reply to ALL room members, so replies
	 * computed against ANOTHER member's state vector land here too — and
	 * for an already-synced pair that diff is EMPTY. An applied empty
	 * SyncStep2 on a still-empty doc therefore cannot prove OUR handshake
	 * completed; `synced` is deferred by `syncSettleMs` so a real answer
	 * carrying room state can land first.
	 *
	 * The verdict is a TWO-ROUND handshake: at the first expiry with a
	 * still-empty doc the provider re-broadcasts a fresh SyncStep1 (an
	 * "are you sure" probe) and grants the room a SECOND window. A
	 * hydration reply delayed past the first window — a slow peer, a
	 * relay stall, a congested network — still lands before `synced`.
	 * Only a doc still empty after the probe's window decides `synced`
	 * (the room verifiably has nothing for us — what lets a fresh doc
	 * seed an empty room). Worst case the empty-room decision costs
	 * `2 × syncSettleMs`.
	 */
	syncSettleMs?: number;
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

	/** True iff the doc holds any replicated state (an empty sv is `[0]`). */
	const hasDocState = (doc: YDoc) => Y.encodeStateVector(doc).length > 1;

	/**
	 * Defer `synced` for an empty SyncStep2 on an empty doc — see the
	 * `syncSettleMs` option for why an applied empty reply is ambiguous.
	 * Armed once per handshake; replies landing mid-window keep the
	 * original deadline (room chatter must not starve the decision).
	 *
	 * First expiry re-requests instead of deciding: a fresh SyncStep1
	 * probe goes out and the room gets a second window to answer. Only
	 * the SECOND quiet expiry claims `synced` — a hydration answer
	 * delayed past one window (slow peer, relay stall) still lands
	 * before the verdict, so a client cannot seed over state it simply
	 * hadn't heard yet.
	 */
	const armSyncSettle = (provider: Provider) => {
		if (provider._syncSettleTimer !== 0) return;
		provider._syncSettleTimer = setTimeout(() => {
			provider._syncSettleTimer = 0;
			if (provider.synced || hasDocState(provider.doc)) {
				// A doc that gained state meanwhile waits for the applied
				// SyncStep2 that delivered it to claim `synced` — the
				// settle only resolves the verifiably-empty room.
				provider._syncSettleProbed = false;
				return;
			}
			if (!provider.wsconnected && !provider.bcconnected) {
				// No transport can deliver a room answer — silence it
				// cannot hear proves nothing. The next connect's
				// SyncStep1 re-derives the handshake.
				provider._syncSettleProbed = false;
				return;
			}
			if (!provider._syncSettleProbed) {
				provider._syncSettleProbed = true;
				const encoder = encoding.createEncoder();
				writeProtocolVersion(encoder);
				encoding.writeVarUint(encoder, messageSync);
				syncProtocol.writeSyncStep1(encoder, provider.doc);
				broadcastMessage(provider, encoding.toUint8Array(encoder));
				armSyncSettle(provider);
				return;
			}
			provider._syncSettleProbed = false;
			provider.synced = true;
		}, provider.syncSettleMs);
	};

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
	 * The shared room protocol (S1) — dispatch, sync handling,
	 * awareness flow, the BC subscriber + connect/disconnect sequences.
	 * The transport edges stay here: `messageAuth` exists only on a server
	 * socket (a BC room has no authority to deny), and `synced` is the
	 * SyncStep2-handshake verdict (+ the `syncSettleMs` ambiguity window),
	 * not the local-hydration claim the IndexedDB provider makes.
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
		onSyncApplied: (provider, syncMessageType, applied, emitSynced) => {
			// `synced` only fires when the SyncStep2 handshake payload was
			// actually accepted — a refused SyncStep2 must not produce a
			// false synced (the doc does not reflect the peer's state).
			// Acceptance alone is not enough though: the reply must leave
			// the doc holding state (an applied empty payload on an empty
			// doc may be a foreign broadcast reply — it defers `synced`
			// to the settle window instead of claiming it).
			if (
				emitSynced &&
				syncMessageType === syncProtocol.messageYjsSyncStep2 &&
				applied &&
				!provider.synced
			) {
				if (hasDocState(provider.doc)) {
					provider.synced = true;
				} else {
					armSyncSettle(provider);
				}
			}
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
			// A pending handshake-settle belongs to the closed socket — a
			// fresh connection re-derives `synced` from its own handshake
			// (and gets its own probe round).
			if (provider._syncSettleTimer !== 0) {
				clearTimeout(provider._syncSettleTimer);
				provider._syncSettleTimer = 0;
				provider._syncSettleProbed = false;
			}
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
					const encoder = room.readMessage(
						provider,
						new Uint8Array(event.data as ArrayBuffer),
						true
					);
					if (encoding.length(encoder) > BARE_REPLY_LENGTH) {
						websocket.send(encoding.toUint8Array(encoder));
					}
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
				// always send sync step 1 when connected
				const encoder = encoding.createEncoder();
				writeProtocolVersion(encoder);
				encoding.writeVarUint(encoder, messageSync);
				syncProtocol.writeSyncStep1(encoder, provider.doc);
				websocket.send(encoding.toUint8Array(encoder));
				// broadcast local awareness state
				if (provider.awareness.getLocalState() !== null) {
					const encoderAwarenessState = encoding.createEncoder();
					writeProtocolVersion(encoderAwarenessState);
					encoding.writeVarUint(encoderAwarenessState, messageAwareness);
					encoding.writeVarUint8Array(
						encoderAwarenessState,
						encodeAwarenessUpdate(provider.awareness, [provider.doc.clientID])
					);
					websocket.send(encoding.toUint8Array(encoderAwarenessState));
				}
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
		/** Latch — 'failed' emits at most once (see `emitFailed` in room.ts). */
		_failedEmitted?: boolean;
		_resyncInterval: ReturnType<typeof setInterval> | 0;
		_checkInterval: ReturnType<typeof setInterval>;
		_syncSettleTimer: ReturnType<typeof setTimeout> | 0;
		/** Set when the settle's first expiry already re-probed — the next expiry decides. */
		_syncSettleProbed: boolean;
		syncSettleMs: number;
		_bcSubscriber: (data: ArrayBuffer, origin: unknown) => void;
		_updateHandler: (update: Uint8Array, origin: unknown) => void;
		_awarenessUpdateHandler: (
			updates: { added: number[]; updated: number[]; removed: number[] },
			origin: unknown
		) => void;
		_exitHandler: () => void;

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
				disableBc = false,
				syncSettleMs = 300
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
			this._syncSettleTimer = 0;
			this._syncSettleProbed = false;
			this.syncSettleMs = syncSettleMs;
			if (resyncInterval > 0) {
				this._resyncInterval = setInterval(() => {
					if (this.ws && this.ws.readyState === this._WS.OPEN) {
						// resend sync step 1
						const encoder = encoding.createEncoder();
						writeProtocolVersion(encoder);
						encoding.writeVarUint(encoder, messageSync);
						syncProtocol.writeSyncStep1(encoder, doc);
						this.ws.send(encoding.toUint8Array(encoder));
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
			this._exitHandler = () => {
				removeAwarenessStates(this.awareness, [doc.clientID], 'app closed');
			};
			const proc = env.isNode ? nodeProcess() : undefined;
			proc?.on('exit', this._exitHandler);
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

		get synced(): boolean {
			return this._synced;
		}

		set synced(state: boolean) {
			if (this._synced !== state) {
				this._synced = state;
				this.emit('synced', [state]);
				this.emit('sync', [state]);
			}
		}

		destroy(): void {
			// A provider destroyed before its handshake completed can never
			// reach `synced` (D4) — checked BEFORE disconnect(): tearing a
			// synced socket down resets `synced`, which must not masquerade
			// as a failure. Emitted at most once (emitFailed latches).
			if (!this.synced) {
				emitFailed(
					this,
					new Error(`WebsocketProvider "${this.roomname}" was destroyed before it synced`)
				);
			}
			if (this._resyncInterval !== 0) {
				clearInterval(this._resyncInterval);
			}
			if (this._syncSettleTimer !== 0) {
				clearTimeout(this._syncSettleTimer);
				this._syncSettleTimer = 0;
				this._syncSettleProbed = false;
			}
			clearInterval(this._checkInterval);
			this.disconnect();
			const proc = env.isNode ? nodeProcess() : undefined;
			proc?.off('exit', this._exitHandler);
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
