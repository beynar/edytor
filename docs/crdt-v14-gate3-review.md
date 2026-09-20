# Gate 3 Review — CRDT v14 Integrated Application

Adversarial functional review of the v14 cutover **as an integrated app**
(wrappers, ops, selection, undo, presence, browser input, providers,
fixtures, migration, lifecycle) — run before U11 performance work.

Probes added by this review (all wired into lanes, none weaken assertions):

| File                                                  | Lane        | Result                   |
| ----------------------------------------------------- | ----------- | ------------------------ |
| `src/tests/crdt/gate3/pending-compaction.test.ts`     | crdt + unit | 4 pass                   |
| `src/tests/gate3/app-context.test.tsx`                | unit        | 7 pass                   |
| `src/tests/fixtures/dom/gate3/lifecycle-dom.test.tsx` | dom         | 3 pass + 1 expected-fail |

Lane status at review time: unit 52 files / **1218 pass** (1 skip, 11 todo);
dom lane green incl. the `test.fails` pin; crdt lane green. Random corpus
still records the intentionally-retained evidence classes (`lost-edit`,
`duplicate-placement`, `upstream-engine-crash`×2 …) — not re-litigated here.

---

## Ranked findings

### F1 — HIGH: unmanaged element inside a text element is unwrapped _after_ reconcile → visible text duplicated, model can compound it

`src/lib/events/domTextMutationObserver.ts`

An element injected inside a managed `[data-edytor-text]` node is skipped by
`removeAddedUnmanagedNodes` because `isInsideEditableIsland` (lines 70–75)
includes `[data-edytor-text]` (`shouldRemoveAddedNode`, line 270). That is by
design — `unwrapAddedUnmanagedTextWrappers` is meant to flatten such
wrappers. **But it runs at line 782, after `reconcileDomText` at line 749.**

Reproduced sequence (pinned by `test.fails` in
`src/tests/fixtures/dom/gate3/lifecycle-dom.test.tsx`, ~lines 70–97):

1. `<span>ROGUE</span>` appended inside a `Hello` text element.
2. Reconcile reads `textContent = 'HelloROGUE'` → writes `HelloROGUE` into the
   model → Svelte re-renders that as a text node.
3. Unwrap then replaces the span with a `ROGUE` text node → DOM children end
   as `…#text:HelloROGUE … #text:ROGUE` → **`HelloROGUEROGUE`** while the model
   holds `HelloROGUE` once.

The DOM now permanently disagrees with `text.stringContent`; the next input
mutation can re-absorb the doubled text into the model — compounding
corruption, not just a display glitch. Trigger is realistic: spellcheck /
grammar overlays (Grammarly-, LanguageTool-style), GBoard spans, translate —
exactly the case the unwrap path exists for. Its ordering makes it produce
the corruption it guards against.

**Fix direction:** unwrap _before_ reconcile so the flattened DOM is what the
diff is computed from (adopt-or-revert decided once), or after unwrapping
force `refreshFromModel` / drop unwrapped nodes whose text the model already
absorbed. Invariant to enforce: post-flush `node.textContent ===
text.stringContent` (+ ZWSP rules).

### F2 — HIGH: no `Edytor` teardown — shared doc/awareness retain every mounted editor forever

- `src/lib/edytor.svelte.ts:311–312` — constructor binds
  `awareness.on('change'|'update', this.refreshRemotePresence)`; never
  released, not in `this.off`.
- `src/lib/edytor.svelte.ts:387–390` — `createUndoManager` builds a
  `Y.UndoManager` holding doc observers; `undoManager.destroy()` never called.
- `src/lib/components/Edytor.svelte:159` — the component always constructs the
  `Edytor`; its `onMount` cleanup (lines 179–192) destroys **only the sync
  provider**. There is no `Edytor.destroy()`/`dispose()` anywhere.

