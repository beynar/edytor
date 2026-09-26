# AI implementation handoff: integrated Edytor document and vendor simplification

Date: 2026-09-21.

This is the canonical handoff combining the integrated-document proposal and elegance review. It contains the implementation objective, architecture constraints, work units, decision gates, and acceptance criteria. The earlier documents are superseded. The [native attribution source notes](./crdt-v14-attribution-source-notes.md) remain supporting research; essential requirements are included here.

## 1. Assignment and completion

Implement an Edytor document API that provides editing, local undo/redo, awareness, and **v14's existing native attribution** by default. Applications should create or load one document and use it headlessly or through multiple Svelte views without assembling managers or binding the engine themselves.

Use this integration to remove duplicated semantic rules and unnecessary representation/lifecycle work. Extend existing owners. Preserve move, split, merge, collaboration, browser editing, and the performance improvements already implemented.

The work is complete when:

- Creation and loading return the existing domain document surface with all required services integrated.
- Multiple views share maintained document state and local services while retaining their own DOM/focus state.
- Attribution survives supported save/load, persistence, and synchronization paths and is available through Edytor's projected content.
- Remote updates, hydration, and system bookkeeping never enter local user history.
- Normal editing retains live-text coordinates, immutable public snapshots, read-your-writes, and commit-bound publication.
- Superseded rules and conversion paths are removed, with preserved contracts demonstrated across their real consumers.
- Correctness, resource lifetime, default-feature performance, and packed-consumer size are measured against identified source and harness versions.

This is an implementation brief, not a claim that its proposals are already implemented. Follow applicable `AGENTS.md` instructions, preserve concurrent work, and resolve routine implementation choices from evidence. New incompatible public/wire contracts remain subject to the repository's authority rules. No hosted deployment or publication is part of this assignment.

## 2. Context and evidence status

The investigations inspected a dirty `feat/crdt-v14-engine` checkout at HEAD `d9b7de09e7110fc7a4c2fb1eec36f8267aede086`. Hardening continued during inspection. Re-read current source and the relevant [execution ledger](./crdt-v14-execution-ledger.md), [Gate-H review](./crdt-v14-gateH-review.md), and [undo ownership decision](./crdt-v14-undo-ownership-adr.md). Do not reintroduce superseded repair/lifetime behavior or assume an earlier defect remains open.

The recorded engine is `@y/y@14.0.0-rc.26`, upstream commit `96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64`, with local patches; `lib0-v14` resolves to `lib0@1.0.0-rc.32`. Verify the current [vendor manifest](../src/lib/crdt/vendor/yjs/UPSTREAM.md) and lockfile before relying on those pins.

Observed at review time:

| Area        | Existing behavior                                                               | Integration opportunity                                                      |
| ----------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Creation    | `bindCrdt(Y).createDoc()` returns a raw `Y.Doc`.                                | Return an assembled domain document from the normal bound API.               |
| Model state | Every editor binds the engine; the `bindRuns` document cache is binding-scoped. | Share the production binding and maintained indexes.                         |
| History     | Created per editor after initialization/sync.                                   | One default local history with document lifetime and explicit capture rules. |
| Awareness   | Editor and provider constructors can each create it.                            | One state shared by views and transports.                                    |
| Attribution | Native APIs exist; Edytor's range projection carries text/marks only.           | Connect capture, durability, projection, and invalidation.                   |
| Text reads  | Edytor independently interprets native items and format markers.                | Consolidate physical sequence semantics in the vendor.                       |
| Commands    | Some view commands repeat document policy.                                      | Resolve UI intent once, then delegate the domain decision.                   |

Relevant source owners:

