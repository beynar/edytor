# Attack: browser-input, revision 2 (compare-to-truth observer, Svelte flush order as the timing hook)

Scope: only the revision-2 delta (`diff scratchpad/arch/plan-final-r1.md docs/archive/architecture-v2/plan.md`, 562 diff
lines). The maintainer's decisions (Option B, Svelte scheduling as the hook, the owned fork) are taken as given; the
findings attack how the plan implements them. Line numbers refer to `docs/archive/architecture-v2/plan.md` unless a file is
named.

## Probes run for this review (no repo file modified)

`scratchpad/arch/r2-attack-probe/` (Svelte 5.55.1 in jsdom, same harness as `rev2-probe`): a root component with a
record-intake MutationObserver (records only name nodes, as L65 says), a root top-level `$effect.pre`, and a root
top-level `$effect` compare pass; each segment's node is written by an attachment that registers it and applies the
r2 write guard (never overwrite a node that differs from what it last wrote).

Run: `npx vitest run --config scratchpad/arch/r2-attack-probe/vitest.attack.config.mts --silent=false` (2/2 pass).

- **B1**: the browser edits an owned node (`hello wrold` → `hello world`), then, in the same task, a synchronous
  commit changes the run's render key (a mark change). Log:
  `mo:1`, `pre:"hello world" dirty=1`, `unregister:"hello world"`, `cmp:"hello world":unregistered:detached`,
  `post:""`, `write:"hello wrold"`, then the record pass. The MutationObserver callback runs first (FIFO microtasks).
  The root `$effect.pre` still sees the edit. The flush destroys the node before the compare pass. The root `$effect`
  runs **before** a writer effect created during the effect phase (`post:""` precedes `write:…`).
- **B2**: drift on an owned node (`hell` → `hel`) plus a same-task model change to that segment (`Xhell`). Log:
  `guard-skip:"hel"(cell "Xhell")`, `invert-to:"hell"`, `post:"hell"`, then `cmp:"hell":registered:last="hell"`.
  A later epoch bump leaves the DOM at `hell` while the cell is `Xhell`.

## Findings (blocker > major > minor)

### 1. BLOCKER: a skipped write is never retried, so inversion and tolerated divergence leave stale text the pass then calls truth

**Scenario (probe B2).** An owned node shows `hell`, and `hell` is also the text last written. The late Android drift
of an already-applied prevented Backspace turns it into `hel`. In the same task a model change to the segment lands:
a second prevented Backspace, or the synchronous commit K2(1) names. The cell becomes `Xhell`.

The steps then run in this order:

1. The MutationObserver callback runs first.
2. The flush's writer sees node ≠ last written and skips (D58).
3. The root `$effect` attributes the drift to the model-owned attempt and inverts it "exactly" to the last written
   text, `hell`.
4. The writer's effect never runs again, because its dependency did not change again.

The DOM now shows `hell` while the cell holds `Xhell`. Every later pass compares `hell` with `hell` and finds nothing.

**Other triggers of the same state:**

- (a) R6's limit and K2's fallback put unclassifiable divergences on a "tolerance list" (lines 1277, 1354). With the
  guard, a tolerated node never receives another model change. Decision 1 allows only the live IME preview as a
  tolerated divergence.
- (b) Read-only mode ignores text divergence (R12, line 150). A node that a foreign script rewrote stops rendering
  remote edits for good, and after a readonly flip back (F-P17 (b)) nothing revisits it.
- (c) A deferred divergence (attempt open, `expect … | unknown`, L6) whose node no new record names.
- (d) The composition hand-back, when "the base the session accounted for" (line 558) differs from the live node.

**Consequence.** The DOM silently differs from the model. The projector maps cell offsets into a node of a different
length, and the next browser-owned input is diffed against a stale base. Nothing repairs this: O67 (line 440) makes
the compare pass the only out-of-sync detector, and L39 (line 685) deletes the remount.

