# Elegance review remediation

Date: 2026-09-23. Companion to `elegance-review-2026-09-23.md`. Executed
as six parallel file-ownership packages plus an integration pass:

- **P1 selection**: D3, D7, D8, D17, S3, S4, S12 + dead surface
  (`selection.shift`, `setAtTextRange`, write-only fields).
- **P2 events**: D11 (`domTextOffset.ts`), D12, D13, D18
  (`wordBoundary.ts`), D19 (`undoRestore.ts`).
- **P3 view/runtime**: D1 (empty `defaultValue`), D5 (`moveBlocks` op),
  D16, D20, D21, D25, S5–S9 + dead surface (`onDeselect` now fires,
  `BlockDefinition.schema`, `serialize.ts`, dead snippet keys).
- **P4 CRDT internals**: D2, D6, S2, S10, S11, `doc.rand` → `rand.ts`
  WeakMap. Detail below.
- **P5 facade/document**: D9, D14, D15, S13/S14, `undo-repair.ts`
  extraction, `admission.ts`, `failed` consumption.
- **P6 providers**: D4 (`failed` contract end-to-end), D10, D22, D23,
  D24, S1 (`providers/room.ts` — the duplicated room protocol now has
  one owner).

Verification (integrated tree): unit `pnpm test -- --run` **1,886**
green, `pnpm test:crdt` 1,807 green, `pnpm test:dom` 260 green,
`pnpm test:dst` 27 green, `pnpm check` / `pnpm test:typecheck` /
`pnpm test:dom:typecheck` / `pnpm lint` clean, packed-consumer suite
green. Full Playwright matrix (chromium/firefox/webkit/mobile):
**1,410+ passed, 0 failed** — after fixing the integration defects
found below.

## Fixed

### D2 — `moveBlocks` throws on an equal-rank seam → FIXED

`placement/model.ts` now routes ALL multi-block rank allocation through
`ranksAt` (`placement/model.ts:705`), the guard-aware allocator already
used by `insertBlocks`: when `left >= right` (equal ranks are a legal
replicated state — cycle-fallback rehoming produces them) the new ranks
join the left tie instead of calling `rankBetween`, which throws.
`moveBlocks` (`:955`) and the move-adjacent paths (`:866`, `:919`,
`:1008`, `:1026`, `:1068`) all consume it; `rankAt` is `ranksAt(.., 1)`.

Pin: `d2-move-rank-seam.test.ts` constructs equal-rank siblings (two
candidates carrying the same rank string) and group-moves across the
seam — previously `rankBetween: left >= right` inside `doc.transact`;
now the group joins the tie and display order falls back to
`(rank, blockId)` sort. The file also pins the inverted-seam case,
same-parent moves, and the pre-order `listBlockIds` shape.

### D6 — `undoRepairClaims` coalescing key non-injective → FIXED

`text/model.ts:1263-1299`: the pending-span coalescing map is now
**nested** — `Map<holder, Map<seqIndex, span>>` — so `(a, 12)` and
(`a1`, 2) can never meet. (The review suggested keying by `SliceEntry`;
the nested map is equivalent — `seqIndex` is already the live index of
the winning entry — and keeps the emitted grouping shape
`Map<holder, Map<seqIndex, SliceRecord[]>>` the writer in
`undo-repair.ts:342-351` consumes.)

Pin: `d6-undo-repair-key.test.ts`. The fixture stages holder `'a'`
claiming atoms `[2,4)` at seqIndex 12 and `'a1'` claiming `[4,7)` at
seqIndex 2 (both encode `'a12'` under the old key), tombstones the
middle span, undoes, and runs the real repair:

- surgical: `undoRepairClaims` must return two holder groups, one
  seqIndex bucket each, records covering `[2,4)` / `[4,7)`;
- end-to-end: facade + real `UndoManager` + doc-level repair observer →
  `'a'` displays `'23'`, `'a1'` displays `'456'`; a fresh replica
  converges on the replicated claims.

Mutation check: reverting the fix to `` `${holder}${seqIndex}` `` makes
both tests fail exactly as predicted — the fused claim lands on `'a'`,
which displays `'23456'` while `'a1'` gets nothing.

### S2 — atom-ownership contest ×4 → CONSOLIDATED

`text/model.ts` now owns the single claim-election walk:

- `gatherClaims` (`:762`) — one traversal producing elected claims;
  consumed by `computeOwnership` (`:993`), `claimRoutesToB` (`:1158`),
  and `undoRepairClaims`' red-claims gather (`:1242`).
- `resolveAnchor` (`:855`) + `sliceRange` (`:940`) — one range
  resolution with the shared `rangeCache`, replacing the `rangeOf` /
  `resolvedRange` duplication.