| Concern                                      | Start here                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bindings, raw types, domain facade/handles   | [CRDT entry](../src/lib/crdt/index.ts), [engine boundary](../src/lib/crdt/engine-api.ts), [EdytorDoc](../src/lib/crdt/edytor-doc.ts), [DocBlock](../src/lib/crdt/nodes.ts)                                                                                                                                                                                     |
| Ownership, interval reads, maintained runs   | [text model](../src/lib/crdt/text/model.ts), [runs](../src/lib/crdt/text/runs.ts), [placement model](../src/lib/crdt/placement/model.ts)                                                                                                                                                                                                                       |
| Native traversal, attribution, updates, undo | [YNode](../src/lib/crdt/vendor/yjs/src/ynode.js), [Renderer](../src/lib/crdt/vendor/yjs/src/utils/Renderer.js), [metadata](../src/lib/crdt/vendor/yjs/src/utils/meta.js), [IDs](../src/lib/crdt/vendor/yjs/src/utils/ids.js), [encoding](../src/lib/crdt/vendor/yjs/src/utils/encoding.js), [UndoManager](../src/lib/crdt/vendor/yjs/src/utils/UndoManager.js) |
| Editor and command adapters                  | [editor](../src/lib/edytor.svelte.ts), [Block](../src/lib/block/block.svelte.ts), [block commands](../src/lib/block/block.utils.ts), [Text](../src/lib/text/text.svelte.ts), [text commands](../src/lib/text/text.utils.ts), [render conversions](../src/lib/text/deltas.ts)                                                                                   |
| Selection and presence                       | [selection](../src/lib/selection/selection.svelte.ts), [history snapshots](../src/lib/history/historySelectionSnapshot.ts), [awareness payload](../src/lib/collaboration/awarenessSelection.ts), [remote overlay](../src/lib/collaboration/RemoteSelections.svelte), [awareness protocol](../src/lib/crdt/protocols/awareness.ts)                              |
| Admission, storage, migration                | [sync](../src/lib/crdt/protocols/sync.ts), [envelope](../src/lib/crdt/protocols/envelope.ts), [IndexedDB](../src/lib/crdt/providers/indexeddb.ts), [WebSocket](../src/lib/crdt/providers/websocket.ts), [migration](../src/lib/crdt/migration/migrate.ts)                                                                                                      |

## 3. Architectural rules

### One meaning, one authority

Apply the supplied elegance standard: the smallest set of independent concepts that makes required behavior reliable. Distinguish declared facts, derived views, and temporary observations. Several projections are legitimate; several independently maintained interpretations of one rule are the target for removal.

| Owner           | Responsibility                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Vendored engine | CRDT integration, physical sequence traversal, formatting state, native positions, attribution semantics, and binary encoding.         |
| Edytor document | Logical block identity/order, ownership across split/merge, domain commands and roles, admission policy, and default service lifetime. |
| Editor view     | Browser input intent, focus, composition, rendering, DOM mapping, and view-specific restoration.                                       |

Keep thin `DocBlock` identity-bound delegates. Keep grapheme deletion, collapsed pending marks, decorations, and DOM behavior with their real owners. Do not move all editor policy into generic `Y.Node`, introduce a parallel document authority, or replace the plugin system.

Before each consequential change, record:

1. The required behavior and the owner with enough information, authority, and lifetime to decide it.
2. The independent rule or mechanism that disappears and the invariant replacing it.
3. The public results, error identity/timing, atomicity, ordering, and progress that must remain intact.
4. A second consumer, placement, or concurrent schedule that could falsify the simplification.

Prefer deriving facts and composing existing owners. Do not introduce service registries, general interpreters, wrapper hierarchies, or extension hooks for hypothetical consumers. Moving code or shortening names does not establish compression.

### Distinct lifetimes under one public document

The existing `EdytorDoc` facade is the normal composition boundary. Bind the production engine once. It may coordinate existing services without becoming one mutable bag or requiring another public session object.

| State                                                               | Lifetime and ownership                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Content, placement, ownership, attribution metadata, actor profiles | Replicated/persisted document state.                                      |
| Undo/redo stacks, maintained indexes, caches, origins               | Local document state; history is not a shared all-users stack.            |
| Presence, caret, heartbeat clocks                                   | Ephemeral collaboration state; neither persisted in content nor undoable. |
| DOM nodes, geometry, composition, focus, restoration attempts       | View state.                                                               |

Views and providers borrow document services. Unmounting one view must not destroy another's history, presence, or model state. Document destruction releases resources it owns; borrowing a raw document or provider does not grant destruction authority.

Keep raw `Y.Doc` construction inert for validation, migration, decoding, and tests. Built-in presence need not run a timer in SSR or staging. Network participation still requires transport configuration. History remains usable with no mounted view.

Document-level block roles/defaults must remain valid when a view unmounts. Reuse existing facade configuration for semantic rules; retain snippets and DOM hooks in views. Different views cannot silently impose incompatible structural rules on one document.

Do not collapse distinct freshness tokens: in-transaction model revision, committed semantic-change sequence, block cache version, and asynchronous restoration attempt have different meanings. Reuse an owner's token only when its coverage and lifetime match the consumer.

### Compatibility and boundaries

Validate external input where it becomes a trusted domain value. Preserve separate wire, storage-generation, legacy import, and public input boundaries. Existing membership, concurrency, dependency, and durability checks are execution requirements, not automatically redundant validation.

