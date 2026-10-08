# Manual Editor Failure Remediation Plan

Source: [manual-editor-behavior-checklist.md](../manual-editor-behavior-checklist.md)

Date: 2026-06-30

This document groups every current `Fail` row from the manual editor behavior checklist into fixable root-cause areas. Do not fix these row by row. Most failures are secondary effects of a smaller number of editor-core defects.

## Snapshot

| Status                     |                                 Count |
| -------------------------- | ------------------------------------: |
| Failed rows grouped here   |                                    38 |
| Main suspected root causes |                                     6 |
| First fix target           | DOM selection to model target mapping |

## Execution Rule

Fix in the order below. A later behavior should not be treated as independently broken until the earlier root cause has been fixed and the row has been retested.

1. Fix click/native-selection to model target mapping.
2. Fix keyboard navigation selection sync.
3. Fix DOM/model order drift after history and structural edits.
4. Fix inline-fragment paste/render reconciliation.
5. Fix pending mark preservation across inline insertion.
6. Revisit deletion boundary contracts after selection/navigation are stable.

## Failure Groups

| Priority | Group                                                                               | Failed rows                                                                                                                                                                                                                                                         | Context                                                                                                                                                                                                                            | Suspected layer/files                                                                                                                                                                                                              | Suggested fix                                                                                                                                                                                                                                                                                                                                                                                                                    | Verification loop                                                                                                                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Click and native-selection target mapping resolves to the wrong model text          | `P0-01`, `P0-02`, `P0-03`, `P0-04`, `P0-05`, `P0-06`, `P0-07`, `P0-08`, `P0-09`, `P0-10`, `SEL-04`, `SEL-05`, `SEL-09`, `SEL-10`, `SEL-11`, `SEL-14`, `SEL-15`, `ENTER-07`, `ENTER-08`, `ENTER-09`, `DEL-11`, `NEST-02`, `NEST-05`, `NEST-06`, `NEST-13`, `NEST-14` | Clicking non-first text, nested child text, inline-boundary text, or code text often mutates the first/root text instead. Several enter/delete/nest failures are blocked because the intended block is never focused.              | `src/lib/selection/selection.svelte.ts`, `src/lib/selection/selection.utils.ts`, `src/lib/components/Text.svelte`, `src/lib/components/InlineBlock.svelte`, `src/lib/components/Content.svelte`, `src/lib/components/Block.svelte` | Make DOM-to-model resolution strict and id/path based. Resolve from the closest text or inline boundary element carrying stable model identity. Remove fallback behavior that silently picks the first or nearest unrelated text. Ensure nested blocks, code text, and inline sentinels all expose enough data attributes for selection mapping. Selection-only clicks should publish coherent editor selection before mutation. | Manual browser: click `World`, nested child, deep child, code line, before/after mention, then type. Only the clicked target may change. Add focused mounted/browser regressions for sibling text, nested child text, inline boundary text, and code line. |
| P0       | Keyboard navigation does not update editor selection                                | `ENTER-02`, `DEL-02`, `DEL-05`, `ATOM-03`, `NAV-01`, `NAV-08`                                                                                                                                                                                                       | ArrowLeft, ArrowRight, and Cmd+Arrow movement leave serialized selection at the old offset. Middle insert/delete tests then execute at block end or boundary instead of the intended caret position.                               | `src/lib/events/onKeyDown.ts`, `src/lib/hotkeys.ts`, `src/lib/selection/selection.svelte.ts`, `src/lib/selection/selection.utils.ts`                                                                                               | For navigation keys that are not editor-handled mutations, let the browser move native selection, then synchronize editor selection from the native range. If async `selectionchange` is unreliable, queue an explicit post-keydown selection read for navigation keys. Handle text offsets and inline-boundary sentinel positions explicitly.                                                                                   | Manual browser: type `abc`, ArrowLeft must move model caret from offset `3` to `2`; Delete must remove `c`, not merge the next block. Then retest `@` insertion in the middle of text and Backspace at a post-mention boundary.                            |
| P0       | DOM order drifts from serialized model after history/structural edits               | `ENTER-20`, `HIST-04`, `HIST-09`                                                                                                                                                                                                                                    | After undo/redo of split and selected-block deletion, serialized value and visible DOM order diverge. Example: serialized `abc / note / tail`, visible DOM `abc / tail / note`.                                                    | `src/lib/components/Block.svelte`, recursive block rendering, `src/lib/edytor.svelte.ts`, `src/lib/block/block.svelte.ts`, Yjs observe/hydration paths, history restore code                                                       | Audit keyed rendering and wrapper identity. Blocks must render keyed by stable block id, not array index or unstable wrapper identity. Undo/redo must reconcile wrapper order with Yjs order and detach stale wrappers. Selection restoration should not mask DOM order drift.                                                                                                                                                   | Manual browser: split first paragraph, undo, redo; selected-block delete, undo, redo. After every step, rendered text order must match serialized block order. Add browser or mounted DOM regression that compares visible text order to model order.      |
| P1       | Inline-block paste/render reconciliation loses rendered inline nodes                | `CLIP-15`                                                                                                                                                                                                                                                           | Pasting before an inline mention preserved the mention in serialized content but the rendered inline-block list became empty and the visible mention disappeared.                                                                  | `src/lib/clipboard/*`, `src/lib/events/onPaste.ts` if present, `src/lib/plugins/html/htmlPlugin.ts`, `src/lib/block/block.utils.ts`, `src/lib/block/inlineBlock.svelte.ts`, `src/lib/components/InlineBlock.svelte`                | Recheck paste insertion into content that already contains inline blocks. Preserve inline block Yjs entries, regenerate wrappers only when needed, and normalize text sentinels without dropping inline wrapper registration. DOM render should reconcile from model truth after paste.                                                                                                                                          | Manual browser: paste `X` before a mention and after a mention. Serialized content and visible inline blocks must both retain the mention. Add mounted DOM test asserting model inline blocks and rendered inline nodes after paste.                       |
| P1       | Pending marks are lost across mention insertion                                     | `ATOM-05`                                                                                                                                                                                                                                                           | With pending bold active, typing `@` inserts a mention, but the trailing typed `x` is plain instead of bold.                                                                                                                       | `src/lib/plugins/mention/MentionPlugin.svelte`, inline insertion operation, `src/lib/text/text.utils.ts`, `src/lib/block/block.utils.ts`, selection aftermath code                                                                 | Decide and lock the product contract. If pending marks should survive inline insertion, carry `markOnNextInsert` from the pre-insertion text to the trailing text after `addInlineBlock` or mention insertion. If not, update the checklist expectation. Current expectation says preserve surrounding mark behavior.                                                                                                            | Manual browser: enable bold at collapsed caret, type `@`, then `x`. The trailing `x` must match the chosen mark contract. Add model/DOM operation regression.                                                                                              |
| P1       | First-block and boundary deletion contracts need confirmation after selection fixes | `DEL-03`, plus retest `DEL-05`, `DEL-11` after earlier groups                                                                                                                                                                                                       | Backspace at the start of an empty first block removed that first block and left `note / tail`, while the checklist expected a first-block guard. Other deletion failures are currently contaminated by wrong selection targeting. | `src/lib/events/onBeforeInput.ts`, `src/lib/block/block.utils.ts`, deletion helpers, selection replacement helper                                                                                                                  | Decide whether empty first-block Backspace should no-op or merge/remove the empty block. The current checklist expects a guard, so either enforce it or update the product contract intentionally. Do not change nested/backspace behavior until click and navigation mapping are fixed.                                                                                                                                         | Manual browser: empty first paragraph Backspace; start of text after mention Backspace; nested child start Backspace. Verify model, visible DOM, and final selection. Add focused tests only after the intended contract is explicit.                      |