Repro: `src/tests/gate3/app-context.test.tsx:191–226` — five `Edytor`s on one
doc/awareness add ≥5 doc `update` listeners and ≥5 awareness listeners;
`editors[0].destroy === undefined`. `facade.dispose()` exists and does
release its doc listener, but **nothing calls it** — not the runtime, not the
component.

Impact: mount/unmount cycles (dialogs, tabs, multi-editor views, test
harnesses) leak one full `Edytor` + its `this.off` closures + undo manager
per mount; listener arrays on the shared doc/awareness grow unboundedly and
every dead editor still runs `refreshRemotePresence` per presence tick.

**Fix direction:** add `Edytor.destroy()` — `awareness.off(...)` both subs,
`undoManager.destroy()`, `facade.dispose()`, `selection.destroy()`, drain
`this.off` — and call it from `Edytor.svelte`'s `onMount` cleanup (the
instance is always component-owned, so this is safe).

### F3 — MEDIUM: `this.off` is never drained — every DOM remount retains ~18 dead closures and a detached editor DOM tree

`src/lib/edytor.svelte.ts:1237–1246` — the attach `destroy` runs
`this.off.forEach((off) => off())` but never empties the array, despite
comments at lines 482 and 1204 claiming it "drains". Each `{#key
edytor.editorDomRevision}` remount (`Edytor.svelte:285`) re-runs
`use:edytor.attach`, pushing ~18 fresh cleanups (node + ownerDocument
listeners, mutation-observer teardown, plugin actions, facade sub) onto the
still-populated array.

Remounts are conditional, not per-keystroke — `refreshDomAfterHistoryChange`
(:51–58) only remounts on rendered drift/disconnected nodes; also hotkeys
(`hotkeys.ts:197,212`) and the reset path (:1071). Still: after N remounts
`off` holds ~18N closures, each retaining the detached previous
`<div data-edytor>` subtree → stale editor DOM trees accumulate for the
session; each destroy also re-runs all prior cleanups (O(n²) work, and only
safe while every cleanup stays idempotent).

**Fix direction:** `this.off.splice(0).forEach(off => off())` (or
`forEach` + `this.off.length = 0`) in the destroy path.

### F4 — MEDIUM: `cloneJson` boundary silently rewrites/drops non-JSON values

`src/lib/utils/json.ts` — `JSON.parse(JSON.stringify(v))` applied to block
`data`, marks, migration data, formats. Repro:
`app-context.test.tsx:46–84` — `Date` → string, `Map` → `{}`, `undefined` and
function keys dropped — silently, no error.

JSON-only is a defensible contract (non-serializable values cannot cross the
wire anyway), but `data`/`marks` accept broad record shapes, so consumers can
store richer values that corrupt silently — and the corruption only surfaces
after a round-trip or a peer reserialize. Needs an explicit decision: type
`data`/`marks` as JSON-only + document loudly, or warn/dev-check on write.

### F5 — LOW (carried risk, de-risked): vendored-engine crash is NOT reachable through provider storage/sync paths

`src/tests/crdt/gate3/pending-compaction.test.ts` (4 probes through the real
`IndexeddbPersistence` + `storeState` over fake-indexeddb): pending structs
and pending delete-sets survive `encodeStateAsUpdate`-based compaction;
`encodeStateVector` truncates at gaps so sync diffs re-deliver missing
ranges; a doc reloaded from a snapshot carrying pending items re-pends them
and heals on resync. The seeds-86/140 crashes require the corpus's synthetic
lossy reload (harness `reload()` discards pending state) — not produced by
any audited provider path.

Residual risk: the engine still hard-crashes on legal update streams after a
lossy reload; any future persistence path that snapshots without pending
items re-opens it. Keep the corpus + these probes as regression evidence.

### F6 — LOW: migration is explicit-only; nothing in an app boot path invokes it

