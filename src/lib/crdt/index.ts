/**
 * Edytor CRDT layer (v14) — the bound public surface.
 *
 * In the packed package this file backs the `edytor/crdt/edytor` subpath
 * (the node/SSR-safe bindings entry); the package root `edytor` re-exports
 * it whole, so everything here also reaches Svelte consumers.
 *
 * THE HEADLINE is the integrated document — `createDocument`,
 * `loadDocument` and `attachDocument` produce an {@link EdytorDocument}
 * bound once to the vendored engine, no engine wiring needed:
 *
 * ```ts
 * import { createDocument } from 'edytor/crdt/edytor'; // or 'edytor'
 * const document = createDocument({ value: { children: [] } });
 * document.facade.insertText(blockId, 0, 'hello');
 * document.history.undo();
 * const saved = document.encode();
 * ```
 *
 * Everything else falls into deliberate tiers:
 *
 * - **Document vocabulary** — the types `document.facade` ops speak
 *   (`BlockSpec`, `Destination`, `ProjectedDoc`, `DocChange`, `JSONDoc`,
 *   …), the provider/sync contract (`EdytorSync`, `ProviderStack`),
 *   `Awareness`, the admission-gate vocabulary (`assertAdmission` —
 *   the ONE boundary every content-entry path crosses), the attribution
 *   read surface (`DocumentAttribution`), and migration.
 * - **Composition** — `bindCrdt(Y)` for consumers that inject the engine
 *   themselves (node/SSR-side provider stacks, migration tooling,
 *   alternate engine instances) plus the engine typings that contract
 *   needs.
 * - **Server coordinator** — the wire surface a Worker-side coordinator
 *   (a Cloudflare Durable Object) needs beside `bindCrdt(Y)`: the frame
 *   contract, message types, the lib0 read/write helpers for frame bodies
 *   and the instance-free awareness codec. Nothing else is exported: the
 *   `bind*` building blocks, rank/run/placement plumbing and storage
 *   constants are internal (0.0.x API retirement, D-15).
 *
 * The raw engine itself is only reachable through
 * `import * as Y from 'edytor/crdt'` — this module never re-exports it,
 * which keeps exactly one engine instance in any consumer graph.
 *
 * Semantics are specified in `docs/crdt-v14-move-adr.md`; the document
 * lifecycle/readiness contract lives in `crdt/document.ts`, the admission
 * boundary in `crdt/admission.ts`.
 */

// ── 1 · The document ───────────────────────────────────────────────────
//
// The integrated document API — the surface this package wants consumers
// to reach for first. `EdytorDocument` owns (or borrows) one engine doc
// and composes the shared facade, one awareness, the local actor, the
// document-level semantic configuration, attribution capture and the
// default local history. Used headlessly or shared by any number of
// `<Edytor {document}>` views.

export {
	EdytorDocument,
	createDocument,
	loadDocument,
	attachDocument,
	SemanticConflictError,
	DocumentNotReadyError,
	DocumentDestroyedError,
	DEFAULT_READINESS_BOUND,
	type DocumentActor,
	type DocumentOptions,
	type DocumentReadiness,
	type DocumentSemanticsConfig,
	type CreateDocumentOptions,
	type LoadDocumentOptions
} from './document.js';

// The bundled plugins' block roles (void/island, `rendersContent`,
// `defaultChild`) for documents no view configures: the room adopts
// `defaultSemantics`; a headless `createDocument` takes it explicitly
// (`semantics: defaultSemantics`) — a silent default would conflict with
// views that redefine those kinds.
export { defaultSemantics, richTextSemantics, codeSemantics, imageSemantics } from './semantics.js';

// The canonical document JSON — `createDocument({value})`,
// `<Edytor {value}>`, `facade.toJSON()` and `facade.init({content})` all
// speak these shapes; consumers must be able to name them, so they are
// part of the document surface, not a deep import.
export type {
	JSONDoc,
	JSONBlock,
	JSONText,
	JSONInlineBlock,
	SerializableContent
} from '../utils/json.js';
/** Canonical JSON → the `BlockSpec` `facade.insertBlock` takes (ids kept or minted). */
export { toBlockSpec } from '../utils/json.js';

