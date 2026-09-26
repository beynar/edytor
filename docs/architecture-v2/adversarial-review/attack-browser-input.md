# Adversarial review: browser-input lens

Target: `plan-v1.md` (judge synthesis, ownership-first base).
Lens: browser input (IME composition, Android/Safari `beforeinput` gaps, spellcheck and autocorrect replacement,
mutation timing vs `selectionchange`, gesture-serial supersession, dead-endpoint recovery).
Status: complete (15 findings verified against source; sections written incrementally).

## 0. Method and inputs

- Plan read in full (sections 0-11), plus `reader-input-events.md` and `reader-selection.md`.
- Source read: `events/onBeforeInput.ts`, `events/beforeInputCommands.ts`, `events/onInput.ts`,
  `events/domTextMutationObserver.ts` (parts), `edytor.svelte.ts` (composition, suppression, listeners, gestures),
  `text/text.svelte.ts` (composition pin), `selection/selection.svelte.ts` (echo, remote reconcile), vendored
  `utils/UndoManager.js`, `utils/diffText.ts`, browser specs (`composition*.spec.ts`, `mobile-*.spec.ts`), DST runner.
- Allowed docs used as requirements: `browser-input-gap-analysis-2026-09-21.md`, `cross-browser-confidence.md`,
  `editor-dst.md`, `editor-delete-contract.md` (anchor, ownership, responsibility sections).
- Every finding gives: a real browser event sequence, what the plan's representation does with it, the evidence,
  and a repair that stays inside the plan's own repair order (requirement, then owner, then representation).

The underlying question for this lens: which facts does the browser own, for how long, and does the plan give
each of them one owner with the right lifetime? The plan gives the IME's node, the IME's text and the user's
native selection moves owners whose lifetimes end too early (session ends at commit, attempt ends at its event,
display happens before the gesture is observed). Most findings below are instances of that one mismatch.

## Summary (ranked; no blockers, 11 major, 4 minor)

| Rank | ID | Sev. | One line | Regression vs today? |
|---:|---|---|---|---|
| 1 | BI-1 | major | Previews that "bypass undo" make committed IME text un-undoable. Composing over a selection deletes it mechanically, with no hooks and no undo | yes |
| 2 | BI-2 | major | The projector has no composition gate, so the bracket's `display` writes the DOM selection mid-IME after remote applies | yes (removes 2 guards) |
| 3 | BI-8 | major | An identity-based Android no-op check combined with prefix/suffix adoption double-deletes after doubled letters | yes |
| 4 | BI-4 | major | D-7 deletes composed text on abandonment (blur, dropped `compositionend`, idle), where the browser has already committed it | yes (dangling path) |
| 5 | BI-5 | major | The session ends at commit, but Firefox and WebKit keep writing and signalling after it. Late records are adopted, and the fix collides with rule 5 | yes |
| 6 | BI-14 | major | The single focus predicate lacks gesture-location evidence, so the projector steals a user's selection outside the editor on every remote apply | yes |
| 7 | BI-9 | major | The bracket covers document changes only. Session and view renders (`compositionstart` placeholder, readonly, a toggle) become "foreign", and inverting Svelte childList can hang | new risk |
| 8 | BI-3 | major | "Always write the current value" overwrites native moves whose `selectionchange` is still queued, and the drag guard loses its consumers | partly (drag) |
| 9 | BI-7 | major | "The open attempt's owner" is singular, but Android drift outlives its attempt and overlaps the next one | design gap |
| 10 | BI-6 | major | R11 purity forbids keeping the IME node through a peer's structural edit, so F-I12 cannot pass as written | overclaim (parity) |
| 11 | BI-10 | major | The IME, projector and bracket gates are synthetic events or desktop emulation and cannot falsify the claims; CDP IME is unused | verification |
| 12 | BI-15 | minor | The filler-to-text transition swaps the IME node in an empty block, the gap analysis's "empty-leaf" class | parity |
| 13 | BI-11 | minor | A peer splits inside a replicated preview, and the commit over a two-block region is undefined | parity |
| 14 | BI-13 | minor | A pinned segment key and an atom inserted inside the host segment duplicate rendered text | new |
| 15 | BI-12 | minor | The seam descends into content hidden by view state, and the projector waits forever | new (extension) |

**Common root.** Three owners get lifetimes that end before the browser is done with the fact they own:
- The composition *session* ends at commit, but the IME's authority over its node continues into a tail: BI-4,
  BI-5, BI-6, BI-15.
- The input *attempt* ends at its event, but engine drift arrives later: BI-7, BI-8.
- The *display* happens before the user's gesture is observed: BI-3, BI-14.

The first repair step in each case is to clarify the requirement (tail, expectation, pending observation). Only BI-7's repair
needs a scheduled deadline. The attempt shape already has one, but the CP11 census must count it. The others use
event-bounded phases or timestamps compared at use.

**Cost of the repairs** (estimated, execution xloc): about 250-330 in `session/composition`, `session/attempt`,
`surface/projector`, `surface/observer`, `surface/cells` and `surface/pin`. That fits inside the events (+300) and
selection (+200) contingencies of §7, but it consumes most of them *before* any R12 or R10 fallback is paid. The events
floor (1,659) and selection floor (1,794) should be read as optimistic by roughly that amount.

## 1. Findings

### BI-1 (major) Composition previews that "bypass undo" cannot be undone by the engine's undo manager

**Plan text.** R8: preview writes "are mechanical: they bypass hooks and are never an undo step". D-6: previews
"stay replicated, as mechanical writes that bypass hooks and undo". D-7: cancel deletes "the preview atoms ... with
no undo entry". §4.3 `session/composition.ts`: commit is "one user-origin command". §1.3: "the commit replaces exactly
the preview, once". §2.2 L2: tracked origins are the view transactions.

**Browser sequence.** Android Gboard types every word through a composition. A desktop Japanese IME sends
`compositionstart`, several `insertCompositionText` previews (`に`, `にほ`, `にほん`, `日本`) and then `compositionend`
with `data = "日本"`, the same as the last preview. The user then presses Mod+Z, or taps undo.

