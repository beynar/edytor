/**
 * The sync factories of the package root (`import { createIndexeddbSync }
 * from 'edytor'`): the provider stack bound once to the vendored engine
 * (`crdt/providers/bound.ts`, shared with `edytor/protocol`'s raw provider
 * classes). The factories themselves live in ONE place, `bindProviders(Y)`
 * in `src/lib/crdt/providers/index.ts`.
 */
import { providers } from '$lib/crdt/providers/bound.js';
import {
	type Awareness,
	type EdytorSync,
	type EdytorSyncCleanup,
	type EdytorSyncPayload,
	type IndexeddbSyncOptions as CrdtIndexeddbSyncOptions,
	type ProviderStack,
	type WebsocketSync,
	type WebsocketSyncOptions as CrdtWebsocketSyncOptions,
	type YDoc
} from '$lib/crdt/index.js';

export type { EdytorSync, EdytorSyncCleanup, EdytorSyncPayload, WebsocketSync, Awareness, YDoc };

export type IndexeddbSyncOptions = CrdtIndexeddbSyncOptions;

// Distributive: the options are a union over the `{server, room}` / deprecated `{serverUrl, roomName}` names.
type WithoutPolyfill<O> = O extends unknown ? Omit<O, 'WebSocketPolyfill'> : never;
export type WebsocketSyncOptions = WithoutPolyfill<CrdtWebsocketSyncOptions> & {
	WebSocketPolyfill?: typeof WebSocket;
};

export const createIndexeddbSync: (name: string) => EdytorSync = providers.createIndexeddbSync;

export const createWebsocketSync = providers.createWebsocketSync as (
	options: WebsocketSyncOptions
) => WebsocketSync;

// `ProviderStack[...]` annotations keep the emitted `.d.ts` referencing the
// bound types through `../crdt/index.js` — without them the declaration
// emit materializes provider internals via extensionless deep paths
// (`../crdt/providers/indexeddb`), which `nodenext` consumers reject.
export const clearDocument: ProviderStack['clearDocument'] = providers.clearDocument;
/** Keep a document's local copy fresh without opening it (sync once, then close). */
export const prefetch: ProviderStack['prefetch'] = providers.prefetch;
/** When a room last stored a change: one authorized HTTP request, no document opened. */
export const lastUpdated: ProviderStack['lastUpdated'] = providers.lastUpdated;
/** A room's document as JSON (one authorized HTTP request), for `<Edytor snapshot>`. */
export const documentSnapshot: ProviderStack['documentSnapshot'] = providers.documentSnapshot;
