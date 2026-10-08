# CRDT v14 — Gate F2 Review (follow-up WU6–WU9 + performance acceptance)

Independent adversarial review of the CRDT v14 performance work units on
`feat/crdt-v14-engine`, prior to final integrated acceptance. Every claim below
was verified by running code — nothing was taken from the ledger, the
benchmarks document, or prior gate reviews without reproduction. **During the
review phase no production files were edited and no git state was mutated** —
the only additions were the probes under `src/tests/crdt/gateF2/` (plus
refreshed `bench/results` artifacts produced by re-running the benchmark
harnesses — an expected side effect of reproduction, not a code change).
The **resolution round** that followed implemented the fixes described in
each finding's _Resolution_ paragraph — those edits are the point of this
update and are called out per finding (F2-B1, F2-M1, F2-m1 all FIXED; the
verdict section and the post-fix suite results are at the bottom).

Review surface, per `docs/archive/crdt-v14-follow-up-prompt.md` (§WU6–WU9,
"Performance acceptance and final review"):

- **WU6** interval ownership in `src/lib/crdt/text/model.ts` — oracle parity vs
  the retained dense algorithm, overlapping claims, gaps, equal endpoints,
  merge chains, cycles, dead owners, Unicode/inline atoms, `maxG`, and every
  production consumer on interval queries.
- **WU7** shared incremental model state in `src/lib/crdt/text/runs.ts` +
  `src/lib/crdt/edytor-doc.ts` — view identity, facet invalidation,
  `commitFast`, `DocChange` completeness, local/remote/undo, lifecycle.
- **WU8** direct range reads + checkpoint indexing — parity vs the pre-WU8
  `toDelta().toJSON()` oracle, marks inheritance/clears, tombstones, inline
  atoms, snapshot immutability, bounded `itemsWalked`/`markersWalked`.
- **WU9** vendored patch P4 (`UPSTREAM.md`) — format-aware search markers for
  `applyDelta` and relative positions, seed gates, renderer exclusion,
  remote/undo clearing, upstream suite, patched↔baseline interop, real
  `yjs@13.6.30` encoded-update interop, bundle effects.
- **Benchmark acceptance** — fixture equivalence, attribution, counter
  definitions, timing windows, memory methodology, reproduction of headline
  claims.

---

## Ranked findings

### F2-B1 — BLOCKER: `deleteRange` uses stale backing coordinates across disjoint same-text segments (FIXED — all probes pass)

**Severity: blocker — user-visible mutation corruption through legal facade
ops; deterministic on every replica (convergent corruption); can throw
mid-mutation leaving a partially-applied delete.**

`deleteRange` (`src/lib/crdt/text/model.ts:1300–1328`) resolves **all** owned
segments once via `flatten`, then deletes each segment's span inside its
backing text **in displayed order**:

```ts
const segs = flatten(b, blocks, own); // all i0/i1 resolved NOW
let base = 0;
for (const seg of segs) {
	const lo = Math.max(at, base),
		hi = Math.min(end, base + len);
	if (lo < hi) {
		const text = blocks.get(seg.t)?.content;
		text.delete(seg.i0 + (lo - base), hi - lo); // ← pre-deletion coords
	}
	base += len;
}
```

When two owned segments live in the **same backing text** (`seg.t` equal — the
normal result of merge-claim chains pulling another block's records into one
display list), deleting the earlier segment's span shifts every backing
position ≥ `i0` left by `hi − lo`. The next segment's recorded `i0/i1` are
stale, so `text.delete` lands on atoms that shifted **into** those coordinates
— a rival segment's content — or off the end entirely. Verified outcomes:

- `src/tests/crdt/gateF2/wu6-delete-range.test.ts` — all three probes fail:
  - _"delete spanning three owned segs removes exactly the displayed atoms"_ —
    displayed atoms survive; rival-seg atoms deleted instead.
  - _"partial delete starting inside seg0 leaks into a rival seg"_ — throws
    `Exceeded content range` at `ynode.js:217` (`formatText` via
    `YNode.delete → applyDelta`), reached through
    `placement/model.ts:925–931` → `text/model.ts:1322`.
  - _control: delete covering only later segs_ — leaves `"dej"` where `"de"`
    was expected (an undeleted atom from a shifted rival seg).