## Row Accounting

| Failed row | Group                                              |
| ---------- | -------------------------------------------------- |
| `P0-01`    | Click and native-selection target mapping          |
| `P0-02`    | Click and native-selection target mapping          |
| `P0-03`    | Click and native-selection target mapping          |
| `P0-04`    | Click and native-selection target mapping          |
| `P0-05`    | Click and native-selection target mapping          |
| `P0-06`    | Click and native-selection target mapping          |
| `P0-07`    | Click and native-selection target mapping          |
| `P0-08`    | Click and native-selection target mapping          |
| `P0-09`    | Click and native-selection target mapping          |
| `P0-10`    | Click and native-selection target mapping          |
| `SEL-04`   | Click and native-selection target mapping          |
| `SEL-05`   | Click and native-selection target mapping          |
| `SEL-09`   | Click and native-selection target mapping          |
| `SEL-10`   | Click and native-selection target mapping          |
| `SEL-11`   | Click and native-selection target mapping          |
| `SEL-14`   | Click and native-selection target mapping          |
| `SEL-15`   | Click and native-selection target mapping          |
| `ENTER-02` | Keyboard navigation selection sync                 |
| `ENTER-07` | Click and native-selection target mapping          |
| `ENTER-08` | Click and native-selection target mapping          |
| `ENTER-09` | Click and native-selection target mapping          |
| `ENTER-20` | DOM/model order drift after history                |
| `DEL-02`   | Keyboard navigation selection sync                 |
| `DEL-03`   | Deletion boundary contract                         |
| `DEL-05`   | Keyboard navigation selection sync                 |
| `DEL-11`   | Click and native-selection target mapping          |
| `HIST-04`  | DOM/model order drift after history                |
| `HIST-09`  | DOM/model order drift after history                |
| `CLIP-15`  | Inline-block paste/render reconciliation           |
| `ATOM-03`  | Keyboard navigation selection sync                 |
| `ATOM-05`  | Pending mark preservation across mention insertion |
| `NEST-02`  | Click and native-selection target mapping          |
| `NEST-05`  | Click and native-selection target mapping          |
| `NEST-06`  | Click and native-selection target mapping          |
| `NEST-13`  | Click and native-selection target mapping          |
| `NEST-14`  | Click and native-selection target mapping          |
| `NAV-01`   | Keyboard navigation selection sync                 |
| `NAV-08`   | Keyboard navigation selection sync                 |

