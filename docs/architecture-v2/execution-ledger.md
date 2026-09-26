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
| chromium integration | see below |
| xloc (`node scripts/xloc.mjs src/lib`) | 29,109 |

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
