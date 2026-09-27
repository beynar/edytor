# CRDT v14 — real-browser multi-client proof (U10 + socket follow-up)

Date: 2026-09-20, extended 2026-09-21 · Units: **U10 — integrated convergence +
real-browser multi-client proof**, the **real-WebSocket transport
follow-up**, and the **hardening Unit-6 three-client extension** · Status:
**complete**

This document records the end-to-end browser evidence for the vendored v14 CRDT
integration: how the proof is wired, what was proven, the defects found and
fixed along the way, measured results, and what remains unproven.

## Topology

### BroadcastChannel room (`?collab=<room>`)

- **Route**: `/test/dom?scenario=collab&collab=<room>` — mounts the production
  `Edytor` Svelte component with a deterministic seed document
  (`collab-b1`, `collab-b2`, `collab-b3`, paragraph type, `alpha`/`beta`/`gamma`
  content) so two independently-mounted clients converge on identical block
  identities instead of generating duplicate random ids.
- **Provider stack (production)**: each page constructs a real
  `IndexeddbPersistence` provider (`src/lib/crdt/providers/indexeddb.ts`,
  re-exported via `src/lib/collaboration/`) against the db name
  `edytor-collab-<room>`. That provider is the shipping stack: IndexedDB
  persistence **plus** BroadcastChannel cross-context fan-out on the db-name
  channel, awareness sync, and the v14 wire envelope (`varuint 14 | type |
payload`) with protocol/schema gating. No external relay or server is
  involved — two tabs in one browser context are a complete two-client room.
- **Two real pages**: every test opens `context.newPage()` twice; each page has
  its own `Y.Doc`, `Edytor` instance, facade, selection, undo manager, Svelte
  render tree, DOM mutation observer, and provider. Updates travel the real
  encode → BroadcastChannel → decode → `applyUpdate` path.
- **Test hooks** (route-gated, test-only):
  - `window.__EDYTOR__` / `__SECOND_EDYTOR__` — live `Edytor` context.
  - `window.__EDYTOR_COLLAB__.provider` — the provider instance; specs drive
    partitions via `provider.disconnectBc()` / `provider.connectBc()` and flush
    persistence via `storeState(provider)`.
  - `window.__EDYTOR_COLLABORATION_TEST__` — `{ IndexeddbPersistence,
clearDocument, storeState }` for seeding/quarantining scenarios.
  - `window.__EDYTOR_SYNC_ERROR__` — captures `edytor.sync` refusal (schema
    gate) deterministically instead of an async rejection.
  - `data-testid="value"` — `JSON.stringify(edytor.value)` render, used for
    full-JSON-equality convergence assertions.

### WebSocket room (`?collabws=<room>&wsserver=<ws-url>`)

- **Route**: `/test/dom?scenario=collab&collabws=<room>&wsserver=<url>` — same
  deterministic seed, but the sync factory constructs the production
  `WebsocketProvider` (`src/lib/crdt/providers/websocket.ts`) instead of
  `IndexeddbPersistence`. Optional `wsresync=<ms>` / `wsbackoff=<ms>` tune the
  provider's resync interval and reconnect backoff for spec determinism.
- **No BroadcastChannel leg**: the websocket provider has none (retired in
  arch-v2 G-e; it used to be forced off here with `disableBc`), so
  BroadcastChannel can never mask a socket failure; the socket is the only
  transport.
- **Two and three independent browser contexts**: the socket specs call
  `browser.newContext()` per client — separate storage, separate BC domains,
  separate `Y.Doc`s that can only ever meet at the relay. The original spec
  uses two contexts; the hardening extension
  (`collaboration-websocket-3client.spec.ts`) uses three.
- **Local opaque relay** (`tests/editor-dom/ws-relay.ts`): a dependency-free
  RFC6455 server that runs inside the Playwright worker process and implements
  exactly the documented supported topology — group sockets by room (URL
  path), forward binary frames **verbatim** to the other members. It never
  decodes the v14 envelope, never merges state, never answers sync. Upstream
  `y-websocket`'s `setupWSConnection` is **not** this — even with no
  persistence hook it keeps a server-side doc, decodes message types, and runs
  its own sync handshake, so enveloped v14 frames are unhandled there
  (dropped, never relayed). This relay is the reference implementation of the
  only proven-compatible server class (see `crdt-v14-providers.md` §server
  compatibility classification).