Preserve existing public behavior except explicitly documented fixes. Keep compatibility adapters thin when needed. Pure reads must not acquire writes, timers, undo state, or item-splitting machinery just for uniformity. Keep failures visible and durable progress distinct from attempted work.

## 4. Intended public API

Illustrative target, **not existing callable APIs**:

```ts
import { createDocument, loadDocument } from 'edytor/crdt/edytor';

const document = createDocument({
	value,
	actor: { id: 'user-42', name: 'Arnaud', color: '#7559ee' }
});

document.history.undo();
document.history.redo();

const saved = document.encode();
const restored = loadDocument(saved, { actor: currentUser });
```

```svelte
<Edytor {document} />
```

Choose final names using existing conventions. Both creation paths expose all required services without opt-in feature plugins. Actor configuration supplies identity; it does not switch attribution on. An account-free session gets an opaque anonymous actor. Preserve historic actor references; unknown imported authors stay unknown.

Fresh creation, restoring saved state, and provider hydration are distinct operations. Restore and validate loaded content/metadata before normal capture. Create a fresh local replica identity on load. Carry logical document identity/schema where required; raw Y update bytes do not represent every application fact. Local undo stacks and online presence need not survive reload by default.

Provider hydration is asynchronous. Complete the selected admission/hydration boundary before deciding to seed an empty document. Distinguish readiness from network synchronization. Attaching history must not bootstrap content. Raw `Y.Doc.load()` already means subdocument loading; do not overload that native meaning.

## 5. Native attribution facts that constrain the implementation

**Attribution is already implemented in v14. Reuse it.** This assignment does not introduce a new tracked-changes product, full audit log, or accept/reject UI.

- Transactions provide `insertSet` and `deleteSet`. Native `ContentAttribute`, `IdMap`, and `ContentMap` associate metadata with CRDT ID ranges; native helpers merge, intersect, filter, encode, and decode them.
- `AttributionsRenderer`, `DiffRenderer`, and node/event delta APIs already interpret those maps. There is no `AttributionManager` class in the reviewed pin; use the actual native APIs.
- Native delta attribution distinguishes insertion, deletion, and per-format authors. Alice inserting `hello` and Bob making it bold can yield `attribution: { insert: ['alice'], format: { bold: ['bob'] } }` beside the normal text/format fields.
- A shared `users[id]` profile dictionary fits native actor references. Keep names/colours outside every range. Native encoding already interns repeated attribute names/values within an encoded map. A probe encoded 100 disjoint ranges with one repeated long actor ID into 437 bytes, containing that string once. This is not an end-to-end size target; separate messages can still repeat IDs.
- `doc.clientID` identifies a replica, not an account, and may rotate after collision. One actor can use several clients. A deletion names the victim's IDs, which cannot identify the deleting actor. Capture authorship at the originating edit; receiving clients must not relabel it.
- `ContentMap` is separate runtime metadata. Raw `encodeStateAsUpdate(doc)` excludes it, and input `applyDelta` attribution is not automatically persisted. Local transaction origins/meta are not transported authorship. Save/load and providers must carry metadata automatically.
- The renderer merges/copies input maps. Mutating the original map does not refresh an existing renderer. Metadata-only changes need explicit affected-view invalidation.
- A renderer covering historical deleted ranges can display them and change lengths/offsets. Even insertion-only historical maps can cover subsequently deleted content. Ordinary authorship views must restrict coverage to live IDs. Deleted/diff views have a separate coordinate/retention contract.
- Visible authorship does not require globally disabling GC. Showing deleted payloads requires retaining them or a suitable previous document for native diff rendering. A merged range map is not an ordered audit history.
- P4 edit/position optimizations currently require `renderer === null`. Automatic capture must not blindly install a renderer that bypasses them. Keep ordinary writes in live-text coordinates and expose attribution through the read projection; prove and measure any alternate editing mode.
- Undo restores content with new item IDs. Naive capture assigns those characters to the undoing actor. For ordinary authorship, preserve the original insertion author on restoration; distinguish the restoring operation if exposed. Integrate with existing undo ownership repair instead of inventing a parallel repair.

Native conversion pattern, shown only to identify the supplied mechanism:

```js
const change = Y.createContentMapFromContentIds(
	Y.createContentIds(transaction.insertSet, transaction.deleteSet),
	[Y.createContentAttribute('insert', actorId)],
	[Y.createContentAttribute('delete', actorId)]
);
```

