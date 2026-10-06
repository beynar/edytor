/**
 * Provider stack for the vendored v14 engine — bound entry point.
 *
 * `bindProviders(Y)` produces the whole provider surface for one engine
 * instance: the provider classes plus `EdytorSync`-shaped factories matching
 * the `{ doc, awareness, synced }` contract. THE single implementation —
 * `src/lib/collaboration/providers.ts` re-exports these bound to the
 * vendored engine (U1 consolidation; the contract itself is unchanged).
 */
import type { EngineApi, YDoc } from '../engine-api.js';
import type { Awareness } from '../protocols/awareness.js';
import { bindIndexeddbProvider, type IndexeddbProvider } from './indexeddb.js';
import { assertRoomId } from './room.js';
import { bindWebsocketProvider, type WebsocketProviderEvents } from './websocket.js';

/**
 * Payload a sync factory receives — the v13 contract plus `failed` (D4):
 * the terminal half of the sync lifecycle. A provider that can never reach
 * `synced` (destroyed before syncing, persistence load failure, refused
 * hydration, denied auth) reports it here exactly once; a transient
 * disconnect or a provider that already synced never does. A
 * `SyncRefusedError` is the exception: the server refused this
 * client for good, reported synced or not, and an empty document does not
 * seed over it.
 */
export type EdytorSyncPayload = {
	doc: YDoc;
	awareness: Awareness;
	synced: (provider?: unknown) => void;
	failed?: (error: unknown, provider: unknown) => void;
	/**
	 * (Re)start this provider's readiness bound (`DEFAULT_READINESS_BOUND`
	 * ms from now) — for a factory whose `bound` is `Infinity` because only
	 * its transport knows when waiting starts to count (the websocket sync:
	 * from the socket's open, or its first failed dial). A no-op once the
	 * provider settled.
	 */
	armBound?: () => void;
	/**
	 * Stop this provider's readiness bound: an empty document waits for it
	 * to settle (or for the next `armBound()`), as the websocket sync does
	 * after expired credentials on a first visit.
	 */
	holdBound?: () => void;
	/**
	 * Attach another sync to the same document as its own provider (its own
	 * target, bound and settle): how a sync brings a companion, e.g. the
	 * websocket sync's local store. `document.attachSync` passes it.
	 */
	attach?: (sync: EdytorSync) => EdytorSyncCleanup | void;
};

export type EdytorSyncCleanup = () => void | Promise<void>;
export type EdytorSync = ((payload: EdytorSyncPayload) => void | EdytorSyncCleanup) & {
	/**
	 * ms an empty document waits for this provider to settle before it
	 * decides without it (R13); `Infinity` for a provider that always
	 * reports `synced` or `failed`, or arms its bound itself (`armBound`).
	 * Default: `DEFAULT_READINESS_BOUND`, counted from the attach.
	 */
	bound?: number;
	/**
	 * The transport target (database, server + room): a document keeps one
	 * provider per target, whatever factory instance attaches it (O75).
	 * Without it the factory itself is the target.
	 */
	target?: string;
};

export type IndexeddbSyncOptions = {
	awareness?: Awareness;
};

/**
 * The factory-owned provider always dials (D-24 G-e retired `connect`,
 * `protocols` and `resyncInterval` here). Cross-tab sync is on by default.
 */
/** Where the socket dials: `<server>/<room>`, the names `<Edytor server room>` uses. */
export type WebsocketTarget =
	| {
			/** The sync server's base URL (`wss://…/rooms`). */
			server: string;
			/** The room (document) id. */
			room: string;
	  }
	| {
			/** @deprecated Use `server`. */
			serverUrl: string;
			/** @deprecated Use `room`. */
			roomName: string;
	  };

export type WebsocketSyncOptions = WebsocketTarget & {
	/** Query parameters (auth tokens), read at every dial. */
	params?: Record<string, string>;
	WebSocketPolyfill?: import('./websocket.js').WebsocketPolyfill;
	maxBackoffTime?: number;
	/**
	 * ms a dial may take to open before it is closed like a failed one, which
	 * starts the readiness bound (default 10 000; `Infinity`: no limit).
	 */
	connectTimeout?: number;
	/**
	 * The room closed the socket with `4401` (expired credentials): put a
	 * fresh token in `params` before the redial, due in `nextRetryMs`.
	 */
	onExpired?: (state: Parameters<WebsocketProviderEvents['expired']>[0]) => void;
	/** Opt out of cross-tab sync over the BroadcastChannel (on by default). */
	disableBc?: boolean;
	/** Largest frame sent whole (default 32 MiB); larger ones are chunked (H6). */
	maxFrameBytes?: number;
	/**
	 * Keep a local copy in IndexedDB (default `true`; skipped where there is
	 * no `indexedDB`). Edits survive offline reloads and reach the server on
	 * reconnect.
	 */
	persist?: boolean;
	/** The local database name. Default: `edytor:<server>/<room>`. */
	persistName?: string;
};