- **Harness fault hooks** (deliberate relay-level faults, NOT transport
  claims): `hold`/`release` with `permute` + `duplicates` (replay of the held
  batch in permuted order, delivered N times), `setLatency` (every forwarded
  frame delayed), `dropNext` (deliberate loss healed by the provider's resync
  handshake), `killRoom` (sever every socket in a room), `stop`/`start` (kill
  the relay, re-listen on the same port), `forwarded` (per-direction frame log
  for envelope assertions), `socketCount`/`pendingCount`.

## Scenarios proven (`tests/editor-dom/collaboration-multiclient.spec.ts`, 7 tests)

| #   | Scenario                                                                    | What it proves                                                                                                                                                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `converges concurrent edits in different blocks and in the same block`      | Real keyboard typing on A and facade edits on B run concurrently; both replicas converge to **byte-identical serialized JSON** — different-block inserts keep both texts; same-block concurrent inserts merge with both contributions present.                                                                                   |
| 2   | `renders the remote caret while the remote client edits`                    | Awareness propagates across the provider: A's caret renders inside B's DOM as a remote selection overlay while A edits.                                                                                                                                                                                                          |
| 3   | `local undo removes only the local edit and preserves remote text`          | Selective undo: A types, B types, A undoes — A's own edit is removed, B's remote text survives; replicas still converge.                                                                                                                                                                                                         |
| 4   | `restores document content from IndexedDB after a cold reload and re-syncs` | A types, `storeState` flushes IDB, `page.reload()` — the editor re-mounts from IndexedDB (not the fixture: `alpha-persisted` survives), re-joins the BC room, and edits flow **bidirectionally** afterward.                                                                                                                      |
| 5   | `refuses a mismatched-schema document through the real component`           | A persisted doc hand-crafted with `meta.v = 99` + `schema = 'edytor'` is loaded into the same IDB room; on mount `edytor.sync` throws `SchemaMismatchError` (surfaced on `__EDYTOR_SYNC_ERROR__`), `edytor.synced` stays `false`, **zero** `[data-edytor-block]` nodes render — the gate fails closed inside the real component. |
| 6   | `converges after interleaved stress edits across both clients`              | 30 rounds of interleaved text inserts + structural `moveBlocks` fired simultaneously from both pages; every A marker `a0..a29` survives somewhere in the converged tree.                                                                                                                                                         |
| 7   | `converges divergent edits after a partition and reconnect`                 | `disconnectBc` on both providers → edits stay local (`PA>alpha` only on A, `PB>gamma` only on B — partition verified) → `connectBc` re-runs sync step 1+2 → both replicas merge to identical JSON containing both edits.                                                                                                         |

Companion spec `tests/editor-dom/collaboration.spec.ts` (3 tests) covers remote
cursor awareness rendering, offline IndexedDB reload, and provider-destroy
awareness cleanup — rewritten from v13 `doc.getText` to the v14 `doc.get` /
`insert` / `toArray` API.

## Scenarios proven over the socket (`tests/editor-dom/collaboration-websocket.spec.ts`, 6 tests)

All six run against the local opaque relay, and the websocket provider has no BroadcastChannel leg — nothing but
browser → TCP → relay → TCP → browser carries state.

