# CRDT v14 providers, persistence and migration (U07)

The v14 provider stack ports the existing `localProvider` /
`y-websocket`-shaped surface onto the vendored `@y/y@14.0.0-rc.26` engine.
Everything lives under `src/lib/crdt/` and is **engine-injected** — no
module in `src/lib` runtime-imports the vendored `.js` (the upstream
`TS2589` deep-instantiation diagnostic in `delta-helpers.js` makes that
impractical; see `src/lib/crdt/engine-api.ts`).

## Construction path

```ts
import * as Y from 'edytor/crdt'; // vendored v14 engine (package export)
import { bindCrdt } from 'edytor'; // root export — resolves for plain
// ESM/node consumers too (a `default` condition exists alongside `svelte`)
// — or equivalently `import { bindCrdt } from 'edytor/crdt/edytor'`.

const crdt = bindCrdt(Y);
const doc = crdt.createDoc();
const awareness = new crdt.Awareness(doc); // engine-free class
const provider = new crdt.providers.IndexeddbPersistence('doc-name', doc, {
	awareness
});
await provider.whenSynced;
```

Package surface:

- `edytor` (root) — the v14 substrate: `bindCrdt`, `bindEdytorDoc`,
  `bindRuns`, `bindMigration`, `Awareness`, protocols, providers. It does
  **not** re-export the v13 collaboration stack (that stays an internal,
  non-published module until U08 rewires it).
- `edytor/crdt` — the raw vendored `@y/y@14.0.0-rc.26` engine module.
- `edytor/crdt/edytor` — the bindings (`src/lib/crdt/index.ts`) for
  consumers that want the facade without the editor package root.

`bindCrdt(Y)` returns `{ createDoc, Awareness, doc, providers, migration,
sync }`. Lower-level `bindSync`, `bindIndexeddbProvider`,
`bindWebsocketProvider`, `bindMigration`, `bindLegacyReader` are exported
individually for tests and custom wiring.

The provider lifecycle contract is unchanged from the v13
`localProvider.ts` fork: `{ doc, awareness, synced }`, hydration completes
before `synced`/`whenSynced` resolves, `destroy()` is idempotent, an
injected `awareness` instance is _not_ destroyed with the provider while an
internally created one is. `src/lib/crdt/providers/index.ts` additionally
exports `createIndexeddbSync`/`createWebsocketSync` factories matching the
`EdytorSync` shape that `src/lib/collaboration/providers.ts` consumes (U08
retargets those imports; the contract itself does not change).

## Document schema gate (`meta.v`)

The document carries an application-schema manifest on the `meta` root:
`meta.v` (schema version, currently `1`) and `meta.schema` (`'edytor-doc'`).
`edytor-doc.ts` exposes the module-level gate:

- `schemaVersion(doc)` — reads the replicated `meta.v`.
- `registryEmpty(doc)` / `isInitialized(doc)` — a doc counts as
  initialized **only** when the version stamp is present; raw registry
  writes do not make a doc "initialized".
- `checkSchema(doc)` → `null | { kind: 'unversioned' | 'unsupported', … }`
- `assertSchema(doc)` throws `SchemaMismatchError`.

Providers enforce the gate and surface it:

- **`unversioned`** (registry content without `meta.v` — rogue or legacy
  write): the update is **quarantined** — never persisted, never broadcast,
  and never applied to a hydrating doc. Hydration pre-merges stored rows
  into a scratch doc seeded with current state; a merged result that would
  be unversioned quarantines the whole batch. `storeState` likewise refuses
  to snapshot unversioned content.
