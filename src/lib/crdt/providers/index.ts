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
import { bindWebsocketProvider } from './websocket.js';

/**
 * Payload a sync factory receives — the v13 contract plus `failed` (D4):
 * the terminal half of the sync lifecycle. A provider that can never reach
 * `synced` (destroyed before syncing, persistence load failure, refused
 * hydration, denied auth) reports it here exactly once; a transient
 * disconnect or a provider that already synced never does.
 */
export type EdytorSyncPayload = {
	doc: YDoc;
	awareness: Awareness;
	synced: (provider?: unknown) => void;
	failed?: (error: unknown, provider: unknown) => void;
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
	 * reports `synced` or `failed`. Default: `DEFAULT_READINESS_BOUND`.
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
export type WebsocketSyncOptions = {
	serverUrl: string;
	roomName: string;
	/** Query parameters (auth tokens), read at every dial. */
	params?: Record<string, string>;
	WebSocketPolyfill?: import('./websocket.js').WebsocketPolyfill;
	maxBackoffTime?: number;
	/** Opt out of cross-tab sync over the BroadcastChannel (on by default). */
	disableBc?: boolean;
	/**
	 * Keep a local copy in IndexedDB (default `true`; skipped where there is
	 * no `indexedDB`). Edits survive offline reloads and reach the server on
	 * reconnect.
	 */
	persist?: boolean;
	/** The local database name. Default: `edytor:<serverUrl>/<roomName>`. */
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
	 */
	const createWebsocketSync = (options: WebsocketSyncOptions): WebsocketSync => {
		const serverUrl = options.serverUrl.replace(/\/+$/, '');
		const room = `${serverUrl}/${options.roomName}`;
		const persistName =
			options.persist === false ? undefined : (options.persistName ?? `edytor:${room}`);
		const sync = (payload: EdytorSyncPayload) => {
			const { doc, awareness, synced, failed, attach } = payload;
			const { params, WebSocketPolyfill, maxBackoffTime, disableBc } = options;
			const local =
				persistName !== undefined && typeof indexedDB !== 'undefined'
					? localSync(persistName, { disableBc })
					: undefined;
			const provider = new ws.WebsocketProvider(serverUrl, options.roomName, doc, {
				awareness,
				params,
				WebSocketPolyfill,
				maxBackoffTime,
				disableBc: disableBc || local !== undefined
			});
			provider.on('synced', (isSynced) => {
				if (isSynced) synced(provider);
			});
			if (failed) provider.on('failed', failed);
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
		return Object.assign(sync, { target: `websocket:${room}`, persistName });
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
