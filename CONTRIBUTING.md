# Contributing to edytor

Thank you for helping. Edytor is a block editor engine (a Svelte 5 view on a vendored Yjs v14
document) with a Cloudflare Durable Object room. Before you change code, read
[`AGENTS.md`](AGENTS.md): it names the owner of every fact ("one owner per fact"), where to fix
what, and the contracts the tests cite. Most bugs that look random come from fixing a behaviour
in the wrong layer.

## Set up

Node 22 or newer (CI uses Node 24) and pnpm 10.

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium   # for the browser lanes; add firefox webkit for all of them
pnpm dev                                # the demo route on http://localhost:5173
```

## The lanes

CI runs the first two groups on every push (`.github/workflows/ci.yml`). Run the ones your
change touches before you open a pull request; CI runs them all.

**Static checks** (every push):

```bash
pnpm check                 # svelte-check, 0 errors and 0 warnings
pnpm lint                  # prettier and eslint (the Worker-safe boundary, the host writers)
pnpm check:worker          # Worker bundles of src/lib/crdt and src/lib/cloudflare
pnpm check:docs            # type-checks the site's doc examples marked `check`
pnpm test:typecheck
pnpm test:dom:typecheck
pnpm test:do:typecheck
```

**Test lanes** (every push):

```bash
pnpm exec vitest --run     # unit and model fixtures (the JSX fixture DSL is src/tests/jsx)
pnpm test:crdt             # engine, facade, sync, migration
pnpm test:dom              # editors mounted in jsdom (a Svelte dev warning fails the test)
pnpm test:do               # the edytor/cloudflare room in workerd
```

After `pnpm test:crdt`, restore `src/tests/crdt/random/failures/seed-37.json` and `seed-59.json`
(`git checkout -- src/tests/crdt/random/failures`) and delete any stray `seed-*.doc.json`.

**Browser lanes** (Chromium on every pull request, sharded in four; the rest nightly in
`.github/workflows/nightly.yml`):

```bash
pnpm test:integration --project=chromium
pnpm test:integration --project=firefox
pnpm test:integration --project=webkit
pnpm test:integration --project=mobile-chromium
pnpm test:integration --project=mobile-webkit
pnpm test:cdp              # Chromium through the DevTools IME path
pnpm test:dst              # the editor-input corpus: solo in three engines, collab in Chromium
```

Real browser behaviour (selection, IME, Android drift) is proven only in these lanes; the jsdom
rows are necessary, not sufficient.

**Release lanes** (the maintainer runs them before a release; not in CI):

```bash
pnpm test:hosted --project=chromium   # real browsers through the room in Miniflare (ports 4195/4196)
tests/packed-consumer/run.sh          # the packed tarball: node, Worker, Svelte build, strict tsc
pnpm bench:crdt                       # engine and facade timings, the scale workload included
```

### Ports

The Playwright lanes serve the app on a port of their own: `PW_PORT` (default 4173) for
`playwright.config.ts` and `DST_PORT` (default 4183) for `playwright.dst.config.ts`. Set them when
several checkouts or worktrees run lanes side by side, for example
`PW_PORT=4310 pnpm test:integration --project=chromium`.

## Timings are not gates

The gate lanes assert operation counts, never the wall clock (CC-05). A test that needs to say
"this stays fast" counts the work the index does: `facade.runsView.debug` gives its fold passes
(`folds`), their input (`foldedPairs`, `foldedStructs`), the blocks it recomputed
(`recomputes`) and the items range reads walked (`itemsWalked`), and the row states a scaling
contract, for example "ten times the blocks, the same recomputes and at most eleven times the
fold input" (`src/tests/crdt/arch-v2/d6-range-delete.test.ts`, `p1-scale.test.ts`,
`src/tests/fixtures/dom/arch-v2-r3-ops.test.tsx`, `src/tests/crdt/range-cursor.test.ts`).
Counts are the same on a laptop and on a loaded shared runner.

Absolute timings belong to the benches: `pnpm bench:scale` measures the operations those rows
count (and lists any timing past the bound the rows held before), and `pnpm bench:crdt` stores it
with the rest under `bench/results/`. The counts see only the index's work. Remote admission
(`applyRemote`'s checks), the engine's integration, the undo manager, document construction and
encode/load are not counted by any gate row: their scaling with the document or its history is
checked only by `pnpm bench:scale`, which reports and fails nothing (a follow-up in the
production plan, WU-09). A browser row may measure a time and report it as a test
annotation (`tests/editor-dom/r3-ops.spec.ts`), never assert it.

A row waits for the fact it needs, never for a delay or a count that only usually holds: in the
room lane `vi.waitFor` defaults to 10 s (`tests/do/setup.ts`), a seeded `RawClient` waits for
`stored()` (the room acknowledges a client's Step1 before it stored anything of it), and a
"never relayed" row counts `syncFrames()`; a Playwright row waits until the model holds the caret
its click placed before it presses a key (a known residual, `sel.key.before-adoption` in
`docs/editor-delete-contract.md`: a key handled at keydown before the click's `selectionchange`
acts on the caret before it).

Never add `performance.now()` with `toBeLessThan` to a gate lane, nor a retry to hide a flake
(`src/tests/ci-gates.test.ts` fails on either, and keeps the workflows and this page in step). A
flaky row is a bug in the row or the code: fix its cause (a trace that recorded the wall clock,
for example), or, while it is being fixed, mark it `it.skip` with a comment that names the issue.

## Pull request checklist

Copy this into the pull request description:

- [ ] Contract row or test written first and seen red
- [ ] Fix in the owner named by AGENTS.md (no second writer, flag, timer or retry)
- [ ] Lanes: `check`, `lint`, `check:worker` (when `crdt` or `cloudflare` was touched),
      `check:docs`, unit, `test:crdt`, `test:dom`, `test:do` (room), Playwright in three engines
      (view), DST (input)
- [ ] Site docs updated, and a user-facing note under `### Unreleased` in `reference/migration.mdx` (the changelog: no ticket ids or file paths); `docs-drift` passes
- [ ] Version bumped and appended to `served-versions.txt` when the packed code changes
- [ ] Scores re-checked on the dimension touched (focused review: only what the unit changed)