- **`unsupported`** (`meta.v` names a version this build doesn't speak):
  content still syncs — a replica cannot refuse structs it shares a
  protocol with — but the signal makes peer skew observable.

Both regimes emit **`'schema-mismatch'`** with `SchemaMismatchDetail`
(`{ docName, problem }`) once per problem-state transition, mirrored
through `'message-error'` carrying the `SchemaMismatchError` so the generic
error channel sees every failure mode.

**Schema-version coexistence is LWW, not coexistence**: two replicas
writing different `meta.v` values converge to one winner (CRDT
attr-last-writer-wins). The manifest cannot hold two versions — detect
mixed-version rooms via the `unsupported` signal, not by storing both.

## Error and signal events (provider observability)

- `'protocol-mismatch'` — a frame failed the version envelope (includes
  real v13 traffic: `{expected:14, found:0}`).
- `'message-error'` — a structurally-valid envelope that could not be
  handled: corrupt sync payloads (the `errorHandler` path), **unknown
  message types** inside a valid v14 envelope, and mirrored
  `SchemaMismatchError`s. Countable, alarmable.
- `'permission-denied'` (websocket) — auth rejection from the server.
- `'load-error'` (indexeddb) — generation-record verification failures.
- `'schema-mismatch'` — the structured schema-gate signal above.

Console logging is not the observability contract — every failure mode has
an event.

## Undo — the supported seam

Consumers must create undo managers through **`ed.createUndoManager(opts)`**
on the `bindEdytorDoc` facade — never by constructing the engine's
`UndoManager` directly:

- It scopes the manager to the **`blocks` registry** — `meta.v` writes and
  schema-version transitions are outside the scope, so undo can never strip
  the version stamp or resurrect a stale version.
- It runs `init` first (no-op when already initialized) — the deterministic
  bootstrap insert always predates capture, so no undo step can remove it.
- Remote/provider writes never enter the stack (foreign origins + non-local
  transactions fail the `trackedOrigins`/`local` filter).

`opts` are the engine's UndoManager options (`captureTimeout`,
`trackedOrigins`, …) passed through verbatim.

## The v13/v14 boundary — what actually enforces it

v13 and v14 are different engines. Their update payloads can _decode_ under
the v14 engine (the legacy reader relies on that), but a live v13 peer must
never write into a v14 document: struct integration, pending-update
handling and GC semantics differ, and the corpus investigation below shows
the v14 engine crashing on update shapes its own sync peers would never
emit. The boundary is therefore enforced at the transport and storage
layers, not by metadata inspection.

### Transport: the version envelope (`protocols/envelope.ts`)

Every provider message — BroadcastChannel room traffic _and_ websocket
frames — is prefixed with a varuint protocol-version word:

```
varuint PROTOCOL_VERSION (=14) | varuint messageType | payload
```

`14` was chosen to be unreachable as a v13 _message type_ (v13 types are
0–3). The gate is fail-closed in both directions:

- A v13 peer's frame starts with its message type (`0|1|2|3`); a v14
  reader decodes `version = 0..3 ≠ 14`, drops the message _before_ any
  sync decoding, and emits `'protocol-mismatch'`. v13 updates can never
  reach `applyUpdate` on a v14 doc.
- A v14 frame starts with `14`; a v13 reader decodes message type `14`,
  finds no handler, and drops it. v14 updates can never reach a v13 doc
  either.

Message types keep the y-websocket numbering inside the envelope: sync `0`,
awareness `1`, auth `2`, query-awareness `3` (plus `7` for migration
announcements on the separate `edytor-v14-migration:<name>` room).

**The envelope is transport-only.** It authenticates that a peer speaks the
v14 wire protocol — it does **not** authenticate payload provenance. A v14
frame carrying v13-shaped update payloads will decode and integrate (the
structs land on legacy root keys, invisible to the v14 projection but
persisted and replicated). Peers in a room are trusted to ship well-formed
v14 structs; the application-schema gate above is what bounds the damage a
confused or forged peer can do to the _projected_ document.

### Storage: a separate IndexedDB generation

- A v14 provider for logical document `name` opens
  `edytor-v14:<name>` — never the legacy `<name>` database.
- On creation the provider stamps `custom.generation =
{ engine: 'yjs-v14', protocol: 14 }` and _verifies_ it before applying a
  single stored row. A populated store without the record — or with a
  foreign record — is a `GenerationMismatchError`: `load-error` fires,
  `whenSynced` rejects, `synced` never happens. Fail closed.
- `clearDocument(name)` deletes only the v14 generation; the legacy DB is
  never touched by this layer.

### Message robustness (found while porting)

lib0's `broadcastchannel` delivers same-tab publishes **synchronously** and
propagates subscriber exceptions into the publisher's call stack. Two
consequences, both handled:

1. The upstream "did the handler write a reply?" check —
   `encoding.length(encoder) > 1` — is wrong under the envelope: a handler
   with nothing to reply leaves `version + mirrored type` = **2 bytes**.
   All three send sites check `> 2` so a bare `[14,0]` header is never
   published (it would decode as a truncated sync message).
2. Subscribers wrap decode in try/catch and report via `'message-error'`
   instead of letting a malformed frame bubble back through the nested
   synchronous publish into the peer's `connectBc`.

## Providers

### `IndexeddbPersistence` (`providers/indexeddb.ts`)

Verbatim port of the v13 `localProvider.ts` fork (y-indexeddb +
cross-tab BC), keeping:

