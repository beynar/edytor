# CRDT v14 — measured performance & bundle report

Units: **U11 — measured specialization and bundle reduction** (plan §7/§8)
and **WU5 — corrected performance baseline** (follow-up prompt work unit 5).
Rule followed: measure first, optimize only what the measurements justify,
record before/after for every change, report unmet targets honestly.

> **Correction notice (2026-09-21, WU5).** The U11 sections below are kept
> verbatim as history, but several numbers were produced by instrumentation
> that conflated cost classes or measured a proxy instead of the real path.
> §9 lists exactly which U11 numbers are **revised** or **invalidated** and
> what replaced them. The durable artifact for all WU5 numbers is
> `bench/results/2026-09-21T00-10-26-013Z.json` (+ `browser-latest.json`),
> with git revision, dirty-tree sha256, seeds, sample counts and full
> distributions embedded.
>
> **Correction notice (2026-09-21, Unit 7 / review R7).** The §13 browser
> numbers are additionally **superseded**: the "keystroke 4.1 ms − facade→DOM
> 0.3 ms = 3.8 ms input pipeline" inference subtracted medians whose samples
> ended at different points (rAF callback vs MutationObserver), on a small
> pre-hardening fixture, with a filename-status source hash and an
> "unmodified engine" label that was already false (P1/P4 patches exist).
> §19 re-measures the repaired packed consumer with a same-keystroke staged
> timeline at 6/1k/5k blocks and records the corrected verdict.

## Environment & methodology

- Machine: Apple M4 Pro, darwin arm64 25.5.0
- Node `v24.21.0`, pnpm `10.32.1`
- Repo: `/Users/arnaud/code/edytor` @ the U11 working tree (uncommitted v14 work
  is the baseline — see `crdt-v14-execution-ledger.md`)
- Profiling: `src/tests/crdt/keystroke-cost-profile.test.ts` — 30 timed iterations per
  metric (10–15 for the heavier load paths), p50/p95/mean over wall-clock
  `performance.now()` inside one vitest process. Numbers are single-machine,
  ±20–40% run-to-run noise; p50 is the headline.
- Wire bytes: `pnpm bench:crdt` (`bench/run.js`) — byte length of emitted
  `update` payloads. The v13 comparison column is **not
  correctness-equivalent**: copy-based ops re-encode the payload and silently
  drop concurrent edits; it exists to quantify cost, not claim equivalence.
- Run-view numbers: `pnpm bench:runs` (maintained-view harness).
- Bundle numbers: `node bench/bundle.js` — rolldown (the bundler Vite 8 ships,
  resolved through vite's dep tree) over packed `dist/`. `.svelte` sources are
  compiled with `svelte/compiler` (client, `css: 'external'`) because dist ships
  them raw for the consumer's plugin; `.css` imports are stubbed (a consumer
  app handles CSS outside the JS graph). `svelte`, `esm-env`, `prismjs`,
  `@atlaskit/*` are external; `lib0-v14` is bundled (it is the engine's own
  pinned dependency line). This approximates a real Vite+Svelte consumer.

## 1 — Package filesystem size (`pnpm package`, 2026-09-20)

| subtree                                        |     bytes | share of dist |
| ---------------------------------------------- | --------: | ------------: |
| `dist/` total (281 files)                      | 1,741,816 |          100% |
| `dist/crdt/`                                   | 1,012,234 |         58.1% |
| `dist/crdt/vendor/` (engine)                   |   587,673 |         33.7% |
| &nbsp;&nbsp;`vendor/yjs/src/`                  |   428,205 |         24.6% |
| &nbsp;&nbsp;`vendor/yjs/dts/`                  |   141,929 |          8.1% |
| &nbsp;&nbsp;`vendor/` docs+license+meta        |   ~17,539 |          1.0% |
| `dist/crdt/` non-vendor (app CRDT layer)       |   424,561 |         24.4% |
| `dist/` non-crdt (editor, plugins, components) |   729,582 |         41.9% |

## 2 — Consumer bundle estimates (rolldown, packed dist)

| entry                                                |   min B |  gzip B | brotli B | modules | vendored modules |
| ---------------------------------------------------- | ------: | ------: | -------: | ------: | ---------------- |
| `edytor` (everything)                                | 429,906 | 123,185 |  105,595 |     162 | 31/31            |
| `edytor/crdt` (engine `import * as Y`)               | 146,714 |  43,841 |   38,854 |      68 | 31/31            |
| `edytor/crdt/edytor` (app layer, engine injected)    |  71,008 |  23,847 |   21,480 |      38 | 0                |
| `used-surface` (only engine symbols `src/lib` calls) | 123,096 |  36,805 |   32,665 |      67 | 30/31            |
| `combined` (`import * as Y` + `bindCrdt(Y)`)         | 274,110 |  81,597 |   71,766 |     150 | 31/31            |

Attribution inside the `edytor` entry: vendored engine ≈ 146.7 KB of 429.9 KB
min (~34%); the rest is app code + compiled Svelte + plugins.

### Dead-surface analysis — measured, deliberately not taken

- `edytor/crdt` intentionally re-exports the **whole** vendored engine
  (`index.js` `export *`), so all 31 source modules are reachable by design —
  renderers, v2 encoders, IdSet/IdMap, delta machinery included. That is the
  public engine surface consumers are promised.
- Even the narrowest realistic import surface (`used-surface`: `Doc`, `Node`,
  `UndoManager`, `transact`, update codecs, relative-position helpers) still
  pulls **30 of 31** vendored modules — the engine's internal graph is too
  coupled for module-granularity shaking. Only `utils/logging.js` drops.
- Maximum obtainable win at function granularity: **23,618 B min / ~7 KB gzip**
  — and only by narrowing the _public_ `edytor/crdt` export list (an API-surface
  decision) or by recorded vendor patches. Neither is justified under U11's
  "don't churn the vendor tree / don't cut public surface on internal-reference
  grounds alone" rule. **No vendor files were touched.**

## 3 — Wire bytes (acceptance table, re-verified)

| op                                |                                    v14 |                v13 copy-equivalent |
| --------------------------------- | -------------------------------------: | ---------------------------------: |
| move, 100k-char block             |                               **54 B** |                          100,127 B |
| split, 100k-char payload          |                              **346 B** |                           50,136 B |
| merge, 100k-char payload          |                               **35 B** |                          100,035 B |
| split scaling                     |      1k→334 B · 10k→341 B · 100k→346 B |             617 / 5,132 / 50,136 B |
| typing (single char)              | local p50 0.0198 ms · remote 0.0087 ms | local 0.0094 ms · remote 0.0071 ms |
| load 1,000 blocks                 |         v14 2.67 ms (188,867 B update) |            v13 2.01 ms (147,867 B) |
| delta, 128 runs                   |                      v14 p50 0.0499 ms |                  v13 p50 0.0089 ms |
| left-edge typing at a record seam | **69.7 B/char** (100 inserts, 6,973 B) |                  bound <200 B/char |

The `typing` row's ~2.1× local p50 delta is v14 engine bookkeeping on a raw
Node microbenchmark (`bench/results/latest.json` `workloads.typing` —
engine-level `textNode.insert(len,'x')` per transaction, 40 samples) — it
measures the op in isolation, not editor latency; both numbers sit far under
any interactive budget.

### Left-edge rewrite — investigated, inherent, not a bug

`insertIntoText` at the left edge of an item-anchored `SliceRecord`
(`src/lib/crdt/text/model.ts` ~L704) rewrites the record: delete + insert with
a new start anchor and `g = maxG+1`. Measured **69.7 B/char** for 100 separate
one-char transactions (gate1 growth test). Analysis:

- A record's `s` anchor is **right-associative** (`assoc = 0`, bound to the
  atom _at_ the range start). Atoms inserted at that index land strictly left
  of the anchor → **outside** the record's resolved range. Without the rewrite
  they are covered by _no_ record → unowned → invisible. The rewrite is
  coverage, not ceremony.
- The seam neighbour's `e` anchor (also right-assoc) _extends_ over the new
  atoms — so the atoms are contested, and the `g` bump is what makes the
  targeted block win deterministically. Without it the chars visibly land in
  the wrong block.
- A left-associative `s` cannot express "which side of the seam did the user
  type into" — it would route _all_ seam atoms (including the neighbour's
  right-edge typing) to one side. Insert intent is not encodable in anchors;
  the rewrite is how intent becomes a deterministic winner.
- Append-a-new-record instead of rewrite trades the ~20 B tombstone for
  O(chars) unbounded record-list growth — worse at every horizon.
- Skipping when "the record does not actually change" — it always actually
  changes (start anchor + generation both move).

**Verdict: inherent to the ownership model, O(1) per char, inside the <200 B
bound. Deliberate non-optimization.** A seam-aware coalescing scheme is an
ownership-model redesign, not a U11 patch.

## 4 — Run-view invalidation @ 1,000 blocks (`pnpm bench:runs`)

| metric                                  |                                                  value |
| --------------------------------------- | -----------------------------------------------------: |
| warm `runs()` read per block            |                                              0.0003 ms |
| full `computeAllRuns` baseline          |                                                5.60 ms |
| local 1-char insert — event handling    |                                              6.14 ms\* |
| local 1-char insert — lazy recompute    |                                      0.17 ms (1 block) |
| unrelated edit — snapshots reused       |                      999/1000, all-block read 0.211 ms |
| remote 1-char insert                    |                      apply 0.26 ms · recompute 0.09 ms |
| delta cache vs fresh `toDelta()` p50    |                                    0.0007 vs 0.0025 ms |
| cold read / reread-after-1-edit scaling | 100 blk: 0.94/0.09 ms · 1k: 6.41/0.22 · 4k: 33.54/0.41 |

\* measured **before** the takeSnap fix below — that 6.14 ms included the old
full-`project()` snapshot in the facade's `updateHandler`. The equivalent
end-to-end path now measures **3.73 ms p50** (next table).

## 5 — U11 profile + optimizations (before → after)

`src/tests/crdt/keystroke-cost-profile.test.ts`, 1,000 flat blocks, isolated run.