**Attribution — pre-existing, not a WU6 regression.** The function is
byte-identical at `HEAD` (`git show HEAD:src/lib/crdt/text/model.ts`,
lines 750–776); WU6 did not touch the mutation path. This review surfaced it
while checking WU6's "preserve the complete semantics" clause. It blocks
_integrated_ acceptance regardless of provenance.

**Compounding detail:** Yjs `transact` does not roll back on a thrown error —
when `Exceeded content range` fires, every `text.delete` that already ran
stays committed. A failed delete can therefore leave a partially-applied
mutation, still convergent, still wrong. `formatRangeIn` (same iteration
shape, `text/model.ts:1339+`) is unaffected — formatting never shifts
positions. `insertIntoText` mutates at one resolved point — unaffected. This
is the only multi-segment position-shifting mutation in the file.

**Fix direction:** compute the full `(seg, lo, hi)` span list from the
snapshot, then execute deletes **per backing text in descending `i0` order**
(rightmost span first) so earlier deletes cannot invalidate later coordinates;
alternatively re-`flatten` between same-text segment deletes. Watch shared
boundary anchors when adjacent segs share an anchor identity — descending
order sidesteps anchor drift only if each span's own endpoints are resolved
before any delete runs. The retained probes must pass unmodified.

**Resolution (implemented — descending-order choice, per the first fix
direction):** `deleteRange` (`src/lib/crdt/text/model.ts:1302–1376`) now
snapshots the flattened seg list once, computes each seg's actual overlap
`{text, i0, len}` with the requested display range, then runs **two
validation passes before any mutation**: every span must resolve and fit its
backing text's live length (pass 1), and each text's spans — sorted into
descending `i0` — must be pairwise disjoint (pass 2; guaranteed by the
interval contract, checked so a violation refuses cleanly instead of
corrupting). Deletes then execute right-to-left per text: a landed delete
only shifts atoms _after_ the remaining spans, so every recorded coordinate
stays live until its own turn — no stale-coordinate deletes, and because all
validation precedes the first `text.delete`, a refused delete can never
strand a half-applied mutation (`transact` does not roll back — the
pre-validation is what makes the op atomic). Descending order was chosen
over re-flattening: identical semantics, one flatten instead of O(segs),
and no anchor-drift questions mid-loop. `wu6-delete-range.test.ts` extended
to 7 probes — the three retained plus gap-spanning mid-range delete,
delete-all + over-range clamping, undo of a multi-segment delete
(convergent re-contest semantics — see limitation 7), and concurrent
local+remote multi-segment delete. All pass.

---

### F2-M1 — MAJOR: unpaired-surrogate content is not wire-idempotent — permanent content divergence (upstream-inherited; FIXED at the facade boundary)

**Severity: major — the convergence guarantee is false for malformed UTF-16
input; reachable through legitimate facade ops with lone-surrogate payloads.
Upstream-inherited (identical in `yjs@13.6.30`), so not a WU6–WU9 regression,
but it must be disclosed for acceptance honesty.**

Mechanism (verified end-to-end): an item whose `ContentString` contains a
lone UTF-16 surrogate keeps it verbatim in the producing replica's store, but
`encodeStateAsUpdate` writes strings through UTF-8 encoding, which maps every
unpaired surrogate to U+FFFD (`EF BF BD`). The receiving replica stores a
**different string for the same item id** — a permanent divergence no later
delivery repairs:

| path                                      | producing replica | receiving replica |
| ----------------------------------------- | ----------------- | ----------------- |
| engine `applyDelta(insert 'x\ude80y')`    | `x\ude80y`        | `x�y`             |
| facade `insertText(p,1,'x\ude80y')`       | `x\ude80y`        | `x�y`             |
| `E.init` seed `'q\ude80r'`                | `q\ude80r`        | `q�r`             |
| `yjs@13.6.30` `text.insert(0,'x\ude80y')` | `x\ude80y`        | `x�y`             |