/** A websocket sync; `persistName` names its local store (for `clearDocument`), unset without one. */
export type WebsocketSync = EdytorSync & { persistName?: string };

export type ProviderStack = ReturnType<typeof bindProviders>;

export const bindProviders = (Y: EngineApi) => {
	const idb = bindIndexeddbProvider(Y);
	const ws = bindWebsocketProvider(Y);

	// Local hydration always ends in `synced` or `failed`: no bound.
	const localSync = (name: string, options: { disableBc?: boolean } = {}): EdytorSync =>
		Object.assign(
			({ doc, awareness, synced, failed }: EdytorSyncPayload) => {
				const provider = new idb.IndexeddbPersistence(name, doc, { awareness, ...options });
				provider.on('synced', () => synced(provider));
				if (failed) provider.on('failed', failed);
				return () => provider.destroy();
			},
			{ bound: Infinity, target: `indexeddb:${name}` }
		);

	const createIndexeddbSync = (name: string): EdytorSync => localSync(name);

	/**
	 * The socket, and by default a local store beside it. The store is its
	 * own provider on the document (`attach`), so the document's readiness
	 * rules see two: stored content decides at once (offline start), and an
	 * empty store holds the seed until it answered, then the server's answer
	 * or the socket's bound decides. While the store exists it carries the
	 * cross-tab channel (the socket's BroadcastChannel leg is off): a tab
	 * applies another tab's edit under the store's origin and relays it to
	 * the server, without storing it twice. Restored edits reach the server
	 * by the join rule on every (re)connect.
	 *
	 * The socket's bound runs from transport state, not from the attach: a
	 * dial still in flight (a cold room holds the upgrade) never counts, so
	 * a slow room hydrates the document instead of racing the seed, up to
	 * `connectTimeout`. Expired credentials (`4401`) before the first sync
	 * hold the bound: the room may hold content, so an empty document waits
	 * for a dial that gets in.
	 */
	const createWebsocketSync = (options: WebsocketSyncOptions): WebsocketSync => {
		const [server, roomName] =
			'server' in options ? [options.server, options.room] : [options.serverUrl, options.roomName];
		assertRoomId(roomName);
		const serverUrl = server.replace(/\/+$/, '');
		const room = `${serverUrl}/${roomName}`;
		const persistName =
			options.persist === false ? undefined : (options.persistName ?? `edytor:${room}`);
		const sync = (payload: EdytorSyncPayload) => {
			const { doc, awareness, synced, failed, attach, armBound, holdBound } = payload;
			const {
				params,
				WebSocketPolyfill,
				maxBackoffTime,
				connectTimeout,
				disableBc,
				onExpired,
				maxFrameBytes
			} = options;
			const local =
				persistName !== undefined && typeof indexedDB !== 'undefined'
					? localSync(persistName, { disableBc })
					: undefined;
			const provider = new ws.WebsocketProvider(serverUrl, roomName, doc, {
				awareness,
				params,
				WebSocketPolyfill,
				maxBackoffTime,
				connectTimeout,
				disableBc: disableBc || local !== undefined,
				maxFrameBytes
			});
			if (onExpired) provider.on('expired', (state) => onExpired(state));
			provider.on('synced', (isSynced) => {
				if (isSynced) synced(provider);
			});
			if (failed) {
				provider.on('failed', failed);
				// `failed` fires only before a sync; a refusal is terminal after one too.
				provider.on('refused', (refusal) => provider.hasSynced && failed(refusal, provider));
			}
			if (armBound) {
				// The bound counts from the socket's open, or from the first
				// failed dial since the last open (offline starts decide as fast).
				// Expired credentials before the first sync hold it for good.
				let armedOffline = false;
				let held = false;
				const arm = () => held || armBound();
				provider.on('status', ({ status }) => {
					if (status !== 'connected') return;
					armedOffline = false;
					arm();
				});
				const armOffline = () => {
					if (armedOffline) return;
					armedOffline = true;
					arm();
				};
				provider.on('connection-close', armOffline);
				provider.on('connection-error', armOffline);
				provider.on('expired', () => {
					if (provider.hasSynced) return;
					held = true;
					holdBound?.();
				});
			}
			let release: EdytorSyncCleanup | void = undefined;
			try {
				// Called directly (no `attach`), the store only persists: readiness is the socket's.
				release = local && (attach ? attach(local) : local({ doc, awareness, synced: () => {} }));
			} catch (error) {
				provider.destroy();
				throw error;
			}
			return () => {
				provider.destroy();
				return release?.();
			};
		};
		return Object.assign(sync, { bound: Infinity, target: `websocket:${room}`, persistName });
	};

	return {
		IndexeddbPersistence: idb.IndexeddbPersistence,
		WebsocketProvider: ws.WebsocketProvider,
		storeState: idb.storeState,
		clearDocument: idb.clearDocument,
		PREFERRED_TRIM_SIZE: idb.PREFERRED_TRIM_SIZE,
		createIndexeddbSync,
		createWebsocketSync
	};
};

export type { IndexeddbProvider };
