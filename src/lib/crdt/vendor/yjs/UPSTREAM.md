# Vendored Yjs v14 — provenance & patch manifest

This directory vendors the Yjs v14 engine source plus the exact local patches
applied on top — an owned fork (an architecture-v2 decision): YP8 prunes everything
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
| `lib0-v14` | `npm:lib0@1.0.0-rc.32` | the engine's `lib0` dep (`^1.0.0-rc.29` upstream), **aliased** so the name never meets the `lib0@0.2` line `yjs@13` installs for itself |
| `@y/protocols` | `1.0.6-rc.1` (devDep) | installs the pristine `@y/y@14.0.0-rc.26` (its peer, override-pinned) that `bench/lib/mk-baseline.sh` materializes for the differential lanes; the protocol ports in `src/lib/crdt/protocols/` cite it |
| `yjs` | `13.6.30` (devDep) | the v13 engine, for the legacy-fixture and v13→v14 migration tests only (never shipped) |
| `yjs-14-move` | `npm:yjs@14.0.0-1` (devDep) | the historical move-engine regression test (`src/tests/crdt/historical/issue-694.test.ts`) |

The v13 provider stack (`y-protocols`, `y-websocket`, `y-indexeddb`, `lib0@0.2`)
is no longer a dependency of any kind: `tests/packed-consumer/smoke.js` and
`src/tests/crdt/boundary-attacks/public-boundary.test.ts` refuse it.

## Layout

```text
src/        upstream src/, plus patches YP1 (import specifiers), YP4, YP5, YP7, YP8 (pruning), YP9–YP15, YP16 (no delta layer), YP17 (one update encoding), YP18 (no undo manager), YP19 (only what edytor calls) and YP20 (hold records)
global.d.ts upstream global.d.ts, plus patches YP1, YP8 and YP19
dts/        generated TypeScript declarations (not upstream source — see below)
LICENSE     upstream MIT license, verbatim
UPSTREAM.md this file
```

Upstream test suite is vendored **outside** `src/lib` at
`vendor-tests/yjs/tests/` so it never ships in `dist`; since YP8 it is pruned to
the kept surface.

## Watching upstream

`.github/workflows/upstream.yml` runs every Monday (and on demand, for a
given version): `scripts/upstream-check.mjs` asks npm for a `@y/y` above
the pin by semver within its major line (14.x, pre-releases included), and
when there is one downloads both tarballs (each checked against the
registry's `dist.integrity`), writes `upstream.diff` (pin → newer, YP1
applied to both) and `fork.diff` (newer → this tree, both carrying YP1) into
the run's artifact, says in the summary whether the installed `lib0-v14`
satisfies the newer engine's `lib0` range (a mismatch is a run warning: a
red check may then be the older lib0, not the fork), then materializes the newer engine as `bench/vendor-baseline/yjs`
so `bench/lib/interop.mjs` (the fork and the newer engine syncing over the
wire) and the baseline leg of `src/tests/crdt/hardening/search-marker-format.test.ts`
(byte-identical stores after every operation) run against it. A red run
means the re-sync needs care; the re-sync itself is the manual recipe under
YP8. Locally: `node scripts/upstream-check.mjs`, then those two checks, then
`bench/lib/mk-baseline.sh` to restore the pinned baseline.

## Local patches

### YP1 — `lib0/` → `lib0-v14/` import specifier rewrite (`src/**`, `global.d.ts`)

Reason: the repo kept `lib0@0.2.117` for the v13 runtime when the engine was
vendored, and the v14 engine needs `lib0@1.0.0-rc.32`; the engine's is the
`lib0-v14` npm alias (the v13 line is now only `yjs@13`'s own, for the
migration tests), so the vendored source references `lib0-v14/*` literally — **no
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

### YP2 — vendored test specifier rewrite (`vendor-tests/yjs/tests/**`)

Same `lib0/` → `lib0-v14/` rewrite, plus relative `../src/` specifiers
retargeted to the vendored tree, plus the `@y/protocols/sync` import in
`testHelper.js` redirected to a local shim (YP3). Reproduce:

```sh
cd vendor-tests/yjs/tests
find . -name '*.js' -exec sed -i '' \
  -e "s|from 'lib0/|from 'lib0-v14/|g" \
  -e "s|import('lib0/|import('lib0-v14/|g" \
  -e "s|from '\.\./src/|from '../../../src/lib/crdt/vendor/yjs/src/|g" \
  -e "s|import('\.\./src/|import('../../../src/lib/crdt/vendor/yjs/src/|g" \
  -e "s|from '@y/protocols/sync'|from './sync-shim.js'|g" {} +
```

### YP3 — `vendor-tests/yjs/tests/sync-shim.js` (new file, test-only)

Verbatim port of `@y/protocols@1.0.6-rc.1` `src/sync.js` (MIT, Kevin Jahns)
with the engine import retargeted from `@y/y` to the vendored source and
`lib0/*` → `lib0-v14/*`. Required because the published `@y/protocols` would
construct a **second engine copy** from npm `@y/y`, breaking `instanceof`
checks against vendored docs. Test code only — not shipped.

