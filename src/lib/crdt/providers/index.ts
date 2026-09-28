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
};

export type ProviderStack = ReturnType<typeof bindProviders>;

export const bindProviders = (Y: EngineApi) => {
	const idb = bindIndexeddbProvider(Y);
	const ws = bindWebsocketProvider(Y);

	// Local hydration always ends in `synced` or `failed`: no bound.
	const createIndexeddbSync = (name: string): EdytorSync =>
		Object.assign(
			({ doc, awareness, synced, failed }: EdytorSyncPayload) => {
				const provider = new idb.IndexeddbPersistence(name, doc, { awareness });
				provider.on('synced', () => synced(provider));
				if (failed) provider.on('failed', failed);
				return () => provider.destroy();
			},
			{ bound: Infinity, target: `indexeddb:${name}` }
		);

	const createWebsocketSync = (options: WebsocketSyncOptions): EdytorSync =>
		Object.assign(
			({ doc, awareness, synced, failed }: EdytorSyncPayload) => {
				const { serverUrl, roomName, params, WebSocketPolyfill, maxBackoffTime, disableBc } =
					options;
				const provider = new ws.WebsocketProvider(serverUrl, roomName, doc, {
					awareness,
					params,
					WebSocketPolyfill,
					maxBackoffTime,
					disableBc
				});
				provider.on('synced', (isSynced) => {
					if (isSynced) synced(provider);
				});
				if (failed) provider.on('failed', failed);
				return () => provider.destroy();
			},
			{ target: `websocket:${options.serverUrl.replace(/\/+$/, '')}/${options.roomName}` }
		);

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
