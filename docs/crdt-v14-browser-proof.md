# CRDT v14 — real-browser multi-client proof (U10)

Date: 2026-09-20 · Unit: **U10 — integrated convergence + real-browser multi-client proof** · Status: **complete**

This document records the end-to-end browser evidence for the vendored v14 CRDT
integration: how the proof is wired, what was proven, the defects found and
fixed along the way, measured results, and what remains unproven.

## Topology

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

## Evidence

| Lane                                                   | Result                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| Chromium Playwright (`tests/editor-dom`)               | **368 pass / 0 fail / 1 skip**                                 |
| Multiclient spec — Chromium / Firefox / WebKit         | **7/7, plus 3/3 companion collab tests on each engine**        |
| `pnpm test` (vitest unit)                              | **1207 pass / 0 fail** (50 files)                              |
| `pnpm test:dom`                                        | **137 pass / 0 fail**                                          |
| `pnpm test:crdt`                                       | **1228 pass / 0 fail**                                         |
| `pnpm test:crdt:extensive`                             | **1234 pass / 0 fail** (incl. 331 vendored upstream yjs tests) |
| `pnpm check` / `test:typecheck` / `test:dom:typecheck` | **0 errors, 0 warnings**                                       |
| `pnpm lint` (prettier + eslint)                        | clean                                                          |
| `pnpm build` → `svelte-package` + `publint`            | **"All good"** — package delivery verified                     |

Multi-client spec timings post-fix: every test converges in **0.3–1.4 s**
across all three engines (previously structural moves alone took 80 s+ or
timed out).

## Limitations and remaining risks

- **Transport is BroadcastChannel, not a socket.** Same-context pages only;
  BC delivery can't be delayed or reordered, so wire-level adversarial
  ordering is unproven in-browser (covered instead by the unit-level replica
  corpus and `test:crdt` sync tests). The `WebsocketProvider` path is ported
  and unit-tested but has no live server in this proof.
- **Firefox/WebKit ran the collaboration specs, not the full 369-test suite.**
  The collab/provider/persistence paths are green on all three engines; the
  broader DOM suite was run on Chromium only.
- **Two clients, small docs.** The proof uses 3-block fixtures and ≤30-op
  stress. Large-document remote structural storms are unmeasured; the random
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
  harder cases: larger docs, a third client, websocket relay, delayed/reordered
  delivery, remote-selection ranges.
- Two latent engine-level risks to carry forward: (a) the vendored rc.26
  skip/GC overlap crash on lossy reloads (seeds 86/140 repros — provider sync
  uses full updates so it's unreachable today, documented in U07); (b) the
  observer-vs-Svelte DOM ownership boundary described above — worth a design
  pass before more DOM-mutating plugins land.
- Ledger updated: `docs/crdt-v14-execution-ledger.md` U10 → complete.
