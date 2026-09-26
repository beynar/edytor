# U08 — Application runtime cutover to the v14 facade

Status: **complete** (2026-09-22). Companion to `crdt-v14-execution-ledger.md` and
`crdt-v14-implementation-plan.md` (U08).

> **Post-cutover update (follow-up work unit 2):** the compat bridge described
> below is **removed**. `src/lib/crdt/compat.ts` is deleted; wrappers and op
> utilities now call the typed node surface in `src/lib/crdt/nodes.ts`
> (`insertChildren`, `deleteChildren`, `insertParts`, `deleteParts`,
> `insertAt`, `deleteAt`, `formatAt`, `setData`, `isInDocument`, …) directly.
> `FACADE_MUTATORS`, the fake `yRootBlock`, and `_docVersion` are gone —
> projection caching keys on the facade-owned `version` token, which preserves
> same-transaction read-your-writes. Sections marked "compat" below are kept
> as U08 historical record; the ledger WU2 row is authoritative for the
> current shape.

## What changed

The live editor runtime now runs on the vendored v14 engine through the
injection boundary (`src/lib/crdt/engine.ts` + `bindCrdt(Y)`), the
`EdytorDoc` facade (`src/lib/crdt/edytor-doc.ts`), and the placement/text
models built by U03–U06. No `yjs` (v13) imports remain in `src/lib` outside
the explicitly retained areas (`crdt/vendor/**`, `crdt/migration/**`,
`crdt/compat.ts` comments). v13 packages (`yjs@13`, `y-protocols`,
`y-websocket`, `y-indexeddb`, `lib0`) remain **devDependencies only** —
used by gate/boundary tests and the legacy-fixture generator.

### Runtime shape

- `Edytor` constructs `bindCrdt(Y)` once and binds `EdytorDoc` over the
  injected `YDoc`. Exactly one production CRDT engine is instantiated.
- `Block`, `Text`, `InlineBlock` are facade-bound live wrappers. The v13-era
  call surface (`text.yText.insert/delete/applyDelta`,
  `block.yContent.push`, `block.yChildren.insert/delete`, `Y.Map`-like
  access) is preserved through compat adapters in `src/lib/crdt/compat.ts`,
  so operation utilities, plugin hooks, island/void semantics, the selection
  API, providers, and Svelte exports are unchanged for consumers.
- `EdytorDoc.assertUsableDoc` (edytor-doc.ts:275, invoked by the facade
  factory at :432) rejects non-v14 docs fail-fast — a v13 `Y.Doc` passed to
  `new Edytor({doc})` throws instead of degrading into the v14 runs layer.
- `src/lib/localProvider.ts` and `src/lib/block/content.svelte.ts` are
  deleted; `collaboration/providers.ts` retargets to `bindProviders`.

### Cross-cutting semantics established during the port

- **Same-transaction reads.** v14 run views synchronize at commit while v13
  `Y.*` reads observe same-txn writes — so the shared model state also
  walks `doc._transaction.changed` on every mid-transaction read
  (`runs.ts` `syncTransaction`), giving command sequences read-your-writes
  inside an open transaction without waiting for the update event.
  `Edytor` memoizes `facade.project()` on `_docVersion`; every mutating
  facade call and every committed change bumps it (`edytor.svelte.ts`).
- **Shared incremental model state (WU7).** One per-document state
  (`bindRuns` attach, `WeakMap`-keyed, lease/refcounted across facades,
  torn down on last dispose or doc destroy) maintains `blocks`, lazy
  ownership, per-text interval rows, and the `placements`/`kids`
  (`childrenIndex`) facets behind a shared `ModelView`. `bindModel`'s
  `view()` is provider-injected — command preambles, anchors, projection,
  `takeSnap`, `childrenIdsIn`, and `DocChange` all read the same indexes
  instead of re-collecting per call; a bare `bindModel` keeps the
  fresh-collect fallback. Facet invalidation is classified per event:
  `content` dirties only the touched blocks' rows (placements/kids
  identity preserved); `slices`/`del`/registry inserts are structural;
  `at` is placement-only; `id`/`type`/`data` are metadata; unknown attrs
  conservatively count as structural. Content/meta-only commits report
  `commitInfo().fast` and `DocChange` patches just the touched ids
  (two-pass validate-then-patch, escalating to the full skeleton diff
  whenever a touched id is unexpectedly visible-but-untracked);
  structural commits take the full-snapshot path. See
  `docs/crdt-v14-benchmarks.md` §16 for measurements.
- **Wrapper identity.** Wrappers are identity-bearing — selection and op
  code hold references across mutations. `reconcileContent` never displaces
  a live `Text` wrapper for a pending carrier; pending ids are aliased in
  `idToText`.
- **Move, don't copy.** Existing subtrees are relocated via `yChildren.insert`
  → `facade.moveBlock`; `insertBlock` rejects already-live ids.
- **Marks.** Direct `Text.insertText` keeps one-shot `markOnNextInsert`
  semantics. Beforeinput/composition paths resolve insertion marks
  contextually (explicit → pending → adjacent-before → adjacent-after) in
  `events/beforeInputCommands.ts`, so contiguous marked typing coalesces
  without leaking syntax marks into structural insertions.