The integration must choose correct capture timing, exclude its own writes, retain remote authors, and ensure committed readers see the intended metadata. Do not store full rendered deltas per edit, expand spans into per-character author arrays, or rebuild an entire document renderer on every keystroke.

## 6. Work units and dependency order

Each unit must include code, focused behavioral proof, and the actual removal of superseded mechanisms where claimed. Keep a short execution ledger with source identity, decisions, completed checks, and unresolved risks. Reconcile units with changes already made by other agents; do not implement the same fix twice.

| Unit | Outcome                                                       | Depends on                   |
| ---- | ------------------------------------------------------------- | ---------------------------- |
| U0   | Verified current baseline and bounded scope                   | —                            |
| U1   | One document composition/lifecycle owner                      | U0                           |
| U2   | Shared command policy and content preparation                 | U1                           |
| U3   | Native bounded-read proof and implementation                  | U0; align with U1/U6         |
| U4   | Default local history and shared anchor contracts             | U1                           |
| U5   | Default shared awareness                                      | U1; anchor contract from U4  |
| U6   | Native attribution capture and durability                     | U1; coordinate with U4/U8    |
| U7   | Canonical attributed projection and rendering                 | U2, U3, U6                   |
| U8   | Unified admission/create/load/migration boundaries            | U1; storage decision from U6 |
| U9   | Intentional public exports, types, and package graph          | U1–U8 as applicable          |
| U10  | Integrated correctness, compression, and performance evidence | U1–U9                        |

Prototype one attributed range through durability and bounded projection in both headless and Svelte consumers before a broad API/consumer migration. Independent units may progress in parallel when their ownership is clear. The sequence is a dependency guide, not a new production orchestration framework.

### U0 — Re-establish the baseline

Inspect current source, dirty work, hardening results, scripts, and package contracts. Record exact source/harness identity and the default-feature configuration. Reproduce only still-relevant reported issues. Complete relevant hardening prerequisites before building on their invariants; report unrelated failures separately.

Capture baseline correctness and resource/performance measurements for the paths this work changes. Historical bundle and timing reports are context, not current targets. The earlier selected-engine bundle omitted attribution and cannot represent the proposed runtime.

**Done when:** the starting contracts, existing fixes, affected test lanes, reproducible measurements, and actual remaining work are recorded. No claim rests only on stale comments or a moving checkout.

### U1 — Own the assembled document once

Bind the production engine once and reuse the existing facade. Share maintained state, history, awareness, and attribution integration per local document. Remove duplicate default raw-document allocation when a document is injected. Consolidate provider factory implementations currently repeated across CRDT and collaboration modules.

Establish clear owned/borrowed teardown and document-level semantic configuration. Define the public create/load surface and readiness contracts, with U8 completing admission/migration integration. Keep the raw engine and staging path inert.

**Deletion targets:** per-view binding work, duplicate maintained indexes, repeated factories, and view ownership of document-lifetime services. Do not add a generic service container.

**Done when:** headless use and 1/2/10 views share the intended state; unmounting one preserves siblings; no premature seed during hydration; structural rules survive view teardown; document destruction releases its resources exactly once.

### U2 — Resolve command meaning and prepare content once

The UI adapter should admit/resolve paths, selection defaults, and segment offsets, then delegate structural permission and persisted-mark changes to the document. Remove repeated live island/void/ancestry policy and use the existing document clear-marks operation for bound text. Retain placement-level identity/concurrency checks.

Pin the observed move discrepancy explicitly: under parent `p` with siblings `a,b`, the path predicate rejects `[0,0] → [0,1,0]` while `block('a').moveTo({ parent: 'b', index: 0 })` succeeds. If still present, correct and report it as a behavior fix rather than hiding it in cleanup.

Prepare `BlockSpec`/`ContentItem` directly from admitted JSON where `setBlock` currently constructs disposable `Block` trees solely for `_toSpec()`. Reuse/refine the existing converter. Establish one pure grouping rule for live content, drafts, and suggestions: text at both edges, empty text separators between adjacent inline atoms. Keep those caret hosts out of replicated content unless independently required.

**Deletion targets:** the second live command-policy implementation, duplicate live mark-clearing algorithm, redundant JSON converter, disposable view construction, and independent grouping corrections.

**Preserve:** plugin hooks and payloads, refusal/return shapes, transaction grouping, normalization timing, wrapper identity, contextual Enter/default-block policy, actual detached drafts, and grapheme/pending-mark behavior. Converters currently differ in omitted/empty fields and unknown-plugin-type failure timing; resolve those contracts before substitution.

