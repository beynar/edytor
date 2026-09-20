# CRDT v14 test harness + bench — U02 record

Companion to `crdt-v14-implementation-plan.md` (§U02, §8, §10) and
`crdt-v14-execution-ledger.md`. This file documents the audit verdict, the
defects found and fixed, how to run every lane, and the measurement harness.

## Commands

| Lane             | Command                                   | What it runs                                                                                                                                            |
| ---------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Green CRDT suite | `pnpm test:crdt`                          | vitest `vitest.crdt.config.ts`: harness, §8 active scenarios, random corpus (150 seeds), historical repros, v14 smoke, legacy v13 — `src/tests/crdt/**` |
| Extensive        | `pnpm test:crdt:extensive`                | same suite under `PRODUCTION=1` (upstream production gates)                                                                                             |
| Pending §8 lane  | `pnpm test:crdt:pending`                  | `vitest.crdt-pending.config.ts` → `src/tests/crdt-pending/pending.test.ts` — 39 `it.todo` rows, deliberately excluded from the green gate               |
| Bench            | `pnpm bench:crdt` (= `node bench/run.js`) | the four §10 workloads below; writes `bench/results/`                                                                                                   |

The corpus lives inside `pnpm test:crdt` — there is no separate command to
forget to run.

## Directory map

```
src/tests/crdt/
  harness/
    peer-set.ts        — independent replicas, directed edge queues, partitions,
                         delivery (ordered/reversed/duplicate/batched),
                         incremental + full-state sync, persist + reload
    rng.ts             — mulberry32 seeded RNG helpers
    assert/convergence.ts — projection diff paths, decoded-SV compare,
                         structural checks, identity snapshots, undo helper
    ops/crdt-ops.ts    — the CrdtOps adapter contract + capability flags
    ops/raw-node-ops.ts — RawNodeOps: v14 Y.Node mapping with TODAY's copy
                         semantics (preservesIdentityOnMove/SplitMerge = false)
    harness.test.ts    — 24 focused harness/network/adapter tests
  scenarios/
    registry.ts        — SECTION8_IDS completeness oracle + entry types
    active.ts          — runnable scenarios asserting plan-required outcomes
    pending.ts         — data-only rows (id, title, owner unit, reason)
    seeds.ts           — BASE_SEED seed document
    scenarios.test.ts  — green-lane runner + completeness/ownership guards
  random/
    generator.ts       — seeded schedule generator (doc ops + net ops)
    runner.ts          — executes schedules, barrier, classifies violations
    shrink.ts          — greedy chunk-removal minimizer
    corpus.test.ts     — the bounded corpus: 150 seeds × 200 ops × 3 peers
    failures/          — persisted repros (schedule + minimized transcript)
  historical/
    issue-694.test.ts  — yjs-14-move pins: sparse toJSON + cursor anchor idx 2
  legacy-v13.test.ts   — v13 baseline decoder tests (U00)
  v14-smoke.test.ts    — vendored engine smoke tests (U01)
src/tests/crdt-pending/
  pending.test.ts      — renders pending registry rows as it.todo
bench/
  run.mjs              — entrypoint: env metadata, JSON output
  lib/stats.mjs        — sampling, p50/p95
  lib/models.mjs       — equivalent v13/v14 doc builders + move impls
  lib/workloads.mjs    — typing / move / load / delta
  results/             — <iso-timestamp>.json + latest.json
```

## Audit verdict (the six required checks)

1. **Single-seed-update replica construction — PASS.**
   `createPeerSet` builds one seed doc, serializes it once with
   `encodeStateAsUpdate`, and every peer is a fresh `Y.Doc` that applies that
   update (`peer-set.ts:342-364`). `harness.test.ts:25` asserts replicas share
   the seeded block's CRDT identity. No independent JSON initialization.

2. **Network controls are real and exercised — PASS.**
   Directed per-edge queues; `partition`/`heal`/`isolate`; `deliver` with
   `reverse`, `times` (duplicates), `batch` (merged update); `dropQueued`
   (message loss); `syncPeer` (incremental state-vector sync); `syncPeerFull`
   (full-state); `persist` + `reload('snapshot'|'log')` (update-log replay).
   All covered in `harness.test.ts` (network simulation describe) AND emitted
   by the random generator (`generator.ts` NET_ACTIONS).