## Phase 1: Repair Selection Target Mapping

### Context

The same symptom appears across sibling text, nested text, deep nested text, code text, and inline-boundary text: the browser click appears visually valid, but the editor model selection resolves to the wrong text, often the first root text.

This is the foundation defect. Until it is fixed, failures in Enter, Backspace, Tab, marks, inline nodes, and history are not trustworthy.

### Suggested fix

1. Inspect rendered DOM for text spans, inline block wrappers, inline sentinels, code text, and nested blocks.
2. Add or repair stable selection identity attributes on editable text and boundary nodes.
3. Change selection resolution to require a valid model identity or a valid boundary mapping.
4. Remove silent fallback to first/root text for unmapped nodes.
5. Ensure click-only selection changes update `edytor.selection.state`, not only the next mutation.

### Verification

Use `http://localhost:5174/` and `http://localhost:5174/test/dom?scenario=nested`, `inline`, and `code`.

Retest:

- `P0-01` through `P0-07`
- `SEL-04`, `SEL-05`, `SEL-09`, `SEL-10`, `SEL-11`, `SEL-14`, `SEL-15`
- `NEST-02`, `NEST-05`, `NEST-06`, `NEST-13`, `NEST-14`

Pass condition: typing after a click mutates only the intended text/block, and click-only selection state is coherent.

## Phase 2: Repair Navigation Selection Sync

### Context

Arrow keys do not update serialized selection in the browser route. This breaks middle insertion, middle deletion, and inline-boundary Backspace.

