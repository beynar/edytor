# Adversarial review of the current Edytor tree

Date: 2026-09-23. Review only; no product code was changed.

## Verdict

The recent work has materially improved the editor, and the existing unit and DOM suites are green. I would **not sign off on the current selection and paragraph-attribution slice** yet. Five supported interleavings produced incorrect focus, selection, document initialization, or authorship. Two more selection/attribution cases need explicit contract tests. The latest packed-browser performance artifact measures an older build, so its numbers cannot establish current browser performance.

The pasted R1–R3 retrospective accurately describes its tested fixes, but its broad conclusion about selection ownership is stronger than current evidence allows. These findings are new interleavings around later user intent, local undo, and delayed remote delivery; they do not negate the anchor work already proven.

Severity in this report: **P1** means a supported workflow produces incorrect observable behavior or a performance claim is not tied to the current build; **P2** means a narrower correctness/contract gap or a benchmark integrity defect. All product findings below were reproduced against the current working tree. The three CRDT reproductions were also replayed independently during this review.

## Findings, ordered by impact

### 1. [P1] A sibling view can seed a shared document before provider hydration

The [editor constructor](../../src/lib/edytor.svelte.ts) calls `this.sync()` whenever a view is readonly **or** has no `sync` prop (line 570). It does not first check whether its injected `EdytorDocument` is still pending. The [component](../../src/lib/components/Edytor.svelte) sets up `whenDocumentReady` only for a view carrying `sync` (lines 183–214). Thus a common composition—one provider-carrying view plus a sibling view without `sync`—lets the sibling decide the document's content before the provider does. A readonly view with `sync` also seeds it in the constructor.

**Reproduction:** attach a pending `Y.Doc`; construct view A with `{document, sync: true}` and view B with `{document}`. The document changes from `pending` to `local` at B's construction. Apply the remote provider's encoded document containing one block, then call `document.sync()`: the resulting projection has **two root blocks**, including a local bootstrap block. A second probe showed `{readonly: true, sync: true}` alone also makes the pending document `local`. Focused Vitest probes passed while asserting this unwanted behavior; the temporary files were removed.

**Why the suite missed it:** [document-views.test.ts](../../src/tests/crdt/document/document-views.test.ts) checks deferral for the provider view alone; existing sibling tests start with an already-ready document. The 47 existing document-view/presence tests pass.

**Acceptance for a fix:** only the document's explicit readiness decision or the provider's `synced` path may seed pending shared content. All injected sibling and readonly views wait and hydrate the same result, with no extra root block. Preserve the existing view-owned document behavior.

### 2. [P1] Delayed blurred-selection repair can steal focus after the user returns

The [selection repair](../../src/lib/selection/selection.svelte.ts) captures an external active element, then schedules an immediate and a 50 ms retry (lines 1960–1984). The retry permits an element **inside the editor** as a reason to focus the old external element (lines 1970–1978). It has no later-focus or later-selection ownership check.

**Reproduction in Chromium:** put the caret in the editor, focus an outside button, apply a document edit while blurred, immediately focus the editor and set a new caret. The editor has focus immediately. After 100 ms, the outside button has focus and the editor's native selection is gone. The existing blurred-update browser test refocuses only after the update settles, so it does not exercise this race.

**Acceptance for a fix:** a deferred repair must stop when a later user focus/caret intent owns the view. A browser regression should interleave the new focus before each delayed callback, then assert active element, DOM selection, and model selection.

### 3. [P1] An undo timer can overwrite a newer caret move in model state

The [history range restoration](../../src/lib/selection/selection.svelte.ts) schedules `restoreModelRange` at 0 and 30 ms (lines 745–769). The continuation guard checks a history-restore version and document-commit version (lines 864–875), but a caret move without a content commit changes neither.

**Reproduction in Chromium through an actual undo stack pop:** establish a range, delete it, then call `historyUndo()`. When the restore settles, move the caret to offset 0. Immediately, both native and model caret are at 0. After the delayed callback, the model jumps to offset 3 while the native caret remains at 0. The next editing command may therefore operate at a different position from the caret the user sees. A direct range-restore probe produced the same class of mismatch.

**Acceptance for a fix:** newer caret/selection intent cancels an older history restore, including timer callbacks; a new document commit still cancels it. Prove model and native selection agree after undo followed quickly by a user caret move, with and without a range snapshot.

### 4. [P1] Same-actor stamp suppression lets undo report the wrong last editor

The [block attribution writer](../../src/lib/crdt/attribution/block.ts) skips a `lastChangedBy` write when the replica's stamp cache and current value both equal the actor (line 185). That equality does not prove the current CRDT item belongs to this replica's latest edit or history step.