3. **Assertions beyond JSON equality — PASS.**
   `convergence.ts` compares canonical projections pairwise, compares DECODED
   state vectors, emits path-addressed first-diff strings, walks the tree for
   cycle / duplicate-placement / duplicate-inline / malformed-node violations,
   and diffs `crdtId` identity snapshots. The corpus adds lost-edit and
   resurrected-delete probes.

4. **Active vs pending registry — PASS.**
   `SECTION8_IDS` lists all 41 §8 ids; `scenarios.test.ts` fails if any id is
   neither active nor pending, if pending rows lack a `U\d\d` owner, or if a
   pending id is not a real §8 id. Pending rows are data-only (no `run`
   function — they cannot be weakened into a pass) and render as `it.todo`
   under `vitest.crdt-pending.config.ts`, which `pnpm test:crdt` does not
   include. Owners: U03 (MV01–MV10), U04 (TX01–TX09), U05 (AN01–AN07), U06
   (ST01–ST03), U07 (SY01–SY03, CO01–CO03), U09 (SE01–SE03, HI01–HI02, IN01),
   U12 (PK01).

5. **Random corpus — PASS after fixes.**
   `CORPUS_SEEDS` = 150 fixed seeds (> the plan's ≥100), each a deterministic
   200-step schedule across 3 peers. The corpus runs in the bounded green
   lane (~13s). Failing seeds persist `failures/seed-<n>.json` (raw schedule +
   greedily minimized repro + readable transcript) — artifacts self-clean when
   a seed passes again. Shrinking is exercised by self-tests, not just by luck.

6. **Historical #694/cursor reproductions — PASS.**
   `issue-694.test.ts` imports `yjs-14-move` (`yjs@14.0.0-1`) and asserts the
   documented buggy behavior: after moving `2` to index 1 in `[0,1,2]`,
   `toArray()` is `[0,2,1]` while `toJSON()`/`JSON.stringify` show the sparse
   array (`[0,2,null]` — index 2 absent), and a relative position anchored to
   `c` before a move-to-front resolves to index 2 instead of 0 (both `assoc`
   values pinned).

## Defects found and fixed by the audit

- **The corpus never ran.** Generator/runner/shrink existed but nothing
  invoked them — the §U02.5 bounded-CI deliverable was dead code. Added
  `corpus.test.ts` (seed-parametrized runner + persistence + shrink
  self-tests + shape guardrails).

- **`RawNodeOps.splitBlock` re-resolved the destination container by logical
  id.** Under duplicate logical ids (produced by concurrent copy-moves) it
  could pick a different physical copy whose length mismatched the offset →
  `Exceeded content range` crashes (e.g. seed 116). Fixed: the split inserts
  into the resolved block's actual `block.parent` container
  (`raw-node-ops.ts:290-296`).

- **`project()` crashed on nodes with unresolvable attrs.** Under lossy
  reload schedules a tombstoned node's `content`/`children` attr can fail to
  resolve → the projector threw, masking the real outcome and escaping the
  runner's classification. Now projects best-effort and sets
  `ProjectedBlock.malformed` → `checkStructurallyValid` reports
  `malformed-node` (never an expected class).

- **Divergence classification did not account for transitive data loss.**
  Lossy snapshot reloads can destroy the last copy of an item on all replicas;
  stranded `pendingStructs`/`pendingDs` then make honest divergence
  impossible. The runner now tracks observed loss (`sawLoss` — SV regression
  or dropped pending state on reload) and classifies post-barrier divergence
  as `unrecoverable-loss` evidence only when loss was actually observed AND
  pending residue exists. In a lossless run, pending residue or divergence
  stays a hard failure. Resolvable pendingDs deps (present in some store but
  never applied) also stay hard failures.

- **Engine-internal crashes needed their own class.** Two seeds (86, 140)
  crash inside vendored-engine cleanup machinery — `findIndexSS` /
  `iterateStructsByIdSet` iterating delete-set ranges that reference items
  absent from the store — while processing _legal_ update streams under lossy
  schedules. Classified `upstream-engine-crash`: a vendored rc.26 robustness
  gap, evidence for U07 (providers/persistence) and a candidate upstream bug
  report. Repros persisted in `failures/`. A crash whose stack is not in the
  engine-internal cleanup path stays a hard `crash` failure.

- **Expected-evidence classes now derive from adapter capability flags.**
  `expectedViolations(ops)` gates `duplicate-placement`, `duplicate-inline`,
  `resurrected-delete`, `cycle` on `!preservesIdentityOnMove` and
  `lost-identity` on the split/merge flag — so plugging in the real U03/U06
  adapter automatically turns today's evidence into hard failures. Nothing is
  weakened permanently.

- **Missing `test:crdt:pending` script.** The pending lane existed but no
  package script ran it — added (`vitest.crdt-pending.config.ts`), plus
  `bench:crdt`.

## Corpus evidence baseline (150 seeds, first green run)

`lost-edit×134, resurrected-delete×84, lost-identity×76,
duplicate-placement×50, duplicate-inline×20, cycle×7, unrecoverable-loss×2,
upstream-engine-crash×2`

Every class except the last two is a copy-adapter consequence pinned to a
pending §8 row. `unrecoverable-loss` = convergent data loss under lossy
reloads (correct semantics). `upstream-engine-crash` = vendored rc.26 DS
iteration over destroyed ranges (U07 evidence; repros committed).

### Replaying a failing seed

```
CRDT_SEEDS=86 pnpm test:crdt        # one seed
CRDT_SEEDS=1,7,86 pnpm test:crdt    # list
CRDT_SEEDS=1-40 pnpm test:crdt      # range
CRDT_SEEDS=1-1000 CRDT_OPS=500 CRDT_PEERS=4 pnpm test:crdt   # wider sweep
```

`failures/seed-<n>.json` contains the raw schedule, a minimized schedule, and
a readable transcript — enough to rebuild the repro without the corpus file.

## Benchmark (`bench/`)

`node bench/run.js` — plain node, no build step. Imports the vendored v14
engine relatively (`src/lib/crdt/vendor/yjs/src/index.js`) and npm
`yjs@13.6.30`. Writes `bench/results/<iso>.json` + `latest.json` with node
version, CPU brand, engine labels, warmup/sample counts, p50/p95.

| Workload | Measures                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| `typing` | local single-char insert latency + remote `applyUpdate` latency on a synced replica                          |
| `move`   | encoded update bytes for a 100k-char block move: v13 copy vs v14 placement attribute; timed 500-char variant |
| `load`   | 1,000-block doc: update bytes, `applyUpdate` load ms, materialization ms                                     |
| `delta`  | 128-format-run paragraph `toDelta()` p50/p95                                                                 |

### First baseline (2026-09-19, node v24.21.0, Apple M4 Pro)

- move 100k payload: **v13 copy 100,136 B vs v14 placement 54 B**
- typing: v14 local p50/p95 0.016/0.036 ms, remote 0.010/0.027 ms;
  v13 local 0.010/0.028 ms, remote 0.008/0.016 ms
- load 1000 blocks: v14 2.64 ms (188,867 B) vs v13 1.92 ms (147,867 B)
- delta 128 runs: v14 p50 0.049 ms vs v13 0.009 ms

Caveats recorded in the JSON: v13 copy-move is **not correctness-equivalent**
(loses concurrent edits); timings are single-machine wall-clock; the v14
placement move is the attribute-relocation primitive the §4 design targets —
the real model adapter lands in U03+.

## Blockers handed to U03/U04/U07

- U03: `preservesIdentityOnMove` flip reclassifies `duplicate-placement`,
  `duplicate-inline`, `resurrected-delete`, `cycle` from evidence to hard
  failures automatically; pending MV01–MV10 become runnable.
- U04: `preservesIdentityOnSplitMerge` flip does the same for `lost-identity`;
  `lost-edit` stays expected (concurrent deletes legitimately erase tags).
- U07: `upstream-engine-crash` repros (`failures/seed-86.json`,
  `failures/seed-140.json`) — vendored rc.26 crashes iterating delete sets
  over destroyed ranges; needs the persistence/provider story (and possibly
  an upstream report). `unrecoverable-loss` pins the convergent-loss contract.
