# Architecture v2 execution ledger

Branch `arch-v2` in worktree `/Users/arnaud/code/edytor-arch-v2`, based on commit `a7337c5`
(snapshot of `feat/crdt-v14-engine` = d9b7de0 + its uncommitted working tree on 2026-09-26).
The plan is `docs/architecture-v2/plan.md`; its §9 defines the checkpoints and discipline.

## Baseline (a7337c5)

| Lane | Result |
|---|---|
| `pnpm exec vitest --run` | 123 files, 1949 passed, 3 skipped, 11 todo |
| `pnpm test:dom` | 21 files, 346 passed, 33 skipped |
| `pnpm test:crdt` | 100 files, 1864 passed, 9 skipped |
| `pnpm check` | 0 errors, 0 warnings |
| `pnpm lint` | clean (after ignoring generated `docs/architecture-v2/` for prettier) |
| chromium integration | 483 passed, 1 skipped, **9 failed deterministically** (known-red baseline, listed below) |
| xloc (`node scripts/xloc.mjs src/lib`) | 29,109 |

### Known-red chromium specs at baseline (reproduced on rerun)

- `beforeinput-fallback.spec.ts:422` reconciles full text wrapper replacement when input events are missing
- `collaboration-websocket-3client.spec.ts:565` refused schema handshake claims no sync, then recovers
- `composition.spec.ts:565` restores the caret after a delayed browser selection jump following composition
- `delete-shapes.spec.ts:319` deleteSoftLineBackward removes to the soft-line start
- `input.spec.ts:1664` replaces a cross-block browser selection when typing a single character
- `input.spec.ts:1742` replaces a cross-block range that starts in an empty placeholder block
- `input.spec.ts:2479` handles cross-block replacement beforeinput through the model
- `input.spec.ts:3099` pastes multiline text over a live browser selection
- `selection.spec.ts:1362` maps Shift-click range extension across marked text and inline atoms

Gate: a checkpoint may not add a chromium failure outside this list. Fixes to listed specs are recorded.

## Maintainer decisions (§11.2)

The plan's proposed answers are adopted, with these explicit calls:
- Option B (compare-to-truth observer) replaces the render bracket; the vendored engine is an owned fork (plan revision 2).
- D-24: G-a (retire the unexported HTML import plugin) taken; G-e taken; G-d only after a browser check;
  G-b **not taken** (field v13 data cannot be ruled out from the repo); G-c evaluated under the fork.
- D-15 (API retirement) taken as proposed.

## Execution deviations from the plan

- §8 rows are written at the checkpoint that gates them ("Tests first" column), not all at G0.
  G0 writes the infrastructure and the rows gated at G0.

## Checkpoints

