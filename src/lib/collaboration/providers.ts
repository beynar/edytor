/**
 * Compatibility shim — the provider sync factories now live in ONE place:
 * `bindProviders(Y)` in `src/lib/crdt/providers/index.ts` (U1 consolidation;
 * this module used to duplicate them). Re-exported here bound to the
 * vendored engine so the documented consumer path
 * (`import { createIndexeddbSync } from 'edytor'`) keeps working.
 */
import { Y } from '$lib/crdt/engine.js';
import { bindProviders } from '$lib/crdt/providers/index.js';
import {
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

export const createIndexeddbSync: (name: string) => EdytorSync = providers.createIndexeddbSync;

export const createWebsocketSync = providers.createWebsocketSync as (
	options: WebsocketSyncOptions
) => EdytorSync;

// `ProviderStack[...]` annotations keep the emitted `.d.ts` referencing the
// bound types through `../crdt/index.js` — without them the declaration
// emit materializes provider internals via extensionless deep paths
// (`../crdt/providers/indexeddb`), which `nodenext` consumers reject.
export const clearDocument: ProviderStack['clearDocument'] = providers.clearDocument;
export const storeState: ProviderStack['storeState'] = providers.storeState;
export const IndexeddbPersistence: ProviderStack['IndexeddbPersistence'] =
	providers.IndexeddbPersistence;
export const WebsocketProvider: ProviderStack['WebsocketProvider'] = providers.WebsocketProvider;
