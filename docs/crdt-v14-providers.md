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
  be unversioned quarantines the batch (see the surgical rule below).
  `storeState` likewise refuses to snapshot unversioned content.
- **`unsupported`** (`meta.v` names a version this build doesn't speak):
  remote updates whose merge would move the doc to that version are
  **refused at the staging boundary** — never applied to the live doc,
  never persisted, never rebroadcast (see _Application-schema boundary_
  below). Outbound writes from a doc already in this state are equally
  quarantined.

Both regimes emit **`'schema-mismatch'`** with `SchemaMismatchDetail`
(`{ docName, problem }`), mirrored through `'message-error'` carrying the
`SchemaMismatchError` so the generic error channel sees every failure
mode. Doc-state transitions emit once per problem-state transition; each
refused update or hydration batch emits once per refusal.

**Schema-version coexistence is LWW, not coexistence**: two replicas
writing different `meta.v` values converge to one winner (CRDT
attr-last-writer-wins — resolved by clientID for same-key writes). The
manifest cannot hold two versions — detect mixed-version rooms via the
`unsupported` signal, not by storing both.

### Document admission boundary (U8)

The transport staging below is one half of the boundary; the document
layer (`crdt/admission.ts`) is the other, and both run the same
`checkSchema`/`assertUsableDoc` reads on the same definitions (the
transport files import the gate vocabulary through `admission.ts`):

- `loadDocument(update)` decodes+integrates the payload onto a scratch
  doc first — `UndecodableUpdateError` for undecodable bytes, then the
  usual typed refusals — so a refused restore never mutates anything and
  the caller's bytes are untouched;
- `attachDocument(doc)` gates the borrowed doc before composing —
  `UnsupportedDocError` for a foreign engine object or applied-but-
  unmigrated v13 layout, `SchemaMismatchError` for
  unversioned/unsupported/foreign schema claims — leaving the doc
  byte-identical (reattachable once its state heals);
- `document.sync()` re-runs the gate at the readiness decision: a doc
  that entered a problem state through raw `applyUpdate` writes (which
  bypass the transport gate) refuses there instead of being seeded over —
  it stays `pending` and preserves its content;
- a `pending` document never writes or broadcasts a seed — provider
  `SyncStep2` publishes only the pre-existing state. An empty document
  seeds only once every attached provider settled or reached its bound
  (arch-v2 T3, settle-or-bound); a non-empty one is `hydrated` as soon as
  a provider settles.

A doc carrying foreign/unrelated ROOTS but no schema claim still admits
`pending` — `sync()` then seeds the schema next to them; the transport
boundary is what keeps schema claims honest, and raw-root content was
never a claim.

## Application-schema boundary — validated staging (work unit 3)

The gate-2 review found `unsupported` versions applied or persisted
_before_ the mismatch was reported. Transport generation 14 proves a peer
speaks the v14 wire protocol, not that its payload is a supported
application schema; and replicated `meta.v` cannot negotiate capabilities
(a v99 peer's `meta.v` can win the merge). The boundary is now enforced
by **validated staging** (`sync.ts` → `applyUpdateStaged`), chosen over
the alternatives:

- _Session/handshake schema word_ — impossible on BroadcastChannel: BC is
  connectionless, there is no handshake, so every message must be
  self-validating anyway. Rejected as the primary mechanism.
- _Per-message schema metadata_ — would refuse exactly the updates the
  contract says must pass (a same-schema peer's incremental writes carry
  no schema word) and adds wire surface for no extra correctness.
- _Storage-generation tagging_ — already exists (`generation` record) and
  stays; it bounds engines, not application schema.

Staging is also the only option that gets LWW right for free: the verdict
is computed on the **merged** result, not the claimed version — an
incremental update carrying no `meta.v` write keeps the staged doc at the
live version and applies, while an update whose merge resolves to an
unsupported or unversioned record is refused **before** it mutates the
live document.

### Inbound path (BroadcastChannel + websocket — identical mechanics)

`messageHandlers[messageSync]` decodes the sync subtype itself:

- **SyncStep1** → replies SyncStep2 with our state — but only when our
  own doc passes `checkSchema`; a doc already in a schema-problem state
  does not ship its state to the room.
- **SyncStep2 / Update** → the payload is merged into a throwaway staging
  doc seeded with the live doc's full state (`new Y.Doc()` +
  `encodeStateAsUpdate(doc)` + `applyUpdate`). `checkSchema(staging)`:
  - `null` → `Y.applyUpdate(doc, update, provider)` — the normal path;
  - problem → **refused**: `'schema-mismatch'` + `'message-error'`
    (`SchemaMismatchError`) emitted; the update never enters the doc —
    so it is never persisted and never rebroadcast (both are
    `doc.on('update')`-driven).
- Unknown sync subtypes inside a valid envelope → `'message-error'`.
- Corrupt payloads → `'message-error'` via the same `errorHandler`
  contract (staging applies are wrapped, `console.error` parity kept).

**`synced` honesty (websocket):** `provider.synced` is set only when the
SyncStep2 handshake payload was actually _applied_. A refused SyncStep2
yields no sync claim — the doc does not reflect the peer's state.

**Join rule and readiness (arch-v2 T2):** one rule, derived from state
vectors, identical on the socket and the BroadcastChannel and correct
behind an opaque relay. Joining sends a hello (SyncStep1 + own presence).
A SyncStep1 is answered with a SyncStep2 and, when the asker's state
vector holds anything we lack, with our own SyncStep1 — so a reconnecting
client's offline edits reach the room without `resyncInterval`, which is
now an optional loss-healing timer (off by default; kept for harnesses
that drop frames on a live socket, arch-v2 G-e). The connection's
`synced` is claimed when it holds a member's state: an applied SyncStep2,
or a SyncStep1 whose state vector it covers. It resets with the socket;
`hasSynced` is the lifetime fact, and the terminal `failed` reads it (a
provider that synced and then lost its socket never fails). The two-round
settle window (`syncSettleMs`) is deleted: `synced` is a readiness
signal, and the seed it could race is idempotent: seeds are one
deterministic update from a writer hashed from the seed (T3), so a client
that claims `synced` off another member's empty handshake and seeds
converges with the room. A client alone in a new room is resolved by the
readiness bound (`DEFAULT_READINESS_BOUND`, or the factory's `bound`).

**Merge semantics worth knowing:** the staged verdict follows CRDT LWW on
`meta.v` — resolved by clientID for same-key writes. A v99 peer's state
staged onto a v1 doc can therefore resolve either way: if v1 wins, the
update applies as ordinary v1 content (compatible — the future schema
lost the merge); if v99 wins, the update is refused. Either outcome
satisfies the contract "reject incompatible data before it mutates the
live document" — the live doc never enters an unsupported state.

### Outbound path (both providers)

Every place local replicated state could leave the doc is gated on
`checkSchema(doc) === null` (previously `unversioned`-only):

- `doc.on('update')` handlers (`_storeUpdate` / `_updateHandler`) — a doc
  in a schema-problem state persists nothing and broadcasts nothing.
- `connectBc` SyncStep2 publish — a problem-state doc never publishes its
  state on the room.
- `beforeApplyUpdatesCallback` / `storeState` — problem state is never
  written into the generation DB.

### IndexedDB hydration (`fetchUpdates`)

Two phases:

1. **Fast path** — all stored rows are merged onto a scratch doc seeded
   with live state; a clean merged result applies the whole batch
   (unchanged behavior for healthy stores).
2. **Surgical path** — a problem merged result re-stages row by row:
   each row is applied to an "accepted" scratch; a row that moves it into
   a problem state is **refused** (never applied to the live doc) and the
   scratch is rebuilt from the accepted prefix so later rows are judged
   against clean state. Clean rows still hydrate; refused rows **stay in
   the store untouched** — the boundary is non-destructive, original
   bytes are never rewritten or deleted.

Hydration refusal signals `'schema-mismatch'` + `'message-error'`,
suppresses `synced`, and rejects `whenSynced` with the
`SchemaMismatchError` — claiming sync over refused stored state would be
a false signal. The provider **still joins the BC room**, so subsequent
VALID peer updates apply (recoverability — refused data does not poison
the connection). A doc already in a schema-problem state at attach time
takes the same path: `whenSynced` rejects, `synced` never fires.

### Refusal ↔ compaction (R2 hardening)

A refusal leaves the live document **not representing** every stored row —
which is exactly the invariant compaction relies on. `storeState` writes
`encodeStateAsUpdate(doc)` and then deletes every row `< _dbref`; a clean
live schema is **not** proof that the snapshot subsumes the stored rows it
replaces (a refused row's bytes are absent from the doc by definition).
The pre-hardening bug: `_dbref` advanced past refused rows, so the delete
range covered them — durable bytes the doc never accepted were destroyed.

The contract now:

- `_hydrationRefused` is set by `fetchUpdates` whenever ANY stored row is
  refused — during hydration **or** during a later `storeState` fetch
  (e.g. a future-schema tab appends to the shared generation while this
  provider is live; the refusal check runs after the fetch, so such rows
  are blocked from the same call that discovers them).
- While `_hydrationRefused` is set, `storeState` still runs the fetch
  (valid peer rows keep hydrating) but **skips snapshot+delete entirely**.
  Blocking was chosen over selective preservation: a selective scheme
  would have to prove each excluded row plus its dependency closure
  survives — an update's deps may sit in rows before _or after_ it —
  while deleting nothing needs no such proof. Refused rows, their deps,
  and everything else remain byte-for-byte durable.
- `_dbref` still advances past refused rows (fetch cursor: refused rows
  are not re-staged on every fetch); `_dbsize` keeps counting real rows.
  `_dbref` is no longer used as a delete boundary for refused instances —
  compaction simply never runs.
- The block is per-instance and sticky: this build can never admit v99
  content, so the snapshot can never subsume the refused bytes. Reopening
  re-establishes it (fresh hydration re-fetches from `_dbref = 0` and
  re-refuses).
- `storeState`'s returned promise settles only after the storage
  transaction **commits** (snapshot add + delete + recount chained, then
  the transaction's `complete`/`abort` observed) — the upstream port
  dropped the inner chain, so completion and failure were unobservable.
  Failures reject; the timed path forwards rejections to `'message-error'`
  and `_storeUpdate`'s row write surfaces there too.
- Normal compaction efficiency is unaffected for fully-admitted state:
  a clean store still compacts to a single snapshot row.

### Recoverability

Refused data is quarantined per-message/per-row — nothing is torn down:

- BC/ws: after a refusal, subsequent valid updates stage clean and apply
  normally (tested).
- IDB: a clean peer's updates arriving after a refused hydration apply
  normally (tested); a clean prefix in a mixed store hydrates (tested).
- An unversioned doc _heals_: a full versioned state update supplies
  `meta.v=1` on merge, stages clean, and applies (tested).

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
- It runs `init` first (no-op when already initialized) — the seed is
  applied as an update with a non-local origin, so no undo step captures it.
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
awareness `1`, auth `2`, query-awareness `3` (migration sends nothing:
`edytor-v14-migration:<name>` names its lock).

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
  subsumes — **unless hydration refused any stored row**: then the
  instance never compacts, so refused bytes and their deps survive
  byte-for-byte (see _Refusal ↔ compaction_ above). `storeState` resolves
  after the transaction commits and rejects on storage failure (the timed
  path forwards failures to `'message-error'`). Snapshot + later rows
  reconstruct the full document (tested).
- BC room = the generation DB name; on connect it publishes its hello
  (SyncStep1 + local awareness state) and a QueryAwareness; the join rule
  exchanges what each side lacks.
- `doc.on('update')` stores every non-provider-origin update and
  broadcasts it as a sync `Update` message.

### `WebsocketProvider` (`providers/websocket.ts`)

Port of `y-websocket@3.0.0`, cut to the surface the docs, demo and tests
use (arch-v2 G-e, D-24): `connect()`/`disconnect()` (and the `connect`
option), `status`/`synced`/`connection-close`/`connection-error` events,
exponential-backoff reconnect (`maxBackoffTime`), liveness (a socket silent
for 30 s is closed and redialed), auth `params` on the URL (read at every
dial, so a refreshed token reaches the next connection), the auth
permission-denied reply (`protocols/auth.ts`), `awareness`,
`WebSocketPolyfill`, and `resyncInterval` (off by default; a loss-healing
knob for harnesses that drop frames on a live socket — the join rule needs
no timer). Leaving announces the presence removal on the socket.

`createWebsocketSync({ serverUrl, roomName, params?, WebSocketPolyfill?,
maxBackoffTime?, disableBc?, persist?, persistName? })` — the factory-owned
provider always dials. By default it also attaches a local IndexedDB store
(`edytor:<serverUrl>/<roomName>`, or `persistName`; `persist: false` opts
out; skipped without `indexedDB`) as its own provider on the document
(`EdytorSyncPayload.attach`): stored content decides readiness offline, an
empty store holds the seed until it answered, and restored edits reach the
server by the join rule. While the store exists it carries the cross-tab
channel and the socket's BroadcastChannel leg (restored after G-e, on by
default) is off; `disableBc` turns both off.

**Retired in G-e** (0.0.x API change, release notes C1): the `protocols`
option (WebSocket subprotocols — pass tokens in `params`), the `sync` event
(an alias of `synced`), the `wsconnecting` field (the `status` event carries
it), the BroadcastChannel leg with `disableBc`, `bcconnected`, `bcChannel`,
`connectBc()`/`disconnectBc()` (cross-tab sync is the IndexedDB
provider's; stack it beside the websocket provider as the demo does), and
on `createWebsocketSync` the `connect`, `protocols`, `resyncInterval` and
`disableBc` options. The `messageSync`/`messageAwareness`/`messageAuth`/
`messageQueryAwareness` constants still export from `edytor/crdt` (now
from `providers/room.ts`).

**Server compatibility classification — the verified topology (work
unit 3, corrected post-review R8).** The websocket path was tested
against _opaque byte relays_ only: `websocket.test.ts`'s in-memory room
(sockets on one URL, `send` forwarded verbatim to the other members) and
`tests/editor-dom/ws-relay.ts`, the dependency-free RFC6455 relay the
browser specs run against. That class of server is reusable unchanged
because the envelope makes v14 frames opaque-but-distinguishable and the
payload is never interpreted.

**What qualifies as an opaque relay:** a websocket server that only
groups connections into rooms and forwards binary frames without decoding
them. That is the entire contract — the relay must not read the first
varuint, must not keep server-side document state, and must not answer
sync itself. The only server implementations actually exercised are our
two test relays; no other server is proven compatible.

**What does NOT qualify — including upstream `y-websocket`:** any server
that interprets the y-protocols sync format — decodes
`varuint messageType`, applies updates to a server-side doc, persists
state, answers SyncStep1 itself, or validates payloads (hosted
"yjs-aware" collaboration services, custom gateways that rewrite sync
messages). **This includes upstream `y-websocket`'s `setupWSConnection`
(`bin/utils.js`), even with NO persistence hook** — verified against
v1.5.4 and v2.1.0, which share the same shape: on connect it calls
`getYDoc(docName)` which always creates a server-side `WSSharedDoc` (plus
a server-side `Awareness`), `messageListener` decodes
`varuint messageType` and switch-handles only `messageSync` (0) and
`messageAwareness` (1), updates reach other members only by integrating
into the server doc and re-broadcasting from `doc.on('update')`, and the
server itself sends an un-enveloped `messageSync`/SyncStep1 on every new
connection. Two failures follow:

- A v14 frame's leading word is the protocol version `14`, which
  `messageListener` reads as _message type_ 14 — no case handles it, so
  the frame is dropped **and never relayed** to room members. v14 peers
  behind upstream's server cannot see each other's updates at all.
- The server's own frames carry no version word, so every message it
  sends (its SyncStep1, its re-broadcast sync/awareness traffic) decodes
  here as `version = 0|1`, is dropped pre-decode, and fires
  `'protocol-mismatch'` — the gate is fail-closed in that direction too.

The earlier revision of this section claimed default upstream
`setupWSConnection` "forwards `message` payloads byte-for-byte" and
qualified as an opaque relay. That was wrong: upstream is a
_participating_ server, not a relay. An opaque-relay test does NOT prove
compatibility with a server in this class; a participating server must
run the vendored v14 engine plus these protocol modules (none exists
today — implementing one is future work, not a deployment option).

Bottom line: the supported websocket topology today is **opaque relay
only**, and the only proven relay is the local test implementation
(`tests/editor-dom/ws-relay.ts`) plus `websocket.test.ts`'s in-memory
room. The boundary's own defense still applies: even if a participating
v13 server somehow pushed data through, it would be refused at the
envelope or the staging boundary — never applied.

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
  `migrate(name, { force: true })` restores the legacy materialization in
  place (below).

### Attempt, phases and progress (T5)

`claim → read → materialize → rebuild → verify → persist`.

- **The attempt is a lock**, not a record: `navigator.locks` lock
  `edytor-v14-migration:<name>` (`migrationBcRoom(name)`), released with
  the tab or the attempt — a crash never blocks the next caller, so there
  is no lease, owner or poll. Where the platform has no `navigator.locks`
  (Node 22) an in-process mutex stands in. A second caller queues behind
  the holder and then observes `alreadyActive`; `wait:false` asks
  `ifAvailable` and returns `busy`. `status(name)` reports `pending` while
  an attempt holds the lock (`locks.query()`), the durable record
  otherwise; `waitForSettled(name)` waits for the lock (shared) and reads
  the record. `leaseMs`, `owner`, `pollMs` and `waitMs` are accepted and
  ignored (D-15).
- **read**: the legacy `<name>` DB's `updates` rows are read raw in one
  readonly transaction; the database is opened non-creating
  (`container.ts` `openIfExists`), so a never-existing name leaves no
  phantom behind.
- **materialize**: `readLegacyJSON` applies the v1 rows to a scratch v14
  doc and materializes the v13 Edytor schema (root `content` map →
  `children` sequence → block maps with `content` text/inline arrays).
  `_legacyTypeRef` distinguishes the decoded node kinds. Anything that is
  not the v13 Edytor schema is rejected (`status:'failed'`). **Pending
  dependencies fail closed**: if applied rows leave
  `store.pendingStructs`/`pendingDs` non-null (a peer's offline row whose
  deps never landed), `PendingLegacyUpdatesError` aborts the migration —
  content is never silently dropped. Id-less blocks and atoms get
  deterministic `mig-*` ids once; the import is built from, and verified
  against, that JSON.
- **rebuild**: `edytorDoc.restore(doc, specs)` into a fresh doc (a first
  import: fresh identity) or, with `force`, into the generation's hydrated
  state (a replace-edit — restore-definition: every legacy id's delete
  marks cleared and its type, data, placement and content rewritten in
  place; every other block delete-marked; ranks derived from the tree).
- **verify**: the migrated state is applied to a second scratch doc and its
  `toJSON()` — ids included — deep-equals the legacy JSON, else `failed`.
- **persist**: ONE `readwrite` transaction over `updates` + `custom`
  verifies-or-stamps the container (`container.ts`, the rule the provider
  uses), **appends** the row (the whole state for a first import, the
  restore's diff for `force`) and writes `status:'active'`. A completed
  import is visible iff both committed; the store is append-only, so rows
  a live v14 provider wrote survive, and a forced re-run never orphans
  them.

A crash anywhere before the commit leaves nothing behind; the next call
re-runs the import. Two devices that force independently write the same
restore (last-writer-wins attrs, derived ranks) and converge on one copy.
`rollback(name)` marks the generation `rolledback` and clears its rows;
the legacy DB is untouched so the v13 stack keeps working on its own data.
A subsequent `migrate` requires `force:true` — rollback is an operator
decision.

### Boot/migration recipe (integrator wiring)

Migration is **explicit-only** — nothing in the runtime invokes it. A v13
user opening the app post-upgrade otherwise lands on the empty
`edytor-v14:<name>` generation and sees a fresh document. The intended
boot order is **migrate first, provider second**: the migrator stamps the
generation record and appends the import row into `edytor-v14:<name>`,
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
		// Another tab is migrating — wait until its attempt (a lock that is
		// released with the tab) ends, then read the record.
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

- **Order matters.** Persist appends (the `updates` store is never
  cleared), so a migration that runs _while a provider is already open_
  still lands correctly on disk — but the open provider only reads the
  row at its next compaction, so that tab sees the migrated content on
  next hydration (or if you bridge it explicitly via
  `Y.applyUpdate(doc, result.update)`). Running `status`/`migrate` before
  opening the provider avoids the bridge entirely.
- Concurrent tabs serialize on the migration lock: `migrate` callers
  queue (`wait:true` default) then observe `alreadyActive`; `wait:false`
  returns `busy` for callers that prefer to proceed immediately — the
  provider stamps an empty container itself, so it still opens, just
  without the import yet.
- The legacy `<name>` DB is never written — v13 installs keep working on
  their own data, and `rollback(name)` + `force` stays an explicit
  recovery path.

## Test evidence

`src/tests/crdt/providers/` and `src/tests/crdt/migration/` (`pnpm
test:crdt`):

- **SY01** `sync.test.ts` — real two-provider BC sync, offline
  convergence, reordered/duplicated delivery, state-vector delta sync,
  v13-shaped room message rejection, awareness propagation + cleanup.
- **SY01-WS** `websocket.test.ts` — actual websocket path over an opaque
  in-memory relay: convergence, live updates, awareness, envelope on every
  frame, no bare headers, v13 frame dropped at the gate.
- **WU3** `schema-boundary.test.ts` — the application-schema boundary on
  every path: v99/unversioned updates refused on BC and websocket (live
  doc untouched, signaled, not persisted, not rebroadcast, `synced` never
  fires falsely), recoverability via subsequent valid updates, valid
  schema-less incremental updates still apply, a poisoned doc's own
  provider never ships its state, stored v99/mixed-schema generations
  hydrate correctly (poisoned rows skipped, bytes intact, `whenSynced`
  rejects, room still joined).
- **SY02** `persistence.test.ts` — hydration from stored rows; compaction
  snapshot + later rows reconstruct the complete document.
- **R2** `hardening/r2-idb-compaction.test.ts` — refused rows survive every
  maintenance path byte-for-byte: explicit and timed compaction, mixed
  valid+refused stores, close/reopen, repeated attempts, dependent rows in
  both seed orders, post-sync refusals discovered inside `storeState`'s
  own fetch, commit-settled promises, surfaced failures, and preserved
  compaction for fully-admitted stores.
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