| CP | Commit(s) | xloc before → after (Δ, plan Δ) | Lanes | Notes |
|---|---|---|---|---|
| G0 | tag `arch-v2/ref-g0` = 60cbdab; 97bac98 (tests first), 07b43ca (census), 69b0217 (deletions), ledger commit | 29,109 → 28,884 (**−225**, plan −290: 22 % short, inside rule 7's 30 %) | `vitest --run` 125 files, 1962 passed, 3 skipped, 11 todo · `test:dom` 21 files, 346 passed, 33 skipped · `test:crdt` 102 files, 1877 passed, 9 skipped · `check` 0/0 · `lint` clean · chromium: not run here (orchestrator) | Frozen counter `scripts/xloc.mjs` sha256 `c15490d2dc016a2c352f32c8cd5df3b3b890b2262106376b12b010b551bceaf3`. Census `pnpm census` (`scripts/census.mjs`, spawns the frozen counter): vendor xloc 7,125 (G0 reference, Δ 0); type-body 827 → 822; mechanisms at exit (= at ref): setTimeout 45, rAF 8, `await tick()` 30, `flushMirror(` 18, `stopCapturing()` 20, `instanceof PreventionError` 7, `ignoreNextSelectionChange` writes 21, `new MutationObserver` 4, `flushSync(` 0. **Moved to `src/tests/oracles`**: `computeAllRuns`+`mergeRuns` (+`sameMarks`), `blockRecordsOf`+`BlockRecord` (also dropped from the `./crdt/edytor` barrel; the DOM test route and collab DST runner import the test copy); `diffSnaps` **copied** (production copy stays to D9, kept runnable by `arch-v2/oracle-diff-snaps.test.ts`). **Deleted (L61)**: `utils/jsx.ts`, `getBlockByIdOrContent`, `remoteOnlyTransaction`/`REMOTE_ONLY_TRANSACTION`, `initialized`, `remotePresenceRevision`/`refreshRemotePresence` + its awareness subscription, `Block.renderVersion`, `Block.#depth`, placement `contentOf`/`slicesNodeOf`/`appendItems`, the unconditional `__EDYTOR_SEL_LOG__` push (the `__EDYTOR_SEL_DEBUG__`-gated echo log and opt-in `__selDrift` probes remain; L61 does not name them). **§8 at G0**: F-U5 in `src/tests/crdt/arch-v2/f-u5-undo-actor-local.test.ts` (3 client-id assignments × B saw/did not see the delete × edit-before/after-undo at A, duplicate delivery, binary reload, observer over all 6 permutations) — green as the plan predicts. **Deferred**: cdp lane harness → V4/I3 (first cdp-gated rows); F-O1…F-O12 spies → their gating checkpoints (recorded deviation). **Test expectation changed**: `gate3/app-context` listener probe expects 0 view-held awareness listeners (was 5, one dead subscription per view). **Shortfall vs −290**: `diffSnaps` (81) stays until D9 by the plan's own row, which the −290 figure appears to include. **Ledger fix**: the baseline table swapped the `test:dom` and `test:crdt` counts — at a7337c5 `test:dom` is 21 files/346 passed and `test:crdt` 100 files/1864 passed. |
| D1 | tag `arch-v2/ref-d1` = d8966d0; 2bc3112 (tests first), fe668a9 (implementation), ledger commit | 28,884 → 28,841 (**−43**, plan −25) | `vitest --run` 126 files, 2048 passed, 3 skipped, 11 todo · `test:dom` 21 files, 346 passed, 33 skipped · `test:crdt` 103 files, 1963 passed, 9 skipped · `check` 0/0 · `lint` clean · chromium: not run here (orchestrator) | **Rows** (`src/tests/crdt/arch-v2/d1-delete-marks.test.ts`, 86 tests, doc + view lanes; view path = `Edytor` mounted headlessly on an attached document): F-D3, F-D8, F-D9, F-D10, F-D17, F-D18, F-D20, each delete row on the view, facade and handle paths; multi-replica rows run 3 client-id assignments × both delivery orders × duplicate delivery × binary reload × every observer permutation. Red on the reference exactly as the plan predicted (F-D3, F-D8, F-D10 except view-after-Q, F-D17 view, F-D18 when A > P, F-D20 view delete; F-D9 green); all green after. **Deleted**: L9 (view tombstoning in `removeBlock`; split type/data copy-then-reset → `SplitTail` decided once by the split), liveness part of L13 (`isVisible`, facade `isVisibleBlock` ancestor walk, `isVisibleId`, `liveNodeOf` op preludes, `mustEscalate` re-derivation, `Edytor.isVisibleBlockId`). 162+/205− production lines. **Census**: mechanism counts unchanged (none claimed); type-body 822 → 822; vendor Δ 0. **Deviations**: (1) R3 on slice records needed one change in the existing ownership decider: a deleted holder's records keep contesting their window and hide what they win (`gatherClaims` no longer skips dead holders; `sweepOwnership` drops dead-won spans). Without it, removing the view tombstoning regresses the pinned head-typed seam case; with it F-D10 passes on every path and replica at D1 (the plan put the concurrent half at D12 / its fallback's "ownership resolution"). D12 re-proves F-D10 under streams. (2) `liveNodeOf` stays as the deleted-vs-hidden accessor (§6 D11; two scenario tests read it), documented as not a liveness answer. (3) The facade keeps the public name `isVisibleBlock` (now `M.isLive`); renaming is API retirement (D-15/C1). (4) `childrenOf`/`childrenIndex` keep an unused `blocks` parameter — left for D2, which owns the children/order index. **Tests changed under D-14**: random-corpus oracle (deleteBlock envelope includes the holders routing to the target; `dead-owner` coverage = dead-held records; per-writer mark stamps), dense ownership oracle (dead holders contest), gateF1 wu1/wu3a + gateF2 wu6-delete-range + ownership-regression (pre-D1 "deleted holder releases coverage" staging now removes the registry entry), wu6-interval-fuzz (refills a drained document: merge-then-delete no longer resurrects and deleting a dead id is refused — it used to count as applied). **Behavior notes**: deleting a non-live block (already deleted, merged away, or under a deleted parent) now returns `false` (was `true` for an already-deleted block); `blockText` of a block under a deleted parent is `null`. **Open**: pre-D1 documents carrying the old single `del` key are not read as deleted (no generation bump until D12) — see contract question in the D1 report. |

## Orchestrator notes

- **G0 chromium**: 482 passed, 10 failed = the 9 known-red + `inline-atomic.spec.ts:1025` (deletes a native-selected
  inline mention without beforeinput). It passed 3/3 in isolation and its file passed 19/19: a flake under full-suite
  load, not a regression. Failures outside the known-red list are re-run in isolation before a verdict.
- **D1 chromium**: 483 passed, 9 failed = exactly the known-red list.
- **D1 contract answers** (orchestrator, from the plan):
  1. No legacy reader for the pre-D1 single `del` key. v14 documents exist only in development (plan §2.1). When the
     transport branch merges, the schema stamp is bumped so a pre-D1 document is refused cleanly by the generation
     gate instead of being misread with its deleted blocks visible.
  2. Deleting a non-live block returns `false` and `blockText` under a deleted parent is `null`: accepted as the
     one-liveness-answer rule; listed for the C1 release notes as an API change.
