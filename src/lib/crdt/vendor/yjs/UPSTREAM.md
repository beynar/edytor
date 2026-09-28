# Vendored Yjs v14 — provenance & patch manifest

This directory vendors the Yjs v14 engine source plus the exact local patches
applied on top — an owned fork (arch-v2 decision D1): P8 prunes everything
edytor does not run on. Do not edit files under `src/` by hand — apply a
recorded patch and document it here.

## Pinned source

| Field | Value |
| ----- | ----- |
| Upstream repo | `github.com/yjs/yjs` |
| Commit | `96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64` (upstream `main` HEAD at vendor time) |
| Upstream package | `@y/y@14.0.0-rc.26` (latest published release, 2026-09-07) |
| Tarball | `https://github.com/yjs/yjs/archive/96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64.tar.gz` |
| Tarball SHA-256 | `4b5ad4100dcbd211fa33b420c0a992564e84286b654259a67e64c05af08d7b85` |
| License | MIT, © Kevin Jahns — see `LICENSE` |
| Upstream engines | `node >= 22.0.0`, `npm >= 8.0.0` (recorded in edytor `package.json#engines`) |

## Dependency pins (edytor `package.json` / `pnpm-lock.yaml`)

| Package | Pin | Purpose |
| ------- | --- | ------- |
| `lib0-v14` | `npm:lib0@1.0.0-rc.32` | the engine's `lib0` dep (`^1.0.0-rc.29` upstream), **aliased** so the v13 runtime keeps `lib0@0.2.117` |
| `lib0` | `^0.2.117` | unchanged — still used by `yjs@13.6.30`, `y-protocols`, `localProvider.ts` |
| `@y/protocols` | `1.0.6-rc.1` (devDep) | reference for U07 provider port; `@y/y` peer override-pinned to `14.0.0-rc.26` |
| `yjs` | `13.6.30` | unchanged — the live v13 runtime |

## Layout

```text
src/        upstream src/, plus patches P1 (import specifiers), P4, P5, P7 and P8 (pruning)
global.d.ts upstream global.d.ts, plus patches P1 and P8
dts/        generated TypeScript declarations (not upstream source — see below)
LICENSE     upstream MIT license, verbatim
UPSTREAM.md this file
```

Upstream test suite is vendored **outside** `src/lib` at
`vendor-tests/yjs/tests/` so it never ships in `dist`; since P8 it is pruned to
the kept surface.

## Local patches

### P1 — `lib0/` → `lib0-v14/` import specifier rewrite (`src/**`, `global.d.ts`)

Reason: the repo keeps `lib0@0.2.117` for the v13 runtime; the v14 engine needs
`lib0@1.0.0-rc.32`. Both are real dependencies (`lib0` and the `lib0-v14` npm
alias), so the vendored source references `lib0-v14/*` literally — **no
Vite/bundler alias is involved at runtime or in the packed artifact**.

110 occurrences rewritten (imports and `import('lib0/…')` JSDoc references).
Reproduce:

```sh
# from the pristine upstream tree
find src -name '*.js' -exec sed -i '' 's|lib0/|lib0-v14/|g' {} +
sed -i '' 's|lib0/|lib0-v14/|g' global.d.ts
```

Verify: `grep -rn "lib0/" src global.d.ts | grep -v "lib0-v14/"` — only prose
mentions of "lib0" (comments) remain; every `lib0-v14` occurrence is followed
by `/`.

### P2 — vendored test specifier rewrite (`vendor-tests/yjs/tests/**`)

Same `lib0/` → `lib0-v14/` rewrite, plus relative `../src/` specifiers
retargeted to the vendored tree, plus the `@y/protocols/sync` import in
`testHelper.js` redirected to a local shim (P3). Reproduce:

```sh
cd vendor-tests/yjs/tests
find . -name '*.js' -exec sed -i '' \
  -e "s|from 'lib0/|from 'lib0-v14/|g" \
  -e "s|import('lib0/|import('lib0-v14/|g" \
  -e "s|from '\.\./src/|from '../../../src/lib/crdt/vendor/yjs/src/|g" \
  -e "s|import('\.\./src/|import('../../../src/lib/crdt/vendor/yjs/src/|g" \
  -e "s|from '@y/protocols/sync'|from './sync-shim.js'|g" {} +
```

### P3 — `vendor-tests/yjs/tests/sync-shim.js` (new file, test-only)

Verbatim port of `@y/protocols@1.0.6-rc.1` `src/sync.js` (MIT, Kevin Jahns)
with the engine import retargeted from `@y/y` to the vendored source and
`lib0/*` → `lib0-v14/*`. Required because the published `@y/protocols` would
construct a **second engine copy** from npm `@y/y`, breaking `instanceof`
checks against vendored docs. Test code only — not shipped.