// ── 2 · The document's vocabulary ──────────────────────────────────────
//
// Types a consumer meets while driving `document.facade` (the ONLY
// structural read/write surface) — block specs, destinations, projected
// trees, change notifications — plus the engine-object types the
// document's own members are typed as (`document.doc: YDoc`,
// `document.history: YUndoManager`).

export {
	type EdytorDoc,
	type OpResult,
	type Plan,
	type Prepared,
	type DocChange,
	type BlockRole,
	type OrderPolicy,
	type DocAnchor,
	type AnchorAffinity
} from './edytor-doc.js';
export { type DocPosition } from './rangeDelete.js';

export {
	type BlockId,
	type Destination,
	type ContentItem,
	type BlockSpec,
	type InlineSpec,
	type ProjectedBlock,
	type ProjectedDoc
} from './placement/model.js';

export { type DocBlock } from './nodes.js';

// `ContentRun` — the maintained-runs item the view layer's delta
// serialization speaks (`text/deltas.ts`). Part of the public
// model→render vocabulary.
export { type ContentRun } from './text/runs.js';

export type { YDoc, YUndoManager, YTransaction } from './engine-api.js';

// ── 3 · Sync, providers, awareness ─────────────────────────────────────
//
// The provider contract: `EdytorSync` factories (what `<Edytor {sync}>`
// and `document.attachSync` consume), the bound provider stack, and the
// option/event types of the two shipped providers. `Awareness` is
// engine-free — one shared instance per document, every view and
// provider publishes presence through it.

export {
	type EdytorSync,
	type EdytorSyncPayload,
	type EdytorSyncCleanup,
	type IndexeddbSyncOptions,
	type WebsocketSync,
	type WebsocketSyncOptions,
	type ProviderStack
} from './providers/index.js';

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

export { SyncRefusedError } from './providers/room.js';

export {
	Awareness,
	type AwarenessDoc,
	type AwarenessStates,
	type AwarenessUpdate,
	type MetaClientState
} from './protocols/awareness.js';

// ── 4 · The admission boundary ─────────────────────────────────────────
//
// One gate vocabulary for every content-entry path — the document layer
// (create/load/attach/sync) and the transport layer (provider staging)
// run the same ordered reads. `admission.ts` is the shared doorway; see
// its header for the admission matrix and the refusal-preserves-data
// contract. Public because diagnostics/migration tooling legitimately
// inspect verdicts; `assertAdmission`/`inspectAdmission` are the entry
// points, the rest are the vocabulary their results speak.

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

// ── 5 · Attribution (read surface) ─────────────────────────────────────
//
// `document.attribution` hands back a `DocumentAttribution` — compact
// per-block records (U1), the replicated actor dictionary, and `legacy()`
// over pre-existing per-edit records. The types are the public read
// vocabulary; ordinary editing writes no per-edit attribution (U2).

export {
	type DocumentAttribution,
	type AttributionActor,
	type ActorProfile,
	type AttributionController
} from './attribution/index.js';

// U1 — compact per-BLOCK attribution read vocabulary (`b/<blockId>`
// records + the block-node `l` attr — see `attribution/block.ts`).
// `document.attribution.block(id)` / `facade.blockAttribution(id)` /
// `DocBlock.attribution` are the read entry points.
export { type ActorId, type BlockAttribution } from './attribution/index.js';

// ── 6 · Migration ──────────────────────────────────────────────────────
//
// v13 → v14 one-way import: `isLegacyDoc` detects a v13-era layout, the
// `Migration` surface (via `bindCrdt(Y).migration` or `bindMigration`)
// rebuilds an admitted document whose `MigrateResult.update` restores
// through `loadDocument`. Runbook: `docs/crdt-v14-migration.md`.

export { isLegacyDoc } from './migration/legacy-schema.js';

export {
	type Migration,
	type MigrationStatus,
	type MigrationRecord,
	type MigrationPhase,
	type MigrateResult,
	type MigrateOptions
} from './migration/migrate.js';