### Suggested fix

1. Identify whether native `selectionchange` fires after ArrowLeft/ArrowRight in the test route.
2. If it fires, fix the selection reader.
3. If it does not fire reliably, queue a post-keydown read for navigation keys that are not prevented.
4. Keep mutation hotkeys separate from navigation synchronization.

### Verification

Retest:

- `NAV-01`
- `NAV-08`
- `ENTER-02`
- `DEL-02`
- `DEL-05`
- `ATOM-03`

Pass condition: model selection offsets follow native caret movement before the next input event.

## Phase 3: Repair DOM/Model Drift After History

### Context

The model can serialize in one order while the visible DOM renders another order after undo/redo. This is more dangerous than a command bug because it means the user sees a different document than the model.

### Suggested fix

1. Audit recursive block rendering keys.
2. Ensure keyed lists use stable block ids.
3. Ensure Yjs observer updates reorder existing wrappers instead of leaving stale render order.
4. Verify undo/redo restores selection only after block order reconciliation.

### Verification

Retest:

- `HIST-04`
- `HIST-09`
- `ENTER-20`

Pass condition: after undo/redo, rendered block order and serialized block order are byte-for-byte equivalent in order.

## Phase 4: Repair Inline Paste Rendering

### Context

Paste before an inline mention can preserve the inline block in serialized model content while dropping it from visible DOM. This suggests wrapper registration or rendering reconciliation fails even though model data survives.

### Suggested fix

1. Inspect clipboard insertion around existing inline blocks.
2. Verify normalization keeps text sentinels around inline blocks.
3. Verify inline block wrappers are created and registered after paste.
4. Ensure render reconciliation consumes the normalized model content, not stale pre-paste content.

### Verification

Retest:

- `CLIP-15`

Pass condition: serialized inline blocks and visible inline blocks agree after paste before and after a mention.

## Phase 5: Repair Pending Marks Across Inline Insertion

### Context

Collapsed bold state is lost after mention insertion. The next typed text after the mention becomes plain.

### Suggested fix

1. Confirm the intended contract: pending marks should survive atomic inline insertion.
2. Preserve pending mark state when moving caret from the source text to the trailing text after mention insertion.
3. Keep this local to inline insertion/mention flow, not general mark toggling.

### Verification

Retest:

- `ATOM-05`

Pass condition: after collapsed bold then `@`, trailing typed text follows the chosen pending mark contract.

## Phase 6: Confirm Deletion Boundary Contract

### Context

Backspace at the start of an empty first block currently removes that block. The checklist expected a guard. This may be a real bug or a product contract mismatch.

### Suggested fix

1. Decide the contract for empty first-block Backspace.
2. If guarded, enforce it in the deletion routing before merge/remove operations.
3. Retest nested and inline-boundary deletion only after Phases 1 and 2 are fixed.

### Verification

Retest:

- `DEL-03`
- Retest `DEL-05` and `DEL-11` after earlier phases

Pass condition: deletion behavior matches the explicit contract and leaves a valid selection.

## Do Not Do

- Do not patch visual DOM output while leaving the model wrong.
- Do not hide failures by changing the demo or test route fixtures.
- Do not work on clipboard broadly while fixing selection or history, except for `CLIP-15`.
- Do not mark an affected row as fixed without browser verification.
- Do not treat a secondary Enter/Delete/Tab failure as independent until selection mapping and navigation sync are fixed.

## Minimum Closeout For Each Phase

| Requirement                    | Evidence                                                               |
| ------------------------------ | ---------------------------------------------------------------------- |
| Focused code change only       | `git diff` limited to the active phase                                 |
| Manual browser retest          | Update affected rows in `manual-editor-behavior-checklist.md`          |
| Regression test where feasible | Focused mounted DOM or Playwright spec for the fixed behavior          |
| No console/page errors         | Browser console check during manual retest                             |
| Model/DOM agreement            | Compare serialized value and visible editor text/order where available |