- `flatten` is the one display-walk; `text/runs.ts`'s `flattenTracked`
  (`runs.ts:947-956`) runs the SAME `T.flatten` walk over the runs
  facet's entry list, capturing dependencies rather than re-implementing
  traversal. `buildRow` (`runs.ts:918-933`) gathers via `gatherClaims`
  over the maintained per-text record index.
- `runs.ts`'s extent index walks id sets through `walkIdSetStructs`
  (`runs.ts:535`) instead of its own copy.

### S10 — schema literals in 3 places → ONE leaf module

New `src/lib/crdt/schema.ts` — the dependency-free leaf carrying every
root key, node name, and attr name (`REGISTRY_KEY`, `META_ROOT_KEY`,
`ATTRIBUTION_ROOT`, `BLOCK_ATTR_ROOT`, `BLOCK_NODE`, `CONTENT_NODE`,
`SLICES_NODE`, `AT_NODE`, `INLINE_NODE`, `ID`, `TYPE`, `DATA`, `DEL`,
`LAST_CHANGED_ATTR`, `CONTENT`, `SLICES`, `AT`, `REC_PREFIX`).

`edytor-doc.ts`'s `SCHEMA` manifest (`:168-229`) now **derives** its
values from these constants — one authority, no divergence possible.
`placement/model.ts`, `text/model.ts`, `text/runs.ts`,
`attribution/block.ts`, and `attribution/attribution.ts` all import the
constants directly from the leaf; the import-cycle workaround (literal
redeclaration) is gone. Replicated names are byte-identical — no
migration.

### S11 — vendor-internal access duplicated, silently disabling → CENTRALIZED + FAIL-FAST

New `src/lib/crdt/structs.ts` is the single vendor-internals surface:

- `clientsOf(doc)` (`:49`) — reads `doc.store.clients` and **throws a
  descriptive error** if the layout is absent (was: three modules
  hand-casting, optional-chained — a vendor rename silently disabled
  undo repair).
- `structAt(Y, structs, clock)` (`:65`) — wraps `Y.findIndexSS`,
  returns `null` on a miss (was a re-implementation).
- `walkIdSetStructs(Y, doc, idSet, fn)` (`:91`) — one insert/delete
  range walk for an IdSet; returns `false` on incomplete coverage.

Consumers: `undo-repair.ts` (suspicion gate + confirmation + copy-span
walks — the `insertSet===undefined → return` silent-disable path is
gone; a missing struct store throws inside the observer, which catches

- logs rather than converging wrongly) and `text/runs.ts` (`:535` — the
  maintained-view extent index walks both `insertSet` and `deleteSet`
  through the same helper). One deliberate policy split remains
  (`runs.ts:524-531`): the extent index is a perf refinement, so a
  missing `store.clients` degrades it to opaque (all-consumers
  invalidation stays CORRECT) rather than throwing inside the observer —
  undo-repair, where silent emptiness would corrupt ownership, is the
  fail-fast consumer.

### `doc.rand` monkey-patch → WeakMap boundary

New `src/lib/crdt/rand.ts`: `setDocRand`/`randOf` over
`WeakMap<EngineDoc, () => number>` — no shape extension of the vendored
`Doc`. `EngineDoc.rand` is deleted from `engine-api.ts` (the field no
longer exists to be forged). `placement/model.ts` reads `randOf(doc)` at
all seven rank-allocation sites; `peer-set.ts` seeds via `setDocRand`
(`:163`, `:424`, `:433`). Re-exported from `crdt/index.ts:317` for test
harnesses. Deterministic harness behavior preserved — the gate1
determinism suite passes unchanged.

### Dead code (caller-verified removals)

- `SliceEntry.item` — was write-only; removed. (Stamp offsetting now
  reads `content.str` slicing — see `SliceEntry.content` type.)
- `ResolvedPlacement.via` — write-only; removed.
- `splitSlices` dead `head` output — signature is now `{ tail } | null`.
- `contributorsOf` (`attribution/block.ts`) — removed; contributor union
  logic is inlined where it was the sole real consumer
  (`contributorsOfRecord` — the live per-record reader — is untouched).
- `isLive` (`placement/model.ts`) — removed; the one place that needed
  the semantics uses `liveNodeOf`.
- `'dead'` string owner → `DEAD` unique symbol
  (`text/model.ts:396`) — a literal `'dead'` block id can no longer
  collide with the dead-owner sentinel.

**Deliberately retained**: `resolveBlock` (`placement/model.ts:1347`,
facade `edytor-doc.ts:2325`) — the review listed it as an alias of
`liveNodeOf`, but it is a _live public API_: harness ops
(`harness/ops/{raw-node,doc,model}-ops.ts`), scenario/concurrency tests,
and probe files call `ed.resolveBlock`/`M.resolveBlock`. Removing it
would break the test surface, not dead code.

