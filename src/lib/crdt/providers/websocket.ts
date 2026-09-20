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
 * U07 difference — the version gate (`protocols/envelope.ts`): every
 * websocket frame and every BC message is tagged `varuint 14 |
 * messageType | payload`. Inbound frames without the tag are dropped before
 * `readSyncMessage` and reported via `'protocol-mismatch'`. A v13
 * y-websocket server in the room therefore cannot feed updates to this
 * provider (and vice versa) — see docs/crdt-v14-providers.md §server
 * classification: only an OPAQUE v1-update relay stays compatible; a server
 * that participates in sync (like upstream `y-websocket-server`) must itself
 * run the vendored v14 engine + v14 protocol modules.
 */
import * as bc from 'lib0-v14/broadcastchannel';
import * as time from 'lib0-v14/time';
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';
import { ObservableV2 } from 'lib0-v14/observable';
import * as math from 'lib0-v14/math';
import * as url from 'lib0-v14/url';
import * as env from 'lib0-v14/environment';
import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates
} from '../protocols/awareness.js';
import { readAuthMessage } from '../protocols/auth.js';
import { bindSync, type SyncProtocol } from '../protocols/sync.js';
import {
	PROTOCOL_VERSION,
	readProtocolVersion,
	writeProtocolVersion
} from '../protocols/envelope.js';
import { checkSchema, SchemaMismatchError, type SchemaProblem } from '../edytor-doc.js';
import type { EngineApi, EngineDoc, YDoc } from '../engine-api.js';
import type { ProtocolMismatch, SchemaMismatchDetail } from './indexeddb.js';

type NodeProcess = {
	on(event: string, f: () => void): void;
	off(event: string, f: () => void): void;
};
const nodeProcess = (): NodeProcess | undefined =>
	(globalThis as { process?: NodeProcess }).process;