**Scope boundary (verified):** mid-pair _splits_ are safe —
`ContentString.splice` (`src/lib/crdt/vendor/yjs/src/structs/Item.js:1347–1361`)
detects a trailing high surrogate on the left half and replaces both halves'
edge chars with U+FFFD at split time, so a mid-pair `splitBlock` or
`insertText` **inside** a pair converges (both replicas see `ab�Z�cd`). The
residual hole is **direct insertion of already-unpaired payloads** — paste,
import, or programmatic input carrying malformed strings.

`src/tests/crdt/gateF2/wu9-surrogate-wire.test.ts`: the engine-level probe
fails (retained); three controls pass — facade mid-pair insert converges via
splice normalization (test name says "diverges"; it actually asserts and
demonstrates _convergence_ — the name should be corrected), mid-pair
`splitBlock` converges, pre-sanitized U+FFFD converges.

**Fix direction:** normalize unpaired surrogates at insert-integrate time
(mirroring `splice`'s approach for whole-payload inserts), or sanitize at the
facade/engine boundary and document the contract. Worth an upstream report —
`yjs/yjs#248` fixed split pairs; raw-payload surrogates are the same hole one
door down.

**Resolution (implemented — facade-boundary normalization, per the second
fix direction; vendored engine untouched):** every caller-supplied string
that enters replicated state is rewritten to well-formed UTF-16 (unpaired
surrogates → U+FFFD, the exact USVString mapping the wire encoder applies)
by `sanitizeWireString` / `sanitizeWireJson` in `src/lib/utils/json.ts`.
Valid surrogate pairs pass through unchanged (`toWellFormed` is the exact
inverse of the lossy encode) and caller objects are never mutated.
Normalization points:

- `T.insertIntoText` payload + `marks` (`text/model.ts:1116–1125`) — covers
  facade `insertText` and `setBlock` content replacement.
- `M.insertBlock` → `sanitizeSpec` (`placement/model.ts:647–686,703`) —
  ids, types, `data`, content text/marks, inline atom fields, recursively
  through `children`; covers `insertBlock`, `insertSubtree`, `E.init`,
  `setBlock` children, `duplicateBlock` re-insert specs, `modelSpecSeed`.
- `buildInline` (`placement/model.ts:530–536`) — `insertInline` atoms.
- `setInlineData` (`placement/model.ts:1079`), `setBlockType` /
  `setBlockData` (`edytor-doc.ts:1279,1290`), `formatRangeIn` formats
  (`text/model.ts:1394`), `M.splitBlock` `newId`
  (`placement/model.ts:869`), merge-reset `defaultType`
  (`edytor-doc.ts:1209`), `appendItems` content writes
  (`placement/model.ts:568–583`).
- Migration materialization — `sanitizeWireJson(json)` in
  `migrate.ts:475`, so legacy v13 payloads land normalized and the
  verify step compares normalized-vs-normalized JSON.
- `nodes.ts` `insertChild`/`split` handles bind the sanitized stored id.

Identifier _references_ (dest parents, `id` args) deliberately stay verbatim
— they resolve against stored (already-normalized) ids or are refused.
`wu9-surrogate-wire.test.ts` rewritten: the raw-engine probe is reframed as
boundary documentation (the vendored store still keeps verbatim what it is
handed — the reason the boundary exists), the misleading "diverges" name is
gone, and per-ingress facade tests pin normalization at `insertText`,
`E.init`, `insertBlock` (text/marks/data/inline ids), `setBlock`,
`setBlockType`/`setBlockData`/`setMark`, valid-pair pass-through, and the
pre-sanitized control. All 10 pass.

---

### F2-m1 — MINOR: benchmark doc §3 typing row hides an unfavorable v13 comparison

`docs/crdt-v14-benchmarks.md` §3's acceptance table shows `—` in the v13
column for `typing (single char)` while showing v13 numbers for `load` and
`delta`. The artifact records the measurement: `bench/results/latest.json`
`workloads.typing` — **v14 local p50 0.0198 ms vs v13 0.0094 ms (~2.1×
slower)**; remote 0.0087 vs 0.0071. The fixture is apples-to-apples
(engine-level `textNode.insert(len,'x')` in a transaction on an equivalent
seed block — `bench/lib/workloads.js:35–67`), so the comparison is valid and
unfavorable on the most common op. The data is not hidden (it ships in every
artifact), but the table cell should carry the number plus a one-line
explanation (v14 engine bookkeeping; still far under any interactive budget)
rather than an em-dash, especially since the _less_ flattering `delta` row
(0.0499 vs 0.0089 — 6×) **is** disclosed.

**Fixed:** the §3 typing cell now carries the artifact numbers on both sides
(v14 local p50 0.0198 ms · remote 0.0087 ms vs v13 local 0.0094 ms · remote
0.0071 ms) plus a one-line caveat that the ~2.1× delta is a raw Node
microbenchmark of the engine op, not editor latency.

---

### F2-i1 — INFO: `readRange` marks-aliasing is a load-bearing contract, not a defect today

Seeded range reads emit `marks` objects that **are** the checkpoint index's
format maps — `src/tests/crdt/gateF2/wu8-range-reads.test.ts:81–115` pins both
the alias (`emitted.marks === cp.formats`) and the corruption path (a consumer
mutating emitted marks poisons the next seeded read). The contract is
documented on `RangeSeed.formats` ("shared, never mutated in place") and
**every current producer interns + freezes before publishing** (verified at
`wu8-range-reads.test.ts:117–132` — published snapshots are frozen and immune).
This is a deliberate zero-copy design, but it is a latent hazard for any
_future_ direct consumer of `openRangeCursor`/`readRange`. Optional
hardening: freeze checkpoint format maps in dev builds, or emit a structural
`readonly` type.

### F2-i2 — INFO: WU6 counters were redefined (disclosed, but the table invites misreading)

`ownershipPositions` now counts emitted **intervals** (was: dense row length);
`claimsVisited` now counts swept **records** (was: covered positions) —
disclosed in `docs/crdt-v14-benchmarks.md` §15 and `bench/lib/baseline.js:313–317`.
The before/after table rows are therefore not comparable units; e.g. the
6,191→100 "ownership positions" row is a metric change, not a 62× win. The
disclosure is present — this entry exists so readers don't misread the delta.

### F2-i3 — INFO: `useEvents` undo timing double-counts nested transactions (disclosed)

The undo lane's write/commit split is timed via
`beforeTransaction → beforeObserverCalls → afterAllTransactions` events
because `UndoManager` calls module-level `transact()`, bypassing the
`doc.transact` wrap (`bench/lib/baseline.js:240–257`). Doc §18 discloses the
nested-transaction double-count; it only affects the single-transaction undo
lane. Verified: reparent now records 73 B/op and undo records non-zero
write/commit — the §18 fixture corrections are real.

---

## Verified clean

### WU6 — interval ownership (the _interval_ work itself is clean)

- **Oracle parity, exhaustive.** `ownership-intervals.test.ts` (15 tests)
  checks interval↔dense parity per position — owner, winning claim identity,
  `maxG`, `flatten`, `nearestOwned` both directions, anchor resolution both
  affinities — across the WU1-A/B/C regressions, merge claims, claim cycles,
  dead holders, gaps, equal endpoints, multiple backing texts, surrogate-pair
  atoms and inline nodes.
- **Randomized adversarial fuzz.** `gateF2/wu6-interval-fuzz.test.ts` (3
  tests): 300-op two-peer stream, 400-op single-peer claim-chain
  accumulation, 160-op merge-heavy stream — full parity at every checkpoint
  plus `assertConverged`; refused/thrown ops counted so the stream keeps
  exercising the surface (≥100 applied enforced).
- **Consumers all on interval queries.** Production paths use
  `sweepOwnership`/`intervalsOver`/`nearestOwned`/`ownerAt`/`intervalAt`
  (`model.ts:624–800`; consumers `runs.ts:765,846`, `edytor-doc.ts:1353,
1457,1480`, `placement/model.ts`); no dense per-position arrays outside the
  retained test oracle `dense-ownership-oracle.ts`. `runs.ts:732–765`
  `buildRow` builds `ivs` via the same sweep — O(claims), not O(text length).
- **Counters confirm scaling.** `claimsScaling` lane: 1/9/33/129 intervals
  for 0/8/32/128 claims — linear in claim boundaries, flat in text length.
- **The one exception is the F2-B1 delete path above** — a pre-existing
  mutation-coordinate defect, not an interval-semantics failure.

### WU7 — shared incremental model state

- `gateF2/wu7-shared-invalidation.test.ts` (10 tests, all passing):
  backing-text edit fans out through merge-claim `textConsumers` (local and
  remote); transitive `c→b→a` chains invalidate the top; remote claim-append
  extends a locally-hidden chain; 5-fast-commit streaks then structural then
  fast keep every `DocChange` complete vs a fresh projection; interleaved
  fast/structural commits stay complete; released subscriptions never fire;
  `doc.destroy` tears down and reattach rebuilds; block subscriptions release
  exactly once; content+meta writes inside one transaction read-your-writes.
- `commitFast` semantics verified against source (`runs.ts:1026–1297`): the
  claim-multiset fingerprint (`claimKeySet`, `runs.ts:1068–1074`) correctly
  distinguishes typing's `slices` record churn from real structure change —
  fast only when neither `structure` nor `placement` fired.
- `diffFast` (`edytor-doc.ts:927–994`) validates escalation **before**
  mutating the skeleton (visible-but-untracked ids → full diff), preventing
  half-patched state; returns `null` on no semantic change — no spurious
  `DocChange`s observed in any probe.
- Shared state is `WeakMap`-keyed on the doc (`runs.ts:371`) — teardown and
  GC verified by the memory lane (post-teardown −0.01 MB).
- `shared-state.test.ts` 15/15 and `runs.bench` invariance counters (999/1000
  snapshot reuse per unrelated edit) corroborate.

### WU8 — direct range reads + checkpoint indexing

- `range-reads.test.ts` (18 tests) + `gateF2/wu8-range-reads.test.ts` (6
  tests): full-range parity against the retained delta-JSON oracle on a
  richly formatted text; mark set/clear incl. null clears; surrogate-pair
  slicing; live inline `data`/`type`; detached guard; forward/backward/
  repeated shared-cursor reads; checkpoint positions equal each pinned item's
  exact visible offset; checkpoint formats are the state _at_ the pinned
  item; index dropped on `content` events and lazily rebuilt (insert-before-
  checkpoint staleness probe); undo rebuilds; cross-block mark interning;
  frozen snapshots; decorations; multi-backing merged-block reads.
- Bounded work verified by counters on the real lane: `itemsWalked` p50 **61**
  and `markersWalked` p50 **40** per warm 2k read of a 100k-unit text (vs a
  ~100k-item render before), `readIndexBuilds` = 10 = one per sample doc.
- Marks aliasing is a documented contract (F2-i1), with interning verified.

### WU9 — vendored patch P4 + interop

- **Differential byte-identity:** `marker-seed.test.ts` 11/11 — identical op
  streams with markers enabled vs disabled produce byte-identical
  `encodeStateAsUpdate` and identical rendered deltas (distant inserts,
  formatted retains, format-marker inserts, deletes, undo/redo, remote apply,
  GC, nested modifies, merge/split, snapshot invalidation).
- **Adversarial probes** (`gateF2/wu9-vendor.test.ts`, 12/12): tail-planted
  marker deleted then re-seeded; mid-list anchor deleted inside a range; GC
  after anchor deletion rejects stale linkage; format ops at/folding across
  the marker index; delete-adjacent + undo + re-seed; undo of the planting op
  itself; formatted leading retain correctly **rejected** for seeding;
  explicit renderer never seeds nor plants; **real `yjs@13.6.30` decodes a
  marker-active v14 update**; **vendored v14 decodes a v13-encoded update**;
  marker-on/off stores emit identical update bytes.
- **Source audit confirms the manifest** (`UPSTREAM.md` P4 §): snapshots
  written only at quiescent points; `updateMarkerFormats` folds format
  inserts in list order; `Item#delete` clears snapshots on `ContentFormat`
  tombstone; `mergeWith`/`overwriteMarker`/`updateMarkerChanges` clear on
  re-anchor; wholesale `_searchMarker.length = 0` on remote/undo; pure-
  positioning-retain gate (`format`/`attribution` unset), `renderer === null`
  gate, first-item-at-index check, 64-step bounded eligibility walk. Every
  documented invalidation path was traced in the source.
- **Interop harness** `bench/lib/interop.mjs`: baseline↔patched through real
  wire updates — bootstrap, 8 alternating distant edits, format ops, anchor
  resolution, deletes+GC, undo, concurrent conflicts, store stats — **all
  checks pass**.
- **Vendored upstream suite:** 325 passed / 6 skipped inside the extensive
  lane (`vendor-tests/yjs/upstream.test.js`).

### Benchmark comparability — reproduced

All headline claims re-measured this review (same harness, same machine):

| claim (doc §15–18)                   | doc value                 | reproduced                      |
| ------------------------------------ | ------------------------- | ------------------------------- |
| keystroke facade p50 @100/1k/5k      | 0.047/0.230/0.839 ms      | 0.045/0.230/0.970 ms            |
| `M.view()` post-write                | ~0.001–0.004 ms           | 0.0005–0.0039 ms                |
| rangeReads warm p50                  | 0.0102 ms                 | 0.0102 ms                       |
| pre-WU8 `toDelta` ref p50            | 0.3995 ms                 | 0.363 ms                        |
| first read incl. index build         | 0.452 ms                  | 0.498 ms                        |
| itemsWalked / markersWalked p50      | 61 / 40                   | **61 / 40**                     |
| engine distant retain+insert         | 1.79 → 0.91 ms            | 1.87 → 0.95 ms                  |
| engine mid retain+insert             | 0.99 → 0.51 ms            | 1.02 → 0.52 ms                  |
| sequential append (format-dense)     | ~1.0 → ~1.0 (honest flat) | 1.02 → 1.04 ms                  |
| abs-pos resolve ×200                 | 13.3 → 0.50 ms            | 14.2 → 0.48 ms                  |
| abs-pos single / rel create          | 0.13 → 0.0004 / 0.0005    | 0.147 → 0.0004 / 0.207 → 0.0005 |
| reparent fixture                     | 73 B/op, 0.12 ms          | 73 B, 0.125 ms                  |
| lifecycle churn held / post-teardown | +7.7 MB / 0.0 MB          | +8.0 MB / −0.01 MB              |

The `bench/vendor-baseline` used for before/after is byte-identical to git
`HEAD` for the three patched files (verified via `mk-baseline.sh` + diff) —
the "before" is a true unpatched engine, not a reconstructed approximation.
Memory methodology verified: the historical +120 MB was conservative stack
pinning; the corrected lane measures post-`setImmediate` unwind
(`baseline.js:1030–1076`). Fixture corrections (reparent targeting an
unattached node; undo's invisible timing) are real and verified above.
`pnpm bench:runs` reproduced: warm `runs()` 0.0003 ms, 999/1000 snapshot
reuse per unrelated edit, scaling reuse 99/999/3999.

The one disclosure gap is F2-m1 (v13 typing cell). All other honesty notes in
the doc — counter redefinitions, `useEvents` caveat, sequential-append
no-win, ±2 B varint noise — checked out as accurate.

---

## Commands run

```bash
pnpm test:crdt:extensive        # PRODUCTION=1 — full CRDT lane incl. vendor + 150-seed corpus
pnpm bench:crdt                 # node --expose-gc bench/run.js — full baseline + wire + memory
pnpm bench:runs                 # BENCH_RUNS=1 vitest runs.bench.test.ts
node bench/lib/engine-micro.mjs quick
ENGINE_DIR=../vendor-baseline/yjs node bench/lib/engine-micro.mjs quick
node bench/lib/interop.mjs      # patched ↔ git-HEAD baseline through real updates
npx vitest --config ./vitest.crdt.config.ts --run \
  src/tests/crdt/marker-seed.test.ts src/tests/crdt/text/ownership-intervals.test.ts \
  src/tests/crdt/text/ownership-regression.test.ts src/tests/crdt/runs/shared-state.test.ts \
  src/tests/crdt/runs/range-reads.test.ts
```

## Suite results (this review's run)

- `pnpm test:crdt:extensive` — **1,388 passed / 4 failed / 1 skipped**
  (58 files, ~100 s). The 4 failures are _exactly_ the retained defect
  probes: 3 × `wu6-delete-range` (F2-B1) + 1 × `wu9-surrogate-wire` (F2-M1).
  Includes vendored upstream suite (331 tests; 325p/6s) and the strict
  150-seed corpus (470 checks — evidence only `moved-edit`, `deleted-legit`,
  `convergent-loss`; zero `stolen-edit`, zero `lost-edit`).
- Focused lanes: `marker-seed` 11/11 · `ownership-intervals` 15/15 ·
  `ownership-regression` 9/9 · `shared-state` 15/15 · `range-reads` 18/18 ·
  `wu7-shared-invalidation` 10/10 · `wu8-range-reads` 6/6 · `wu9-vendor`
  12/12 · `wu6-interval-fuzz` 3/3.
- `bench/lib/interop.mjs` — all checks pass.
- Artifacts: `bench/results/latest.json` + `runs-latest.json` refreshed by
  reproduction; `bench/results/2026-09-21T06-42-*.json` are this review's
  runs.

## Suite results (resolution round — post-fix)

- `pnpm test:crdt` — **1,396 passed / 7 skipped / 0 failed** (58 files).
- `pnpm test:crdt:extensive` — **1,402 passed / 1 skipped / 0 failed**
  (58 files, ~97 s; the 1 skip is the `BENCH_RUNS`-gated
  `runs.bench.test.ts`). Includes the vendored upstream suite (331/331)
  and the strict 150-seed corpus (470 checks — same evidence classes:
  only `moved-edit`, `deleted-legit`, `convergent-loss`; zero
  `stolen-edit`, zero `lost-edit`).
- gateF2 focused lane — **48/48**: `wu6-delete-range` 7/7 ·
  `wu9-surrogate-wire` 10/10 · `wu6-interval-fuzz` 3/3 ·
  `wu7-shared-invalidation` 10/10 · `wu8-range-reads` 6/6 ·
  `wu9-vendor` 12/12.
- `pnpm test` — **1,385 passed / 0 failed** (70 files).
- `pnpm test:dom` — **142 passed / 0 failed** (3 files).
- `pnpm test:integration:serial` — **1,197 passed / 12 skipped / 0
  failed** (all five projects: chromium, firefox, webkit,
  mobile-chromium, mobile-webkit).
- `pnpm check` / `pnpm test:typecheck` / `pnpm test:dom:typecheck` —
  0 errors / 0 warnings; `pnpm lint` — clean.
- `pnpm build` — vite build + `svelte-package` + publint all clean.

## Honest limitations

1. **F2-B1 was a release blocker, pre-existing — now fixed.** It lived in
   the delete path that none of WU6–WU9 touched; the interval work itself is
   verified-equivalent to the dense oracle everywhere. The fix (descending
   per-text order + pre-validation, see the F2-B1 resolution) is verified by
   the three retained probes plus four new edge cases.
2. **F2-M1 is upstream-inherited — now fixed at the boundary.** Identical
   encoding behavior verified in `yjs@13.6.30`; the vendored encoder files
   remain upstream-identical (the fix normalizes at the facade boundary, not
   in vendor code — the raw-engine probe documents why the boundary must
   exist). Raw `applyDelta` writes on user-facing engine types remain
   outside the supported contract; every facade ingress is normalized.
3. **Timing is single-machine** (the doc's own ±20–40 % noise caveat);
   keystroke-5k measured 0.97 ms vs the claimed 0.84 — within noise, flagged
   for completeness.
4. **DOM/browser lanes re-run this round:** `pnpm test` 1,385p,
   `pnpm test:dom` 142p, `pnpm test:integration:serial` 1,197p/12s
   across all five browser projects, `pnpm check` / both test
   typechecks / `pnpm lint` clean — the integrated board is green.
5. **Fuzz `threw` accounting.** `wu6-interval-fuzz` catches `deleteRange`
   throws so the stream continues; parity is checked on the resulting state.
   A thrown-then-committed partial delete still reads as "consistent" to the
   structural oracle — the dedicated `wu6-delete-range` probes are what pin
   the user-visible defect. (Moot for the new implementation: `deleteRange`
   pre-validates every span, so the throw path is unreachable through the
   facade.)
6. **Facade-level surrogate test name** said "diverges" while asserting
   convergence via splice normalization — renamed in the rewrite; the test
   now documents the engine boundary and pins per-ingress normalization.
7. **Undo of atom deletes re-contests restored atoms (pre-existing model
   semantics, convergent — not introduced by the F2-B1 fix).** Upstream
   `UndoManager.redoItem` restores deleted atoms as **new** items (the
   tombstones stay deleted); slice anchors bound to those tombstones resolve
   past the redone replacements because `resolveAnchor` runs
   `followUndoneDeletions=false` — the only convergent choice, since
   `redone` pointers never serialize. Revived atoms therefore land in the
   currently-winning claims (e.g. undoing the fragmented multi-seg delete
   puts 'de' under `b`, 'h' under `mid1`, 'j' under `mid3` instead of back
   under `early`). Verified identical behavior for single-segment deletes —
   it is a property of anchored claims + upstream undo, not of the delete
   implementation. Every restored atom displays exactly once and all
   replicas compute the identical projection; the `wu6-delete-range` undo
   probe pins convergence + conservation. Restore-to-original-owner undo
   would need undo-aware claim semantics — recorded here as a known
   semantic gap, not a convergence defect.

## Verdict

- **WU6 (interval ownership): PASS.** The interval representation, oracle
  fidelity, scaling counters and consumer cutover are verified clean, and
  the shared delete path is now correct: `deleteRange` snapshots spans,
  pre-validates every range before mutating, and executes per backing text
  in descending `i0` order — the unit-1 "complete semantics" claim now
  holds for the delete path (all 7 `wu6-delete-range` probes green).
- **WU7 (shared incremental state): PASS.** Invalidation fanout, `commitFast`
  classification, `DocChange` completeness, lifecycle and teardown all
  verified; `diffFast`'s validate-then-patch is correct.
- **WU8 (range reads + checkpoints): PASS.** Oracle parity, bounded counters
  (61/40 walked per 2k read of 100k), immutability and invalidation all
  verified; marks-aliasing is a documented contract with verified interning.
- **WU9 (P4 patch + interop + bundle): PASS.** Byte-identical differential,
  all seed/invalidation gates verified in source and by probe, upstream suite
  green, patched↔baseline and real v13↔v14 wire interop green, measured wins
  reproduced within noise.
- **Benchmark acceptance: PASS (F2-m1 fixed).** Fixtures equivalent,
  attribution honest, counters redefined-but-disclosed, memory methodology
  corrected and verified, headline numbers reproduced; the typing row now
  discloses the real v13 comparison.
- **Integrated gates: PASS** — F2-B1 fixed (all retained probes plus the
  added edge cases green), F2-M1 fixed at the facade boundary (all
  `wu9-surrogate-wire` probes green), `pnpm test:crdt`,
  `pnpm test:crdt:extensive`, `pnpm test`, `pnpm test:dom`,
  `pnpm test:integration:serial`, `pnpm check`, both test typechecks and
  `pnpm lint` all green.
- **Overall completion: PASS.** Everything WU6–WU9 built is verified; the
  pre-existing delete-path defect is fixed (descending per-text order +
  pre-mutation validation), the upstream-inherited wire divergence is
  normalized at the facade boundary with the raw engine path documented as
  below-contract, and the benchmark disclosure is honest. The verdict this
  review predicted — "fix `deleteRange`, keep the retained probes green,
  re-run `pnpm test:crdt:extensive`, and this review's verdict flips to
  PASS on existing evidence" — is satisfied.