## Integration pass — defects found while validating the assembled tree

The parallel packages were individually green; integration surfaced two
real defects that none of the per-package lanes caught:

### Deferred selection writes steal foreign focus — FIXED

`setAtTextOffset`/`setAtRange`/`setAtBlockRange` each `await` node
resolution before writing. If the user clicked a foreign control during
that window, the write landed anyway — and in Firefox `addRange` inside
a contenteditable pulls focus to it with no `.focus()` call, so the
editor silently re-grabbed focus (caught by
`undo-scope.spec.ts` on the Firefox lane: `activeElement` bounced
`input → editor div` ~150ms after the trusted click).

Fix: `foreignFocusOwnsSelection()` (selection.svelte.ts) — checked at
**write time**, inside the retry loops, not at scheduling time (`await`
continuations resume only after the click's task completes, so
`activeElement` is already settled). When a foreign element holds focus
the writers take the model-only fallback (`setCollapsedStateAtTextOffset`
/`setRangeStateAtTextOffsets`/`syncStateToBlockRange`), the same contract
as the unresolvable-endpoint path. Nothing/body-focused stays writable —
the programmatic-restore and test-helper case.

Two rejected predicates, documented so they don't come back:

- `lastUserGestureOutsideEditor` is too broad: a preventDefault'd
  outside mousedown (toolbar buttons, `Toolbar.svelte` `onmousedown`)
  arms it while focus stays in the editor — gating on it collapses the
  selection after toolbar formatting (`toolbar.spec.ts` regression).
- `activeElement` at _scheduling_ time is too weak: the write's own
  awaits span the whole focus-transfer window.

Also armed the post-write verify timer (`scheduleCaretWriteVerification`)
with the same strict check — a repair must never expand scope.

### `focusForeignInput` test-helper flakiness — FIXED (harness)

`undo-scope.spec.ts` appended the bare `<input>` at `body` end, below
live debug `<pre>` dumps that re-render on every model change — under
parallel load the box could move between Playwright's actionability
check and the click dispatch. The input is now `position: fixed` at a
corner. (Instrumented probe: the _real_ failure was the focus-steal
above; the fixed geometry removes a second, independent flake vector.)

### Earlier integration findings (fixed in prior passes)

- Websocket handshake race — `synced` claimed by foreign SyncStep2
  replies broadcast by the opaque relay; fixed with the evidence-gated
  settle (`syncSettleMs`). See `adversarial-review-2026-09-23.md`.

## Deferred / retained

- **`resolveBlock`/`liveNodeOf` duality** — retained deliberately;
  `resolveBlock` is a live public/test API (harness + scenario callers),
  not dead surface.
- **S13 partial** — richer verdict returns from model ops still open
  (needs an op-result type; behavior correct today).
- **WS BroadcastChannel leg coverage** — provider logic is shared via
  `room.ts` and unit-tested, but the ws↔ws BroadcastChannel path still
  lacks a browser-level pin (every ws test forces `disableBc: true`).
- **`domTextMutationObserver` pre-existing race** — a repair can restore
  a pre-repair caret against a later input-path write (observed once,
  pre-dates this remediation; bounded by the verify machinery).
- **Vendor surface** — ~half the vendored export surface is unreachable
  from `src/lib`; kept intact deliberately so a vendor upgrade stays a
  drop-in, not a re-prune.

## Migration / cross-file notes

- **Wire + storage compat preserved**: slice records still write as
  `{t,s,e,g}`/`{m}` payloads on `slices` lists; D2 only changes _which_
  rank string is minted on a degenerate seam (a join-left rank is a
  valid replicated value); D6 only changes which holder's list a repair
  claim lands on (the fused-claim outcome was the _bug_). No
  `SCHEMA.version` bump — names are identical values sourced from the
  leaf.
- **Internal API shape changed**: `undoRepairClaims` returns
  `Map<holder, Map<seqIndex, SliceRecord[]>>` (was a flat map of fused
  keys). Sole consumer is `undo-repair.ts` — updated to iterate holder
  groups → seqIndex buckets, inserting descending so earlier inserts
  never shift later targets.
- **`EngineDoc.rand` removed**: any out-of-tree code seeding
  `doc.rand` must switch to `setDocRand(doc, fn)`; reads via
  `randOf(doc)` fall back to `Math.random` for unseeded docs (same
  effective default as before).
- **`structs.ts` is the vendor-layout tripwire**: a vendored-Yjs
  upgrade that renames `store.clients`/`findIndexSS` now fails loudly in
  `clientsOf`/`structAt` at the first undo-shaped transaction or extent
  walk — including under the runs view — rather than silently disabling
  repair.

## Release-gate fixes (2026-09-24)

Three correctness boundaries from the independent pre-release review —
each reproduced against the tree, fixed, and pinned.