### YP4 — format-aware search-marker checkpoints for `applyDelta` + relative positions (WU9)

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
`src/tests/crdt/hardening/search-marker-format.test.ts` pins the same-key boundary
rule (the R1 review's YP4 corruption), runs randomized + structured
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

### YP5 — shared item-piece traversal + bounded read-only `RangeCursor` (U3)

Reason: Edytor's formatted range reads and the engine's own `toDelta`
carried **two** physical-sequence interpretations (the Edytor-side reader
folded format markers over `node._start` on its own, plus a private
checkpoint index). U3 consolidates the interpretation into the engine:
`toDelta` and bounded range reads now consume the same item-piece
traversal, and the YP4 format-aware markers double as the read cursor's
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
  - **Read seed is weaker than the mutation seed (YP4):** a read may resume
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
`AttributionsRenderer` (since YP8: its test port `ContentMapRenderer`), remote `applyUpdate`, undo/redo,
open-transaction reads, forward/backward/repeated cursor reuse), read
purity (no updates/splits/undo/renderer changes; marker perturbation
invisible to mutations), traversal bounds, and the
`a[b]b[b=null]c` read-seed-vs-mutation-seed counterexample.
`src/tests/crdt/runs/range-reads.test.ts` +
`text-model-probes/range-read-hazards.test.ts` cover the Edytor projection: parity vs
the pre-WU8 `toDelta().toJSON()` oracle at every range, marker pinning
(`index` = anchor's left edge, `formats` = fold at that edge), the
marks-alias boundary (corruption is confined to one cursor — marker
snapshots are adopted by private copy), and maintained-view work bounds.

Measured (see `docs/archive/crdt-v14-execution-ledger.md` U3 entry for the full
table): seeded 2k reads of a shared 100k formatted text stay range-sized
(mean 49 items + 32 markers walked per read, down from 62 + 41 with the
WU8 Edytor-side index; warm p50 ≈ 0.012 ms) with the marker pool filling
adaptively; `firstReadMs` carries the one cold walk. Routing `toDelta`'s
current-state items through `readItemPieces` + `processContent` costs a
modest per-item overhead vs the inlined dispatch it replaced (measured
≈ 0-15 %, within run-to-run noise on the 10-sample bench) — the
documented price of sharing the interpretation; the `scratch` reuse keeps
the common path allocation-free.

YP4 measured (`node bench/lib/engine-micro.mjs quick`, 20 000-char fragmented
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

### YP6 — side-correct current-state attribution rendering (REMOVED by YP8)

> YP8 deleted `src/utils/Renderer.js`, the file this patch lived in; the text
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

### YP7 — `YNode#insertAtGapEnd(index, content)`: insert at the end of the gap (arch-v2 D11)

Reason: Edytor's stream boundaries (plan `docs/archive/architecture-v2/plan.md` §2.1,
rule R2) must sit after the whole gap at a split point — after every tombstone
and every format item that precedes the next live character — so that an undo
of a text delete (whose copies `redoItem` integrates between the tombstone's
current left neighbour and the tombstone) keeps the restored text in the stream
that displayed it. The public insert cannot place an item there: its walk
(`minimizeFormatChanges`) stops at the first live format item whose value
differs from the requested one, and two concurrent formatters can leave two
same-key items with different values in one gap (the F1 counterexample,
`a5-concurrent-format-min`). The engine is an owned fork (maintainer decision,
plan revision 2); YP7 is a feature of it, charged to the plan's vendor delta.

Patch (`src/ynode.js`, both hunks delimited by `// YP7 begin` / `// YP7 end`):

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
  generator emits for the JSDoc). Since YP8 the generator runs clean and emits
  them from the JSDoc — nothing in `dts/` is hand-edited any more.

Nothing else changes: YP7 adds a path and touches no existing function.

Correctness oracle: `src/tests/crdt/yp7-gap-end.test.ts`.
- Semantics: the item lands after every tombstone and format item in the gap
  and before the next live content item; the clock advances by exactly one and
  no format item is added; with two live same-key format items of different
  values in the gap (built by a delete concurrent with two formatters) the
  public insert stops inside the gap while YP7 passes both, and the inserted
  unit renders with the fold's formats; mid-item split, index 0, text end, and
  the out-of-range throw; concurrent gap-end inserts converge under three
  client-id assignments.
- Byte-equality differential (the YP4 method): the test materializes the pre-P7
  engine by copying `src/` into `node_modules/.cache/edytor-p7-baseline` with
  every `// YP7 begin … // YP7 end` hunk stripped (and asserts the copy has no
  `insertAtGapEnd`), then replays 40 seeded programs × 120 operations over every
  existing public write path — `insert` with and without formats, `delete`,
  `format`, inline `Node` and JSON inserts, `UndoManager` undo/redo, remote
  `applyUpdate` between two docs, gc on and off — on both engines, and
  requires identical `encodeStateAsUpdate` bytes for both docs and an
  identical `toDelta` after EVERY operation.
- The upstream suite (`pnpm test:crdt`, `vendor-tests/yjs`) passes unchanged.

Vendor delta: +27 xloc in `src/` (census `--vendor`), plus 9 declaration lines
in `dts/`.

### YP8 — prune the fork to the surface edytor runs on (the architecture-v2 pruning step; the fork is owned)

Reason: `crdt/engine.js` hands every `bind*` a 23-symbol engine
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
renderer-aware reads, `renderer-helpers.js`), so YP4, YP5 and YP7 are untouched.

Deleted files: `utils/Renderer.js` (and with it YP6), `utils/Snapshot.js`,
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
- `src/tests/crdt/yp8-surface.test.ts` pins `edytor/crdt`'s exports and
  proves closure: rolldown-bundling the engine object + the keep list keeps
  every top-level vendored declaration outside the allowlist above.
- `bench/lib/mk-baseline.sh` now materializes the PRISTINE upstream engine
  (`@y/y@14.0.0-rc.26`, installed as the `@y/protocols` peer, + YP1), and the
  baseline leg of `src/tests/crdt/hardening/search-marker-format.test.ts` (patched vs
  upstream, per-op `toDelta` + byte-identical `encodeStateAsUpdate`) and
  `bench/lib/interop.mjs` pass against it; the YP4/YP7 differentials
  (`search-marker-format`, `marker-seed`, `yp7-gap-end`) stay green.

Re-syncing with upstream: take the new upstream `src/`, apply YP1, re-apply
the YP4/YP5/YP7 hunks (diff this tree against the pinned upstream as in
"Diffing against upstream"), then run `pnpm exec vitest --config
./vitest.crdt.config.ts --run src/tests/crdt/yp8-surface.test.ts` — its
closure failure lists exactly the declarations to delete (update `KEPT` for
deliberate export changes), and regenerate `dts/`.
### YP9 — pending structs record every stacked dependency (`src/utils/encoding.js`)

Reason: `integrateStructs` walks a dependency stack; when the head waits for a
client that is already on the stack it records only the head's missing client
in the pending state vector (`missingSV`). The dependency of the struct at the
bottom of the stack is lost, so the later update that supplies it never
triggers `readUpdateV2`'s retry, and the document holds a pending update it
could integrate — forever, until some unrelated update from the recorded
client arrives. Reproduced on the unmodified `@y/y@14.0.0-rc.26` with four
updates (A1 ← B1 ← A3, A2 independent) delivered as A3, B1, A1, A2; found by
the architecture-v2 phase-2 fuzz (`src/tests/crdt/arch-v2/replica-fuzz.test.ts`, an
observer fed every update in reverse order stayed pending in 74/1,500 seeds).