**Done when:** direct document and editor commands agree on applicable moves/mark changes; tests include real descendants, sibling nesting, islands/voids, a same-transaction type change, later text segments, structured marks, missing/explicit IDs, unknown child types, and empty/suggestion content. No wrapper is constructed merely to recover its input shape.

### U3 — Consolidate physical text reading in the vendor

Prototype a small read-only native range cursor using existing traversal/rendering semantics. It must supply bounded interval content, formatting, identities, and native attribution behavior without whole-node materialization. Edytor retains logical ownership, slice selection, inline projection, interning, and immutable publication.

Consolidate the interpretation shared by native full reads and Edytor range reads. Moving the custom implementation under `vendor/` without sharing semantics is not sufficient. Move checkpoint validity toward the engine where integration/split/merge/tombstone facts are known, but retain distinct physical caches when needed.

**Critical counterexample:** in `a[bold=true]b[bold=null]c`, visible offset 1 spans several physical positions. A read checkpoint can sit on `b` after its opening marker; the ordinary mutation cursor stops before that marker. P4 requires the first item at that index. Never equate those seeds solely by visible offset.

**Deletion targets:** Edytor's independent native-item/format interpretation, redundant private item shapes, and checkpoint lifetime machinery actually replaced by native ownership.

**Done when:** bounded output matches the pinned native reference across overlapping/same-index formats, deleted markers, surrogate pairs, inline atoms, attribution, remote integration, undo, and open-transaction reads. Pure reads emit no updates and do not split items. Preserve visited-item bounds. For mutation/checkpoint changes, compare unseeded behavior, anchors, and serialized updates, including a peer insertion at the same boundary. Record any vendor patch and regenerate declarations.

### U4 — Default local history and anchor ownership

Use one native UndoManager with document lifetime, including headless editing. Capture explicit local editing origins and independently exclude remote transactions, hydration/import, schema/profile/attribution bookkeeping, and system repair. Preserve the manager's undo/redo origin so the opposite stack works. Start from existing grouping behavior, including the native 500 ms default, with explicit boundaries for distinct commands and view switches.

History creation must not initialize content. Preserve registry/content-only scope. Integrate the final verified undo ownership repair with history/document lifetime and coherent publication; do not recreate a second repair system.

Unify the selection snapshot contract and compact/native backing-position conversion. History entries carry the initiating view's anchors; restore DOM state only in the appropriate requesting view. Release view listeners on detach/remount and cancel stale asynchronous restoration. Use current block reads rather than a whole projected tree solely to locate one segment.

Keep affinity, append-following slice ends, deleted-target fallback, and undo's use of local redone information distinct. Re-check current wrapper membership when consuming it. History clearing/pruning must release retained native items correctly. Measure retained bytes before choosing a default limit; do not silently inherit unbounded retention or an arbitrary cap.

**Deletion targets:** duplicate default stacks/listeners, parallel snapshot field lists, repeated position codecs/fallback interpretation where meanings match, and unnecessary full-tree lookups.

**Done when:** remote apply with and without an origin never grows local history; two views do not capture the same command into competing default stacks; undo works with no mounted view; another view cannot overwrite snapshots or steal focus; restore survives move/split/merge and rejects stale attempts; clear/close releases retention without harming legitimate owners. Verify attribution on restored items with U6/U7.

### U5 — Default shared awareness

Retain the current protocol and give the document typed actor/selection access. Views and providers share one awareness state. The active local view owns the published caret; tearing down an inactive view must not clear it. Multiple remote clients for one account remain distinct replicas/carets.

Keep liveness activity dormant in SSR/staging and activate it for participating transports. Preserve protocol heartbeat/expiry semantics while publishing only semantically changed selection state. Visual consumers should react to semantic changes rather than duplicate `change`/heartbeat `update` subscriptions. Resolve anchors in the document and DOM rectangles in each view.

Keep durable actor identity separate from presence profiles; offline authors remain resolvable. Ensure client-ID changes do not leave transport identity stale. Retain or version legacy offset fields according to supported-peer contracts.

**Deletion targets:** independently created awareness instances, duplicate visual callbacks, redundant payload recomputation, and per-view ownership of shared liveness resources.

**Done when:** one liveness loop per participating document, none in staging/SSR; 1/2/10 views share protocol state; heartbeat alone causes no unnecessary visual projection; one view/transport disconnect preserves other users of the state; close releases timers/listeners. Count actual callbacks, encoded frames, and renders rather than assuming Svelte renders once per callback.

