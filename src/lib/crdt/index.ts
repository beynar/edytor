/**
 * Edytor CRDT layer (v14) — public internal entry point.
 *
 * - `placement/rank.ts` — Logoot-style rank keys (pure functions).
 * - `placement/model.ts` — `bindModel(Y)`: registry + placement records +
 *   deterministic acyclic projection + all document ops. Inject the vendored
 *   v14 module; see `engine-api.ts` for why nothing here imports vendor JS.
 *
 * Semantics are specified in `docs/crdt-v14-move-adr.md`.
 */
export {
	RANK_VMIN,
	RANK_VMAX,
	RankSpaceExhausted,
	decodeRank,
	encodeRank,
	compareRank,
	rankBetween,
	initialRank,
	type RankSeg
} from './placement/rank.js';

export {
	bindModel,
	REGISTRY_KEY,
	type PlacementModel,
	type PlacementValue,
	type PlacementCand,
	type ResolvedPlacement,
	type BlockId,
	type Destination,
	type ContentItem,
	type BlockSpec,
	type InlineSpec,
	type ProjectedBlock,
	type ProjectedDoc
} from './placement/model.js';

export {
	bindRuns,
	decorateRuns,
	type RunsApi,
	type RunView,
	type RunViewDebug,
	type ContentRun,
	type LocalDecoration,
	type DecoratedRun
} from './text/runs.js';

export {
	bindEdytorDoc,
	SCHEMA,
	SCHEMA_VERSION,
	SCHEMA_NAME,
	META_KEY,
	BOOTSTRAP_BLOCK_ID,
	assertUsableDoc,
	UnsupportedDocError,
	type EdytorDoc,
	type EdytorDocBinding,
	type EdytorDocConfig,
	type DocChange,
	type BlockRole,
	type DocAnchor,
	type AnchorAffinity
} from './edytor-doc.js';

export type {
	EngineApi,
	EngineDoc,
	EngineNode,
	EngineDeepEvent,
	EngineItemRef,
	YDoc,
	YNode,
	YUndoManager,
	YTransaction,
	YItem
} from './engine-api.js';

// ── U07: providers, protocols, migration ────────────────────────────────
//
// The vendored v14 engine is always injected (`bind*(Y)`); `src/lib` never
// runtime-imports it. For package consumers the engine is
// `import * as Y from 'edytor/crdt'` — the supported public engine path
// (U01) — tests import the vendored source directly. `bindCrdt` is the
// one-shot entry: doc creation, awareness, providers, migration.

export { bindSync, type SyncProtocol } from './protocols/sync.js';

export {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	modifyAwarenessUpdate,
	removeAwarenessStates,
	outdatedTimeout,
	type AwarenessDoc,
	type AwarenessStates,
	type AwarenessUpdate,
	type MetaClientState
} from './protocols/awareness.js';

export {
	messagePermissionDenied,
	writePermissionDenied,
	readAuthMessage,
	type PermissionDeniedHandler
} from './protocols/auth.js';

export {
	PROTOCOL_VERSION,
	GENERATION_PREFIX,
	generationDbName,
	GENERATION_KEY,
	GENERATION_RECORD,
	GenerationMismatchError,
	writeProtocolVersion,
	readProtocolVersion,
	type GenerationRecord
} from './protocols/envelope.js';

export {
	bindIndexeddbProvider,
	PREFERRED_TRIM_SIZE,
	type IndexeddbProvider,
	type IndexeddbPersistenceApi,
	type IndexeddbPersistenceOptions,
	type ProtocolMismatch,
	type SchemaMismatchDetail
} from './providers/indexeddb.js';

export {
	bindWebsocketProvider,
	messageSync,
	messageAwareness,
	messageAuth,
	messageQueryAwareness,
	type WebsocketProviderApi,
	type WebsocketProviderOptions,
	type WebsocketProviderEvents,
	type WebsocketPolyfill
} from './providers/websocket.js';

export {
	bindProviders,
	type ProviderStack,
	type EdytorSync,
	type EdytorSyncPayload,
	type EdytorSyncCleanup,
	type IndexeddbSyncOptions,
	type WebsocketSyncOptions
} from './providers/index.js';

export {
	bindLegacyReader,
	isLegacyDoc,
	LEGACY_ROOT_KEY,
	LEGACY_INITIALIZED_KEY
} from './migration/legacy-schema.js';

export {
	bindMigration,
	migrationBcRoom,
	type Migration,
	type MigrationStatus,
	type MigrationRecord,
	type MigrationPhase,
	type MigrateResult,
	type MigrateOptions
} from './migration/migrate.js';

import type { EngineApi, YDoc } from './engine-api.js';
import { Awareness as _Awareness } from './protocols/awareness.js';
import { bindEdytorDoc } from './edytor-doc.js';
import { bindProviders } from './providers/index.js';
import { bindMigration } from './migration/migrate.js';
import { bindSync } from './protocols/sync.js';

/**
 * One-shot binding of the whole CRDT surface to a concrete engine module —
 * the supported construction path for consumers (U07/U08):
 *
 * ```ts
 * import * as Y from 'edytor/crdt';        // vendored v14 engine
 * import { bindCrdt } from 'edytor';       // or '$lib/crdt/index.js'
 * const crdt = bindCrdt(Y);
 * const doc = crdt.createDoc();
 * const awareness = new crdt.Awareness(doc);
 * const provider = new crdt.providers.IndexeddbPersistence('my-doc', doc, { awareness });
 * ```
 */
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
		sync: bindSync(Y)
	};
};

export type Crdt = ReturnType<typeof bindCrdt>;