| metric                                 |   before |       after |                 Δ |
| -------------------------------------- | -------: | ----------: | ----------------: |
| `facade.insertText` + `onChange` p50   | 13.18 ms | **3.73 ms** |          **−72%** |
| `M.project(doc)` p50                   | 11.07 ms | **4.57 ms** |          **−59%** |
| `facade.project()` p50                 | 11.87 ms | **4.85 ms** |          **−59%** |
| first `project()` after 390 KB hydrate | 16.32 ms | **5.08 ms** |          **−69%** |
| bare `insertText` txn p50              |  1.67 ms |     1.93 ms | noise — unchanged |
| `insertText` call alone p50            |  1.52 ms |     1.59 ms |         unchanged |
| `collectBlocks`                        |  0.26 ms |     0.26 ms |                 — |
| `computeOwnership`                     |  0.91 ms |     0.76 ms |                 — |
| `applyUpdate` (390,489 B state)        | 10.70 ms |     9.26 ms |       engine-side |
| facade attach                          |  1.32 ms |     1.17 ms |                 — |
| `facade.toJSON()` p50                  |        — |     5.19 ms |                 — |

### What was changed and why

**O1 — `project()`: O(n²) → O(n).**
`src/lib/crdt/placement/model.ts`. The projector called `childrenOf()` per
block; each call scanned every placement — O(n²), ~10 ms of the ~11 ms
projection at 1k blocks. New `childrenIndex()` buckets all visible blocks by
display parent in ONE pass and sorts each bucket by the existing `(rank, id)`
comparator; `project()` emits from the index. `positionInView()` extracted so
`positionOf()` and whole-tree walks share one collected view.

**O2 — `takeSnap()`: skeleton snapshot + runs-identity content check.**
`src/lib/crdt/edytor-doc.ts`. `updateHandler` took a full `M.project()` per
committed transaction — every keystroke paid per-block `contentItemsOf` +
`cloneJson` only to JSON-compare them. The new snapshot walks `childrenIndex`
and stores per block: parent/index/type, the **live** `data` ref (compared via
`dataKeyOf`; cloned only if it reaches a `meta` DocChange payload), and the
block's **cached runs array reference** — the runs view returns the identical
frozen array while content is unchanged (structural sharing in `reconcile`),
so `o.contentRef !== n.contentRef` is an O(1) maybe-changed check, confirmed
by a lazily-computed JSON key before reporting (run `marks`/`data` compare by
reference, so a recomputed-but-equal array is possible). Full projected
subtrees are materialized lazily via `nodeFor` — only `added` roots need them.
Navigation helpers (`pathOf`, `ancestorsOf`, `next/previousInDocOrder`,
`islandOf`, `canAcceptMove`) thread ONE collected `view()` per call instead of
re-collecting per tree level.

Result composition after fix (~3.7 ms/keystroke @1k): `insertText` ~1.6 ms
(vendored engine internals) + skeleton snap ~1.3 ms (`view()` ~1.1 ms +
`childrenIndex` ~0.2 ms) + diff ~0.7 ms.

### Deliberate non-optimizations (measured, documented)

- **Left-edge record rewrite** — inherent; see §3.
- **Vendored dead surface** — max ~23.6 KB min/~7 KB gzip and only by cutting
  the public `edytor/crdt` surface or patching vendor; engine too coupled to
  shake (30/31 modules survive a minimal import). See §2.
- **Incremental `view()`/`project()` caching** — the residual ~1.1 ms/commit
  is `collectBlocks` + `computeOwnership` + `resolvePlacements`. Memoizing it
  across transactions needs an invalidation-tracked index; the plan forbids a
  second cache without clear ownership, and the runs view already owns facet
  invalidation. A facet-driven DocChange fast-path (skip the skeleton snap for
  content-only transactions) is a candidate U12+ item, not a blind guess.
- **`insertText` engine internals** (~1.6 ms @1k) — vendored item integration;
  not ours to patch.

## 6 — Verification after optimization

- `pnpm test:crdt` — **1233 pass / 7 skip** (42 files)
- `pnpm test` — **1219 pass / 1 skip / 11 todo** (55 files)
- `pnpm test:dom` — **142 pass** (3 files)
- `pnpm check` — 0 errors / 0 warnings
- `pnpm lint` — clean
- `pnpm package` + publint — clean ("All good!")
- `pnpm bench:crdt` — wire numbers above; no regression

## 7 — Vendor integrity

- No vendored file was added, edited, or deleted in U11.
- `UPSTREAM.md` pin re-verified this unit: tarball sha256
  `4b5ad4100dcbd211fa33b420c0a992564e84286b654259a67e64c05af08d7b85` matches;
  `src/`, `global.d.ts`, and `LICENSE` are byte-identical to upstream after
  reversing the recorded P1 (`lib0/`→`lib0-v14/`) rewrite. Only the recorded
  patch exists.

## 8 — Handoff notes for U12

- `bench/bundle.js` is the durable bundle measurement entry (writes
  `bench/results/bundle-*.json` + `bundle-latest.json`).
- `src/tests/crdt/keystroke-cost-profile.test.ts` is the durable per-keystroke/load
  profile (~3 s in the green lane).
- Candidate U12+ item if keystroke latency still matters: a facet-driven
  DocChange path (reuse the runs view's per-event invalidation set so
  content-only transactions skip the ~1.3 ms skeleton snap). Needs care:
  `takeSnap` must still keep `prev.nodes` fresh across skipped snapshots and
  non-content facets must fall back to the full diff.
- Package surface decision deferred: whether `edytor/crdt` should keep
  re-exporting the whole engine vs a curated subset (worth ≤ ~23.6 KB min).

---

## 9 — WU5 corrections to U11 measurements (2026-09-21)

`bench/lib/stats.js` `measure()` treated any **numeric** callback return as a
remote-side timing; `bench/lib/workloads.js` returned byte counts from some
callbacks, so byte totals were silently reported as milliseconds. `measure()`
now accepts explicit `{ remote: ms }` / `{ bytes: n }` objects (bare numbers
stay backward-compatible as remote ms) and emits a separate `bytes` stats
object with byte units. All byte-returning callers were converted.

| U11 number                                                      | status      | WU5 finding                                                                                                                                |
| --------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `typing … remote p50/p95` (any workload returning update bytes) | **invalid** | numeric byte returns were timed as ms. Re-measured under corrected `measure()`; see artifact `workloads.*`.                                |
| "staging ≈ 10–18 ms per inbound update" (manual scratch probe)  | **revised** | that was `new Y.Doc + applyUpdate(state) + applyUpdate(update)` by hand. Real `applyUpdateStaged` after the fast path: see §10.            |
| keystroke "facade.insertText + onChange p50 3.73 ms"            | **revised** | conflated write + commit + view-collect + callbacks. Separated lanes below; facade-only p50 ≈ 2.05 ms @1k, +2.6 ms with a live subscriber. |
| "70 B seam premium" (seam vs caret typing)                      | **revised** | corrected fixture measures seam 35 B vs caret 33 B/update — the premium is ~2 B, not 70 B. See §11.                                        |
| bundle sizes (§2)                                               | still valid | definition preserved; WU5 adds a **real** packed-consumer Vite build (§13), not a replacement.                                             |

The §3 left-edge rewrite analysis (69.7 B/char, inherent) stands — that was
measured by the gate1 growth test, not the flawed `measure()` path.

## 10 — `applyUpdateStaged` fast path (WU5 headline)

Every inbound provider update used to pay a full staged validation: build a
scratch doc, replay local state into it, apply the update, `checkSchema()`.
That was ~7–14 ms/update on a 1k-block doc while a keystroke update is ~35 B.

`src/lib/crdt/protocols/sync.ts` now scans the decoded update first
(`canApplyDirect`). It refuses the fast path — full scratch staging kept —
for: already-nonconforming live docs, `pendingStructs`/`pendingDs`, undecodable
payloads, direct `meta` writes, `blocks` writes on an unversioned doc, any
struct whose parent can't be resolved through its origin/right-origin chain
(parentless `setAttr` overwrites inherit parent from neighbours — the chain
is resolved through decoded structs then the live store), and delete sets
covering live `meta` items.

| path                                    | p50/update | note                                  |
| --------------------------------------- | ---------: | ------------------------------------- |
| `applyUpdateStaged` (fast path)         |   0.043 ms | 0/1500 content updates took scratch   |
| manual scratch merge (historical proxy) |    7.36 ms | what every update paid before         |
| remote burst, 50 keystrokes             |   0.011 ms | `applyMs` incl. scan, stagedTotal = 0 |
| reconnect diff (50 offline edits)       |   0.071 ms | one 130 B diff → fast path            |

Refusal semantics unchanged — `src/tests/crdt/text-model-probes/inbound-refusal.test.ts`
(9 tests) covers SyncStep2 full-state, `meta.v` overwrite, foreign
`meta.schema`, meta attr deletion, unversioned `blocks` writes, pending
causal deps and corrupt payloads; `schema-boundary.test.ts` (9 tests) still
green. No false `synced`, no persistence/rebroadcast of refused updates.

## 11 — WU5 corrected baseline matrix (facade lanes)

Artifact `baseline.*`, `lane()` = one encoded fixture snapshot → fresh doc
per sample via `applyUpdate` (independent, data-cold; 7.8 ms to restore 1k).
Per-stage split: `writeMs` in-transaction model+integrate, `commitMs`
encode+event dispatch, `collectMs`/`ownMs`/`placeMs` the three `ownView()`
stages, `runsMs` maintained-runs reconcile. Work counters per lane:
`updateEvents`, `ownershipPositions`, `claimsVisited`, `runsRecomputed`.

**Keystroke scaling (insert 1 char, flat docs)** — p50 ms:

| blocks | facade |  write | commit | collect |   own | place |  runs |   B |
| -----: | -----: | -----: | -----: | ------: | ----: | ----: | ----: | --: |
|    100 |  0.254 |  0.208 |  0.037 |   0.041 | 0.121 | 0.025 | 0.036 |  35 |
|  1,000 |  2.052 |  1.963 |  0.086 |   0.568 | 1.113 | 0.202 | 0.184 |  37 |
|  5,000 | 11.771 | 11.659 |  0.105 |   2.717 | 9.411 | 1.348 | 0.720 |  37 |

Cost scales with `ownershipPositions` (6.2k → 62.9k → 318.9k) — ownership
recompute is the dominant per-keystroke term at 5k, exactly where the U11
"deliberate non-optimization" note predicted.

**Text length (1 block, N units)** — facade p50: 1k→0.093 · 10k→0.187 ·
100k→1.262 ms (ownership positions = N; roughly linear).

**Ownership claims (10k units, K records)** — facade p50: 0→0.122 · 8→0.150 ·
32→0.180 · 128→0.321 ms. Linear in claims; `runsMs` is the fastest-growing
term (0.09 → 0.42).

**Dense marks / inlines** — 128 mark runs: facade 0.073 ms, 95 B/update.
250 inline blocks: 0.063 ms, 35 B.

