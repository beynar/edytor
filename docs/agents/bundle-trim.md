# Trimming the bundle

How to make edytor's shipped JavaScript smaller without changing what it does. [AGENTS.md](../../AGENTS.md) is the overview; this file holds the method, the rules and the step-by-step procedure. Read it before any work whose goal is size, and before a feature lands: a feature's cost is part of its acceptance.

## The thesis

The code is there for a reason. The bytes do not come from dead code. They come from behaviour expressed too heavily, the result of organic growth:

- one idea written in several shapes, in several places;
- a check repeated at every layer instead of once at the boundary;
- special cases that a general rule, or a table, would cover;
- guards for states that cannot happen;
- each module building its own copy of a helper that should be shared;
- a layer edytor builds on top of the vendored Yjs fork, where the engine could hold the fact itself.

So the question is never "is this function duplicated?" (that search finds nothing and concludes "it is behaviour"). It is: **who should state this fact once, so that the others stop restating it?** Modules are not isolated. A module may grow by a few hundred bytes to hand the others a fact, a shape or a helper that lets them cut a lot.

## Rules

Allowed:

- raw reduction: delete, merge, share, rewrite smaller;
- any two ways of doing or expressing the same thing become one;
- moving a mechanism into the fork (`src/lib/crdt/vendor/yjs/`, a new `YP` patch in its `UPSTREAM.md`) so edytor's layer over it disappears;
- breaking API changes, with their Breaking note in the changelog;
- dropping old stored data (bump the schema generation and refuse the old one, never convert).

Never:

- code splitting, lazy loading, dynamic `import()`, or making a built-in capability opt-in;
- renaming or minification tricks;
- a behaviour change made alone: a cut that would change behaviour is listed, measured, and decided by the user;
- weakening a test so a cut passes;
- merging a change that misses its size target: a miss stops the merge and goes back to the user.

## What history taught

| Approach                                                                                          | Result                                                     | Lesson                                                                  |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| Duplicate-function passes over the whole bundle                                                   | −2.4 KB, then −0.4 KB                                      | The wrong question: every function has a reason to exist                |
| Moving text deletes into the fork (YP20)                                                          | −10.3 KB of edytor's layer, +2.6 KB of engine: −6.8 KB net | Engine-first works when edytor re-implements what the engine could know |
| One placement resolution instead of two (first read and incremental)                              | −1.4 KB                                                    | Two shapes of one rule is the commonest pattern                         |
| One walk over a sequence's units instead of five                                                  | −1.1 KB                                                    | Same walk, written per caller                                           |
| A move record reusing the hold record's range writer and reader                                   | −0.8 KB                                                    | Two engine records of the same shape share one codec                    |
| One "is this a nested editable?" rule (`editableBoundary`) for the chrome press and `selectstart` | a bug fixed, not only bytes                                | Two owners of one fact disagree sooner or later                         |
| One `ownsPress` rule asked by every press handler                                                 | a flicker fixed                                            | A check at each level instead of once at the boundary                   |
| Estimates written before measuring                                                                | off by 2× to 5×, both ways                                 | Measure; never decide on an estimate                                    |
| A feature merged at +17 KB after a failed cut                                                     | refused by the user                                        | The size target is a gate, not a note                                   |
| Shared suggestions as a plugin (the user lifted "never opt-in" for this feature)                  | bare `<Edytor />` +13.4 KB → +1.0 KB (0.4 KB of it engine) | A feature most apps skip belongs in a plugin, behind generic ports      |

## Tools

- `node scripts/bundle-size.mjs` builds the probes and reports edytor's own bytes (the Svelte runtime excluded). `--only minimal,all,export` picks probes (`minimal` is `<Edytor />` alone, `all` every plugin, `export` and `export-*` the `edytor/export` entry and each function of it); `--top 600` lists files; `--by dir` groups; `--json out.json` writes the numbers; `--no-package` reuses the current `dist/`; `--cache <dir>` builds the probes there instead of `node_modules/.cache/bundle-size`.
- **Attribution by function: `pnpm bundle:attribution`** (`scripts/bundle-attribution.mjs`, after a `bundle-size.mjs` run that built the probe). The probe builds keep their source maps (`node_modules/.cache/bundle-size/*/out/assets/*.map`): the script attributes every minified byte to its source position through the map, then to the declaration around it in the packaged `dist/` file (a top-level function, class or constant, and `--depth` levels inside: methods, class fields, an object's properties, a function's own declarations; a `.svelte` file's `<script module>`, `<script>`, top-level snippets and `(template)`). Each row is `file › declaration › …` with its minified bytes and its gzip share (the row's code gzipped alone, scaled so the bundle's sources sum to its gzip: an estimate). Arguments filter sources by substring (`pnpm bundle:attribution crdt/doc/ session/`); `--files` gives one row per file, `--top 40` the largest rows, `--min 50` hides smaller ones, `--sort name` lists in source order, `--json out.json` writes every row, `--app all` reads another probe, `--cache <dir>` another cache, and `--against <dir>` diffs with a second cache (a copy of the cache taken before the change: each declaration's bytes before and after). Every pass uses this script, so its numbers compare.
- **Measuring a change.** Before and after, on the same machine, with the same command; report minified and gzip bytes for `minimal`, `all` and `export`. In an exported copy of the repository (`git archive … | tar -x`, `node_modules` linked), give both scripts their own cache directory inside the copy (`--cache`): the linked `node_modules/.cache` is the main checkout's.

## Step by step

### 0. Set the target

State the budget before any work: the number of KB the bare `<Edytor />` (the `minimal` probe) may weigh after the pass, or the most a feature may add. Write it in the plan and in the PR. Without a number there is nothing to stop at.