Expected values in tests come from the contracts (`docs/editor-delete-contract.md`, the site's
behaviour tables) or from Notion's behaviour, never from running the code under test. Public API
and behaviour changes update the page that documents them in `site/content/docs` and
`reference/migration.mdx` in the same change.

## CI and branch protection

`ci.yml` runs on every push and pull request. Its last job needs every lane and fails when one
failed or was cancelled. In a pull request run it is named **`CI passed`**, the one check to
require; in every other run it carries its event (`CI passed (push)`, `CI passed
(workflow_dispatch)`), because those runs skip the Chromium lane unless asked (`browsers`, a
boolean input of a manual run and of a `workflow_call`). A branch with an open pull request
therefore runs the gate lanes twice per commit (its push run and its pull request run); only the
pull request run decides the merge. When several runs report the same check name GitHub keeps the
newest, so the push run must never report the required name.

Branch protection is a repository setting. **It is not applied yet**: until a maintainer creates
the ruleset below, nothing stops a direct push to `master`, so run the lanes before pushing. The
ruleset (Settings → Rules → Rulesets → New branch ruleset):

- **Name**: `master`; **Enforcement status**: Active.
- **Target branches**: Include default branch (`master`).
- **Restrict deletions** and **Block force pushes**: on.
- **Require a pull request before merging**: on (0 required approvals while there is one
  maintainer).
- **Require status checks to pass**: on, with **Require branches to be up to date before
  merging**; add the check **`CI passed`** (source: GitHub Actions).
- **Bypass list**: empty, so a release goes through a pull request too. (With the classic
  "Branch protection rules" page, the same settings are "Require a pull request before merging",
  "Require status checks to pass before merging" with `CI passed`, "Require branches to be up to
  date before merging" and "Do not allow bypassing the above settings".)

`publish.yml` runs on a `v*` tag: it calls `ci.yml` on the tagged commit with the Chromium lane
and publishes to npm only when it passed. `nightly.yml` runs Firefox, WebKit, the mobile
projects, CDP and DST every night on `master`; a red night is an issue to fix, not a gate.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
