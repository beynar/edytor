/**
 * `edytor/protocol` — the wire and coordinator vocabulary (Worker-safe).
 *
 * What a server coordinator (`edytor/cloudflare`'s `DocumentRoom`, or one
 * of your own) and transport tooling need beside the document API, kept
 * out of the application entries (`edytor`, `edytor/crdt/edytor`):
 *
 * - `bindCrdt(Y)` — `.sync` readers/writers and `applyRemote`,
 *   `.admission`, `.doc`, `.createDoc` on an engine you pass in;
 * - the frame contract `varuint GENERATION | varuint messageType |
 *   payload`, the generation records and the message types, the
 *   store-before-ack frame (`messageSaved`), the bounded catch-up codec
 *   (`chunkFrame`/`createChunkReader`, `messageChunk`) and the comment
 *   messages (`messageComments`);
 * - the lib0 helpers that read and write frame bodies, and the awareness
 *   codec that needs no `Awareness` instance (whose sweep timer blocks
 *   hibernation);
 * - the admission gates (`assertAdmission`, `inspectAdmission`, …) that
 *   diagnostics and migration tooling read;
 * - the raw provider classes behind `createIndexeddbSync` and
 *   `createWebsocketSync` (`IndexeddbPersistence`, `WebsocketProvider`)
 *   and `storeState`.
 *
 * `pnpm check:worker` keeps this graph Worker-safe; the site's
 * `server/protocol` page documents the contract.
 */

// ── Composition — injecting the engine ─────────────────────────────────
export {
	bindCrdt,
	type Crdt,
	type EngineApi,
	type EngineDoc,
	type EngineNode,
	type EngineDeepEvent,
	type EngineTransaction,
	type EngineItemRef,
	type YNode,
	type YItem,
	type YDoc,
	type YUndoManager,
	type YTransaction
} from './index.js';

// ── The frame contract and the generation ──────────────────────────────
export { SCHEMA_VERSION, META_KEY } from './edytor-doc.js';

export {
	GENERATION,
	generationWord,
	frame,
	PROTOCOL_VERSION,
	GENERATION_RECORD,
	STORED_GENERATION_RECORD,
	STORAGE_FORMAT,
	GenerationMismatchError,
	readProtocolVersion,
	type GenerationRecord,
	type StorageFormat
} from './protocols/envelope.js';
export { PREVIOUS_SCHEMA, isPreviousGenerationRecord } from './migration/generation.js';

// ── Message types, acknowledgements and chunks ─────────────────────────
export {
	messageSync,
	messageAwareness,
	messageAuth,
	messageQueryAwareness,
	messageSaved,
	messageChunk,
	messageComments,
	MAX_FRAME_BYTES,
	chunkFrame,
	createChunkReader,
	ChunkLimitError,
	type ChunkReader,
	CLOSE
} from './providers/room.js';

export {
	messageYjsSyncStep1,
	messageYjsSyncStep2,
	messageYjsUpdate,
	type SyncProtocol
} from './protocols/sync.js';

export {
	messagePermissionDenied,
	messageReadOnly,
	writePermissionDenied,
	writeReadOnly
} from './protocols/auth.js';

export {
	commentsSubscribe,
	commentsSnapshot,
	commentsChange,
	writeCommentsSubscribe,
	writeCommentsSnapshot,
	writeCommentsChange,
	readCommentsMessage,
	type CommentChange,
	type CommentMessage,
	type CommentSnapshot,
	type CommentThread,
	type ThreadComment
} from './protocols/comments.js';

export {
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	modifyAwarenessUpdate,
	readAwarenessEntries,
	writeAwarenessEntries,
	type AwarenessEntry
} from './protocols/awareness.js';

// Minimal wire codec for frame bodies (lib0 — the codec the frames are
// written with): read the header/subtype/payload, write a payload into a
// `frame` callback's encoder.
export { createDecoder, readVarUint, readVarUint8Array, type Decoder } from 'lib0-v14/decoding';
export { writeVarUint8Array, type Encoder } from 'lib0-v14/encoding';

// ── The admission gates ────────────────────────────────────────────────
//
// One gate vocabulary for every content-entry path (`admission.ts` has
// the matrix and the refusal-preserves-data contract). The errors they
// throw are also exported from `edytor` and `edytor/crdt/edytor`, where a
// `loadDocument` caller catches them.
export {
	assertAdmission,
	assertSchema,
	assertUsableDoc,
	checkSchema,
	inspectAdmission,
	isInitialized,
	registryEmpty,
	schemaVersion,
	SchemaMismatchError,
	UndecodableUpdateError,
	UnsupportedDocError,
	type AdmissionResult,
	type AdmissionVerdict,
	type SchemaProblem
} from './admission.js';

// ── Raw providers ──────────────────────────────────────────────────────
//
// The classes `createIndexeddbSync`/`createWebsocketSync` construct, bound
// to the vendored engine (the same classes as `bindCrdt(Y).providers` on
// the full namespace). Applications pass a sync factory to `<Edytor>` or
// `document.attachSync`; these are for tooling that drives a provider on
// a doc it owns.
import { providers } from './providers/bound.js';
import type { ProviderStack } from './providers/index.js';

export const IndexeddbPersistence: ProviderStack['IndexeddbPersistence'] =
	providers.IndexeddbPersistence;
export const WebsocketProvider: ProviderStack['WebsocketProvider'] = providers.WebsocketProvider;
/** Compact an `IndexeddbPersistence`'s store into one snapshot now (it settles once stored). */
export const storeState: ProviderStack['storeState'] = providers.storeState;

export type { ProviderStack } from './providers/index.js';
export {
	type IndexeddbPersistenceApi,
	type IndexeddbPersistenceOptions,
	type ProtocolMismatch,
	type SchemaMismatchDetail
} from './providers/indexeddb.js';
export {
	type WebsocketProviderOptions,
	type WebsocketProviderEvents,
	type WebsocketPolyfill
} from './providers/websocket.js';