export const messageSync = 0;
export const messageQueryAwareness = 3;
export const messageAwareness = 1;
export const messageAuth = 2;

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
	 * apply. The frame is dropped, never applied. Also mirrors schema-gate
	 * violations so the error channel sees every failure mode.
	 */
	'message-error': (error: unknown, provider: unknown) => void;
	/**
	 * The document's replicated state violates the application-schema gate
	 * (`meta.v` absent with content present = quarantined from broadcast;
	 * `meta.v` unsupported = synced but flagged). See the indexeddb provider
	 * for the same contract.
	 */
	'schema-mismatch': (detail: SchemaMismatchDetail, provider: unknown) => void;
	/** Server refused access — the auth reply carried a denial reason. */
	'permission-denied': (reason: string, provider: unknown) => void;
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

	/** Schema gate — see the indexeddb provider for the full contract. */
	const gateSchema = (provider: Provider): SchemaProblem | null => {
		const problem = checkSchema(provider.doc as unknown as EngineDoc);
		const key = problem === null ? null : `${problem.kind}:${problem.version ?? '?'}`;
		if (key !== provider._schemaGateKey) {
			provider._schemaGateKey = key;
			if (problem !== null) {
				provider.emit('schema-mismatch', [
					{ docName: provider.roomname, problem } satisfies SchemaMismatchDetail,
					provider
				]);
				provider.emit('message-error', [
					new SchemaMismatchError(provider.roomname, problem),
					provider
				]);
			}
		}
		return problem;
	};

	const permissionDeniedHandler = (provider: Provider, reason: string) => {
		// Observable event instead of console.warn — a denied peer must be
		// visible to consumers (auth failures are indistinguishable from a
		// silent disconnect otherwise).
		provider.emit('permission-denied', [reason, provider]);
	};

	const messageHandlers: Record<
		number,
		(
			encoder: encoding.Encoder,
			decoder: decoding.Decoder,
			provider: Provider,
			emitSynced: boolean,
			messageType: number
		) => void
	> = {
		[messageSync]: (encoder, decoder, provider, emitSynced) => {
			encoding.writeVarUint(encoder, messageSync);
			// Corrupt payloads inside a valid v14 envelope surface through
			// 'message-error' — never swallowed by the sync layer alone.
			const syncMessageType = syncProtocol.readSyncMessage(
				decoder,
				encoder,
				provider.doc,
				provider,
				(error) => provider.emit('message-error', [error, provider])
			);
			// Post-apply schema check — remote updates can move the doc into
			// an unsupported-version state.
			gateSchema(provider);
			if (emitSynced && syncMessageType === syncProtocol.messageYjsSyncStep2 && !provider.synced) {
				provider.synced = true;
			}
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
		[messageAuth]: (_encoder, decoder, provider) => {
			readAuthMessage(decoder, provider.doc, (_ydoc, reason) =>
				permissionDeniedHandler(provider, reason)
			);
		}
	};

	const readMessage = (provider: Provider, buf: Uint8Array, emitSynced: boolean) => {
		const decoder = decoding.createDecoder(buf);
		const encoder = encoding.createEncoder();
		if (!readProtocolVersion(decoder)) {
			provider.emit('protocol-mismatch', [
				{ expected: PROTOCOL_VERSION, found: buf.length > 0 ? buf[0] : null },
				provider
			]);
			return encoder;
		}
		writeProtocolVersion(encoder);
		const messageType = decoding.readVarUint(decoder);
		const messageHandler = provider.messageHandlers[messageType];
		if (messageHandler) {
			messageHandler(encoder, decoder, provider, emitSynced, messageType);
		} else {
			// Fail closed + observable — a valid v14 envelope with an unknown
			// message type is surfaced, not silently dropped.
			provider.emit('message-error', [
				new Error(`Unknown v14 message type ${messageType}`),
				provider
			]);
		}
		return encoder;
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
					const encoder = readMessage(provider, new Uint8Array(event.data as ArrayBuffer), true);
					// `> 2`: the version envelope makes an empty reply 2 bytes
					// (version word + mirrored message type), not 1 as upstream.
					if (encoding.length(encoder) > 2) {
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
		messageHandlers: typeof messageHandlers;
		_synced: boolean;
		ws: WebSocket | null;
		wsLastMessageReceived: number;
		shouldConnect: boolean;
		/** Last signaled schema-gate state key — dedupes 'schema-mismatch'. */
		_schemaGateKey: string | null;
		_resyncInterval: ReturnType<typeof setInterval> | 0;
		_checkInterval: ReturnType<typeof setInterval>;
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
			this.messageHandlers = messageHandlers;
			this._synced = false;
			this.ws = null;
			this.wsLastMessageReceived = 0;
			this.shouldConnect = connect;
			this._schemaGateKey = null;
			this._resyncInterval = 0;
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

			this._bcSubscriber = (data, origin) => {
				if (origin !== this) {
					try {
						const encoder = readMessage(this, new Uint8Array(data), false);
						// `> 2` — see the onmessage handler / indexeddb provider.
						if (encoding.length(encoder) > 2) {
							bc.publish(this.bcChannel, encoding.toUint8Array(encoder), this);
						}
					} catch (error) {
						// Same-tab lib0 delivery is synchronous: never let a
						// malformed frame propagate into the publisher's stack.
						this.emit('message-error', [error, this]);
					}
				}
			};
			// Listens to doc updates and sends them to remote peers (ws and bc)
			this._updateHandler = (update, origin) => {
				// Schema gate: updates leaving the doc with replicated registry
				// content but no meta.v are quarantined — never broadcast
				// (gate-2 attack 1a). 'unsupported' meta.v signals but flows.
				if (origin !== this && gateSchema(this)?.kind !== 'unversioned') {
					const encoder = encoding.createEncoder();
					writeProtocolVersion(encoder);
					encoding.writeVarUint(encoder, messageSync);
					syncProtocol.writeUpdate(encoder, update);
					broadcastMessage(this, encoding.toUint8Array(encoder));
				}
			};
			this.doc.on('update', this._updateHandler);
			this._awarenessUpdateHandler = ({ added, updated, removed }, _origin) => {
				const changedClients = added.concat(updated).concat(removed);
				const encoder = encoding.createEncoder();
				writeProtocolVersion(encoder);
				encoding.writeVarUint(encoder, messageAwareness);
				encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, changedClients));
				broadcastMessage(this, encoding.toUint8Array(encoder));
			};
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
			if (this._resyncInterval !== 0) {
				clearInterval(this._resyncInterval);
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
			if (!this.bcconnected) {
				bc.subscribe(this.bcChannel, this._bcSubscriber);
				this.bcconnected = true;
			}
			// send sync step1 to bc
			const encoderSync = encoding.createEncoder();
			writeProtocolVersion(encoderSync);
			encoding.writeVarUint(encoderSync, messageSync);
			syncProtocol.writeSyncStep1(encoderSync, this.doc);
			bc.publish(this.bcChannel, encoding.toUint8Array(encoderSync), this);
			// broadcast local state
			const encoderState = encoding.createEncoder();
			writeProtocolVersion(encoderState);
			encoding.writeVarUint(encoderState, messageSync);
			syncProtocol.writeSyncStep2(encoderState, this.doc);
			bc.publish(this.bcChannel, encoding.toUint8Array(encoderState), this);
			// write queryAwareness
			const encoderAwarenessQuery = encoding.createEncoder();
			writeProtocolVersion(encoderAwarenessQuery);
			encoding.writeVarUint(encoderAwarenessQuery, messageQueryAwareness);
			bc.publish(this.bcChannel, encoding.toUint8Array(encoderAwarenessQuery), this);
			// broadcast local awareness state
			const encoderAwarenessState = encoding.createEncoder();
			writeProtocolVersion(encoderAwarenessState);
			encoding.writeVarUint(encoderAwarenessState, messageAwareness);
			encoding.writeVarUint8Array(
				encoderAwarenessState,
				encodeAwarenessUpdate(this.awareness, [this.doc.clientID])
			);
			bc.publish(this.bcChannel, encoding.toUint8Array(encoderAwarenessState), this);
		}

		disconnectBc(): void {
			// broadcast message with local awareness state set to null
			// (indicating disconnect)
			const encoder = encoding.createEncoder();
			writeProtocolVersion(encoder);
			encoding.writeVarUint(encoder, messageAwareness);
			encoding.writeVarUint8Array(
				encoder,
				encodeAwarenessUpdate(this.awareness, [this.doc.clientID], new Map())
			);
			broadcastMessage(this, encoding.toUint8Array(encoder));
			if (this.bcconnected) {
				bc.unsubscribe(this.bcChannel, this._bcSubscriber);
				this.bcconnected = false;
			}
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