Patch (all hunks marked `// YP9` or delimited by `// YP9 begin` / `// YP9 end`):
a `stackMissing` array parallel to `stack` records the client each stacked
struct waits for (pushed with the struct, popped with it); `addStackToRestSS`
first records every one of them in `missingSV` at the store's clock. Recording
more clients can only cause more retries, never a wrong integration.

Oracle: `src/tests/crdt/yp9-yp10-engine.test.ts` — the raw program in every
delivery order, the facade program the fuzz found in every order, and the
stripped tree (the YP9 hunks removed) stays pending on A3, B1, A1, A2.

### YP10 — the formatting cleanup after a remote change runs under an untracked origin (`src/utils/Transaction.js`) — REMOVED by YP19 (no cleanup)

Reason: `cleanupYTextAfterTransaction` deletes the format items a remote
change made redundant in a new transaction with the `null` origin — the
untyped-local origin every default `UndoManager` (and edytor's
`document.history`) tracks. Receiving a peer's delete over text this user had
formatted therefore pushed an invisible step onto this user's undo stack, and
the next undo reverted the cleanup instead of the user's last edit
(`docs/editor-delete-contract.md` `conc.undo.actor-local`,
`hist.capture-group`). Reproduced on the unmodified `@y/y@14.0.0-rc.26`.

Patch (hunks marked `// YP10` or delimited by `// YP10 begin` / `// YP10 end`):
the cleanup transaction's origin is a module-private
`Symbol('yjs.formatting-cleanup')`. It stays a local transaction whose update
providers broadcast like any local write (a replica's cleanup is
order-dependent, so peers must receive it to converge); no undo manager
tracks the symbol.

Oracle: `src/tests/crdt/yp9-yp10-engine.test.ts` — after a peer's replace,
partial delete or full delete over A's bold run, A's undo stack is unchanged,
one undo removes A's last edit, and the peers still converge; the stripped
tree (the YP10 hunks removed) puts the cleanup on the stack.

### YP11 — UndoManager `restoreFilter` and `onApply`: the document decides how deleted text comes back (`src/utils/UndoManager.js`, `src/index.js`) — the hooks REMOVED by YP18

Since YP18 the undo manager is edytor's own and calls these rules directly; the fork keeps only the `redoItem` export. The record below is the patch as it stood.

Reason: the engine's undo re-creates deleted content as COPIES and records no
writer for a delete. Two peers that delete the same character concurrently and
each undo therefore brought it back twice (`abbc`), and the first undo brought
it back although the other peer's delete still held it (arch-v2 contract
program `history.concurrent-double-delete`). Edytor fixes this with per-writer
text delete marks (`src/lib/crdt/text/deletes.ts`, execution ledger row
"Text double-delete undo"; since YP20 the engine's hold records, and that
module is gone); the engine needs two hooks for it, and nothing else
changes.

Patch (hunks marked `// YP11` or delimited by `// YP11 begin` / `// YP11 end`):

- `UndoManagerOptions.restoreFilter(item, stackItem) → boolean` (default
  always `true`): asked for every deleted item a popped stack item would
  re-create. A withheld item counts as a change, so the step is consumed
  instead of skipped for the next one (upstream skips a step that changes
  nothing).
- `UndoManagerOptions.onApply(transaction, stackItem)` (default no-op): called
  inside the undo/redo transaction once the stack item is applied; its writes
  are part of the same update and of the step the other stack captures.
