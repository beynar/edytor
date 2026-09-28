# arch-v2 phase 2: finish, polish, and reduce further without deleting features

## Context

`arch-v2` completed the 44-checkpoint rewrite: 29,109 → 19,409 execution LOC in `src/lib` (−33.3%), plus the vendored Yjs fork (7,152). Browser failures dropped from 28 to 6, DST is 68/68, and the real-IME lane is 40/40. A competing branch (`bey-native-foundation-prototype`) reached 7,986 LOC by replacing Yjs and dropping features. The review found that its merges are not total (clients block and lose offline edits), that selection races revert newer moves, that there is no DOM repair, and that features are missing. Its engine is not worth taking, but several of its ideas are.

The goal now is to finish the open items, harden the result, and cut further **without deleting any feature**. Every gain below is either genuine simplification (one owner, less code), shipped-code reduction (the vendored engine counts toward package size), or test infrastructure that prevents regressions.

Measured inputs:
- the gems exploration of the native branch;
- the vendored-engine reach analysis;
- the arch-v2 leftover audit (HEAD 96c87f0).

## Gems taken from the native branch

| Gem | What we take | Effect |
|---|---|---|
| Real Cloudflare runtime tests | Cloudflare vitest pool lane for the room, Miniflare-hosted Playwright lane (3 browsers over real WebSockets), Worker smoke in the packed consumer (their `vitest.native-workers.config.ts`, `tests/native/hosted/{start.mjs,worker.ts}`, `tests/packed-consumer/smoke-native-worker.mjs`) | Proves the DO path for real instead of a Node fake; test-only |
| Marks and kinds declared by tag | One `tag` on mark records drives rendering, HTML export and import; seven identical mark snippets collapse into one core `<svelte:element>` | ≈ −35; fixes bold rendering `<b>` but exporting `<strong>` |
| HTML import via `DOMParser` | Parse into the existing `Flow` (D7 `prepare.insertFlow`); tag tables come from inverting kind/mark records, not a hard-coded switch | Restores the feature D8/G-a retired, at ≈ +130 instead of the 1,332 it used to cost |
| One DOM→model point mapper | Range-measured offset (their `#point`) as the only DOM→model mapper; keep the filler, trailing-newline, converted-space and outside-point rules | ≈ −60 across `getYIndex`, `domTextOffset.ts`, `findDomPoint` |
| Durable Object room as a package export | Promote the proof coordinator (`src/tests/crdt/arch-v2/do-coordinator.test.ts`) to `edytor/cloudflare` with their auth pattern: authorize before upgrade, strip client identity headers, bind the verified user + replica to the socket, and refuse updates whose struct `client` ids aren't that socket's | Adds the room you will deploy, ≈ +250; closes attribution spoofing |
| Store-before-ack signal + bounded catch-up | After persisting, the room replies with its state vector (client knows what is saved); large Step2 split into start/part/end frames applied only when complete (32 MiB frame limit) | ≈ +55 |
| Contract-program adapter | Their engine-agnostic peer programs (`src/tests/native/contracts/{adapter,programs}.ts`) pointed at our facade | Independent cross-check; test-only |
| Their adversarial probes | The fuzz, room-sim and browser probes written against their branch (`review-probes/`) re-targeted at arch-v2 | Confirms arch-v2 doesn't share their failures (F-S11 races, DOM repair, IME undo caret) |

Not taken (they are feature drops): the single 1,642-line view class that remounts over browser input; the outbox/blocked client and localStorage journal; chrome inside block shells; hard-coded tag switches; the custom-MIME-only clipboard; per-block `role=textbox` hosts; full-history replay.

## Plan

Same discipline as phase 1 (plan §9.1): tests first, one owner per fact, no new timers, the same frozen counter (`scripts/xloc.mjs`, sha c15490d2…), every lane green before a checkpoint closes, results in `docs/architecture-v2/execution-ledger.md`.