### P4 — format-aware search-marker checkpoints for `applyDelta` + relative positions (WU9)

Reason: profiling the corrected WU8 baseline showed `YNode#applyDelta` always
starts its `ItemTextListPosition` walk at `_start` — every delta pays
O(items-to-target) — and `createAbsolutePositionFromRelativePosition` /
`createRelativePositionFromTypeIndex` walk the linked list linearly to sum
visible length. On a 60 k-item fragmented doc: distant `retain+insert`
≈ 4.1 ms/op, distant anchor resolve ≈ 0.23 ms/op. Upstream's
`ArraySearchMarker` pool already accelerates *index* lookups
(`typeListGet`, `typeListInsertGenerics`, `findMarker`) but was unusable for
`applyDelta` because the cursor also needs `currentFormats` — which upstream
kept disabled outright (`ContentFormat.integrate` set
`p._searchMarker = null`).

Patch (all in `src/`):

- `ynode.js` — `ArraySearchMarker` gains a `formats` field: a snapshot of a
  cursor's `currentFormats` at the marker's position (left edge of `p`),
  `null` when unknown. Written **only at quiescent points** — the end of
  `applyDelta` (post-op cursor state), after each retain op, and
  `findMarker`'s read walks — never mid-mutation: `formatText`'s in-flight
  `currentFormats` is transient and proved able to capture state invalidated
  later in the same operation.
- `ynode.js` — `updateMarkerFormats(parent, currPos, format)` folds a freshly
  integrated `ContentFormat` into snapshots at-or-right of the insertion
  (called from `insertFormats` / `insertNegatedFormats`). Positions compare
  in *list order*, not index space: markers anchored in the same-index run
  ending at `currPos.left` must not observe it. **Same-key boundary (R1
  repair):** the fold walks right from the insertion and stops at the first
  *live* `ContentFormat` that sets the same key — a snapshot anchored beyond
  that boundary still draws the key from the intervening marker, so folding
  the new one in would corrupt it (pre-repair, a `retain(50)+insert(Z,{b})`
  negation overwrote the snapshot inside a `[100,200)` bold span with `{}`,
  and the next seeded insert dropped bold from the span tail). Markers
  anchored *on* the boundary item are still updated — their snapshot is the
  state at their left edge, which precedes the boundary item's own effect.
  Candidates the walk never reaches (stale record: unlinked/merged anchor or
  an index lying about the true position) get `formats = null` instead of a
  blind update — invalidate, never corrupt.