| #   | Scenario                                                                              | What it proves                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `converges two independent browser contexts over the socket transport`                | Providers reach `wsconnected: true, synced: true` with no BroadcastChannel leg; the same-id seed dedupes to `collab-b1/b2/b3`; concurrent **real-keyboard** typing in different blocks and the same block converges to byte-identical JSON on both replicas; every relayed frame asserted to carry the v14 envelope (first byte `varuint 14`).                                                         |
| 2   | `propagates awareness and renders the remote caret over the socket`                   | B's caret rides `messageAwareness` frames over the socket and renders inside A's DOM as `[data-edytor-remote-cursor][data-client-id]`; stays live while B types; convergence holds.                                                                                                                                                                                                                    |
| 3   | `converges divergent edits after a socket kill and a relay restart`                   | Two partition flavours: (a) `killRoom` severs all sockets while the relay stays up — providers reconnect and re-handshake on their own; (b) `stop()` kills the relay entirely — edits made offline stay local (verified divergent), then `start()` on the same port → backoff reconnect → SyncStep1/2 replay → `PA>alpha` + `PB>gamma` merge on both replicas with identical ids.                      |
| 4   | `converges under held, permuted, duplicated, delayed and dropped delivery`            | `hold` buffers both sides (genuine concurrency), `release({permute, duplicates:2})` replays the batch out-of-order and doubled — converges anyway; `setLatency(150)` delayed delivery converges; `dropNext(2)` deliberate loss is healed by the provider's periodic resync handshake. Distinct from TCP semantics, deliberately: these are replay faults a live connection can't produce.              |
| 5   | `local undo removes only the local edit after remote edits over the socket`           | A inserts `-A`, B inserts `-B` (both over the socket), A's `undoManager.undo()` removes only `-A` — `alpha-B` on both replicas; the undo inverse itself travels the socket.                                                                                                                                                                                                                            |
| 6   | `preserves ownership through concurrent splits and a concurrent move over the socket` | The WU1 regressions end-to-end over sockets: concurrent `splitBlock` at offsets 3 and 8 held then released → `collab-b2='abc'`, `early='defgh'`, `late='ijbeta'`; left-edge `X` into `early` does not steal `late`'s atoms; split-at-0 empty-head typing fills the head (`wb='Z'`, `wbtail='abcdefghij'`); held concurrent `moveBlocks` + remote `insertText` → `collab-b3` at index 0 with `M>gamma`. |

## Scenarios proven over the socket with three clients (`tests/editor-dom/collaboration-websocket-3client.spec.ts`, 5 tests)

Hardening Unit-6 extension: **three** independent browser contexts (separate
storage, separate BC domains), no BroadcastChannel leg on any provider — the socket is
the only transport. Assertions are semantic per replica (exact `blockText`,
`marks` runs, block-identity ownership), not just "all equal".