- `index.js` exports `redoItem` (the document re-creates text through it, so
  a restoration places its copy exactly as the engine's own undo does).

The document also reads `iterateStructsByIdSet` and `getItemCleanStart`
(already exported) through the engine object. `src/utils/Transaction.js`: the
YP10 block moved above the cleanup's JSDoc so the declaration generator binds
`@param {Transaction}` again (no code change; `dts/` had been left stale).

Oracle: `src/tests/crdt/yp11-undo-hooks.test.ts` — the hook rows run on the
patched tree and on the tree with the YP11 hunks stripped (which ignores the
options: the rows discriminate); a differential replays 40 seeded programs ×
120 operations over the text write paths with undo/redo on both trees with no
options and requires byte-identical `encodeStateAsUpdate` for both peers and
an identical render after every operation. The YP4/YP7 differentials and the
upstream suite pass unchanged.

Vendor delta: +9 xloc in `src/` (census `--vendor`: 5,769 → 5,778).

### YP12 — UndoManager `withdraw`: the document keeps an item an undo would delete (`src/utils/UndoManager.js`) — REMOVED by YP18

Since YP18 the withdraw rule is a step of edytor's own undo manager. The record below is the patch as it stood.

Reason: the engine undoes an insert by deleting the inserted items, and a
deleted type deletes everything inside it. Undoing a block's creation
therefore deleted the block node with the text another writer had typed into
it, before or after the undo (arch-v2 contract `hist.undo.withdraw`,
2026-09-28: an undo removes only the undoer's own contributions). Edytor keeps
the node and writes a per-writer withdraw mark instead
(`src/lib/crdt/placement/model.ts` `withdrawOnUndo`); the document index shows
a withdrawn block while it holds another writer's content.

Patch (hunk delimited by `// YP12 begin` / `// YP12 end`, option lines marked
`// YP12`):

- `UndoManagerOptions.withdraw(item, stackItem, transaction) → boolean`
  (default never): asked for every item a popped stack item would delete,
  before `deleteFilter`. `true` keeps the item — the hook may write in its
  place, inside the transaction, and its writes are part of the step the
  other stack captures — and counts as a change, so a step whose only effect
  was kept is consumed instead of skipped for the next one (like YP11's
  withheld restore).

Oracle: `src/tests/crdt/yp12-undo-withdraw.test.ts` — the hook rows run on the
patched tree and on the tree with the YP12 hunk stripped (which ignores the
option); a differential replays 30 seeded programs × 100 map and nested-text
operations with undo/redo on both trees with no option and requires
byte-identical `encodeStateAsUpdate` for both peers after every operation.

Vendor delta: +6 xloc in `src/`.

### YP13 — paired marks: an end closes only its own start (`src/utils/marks.js`, `src/structs/Item.js`, `src/ynode.js`, `src/utils/transaction-helpers.js`, `src/utils/RangeCursor.js`, `src/utils/Doc.js`)

Reason: upstream formatting writes `{key: value}` where a range starts and
`{key: null}` (or the value it replaced) where it ends, so any end closes
whatever is open: two concurrent overlapping bolds lose bold where one's end
lands inside the other, and a concurrent insert beside a format item lands
before or after it by client id (CRDT study 2026-10, H5, Peritext §2). The
fork adds paired marks (Peritext / Loro anchor pairing), schema generation 5:

- `utils/marks.js` (new): a mark operation is a start `ContentFormat` keyed
  `\u0001` + mark, value `[v, lamport, client, clock, side]`, and an end keyed
  `\u0002` + mark, value `[client, clock, side]` naming its start. A
  position's value of a mark is the value of the open operation with the
  greatest `(lamport, client, clock)` (`MarkState`, immutable so marker
  snapshots can share it); `foldPaired` is the fold.
- `updateCurrentFormats` (both copies) folds paired items through
  `foldPaired`; `RangeCursor#_emitFormats` renders a `MarkState`'s winning
  value; `toDelta` skips paired items (edytor reads marks through
  `RangeCursor`); the formatting cleanups never delete a paired item.
- `Item#integrate`, case 1 of the conflict loop: `sortsBefore(o, this)` —
  items of one origin order left-side mark items, then content and plain
  formats, then right-side mark items, by client id within a class (plain
  items keep upstream's `o.id.client < this.id.client`).
- `Item#gc` keeps a paired mark item's content (its side orders concurrent
  inserts on every replica, collected or not).
- `ContentFormat#integrate` records a paired start's Lamport timestamp in
  `doc._markClock` (new `Doc` field); `YNode#mark(index, length, mark,
  value, startSide, endSide)` writes one operation at `_markClock + 1`;
  `YNode#insertInGap(index, content)` inserts with no format item. Every
  write in a gap takes the gap's last content item as origin and its next
  live content item as right origin, and integrates through the conflict
  loop, so a local write lands where a remote replica integrates it.

Plain formats (every upstream test) are untouched: the class of a plain
item is content's, so the comparator reduces to upstream's.

Oracle: `src/tests/crdt/arch-v2/paired-marks.test.ts` (the Peritext cases on
every swept client-id pair and delivery order; 7 of its 17 rows fail on
the tree without YP13), the upstream suite unchanged.

### YP14 — a value a concurrent write replaced keeps its subtree (`src/utils/transaction-helpers.js`, `src/structs/Item.js`, `src/utils/Doc.js`, `src/index.js`)

Reason: a map key written concurrently by two clients keeps the rightmost
value and deletes the others; deleting a node value deletes its whole
subtree. edytor's block registry is a map of nodes keyed by caller ids, so
two writers creating block `N` at once lost the losing node's text (CRDT
study 2026-10, H13, plan §2.1 "Identity"). The fork lets a document keep
such a node:

- `isKeptReplaced(item)` (new, `utils/transaction-helpers.js`, exported):
  a node value (`ContentType`, `parentSub !== null`) with a newer value to
  its right that was NOT written over it (the right one's origin is not
  this item), when the document asks (`doc.keepReplaced`, else the class
  default `Doc.keepReplaced`; both `null` upstream, so every upstream test
  runs upstream's semantics).
- `Item#delete`: such an item is marked deleted and enters the delete set
  as before, but its content's subtree is not deleted.
- `Item#integrate`: an item whose parent is such a node integrates live
  (upstream deletes an item under a deleted parent), so a write that
  reaches a replica after the race, or a reload that integrates the node
  before its children, keeps the subtree on every replica.
- `tryGcDeleteSet`: such an item is never collected.
- `Doc#keepReplaced` (instance, default `null`) and `static
  Doc.keepReplaced` (default `null`): edytor sets the instance field of each
  of its documents to its registry predicate before the document integrates
  anything (`keepingReplaced` in `crdt/incarnations.ts`: a facade's
  `create`, `createDoc`/`newDoc`, the scratch documents of admission, seeds,
  migration and prefetch); the static stays `null`, so another document of
  the engine keeps upstream's semantics.

A value written over a known one (a sequential overwrite) and a removed
key (`deleteAttr`) delete their subtree as before. `YNode#applyDelta`
still writes nothing to a deleted node, so the kept node's own attrs are
frozen; its children (a text, a list, a map) are ordinary live types.

Oracle: `src/tests/crdt/placement/same-id-concurrent.test.ts` (the losing text shows
on every replica and after a reload; two fuzzes), the upstream suite
unchanged.

### YP15 — no lib0 `logging` nor `environment` in the engine, no development freeze (`src/utils/UndoManager.js`, `src/ynode.js`, `src/utils/Transaction.js`, `src/structs/Item.js`)

Reason: the engine's three messages printed through `lib0/logging` and its
development check read `lib0/environment` (`getVariable('node_env')`),
which brought both modules (their colour, parameter and storage readers)
into every app that ships edytor, for three lines of output and one
boolean, and that boolean's freeze cannot hold edytor's values.

Patch (lines marked `// YP15`): the "Not same Y.Doc" and "Invalid access"
warnings are `console.warn`, the client-id change notice `console.log`
(unstyled). `ContentAny` no longer deep-freezes its values in development
mode (`isDevMode`, the `node_env` variable, and the `lib0/object` import
go): edytor stores `Uint8Array` records (text delete marks, restorations)
there, and `Object.freeze` refuses a typed array with elements, so a
development process (`NODE_ENV=development`) threw on the first text
delete.

Oracle: the upstream suite unchanged; `pnpm test:crdt` (with the freeze
on, every text delete in the unit lane throws `Cannot freeze array buffer
views with elements`).

### YP16 — no delta layer: the writes call the cursor helpers, the reads walk the items (`src/ynode.js`, `src/utils/*`, `src/index.js`)

Reason: every app shipped lib0's `delta` (28 KB minified) and `schema`
(5.4 KB, with `logging` → `dom`) because every engine write went through
`applyDelta(delta.create()…)`, and the `$type` schema tags were set at load.
Edytor never read a delta at run time (one migration read of `node.delta`,
now an item walk). The engine built alone went from 130.9 KB min / 39.2 KB
gzip to 77.2 / 23.6; an app bundle (`scripts/bundle-size.mjs`) from 749.7 to
695.9 KB min (minimal) and from 959.6 to 905.8 (every plugin). Vendored execution lines (`node scripts/xloc.mjs
src/lib/crdt/vendor --vendor`) 5,969 → 5,029, 29 → 27 files. Approved
removal of public raw-engine API (`edytor/crdt`), listed in the site's
migration page.

Patch (the new code is delimited by `// YP16 begin` / `// YP16 end` in
`ynode.js`):

- `YNode#insert`/`delete`/`format`/`setAttr`/`deleteAttr`/`clearAttrs` call
  the helpers `applyDelta` called (`insertContent`, `insertContentHelper`,
  `deleteText`, `ItemTextListPosition#formatText`, `nodeMapSet`,
  `nodeMapDelete`) with the op sequence the builder produced for them: a
  positioning retain (`cursorAt`, which carries YP4's marker seed and the
  plant after the retain), the op, the final plant; an empty insert, a
  `length <= 0` delete or format, and a format with no key are no-ops, as
  the empty deltas were; a deleted node takes no write. Formats are resolved
  the way the builder resolved them (an insert's `null`/`undefined` values
  dropped, `{}` → none; a format's `null` values kept as removals).
- A detached node keeps `_prelim = { runs, attrs }`: the content runs in the
  normal form the pre-integration delta had (adjacent runs of one kind and
  equal formats merged, deletes and formats applied to them) and the attrs in
  first-write order (`null` for a removal, the slot kept), replayed at
  `_integrate` with one cursor, then the attrs — the order `applyDelta`
  applied the composed delta in. A write past a detached node's content
  throws at the write (the composed delta threw when the node integrated).
- Reads: `toArray` (and `toJSON`, `toString`, `map`, `forEach`), `clone`
  and the equality trait read the content as runs (`readRuns`: live items,
  formats folded, a paired mark's winning value under its mark name), not
  through `toDelta`.
- Removed: `toDelta`, `toDeltaDeep`, `applyDelta`, the maintained `delta`
  cache (`_delta`, `clearCache`), `change`, `$delta`, `static from`, the
  `'delta'` event and its upkeep in `cleanupTransactions`, `YEvent#delta`/
  `deltaDeep`/`getDelta`, inserting a delta as content (`YNode.from` in
  `insertContentHelper`), the renderer (`useRenderer`, `_renderer`,
  `AbstractRenderer`, `$renderer`, `utils/renderer-helpers.js`, the renderer
  branches of the cursor, `deleteText`, `RangeCursor` and the relative
  positions — `liveLength` in `transaction-helpers.js` is the one length),
  `createAttributionFromAttributionItems`, the schemas (`$doc` → `isDoc`, a
  prototype tag; `$nodeAny`, `$idSet`, `$idMapAny`, `utils/meta.js` with
  `$contentIds`/`$contentMap` and the content-map codec), the IdMap family of
  `utils/ids.js` (`IdMap`, `AttrRange(s)`, `ContentAttribute`, the codec;
  `lib0/hash/rabin` goes with it), the `ContentMap` typedef,
  `iterateStructsByIdSetWithoutSplits`/`iterateStructsWithoutSplits`, and
  `lib0/logging` (`console.warn`). `RangeCursor` pieces keep their shape
  (`deleted: false`, `attrs: null`). `intersectSets` stays exported.
- `edytor/crdt` exports 89 → 66 names; the engine object loses
  `createIdMap`, `insertIntoIdMap`, `createContentMap`, `decodeContentMap`
  (their only caller, `attribution.legacy()`, is removed) and
  `mergeUpdatesV2` (no caller).

Test side: `src/tests/crdt/harness/delta.js` is the engine's `toDelta`,
`applyDelta`, `YEvent#getDelta`/`delta`/`deltaDeep` and `YNode.from` as they
stood before YP16, renderer-free, over the engine's internal helpers (it
dispatches to a baseline engine's own methods); the vendored upstream suite,
the YP4/YP5/YP7/YP11 differentials, `bench/lib/interop.mjs` and
`bench/lib/engine-micro.mjs` read and write deltas through it. Removed with
their subject: `IdMap.tests.js`, `schema.tests.js`, the RDT/cache tests of
`attribution.tests.js` (`bind`, the `'delta'` channel, the cache and its
fingerprint memos), the renderer rows of `range-cursor`,
`search-marker-anchors` and `stream-boundary-races`, and the `Node.delta`
pins of `runs/delta-contract`.

Oracle: `src/tests/crdt/yp16-writes.test.ts` — 40 seeded programs × 120
operations over every public write (text and array inserts with formats,
deletes, formats with `null`/`{}` updates, attrs, `clearAttrs`,
`push`/`unshift`, writes to detached nodes nested two deep, undo/redo,
writes to a deleted node), gc on and off, byte-identical
`encodeStateAsUpdate` and equal deep content after EVERY operation against
(1) the pristine upstream engine (local writes; the fork's search markers
off, see below) and (2) the fork as it stood before YP16 (`git archive`,
every operation, remote exchange included). Two pre-existing differences
from upstream, unchanged by YP16 and pinned by (2): remote integration, and
the YP4 seeded cursor, which in one seed (an array insert with formats at a
seeded position) places an item differently from upstream's walk (equal
content, different bytes).

### YP17 — one update encoding: upstream's v2, under the unsuffixed names (`src/utils/UpdateEncoder.js`, `src/utils/UpdateDecoder.js`, `src/utils/encoding.js`, `src/utils/updates.js`, `src/utils/Transaction.js`, `src/utils/ids.js`, `src/utils/Doc.js`, `src/index.js`, `global.d.ts`)

Reason: the fork carried two update encodings (v1 and the columnar v2) and
every producer and consumer chose one: the wire sent a SyncStep2 in v2 and
converted it to v1 on receipt, updates in v1, the room and the browser
store kept v1 update rows beside v2 snapshots, tagged by a storage format
in their generation record. The engine already kept its pending structs
and deletes in v2. One encoding is v2: smaller for any state (2,000
blocks: 720,855 → 544,410 bytes, gzip 150,174 → 75,475) and for structural
edits (an Enter 472 → 388), equal for a keystroke (133 / 134). Edytor's
schema generation 6 is the cutover; nothing converts the other encoding.

Patch:

- `UpdateEncoderV1`/`UpdateDecoderV1` and `IdSetEncoderV1`/`IdSetDecoderV1`
  are removed; the v2 classes are renamed `UpdateEncoder`, `UpdateDecoder`,
  `IdSetEncoder`, `IdSetDecoder` (the `…V1 | …V2` JSDoc unions with them).
- `applyUpdate`, `readUpdate`, `encodeStateAsUpdate`, `mergeUpdates`,
  `diffUpdate` and `decodeUpdate` are the v2 functions (`applyUpdateV2`,
  `readUpdateV2`, `encodeStateAsUpdateV2`, `mergeUpdatesV2`, `diffUpdateV2`,
  `decodeUpdateV2` renamed, their encoder/decoder parameters removed);
  `convertUpdateFormat`/`convertUpdateFormatV2ToV1` and the leftover
  obfuscator typedef are removed. `readUpdate` is not exported.
- `encodeStateVector`/`decodeStateVector` write and read the state vector
  with a plain lib0 encoder (byte-identical: a state vector only ever used
  the rest encoder); `readStateVector`, `writeStateVector`,
  `writeDocumentStateVector` and `encodeStateVectorV2` are folded into them.
- The `update` event carries the update in the one encoding; the `updateV2`
  event is removed.
- `edytor/crdt` exports `UpdateEncoder`, `UpdateDecoder` and `diffUpdate`
  in place of the V1/V2 pairs (see `src/tests/crdt/yp8-surface.test.ts`).

Interop: an upstream engine reads the fork's bytes with its `…V2`
functions (`bench/lib/interop.mjs`, the baseline legs of
`search-marker-format.test.ts` and `yp16-writes.test.ts` compare against
upstream's `encodeStateAsUpdateV2`). Vendored execution lines 5,123 →
4,872. Test side: `compatibility.tests.js` (v1 documents of Yjs 13) is
removed; the upstream suite's helpers run every program in the one
encoding (`testHelper.js`, `updates.tests.js`).

### YP18 — no undo manager: the history is edytor's (`src/utils/UndoManager.js` → `src/utils/redo.js`, `src/index.js`, `global.d.ts`)

Reason: two mechanisms layered one undo. The engine's `UndoManager` kept the
stacks, the capture window, the scope and tracked origins, and replayed a
step; edytor's history (`src/lib/crdt/doc/history.ts`) drove it through the
YP11/YP12 hooks and managed its stacks from outside (the step limit and the
release of what a dropped step kept, the purge horizon, the shared own-text
ids, the room's restore and validation histories). Now edytor's
`UndoManager` is the one owner: it captures and replays over the engine's
struct primitives, and the fork keeps only those.

Patch:

- `utils/UndoManager.js` is removed except `redoItem` and `keepItem`, now in
  `utils/redo.js`. `redoItem(transaction, item, redoitems, itemsToDelete,
  deletedByHistory?)` takes a predicate (whether a step of the history
  deletes an id) in place of `ignoreRemoteAttributeChanges` and the undo
  manager. Gone: `UndoManager`, `StackItem`, `popStackItem`, the stack
  events, `deleteFilter`, `captureTransaction` defaults, `addToScope`,
  `ignoreRemoteAttributeChanges`, the YP11/YP12 hooks.
- `index.js` exports `keepItem` and `followRedone` (edytor's history keeps
  deleted items and follows a local copy's chain) and uses `globalThis` for
  its duplicate-import guard (Baseline 2024).
- `global.d.ts` loses `UndoManager` and `StackItem`.

Vendored execution lines 4,872 → 4,630; an app bundle 546.4 → 545.0 KB min
(minimal), 745.4 → 744.0 (every plugin): edytor's manager is 4.3 KB where
the engine's (without `redoItem`) and the hooks' driver were 5.6.

Test side: `src/tests/crdt/harness/undo.js` is the engine's `UndoManager`
as it stood before YP18 (`undoManagerOf(Y)`, over the fork or a copy of its
tree), for the upstream suite, the replica harness's `raw` adapter, the
engine probes and the differentials. Removed with their subject:
`yp11-undo-hooks.test.ts`, `yp12-undo-withdraw.test.ts` (the hooks' rows;
the rules are the facade history's `hist.undo.*` rows) and the upstream row
on `ignoreRemoteAttributeChanges`.

### YP19 — the engine ships what edytor calls: no plain formats, no observers, no subdocuments, no relative-position objects (`src/ynode.js`, `src/structs/Item.js`, `src/utils/Doc.js`, `src/utils/Transaction.js`, `src/utils/transaction-helpers.js`, `src/utils/encoding.js`, `src/utils/ids.js`, `src/utils/StructStore.js`, `src/utils/positions.js` (new), `src/index.js`, `global.d.ts`)

Reason: YP8 pruned the declarations nothing reaches, but a class ships
every method, and the reachable functions still carried paths edytor never
takes. Two ways of doing one thing each: plain format items beside the
paired marks (YP13), type observers and deep events beside the document's
transaction events, `RelativePosition`/`AbsolutePosition` objects and their
JSON form beside edytor's anchors (an item id and a side), a subdocument
lifecycle and load/sync promises beside edytor's document readiness. The
fork keeps one of each. An app bundle: 488.1 → 471.8 KB min (minimal),
703.3 → 687.0 (every plugin); the engine's share 60.7 → 45.2 KB.

Patch:

- **Formats.** The only format items are paired marks (`mark`). Gone: the
  plain-format writes (`YNode#format`, `insert`'s format argument,
  `ItemTextListPosition#formatText`, `insertFormats`,
  `insertNegatedFormats`, `minimizeFormatChanges`, `updateMarkerFormats`,
  `insertContent`/`insertContentHelper`, `equalFormats`), the formatting
  cleanups (`cleanupYTextFormatting`, `cleanupYTextAfterTransaction`,
  `cleanupFormattingGap`, `cleanupContextlessFormattingGap`,
  `Doc#cleanupFormatting`, `Transaction#_needFormattingCleanup`,
  `YNode#_hasFormatting`) and with them YP10. A plain format item a peer
  writes integrates and is inert: no cursor folds it
  (`updateCurrentFormats` folds paired marks only), no read shows it.
- **One sequence write.** `YNode#insert(index, content)` places as
  `insertInGap` does (YP13); the positioning step of a delete is
  `ItemTextListPosition#advance` (walk `length` live units, past the deleted
  items around them). Without marks in the gap both place exactly where the
  old formatted walk did: the YP16 differential (local programs, search
  markers on and off) stays byte-identical to upstream and to the fork
  before YP16.
- **No observers.** `observe`/`observeDeep`/`unobserve*`, `YEvent`,
  `EventHandler.js`, `callTypeObservers`, `_callObserver`,
  `Transaction#changedParentTypes`, the `beforeObserverCalls` and
  `afterTransactionCleanup` events are gone. A commit emits `commit`
  (new), then `afterTransaction`, each listener run even if another throws;
  a remote transaction still clears the search markers of the types it
  changed. edytor's index folds on `commit` when the registry or a node under
  it changed (`changedUnder` in `crdt/structs.ts`, what the deep observer of
  the registry heard); the history captures a transaction by the same test
  over its scope.
- **No subdocuments, no load state.** `ContentDoc`, `createContentDocFromDoc`,
  `Doc#load`/`getSubdocs`/`getSubdocGuids`/`toJSON`, `guid`,
  `collectionid`, `meta`, `autoLoad`, `shouldLoad`, `isLoaded`,
  `isSynced`, `whenLoaded`, `whenSynced`, the `load`/`sync`/`subdocs`
  events, `Transaction#subdocs*`, `beforeState`/`afterState`, `meta`,
  `cleanUps`; `Doc` takes `{ gc, gcFilter }`.
- **Contents.** `ContentJSON`, `ContentEmbed` and `ContentDoc` are gone;
  their refs (2, 5, 9) are refused on decode like GC (0) and Skip (10), so an
  update holding one is malformed.
- **Positions.** `utils/RelativePosition.js` is replaced by
  `utils/positions.js`: `idAtIndex(node, index, assoc)` (the unit a position
  binds, `null` at an end) and `indexOfId(doc, id, assoc)` (`{ type, index }`
  or `null`), the marker-assisted walks unchanged, no redone-chain option.
- **Node.** `YNode` is no `ObservableV2` (nothing listened to a node's
  `destroy`); gone: `parent`, `clone`, `clearAttrs`, `hasAttr`, `getAttrs`,
  `push`, `unshift`, `get`, `slice`, `toArray`, `toJSON`, `toString`, `map`,
  `forEach`, `attrValues`, `attrEntries`, `attrSize`, the equality trait,
  `typeListGet`/`typeListSlice`, `nodeMapGet(All)`/`nodeMapHas`,
  `createMapIterator`, the premature-access warning. `attrKeys` is a
  generator. A detached node's pending content is plain runs (no formats).
- **Ids, store.** `IdSet#forEach`/`covers`/`coveredLength`/`slice`, the
  equality trait, `MaybeIdRange`, `equalIdSets`, `StructStore#get`/
  `getIndex`.
- `readUpdate` runs through `transact(doc, …, origin, false)` (a top-level
  apply is non-local from `beforeTransaction` on; a nested one is forced
  non-local, as before).

Test side: `src/tests/crdt/harness/node-reads.js` installs the renderings and
conveniences the tests read state through (`toJSON`, `toString`, `toArray`,
`get`, `slice`, `getAttrs`, `hasAttr`, the attr iterators, `map`,
`forEach`, `push`, `unshift`, `clone`, `clearAttrs`, `parent`) on the node's
prototype, from `src/tests/setup/engine-reads.ts` in every vitest lane (and
on a stripped copy's node where a differential loads one). The harness's
`applyDelta` writes a formatted op as paired mark operations (an insert takes
exactly its formats, a retain sets the keys it names); the raw adapter marks
with `mark`; the harness's pre-YP18 `UndoManager` derives
`changedParentTypes` from `changed`. Removed with their subject: the
upstream tests of observers and events, subdocuments, relative positions,
plain formatting and its cleanup (`y-text`, `y-map`, `y-array`, `doc`,
`delta`, `undo-redo`, `attribution`, `IdSet`, `y-xml`;
`relativePositions.tests.js` whole), `src/tests/crdt/runs/delta-contract.test.ts`
(the deep observer as the index's payload), the YP10 discriminating row, the
`yp16-writes` exchange runs (the removed cleanup split the items a remote
delete set reached) and the `seed-86` crash artifact (its crash site was the
cleanup's delete-set walk). Ported: `v14-smoke` (marks, the `commit` event,
`idAtIndex`/`indexOfId`), the YP7 rows (gaps built with marks), the marker
probes (planting through `findMarker`), `testStructReferences`,
`testKeyEncoding`. Upstream suite: 197 → 126 tests.

### YP20 — hold records: an attributed, reversible delete (`src/structs/Item.js`, `src/structs/AbstractStruct.js`, `src/ynode.js`, `src/utils/encoding.js`, `src/utils/ids.js`, `src/utils/StructStore.js`, `src/utils/Transaction.js`, `src/utils/transaction-helpers.js`, `src/utils/redo.js`)

Reason: the engine's delete is anonymous (a delete set names ids, not who
deleted them) and irreversible (a deleted item is deleted forever; an undo
re-creates COPIES). Edytor's product rules need a per-writer, reversible
text delete — a character two writers deleted shows again only once both
undid, an undo restores the same text in the same order, text another
author added is kept — so edytor carried a layer over the engine
(`crdt/text/deletes.ts`, `crdt/text/delete-index.ts`, 10.3 KB minified in
every app): per-writer delete marks, restoration records, copy lineage
(root, member, leaf), pending restorations, a hold rule for a peer's
concurrent restoration, a leftmost-wins dedup of concurrent copies, a
`gcFilter` keeping every deleted copy's content on every replica (the room
too), and follow-up transactions after remote changes. The fork now has the
delete, and the layer is gone. Design: `docs/archive/engine-delete/design.md`.
Edytor's schema generation 7 is the cutover (no conversion).

Patch (new code delimited by `// YP20 begin` / `// YP20 end`, edits marked `// YP20`):

- **`ContentHold`** (`Item.js`, content ref 11, `readContentHold` in
  `ynode.js`'s `contentRefs`): one unit per held id range
  (`client, clock, len`, written as a left id and a length); `copy`,
  `splice`, `mergeWith` (consecutive records of one writer merge, as a
  typed run does), `write`. Integrating it holds what it names; deleting it
  (an ordinary delete of the record item) releases. Records are immutable:
  the state that decides visibility is the items, the delete set, the
  records and the deleted records, so replicas converge in any order.
- **`Item`**: `holds` (local, never encoded: how many live records name
  the item), `removed` (bit 3, the delete set's fact; `AbstractStruct`
  answers `deleted` for a GC struct or a Skip), and `deleted` = `removed ||
  holds > 0`, so every reader of visibility (cursors, positions, the range
  cursor, lengths, edytor's index) sees a held item as deleted. The paths
  that mean the engine's delete read `removed`: `Item#delete`'s guard (a
  held item is removed too, and logs a give-back: the delete set counts it
  hidden again), `Item#gc`, `Item#split` (the right part copies `holds`),
  `Item#mergeWith` (equal `removed` and `holds`), `Item#integrate`'s
  deleted-parent rule (a held atom's attrs integrate), `ContentType#delete`
  (a held child goes with its node), `createDeleteSetFromStructStore`,
  `readAndApplyDeleteSet`, `tryGcDeleteSet`, `redoItem`'s parent rule.
- **Holding** (`holdRange`): the items present take the hold now, split at
  the range's edges; a range this replica lacks (past its clock, or a Skip)
  waits in `store.pendingHolds` (`client → [clock, len, delta, …]`), applied
  by `readUpdate` once an update of that client integrated
  (`applyPendingHolds`): a record never waits for its items, so a delete of
  text a room lost is stored and acknowledged at once. A GC struct takes
  nothing. An item that starts or stops being held (and is not removed)
  moves its parent's length, drops its search markers, joins
  `transaction.changed` and is logged in `transaction.holds`
  (`client, clock, ±len`, in order: the index's edits).
- **`YNode#delete(index, length, into, fresh)`**: with `into` (the records
  list) the live units are held by one record appended there instead of
  removed, except those `fresh` names (the open undo step's inserts:
  removed, so that step's undo changes nothing); the search markers move as
  for a delete. **`YNode#hold(ids)`**: append a record holding `ids`.

Plain deletes (every upstream test) are untouched: with no record, `holds`
is 0 everywhere and every changed path reduces to upstream's.

Edytor side: a text delete passes the records list (`crdt/text/model.ts`
`deleteRange`); the history's undo deletes the undoer's record, a redo
copies the record (never the text), an undo of typing holds the typed text,
a dropped step removes what this writer's records of it hold
(`hist.delete-marks.release`); the purge removes what a record older than
the horizon holds; the index folds `transaction.holds`. Removed:
`bindCrdt(Y).doc.keepCopies`, `PurgeReport.records`, the restoration
records root, the engine object's `ContentAny`.

Measured: vendored execution lines 3,392 → 3,548 (+156); edytor's
`text/deletes.ts` + `text/delete-index.ts` (699) removed. App bundle
(`scripts/bundle-size.mjs`): minimal 423.8 → 416.7 KB own (470.6 → 463.5
total), every plugin 653.2 → 646.2 (701.8 → 694.8), `edytor/export`
unchanged.

Oracle: `src/tests/crdt/yp20-holds.test.ts` (a hold and its release show the
same item; two writers in both orders; overlapping records; a peer's insert
inside a held run; a record whose items arrive later; merged, diffed and
reloaded updates; collection; `fresh`; three seeded differentials of held
deletes, releases and inserts with search markers on and off, byte-identical
after every step), the edytor rows `arch-v2/text-delete-marks.test.ts`,
`delete-records-fold.test.ts`, `history-limit.test.ts` and the native
contract programs (all 12 hold, `split.range-one-undo` included), the random
corpus (every adapter), the upstream suite unchanged (`encoding.tests.js`
pins ref 11).

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

Emit runs clean since YP8 (the upstream `TS2589` came from the deleted
`utils/delta-helpers.js`).

## Diffing against upstream

```sh
# fetch pristine source
curl -sL -o /tmp/yjs.tgz \
  https://github.com/yjs/yjs/archive/96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64.tar.gz
shasum -a 256 /tmp/yjs.tgz   # expect 4b5ad410…8d7b85
tar -xzf /tmp/yjs.tgz -C /tmp
UP=/tmp/yjs-96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64

# engine source: normalize YP1 away, then diff — prints exactly the YP4–YP16 hunks
# (the pinned tarball's src/ equals node_modules/@y/y@14.0.0-rc.26/src)
mkdir -p /tmp/yjs-normalized && cp -R src/lib/crdt/vendor/yjs/src /tmp/yjs-normalized/
find /tmp/yjs-normalized -name '*.js' -exec sed -i '' 's|lib0-v14|lib0|g' {} +
diff -r "$UP/src" /tmp/yjs-normalized/src
diff "$UP/global.d.ts" <(sed 's|lib0-v14|lib0|g' src/lib/crdt/vendor/yjs/global.d.ts)
diff "$UP/LICENSE" src/lib/crdt/vendor/yjs/LICENSE

# tests: reverse YP2 specifiers, then diff (prints the YP8 test pruning)
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

- `pnpm test:crdt` — **120 pass / 6 skipped / 0 failed** since YP19, unchanged by YP20 (196/6
  since YP16, 216/6 since YP8, 325/6
  before; upstream standard tier; the 6 skips are upstream's own
  `t.skip(!t.production)` extensive-tier gates: 3× y-array, 3× y-map random
  stress tests).
- `pnpm test:crdt:extensive` (`PRODUCTION=1`) — 331 pass before YP8 (~200 s;
  includes the 30 000-op randomized stress test); 222 tests since YP8, 202
  since YP16 (`IdMap.tests.js`, `schema.tests.js` and the RDT tests of
  `attribution.tests.js` went with their subject).
- Reproduce a seed: `YJS_TEST_SEED=<n> pnpm test:crdt`.
- Vitest runs each test once; upstream's `runTests` repeats `testRepeat*`
  cases for `--repetition-time` ms — that repetition loop is not replicated.
