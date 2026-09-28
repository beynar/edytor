/**
 * `edytor/cloudflare` — the Durable Object room for one edytor document
 * and the host Worker's authorizing router. Worker-only (imports
 * `cloudflare:workers`); built on the Worker-safe CRDT entry. README
 * "Server coordinator (Cloudflare Durable Object)".
 */
export {
	DocumentRoom,
	DEFAULT_COMPACT_AFTER,
	DEFAULT_MAX_ROW_BYTES,
	IDENTITY_HEADERS,
	noTimers,
	type Attachment,
	type DocumentRoomEnv,
	type Refusal,
	type SocketIdentity
} from './DocumentRoom.js';
export {
	routeDocumentSocket,
	requestedReplica,
	type AuthorizeDocumentSocket,
	type DocumentIdentity
} from './routeDocumentSocket.js';
