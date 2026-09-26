# Architecture v2 execution ledger

Branch `arch-v2` in worktree `/Users/arnaud/code/edytor-arch-v2`, based on commit `a7337c5`
(snapshot of `feat/crdt-v14-engine` = d9b7de0 + its uncommitted working tree on 2026-09-26).
The plan is `docs/architecture-v2/plan.md`; its §9 defines the checkpoints and discipline.

## Baseline (a7337c5)

| Lane | Result |
|---|---|
| `pnpm exec vitest --run` | 123 files, 1949 passed, 3 skipped, 11 todo |
| `pnpm test:dom` | 100 files, 1864 passed, 9 skipped |
| `pnpm test:crdt` | 21 files, 346 passed, 33 skipped |
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
