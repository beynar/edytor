# sync-collab domain — architecture reading (READ-ONLY)

Scope: `src/lib/crdt/providers/**` (1098 xloc), `src/lib/crdt/protocols/**` (508), `src/lib/crdt/migration/**` (519), `src/lib/collaboration/**` (666) = **2791 xloc**.
Repo: `/Users/arnaud/code/edytor` @ `feat/crdt-v14-engine` (d9b7de0 + working tree). All line refs are to that tree.
Probes written for this reading live in `scratchpad/probes-sc2/*.test.ts` (run with `npx vitest --config scratchpad/probes-sc2/vitest.probe.config.mjs --run`); results quoted inline as **[P1]..[P8]** (P2b, P3b, P4b, P4c, P6b are variants).

---

## 1. Required behavior (guarantees, no implementation names)

Evidence column = the test/spec that pins it today (primary evidence) or the doc sentence that states it.

### 1.1 Convergence and transport

| # | Guarantee | Tag | Evidence |
|---|---|---|---|
| G1 | Replicas that have received the same set of edits hold identical content, independent of delivery order, duplication, delay, or loss that is later healed. | [collab-invariant] | `src/tests/crdt/providers/sync.test.ts:82`; `tests/editor-dom/collaboration-websocket.spec.ts:311`; `…-3client.spec.ts:417` |
| G2 | After a partition, reconnecting replicas exchange exactly what the other lacks; edits made on both sides survive. | [collab-invariant] | `sync.test.ts:50,117`; `collaboration-multiclient.spec.ts:378`; `collaboration-websocket.spec.ts:241` — **violated over the websocket path with library defaults, [P5] §7 C7** (the specs force `resyncInterval`) |
| G3 | Tabs of one browser collaborate with no server; a byte-forwarding relay (no payload understanding) is enough across browsers. | [collab-invariant] | `collaboration-multiclient.spec.ts` (two pages, one context); `websocket.test.ts:95`; `tests/editor-dom/ws-relay.ts` |
| G4 | A change received from one transport is not echoed back to it, but IS forwarded/persisted by every other transport attached to the same document. | [collab-invariant] | `src/tests/crdt/gate2/lifecycle.test.ts:244` (WS-received update persisted by the IDB provider) |
| G5 | Remote changes never enter local undo; undo removes only the local user's own edits and the inverse replicates. | [collab-invariant] | `collaboration-multiclient.spec.ts:192`; `…-3client.spec.ts:499`; `collaboration-websocket.spec.ts:373` |
| G6 | A malformed or truncated frame is dropped and reported; it never throws into the sender (same-tab channel delivery is synchronous) nor the receiver's event loop. | [browser-constraint] | `src/tests/crdt/gate2/envelope.test.ts:224,257`; `gate2/sync-corrupt.test.ts:11` |
| G7 | Every failure mode is observable as an event, not console output: incompatible peer, undecodable/unknown message, incompatible schema, permission denied, storage load failure, storage write failure. | [user-visible] (operator) | `docs/crdt-v14-providers.md` §Error and signal events; `websocket-events.test.ts:203,237`; `r2-idb-compaction.test.ts:383` |
| G8 | A server's permission denial is observable and terminal for that provider's sync. | [user-visible] | `websocket-events.test.ts:203` |

### 1.2 Readiness (who decides the initial content)

| # | Guarantee | Tag | Evidence |
|---|---|---|---|
| G9 | Nothing is seeded, shown as "ready", or broadcast as a bootstrap before persisted/remote state has had its chance to arrive. A genuinely empty room is seeded exactly once; concurrent seeds converge to one bootstrap block. | [user-visible] | `src/tests/crdt/document/readiness-hydration.test.ts:37,83`; `gate2/compaction-schema.test.ts:187` — **violated when IDB + WS are combined, [P4]/[P4b] §7 C5-C6; never reached for the first websocket client, [P6b] C8** |
| G10 | "Synced" is claimed only when the replica reflects the answering side's state: an answer carrying state, or a room verified empty twice. A foreign empty answer, or a refused answer, never claims it. Worst-case empty-room decision is bounded (2 × settle window). | [collab-invariant] | `websocket.test.ts:201,237,266,304,336`; `schema-boundary.test.ts:436` |
| G11 | A provider that can never become synced (destroyed first, storage unreadable, denied, refused hydration) says so exactly once; a transient disconnect and a provider that **already synced** never do. The content decision then returns to the view (no view hangs unsynced forever). | [user-visible] | `src/lib/crdt/providers/index.ts:16-21`; `lifecycle-failure.test.ts:90,112,122,146`; `document-sync.test.tsx:164` — **violated for websocket, see [P1] §7** |
| G12 | Several views of one document share one provider per transport target; unmounting one view never tears down the provider its siblings use; provider lifetime = document lifetime for shared documents, component lifetime for view-owned ones. | [user-visible] | `document-sync.test.tsx:45,69,90,151`; `presence.test.ts:259,280` |

### 1.3 Compatibility boundaries

| # | Guarantee | Tag | Evidence |
|---|---|---|---|
| G13 | Replicas of a different engine generation never exchange document bytes with this one, in either direction, on any transport; the drop is observable. | [collab-invariant] | `gate2/envelope.test.ts:96,122`; `sync.test.ts:140`; `websocket.test.ts:162` |
| G14 | Stored bytes are applied only from a container provably written by this generation; anything else fails closed (observable, no sync claim). Legacy containers are never read by the provider. | [collab-invariant] | `persistence.test.ts:132,156,179,198` |
| G15 | A replica never ends up **owning** a document stamped with a schema it cannot speak (unversioned / unsupported / foreign manifest), whether the bytes came from a peer, from storage, or from a raw write before readiness. | [collab-invariant] | `schema-boundary.test.ts:224-613`; `gateF1/wu3b-staging.test.ts`; `collaboration-multiclient.spec.ts:264`; `…-3client.spec.ts:565` |
| G15′ | (What G15 is *documented* to mean — "incompatible data never mutates the live document", `docs/crdt-v14-providers.md:139-144,188-189`.) | [collab-invariant] | **Not delivered today: only the stamp is guarded, content from an incompatible writer integrates — [P2] §7.** |

### 1.4 Persistence

| # | Guarantee | Tag | Evidence |
|---|---|---|---|
| G16 | Every local change is durably appended; a cold reload restores it and rejoins collaboration. | [user-visible] | `persistence.test.ts:80`; `collaboration-multiclient.spec.ts:224`; `collaboration.spec.ts:45` |
| G17 | Stored growth is bounded: past a threshold the store compacts to a snapshot (+ later rows) that reconstructs the same document. | [user-visible] | `persistence.test.ts:98`; `gate2/compaction-schema.test.ts:48,91` |
| G18 | Compaction deletes only bytes the replacement snapshot provably represents — never bytes the document did not integrate. | [collab-invariant] | `r2-idb-compaction.test.ts:107-383` |
| G19 | Probing for a document's storage never creates storage. | [browser-constraint] | `migration-probes.test.ts:34,61` |

### 1.5 Presence

| # | Guarantee | Tag | Evidence |
|---|---|---|---|
| G20 | Each remote collaborator's caret/selection renders at the content it was placed against and follows concurrent edits; label + color from the peer's profile. | [user-visible] | `collaboration.test.tsx:36,53,117`; `collaboration-multiclient.spec.ts:162`; `collaboration-websocket.spec.ts:205` |
| G21 | A detaching view removes its own caret for peers; sibling views of the same client keep theirs; a departed/disconnected client disappears from peers (announce on leave, timeout otherwise). | [user-visible] | `presence.test.ts:90,112,135,154`; `collaboration.spec.ts:83`; `lifecycle-failure.test.ts:309` |
| G22 | Presence writes never create document updates or undo steps; malformed peer presence is ignored, never crashes, never renders at a wrong offset. | [collab-invariant] | `presence.test.ts:173`; `collaboration.test.tsx:142,180` |
| G23 | Unchanged presence is not re-broadcast. | [collab-invariant] (bandwidth) | `presence.test.ts:429,461`; `elegance-awareness.test.ts:190` (test file; titles only used) |
| G24 | Remote carets stay on their anchor when the page scrolls or re-lays out. | [user-visible] | **No test, not implemented** — missing requirement (see §7 C12). |
| G25 | No layout reads for presence when there are no remote peers. | [browser-constraint] (perf) | `remoteSelection.ts:258-262` comment; no dedicated test |

### 1.6 Migration (v13 → v14)

| # | Guarantee | Tag | Evidence |
|---|---|---|---|
| G26 | A v13-persisted document's logical content (tree, marks, inline atoms, data, logical ids) appears for v14 clients; CRDT identity/history does not survive and is not claimed to. | [user-visible] | `migrate.test.ts:85,110,138` |
| G27 | The legacy store is never written; rollback is always possible and is an explicit operator act. | [collab-invariant] | `migrate.test.ts:110,252` |
| G28 | A migration never activates a truncated or unverified document (missing causal deps fail closed; logical equality verified before activation). | [collab-invariant] | `migrate.test.ts:92`; `gate2/migration-adversarial.test.ts:100,213` |
| G29 | Concurrent/interrupted migrations produce one consistent result without duplicated content; migrating while a live provider writes the same container loses none of that provider's rows. | [collab-invariant] | `migrate.test.ts:175,190,202,227`; `gate2/migration-adversarial.test.ts:166,255` — **the "force" recovery path violates the spirit of this, [P3]/[P3b] §7** |

### 1.7 Lifecycle

| # | Guarantee | Tag | Evidence |
|---|---|---|---|
| G30 | Teardown is idempotent; a provider destroys presence state only if it created it. | [collab-invariant] | `persistence.test.ts:213,227`; `gate2/lifecycle.test.ts:133,166` |
| G31 | Background timers never keep a server-rendering process alive. | [browser-constraint] | `docs/archive/crdt-v14-browser-proof.md` §7 (SSR awareness timer) |
| G32 | Tab close / process exit announces presence removal (best effort). | [browser-constraint] | `indexeddb.ts:545-548`; `websocket.ts:485-490` — the two providers decide this differently (WS: Node `exit` only), §7 C13 |