// ── 7 · Composition — injecting the engine ─────────────────────────────
//
// `bindCrdt(Y)` is the supported one-shot entry for consumers that take
// the engine themselves (the documented node/SSR path):
//
// ```ts
// import * as Y from 'edytor/crdt';        // vendored v14 engine
// import { bindCrdt } from 'edytor/crdt/edytor';
// const crdt = bindCrdt(Y);
// const doc = crdt.createDoc();
// const provider = new crdt.providers.IndexeddbPersistence('my-doc', doc);
// ```
//
// Everything `bindCrdt` composes is also available pre-bound through the
// document factories above — reach for `bindCrdt` when the caller needs
// the raw provider/migration/sync stacks on a doc it owns, not for
// ordinary document work. `EngineApi`/`EngineDoc`/`YDoc` and friends are
// the typings that injection contract speaks.

import type { EngineApi, YDoc } from './engine-api.js';
import { Awareness as _Awareness } from './protocols/awareness.js';
import { bindAdmission } from './admission.js';
import { bindAttribution } from './attribution/index.js';
import { bindEdytorDoc } from './edytor-doc.js';
import { bindProviders } from './providers/index.js';
import { bindMigration } from './migration/migrate.js';
import { bindSync } from './protocols/sync.js';

export const bindCrdt = (Y: EngineApi) => {
	const doc = bindEdytorDoc(Y);
	return {
		/** Create a v14 document — `new Y.Doc(opts)` on the bound engine. */
		createDoc: (opts?: ConstructorParameters<EngineApi['Doc']>[0]): YDoc => new Y.Doc(opts),
		/** Engine-free — same class for every engine instance. */
		Awareness: _Awareness,
		doc,
		providers: bindProviders(Y),
		migration: bindMigration(Y),
		sync: bindSync(Y),
		/** U8 — the document-admission boundary (`admitUpdate` staged restore + the shared gate vocabulary). */
		admission: bindAdmission(Y),
		/** Bind the attribution service to this engine — actor dictionary + legacy `a/` reads + block attribution (documents attach it automatically). */
		attribution: bindAttribution(Y)
	};
};

export type Crdt = ReturnType<typeof bindCrdt>;

export type {
	EngineApi,
	EngineDoc,
	EngineNode,
	EngineDeepEvent,
	EngineTransaction,
	EngineItemRef,
	YNode,
	YItem
} from './engine-api.js';

// ── 8 · Server coordinator surface (Worker-safe) ────────────────────────
//
// What a server coordinator (`edytor/cloudflare`'s `DocumentRoom` — README
// "Server coordinator") imports beside `bindCrdt(Y)` (`.sync` readers/writers and
// `applyRemote`, `.admission`, `.doc`, `.createDoc`): the frame contract
// `varuint GENERATION | varuint messageType | payload`, the message types,
// the lib0 helpers that read and write frame bodies, and the awareness
// codec that needs no `Awareness` instance (whose sweep timer blocks
// hibernation), the store-before-ack frame (`messageSaved`) and the bounded
// catch-up codec (`chunkFrame`/`createChunkReader`, `messageChunk`).
// `pnpm check:worker` keeps this graph Worker-safe.

export { SCHEMA_VERSION, META_KEY, EdytorDocDisposedError } from './edytor-doc.js';

export {
	GENERATION,
	generationWord,
	frame,
	PROTOCOL_VERSION,
	GENERATION_RECORD,
	GenerationMismatchError,
	readProtocolVersion,
	type GenerationRecord
} from './protocols/envelope.js';

export {
	messageSync,
	messageAwareness,
	messageAuth,
	messageQueryAwareness,
	messageSaved,
	messageChunk,
	MAX_FRAME_BYTES,
	chunkFrame,
	createChunkReader
} from './providers/room.js';

export {
	messageYjsSyncStep1,
	messageYjsSyncStep2,
	messageYjsUpdate,
	type SyncProtocol
} from './protocols/sync.js';

export { messagePermissionDenied, writePermissionDenied } from './protocols/auth.js';

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