- `updates` store (auto-increment keys) of raw V1 update rows wrapped in a
  fresh `ArrayBuffer`; `custom` store for metadata (`get`/`set`/`del`).
- `PREFERRED_TRIM_SIZE = 500`: past it, a debounced `storeState` appends a
  compacted `encodeStateAsUpdate` snapshot and deletes the rows it
  subsumes. Snapshot + later rows reconstruct the full document (tested).
- BC room = the generation DB name; on connect it publishes
  SyncStep1 + SyncStep2 + QueryAwareness + local awareness state.
- `doc.on('update')` stores every non-provider-origin update and
  broadcasts it as a sync `Update` message.

### `WebsocketProvider` (`providers/websocket.ts`)

Port of `y-websocket@3.0.0` keeping `connect()`/`disconnect()`,
`status`/`sync`/`synced` events, exponential-backoff reconnect,
`resyncInterval`, `params`, `protocols`, `WebSocketPolyfill`, `disableBc`,
and BC cross-tab fan-out on `serverUrl + '/' + roomname`. Auth messages
(`protocols/auth.ts`) are handled.

**Server compatibility classification:** the websocket path was tested
against an _opaque relay_ — a server that only forwards frames between
room members. That kind of server remains reusable unchanged, because the
envelope makes v14 frames opaque-but-distinguishable and the payload is
never interpreted. A server that _participates_ in sync — loads, merges,
compacts, validates or inspects documents (e.g. upstream
`y-websocket-server` persistence hooks) — must run the vendored v14 engine
and these protocol modules; a v13 engine in that role cannot parse v14
state and will be dropped at the version gate anyway.

### Awareness (`protocols/awareness.ts`)

Verbatim port of `@y/protocols` awareness on `ObservableV2` + lib0-v14,
with the engine import reduced to `import type` (upstream's was
JSDoc-only but still executed `@y/y`, instantiating a second engine).
Wire format unchanged (clientID + clock + JSON state). Presence payload
_versioning_ (e.g. selection shapes) is U09's concern — the envelope only
guarantees the peer speaks v14.

## Migration (`migration/`)

Non-destructive v13 → v14 migration. `bindMigration(Y)` exposes
`migrate(name, opts)`, `rollback(name)`, `status(name)`,
`waitForSettled(name)`.

### What survives and what does not

- **Survives:** the logical document — block tree, inline atoms, marks,
  block/inline **logical ids** (`b_*`/`i_*` are data) — verified by
  re-materializing the migrated snapshot and deep-comparing JSON before
  activation.
- **Does not survive (by design):** CRDT item identities (`client:clock`),
  CRDT history, pending offline update _identity_, collaborative undo
  stacks, presence. The migrated doc is a fresh document with the same
  logical content. This is a JSON-level import — never describe it as
  preserving CRDT identity or history.
- **Disconnected legacy writes after cutover:** land in the untouched
  legacy DB and are _not_ live-mapped. Recovery path is explicit:
  `migrate(name, { force: true })` re-imports the legacy doc wholesale.

### Phases and arbitration

`claim → read → materialize → rebuild → verify → persist → activate →
announce`.

- **claim**: the `migration` record in the generation's `custom` store is
  written inside one `readwrite` transaction — IndexedDB serializes
  read-write transactions over a store, so exactly one caller owns
  `{status:'pending', owner, leaseUntil}`. Other callers observe the
  record and wait (poll + BC nudge on `edytor-v14-migration:<name>`);
  `wait:false` returns `busy`. A `pending` lease that expires (crashed
  tab) is reclaimable — `waitForSettled` treats an expired lease as
  settled, so resume latency is bounded by `leaseMs`, not `waitMs`.
- **read**: the legacy `<name>` DB's `updates` rows are read raw. A
  never-existing name produces a phantom store-less DB — the migrator
  heals it (creates the v13 stores / deletes the phantom) so a later v13
  `y-indexeddb` open still finds a healthy database and the rollback
  guarantee holds.
- **materialize**: `readLegacyJSON` applies the v1 rows to a scratch v14
  doc and materializes the v13 Edytor schema (root `content` map →
  `children` sequence → block maps with `content` text/inline arrays).
  `_legacyTypeRef` distinguishes the decoded node kinds. Anything that is
  not the v13 Edytor schema is rejected (`status:'failed'`). **Pending
  dependencies fail closed**: if applied rows leave
  `store.pendingStructs`/`pendingDs` non-null (a peer's offline row whose
  deps never landed), `PendingLegacyUpdatesError` aborts the migration —
  content is never silently dropped.