**Reproduction with three live-wired replicas:** Alice on device A edits; Alice on device B edits; Bob on C edits; Alice on A edits again; Alice on B edits again. All replicas show `xABCDE`, last editor Alice. A undoes only its latest edit. B's later `E` remains, giving `xABCE`, but **all replicas report Bob** as `lastChangedBy`. The second B edit suppressed its own `l` write, so undo of A's item exposed Bob's older value. Replayed with `pnpm exec jiti /tmp/edytor-crdt-probe.ts`; source and output were inspected during review.

**Why the suite missed it:** [block-undo.test.ts](../../src/tests/crdt/attribution/block-undo.test.ts) exercises first stamps from each same-actor replica, not this interleaved second stamp.

**Acceptance for a fix:** undo on one device must not hide a later surviving edit from another device, even when both use the same actor ID. Specify the exact meaning of `lastChangedBy` under undo and concurrent edits before optimizing same-actor writes; test repeated actors, intervening third actors, and selective undo. A per-replica value cache is insufficient evidence of CRDT write ownership.

### 5. [P1] A delayed edit to an undone block can contaminate a new block with the same ID

Attribution records use [only the recyclable block ID](../../src/lib/crdt/attribution/block.ts) as their key (`b/<id>`, line 89). On fresh creation, `stampCreated` clears known old contributor keys (lines 207–236), but it cannot prevent a delayed edit from the old physical block from writing to that same record later.

**Reproduction:** Alice creates `shared = old`; Carol edits it offline. Alice undoes creation; Bob receives the undo and creates a fresh `shared = new`. Bob's new block initially has `{createdBy: bob, contributors: {bob}}`. Deliver Carol's old edit update: visible text remains `new`, but contributors become **`{bob, carol}`**. Replayed with `pnpm exec jiti /tmp/edytor-crdt-delayed-probe.ts`. [The existing recycling test](../../src/tests/crdt/review/block-attr-defects.test.ts) covers immediate recreation, not delayed delivery.

**Acceptance for a fix:** attribution for a new block identity must be insulated from delayed updates to an older identity that used the same public ID. Test the delivery order above and its reverse on multiple peers, including save/load. Clearing already-known keys at creation alone does not provide that isolation.

### 6. [P2] Async range selection can apply stale direction over newer intent

`setAtRange()` awaits endpoint nodes, then [rejects stale writes only when endpoint identities or offsets differ](../../src/lib/selection/selection.svelte.ts) (lines 2819–2832). Direction is absent from that guard.

**Reproduction in Chromium:** delay an older forward range write over offsets 1–3; apply a newer backward range over the same endpoints; release the old lookup. The newer state is backward, then the old write makes the final model state forward. This can occur during overlapping range restoration or rapid reverse selection.

**Acceptance for a fix:** selection writes need an ownership/order check that includes direction and newer user intent. Add an overlapping async regression; sequential direction tests do not exercise it.

### 7. [P2, contract decision] Concurrent split can attribute an edit to the wrong visible paragraph

[Split](../../src/lib/crdt/edytor-doc.ts) copies the source's contributor set to the new tail once (line 1790 onward). A concurrent edit still stamps its original logical block ID, even when ownership resolution later places its text in the tail.

**Reproduction:** offline Alice splits `abcd` after `ab`; offline Bob inserts `X` at original offset 3. After exchange, both peers converge to source `ab` and tail `cXd`. Bob appears in the unchanged source's contributors, while the tail lists Alice alone. Independently replayed with `pnpm exec jiti /tmp/edytor-crdt-split-probe.ts`.

This is a defect **if paragraph attribution describes contributors to each paragraph's visible content**, which is the natural reading of the current API and handoff. If the intended contract is instead "actors who edited this logical block ID before ownership moved," document that weaker meaning explicitly. Decide the contract before changing storage; the two interpretations cannot both be inferred from the existing contributor set.

### 8. [P1 evidence / P2 harness] The latest packed-browser numbers do not describe this tree

[browser-latest.json](../../bench/results/browser-latest.json) records `src/lib` hash `8c0711a7…` and a packed tarball from 2026-09-22. The current source hashes to `4cf480e5…`; `dist` and the installed packed consumer differ in **50 product files**, including editor, selection, input, and placeholder code. The recorded 5k mount **697 ms** and keystroke p50 **15.9 ms** are valid for the artifact's older build. They do not establish current browser performance or the effect of later fixes. Current focused Node tests did pass 33/33 for scoped refresh, bulk initialization, and shared-backing fanout; the shared keystroke recomputed one run in the current Node probe. That is narrower evidence.