### P1. Finish and harden (tests first, no production LOC target)
1. **Port the review probes to arch-v2.** Re-target the fuzz campaign (3–5 replicas, random delivery, offline churn), the room simulation and the browser probes (IME undo caret, selection races under remote traffic, foreign DOM mutation, word delete over atoms, select-all per engine) as permanent rows in `src/tests/crdt/arch-v2/` and `tests/editor-dom/`. Anything red becomes a bug to fix in its owner.
2. **The two known reds:** `composition.spec.ts:563` (caret after a delayed jump that the spec marks as a user gesture; V5's classifier adopts it) and `delete-shapes.spec.ts:319` (deleteSoftLineBackward). Fix, or re-pin with a contract row that says why the spec's expectation is wrong.
3. **Real-runtime lanes** (gem 1) and the contract-program adapter (gem 7).
4. **Open follow-ups:**
   - Check the paste-subtree bench regression (1.33 vs 0.82 ms) on a quiet machine.
   - Find the unnamed `test:crdt` row that failed once under load.
   - Refresh the stale `bench/lib/mk-baseline.sh`.

### P2. Delete leftovers and duplicated decisions in `src/lib` (≈ −400 to −600, no behavior change)
Ordered low-risk first, each a small checkpoint:
1. **Dead code** (≈ −55):
   - `domSelectionCoversRange`, `domSelection.ts:137-141`;
   - `replaceSelection.ts:117-127`;
   - `structs.ts` `clockOf`/`deletedLen`;
   - `constants.ts` `UndoTracker`;
   - `legacy-schema.ts:45`;
   - `block.utils.ts:97-99` (a key no op uses);
   - test-only production helpers (`idToText`, `blocksBetween`, `postCompositionGuardSwallows`, `compareRank`, `initialRank`).
2. **Synchronous setters** (≈ −30 plus plumbing): `setAtTextOffset`/`setAtRange`/`setAtTextsRange`/`setAtBlockRange` are `async` but never await. Make them synchronous, fold `replaceSelectionWithCollapsedTarget` into its `…Sync` twin, and de-async the 31 call sites.
3. **Tick chains** (≈ −35, census −9 `await tick()`): the select-after-tick chains in `onBeforeInput.ts`, `beforeInputCommands.ts`, `beforeInputDeleteCommands.ts`, `onInput.ts`, `observer.svelte.ts:900` and `edytor.svelte.ts:846`. The projector already displays the current value after the flush. Each site is pinned by a browser or mobile spec, so do one site per commit.
4. **One DOM→model point mapper** (gem 4, ≈ −60): `getYIndex` built on `domTextOffset`, and `remoteSelection.findDomPoint` → `projector.domPointOf`.
5. **One selection read** (≈ −150): migrate the 27 production readers of the `selection.state` compatibility getter to `projection`, then delete `#compatState` and the extra fields. Merge the two setter families (`setRangeStateAtTextOffsets`/`setCollapsedStateAtTextOffset` into `setAtRange`/`setAtTextOffset`). The public `selection.state` getter stays as a thin view if consumers read it (README), otherwise it's a K5 note.
6. **Small duplicate facts** (≈ −100):
   - one JSON equality in `utils/json.ts`;
   - one `isRecord`;
   - one `sameIds`;
   - `getRootSelection` → `getDomSelection`;
   - cut = copy + delete;
   - one overlay mount helper for slash/toolbar;
   - drop the redundant clipboard clones;
   - a leaner fragment decode (gem 8).
7. **Marks by tag** (gem 2, ≈ −35).
8. **Cells from the index's frozen records** (gem, ≈ −55): the index already emits frozen per-block runs with identity; `cells.apply` becomes "set the ids the report names". Keep the K7 added-subtree rule and the observer's `before` map.
9. **Review `edytor.svelte.ts` `attach()`** (≈300 lines of focus and pointer rules): move each rule to its owner (surface events, projector focus verdict, pointer). Count only what disappears.
10. **Timer census:** remove the two native-arrow re-sync timers in `onKeyDown.ts:155-202` if V5's classifier already covers them, proven per engine. The five named browser rules stay.

### P3. Shrink the shipped engine (owned fork)
1. **Named imports instead of the namespace** (no source deletion): `src/lib/crdt/engine.js` does `import * as Y` and `EngineApi = typeof Y`, so nothing tree-shakes. Replace it with a named-import object of the ~25 symbols edytor uses. That shrinks the engine in every consumer bundle by about 22% (107.6 → 84.4 KB minified), with no feature change.
2. **Prune the fork** (≈ −1,280 vendored xloc, decision D1):
   - Delete whole files: `Renderer.js` 400 and patch P6, `position-helpers.js` 156, `Snapshot.js` 93, `delta-helpers.js` 22, `logging.js` 10.
   - Trim unused exports from `updates.js`, `ids.js`, `meta.js` and `RelativePosition.js`.
   - P4, P5 and P7 land in code that stays.
   - The vendored upstream suite must be rewritten to the surface we keep: its `testHelper.js` uses snapshots and V2 updates.
   - Regenerate `dts/` with `scripts/regen-crdt-vendor-types.sh`.
   - Record the pruning as patch P8 in `UPSTREAM.md`.

### P4. Restore features cut in phase 1 (your rule: no feature deletion)
1. **HTML import via DOMParser** (gem 3, ≈ +130): tag tables from records; lands on the `flow.*` contract rows. Restore `paste-html` browser rows.
2. **Websocket BroadcastChannel leg** (G-e retired it, decision D2): restore cross-tab sync for websocket-only tabs, or keep it retired because IndexedDB covers cross-tab.

### P5. Go further for the Durable Object deployment (adds code, adds the feature you need)
1. `edytor/cloudflare` export: the Yjs-based room with auth binding and client-id enforcement (gem 5).
2. Store-before-ack signal and bounded catch-up (gem 6).
3. Hosted Playwright lane through the real room (gem 1).

## Expected result

| Scope | Now | After P2 + P3 | After P4 + P5 (features added back or added) |
|---|---:|---:|---:|
| `src/lib` execution LOC | 19,409 | ≈ 18,800–19,000 (−35%) | ≈ 19,150–19,400 |
| Vendored engine xloc | 7,152 | ≈ 5,870 (with D1) | ≈ 5,870 |
| Engine in consumer bundle (min) | 107.6 KB | ≈ 84 KB | ≈ 84 KB |

Honest statement: without deleting features, the no-feature-loss path lands around −35% on the phase-1 metric. The 40% line needs either feature removal or the "moved out of the library" accounting, which the method says not to count. P4/P5 add code on purpose: HTML import and the server room are features.

## Decisions (defaults in bold)

- **D1 — Prune the Yjs fork (P3.2).** **Yes.** The raw `edytor/crdt` export loses renderer, snapshot, diff/obfuscate and logging helpers that edytor never uses. The upstream test suite is rewritten to the kept surface.
- **D2 — BroadcastChannel leg (P4.2).** **Keep retired**, since IndexedDB already syncs tabs. Restore if you use websocket-only tabs offline.
- **D3 — `selection.state` public getter (P2.5).** **Keep a thin read-only view** for consumers; delete the internal compat layer only.
- **D4 — P5 scope.** **Build the room now**, since you are deploying on Durable Objects.

## Verification

- Per checkpoint:
  - `pnpm check`, `pnpm lint`, `pnpm check:worker`, `pnpm exec vitest --run`, `pnpm test:crdt` (restore seed-37/59 json), `pnpm test:dom`;
  - both typechecks;
  - full chromium/firefox/webkit (`PW_PORT=… playwright test --config=playwright.arch.config.ts`), mobile projects, `--project=cdp`;
  - DST (`playwright.dst.config.ts`).
  - Known reds stay at most the current 2 per engine, trending to 0 after P1.2.
- The ported review probes (P1.1) are part of every later gate.
- P3:
  - bundle measurement before/after (rolldown, as in `scripts/check-worker-bundle.mjs`);
  - the P4/P7 byte-equality differential tests (`r1-p4-format.test.ts`, `p7-gap-end.test.ts`) still green;
  - the rewritten upstream suite green;
  - `tests/packed-consumer/run.sh`.
- P5: the room under the Cloudflare vitest pool plus the Miniflare-hosted three-browser lane (offline replay, reconnect, presence, hibernation, auth refusal of forged client ids).
- Final: `node scripts/xloc.mjs src/lib --dirs`, `--vendor` on the fork, `pnpm bench:crdt`, `pnpm build` bundle sizes, and the exit census in the ledger's Results section.
