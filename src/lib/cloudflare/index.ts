/**
 * `edytor/cloudflare` — the Durable Object room for one edytor document
 * and the host Worker's authorizing router. Worker-only (imports
 * `cloudflare:workers`); built on the Worker-safe CRDT entry. Documented in
 * the site's `server/` section (room, authorization, extending, protocol).
 */
export {
	DocumentRoom,
	AttachedDocument,
	attachDocument,
	SOCKET_TAG,
	closedSocket,
	type AttachDocumentOptions,
	DEFAULT_COMPACT_AFTER,
	DEFAULT_MAX_ROW_BYTES,
	DEFAULT_SAVE_AFTER,
	DEFAULT_MAX_DOCUMENT_BYTES,
	DEFAULT_MAX_INBOUND_FRAME_BYTES,
	DEFAULT_MAX_BUFFERED_BYTES,
	DEFAULT_MAX_UPDATES_PER_SECOND,
	MAX_REFUSALS,
	MAX_WAITING_DELETES,
	ROOM_ORIGIN,
	RESTORE_ORIGIN,
	PURGE_ORIGIN,
	IDENTITY_HEADERS,
	PROBE_HEADER,
	noTimers,
	type Attachment,
	type DocumentRoomEnv,
	type LoadedDocument,
	type Refusal,
	type ReplicaOwner,
	type SavedDocument,
	type SocketIdentity,
	type StoredRecord,
	type FrameValidation,
	type ValidatedBlock,
	type RoomMetrics,
	type RoomLogEntry,
	type RestoreResult,
	type Timing
} from './DocumentRoom.js';
export {
	DEFAULT_RETENTION_DAYS,
	HISTORY_MAX_VALUE_BYTES,
	R2_HISTORY_MAX_VALUE_BYTES,
	ROOM_HISTORY_MAX_BYTES,
	ROOM_HISTORY_MAX_VALUE_BYTES,
	kvHistory,
	r2History,
	roomHistory,
	type HistoryEntry,
	type HistoryMetadata,
	type HistoryOptions,
	type HistoryRoomStorage,
	type HistoryStore,
	type HistoryStoreFactory,
	type HistoryStoreRecord,
	type KVLike,
	type R2BucketLike
} from './history.js';
export { type PurgeReport } from '../crdt/purge.js';
export { lockedBlocks, type LockOptions } from './locks.js';
export {
	moveBlocks,
	forwardLateEdits,
	DEFAULT_MOVE_GRACE_DAYS,
	type CommitResult,
	type ExportedBlocks,
	type ImportReceipt,
	type ImportRequest,
	type LateEdit,
	type LateEditBatch,
	type MoveDestination,
	type MovedState,
	type MoveNamespace,
	type MoveRoom
} from './move.js';
export {
	routeDocumentSocket,
	routeDocumentHistory,
	requestedReplica,
	type AuthorizeDocumentSocket,
	type ExpiredCredential,
	type DocumentNamespace,
	type DocumentIdentity
} from './routeDocumentSocket.js';