- **rebuild**: `edytorDoc.init(doc, { content: specs })` — the same
  document-level path used for fresh docs; ids preserved, `mig-*`
  deterministic fallbacks for missing ones.
- **verify**: the snapshot is applied to a second scratch doc and its
  `toJSON()` deep-equals the materialized legacy JSON, else `failed`. The
  expected side is normalized through the same fallback-id assignment
  first, so id-less legacy docs verify instead of dead-ending.
- **persist**: **additive** — the snapshot row is written under the fixed
  key `MIGRATION_SNAPSHOT_KEY`; the `updates` store is **never cleared**,
  so rows a live v14 provider already wrote survive a late migration.
  Re-runs overwrite the same key — idempotent, cannot duplicate.
- **activate**: single record write `status:'active'`.
- **announce**: BC nudge so waiting tabs settle immediately.

Every phase is idempotent; resuming re-runs the import into the same
generation and cannot duplicate identities because the migrated doc is
rebuilt from scratch and persisted as one row. `rollback(name)` marks the
generation `rolledback` and clears its rows; the legacy DB is untouched
so the v13 stack keeps working on its own data. A subsequent `migrate`
requires `force:true` — rollback is an operator decision.

### Boot/migration recipe (integrator wiring)

Migration is **explicit-only** — nothing in the runtime invokes it. A v13
user opening the app post-upgrade otherwise lands on the empty
`edytor-v14:<name>` generation and sees a fresh document. The intended
boot order is **migrate first, provider second**: the migrator stamps the
generation record and persists the snapshot row into `edytor-v14:<name>`,
so a provider opened afterwards passes the storage gate and hydrates the
migrated content inside the same `whenSynced`.

```ts
import * as Y from 'edytor/crdt';
import { bindCrdt } from 'edytor';

const crdt = bindCrdt(Y);

const bootDocument = async (name: string) => {
	// 1. Settle this generation's migration state.
	const record = await crdt.migration.status(name); // cheap: one custom read
	if (record.status === 'none' || record.status === 'failed') {
		// 'none'   — never migrated. Run it: absent legacy DB →
		//            {status:'active', empty:true}; legacy rows → verified
		//            snapshot. Idempotent and single-winner across tabs.
		// 'failed' — claimable again; safe to retry (a pending-deps abort is
		//            retryable once the missing rows sync).
		const result = await crdt.migration.migrate(name);
		if (result.status === 'failed') {
			// Surface result.error — e.g. PendingLegacyUpdatesError: a peer's
			// offline rows never landed; retry later, do not force.
		}
	} else if (record.status === 'pending') {
		// Another tab owns the claim — wait for its settle (expired leases
		// count as settled).
		await crdt.migration.waitForSettled(name);
	}
	// 'rolledback' is an operator decision — never auto-migrate over it
	// (requires { force: true }).

	// 2. Open the provider — hydrates whatever the generation holds
	//    (migrated snapshot + any live rows) and joins the BC room.
	const doc = crdt.createDoc();
	const awareness = new crdt.Awareness(doc);
	const provider = new crdt.providers.IndexeddbPersistence(name, doc, { awareness });
	await provider.whenSynced;

	// 3. Init/bind the editor — sync() is init-aware: a migrated/hydrated
	//    doc carries meta.v and skips the bootstrap seed.
	const edytor = new Edytor({ doc, awareness, sync: true, value });
	// or: <Edytor sync={({ doc, awareness, synced }) => {
	//   const provider = new crdt.providers.IndexeddbPersistence(name, doc, { awareness });
	//   provider.whenSynced.then(synced);
	//   return () => provider.destroy();
	// }} … />
};
```

Rules that make this safe:

- **Order matters.** Persist is additive (`MIGRATION_SNAPSHOT_KEY`; the
  `updates` store is never cleared), so a migration that runs _while a
  provider is already open_ still lands correctly on disk — but the open
  provider does not re-read its store, so that tab only sees the migrated
  content on next hydration (or if you bridge it explicitly via
  `Y.applyUpdate(doc, Y.encodeStateAsUpdate(result.doc))`). Running
  `status`/`migrate` before opening the provider avoids the bridge
  entirely.
- Concurrent tabs serialize on the claim: `migrate` losers wait
  (`wait:true` default) then observe `alreadyActive`; `wait:false`
  returns `busy` for callers that prefer to proceed immediately — the
  claim already stamped the generation record, so the provider still
  passes the storage gate, just without the snapshot yet.