### U6 — Capture and persist native attribution automatically

Use the native range/map APIs described above. Capture the actor at the originating edit, exclude metadata from recapture/history, retain received attribution, and define capture/publication timing. Use stable actor references and one profile record where needed. Profile changes must not rewrite content attribution.

Resolve metadata durability with a bounded prototype:

| Candidate                                                                                          | Advantage                                                         | Required proof                                                                                                                                               |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reserved replicated metadata root with immutable, independently keyed native encoded range records | Reuses Y update delivery and document persistence.                | Safe capture boundary, no recapture loop, undo exclusion, concurrent offline merge, bounded batching/compaction and no lost metadata.                        |
| Native metadata alongside updates in the versioned Edytor envelope                                 | Keeps compact metadata batches separate from editable structures. | Every save, hydration, reconnect, relay, state-transfer, and compaction path preserves both parts; duplicate/reordered and metadata-only delivery converges. |

Start with the replicated-root prototype; choose the envelope if evidence shows unsafe capture or material write amplification. This is a provisional preference. Record the chosen representation, migration/version implications, and evidence before broad integration. A content state vector alone does not establish metadata completeness.

Never overwrite one shared global attribution blob, encode the complete accumulated map per keystroke, or accumulate an unbounded permanent record for each character/keystroke. Use native encoding/merging, avoid unnecessary timestamps that defeat coalescing, and make retention/compaction correctness explicit.

Preserve original insertion authorship when undo creates replacement item IDs. Keep restoring-operation identity distinct if exposed. Move/split/merge must preserve attribution with character identities. Unknown prior authors remain unknown; login/actor changes cannot relabel history.

**Deletion targets:** no replacement attribution engine is needed; remove any superseded adapter path only when demonstrated. New capture/durability behavior may legitimately add code.

**Done when:** Alice inserts, Bob formats, and Carol deletes with correct native attribution after save/load, offline concurrency, duplicate/reordered delivery, and reconnect. Include one actor on multiple clients, profile changes, metadata-only updates, ownership moves, and undo/redo. Document and metadata survive existing storage admission/version gates; user history excludes bookkeeping.

### U7 — One canonical attributed projection

Extend the existing immutable run contract to carry native attribution beside marks. Preserve ownership intervals and author boundaries. Use the native renderer as the differential reference; consolidate custom interpretation through U3.

Normal reads restrict attribution coverage to live content/format IDs and retain normal editing offsets. Keep deleted/diff view semantics distinct. Update/invalidate only affected projections when metadata changes; source-map mutation alone does not refresh a renderer. Preserve the base write fast path rather than installing a non-null renderer everywhere.

Derive ordered Svelte mark views once at the rendering boundary. Export JSON from the domain representation, not by reconstructing persisted meaning from render-only tuples. Remove duplicate merging of canonical live runs and unnecessary record/tuple round trips. Retain view-only transformations/decorations and draft canonicalization.

Audit `JSONDelta.id` before removal: repository rendering uses index/marks keys while conversion allocates UUIDs, but public consumers may still use the field. Preserve DOM/wrapper identity and public contract compatibility.

**Deletion targets:** independent run coalescing/equality decisions, redundant live conversions, dropped-and-reconstructed metadata, and proven unused render allocations. Useful derived views/caches remain legitimate with clear invalidation.

**Done when:** headless, live, and readonly consumers agree on persisted meaning; identical marks with different authors do not coalesce incorrectly; metadata-only changes are observable; normal offsets remain unchanged; no whole-document export occurs per keystroke. Test mark nesting, transformed code, empty caret hosts, terminal newlines, immutable snapshots, same-transaction reads, and commit-only notifications.

### U8 — Complete admission, creation/loading, and migration integration

Share admission policy without flattening provider algorithms. `checkSchema` already has an owner; wrapping it again is not a gain. Evaluate a conservative native inspection seam for affected-root/parent-key facts so Edytor can retire its `canApplyDirect` parent/origin-resolution mirror. Edytor retains schema policy. Native `getMissing()` mutates transaction state and must not be exposed directly as pure inspection.

Unknown dependencies/effects must stage. Eligibility depends on the current update and document state, not permanent approval. Preserve envelope admission before decoding, storage-generation gates, origin handling, provider signals, corrupt-payload timing, and observer-failure behavior.

