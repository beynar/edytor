/**
 * Provider stack for the vendored v14 engine — bound entry point.
 *
 * `bindProviders(Y)` produces the whole provider surface for one engine
 * instance: the provider classes plus `EdytorSync`-shaped factories matching
 * the existing `{ doc, awareness, synced }` contract that
 * `src/lib/collaboration/providers.ts` consumes (U08 retargets its imports
 * here; the contract itself is unchanged).
 */
import type { EngineApi, YDoc } from '../engine-api.js';
import type { Awareness } from '../protocols/awareness.js';
import { bindIndexeddbProvider, type IndexeddbProvider } from './indexeddb.js';
import { bindWebsocketProvider } from './websocket.js';

/** Payload a sync factory receives — identical to the v13 contract. */
export type EdytorSyncPayload = {
	doc: YDoc;
	awareness: Awareness;
	synced: (provider?: unknown) => void;
};

export type EdytorSyncCleanup = () => void | Promise<void>;
export type EdytorSync = (payload: EdytorSyncPayload) => void | EdytorSyncCleanup;

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

	const createIndexeddbSync =
		(name: string): EdytorSync =>
		({ doc, awareness, synced }) => {
			const provider = new idb.IndexeddbPersistence(name, doc, { awareness });
			provider.on('synced', () => synced(provider));
			return () => provider.destroy();
		};

	const createWebsocketSync =
		(options: WebsocketSyncOptions): EdytorSync =>
		({ doc, awareness, synced }) => {
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
			return () => provider.destroy();
		};

	return {
		IndexeddbPersistence: idb.IndexeddbPersistence,
		WebsocketProvider: ws.WebsocketProvider,
		fetchUpdates: idb.fetchUpdates,
		storeState: idb.storeState,
		clearDocument: idb.clearDocument,
		PREFERRED_TRIM_SIZE: idb.PREFERRED_TRIM_SIZE,
		createIndexeddbSync,
		createWebsocketSync
	};
};

export type { IndexeddbProvider };