`bindCrdt(Y).migration` (`src/lib/crdt/index.ts:201`) exposes
`migrate/rollback/status`; `docs/crdt-v14-providers.md` documents it
thoroughly as a manual operator action. The DOM route
(`src/routes/test/dom/+page.svelte:362`) mounts `IndexeddbPersistence`
directly — a v13 user opening the app post-upgrade reads the empty
`edytor-v14:<name>` namespace unless the integrator runs `migrate(name)`.
By design per the handoff; the gap is integrator-facing: ship a boot-time
`status(name)`/`migrate` recipe (or auto-invoke option) before packaging.

### F7 — INFO: `insertSubtree` is a plain alias of `insertBlock`

`src/lib/crdt/edytor-doc.ts:810` — documented as intentional
("spec ids must be new"), no production callers. Not a defect; flagged only
because the name implies distinct semantics.

---

## Verified clean (probed, not assumed)

- **Undo vs remote edits** (`app-context.test.tsx:88–135`): local undo
  preserves a remote peer edit; redo reapplies only the local change.
- **Selection anchors** (:139–188): caret anchor survives remote merge
  (resolves into merged block at offset 7) and remote split (offset 5 →
  second half at offset 2).
- **Awareness cleanup on unmount** (DOM lane): local `selection` presence
  removed; unrelated `user` state retained. `RemoteSelections.svelte:41–45`
  offs its own subs; attach destroy does release DOM/facade-sub listeners.
- **Plugin interception**: `prevent()` throws `PreventionError`, caught at
  every event layer (`onBeforeInput.ts:610`, `onKeyDown.ts:359`,
  `onPaste.ts:110`, `onCut.ts:37`, `onCopy.ts:18`, `hotkeys.ts:606`);
  first normalized-payload plugin wins (`block.utils.ts:80–92`,
  `text.utils.ts:42–55`). Note: `onAfterOperation` receives the original
  payload, not the normalized one — semantic quirk, not a defect.
- **Void/island + grouped move**: `insertBlock` rejects void parents
  (`edytor-doc.ts:802`); `moveBlocks` is one transaction with per-member
  island/void checks (:826–833). `dnd.svelte.ts` remains a consumer-callback
  shell (no model ops wired — matches AGENTS.md "not ready").
- **Browser proof honesty**: `collaboration-multiclient.spec.ts` asserts a
  real partition gate (`bcconnected:false` both sides, divergent state
  mid-partition) and full serialized-JSON equality post-heal. One 300 ms
  sleep for a negative assertion — heuristic but reasonable.
- **Migration pipeline**: claim→announce phases idempotent, non-destructive,
  pending-deps fail closed; 13 migrate tests green.
- **Cross-cutting**: no stray `console.*` in v14 production paths
  (`sync.ts:73` is deliberate error reporting); `ts-expect-error` limited to
  3 known plugin-typing spots; `RemoteSelections`/provider `destroy()` paths
  verified.

## Honest limits

- Playwright specs audited statically; no live browser run this session.
- Undo probes cover insert/merge/split scope — not grouped moves or void
  subtrees under remote churn.
- F1 reproduced for a flat span; wrappers containing managed nodes take a
  different (rejected) path — untested permutations remain.
- F3 leak confirmed by code inspection + remount probe; retained bytes not
  profiled.
- The DOM harness mounts real Svelte but input simulation is synthetic;
  native beforeinput/IME coverage remains browser-spec-only.

## Verdict

- **U11 performance work may begin.** None of the findings block
  instrumentation; note F2/F3 will pollute memory benchmarks until fixed
  (mount/remount leaks masquerade as baseline growth — flag baselines
  accordingly).
- **Final packaging: NO.** F1 is user-visible corruption through a realistic
  trigger; F2 leaves a public object with no teardown story; F3 contradicts
  its own comments. Land fixes for F1–F3 and the F4 contract decision,
  re-run the three lanes (F1's `test.fails` must flip to pass), then re-gate.
  Everything else probed — facade binding, ops marshaling, anchors, undo,
  awareness, providers, compaction, migration, protocol gates — holds.
