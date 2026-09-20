# CRDT v14 — U11 measured performance & bundle report

Unit: **U11 — measured specialization and bundle reduction** (plan §7/§8).
Rule followed: measure first, optimize only what the measurements justify,
record before/after for every change, report unmet targets honestly.

## Environment & methodology

- Machine: Apple M4 Pro, darwin arm64 25.5.0
- Node `v24.21.0`, pnpm `10.32.1`
- Repo: `/Users/arnaud/code/edytor` @ the U11 working tree (uncommitted v14 work
  is the baseline — see `crdt-v14-execution-ledger.md`)
- Profiling: `src/tests/crdt/u11-profile.test.ts` — 30 timed iterations per
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

| op                                |                                    v14 |     v13 copy-equivalent |
| --------------------------------- | -------------------------------------: | ----------------------: |
| move, 100k-char block             |                               **54 B** |               100,127 B |
| split, 100k-char payload          |                              **346 B** |                50,136 B |
| merge, 100k-char payload          |                               **35 B** |               100,035 B |
| split scaling                     |      1k→334 B · 10k→341 B · 100k→346 B |  617 / 5,132 / 50,136 B |
| typing (single char)              | local p50 0.0141 ms · remote 0.0096 ms |                       — |
| load 1,000 blocks                 |         v14 2.67 ms (188,867 B update) | v13 2.01 ms (147,867 B) |
| delta, 128 runs                   |                      v14 p50 0.0499 ms |       v13 p50 0.0089 ms |
| left-edge typing at a record seam | **69.7 B/char** (100 inserts, 6,973 B) |       bound <200 B/char |

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

`src/tests/crdt/u11-profile.test.ts`, 1,000 flat blocks, isolated run.

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
- `src/tests/crdt/u11-profile.test.ts` is the durable per-keystroke/load
  profile (~3 s in the green lane).
- Candidate U12+ item if keystroke latency still matters: a facet-driven
  DocChange path (reuse the runs view's per-event invalidation set so
  content-only transactions skip the ~1.3 ms skeleton snap). Needs care:
  `takeSnap` must still keep `prev.nodes` fresh across skipped snapshots and
  non-content facets must fall back to the full diff.
- Package surface decision deferred: whether `edytor/crdt` should keep
  re-exporting the whole engine vs a curated subset (worth ≤ ~23.6 KB min).
