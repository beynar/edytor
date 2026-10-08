# Architecture v2 planning artifacts (2026-09-26)

Produced by a 15-agent workflow (Opus 5.5, max effort) that was forbidden from reading
prior architecture opinions in `docs/` (rewrite plan, elegance/adversarial reviews,
proposals, handoffs). Inputs were the source, the tests, the behavior contracts and
ADRs, and browser/engine facts only.

- `plan.md` — the final plan (12 sections: rules, representations, ownership, module map,
  deletion ledger, distinctions, LOC table, falsification tests, 44-checkpoint migration,
  extension cost, risks + 24 maintainer decisions, review disposition).
- `plan-v1-pre-review.md` — the synthesized plan before the adversarial pass, kept for diffing.
- `readers/` — six domain analyses (selection, input-events, runtime-model, crdt-core,
  sync-collab, plugins-ui): required behavior, fact→owner→lifetime tables, machinery
  inventory, floors. They also contain reproduced bugs found by probes.
- `proposals/` — three independent architectures (representation-first, ownership-first,
  deletion-first) that were judged and merged.
- `adversarial-review/` — four attack lenses (feature parity, LOC honesty, CRDT constraints,
  browser input): 50 findings, all accepted into `plan.md` §12.

LOC metric: `node scripts/xloc.mjs src/lib --dirs` (execution lines: no blank, comment or
type-only lines; vendored Yjs excluded). Baseline 29,099 at d9b7de0 + working tree.