### 1. Baseline

Run `node scripts/bundle-size.mjs --only minimal,all,export` on the starting commit and record the numbers (minified and gzip, edytor's own). Every later number is against this baseline.

### 2. Attribution table

Attribute the `minimal` probe's bytes by function (see Tools). Sort by size. The top functions and the top files are where the plan looks first; anything under 100 bytes is noise unless it repeats.

### 3. Fact map

For the area being trimmed, list each fact or derived value it produces or uses, in one table:

| Fact                | Computed by (shape)                   | Consumed by                         | Re-derived, converted or re-checked where                                               |
| ------------------- | ------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| the caret           | the selection value `{block, offset}` | navigation, commands, the projector | a segment and offset in the input path, a DOM point in the observer, anchors in history |
| may this view write | the dispatcher's `permits`            | every command                       | each command again, the bindings, the chrome                                            |

Typical facts in edytor: the caret and the selection in their shapes (value, projection, text range, `{block, offset}`, segment and offset, DOM point, anchors); block, text and node lookups; display order and display parent; visibility; a kind's roles; DOM ↔ model points and ranges; permission and readonly checks; the index's records and their rebuild paths; ids and their records and engine items.

### 4. Hunt the patterns

Go through the fact map and the attribution table with this list. Name the pattern on every finding.

1. **One idea, several shapes.** The same fact kept or converted in several representations. Pick one shape at the producer; consumers read it.
2. **A check at every layer.** The same guard in the caller, the callee and the callee's callee. Keep it once, at the boundary that owns it (the dispatcher for permissions, the classifier for events, the index for liveness).
3. **Special cases a rule covers.** Branches per kind, per key or per operation that differ only in data. Replace them with one rule over a table.
4. **Guards for impossible states.** Defensive branches for values the types or the owner already exclude. Delete them; if a test needs them, the test is checking the wrong owner.
5. **Private copies of a shared helper.** The same small function (a walk, a compare, a lookup, a set of sets) written per module. One helper, in the leaf or the owner.
6. **A walk written per caller.** Several functions or folds walking the same items, structs or blocks for slightly different answers. One walk that yields what they all need.
7. **Edytor computing what the engine could hold.** A layer over Yjs maintaining per-item facts the engine could keep natively (as YP20 does for deletes and YP22 for moves). Engine-first: change the fork, and the layer disappears.
8. **A missing provider.** Many consumers re-deriving a fact from raw data that one module already had in hand. The producer exposes it (it may grow); the consumers shrink.

### 5. Account for each opportunity

One row per opportunity, measured from the attribution table:

| Opportunity | Pattern | Producer (+bytes) | Consumers (−bytes) | Net | Risk |
| ----------- | ------- | ----------------- | ------------------ | --- | ---- |

A producer may grow when its consumers shrink more. Rank by net, then by risk.

### 6. Prototype the biggest

Prototype the top two or three in an exported copy of the repository, never in a checkout someone else works in. Measure them with the bundle script and run the tests that cover them (by file name, not whole lanes). An opportunity whose prototype does not save what its row said is re-estimated or dropped.

### 7. Plan, and the user's review

Write the plan in `docs/archive/<pass>/design.md`: the baseline, the attribution table, the fact map, the ranked opportunities with their measured or prototyped numbers, the modules to rewrite and the behaviour changes it would take to go further, each with its measured saving. The user decides the behaviour changes; nothing that changes behaviour is built before that.

### 8. Implement: providers first, then a rewrite to budget

1. Land the providers: the facts, shapes and helpers others will read.
2. Then rewrite each consumer module to a budget: **−30 % of its bytes**, with the existing tests as the only spec and no behaviour change. Rewriting to a number forces each rule to be stated once, in the right place; asking "what can be removed?" does not.
3. Engine moves follow the fork's rules: a new `YP` patch recorded in `UPSTREAM.md`, Worker-safe code, engine privates through `crdt/structs.ts`, and a schema generation bump if the stored format changes.
4. When code is removed, its copies in `src/tests/` and `tests/` go in the same change: tests run the real implementation.

### 9. One cut per commit

Each cut is its own commit, measured before and after, and its message says the pattern it removed and its bytes ("one walk over the sequence's units instead of five: −1,102 B min, −380 B gzip"). A cut is kept only when its net is below zero. Revert a cut that saves under 0.3 KB or that needs a test weakened, and say why.

### 10. Verify

Per cut, the fast loop only: `pnpm check`, `pnpm lint`, `pnpm check:deps`, the affected unit and `test:dom` files by name, and the related Playwright spec in Chromium (`pnpm check:worker` too when `src/lib/crdt` or the room changes). Once per pull request, and only when the engine, the CRDT layer, the providers or the room changed: `pnpm test:crdt` whole, the wide corpus (`CRDT_SEEDS=1-1000 CRDT_OPS=300`), `pnpm test:do` and `pnpm check:api`. CI and the nightly run the rest (Chromium shards, Firefox, WebKit, mobile, cdp, DST). No benchmark unless the pass is about speed.

### 11. Hold the gain

A size budget in CI: the `minimal` probe's bytes may not grow past the budget the last pass reached, so a pull request that adds bytes fails until it pays for them or the user raises the budget. A feature brief states its own budget; a missed budget stops the merge.

### 12. Report

The report a pass ends with:

- the baseline and the result for `minimal`, `all` and `export`, minified and gzip;
- each cut: its pattern, its bytes, kept or reverted and why;
- the behaviour changes not made, with their measured savings, for the user;
- the verification run and what was left to CI;
- the pull request.