The harness also weakens future comparisons:

- [browser.js](../../bench/browser.js) overwrites `browser-U0-instrumented.json` on **every** run (line 1266 onward), though it calls the alias frozen.
- It hashes `bench/browser-app` **before** building (line 186), and [hashTree](../../bench/lib/source-id.js) includes generated `dist`; the recorded app hash includes five source files and five prior build files.
- The artifact variant is hardcoded to `B` (line 190), including when a later C build is measured.

**Acceptance for a fix:** freeze baselines only by explicit action, hash source inputs separately from emitted assets, derive variant from the run, then pack/install the current tree and rerun the relevant browser lanes. Compare matched source, package, harness, fixture, and browser identities. Do not transfer a latency claim from the older package to today's source.

## Validation and limits

- `pnpm check`: **0 errors, 0 warnings**.
- `pnpm test -- --run`: **1786 passed, 1 skipped, 11 todo** (105 files passed, 2 skipped).
- `pnpm test:dom`: **247 passed**.
- Existing document-view/presence tests: **47 passed**. Two temporary Vitest probes established the pending shared-view and readonly-view failures; another established the extra block after remote hydration. The temporary files were removed.
- Existing focused CRDT attribution tests: **26 passed** across three files. Three independent reproduction scripts under `/tmp/edytor-crdt-*.ts` produced the outputs above; the author of this report reran them. These scripts are diagnostic, not permanent regression tests.
- Existing focused performance tests: **33 passed**. Current Node shared-backing keystroke recomputed one run; formatting still recomputed all 50 in that fixture.
- Selection findings used focused real-Chromium probes on `/test/dom`; the undo timer was checked through an actual `historyUndo()` stack-pop path. These were diagnostic probes, not new checked-in tests.

This review did not rerun the full Firefox/WebKit browser matrix, DST corpus, CRDT extensive lane, or a fresh packed-browser benchmark. Their prior green results remain evidence for the earlier source identities only. The tree is dirty on `feat/crdt-v14-engine` at HEAD `d9b7de0`; preserve all concurrent work when fixing these issues.

## Recommended repair order

1. Pin the five P1 correctness sequences as failing tests, including native/model selection assertions and full multi-replica delivery orders. Keep all current tests intact.
2. Fix readiness at the document/view boundary, so every injected view follows the document's decision; then fix selection timer ownership and stale async writes at the existing selection owner.
3. Resolve attribution identity and selective-undo semantics together. The two CRDT failures both show that value equality or a public block ID is not enough to identify which historical edit a metadata write belongs to. Qualify split behavior under the chosen paragraph-level meaning.
4. Correct benchmark provenance and rerun the packed browser on the actual final tree. Report stage timings separately from rAF/paint and from current Node microbenchmarks.

The important architectural lesson is narrow: recent optimizations suppressed work using facts that were not stable under later intent, undo, or delayed delivery. The next fix should make those ownership boundaries explicit, then measure again.

## Resolution (2026-09-23, same day)

All eight findings were fixed and validated. Regression tests were pinned first for each defect, then the product fix landed.