**What the representation does.** A "mechanical" preview write has to use an origin outside the undo manager's
tracked origins, because that is the only way to keep it out of an undo step. The commit then has two possible
implementations, and both break undo:
- The commit keeps the preview atoms, as today's fast path does when the final value equals the preview
  (`edytor.svelte.ts:1754-1760`, `beforeInputCommands.ts:285`). Then no tracked transaction ever inserted
  `日本`. Undo pops the previous, unrelated step, and the composed text stays. On Android this means typed words are
  never undoable.
- The commit replaces the preview in one tracked transaction. Then the stack item's `deletes` hold the untracked
  preview items. `popStackItem` re-creates every deleted struct except those in the same item's `inserts`
  (`vendor/yjs/src/utils/UndoManager.js:83-96`: "Never redo structs in stackItem.insertions because they were created
  and deleted in the same capture interval"). So undo removes the committed `日本` and restores the preview `日本`: a
  visible no-op. If the final value differs, undo resurrects an intermediate preview.

**If "bypass undo" meant "tracked, but not its own step".** The plan never says how the previews would join one
step. The dispatcher's undo policy is "text insertion coalesces, everything else cuts" (§4.3), and previews are not
commands, so no policy covers them. The engine merges tracked transactions only within `captureTimeout`
(`UndoManager.js:227-235`). A session with a pause longer than 500 ms, which is normal while choosing kanji, is
therefore split across several stack items. One undo then pops only the tail and leaves an intermediate preview
(`にほん`) behind. Either reading breaks "undo removes what the user typed".

**Also broken: composing over a selection.** Today the first preview deletes the selected range, atom or block set
before writing the preview (`beforeInputCommands.ts:173-186`, `replaceSelectionBeforeTextInsertion` at :176). This goes
through the ordinary text and block operations, so hooks see it and it is tracked. If the plan's `start` captures the
target and the first preview performs this replacement, the replacement becomes mechanical. It cannot be undone
(the replaced text is lost from history), and extension vetoes on block deletion are bypassed. A locked block
deleted by typing is refused; the same selection overwritten through an IME is deleted. Worse, suppose an extension
vetoes the commit (a read-only region, a length limit). R7 consults hooks once, on the user-level commit. By then
the start target is already gone, and D-7's cancel deletes the preview. The veto destroys text instead of
preventing the edit, which is the "half-executed command" R7 exists to rule out.

The alternative is to replace at commit. Then the model keeps, for the whole session, text that non-cancelable
Chromium/Android composition has already removed from the DOM. Peers keep seeing it, and the pin covers only the
host text node. D33 ("user intent vs mechanical replay") is conflated here: replacing the start target is user
intent, and only the preview text is replay.

**Frequency on Android.** Composing over existing text is routine there. When the caret is placed inside a
word, or after Backspace undoes an autocorrect, the IME reopens a composition over committed text
(Chromium's composition-from-existing-text path). The first `insertCompositionText` then declares a target range
that covers the existing word. So under the plan every re-edited word routes a deletion of committed text through
the mechanical, unhooked, untracked path. If that session is then abandoned (see BI-4), the original word and its
preview are both gone.

**Why the gates miss it.** No composition spec undoes a committed composition. `composition.spec.ts` has no undo
test. `composition-cancellation.spec.ts:360` covers only the cancel path, and only within the 500 ms capture window
(`page.waitForTimeout(650)` is spent *before* the composition). The DST undo oracle asserts only when the previous
action raised `undoDepth` by exactly one (`tests/editor-dst/runner.ts:1475-1480`), so a commit that pushes no stack
item escapes it.

**Today's behavior.** Previews are tracked. They go through `insertText`/`deleteAt`, then `batch`, then
`edytor.transact` with the tracked view origin, and `deleteCompositionText` does not cut capture
(`onBeforeInput.ts:539-549`). So a commit is undoable, but a session longer than `captureTimeout` splits into several
steps, and a slow cancel leaves a "delete preview" step that undo reverses into a resurrected preview. The plan
correctly sees that previews must not form their own steps, but "bypass undo" is the wrong mechanism.

**Repair (owner: `session/composition` + the dispatcher's undo policy).** A composition is one capture group, not
an untracked side channel:
1. At session start, call `stopCapturing()`, then run the start-target replacement as an ordinary user-origin
   command (hooks, veto, tracked).
2. Track previews with the view origin, and suppress the capture-timeout split for the session's lifetime (a
   `captureTransaction`/merge rule keyed by session id).
3. Commit and cancel land in the same stack item. A cancel then nets to an item whose inserts equal its deletes, and
   `popStackItem` skips it.

History commands stay swallowed while a session is live (pinned today by `adversarial-wave2.test.tsx:446` and
`adversarial-wave3.test.tsx:475`), so the capture group cannot be popped under the IME.

Add F-rows:
- compose with 1 s gaps, commit, and one undo removes exactly the composed text;
- compose over a selection, commit, and one undo restores the selection's text;
- compose, then cancel after 1 s, and undo reverts the previous step with no preview resurrected;
- a veto on block deletion refuses an IME composition over a cross-block selection exactly as it refuses typing.

### BI-2 (major) The projector has no composition rule, so the bracket's `display` step writes the DOM selection into a live IME session

**Plan text.** R10: the projector "always writes the current value, only when the target is mounted, and never
over foreign focus". §4.4 `surface/projector.ts` lists its conditions: current value, mounted target, focus
predicate, dedupe, backward ranges, user-frame scroll. None of them mentions composition. CP9 says the render
bracket "(... → flushSync → discard own records → display) wraps commands, remote applies and history". D15
correctly notes that the pinned DOM is a separate coordinate space, but no rule or module carries that fact.

**Browser sequence.**
1. A Japanese IME composes `に` at `Hello|` in Chromium or Safari.
2. A peer inserts `XYZ` at offset 0 of the same paragraph.
3. The remote apply runs through the bracket. The pin keeps the host text node frozen (base `Hello` + preview),
   while the model is now `XYZHelloに` with the caret anchor at offset 9.
4. The bracket's `display` step projects the current value (block, 9) and maps it through `surface/domPoint`, the
   one model-to-DOM mapper, which has no pin mode. The frozen node is 6 UTF-16 units long, so the point clamps or
   lands on the wrong node, and the DOM differs from the target, so the projector writes.

Changing the DOM selection during a composition ends it in both Chromium and WebKit: the engine commits or drops
the marked text, and the IME's candidate window closes. The same happens on every remote keystroke
in the host paragraph, and on any `select()` issued while composing (the preview's own caret, held ranges).

The same write can come from the preview's *own* bracket, with no peer involved. Previews are document changes,
so they render inside a bracket (R12), and every bracket ends in `display`. Previews are also mechanical rather than
commands, so R7's "result selection" does not cover them. If the session does not reselect after each preview,
the caret anchor rides the local insert with left affinity, which is the D23 hazard: the model caret sits *before*
the preview while the IME's caret sits after it. `display` then writes on every keystroke of the composition. The
plan does not say which of the two the session does.

**Evidence that today's code deliberately avoids this.**
- `text.svelte.ts:762-769`: the remote restore is skipped while the pin holds — "writing the DOM selection
  mid-composition disturbs IMEs".
- `selection.svelte.ts:2387-2390`: `reconcileSelectionAfterRemoteApply` returns early when composing.
- The remaining gap today is the dead-endpoint repair, which has no composition guard (reader-selection C9).

The plan deletes these sites: L21 removes the reconcile and the dead-endpoint repair, and L16 removes the mirror's
`_setItems` path. It does not move the guard into the projector.

**Why the gates miss it.** F-I8 and the seven `composition-remote-lock` specs use `dispatchComposition`
(`tests/editor-dom/helpers.ts:1017-1090`), and the DST composition action is synthetic too (`runner.ts:491-543`,
"events are isTrusted:false"). Script-dispatched composition events have no IME behind them, so a selection write
aborts nothing and the specs stay green. The only real-IME harness is CDP `Input.imeSetComposition`, in three
Chromium tests (`mobile-composition.spec.ts:342-470`). None of them involves a peer, and no plan gate names it.

**Repair (owner: `surface/projector`, with `session/composition`).** Split display by who caused it.
- *Background brackets* (remote applies, history of another view, held-range updates) never write the DOM
  selection while a session owns a host. The session owns the caret (reader W3), and the value keeps riding in
  model space.
- *User commands* that must move the caret while a session is live end the session first (a commit of what the IME
  shows), then display. This matters on Android, where a composition region is open whenever the caret sits inside a
  word.
- When the session ends, the bracket that releases the pin performs the one catch-up display.
- A mid-session write, if one is ever needed, maps through `surface/pin`, not `surface/domPoint`.

Add a CDP-driven row to CP6/CP9: a real IME composition in Chromium, a remote insert before the region, and a
check that the composition stays live (the next `imeSetComposition` extends it) and commits once at the shifted
region.

### BI-3 (major) "Always write the current value" is not gesture supersession: the bracket's `display` overwrites native selection moves whose `selectionchange` has not arrived yet

**Plan text.**
- §1.3 says W1 ("a deferred caret write never overrides a newer gesture") follows from R10 and replaces 16
  staleness mechanisms.
- R10: the projector "always writes the current value" and uses the gesture serial only to classify observed
  `selectionchange` events (O46, O50).
- The bracket ends in `display` after every command, remote apply and history step (§2.3, CP9).
- L22 and L23 delete every gesture check and the drag-guarded repair sites. No projector condition replaces them (§4.4).

**Browser facts.** Native caret moves change the DOM selection synchronously in the default action of
`keydown`/`mousedown`, or with no page event at all: iOS/Android selection-handle drags, the iOS space-bar
trackpad, Gboard cursor control, VoiceOver/Switch Control, closing find-in-page. The `selectionchange` that reports
the move is a later task. A WebSocket `message` task or a local command can run in between (reader-selection
§2.1-1; the bracket runs synchronously inside whatever task triggers it).

**Sequences that break.**
1. *Arrow key vs a peer's edit.* ArrowRight moves the DOM caret. A remote update arrives before the
   `selectionchange` task. The bracket applies it, then runs `display()`: the value is still the old caret, the DOM
   differs, so the projector writes the old caret. The keystroke is lost. The queued `selectionchange` then reads
   DOM == displayed and is classified as an echo. In a busy document this drops arrow presses and Shift+Arrow
   extensions at random.
2. *Mobile handle drag.* No pointer or key event reaches the page. Every remote update during the drag snaps the
   selection back to the last observed value.
3. *Mouse drag.* The value lags the DOM by one `selectionchange` during a drag, and every remote bracket rewrites
   the lagging range under the drag.

The current code skips remote-apply repairs during a drag (`selection.svelte.ts:2375-2380`; the same guard is in
`restoreRelativePosition` at `:2190-2195`). The plan keeps "pointer drag" as a single-owner fact (§3 preamble), but
none of the projector's conditions (R10, §4.4) consumes it, and the repair sites that did are deleted (L21, L23).

**Today's behavior.** `captureSelectionForRemoteApply` snapshots the *model* state (`selection.svelte.ts:2320-2335`),
which lags an unobserved DOM move in exactly the same way. `reconcileSelectionAfterRemoteApply`
(`:2350-2478`) rewrites the DOM when it differs from the stale anchors, and its gesture check only catches gestures
made *after* the capture. So race 1 exists today. The plan does not introduce it, but its claim that W1 becomes
"structural" does not hold. The plan does add a regression: the drag guard loses its only consumers (sequence 3).

**What is missing from the representation.** The bracket hands *pending mutation records* to the observer before it
applies (R12). It does not hand over the *pending selection observation*. Selection observation is also an input
queue, and the platform delivers it late.

**Repair (owner: `surface/projector` + classifier, no timer).** Step one of every bracket (and of `select()` from a
command) reads the DOM selection synchronously and classifies it first, as if a `selectionchange` had fired:
- DOM == `displayed`: nothing.
- Otherwise, with a gesture since the display, or with no gesture and no render since the display: admit it as
  user or foreign intent before applying.

Only after that step can a post-flush DOM ≠ projection be attributed to our own render. Keep "pointer drag active ⇒
no display writes" as a projector condition.

Add browser rows: ArrowRight with a remote update injected before `selectionchange` (Playwright `page.evaluate`
applying a peer update inside a `keydown` capture listener's `queueMicrotask`); mouse-drag selection with remote
updates at 60 Hz; a no-event selection move (`setBaseAndExtent` from a page script) racing a remote apply.

### BI-4 (major) D-7 turns "the browser never sent `compositionend`" into "delete the user's composed text"

**Plan text.** D-7: "One `cancel`: the preview atoms are deleted, with no undo entry", applied to both the abandoned
composition and the host-deleted one. F-O1 keeps "a live composition's idle policy" as an allowed timer. §4.3 lists
an "idle/dangling policy" but gives neither its trigger nor its bound.

**Browser facts.** When focus leaves during a composition (a click outside, an app switch, a programmatic focus
change by an extension, the Android keyboard dismissed), Chromium, WebKit and the Android IME *commit* the marked text
into the DOM. A missing or late `compositionend` is the anomaly the dangling path exists for. The text itself is
committed and visible. A composition can also be alive and silent for many seconds while the user reads a
candidate list. The gap analysis notes that ProseMirror uses a 5 s stuck-composition bound and asks us to "verify
ours doesn't cancel live compositions" (G8).

**Today's behavior.** The two abandonment exits disagree, as the plan says:
- The dangling-blur reset keeps the preview atoms (`edytor.svelte.ts:1500-1513`), matching what the browser left in
  the DOM.
- The observer's idle cancel deletes them after 750 ms (`domTextMutationObserver.ts:45, 1516-1540, 1557-1569`).
  Reader C1 measured exactly this: a live session killed and its preview deleted.

The only pinned cancel test is an explicit empty commit (`composition-cancellation.spec.ts:63`, `compositionend`
data `''`), which is a real cancel. There is no pin for "preview written, blur, no `compositionend`".

**What the representation does.** D-7 picks the destructive branch for both exits. A blur that drops
`compositionend` now deletes text the user can see and the browser has committed. If the plan keeps any time-based
idle policy (F-O1 allows one), a user who pauses over the candidate list longer than the bound has the preview
deleted from the model. The pin is then released and the host re-rendered while the IME still owns it, which is
the G2 corruption class. F-I6 (850 ms) only proves that the bound is larger than 850 ms.

**Repair (owner: `session/composition`).** Split the decision the plan merged:
- *Explicit cancel* is an empty final value, or `deleteCompositionText` with no following insert. Delete the preview
  in the same capture group as BI-1, so there is no undo noise.
- *Abandonment* is focus loss, a non-composing key (`event.isComposing === false` while a session is live), a new
  `compositionstart`, or a gesture-carrying selection outside the region. **Adopt what the DOM holds**: commit the
  host's DOM text for the region, or the preview if the host is gone. Time alone is never an abandonment signal.

Add F-rows:
- a preview, then a blur with `compositionend` suppressed, and the text stays in model and DOM;
- a 10 s pause with no events, and the composition is still live and commits once.

### BI-5 (major) The session's lifetime ends at commit, but the IME's authority over its node does not

**Plan text.**
- L7 and O31 give the composition session the lifetime "compositionstart → commit/cancel". R8: "It ends exactly
  once, in one commit or one cancel."
- Records are classified "by location and the open attempt's owner" (O52, CP9).
- L30 deletes the suppression windows, L35 deletes the nine reset sites.
- The only post-session state the plan keeps is the phantom-key guard (F-I13).

**Browser sequences, each pinned today.**
1. *Firefox order: `compositionend` comes before the last `input`.* The commit runs at `compositionend` and
   releases the pin, so the bracket re-renders the host with the committed `に`. Firefox then applies its trailing
   composition mutation and fires `input` (`insertCompositionText`, `isComposing: false`), so the DOM becomes `にに`.
   Pins: `composition.spec.ts:935` ("repairs Firefox-style duplicated committed input after compositionend") and
   `:896` (stale `n` after the commit). Both expect the late mutation to be **reverted**. In the plan no session is live at
   that point. If no `beforeinput` precedes the `input`, as in the pinned test, there is no attempt either, and a
   text change inside a text element with no attempt is what the plan adopts: missing-event input and foreign
   type-overs must be adopted (`dom-mutation.spec`, DST `foreignMutation`). If a composition-typed `beforeinput` does
   precede it, the only owner the intent table can give a composition insert outside a session is "browser", which
   also adopts. Either way the model becomes `にに`.
2. *WebKit order: the final `insertFromComposition` comes before `compositionend`.* The commit happens on the
   `beforeinput`, and the later `compositionend` must not commit again (cross-browser-confidence: "the later
   compositionend is duplicate-free").
3. *Android: composition DOM mutation without `beforeinput`.* It commits once, and "a later duplicate compositionend
   is ignored" (same doc).

"Idempotent across commit signals" (§4.3) needs the session to exist after its own commit, which contradicts its
stated lifetime.

**Today's behavior.** The tail is two 50 ms windows armed by the commit (`edytor.svelte.ts:1743-1744`,
`suppressNextInputFallback(50)` + `repairSuppressedInputFallback(50)`) plus the `compositionEndedAt` timestamp
(`:1648`, `:1820`). These are exactly the flags and timers L30 deletes, without saying what replaces them.

**Consequence for the plan's own rules.** The CP6 gate keeps these specs green, so the implementer will need a
post-commit tail. Rule 5 of §9.1 forbids adding "a timer, a one-shot flag or a retry loop" and treats the need as a
redesign trigger. So the plan walks into its own trigger on a known, documented engine order.

**Repair (owner: `session/composition`; clarify the requirement first).** The session has three phases:
`live → ended(tail) → gone`.
- The tail ends at the first *non-composition* occurrence: a `beforeinput`/keydown that is not composition-typed, a
  gesture, or a new `compositionstart`.
- It also ends at a timestamp bound compared at use, like `compositionEndedAt`, not a scheduled timer.
- While the tail lasts, composition-typed `input` events, duplicate commit signals, phantom keys and host-located
  records are attributed to the ended session and reverted to the model.

This is one owner for all four tail behaviors (the phantom key, the duplicate `compositionend`, the Firefox trailing
input, the WebKit early commit), and it needs no new timer. Update L7/O31's lifetime column.

### BI-6 (major) R11 ("host content is a pure function of the model") forbids the only mechanism that keeps an IME node alive through a peer's structural edit

**Plan text.**
- §1.3 says "The IME's node is never re-rendered" (from R8, R11, R12).
- R11: every node in the host is model text or core structure "whose presence is a pure function of the model".
- O40: the core renders the block element from `definition.element(data)`. O41/§2.4: cells are
  "created/disposed/patched only from change reports".
- The pin (`surface/pin.ts`, 55 xloc) freezes one host *segment*.
- F-I12 expects that when a peer deletes the host block, "no DOM write into the composing node before
  `compositionend`".

**Browser fact.** The IME owns the text node it composes into. If the node, or any ancestor, is removed, replaced or
moved, Chromium finishes or cancels the composition, and the IME's next update lands in a node the editor no longer
tracks (the gap analysis rates this class G2, P0, "the single highest-value correctness gap"; it names
collaboration as the trigger).

**Sequences during a live composition in block B.**
1. A peer turns B into a heading (slash menu, markdown shortcut, toolbar). The kind record's element changes, so the
   element and its subtree are re-created. Today `Block.svelte:13-15,32` does the same with `{#key snippetKey}`.
2. A peer presses Tab on B, nesting it under its previous sibling, or drags it into a container. The placement's
   parent changes. B's DOM is destroyed in one `{#each}` and created in another, because Svelte cannot move nodes
   across each blocks.
3. A peer presses Backspace at B's start and B merges into A. Under R2/R3, B becomes hidden and its stream is
   displayed inside A's cell, in different nodes with a different causal segment key. B's cell is disposed by the
   change report.
4. A peer deletes B (F-I12). The cell is disposed at the change report, which is itself a DOM write that removes the
   composing node, well before `compositionend`.

In all four cases the representation *requires* the remount: the plan's pin is keyed by segment inside a cell, and
the cell's existence, element and parent are pure functions of the model. So F-I12's expected result cannot pass
under R1 + R11, and the §1.3 claim is false for every structural remote change. Today's code has the same holes:
the region is handed to another wrapper and the pin released when atoms migrate (`text.svelte.ts:481-499`), and
type changes re-key the block. So this is not a regression. It is an overclaim that hides the one change that
would fix G2.

**Repair (owner: `surface/cells` + `session/composition`; the maintainer decides between two policies).**
- (a) *Retain.* Amend R11 to "a pure function of (model, live composition session)". The cell that contains the
  session's host is retained, frozen at its current element, parent and position, while the session (and its BI-5
  tail) lasts. Change reports that touch it are applied as one catch-up patch when the session ends. The commit
  writes through the region anchors, which resolve to wherever the atoms now live, or to the seam if they are dead.
- (b) *Commit first.* A background structural change that touches the host first commits the session (with the
  text the IME shows) and then applies. That is deterministic, but it interrupts the IME.

Either way, record the decision, change F-I12's expectation to match, and gate it with the CDP IME harness
(Chromium `Input.imeSetComposition`) plus a second page as the peer, for all four sequences.

### BI-7 (major) "The open attempt's owner" is singular, but Android drift outlives its attempt and overlaps the next one

**Plan text.**
- L6: an attempt lives for "one occurrence", with `owner`, `expect?` and `deadline?`.
- O52: records are adopted or reverted "by location + the open attempt's owner".
- R8: "Each input occurrence opens at most one attempt."
- L30 deletes the six flags and four timers "because ownership of DOM mutations is a property of the open attempt".
- The CP11 timer census allows the Android no-op Backspace deadline and the missing-`beforeinput` deadline. It
  allows no drift window for model-owned attempts.

**Browser facts.**
- *Android Chrome mutates the DOM anyway after a canceled `deleteContentBackward`/`deleteContentForward`, and the
  echo "lands in the same task or the next frame"* (`selection.svelte.ts:248-256`; gap analysis G8,
  "preventDefault-ignored deletes ... double deletion").
- A prevented event has no `input` event to close its attempt. The mutation arrives after the handler has returned.
- Non-cancelable model-owned commands need a drift window after the command (`onBeforeInput.ts:112`, 150 ms,
  armed at `:720-740` after `await command`).
- Gboard can emit several IME operations for one key: a delete followed by a recomposition of the word, arriving as
  `deleteContentBackward` and then `compositionstart` + `insertCompositionText` within one frame.

**What the representation does.**
1. If the attempt closes when its handler returns, the late "mutates anyway" deletion has no open attempt. It is a
   text change inside a text element, which the plan adopts. So the model deletes twice: once by the command, once
   by adoption.
2. If the attempt stays open until a deadline (a timer the census does not count), the next occurrence opens a
   second attempt in the same text node while the first is still waiting for its drift. One is model-owned
   (revert), the other browser-owned (adopt). "By location + the open attempt's owner" cannot say which records
   belong to which. Either the user's new character is reverted (lost keystroke) or the old drift is adopted
   (duplicated merge text, the case `mobile-beforeinput.spec.ts:1288` pins).

Today's flags and timers are crude, but they encode "the newest attempt wins, older drift is repaired from the
model". The plan deletes them and replaces them with a singular owner that cannot express two live claims on one
node.

**Repair (owner: `surface/observer` + `session/attempt`).** Attribute records by *expectation*, not by owner alone:
- Each open attempt carries `expect = {host, before, after | unknown}`: the browser-owned text change it announced,
  or for a model-owned attempt the DOM state its bracket produced.
- A record batch whose net text effect matches a browser-owned attempt's `expect` is adopted for that attempt.
  Everything else in a host that some model-owned attempt claimed is reverted to the model.
- Attempts are a small per-host queue, closed by the first of: its `input`, the next non-composition occurrence
  **after** its expectation is met, or its deadline.

Count the model-owned drift deadline in the CP11 census.

Add dom rows with two overlapping attempts in one text: a prevented Backspace plus late drift, followed within one
frame by a non-cancelable `insertText`. Both effects land exactly once.

### BI-8 (major) An identity-based Android no-op check combined with position-blind adoption double-deletes after doubled letters

**Plan text.**
- §4.3 `session/attempt`: "Android no-op-Backspace deadline tested against the anchored atom".
- D4: "success = the anchored atom disappeared".
- F-I2 expects "exactly one grapheme deleted: the one before the anchored caret".
- L32 and O52: "adoption diffs by common prefix/suffix only".

**Browser sequence.**
1. On Android Chrome, the text is `hello` and the caret is at `hel|lo`.
2. Backspace arrives as a non-cancelable `deleteContentBackward`, collapsed and text-local, so it is browser-owned
   and the plan arms the no-op deadline.
3. Chrome deletes the `l` at index 2 and the DOM becomes `helo`.
4. The prefix/suffix diff is greedy on the prefix: `hel` matches, then the suffix `o`. It deletes model index **3**,
   the *second* `l` (`utils/diffText.ts:28-60`). The strings agree, but the surviving atom is the one the caret
   was anchored after.
5. At the deadline, the attempt asks whether the grapheme before its anchored caret disappeared. It did not, so the
   fallback deletes it. The model and then the DOM become `heo`.

Every Backspace right after a doubled letter (`ll`, `ee`, `ss`, `oo`, double spaces, `!!`, `...`) double-deletes on
Android. Android is not in any lane (K3, U-2), and F-I2's scenario uses a peer edit, not a repeated character.

**Today's behavior.** The fallback compares strings (`onBeforeInput.ts:485-527`: `text.stringContent !== initialValue`
or the DOM text changed), so it is immune to this case. It is not immune to a concurrent remote edit (reader-input
C5), which is what motivated the plan's change. Adoption today also places the caret from the native DOM caret, not
from the diff (`onInput.ts:640-646`). So the misattributed item never reaches a user-visible decision.

**The same flaw elsewhere, already present today.** Browser-owned word deletes and replacements declare their
exact target range at admission, and prefix/suffix adoption ignores it. Take `**the** the cat` with the caret after
the bold word, and an Android word-delete (`deleteWordBackward`, text-local, non-cancelable). The DOM becomes
`the cat` (plain), but the greedy diff deletes the *second*, plain `the `. The model keeps the bold `the`, so the
re-render turns the survivor bold. Remote carets and attribution bound to the words are swapped too. This one is
parity with today's diff, but it shows that "prefix/suffix only" (L32) is not the requirement. It is the requirement
minus the position hint the attempt already holds.

**Repair (owner: `session/attempt` supplies the hint, `surface/observer` uses it).**
- Adoption diffs with a *preferred position*: the admitted target range, or the pre-edit anchored caret. This is
  ProseMirror's `findDiff(a, b, preferredPos)`. Among equal-cost diffs, pick the one that touches the declared range.
- The no-op test becomes "did this attempt's adoption apply a deletion" (`phase: applied`), not atom identity. That
  survives a concurrent remote edit and repeated characters alike.

Add dom rows: Backspace between doubled letters via a browser-owned deletion, where exactly one character is
deleted and the deadline does nothing; Android word-delete of the first of two identical words with different marks, where the survivor keeps its own
marks and a remote caret inside it stays put.

### BI-9 (major) The bracket covers document changes, but the host also renders session and view state; K2's "never data" is false for Svelte-owned nodes

**Plan text.**
- R12: "Document changes render inside a bracket", and every record that reaches classification "was therefore made
  by the browser or by a foreign script".
- CP9: the bracket "wraps commands, remote applies and history". O25 adds selection side effects ("rendered inside
  the bracket").
- §2.4: the placeholder attribute is derived from "cell has one empty text ∧ **no live composition in it**".
- K2: a render in the host outside any bracket "is treated as foreign. That costs an idempotent re-render, never
  data." The only guard is a dev assertion (X2).

**Host writes the bracket's stated scope does not cover.**
1. *`compositionstart` in an empty paragraph* is the most common IME start. The session begins, and no document
   change happens until the first preview. The placeholder `$derived` flips and Svelte removes `data-placeholder` in
   its microtask flush, outside any bracket. The observer watches every attribute with `attributeOldValue`
   (`domTextMutationObserver.ts:1542-1555`), so under R12 the record is foreign and is inverted from `oldValue`.
   The placeholder is painted over the IME preview for the whole session, and Svelte, which believes the attribute
   is gone, will not remove it again. Pinned against by `composition.spec.ts:288` ("hides empty-block placeholders
   while IME composition is active"), but only with synthetic events (BI-10).
2. *The readonly toggle* writes `contenteditable` on the host root (`Edytor.svelte:229`), which is inside the
   observed subtree. It is not a command.
3. *Extension view state that changes childList* is the case the plan invites. Its own extension example (a) is a
   toggle whose children collapse. A click on the chevron flips local `$state`, and Svelte removes or inserts the
   children subtree inside the host, with no document change and so no bracket. The observer inverts the childList:
   it re-inserts the removed fragment or removes the inserted one, including Svelte's empty-text fragment anchors.
   The repo already documents the result: removing those anchors "corrupts keyed-each reconciliation — the next
   reconcile walks a fragment whose `end` is no longer reachable and spins forever"
   (`domTextMutationObserver.ts:314-319`). That is a hang, not "an idempotent re-render".

**Why it matters for this lens.** C1 (the editor's own `data-edytor-focused` records cancelling a live IME) is
exactly this class. The plan fixes C1 by naming selection attributes as bracketed, but it creates new members of
the same class (1, 3), and it replaces liveness inference with a guarantee that holds only if *every* host-visible
state write is bracketed. That is a whole-program property, enforced by a dev-only assertion.

**Repair (owner: `surface/observer` bracket API; clarify the requirement).**
- Define host-visible state as any `$state` read by host templates. It is written only through `surface.update(fn)`,
  which is the bracket. Session transitions (`compositionstart`, commit, cancel, the BI-5 tail end), readonly,
  `select()` side effects and extension view state all go through it. Give extensions that primitive in the plugin
  contract.
- Run the dev assertion in CI lanes (DST solo and collab in dev mode, all dom fixtures), so that one unbracketed write
  fails a test instead of a user session.
- Keep one piece of today's liveness knowledge as a hard floor: never remove empty text nodes or Svelte fragment
  anchors during inversion. Fall back to a smallest-unit remount instead.

Add dom rows:
- `compositionstart` in an empty block leaves no `data-placeholder` and no record reaching the classifier;
- a toggle-style snippet with local collapse state, collapsed and expanded three times, leaves zero records reaching
  the classifier and the editor responsive.

### BI-10 (major) The gates chosen for the IME, projector and bracket claims cannot falsify them

**Plan text.**
- §8 puts the IME rows in "dom + browser" lanes: F-I6, F-I8, F-I9, F-I10, F-I11, F-I12, F-O2.
- CP5 makes "F-S10 on three engines plus DST" the **gate for deleting timers**. That covers the Gecko re-anchor, the
  Gecko/Blink clamp, the "Android +1 echo after a model-owned merge" and the "IME post-commit selection jump".
- K3 and U-2 concede that Android and iOS are not in the lanes.
- §8 says "jsdom cannot falsify echo, IME or layout claims" and implies the browser lane can.

**What the browser lanes actually drive.**
- Every composition spec builds its IME sequence with `dispatchComposition` (`tests/editor-dom/helpers.ts:1017-1090`).
  These are script-created `CompositionEvent`/`InputEvent` objects with no default action. No IME exists, the browser
  never mutates the DOM for them, and nothing is aborted by a selection write or a node remount.
- The DST composition action is the same ("events are isTrusted:false", `tests/editor-dst/runner.ts:491-543`;
  `docs/editor-dst.md`: "synthetic composition/clipboard/drop").
- Mobile specs are desktop engines with mobile emulation: UA, viewport and touch points, with desktop editing code.
  Android's post-delete echo and "mutates anyway" behavior are *simulated* by the spec itself
  (`mobile-beforeinput.spec.ts:225-262` writes the drift and then dispatches `input`). A spec that simulates the echo
  cannot prove that a timer-free classifier handles the real one.
- The one real-IME driver in the repo is CDP `Input.imeSetComposition`/`Input.insertText`, in three Chromium tests
  (`mobile-composition.spec.ts:342-470`). No plan gate names it.

**Consequence.** BI-2, BI-5, BI-6 and BI-9 can all ship with every CP6, CP8 and CP9 row green. The CP5 timer deletion
for the Android echo and the IME post-commit jump is gated on reproductions written by the same authors who wrote
the classifier. That is the "observation vs guarantee" confusion (D5) applied to the test plan.

**Repair (owner: §8/§9 gates).**
- Every row that claims IME-node survival, a no-write rule during composition or post-commit behavior gets a CDP-IME
  variant (Chromium desktop, plus the mobile-emulation project) that is a **gate**, not a smoke test:
  - F-I6, F-I8, F-I10, F-I11, F-I12;
  - BI-2's remote-insert row;
  - BI-6's four structural rows;
  - BI-9's `compositionstart` placeholder row.
  Use a second browser context as the peer (the collaboration specs already do this).
- Keep the Android echo and "mutates anyway" handling as named, counted, time-bounded rules until a real-device lane
  exists (the gap analysis already lists "mobile-emulation DST" and real-device qualification as open). Do not let
  CP5 delete them on the strength of desktop emulation. This follows the plan's own rule for unprovable claims
  (K10: "keep it until a real-browser check shows ...").

### BI-11 (minor) Replicated previews let a peer split the region; "the region is two anchors" gives the commit no rule for that

**Plan text.** R8: "a composition is a session whose region is two anchors". D-6 keeps previews replicated, so peers
see them and can edit inside them. F-I8 covers absorbed remote *text* only. §1.3: "the commit replaces exactly the
preview, once".

**Sequence.**
1. A is composing `にほんご` in block B.
2. Peer C, who sees the preview, puts the caret after `にほ` and presses Enter. B's stream now ends at the boundary
   item, and a new block B' starts with `んご`.
3. A's IME commits `日本語`. The region's start anchor resolves in B and its end anchor in B'.

Replacing "exactly the preview" is now a cross-block range. If it goes through `doc/rangeDelete`, merges are governed
by `canMerge`, and the commit silently reverts C's split. If it deletes only in B and inserts there, B' keeps a stray
`んご`, so the text is duplicated.

**Today's behavior.** `resolveCompositionRegion` (`edytor.svelte.ts:295-321`) falls back to the numeric
`regionLength ?? value.length` on the tracked host when the anchors resolve to different wrappers (`:318`). The
delete then clamps at B's end and leaves `んご` in B'. That is the duplication outcome, and no test pins it.

**Repair (owner: `session/composition`).**
- The commit deletes the region's *live preview items* in whatever streams they occupy now. This is a per-stream
  delete (R2's only content-delete path), never a range delete across blocks.
- It inserts the final text at the region start and leaves the peer's structure alone.
- Record the decision, and add a doc row (with a replicated preview and a peer split inside it) next to F-I8.

### BI-12 (minor) Dead-endpoint recovery waits for a mount that view state may never grant

**Plan text.**
- D24/D25: model destination and DOM readiness are separate facts, and a phantom slot is `rendersContent: false`,
  declared per kind (O22).
- The seam rule does "editable descent" over the document alone (§2.4).
- The projector displays "only when the target is mounted" (R10). L22 deletes `deadEndpointRecoveryPending`, and the
  delete contract's "at a settled barrier, `part.node == null` means phantom" disappears with it.

**Sequence (the plan's own extension example (a)).**
1. A toggle block is collapsed. Its children are not rendered, which is view state, not document state.
2. A peer deletes the block holding the local caret. The seam rule descends into the next sibling, a collapsed
   toggle, and picks its first child's text: live, editable by declaration, and never mounted.
3. The value is set and the projector waits. The DOM selection stays wherever the removal left it, and the next
   keystroke is admitted against the model value.

The next keystroke therefore edits invisible content. That is the UNRESOLVED-2 class the delete contract closed
("the caret looked alive but the next keystroke was silently dropped"). No settle barrier ever ends the wait, so
the distinction D24 keeps has no exit.

**Repair (owner: Surface supplies a fact the Document cannot know).**
- `surface` exposes `displayable(blockId)`: mounted and not hidden by view state.
- The seam descent and the caret-stop stream skip non-displayable content. The seam rule stays document-pure, and
  the Surface filter is applied at projection.
- A kind whose children rendering depends on view state declares it (`rendersChildren(data, view)`). Price this into
  the extension-cost claim for (a).

### BI-13 (minor) A pinned segment key survives an atom inserted *inside* the host segment, so the frozen and model renders overlap

**Plan text.**
- §2.4 and O42: segment key = "id of the preceding atom (or `start`); a key pinned by a live composition stays alive
  until the session ends".
- `surface/pin.ts` freezes the base render and splices the preview.
- F-I10 inserts an atom before `@` (a *previous* segment). F-I11 deletes `@` (the key's owner).

**Sequence.**
1. A composes at `ab@cd|` (segment keyed `@`, text `cd` + preview).
2. A peer, seeing the preview, inserts a mention `#` between `c` and `d`.
3. The model re-segments into `@` → `c` and `#` → `d` + preview. The pinned key `@` stays alive with its frozen render
   `cd` + preview, and the new segment `#` renders the model text `d` + preview after the new atom.

For the rest of the session the DOM shows `ab@cd<preview>#d<preview>`: duplicated text, and the atom in the wrong
place. The IME node survives, as F-I10 intends, but the cell renders the same atoms twice. The commit resolves
through anchors and is correct, so the damage is visual until the pin releases. The domPoint interpreter must also
map clicks, drops and copy made during that window against a DOM that contradicts the model.

**Repair (owner: `surface/pin`).** While pinned, freeze the host cell's *segment list*, not only the host key. Change
reports that re-segment the host cell are applied in the catch-up patch at session end (the same mechanism as BI-6
option (a), one level down). Add the sequence as F-I10b.

### BI-14 (major) The single focus predicate has no gesture-location fact, so `body` after an outside click counts as "orphaned" and the projector steals the page's selection

**Plan text.**
- O47: "Focus verdict (foreign control vs orphaned `body`)", decided by one predicate in `surface/projector`.
- D27 keeps "foreign focus" apart from "orphaned focus (`body` after our own remount)".
- R10: the projector writes "never over foreign focus".
- F-S9 checks (a) our render detached the focused node, so write, and (b) the user focused an outside `<input>`, so
  model-only.

**The missing case.** The user clicks *non-focusable* page content outside the editor (a sidebar, the page
background, static text) or drag-selects text there to copy it. Focus is `body` and the document's only DOM
selection is outside the editor. That is the same DOM state as case (a), but it is user-owned.

**Sequence.**
1. The user selects a paragraph in a sidebar to copy it.
2. A peer types in the document, and the remote apply runs the bracket, which ends in `display`.
3. Focus is `body`, so the predicate says orphaned, and the projector writes the editor caret. The document has one
   selection, so the user's sidebar selection disappears, and Firefox also focuses the editor on `addRange`
   (reader-selection §2.1-3).

In an active room the user cannot select text outside the editor. Keystrokes meant for the page, such as page
shortcuts, start landing in the document.

**Today's behavior.** This is guarded by DOM evidence of *where the last gesture landed*:
- `lastUserGestureOutsideEditor` (`edytor.svelte.ts:1316-1325`, set by the document-level capture `pointerdown` at
  `:2091-2100` and by `focusout` to an outside target at `:2157-2170`);
- consumed by the blurred restore (`selection.svelte.ts:2262-2290`) and the observer repair
  (`domTextMutationObserver.ts:968-977`);
- the remote reconcile also skips when the DOM selection "legitimately lives outside this editor"
  (`selection.svelte.ts:2419`).

The requirement is explicit: "repair never steals focus or selection the user moved elsewhere (outside gesture,
nested editable, plugin chrome)" (reader-input §1, item 25). The plan deletes these consumers (L21, L23, L33) and its
one predicate reads only `activeElement`.

**Repair (owner: `surface/projector`, fed by `surface/events`).** The focus verdict takes three inputs, not one:
- `activeElement`;
- the landing point of the last gesture (an outside `pointerdown`, or `focusout` to an outside target), kept until an
  inside gesture or `focusin` returns ownership;
- whether the live DOM selection lies outside the editor.

`body` is *orphaned* only if our own bracket removed the focused node, which the bracket can record because it knows
what its flush detached. Otherwise it is user-owned, and the update is model-only.

Add an F-S9 case (c): an outside non-focusable text selection survives a remote apply in every engine.

### BI-15 (minor) The pin is described for a text segment. The most common IME start, an empty block, begins in a filler node that the first preview swaps out

**Plan text.**
- Segments carry "ZWSP/newline fillers" (§2.4).
- `surface/pin.ts` "freeze[s] the base render and splice[s] the preview while the session owns `host`".
- The F-I rows compose into `Hello|` (F-I6), into a fresh non-empty split block (F-I7), or into segments beside atoms
  (F-I10, F-I11). None composes into an *empty* block.

**Browser fact.** In an empty block the IME composes into the filler text node that holds the caret. Replacing that
node when the model becomes non-empty is the "composition-into-empty-leaf" bug class. The gap analysis lists it as
missing (G8: "Slate's 'don't unmount the text node the IME is creating' rule (the 안녕→ㅇ안녕 bug)"), and G2 rates
the family P0.

**Today's behavior.** `Text.svelte:233-247` renders the filler and the content in different branches
(`{#if text.isEmpty}&#8203;{:else}{#each …}{/if}`). The pinned branch keeps `isEmpty` model-true
(`text.svelte.ts:557-600`), so the first preview switches branches: it removes the node the caret, and the IME,
sat in, during the flush that follows the `beforeinput` listener. The CDP test that composes into an empty first
paragraph passes on its *final* text (`mobile-composition.spec.ts:342`). Nothing asserts node identity or the DOM
during the session, so whether Chromium tolerates the swap (for example by starting its composition in a fresh
node) is unobserved, and WebKit and OS IMEs are untested.

**Repair (owner: `surface/cells` segments + `surface/pin`).**
- Render filler and content through the *same* text node: the node's data is the text, or the filler when empty.
  The empty-to-non-empty transition is then a `characterData` change of one node, which the pin suppresses for
  the session.
- Add F-I15: compose into an empty paragraph (CDP IME), and the host text node before the first preview `===` the node
  after the commit's pin release, with no placeholder attribute during the session (see BI-9).

