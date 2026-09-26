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

## Strict lost-edit oracle + corpus lanes (WU3)

The baseline above predates the strict gate: the corpus used to report model
adapter `lost-edit×129` + `unrecoverable-loss×5` as "evidence" — outcome
counts, not correctness verdicts. WU3 replaced that with an atom-level
oracle and a strict/diagnostic lane split.

### Lanes

| Adapter                     | Lane           | Gate                                                                                                                                                                                         |
| --------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model` (`placement-model`) | **strict**     | Any hard violation fails the seed: `lost-edit`, `unreachable-block`, `crash`, `divergence`, `upstream-engine-crash` — an engine stack frame does not excuse a crash on production semantics. |
| `doc` (`edytor-doc`)        | **strict**     | Same — the public facade must preserve the model's semantics.                                                                                                                                |
| `raw` (`raw-node`)          | **diagnostic** | Expected copy-semantics evidence (`lost-edit`, `duplicate-placement`, `resurrected-delete`, `cycle`, `lost-identity`, `duplicate-inline`, `upstream-engine-crash`) is reported, never gated. |

The partition lives in `runSchedule`: `RunResult.violations` is always the
hard list, `RunResult.evidence` the legit report — a legit class can never
be promoted nor a real one downgraded by the caller. The legit set is
adapter-derived (`expectedViolations(ops)`): oracle adapters legitimize
only `moved-edit`, `deleted-legit`, `convergent-loss`. `stolen-edit` is a
hard violation on every strict lane (gate-F1 F3).

### Atom-fate oracle (`classifyTagAtoms`)

At each successful `insertText` the runner records the written atoms'
engine ids (`{client, clock}` via `locateTagAtoms`). At the barrier each
atom is classified on every replica (`AtomFate`):

- `present` — displayed by the block the insert targeted.
- `moved:owner` — displayed by a _different_ visible block (split/merge
  moved through contested-range claims). The edit survived, relocated.
- `stolen:owner` — like `moved`, but the owner has no causal explanation
  (gate-F1 F3). With a `TagClassifyContext` the oracle distinguishes a
  legitimate owner-move from an ownership steal: `insertOwners` records
  owners that already claimed the atoms at insert time (the at-birth
  steal signature — the insert itself was misrouted) and `legitOwners`
  carries every block a recorded split/merge produced, PLUS the atoms'
  home block (its backing text's natural owner — it reclaims the atoms
  whenever a claim holding them dissolves, e.g. the claiming block is
  concurrently deleted) and the insert target. A visible owner outside
  that set is an unexplained transfer → `stolen` → `stolen-edit`, a hard
  failure — never evidence. Without context the verdict stays `moved`
  (pre-F3 semantics for context-free callers).
- `tombstoned` — the item itself is deleted (explicit `deleteText`/
  `removeInline` covered it). **Legit deletion.**
- `dead-owner` — live atom, but every covering claim belongs to a
  deleted/legitimately-hidden holder — content died with its owner.
  **Legit deletion** (block-delete contract).
- `unreachable` — owned by a live block that should be projected but is
  not → `unreachable-block` violation.
- `uncovered` — live atom covered by NO claim record at all (coverage
  hole).
- `gone` — absent from the struct store entirely (safe lookup: clock
  beyond the client's stored range, or a non-Item/non-GC struct; `findIndexSS`
  is only called once presence is established — it throws on absent clocks).

Tag verdicts (worst-first): `present` › `moved-edit` › `deleted-legit` ›
`convergent-loss` › `lost-edit` › `stolen-edit` › `unreachable-block`.

### What counts as real loss vs environment loss

An atom reported `uncovered`/`gone`/`unreachable` on peer A is **not**
automatically lost. Yjs applies an update's deleteSet on receipt while each
struct integrates only once its deps arrive — under a lossy schedule
(reloadSnap/reloadLog/drop/partition) a coverage record can be:

- **stranded in `pendingStructs`** on some replicas and integrated on
  others → the cross-replica check finds a soft fate on another peer →
  `convergent-loss`;
- **destroyed at origin** (written, then regressed by a snapshot reload
  before any delivery) → hard on every replica — excused only when the
  atom's OWN ids are correlated with the observed loss (gate-F1 F4, see
  below) → `convergent-loss`;
- **a genuine hole** — hard on every replica and not loss-correlated →
  `lost-edit`, a hard failure.

Same logic for `gone` and `unreachable`: legit only under correlated
environment loss; otherwise both are violations.

### Correlated loss (gate-F1 F4)

The excuse used to be run-global: any `sawLoss` event anywhere in the
schedule excused every hard atom fate. The runner now records **which**
item-id ranges each lossy reload actually destroyed — pending-struct and
pending-deleteSet ranges captured pre-reload plus regressed state-vector
tails — into `lostRanges`, and snapshots the post-barrier stranded-pending
residue as `strandedRanges`. A hard-on-every-replica atom classifies
`convergent-loss` only when its own id or one of its coverage deps
(`tagAtomDeps` — the claim stamps of every record covering the atom on
any replica, live or dead holder) intersects either set. An unrelated
lossy reload elsewhere in the run excuses nothing; the WU3a injection
probe pins this (one tag's real destroyed-by-reload loss stays
`convergent-loss` while injected `uncovered` fates on untouched tags stay
`lost-edit`).

### Injection proof (permanent tests)

`corpus.test.ts` self-tests prove the strict gate cannot silently pass:

- a `classifyTagAtoms` stub returning `uncovered` on a lossless schedule →
  `ok:false`, violations `lost-edit`;
- an adapter `insertText` that throws → `ok:false`, violations `crash`;
- a `locateTagAtoms` returning `null` (success with no findable atoms) →
  `ok:false`, violations `lost-edit`.

Gate-F1 adds two more permanent proofs in `gateF1/wu3a-oracle.test.ts`:

- a stub returning `uncovered` everywhere on a schedule containing a real
  lossy reload → the atom-correlated tag stays `convergent-loss`, the
  unrelated injected fates stay `lost-edit` (F4 correlation, not the
  run-global excuse);
- a deliberately misbehaving adapter whose typed atoms are immediately
  owned by a rival → `stolen-edit`, a hard failure (F3 — a steal can
  never launder through `moved-edit`).

### WU3 classification of the 134 residual cases

Full per-seed detail prints in the corpus run
(`per-seed verdicts [adapter] seed N: tag:verdict`). Verdict totals across
150 seeds × ~200 inserts (identical on `model` and `doc`):

`present×1972, deleted-legit×2000, moved-edit×1176, convergent-loss×84` —
**zero `lost-edit`, zero `unreachable-block`**.

Mapping of the old classes:

- `lost-edit×129` (seed-level) → all resolved to `moved-edit`
  (owner-move, the majority), `deleted-legit`, or `convergent-loss`.
  The five tags that still surfaced as `lost-edit` mid-triage
  (`µ24x39`, `µ24x58`, `µ135x42`, `µ135x86`, `µ135x97`) were traced to
  coverage records stranded in `pendingStructs` — proven by inspecting
  per-replica stores (the records are integrated on one replica, pending
  on the others; all peers carry pending residue under the schedule's
  lossy net ops). **No real model loss was found — no model fix needed.**
- `unrecoverable-loss×5` → renamed `convergent-loss` (correct CRDT
  semantics under the harness's deliberate environment loss).

Seeds carrying `convergent-loss` tags: 1, 9, 12, 15, 21, 24, 26, 33, 38,
63, 64, 68, 148, 150 — all consistent with those schedules' lossy net ops.

**Post-gate-F1 update (2026-09-21):** with the F1 ownership fix in
`text/model.ts` (inserts claim their atoms for the typed-into block on
every boundary — empty display, left edge, display-end append), the strict
oracle with `stolen` active reports **zero `stolen-edit` and zero
`lost-edit`** across all 150 seeds on both strict adapters. Per-seed
evidence classes observed: `moved-edit` (141 seeds), `deleted-legit` (150),
`convergent-loss` (15) — identical on `model` and `doc`. The corpus run
before the fix showed real `stolen-edit` violations (e.g. seed-20/seed-46
inserts whose atoms were born inside a rival's claim at the display-end
seam); the engine fix removed them — nothing was reclassified to force
green.

### Upstream crash repros stay diagnostic

`failures/seed-86.json` / `seed-140.json` (vendored rc.26
`iterateStructsByIdSet`/`findIndexSS` crashes over destroyed ranges) are
replayed by a permanent test: they must classify as
`upstream-engine-crash` _evidence_ on the raw adapter — never a gate
failure, never silently green. Artifacts now also persist `evidence` and
`tagVerdicts` for provenance.

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