| #   | Scenario                                                                              | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `converges a concurrent split, marked edit, and move across three contexts`           | Relay `hold` makes three ops genuinely concurrent: A `splitBlock('collab-b2',2)`, B `insertText` into `collab-b3` with `{bold:true}`, C `moveBlocks('collab-b1'→end)`. Pre-release divergence verified per replica; after release all three converge to `[b2='be', splitA='ta', b3='gamma'+bold '-B', b1='alpha']` — split ownership partitioned, mark preserved on the exact run, moved block kept id+content at index 3.                                                                                                                                                                        |
| 2   | `converges divergent edits after a one-client partition, reconnect and reload`        | `provider.disconnect()` partitions C while A↔B keep syncing (`socketCount` drops to 2, `wsconnected:false` on C). Both sides edit (A text, B `formatRange` italic, C offline text) — divergence asserted semantically per side — then `connect()` re-handshakes all three to one document. Then `pageC.reload()`: the fresh doc re-syncs over the socket alone (no IndexedDB on this route) and lands on the converged state, marks included.                                                                                                                                                     |
| 3   | `converges under permuted, duplicated, delayed and dropped delivery to three clients` | Held three-way concurrent edits released with `permute:true, duplicates:3` — every member receives the batch reordered and tripled, converges to identical runs (`beta` + italic `<B`, code-marked `C>` + `gamma`). `dropNext(1)` drops one inbound update to BOTH other members — healed by the resync handshake. `setLatency(60)` delayed fan-out converges.                                                                                                                                                                                                                                    |
| 4   | `selective undo removes only the undoing client's edits across three clients`         | A/B/C each commit one local edit (B's is bold-marked). A's `undo()` removes only `-A`; B's marked `-B` and C's `-C` survive on all three replicas, asserted run-for-run (`{text:'-B', marks:{bold:true}}` intact). B's `undo()` then removes `-B` and its mark — `gamma` returns unmarked while `-C` persists.                                                                                                                                                                                                                                                                                    |
| 5   | `a refused schema handshake claims no sync, then recovers when a clean peer joins`    | A rogue room member (raw Node `WebSocket` in the worker, speaking the real v14 envelope) answers every SyncStep1 with a SyncStep2 carrying `meta.v=99` (deterministic LWW winner, `clientID = MAX_SAFE_INTEGER`). The joining client stages and **refuses** each reply: `provider.synced` stays `false` across ≥4 resync cycles, `edytor.synced` stays `false`, zero blocks render, `evil-v99` never enters the doc, `schema-mismatch`/`message-error` fire. When two clean peers join, the refused client syncs honestly and all three converge to the seed — recoverability over a real socket. |

## Root causes found and fixed

### 1. Multi-block drag deleted both selected siblings

`tests/editor-dom/block-handles.spec.ts:164`. The DnD path moved selected
siblings individually; target indices shifted under it and both blocks vanished.
Fix (`src/lib/plugins/blockHandles/blockHandleOperations.ts`): compute the drop
target once, adjust for moved source siblings, extract stable ids, call the
grouped `facade.moveBlocks` (one transaction, identity-preserving) inside
`edytor.transact`, `flushMirror`, then reselect the original wrappers on the
next tick.

### 2. Code-line typing truncated at the caret

`tests/editor-dom/selection.spec.ts:857` — typing `C` produced `ret` instead of
`retCurn a;`. `getMarksAtRange` derived insertion marks from **decorated**
`this.children`, and the code plugin's local Prism `codeToken` transform leaked
into persisted marks — the inserted character serialized as a separate marked
run and the assertion on the first content run saw truncation. Fix
(`src/lib/text/text.utils.ts`): derive marks from model-authoritative
`this.value`; the comment documents that decorated children carry local
rendering transforms and must never feed persisted marks.

### 3. IME character dropped at a code-suggestion boundary

`tests/editor-dom/composition.spec.ts:321` — composed `に` vanished. Same
decoration-leak root cause as #2; fixed by the same `getMarksAtRange` change.

### 4. Collaboration spec still on the v13 API

`tests/editor-dom/collaboration.spec.ts` used `doc.getText('note')` /
`.insert()` / `.toString()`. Rewritten to v14: `doc.get('note')` unified node,
`node.insert(0, '…')`, `node.toArray().join('')`.

### 5. The structural-move freeze (largest defect)

Concurrent **structural** moves (not text inserts) froze a receiving page for
80 s+ — effectively forever. Diagnosis, in order:

- Provider `readMessage()` completed; the freeze was in **post-apply scheduled
  work**, not transport.
- CDP `Debugger.pause` on the busy main thread showed a constant stack:
  `move → reconcile → commit → update_reaction → update_effect → #traverse →
#process → flush` — inside **Svelte's keyed `{#each}` reconciliation**, stuck
  at `i = 1` forever.
- Frame inspection showed `effect.nodes.end` — the each-item fragment's end
  boundary — **detached** (`endConnected: false`, `parentNode: null`). With
  `end` unreachable, `move()` walks the whole sibling list and reconcile's
  `i -= 1` retry path re-enters it indefinitely (captured: **347,589**
  `ChildNode.before` calls in a repeating 10-node cycle).
- Who detached it? `domTextMutationObserver`'s
  `removeAddedUnmanagedNodes`: any unmanaged **empty `#text` node** added
  outside an editable island was treated as browser junk and removed — but
  those are exactly Svelte's `{#each}`/`{#if}` fragment anchors
  (`nodes.start`/`nodes.end`), re-inserted whenever `move()` reorders a keyed
  fragment. The observer ate the anchor; the next reconcile corrupted.

Why it needed exactly two moves: move #1's DOM churn flushed the observer,
which deleted the anchor; the corruption sat latent until move #2's reconcile
walked the broken fragment. Inserts never moved anchors → insert-only
collaboration always converged. Local moves froze the same way — the bug is
transport-agnostic; the remote path just triggers it reliably.

**Fix** (`src/lib/events/domTextMutationObserver.ts`, `shouldRemoveAddedNode`):
empty text nodes outside editable islands are kept. Svelte anchors are always
empty; a browser-injected empty text node is invisible and harmless, while a
deleted anchor is fatal. Result: 10 remote structural moves converge in <1 s
(previously 80 s+/timeout); the single-page two-move repro went from a hard
hang to instant.

### 6. Route-level noise fixed en route

- `src/routes/test/dom/+page.svelte` — `data.collab` initial-value capture
  warning silenced via `untrack` (the load payload is static per navigation);
  `IndexeddbPersistence` used as a type → `InstanceType<typeof …>`.

### 7. SSR awareness timer pinned the Node event loop (socket/packaging follow-up)

The packed-consumer SSR smoke built and rendered correctly, then the Node
process never exited. `Edytor` constructs `Awareness`
(`src/lib/crdt/protocols/awareness.ts`), which starts a recurring `setInterval`
for the stale-client sweep; an SSR render creates an awareness instance that
nothing destroys, and the live timer kept the event loop alive. Fix: `unref()`
the interval when the timer supports it (Node timers do; browsers ignore it) —
SSR processes exit cleanly, browser sweeping is unchanged.

### 8. Packed-consumer `run.sh` — Svelte consumer build boundary

The packed consumer initially compiled `App.svelte` through **two** Svelte
plugins (an inline `svelte()` plus `vite.config.mjs`'s) and the second pass
choked on already-compiled output ("Expected a valid element or component
name"). Fix: single plugin registration in `svelte-app/vite.config.mjs`;
client `vite build` and SSR `vite build --ssr` both consume it.

## Evidence

Serial browser matrix: `pnpm test:integration:serial`
(`playwright test --workers=1`, all five configured projects, 1209 tests,
~6.8 min). Per-engine counts:

| Lane                                                              | Result                                                                                                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Chromium (`tests/editor-dom`)                                     | **372 pass / 1 skip / 0 fail**                                                                                                    |
| Firefox (`tests/editor-dom`)                                      | **371 pass / 2 skip / 0 fail** (full-project rerun post-harness-fix; the one serial-run failure is explained below)               |
| WebKit (`tests/editor-dom`)                                       | **369 pass / 6 skip / 1 flaky→pass** (composition timing test retried green; project has `retries: 1`)                            |
| Mobile Chromium (`tests/editor-dom/mobile-*`)                     | **45 pass / 0 skip**                                                                                                              |
| Mobile WebKit (`tests/editor-dom/mobile-*`)                       | **42 pass / 3 skip**                                                                                                              |
| Websocket spec — Chromium / Firefox / WebKit                      | **6/6 on each engine** (firefox verified again post-fix, focused run 6/6)                                                         |
| Websocket 3-client spec — Chromium / Firefox / WebKit             | **5/5 on each engine** (focused run 2026-09-21: chromium 9.6s total, firefox 12.2s, webkit 18.8s — 11/11 incl. the 2-client spec) |
| Multiclient + companion specs — Chromium (post-socket-work rerun) | **10/10**                                                                                                                         |
| `pnpm test` (vitest unit)                                         | **1247 pass / 0 fail** (56 files, 1 skipped, 11 todo)                                                                             |
| `pnpm test:dom`                                                   | **142 pass / 0 fail**                                                                                                             |
| `pnpm test:crdt`                                                  | **1258 pass / 0 fail** (7 skipped)                                                                                                |
| `pnpm check`                                                      | **0 errors, 0 warnings**                                                                                                          |
| `pnpm lint` (prettier + eslint)                                   | clean                                                                                                                             |
| `tests/packed-consumer/run.sh` (fresh tarball)                    | **ALL PASS** — node smoke, vite client build, SSR render, browser mount/edit/readonly/teardown, strict `tsc` typechecks           |

Serial-run defect note (test harness, not the engine): the first serial pass
recorded 1 firefox failure in `converges divergent edits after a socket kill
and a relay restart` — while the relay is down, Firefox reports the refused
WebSocket as a **pageerror** ("Firefox can't establish a connection to the
server at ws://…"), not a console error like Chromium/WebKit. The spec's
reconnect-noise filter only covered console errors. Fix: `trackPageIssues`
gained `ignorePageErrors` and the noise pattern covers both wordings; the
firefox rerun of the whole project is green.

Multi-client spec timings post-fix: every test converges in **0.3–1.4 s**
across all three engines (previously structural moves alone took 80 s+ or
timed out). Socket-spec timings: each of the 6 tests completes in ~0.2–2.6 s
per engine.

## Limitations and remaining risks

- **The relay is local and in-process, not a deployed server.** The socket
  proof runs against a same-host RFC6455 opaque relay inside the Playwright
  worker — loopback latency, no TLS, no auth, no horizontal scaling, no
  persistence. The documented server contract (group-by-room, verbatim binary
  forwarding) is what it implements, and nothing stronger is claimed.
- **Permuted/duplicated/dropped delivery is harness replay, not TCP.** A live
  TCP connection preserves order and never duplicates or silently drops
  mid-stream; the spec deliberately distinguishes those relay-level faults
  from transport semantics. What they prove is that v14 update application is
  idempotent and the state-vector resync heals gaps — which is the property
  that matters for real networks, where a middlebox or a reconnect can still
  produce redelivery and gaps at the application layer.
- **At most three clients, three contexts, one relay.** The socket proof
  tops out at a three-member room (three independent browser contexts over
  one in-process relay). N>3 fan-out, cross-relay topologies, a second
  relay, and any participating/persistence-hook server (the topology docs
  classify as unsupported for v14 — including upstream `y-websocket`'s
  `setupWSConnection`, which interprets message types rather than relaying
  bytes) are unproven.
- **No hosted server, TLS, or auth.** Every socket test terminates at the
  loopback relay in the Playwright worker — no deployment, no `wss://`
  handshake, no credential path, no proxy/middlebox behavior. The rogue-peer
  test speaks a well-formed v14 envelope; a malicious-but-protocol-valid
  peer is covered only for the schema-refusal path, not for hostile framing
  or floods.
- **Browser matrix skips are pre-existing intentional skips** (e.g.
  Chromium-only CDP-IME and clipboard tests are `test.skip` on other engines)
  — see the Evidence table for exact counts per project; nothing is
  summarized away.
- **Small docs, bounded fan-out.** The proof uses 3-block fixtures and ≤30-op
  stress; BroadcastChannel coverage is two contexts, socket coverage tops out
  at three. Large-document remote structural storms are unmeasured; the random
  corpus (`test:crdt`) covers the model side at 150 seeds × 200 ops × 3 peers.
- **The empty-anchor exemption is a guard, not a redesign.** The DOM mutation
  observer still can't distinguish Svelte-owned DOM from browser-owned DOM by
  ownership — only by shape/location. A future browser quirk that injects
  non-empty unmanaged nodes between blocks could still fight reconciliation;
  the safe follow-up is scoping removals to editable islands entirely.
- **Presence coverage is caret-level.** Selection ranges, remote drag states,
  and awareness churn under partition are not separately asserted.
- **Schema gate proven at the component boundary** (`meta.v=99` →
  `SchemaMismatchError`, unsynced, no render). Unversioned-but-populated
  quarantine and unsupported-version _broadcast_ signaling are covered at the
  provider/unit level, not re-asserted here.

## Gate 3 handoff

- Integration claim is now browser-backed: collaboration (convergence,
  presence), persistence (IDB reload), selection/undo (selective local undo),
  plugins (full plugin stack mounted on the proof route), readonly rendering,
  and package delivery (`publint` clean) all verified end-to-end.
- Deterministic collab route + provider hooks are in place for Gate 3 to add
  harder cases: larger docs, N>3-member rooms, remote-selection ranges. The
  websocket relay + adversarial-delivery + three-client coverage is already
  done (this doc, socket sections above).
- Packed-consumer extension (socket follow-up): `tests/packed-consumer/` now
  also proves the Svelte component surface from the real tarball — Vite client
  build, Vite SSR build + render (readonly output asserted non-editable,
  seeded text + `data-edytor` markup present), and a Chromium page that mounts
  the editable + readonly editors, renders the `richTextPlugin` surface, types
  through the real input path, inserts through `facade.insertText`, and
  unmounts cleanly. Node runtime smoke + strict `tsc` (nodenext + bundler,
  `skipLibCheck:false`) still pass; plain-Node root import failing on
  `.svelte` remains the expected package-boundary behavior.
- Two latent engine-level risks to carry forward: (a) the vendored rc.26
  skip/GC overlap crash on lossy reloads (seeds 86/140 repros — provider sync
  uses full updates so it's unreachable today, documented in U07); (b) the
  observer-vs-Svelte DOM ownership boundary described above — worth a design
  pass before more DOM-mutating plugins land.
- Ledger updated: `docs/crdt-v14-execution-ledger.md` U10 → complete.
