import { Y } from '$lib/crdt/engine.js';
import {
	bindProviders,
	type Awareness,
	type EdytorSync,
	type EdytorSyncCleanup,
	type EdytorSyncPayload,
	type IndexeddbSyncOptions as CrdtIndexeddbSyncOptions,
	type ProviderStack,
	type WebsocketSyncOptions as CrdtWebsocketSyncOptions,
	type YDoc
} from '$lib/crdt/index.js';

const providers = bindProviders(Y);

export type { EdytorSync, EdytorSyncCleanup, EdytorSyncPayload, Awareness, YDoc };

export type IndexeddbSyncOptions = CrdtIndexeddbSyncOptions;

export type WebsocketSyncOptions = Omit<CrdtWebsocketSyncOptions, 'WebSocketPolyfill'> & {
	WebSocketPolyfill?: typeof WebSocket;
};

export const createIndexeddbSync =
	(name: string): EdytorSync =>
	({ doc, awareness, synced }) => {
		const provider = new providers.IndexeddbPersistence(name, doc, { awareness });
		provider.on('synced', () => synced(provider));
		return () => provider.destroy();
	};

export const createWebsocketSync =
	(options: WebsocketSyncOptions): EdytorSync =>
	({ doc, awareness, synced }) => {
		const provider = new providers.WebsocketProvider(options.serverUrl, options.roomName, doc, {
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

// `ProviderStack[...]` annotations keep the emitted `.d.ts` referencing the
// bound types through `../crdt/index.js` — without them the declaration
// emit materializes provider internals via extensionless deep paths
// (`../crdt/providers/indexeddb`), which `nodenext` consumers reject.
export const clearDocument: ProviderStack['clearDocument'] = providers.clearDocument;
export const storeState: ProviderStack['storeState'] = providers.storeState;
export const IndexeddbPersistence: ProviderStack['IndexeddbPersistence'] =
	providers.IndexeddbPersistence;
export const WebsocketProvider: ProviderStack['WebsocketProvider'] = providers.WebsocketProvider;