- **Proxy-safe cloning.** `structuredClone` was replaced with `cloneJson`
  (`utils/json.ts`) throughout `src/lib` — marks/data arriving through the
  Svelte component layer are `$state` proxies, which `structuredClone`
  rejects with `DATA_CLONE_ERR`. JSON payloads are the documented contract —
  see "Boundary contract" in `utils/json.ts`: `data`/`marks`/format payloads
  are JSON-typed only; non-JSON values (`Date`, `Map`, `undefined` keys,
  functions) cannot cross the wire and are coerced/dropped — reported via
  `console.warn` in dev builds so the loss is never silent (gate-3 F4).

## Real defects found and fixed

1. **Pending-wrapper reconciliation displaced live text wrappers**
   (`block.svelte.ts` `reconcileContent`): a second pass replaced the live
   wrapper a caller still referenced (selection/ops), producing
   "Failed to resolve content parts" failures plus an unhandled rejection.
   Fix: pending carriers die, live owner keeps identity, old id aliased.
2. **Cross-block deletion lost end-block children** (`edytor.utils.ts`
   `deleteContentWithinSelection`): it cloned `child.value` into
   `insertBlock`, which the facade rejects (ids already live). Fix: move the
   existing subtree ids through the bound `yChildren.insert` adapter.
3. **`structuredClone` on `$state` proxies** (DOM suite): mention/link-mark
   insertions threw `DATA_CLONE_ERR` inside transactions → 6 test failures +
   4 unhandled rejections. Fix: `cloneJson` everywhere (21 sites, 9 files).
4. **Redo silently no-opped after structural undo** — the most subtle bug in
   the unit. `facade.onChange`'s unsubscribe was bundled into `this.off`,
   which `attach`'s destroy path drains on every `{#key editorDomRevision}`
   remount (structural hotkeys/undo bump it). After the first remount the
   mirror detached permanently: the doc was correct (`toJSON`, projection
   both right) but `root.children` never reconciled again — undo worked
   (DOM already torn down+rebuilt) while redo applied to the doc and showed
   nothing. Fix: `Edytor.ensureFacadeChangeSub` (edytor.svelte.ts) tracks
   the sub with an idempotent release guard, re-establishes it inside
   `attach`, and forces a projection bump + `flushMirror` on re-subscribe so
   changes missed while detached converge.
5. **Mark inheritance divergence**: initial fix attempt put adjacent-mark
   inheritance in `Text.insertText` itself, which leaked `codeToken` syntax
   marks into code-plugin tab insertion. Final shape: one-shot direct ops,
   contextual resolution only in the beforeinput command layer.
6. **`toDelta().toJSON()` typed `unknown`** (`placement/model.ts`) — two
   svelte-check errors; cast to `{children?: unknown[]}` before iterating.

## Fixture/harness changes

- Collaboration fixtures and `dom/EdytorHarness.svelte` now create docs via
  `bindCrdt(Y).Doc` (the injection boundary) instead of v13 `new Y.Doc()`.
- `src/tests/crdt/fixtures/legacy-v13/generate.ts` hand-builds v13-schema
  documents with `yjs` for the legacy-reader tests — decode path is the v14
  `bindLegacyReader`; an `Edytor` is never constructed on a v13 doc.
- Type-only `yjs` imports in test plumbing replaced with internal/compat
  types (`dom/test.utils.ts`, `fixtures/types.ts`,
  `normalization/contracts.fixtures.tsx`, `EdytorHarness.svelte`).

## Verification evidence

| Surface                   | Result                                                                  |
| ------------------------- | ----------------------------------------------------------------------- |
| `vitest run` (unit)       | **1181 pass / 0 fail** — 48 files, 1 skip, 11 todo                      |
| `pnpm test:dom`           | **112 pass / 0 fail** — 3 files, 0 unhandled errors                     |
| `pnpm check`              | 0 errors / 0 warnings                                                   |
| `pnpm test:typecheck`     | 0 errors / 0 warnings                                                   |
| `pnpm test:dom:typecheck` | 0 errors / 0 warnings                                                   |
| `pnpm package` + publint  | clean — packed `import 'edytor'` surface builds                         |
| v13 import audit          | zero `from 'yjs'` in `src/lib` outside vendor/migration/compat comments |

Focused suites on the touched seams: model operations 89, transforms 106,
history 7, normalization 6, collaboration 3 (model) + 2 (dom), legacy-v13 11,
providers sync/persistence/websocket 16, engine-boundary 20, gate2 43 — all
green.

## Deferred / follow-ups

- **U09**: relative-anchor selection upgrades, history + presence
  refinements, deeper browser-input integration (the DOM fixture suite
  covers dispatched beforeinput/keydown paths, not real browser
  composition/IME or native selectionchange timing).
- **U10**: Playwright/browser convergence proof, packed-consumer runtime
  smoke (`pnpm release:check` browser matrix is environmental — Firefox/
  WebKit executables absent per U00 baseline).
- ~~`this.off` accumulates dead unsubscribe entries across keyed remounts~~
  **Resolved (gate-3 F3):** `attach`'s destroy now drains AND clears
  (`splice(0)`), so each `{#key editorDomRevision}` remount leaves exactly
  one live batch — no dead-closure accretion.
- `release:check` also covers `pnpm lint` — prettier/eslint not part of the
  U08 gate evidence (run before release).
