export {
	freshestPublishedSelection,
	publishPresence,
	PresenceWriter,
	type PresenceOptions,
	type PresenceShare,
	type EdytorAwarenessSelection,
	type EdytorAwarenessState,
	type EdytorAwarenessUser,
	type EdytorAwarenessViewSelection
} from './awarenessSelection.js';
export { whenDocumentReady } from './documentSync.js';
export {
	createIndexeddbSync,
	createWebsocketSync,
	clearDocument,
	IndexeddbPersistence,
	storeState,
	WebsocketProvider,
	type EdytorSync,
	type EdytorSyncCleanup,
	type EdytorSyncPayload,
	type IndexeddbSyncOptions,
	type WebsocketSync,
	type WebsocketSyncOptions
} from './providers.js';