**Evidence.** Probe B2. Svelte effects re-run only when a dependency changes; Svelte's own writer
(`render.js:46-55`) would have written, but the r2 attachment writer does not. F-I19 (line 1053) and F-O13
(line 1120) assert model effects only.

**Repair.**

- Inversion writes the cell's current projection, not the last-written text, and resets the last-written text.
- A guarded skip marks the node render-dirty, and the pass re-runs the writer once the divergence is resolved.
- No tolerated text divergence outside the live IME host.
- Add F-O13 (d): drift inversion plus a same-task model change.
- Add an F-O10 invariant: after settle, every registered node equals its cell's current projection, not only its
  last-written text.

### 2. BLOCKER: structural divergence is either own-render noise or invisible

The plan compares "strict child lists (text and mark elements) against registered nodes and anchors" (lines 563,
579), and a node is registered only "by the attachment that first writes it" (line 578).

**(i) Mark snippets.** Bold renders `<span data-edytor-mark="bold"><b>…</b></span>`. The `<b>` is the mark record's
snippet output (`RichTextPlugin.svelte:231-296`, rendered at `Mark.svelte:34-36`). No attachment writes or registers
it, so the editor's own `<b>`, `<a href>` and `<span style>` count as divergence after every flush that renders a
mark. If snippet elements are skipped as transparent instead, the pass cannot see:

- Chrome's re-nested `<a>`/`<b>` (`dom-mutation.spec.ts:708`)
- cloned mark wrappers (`dom-mutation.spec.ts:854`)

**(ii) Root and block level.** Root and block child lists are tolerant. An Android non-cancelable Enter appends the
browser's `<div>` to the root (`mobile-beforeinput.spec.ts:351-354`; misreported Backspace `:406-409`), and the specs
require it gone (`:1373`, `:1346`). Under the plan it survives, with the duplicated text visible.

**(iii) DST foreign mutations.**

- `insertForeignElement` at block or root level (`tests/editor-dst/runner.ts:748-760`) must not survive
  (`browserState.ts:2205-2215`, `foreign-element-survived`).
- `removeElement` of a block or atom must be restored (`generator.ts:77-78`).

**Why nothing handles (ii) and (iii) any more.** Today they rely on:

- `restoreRemovedManagedNodes` and `removeAddedUnmanagedNodes` (`domTextMutationObserver.ts:679-745`), which need
  each record's `removedNodes`, `addedNodes` and siblings. L65 (line 674) reduces records to "the nodes to compare".
- The `{#key}` remount that WebKit's dropped root sibling still needs (`cross-browser-confidence.md:92-96`;
  `hotkeys.ts:211, 236`). L39 deletes it.

R7's gate (line 1278) lists DST `foreignMutation` on three engines and the `dom-mutation.spec` foreign-damage specs,
so R7 cannot close as specified.

**Repair.**

- Declare the expected child list per container. The root and the core-rendered content and children slots are
  strict against registered block elements plus anchors.
- Mark records declare an `element` the core renders and registers, or the core passes a registering wrapper into
  the mark snippet.
- Snippet markup outside the slots stays tolerant only through a recorded §11.2 decision that also changes DST's
  oracle.
- Keep record-level `addedNodes`/`removedNodes` and siblings for strict containers.
- Re-budget: about +60 to +100.

### 3. MAJOR: "wait for the flush, then diff" loses browser input when that flush removes or re-keys the node

**Scenario (probe B1).** A browser-owned edit (autocorrect, or Android `insertText`) changes an owned node. In the same
task, a synchronous commit changes that run's render identity:

- a mark change on the run
- deleting the atom that keys the segment (segment key = preceding atom id, O47)
- a retype that changes `element(data)`
- D-20's structural change

The flush unregisters and destroys the node, and the compare pass finds it detached. Nobody adopts the edit, which is
now gone from the DOM and never reached the model. The root `$effect.pre` did see the edit (`pre:"hello world"
dirty=1`).

Revision 1 handed pending records to the observer before applying the change (`plan-final-r1.md:130`); revision 2
dropped that step. K2(1) (line 1354) names this exposure and says "the writer's guard keeps the node". The guard only
covers rewrites. F-O13 (a) and (b) test only a remote *insert*, so the loss would be silent.