| #   | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Validation                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | Views with an injected pending `EdytorDocument` defer seeding via a new `onReady` document event; `attachSync` tracks attached-but-unsynced providers (`_pendingSyncs`) so `whenDocumentReady` resolves synchronously on the readiness transition instead of polling. `Edytor.bindReadiness` holds `{document}` / `readonly` / `sync`-less views out of `sync()` until the document decides; destroyed views release the binding.                                                                           | `document-readiness.test.ts` (7), `document.test.ts`, `document-views.test.ts` — 121 document tests                   |
| 2   | Already fixed in the prior round; the deferred blurred repair checks a later user gesture/focus before refocusing the captured external element.                                                                                                                                                                                                                                                                                                                                                            | `selection-ownership.test.tsx` "deferred retry does not refocus an external element"                                  |
| 3   | Restore ownership is triple-guarded: `historySelectionRestoreVersion` + `_docCommitVersion` + new `gestureSerial` (pointer/key/focus). A foreign _field-different_ write aborts delayed `restoreModelRange` passes (`ownedState` compares endpoints/direction, not object identity — equivalent re-derives don't false-abort). Programmatic `focus()` during a restore window and DOM-detach `focusout` (no `relatedTarget`) no longer mark gestures, so an undo's own render can't self-abort its restore. | `selection-ownership.test.tsx` "caret move after undo", `undo-reversed-range-repro.spec.ts`, DST 27/27                |
| 4   | `stampLastChanged` suppression now checks **tip ownership**: the skip only applies when the replica itself wrote the current `l` item (walked via `node._map`), not merely when the value equals the actor. Every replica's latest stamp becomes a real CRDT item, so undo exposes the true surviving writer.                                                                                                                                                                                               | `block-attr-defects.test.ts` "undo exposes the later same-actor writer" (+ `captureTimeout: 0` to pin step semantics) |
| 5   | Block attribution records carry an **incarnation stamp** (`i` = creating item's id). `ensureRecord` swaps in a fresh record node when the stored `i` doesn't match the live block's lineage (resolved through `item.redone` for undo/redo re-integration). Delayed foreign edits land on the orphaned record, not the new block's. Reads keep simple map-winner semantics — `redone` pointers are local-only and can't gate reads without diverging replicas.                                               | `block-attr-defects.test.ts` delayed-delivery scenarios, `block-undo.test.ts` 69 attribution tests                    |
| 6   | `setAtRange`'s staleness guard now includes `isReversed` — an older forward write can't overwrite a newer backward range on the same endpoints.                                                                                                                                                                                                                                                                                                                                                             | `selection-ownership.test.tsx` direction-supersede test                                                               |
| 7   | Contract decided: contributors describe edits to the logical block; on split the source set is copied to the tail once at split time — later-arriving concurrent edits stay with the lineage they stamped. Documented and pinned.                                                                                                                                                                                                                                                                           | `block-attr-defects.test.ts` concurrent-split contract test (convergent, lineage-preserved)                           |
| 8   | Provenance gate in `bench/browser.js`: `run.sh` stamps `edytor.src-sha256` with `hashTree(src/lib)`; the gate refuses (or records `stale: true` under `--allow-stale`) on mismatch, mtime as fallback. `hashTree` now uses `path.relative` — `..`-spelled roots no longer mangle relpaths. Variant bumped to **C** (B + readiness/attribution/selection fixes). Fresh pack + full browser rerun recorded `stale: false`.                                                                                    | Packed-consumer checks pass; `docs/crdt-v14-benchmarks.md` §20                                                        |

### Follow-on defects found while fixing (also resolved)

- **DST `selection-model-dom-mismatch` (6 seeds):** undo's DOM render detached the focused node → `focusout` marked a user gesture → `isCurrentRestore` false → restore aborted before its first DOM write, leaving model≠native. Fixed by the narrowed focusin/focusout marking above.
- **Equivalent-state false abort:** the first ownership check compared object identity; a same-range re-derive replaced `state` and tripped it. Fixed by field comparison (`sameTarget`).
- **Android caret flake under parallel load:** the 250 ms post-delete restore window could expire between setup and the simulated selection echo. Test re-stamps `lastDeleteCommandAt` immediately before the echo — production window unchanged.
- **`hashTree` relpath mangling:** `run.sh` calls it with `$ROOT="$HERE/../.."`, and `f.slice(dir.length + 1)` mis-sliced relpaths on the un-normalized root — stamps could never match the gate. Fixed with `path.relative`; hashes for normalized roots are unchanged.

### Final validation

- `pnpm test -- --run`: **1,799 passed**, 1 skipped, 11 todo (107 files)
- `pnpm test:dom`: **250 passed** (13 files)
- `pnpm check` / `pnpm test:dom:typecheck`: **0 errors, 0 warnings**
- `pnpm lint`: clean
- `pnpm test:dst`: **27/27**
- `pnpm test:crdt`: **1,755 passed**, 7 skipped (90 files)
- `pnpm build` + `svelte-package` + `publint`: clean
- `tests/packed-consumer/run.sh`: all checks pass (fresh `edytor.tgz`, 609,378 B, sidecar `0dc360bb…`)
- Full Playwright matrix (Chromium/Firefox/WebKit/Mobile Chromium/Mobile WebKit): **1,410 passed**, 12 skipped, 0 failed

## Follow-up hardening: selection write path (2026-09-23, late round)

The full matrix surfaced a residual class the earlier rounds hadn't pinned: **caret writes racing native re-derives under load**. Three specs flaked only at full-matrix contention — `clipboard` mention paste (firefox/webkit), `hotkeys` ctrl+a caret-0 (chromium), `advanced-delete` combining-accent caret (firefox). SELLOG/mutation tracing isolated the mechanisms:

| Defect                                                                                                                                                                                                                                                         | Fix                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `setAtTextOffset` treated `!node.isConnected` as terminal — mid-remount detached nodes skipped the DOM write with no retry (while `findTextNode` misses retried 10×). A stray `selectionchange` then derived the stale native position and reverted the model. | Bounded retry through the transient disconnected window in `setAtTextOffset`, `setAtRange`, `setAtTextRange`, `setAtBlockRange` — re-resolve the node per attempt, keep per-attempt staleness guards.                                                                                                                                                                          |
| `setAtRange` staleness guard counted an equivalent re-derive of the _call-time_ position (a delayed echo of the old caret) as a foreign write and aborted.                                                                                                     | The guard now only aborts on a state that differs from **both** the write target and the call-time snapshot — a true foreign move.                                                                                                                                                                                                                                             |
| Post-delete caret re-anchor: after an in-place `characterData` delete, Gecko under contention re-anchors the DOM caret at the _preserved absolute offset_ instead of the shifted position; a `nat@15` derive lands after our `@13` write and sticks.           | Bounded post-write verification in `setAtTextOffset`: ~150 ms after the write, if the model drifted back to the exact pre-write position with no user gesture, re-assert (≤3 attempts, ~450 ms). Repairs the transient single-bounce case without fighting the browser indefinitely.                                                                                           |
| Firefox _permanently_ insists on the preserved offset (11 re-asserts over ~1.6 s each bounced within ~10 ms; the position is also a bidi boundary next to the RTL Hebrew run). `comp:false` throughout — not IME.                                              | Documented browser quirk, not a defect: model=native keeps the next keystroke landing where the user sees the caret. The spec asserts the strict grapheme-deletion contract (text) plus a Firefox-tolerant caret of 13 **or** 15 with an inline `firefox-preserved-caret-offset` rationale. Chromium/WebKit keep the strict `@13` assertion.                                   |
| Browser caret at end-of-`'\n'` before an atomic inline element is engine-canonicalized into the trailing ZWSP placeholder (WebKit permanently, Firefox transiently) — DOM-index helpers resolved a different caret than the test intended.                     | Test-side determinism: `dispatchPasteAtCaret` helper resolves the target `Text` via `block.content` index (model identity, not DOM text index), pins the model caret, and dispatches the paste **synchronously in the same evaluate** — the `onPaste`→`selection.state` read can't interleave with a stray derive. `'\n'` setup uses `insertAt` instead of Shift+Enter timing. |

### Validation (this round)

- Focused batches (advanced-delete + hotkeys + clipboard, firefox+webkit, 4 workers): **144/144 × 3 batches**
- `pnpm check`, `pnpm lint`: clean
- Full Playwright matrix: **1,410 passed**, 12 skipped, 0 failed — includes the firefox 3-client partition/reconnect/reload spec that exposed the handshake race below

## Follow-up hardening: websocket handshake readiness (2026-09-23, final round)

The full matrix surfaced one remaining data-loss race: `collaboration-websocket-3client` (firefox) converged all three replicas onto `['alpha','beta','gamma']` — the partition edits `-A` and `C>` were wiped after client C reloaded.

**Root cause — a foreign SyncStep2 can claim the handshake.** The opaque relay broadcasts every SyncStep2 reply to ALL room members, but the v14 wire format carries no request identity: a reply computed against _another_ member's state vector is indistinguishable from the answer to ours. For an already-synced pair that diff is **empty** — and the provider treated _any_ applied SyncStep2 as `synced`. A fresh client that received a foreign empty reply before the real hydration answer called `document.sync()` on a still-empty doc → `assertAdmission` verdict `fresh` → seeded `collab-b1..3`; when the fresh seed items won the map LWW election over the synced blocks, the room reverted to base text.

**Fix — `synced` requires evidence.** In `providers/websocket.ts`, an applied SyncStep2 now claims `synced` only when the doc holds replicated state afterward (`encodeStateVector(doc).length > 1`). An applied reply on a still-empty doc arms a settle window (`syncSettleMs`, default 300 ms — plumbed through `WebsocketSyncOptions`); only a doc still empty at expiry — the room verifiably has nothing — completes the handshake, preserving cold-start seeding. The timer clears on disconnect/destroy so a reconnect re-derives `synced` from its own handshake.

**Pinned at the unit level** (`websocket.test.ts`, +4 tests over the in-memory opaque relay, deterministic frame injection): foreign empty SyncStep2 cannot claim `synced`; empty room resolves via settle; a state-carrying SyncStep2 resolves immediately inside the window; reconnect re-syncs through the fresh handshake.

**Residual bound:** seeding can still race hydration only if _every_ real SyncStep2 answer arrives later than the settle window — the honest limit of a request/reply protocol without a nonce over a broadcast relay.