**Seam vs caret** — seam insert at a record boundary: 35 B, facade 0.134 ms;
ordinary caret: 33 B, 0.168 ms. **The seam premium is ~2 B — the historical
"70 B premium" claim does not reproduce** under the corrected fixture
(revised finding; the §3 gate1 number of 69.7 B/char is a different,
per-100-transactions measurement that still stands).

**History** — fresh vs churned (seed 1234) 1k docs: facade 1.77 vs 1.92 ms —
fragmented history adds ~8%, not a cliff.

**Ops @1k** — facade p50: delete-char 1.83 · paste 500-char 1.74 (537 B) ·
paste-subtree 2.14 (2,026 B) · format 1.74 (78 B) · split 0.70 (352 B) ·
merge 0.63 (33 B) · same-parent move 0.43 (68 B) · group-5 move 0.50 (297 B)
· undo 0.04 + view 1.56 (13 B) · anchor create+resolve 1.72 (resolveAnchor
1.49 — anchor resolution is a full ownView at 1k, flagged for WU6+).

**Serialization @1k** — treeWalk 2.25 + contentJSON 3.51 + encode 2.46 ms,
330,736 B state update. `changeCallbacks` differential: keystroke facade
2.44 ms no-subscriber vs 5.05 ms with a live DocChange subscriber (+2.6 ms —
the skeleton-snap + diff cost, matching U11's post-fix composition).

**Retained memory** (post-`global.gc()`, 3 docs held): baseline heap
13.7 MB; +3.1 MB @100 blk; +29.8 MB @1k; +153.4 MB @5k — ~30 KB/block
retained. Undo lifecycle after 10 edits @1k: +120 MB (includes the held
snapshot docs; flagged as the lane to re-run under WU6 memory work).

## 12 — Budgets (WU5 acceptance lines)

These are the numbers future WU6–9 optimizations are judged against; treat
as regression budgets at ±40% on this machine, not hardware-independent
guarantees:

| budget                                | line                        |
| ------------------------------------- | --------------------------- |
| keystroke facade @1k                  | p50 ≤ 3 ms                  |
| keystroke facade @5k                  | p50 ≤ 15 ms                 |
| `applyUpdateStaged` content fast path | p50 ≤ 0.1 ms, staged = 0    |
| staged schema-check fallback          | unchanged semantics, any ms |
| seam vs caret wire premium            | ≤ 5 B/update                |
| retained heap @1k, 3 docs             | ≤ 40 MB                     |
| packed consumer `index-*.js` brotli   | ≤ 125 KB                    |

## 13 — Packed consumer & browser lane (real, not estimated) — SUPERSEDED by §19

`bench/browser.js` runs the actual packed consumer
(`tests/packed-consumer/svelte-app`): real `vite build`, then chromium +
Playwright when available. Result → `bench/results/browser-latest.json`:

- emitted client bundle: `index-*.js` **464,259 B min / 138,457 B gzip /
  119,518 B brotli** — the real consumer bundle (Svelte app + full editor +
  plugins), complementing the §2 rolldown estimates.
- mount: **71 ms**; `edytor.value` export 0.1 ms (small fixture).
- ~~complete keystroke p50 4.1 ms / p95 9.1 ms~~ — **INVALID (R7)**: the
  keystroke median ended at a rAF callback while the facade→DOM median ended
  at a MutationObserver over different samples; the "3.8 ms input pipeline"
  gap was the difference of two incompatible endpoints, not a measured stage.
  The fixture was also a stale pre-WU6–WU9 build at a single small scale.
  Corrected instrumentation and numbers: **§19**.
- ~~facade→DOM segment p50 0.3 ms~~ — same invalid basis. `facadeToDom`
  remains a real lane in §19 but is **never subtracted** from keystroke
  medians.
- If Playwright/chromium is absent the lane records an explicit skip; no
  browser numbers are claimed for skipped runs.

## 14 — WU5 verification

- `pnpm bench:crdt` — full matrix → `bench/results/2026-09-21T00-10-26-013Z.json` (~106 s)
- `pnpm test:crdt` — **1289 pass / 7 skip** (47 files, incl. 9 staging tests)
- `pnpm test` — **1278 pass / 1 skip / 11 todo** (60 files)
- `pnpm check` — 0 errors / 0 warnings
- `pnpm lint` — clean
- `tests/packed-consumer/run.sh` — **ALL PACKED-CONSUMER CHECKS PASSED**
  (tarball install, runtime smoke, vite build, SSR, chromium
  mount/edit/readonly/teardown, tsc nodenext + bundler)

### Suspicious / unresolved findings carried forward

1. `moves.reparent` recorded `updateBytes 0 / writeMs 0` — the lane's
   pre-state may already satisfy the reparent (move resolved as a no-op).
   Needs fixture inspection before trusting the 0.18 ms facade number.
2. `undo` write/commit lanes are 0 — the undo op is timed but its own
   transaction attribution needs the same hook treatment as other ops.
3. `post-edit-undo-lifecycle` retained +120 MB @1k is dominated by held
   fixture snapshots; a leak-vs-snapshot split is unresolved.
4. `keystroke` p95/p50 spread is wide at 5k (23.5 vs 11.8 ms) — GC pressure
   on 319k ownership positions; distributions are in the artifact.

## 15 — WU6 interval ownership (2026-09-21)

Artifact `bench/results/2026-09-21T00-32-18-276Z.json` vs the WU5 baseline
`2026-09-21T00-10-26-013Z.json` — same fixtures, same machine.

**Representation.** `atomOwner`/`atomClaim` dense per-position arrays (and
the identical `AtomRow` in `runs.ts`) are replaced by ordered disjoint
`OwnInterval {i0,i1,owner,claim}` lists per backing text, built by
`sweepOwnership` — a claim-endpoint sweep with a lazy-expiry max-heap over
the unchanged `(g, s0, stamp)` contest key. Adjacent elementary spans won
by the same record coalesce; a gap breaks coalescing so identical-record
coverage on both sides of a gap stays two intervals — preserving the
per-record emission contract. Interval count per text ≤ 2·claims − 1;
cost O(c log c) per text, independent of text length. No tree index — the
flat array + binary search measured sufficient.

**Counter redefinition** (`bench/lib/baseline.js`): `ownershipPositions`
now counts emitted INTERVALS (was: dense row length); `claimsVisited`
counts slice RECORDS swept (was: covered positions). Both now measure the
work that actually scales — the WU5 goalposts, not a number inflated by
text length.

**Keystroke scaling** — p50 (before → after):

| blocks |        facade |         write |     collect |         own |       place |        runs |     intervals |        claims |
| -----: | ------------: | ------------: | ----------: | ----------: | ----------: | ----------: | ------------: | ------------: |
|    100 |   0.254→0.215 |   0.208→0.165 | 0.041→0.037 | 0.121→0.076 | 0.025→0.021 | 0.036→0.043 |     6,191→100 |     6,191→100 |
|  1,000 |   2.052→1.496 |   1.963→1.419 | 0.568→0.491 | 1.113→0.684 | 0.202→0.168 | 0.184→0.165 |  62,891→1,000 |  62,891→1,000 |
|  5,000 | 11.771→11.302 | 11.659→11.196 | 2.717→2.624 | 9.411→6.151 | 1.348→1.692 | 0.720→0.765 | 318,891→5,000 | 318,891→5,000 |

Intervals now equal the claim count (1 self-slice per block). The remaining
`ownMs` is per-CLAIM work — two `resolveAnchor` calls + `computeOwners` +
sweep bookkeeping per record (~0.7 µs/claim @1k) — not traversal; dense
per-position allocation and scanning are gone. Keystroke p95 @5k
23.5→19.2 ms; budgets hold (facade @1k ≤3 ✓ 1.50, @5k ≤15 ✓ 11.30).

**Text length (1 block, N units)** — ownMs 1k/10k/100k: 0.051/0.110/0.784 →
**0.012/0.008/0.007** — flat; the 100k case improved ~109×. Intervals: 9 at
every size (the text's 9 anchored records regardless of its length).

**Ownership claims (10k units, K records)** — ownMs 0/8/32/128 claims:
0.068/0.082/0.088/0.172 → 0.001/0.008/0.028/0.102 — now scaling with
claims, as designed (intervals 1→9→33→129).

**History** — fresh vs fragmented 1k: own 0.994/0.976 → 0.745/0.822;
fragmented sweeps 1,050 records (50 extra split-history claims) vs 1,000 —
the flagged fragmented-history regression does not materialize: +10% own
over fresh, no cliff.

**Seam/caret (10k text)** — ownMs 0.081/0.108 → 0.007/0.007 (≈15×).
Wire bytes: 35/35 this run vs 35/33 before — ±2 B of per-doc
random-clientID varint noise in the update encoding (verified 34–35 B
across repeated runs of identical code); the corrected §11 finding
(premium ≈ 0–2 B, not 70 B) stands.

**Ops @1k** — own p50: delete 1.01→0.79 · paste-text 1.03→0.80 ·
paste-subtree 1.04→0.79 · format 0.98→0.71. **Anchors** — resolveAnchor
1.49→1.14 (outward scan is now interval-boundary hops; the call still pays
one fresh `ownView`). **Undo view** — own 0.93→0.66.

**Retained memory** — unchanged: +3.0/+29.7/+153.5 MB @100/1k/5k, lifecycle
+120.5 MB — expected: the dense arrays were transient per-view garbage, so
the win is CPU/GC pressure (p95), not retained heap.

**Verification** — `test:crdt` 1304p/7s · `test:crdt:extensive` 1310p/1s ·
`test` 1293p/1s/11t · `test:dom` 142p · `check`/`test:typecheck`/
`test:dom:typecheck` 0e/0w · `lint` clean · packed-consumer ALL PASS ·
chromium lane 372p/1s. New: `ownership-intervals.test.ts` (15 tests)
differentials interval vs dense-oracle per position/record/`maxG`/
flatten/`nearestOwned`/`resolveAnchor` across WU1 fixtures, merges,
cycles, dead holders, equal endpoints, Unicode, inline atoms, delivery
orders, duplication, reload, undo.

## 16 — WU7 shared incremental model state (2026-09-21)

Artifact `bench/results/2026-09-21T01-50-52-327Z.json` vs the WU6 artifact
`2026-09-21T00-32-18-276Z.json` — same fixtures, same machine.

**Problem.** Every command preamble, anchor resolution, projection, and
`DocChange` commit paid a fresh `collectBlocks` + `computeOwnership` +
`resolvePlacements` + `childrenIndex` over the whole registry. At 5k
blocks that was ~9.8 ms of view re-collection per keystroke — 87% of the
11.3 ms facade p50 — while the runs view already maintained exactly the
invalidation bookkeeping needed to avoid it (the §5 "deliberate
non-optimization" deferred this until the runs view owned facet
invalidation; WU7 is that item).

**Architecture.** `bindRuns(...).attach(doc)` state is now the single
per-document model-state owner (`WeakMap<EngineDoc, ViewRecord>`,
lease/refcounted — multiple `EdytorDoc` facades over one doc share it;
last dispose / doc destroy tears it down). It maintains:

- `blocks`: the full `BlockRec` map, patched in place per event;
- `own`: lazily maintained ownership (interval rows per text);
- `placements` / `kids` (`childrenIndex`): lazy facets rebuilt only when
  the structure/placement versions bump — **content-only commits preserve
  their map identity**;
- `modelCtx`: the `ModelView` every consumer shares. `bindModel` takes a
  `view()` provider — `bindEdytorDoc` injects
  `(doc) => R.modelState(doc)` — so command preambles, anchors,
  `takeSnap`, `childrenIdsIn`, projection, and `DocChange` all read the
  same indexes. Bare `bindModel` (no provider) keeps the fresh-collect
  fallback;
- transaction-local sync: mid-transaction reads walk
  `doc._transaction.changed` so command sequences keep read-your-writes
  without waiting for the update event;
- `commitInfo()`: per-commit `{seq, fast, content, meta}` — `fast` is
  true only when no structural/placement invalidation occurred.

`DocChange` uses it: `updateHandler` skips no-op events by sequence
(`lastSeenSeq`), and on `fast` commits runs a two-pass `diffFast` —
validate all touched ids against the previous skeleton **without
mutating it**, escalate to the full diff if a touched id is visible but
untracked, then patch only touched content/meta. `fast` = false (moves,
splits, merges, block delete, paste-subtree, `slices`/`del`/`at` writes,
unknown attrs) takes the existing full-snapshot path — correctness over
fast-path eligibility.

**New counters** (`bench/lib/baseline.js`): `viewMs` — the shared
`view()` read the next consumer pays (vs the retained
`collectMs`/`ownMs`/`placeMs` columns, still measured as the fresh
from-scratch equivalent for reference); `commitFast` — 1 iff the commit
took the `DocChange` fast path; `runsRecomputed` — blocks whose runs
were actually recomputed (unchanged semantics).

**Keystroke scaling** — p50 (WU6 → WU7):

| blocks |           facade |        write |      commit | shared view | fresh collect+own+place |        runs | recomputed | fast |
| -----: | ---------------: | -----------: | ----------: | ----------: | ----------------------: | ----------: | ---------: | ---: |
|    100 |  0.215→**0.047** |  0.165→0.022 | 0.043→0.022 |      0.0004 |       0.041+0.078+0.020 | 0.043→0.012 |          1 |    1 |
|  1,000 |  1.496→**0.230** |  1.419→0.149 | 0.086→0.072 |      0.0014 |       0.530+0.724+0.192 | 0.165→0.035 |          1 |    1 |
|  5,000 | 11.302→**0.839** | 11.196→0.730 | 0.099→0.100 |      0.0035 |       3.025+5.340+1.409 | 0.765→0.081 |          1 |    1 |

The whole-document view re-collection is gone from the keystroke path:
the shared `view()` read is ~1–3 µs at every size; `write` now pays only
the in-transaction model work + `tr.changed` sync; `commit` pays the
encode + `diffFast` over one touched block. Facade p50 improved ~4.6× /
~6.5× / ~13.5× at 100/1k/5k. Budgets hold with headroom (facade @1k ≤3 ms
→ 0.23, @5k ≤15 ms → 0.84). Exactly one block's runs recompute per
keystroke at every size.

**DocChange callback cost** (`changeCallbacks` lane @1k, one keystroke):
with-subscriber 4.226→**0.122 ms** (~35× — the skeleton snapshot + full
diff is replaced by the two-pass touched-id patch); no-subscriber
1.496→**0.234 ms** (commit bookkeeping only — `commitInfo` + seq check).
`firedPerOp` still exactly 1.

**Structural ops still take the full path — and are faster anyway** (@1k,
facade p50): `moves/same-parent` 0.331→0.080, `moves/group-5`
0.398→0.150, `splitMerge/split` 0.659→0.217, `splitMerge/merge`
0.541→0.162, `ops/paste-subtree` 2.023→0.768 — `commitFast=0` on all of
them as designed, but the write side no longer re-collects the view and
the full `takeSnap` reuses maintained `kids`. Content-only ops all
`commitFast=1`: `ops/delete` 1.778→0.248, `ops/format` 1.633→0.269,
`ops/paste-text` →0.260, `history/fresh` 1.831→0.256, `fragmented`
1.809→0.267, `undo` 0.042→0.029, `anchors/anchor-cycle` 1.562→0.101 with
`resolveAnchorMs` 1.137→**0.009** (anchor resolution now reads the
shared context instead of paying a fresh `ownView` per call).

**Roughly flat lanes** (already cheap, no re-collection dominated):
`textLength` 100k 0.030→0.027, `denseMarks` 0.064→0.070 (within noise),
`claims-128` 0.226→0.207, `depth-100` 0.139→0.044, `inline-250`
0.056→0.056. `serialization` treeWalk 1.708→0.515 (walks maintained
`kids`).

**Memory** — retained deltas vs process baseline: +23.2 MB @1k and
+151.7 MB @5k (WU6: +29.7 / +153.5) — the maintained placements/kids
maps are new O(blocks) per-doc state, but within run-to-run heap noise;
no material regression observed. `post-edit-undo-lifecycle` 120.5→117.4
MB (same held-snapshot caveat as §14).

**Tradeoffs / carried.**

1. The maintained `blocks`/`placements`/`kids` maps persist per
   document — an intentional memory-for-CPU trade (bounded by visible
   block count; torn down on last-lease dispose or doc destroy).
2. `diffFast` escalates to the full diff whenever a touched id is
   unexpectedly visible-but-untracked — correct, and rare by
   construction (registry inserts are structural).
3. `changeCallbacks/no-subscriber` (0.234 ms) now exceeds
   `with-subscriber` (0.122 ms): with no subscriber the handler keeps
   `prevSkeleton` current via the fast diff, but pays `commitInfo` +
   seq bookkeeping plus the same per-event facet sync; with a
   subscriber the emit is the only extra work and the diff itself is
   cheaper than before. Both are ~35×/~6× better than WU6.
4. Fresh `collectMs`/`ownMs`/`placeMs` columns are retained as the
   from-scratch reference — they are what a bare `bindModel` (no runs
   attach) still pays per `view()` call.

**Verification** — `test:crdt` **1319p/7s** (49 files) ·
`test:crdt:extensive` 1325p/1s · `check`/`test:typecheck`/
`test:dom:typecheck` 0e/0w · `lint` clean. New:
`src/tests/crdt/runs/shared-state.test.ts` (15 tests) — shared-state
identity across consumers, facet invalidation (content vs `at` vs
`slices`/`del` vs `meta` vs unknown attrs), placements/kids identity
preservation on content-only commits, `commitInfo`/`commitFast`
classification, transaction `changed` read-your-writes, `DocChange`
fast-path payloads, two-facade lease sharing, dispose/destroy teardown.
A `diffFast` mutation-ordering defect (early escalation after partial
`prev` mutation) was caught by the mirror differential and fixed by the
two-pass validate-then-patch design.

## 17 — WU8 direct formatted range reads (2026-09-21)

Artifact `bench/results/2026-09-21T02-29-48-807Z.json`.

**Problem.** `itemsOfRange()` rendered the WHOLE backing text through
`text.toDelta().toJSON()` and then clipped to `[i0, i1)`. A block whose
visible slice is ~2k atoms of a shared 100k-unit backing text still paid
a full 100k-item render + JSON conversion per read — and several
sibling slices of one text each re-rendered the same sequence. A
commit-time cache could not simply be swapped in: fresh reads must keep
read-your-writes inside an open transaction, so the read path has to
walk live state.

**Architecture** (`src/lib/crdt/text/model.ts`, outside the vendored
engine — no patch needed): a forward-only `RangeCursor` walks the live
item list (`_start`/`right`) exactly like `YNode.toDelta()` does —
deleted items skipped, `ContentFormat` markers (non-countable) fold
into mark state, `ContentString` slices `str` directly, `ContentType`
inline children emit one `getAttr`-live `{id, type, data}` item.
Adjacent text pieces under canonically-equal marks (`canonKey`)
merge — identical shapes to the old delta-JSON reader either way.
Because the walk reads the same live links `toDelta()` reads, items
integrated earlier in the SAME transaction are visible — RYW preserved
with no staleness window. Emitted `marks` alias cursor/checkpoint
format state under a copy-on-write `shared` flag (mirrors the delta
builder's `useFormats`); the run layer interns them before publishing,
and detached nodes (`doc === null`) still read as empty without
touching `.delta`.

A sparse per-text checkpoint index (`readCheckpoints` — `{pos, it,
formats}` seeds at most `READ_CP_ITEMS = 64` walked items apart) turns
the one remaining O(items) prefix scan into a one-time cost: the
maintained view (`runs.ts`) keeps `readIndexes` per text, drops a
text's index on any `content`-facet event (local edit, remote update,
undo/redo, format or inline write — all surface as `content`), and
rebuilds lazily on the next read. Reads seed at the latest checkpoint
≤ `i0` and walk only the intra-gap remainder plus the range itself.

`computeFresh` shares one cursor per backing text across a block's
owned segs; `contentItemsOf` (both the text model's and the placement
model's whole-text conversion) now routes through the same walk —
zero production `toDelta().toJSON()` calls remain in the content-read
path.

**New counters** (`RunView.debug`): `itemsWalked` / `markersWalked` —
sequence items stepped over and format markers applied inside
maintained range reads (the metric that must scale with the range, not
the text); `readIndexBuilds` — checkpoint-index rebuilds since attach;
`reset()` zeroes all four counters.

**Range-read lane** — `rangeReads` workload: 50 sibling blocks each
owning a ~2k slice of ONE shared 100k-unit formatted text; 10 doc
builds × 49 warm reads each (the first read per doc pays the index
build):

| metric                                     |                         value |
| ------------------------------------------ | ----------------------------: |
| warm read p50 / p95                        |        **0.0102 / 0.0126 ms** |
| warm read mean                             |                     0.0105 ms |
| pre-WU8 `toDelta().toJSON()` reference p50 |        0.3995 ms (every read) |
| first read incl. index build p50           |       0.452 ms (once per doc) |
| items walked per warm read p50             | 61 (vs ~100k rendered before) |
| markers walked per warm read p50           |                            40 |
| readIndexBuilds                            |       10 (one per sample doc) |

Warm reads are ~**39× faster at p50** (0.0102 vs 0.3995 ms) and the
walked-item count — ~61 items vs a full 100k-item render — shows the
cost now tracks the range plus a bounded checkpoint gap, exactly the
intended scaling. Amortized over the 50 sibling reads of one doc the
one-time index build (~0.45 ms) is ~0.009 ms/read — total per-read
cost ~0.019 ms, still ~21× under the old path even if the index were
rebuilt once per doc.

**Tradeoffs / carried.**

1. Checkpoint indexes are O(items/64) retained state per text that has
   been range-read — deliberately dropped on `content` events rather
   than incrementally patched (a rebuild is one linear pass; patch
   logic would re-derive anchor math for marginal gain).
2. Reads with `i0` behind the cursor rewind to `_start` — the
   maintained view reads forward by construction (segs arrive in
   order), so this is a cold-miss path, not the common case.
3. `RangeItem` marks alias cursor state until interned — safe because
   every producer either stays inside the reader or passes through
   `intern()` before publishing; the contract is documented at the
   types (`RangeSeed.formats` "shared, never mutated in place").
4. The test-harness `contentTail` (`raw-node-ops.ts`) keeps its own
   `content.delta` walk on purpose — adapter diversity is the point of
   the raw ops variant.

**Verification** — `test:crdt` **1337p/7s** (50 files) ·
`test:crdt:extensive` 1343p/1s · `check`/`test:typecheck`/
`test:dom:typecheck` 0e/0w · `lint` clean. New:
`src/tests/crdt/runs/range-reads.test.ts` (18 tests) — oracle parity
of EVERY range of a richly formatted text against the retained
delta-JSON reader, mark set/clear boundaries incl. null clears,
surrogate-pair slicing, live inline `data`/`type` reads, detached
guard, shared-cursor forward/backward/repeated reads, checkpoint
identical-reads + bounded intra-gap walks, mid-transaction RYW
(stateless reader AND maintained view + index per step), index
staleness on insert-before-checkpoint, range-sized reads on one long
text, disjoint-seg cursor sharing, remote format update parity, undo
index rebuilds, cross-block mark interning, frozen snapshots,
decorations overlay, multi-backing merged-block reads.

## 18 — WU9 engine checkpoint patch + honest-memory verdict (2026-09-21)

Artifacts `bench/results/2026-09-21T05-19-37-243Z.json` (full lane) +
`bench/lib/engine-micro.mjs` before/after runs (`ENGINE_DIR=../vendor-
baseline/yjs` = materialized git-HEAD engine — the true before).

### The patch (vendored-engine P4 — `UPSTREAM.md` has the full manifest)

Re-profiling the corrected WU8 baseline showed two remaining engine-internal
linear walks: `YNode#applyDelta` always starts its cursor at `_start`
(every delta pays O(items-to-target)) and both relative-position helpers
walk the list linearly to sum visible length. Upstream's `ArraySearchMarker`
pool already accelerates index lookups but could not seed `applyDelta`:
the cursor also needs `currentFormats`, which upstream kept disabled
entirely (`ContentFormat.integrate` set `p._searchMarker = null`).

The patch attaches a **format snapshot** to each marker — `currentFormats`
at the marker's left edge, written only at quiescent points (end of
`applyDelta`, post-retain boundaries, `findMarker` read walks) — never
mid-mutation, where in-flight format state is transient (an earlier
variant captured it inside `forward()`; the differential harness caught a
stale `{hl,b}` vs true `{hl}` producing byte-divergent stores, which is
why writes are quiescent-only by construction). `applyDelta` seeds the
cursor from the best eligible marker only when the leading op is a pure
positioning retain (`format`/`attribution` unset — formatted retains apply
state across their whole range, so their prefix must still be walked),
`renderer === null`, the marker's anchor is still linked, and the anchor
is the first item at its index (upstream's walk stops on the first item —
format/deleted items sharing an index make "same index" ≠ "same list
position"). `plantMarker` plants checkpoints at quiescent points, reusing
same-index records; at the tail it anchors on the last countable item
(sequential appends otherwise never produce a seedable marker).
Snapshots are folded forward on format inserts, invalidated on
re-anchor/merge/`ContentFormat` deletion, wholesale-cleared on remote
integration and undo/redo exactly like the marker pool itself. Disabled
(`_searchMarker = null`) makes every added path inert = upstream behavior.

### Measured (engine-micro, `quick`: 20 000-char fragmented text = 60k items)

| lane                                       | before (HEAD) | after (P4) |
| ------------------------------------------ | ------------- | ---------- |
| applyDelta retain(18000)+insert (distant)  | 1.79 ms       | 0.91 ms    |
| applyDelta retain(10000)+insert (mid)      | 0.99 ms       | 0.51 ms    |
| applyDelta sequential append               | 0.98 ms       | 1.00 ms    |
| applyDelta scattered distant insert+delete | 1.01 ms       | 0.82 ms    |
| applyDelta retain(10)+insert (near)        | 0.006 ms      | 0.008 ms   |
| abs-pos resolve ×200 (all anchors)         | 13.3 ms       | 0.50 ms    |
| abs-pos resolve (single distant)           | 0.13 ms       | 0.0004 ms  |
| relative-pos create (distant)              | 0.13 ms       | 0.0005 ms  |

Position-dependence is the honest story: on the format-dense fixture,
sequential positions are guarded by `ContentFormat` items, so the
first-at-index check correctly rejects the seed (~1.0 ms — no regression,
no win). On a fragmented doc WITHOUT format guards (alternating-client
churn, 10k items) sequential append measures ~1.0 → **0.009 ms/op**
(~115×). Anchor operations are the uniform win (~26–300×) since index
lookups need no format eligibility at all.

**Correctness oracle** — `src/tests/crdt/marker-seed.test.ts` (11 tests)
replays identical op streams with markers enabled vs disabled and
requires **byte-identical** `encodeStateAsUpdate` plus identical rendered
deltas (distant inserts, formatted retains, format-marker inserts,
deletes, undo/redo, remote apply, GC, nested modify ops, merge/split,
snapshot invalidation). `bench/lib/interop.mjs` syncs patched ↔
git-HEAD baseline peers through bootstrap, alternating edits, formats,
anchors, deletes+GC, undo and concurrent conflicts — all checks pass.

### Memory verdict — the +120MB was stack pinning, not a leak

`bench/lib/memory-probe.mjs` decomposes the lane. Same-frame measurement
after destroying the 100/1k/5k held-doc sets read +78–117MB residual; the
identical measurement deferred one macrotask (frame unwound, dead stack
slots gone) reads **−0.3MB**. V8's conservative stack scan pins objects
whose pointers still sit in dead slots of the _active_ frame — the lane's
own loop locals, not retained engine state. The lane now measures through
`setImmediate` unwinds from nested async frames; corrected numbers:
lifecycle churn with {doc, facade, UndoManager} held **+7.7MB**, and
**0.0MB** after `um.destroy()` + `ed.dispose()` + `doc.destroy()`.
`runs.ts` doc-shared state is `WeakMap`-keyed — verified collectable.
Retained-heap budgets themselves were also stack-inflated and are now
measured post-unwind (±unchanged within noise).

### Fixture/attribution corrections (the §14 suspicious findings)

1. `moves.reparent` targeted `d0`, which the fixture never attached
   (`children` takes nestedSpec's inner chain) — the move was a silent
   no-op recording 0 bytes. Retargeted to `d19` (deepest attached
   section): now 73B/op, facade p50 0.12 ms.
2. `undo` write/commit read 0 because `UndoManager` calls the module-level
   `transact()` directly, bypassing the `doc.transact` method wrap.
   `instrumentOp` gained `useEvents` mode timing
   `beforeTransaction`→`beforeObserverCalls`→`afterAllTransactions`:
   write p50 0.0072 ms + commit p50 0.0112 ms, 13B/update.

### Bundle surface

`bench/bundle.js` entries (`dist/` + rolldown, real consumer pull):
`edytor/crdt` (whole vendored engine) 146,714B min / 38,854B brotli ·
`used-surface` (only symbols src/lib references) 123,096B / 32,665B ·
`combined` (import _ + bindCrdt) 284,313B / 74,650B · `edytor` full
439,815B / 108,215B · packed consumer `index-_.js`471,869B /
121,658B brotli (budget ≤125KB holds). The only module tree-shaken
between full-engine and used-surface is upstream's 396B`logNode`
debug helper — the engine is genuinely tight; the ~23.6KB min delta is
unused *exports* of the documented public engine API (`edytor/crdt`is a
published export), so removal was **rejected** as an API break; consumers
who don't`import \*` pay nothing (tree-shaking proven by the
used-surface lane).

### Rejected / not-taken paths

- `forward()`-hook snapshot writes — captured transient format state;
  byte-divergence caught by the differential oracle. Replaced by
  quiescent writes.
- Formatted-retain seeding — a retain carrying `format`/`attribution`
  applies work across its range; skipping the prefix drops it. Gated out.
- Renderer-path seeding — `marker.index` counts countable length, which
  custom renderers don't share; gated to `renderer === null`.
- `logNode` / unused-export removal — public API surface, see above.

### Validation

`test:crdt` 1348p/7s (51 files, incl. vendored upstream suite) ·
`test:crdt:extensive` 1354p/1s · `pnpm test` 1337p/1s/11t (64 files) ·
`test:dom` 142p · `check`/`test:typecheck`/`test:dom:typecheck` 0e/0w ·
`lint` clean (`bench/vendor-baseline/` added to eslint ignores —
generated content) · `pnpm package` + publint clean ·
`scripts/regen-crdt-vendor-types.sh` emitted (expected TS2589 only) ·
marker-seed differential 11/11 · interop baseline↔patched all pass.

### Remaining risks

- Snapshot invalidation is conservative (clears all on `ContentFormat`
  delete, on any re-anchor) — a missed path degrades to a rejected seed
  (slower, still correct) rather than wrong state; the byte-identity
  oracle is the net.
- The seed scan is O(markers) per eligible op (pool ≤ maxSearchMarker)
  and per-op planting does a same-index scan — bounded, subsumed in the
  measured deltas above.
- `useEvents` timing double-counts nested transactions — only used for
  the single-transaction undo lane.

## 19 — Unit 7: honest same-keystroke browser measurement + 5k verdict (2026-09-21)

Unit 7 of `docs/archive/crdt-v14-hardening-prompt.md`, answering review R7: measure the
**repaired** editor end to end, attribute one trusted keystroke across input →
transaction → maintained-view publication → DOM flush → frame scheduling, and
decide from evidence whether further optimization is justified. **No `src/lib`
production code was changed in this unit** — the identified bottleneck is
reported, not patched.

### Artifacts & source identity

| artifact                | value                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| node lane               | `bench/results/2026-09-21T14-58-49-261Z.json` (`node --expose-gc bench/run.js`)                                    |
| browser lane            | `bench/results/browser-2026-09-21T15-16-45-227Z.json` (`node bench/browser.js`; = `browser-latest.json`)           |
| `src/lib` contents      | sha256 `ce435d396e66eaaabc41695bf63996aaee23955e9b5a9c452281b2f6e7a13bdd` (178 files)                              |
| vendored engine sources | sha256 `42e3700a487595831a1b767a851b38528d47d27779a38f183c826f7be1f909d8` (32 files)                               |
| packed tarball          | `tests/packed-consumer/edytor.tgz` sha256 `b90ff22c…1dd1ed38`, 463,912 B — **rebuilt this unit**                   |
| engine label            | vendored `@y/y@14.0.0-rc.26` (upstream `96c96e1f`) + P1 specifier rewrite + P4 marker patch — **not** "unmodified" |
| browser                 | chromium 147.0.7727.15 via Playwright; Apple M4 Pro, darwin arm64, Node v24.21.0                                   |

Content hashing lives in `bench/lib/source-id.js` (hashes file **contents**,
not `git status` filenames — the R7 fingerprint defect). The bench app is
`bench/browser-app/` — a real Vite build resolving `edytor` from the repacked
consumer install, driven by `bench/browser.js`.

### Method corrections vs the §13 lane

1. **Same-keystroke staged timeline.** Every sample opens one record; all
   stage marks share that record's `t0` (capture-phase `beforeinput`, or the
   op call for facade lanes). Marks: `keydown` → `beforeinput` → `tx`
   (`beforeTransaction`) → `writeDone` (`beforeObserverCalls`) →
   `observersDone` (`afterTransaction`) → `updateDone` → `commitDone`
   (`afterAllTransactions`) → `published` (facade `onChange` subscriber
   registered _after_ the editor's own, so it fires after `flushMirror`)
   → `dom` (first observed MutationObserver record) → `handlerDone`
   (document-level bubble `beforeinput`, i.e. dispatch completion) → `raf`.
2. **Arm–dispatch ordering.** The recorder is armed synchronously inside one
   `page.evaluate` _before_ `Input.dispatchKeyEvent` — Runtime.evaluate and
   input dispatch travel different queues, and the previous run's 11–12/24
   "timeouts" at 1k/5k were events arriving before the recorder armed.
   Post-fix: **0/24 timeouts on every keystroke lane at every scale**.
3. **rAF is a callback, not paint.** `rafMs` = DOM-mutation → rAF callback.
   No paint/rasterization claim is made anywhere in this report.
4. **No median subtraction.** `facadeToDom` is reported as its own lane;
   nothing is derived by subtracting independent medians.
5. **DOM-spec checkpoint semantics are reported, not hidden.** Microtask
   checkpoints run _between event listeners during dispatch_, so the Svelte
   flush and the MO callback can complete before `beforeinput` finishes
   bubbling. `flushMs` (commitDone → dom) and `dispatchTailMs`
   (dom → handlerDone) therefore both contain work that ran _inside_ the
   `beforeinput` dispatch — the stage order in each raw record
   (`records[].marksRelEntryMs`/`order`) is the audit trail. Stage medians
   are per-stage statistics — `dispatchTailMs` ⊂ the dom→raf window, so
   stage medians do **not** sum to `totalMs`.

### Node/facade lanes — WU6/WU7 survived hardening (bounded cost)

`bench/results/2026-09-21T14-58-49-261Z.json` (`baseline.*`, p50 ms):

| lane                                  | this artifact | WU7 artifact | budget (§12) | verdict |
| ------------------------------------- | ------------: | -----------: | -----------: | ------- |
| keystroke facade @100                 |         0.097 |        0.047 |            — | holds   |
| keystroke facade @1k                  |         0.408 |        0.230 |       ≤ 3 ms | holds   |
| keystroke facade @5k                  |         1.026 |        0.839 |      ≤ 15 ms | holds   |
| `applyUpdateStaged` fast path @1k     |         0.041 |        0.043 |     ≤ 0.1 ms | holds   |
| manual scratch merge (pre-WU5 proxy)  |         7.746 |         7.36 |            — | ref     |
| remote burst apply @1k, 50 keystrokes |         0.008 |            — |            — | holds   |
| warm range read (2k slice of 100k)    |         0.010 |        0.010 |            — | holds   |
| first range read (index build)        |         0.437 |        0.452 |            — | holds   |

`commitFast=1` and `runsRecomputed=1` on every content-only lane at every
scale — interval ownership (WU6) and the shared maintained model state (WU7)
survive intact; full re-collection columns (`collectMs`/`ownMs`/`placeMs`) are
retained only as the bare-`bindModel` reference. Hardening cost on the facade
keystroke is real but bounded: +0.18 ms @1k, +0.19 ms @5k vs WU7 (R4
interning + R5 pending-notify + repair hooks). Fragmented history adds ~7%
(facade 0.298 fresh vs 0.318 churned @1k). Ops @1k facade p50: delete 0.290 ·
paste-500ch 0.308 (537 B) · paste-subtree 0.888 (2,026 B, `commitFast=0` as
designed) · format 0.408 (78 B). Seam vs caret wire: **35 B = 35 B** — the
seam premium is ~0 B, inside the ≤5 B budget. Serialization @1k: treeWalk
0.587 + contentJSON 2.42 ms. Retained memory (post-gc, 3 docs): +3.3 MB @100,
+31.8 MB @1k (≤40 MB budget ✓), +163.5 MB @5k (~31 KB/block); post-edit/undo
lifecycle +8.1 MB held → **+0.05 MB after teardown** — the WU9
"stack-pinning, not a leak" verdict holds on the repaired code.

Packed consumer bundle (`packedConsumer.assets` in the node artifact — real
Vite build of the repacked tarball): `index-*.js` **479,854 B min / 143,400 B
gzip / 123,819 B brotli** — ≤125 KB budget holds. `prism-*.js` chunks ≤3 KB.
The browser lane's own `bench/browser-app` bundle: 480,108 min / 143,596 gzip
/ 123,828 brotli.

### Browser keystroke — same-keystroke stages, p50 ms (n=24 each, 0 timeouts)

| scale                    | input | write | publish | flush | post-dom tail |  raf | toDom | **total** | p95 total |
| ------------------------ | ----: | ----: | ------: | ----: | ------------: | ---: | ----: | --------: | --------: |
| small (6 blocks)         |   0.2 |   0.1 |     0.2 |   0.2 |           0.3 |  6.2 |   0.7 |   **6.8** |       7.8 |
| 1,000 blocks             |   0.7 |   0.8 |    11.2 |  10.4 |           9.0 |  9.4 |  23.5 |  **32.8** |      37.2 |
| 5,000 blocks             |   3.1 |   3.9 |    58.9 |  61.3 |          55.6 | 57.3 | 127.8 | **185.2** |     208.9 |
| 1k + 200 churn cycles    |   0.7 |   0.8 |    10.6 |  11.4 |           8.8 |  9.2 |  24.1 |  **33.1** |      41.8 |
| shared 100k chars/50 sib |   0.3 |   0.9 |     3.0 |   3.7 |           1.3 |  1.5 |   8.0 |   **9.5** |      13.2 |

`input` = beforeinput → transaction begin (selection mapping/input
interpretation); `write` = transaction body; `publish` = writeDone →
`published` (observer calls + maintained-view patch + GC/merge + update
encode + DocChange dispatch **including the editor's commit subscriber**);
`flush` = commitDone → first observed DOM mutation (Svelte render commit);
`post-dom tail` = dom → handlerDone (post-flush checkpoint work still inside
dispatch); `raf` = dom → rAF callback (frame scheduling, **not** paint).
`updateBytes` p50 = 39 B/keystroke at every scale; `recomputedBlocks` p50 = 1
on the flat/churned lanes and **50 on the shared-backing lane** — a keystroke
into one sibling correctly invalidates every sibling slicing the same backing
text (shared-text bookkeeping, not a whole-doc recompute).

### Other browser lanes (toDom / total p50, ms — keystroke lanes trusted, facade lanes synchronous-op)

| lane (small / 1k / 5k)                         | small                          | 1k                               | 5k                                |
| ---------------------------------------------- | ------------------------------ | -------------------------------- | --------------------------------- |
| Backspace delete (n=24, 0 timeouts)            | 0.6 / 7.0                      | 22.0 / 31.8                      | 128.6 / 184.4                     |
| format hotkey Meta+b, real range select (n=10) | 1.3 / 1.7                      | 22.9 / 31.8                      | 134.2 / 191.3                     |
| `facade.insertText` → DOM (n=15)               | 0.5 / 7.3                      | 20.7 / 42.9                      | 121.3 / 179.8                     |
| paste: `insertText` 500 chars (n=15)           | 0.6 / 7.3                      | 20.8 / 45.3                      | 121.4 / 181.5                     |
| `facade.formatRange` 20 chars (n=15)           | 1.1 / 7.3                      | 22.2 / 46.5                      | 126.4 / 200.1                     |
| `undo` — measured undo step only¹ (n=15)       | 0.5 / 6.0                      | 21.2 / 50.5                      | 123.2 / 183.9                     |
| remote burst: 30 peer keystroke updates        | apply 0.1/upd; burst→raf 5.3   | apply 10.3/upd; burst→raf 622.3  | apply 57.6/upd; burst→raf 3,900   |
| reconnect: 30 offline edits → 1 diff update    | apply 0.2; diff 79 B; →raf 6.6 | apply 10.1; diff 82 B; →raf 41.6 | apply 59.9; diff 82 B; →raf 187.5 |
| explicit full-doc export `edytor.value`+JSON   | 0.1 / 1,094 B                  | 2.6 / 127,234 B                  | 12.8 / 639,234 B                  |
| cold mount (goto → all blocks rendered)        | 178 ms                         | 649 ms                           | 17,312 ms                         |

¹ Each undo sample is preceded by one unmeasured facade insert for the undo
to act on — the measured span is the undo step alone; insert+cleanup are not
reported as one op. Remote-burst applies go through `applyUpdateStaged`
(staged=0, applied=30/30) — each remote update pays the same per-commit
publish path as a local keystroke. Facade-lane `totalMs` at 1k exceeds the
keystroke lane's because ops are dispatched back-to-back with no settle
wait (main thread stays busier) — reported, not hidden.

The `shared-100k` format lane recorded **1/15 `dom-mutation` timeouts** —
sample 0 (`{bold: true}` on an already-bold slice): the transaction committed
with **0 update bytes** and no `published` mark — a true no-op commit, so no
DOM mutation existed to observe. The raw record
(`tx=1, updateBytes=0, timedOut='dom-mutation'`) is preserved in the
artifact; reported, not retried away.

### The 5k bottleneck — measured, located, **not** patched (out of scope)

Node facade keystroke @5k = **1.03 ms p50**; the browser keystroke @5k =
**185 ms p50** — the ~180× gap is entirely in the editor/Svelte layer, not
the CRDT engine. Per-commit instrumentation plus targeted probes locate it:

1. **Per-commit placeholder sweep — the dominant term.**
   `edytor.svelte.ts:456–468` — every facade commit schedules
   `tick().then(() => { removeStalePlaceholdersIn(root); for (const text of
idToText.values()) { removeStalePlaceholders(text);
scheduleRemoveStalePlaceholders(text); } scheduleRemoveStalePlaceholdersIn(root); })`.
   `schedulePlaceholderRemoval` (`removeStalePlaceholders.ts:70–84`) runs the
   removal **~6× per call**: immediate + `queueMicrotask` + rAF + nested
   `setTimeout` + `setTimeout(50/250/1000)`. At 5k texts that is ~30,000+
   scheduled DOM scans per commit, and each sweep's own node removals
   re-trigger the editor's `observeDomTextMutations` flush (which itself
   calls `removeStalePlaceholdersIn(root)` — a full-subtree
   `querySelectorAll`), amplifying further. **Measured: one 5k keystroke
   executes 75,043 `querySelectorAll` calls** (25,016 before the rAF
   callback — the `post-dom tail`/`raf` window — and 50,027 in deferred
   timer rounds over the following ~1 s). This dominates the ~56 ms
   `dispatchTailMs` and inflates `rafMs`; each keystroke also leaves ~1 s of
   residual sweep work that the next keystroke lands on.
2. **Eager full-document export per commit.** `edytor.svelte.ts:451`
   evaluates `const value = this.value` — a recursive JSON export of the
   whole tree (measured **17.4 ms standalone @5k**) — on every commit,
   unconditionally, even when `onChange` and every plugin hook are unset.
3. **Full mirror re-projection per commit.** `flushMirror()` →
   `reconcileChildren(projectedChildren(null))` reads `_projectedTree()`,
   memoized on `facade.version` — which every commit bumps — so each commit
   rebuilds the full projected tree (`facade.project()` = 4.7 ms standalone
   @5k), rebuilds the 5,001-entry index map, and diffs all 5,000 root
   children, even though the DocChange already knows the one touched block.
4. **Svelte render commit over the 5,000-child mirror** — `flushMs` ≈ 61 ms:
   keyed each-block reconciliation + DOM writes at document scale.
5. **Frame scheduling** — `rafMs` ≈ 57 ms is a callback-scheduling wait
   behind the above work, **not** paint.

`writeMs` (3.9 ms — model write + item integration) and `inputMs` (3.1 ms)
are small; `recomputedBlocks=1`/`commitFast=1` confirm the maintained view is
not the problem. Remote applies pay the same publish path — 57.6 ms/update
at 5k — so the burst lane degrades linearly (30 updates ≈ 1.9 s apply).

**Verdict:** a real, bounded, material optimization opportunity exists — the
per-commit placeholder sweep and the eager `this.value` export are O(doc)
work with no per-commit justification, plus the full-tree mirror rebuild for
content-only commits. It lives in `src/lib/edytor.svelte.ts` /
`src/lib/text/removeStalePlaceholders.ts` — **production code this unit was
not permitted to touch** — so it is reported, not fixed. Suggested follow-up
unit (with before/after evidence + focused review): scope the sweep to the
texts/parents the DocChange touched and dedupe to ≤1 scheduled pass per
commit; compute `this.value` only when a subscriber exists (or lazily);
reuse the DocChange touched-set for incremental mirror reconciliation. A
conservative ceiling estimate from the measured pieces: removing the sweep
scheduling + eager export + full re-projection would take the 5k keystroke
from ~185 ms toward the Svelte-render floor (~60–70 ms) — the estimate is
_not_ a claimed result.

### Engine/Wire budgets — all hold on the repaired build

| budget                              | line     |  measured | status       |
| ----------------------------------- | -------- | --------: | ------------ |
| keystroke facade @1k                | ≤ 3 ms   |  0.408 ms | ✓            |
| keystroke facade @5k                | ≤ 15 ms  |  1.026 ms | ✓            |
| `applyUpdateStaged` fast path       | ≤ 0.1 ms |  0.041 ms | ✓ (staged=0) |
| seam vs caret wire premium          | ≤ 5 B    |      ~0 B | ✓            |
| retained heap @1k (3 docs)          | ≤ 40 MB  |  +31.8 MB | ✓            |
| packed consumer `index-*.js` brotli | ≤ 125 KB | 123,819 B | ✓            |

Browser-scale latency has no pre-registered budget; the 5k figure above is
the measured fact and the bottleneck attribution is the deliverable.

### Follow-up: the three measured hot spots — fixed and re-measured (2026-09-21)

The follow-up unit U7 recommended was executed: the placeholder sweep, the
eager `value` export, and the full mirror re-projection were patched
**minimally**, in the editor layer only (`src/lib/edytor.svelte.ts`,
`src/lib/block/block.svelte.ts`; zero `src/lib/crdt` changes), then
re-measured with the **same instrumentation, same scales, same machine**.

Mechanisms:

1. **Placeholder sweep** — the per-commit `tick().then` handler no longer
   loops `idToText` (~5,000 texts × ~6 scheduled `querySelectorAll` runs
   each). It runs `removeStalePlaceholdersIn(node)` once +
   `scheduleRemoveStalePlaceholdersIn(node)` — one subtree sweep with the
   same multi-tick race coverage (immediate + microtask + rAF + deferred
   timers), which provably subsumes the per-text loop (every text's
   placeholder scope is its own `parentElement`, inside `node`).
2. **`edytor.value`** — the getter is now memoized on `facade.version`
   (+root identity) instead of recomputing per read, and the commit
   subscriber computes it **only when a consumer exists** (`onChange` or a
   plugin `onChange` hook). With no consumers a commit pays nothing.
3. **Mirror reconcile** — `flushMirror` on the commit dispatch applies the
   `DocChange` directly (`applyMirrorChange`): `order` lists re-set only
   changed parents' children, `added` roots `_reconcile` their projected
   subtree, `removed` roots drop with a `claimed`-aware cascade, `meta`/
   `content` patch the touched blocks. No `project()`, no 5,001-entry
   index, no full-tree diff. Divergence (unresolvable id ⇒ mirror out of
   sync with the diff stream) falls back to the full reconcile — also the
   path for direct mid-transaction `flushMirror()` calls, where no
   DocChange exists. One latent bug surfaced and fixed: `Block._drop`'s
   cascade was unconditional and ate children a commit had moved out of a
   dying subtree (`keepChildren` deletes) — the next reconcile remounted
   fresh wrappers. `_drop` now drops exactly the invisible nodes
   (projected-visibility predicate by default; the change's `claimed` set
   in the incremental path).

Measured after — browser keystroke, same-keystroke stages p50 ms
(n=24, 0 timeouts; artifact `bench/results/browser-2026-09-21T16-26-59-611Z.json`
= `browser-latest.json`; src/lib sha256 `f8f1987d…`, packed tarball
sha256 `566033a1…`, 468,066 B):

| scale                    | input | write | publish | flush | post-dom tail |  raf | toDom | **total** | p95 total |
| ------------------------ | ----: | ----: | ------: | ----: | ------------: | ---: | ----: | --------: | --------: |
| small (6 blocks)         |   0.2 |   0.2 |     0.1 |   0.1 |           0.3 |  6.3 |   0.5 |   **6.9** |       7.9 |
| 1,000 blocks             |   0.5 |   0.8 |     0.1 |   0.2 |           2.9 |  4.3 |   1.6 |   **6.1** |       7.6 |
| 5,000 blocks             |   2.9 |   4.1 |     0.2 |   0.6 |          19.1 | 21.8 |   7.6 |  **29.5** |      34.8 |
| 1k + 200 churn cycles    |   0.5 |   0.8 |     0.1 |   0.1 |             — |    — |     — |   **6.0** |         — |
| shared 100k chars/50 sib |   0.3 |   1.0 |     0.7 |   0.2 |           1.6 |  4.3 |   2.2 |   **6.5** |         — |

vs §19 baseline @5k: publish **58.9 → 0.2**, flush **61.3 → 0.6**, post-dom
tail **55.6 → 19.1**, raf **57.3 → 21.8**, total **185.2 → 29.5 ms** (−84%).
The U7 ceiling estimate (~60–70 ms — "the Svelte-render floor") was beaten:
`flushMs` collapsing to 0.6 shows the render commit was never diffing 5,000
children — it was re-running behind the full-tree reconcile; with the
incremental patch the DOM mutation is a single text node.

Other lanes @5k (toDom / total p50 ms — before → after): Backspace delete
128.6/184.4 → **7.4/24.6** · format hotkey 134.2/191.3 → **12.4/22.8** ·
`facade.insertText`→DOM 121.3/179.8 → **4.5/15.2** · paste-500ch
121.4/181.5 → **4.6/18.6** · `formatRange` 126.4/200.1 → **8.3/25.4** ·
undo 123.2/183.9 → **4.7/13.5** · remote burst **57.6 → 3.3 ms/apply**,
burst→raf **3,900 → 123.1 ms** · reconnect (30 offline edits) apply
**59.9 → 4.1 ms**, →raf **187.5 → 14.9 ms**. `recomputedBlocks=1`,
`commitFast=1`, `updateBytes` 39 B/keystroke unchanged; mount @5k
~18 s (initial 5,000-component render — unchanged, not in scope).

What remains: `post-dom tail` + `raf` @5k (~41 ms combined) is DOM-side
work inside dispatch + frame scheduling over a 5,000-block document —
layout, the MutationObserver flush/checkpoint, and the now-bounded sweep
(2 subtree `querySelectorAll` runs per commit instead of ~75k total
across 6 deferred rounds). `input` (2.9) and `write` (4.1) are unchanged —
engine-side, already incremental.

Verification: `pnpm test` 1,494 pass (7 pre-existing gateH probe failures
— RED-by-design defect documentation, unchanged); `pnpm test:dom` 142/142;
`vitest --config vitest.crdt.config.ts` 1,501 pass (same 7 probes). New
equivalence test `src/tests/mirror-incremental.test.tsx` asserts the
wrapper tree equals a fresh `facade.project()` serialization after every
op class (content/meta/move/add/delete/keepChildren/nest/merge/remote),
plus registry invariants, wrapper-identity preservation under
`keepChildren`, and lazy-`value` memoization.

### Honest limits of this measurement

- Single machine (M4 Pro), single browser (chromium 147), synthetic flat
  fixtures; ±20–40% run-to-run noise — p50 quoted, distributions in the
  artifact.
- `dom` = first _observed_ MutationObserver record; `raf` = callback
  scheduling. **No paint/raster claim is made anywhere.**
- Stage medians are per-stage — `dispatchTailMs` ⊂ the dom→raf window; stage
  p50s do not sum to `totalMs` p50.
- The keystroke lanes type `'x'` into the same block repeatedly (doc grows
  by ≤24 chars — negligible) — a deliberate same-target choice, not random
  position sampling.
- `formatHotkey` has no `beforeinput` (t0 = keydown): `dispatchMs`/
  `dispatchTailMs` are absent by design, not missing data.
- Browser mount @5k (17.3 s) is dominated by the initial render of 5,000
  block components (module load + init + first render) — cold-mount reality,
  not a regression claim.
- `performance.memory` heap figures are coarse (includes uncollected
  garbage); the node post-gc retained numbers are the trustworthy ones.
- The pre-fix artifact (`browser-2026-09-21T15-07-21-830Z.json`, 11–12/24
  timeouts at 1k/5k) is retained as evidence of the arm-race defect; only
  the post-fix artifact's numbers are reported above.

## 20 — Variant C: provenance-gated re-measurement after the 2026-09-23 hardening round (2026-09-23)

The adversarial review (`docs/archive/adversarial-review-2026-09-23.md`, item P2-8)
correctly noted that the latest browser artifact measured an **older packed
build** — the tarball predated the day's selection/attribution/readiness
fixes. This unit closes the provenance hole and re-measures.

### Provenance gate (new, enforced)

`bench/browser.js` now **refuses to run** when the packed tarball cannot
contain the source the artifact claims:

- `tests/packed-consumer/run.sh` stamps the `src/lib` content hash it
  packed into `tests/packed-consumer/edytor.src-sha256` (sidecar, sha256 of
  the `hashTree` input — same function the artifact reports). `hashTree`
  derives relpaths with `path.relative` — an earlier string-slice
  implementation hashed mangled relpaths when the caller passed a `..`-
  containing root, so stamps could never match the gate.
- The bench driver compares the stamp against the **current** `src/lib`
  hash — catches content mismatch even when mtimes lie (e.g. repacked from
  a stale dist). Missing sidecar falls back to the mtime gate
  (`tgz mtime < newest src/lib mtime` ⇒ stale).
- Both checks are recorded in `meta.sources.packedVsSrc` either way;
  `--allow-stale` records a knowingly-stale measurement instead of
  refusing. Verified: corrupted sidecar ⇒ `SKIP` + exit 1; matching ⇒ run.

`meta.variant` is now an artifact-level dimension:
`A` = retired per-edit text attribution · `B` = compact block attribution ·
`C` = block + editor fixes from the 2026-09-23 review (readiness `onReady`,
incarnation-stamped attribution records, selection ownership + stale-write
guards). This run is **variant C**.

### Artifacts & source identity

| artifact            | value                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| browser lane        | `bench/results/browser-2026-09-23T14-11-29-785Z.json` (`pnpm bench:browser`, copied to `-latest`)   |
| `src/lib` contents  | sha256 `0dc360bb790f…` (sidecar-stamped, matches tarball — includes the DST selection fixes)        |
| packed tarball      | `tests/packed-consumer/edytor.tgz` sha256 `d81f5fee…`, **609,378 B — rebuilt after final src edit** |
| `packedVsSrc.stale` | `false` — gate verified both directions                                                             |
| engine              | vendored `@y/y@14.0.0-rc.26` + recorded local patches (unchanged; `UPSTREAM.md`)                    |
| browser             | chromium 147.0.7727.15 via Playwright; Apple M4 Pro, darwin arm64                                   |

### Browser keystroke — p50 ms (n=24, 0 timeouts)

| scale                    | input | body | publish | flush | post-dom tail | raf | toDom | **total** | p95 |
| ------------------------ | ----: | ---: | ------: | ----: | ------------: | --: | ----: | --------: | --: |
| small (6 blocks)         |   0.4 |  0.2 |     0.1 |   0.1 |           0.8 | 1.4 |   1.0 |   **2.4** | 9.4 |
| 1,000 blocks             |   0.4 |  0.2 |     0.1 |   0.3 |           3.2 | 1.3 |   1.1 |   **5.2** | 7.4 |
| 5,000 blocks             |   0.3 |  0.2 |     0.1 |   1.0 |          19.4 | 9.8 |   1.8 |  **25.4** |   — |
| 1k + 200 churn cycles    |     — |    — |       — |     — |             — |   — |     — |   **5.5** |   — |
| shared 100k chars/50 sib |   0.4 |  0.2 |     0.1 |   0.3 |           1.9 | 1.2 |   1.2 |   **3.8** |   — |
| diag-1k (instrumented)   |     — |    — |       — |     — |             — |   — |     — |   **5.9** |   — |
| diag-5k (instrumented)   |     — |    — |       — |     — |             — |   — |     — |  **30.7** |   — |

Mount wall: small 331 ms · 1k 369 ms · 5k 1,246 ms · shared 221 ms.
Shared-backing setup: split×49 = 144 ms.

This is the **second** variant-C run: the first (artifact `…T13-11-25`, src
`4c156747…`, 5k p50 23.4 ms) measured the review-fix build before the DST
selection restore fixes landed; this run covers the final tree. Stage
composition is identical — the delta is dispatchTail noise (see below).

### vs variant B (2026-09-22T15-16-55) — read the noise, not the deltas

| scale  | B total | C total | note                               |
| ------ | ------: | ------: | ---------------------------------- |
| small  |     5.8 |     2.4 | within noise                       |
| 1k     |     6.0 |     5.2 | within noise                       |
| 5k     |    15.9 |    25.4 | dispatchTail 11.9→19.4 — see below |
| shared |     5.9 |     3.8 | within noise                       |

The 5k delta is **not** a regression signal: variant C's changes are not on
the keystroke hot path (readiness binding is constructor-time; selection
guards are O(1) comparisons; the attribution record check adds a map lookup

- occasional lineage walk per stamped op — `contentBody`/`publish` stages
  stay ≤0.2 ms). `dispatchTailMs` at 5k across all artifacts on this machine
  spans **13–56 ms** — the B run's 11.9 was a low outlier; C's 17.1 (first
  run) and 19.4 (this run) sit mid-band. A genuine per-keystroke cost change
  would move every scale; small/1k/shared all improved 30–45% in the same
  run, which is the noise signature, not a code effect.

### Honest limits (unchanged from §19, plus one)

- Same single-machine caveats; p50 quoted, distributions in the artifact.
- rAF = callback scheduling, **not** paint; stage p50s do not sum to total.
- The content-hash gate covers `src/lib`; the bench app and packed-consumer
  harness files are hashed into the artifact but are **not** gate inputs —
  editing them does not invalidate the tarball (they are not in it).

## 21 — Release-gate re-measurement (2026-09-24)

Re-measured after the release-gate fixes (owned-path `failed` wiring,
blurred-repair ownership guard, websocket two-round settle) — the §20
artifact's src hash (`0dc360bb…`) no longer matches the tree.

### Artifacts & source identity

| artifact           | value                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------ |
| browser lane       | `bench/results/browser-2026-09-24T07-51-11-189Z.json` (copied to `browser-latest.json`)    |
| `src/lib` contents | sha256 `cc8eb8b8…` (194 files — sidecar-stamped; gate verified `packedVsSrc.stale: false`) |
| packed tarball     | sha256 `f24f6870…`, 645,542 B                                                              |
| browser            | chromium via Playwright; Apple M4 Pro, darwin arm64                                        |

### Browser keystroke — p50 ms (n=24, 0 timeouts)

| scale                    | input | body | publish | flush | post-dom tail |  raf | **total** |
| ------------------------ | ----: | ---: | ------: | ----: | ------------: | ---: | --------: |
| small (6 blocks)         |   0.2 |  0.1 |       0 |   0.1 |           0.4 |  5.6 |   **6.5** |
| 1,000 blocks             |   0.2 |  0.1 |     0.1 |   0.2 |           3.4 |  2.3 |   **5.5** |
| 5,000 blocks             |   0.2 |  0.1 |     0.1 |   0.8 |          22.1 | 16.3 |  **32.4** |
| 1k + 200 churn cycles    |     — |    — |       — |     — |             — |    — |   **5.6** |
| shared 100k chars/50 sib |   0.2 |  0.3 |     0.1 |   0.2 |           0.9 |  4.6 |   **6.2** |
| diag-1k (instrumented)   |     — |    — |       — |     — |             — |    — |   **5.9** |
| diag-5k (instrumented)   |     — |    — |       — |     — |             — |    — |  **34.5** |

Mount wall: small 82 ms · 1k 252 ms · 5k 937 ms · shared 103 ms.
Shared-backing setup: split×49 = 91.8 ms.

Three consecutive 5k runs on this tree: 34.2 / 33.8 / 32.4 ms — the ~33 ms
figure is stable on this machine today, vs §20's 25.4 ms on the
`0dc360bb…` tree. The delta sits entirely in `dispatchTail`/`rafCb`
(headless-Chromium layout scheduling, not engine work): every engine-side
span is flat or better (contentBody 0.2→0.1, commit 0.4→0.3, flush 1.0→0.8,
toDom 1.6→1.4), the per-keystroke DOM mutation profile is unchanged
(1 recompute / 1 block / commitFast 24/24), and mount _improved_
(1,246→937 ms). `dispatchTailMs` spans 13–56 ms across same-source
artifacts on this machine, so this reads as render-ambient noise rather
than a code regression — but it is not attributable without a controlled
same-session A/B, which the uncommitted tree cannot provide. Watch item.

### Packed consumer bundle — over budget

`tests/packed-consumer/svelte-app` `index-*.js`: **587,126 B min /
148,785 B brotli (145.3 KB)** — vs the §12 budget of ≤ 125 KB and the
141.6 KB measured at review. The +3.7 KB since review is the release-gate
code. The gate fixes are not the driver — the gap to budget (~20 KB)
predates them and needs a dedicated optimization pass (vendor surface,
plugin splitting), not a per-fix shave.