**Repair.**

- Resolve dirty registered nodes in the root `$effect.pre` (decision 2 allows it), with base-relative adoption, or
  snapshot their text and anchored position there.
- Teardown of a divergent node hands `(last written, DOM text)` to the observer instead of dropping its registry entry.
- Add F-O13 variants: mark change, atom deletion, retype, move, and a split before the edited run.

### 4. MAJOR: comparing text one node at a time misreads browser splits and multi-node edits

**Scenario.** `splitManagedTextDomTextNode` (`dom-mutation.spec.ts:299-341`, test at `:655-706`) splits `Alpha`
inside a mark. The registered node becomes `Al`, and an unregistered sibling `pha` appears. The logical text is
unchanged; the spec expects the model unchanged and one text node.

Comparing each node against its last-written text (O58, O59; lines 431-432, 579-580) sees "delete `pha`". The outcome
depends on the unattributed policy:

- If the location rule adopts it, as DST's oracle does for in-text foreign text (`browserState.ts:2192-2197`), `pha`
  is deleted from the model, and the unregistered node is then removed as child-list divergence.
- If the rule inverts it, legitimate browser-owned edits that touch two nodes are reverted or never match the
  per-host attempt expectation (`expect: {host, …}`, L6, line 279). Examples: a node the browser removes whole (its
  data is unchanged, so there is no text divergence), or a replacement across a mark boundary.

Today's reconcile diffs the whole text element: `cross-browser-confidence.md:57` states the rule as "logical text
content is unchanged".

**Repair.**

- Compare per owned text element: the DOM text in document order over registered, unregistered and detached nodes,
  fillers stripped, against the concatenation of their last-written text.
- Equal logical text means a structural re-render only.
- Otherwise run one base-relative diff per element, matched against that host's attempt queue.

### 5. MAJOR: the timing hook is only half specified, and the §1.1 ordering claim is too strong

**(a) Record-only changes have no named trigger.** The root `$effect` reads the render epoch (O55, line 428). Browser
input makes records but no state write, and the plan never names what the MutationObserver callback writes (K2(2)
only says "one extra microtask flush").

- If it bumps the render epoch, every foreign or browser record looks like a render to the classifier, and a selection
  set by assistive tech or the host app without a gesture is reverted as drift (C4, D26).
- If it bumps nothing, browser input is never compared.

**(b) Effect-phase writes land after the compare and display.** Probe B1 shows `post:""` before `write:"hello
wrold"`. Effects created while `collected_effects === null` go to the next batch (`effects.js:128-135`;
`batch.js:290, 324, 349`), and the root `$effect` does not re-run there without an epoch bump. So "runs after every
DOM write of the flush … attachment writes included" (lines 124-128) holds for template effects and attachment bodies
only, not for nested `$effect`s or state written during the effect phase. The display can target nodes not yet
written, and a dedupe keyed on the model range then skips the fix.

**(c) K2's claim is wrong.** K2 says a missed bump "misclassifies a selectionchange, never a DOM change". A child-local
state flip that re-renders host content skips the compare, the focus note and the display for that flush.

**(d) Deadlines have no trigger.** Deadlines (R8; the model-owned drift deadline in rule 5) have no named way to
re-run the compare for deferred divergences. At expiry, drift that outlived its attempt is adopted by the location
rule, so the prevented Backspace is applied twice.

**Repair.**

- Add a `recordsVersion` signal, written by the MutationObserver callback and by deadline expiry, that the root
  `$effect.pre` and `$effect` read and the classifier does not.
- Restrict host writers to template effects and attachment bodies (lint), or queue the compare and display as a
  microtask from the root `$effect` so they follow chained batches.
- Extend the r2 probe to nested effects, effect-phase state writes, re-keyed nodes and a flush with no epoch bump.
- State the unattributed-divergence policy per host.

