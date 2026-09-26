# Adversarial review: feature-parity lens (plan-v1)

Status: complete (12 findings: 1 blocker, 7 major, 4 minor). Summary and checked-and-held claims at the end.

Target: `scratchpad/arch/plan-v1.md` (1,318 lines, read in full).
Method: enumerate guaranteed behaviors from the allowed contract docs
(`docs/editor-delete-contract.md`, `docs/crdt-v14-selection.md`,
`docs/crdt-v14-document.md`, `docs/manual-*.md`, README, AGENTS.md), the demo route and the
DOM / DST / e2e tests; for each, check whether a plan rule, module or checkpoint still
guarantees it, and quote the plan text that fails it. Excluded docs (plans, proposals,
reviews, handoffs, prompts) were not opened. The scratchpad `arch-*.md` proposals were not
opened either (they are other sessions' architecture opinions).

## Suspicions and their disposition

- S1 undo coalescing policy → **FP-2** (confirmed: today's rule is "cut before", pinned both ways).
- S2 previews that bypass undo → **FP-3** (confirmed from the vendored UndoManager).
- S3 fresh-id seeding → **FP-1** (confirmed; worse than suspected: ids of every `value` seed).
- S4 readiness bound blocks offline-first typing → dropped: today the view already renders only once `synced`
  (`Edytor.svelte:221`), so the bound is not a new wait.
- S5 non-model nodes in the host → **FP-4 / FP-5** for browser-mutated or view-state nodes; static native controls in
  voids (`ImagePlugin.svelte` input/button) produce no mutation records and are not a finding.
- S6 declared `rendersContent` → **FP-9**.
- S7 one seam rule for every cause → **FP-7**.
- S8 prefix/suffix-only adoption → dropped: the pinned mark-preservation specs (`dom-mutation.spec.ts:547, 596`) are
  single-region changes that prefix/suffix handles.
- S9 product timers → dropped: plugins and presence use only positioning frames besides the mention restore the plan
  deletes on purpose.
- S10 non-browser HTML import → dropped: the HTML plugin is not exported.
- S11 overlay handles → not raised: alignment and nested scroll are disclosed (K9) and gated by browser lanes.
- S12 markdown shortcuts → not raised: the multi-prefix / per-level data is expressible as a table in the kind record.

---

## Findings (verified against source; ranked blocker > major > minor)

### FP-1 [blocker] R13 "seed only under fresh ids" destroys caller-id preservation of `value`, and the plan's no-overwrite claim silently depends on that loss

**Plan text that fails.** R13 (plan-v1.md:155): "A document seeds content only when it is empty, only after every
attached provider has settled or its bound has elapsed, and only under fresh ids [DF]." Repeated unconditionally in O17
(:358 "seed with fresh ids"), L56 (:653 "seeds under fresh ids, so a seed can never overwrite room content") and D-3
(:1268). No row says caller-supplied `value` ids survive.

**Guarantee today.** `document.sync(value)` seeds `value.children` through `jsonBlockToSpec`, which "keeps caller ids
and mints missing ones (`freshIds` stays false — concurrent same-id inits dedupe)" (`src/lib/crdt/document.ts:636-640`);
`init` documents "Initial content may be supplied as spec blocks; concurrent inits with identical ids dedupe the same way"
(`src/lib/crdt/edytor-doc.ts:37-45, 690-693`). JSON round-trip with ids is a stated property (README "Readable JSON data
structure", `JSONBlock.id?`; runtime reader G1/G3), and the headless contract documents it literally:
`createDocument({ value: { children: [{ type: 'paragraph', id: 'p1', … }] } })` then
`document.facade.project().children` → `{ id: 'p1', … }` (`docs/crdt-v14-document.md:55-67`); `attachSync(…, { value })`
seeds the same way (`:139-157`).

**Concrete scenarios.**
1. Demo route, no provider: `value={demoValue}` carries ids `page-title … page-end` (`src/routes/+page.svelte:84-172`).
   Under R13 they are replaced on every load. `demoPagePlugin.onBlockAttached` builds deep-link anchors `#block-<id>` and
   the block menu's "Copy link" writes that URL (`+page.svelte:28-40, 253-264`): every copied link is dead after reload.
   Browser specs address these ids directly (`demo-route.spec.ts:90-127` `[data-edytor-id="page-toggle"]`,
   `demo.spec.ts:155-181`, `handle-alignment.spec.ts:14`): all fail.
2. A consumer that persists `onChange` JSON and re-mounts it as `value` gets new ids every session (comments, links,
   analytics keyed by block id break).
3. Two fresh clients open an empty room with the same template `value` (with ids): today they dedupe to one copy; under
   R13 they union to two copies. The plan's own §1.3 row "Opening a room never duplicates … its content" and F-T4
   "nothing duplicated" only hold if the room's state arrives before the bound; on a connection slower than the bound the
   template is seeded under fresh ids and then unioned with the room's content.

**Why it is a blocker, not a wording fix.** Restoring caller ids re-opens exactly the overwrite path the plan used fresh
ids to close (L56 deletes the settle window and poll on the strength of "a seed can never overwrite room content"): a late
seed after the bound elapsed writes registry entries under the same ids as the room's blocks, and concurrent map-attr LWW
can then replace the room's edited block with the template's. The plan has to choose, explicitly, between id
preservation and bound-based seeding; today it deletes the mechanism while quietly dropping the guarantee.

**Repair.** Split R13 into two facts with two owners: (a) *what* is seeded keeps caller ids (parity); (b) *when* a
caller-id seed may run is gated on a positive emptiness proof from every provider (no bound-elapsed seeding for caller-id
content), while only the id-less default paragraph may use bound-elapsed + fresh ids. Add falsification rows for the demo
ids, the JSON id round-trip and the slow-network template race.

### FP-2 [major] "Text insertion coalesces, everything else cuts" breaks the pinned delete-then-type undo step (and contradicts F-U8)

**Plan text that fails.** `session/commands.ts` (plan-v1.md:501): "undo policy (text insertion coalesces, everything else
cuts)"; CP4 contract (:1092): "one undo step per command (existing history fixtures)"; §1.3 "One user action is one undo
step". F-U8 (:905) simultaneously requires "typing, then a browser-owned deletion within `captureTimeout` (one merged
step)", i.e. a deletion that does *not* cut.

**Guarantee today.** Deletes, pastes, drops and paragraph splits cut *before* the command only
(`src/lib/events/onBeforeInput.ts:539-549` called at :700 and :708 before dispatch); Enter additionally cuts after
(`beforeInputCommands.ts:584-586`). Typing that follows a delete inside `captureTimeout` therefore joins the delete's
step. `tests/editor-dom/history-coalesced-range.spec.ts:14-58` pins it: type `.` with code mark, select it, Delete, type
`!`, Mod+Z → value is `[{text: '.', marks: {code: true}}]` and the selection is the forward range 0→1.

A second spec pins the other half: `tests/editor-dom/input.spec.ts:1023-1105` ("keeps browser-owned deletion with empty
follow-up inputType as a separate undo step") types `!` natively, deletes it natively, and expects `historyUndo` to
restore `lead!` — so the premise of the plan's F-U8 ("typing, then a browser-owned deletion … one merged step") is the
opposite of pinned behavior, and F-U8 cannot be constructed under the plan's own "everything else cuts" either.

**Scenario under the plan.** Delete (non-insertion ⇒ cut) and `!` (new command ⇒ new step): Mod+Z removes only `!`, the
document stays empty, the range is not restored — the spec fails. If instead "cut" means "cut before only", F-U8 is
satisfied but "one undo step per command" and G12 are false as written.

**Repair.** State the policy as today's observable rule (cut *before* structural/delete/paste/drop commands, cut *after*
paragraph split, coalesce following insertions within `captureTimeout`), keep `captureTimeout` as the documented option
(`createDocument({history: {captureTimeout}})`, `crdt/document.ts:203-208`), and add history-coalesced-range as a CP4
contract row.

### FP-3 [major] Composition previews that "bypass undo" make undo resurrect the IME preview and lose a replaced selection

**Plan text that fails.** R8 (:150) "Its preview writes are mechanical: they bypass hooks and are never an undo step";
§2.4 categories table (:320) and D-6 (:1271) "mechanical writes that bypass hooks and undo"; `session/composition`
"`commit` (one user-origin command …)"; R7 "It then runs exactly one transaction".

**Engine mechanics.** On undo the vendored UndoManager re-integrates every item deleted by the popped step that was not
inserted by that same step (`src/lib/crdt/vendor/yjs/src/utils/UndoManager.js:84-96`, "Never redo structs in
stackItem.insertions"). Preview atoms inserted by an untracked origin and deleted by the tracked commit are therefore
restored by undo.

**Today.** Preview writes are ordinary tracked text ops (`beforeInputCommands.ts:167-214`: `deleteAt` + `insertText`
under the editor transaction), so preview inserts and their replacement land in the same captured step and undo removes
the committed text cleanly.

**Scenarios under the plan.**
1. Compose `nihon` (preview `にほん`), commit `日本`, Mod+Z: the commit's step deletes `日本` and re-integrates the preview
   atoms `にほん`, which replicate to peers; because they were inserted untracked, no later undo can remove them.
2. COMP-02 (`manual-editor-behavior-checklist.md`, "Composition over same-block selection"): select `hello`, compose
   `に`, commit, Mod+Z. If the first preview replaces the selection (as today, `replaceSelectionBeforeTextInsertion`,
   `beforeInputCommands.ts:175-178`), that deletion is an untracked mechanical write and undo cannot bring `hello` back:
   data loss.

**Repair.** Either keep previews tracked and have the commit own the step (dispatcher merges the preview's writes into
the commit's step and cuts around it), or define the commit as reusing preview atoms, and state where the selection
replacement is written. Add undo-after-commit and undo-after-selection-replacing-composition rows to CP6.

### FP-4 [major] R12 brackets only document changes, but pinned features render into the host from other state (native `<details>`, the readonly prop, plugin attach hooks)

**Plan text that fails.** R12 (:154) "Document changes render inside a bracket … Every record that reaches classification
was therefore made by the browser or by a foreign script"; R11 (:153) "Every node inside the contenteditable host is model
text or core-rendered structure whose presence is a pure function of the model"; O52 (:403) every classified record is
adopted or inverted by location and attempt owner; L33 (:615) "attribute spec tables and healing (297 → 15)"; CP9 (:1162)
the bracket "wraps commands, remote applies and history". §10(a) (:1226) even treats "a toggle" as a hypothetical new
kind, although one ships today.

**Guarantee today.** The observer distinguishes owned from unowned attributes per element: block elements are
non-strict ("only the structural identity attributes are restored; the rest of the surface stays plugin-owned",
`src/lib/events/domTextMutationObserver.ts:1137-1152`), and the root's `contenteditable` is healed *to the current
`readonly` value* (`:1351-1366`). That table is what lets three pinned behaviors coexist with foreign-damage healing
(`dom-mutation.spec.ts:906, 962, 1008, 1045, 1276`):
1. **Native toggles.** `RichTextPlugin.svelte` ships `details` and `toggle` kinds rendered as
   `<details><summary>content</summary>children</details>`; clicking the summary makes the *browser* toggle `open` inside
   the host. Pinned: `demo-route.spec.ts:90-127` (open `page-toggle`, then type / Enter in its child),
   `demo.spec.ts:155-181` (drop into the closed toggle, open it, child renders below), `block-handles.spec.ts:159-186`.
2. **Runtime readonly flip.** Toggling the prop re-renders `contenteditable`/`aria-readonly` on the host root from view
   state, not from a document change. Pinned: `features.spec.ts:221-224` (and back at :301), `handle-alignment.spec.ts:185`.
3. **Plugin attach hooks.** `onBlockAttached` hands plugins the block element (the demo writes `node.id` for deep links,
   `src/routes/+page.svelte:28-40`). Today any attribute a plugin writes on a block element, at attach time or later from
   its own listeners, is tolerated by the non-strict spec; under R12 only writes that happen to land inside a bracketed
   flush survive.

**Scenario.** Click the `page-toggle` summary, or click the demo's `toggle-readonly` button. Neither is a command, remote
apply or history step, so its records reach the classifier. Without the owned/unowned table (L33 keeps 15 of 297 lines),
the classifier either inverts them (the toggle never opens; readonly cannot be switched) or ignores attribute records
wholesale (the five heal specs fail). R11 forbids `open` outright, since it is not a function of the model.

**Repair.** Keep a declared per-element attribute ownership table (identity attributes owned, root `contenteditable`
owned *by the view's readonly state*, declared view-state attributes such as `open` unowned), and bracket every
view-state render (readonly, selection attributes, placeholder, suggestions), not only document changes. Add these
three scenarios to §8 and to the CP9 contract.

### FP-5 [major] Inline text suggestions ("AI copilot ready") have no owner, violate R11, and render outside every bracket

**Plan text that fails.** §2.2 (:263) "Nothing else is stored as truth"; `select()` side effects (O25, :371) list
"focused/selected sets + hooks + attributes … one `onSelectionChange`, presence publish" and no suggestion rule; R11/R12
as above. The plan's only coverage is `surface/suggestions.ts` (25 xloc, "view objects") and a CP9 exemption fallback.

**Guarantee today.** README Features: "AI copilot ready: Support inline text suggestions for ai completions";
"[x] Text suggestions". `block.suggestions` is per-view `$state` (`src/lib/block/block.svelte.ts:247-275`), settable by
plugins and hosts, rendered inline inside the host after the block's content (`src/lib/components/Content.svelte:37-45`,
`data-edytor-text-suggestion`), cleared when the selection leaves the block (`selection.svelte.ts:1943-1947`), accepted by
Tab / cleared by Escape in code lines (`hotkeys.spec.ts:1618, 1670`; `plugins.fixtures.tsx:166-203`), kept alive through
a composition at the suggestion boundary (`composition.spec.ts:321-372`), and never resurrected once dismissed
(`adversarial-wave3.test.tsx:290-313`).

**Scenario.** An AI plugin sets a suggestion asynchronously (no command, remote apply or history step is running). Svelte
flushes the ghost span into the host outside any bracket; R12 classifies it as foreign and inverts it (or the dev
assertion fires). Moving the caret to another block no longer clears it because nothing owns that rule.

**Repair.** Add suggestions to §2.2 as per-view replaceable state owned by the Session (value + block id + clear-on-leave
rule inside `select()`), render them through the bracket (a suggestion change is a render input like a change report), and
add rows for set-async, leave-block, Tab, Escape and composition-at-boundary.

### FP-6 [major] The documented interception contract (every operation, payload replacement) changes, and §11.3 still claims parity

**Plan text that fails.** D-10 (:1275) "Hooks see the user-level command once, before its transaction; nested sub-steps
are not intercepted"; L5 (:255) the command value is "immutable admitted meaning"; F-M2 "the range delete's sub-steps do
not consult hooks". K5 (:1254) records the nested-step change as a plugin-API risk, but §11.3 (:1300), which lists "the only proposed scope cuts
and contract changes", omits D-10, and no section mentions that hooks can no longer replace the payload.

**Guarantee today.** README plugin table: `onBeforeOperation` "Called before any operation is executed — Validating table
cell merges before they happen"; the typed contract returns a replacement payload
(`src/lib/plugins.ts:88`: `(payload: C) => C['payload'] | void`; runtime reader G22 "the first non-void return replaces
the payload"). Pinned: `src/tests/fixtures/model/operations/pipeline.fixtures.tsx:99-125` ("lets onBeforeOperation
normalize the grouped-move payload … the retargeted path lands"). In-repo plugins depend on it: code auto-pair mutates
`payload.value` (`CodePlugin.svelte:117-133`); the link-edge rule returns a new payload whose marks depend on whether the
DOM caret sits inside the `<a>` (`RichTextPlugin.svelte:98-127`); the code plugin vetoes the nested `mergeBlockForward`
of an empty block before a code block and replaces it with `mergeBlockBackward` (`CodePlugin.svelte:103-110`).

**Scenarios.** (1) The retarget fixture: the hook's returned `{path:[3]}` is ignored → wrong order. (2) `[p "a", p "", code >
[codeLine "x"]]`, caret in the empty paragraph, Delete: the forward ladder calls `mergeBlockForward`
(`beforeInputDeleteCommands.ts:80-96`), the code hook vetoes it and merges the empty paragraph backward, so it disappears;
under D-10 the ladder's merge is not hooked, so the replacement never runs; `canMerge` refuses the island merge and the
result is whatever the new ladder does with a refused merge (the delete contract has no row for it; most likely a no-op). (3) A "protected block" plugin that
vetoes `removeBlock` can no longer stop a range delete from removing it (the README use case).

**Repair.** Either list D-10 and "no payload replacement" in §11.3 with migration notes (and rewrite the retarget fixture
and the code plugin's Delete rule as explicit rows), or keep a pre-transaction
*plan* phase in which hooks see (and may veto or rewrite) each planned sub-step before the single transaction runs; that
keeps "consulted once, before any write" without dropping nested interception.

### FP-7 [major] "One seam rule for every cause" moves the caret after a local block-selection delete or cut

**Plan text that fails.** §2.4 seam row (:303): "Seam of a vanished endpoint … the replicated slot `{p, r}` of the
topmost dead ancestor … projection (remote delete, redo, cut, block-set delete — one rule)"; L25 (:602) retires
"`getClosestUnselectedBlock` + `blockToFocus`" so that "a vanished endpoint lands at its block's replicated slot, with the
same answer for every cause". This contradicts the plan's own D23 (:727) "Result selection of a local command vs
anchor-following for changes this view did not author".

**Guarantee today.** Two different, intentional rules:
- remote deletion (`sel.seam.next-sibling`, `docs/editor-delete-contract.md` "Selection recovery on the passive peer"):
  the sibling that slid into the dead index, at offset 0; the previous sibling's end only when the dead block was last;
- local block-selection Backspace/Delete and cut: the closest *previous* unselected block, caret at the end of its first
  editable text; the next block only when there is no previous one (`src/lib/selection/replaceSelection.ts:133-143`,
  `hotkeys.ts:680-695`, `onCut.ts:20-27`). Pinned: `tests/editor-dom/hotkeys.spec.ts:955-993` — select block `[1]` of
  `['First block', 'Marked middle', 'lead @ tail']`, Backspace → caret in `[0]`.

**Scenario under the plan.** The same Backspace resolves through the slot rule: `lead @ tail` slid into index 1, so the
caret lands at `[1]@0`; the spec's `startBlockPath: [0]` fails, and cut (CLIP-07) moves the same way.

**Repair.** Keep the local rule as the block-set delete/cut command's *result selection* (R7 already lets a command
return its selection) and use the slot rule only for endpoints this view did not author; add the hotkeys.spec case and a
cut case to the CP5 contract.

### FP-8 [major] A static `inclusive: false` link edge reverses the pinned "type inside the trailing anchor edge extends the link"

**Plan text that fails.** O27 (:373) fixes one order for every channel: "explicit → pending → common-of-replaced →
neighbour before, else after → mark edge policy"; O58 (:414) / §10(b) (:1227): "`inclusive: false` covers non-inclusive marks; the link
edge uses the same field plus a boundary hook"; §4 prohibition "`session/` never touches the DOM".

**Guarantee today.** The rich-text hook keeps the link when the DOM caret sits *inside* the `<a>` at its trailing edge
and drops it when the caret is outside (`RichTextPlugin.svelte:98-127`, `isInsideLinkMark(selection.state.startNode)`).
Pinned three times: `src/tests/fixtures/dom/plugins.fixtures.tsx:22-70`, `tests/editor-dom/plugins.spec.ts:22-58`,
`tests/editor-dom/input.spec.ts:480-512` — caret at `Link|` inside the anchor, type `!` → `Link!` fully linked, then
` tail`.

**Scenario under the plan.** `marksForInsertion` picks the link from the neighbour before, then the edge policy of a
non-inclusive link strips it: result `Link` + `! tail`, all three pins fail. The only information that distinguishes
the two cases is a DOM fact the Session may not read, and the plan names no place where the Surface records it.

**Repair.** Make the side of the insertion point part of the anchored target at admission (the DOM point interpreter
already knows whether the point is inside the mark element), and let the edge policy consult that side instead of
being unconditional. Add the three pins to the CP4 contract next to F-P4.

### FP-9 [minor] Declared `rendersContent` replaces an automatic observation without enforcement

**Plan text.** O22 (:363) "Phantom content slot … adopted semantics `rendersContent` (declared by the kind record)"; D25
(:729); K5 does not list the new obligation for extension authors.

**Guarantee today.** A phantom is detected from mount state at a settled barrier, so any snippet that never renders
`content()` is skipped as a caret destination automatically (`docs/editor-delete-contract.md` "Selection ownership and
lifecycle": "At a settled barrier, `part.node == null` means phantom"; AGENTS.md "container phantom slots must stay
skipped"; runtime reader G16). The README's block-definition table has no such field, and snippets may render content
conditionally.

**Scenario.** A consumer kind `columns` whose snippet renders only `children()` and does not declare
`rendersContent: false`; a peer deletes the block holding the caret; the seam walk lands on the `columns` content slot,
which never mounts, and the next keystroke goes into invisible text — the UNRESOLVED-2 defect the contract records as
fixed. The same happens for a snippet with `{#if data.showTitle}{@render content()}{/if}`.

**Repair.** Keep the declaration but verify it: a dev-mode check at a settled barrier that a kind declared
`rendersContent: true` actually mounted its slot, and fall back to "not a destination" when it did not.

### FP-10 [minor] Several documented plugin and API surfaces have no owner or placement in the plan

Not declared removed (absent from K5 :1254, D-15 and §11.3), not assigned to any module:
- `onBlockAttached` / `onTextAttached` / `onEdytorAttached` (README plugin table; `plugins.ts:101-105`). The demo's
  deep-link plugin uses `onBlockAttached` (`+page.svelte:28-40`); block handles, toolbar and slash menu use
  `onEdytorAttached` (`blockHandlesPlugin.ts:179`, `toolbarPlugin.ts:45`, `slashMenuPlugin.ts:89`).
- `onBeforeInput` with the raw `InputEvent` (README "Converting markdown shortcuts as you type"; `onBeforeInput.ts:630`),
  which conflicts with L28 "nothing downstream re-reads the DOM event"; the rich-text native-format mapping that
  `format-beforeinput.spec.ts` pins (9 tests) runs through it.
- `onDeleteSelectedBlocks` (`hotkeys.ts:674`), plugin `commands: EditorCommand[]` with `isEnabled` / async `run`
  consumed by the slash menu (`SlashMenuController.svelte.ts:44-50`; the demo registers `block.code`), `MarkDefinition.void`
  (`Mark.svelte:28-31`), `use:block.void` non-editable regions (code block header, which the handle aligner queries at
  `blockHandlesPlugin.ts:40`).
- The block-definition `transformText` hook (README block-definition table; `plugins.ts` BlockDefinition) is not a field of
  the O57 kind record, although the code plugin's token rendering depends on it and L62 retires `decorateRuns`.
- `edytor.moveBlocks` returns "the blocks actually moved" (README; `pipeline.fixtures.tsx:176` for `edytor.moveBlocks(request)`), while F-O6 treats its
  result as `{status}`.
- D-8's placeholder function has no stated argument shape; the demo shows the placeholder only on the focused block
  (`+page.svelte` `{#if block.focused}`), which needs selection state, not an id-only handle.

**Repair.** Add each surface to K5 (with its replacement) or to a module row; for `onBeforeInput`, state whether it runs
before admission (and can therefore still claim the occurrence).

### FP-11 [minor] Read-only editors today ignore foreign DOM mutations; the plan's classifier would revert them

**Plan text.** R12/O52: every record not produced inside a bracket is classified and adopted or inverted; there is no
read-only branch.

**Guarantee today.** The observer's flush returns early while read-only (`domTextMutationObserver.ts:1603-1605`; input
reader guarantee A.8 "the observer ignores DOM mutations while read-only rather than healing them"). README pitches
read-only as the way "to lightweightly render static content".

**Scenario.** A read-only document viewed with an annotation or highlighter extension that wraps text in its own
elements: today the wrappers stay; under the plan there is no open attempt, so the records are "foreign" and are
inverted (the annotation disappears, and the extension may re-apply it in a loop).

**Repair.** State the read-only policy for the observer explicitly (ignore, or heal only owned attributes) and add a row.

### FP-12 [minor] The operator-facing migration API changes shape without being declared

**Plan text.** O67 (:428) "attempt = `navigator.locks` lock … progress = import row + `active` record in one
transaction"; L57 (:654) deletes the "lease/owner vocabulary" and "owner-carrying record writes"; D-15 (:1280) lists the
retired API and does not include migration.

**Guarantee today.** The runbook's API summary (`docs/crdt-v14-migration.md:302-316`) documents `MigrateOptions`
`leaseMs`, `waitMs`, `pollMs`, `owner`, `wait` and `MigrationRecord {status, owner?, leaseUntil?, …}`, and its boot recipe
branches on `status === 'pending'` → `waitForSettled` (`:60-86`); `wait:false` returns `{status:'busy'}` immediately
(`:136-141`).

**Scenario.** An operator's boot code written from the runbook: with no durable `pending` state, the `pending` branch is
dead and a second tab's `status()` reports `none` while the first tab holds the lock; `leaseMs`/`owner` become no-ops.
Behavior can stay correct, but the documented contract changes silently.

**Repair.** List the option/record changes in D-15 or keep `status()` reporting `pending` while the lock is held
(`navigator.locks.query()`), and map `wait:false` to `ifAvailable`.

---

## Summary for the judge

**Verdict on §11.3 ("Feature parity is kept for everything the tests, docs and demo route exercise").** Not true as
written. Beyond the disclosed decisions (D-1…D-5, D-8, D-9, D-15, D-16), the plan changes or breaks eight guaranteed
behaviors; seven of them are pinned by existing specs, fixtures or documented examples:

| # | Behavior | Pinned by | Plan text that breaks it |
|---|---|---|---|
| FP-1 | Caller ids in `value` survive seeding; same-id concurrent seeds dedupe; demo deep links | `docs/crdt-v14-document.md:55-67`, demo specs on `page-*` ids | R13 / O17 / L56 / D-3 "fresh ids" |
| FP-2 | Delete + following typing is one undo step; a native delete after typing is its own step | `history-coalesced-range.spec.ts:14`, `input.spec.ts:1023` | "text insertion coalesces, everything else cuts"; CP4 "one undo step per command"; F-U8 |
| FP-3 | Undo after an IME commit restores the pre-composition text (including a replaced selection) | checklist COMP-02 + engine semantics (unpinned) | R8 / D-6 previews "bypass undo" |
| FP-4 | Native `<details>` toggles open; readonly can be flipped at runtime; plugin attributes on block elements | `demo-route.spec.ts:90,111`, `demo.spec.ts:155`, `features.spec.ts:221`, heal specs | R11, R12, O52, L33 |
| FP-5 | Inline text suggestions (README feature) | `hotkeys.spec.ts:1618,1670`, `composition.spec.ts:321`, `adversarial-wave3:290` | §2.2 "nothing else is stored", R11, R12 |
| FP-6 | Hooks intercept every operation and may replace the payload | `pipeline.fixtures.tsx:99`, README table, code/rich-text plugins | D-10, L5 (missing from §11.3) |
| FP-7 | Local block-selection delete / cut puts the caret in the previous block | `hotkeys.spec.ts:955` | §2.4 seam row "one rule", L25 |
| FP-8 | Typing inside a link's trailing edge extends the link | `plugins.fixtures.tsx:22`, `plugins.spec.ts:22`, `input.spec.ts:480` | O27 order + O58 static `inclusive` |

Minor: FP-9 (`rendersContent` declared without enforcement), FP-10 (documented hooks and API surfaces with no owner),
FP-11 (read-only observer policy), FP-12 (migration API shape).

**Common root cause.** The plan's rules R7, R11 and R12 are stated for the *document-driven* path (commands, change
reports, history) and treat everything else as foreign or nonexistent. The features above live on the other paths:
view-local state (suggestions, readonly, `<details open>`), plugin-authored behavior (payload rewrites, nested vetoes,
attach hooks) and DOM-side facts (the link edge). Each needs an owner in §2.2/§3 before its mechanism is deleted.

## Claims checked that hold (no finding raised)

- Placeholder rule "one empty text ∧ no live composition" matches today's `shouldShowPlaceholder`
  (`Text.svelte:202-208`), except that today it also hides while the DOM already shows text the model has not adopted (`!hasDomText`); only D-8's markup cut (disclosed) and the function's argument shape (FP-10) are at stake.
- Navigation is already model-driven today (`hotkeys/navigation.ts`, arrows, Home/End, PageUp/Down), so the caret-stop
  stream is not a new parity risk in itself.
- Cross-tab sync survives L62: both providers already join the shared BroadcastChannel room in `providers/room.ts`; only
  the duplicate WebSocket-side fan-out is retired.
- The HTML deserializer is not exported (`src/lib/plugins/index.ts`), so moving HTML import to `DOMParser` removes no
  public server-side API.
- The v13→v14 migration keeps logical ids (O68), unlike the seeding path in FP-1.
- Cancel of a composition leaves no undo entry under either design (`composition-cancellation.spec.ts:360`); the undo
  problem in FP-3 is specific to the commit path.