### 1.8 Test-only requirements (seams the suites depend on; not user guarantees)

| # | Requirement | Tag | Evidence |
|---|---|---|---|
| T1 | Persistence can be flushed on demand and the flush settles only after the storage transaction commits. | [test-only] (also used by the timed path) | `r2-idb-compaction.test.ts:358`; browser hooks `window.__EDYTOR_COLLAB__`/`storeState` (`docs/archive/crdt-v14-browser-proof.md:33-43`) |
| T2 | A provider's message entry point accepts forged frames directly. | [test-only] | `indexeddb.ts:559-564` ("the gate-2 probes call it directly"); `websocket-events.test.ts:92-95` (`deliverTo`) |
| T3 | Migration phases are observable/interruptible (`onPhase` throws simulate crashes). | [test-only] | `migrate.ts:153-154`; `migrate.test.ts:202,227` |
| T4 | Transport timings (`resyncInterval`, `maxBackoffTime`, `syncSettleMs`) are injectable for determinism — and every browser/DST run sets `resyncInterval` (200–250 ms), which hides [P5]/[P6b]. | [test-only] | `src/routes/test/dom/+page.ts:30`; `tests/editor-dst/collab-runner.ts:229` |
| T5 | Provider private state (`_dbref`, `_hydrationRefused`, `ws`, `_dbsize`) is reachable from tests (`@ts-nocheck` suites). | [test-only] | `gateH-r2-probes.test.ts`, `r2-idb-compaction.test.ts`, `websocket-events.test.ts` |

---

## 2. Real constraints (what the engine, the browser and Svelte actually force)

### 2.1 Vendored Yjs v14 engine (`src/lib/crdt/vendor/yjs`)

- **E1 — Update payload shapes differ by producer.** `doc.on('update')` payloads carry only the transaction's delete set; `encodeStateAsUpdate(doc, sv)` carries the *whole* delete set. Consequence observed in [P2 first variant]: a diff built with `encodeStateAsUpdate(b, sv)` after a refused `meta.v` overwrite also carries the deletion of the old `meta.v` item and is refused as `unversioned` (misclassified), while the provider-broadcast transaction payload of the same edit is accepted. Any gate that inspects payloads sees different verdicts for the same logical edit depending on who encoded it.
- **E2 — Clock gaps integrate via `Skip`, not pending.** [P2b]: applying `Item(2:1+3)` without `2:0` leaves the store as `Skip(0+1) Item(1+3)`, `pendingStructs == null`, state vector `[[2,0],…]`, and the text is visible. So refusing one update from a peer does **not** hold back that peer's later updates — they integrate immediately. This single fact decides how much a per-update schema gate can promise (§7 C2).
- **E3 — Missing *origins* still pend.** [P3b]: rows whose left/right origin items were in an overwritten snapshot remain in `store.pendingStructs` forever. Pending state is sticky and invisible in the projection.
- **E4 — Map attrs are LWW; concurrent same-key writes resolve by clientID, causally later writes win deterministically.** This is what makes the registry-keyed-by-logical-id dedupe work (`edytor-doc.ts:36-44` bootstrap), what makes `meta.v` "coexistence" LWW, and what makes the forced re-migration a per-block coin flip ([P3]).
- **E5 — Origin is the only remote/local discriminator.** `transact(doc, f, origin, local)`; undo tracks a set of origins (`document.ts` `_trackedOrigins = {view transaction, null}`), providers suppress echo with `origin !== this`. Therefore every remote apply must carry a non-null, untracked origin (`sync.ts:54-73`).
- **E6 — Idempotent, commutative integration of complete updates.** Re-applying identical structs is a no-op — the property that makes duplicated/permuted delivery safe (G1). It does *not* make two imports of the same JSON idempotent: each import mints fresh identities (random clientID), so identical logical content collides by LWW instead of deduplicating ([P3]).
- **E7 — Lossy updates can crash integration.** `docs/crdt-v14-providers.md:659-682` (seeds 86/140): a `Skip` covering more than the `GC` it replaces corrupts the struct store. Providers must only ever emit complete updates/state-vector diffs (they do).
- **E8 — Schema-relevance of a struct is not local.** A parentless wire item inherits parent/parentSub from its origin chain (`getMissing`), so "does this update write under `meta`?" requires resolving origins through the update and the live store — the reason `canApplyDirect` re-implements engine resolution (`sync.ts:190-300`).
- **E9 — One engine instance per graph.** Runtime-importing any npm `@y/*` instantiates a second engine and breaks `instanceof` (`docs/archive/crdt-v14-provider-research.md:49`); hence every module takes the engine by injection (`bind*(Y)`). This is why the domain is shaped as closures over `Y`.
- **E10 — No in-engine awareness.** Presence is a separate protocol: per-client LWW clock map with a 30 s expiry and a 15 s heartbeat (`awareness.ts:24,85-112`).
- **E11 — Anchors resolve only once their atom is integrated.** `resolveTextAnchor` returns null for a not-yet-integrated or hidden atom (`selection.svelte.ts:2070-2080`).

### 2.2 Browser

- **B1 — `indexedDB.open(name)` creates a store-less database when absent.** Probing must abort the upgrade (`migrate.ts:181-197`) or consult `indexedDB.databases()` (`migrate.ts:288-297`).
- **B2 — IndexedDB serializes readwrite transactions with overlapping scope; a transaction auto-commits when it has no pending requests.** A read-modify-write inside one readwrite transaction is an atomic claim (`migrate.ts:402-425`); commit observation needs listeners attached while the transaction is still active (`indexeddb.ts:310-322`). The same serialization is what makes fetch-cursor + delete-boundary inside one transaction safe.
- **B3 — BroadcastChannel is connectionless and same-origin; lib0's shim delivers same-tab publishes synchronously and propagates subscriber exceptions into the publisher.** No handshake is possible, so every message must be self-validating (the envelope word does this), and subscribers must catch (`room.ts:310-327`).
- **B4 — WebSocket `onclose` is not guaranteed on network loss.** Liveness must be inferred from inbound silence (`websocket.ts:491-500`, 30 s).
- **B5 — Range geometry is viewport-relative and stale after any scroll/layout change.** `getClientRects()`/`getBoundingClientRect()` values used for a `position: fixed` overlay (`RemoteSelections.svelte:77-82`) are valid only until the next scroll/resize.
- **B6 — `beforeunload`/process `exit` are best effort.** Departure announcements cannot be guaranteed; the peer-side timeout (E10) is the real guarantee.
- **B7 — Node timers keep the process alive unless `unref()`ed** (SSR renders construct presence objects whose client teardown never runs).
- **B8 — Composition owns the DOM under the caret.** Remote integration during IME composition must not remount or re-render the composing text node (pinned by `tests/editor-dom/composition-remote-lock.spec.ts`, 7 tests). For this domain it follows that the presence overlay must live outside the editable (`RemoteSelections.svelte:53`, `contenteditable="false"`). Remote applies must also stay distinguishable from local ones: via their origin (E5) and via the engine's `transaction.local === false` for decoded updates, which the view reads as `change.local` (`edytor.svelte.ts:861`).

### 2.3 Svelte 5 runes

- **S1 — Non-rune event sources must be bridged into a `$state` read.** A `$derived` that reads awareness/doc state recomputes only when some `$state` it read changes, so presence rendering needs an explicit invalidation counter (`RemoteSelections.svelte:12-16`). Exactly one such counter per consumer is required; any other counter nobody reads is dead weight (§3 F12).
- **S2 — `onMount` is client-only.** Providers must be attached from mount (or document level), never during SSR construction (`Edytor.svelte:123-141`).
- **S3 — Keyed `{#each}` uses empty text nodes as fragment anchors.** Remote structural moves reorder those anchors; anything that removes "junk" empty text nodes corrupts reconciliation (the 80 s freeze in `docs/archive/crdt-v14-browser-proof.md` §5). Not in this domain's files, but it is the reason remote structural edits are safe only while the mutation observer leaves anchors alone.


---

## 3. Fact → authoritative owner → lifetime → consumers

⚑ = decided in more than one place (every decider listed with file:line). "Owner" is who *should* own it given information + lifetime + authority; "today" says where it is actually decided.