### RG1 — owned `<Edytor {sync}>` never saw `failed`

**Defect:** the component invoked the `sync` factory directly with only a
`synced` callback. A terminal provider failure left the document pending
and the view unsynced forever; the injected-document path handled the
same failure correctly through `attachDocumentSync`.

**Fix:** the component now routes through `attachDocumentSync`
(`Edytor.svelte` onMount), so the owned path gets the same
pending-count/failure-settlement/cleanup contract. `edytor.svelte.ts`'s
constructor binds `whenDocumentReady` for the owned+sync case too — a
failed provider settles the pending claim, `whenDocumentReady` wakes the
view, and the view performs the local `edytor.sync()` decision itself.
Owned-document cleanup is unchanged (`edytor.destroy()` →
`document.destroy()` runs the tracked provider cleanup).

**Also fixed in passing:** an injected _already-ready_ document plus a
`sync`-carrying view previously bound nothing (the view never synced);
the same readiness bind now covers it.

**Pins** (`tests/fixtures/dom/collaboration/document-sync.test.tsx`):
owned doc + terminally-failing factory still seeds; ready injected doc +
late sync view syncs immediately; owned-path teardown stays
component-lifetime (`cleanup === 1` on unmount).

### RG2 — stale blurred-selection repair refocused the outside element

**Defect (reproduced in Chromium by the reviewer):** the deferred repair
in `restoreRelativePosition` captured the blurred `externalActiveElement`
at schedule time and, ~50 ms later, refocused it + restored the old caret
— even when focus and caret had already returned to the editor. The
callback never re-checked ownership at execution time.

**Fix:** the retry closure aborts when the outside-ownership evidence is
gone — `lastUserGestureOutsideEditor` is cleared by the `focusin` back
into the editor, so the delayed callback reads it **at run time** and
yields instead of refocusing the stale element.

**Pin repair:** the pre-existing `selection-ownership.test.tsx` test was
**vacuous** — it used `edytor.transact`, whose origin equals
`edytor.transaction`, so `restoreRelativePosition` skipped the blurred
branch entirely. The pins now write through a foreign-origin update and
assert the repair does not steal focus/caret back; both verified to fail
without the guard (red→green).

### RG3 — websocket empty-room readiness used one ambiguous window

**Defect:** an applied-but-empty SyncStep2 armed a single `syncSettleMs`
(300 ms) window; an empty doc at expiry claimed `synced`. A delayed
hydration reply could arrive after the client had already decided the
room was empty and seeded — the documented residual bound was too wide.

**Fix — two-round settle** (`providers/websocket.ts`,
`armSyncSettle`): the first quiet expiry sends a fresh SyncStep1 probe
and arms a second window; `synced` is claimed only after **two**
consecutive quiet windows with the transport still connected. A
state-bearing SyncStep2 at any point claims `synced` immediately.
Disconnect/destroy clears probe+timer state so a reconnect re-derives
readiness from its own handshake; BC frames never arm the ws handshake
(`emitSynced=false`).

**Pins** (`src/tests/crdt/providers/websocket.test.ts`, +4): foreign
empty SyncStep2 does not claim sync; first expiry emits a second
SyncStep1; a state-bearing reply inside round two resolves immediately;
genuinely empty rooms complete only after the second quiet window;
reconnect uses a fresh handshake.

**Residual bound (documented in `crdt-v14-providers.md`):** a hydration
reply delayed past _both_ windows can still race the seed — the honest
limit of request/reply without a server-side room epoch. If the product
needs a hard guarantee, the contract upgrade is a nonce'd/authoritative
room-state handshake, not a longer timer.

### Validation (release-gate round)

| lane                                   | result                          |
| -------------------------------------- | ------------------------------- |
| `pnpm test -- --run`                   | 1,887 / 117 files               |
| `pnpm test:dom`                        | 264                             |
| `pnpm check` / typechecks / lint       | clean                           |
| Chromium collab/focus/selection subset | pass                            |
| Firefox targeted subset (fresh server) | 11/11                           |
| WebKit targeted subset (fresh server)  | 16/16                           |
| packed-consumer                        | ALL CHECKS PASSED               |
| browser perf vs packaged tree          | §21 of `crdt-v14-benchmarks.md` |

An earlier combined Firefox+WebKit run reported mass failures —
`ECONNREFUSED 127.0.0.1:4173`, the shared dev server died mid-run.
Infra failure, not product: both subsets pass clean on fresh servers.

### New pins added this round

- `document-sync.test.tsx`: owned-path terminal `failed` → view seeds;
  ready injected doc + late sync view; teardown count.
- `selection-ownership.test.tsx`: deferred repair yields when ownership
  returned (foreign-origin write; verified red without the guard).
- `websocket.test.ts`: two-round settle contract (4 tests).
