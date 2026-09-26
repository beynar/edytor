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
};

export type IndexeddbSyncOptions = {
	awareness?: Awareness;
};

export type WebsocketSyncOptions = {
	serverUrl: string;
	roomName: string;
	connect?: boolean;
	params?: Record<string, string>;
	protocols?: string[];
	WebSocketPolyfill?: import('./websocket.js').WebsocketPolyfill;
	resyncInterval?: number;
	maxBackoffTime?: number;
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
			{ bound: Infinity }
		);

	const createWebsocketSync =
		(options: WebsocketSyncOptions): EdytorSync =>
		({ doc, awareness, synced, failed }) => {
			const provider = new ws.WebsocketProvider(options.serverUrl, options.roomName, doc, {
				connect: options.connect,
				awareness,
				params: options.params,
				protocols: options.protocols,
				WebSocketPolyfill: options.WebSocketPolyfill,
				resyncInterval: options.resyncInterval,
				maxBackoffTime: options.maxBackoffTime,
				disableBc: options.disableBc
			});
			provider.on('sync', (isSynced: boolean) => {
				if (isSynced) {
					synced(provider);
				}
			});
			if (failed) provider.on('failed', failed);
			return () => provider.destroy();
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