- `ynode.js` — `applyDelta` seeds `currPos` from the best marker when the
  first op is a *pure* positioning retain (`op0.format == null &&
  op0.attribution == null` — lib0's `_isPlainRetain`), `renderer === null`,
  and the marker carries a snapshot. Eligibility: `m.index <= retain` after
  stepping left over countable/non-deleted items only (bounded, 64 steps —
  crossing a format marker or tombstone rejects the seed), anchor linkage
  verified, and `p` must be the *first* item at its index (upstream's walk
  stops on the first unprocessed item — format markers/deleted items sharing
  the index would seed a different list position). Only the leading retain is
  shortened; formatted retains are never shortened (their prefix applies
  formats).
- `ynode.js` — marker planting at quiescent points via `plantMarker`
  (dedupes same-index records). At the tail (`currPos.right === null`) the
  marker anchors on the last countable/non-deleted item with
  `index -= p.length` — sequential appends otherwise never produce a
  seedable checkpoint since every quiescent point sits at the tail; a
  countable item doesn't change format state so the tail `currentFormats`
  is also its left-edge state.
- `ynode.js` — `findMarker` folds `walkFormats` while walking right from a
  snapshot-carrying marker so returned markers carry a valid snapshot;
  left-walks drop it (state not reconstructable backwards).
- `ynode.js` — `overwriteMarker` and the `updateMarkerChanges` re-anchor
  clear `formats` (position changed → snapshot stale).
- `structs/Item.js` — `Item#delete` clears all snapshots in the parent when
  tombstoning a `ContentFormat` (the only path that changes format state
  without an insert; every cleanup path routes through `Item#delete`).
- `structs/Item.js` — `Item#mergeWith` clears `formats` on re-anchored
  markers (anchor moved left → snapshot stale).
- `structs/Item.js` — `ContentFormat.integrate` no longer nulls
  `p._searchMarker`: the marker *index* stays valid across format
  integrations (format items are non-countable); snapshots are maintained by
  the hooks above. Wholesale clears (`_searchMarker.length = 0`) still cover
  remote integration and undo.
- `utils/RelativePosition.js` — `createRelativePositionFromTypeIndex` and
  `createAbsolutePositionFromRelativePosition` seed/stop-early via
  `findMarker` + marked items (index space only — no formats needed).
  `marker.index` semantics: left edge of `p`, i.e. count of rendered units
  strictly before it.

Invalidation coverage (audit): format-item inserts → `updateMarkerFormats`
(same-key-bounded fold; unreachable anchors → `formats = null`); format-item
tombstones → `Item#delete` hook; re-anchors → `overwriteMarker` /
`updateMarkerChanges`; merges → `Item#mergeWith`; index shifts →
`updateMarkerChanges` (position preserved); remote → `_callObserver` clears;
undo/redo → `UndoManager` clears on `subProps.has(null)`; GC-unlinked anchors
→ linkage check in seed + candidate invalidation in `updateMarkerFormats`;
`Item.split` keeps the original as the left part so anchors stay valid;
renderer paths excluded (`renderer === null` gate — markers record raw
countable space which renderers don't affect).

Correctness oracle: `src/tests/crdt/marker-seed.test.ts` replays identical op
streams with markers enabled vs disabled (`_searchMarker = null` makes every
added path inert = upstream behavior) and requires **byte-identical**
`encodeStateAsUpdate` output plus identical rendered deltas — covering
distant inserts, formatted retains, format-marker inserts, deletes, undo/
redo, remote apply, GC, nested modify ops, merge/split cycles.
`src/tests/crdt/hardening/r1-p4-format.test.ts` pins the same-key boundary
rule (the R1 review's P4 corruption), runs randomized + structured
differential replays (patched vs disabled vs materialized pre-P4 baseline)
with per-op `toDelta` + store-byte equality across insert/delete/format/
undo/remote/GC schedules, and a one-off 18 000-op triple-fixture fuzz ran
clean. Development history: an earlier variant filled snapshots from
`forward()` mid-mutation — a differential test caught a stale `{hl,b}` vs
true `{hl}` state (byte-divergent stores, same render); the quiescent-write
design closes the invariant by construction. The follow-up review then found
the unbounded fold itself (the [100,200) shadowing case above) — fixed by
the boundary rule + conservative invalidation, not by disabling seeding.
`bench/lib/interop.mjs` syncs patched ↔ git-HEAD baseline peers via
`applyUpdate` — all checks pass.

### P5 — shared item-piece traversal + bounded read-only `RangeCursor` (U3)

Reason: Edytor's formatted range reads and the engine's own `toDelta`
carried **two** physical-sequence interpretations (the Edytor-side reader
folded format markers over `node._start` on its own, plus a private
checkpoint index). U3 consolidates the interpretation into the engine:
`toDelta` and bounded range reads now consume the same item-piece
traversal, and the P4 format-aware markers double as the read cursor's
checkpoints — the Edytor-side index is deleted.

Patch (all in `src/` unless noted):

- `utils/renderer-helpers.js` — new `readItemPieces(out, renderer, item,
  scratch?)`: the `AttributedContent` pieces one item contributes to a
  *current-state* render — renderer-claimed → `readContent` mode `1`;
  `ContentFormat` → one marker piece; tombstoned → nothing; otherwise the
  item whole. This is the single physical-sequence interpretation both
  consumers share. `scratch` is a caller-owned `AttributedContent` reused
  for the single trivial piece — both consumers drain `out` before the
  next item, so the common live-content path stays allocation-free
  (renderer-claimed items always allocate their own pieces).
- `ynode.js` — `YNode#toDelta`'s current-state walk
  (`itemsToRender === null && !retainInserts`) now iterates
  `readItemPieces` + `processContent` instead of its inlined dispatch —
  op-identical output (the same `useFormats`/`insert`/`deep`-ContentType/
  marker-fold state machine consumes the pieces); change renders and
  `retainInserts` overlays keep their original paths.
- `ynode.js` — `plantSearchMarker(parent, p, index, formats)` exported:
  the read-side counterpart of `plantMarker` — plants a format-aware
  marker at an explicit `{p, left-edge index, formats}` triple without an
  `ItemTextListPosition`, deduping same-index records identically.
- `utils/RangeCursor.js` (new file) — `RangeCursor`: a forward-only,
  read-only cursor over one `YNode` list. `read(i0, i1, stats?)` seeks via
  the `_searchMarker` pool, walks `readItemPieces` per item folding
  `ContentFormat` state exactly like `ItemTextListPosition#forward`
  (tombstoned markers apply nothing), and emits `RangePiece`s — content
  (borrowed), first-element `id`, rendered `index`/`offset`/`len`,
  effective `deleted`, native `attrs` (the
  `createAttributionFromAttributionItems` inputs), and the folded
  `formats` object (shared per fold state — read-only for consumers).
  Semantics preserved: countable vs non-countable, deleted and
  restored/attributed-tombstone content, renderer-aware splitting and
  `contentLength`, UTF-16 string clipping identical to clipping a
  `toDelta` insert op, inline/element content, read-your-writes
  mid-transaction. Two deliberate design points:
  - **Read seed is weaker than the mutation seed (P4):** a read may resume
    on *any* linked item at-or-left of the target — the forward fold
    reproduces format state — while `applyDelta` still requires the
    *first* item at the index (`a[b]b[b=null]c`: a tail marker anchored on
    `c` seeds reads but is correctly rejected for mutations — pinned by
    test). Both consume the same marker records.
  - **Read-driven planting:** cold walks record sparse markers every
    `READ_PLANT_GAP = 64` items stepped (`renderer === null` only) —
    `findMarker`'s merge-left rule cannot anchor mid-run in
    same-client-contiguous lists, so read workloads keep the pool filled
    themselves. Bounded cost: O(checkpoint-gap + range), never O(text).
  - **Purity:** reads never open a transaction — no updates, no item
    splits, no undo-state changes, no renderer install/mutation. The only
    writes are `_searchMarker` maintenance — the same adaptive cache
    writes upstream's own read-path lookups perform — non-replicated and
    behavior-invisible (byte-identical stores with the pool disabled).
- `index.js` — exports `RangeCursor`.

Correctness oracle: `src/tests/crdt/range-cursor.test.ts` — bounded
output vs the whole-node `toDelta` reference over every range (marks
inherited across boundaries, null clears, surrogate/code-unit clipping,
inline atoms, tombstoned content+markers, attribution via
`AttributionsRenderer` (since P8: its test port `ContentMapRenderer`), remote `applyUpdate`, undo/redo,
open-transaction reads, forward/backward/repeated cursor reuse), read
purity (no updates/splits/undo/renderer changes; marker perturbation
invisible to mutations), traversal bounds, and the
`a[b]b[b=null]c` read-seed-vs-mutation-seed counterexample.
`src/tests/crdt/runs/range-reads.test.ts` +
`gateF2/wu8-range-reads.test.ts` cover the Edytor projection: parity vs
the pre-WU8 `toDelta().toJSON()` oracle at every range, marker pinning
(`index` = anchor's left edge, `formats` = fold at that edge), the
marks-alias boundary (corruption is confined to one cursor — marker
snapshots are adopted by private copy), and maintained-view work bounds.

Measured (see `docs/crdt-v14-execution-ledger.md` U3 entry for the full
table): seeded 2k reads of a shared 100k formatted text stay range-sized
(mean 49 items + 32 markers walked per read, down from 62 + 41 with the
WU8 Edytor-side index; warm p50 ≈ 0.012 ms) with the marker pool filling
adaptively; `firstReadMs` carries the one cold walk. Routing `toDelta`'s
current-state items through `readItemPieces` + `processContent` costs a
modest per-item overhead vs the inlined dispatch it replaced (measured
≈ 0-15 %, within run-to-run noise on the 10-sample bench) — the
documented price of sharing the interpretation; the `scratch` reuse keeps
the common path allocation-free.

P4 measured (`node bench/lib/engine-micro.mjs quick`, 20 000-char fragmented
text = 60 k list items; before = `ENGINE_DIR=../vendor-baseline/yjs`
materialized HEAD copies; post-R1-repair numbers): distant `retain+insert`
1.80 → 0.92 ms/op (~2×), mid 0.99 → 0.50 (~2×), near unchanged (~0.007 ms —
walk already short), scattered distant 1.01 → 0.83 (~1.2×, no regression),
sequential append 1.02 → 1.01 (parity on the format-dense fixture — see
below); `createAbsolutePositionFromRelativePosition` single distant 0.14 →
0.0004 ms/op, `createRelativePositionFromTypeIndex` distant 0.13 → 0.0005
ms/op, ×200-anchor resolve 13.2 → 0.46 ms/op (~29×). The R1 boundary repair
cost nothing measurable — it bounds a walk that only runs when a format
item is integrated locally. On fragmented text WITHOUT format guards
(alternating-client churn, 10 k items) sequential append goes ~1.0 → 0.009
ms/op. On the format-dense fixture sequential positions are format-guarded
— the first-at-index check correctly rejects the seed (upstream's walk
would land on a different item in the same-index run), so that workload
stays ~1.0 ms/op; the win is position-dependent by design, never a
regression.

### P6 — side-correct current-state attribution rendering (REMOVED by P8)

> P8 deleted `src/utils/Renderer.js`, the file this patch lived in; the text
> below is kept as history. The side-correct semantics survive as the
> test-only `ContentMapRenderer` (`src/tests/crdt/harness/content-map-renderer.js`),
> which the renderer-plumbing tests install.

Reason: `AttributionsRenderer` merged insertion and deletion maps before
rendering every item. After undo/redo, a deleted original format marker still
carried its historical insertion attribution even when history replay had
created no deletion attribution. The merged renderer treated that opposite-side
coverage as an anonymous deletion, so the tombstone closed the format-authorship
range opened by its live redo copy. Text and marks round-tripped; native delta
attribution did not.

Patch (`src/utils/Renderer.js`):

- The ordinary current-state projection reads `ContentMap.inserts` for live
  items and `ContentMap.deletes` for tombstones. Opposite-side history alone no
  longer makes an item attributed or visible.
- Explicit `renderedContent` projections retain the upstream merged-map path.
  Restoring content from another point in time can still use attribution from
  the item's opposite current-state side.
- `contentLength` uses deletion-side coverage for current-state tombstones, so
  range traversal and full rendering keep the same index space.

Correctness oracle: `src/tests/crdt/runs/attribution.test.ts` pins marked insert
→ undo → redo and direct format → undo → redo. Both the maintained runs and the
native `toDelta({ renderer })` projection restore the original format actor.
The attribution and range-cursor slices cover ordinary insertion/deletion,
torn delivery, custom projection, remote merge, and cursor parity.

### P7 — `YNode#insertAtGapEnd(index, content)`: insert at the end of the gap (arch-v2 D11)

Reason: Edytor's stream boundaries (plan `docs/architecture-v2/plan.md` §2.1,
rule R2) must sit after the whole gap at a split point — after every tombstone
and every format item that precedes the next live character — so that an undo
of a text delete (whose copies `redoItem` integrates between the tombstone's
current left neighbour and the tombstone) keeps the restored text in the stream
that displayed it. The public insert cannot place an item there: its walk
(`minimizeFormatChanges`) stops at the first live format item whose value
differs from the requested one, and two concurrent formatters can leave two
same-key items with different values in one gap (the F1 counterexample,
`a5-concurrent-format-min`). The engine is an owned fork (maintainer decision,
plan revision 2); P7 is a feature of it, charged to the plan's vendor delta.

Patch (`src/ynode.js`, both hunks delimited by `// P7 begin` / `// P7 end`):

- `insertAtGapEndHelper(transaction, parent, index, content)` (exported):
  a renderer-free `ItemTextListPosition` walks `index` countable live units
  (splitting a live item mid-way with `getItemCleanStart`), then forwards past
  every deleted item and every `ContentFormat` item (folding live formats), and
  integrates one `Item` with `content` between the cursor's neighbours. No
  format item is inserted, so the content carries exactly the formats in
  effect there. Search markers are shifted with `updateMarkerChanges`, the
  same call `insertContent` makes. `index > length` throws
  `Exceeded content range`, like `formatText`.
- `YNode#insertAtGapEnd(index, content)`: one `transact` around the helper
  with `new ContentAny(content)` (an array of JSON values, one countable unit
  each). Throws on a detached node.
- `dts/ynode.d.ts`: the two declarations added by hand (same shapes the
  generator emits for the JSDoc). Since P8 the generator runs clean and emits
  them from the JSDoc — nothing in `dts/` is hand-edited any more.

Nothing else changes: P7 adds a path and touches no existing function.

Correctness oracle: `src/tests/crdt/p7-gap-end.test.ts`.
- Semantics: the item lands after every tombstone and format item in the gap
  and before the next live content item; the clock advances by exactly one and
  no format item is added; with two live same-key format items of different
  values in the gap (built by a delete concurrent with two formatters) the
  public insert stops inside the gap while P7 passes both, and the inserted
  unit renders with the fold's formats; mid-item split, index 0, text end, and
  the out-of-range throw; concurrent gap-end inserts converge under three
  client-id assignments.
- Byte-equality differential (the P4 method): the test materializes the pre-P7
  engine by copying `src/` into `node_modules/.cache/edytor-p7-baseline` with
  every `// P7 begin … // P7 end` hunk stripped (and asserts the copy has no
  `insertAtGapEnd`), then replays 40 seeded programs × 120 operations over every
  existing public write path — `insert` with and without formats, `delete`,
  `format`, inline `Node` and JSON inserts, `UndoManager` undo/redo, remote
  `applyUpdate` between two docs, gc on and off — on both engines, and
  requires identical `encodeStateAsUpdate` bytes for both docs and an
  identical `toDelta` after EVERY operation.
- The upstream suite (`pnpm test:crdt`, `vendor-tests/yjs`) passes unchanged.

Vendor delta: +27 xloc in `src/` (census `--vendor`), plus 9 declaration lines
in `dts/`.

### P8 — prune the fork to the surface edytor runs on (arch-v2 P3, decision D1)

Reason: `crdt/engine.js` (P3.1) hands every `bind*` a 23-symbol engine
object, so consumer bundles already tree-shake the rest — but the shipped
source, its declarations, the `edytor/crdt` namespace and the upstream suite
still carried ≈1,400 execution lines edytor never runs: concrete renderers,
snapshots, update diff/log/obfuscate helpers, delta-position mapping, id-map
algebra and content-id helpers. D1: an owned fork keeps what it uses.

Kept surface (the rule): every declaration reachable from the engine object
in `src/lib/crdt/engine.js` plus `mergeUpdates` (server coordinators compact
with it), the IdMap/ContentMap codec pair (`encodeIdMap`/`decodeIdMap`,
`writeIdMap`, `encodeContentMap`/`writeContentMap` — the inverse of the
`readIdMap`/`decodeContentMap` that read legacy `a/` attribution records) and
`createContentAttribute`. Also kept though unreachable: the duplicate-import
guard in `index.js`, `AbstractContent` (the content interface) and the XML
type-ref ids in `structs/Item.js` (wire format). Every surviving upstream
export stays exported; the renderer INTERFACE stays (`AbstractRenderer`,
`$renderer`, `useRenderer`, `toDelta({renderer})`, `RangeCursor`'s
renderer-aware reads, `renderer-helpers.js`), so P4, P5 and P7 are untouched.

Deleted files: `utils/Renderer.js` (and with it P6), `utils/Snapshot.js`,
`utils/position-helpers.js`, `utils/delta-helpers.js`, `utils/logging.js`.

Deleted declarations (with their JSDoc):

| File | Declarations |
| ---- | ------------ |
| `utils/EventHandler.js` | `removeAllEventHandlerListeners` |
| `utils/ID.js` | `writeID`, `readID` |
| `utils/RelativePosition.js` | `writeRelativePosition`, `encodeRelativePosition`, `readRelativePosition`, `decodeRelativePosition`, `compareRelativePositions` |
| `utils/StructStore.js` | `integrityCheck` |
| `utils/UndoManager.js` | `undoContentIds` |
| `utils/YEvent.js` | `getPathTo` |
| `utils/encoding.js` | `readUpdate`, `diffUpdate`, `createDocFromUpdate`, `createDocFromUpdateV2`, `cloneDoc` |
| `utils/ids.js` | `gcIdSet`, `_createInsertSliceFromStructs`, `createInsertSetFromStructStore`, `encodeIdSet`, `decodeIdSet`, `mergeIdMaps`, `createIdMapFromIdSet`, `createIdSetFromIdMap`, `diffIdMap`, `intersectMaps`, `filterIdMap`, `$idMap` |
| `utils/meta.js` | `createContentIds`, `createContentIdsFromContentMap`, `createContentIdsFromDoc`, `createContentIdsFromDocDiff`, `excludeContentIds`, `excludeContentMap`, `mergeContentMaps`, `mergeContentIds`, `createContentMapFromContentIds`, `writeContentIds`, `encodeContentIds`, `readContentIds`, `decodeContentIds`, `intersectContentMap`, `intersectContentIds`, `filterContentMap` |
| `utils/transaction-helpers.js` | `nextID`, `tryGc` |
| `utils/updates.js` | `logUpdate`, `logUpdateV2`, `encodeStateVectorFromUpdateV2`, `encodeStateVectorFromUpdate`, `createContentIdsFromUpdateV2`, `createContentIdsFromUpdate`, `createObfuscator`, `obfuscateUpdate`, `obfuscateUpdateV2`, `convertUpdateFormatV1ToV2`, `intersectUpdateWithContentIdsV2`, `intersectUpdateWithContentIds` |
| `ynode.js` | `getNodeChildren`, `$node`, `typeListInsertGenericsAfter`, `lengthExceeded`, `typeListInsertGenerics`, `typeListPushGenerics`, `typeListDelete`, `nodeMapGetSnapshot`, `nodeMapGetAllSnapshot`, `isVisible` |

Hand edits beyond deletion: `YNode#getAttrs()` loses its `snapshot`
argument; `index.js` drops the deleted names and re-exports `AbstractRenderer`
and `$renderer` from `utils/renderer-helpers.js` (they came through
`Renderer.js`); `global.d.ts` drops the `Snapshot` alias; two JSDoc types in
`utils/RelativePosition.js` point at `./renderer-helpers.js`; imports that
became unused are removed. `dts/` is regenerated
(`scripts/regen-crdt-vendor-types.sh`, which now runs tsc clean).

Measured: vendored execution lines (`node scripts/xloc.mjs
src/lib/crdt/vendor --vendor`) 7,152 → 5,761 (−1,391), 33 → 28 files;
`edytor/crdt` exports 161 → 85.

Upstream suite (`vendor-tests/yjs/`) rewritten to the kept surface: tests
whose subject is a deleted subsystem are removed (`snapshot.tests.js`, the
renderer/diff/suggestion tests of `attribution.tests.js`, the delta-position
and gc-id-set tests, obfuscate/intersect/state-vector-from-update, id-map
algebra, `$node`/`$idMap` schemas); tests of kept behaviour stay, with
test-side ports where a helper went (`testHelper.js` compares encoded delete
sets instead of snapshots and wraps `diffUpdateV2` for V1; `updates.tests.js`
ports `createContentIdsFromUpdate`/`encodeStateVectorFromUpdate` over the
kept `decodeUpdate(V2)`; relative positions resolve in memory; the IdMap
diffing tests keep their codec roundtrip). 331 → 222 tests (221 upstream
tests kept, 110 removed, 1 codec roundtrip replacing two).

Correctness oracle:
- `src/tests/crdt/p8-surface.test.ts` pins `edytor/crdt`'s exports and
  proves closure: rolldown-bundling the engine object + the keep list keeps
  every top-level vendored declaration outside the allowlist above.
- `bench/lib/mk-baseline.sh` now materializes the PRISTINE upstream engine
  (`@y/y@14.0.0-rc.26`, installed as the `@y/protocols` peer, + P1), and the
  baseline leg of `src/tests/crdt/hardening/r1-p4-format.test.ts` (patched vs
  upstream, per-op `toDelta` + byte-identical `encodeStateAsUpdate`) and
  `bench/lib/interop.mjs` pass against it; the P4/P7 differentials
  (`r1-p4-format`, `marker-seed`, `p7-gap-end`) stay green.

Re-syncing with upstream: take the new upstream `src/`, apply P1, re-apply
the P4/P5/P7 hunks (diff this tree against the pinned upstream as in
"Diffing against upstream"), then run `pnpm exec vitest --config
./vitest.crdt.config.ts --run src/tests/crdt/p8-surface.test.ts` — its
closure failure lists exactly the declarations to delete (update `KEPT` for
deliberate export changes), and regenerate `dts/`.
### P9 — pending structs record every stacked dependency (`src/utils/encoding.js`)

(P8 is reserved for the phase-2 P3 fork pruning.)

Reason: `integrateStructs` walks a dependency stack; when the head waits for a
client that is already on the stack it records only the head's missing client
in the pending state vector (`missingSV`). The dependency of the struct at the
bottom of the stack is lost, so the later update that supplies it never
triggers `readUpdateV2`'s retry, and the document holds a pending update it
could integrate — forever, until some unrelated update from the recorded
client arrives. Reproduced on the unmodified `@y/y@14.0.0-rc.26` with four
updates (A1 ← B1 ← A3, A2 independent) delivered as A3, B1, A1, A2; found by
the arch-v2 phase 2 P1 fuzz (`src/tests/crdt/arch-v2/p1-fuzz.test.ts`, an
observer fed every update in reverse order stayed pending in 74/1,500 seeds).

Patch (all hunks marked `// P9` or delimited by `// P9 begin` / `// P9 end`):
a `stackMissing` array parallel to `stack` records the client each stacked
struct waits for (pushed with the struct, popped with it); `addStackToRestSS`
first records every one of them in `missingSV` at the store's clock. Recording
more clients can only cause more retries, never a wrong integration.

Oracle: `src/tests/crdt/p9-p10-engine.test.ts` — the raw program in every
delivery order, the facade program the fuzz found in every order, and the
stripped tree (the P9 hunks removed) stays pending on A3, B1, A1, A2.

### P10 — the formatting cleanup after a remote change runs under an untracked origin (`src/utils/Transaction.js`)

Reason: `cleanupYTextAfterTransaction` deletes the format items a remote
change made redundant in a new transaction with the `null` origin — the
untyped-local origin every default `UndoManager` (and edytor's
`document.history`) tracks. Receiving a peer's delete over text this user had
formatted therefore pushed an invisible step onto this user's undo stack, and
the next undo reverted the cleanup instead of the user's last edit
(`docs/editor-delete-contract.md` `conc.undo.actor-local`,
`hist.capture-group`). Reproduced on the unmodified `@y/y@14.0.0-rc.26`.

Patch (hunks marked `// P10` or delimited by `// P10 begin` / `// P10 end`):
the cleanup transaction's origin is a module-private
`Symbol('yjs.formatting-cleanup')`. It stays a local transaction whose update
providers broadcast like any local write (a replica's cleanup is
order-dependent, so peers must receive it to converge); no undo manager
tracks the symbol.

Oracle: `src/tests/crdt/p9-p10-engine.test.ts` — after a peer's replace,
partial delete or full delete over A's bold run, A's undo stack is unchanged,
one undo removes A's last edit, and the peers still converge; the stripped
tree (the P10 hunks removed) puts the cleanup on the stack.

## Generated declarations (`dts/`)

`svelte-package` copies JS verbatim but emits no `.d.ts` for JS inputs, so
declarations are generated the same way upstream does (`tsc` over the
JSDoc-annotated source):

```sh
scripts/regen-crdt-vendor-types.sh   # tsc -p tsconfig.vendor-dts.json + fixups
```

Emits `dts/**/*.d.ts` mirroring `src/` layout, plus `dts/global.d.ts` with
`import('./src/…')` → `import('./…'` remapped to the emitted tree and a
`/// <reference path="./global.d.ts" />` prepended to `dts/index.d.ts`.
Emitted types reference `lib0-v14/*` — resolved via the real dependency.

Emit runs clean since P8 (the upstream `TS2589` came from the deleted
`utils/delta-helpers.js`).

## Diffing against upstream

```sh
# fetch pristine source
curl -sL -o /tmp/yjs.tgz \
  https://github.com/yjs/yjs/archive/96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64.tar.gz
shasum -a 256 /tmp/yjs.tgz   # expect 4b5ad410…8d7b85
tar -xzf /tmp/yjs.tgz -C /tmp
UP=/tmp/yjs-96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64

# engine source: normalize P1 away, then diff — prints exactly the P4–P8 hunks
# (the pinned tarball's src/ equals node_modules/@y/y@14.0.0-rc.26/src)
mkdir -p /tmp/yjs-normalized && cp -R src/lib/crdt/vendor/yjs/src /tmp/yjs-normalized/
find /tmp/yjs-normalized -name '*.js' -exec sed -i '' 's|lib0-v14|lib0|g' {} +
diff -r "$UP/src" /tmp/yjs-normalized/src
diff "$UP/global.d.ts" <(sed 's|lib0-v14|lib0|g' src/lib/crdt/vendor/yjs/global.d.ts)
diff "$UP/LICENSE" src/lib/crdt/vendor/yjs/LICENSE

# tests: reverse P2 specifiers, then diff (prints the P8 test pruning)
cp -R vendor-tests/yjs/tests /tmp/yjs-tests-normalized
cd /tmp/yjs-tests-normalized && rm -f sync-shim.js && find . -name '*.js' -exec sed -i '' \
  -e "s|from 'lib0-v14/|from 'lib0/|g" -e "s|import('lib0-v14/|import('lib0/|g" \
  -e "s|from '../../../src/lib/crdt/vendor/yjs/src/|from '../src/|g" \
  -e "s|import('../../../src/lib/crdt/vendor/yjs/src/|import('../src/|g" \
  -e "s|from './sync-shim.js'|from '@y/protocols/sync'|g" {} +
diff -r "$UP/tests" /tmp/yjs-tests-normalized
```

## Upstream test record (this tree)

Runner: `vendor-tests/yjs/upstream.test.js` registers every `testXxx(tc)`
export as a vitest test with a real `lib0-v14/testing` `TestCase`.

- `pnpm test:crdt` — **216 pass / 6 skipped / 0 failed** since P8 (was 325/6
  before; upstream standard tier; the 6 skips are upstream's own
  `t.skip(!t.production)` extensive-tier gates: 3× y-array, 3× y-map random
  stress tests).
- `pnpm test:crdt:extensive` (`PRODUCTION=1`) — 331 pass before P8 (~200 s;
  includes the 30 000-op randomized stress test); 222 tests since P8.
- Reproduce a seed: `YJS_TEST_SEED=<n> pnpm test:crdt`.
- Vitest runs each test once; upstream's `runTests` repeats `testRepeat*`
  cases for `--repetition-time` ms — that repetition loop is not replicated.