| # | Fact | Should-own (info + lifetime + authority) | Lifetime | Consumers | Deciders today |
|---|---|---|---|---|---|
| F1 | Is this frame from a compatible engine/wire generation? | The frame reader, once, before any decode | per frame | dispatch, observability | `room.ts:278` (`readProtocolVersion`) — single reader ✔. **Writers**: header `writeProtocolVersion + writeVarUint(type)` hand-repeated at `room.ts:337-338, 353-354, 373-374, 382-383, 390-391, 395-396, 411-412`, `websocket.ts:187-188, 347-348, 354-355, 465-466`, `migrate.ts:269-270` (12 sites). One rule, 12 places that must remember it. |
| F2 ⚑ | Is this storage container this generation's (and may it be stamped)? | The container opener, once per open | per container | provider hydration, migration | `indexeddb.ts:162-180` stamps **only if the updates store is empty**, else `GenerationMismatchError`; `migrate.ts:451-454` stamps **unconditionally** (overwrites a foreign record, stamps a populated foreign store). Store creation also duplicated: `indexeddb.ts:425-427` vs `migrate.ts:166-169`; row decode duplicated `indexeddb.ts:74-82` vs `migrate.ts:160-164`; store names `indexeddb.ts:63-64` vs `migrate.ts:74-75`. |
| F3 ⚑ | Does integrating these bytes leave a schema this build can own? | Today: every byte-entry point. (§6 R1 argues the channel/container should own it once.) | per update / per row / per load | live doc, storage, broadcast | Staging (scratch = live + bytes → `checkSchema`) implemented **three times**: `sync.ts:358-373` (transport), `indexeddb.ts:198-251` (hydration: batch fast path + per-row surgical path, does not reuse the transport one nor `canApplyDirect`), `admission.ts:183-192` (`loadDocument`). Fast-path proof `sync.ts:190-300` re-derives `checkSchema`'s read set (`edytor-doc.ts:304-320`) — silently unsound if `checkSchema` ever reads a fourth thing. |
| F4 ⚑ | Is *our own* doc currently in a schema-problem state? | The document (it changes only through integration) | per doc state transition | outbound gates | Re-evaluated at **8** sites: `room.ts:216` (Step1 reply), `room.ts:246` (post-apply recheck), `room.ts:380` (connect Step2), `indexeddb.ts:303` (storeState), `indexeddb.ts:464` (pre-hydration persist), `indexeddb.ts:507` (**every local update**), `websocket.ts:479` (**every local update**), plus `document.sync()` re-check (`document.ts:629-632`). Dedupe of its signal: `_schemaGateKey` (`room.ts:115-123`) per provider instance. |
| F5 ⚑ | Has this provider reached synced? | The provider — but as **two** facts: *connection currently synced* (transient) vs *has ever synced* (lifetime) | connection / provider lifetime | factories, document, `failed` | IDB claims in `indexeddb.ts:581-587`; WS sets true `websocket.ts:251-252, 195`, resets false `websocket.ts:284, 314`. `emitFailed` (`room.ts:140-144`) reads the **connection-scoped** WS flag as if it were the lifetime fact → **[P1]**. Factories re-interpret: `providers/index.ts:60` (`'synced'` event) vs `providers/index.ts:79-83` (`'sync'` boolean, calls `synced(provider)` on **every** reconnect — made harmless only by the document's own latch, F6). |
| F6 ⚑ | Is some provider still in flight for this document? | The document | until first decision | views, facade | Three representations: `document.ts:431,874,888-893` (`_pendingSyncs` counter), `edytor-doc.ts:820,2599-2605` (facade `syncPending` boolean, toggled from the document at `document.ts:880,892,628`), per-attach `pending` closure `document.ts:882-901`. Plus the provider-side `_failedEmitted` latch (`room.ts:128-144`). Four latches for one lifecycle. |
| F7 ⚑ | Has a provider terminally failed? | The provider (only it knows the failure class) | provider lifetime | document → views | Provider: `indexeddb.ts:445-450, 479-484, 614-620`, `websocket.ts:199-207, 533-538`, latch `room.ts:140-144`. Document **re-decides**: cleanup-before-sync and throwing factory are also "failed" (`document.ts:923, 928, 948`), sticky `_syncFailed` (`document.ts:898`). View reads `syncFailed && !syncPending` (`documentSync.ts:116`). |
| F8 ⚑ | Is the document's initial content decided (ready)? | The document | document lifetime | every view | `document.ts:621-667` (`sync()`, the owner). Mirrored/polled: `Edytor.synced` `$state` (`edytor.svelte.ts:188, 824`), `whenDocumentReady` = `onReady` + `onSyncSettled` + **50 ms poll "in case a future readiness path bypasses both events"** (`documentSync.ts:85-123`), plus the view's own `setTimeout(0)` self-decision (`edytor.svelte.ts:773-800`). And — see [P4]/[P4b] — the decision is taken by the **first** provider's `synced` (`document.ts:919-920`), not by the set of attached providers. |
| F9 ⚑ | Which providers are attached to this document (dedupe)? | The document, keyed by **transport target** (db name / server+room) | document lifetime | views | Module-level `WeakMap<EdytorDocument, Set<EdytorSync>>` keyed by **factory identity** (`documentSync.ts:35, 48-67`) + the document's `_syncCleanups`/`_pendingSyncs` (`document.ts:430-431, 874, 952`). Identity ≠ target: `createIndexeddbSync('room')` inlined per view makes two providers on one db (`documentSync.ts:20-22` admits it). |
| F10 ⚑ | Join handshake: who sends what when a replica (re)joins a room? | One transport-agnostic rule, derived from state vectors | per join | convergence (G2), readiness | BC join **pushes**: Step1 + full Step2 + query + own presence (`room.ts:365-402`). WS join only **pulls**: Step1 (+ presence) (`websocket.ts:345-361`) — correct only behind a *participating* server, which `docs/crdt-v14-providers.md:425-463` declares unsupported. Result **[P5]**: offline edits of a reconnecting client never reach peers with default `resyncInterval = -1`; **[P6]/[P6b]**: the first client of a room never syncs, even after others join and seed. Every browser spec/DST run forces `wsresync=200/250` (`src/routes/test/dom/+page.ts:30`, `collab-runner.ts:229`), so the suite never sees the default. |
| F11 | Is an (empty) room answer evidence the room is empty? | Nobody can know over an opaque relay (missing fact: membership) | per handshake | readiness | WS settle heuristic `websocket.ts:150-197, 237-257, 274-281, 542-546`; armed only by an applied Step2, so zero-member rooms never settle ([P6]). |
| F12 ⚑ | Remote-presence geometry must be recomputed | The overlay component | component lifetime | overlay `$derived` | `RemoteSelections.svelte:12-16, 27-29, 42-43` (read ✔). `Edytor.remotePresenceRevision` (`edytor.svelte.ts:187, 468-470, 614, 645, 875, 2205`) is **written and never read** anywhere in `src/` (grep) — dead invalidation; tests call `edytor.refreshRemotePresence()` believing it refreshes the overlay (`collaboration.test.tsx:31,75,172,209`, `tests/editor-dom/collaboration.spec.ts:35`). |
| F13 ⚑ | The published local caret (wire form) | The selection (owns the caret) | while the view lives | peers | Published as **three encodings of one caret**: anchors `start/end`, `startTextId/endTextId + yStart/yEnd`, and the `selection` mirror of the freshest `selections[viewId]` entry (`awarenessSelection.ts:235-263, 219-233`). Consumer resolves anchor, falls back to id+offset (`remoteSelection.ts:282-287`), falls back to mirror (`remoteSelection.ts:62-71`). |
| F14 ⚑ | Which view owns which presence entry? | The view (it knows its own id and its own teardown) | view lifetime | teardown, sweep | Reconstructed by registries because teardown calls `clearAwarenessSelection(awareness)` **without the view's identity** (`selection.svelte.ts:670`): `viewPresenceIds` (`awarenessSelection.ts:124-133`), `presenceOwners` (`142-150`), `sweepDestroyedViews` polling `edytor.destroyed` on every publish/clear (`169-186, 284, 370`). |
| F15 ⚑ | Did the published presence change (skip broadcast)? | The single write point | per publish | bandwidth (G23) | `selection.emittedStatesMatch` (`selection.svelte.ts:453-470`), `publishedEntryEquals`+`anchorsEqual` (`awarenessSelection.ts:312-353`), final `jsonValuesEqual` guard (`400-405`), `clearAwarenessSelection` `unchanged` (`299-301`), and the engine-free `Awareness.setLocalState` deep-equal for `'change'` (`awareness.ts:164`) — five equality decisions. |
| F16 | Has a peer left? | Awareness (timeout) + transport (close) | per peer | overlay | Timeout `awareness.ts:85-112`; WS close drops all remote states `websocket.ts:286-292`; BC leave broadcast `room.ts:409-417`; exit/unload `websocket.ts:485-487`, `indexeddb.ts:543-548`. Different triggers, same effect — acceptable (B6: announcements are best effort). BC-only providers never drop remote states locally on `disconnectBc` (asymmetry, not duplication). |
| F17 ⚑ | Stored-row key policy of the `updates` store | The storage owner (one writer discipline: append-only) | container lifetime | hydration, compaction | Provider: append (`addAutoKey`) + delete `< _dbref` (`indexeddb.ts:326-332, 513`). Migrator: **overwrite** fixed key 0 with `put` (`migrate.ts:87, 571-579`). Two writers, two disciplines in one store → **[P3b]** (orphaned rows pend forever) and **[P3]** (per-block coin flip). |
| F18 | Migration progress (none/pending/active/failed/rolledback) | The migrator | generation lifetime | boot recipe, other tabs | `migrate.ts:91-105, 402-446, 480-511, 581-597, 616-631`. Waiters poll + BC nudge; the nudge's enveloped JSON payload (`migrate.ts:267-273`) is **never decoded** — `waitForSettled` subscribes `() => void check()` (`migrate.ts:325`). |
| F19 ⚑ | Logical id for an id-less legacy block/atom | One JSON normalization pass | migration run | rebuild, verify | `blockToSpec` fallback (`migrate.ts:209-236`) and `withFallbackIds` (`migrate.ts:245-256`) — same policy twice so verify can compare; a third JSON→spec converter exists in the document layer (`document.ts:642`, `jsonBlockToSpec`). |
| F20 ⚑ | What makes a document "initialized" (schema stamp) | The document model's `init` | doc lifetime | admission, readiness | `edytor-doc.ts:703-716` (`init`), re-implemented by hand in `migrate.ts:536-546` (meta attrs written directly to avoid the bootstrap block). |
| F21 | Origin of remote integration | The applying transport (the provider instance) | per apply | undo scope, echo suppression | `room.ts:232-237` (provider as origin), `indexeddb.ts:206-215, 241-248` (provider, `local=false`); `sync.ts:73,82` default symbol only for raw readers no shipped path uses. Single rule ✔ in the domain. The view also defines a never-used remote marker (`REMOTE_ONLY_TRANSACTION`, `edytor.svelte.ts:181`, `constants.ts:2`) — a second, dead representation of "remote origin". |
| F22 ⚑ | Who destroys an awareness instance a provider created? | Whoever created it | creator lifetime | timers | IDB destroys its own (`indexeddb.ts:422-423, 622-624`); WS creates one by default (`websocket.ts:421`) and never destroys it (`websocket.ts:528-554`) — its 3 s interval keeps running in browsers. Pinned as an "asymmetry" by `gate2/lifecycle.test.ts:133`. |
| F23 | Compaction permission | The storage owner, from "every stored row was integrated" | provider instance | storeState | `_hydrationRefused` latch `indexeddb.ts:250, 306, 583` (sticky per instance, re-established on reopen). Exists only because F3 can refuse rows (§6 R1). |
| F24 ⚑ | Model (text, offset) → DOM (node, offset) | The selection layer (it owns caret↔DOM mapping, composition pins, placeholders) | per render | local caret, remote carets | `selection.svelte.ts:2972-2994` (`findTextNode`) and `remoteSelection.ts:138-167` (`findDomPoint`) — same TreeWalker walk, different not-found fallbacks (`[null,0]` vs `{node, min(offset, childNodes.length)}`). Any future change to how a text segment renders (placeholders, composition pin) must be made twice. |
| F25 ⚑ | May this document still be edited when its schema state is bad? | The document/editor (it owns input acceptance) | doc lifetime | user | Decided by the **transport**: providers silently stop persisting and broadcasting every later local update (`indexeddb.ts:507-537`, `websocket.ts:479-481`) while the editor keeps accepting input → **[P7]** silent loss. The document itself only re-checks at `sync()` (`document.ts:632`). |


---

## 4. Machinery inventory

xloc counted with the baseline counter's rules on line ranges (`scratchpad/xrange.mjs <file> label=a-b`); per-file sums equal `xloc.mjs --files`. Note: the counter leaks some type-literal lines with arrow members into "execution" (e.g. `migrate.ts` types = 36); they are counted as-is so before/after stay comparable.

Classes: **REQ** = implements a §1 guarantee in its simplest form · **CON** = forced by a §2 fact · **HIST** = exists because of an earlier decision; the replacing invariant is named.

### 4.1 `providers/room.ts` — 241

| Mechanism | Lines | xloc | Class | Replacing invariant (HIST) |
|---|---|---|---|---|
| Message-type constants, imports | 1-50 | 17 | REQ | — |
| Host/provider/behavior types (incl. `SchemaGateHost`, schema emit overloads) | 51-90, 124-139, 145-198 | 33 | REQ / HIST (schema parts ≈ 8) | R1 |
| `emitSchemaProblem` + `gateSchema` with `kind:version` dedupe key + bound gate closures | 91-123, 199-207 | 25 | HIST | R1: no transport-level schema state exists to gate or dedupe |
| `emitFailed` terminal latch | 140-144 | 5 | REQ (reads the wrong fact, F5/[P1]) | keep; read `hasSynced`, not `synced` |
| Sync: Step1 reply (gated) | 208-220 | 10 | REQ (gate part HIST) | R1 |
| Sync: staged apply + D24 post-apply recheck + refusal report | 221-250 | 19 | HIST | R1 (plain apply + error channel ≈ 8) |
| Sync: unknown subtype report | 251-256 | 5 | REQ (G7) | — |
| Awareness query/apply handlers | 257-268 | 12 | REQ (G20-21) | — |
| `readMessage` (envelope check → dispatch → unknown type) | 269-301 | 23 | REQ + CON (G13, B3) | — |
| BC subscriber (catch, reply only if > 2 bytes) | 302-327 | 14 | CON (B3) | — |
| Awareness change → broadcast | 328-345 | 13 | REQ | — |
| `broadcastUpdate` | 346-357 | 7 | REQ | — |
| `connectBc` join: subscribe, Step1, **gated full-state Step2 push**, query, own presence | 358-402 | 31 | REQ; push+gate HIST | R2b (one join rule for all transports, derived from state vectors) |
| `disconnectBc` leave announce | 403-423 | 14 | REQ (G21) | — |
| Handle object | 424-437 | 13 | glue | — |

### 4.2 `providers/indexeddb.ts` — 395

| Mechanism | Lines | xloc | Class | Replacing invariant (HIST) |
|---|---|---|---|---|
| Imports | 1-62 | 20 | glue | — |
| Store names, row codec, `isGenerationRecord` | 63-89 | 22 | CON (row buffers) — duplicated in `migrate.ts:74-75,157-169` | one container module (F2) |
| Types | 90-127 | 2 | — | — |
| Room binding + schema gate wrappers | 128-149 | 10 | REQ / HIST (≈5) | R1 |
| Hydration: generation verify-or-stamp | 150-183 | 26 | REQ (G14) — rule diverges from `migrate.ts:451-454` | one verify-or-stamp rule (F2) |
| Hydration: **staging fast path** (scratch = live + all rows) | 184-215 | 21 | HIST | R1 |
| Hydration: **surgical per-row re-staging** + refusal latch | 216-251 | 32 | HIST | R1 |
| Hydration: cursor `_dbref` / `_dbsize` | 252-267 | 15 | REQ (G17-18) | — |
| `storeState`: fetch → snapshot → delete `< _dbref` → recount, commit-tracked | 268-342 | 38 | REQ + CON (B2); schema + refusal gates (≈4) HIST | R1 (compaction always legal once every integrated row is represented) |
| Class fields + event map (incl. `schema-mismatch`, `_hydrationRefused`) | 349-410 | 34 | glue / HIST (≈6) | R1 |
| Ctor: fields, open, `whenSynced`, `onLoadError` | 411-451 | 30 | REQ (G11, G14) | — |
| Ctor: hydrate wiring (persist pre-existing state, connect, refusal → reject) | 452-499 | 29 | REQ (≈17) / HIST (≈12) | R1 |
| `_storeUpdate`: append row, debounce compaction, broadcast — **gated** | 500-539 | 27 | REQ; gate HIST (and causes [P7]) | R1 + F25 (editing refusal belongs to the document) |
| Listeners (`update`, `destroy`, `beforeunload`) | 540-549 | 10 | CON (B6) | — |
| `readMessage` public seam ("gate-2 probes call it") | 550-565 | 4 | test-only | tests use the room handle |
| `broadcastMessage`, `connectBc` synced claim, `disconnectBc` | 566-592 | 15 | REQ | — |
| `destroy` (idempotent, settles waiters, owned awareness) | 593-635 | 33 | REQ (G30, G11) | — |
| `get`/`set`/`del` on `custom` | 636-656 | 19 | HIST (y-indexeddb API parity; no caller in `src/`) | the container's `custom` store is library-owned (generation + migration records) |
| Return | 657-664 | 7 | glue | — |

### 4.3 `providers/websocket.ts` — 399

| Mechanism | Lines | xloc | Class | Replacing invariant (HIST) |
|---|---|---|---|---|
| Imports, `nodeProcess`, event/option types | 1-144 | 52 | glue / REQ (y-websocket option parity) | — |
| **Two-round empty-room settle** (`armSyncSettle`, `hasDocState`) | 145-198 | 29 | HIST — and incomplete: never arms in a zero-member room ([P6]) | R2a: opening never writes → `synced` is a UX signal, no emptiness proof needed |
| Permission denied → event + terminal failure | 199-208 | 4 | REQ (G8) | — |
| Room binding + auth handler | 209-236 | 17 | REQ | — |
| `onSyncApplied`: synced verdict from applied Step2 + settle arming | 237-258 | 15 | REQ (≈6) / HIST (≈9) | R2a |
| `closeWebsocketConnection` (settle reset, drop remote states, backoff) | 259-306 | 36 | REQ + CON (B4, G21); settle reset HIST (≈6) | R2a |
| `setupWS` (socket handlers; onopen **pull-only** hello) | 307-366 | 54 | REQ; hello duplicates `connectBc` frames (≈12) | R2b one join rule |
| `broadcastMessage` (socket + BC) | 367-376 | 9 | REQ; BC half HIST | one cross-tab channel per document (not one per provider) |
| Class fields + ctor options/fields | 377-459 | 78 | glue; settle/schema fields HIST (≈9) | R1, R2a |
| `resyncInterval` Step1 timer (default **off**) | 460-472 | 11 | CON: the only mechanism that heals a reconnecting client's offline edits over an opaque relay ([P5]); tests always enable it | R2b makes it a loss-healing extra, not a correctness dependency |
| Local update → broadcast (gated) | 473-483 | 7 | REQ; gate HIST | R1 |
| Awareness handler, `exit` handler, 30 s liveness check | 484-500 | 15 | CON (B4, B6) | — |
| Connect-on-construct, `url`, `synced` accessor | 501-527 | 23 | REQ | — |
| `destroy` (failed-if-unsynced — **wrong fact**, settle clear) | 528-555 | 23 | REQ; `!this.synced` HIST ([P1]) | lifetime `hasSynced` |
| `connect`/`disconnect`/`connectBc`/`disconnectBc` (+ `disableBc`) | 556-585 | 26 | REQ; BC part HIST | one cross-tab channel per document |

### 4.4 `providers/index.ts` — 63

| Mechanism | Lines | xloc | Class | Replacing invariant |
|---|---|---|---|---|
| `EdytorSync` payload/cleanup types, `WebsocketSyncOptions` (a hand-copied subset of provider options) | 1-51 | 20 | REQ; option copy HIST | `WebsocketSyncOptions = ProviderOptions & {serverUrl, roomName}` |
| `createIndexeddbSync` / `createWebsocketSync` (11-line manual option forwarding; `'sync'` boolean re-fired on every reconnect) | 52-87 | 33 | REQ; forwarding HIST (≈9) | spread options |
| Return | 88-99 | 10 | glue | — |

### 4.5 `protocols/*` — 508

| Mechanism | Lines | xloc | Class | Replacing invariant |
|---|---|---|---|---|
| `sync.ts` write/read Step1/Step2/Update helpers, origin default | 54-102, 129-132 | 25 | REQ (E5) | — |
| `sync.ts` raw readers `readSyncStep2/readUpdate/readSyncMessage` (unused in `src/lib`) | 103-128, 384-415 | 41 | HIST (y-protocols parity; harness surface) | the room dispatch is the only reader |
| `sync.ts` **`canApplyDirect`** (re-implements engine origin-chain resolution to prove an update cannot touch `meta`/registry emptiness) | 136-300 | 91 | HIST (CON only *given* compat-as-data, E8) | R1 |
| `sync.ts` **`applyUpdateStaged`** (scratch = full live state + update) | 301-383 | 39 | HIST | R1 |
| `sync.ts` imports/bind/return | rest | 19 | glue | — |
| `awareness.ts` Awareness class, encode/apply/remove | 1-237, 262-323 | 223 | CON (E10) / REQ (G20-21) | — |
| `awareness.ts` `modifyAwarenessUpdate` (server-side helper, no server exists) | 238-261 | 19 | HIST | — |
| `envelope.ts` version word, generation name/record, mismatch error | 1-83 | 32 | REQ (G13-14) | — |
| `auth.ts` read (REQ G8) + `writePermissionDenied` (server/test side) | 1-38 | 19 | REQ / test-only (4) | — |

### 4.6 `migration/*` — 519

| Mechanism | Lines | xloc | Class | Replacing invariant |
|---|---|---|---|---|
| `legacy-schema.ts` v13 layout reader + pending-deps refusal | 1-206 | 118 | REQ (G26, G28) — `LEGACY_INITIALIZED_KEY` unused | — |
| `migrate.ts` imports, consts, types (record with owner/lease; options wait/lease/poll/owner) | 1-156 | 59 | REQ / HIST (lease vocabulary ≈ 20) | R3 |
| Row codec + generation DB open (dup of `indexeddb.ts`) | 157-170 | 11 | HIST duplication | one container module |
| `openDbIfExists` + `status` (non-creating probe) | 171-198, 275-307 | 36 | CON (B1) | — |
| `blockToSpec` + `withFallbackIds` (same id policy twice; third converter in `document.ts:642`) | 204-257 | 40 | REQ policy, HIST duplication | normalize ids once, convert with the canonical converter |
| **Claim loop** (readwrite claim, lease, stale reclaim, busy) | 397-447 | 43 | HIST | R3: attempt ownership = crash-released platform lock (`navigator.locks`, present in browsers and Node 24 here) |
| **`waitForSettled`** (poll 150 ms + BC nudge whose JSON payload nobody decodes) + `announce` | 258-274, 308-371 | 62 | HIST | R3 |
| Unconditional generation stamp | 448-455 | 4 | HIST divergence (F2) | one verify-or-stamp rule |
| Read legacy rows (one readonly tx = consistent snapshot) | 456-479 | 13 | REQ + CON (B2) | — |
| `markFailed` / empty-legacy activate / activate+announce (three record writes with owner) | 480-512, 581-598 | 46 | REQ core (≈20) / HIST (≈26) | R3: persist + activate in **one** readwrite tx over `updates`+`custom` |
| Materialize + sanitize + verify | 513-531, 551-567 | 20 | REQ (G28) | — |
| Rebuild incl. **hand-written meta-only branch** (avoid bootstrap block) | 532-550 | 13 | REQ (≈5) / HIST (≈8) | R2a: an import writes exactly the imported content |
| Persist under **fixed key 0 via `put`** (overwrite) | 568-580 | 7 | HIST — breaks append-only ([P3b]) | append-only store for every writer |
| Options/phase hook, return/finally | 372-396, 599-609 | 25 | glue / test hook | — |
| `rollback` (record + clear rows + announce) | 610-632 | 16 | REQ (G27); announce HIST | — |

### 4.7 `collaboration/*` — 666

| Mechanism | Lines | xloc | Class | Replacing invariant |
|---|---|---|---|---|
| `awarenessSelection.ts` types/imports | 1-59 | 21 | REQ (types for 3 encodings: part HIST) | R3 |
| `jsonValuesEqual`, `anchorsEqual`, `publishedEntryEquals` (three equality notions) | 60-94, 307-354 | 60 | HIST | one deep-equality of the entry (minus `t`) at the single write point |
| `normalizeAwarenessSelection` (coerces 6 legacy fields) | 95-118 | 16 | REQ (G22), oversized by legacy fields | R3 |
| `viewPresenceIds` WeakMap + counter, `presenceOwners` registry, `readSelections`, `sweepDestroyedViews` | 119-187 | 44 | HIST (ownership reconstructed because teardown passes no view id) | R3: the view deletes its own key |
| `freshestPublishedSelection` | 188-217 | 18 | REQ (one caret per client) | — (smaller once entries are single-encoding) |
| `writePresenceFields` legacy `selection` mirror | 218-234 | 15 | HIST (pre-U5 v14 peers — none deployed; v13 peers are already excluded by the envelope) | R3 |
| `createAwarenessSelection` (anchors + `textId/yStart` legacy fields) | 235-264 | 22 | REQ; legacy half HIST | R3 |
| `clearAwarenessSelection`, `publishAwarenessSelection` | 265-306, 355-407 | 60 | REQ core (≈25) / HIST (≈35) | R3 |
| `remoteSelection.ts` user/color, anchor guards, anchor resolve (excl. the ≈ 6-line mirror fallback counted below) | 1-114 | 67 | REQ (G20, G22) | — |
| `remoteSelection.ts` `getSelection` mirror fallback + `resolveTextOffset` numeric fallback | 52-73 (part), 115-137 | 24 | HIST (second interpretation of the same caret; renders stale offsets) | R3: anchor or nothing |
| `remoteSelection.ts` `findDomPoint` (dup of `selection.svelte.ts:2972-2994`) | 138-168 | 27 | HIST duplication (F24) | reuse the selection's mapper |
| `remoteSelection.ts` rect/range geometry + `getRenderedRemoteSelections` | 169-324 | 122 | REQ + CON (B5); unused `_editorRect/_editor` params threaded through 4 helpers | — |
| `RemoteSelections.svelte` (revision counter, subscriptions, overlay, CSS) | 1-106 | 83 | REQ + CON (S1) — **no scroll/resize invalidation** (G24 missing) | — |
| `documentSync.ts` `attachDocumentSync` (dedupe by **factory identity** in a module WeakMap) | 31-68 | 21 | HIST (wrong key, wrong owner, F9) | the document keys attachments by transport target |
| `documentSync.ts` `whenDocumentReady` (onReady + onSyncSettled + 50 ms poll backstop) | 69-124 | 31 | HIST ("in case a future readiness path bypasses both events") | readiness is one event on one owner; R2a removes the failed-provider hand-back |
| `providers.ts`, `index.ts` re-export shims | all | 29 | REQ (public API) | — |

**Outside the domain but part of its decisions:** `Edytor.remotePresenceRevision`/`refreshRemotePresence` (`edytor.svelte.ts:187, 468-470, 614, 645, 875, 2205`) — invalidation nobody reads (F12); facade `syncPending` twin (`edytor-doc.ts:820, 2599-2605`) and document `_syncFailed`/`onSyncSettled` (`document.ts:439-441, 836-857, 896-900`) — the other halves of F6/F7.

**Totals by class (domain only, summed from the rows above; gross, before the replacement code each invariant needs):** REQ + CON ≈ 1,850 · HIST ≈ 930 (33 %) · test-only ≈ 12.

| HIST cluster | gross xloc | where |
|---|---|---|
| Schema-as-data staging and gating | ≈ 276 | `sync.ts` 130, `indexeddb.ts` 83, `room.ts` 59, `websocket.ts` 4 |
| Presence multi-encoding + reconstructed ownership + duplicated DOM mapping | ≈ 231 | `awarenessSelection.ts` ≈ 180, `remoteSelection.ts` 51 |
| Migration arbitration (lease/claim/poll/announce/owner records) | ≈ 154 | `migrate.ts` |
| Transport parity surface (raw readers, server helpers, `get/set/del`, WS-side BC, duplicated hello, hand-copied options) | ≈ 123 | `sync.ts`, `awareness.ts`, `indexeddb.ts`, `websocket.ts`, `providers/index.ts` |
| Readiness plumbing (settle window, failed hand-back, poll backstop, factory-identity dedupe) | ≈ 100 | `websocket.ts` ≈ 55, `documentSync.ts` ≈ 38, `room.ts` ≈ 6 |
| Other migration duplications (codec/open, id policy, stamp, meta-only branch, key-0 overwrite) | ≈ 50 | `migrate.ts` |

---

## 5. Distinctions that must stay explicit

Each pair looks compressible; each has a concrete bug when merged (several are merged today).

| # | Keep apart | Bug when merged | Status today |
|---|---|---|---|
| D1 | **Connection currently synced** (transient, resets on socket loss) vs **provider has ever synced** (lifetime; decides terminal failure) | A provider that synced, lost its socket, then is destroyed reports `failed` "destroyed before it synced" — [P1]. Any consumer treating `failed` as terminal (the contract says it may) tears down a healthy document. | **Merged** (`room.ts:141` reads `host.synced`; WS resets it at `websocket.ts:284`). Masked in the editor only because the document keeps its own latch (F6). |
| D2 | **Transport success** (a frame decoded / an update applied) vs **operation success** (this replica now reflects the answering side) | An applied *empty* Step2 relayed from another member's handshake would count as "synced", the doc seeds, and the reserved-id seed erases room content ([P4c]). | Kept apart for WS (`websocket.ts:245-256`), **merged for IDB**: "local hydration finished" is treated by the document as "content may be decided" ([P4]/[P4b]). |
| D3 | **Wire generation** (envelope word) vs **payload provenance / peer authority** | Treating "speaks v14" as "trusted" gives a false security boundary; a forged enveloped payload integrates. | Kept apart and documented (`docs/crdt-v14-providers.md:344-350`). |
| D4 | **Observation** ("the live `meta.v` stayed supported") vs **guarantee** ("no content written by an incompatible writer integrated") | With engine fact E2 (clock gaps become `Skip`), refusing the stamp-carrying update does not stop the incompatible writer's later content — [P2]: `from-v2-peer` is projected in a v1 replica whose stamp was protected. | **Merged in the documentation** (`docs/crdt-v14-providers.md:139-144,188-189` claims the guarantee; code delivers the observation). |
| D5 | **Creating** a document (writes initial content, once, by someone entitled to assert "new") vs **opening** one (must never write) | Seed-if-empty on open: a replica that merely hasn't heard the room yet writes content — duplicate `value` blocks ([P4]), erased first paragraph via the reserved bootstrap id ([P4b], [P4c]), or a lone client that can never decide and never renders ([P6]). | **Merged** (`document.ts:621-667` + `attachSync` `synced` → `sync(value)` at `document.ts:919-920`). |
| D6 | **Stored bytes** vs **integrated state** | Compaction deletes stored bytes the snapshot never contained (the pre-R2 bug; refused rows destroyed). | Kept apart by the `_hydrationRefused` latch (`indexeddb.ts:306`) — needed only because rows can be refused (R1 removes the cause). |
| D7 | **Attempt ownership** (who is migrating right now; must vanish with the tab) vs **durable progress** (a completed import; must survive crashes) | Storing attempt ownership durably forces leases, expiry, polling and a reclaim race (`gate2/migration-adversarial.test.ts:255` "a second caller reclaims a live claim"). | **Merged** (`pending` + `owner` + `leaseUntil` in the durable record, `migrate.ts:93-105, 402-425`). |
| D8 | **Import** (fresh identity appended) vs **replace** (a CRDT edit superseding existing blocks) | `force` re-import overwrites the snapshot row: live rows lose their causal base and pend forever ([P3b]), or per-block LWW keeps a random subset of post-migration edits ([P3]). | **Merged** (`migrate.ts:571-579` `put(…, 0)` is used for both first import and forced replacement). |
| D9 | **Presence definition** (a view's caret, owned by the view) vs **presence occurrence** (an entry in the client's single shared awareness slot) | Clearing by slot instead of by owner either strips sibling views' carets or needs registries that poll `destroyed` to rediscover ownership. | **Merged at the call site** (`selection.svelte.ts:670` passes only the awareness) → registries F14. |
| D10 | **Anchor position** (causal, follows edits) vs **numeric offset** (valid only in the sender's state at publish time) | Rendering the offset when the anchor cannot resolve paints the caret at a stale position after concurrent edits instead of not painting it. | **Merged** as fallback (`remoteSelection.ts:282-287`). |
| D11 | **Replicated document state** vs **ephemeral presence / local decoration** | Presence written into the doc would create undo steps and persisted rows. | Kept apart (`presence.test.ts:173`). |
| D12 | **Remote-apply origin** vs **local origins** (E5) | A `null` origin on remote applies is tracked by undo (`document.ts:401` tracks `null`) and defeats `origin !== this` echo suppression. | Kept apart (`sync.ts:54-73`, providers pass themselves). |
| D13 | **Container identity** (generation record, immutable once stamped) vs **migration progress** (mutable record in the same store) | The migrator stamps identity as a side effect of claiming progress, so a populated foreign store gets stamped and its rows later hydrate. | **Merged** (`migrate.ts:451-454` vs `indexeddb.ts:165-175`). |
| D14 | **Room membership** (who is there) vs **room state** (what exists) | Inferring "empty state" from "no answers" cannot distinguish zero members from slow members: zero members never settle ([P6]); slow members lose to the 2-window bound (documented residual). | **Merged** by the settle heuristic (`websocket.ts:150-197`). The opaque relay provides neither fact. |
| D15 | **Accepting input** vs **being able to persist/broadcast it** | The transport silently drops every later local edit while the editor keeps accepting input — [P7] (edits lost on reload, one deduped event). | **Merged into the transport** (F25). |


---

## 6. Representation candidates

### R1 — Compatibility is a property of the channel and the container, not a replicated attribute

**Today.** "Can this build own these bytes?" is answered by replicated LWW attributes inside the document (`meta.v`, `meta.schema`). Because the answer lives in the data, every entry point must *simulate* integration (scratch doc = full live state + candidate bytes → `checkSchema`) and every exit point must re-inspect the live doc. The simulation is O(doc), so a 91-xloc proof (`canApplyDirect`) re-implements the engine's origin-chain resolution to skip it; hydration re-implements staging twice more (batch, then per row); a refused row makes compaction unsafe, so a sticky latch disables compaction for the life of every instance that ever opens that container.

**Proposed.** The envelope word and the container record name the full generation — engine, wire protocol **and application schema** (e.g. `varuint 14 | varuint SCHEMA_VERSION | type | payload`, record `{engine, protocol, schema}`; a schema bump is a new generation). The v13→v14 boundary already works exactly this way for honest peers, and no probe or pinned test found a hole in it. `meta.v` stays in the document for bytes of unknown provenance — `loadDocument`, `attachDocument`, and the `sync()` re-check in `admission.ts`/`document.ts` are unchanged.

**Disappears (domain):** `canApplyDirect` (91), `applyUpdateStaged` (39), hydration fast/surgical staging (53 → ≈ 6), `_hydrationRefused` latch + compaction block + refusal rejection (≈ 18), `gateSchema`/`emitSchemaProblem`/dedupe key/bound closures (25), eight outbound gate call sites (≈ 12), the staged branch + D24 post-apply recheck in `room.ts` (19 → ≈ 8), `schema-mismatch` plumbing and types (≈ 10). **≈ 250 xloc net** after adding ≈ 5 for the wider envelope/record check. Also disappears: [P7] silent quarantine (F25), the compaction-disabled-forever state, and the app-level dependency on engine internals (E8).

**Invariant that replaces it:** *A replica integrates bytes only from writers of its own (engine, wire, schema) generation: the envelope word proves it per frame before decode, the container record proves it per container before hydration. Nothing inside a frame or row is inspected for compatibility.*

**Residual guard (outside the domain, O(1)):** a same-generation writer can still produce a foreign stamp through corruption or forgery: raw engine writes, or a hand-crafted row like the one in `collaboration-multiclient.spec.ts:264`. The document can observe its own `meta` root, which fires only when the stamp changes. On such a change it switches itself to read-only and signals once. The document is the owner of "may this still be edited", so this also replaces the transport's silent quarantine ([P7]) with a visible state. That check is about 8 lines in the document layer, against about 250 lines of per-update staging here.

**Why this is not a loss of protection.** [P2] shows the current gate's real guarantee is "the stamp stays supported", not "incompatible content stays out": under E2 the incompatible writer's later content integrates immediately. A clean partition of mixed-schema rooms is strictly stronger than today's "LWW coexistence". A forged peer that speaks the current envelope and writes `meta.v` is outside the documented threat model (`docs/crdt-v14-providers.md:344-350`) and is still refused at the document's next admission check. Tests to rewrite as generation-mismatch tests: `schema-boundary.test.ts`, `gateF1/wu3b-staging.test.ts`, the refusal half of `hardening/r2-idb-compaction.test.ts`, `gate2/compaction-schema.test.ts:117`, `gate2/envelope.test.ts:313-341`, `lifecycle-failure.test.ts:206-277`, `…-3client.spec.ts:565`. `collaboration-multiclient.spec.ts:264` (hand-crafted v99 doc in the v1 container) keeps passing through `document.sync()` admission.

### R2 — Opening never writes; the join handshake is derived from state vectors, identically on every transport

**(a) Create ≠ open.** Initial content is written only by an explicit create (`createDocument({value})`, or an explicit create flag on the view), never as the side effect of "some provider said synced". An empty document's first line is a view-level virtual block materialized by the first input, not a replicated block under a reserved id.

- Disappears (domain): the two-round settle window, its fields/resets and the settle branch of the synced verdict in `websocket.ts` (≈ 55), the failed-provider hand-back + 50 ms poll in `whenDocumentReady` (≈ 23), the migration's hand-written meta-only branch (≈ 8). Outside the domain: facade `syncPending` twin, document `_syncFailed`/`onSyncSettled` seed gating, the view's `setTimeout(0)` self-decision, the `BOOTSTRAP_BLOCK_ID` LWW trick.
- Invariant: *No replica writes content it did not author (a user edit or an explicit create). `synced` is an informational signal; no correctness decision waits on it.*
- Fixes [P4], [P4b]/[P4c], [P6]/[P6b]; the documented residual ("a hydration reply delayed past both windows can still race the seed", `docs/crdt-v14-providers.md:179-181`) ceases to exist.
- Minimal step if (a) is too large: keep seed-if-empty but seed under fresh ids and decide after the first applied Step2 **or** one timeout from open. That is non-destructive (worst case: an extra empty paragraph) and fixes [P4b]/[P6]/[P6b], not [P4].

**(b) One join rule.** On a Step1 carrying `sv_peer`: reply Step2(diff) and, if `sv_peer` holds anything we lack, reply our own Step1. Connecting sends only Step1 + presence ("hello"), on BC and socket alike.

- Disappears: the gated full-state Step2 push in `connectBc` (≈ 9), the duplicated socket hello (≈ 12), and the correctness dependency on `resyncInterval` ([P5]): resync becomes an optional loss-healing timer.
- Invariant: *once two replicas of a room have each received one Step1 from the other, each holds the other's state.* This holds for joiners, rejoiners and opaque relays, and terminates because replies stop once state vectors are equal.
- Cost: a Step1/Step2 burst that grows with the number of members on each join through an opaque relay. The relay must keep excluding the sender, as `ws-relay.ts` already does.

### R3 — Ownership is held by the owner; durable storage records only completed effects

One principle, two places where the code currently reconstructs ownership:

**(a) Presence.** An entry is `selections[viewKey] = {start, end, collapsed, reversed, t}`: anchors only, one encoding. The view that minted `viewKey` deletes it in its own teardown (`clear(awareness, viewKey)`). The only dedupe is "entry minus `t` deep-equals the previous entry" at the single write. Remote rendering resolves the anchor or paints nothing; DOM mapping reuses the selection layer's mapper; overlay coordinates are editor-relative, so scrolling needs no invalidation (G24).

- Disappears: view-id WeakMap + owner registry + `sweepDestroyedViews` + `readSelections` (44), the `selection` mirror (15), legacy `textId/yStart` fields + numeric fallback + mirror fallback (≈ 34), three equality helpers (60 → ≈ 4), `findDomPoint` (27), plus the branches in the render path that only existed to reconcile the three encodings; the dead `Edytor.remotePresenceRevision` path outside the domain goes too. **≈ 240 xloc net in the domain** (`awarenessSelection.ts` 256 → ≈ 88, `remoteSelection.ts` 246 → ≈ 166, overlay +2).
- Invariant: *every presence key has exactly one live writer, the view that minted it, and that writer removes it on teardown; the wire carries one representation of a caret.*

**(b) Migration.** Attempt ownership is a crash-released platform lock (`navigator.locks.request('edytor-v14-migration:' + name, { ifAvailable: !wait }, …)`, present in current browsers and in Node 24 in this environment). Durable progress is written once: the import row is **appended** and the `active` record is written in **one** readwrite transaction over the generation DB's `updates` + `custom` stores. `force` is a replace-edit (hydrate → one replace transaction → append its diff), never an overwrite. One container module owns the codec, the non-creating open, and the single verify-or-stamp rule for both the provider and the migrator.

- Disappears: the claim loop (43), `waitForSettled` polling + the BC announce whose payload nobody decodes (62), lease/owner vocabulary (≈ 20), three owner-carrying record writes (≈ 26 → ≈ 10), the key-0 overwrite (7), and the duplicated codec/open/stamp (net ≈ −26).
- Invariant: *the generation store is append-only for every writer; a completed import is visible iff its row and its `active` record committed together; at most one tab imports a given name at a time, and that exclusivity ends with the tab.*
- Fixes [P3], [P3b], D13 (stamping a populated foreign store), and the crash window between persist and activate.


---

## 7. Falsifying counterexamples

Smallest scenarios that expose a wrong abstraction. **Probed** ones were executed against the working tree (`scratchpad/probes-sc2/`); **code-derived** ones follow from the cited lines and were not executed.

| # | Axis | Scenario (smallest) | Observed / derived | Wrong abstraction exposed |
|---|---|---|---|---|
| C1 **[P1]** | failure midway | Two WS clients sync; B's socket closes (transient); `B.destroy()`. | `failed` fires on B: "destroyed before it synced" (`p1-ws-failed-after-synced.test.ts`, assertion passes). | D1: connection-scoped `synced` used as the lifetime fact (`room.ts:141`, `websocket.ts:284, 533`). |
| C2 **[P2]** | two features combined (upgrade + normal typing) | A (v1) and B share a doc. B writes `meta.v = 2` (A refuses: `unsupported`) and then types "from-v2-peer" (provider-style transaction payload). | A applies the text on the **fast path** (`staged:false`), projects `from-v2-peer`, `meta.v` stays 1, no pending state; the engine filled B's refused clock with `Skip(0+1)` (**[P2b]**). With a full-state diff instead of the transaction payload, the same edit is refused as `unversioned` (E1). | D4: the gate protects the stamp, not the content; the verdict depends on who encoded the bytes. |
| C3 **[P3b]** | retry after partial completion | migrate → provider hydrates → user types → (no compaction) → `migrate(name, {force:true})` → reload. | 6/6 trials: the edit is gone, `pendingStructs != null` forever on every later hydration. That pending state also forces `canApplyDirect` to `false` (`sync.ts:201-203`), so every later inbound update pays the O(doc) staging. | D8 + F17: the migrator overwrites key 0 in a store the provider treats as append-only. |
| C4 **[P3]** | retry after partial completion | Same as C3, with `storeState` compaction before the forced re-run. | Post-migration edit survived in 1/6 trials (per-block clientID LWW). The runbook promises replacement (`docs/crdt-v14-migration.md:219-223`); the actual result is a random per-block mix. | D8. |
| C5 **[P4]** | two features combined (IDB + WS, documented as intentional at `documentSync.ts:19-21`) | New device: empty IndexedDB, room already holds "room content"; the view passes a default `value`. | Readiness is decided by the IDB provider's `synced` (`readiness: 'local'`) and `value` is seeded. After the WS sync, the local doc holds `["room content", "default seed"]` while the remote holds `["room content"]` (divergent: see C7). | D2/D5: the first provider's "hydrated locally" is treated as "the document is new". |
| C6 **[P4b]/[P4c]** | two features combined + empty value | Same as C5 but no `value`; the room's content lives in the reserved bootstrap block (any doc created without `value` and then typed into). | 7/8 trials: the room's first paragraph is **erased on both replicas** whenever the new device's clientID is higher (`p4b`, instrumented). Deterministic repro `p4c`: editor clientID 10 vs seeder 20 → the edited block is lost. | D5 + the reserved-id seed turns a wrong "empty" guess into an overwrite. |
| C7 **[P5]** | fact changing between observation and use (rejoin) | Opaque relay, default options. B disconnects, edits offline, reconnects while A stays connected. | A never receives B's offline edit (`resyncInterval=-1`). With `resyncInterval=200` it heals in about 200 ms. Every browser spec and DST run forces 200/250 ms (`src/routes/test/dom/+page.ts:30`, `tests/editor-dst/collab-runner.ts:229`). | F10: a join handshake that only pulls, correct only behind a participating server, which is exactly the topology declared unsupported. |
| C8 **[P6]/[P6b]** | empty collection (empty room) | The first client of a room over an opaque relay, with default options. | Alone: no Step2 is ever applied, so the settle window never arms. After 2 s (settle 50 ms): `document.ready=false, readiness=pending, syncPending=true`, and no `failed`. **[P6b]**: a second client then joins, settles, and seeds. The first client even holds that seeded block, but it only ever receives `Update` frames, never a `Step2`, so it stays `pending` forever with `resyncInterval=-1`. With `resyncInterval=200` it becomes `hydrated`. `<Edytor>` renders only `{#if edytor.synced}` (`Edytor.svelte:221`), so under library defaults the first user of every new websocket room never sees the editor. | D14: emptiness inferred from silence (membership is a missing fact); D2: an applied `Update` carrying room state is not accepted as evidence. |
| C9 **[P7]** | fact changing between observation and use (gate checked after commit) | Doc + IDB provider; one local write sets `meta.v = 99`; then three normal edits. | Live doc shows all three edits. After a reload, only the edit made before the bad stamp is there. One deduped `schema-mismatch` fired and the editor never stopped accepting input. | D15/F25: the transport decides the fate of user input. |
| C10 **[P8]** | same definition in two positions | Two views, each with an inline `createIndexeddbSync('notes')`, on one injected document. The dedupe key is factory identity, so two providers attach. | Rows per session: 6, 11, 16, 21 vs 3, 5, 7, 9 with one provider. Each provider re-stores the other's hydration (`origin !== this`, `indexeddb.ts:503-508`), and every update is also broadcast twice on one BC channel. | F9: dedupe keyed by factory identity instead of transport target. (Also visible: an empty doc writes a 2-byte pre-hydration row on every open, `indexeddb.ts:459-467`.) |
| C11 code-derived | two features combined (mixed-schema tabs + compaction) | A future-schema tab appends one row to the shared generation. | Every v1 instance that opens the container refuses that row and never compacts again (pinned: `r2-idb-compaction.test.ts:198`, `gateH-r2-probes.test.ts:218`), so the store grows without bound. By the C2 mechanism, that tab's later content rows are accepted by the surgical path. | D4/D6: refusal-by-inspection creates permanent maintenance debt. |
| C12 code-derived | layout change | A remote peer idles; the local user scrolls the page. | The overlay is `position: fixed` (`RemoteSelections.svelte:77-82`) with viewport rects captured at compute time (`remoteSelection.ts:169-178, 311`). Recompute happens only on awareness `'change'` or doc `'update'` (`RemoteSelections.svelte:42-43`), and heartbeats never emit `'change'` (`awareness.ts:164-171`). The caret stays at stale screen coordinates. `toRemoteRect` already receives an unused `_editorRect`. | G24 missing; coordinates are represented in the wrong frame. |
| C13 code-derived | lifecycle divergence | A WS-only (`disableBc`) peer closes its tab. | No departure is announced in browsers: only Node `exit` is hooked (`websocket.ts:485-490`), and the relay does not tell the others. The caret lingers on peers until the 30 s awareness timeout. The IDB/BC provider announces via `beforeunload` → `destroy` → `disconnectBc` (`indexeddb.ts:543-548`, `room.ts:409-417`). | F16: two providers make the departure decision differently. |
| C14 code-derived | nesting (views inside one document) | View V1 of a shared document tears down in an order where `destroyed` is set but its selection teardown does not run (the path simulated at `presence.test.ts:135`). | V1's caret stays published until some sibling publishes (the sweep runs only on publish/clear). With no sibling activity, peers keep seeing a dead view's caret. | D9: ownership reconstructed by polling instead of held by the owner. |
| C15 code-derived | generated value after a boundary | The integrator bridges a migration into an already-open provider, as the runbook advises (`Y.applyUpdate(doc, encodeStateAsUpdate(result.doc))`, `docs/crdt-v14-migration.md:112-116`), and later runs `force`. | The bridge makes the provider store a second full copy of import #1 as an ordinary row. A later `force` overwrites key 0 with import #2, so hydration merges two imports of the same logical ids, giving the C4 per-block coin flip in tabs that bridged (C3 in tabs that did not). | D8. |
| C16 not falsified | IME / composition | A remote Update is applied during a local composition. | The domain's only obligations are a non-null, untracked origin (`room.ts:232-237`) and an overlay outside the editable (`RemoteSelections.svelte:53`). The `composition-remote-lock.spec.ts` suite (7 tests) pins the editor side. The overlay does read layout on every remote update during composition: a performance cost, not a correctness one. | — |


---

## 8. LOC — current, floor, derivation

Counter: `node scratchpad/xloc.mjs <dir> --files` (current); per-mechanism ranges with `scratchpad/xrange.mjs` (§4). "Floor" = execution LOC of **this domain's files** if every §1 guarantee is kept and every fact in §3 has one owner (R1 + R2 + R3 applied, plus the small consolidations named below). Code that must move is counted where it lands; deletions that land **outside** the domain (document/facade/view) are *not* credited here.

### 8.1 Per file

| File | Current | Floor | What survives (and what goes) |
|---|---|---|---|
| `providers/room.ts` | 241 | 171 | Keeps: constants/types (−8 schema types), `emitFailed` (reads `hasSynced`), Step1 reply (+2 for R2b's conditional Step1 back), plain apply with error channel (19 → 8), unknown-subtype report, awareness handlers, `readMessage`, BC subscriber, broadcast helpers (−8 via a 5-line `frame(type, write)` helper that also serves `websocket.ts`/`migrate.ts`), `connectBc` = subscribe + shared `hello()` (31 → 14), `disconnectBc` (14 → 10). Goes: `emitSchemaProblem`, `gateSchema` + dedupe key, gate closures (25). |
| `providers/indexeddb.ts` | 395 | 241 | Keeps: open/whenSynced/load-error/destroy lifecycle, `_storeUpdate` append + debounce (−3 gate), `storeState` commit tracking (38 → 33), cursor/count, listeners, BC glue. Hydration = verify-or-stamp call + getAll + **one** apply transaction + cursor (94 → 31). Goes: staging fast + surgical paths (53), refusal latch/rejection (≈ 18), `get/set/del` (19, no caller), `readMessage` test seam (4); codec + generation check move to the container module (−48 here, +counted there). |
| *new* `providers/container.ts` | 0 | 56 | Store names, open-with-stores, row codec, `isGenerationRecord`, **one** verify-or-stamp rule, non-creating open (B1) and existence probe — the union of `indexeddb.ts:63-89,150-183` and `migrate.ts:157-198,288-297`, deduplicated (82 → 56). |
| `providers/websocket.ts` | 399 | 322 | Keeps the y-websocket surface (options, `status`/`connection-*` events, backoff, liveness, resync, auth), `synced` = first applied Step2 (15 → 5), onopen via shared `hello()` (54 → 42). Goes: two-round settle (29), settle fields/resets (≈ 15), schema key/gate (≈ 4), `!synced`→`!hasSynced` fix in `destroy` (23 → 19). |
| `providers/index.ts` | 63 | 54 | `WebsocketSyncOptions` derived from provider options; factories spread options instead of an 11-line copy; factories expose a transport-target key for dedupe (+4). |
| *cross-provider* | — | −40 | One provider lifecycle owner (hasSynced/failed/whenSynced/destroy guard/departure announcement, currently duplicated and divergent — C13) ≈ −25; one cross-tab channel per document (drop the WS-side BC fan-out and `disableBc` plumbing when a document already has one) ≈ −15. |
| `protocols/sync.ts` | 215 | 54 | Keeps: write/read Step1/Step2/Update, remote-origin default, one `applyRemote(doc, update, origin, onError)` (18 → 10), `svCovers(peerSv, ownSv)` for R2b (+6). Goes: `canApplyDirect` (91), `applyUpdateStaged` (39), `readSyncMessage` (23, unused in `src/lib`). |
| `protocols/awareness.ts` | 242 | 223 | Verbatim protocol stays (E10). Goes: `modifyAwarenessUpdate` (19, server-side helper, no server). A purpose-built presence map could be ≈ 150 but is not counted (rewrite risk for ≈ 70 xloc). |
| `protocols/envelope.ts` | 32 | 35 | +3: generation word and record carry the schema version (R1). |
| `protocols/auth.ts` | 19 | 15 | `writePermissionDenied` is server/test-side (4). |
| `migration/migrate.ts` | 401 | 192 | Keeps: record read, non-creating `status`, legacy read (one readonly tx), materialize + sanitize + verify, rollback, result shape. New: platform-lock acquisition with `ifAvailable` for `busy` (+12), append + `active` in **one** transaction (24 → 12), `force` as a replace-edit (+13), a 3-line lock-based `waitForSettled` for API parity. Goes: claim loop (43), polling `waitForSettled` + announce (62 → 3), lease/owner vocabulary (36 → 24 types), duplicated id policy (40 → 13 using the canonical converter), meta-only branch (13 → 5), key-0 overwrite. |
| `migration/legacy-schema.ts` | 118 | 117 | Required decoder; drop unused `LEGACY_INITIALIZED_KEY`. |
| `collaboration/awarenessSelection.ts` | 256 | 88 | One entry type (anchors + two flags + `t`), anchor guards moved in from `remoteSelection.ts` (+10, moved), `normalizeEntry`, view key (5), `freshest` (12), `create` (12), `publish` (18), `clear(awareness, viewKey)` (8), one `sameEntry` (4). Goes: three equality helpers, owner registries + sweep, mirror, legacy fields. |
| `collaboration/remoteSelection.ts` | 246 | 166 | Keeps user/color, anchor resolve, rect/range geometry, render loop. Goes: numeric fallback (18), mirror fallback (7), `findDomPoint` (27 → 3, reuses `selection.svelte.ts:2972` — +1 line there to expose it), guards (moved out), unused `_editorRect/_editor` threading. |
| `collaboration/RemoteSelections.svelte` | 83 | 85 | Editor-relative coordinate frame (fixes G24/C12 without scroll listeners). |
| `collaboration/documentSync.ts` | 52 | 20 | Dedupe by transport key (14); readiness wait = already-ready fast path or one `onReady` subscription (6). Goes: `onSyncSettled`/`syncFailed` hand-back and the 50 ms poll. |
| `collaboration/providers.ts` | 16 | 16 | Public shim. |
| `collaboration/index.ts` | 13 | 12 | Drops removed exports. |
| **Total** | **2,791** | **≈ 1,830** | **−960 xloc (−34 %)** |

### 8.2 Where the reduction comes from

| Source | Net xloc | Nature |
|---|---|---|
| R1 — compatibility in the channel/container | ≈ −255 | deleted mechanism (staging, proof, latch, gates) |
| R3a — presence owned by the view, one encoding | ≈ −245 | deleted reconstruction + second/third interpretations |
| R3b — migration lock + atomic append + container dedupe | ≈ −200 | deleted arbitration; duplicated storage code merged (moved lines counted once) |
| R2 — open never writes + one join rule | ≈ −95 | deleted heuristic; outside the domain it also deletes seed gating, which is not credited here |
| Unused public/test surface (raw readers, server helpers, `get/set/del`, test seam) | ≈ −70 | **retiring parity surface, not simplifying the candidate** — it only counts if the maintainer accepts the API removal |
| Cross-provider lifecycle + single cross-tab channel | ≈ −40 | merged duplication |
| Small (option spreading, readiness wait, docs-only exports) | ≈ −55 | cleanup |

### 8.3 Honest caveats

- **Parity floor ≈ 1,830 (−34 %)** keeps the v13→v14 migration and full y-websocket option parity. That is below the 40–50 % target for this domain. The rest of the target is available only through a **product decision**, not a refactor: in a 0.0.x package the README marks "not production ready", if no persisted v13 data must be carried forward, `migrate.ts` + `legacy-schema.ts` + the container's non-creating-open/existence helpers (≈ 332 floor xloc) and the `isLegacyDoc` admission check outside the domain can be deleted, giving **≈ 1,500 (−46 %)**. That is a requirement change (G26–G29), and it must be decided as one.
- R2 **moves** work to the view layer (a virtual first block materialized on first input) and changes the `<Edytor value>` contract (value applies on create, not on open). That cost is outside this floor. The minimal R2 step (fresh-id seed + single timeout) keeps the contract and still deletes the settle window (≈ −40 here).
- R1 **changes a documented contract** (schema coexistence is LWW) and turns every future schema bump into a generation bump plus an import. That is a real extension cost. The honest comparison is with today's per-update gating, which [P2] shows does not keep incompatible content out, and which [C11] shows can disable compaction permanently.
- Tests pinning the retired mechanisms (`schema-boundary.test.ts` 613 lines, `wu3b-staging.test.ts` 290, most of `r2-idb-compaction.test.ts` 404, the lease/claim parts of `migrate.test.ts` and `gate2/migration-adversarial.test.ts`, the mirror/sweep parts of `presence.test.ts` and `elegance-awareness.test.ts`) must be rewritten against the new invariants. Test LOC is not in the metric, but the rewrite is real work.
- Bundle size: these deletions should shrink the shipped bundle, because `canApplyDirect`, the staging, the migration poller and the presence helpers are runtime code, not types. Fewer source lines alone do not prove it. `navigator.locks` adds no dependency. Measure with `bench/` before claiming a number.
- Behavior bugs in §7 (C1, C3–C9, C12, C13) are independent of the LOC outcome. Several are fixable in place: `hasSynced` for C1; an append-only migration for C3/C4; a WS join that also answers with its own Step1 for C7; a connect timeout for C8. Doing those first adds lines, so the floor above assumes the representation changes, not patches.