Preserve IndexedDB batch admission and atomic live application. A batch may finish compatible despite an incompatible intermediate row; replacing it with per-row live admission changes behavior. Keep refused rows/recovery and storage commit acknowledgement. `_dbref` is fetch progress; `_hydrationRefused` means incomplete snapshot coverage. A later clean schema cannot make missing bytes disposable.

Separate schema stamping from fresh-content bootstrap in the existing document owner. Reuse stamping for empty migration without producing a competing bootstrap block. Loading must not replay fresh defaults or start capture early.

Prepare migration's admitted logical JSON with deterministic missing IDs once, then lower it into `BlockSpec`. Remove duplicate fallback-ID assignment in reconstruction and expected-output preparation. Keep an independent encode → fresh-document decode → logical readback comparison against that prepared source; never derive the expected value from the rebuilt document.

**Deletion targets:** the application-side native dependency mirror if the prototype replaces it, repeated protocol admission interpretations, direct schema stamping outside its owner, and duplicate migration identity policy. Do not invent a general update-planning language or remove distinct trust/progress boundaries.

**Done when:** parentless schema overwrites, pending dependencies, delete-only updates, first-contact versus ordinary updates, refused storage rows, and abort-after-request-success preserve existing guarantees. Empty migration merged into an edited live document creates no competing bootstrap; two fresh editors still converge correctly. Missing nested IDs, concurrent migrators, and resumed acknowledged migration phases verify correctly. Create/load includes attribution without implicitly restoring presence/history.

### U9 — Public surface, declarations, and vendor/package organization

Expose one normal document entry with all required capabilities, a Svelte rendering entry, explicit transport/migration entries, and advanced raw-engine access. Keep one engine copy in packed consumers. Re-export shared provider factories rather than maintaining duplicates.

Keep the useful `engine.js`/declaration boundary. Re-test handwritten engine interfaces against current generated declarations through real facade consumers; derive types where they work and retain narrow documented boundaries where they do not. A successful native API smoke is not proof every generic consumer compiles. Do not replace casts with elaborate generic machinery or pull vendor JS into application checking unnecessarily.

Keep upstream provenance, patch manifests, reproducible generated declarations, and upstream tests outside the shipped graph. Trim based on actual published imports and supported format contracts. Renderer/ID machinery, native undo retention, decoder table entries, and V2 pending-update codecs are not dead because public code does not instantiate them directly.

**Deletion targets:** superseded factory/export paths, unnecessary handwritten native shapes, accidental transport/migration imports, and code demonstrated unreachable under supported contracts. File moves alone count as no source/bundle reduction.

**Done when:** packed Node and Svelte consumers use the simplified API with one engine instance; declarations match runtime; offline creation excludes unnecessary transport/migration code; compatibility boundaries and supported formats remain explicit; real default-feature bundle sizes are recorded.

### U10 — Integrated qualification and honest measurement

Review the integrated code before expensive qualification. Freeze source/harness identity for final evidence. Keep failures failed and historical artifacts intact; later fixes receive new attestations. If concurrent work changes relevant code, identify which evidence must be rerun rather than claiming a moving-target result.

Run the existing relevant lanes, checking current scripts first:

```sh
pnpm check
pnpm lint
pnpm test -- --run
pnpm test:dom
pnpm test:typecheck
pnpm test:dom:typecheck
pnpm test:crdt
pnpm test:integration:serial
pnpm build
```

Run the extensive upstream CRDT lane for the applicable native changes, plus the packed-consumer check at `tests/packed-consumer/run.sh`. Use focused existing tests while developing; do not repeatedly rerun unrelated full lanes without a change or unresolved concern. Browser proof must include affected real editing/collaboration flows; report unavailable lanes exactly.

Measure the completed default runtime with existing benchmark tooling (`bench:crdt`, `bench:runs`, `bench:browser`, and packed consumer builds), extending workloads only where required:

| Workload                                          | Evidence to collect                                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 100k-character single-author paragraph            | Interval count, range work, edit/read p50/p95, allocations.                                                |
| Fragmented multi-author text and heavy formatting | Author/format boundaries, bounded reads, distant edits, P4 eligibility and active-attribution cost.        |
| Deletion/undo churn                               | Correct restoration, original authorship, retained structs/bytes, clear/prune/close behavior.              |
| 5k-block document                                 | Local-command/projection work, full exports avoided, structural move/split/merge cost.                     |
| 1/2/10 views and many remote cursors              | Shared state, listener/timer counts, callback/frame counts, per-view geometry work.                        |
| Reconnect, save/load, offline merge               | Update/attribution bytes, admission cost, metadata completeness and compaction safety.                     |
| Packed Node/Svelte consumers                      | Published declarations, single engine copy, actual minified/gzip/Brotli assets with all defaults included. |

