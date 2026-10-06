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
	DEFAULT_MAX_UPDATES_PER_SECOND,
	MAX_REFUSALS,
	MAX_WAITING_DELETES,
	ROOM_ORIGIN,
	IDENTITY_HEADERS,
	noTimers,
	type Attachment,
	type DocumentRoomEnv,
	type LoadedDocument,
	type Refusal,
	type ReplicaOwner,
	type SavedDocument,
	type SocketIdentity,
	type StoredRecord
} from './DocumentRoom.js';
export {
	routeDocumentSocket,
	requestedReplica,
	type AuthorizeDocumentSocket,
	type ExpiredCredential,
	type DocumentNamespace,
	type DocumentIdentity
} from './routeDocumentSocket.js';