### 6. MAJOR: the composition host goes back to the compare pass at session end, while the plan says the browser keeps authority through the tail

**Where the plan contradicts itself.** The pin and observer rows hand the host back "at session end" (lines 558, 563,
579). §2.3 (line 318) keeps a tail "because the browser's authority over the IME node outlives the commit".

**WebKit's early commit.** WebKit sends `insertFromComposition` before `compositionend` (`composition.spec.ts:662-727`;
`cross-browser-confidence.md:52`). The session ends in that `beforeinput` listener, so the catch-up write and
hand-back run in the microtask checkpoint before WebKit's default action and before `compositionend`. The default
action then lands on a node the pass owns.

**Firefox's trailing input.** Firefox's trailing composition `input` with DOM drift (`composition.spec.ts:896-975`,
expected `に` not `にに`) lands after the hand-back.

**Attribution.** R12 and O59 attribute only by "the open attempt's expectation". O34 lists observer attribution only
as a consumer, and the tail is not an attempt. Unattributed in-text changes are adopted, which reopens BI-5.

**D-20's forced commit.** It hands the node back while the IME is still composing, so every later `compositionupdate`
becomes a divergence to invert or adopt.

**The accounted base.** "The base the session accounted for" is not defined against the live node. If it comes from
`compositionend.data` (`cross-browser-confidence.md:42`) and the DOM differs, the guard skips the catch-up (finding 1).
F-O2 covers only the live session.

**Repair.**

- Keep the host excluded until the tail ends.
- Make the tail an explicit expectation source that resolves late changes to the cell's current projection.
- Define the hand-back as setting the last-written text to the live node text read at hand-back.
- Add a cdp row for IME updates that continue after a D-20 forced commit.

### 7. MAJOR: the r2 observer re-budget omits the mechanisms above, and the confident case with cuts has a 55-xloc margin

The re-budget (lines 568-586) is 990 − 145 + 115 = 960. Findings 1-6 need:

| Mechanism | xloc |
|---|---:|
| Pre-write resolution and teardown hand-off | +15 to +25 |
| Per-element aggregation | +30 to +40 |
| Render-dirty retry | +10 to +15 |
| Records signal and deadline re-trigger | +10 to +15 |
| Tail attribution and hand-back at tail end | +10 to +20 |
| Strict root/slot containers, mark-snippet registration and record-level childList inversion | +50 to +80 |
| **Total** | **≈ +125 to +195** |

The observer would land at ≈1,085-1,155, above revision 1's 990.

"Confident, with D-24's proposed cuts: 17,404 (−40.2 %)" (line 894) is 55 xloc under the 40 % line (17,459). The
statement "D-24's proposed cuts close it" (line 900) therefore fails even at the low estimate. The +100 Option B
residuals (line 878) pay for other items.

**Repair.** Re-budget line by line and restate the confident band and D-24.

### 8. MINOR: the filler and the placeholder under the compare pass

The first browser-owned character in an empty block leaves `​a` in the "filler and text in one node" design
(line 555). The writer then assigns `data = "a"`. The DOM replace-data rule moves a caret at offset 2 to offset 0, so
every first character forces a display write during Android typing (the snap-back class).

Diffs must also treat filler-only differences as equal. An engine or IME that replaces or deletes the ZWSP otherwise
produces a phantom one-unit edit. F-I15 checks only node identity and the attribute.

**Repair.** The writer splices with `deleteData`/`insertData` instead of assigning `data`; fillers are stripped on
both sides of every diff; add an Android first-character row.

### 9. MINOR: F-O10's oracle needs the per-write provenance the design dropped

F-O10 (line 1117) needs "a test-side log of who wrote each host node" on DST and every dom fixture. In the
real-browser lanes the browser writes natively, and Svelte's writes are not bracketed. The plan names no
instrumentation, for example patching the `Node`/`CharacterData` mutators with flush-scoped tags, and no cost, so R7's
F-O10 gate cannot be falsified where browser writes occur.

**Repair.** Specify and budget that instrumentation with the G0 spies.