Separate engine mutation, model projection, DOM reconciliation, layout, and scheduling costs. A callback at `requestAnimationFrame` is not proof of completed paint; do not subtract differently bounded measurements and name the remainder as a subsystem's cost.

Choose justified performance budgets from the baseline and workload before final tuning. Report added attribution work honestly. Reject improvements obtained by dropping attribution, subscribers, validation, undo semantics, or retention obligations. Do not promise constant cost when every character has a genuinely different author/format boundary.

Report semantic compression separately: production code added/removed across the whole touched perimeter, independent rules retired, exceptional paths removed, and actual extension cost across native, headless, and UI consumers. Separate tests, evidence, and comparison specimens. No arbitrary LOC percentage overrides correctness.

**Done when:** all applicable checks and acceptance witnesses have identified results; performance/bundle claims are reproducible; unexplained regressions or incomplete contracts are resolved or explicitly reported as unfinished.

## 7. Decision gates and scope limits

Required outcomes are fixed; these implementation choices remain evidence-dependent:

| Decision                            | Initial direction                                     | Gate                                                                                                                              |
| ----------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Attribution durability              | Prototype replicated native-metadata records first.   | Demonstrate convergence, safe capture, compaction, and acceptable write amplification; otherwise evaluate the versioned envelope. |
| Native range/read checkpoint design | Share native interpretation; preserve bounded access. | Prove read/write phase distinctions and native output/anchor equivalence before replacing current paths.                          |
| Native update inspection            | Conservative engine facts, Edytor schema policy.      | Replace independent integration interpretation without mutating inspection or weakening staging/admission.                        |
| History retention                   | Explicit release/pruning owned by history.            | Select a default from retained-memory evidence and preserve undo ownership.                                                       |
| Native types                        | Prefer current generated declarations where usable.   | Actual facade and packed consumers compile without broad casts or lost safety.                                                    |

Record outcomes of these bounded proofs. Do not preserve a failed candidate as a hidden fallback or silently omit a required capability. A consolidation that does not remove an independent rule or improve a real boundary may be declined with evidence; it does not justify broader unrelated refactoring.

Out of scope: a new CRDT algorithm, attribution reimplementation, full ordered audit-history product, new accept/reject UI, automatic unlimited deleted-content retention, unrelated plugins/UI redesign, hosted authorization/backend deployment, and unsupported wire compatibility promises.

## 8. Evidence carried forward and required deliverables

The prior investigations changed no production code. They independently ran narrow probes against the then-current tree:

- Native attribution: input delta attribution alone was not persisted; captured native maps produced insertion/format/deletion authors; map mutation left an existing renderer stale; document-only save lost metadata while a native-map round trip retained it; repeated actor encoding deduplicated; naive undo relabeled restored content; GC prevented recovery of deleted text payloads.
- Lifecycle: remote no-origin apply entered default undo history; two managers captured one null-origin edit; duplicate awareness instances shared a client ID but held separate state; destroying awareness/history alone left the observed hooks/retention behind.
- Move policy: the exact UI predicate rejected `[0,0] → [0,1,0]`, while the real domain operation moved `a` under sibling `b`. This was not a mounted UI test.
- Native types: a strict `NodeNext`/`ES2022` consumer smoke with `skipLibCheck` compiled basic native node/doc, formatting, renderer reads, item references, and relative positions. The full facade and dependency declarations were not qualified by that smoke.

These are reproducible observations to turn into relevant maintained witnesses, not proof that the new integration works. Temporary `/tmp` probes may be gone. Their described inputs/results and the supporting source notes are enough to recreate focused tests; do not make the handoff depend on those files.

Deliver:

1. The integrated implementation and deletion of superseded mechanisms, preserving concurrent user work.
2. Public create/load/edit/history/presence/attribution/close documentation and examples, including ownership and readiness.
3. Focused behavioral and concurrency tests plus applicable full-lane results.
4. Exact-identity benchmark, resource-lifetime, packed-consumer, and compression evidence.
5. Updated vendor patch/declaration provenance and applicable project documentation when durable contracts change.
6. A concise report following the repository's Outcome / Validation / Risks convention, distinguishing achieved results, intentional behavior fixes, unavailable checks, and any required work still incomplete.
