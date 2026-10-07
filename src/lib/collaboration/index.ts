export {
	freshestPublishedSelection,
	publishPresence,
	PresenceWriter,
	DEFAULT_PRESENCE_THROTTLE,
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
	prefetch,
	lastUpdated,
	documentSnapshot,
	type EdytorSync,
	type EdytorSyncCleanup,
	type EdytorSyncPayload,
	type IndexeddbSyncOptions,
	type WebsocketSync,
	type WebsocketSyncOptions
} from './providers.js';