- The legacy `<name>` DB is never written — v13 installs keep working on
  their own data, and `rollback(name)` + `force` stays an explicit
  recovery path.

## Test evidence

`src/tests/crdt/providers/` and `src/tests/crdt/migration/` (29 tests,
`pnpm test:crdt`):

- **SY01** `sync.test.ts` — real two-provider BC sync, offline
  convergence, reordered/duplicated delivery, state-vector delta sync,
  v13-shaped room message rejection, awareness propagation + cleanup.
- **SY01-WS** `websocket.test.ts` — actual websocket path over an opaque
  in-memory relay: convergence, live updates, awareness, envelope on every
  frame, no bare headers, v13 frame dropped at the gate.
- **SY02** `persistence.test.ts` — hydration from stored rows; compaction
  snapshot + later rows reconstruct the complete document.
- **SY03** `persistence.test.ts` — generation separation (legacy DB never
  opened), populated-without-record and foreign-record fail closed,
  idempotent destroy, owned/injected awareness lifecycle.
- **CO01** `migrate.test.ts` — all four recorded v13 fixtures decode to
  their pinned logical JSON (binary decode tested apart from schema
  conversion); the offline-peer pending update applies incrementally;
  non-legacy docs are rejected.
- **CO02** — end-to-end migration into the generation, hydration by a real
  provider, legacy DB byte-identical afterwards, logical ids preserved /
  CRDT identity reset, empty and foreign legacy DBs.
- **CO03** — concurrent migrators produce exactly one snapshot and one
  `alreadyActive`; idempotent re-run; crash before persist and after
  persist resume cleanly; rollback preserves legacy and requires `force`.

## Engine robustness note (seeds 86/140)

The random corpus (`src/tests/crdt/random/failures/seed-{86,140}.json`)
exposes a genuine **vendored-engine defect**, not a provider or harness
bug: after a _lossy_ reload — an update whose `Skip` ranges mark
known-but-absent content — integrating a `GC` range that covers more than
the `Skip` it replaces produces overlapping entries in the struct store,
and a later lookup/cleanup crashes (`Cannot read properties of undefined
(reading 'id')`).

Instrumented tracing of `BlockSet.exclude()` / `StructStore.add()` /
transaction cleanup confirmed the store is consistent until the
overlapping insertion, so the corruption happens inside engine
integration. The vendor tree was reverted clean (patches must go through
`UPSTREAM.md`'s documented process). Practical implications:

- Providers never _emit_ lossy updates — `encodeStateAsUpdate` always
  writes complete struct ranges, and the sync protocol only ships full
  updates/state vectors. The defect is not reachable through the provider
  sync path.
- The corpus's lossy-reload adapter is what triggers it (deliberately
  dropping slices of a doc). Both seeds are classified
  `upstream-engine-crash` in `corpus.test.ts` and the repros are committed
  for an upstream report / future engine patch.

## U08 handoff

Gate 2 remediation landed before this handoff — the substrate passes its
adversarial review (see `crdt-v14-gate2-review.md` → Resolution). The
cutover checklist:

- Retarget `src/lib/collaboration/providers.ts` to
  `bindProviders(Y)`/`createIndexeddbSync`/`createWebsocketSync` (same
  `EdytorSync` contract) and `src/lib/localProvider.ts` to the v14
  `IndexeddbPersistence`. The v13 packages (`yjs`, `y-protocols`,
  `y-websocket`, `y-indexeddb`, `lib0`) are devDependencies — they still
  resolve inside this repo for the live editor; only remove them once no
  shipped module imports them.
- Undo: attach via `ed.createUndoManager()` — the registry-scoped,
  post-init seam (see "Undo — the supported seam"). Do not construct the
  engine `UndoManager` against the whole doc: that scope can undo `init`
  (bootstrap + `meta.v`) and resurrect stale schema versions.
- `awarenessSelection.ts`/`remoteSelection.ts`: v14 relative positions
  resolve to `Y.Node` (`absolutePosition.type instanceof Y.Node`), not
  `Y.Text`.
- `edytor.sync()` must check `doc.isInitialized()` before `init()` (a
  migrated/hydrated doc already has the version record).
- Wire `'schema-mismatch'`/`'message-error'`/`'permission-denied'` into
  whatever operator/user surfacing the app wants — they are the
  observability contract now, not console noise.
- The legacy DB (`<name>`) is left in place; whether/when to surface the
  migration to users is a product decision — the mechanics are
  `migration.migrate(name)` + `rollback(name)`.
