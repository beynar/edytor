# Cross-Browser Worklog

Operational ledger for the browser-behavior hardening track. Update this before
starting a new cross-browser slice and after finishing it. The purpose is to stop
re-solving the same paste, composition, selection, or structural fallback case.

## Update Protocol

- Before code changes: mark exactly one `Active Slice`.
- After code changes: move the slice into `Completed Edytor Coverage`, record
  the verification command, and update `Next Queue`.
- When adding a regression that is not green yet: record it under the active
  slice immediately, including the failing command and the proven gap. Do not
  leave failing discoveries only in chat or memory.
- If a session only changes this ledger, record that fact in `Ledger Updates`
  instead of pretending a browser behavior slice was completed.
- If a task is already listed under `Completed Edytor Coverage`, do not reopen it
  unless the new failure is materially different and browser-backed.
- If work resumes after compaction, read this file first; memory summaries are
  secondary.
- Treat this file as append-mostly. Completed coverage should not be deleted
  just because the same fact is now also present in a compaction summary.
- Before adding a new browser-hardening test, search this file for the behavior
  and write down why the new case is materially different if the area is already
  listed as done.

## Current Status Snapshot

- Canonical tracker: this file.
- Current track: cross-browser editing behavior only.
- Current active work: None.
- Current release gate: `pnpm release:check` passed on 2026-06-19 19:38 CEST.
  The gate covered `pnpm check`, `pnpm lint`, model tests, mounted DOM tests,
  test typechecks, serial Playwright across Chromium, Firefox, WebKit, mobile
  Chromium, mobile WebKit, `pnpm build`, package, and `publint`.
  Browser-owned text reconciliation now notifies plugin `insertText`
  aftermath hooks, so real placeholder-click typing can open the slash menu
  before command execution. Mobile WebKit non-cancelable code-line Enter and
  line-break drift now repair both the native event target and final caret
  target while keeping paragraph soft breaks in the same paragraph.
- Current state: root-route typing and mark toggles no longer leave visible
  stale DOM clones; structural key fallback and mobile non-cancelable
  beforeinput repair are covered across Chromium, Firefox, WebKit, mobile
  Chromium, and mobile WebKit. Live localhost edit-history clearing now lands
  on a focused editable empty paragraph instead of a stale wrapper/root
  selection. Programmatic focus/refocus and structural paragraph-split redo now
  have direct browser regression gates. Code island Backspace/Delete boundaries
  now have real-browser regression coverage. Code-line Tab insertion and code
  suggestion acceptance now have real-browser regression coverage. Physical
  Shift+Tab is now model-owned as the inverse of block nesting for caret and
  selected-block states across Chromium, Firefox, and WebKit. The demo route
  now also has direct cross-browser gates for visible mark-toggle
  duplication, undo/delete marked DOM duplication, auto-dot preservation, and
  paragraph-split history grouping on `/`. Reverse native selections now keep
  anchor/focus direction after model-owned mark formatting across Chromium,
  Firefox, and WebKit, including when mark formatting is undone and redone
  through history. ShadowRoot backward selections now preserve anchor/focus
  direction in Edytor's model selection across Chromium, Firefox, and WebKit.
  Composition that starts while the native selection already spans multiple
  blocks now has direct browser coverage for both preview-beforeinput and
  compositionend-only commit paths. The selected cross-block range is replaced
  once, the trailing block is emptied, and the caret lands after the committed
  IME text across Chromium, Firefox, and WebKit. Compositionend-only commits
  now also keep the composition-start target even when the browser reports a
  bogus `selectionchange` during active composition.
  Safari-shaped final `beforeinput.insertFromComposition` before a later
  `compositionend` now exits composing state immediately, restores the caret
  after the committed text, and ignores the later `compositionend` as a
  duplicate-free no-op across Chromium, Firefox, and WebKit.
  Composition started from a rendered mark-wrapper boundary now has direct
  browser coverage and preserves the left mark context across Chromium,
  Firefox, and WebKit. Native double-click word selections now have direct
  follow-up mutation coverage: bold formatting and typed replacement affect
  only the selected word and do not leave duplicated visible DOM text.
  Post-composition multi-block selections now delete normally and restore the
  caret to a live surviving block instead of leaving selection aftermath pointed
  at a deleted block. Playwright integration now starts with a preview-only app
  build so browser runs do not invoke package emission, and pointer clicks
  inside selected block content force a collapsed model caret when Chromium does
  not emit a useful selectionchange. Browser-owned collapsed deletions now
  tolerate empty follow-up `inputType` values while preserving undo/redo caret
  restoration from the beforeinput-time delete target. Embedded native controls
  inside void blocks now own their own beforeinput/input/keydown events, so
  stale outer-editor selections cannot mutate the model while a nested control
  is focused. Native non-text controls inside void bodies, such as buttons and
  links, also own activation keys while Backspace/Delete are prevented from
  triggering browser navigation or stale editor mutation unless the editor has
  an explicit selected-block deletion active. Nested native text controls inside
  void bodies now also own their composition lifecycle, so a bubbled
  `compositionstart` cannot leave Edytor in stale composing state or suppress
  the next editor hotkey. Firefox input-only replacement of
  browser-created expanded selections now infers missing `InputEvent.data` from
  the DOM/model text diff before replacing the selected model range. Empty
  placeholder/native-range cleanup now has a direct browser regression proving a
  browser-created selection around an empty block cannot hijack the next click
  and typed character.
  External toolbar/control commands now have browser coverage proving they run
  from Edytor's preserved model selection after the user leaves the native DOM
  selection/focus context, instead of targeting the external control or an empty
  browser selection. Firefox-style compositionend-before-input duplication now
  has direct browser coverage, so a late Firefox composition `input` cannot
  double-commit the final IME text after Edytor already handled
  `compositionend`. Backspace from inside the browser-only trailing soft-break
  marker now deletes only the model newline and restores the caret to the text
  end across Chromium, Firefox, and WebKit. Consecutive trailing soft-break
  handling now keeps repeated trailing markers classified as managed editor
  DOM, so Firefox/WebKit cannot silently remove the browser-only marker while
  the model text still ends with consecutive newlines. Native reverse-selection
  restoration now falls back safely when browser `setBaseAndExtent()` or
  `extend()` throws while restoring a backward range. Chromium CDP IME
  composition now has a regression gate for the active-composition
  delete-and-reinsert sequence that ProseMirror tracks with `lastChromeDelete`.
  Same-character replacement now has direct browser coverage proving unchanged
  text still collapses selection and places the next typed character at the
  replacement boundary. Real Backspace before inline atomic mentions now has a
  direct browser regression gate proving Chrome/Firefox/WebKit do not leave
  bogus `<br>` DOM when the last text before an atom is deleted. Safari-shaped
  text insertion/replacement `beforeinput` events with null `data` and a
  `dataTransfer` text payload are now model-owned, so the transfer payload is
  inserted and the caret is restored. Link-mark anchor-boundary typing now has
  direct browser coverage proving insertion at the end of a rendered `<a>`
  preserves the link mark and does not clone visible DOM. IME composition
  immediately after a collapsed pending-mark toggle now inherits the intended
  mark across Chromium, Firefox, and WebKit, including the compositionend-only
  commit path. Off-edge pointer clicks immediately after an inline atomic
  mention now have direct browser coverage proving the caret lands in the
  trailing editable text before typed insertion, not in a stale browser-owned
  atom-adjacent position. Clicking directly before an already selected inline
  mention now also has browser coverage proving the selected-atom state clears
  before the next typed insertion. Printable input after a real pointer-selected
  inline mention now replaces the atom through the model and restores the caret
  after the typed character across Chromium, Firefox, and WebKit. Backspace at
  the start of a block whose previous block contains inline mention atoms now
  restores the caret to the merge boundary instead of the appended source block
  end. Composition
  immediately before adjacent identical committed text now has a browser
  regression gate proving the preview is not merged with or duplicated into the
  neighboring identical text. Non-native `contenteditable=false` islands inside
  editable blocks now remap to the owning block's editable text before structural
  keys, so clicking a callout icon cannot delete stale editor text. Empty-block
  placeholders now hide during active IME composition, restore after canceled
  composition, and stay hidden after committed composition text exists. Multiple
  Edytor instances on the same document now have a direct browser regression
  proving document-level `selectionchange` and `keydown` listeners do not leak
  selection or text mutations across editor roots. A dangling composition that
  loses `compositionend` during external blur now clears after refocus, so
  normal hotkeys are not suppressed by stale IME state. Autocorrect/spellcheck
  `insertReplacementText` target ranges spanning inline atomic mentions are
  now locked as model-owned browser behavior. Post-composition Backspace after
  an explicit selection spanning inline atomic mentions is also locked as a real
  deletion path, not swallowed by the WebKit-style immediate Backspace guard.
  Element-node `beforeinput.getTargetRanges()` at inline atomic mention
  boundaries now normalize to neighboring editable text before model-owned
  `insertText`. Secondary-click/contextmenu selection now has a direct browser
  regression proving the next keyboard edit follows the browser's
  secondary-click target, not a stale cached model selection. Firefox inserts
  at the clicked caret; Chromium and WebKit replace the clicked word, and both
  outcomes are documented as browser-specific behavior. Follow-up typing after
  inserting a tab inside code/pre content now has browser coverage, locking the
  Slate-inspired Chrome `pre` + tab quirk as model-owned instead of allowing
  native whitespace handling to corrupt the visible code line. Cancelable
  multi-character/special-character `beforeinput.insertText` payloads are now
  model-owned and inserted exactly once across Chromium, Firefox, and WebKit.
  Mobile non-cancelable advanced deletion input types now have direct browser
  coverage proving word/soft-line/hard-line deletions stay model-owned even
  when the browser mutates DOM before the follow-up `input`. Mobile
  non-cancelable generic/fragment deletion input types now also have direct
  browser coverage proving `deleteContent`, `deleteEntireSoftLine`, and
  `deleteByComposition` repair browser-created DOM drift back to the model
  command result. Pure divider/horizontal-rule void blocks now also have
  browser coverage proving Backspace from the following text caret selects the
  divider atomically first and a second Backspace deletes it with the caret
  restored to a live paragraph. Input-only native history events now route
  through editor undo/redo instead of being reconciled as arbitrary DOM text
  diffs, preserving redo stack semantics and caret restoration across Chromium,
  Firefox, and WebKit. Slate-style unfocused input-only native history is now
  covered too: an `input.historyUndo` or `input.historyRedo` event dispatched
  from editable DOM after focus moved to an outside native input still syncs
  Edytor history/value and leaves cached model selection coherent.
  CharacterData-only browser text mutations now have direct browser coverage,
  so extension/speech/autocorrect-style DOM rewrites that do not provide a
  useful `beforeinput` or `input` event still reconcile into the model and
  restore the caret.
  Cross-text `deleteContentForward` target ranges at a block boundary now have
  direct browser coverage too: unsafe browser ranges are ignored and structural
  Delete merges through the semantic model command with the caret restored to
  the join boundary.
  Marked CharacterData-only browser text mutations now have direct browser
  coverage too, so extension/speech/autocorrect-style DOM rewrites inside
  rendered mark wrappers preserve mark attributes, plain neighbors, and caret
  placement.
  Deletion-only CharacterData mutations inside rendered mark wrappers now also
  preserve deleted mark context for the next typed character, matching the
  ProseMirror/Svedit/Lexical invariant that formatted ranges shrink without
  losing insertion formatting at the deletion boundary.
  Browser-created DOM text-node splits inside rendered mark wrappers are now
  repaired back to a single model-rendered mark leaf without changing logical
  text or cached caret placement. WebKit/Safari converted-space wrappers are
  now normalized from `span.Apple-converted-space` with `\u00A0` into logical
  spaces before DOM text reconciliation, so the model stores normal spaces and
  the wrapper is removed. Chrome-style nested inline mark DOM drift around link
  anchors is now repaired from the model even when logical text content is
  unchanged, so browser-flipped `link`/`bold` wrapper order cannot persist in
  the editable DOM.
  Dynamic readonly transitions now also have direct browser coverage: a live
  editor with an existing model selection can switch to `contenteditable=false`
  without leaving stale `Edytor.readonly=false` mutation paths behind.
  Native `formatRemove` target ranges now have direct browser coverage across
  mixed marks and inline atoms, so browser remove-format commands use the
  event-time target range, preserve inline mentions, and restore the selected
  model range without leaving native formatting DOM.
  Late `compositionend.data` delivered after external blur and dangling
  composition cleanup now has direct browser coverage across Chromium, Firefox,
  and WebKit; the stale IME payload is ignored and a later fresh caret edit
  still works.
  Partial inside/outside `beforeinput.getTargetRanges()` now has direct browser
  coverage in both directions across Chromium, Firefox, and WebKit; these
  invalid target ranges are prevented without mutating stale cached editor
  selection.
  Android-style active composition DOM mutation without `beforeinput` now has
  browser coverage; composing DOM/input drift commits once, clears composing
  state, restores the caret, and ignores a later duplicate `compositionend`.
  Normal-browser Shift+Tab now also covers a newly split paragraph containing a
  soft break on `/`, with reverse-tab key aliases routed through the model-owned
  unnest command and native Tab/Shift+Tab DOM drift suppressed around the
  structural hotkey command.
- Clipboard/paste status: do not reopen unless a fresh browser regression proves
  paste is the failing cross-browser boundary.
- Verification rule: Playwright browser specs run sequentially with
  `--workers=1`.
- WebKit desktop can show Playwright retries for long-run navigation stalls
  only; route assertions still run and must pass on retry, and focused reruns of
  retrying cases must pass.

## Continuation Contract

- Source of truth after compaction: this file, then current code/tests, then
  memory summaries.
- Every implementation slice must have one of two endings: `Active Slice` is
  reset to `None` with verification recorded, or it remains active with the
  exact failing command and blocker.
- Repeated work is a process bug. If a completed area is revisited, the ledger
  entry must name the fresh browser failure that makes the revisit legitimate.

## Resume Checklist

Run this checklist before any new cross-browser implementation slice:

1. Read `Current Status Snapshot`, `Fast Coverage Index`, `Active Slice`, and
   `Completed Edytor Coverage`.
2. Search this file for the proposed behavior name and browser symptom.
3. If the behavior is already listed as done, stop unless there is a fresh
   browser-backed failure that is materially different.
4. If it is new, write the proposed work under `Active Slice` before editing
   runtime or tests.
5. Add the failing command before patching runtime whenever the new case starts
   red.
6. After the fix, move the slice into `Ledger Updates`, update
   `Completed Edytor Coverage`, and record verification commands.
7. Reset `Active Slice` to `None` only after the slice is green or leave it with
   the exact blocker.

## Fast Coverage Index

- Done: clipboard v1 and clipboard hardening.
- Done: HTML paste mapping and fallback behavior, except for future
  browser-proven regressions.
- Done: desktop missing-`beforeinput` fallback for Enter, Backspace, Delete,
  Shift+Enter, selected-block deletion, and inline-boundary deletion.
- Done: mobile non-cancelable Backspace/Delete/Enter/Shift+Enter structural
  repair.
- Done: mobile IME composition around empty blocks, selections, marks, inline
  mentions, and history-restored selections.
- Done: mobile non-cancelable `insertText` over plain expanded selections,
  inline-spanning selections, and cross-block selections.
- Done: mobile non-cancelable `insertText` over marked and mixed-mark
  expanded selections.
- Done: collapsed typing at the end of a rendered link anchor preserves the
  link mark and does not leave duplicated anchor DOM.
- Done: IME composition started immediately after a collapsed pending mark
  toggle inherits that pending mark and restores a collapsed caret after the
  committed text.
- Done: IME composition immediately before adjacent identical committed text
  replaces the preview once, preserves the existing neighbor, and leaves the
  caret between both graphemes.
- Done: IME composition at a code-line suggestion boundary preserves the
  editable text as the model target, keeps the suggestion overlay out of the
  serialized value, and leaves the suggestion UI alive across Chromium,
  Firefox, and WebKit.
- Done: IME composition that starts over an expanded multi-block selection
  replaces the selected range once and restores the caret after the committed
  text, both when the browser sends `insertCompositionText` beforeinput and
  when `compositionend` is the only committed event.
- Done: active-composition `selectionchange` drift before a compositionend-only
  commit cannot retarget the final IME text; the commit uses the
  composition-start selection snapshot and restores the caret there.
- Done: final `beforeinput.insertFromComposition` before the later
  `compositionend` is treated as the composition commit boundary; composing
  state is cleared immediately, selection restoration runs, and the later
  `compositionend` does not duplicate the text.
- Done: dangling `compositionstart` without `compositionend` after external
  blur/refocus clears composing state before later hotkeys, so a post-refocus
  bold toggle applies normally across Chromium, Firefox, and WebKit.
- Done: empty-block placeholders are hidden during active IME composition,
  restored after canceled composition, and remain hidden after committed
  composition text exists.
- Done: multiple editor instances on the same document isolate document-level
  `selectionchange` and `keydown` handling, so focusing/typing in one editor
  cannot mutate another editor's model or cached selection.
- Done: off-edge pointer clicks just after inline atomic mention blocks map to
  trailing editable text before typed insertion.
- Done: real pointer clicks just before an already selected inline atomic
  mention clear the selected-inline deletion target and type into the
  preceding editable text.
- Done: printable input after selecting an inline atomic mention replaces the
  selected atom, clears atom selection, and leaves the caret after the typed
  text.
- Done: secondary-click/contextmenu inside editable text does not leave stale
  model selection behind for the next keyboard edit; Firefox caret insertion
  and Chromium/WebKit word-replacement behavior are locked separately.
- Done: follow-up typing after inserting a tab inside a rendered code/pre line
  stays model-owned and keeps serialized text, visible text, and caret offset
  exact across Chromium, Firefox, and WebKit.
- Done: cancelable multi-character/special-character `beforeinput.insertText`
  payloads are prevented, inserted through the model exactly once, and restore
  the caret after the inserted payload.
- Done: mobile non-cancelable advanced deletion input types
  (`deleteWordBackward`, `deleteWordForward`, `deleteSoftLineBackward`,
  `deleteSoftLineForward`, `deleteHardLineBackward`,
  `deleteHardLineForward`) repair browser-created DOM drift back to the model
  command result and restore the caret.
- Done: mobile non-cancelable generic/fragment deletion input types
  (`deleteContent`, `deleteEntireSoftLine`, `deleteByComposition`) repair
  browser-created DOM drift back to the model command result and restore the
  caret.
- Done: interrupted mouse drag selections that release outside the editor do
  not leave a stale drag range or selected inline atom behind; the next click
  and typed edit land at the clicked text target.
- Done: browser-native autocorrect/spellcheck-style `insertReplacementText`
  target ranges spanning text + inline atomic mention + text are model-owned;
  the mention is removed atomically and the caret lands after the inserted
  replacement.
- Done: after IME composition ends, an explicit user selection spanning inline
  atomic mentions and multiple blocks deletes normally with Backspace across
  Chromium, Firefox, and WebKit.
- Done: collapsed `beforeinput.getTargetRanges()` whose container is the
  paragraph/content element and whose child offset is before or after an inline
  atomic mention normalize to the neighboring editable text before insertion.
- Done: real Backspace block-boundary merge after a previous block containing
  inline mention atoms preserves both atoms and restores the caret to the merge
  boundary.
- Done: mobile non-cancelable single-character `insertText` at the start of a
  text node keeps the beforeinput-time insertion target even if native
  selection jumps before the `input` event.
- Done: ArrowLeft/ArrowRight and Shift+ArrowLeft/Shift+ArrowRight around
  inline atomic mention blocks.
- Done: RTL/bidi ArrowLeft/ArrowRight and Shift+ArrowLeft/Shift+ArrowRight
  around inline atomic mention blocks.
- Done: advanced delete `beforeinput` routing for word, soft-line, hard-line,
  cut, drag, and composition deletion inputTypes.
- Done: advanced delete `beforeinput` routing for generic `deleteContent` and
  whole-soft-line `deleteEntireSoftLine` inputTypes.
- Done: missing-`beforeinput` modifier word deletion reconciles browser-owned
  DOM text deletion through the follow-up `input.deleteWordBackward` event and
  restores the caret at the deleted word boundary.
- Done: missing-`beforeinput` forward modifier word deletion reconciles
  browser-owned DOM text deletion through the follow-up
  `input.deleteWordForward` event and restores the caret at the deletion start.
- Done: missing-`beforeinput` modifier line deletion reconciles browser-owned
  DOM text deletion through follow-up `input.deleteSoftLineBackward`,
  `input.deleteHardLineBackward`, `input.deleteSoftLineForward`, and
  `input.deleteHardLineForward` events and restores the caret at the line
  boundary.
- Done: browser-owned text insertion undo/redo restores the caret from the
  captured history selection snapshot instead of stale post-refresh DOM
  selection.
- Done: characterData-only browser text mutations of existing managed text
  nodes reconcile through the DOM observer without requiring a `beforeinput` or
  `input` event, preserving the browser's post-mutation caret offset.
- Done: characterData-only browser text mutations inside rendered mark wrappers
  preserve the affected mark attributes, leave adjacent plain text plain, and
  restore the browser's post-mutation caret offset.
- Done: deletion-only characterData mutations inside rendered mark wrappers
  preserve the deleted mark context for the next typed character, while keeping
  neighboring plain text plain.
- Done: browser-created child-list text-node splits inside rendered mark
  wrappers are repaired from the model when logical text content is unchanged,
  preserving the caret and mark/plain boundaries.
- Done: browser-flipped nested `link` and `bold` mark DOM is remounted from the
  model even when the logical text content is unchanged, preserving canonical
  mark order and caret placement.
- Done: WebKit/Safari `span.Apple-converted-space` wrappers inside live editable
  text are normalized to logical spaces before reconciliation, preserving the
  caret and preventing `\u00A0` from entering the model.
- Done: WebKit post-composition Backspace guard now preserves explicit user
  selections instead of swallowing selected-content deletion.
- Done: WebKit-style post-composition Backspace also preserves explicit
  multi-block selections and restores the caret to a live survivor after the
  selected blocks are deleted.
- Done: triple-clicking a non-editable void block body selects the whole void
  block atomically instead of overhanging into editable caption text.
- Done: triple-clicking editable text immediately before an inline atomic
  mention preserves the model-owned whole-block range for the next typed
  replacement, so WebKit cannot shrink the replacement to only the pre-mention
  text before Edytor normalizes the DOM range.
- Done: browser-created triple-click text selections replace only the clicked
  block on the next typed character, even when Firefox reports a collapsed
  target range.
- Done: Firefox input-only replacement of a browser-created expanded selection
  still replaces the selected model text when the follow-up `input` event has
  no useful `data` payload.
- Done: browser-created double-click word selections can be followed by bold
  formatting or typed replacement without mutating adjacent blocks or leaving
  duplicated visible DOM text.
- Done: same-character replacement over an expanded text selection collapses
  the caret to the replacement boundary, and the next typed character lands at
  that boundary even though the replaced text itself is unchanged.
- Done: native non-text controls embedded inside void block bodies own Enter
  and Space activation, and Backspace/Delete do not leak into the parent editor
  unless there is an explicit selected-block deletion.
- Done: native text controls embedded inside void block bodies own IME
  composition events; bubbled native-control composition cannot set Edytor's
  composing state, mutate stale model selection, or suppress the next editor
  hotkey.
- Done: non-native `contenteditable=false` islands inside normal editable
  blocks map back to the owning block's editable text boundary before
  Backspace/Delete, while native controls keep their own event ownership.
- Done: native selections around an empty placeholder/zero-width empty block
  remap before the next click/edit, so the next typed character lands in the
  clicked block rather than the stale empty block.
- Done: external `contenteditable` selections outside the editor are ignored
  like native control selection noise, and programmatic editor refocus restores
  the cached model caret before the next typed character.
- Done: editable roots expose stable textbox semantics (`role="textbox"`,
  `aria-multiline="true"`, and readonly state) alongside browser mutation guard
  attributes across Chromium, Firefox, and WebKit.
- Done: empty native selectionchange after blur/window focus loss does not
  erase Edytor's cached model selection; programmatic refocus restores the
  caret before typing.
- Done: internal programmatic focus during `clear()` restores focus/caret
  without scrolling a page whose editor is below the viewport across Chromium,
  Firefox, and WebKit.
- Done: undoing typed text in a split paragraph leaves one visible placeholder,
  not duplicated placeholder text.
- Done: vertical ArrowUp/ArrowDown navigation around image-like void blocks
  stays on editable model targets or atomic block selection, never the
  non-editable figure body.
- Done: Shift+ArrowDown selection extension across image-like void blocks is
  editor-owned when the caret starts immediately before the void block, so the
  browser cannot trap the selection on the non-editable figure body.
- Done: real-browser Shift+Enter stays a paragraph soft break even when the
  browser reports the follow-up `beforeinput` as `insertParagraph`.
- Done: typing after a browser caret lands inside the trailing soft-break marker
  inserts at the model text end and removes the marker, instead of treating the
  zero-width marker as editable model content.
- Done: typing after a browser caret lands inside a marker for consecutive
  trailing soft breaks inserts at the full model text end, removes the marker,
  and keeps Firefox/WebKit from dropping the Svelte-owned marker during DOM
  repair.
- Done: Backspace after a browser caret lands inside the trailing soft-break
  marker deletes only the model newline, removes the marker, restores the caret
  at the previous text end, and prevents the source `beforeinput`
  synchronously.
- Done: a native same-text range spanning a model soft break is replaced through
  model-owned text insertion, leaving `lXd` and a collapsed caret after `X`
  instead of corrupting newline offsets or leaving stale DOM.
- Done: a reverse native selection spanning a model soft break survives
  model-owned mark formatting, keeps `e\na` bold, and preserves backward native
  selection direction after the marked DOM remount.
- Done: Android/mobile virtual-keyboard Backspace intent wins over a following
  Enter-shaped `beforeinput.insertParagraph`, so SwiftKey-style structural
  misreports merge/delete backward instead of inserting a paragraph.
- Done: a real pointer click inside already selected block content clears
  selected-block state and places a collapsed caret back in editable text across
  Chromium, Firefox, and WebKit.
- Done: real Shift+click range extension from marked text into text after an
  inline atomic mention maps to one model range and the next typed replacement
  deletes the full range without corrupting the inline atom boundary across
  Chromium, Firefox, and WebKit.
- Done: Home/End and Shift+Home/End are model-owned at the current block
  boundary so Firefox and WebKit do not leave the caret unchanged inside marked
  text.
- Done: PageUp/PageDown and command-arrow document-boundary navigation are
  model-owned across nested and void content.
- Done: Alt/Ctrl word-boundary navigation and Shift+Alt/Ctrl word selection are
  model-owned across marks, emoji, and inline atomic mention boundaries.
- Done: AltGraph/dead-key keydowns do not trigger editor hotkeys, so
  Ctrl+Alt-like printable input and literal `KeyboardEvent.key === 'Dead'`
  accent composition input can flow into the following text insertion without
  accidentally firing `mod+alt` commands.
- Done: `insertTranspose` beforeinput events with target ranges are model-owned
  through controlled text insertion.
- Done: cancelable `insertText` and `insertReplacementText` beforeinput events
  whose `data` is `null` but whose `dataTransfer` carries `text/plain` are
  model-owned and insert the transfer text across Chromium, Firefox, and
  WebKit.
- Done: `insertFromYank` beforeinput events are model-owned as controlled text
  insertion instead of being prevented as an unsupported no-op.
- Done: `beforeinput.insertText` tab payloads route through semantic Tab
  behavior instead of inserting a literal tab into rich-text paragraphs; code
  lines still insert a literal tab through the code plugin path.
- Done: IME composition over mixed marked text preserves only common marks and
  does not inherit a left/right formatting boundary accidentally.
- Done: Firefox-style `compositionend` before final `input` is guarded against
  duplicated committed DOM text; the model and rendered DOM stay at one final
  IME commit with the caret after the committed character.
- Done: Chromium CDP IME composition that temporarily clears and reinserts the
  active composing text commits exactly once, preserves the caret, and does not
  duplicate visible DOM.
- Done: out-of-editor `beforeinput.getTargetRanges()` are prevented and ignored
  so stale cached editor selection cannot be mutated by an unexpected browser
  target range.
- Done: unsupported native list, indent, outdent, block-format, and justify
  `beforeinput` commands are prevented and no-op for collapsed and ranged
  selections across Chromium, Firefox, and WebKit.
- Done: unsupported native color/font formatting `beforeinput` commands
  (`formatForeColor`, `formatBackColor`, `formatFontColor`, `formatFontName`)
  are prevented and no-op for collapsed and ranged selections across Chromium,
  Firefox, and WebKit.
- Done: unsupported native link/direction/horizontal-rule `beforeinput`
  commands (`insertLink`, `formatSetBlockTextDirection`,
  `formatSetInlineTextDirection`, `insertHorizontalRule`) are prevented and
  no-op for collapsed and ranged selections across Chromium, Firefox, and
  WebKit.
- Done: Backspace from the start of text after a pure divider/horizontal-rule
  void block selects the divider as an atomic block first, and a second
  Backspace deletes it while restoring a live paragraph caret across Chromium,
  Firefox, and WebKit.
- Done: native `formatItalic`, `formatUnderline`, `formatStrikeThrough`,
  `formatSuperscript`, and `formatSubscript` beforeinput values are browser
  tested across range selections and collapsed pending-mark insertion.
- Done: native `formatRemove` at a collapsed caret clears pending insertion
  marks before the next typed character across Chromium, Firefox, and WebKit.
- Done: reverse native selections preserve anchor/focus direction when a
  model-owned mark toggle remounts or rewrites marked text.
- Done: reverse native selections preserve anchor/focus direction when a
  model-owned mark toggle is undone or redone through history restoration.
- Done: reverse model-range restoration falls back to a normal DOM range when
  browser `Selection.setBaseAndExtent()` / `Selection.extend()` throws, instead
  of crashing the editor.
- Done: composition cancellation with empty `compositionend.data` and
  `deleteCompositionText` during an active IME preview are browser tested across
  Chromium, Firefox, and WebKit.
- Done: composition interrupted by `insertParagraph` preserves the active IME
  preview until `compositionend`, replaces preview text with the final IME
  value, and restores the post-Enter caret target.
- Done: composition interrupted by normal `deleteContentBackward` beforeinput
  does not corrupt the later final IME commit or selection.
- Done: composition interrupted by normal `deleteContentForward` beforeinput
  does not merge the following block into the active IME preview and preserves
  the final IME commit plus caret target.
- Done: stale blurred editor ranges no longer override a newer in-editor DOM
  selection on root refocus before the next input.
- Done: composition interrupted by native `formatUnderline` does not leak a
  newly-created pending mark into the later final IME commit.
- Done: composition from a DOM element-node caret immediately after a rendered
  mark wrapper preserves the left mark context and caret aftermath across
  Chromium, Firefox, and WebKit.
- Done: active-composition keydowns for editor hotkeys and structural commands
  are ignored by the editor command layer, so `mod+b`, Enter, Tab, and undo do
  not mutate the composition preview before the final IME commit.
- Done: active-composition Arrow/Escape candidate-navigation keydowns are also
  ignored by editor command/navigation handling, so IME/accent candidate UI
  keeps ownership and the preview caret stays stable until composition commit.
- Done: canceled composition previews do not create noisy undo entries; after a
  normal text insertion, canceled IME preview, and one undo, the normal text
  insertion is undone directly.
- Done: unsupported native `insertFromDrop` beforeinput is prevented and no-ops
  at the current non-DnD product boundary.
- Done: root `dragover` and `drop` events are prevented at the current non-DnD
  product boundary, so browsers cannot perform uncontrolled native drop
  insertion before or without `beforeinput.insertFromDrop`.
- Done: blurred-editor programmatic/remote text updates preserve external DOM
  focus and keep cached editor selection usable on explicit refocus.
- Done: real pointer clicks on non-editable inline mention atoms select and
  delete the atom through the model across Chromium, Firefox, and WebKit.
- Done: printable input after a real pointer-selected inline mention atom
  replaces that atom through the model and restores the caret after the typed
  character across Chromium, Firefox, and WebKit.
- Done: real browser drag-created ranges across inline mention atoms delete the
  text range plus atomic mention semantically across Chromium, Firefox, and
  WebKit.
- Done: real browser drag-created ranges across inline mention atoms can be
  followed by model-owned bold formatting; selected text receives the mark, the
  mention atom is preserved, selection remains expanded, and managed DOM is not
  duplicated across Chromium, Firefox, and WebKit.
- Done: real Backspace repeatedly deleting all text immediately before an
  inline atomic mention preserves the mention and trailing text without leaving
  bogus browser-created `<br>` DOM across Chromium, Firefox, and WebKit.
- Done: bogus browser-created `<br>` nodes immediately before or after inline
  mention atoms are removed as DOM drift while the inline atom, model content,
  and caret boundary remain stable across Chromium, Firefox, and WebKit.
- Done: model-owned typing remounts the affected text from the Yjs model so
  browser-cloned marked DOM and stale empty placeholders are removed across
  Chromium, Firefox, and WebKit.
- Done: the demo route now asserts visible paragraph text when typing in the
  default nested marked `One` block, so stale DOM clones cannot hide behind a
  correct managed text wrapper.
- Done: the demo route now asserts exact visible paragraph text after
  `clear()` and ordinary typing, so duplicated DOM text cannot pass as a loose
  `contains` match.
- Done: mark toggles and native format-beforeinput mark removal remount the
  affected text from the Yjs model so stale browser-cloned marked DOM cannot
  remain visible while the serialized value is correct.
- Done: auto-dot `. ` insertion is only treated as replacement at a real
  space/dot boundary, so ordinary preceding non-space text is preserved.
- Done: native `insertReplacementText` over marked ranges is model-owned, and
  non-cancelable replacement drift is repaired without duplicating model text
  or corrupting marks.
- Done: native input reconciliation removes stale placeholders after text
  becomes non-empty across Chromium, Firefox, and WebKit.
- Done: empty-block placeholders are keyed to `Text.isEmpty`, and stale
  placeholder cleanup also runs from input and DOM-mutation reconciliation so
  browser-owned insertions cannot leave `aWrite something here ...` visible
  while the model text is `a`.
- Done: collapsed Backspace/Delete deletes a whole grapheme cluster when
  target ranges are unavailable, so emoji surrogate pairs and combining-accent
  characters cannot be split into invalid model text.
- Done: root-route typing, mark-toggle aftermath, missing-beforeinput
  structural fallbacks, and mobile non-cancelable structural repairs preserve
  model-owned DOM and selection after browser drift.
- Done: raw native `insertText` payloads containing `\r` or `\n` are routed to
  paragraph split or soft-break commands instead of being reconciled as literal
  model text.
- Done: stale native DOM mutations produced after model-owned replacement,
  mark toggles, paragraph split, and soft-break commands are cleaned from the
  DOM without being reconciled back into the Yjs model.
- Done: repeated Chromium CDP/mobile composition starts are idempotent, final
  `insertText` during active composition commits once, and idle composition
  cancellation removes preview text.
- Done: stale text/block attachment cleanup cannot detach the current model
  mapping or observer after keyed remounts, so mark toggles do not orphan live
  text wrappers.
- Done: root-route `clear()` after edit history focuses the newly-created
  empty paragraph text and restores placeholder/caret behavior.
- Done: browser-owned non-cancelable collapsed `insertText` stores the
  event-time target and restores selection there when native selection jumps
  before the follow-up `input` event.
- Done: mobile non-cancelable Backspace/Delete over a paragraph-spanning text
  range restores the event-time caret after native DOM deletion shifts the
  browser selection rightward.
- Done: consecutive browser-owned `insertText` mutations before the first
  `input` flush reconcile to one model text value and restore the final caret.
- Done: external native `<input>`/`<textarea>` selectionchange noise does not
  mutate Edytor's cached model selection or focused block state.
- Done: route load does not focus the editor or create a native editor
  selection before user interaction; the first placeholder click and typed
  character still create the expected model selection across Chromium, Firefox,
  and WebKit.
- Done: native selections that start inside Edytor and end in external DOM are
  ignored instead of rewriting the cached model selection to an unmappable
  partial range. Chromium and Firefox exercise the partial-outside range;
  WebKit normalizes the synthetic range back inside contenteditable and is
  recorded as an explicit browser quirk skip.
- Done: native selections that start in external DOM and end inside Edytor are
  also ignored, preserving the previous valid model selection across Chromium
  and Firefox; WebKit normalizes this synthetic cross-boundary range back
  inside contenteditable and is recorded as an explicit browser quirk skip.
- Done: ShadowRoot selection mapping does not trust native
  `Selection.isCollapsed`; expanded shadow ranges are detected from
  anchor/focus node and offset equivalence across Chromium, Firefox, and WebKit.
- Done: ShadowRoot backward selection mapping preserves anchor/focus direction
  and records `isReversed: true` across Chromium, Firefox, and WebKit.
- Done: DOM mutation repair no longer restores removed managed nodes when the
  same mutation adds a managed replacement, so Svelte-owned remounts cannot
  resurrect stale text/block DOM.
- Done: DOM mutation repair remounts a live text from the Yjs model when the
  browser adds an Edytor-shaped managed mark subtree whose visible text no
  longer matches the model.
- Done: keyboard tab focus into the editor restores the cached model selection
  instead of accepting browser focus-time caret reset to the first editable
  text.
- Done: direct programmatic `edytor.node.focus()` after external focus restores
  the cached model selection before the next input, without requiring a manual
  post-focus selection reset.
- Done: real-browser paragraph split undo/redo restores both the two-block
  document shape and caret in the second block across Chromium, Firefox, and
  WebKit.
- Done: real-browser Backspace at the first code-line start and Delete at the
  last code-line end keep the code island isolated from surrounding root
  paragraphs across Chromium, Firefox, and WebKit.
- Done: real-browser Tab inside a code line inserts a tab character instead of
  moving focus, and Tab accepts code suggestions across Chromium, Firefox, and
  WebKit.
- Done: real-browser Shift+Tab unnests nested blocks through the model instead
  of moving focus, for both caret selection and selected-block state across
  Chromium, Firefox, and WebKit.
- Done: real-browser typing after an inserted code-line tab keeps code/pre
  whitespace model-owned and preserves the exact visible text/caret across
  Chromium, Firefox, and WebKit.
- Done: real-browser ArrowUp from the second code line keeps code-island
  selection live; the next typed character mutates the first code line and
  restores a collapsed code-line caret across Chromium, Firefox, and WebKit.
- Done: browser `mod+a` cycles to model-level document block selection and
  Backspace deletes every root block to one editable empty fallback block with
  the caret restored at offset `0`.
- Done: mobile non-cancelable `insertParagraph` inside a code line splits the
  code line, removes native paragraph drift, and keeps the caret inside the
  code island across mobile Chromium and mobile WebKit.
- Done: mobile non-cancelable `insertLineBreak` inside a code line splits the
  code line, removes native `<br>` drift, and keeps the caret inside the code
  island across mobile Chromium and mobile WebKit.
- Done: the demo route `/` directly asserts that toggling bold on selected
  marked text does not duplicate visible paragraph text, and that `. `
  auto-dot payloads preserve the existing word instead of deleting it.
- Done: collapsed mark typing followed by Space/Backspace is directly asserted
  on `/` before undo runs, so stale marked text cannot be resurrected at the
  immediate deletion boundary.
- Done: undoing a Backspace inside marked text on `/` refreshes connected text
  DOM from the Yjs model after history selection restoration, so stale
  browser-cloned marked spans cannot remain visible.
- Done: paragraph insertion closes its history capture group after the
  structural split, so typing in the newly-created paragraph undoes separately
  from the split across Chromium, Firefox, and WebKit.
- Done: hidden stale placeholder elements are removed after split/type/undo/redo
  on `/`, so DOM text no longer contains repeated placeholder strings while the
  model value is correct.
- Done: input-only replacement over an expanded model selection is model-owned
  without introducing an extra async checkpoint for non-text `input` events, so
  marked DOM reconciliation cannot duplicate text after synthetic or browser
  fallback input.
- Done: collapsed browser-owned `insertReplacementText` keeps the
  beforeinput-time text target when native selection jumps before the follow-up
  `input`, so autocorrect/spellcheck replacement can reconcile text and restore
  the caret to the edited block instead of the browser-jumped block.
- Done: browser-owned replacement reconciliation accepts compatible text input
  follow-ups, so `beforeinput.insertReplacementText` followed by
  `input.insertText` still uses the pending beforeinput-time target instead of
  trusting a browser-jumped selection.
- Done: browser-owned replacement reconciliation also tolerates a follow-up
  `input` event with an empty or unavailable `inputType`, preserving the
  pending beforeinput-time replacement target and inferred caret.
- Done: browser-owned collapsed Backspace/Delete reconciliation also tolerates
  a follow-up `input` event with an empty or unavailable `inputType`, keeps the
  beforeinput-time delete target, records deletion as its own history step, and
  restores undo/redo caret positions from the correct pre/post-delete offsets.
- Done: input-only native `historyUndo`/`historyRedo` fallback is model-owned.
  When the browser mutates text DOM before an `input.historyUndo`, Edytor runs
  the undo manager instead of treating the DOM diff as a new edit, preserving
  redo stack semantics and restoring the caret after redo.
- Done: unfocused input-only native `historyUndo`/`historyRedo` fallback is
  covered. When an outside native input owns focus but a history input event
  still arrives from editable DOM, Edytor syncs internal history/value and keeps
  cached model selection coherent.
- Done: embedded native controls inside void blocks own typing, Backspace, and
  Enter. Their beforeinput/input/keydown events are ignored by the outer editor
  by live event target, not by stale cached editor selection.
- Done: external toolbar/control commands use the preserved Edytor model
  selection after the browser moves focus or DOM selection away from the
  editor. A focused external button can run a block-conversion command and
  still convert the originally selected block across Chromium, Firefox, and
  WebKit.
- Done: readonly browser text selections map into Edytor selection state across
  Chromium, Firefox, and WebKit. Mutation keys such as printable typing and
  Backspace are prevented as no-ops when the native selection is inside the
  readonly editor, including WebKit keydowns whose event target is outside the
  editor root.
- Not started in this tracker: no broader Notion product features, DnD,
  collaboration UX, slash menu, or command palette work belongs to this
  cross-browser slice.

## Ledger Updates

- 2026-06-20: completed Phase 1 visible regression quarantine for root-route
  selection routing after real clicks into non-first editable text.
  - Added focused demo-route browser coverage for locator-backed clicks into
    `World`, nested child paragraphs `One` and `Two`, and the code line. The
    next typed character must mutate only the clicked editable text leaf, never
    the first parent `hello` text.
  - Added focused demo-route coverage for `End` then `Enter` after a real click
    into nested `One`. The split must happen inside the nested child block, not
    at the parent paragraph.
  - Runtime patch not required in this worktree: the new regression passed
    against the current implementation across Chromium, Firefox, and WebKit,
    and an extra Chromium smoke passed against the exact dev URL
    `http://127.0.0.1:5173/`.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "routes real clicks|routes enter" --workers=1 --project=chromium`
    passed 2 tests.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "routes real clicks|routes enter" --workers=1 --project=firefox --project=webkit`
    passed 4 tests.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1`
    passed 45 tests across Chromium, Firefox, and WebKit.
  - Verification: local Playwright Chromium smoke against
    `http://127.0.0.1:5173/` passed for `World`, `One`, `Two`, code-line
    typing, and nested-`One` Enter routing. The dev server printed existing
    Svelte hydration warnings, but no selection routing failure was observed.

- 2026-06-19: completed Phase 10 scale, property, and browser-matrix hardening.
  - Matrix evidence: `playwright.config.ts` already declares `chromium`,
    `firefox`, and `webkit` projects for non-mobile specs, plus
    `mobile-chromium` and `mobile-webkit` projects matched to mobile specs.
  - Model coverage added deterministic scale fixtures for 1,000 and 5,000 flat
    blocks, 100-level nesting, many marks, and many inline blocks.
  - Model coverage added a deterministic operation-sequence/property fixture
    covering insert, split, merge, delete range, nest, unnest, move, mark
    toggle, undo, and redo with invariants after each step.
  - Browser hardening fixed blurred programmatic Yjs text updates stealing focus
    back into the editor after an external control was focused.
  - Browser hardening fixed reverse-selection mark toggle restoration, link-edge
    typing mark preservation, selected-block Shift+Tab selection restoration,
    and fast undo/redo history selection races across Firefox/WebKit.
  - Test harness hardening releases `Meta`, `Control`, `Shift`, and `Alt` after
    each browser test so one spec cannot leak modifier state into the next.
  - Browser matrix note: WebKit's headless `page.mouse` drag does not reliably
    extend native selections across sibling `contenteditable` paragraphs. That
    case is explicitly skipped only for WebKit; WebKit selection mapping remains
    covered by native range and keyboard-selection specs.
  - Verification: `pnpm test -- --run
src/tests/fixtures/model/phase10-scale.test.ts
src/tests/fixtures/model/phase10-operation-sequence.test.ts` passed 303 tests
    across the current model suite.
  - Verification: `pnpm test:dom --
src/tests/fixtures/dom/plugins.fixtures.tsx` passed 109 mounted DOM tests.
  - Verification: focused Playwright cluster for reverse selection, link-edge
    typing, selected-block unnest, paragraph split history restoration, sibling
    drag selection, and slash menu passed with 26 passed and 1 documented WebKit
    skip.
  - Verification: `pnpm test:typecheck`, `pnpm test:dom:typecheck`,
    `pnpm check`, and `pnpm lint` passed with 0 errors.
  - Late browser-backed fixes: placeholder-click slash menu typing now opens
    from browser-owned text reconciliation, and mobile WebKit non-cancelable
    code-line Enter/line-break drift now restores the normalized code-line
    caret while removing unmanaged native DOM drift.
  - Verification: `pnpm test:integration
tests/editor-dom/slash-menu.spec.ts --workers=1` passed 6 tests across
    Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:integration
tests/editor-dom/mobile-beforeinput.spec.ts --project=mobile-webkit --grep
"code line" --workers=1` passed 2 tests.
  - Verification: `pnpm test:integration
tests/editor-dom/mobile-beforeinput.spec.ts --project=mobile-webkit
--workers=1` passed 34 tests.
  - Verification: `pnpm test:integration
tests/editor-dom/mobile-beforeinput.spec.ts --project=mobile-chromium --grep
"code line" --workers=1` passed 2 tests.
  - Verification: `pnpm release:check` passed on 2026-06-19 19:38 CEST with
    303 model tests, 109 mounted DOM tests, 1,077 Playwright browser passes, 12
    documented skips, `pnpm build`, package, and `publint`.

- 2026-06-19: completed Phase 9 collaboration and persistence hardening.
  - Material gaps: collaboration was mostly engine plumbing. There was no
    verified public sync helper API, no focused provider lifecycle coverage, no
    browser-visible remote awareness selection coverage, and README claims were
    broader than the verified product surface.
  - Runtime/API result: exported collaboration helpers for IndexedDB and
    websocket sync, passed Edytor's awareness object through provider setup,
    published local selection into awareness, rendered remote cursor/selection
    overlays from awareness state, and cleaned up provider-owned awareness on
    destroy.
  - Documentation result: README now describes Yjs collaboration primitives,
    IndexedDB/websocket setup, awareness user metadata, remote selection
    rendering, and unsupported auth/permissions/hosted persistence guarantees.
  - Browser coverage: added `tests/editor-dom/collaboration.spec.ts` for
    remote cursor rendering, offline IndexedDB reload, and provider awareness
    cleanup across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test -- --run src/tests/fixtures/model/collaboration` passed 297
    tests across 10 files.
  - Verification:
    `pnpm test:dom -- src/tests/fixtures/dom/collaboration` passed 109 tests
    across 2 files.
  - Verification:
    `lsof -ti :4173 | xargs -r kill` completed before focused browser checks.
  - Verification:
    `pnpm test:integration tests/editor-dom/collaboration.spec.ts --workers=1`
    passed 9 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm check` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` and `git diff --check` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, typed `One`, selected/toggled bold, typed replacement
    text without visible duplication, pressed Enter, typed `Two`, and undo/redo
    restored the visible document. The deterministic `/test/dom?scenario=selection`
    route rendered serialized value correctly and emitted no console/page errors.
  - In-app Browser caveat: the browser plugin's read-only evaluation context did
    not expose `window.__EDYTOR__`, so manual remote-client injection was not
    possible there. Treat remote awareness overlay behavior as proven by the
    Playwright collaboration spec above.
  - Remaining risk: websocket setup is API/example covered but not verified
    against a hosted websocket server. Auth, permissions, and hosted persistence
    guarantees remain explicitly unsupported.

- 2026-06-19: completed Phase 8 Notion-like product-layer browser hardening.
  - Material gaps: clicking non-native editable block chrome could leave a stale
    browser selection before destructive keys; block-handle chrome leaked `::`
    into visible/text content assertions; single-block markdown shortcut
    conversion could update the model while leaving stale paragraph DOM.
  - Runtime fixes: non-native `contenteditable=false` block chrome now captures
    pointer selection into the block's first editable text; block-handle glyphs
    render through generated CSS content rather than text nodes; converted
    blocks remount from `block.renderVersion`/snippet keys; markdown shortcut
    conversion updates model selection before async DOM restoration.
  - Browser coverage: added a regression for rendering a markdown shortcut
    conversion when it is the only document block in
    `tests/editor-dom/markdown-shortcuts.spec.ts`.
  - Verification:
    `lsof -ti :4173 | xargs -r kill` completed before focused browser checks.
  - Verification:
    `pnpm test:integration tests/editor-dom/features.spec.ts -g "contenteditable=false island" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/features.spec.ts -g "native buttons inside void blocks|contenteditable=false island" --workers=1`
    passed 6 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/markdown-shortcuts.spec.ts --workers=1`
    passed 6 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/markdown-shortcuts.spec.ts tests/editor-dom/slash-menu.spec.ts tests/editor-dom/toolbar.spec.ts tests/editor-dom/block-handles.spec.ts tests/editor-dom/features.spec.ts --workers=1`
    passed 72 tests.
  - Verification:
    `pnpm test:dom -- src/tests/fixtures/dom/dom.test.ts -t "slash menu|toolbar|block handle|keyboard fallback"`
    passed 107 tests.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1`
    passed 36 tests.
  - Verification:
    `pnpm test -- --run src/tests/fixtures/model/operations.test.ts -t "notion|markdown"`
    passed 294 tests across 9 files.
  - Verification: `pnpm check`, `pnpm test:typecheck`, and
    `pnpm test:dom:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` and `git diff --check` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared to one empty paragraph, typed `One`, selected text, toggled bold,
    typed more text, pressed Enter, typed `Two`, undo/redo restored the visible
    blocks, and a stepwise `## Title` shortcut rendered as a real `h2` without
    visible DOM duplication.
  - Remaining risk: empty sibling block-handle host shells can remain after a
    clear/remount. They are non-visible and contain no text or handle button, so
    broad browser specs and the live editor smoke stayed green. Do not reopen
    this unless a fresh browser-backed failure proves user-visible impact.

- 2026-06-19: completed real browser drag-selection mark formatting across
  inline atomic mentions.
  - Material gap: Edytor already covered real browser drag-created selections
    across inline mention atoms for deletion, and native format/remove commands
    over target ranges. It did not cover the combined native mouse-drag range
    across text + inline mention + text followed by a mark hotkey.
  - Browser coverage: added
    `drag-selected inline mention range can be mark-formatted` to
    `tests/editor-dom/inline-atomic.spec.ts`.
  - Runtime result: no production patch was needed. Existing drag-selection
    repair and rich-text mark operations already preserve the inline atom,
    apply marks to both selected text segments, restore the expanded model
    selection, and keep managed DOM from duplicating.
  - Browser differences: none observed. Chromium, Firefox, and WebKit produced
    the same model, selection, and managed DOM shape.
  - Verification:
    `lsof -ti :4173 | xargs -r kill` completed before browser checks.
  - Verification:
    `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts -g "drag-selected inline mention range can be mark-formatted" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts --workers=1`
    passed 42 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm check` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.

- 2026-05-25: completed Android-style composition DOM mutation without
  `beforeinput`, plus root-route Shift+Tab and visible DOM-duplication
  follow-up.
  - DeepWiki findings: Slate's Android input manager and ProseMirror/Lexical DOM
    reconciliation treat IME composition as a DOM-mutation surface, not only a
    clean `beforeinput` stream. Android keyboards can mutate text DOM while
    composition is active and send only composing `input`/mutation signals.
  - Material gap: Edytor had runtime support for idle composition mutation
    reconciliation and broad non-composition DOM mutation coverage, but no
    browser regression proving an active composition DOM mutation without
    `beforeinput` commits once, restores the caret, clears composing state, and
    ignores a later duplicate `compositionend`.
  - Browser coverage: added
    `reconciles composition DOM mutation when beforeinput is missing` to
    `tests/editor-dom/composition.spec.ts`.
  - Runtime fix from the live localhost smoke: `unNestBlock()` now deletes the
    nested child before inserting the recreated root sibling from the model
    snapshot, matching the stable `nestBlock()` mutation order. Editor-origin
    `keydown` is handled on the editable root capture phase so Tab/Shift+Tab
    prevent native `contenteditable` drift before the document-level fallback
    listener runs. Structural hotkey caret restoration refreshes block children
    and remounts the editable root from the live model when browser mutation
    corrupts Svelte's internal anchors. A hidden managed render anchor keeps the
    editable root end stable for append-at-end structural moves. `ISO_Left_Tab`
    and `Backtab` key aliases normalize to `shift+tab`.
  - Browser coverage from the live localhost smoke: added
    `unnests a newly split soft-break block with shift+tab in the real browser`
    and `treats browser reverse-tab key aliases as shift+tab` to
    `tests/editor-dom/hotkeys.spec.ts`, plus
    `unnests a newly split soft-break paragraph on shift+tab` to
    `tests/editor-dom/demo-route.spec.ts`.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "composition DOM mutation" --workers=1`
    passed across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts -g "reverse-tab|shift\\+tab|newly split soft-break|clearing a previously nested" --workers=1`
    passed 15 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1`
    passed 36 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "composition DOM mutation" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification: a local Playwright script repeated the root-route
    `clear -> type One -> Enter -> type Two -> Shift+Enter -> type Br -> Tab -> Shift+Tab`
    flow 10 consecutive times in WebKit and observed `["One", "Two\nBr"]` every
    time after the final fix.
  - Verification: `pnpm test -- --run` passed 269 tests.
  - Verification: `pnpm test:dom` passed 90 tests.
  - Verification: `pnpm check`, `pnpm test:typecheck`, and
    `pnpm test:dom:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared to one empty focused block, typed `One`, then selected a suffix,
    toggled bold, and typed `X`. The live DOM stayed coherent as `One` and
    `OneX` respectively with one managed text wrapper and no visible duplicate
    content.
  - In-app Browser caveat: the Browser plugin's `locator.press('Enter')` path
    does not reliably exercise the same native paragraph-split path as normal
    Playwright `page.keyboard.press('Enter')`. Treat structural Enter/Tab
    behavior as proven by the Playwright browser specs above, not by that
    synthetic in-app path.

- 2026-05-25: completed Safari-shaped final `insertFromComposition`
  composition-state boundary.
  - DeepWiki findings: Slate treats Safari
    `beforeinput.insertFromComposition` as the composition commit boundary
    because Safari can dispatch the final beforeinput before `compositionend`.
    If the editor stays in composing mode after that final beforeinput,
    selection stabilization and subsequent key handling can remain suppressed
    until the later `compositionend`.
  - Material gap: Edytor already covered `insertFromComposition` value
    insertion, replacement of intermediate preview text, compositionend-only
    commits, and late `compositionend` duplicate prevention. It did not lock
    the state boundary immediately after the final `insertFromComposition`
    beforeinput.
  - Proven gap before runtime patch:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "ends composing state" --workers=1 --project=webkit`
    failed because the committed text was present but Edytor selection stayed
    at offset `0` instead of the committed-text boundary while composition
    state remained active.
  - Runtime fix: `insertFromComposition` now treats the final beforeinput as a
    commit boundary, clears `compositionState`, `compositionStartReplacementState`,
    `isComposing`, and `hasHandledCompositionInput`, then runs composition
    selection stabilization. A later `compositionend` therefore becomes a
    no-op instead of a second commit.
  - Browser coverage: added
    `ends composing state after final insertFromComposition before compositionend`
    to `tests/editor-dom/composition.spec.ts`.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "insertFromComposition|ends composing state" --workers=1`
    passed 9 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run` passed 269 tests.
  - Verification: `pnpm check`, `pnpm test:typecheck`, and
    `pnpm test:dom:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed after formatting
    `src/lib/events/onBeforeInput.ts`.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, typed through the live editable surface, toggled
    a bold mark, used Enter, Shift+Enter, Tab, Shift+Tab, Backspace, undo, and
    redo. The visible editor text stayed coherent, the editor remained focused,
    and no browser console errors were emitted.

- 2026-05-25: completed physical Shift+Tab block unnest coverage.
  - DeepWiki findings: Lexical intercepts Tab/Shift+Tab keydowns and dispatches
    indentation/outdentation commands instead of letting browser focus
    navigation own the editor surface. ProseMirror and Slate provide keymap or
    plugin hooks where handled Tab/Shift+Tab commands prevent default and apply
    model transforms. Svedit currently leaves Tab unowned, matching the
    browser-default behavior Edytor should avoid for its existing block-nesting
    command.
  - Proven gap before runtime patch:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts -g "shift\\+tab" --workers=1 --project=chromium`
    initially left the `note` paragraph nested under `lead` after physical
    `Shift+Tab`.
  - Runtime fix: the default hotkey map now handles `shift+tab`, prevents
    default browser focus traversal, calls the existing `unNestBlock()`
    operation, and restores either the caret target or selected-block state on
    the newly unnested block.
  - Browser coverage: added
    `unnests the current block with shift+tab in the real browser` and
    `unnests a selected block with shift+tab in the real browser` to
    `tests/editor-dom/hotkeys.spec.ts`.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts -g "shift\\+tab" --workers=1`
    passed 6 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts -g "tab|code-line tab|suggestion.*Tab" --workers=1`
    passed 24 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run`, `pnpm test:dom`, `pnpm check`,
    `pnpm test:typecheck`, `pnpm test:dom:typecheck`, and `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, typed through the live editable surface, toggled
    a bold mark, used Enter, Tab, Shift+Tab, Shift+Enter, Backspace, undo, and
    redo, and checked the live DOM for unmanaged root text nodes and console
    errors. The root route stayed focused with no console errors; the
    authoritative Shift+Tab structural proof is the Playwright browser matrix
    above because the in-app Browser key sequence did not reliably create a
    nested block from the root route before Shift+Tab.
  - Follow-up in-app Browser verification on `http://localhost:5173/`: bulk
    Browser typing is currently blocked by the Browser plugin's virtual
    clipboard setup, so the smoke used physical key presses. Key-by-key text
    input, collapsed bold toggling, selected-block bold toggling, Enter,
    Tab/Shift+Tab, and undo/redo did not reproduce the earlier visual DOM text
    duplication or emit console errors.

- 2026-05-25: completed forward structural Delete target-range coverage.
  - DeepWiki findings: Slate and Lexical prevent default for complex delete
    input types and route them through semantic delete commands instead of
    blindly applying browser `getTargetRanges()` across nodes or blocks. They
    use target ranges with caveats, especially on Android/WebKit, but
    structural deletion remains model-owned.
  - Material gap: Edytor already covered text-local Delete target ranges and
    cross-text Backspace target ranges, but not a cross-text
    `deleteContentForward` target range at a block boundary.
  - Browser coverage: added
    `ignores cross-text delete target ranges so structural delete still merges blocks`
    to `tests/editor-dom/input.spec.ts`.
  - Runtime result: no runtime patch was needed. The existing target-range
    safety rejects the unsafe cross-text range and the cached caret still
    routes Delete through the semantic forward-merge command.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "structural delete still merges" --workers=1 --project=chromium`
    passed 1 test.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "cross-text delete target ranges" --workers=1`
    passed 6 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "text-local .*delete target ranges|cross-text delete target ranges" --workers=1`
    passed 12 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts --workers=1`,
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "auto-dot|does not delete preceding non-space text" --workers=1`,
    and `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1`
    passed after rechecking the user-reported root-route duplicate-DOM and
    auto-dot flows.
  - Verification: `pnpm test -- --run`, `pnpm check`,
    `pnpm test:typecheck`, `pnpm test:dom:typecheck`, and `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    route, clicked the editable root, typed `One`, toggled bold for `Bold`,
    toggled bold off for `Tail`, inserted a soft break, typed `Soft`, used
    Backspace, pressed Tab, used undo/redo, pressed Enter, and typed `Next`.
    The live editor rendered two managed paragraphs after the split, kept one
    bold wrapper around `Bold`, had no unmanaged root text nodes, and emitted no
    console errors. A follow-up mark/double-space probe did not reproduce the
    visible duplicate DOM on a freshly reset root route.

- 2026-05-25: completed partial inside/outside beforeinput target-range
  coverage.
  - DeepWiki findings: Slate and Lexical only accept DOM selections/target
    ranges whose endpoints resolve inside the editor root; otherwise they keep
    the previous editor selection. Svedit gates input and selection work by
    active canvas/root containment and selection common-ancestor containment.
  - Material gap: Edytor already covered native selections that cross the
    editor boundary and wholly outside beforeinput target ranges, but not
    `beforeinput.getTargetRanges()` values with one endpoint inside the editor
    and one endpoint in external DOM.
  - Browser coverage: added
    `prevents partial editor-to-outside target range beforeinput without mutating stale editor selection`
    and
    `prevents partial outside-to-editor target range beforeinput without mutating stale editor selection`
    to `tests/editor-dom/input.spec.ts`.
  - Runtime result: no runtime patch was needed. The current target-range
    containment guard rejects the crossing-boundary ranges before snapshotting
    stale selection, prevents the event, leaves the document unchanged, and
    preserves the previous valid editor caret.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "partial .* target range" --workers=1 --project=chromium`
    passed 2 tests.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "partial .* target range" --workers=1`
    passed 6 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "outside target range|partial .* target range|uses beforeinput target ranges" --workers=1`
    passed 12 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run`, `pnpm check`,
    `pnpm test:typecheck`, `pnpm test:dom:typecheck`, and `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    route, clicked the editable root, typed `One`, toggled bold for `Bold`,
    toggled bold off for `Tail`, inserted a soft break, typed `Soft`, used
    Backspace, pressed Tab, used undo/redo, pressed Enter, and typed `Next`.
    The live editor rendered two managed paragraphs after the split, kept one
    bold wrapper around `Bold`, had no unmanaged root text nodes, and emitted no
    console errors.

- 2026-05-25: completed late `compositionend` after blur coverage.
  - DeepWiki findings: Svedit checks whether focus still belongs to the editor
    before committing `compositionend`; Lexical clears composition identity and
    carries browser-specific late-ordering flags; ProseMirror tracks composition
    IDs and clears stale state through DOM-observer flushing; Slate clears
    composing state asynchronously and cleans up after blur.
  - Material gap: Edytor already covered a missing `compositionend` after blur,
    but not a delayed `compositionend.data` arriving after the dangling
    composition reset.
  - Browser coverage: added
    `ignores late compositionend data after blur clears dangling composition`
    to `tests/editor-dom/composition.spec.ts`.
  - Runtime result: no runtime patch was needed. The current dangling
    composition reset clears composing state before the late event arrives, so
    the stale IME payload is ignored and a later fresh caret edit still inserts
    normally.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "ignores late compositionend" --workers=1 --project=chromium`
    passed.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "ignores late compositionend" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "splits a cleared paragraph|does not coalesce typing after a paragraph split|does not duplicate visible text|does not leave stale visible DOM clones" --workers=1 --project=chromium`
    passed 4 root-route Chromium tests.
  - Verification: `pnpm test -- --run`, `pnpm check`,
    `pnpm test:typecheck`, `pnpm test:dom:typecheck`, and `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    route, clicked the editable root, typed `One`, toggled bold for `Bold`,
    toggled bold off for `Tail`, inserted a soft break, typed `Soft`, used
    Backspace, pressed Tab, and used undo/redo. The live editor had one managed
    block, one bold wrapper around `Bold`, no unmanaged root text nodes, and no
    console errors.
  - Tooling caveat: this in-app Browser session could not make Enter split the
    paragraph through either locator or low-level keypress APIs. The real
    Playwright `/` split and split-history specs above passed, so no runtime
    change was made from that browser-control artifact.

- 2026-05-25: completed native `formatRemove` target-range coverage.
  - DeepWiki findings: Slate and Svedit prevent native formatting DOM mutation
    and route formatting input through model commands; Lexical dispatches text
    formatting commands and restores selection from editor state; ProseMirror
    can reconcile browser mark-removal DOM changes but still treats editor state
    as authoritative.
  - Material gap: Edytor covered native format toggles and collapsed
    `formatRemove`, but not a browser remove-format event whose
    `getTargetRanges()` selected a mixed-mark range spanning an inline atom
    while the cached editor selection was stale.
  - Browser coverage: added
    `uses formatRemove target ranges across mixed marks and inline atoms` to
    `tests/editor-dom/format-beforeinput.spec.ts`.
  - Runtime result: no runtime patch was needed. The new browser case passes
    with the existing `beforeinput.getTargetRanges()` selection sync and
    rich-text `formatRemove` model command. The first focused run failed only
    because the test counted nested inline-attachment DOM nodes as separate
    mentions; the assertion now counts top-level inline atoms, matching the
    existing inline tests.
  - Verification:
    `pnpm test:integration tests/editor-dom/format-beforeinput.spec.ts -g "formatRemove target ranges" --workers=1 --project=chromium`
    passed.
  - Verification:
    `pnpm test:integration tests/editor-dom/format-beforeinput.spec.ts --workers=1`
    passed 27 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts -g "tab" --workers=1 --project=chromium`
    passed 6 Chromium tab/code-tab hotkey tests.
  - Verification: `pnpm check`, `pnpm test:typecheck`,
    `pnpm test:dom:typecheck`, `pnpm lint`, and `git diff --check` passed.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    route, clicked the editable root, typed `one`, toggled bold for `bold`,
    toggled bold off for `tail`, inserted a soft break, typed `soft`, used
    Backspace, pressed Tab, and used undo/redo. The visible editor had one
    managed block, one bold wrapper, no unmanaged root text nodes, no placeholder
    duplicates, and no console errors.
  - Tooling caveat: the in-app Browser locator backend could not keep focus on
    the root-route code-line locator for a code Tab smoke. The real Playwright
    code Tab hotkey tests above passed, so no runtime patch was made from that
    browser-control artifact.

- 2026-05-25: completed dynamic readonly transition hardening.
  - DeepWiki findings: Slate gates `selectionchange`, `beforeinput`, `input`,
    and `keydown` while `readOnly` is active and separates selectable readonly
    text from mutation commands; Lexical tracks non-editable selection without
    allowing mutation; Svedit flips `contenteditable` from the editable prop.
  - Material gap: Edytor covered routes loaded as readonly, but not an already
    selected editable editor that is later switched to `contenteditable=false`.
  - Browser coverage: added
    `keeps dynamic readonly transitions immutable with stale model selection`
    to `tests/editor-dom/features.spec.ts` and added a test-only dynamic
    readonly toggle to `/test/dom`.
  - Proven gap before runtime patch:
    `pnpm test:integration tests/editor-dom/features.spec.ts -g "dynamic readonly" --workers=1 --project=chromium`
    failed because the DOM root reported `contenteditable=false` while a
    synthetic `beforeinput.insertText` still changed the model from `note` to
    `nXe`.
  - Runtime fix: `src/lib/components/Edytor.svelte` now synchronizes the
    reactive component `readonly` prop into the live `Edytor.readonly` state, so
    existing beforeinput/input/keydown readonly guards remain accurate after
    prop transitions.
  - Verification:
    `pnpm test:integration tests/editor-dom/features.spec.ts -g "dynamic readonly" --workers=1`
    passed across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/features.spec.ts -g "readonly" --workers=1`
    passed 9 readonly tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "splits a cleared paragraph|does not coalesce typing after a paragraph split|visible mark-toggle|auto-dot" --workers=1 --project=chromium`
    passed 3 matched demo-route split/auto-dot tests.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "does not duplicate visible text when toggling a mark|does not duplicate marked text after undoing a deletion|clears to one editable paragraph" --workers=1 --project=chromium`
    passed 3 demo-route duplication tests.
  - Verification: `pnpm check`, `pnpm test:typecheck`,
    `pnpm test:dom:typecheck`, `pnpm lint`, and `git diff --check` passed.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    route, clicked the editable root, typed `one`, toggled bold for `bold`,
    toggled bold off for `tail`, then used undo/redo. The visible editor had
    one managed block, one bold wrapper, no unmanaged root text nodes, no
    placeholder duplicates, and no console errors.
  - Tooling caveat: the in-app Browser keypress backend did not deliver a
    useful real `Enter` paragraph split to the contenteditable root in this
    session. The real Playwright demo-route split/undo tests above passed, so no
    runtime patch was made from that browser-control artifact.

- 2026-05-25: completed Chrome-style nested inline mark DOM repair for links.
  - DeepWiki findings: ProseMirror explicitly documents Chrome flipping the
    nesting order of edited inline nodes, especially `<a>` marks on decorated
    text; Lexical removes or reconciles unrecognized DOM mutations from its
    authoritative editor state; Slate prevents risky native input at link and
    mark boundaries.
  - Material gap: Edytor already covered link-boundary typing and generic marked
    wrapper repair, but did not prove browser-flipped `link` + `bold` DOM order
    inside one managed text would be repaired when logical `textContent` was
    unchanged.
  - Browser coverage: added
    `repairs browser-flipped nested link and bold mark DOM from the model` to
    `tests/editor-dom/dom-mutation.spec.ts`. The test applies bold to an
    existing link, simulates a browser replacing the canonical nested mark DOM
    with the opposite link/bold wrapper order, and asserts the model marks,
    canonical DOM, and collapsed caret are restored.
  - Proven gap before runtime patch:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts -g "flipped nested link" --workers=1 --project=chromium`
    failed because the model stayed correct but the stale browser-flipped DOM
    remained mounted.
  - Runtime fix: DOM mutation repair now refreshes managed text subtrees from
    the model whenever a managed subtree mutates, even if logical text content
    is unchanged. This keeps model-owned mark nesting authoritative.
  - Verification:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts -g "flipped nested link" --workers=1 --project=chromium`
    passed after the runtime patch.
  - Verification:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts --workers=1`
    passed 36 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "link anchor|browser-cloned mark|marked content|auto-dot" --workers=1`
    passed 9 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed and `git diff --check` passed for touched
    files.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    route, typed `One`, toggled bold for `Bold`, toggled bold off, typed
    `Tail`, inserted a soft break and `Sof`, used Backspace, split with Enter,
    typed `Two`, then used undo/redo. The live DOM had two blocks, one bold mark
    wrapper around `Bold`, no unmanaged root text, `hasDuplicateDisplay=false`,
    and no page console warnings or errors.

- 2026-05-25: rechecked the live root-route editing report on
  `http://localhost:5173/`.
  - Scope: ledger-only verification. No runtime code was changed.
  - In-app Browser verification: on the active `/` tab, used `clear`, clicked
    the editable root, typed `One`, toggled bold for `Bold`, toggled bold off,
    typed `Tail`, and inserted two spaces. The rendered DOM contained one
    managed text node and one bold mark wrapper around `Bold`; no duplicated
    visible text or console warnings/errors were observed.
  - In-app Browser verification: using the page locator path on the same tab,
    `One`, Enter, `Two` produced two paragraph blocks. First undo removed `Two`
    and left the split empty paragraph; second undo restored the single `One`
    paragraph. No console warnings/errors were observed.
  - Tooling caveat: the lower-level DOM click/key helper did not synthesize a
    reliable Enter paragraph split in the in-app Browser and collapsed `One`
    Enter `Two` to `OneTwo`. The page locator path and the cross-browser
    Playwright regression below both exercised the real browser flow correctly,
    so no runtime patch was made from that artifact.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "duplicate|auto-dot|clears to one editable|split|undo" --workers=1`
    passed 21 tests across Chromium, Firefox, and WebKit.

- 2026-05-25: completed nested native-control composition isolation.
  - DeepWiki findings: Slate ignores composition events fired from nested
    `input`/`textarea` controls; Lexical and ProseMirror keep editor IME state
    scoped to the editable surface; Svedit treats native controls and cursor
    traps as explicit browser-ownership boundaries.
  - Material gap: Edytor already let nested native controls inside void blocks
    own typing, Backspace, Enter, and button activation keys, but had no browser
    regression proving native-control `compositionstart` could not poison
    Edytor's composition state.
  - Browser coverage: added
    `lets native composition inside void controls stay outside the editor model`
    to `tests/editor-dom/features.spec.ts`. The test focuses the figure input,
    dispatches a bubbling native-control `compositionstart` and composing
    `input`, intentionally omits `compositionend`, asserts the native input owns
    the value, asserts `edytor.isComposing` remains false, then verifies the next
    editor bold hotkey and typed insertion still work.
  - Proven gap before runtime patch:
    `pnpm test:integration tests/editor-dom/features.spec.ts -g "native composition inside void" --workers=1 --project=chromium`
    failed because `edytor.isComposing` stayed `true` after the nested native
    input compositionstart.
  - Runtime fix: `onCompositionStart` and `onCompositionEnd` now ignore events
    whose target is inside a native interactive control, matching the existing
    beforeinput/input/keydown ownership guard for nested controls.
  - Verification:
    `pnpm test:integration tests/editor-dom/features.spec.ts -g "native composition inside void" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/features.spec.ts -g "native controls inside void|native buttons inside void|native composition inside void|editable captions" --workers=1`
    passed 12 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`, used
    `clear`, clicked the editable surface, typed `One`, toggled bold for `Bold`,
    toggled bold off, typed `Tail`, inserted a Shift+Enter soft break, typed
    `Soft`, used Backspace, pressed Enter, typed `Two`, used undo/redo, and
    pressed Tab. The live DOM had two blocks, one bold mark wrapper around
    `Bold`, `hasDuplicateDisplay=false`, and no browser console warnings or
    errors.

- 2026-05-25: completed WebKit/Safari converted-space DOM normalization.
  - DeepWiki findings: ProseMirror explicitly restores WebKit/Safari
    converted-space spans to normal spaces, including
    `span.Apple-converted-space`; Lexical and Slate carry WebKit-specific
    whitespace/selection compatibility paths; Svedit treats browser DOM as an
    observed source that must be diffed back into the model rather than trusted
    as editor state.
  - Material gap: Edytor had root-route double-space smoke coverage and HTML
    parser `&nbsp;` normalization, but no live contenteditable regression for a
    browser inserting an `Apple-converted-space` wrapper containing `\u00A0`.
  - Browser coverage: added
    `normalizes WebKit converted-space wrappers to logical spaces` to
    `tests/editor-dom/dom-mutation.spec.ts`. The test inserts a live
    `span.Apple-converted-space` wrapper at the end of `lead`, asserts the model
    value is `lead ` with a normal space, asserts the wrapper is removed, and
    asserts the caret lands at offset `5`.
  - Proven gap before runtime patch:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts -g "normalizes WebKit converted-space" --workers=1 --project=chromium`
    failed because Edytor stored `lead\u00A0` instead of logical `lead `.
  - Runtime fix: `domTextMutationObserver` now detects added
    `span.Apple-converted-space` nodes before unmanaged-node cleanup, replaces
    their `\u00A0` text with normal-space DOM text, preserves collapsed selection
    inside the wrapper, then lets the existing reconciliation path store the
    logical space in the model.
  - Verification:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts -g "normalizes WebKit converted-space" --workers=1 --project=chromium`
    passed after the runtime patch.
  - Verification:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts -g "normalizes WebKit converted-space" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts --workers=1`
    passed 33 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "duplicate|auto-dot|clears to one editable|split|undo" --workers=1`
    passed 21 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - Verification:
    `git diff --check -- src/lib/events/domTextMutationObserver.ts tests/editor-dom/dom-mutation.spec.ts docs/cross-browser-worklog.md docs/cross-browser-confidence.md`
    passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`, used
    `clear`, clicked the visible empty placeholder, typed `One`, toggled bold for
    `Bold`, toggled bold off, typed `Tail`, inserted a Shift+Enter soft break,
    typed `Soft`, used Backspace, typed `Two`, used undo/redo, and pressed Tab.
    The live DOM had one editable root, one managed text wrapper, one bold mark
    wrapper around `Bold`, `hasDuplicateDisplay=false`, and no duplicated visible
    text. The Browser plugin's DOM-CUA `Enter` keypath did not synthesize the
    same paragraph split path in this session, so paragraph split proof remains
    the Playwright browser gate above rather than this manual Browser pass.

- 2026-05-25: completed browser-created DOM text-node split repair inside
  rendered mark wrappers.
  - DeepWiki findings: ProseMirror reparses affected DOM ranges for child-list
    text changes, Lexical reverts unmanaged child-list text drift and restores
    selection, Slate's Android path validates DOM diffs against the model, and
    Svedit diffs logical text instead of trusting DOM text-node boundaries.
  - Material gap: Edytor already covered text value changes, wrapper insertion,
    wrapper replacement, marked insertion, and deletion-only mark preservation,
    but not no-text-change DOM boundary drift where a browser splits one marked
    text node into adjacent DOM text nodes.
  - Browser coverage: added
    `repairs browser-created text-node splits inside marked DOM` to
    `tests/editor-dom/dom-mutation.spec.ts`. The test splits the rendered bold
    `Alpha` text node into `Al` + `pha`, keeps the caret at logical offset `4`,
    and asserts Edytor restores one rendered bold text node while the model
    remains `{ bold: true } Alpha` plus plain ` beta`.
  - Proven gap before runtime patch:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts -g "repairs browser-created text-node splits" --workers=1 --project=chromium`
    failed because the model stayed correct but the rendered bold leaf remained
    split into two DOM text nodes.
  - Runtime fix: `domTextMutationObserver` now detects child-list mutations
    that add or remove raw DOM text nodes inside a live managed `Text`. When the
    logical text content is unchanged, it refreshes the affected text from the
    model and restores the cached caret. Mutations that change logical text
    still go through the existing text-diff reconciliation path.
  - Verification:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts -g "repairs browser-created text-node splits" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts --workers=1`
    passed 30 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "duplicate|auto-dot|clears to one editable|split|undo" --workers=1`
    passed 21 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - Verification:
    `git diff --check -- src/lib/events/domTextMutationObserver.ts tests/editor-dom/dom-mutation.spec.ts docs/cross-browser-worklog.md`
    passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, typed `One`, toggled bold for `Bold`, toggled bold off,
    typed `Tail`, inserted a Shift+Enter soft break, typed `Soft`, used
    Backspace, split with Enter, typed `Two`, used undo/redo, then pressed Tab.
    The live DOM had one editable root, two paragraph blocks after split/redo,
    managed text wrappers `OneBold Tail\nSof` and `Two`, one bold mark wrapper
    around `Bold`, no stale placeholders, and no browser console warnings or
    errors. After Tab, the second paragraph nested under the first as expected
    while the visible text remained singular.

- 2026-05-25: completed mark-preserving deletion-only `characterData` mutation
  coverage.
  - DeepWiki findings: ProseMirror has DOM-change tests for deleting text in
    markup and preserving marks on deletion; Lexical shrinks formatted
    `TextNode` content while restoring valid selection; Slate keeps pending
    insertion marks around browser-mutated marked leaves; Svedit adjusts
    annotation ranges on deletion-only DOM diffs and collapses selection at the
    deletion boundary.
  - Material gap: Edytor already covered plain `characterData` mutation and
    marked `characterData` insertion, but not deletion-only mutation where no
    inserted character exists to infer marks from.
  - Browser coverage: added
    `preserves deleted mark context after deletion-only characterData mutations`
    to `tests/editor-dom/dom-mutation.spec.ts`. The test deletes the whole
    rendered bold `Alpha` DOM text node through `CharacterData`, types `Z` at
    the deletion boundary, and asserts `Z` is bold while the following ` beta`
    remains plain.
  - Proven gap before runtime patch:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts -g "preserves deleted mark context" --workers=1 --project=chromium`
    failed because the follow-up typed `Z` became plain `Z beta` instead of
    preserving bold context as `Z` plus plain ` beta`.
  - Runtime fix: `onInput` now preserves pending insertion marks for
    deletion-only DOM text diffs when the deleted range has one uniform
    non-empty mark set. Mixed/plain deletion-only diffs remain unchanged, and
    insertion diffs still use the existing pending/neighbor mark logic.
  - Verification:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts -g "preserves deleted mark context" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts --workers=1`
    passed 27 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "duplicate|auto-dot|clears to one editable|split|undo" --workers=1`
    passed 21 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed after formatting the worklog.
  - Verification:
    `git diff --check -- src/lib/events/onInput.ts tests/editor-dom/dom-mutation.spec.ts docs/cross-browser-worklog.md`
    passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, typed `One`, toggled bold for `Bold`, toggled bold off,
    typed `Tail`, inserted a Shift+Enter soft break, typed `Soft`, used
    Backspace, split with Enter, typed `Two`, used undo/redo, then pressed Tab.
    The live DOM had one editable root, two paragraph blocks after split/redo,
    managed text wrappers `OneBold Tail\nSof` and `Two`, one bold mark wrapper
    around `Bold`, no stale placeholders, and no browser console warnings or
    errors. After Tab, the second paragraph nested under the first as expected
    while the visible text remained singular.

- 2026-05-25: re-audited the active in-app Browser tab on
  `http://localhost:5173/` without a runtime patch.
  - Trigger: user clarified the failure surface as the currently open
    localhost demo tab after visible DOM duplication reports.
  - In-app Browser verification: used the active tab without a hard reload,
    cleared the editor, clicked the editor, typed `One`, toggled bold, typed
    `Bold`, toggled bold off, typed `Tail`, pressed double Space, split with
    `Enter`, typed `Two`, then used undo and redo. The live DOM stayed
    singular: one contenteditable root, one managed text wrapper per logical
    text, one bold mark wrapper around `Bold`, no stale placeholder clone, and
    no browser console warnings or errors.
  - Focused browser verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "duplicate|auto-dot|clears to one editable|split|undo" --workers=1`
    passed 21 tests across Chromium, Firefox, and WebKit.
  - Runtime result: no production patch was made because the current live tab
    and the existing cross-browser duplicate/auto-dot/split/undo gates did not
    reproduce the reported model-correct/DOM-duplicated state. If it reappears,
    the next useful evidence is the exact native event sequence immediately
    before the first duplicate, especially whether the tab is carrying stale
    HMR state or an OS/browser autocorrect replacement event.

- 2026-05-25: completed marked characterData-only browser text mutation
  coverage.
  - DeepWiki findings: ProseMirror has DOM-change tests for typing/deleting
    inside markup and preserving marks, Lexical stores formatting on text nodes
    while reconciling DOM mutations, Svedit adjusts annotations during
    text-diff transactions, and Slate avoids native insertion when marks are
    active unless it can preserve leaf formatting.
  - Material gap: Edytor already covered plain characterData-only mutations,
    unmanaged wrapper insertion, browser wrapper replacement, and stale
    managed-mark DOM. It did not directly prove a
    browser/extension/speech/autocorrect-style `CharacterData` rewrite inside a
    rendered mark wrapper.
  - Browser coverage: added
    `preserves marks during marked characterData-only browser text mutations`
    to `tests/editor-dom/dom-mutation.spec.ts`. The test mutates the live DOM
    text node inside a bold mark from `Alpha` to `Alphas`, dispatches no input
    event, and asserts the inserted `s` remains bold, the trailing ` beta`
    remains plain, and the caret lands after `Alphas`.
  - Runtime result: no production patch was needed; the existing DOM text diff
    already preserved insertion marks by inspecting neighboring model marks.
    The new test locks this cross-browser contract.
  - Verification:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts -g "marked characterData" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts --workers=1`
    passed 24 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - Verification:
    `git diff --check -- tests/editor-dom/dom-mutation.spec.ts docs/cross-browser-worklog.md`
    passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, typed `One`, toggled bold for `Bold`, toggled bold off,
    typed `Tail`, inserted a Shift+Enter soft break, typed `Soft`, used
    Backspace, split with Enter, typed `Two`, used undo/redo, and pressed Tab.
    The live DOM had one editable root, two paragraph blocks, managed text
    wrappers `OneBold Tail\nSof` and `Two`, one bold mark wrapper around
    `Bold`, no stale placeholders, and no app console errors beyond Vite debug
    connection logs.

- 2026-05-25: completed characterData-only browser text mutation coverage.
  - DeepWiki findings: Lexical reconciles raw `characterData` mutations through
    its mutation pipeline, ProseMirror's DOMObserver routes changed text nodes
    into DOM-change parsing, and Svedit diffs browser-mutated DOM text back
    into the model while preserving the browser's post-mutation caret.
  - Material gap: Edytor already covered unmanaged wrapper insertion,
    browser wrapper replacement, and stale managed-mark DOM, but did not
    directly prove a browser/extension/speech/autocorrect-style change to an
    existing managed text node's `CharacterData` without any useful
    `beforeinput` or `input` event.
  - Browser coverage: added
    `reconciles characterData-only browser text mutations without an input event`
    to `tests/editor-dom/dom-mutation.spec.ts`. The test mutates a live DOM
    text node from `lead` to `leads`, places the browser caret after the
    inserted character, dispatches no input event, and asserts the serialized
    model, DOM text, and selection.
  - Runtime result: no production patch was needed; the existing DOM mutation
    observer already reconciled the behavior correctly. The new test locks this
    cross-browser contract.
  - Verification:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts -g "characterData-only" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts --workers=1`
    passed 21 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - Verification:
    `git diff --check -- tests/editor-dom/dom-mutation.spec.ts docs/cross-browser-worklog.md`
    passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, typed `One`, toggled bold for `Bold`, toggled bold off,
    typed `Tail`, inserted a Shift+Enter soft break, typed `Soft`, used
    Backspace, split with Enter, typed `Two`, used undo/redo, and pressed Tab.
    The live DOM had one editable root, two paragraph blocks, managed text
    wrappers `OneBold Tail\nSof` and `Two`, one bold mark wrapper around
    `Bold`, no stale placeholders, and no app console errors beyond Vite debug
    connection logs.

- 2026-05-25: rechecked the live root route on `http://localhost:5173/`
  after the user pointed the audit at the active local app.
  - Trigger: user reported that typing, mark toggles, double-space behavior,
    paragraph split, and undo/redo still appeared broken in the live demo.
  - In-app Browser verification: navigated the active tab to `/`, cleared the
    editor, clicked the editor, typed `One`, toggled bold for `Bold`, toggled
    bold off, typed `Tail`, pressed double Space, split with `Enter`, typed
    `Two`, then used undo and redo. The DOM remained singular: one editable
    root, one managed text wrapper per model text, one bold mark wrapper around
    `Bold`, no stale placeholder clone, and no visible text duplication.
  - Result: no runtime patch was made. This audit did not reproduce a
    model/value-correct-but-DOM-duplicated state in the hard-reloaded local
    tab. If it persists in a user-held tab, the next useful evidence is the
    exact native event/inputType sequence immediately before the first duplicate
    appears, or confirmation that the dev-server tab had stale HMR state.
  - Focused browser verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts tests/editor-dom/input.spec.ts tests/editor-dom/hotkeys.spec.ts tests/editor-dom/dom-mutation.spec.ts --workers=1 -g "duplicate|auto-dot|stale DOM clones|does not delete existing demo-route text|does not resurrect marked text|splits a cleared paragraph|coalesce typing after a paragraph split|placeholder after undoing text|undo|redo|bold|mark"`
    passed 93 tests across Chromium, Firefox, and WebKit.

- 2026-05-25: completed unfocused input-only native history coverage.
  - DeepWiki findings: Slate React has a `handleNativeHistoryEvents` path in
    `Editable` for `input.historyUndo`/`input.historyRedo` when
    `ReactEditor.isFocused(editor)` is false. The documented reason is that
    browsers can still place content in the native undo stack even when the
    editor owns `beforeinput`; Slate's contract is to sync editor state/history
    while unfocused, not to promise external focus restoration.
  - Material gap: Edytor already covered focused
    `beforeinput.historyUndo`/`historyRedo`, hotkey undo/redo, and focused
    input-only native history. It did not directly prove the Slate-shaped
    fallback where focus has moved to an outside native input and a
    `historyUndo`/`historyRedo` input event still bubbles from editable DOM.
  - Browser coverage: added
    `routes unfocused input-only native history through editor history` to
    `tests/editor-dom/input.spec.ts`. The test types `a`, focuses an outside
    native input, simulates browser-native undo/redo DOM mutations, dispatches
    `input.historyUndo` and `input.historyRedo` from the editable text wrapper,
    and asserts Edytor's serialized value and cached model selection remain
    coherent.
  - Runtime result: no production patch was needed after narrowing the test to
    the peer-editor contract. A stricter external-focus-preservation assertion
    was intentionally not kept because DeepWiki confirmed Slate does not make
    that promise, and synthetic contenteditable `input` dispatch can itself
    alter browser focus.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "unfocused input-only native history" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1`
    passed 171 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed after formatting the browser spec.
  - Verification:
    `git diff --check -- tests/editor-dom/input.spec.ts docs/cross-browser-worklog.md`
    passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, typed `One`, toggled bold for `Bold`, toggled bold off,
    typed `Tail`, split with Enter, typed `Two`, inserted a Shift+Enter soft
    break, typed `Soft`, used Backspace, undo, redo, and Tab. The live DOM had
    one contenteditable root, two paragraph blocks, managed text wrappers
    `OneBold Tail` and `Two\nSof`, one bold mark wrapper around `Bold`, no
    stale placeholders, and no console errors.

- 2026-05-25: rechecked the live root-route duplicate-DOM report on
  `http://localhost:5173/` without a runtime patch.
  - Trigger: user explicitly pointed the investigation at the active localhost
    tab after reporting visible duplicated DOM during typing, mark toggles,
    double-space behavior, paragraph split, and undo/redo.
  - In-app Browser verification: inspected `/` with no console errors, cleared
    the editor, typed `One` through per-key browser events, toggled bold, typed
    `Hello`, pressed double Space, split at the paragraph end, used undo/redo,
    then hard-reloaded `/` and repeated a clean flow with `One`, bold `Hello`,
    `World`, Enter, `Two`, undo, and redo. The live DOM stayed singular: one
    contenteditable root, one managed text wrapper per model text, one bold
    wrapper only around the marked segment, and no stale placeholder clone.
  - Focused browser verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "duplicate|auto-dot|clears to one editable|split|undo" --workers=1`
    passed 21 tests across Chromium, Firefox, and WebKit.
  - Focused browser verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "input-only native history|auto-dot|split|insertParagraph" --workers=1`
    passed 9 tests across Chromium, Firefox, and WebKit.
  - Focused browser verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts -g "bold|mark|history|undo|redo" --workers=1`
    passed 33 tests across Chromium, Firefox, and WebKit.
  - Focused browser verification:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts --workers=1`
    passed 18 tests across Chromium, Firefox, and WebKit.
  - Runtime result: no production patch was made because the current source and
    a hard-reloaded live tab did not reproduce the reported model/DOM
    divergence. If it persists in a user-held tab, the next boundary is stale
    dev-server/HMR DOM state, physical OS auto-period/autocorrect input, or a
    still-unrecorded native selection state immediately before the first bad
    keystroke.

- 2026-05-25: completed input-only native history undo/redo fallback.
  - DeepWiki findings: Lexical and Slate route browser-native
    `historyUndo`/`historyRedo` through editor history commands, while
    ProseMirror and Svedit treat unreliable browser input as a DOM
    reconciliation boundary rather than the source of editor truth.
  - Material gap: Edytor already covered cancelable
    `beforeinput.historyUndo`/`historyRedo`, hotkey undo/redo, and
    mobile history-restored composition. It did not cover the fallback shape
    where the browser has already mutated DOM and only an `input.historyUndo`
    event reaches the editor.
  - Browser coverage: added
    `routes input-only native history undo through editor history` to
    `tests/editor-dom/input.spec.ts`. The test types `a`, simulates browser DOM
    native undo by emptying the text node and dispatching `input.historyUndo`,
    then verifies a subsequent editor `historyRedo` restores `a` and the caret
    after it.
  - Proven gap before runtime patch:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "input-only native history" --workers=1 --project=chromium`
    failed because redo did not restore `a`; the input-only undo had been
    reconciled as a text diff and cleared redo semantics.
  - Runtime fix: `onInput` now handles `historyUndo` and `historyRedo` before
    ordinary DOM text reconciliation. Input-only history events consume the
    undo manager, refresh the DOM from model state, and restore selection from
    the existing history stack metadata. Unlike beforeinput history, this path
    does not queue a new selection snapshot because the browser has already
    moved DOM selection and doing so overwrote Firefox redo caret metadata.
  - Additional cross-browser issue found while validating: the first
    all-browser run passed Chromium/WebKit but left Firefox redo selection at
    offset `0`. Removing the post-native snapshot override fixed caret
    restoration at offset `1` across all engines.
  - In-app Browser verification on `http://localhost:5173/`: used `clear`,
    clicked the editor, typed `One`, toggled bold, typed `Hello  `, Backspaced,
    used undo/redo, inserted a Shift+Enter soft break, pressed Tab, and
    inspected the live DOM. The editor kept one contenteditable root, one
    managed text node per current document shape, correct visible text, and no
    page console errors. The in-app keypress API still did not synthesize
    paragraph Enter as a split, so split/undo remains verified by the
    Playwright demo-route gate below. The page was left on a clean focused
    empty paragraph.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "input-only native history" --workers=1 --project=chromium`
    initially failed, then passed after the runtime fix.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "input-only native history" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1`
    passed 168 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts -g "history|undo|redo" --workers=1`
    passed 15 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "duplicate|auto-dot|clears to one editable|split|undo" --workers=1`
    passed 21 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run` passed 269 tests.
  - Verification: `pnpm test:dom` passed 90 tests.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm test:dom:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm check` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed after formatting `onInput.ts`.
  - Verification: `pnpm build` passed, including `svelte-package` and
    `publint`.

- 2026-05-25: completed divider void-block Backspace selection/deletion
  coverage and localhost regression verification.
  - DeepWiki findings: ProseMirror works around browser selection around
    uneditable block nodes, Slate treats void-node selection/deletion as a
    first-class regression surface, and Lexical has DecoratorNode/horizontal
    rule navigation/deletion coverage.
  - Material gap: Edytor already had browser coverage for image void captions,
    image void-body focus, vertical arrows around image void blocks,
    Shift+ArrowDown across void blocks, and triple-click void selection. It did
    not directly lock the neighboring-caret Backspace path for a pure
    non-editable divider/horizontal-rule block.
  - Browser coverage: added the `/test/dom?scenario=divider` fixture and
    `selects and deletes a divider block from a neighboring text caret` to
    `tests/editor-dom/input.spec.ts`. The test places the caret at the start of
    the paragraph after the divider, presses Backspace, asserts the divider is
    selected as an atomic block, presses Backspace again, and asserts the
    divider is removed with the caret restored to the previous paragraph.
  - Runtime fix: `divider` and `horizontalRule` now register as full
    `BlockDefinition` values with `void: true`. Previously they rendered
    `use:block.void` in the DOM but were registered as bare snippets, so the
    operation layer did not treat them as void blocks.
  - In-app Browser verification on `http://localhost:5173/`: used `clear`,
    clicked the editable placeholder/root, typed `One`, toggled bold over the
    text, typed `Hello  `, and verified the live DOM had one managed text node
    with the expected text and no visible cloned content. The in-app
    automation keypress API did not dispatch the same Enter path as Playwright's
    browser keyboard, so paragraph split/undo stayed verified through the
    browser smoke spec below instead of being inferred from that tool artifact.
    The page was left on a clean focused empty paragraph.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "divider" --workers=1 --project=chromium`
    initially failed because the divider was not selected as a block.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "divider" --workers=1 --project=chromium`
    passed after the runtime fix.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "divider" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1`
    passed 165 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "duplicate|auto-dot|clears to one editable|split|undo" --workers=1`
    passed 21 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run` passed 269 tests.
  - Verification: `pnpm test:dom` passed 90 tests.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm test:dom:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm check` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - Verification: `pnpm build` passed, including `svelte-package` and
    `publint`.

- 2026-05-25: completed code-suggestion composition boundary coverage and root
  route regression verification.
  - DeepWiki findings: Lexical and ProseMirror both treat composition near
    typeahead/widget/decorator DOM as a browser-owned edge where overlay DOM
    must stay outside the serialized model and the editable text target must
    remain stable.
  - Material gap: Edytor had extensive IME, mark, inline, placeholder, and
    composition drift coverage, but no direct browser spec for active code-line
    suggestions during IME composition.
  - Browser coverage: added
    `keeps code suggestions alive during composition at the suggestion boundary`
    to `tests/editor-dom/composition.spec.ts`. The test renders a code-line
    suggestion overlay, composes `に` at the real text boundary, asserts the
    model text becomes `const a = 1;に`, asserts the suggestion text remains an
    overlay, and asserts the caret lands after the committed IME text.
  - Runtime note: no production runtime change was needed for the reachable
    boundary. A temporary artificial check that forced a native selection inside
    `contenteditable=false` suggestion DOM was removed because Chromium clamps
    that impossible range back into editable token DOM.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, used `clear`, typed `Oneee`, toggled bold around `One`, typed double
    spaces, and verified the live DOM had one managed text node with
    `OneeeOne  ` and one bold mark wrapper, not duplicated visible clones. Also
    selected the whole text with `mod+a`, toggled bold, and verified the DOM
    still had one managed text node containing `Oneee`.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "code suggestions" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "duplicate|auto-dot|clears to one editable|split|undo" --workers=1`
    passed 21 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run` passed 269 tests.
  - Verification: `pnpm test:dom` passed 90 tests.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm test:dom:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm check` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed after formatting the composition spec.
  - Verification: `pnpm build` passed, including `svelte-package` and
    `publint`.
  - Full browser lane note:
    `pnpm test:integration --workers=1` ran 961 browser tests. The
    input/selection/composition/demo-route lanes stayed green, but the run
    ended red on the already-deferred clipboard selected nested block paste
    regression:
    `tests/editor-dom/clipboard.spec.ts:147` failed in Chromium, Firefox, and
    WebKit with expected root child count `3`, received `2`. Three WebKit
    navigation stalls passed on retry. Per the current scope rule, clipboard
    remains in `Next Queue` and was not fixed in this slice.

- 2026-05-25: completed selected inline atom printable replacement.
  - DeepWiki findings: Slate, Lexical, and ProseMirror treat selections over
    void/decorator/atomic inline nodes as semantic editor selections, not
    ordinary browser text ranges. Printable input after selecting an inline
    atom should therefore be an editor-owned replacement command.
  - Material gap: Edytor already covered Backspace/Delete on selected inline
    mentions, drag selections across inline mentions, click-before/click-after
    inline mention caret mapping, and triple-click follow-up replacement. It did
    not lock the path where the atom itself is selected and the next typed
    character should replace that atom.
  - Browser coverage: added
    `replaces a selected inline mention with typed text` to
    `tests/editor-dom/inline-atomic.spec.ts`. The test pointer-clicks the
    second inline mention in `/test/dom?scenario=inline`, types `X`, asserts the
    paragraph normalizes to `lead X end`, clears selected-inline state, and
    restores the caret after the inserted character.
  - Runtime fix: real pointer clicks on inline blocks now select the atom
    directly through the model, selectionchange suppression now ignores only
    collapsed synthetic atom-click selections instead of blindly skipping the
    next valid text caret update, and printable keydown replaces the selected
    atom before the browser can create an uncontrolled DOM mutation.
  - Additional regression found while validating: Firefox reverse-drag across
    an inline mention can leave a wrong same-text range instead of a collapsed
    selected atom. `restoreInlineAtomDragRange` now restores the semantic range
    whenever the pointer drag start/end cross an inline atom in the same block,
    not only when the browser leaves a collapsed atom selection behind.
  - Failing evidence before the fix:
    `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts -g "replaces a selected inline mention with typed text" --workers=1`
    failed because a real pointer click did not leave the inline mention
    selected across browser engines.
  - Verification:
    `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts --workers=1`
    passed 39 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts -g "selects inline mentions atomically with a real pointer click|replaces a selected inline mention with typed text|maps off-edge clicks after inline mentions|clears selected inline mentions" --workers=1 --project=chromium`
    passed the previously order-dependent Chromium sequence.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1`
    passed 33 tests across Chromium, Firefox, and WebKit, including typing
    clone, mark-toggle clone, auto-dot, Enter split, split undo, and clear-focus
    regressions on `/`.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: hard-reloaded the
    root route, cleared the editor, typed `One`, toggled bold for `Two`, toggled
    bold off for `Three`, verified a single visible managed text node, cleared
    again, typed `hello  ` and `hello. ` without deleting prior content, then
    verified Backspace and undo. The Browser keypress surface did not deliver a
    real Enter event, so Enter/undo was verified through the demo-route
    Playwright suite above.

- 2026-05-25: completed active-composition selectionchange drift hardening.
  - DeepWiki findings: ProseMirror suppresses suspicious Chrome composition
    selection updates; Slate stores pending Android composition selections and
    clears stale pending selections before text insertion; Lexical tracks a
    composition key separately from DOM selection; Svedit defers composition
    commit from its composition-time selection.
  - Material gap: Edytor already restored selection after composition and
    handled cross-block composition replacement, but a `compositionend.data`
    commit with no composition `beforeinput` still used the current selection.
    A bogus browser `selectionchange` during composition could therefore move
    the final IME text into another paragraph.
  - Browser coverage: added a selection-drift composition test to
    `tests/editor-dom/composition.spec.ts`. The test starts composition at
    `le|ad`, moves native selection to `no|te` before `compositionend`, commits
    `に`, then asserts `['leにad', 'note', '']` and a collapsed caret at offset 3
    in the first block.
  - Runtime fix: `Edytor` now snapshots the `SelectionReplacementState` on
    `compositionstart` and uses that snapshot for compositionend-only commits.
    Composition paths that already received composition `beforeinput` keep using
    their explicit `compositionState` target.
  - Failing evidence before the fix:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "selection drift" --workers=1`
    failed in Chromium, Firefox, and WebKit with the IME text inserted into the
    drifted second paragraph (`['lead', 'noにte', '']`).
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "selection drift" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit after the fix.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts --workers=1`
    passed 105 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - Verification:
    `git diff --check -- src/lib/edytor.svelte.ts tests/editor-dom/composition.spec.ts docs/cross-browser-worklog.md`
    passed.
  - In-app Browser verification on `http://localhost:5173/`: hard-reloaded the
    root route, cleared the editor, typed `One`, toggled bold for `Two`, pressed
    double Space, split with Enter, typed `Next`, inserted a soft break, used
    Backspace, undo, redo, and Tab. The live route had one editable root, parent
    own text `OneTwo  `, nested child own text `Next\n`, one expected bold mark
    wrapper, and no page console errors.

- 2026-05-25: completed composition-start over expanded multi-block selection
  coverage.
  - DeepWiki findings: Slate clears expanded selections during
    `compositionstart` so composition replaces the selected fragment instead of
    inserting beside it. Lexical anchors non-collapsed composition in a stable
    text node and treats non-collapsed composition as a controlled path.
    ProseMirror has cross-paragraph composition coverage because browser DOM
    changes and selection reports drift during IME.
  - Material gap: Edytor already covered same-block composition replacement and
    post-composition multi-block deletion. It did not directly lock the path
    where IME composition starts while the current selection already spans two
    blocks.
  - Browser coverage: added two cross-block composition tests to
    `tests/editor-dom/composition.spec.ts`. Both select from `le|ad` through
    `no|te`, commit `に`, assert serialized block content `['leにte', '']`,
    assert visible managed DOM text for the preview path, and assert the
    collapsed caret at offset 3 in the surviving first block.
  - Runtime change: none. Current composition replacement logic already handled
    this correctly.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "cross-block selection" --workers=1`
    passed 6 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts --workers=1`
    passed 102 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - Verification:
    `git diff --check -- tests/editor-dom/composition.spec.ts docs/cross-browser-worklog.md`
    passed.
  - In-app Browser verification on `http://localhost:5173/`: hard-reloaded the
    root route, cleared the editor, typed `One`, toggled bold for `Two`,
    pressed double Space, split with Enter, typed `Next`, inserted a soft break,
    used Backspace, undo, redo, and Tab. The live route had one editable root,
    parent own text `OneTwo  `, nested child own text `Next\n`, one expected
    bold mark wrapper, and no page console errors.

- 2026-05-25: rechecked live root-route DOM duplication report on
  `http://localhost:5173/` without a runtime change.
  - Trigger: user pointed the active investigation back to the root demo route
    after visible duplicated text was reported during typing, mark toggles, and
    double-space behavior.
  - In-app Browser verification: hard-reloaded `/`, cleared the editor, focused
    the empty paragraph, typed `One`, toggled bold for `Two`, toggled bold off,
    pressed double Space, Backspace, undo, and redo. The live DOM stayed
    singular: one editable root, one managed text wrapper, one bold mark wrapper
    around `Two`, no stale placeholder, and no console errors.
  - Focused browser verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts tests/editor-dom/hotkeys.spec.ts tests/editor-dom/format-beforeinput.spec.ts tests/editor-dom/input.spec.ts tests/editor-dom/dom-mutation.spec.ts --workers=1 -g "duplicate|auto-dot|stale DOM clones|does not delete existing demo-route text|does not resurrect marked text|splits a cleared paragraph|coalesce typing after a paragraph split|placeholder after undoing text"`
    passed 30 tests across Chromium, Firefox, and WebKit.
  - Runtime change: none. The current checked-out source did not reproduce the
    reported visible DOM/value divergence after a hard reload. If the symptom
    persists in a held tab, the next boundary is stale dev-server/HMR state or a
    browser/user input sequence not represented by the current specs.

- 2026-05-25: completed mobile non-cancelable generic/fragment deletion
  coverage.
  - DeepWiki findings: Slate schedules `deleteContent`,
    `deleteEntireSoftLine`, `deleteByComposition`, `deleteByCut`, and
    `deleteByDrag` through semantic editor transforms in its Android/non-
    cancelable input manager. Lexical maps generic and fragment deletion
    `beforeinput` values to delete-character/remove-text commands and keeps
    composition deletion explicit. ProseMirror repairs generic/fragment
    deletion from DOM-change interpretation when browsers mutate first. Svedit
    reconciles deletion drift from stored input state and intentionally blocks
    unsupported drag deletion.
  - Material gap: Edytor already covered desktop target-range routing for
    `deleteContent`, `deleteEntireSoftLine`, and `deleteByComposition`. It did
    not directly cover mobile-style non-cancelable `beforeinput` followed by
    native DOM drift for these input types.
  - Browser coverage: added three tests to
    `tests/editor-dom/mobile-beforeinput.spec.ts` for `deleteContent`,
    `deleteEntireSoftLine`, and `deleteByComposition`. Each dispatches a
    non-cancelable `beforeinput`, injects a wrong native DOM text value before
    the follow-up `input`, then asserts the model-owned deletion result,
    visible DOM text, and collapsed caret offset.
  - Runtime change: none. The current runtime repaired the model and selection
    correctly.
  - Test harness correction: the first focused run failed for
    `deleteEntireSoftLine` only because the DOM assertion counted Edytor's
    managed zero-width empty-text sentinel as visible text. The
    mobile-beforeinput DOM text helper now normalizes `\u200B` before visible
    text assertions.
  - Verification:
    `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts -g "native DOM drift after non-cancelable delete(Content|EntireSoftLine|ByComposition)" --workers=1`
    passed 6 tests across mobile Chromium and mobile WebKit after the helper
    correction.
  - Verification:
    `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts --workers=1`
    passed 68 tests across mobile Chromium and mobile WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - Verification: `git diff --check` passed.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    editor, typed `One`, toggled bold for `Two`, toggled bold off, pressed
    double Space, split with Enter, typed `Next`, inserted a soft break, used
    Backspace, undo, redo, and Tab. The live DOM had one contenteditable root,
    one expected bold wrapper around `Two`, coherent split/soft-break content,
    and no page console errors.

- 2026-05-25: completed mobile non-cancelable advanced deletion coverage.
  - DeepWiki findings: Slate maps `deleteWord*`, `deleteSoftLine*`, and
    `deleteHardLine*` `beforeinput` values to semantic word/line/block
    deletion commands, and its Android input manager accounts for
    non-cancelable native edits. Lexical routes the same input types through
    `DELETE_WORD_COMMAND` / `DELETE_LINE_COMMAND`. ProseMirror infers deletion
    intent from recent key state plus DOM changes when browser events are
    unreliable. Svedit stores input-time selection and reconciles native
    deletion drift through text diffing.
  - Material gap: Edytor already covered desktop missing-`beforeinput` word and
    line deletion. It did not directly cover mobile-style non-cancelable
    advanced deletion `beforeinput` followed by browser-created DOM drift.
  - Browser coverage: added six tests to `tests/editor-dom/mobile-beforeinput.spec.ts`
    for `deleteWordBackward`, `deleteWordForward`, `deleteSoftLineBackward`,
    `deleteSoftLineForward`, `deleteHardLineBackward`, and
    `deleteHardLineForward`. Each dispatches a non-cancelable `beforeinput`,
    injects a wrong native DOM text value before the follow-up `input`, then
    asserts the model-owned deletion result, visible DOM text, and collapsed
    caret offset.
  - Runtime change: none. The new regressions passed against the current
    implementation, so this slice locks existing correct behavior.
  - Verification:
    `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts -g "native DOM drift after non-cancelable delete" --workers=1`
    passed 12 tests across mobile Chromium and mobile WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts --workers=1`
    passed 62 tests across mobile Chromium and mobile WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - Verification: `git diff --check` passed.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    editor, typed `One`, toggled bold for `Two`, toggled bold off, pressed
    double Space, split with Enter, typed `Next`, inserted a soft break, used
    Backspace, undo, redo, and Tab. The live DOM had one contenteditable root,
    one expected bold wrapper around `Two`, coherent split/soft-break content,
    and no page console errors.

- 2026-05-25: completed cancelable multi-character insertText coverage.
  - DeepWiki findings: Slate keeps special and multi-character insertion on the
    model-owned path instead of trusting every native `insertText` payload,
    because browser-native special-character/long-press insertion can duplicate
    or misplace text. Lexical uses the same broad principle: text insertion is
    routed through editor commands when browser mutation would make selection or
    reconciliation ambiguous.
  - Material gap: Edytor already covered real browser accented/emoji insertion.
    It did not directly cover a cancelable `beforeinput.insertText` payload such
    as `é🙂`, where the editor must prevent native insertion, update the model
    once, and restore the caret after the inserted payload.
  - Browser coverage: added
    `model-owns cancelable multi-character insertText payloads` to
    `tests/editor-dom/input.spec.ts`. The test dispatches cancelable
    `beforeinput.insertText` with `é🙂` at `le|ad`, then asserts the event is
    prevented, serialized text is `leé🙂ad`, visible text matches, and the caret
    lands at offset `5`.
  - Runtime change: none. The new regression passed against the current
    implementation, so this slice locks an existing correct behavior.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "multi-character insertText" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "duplicate|auto-dot|split|undo" --workers=1`
    passed 18 tests across Chromium, Firefox, and WebKit.
  - In-app Browser verification on `http://localhost:5173/`: without reloading
    the current root-route tab, cleared the editor, typed `One`, toggled bold
    for `Two`, toggled bold off, pressed double Space, used Enter, typed `Next`,
    and used undo/redo. The live DOM had one contenteditable root, one managed
    text wrapper, one bold mark wrapper only around `Two`, no visible duplicate
    editor text, and no page console errors. A second live pass with longer
    `ezaeazeaz ...` text also left a single managed text wrapper and no visible
    clone.

- 2026-05-25: completed code/pre tab follow-up typing coverage.
  - DeepWiki findings: Slate carries a Chrome-specific native insertion guard
    for `insertText` inside `pre` content containing tab characters, because
    browser whitespace handling can insert text abnormally once tabs are
    present. Lexical similarly routes code-block Tab and follow-up code editing
    through editor commands instead of letting the browser mutate the DOM.
  - Material gap: Edytor already had real-browser coverage proving Tab inserts a
    tab character inside a code line. It did not directly prove that the next
    typed character after that tab remains model-owned inside the rendered
    `<pre><code>` tree.
  - Browser coverage: added
    `keeps typing after a code-line tab model-owned in the real browser` to
    `tests/editor-dom/hotkeys.spec.ts`. The test inserts a tab after `const `,
    types `X`, and asserts the serialized code-line text, visible code-line
    text, single text wrapper, and collapsed caret all match
    `const \tXa = 1;`.
  - Runtime change: none. The regression passed against the current
    implementation, so this slice locks the contract.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts -g "code-line tab" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts --workers=1`
    passed 69 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run` passed 269 tests.
  - Verification: `pnpm test:dom` passed 90 tests.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm test:dom:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm check` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - Verification: `pnpm build` passed, including `svelte-package` and
    `publint`.
  - Verification: `git diff --check` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, clicked the empty editor, typed `One`, toggled bold for
    `B`, toggled bold off, typed more text, pressed double Space, split with
    `Enter`, typed `Two`, inserted a soft break, deleted, used undo/redo, then
    pressed Tab. The visible editor text remained coherent as `OneBn   Two`
    plus the soft-break newline; there was one contenteditable root and no page
    console errors.

- 2026-05-25: completed secondary-click/contextmenu selection coverage.
  - DeepWiki findings: Slate, Lexical, and ProseMirror keep browser-owned
    selection compatibility explicit because secondary-click can move the
    native selection inconsistently or without a useful `selectionchange`.
    The practical regression is: create an existing model caret, secondary-click
    another text position, then type and assert the edit follows the
    secondary-click target rather than the stale original caret.
  - Material gap: Edytor already covered ordinary pointer clicks, interrupted
    drag selection cleanup, inline-atom clicks, and external-toolbar focus
    restoration. It did not directly cover the `contextmenu`/right-click path
    where native selection behavior diverges by browser.
  - Browser coverage: added
    `uses the secondary-click target for the next keyboard edit` to
    `tests/editor-dom/selection.spec.ts`. The test starts with a stale caret in
    the first block, secondary-clicks the second block, types `X`, and asserts
    the mutation happens in the second block. Firefox inserts at the clicked
    caret; Chromium and WebKit replace the secondary-clicked word, so the
    browser-specific expected values are explicit.
  - Runtime change: none. The first focused run proved the new test failed only
    because Chromium/WebKit intentionally expose a different word-selection
    behavior than Firefox, not because Edytor used the stale original caret.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "secondary-click target" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`
    passed 105 tests, with 6 existing browser-capability skips.
  - Verification: `pnpm test -- --run` passed 269 tests.
  - Verification: `pnpm test:dom` passed 90 tests.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm test:dom:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm check` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - Verification: `pnpm build` passed, including `svelte-package` and
    `publint`.
  - Verification: `git diff --check` passed.
  - In-app Browser verification on `http://localhost:5173/`: cleared `/`,
    focused the empty editor, typed `One`, toggled bold for `B`, toggled bold
    off, typed more text, pressed double Space, split with `Enter`, typed `Two`,
    then used undo/redo. The live DOM had one contenteditable root, two
    paragraph blocks after the split, one bold mark wrapper around only `B`, no
    duplicate text nodes, and no console errors.

- 2026-05-25: completed element-node target-range insertion around inline
  mentions.
  - DeepWiki findings: Lexical resolves `beforeinput.getTargetRanges()` through
    DOM range application and normalizes element/decorator boundary points into
    model selection points. Slate uses `getTargetRanges()` for WebKit/Shadow DOM
    cases and converts the DOM range to a Slate range before controlled
    insertion. The practical regression for Edytor is a collapsed `StaticRange`
    whose container is a paragraph/content element and whose offset sits
    immediately before or after an inline atom.
  - Material gap: Edytor already covered element-node carets around inline
    mentions for selection and composition, and text-node target ranges for
    insert/replacement. It did not directly lock
    `beforeinput.insertText.getTargetRanges()` when the target range containers
    are element nodes at inline atom boundaries.
  - Browser coverage: added
    `normalizes element-node beforeinput target ranges around inline mentions`
    to `tests/editor-dom/input.spec.ts`. The test dispatches model-owned
    `insertText` from collapsed element-node target ranges after the first
    inline mention and before the second inline mention, then asserts insertion
    lands in the correct neighboring text nodes.
  - Runtime change: none. The regression passed against the current
    implementation, so this slice locks the contract.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "element-node beforeinput target ranges" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1`
    passed 159 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm check` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, typed `One`, toggled bold for `B`, toggled bold off,
    split with `Enter`, typed `Two`, used undo/redo, Shift+Enter, Backspace,
    and Tab. The DOM had one contenteditable root, one bold mark wrapper, no
    console errors, and the apparent repeated `Two` was confirmed as normal
    nested block text aggregation after Tab.

- 2026-05-25: completed post-composition inline-atomic selection deletion
  coverage.
  - DeepWiki findings: Slate and Lexical normalize DOM selections and
    `beforeinput.getTargetRanges()` into editor selections around
    void/decorator nodes; Slate relies on target ranges for WebKit/Shadow DOM
    cases, while Lexical normalizes boundary points around decorator nodes.
    The practical follow-up was not another collapsed composition case, but the
    intersection of composition end, an explicit user-created selection, inline
    atomic content, and a later Backspace.
  - Material gap: Edytor already covered the WebKit post-composition Backspace
    guard for collapsed carets, plain selected content, and plain multi-block
    selections. It did not directly prove that the guard allows deletion when
    the user selection spans inline mention atoms after composition ended.
  - Browser coverage: added
    `does not ignore Backspace after compositionend when selection spans inline mentions`
    to `tests/editor-dom/composition.spec.ts`. The test commits IME text, then
    creates a cross-block selection from text after one mention through text
    after another mention, presses Backspace, and asserts the second mention is
    removed atomically while the first mention and surviving text normalize to
    `tadに`.
  - Runtime change: none. The regression passed against the current
    implementation, so this slice locks the contract.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "selection spans inline mentions" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts --workers=1`
    passed 96 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm check` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, typed `One`, toggled bold for `B`, toggled bold off,
    split with `Enter`, typed `Two`, used undo/redo, Shift+Enter, Backspace,
    and Tab. The DOM had one contenteditable root, one bold mark wrapper, no
    console errors, and the apparent repeated `Two` was confirmed as normal
    nested block text aggregation after Tab.

- 2026-05-25: completed inline-atomic native replacement coverage.
  - DeepWiki findings: Slate and Lexical explicitly route complex
    `insertReplacementText` through controlled/model text insertion rather than
    browser DOM mutation. ProseMirror accepts that browsers may mutate DOM for
    replacement-like input, but routes the result through DOM-change parsing and
    model transactions. The practical regression shape is a spellcheck or
    autocorrect replacement whose event-time target range spans text, an inline
    atom, and following text.
  - Material gap: Edytor already covered typed replacement after Shift-click
    across inline atoms, mobile non-cancelable `insertText` over inline-spanning
    selections, and generic `insertReplacementText` over marked/cross-block
    ranges. It did not directly lock the browser-native
    `insertReplacementText` target-range path when the range crosses an inline
    mention atom.
  - Browser coverage: added
    `model-owns native replacement target ranges across inline mentions` to
    `tests/editor-dom/input.spec.ts`. The test dispatches
    `beforeinput.insertReplacementText` with a target range from `lead ` through
    an inline mention into ` end`, then asserts the second block normalizes to
    `leXnd`, the mention is removed atomically, and the caret lands after `X`.
  - Runtime change: none. The regression passed against the current
    implementation, so this slice only locks the contract.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "native replacement target ranges across inline mentions" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1`
    passed 156 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm check` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, typed `One`, toggled bold for `B`, toggled bold off for
    following text, split with `Enter`, typed `Two`, used undo/redo,
    Shift+Enter, Backspace, and Tab. The final DOM had one contenteditable root,
    one bold mark wrapper, no console errors, and the apparent repeated `Two`
    was confirmed to be normal nested block `textContent` aggregation after
    Tab, not duplicated editor-owned content.

- 2026-05-25: completed interrupted mouse-drag selection recovery.
  - DeepWiki findings: ProseMirror delays selection synchronization while
    `mouseDown` is active so intermediate selectionchange or DOM updates cannot
    corrupt the final drag selection. Slate suppresses internal drag-time
    selectionchange churn and resets dragging state on both `drop` and
    `dragend`. Lexical carries regressions for mouse leaving/re-entering the
    browser window during selection/drag interactions, where browser button
    state can be lost.
  - Material gap: Edytor already covered ordinary real-browser drag ranges
    across sibling blocks, nested blocks, and inline mention atoms. It did not
    prove that an interrupted drag whose mouseup happens outside the editor
    cannot leave stale drag/selection state that corrupts the next click edit.
  - Proven gap before runtime patch:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "interrupted mouse drag" --workers=1`
    initially failed. Chromium collapsed the inline fixture to one empty
    paragraph after the abandoned drag and follow-up type; Firefox/WebKit
    showed the test needed to wait for the explicit click-selection target
    before typing.
  - Runtime fix: trusted `beforeinput.deleteByDrag` is prevented and treated as
    a no-op at the current non-DnD product boundary, while synthetic
    `deleteByDrag` target-range tests still exercise the model deletion command.
    The selection layer now also exposes an explicit pointer-drag cleanup hook
    used by that guard.
  - Browser coverage: added
    `ignores an interrupted mouse drag before the next click edit` to
    `tests/editor-dom/selection.spec.ts`. The test starts a real native drag,
    mutates an unrelated block attribute during the drag, releases outside the
    editor viewport, then clicks/types in a later text node and asserts the edit
    lands at that clicked target with no selected inline atom left behind.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "interrupted mouse drag" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "drag-selects forward and reverse|interrupted mouse drag" --workers=1`
    passed 6 tests across Chromium, Firefox, and WebKit after restarting a
    stale preview server that had been reusing an older build.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`
    passed 102 tests with 6 documented skips across Chromium, Firefox, and
    WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/drop-beforeinput.spec.ts --workers=1`
    passed 6 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/advanced-delete.spec.ts -g "deleteByDrag" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "splits a cleared paragraph" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - Verification: `pnpm check` passed with 0 errors and 0 warnings.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, typed `One`, toggled bold for `B`, toggled bold off for
    following text, and inspected the managed DOM. The rendered editor kept one
    managed text wrapper containing `One`, one bold mark wrapper for `B`, and a
    trailing `n`, with no duplicated visible text and no console errors. A
    second live keypress pass split the paragraph with `Enter`, typed `Two` in
    the new paragraph, then verified `mod+z` and `mod+shift+z` restored the
    expected DOM states.

- 2026-05-25: completed missing-compositionend blur/refocus recovery.
  - DeepWiki findings: Slate clears stale composing state from later keydown
    evidence when `compositionend` is unreliable. ProseMirror uses composition
    end/flush recovery so later keydowns after blur/refocus are normal editor
    commands. Lexical tracks composition state separately from keyboard command
    dispatch and recovers stale composition flags. Svedit lacks an explicit
    equivalent fallback, which makes this a plausible stuck-hotkey risk.
  - Material gap: Edytor already covered canceled compositions that receive
    `compositionend`, post-composition Enter/Backspace guards, and active
    composition keydown suppression. It did not prove that a dangling
    `compositionstart` followed by external blur/refocus stops suppressing
    normal hotkeys.
  - Proven gap before runtime patch:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "blur drops compositionend" --workers=1`
    passed Chromium but failed Firefox and WebKit because the post-refocus
    `mod+b` hotkey was still suppressed and the typed `X` was plain.
  - Runtime fix: external `focusout` now schedules a short dangling-composition
    reset only when Edytor is still composing. A real `compositionstart`,
    `compositionend`, or editor destroy clears that timer, so legitimate
    composition cleanup still wins.
  - Browser coverage: added
    `processes hotkeys normally after blur drops compositionend` to
    `tests/editor-dom/composition.spec.ts`. The test dispatches
    `compositionstart` without `compositionend`, blurs the editor, refocuses
    the text, presses `mod+b`, types `X`, and asserts the inserted character is
    bold with a collapsed caret after it.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "blur drops compositionend" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition-cancellation.spec.ts --workers=1`
    passed 24 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts --workers=1`
    passed 93 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "splits a cleared paragraph|paragraph-split|Enter" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - Verification: `pnpm test -- --run` passed 269 tests.
  - Verification: `pnpm test:dom` passed 90 tests.
  - Verification: `pnpm check` passed with 0 errors and 0 warnings.
  - Verification: `pnpm test:dom:typecheck` passed with 0 errors and 0
    warnings.
  - Verification: `pnpm build` passed, including package generation and
    `publint`.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, typed `One`, toggled bold for `B`, toggled bold off for
    following text, inserted a soft break, typed `X`, used Backspace,
    undo/redo, and inspected the managed DOM. The rendered editor kept one
    managed text wrapper, one bold mark wrapper for `B`, coherent soft-break
    text, and no console errors. Direct in-app Browser `Enter` key injection
    did not reproduce the split path, so the real Playwright demo-route split
    regression above remains the authoritative cross-browser evidence for
    Enter.

- 2026-05-25: completed consecutive trailing soft-break selection mapping.
  - DeepWiki findings: Slate has explicit Firefox compensation for selection
    offsets when text ends with consecutive newlines. ProseMirror and Svedit
    also treat trailing BR/newline marker selection as browser-sensitive DOM
    plumbing rather than trusting native offsets.
  - Material gap: Edytor covered a single trailing soft-break marker, typing
    after that marker, and Backspace from that marker. It did not prove the
    repeated trailing newline case where Firefox/WebKit can remove or rewrite
    the browser-only marker while the model still ends with `\n\n`.
  - Proven gap before runtime patch:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "consecutive trailing soft" --workers=1`
    initially passed Chromium but failed Firefox/WebKit because the trailing
    marker was absent or unstable after repeated Shift+Enter.
  - Runtime fix: `data-edytor-trailing-newline` is now classified as managed
    editor DOM in `domTextMutationObserver`, and liveness checks restore it
    only when its owning live text still ends with a newline.
  - Browser coverage: added
    `types at the model text end after consecutive trailing soft breaks` to
    `tests/editor-dom/input.spec.ts`. The test creates two real Shift+Enter
    soft breaks, forces the native caret into the trailing marker, types `x`,
    and asserts the model text becomes `lead\n\nx` with the caret at offset 7
    and no stale marker.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "consecutive trailing soft" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "soft break|soft-break|trailing" --workers=1`
    passed 18 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1`
    passed 153 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1`
    passed 33 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - Verification: `pnpm test -- --run` passed 269 tests.
  - Verification: `pnpm test:dom` passed 90 tests.
  - Verification: `pnpm check` passed with 0 errors and 0 warnings.
  - Verification: `pnpm test:dom:typecheck` passed with 0 errors and 0
    warnings.
  - Verification: `pnpm build` passed, including package generation and
    `publint`.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, used direct keypresses to type `One`, inserted two
    Shift+Enter soft breaks, typed `X`, and inspected the live DOM. The editor
    contained one text node with `One\n\nX`, zero trailing markers after the
    final non-newline character, no duplicated visible text, and no console
    errors. A collapsed bold-toggle smoke also left one bold wrapper for `B`
    and plain `n` after undo/redo.

- 2026-05-25: completed code-island vertical arrow selection resilience.
  - DeepWiki findings: Lexical has a Firefox-specific regression around
    selection loss after ArrowUp inside code blocks. ProseMirror treats
    isolating/code-like content as browser-sensitive around selection updates,
    especially near uneditable or structured boundaries.
  - Material gap: Edytor had browser coverage for code-line Tab behavior,
    suggestion acceptance, Escape suggestion clearing, and code island
    Backspace/Delete merge guards. It did not directly prove that vertical
    arrow movement inside a code island leaves the model selection live for the
    next edit.
  - Browser coverage: added
    `keeps code-line selection live after vertical arrow navigation` to
    `tests/editor-dom/selection.spec.ts`. The test loads
    `/test/dom?scenario=code`, places the caret at the start of the second code
    line, presses ArrowUp, types `X`, and asserts the first code line becomes
    `Xconst a = 1;`, the second line remains `return a;`, and selection is a
    collapsed caret in the first code line.
  - Runtime result: no production patch was required; current code-island
    selection mapping already satisfied the peer-derived contract.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "code-line selection live" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`
    passed 99 tests with 6 documented skips across Chromium, Firefox, and
    WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, typed `One`, toggled bold around `Two`, inserted a
    Shift+Enter soft break, typed `Soft`, used Backspace, undo, redo, and Tab,
    then inspected DOM/model state. The editor showed one paragraph containing
    `OneTwo\nSof`, one bold wrapper for `Two`, a collapsed caret in the edited
    text, and no console errors.

- 2026-05-25: completed initial route-load focus neutrality.
  - DeepWiki findings: Lexical explicitly regression-tests that an editor must
    not auto-focus itself on page load. Slate and ProseMirror reinforce the
    same boundary from the opposite side: focus/refocus should restore or
    reconcile a cached editor selection only after real focus intent, not
    during mount.
  - Material gap: Edytor already had coverage for Tab focus, programmatic
    refocus, `clear()` focus restoration, and blurred remote/programmatic
    updates. It did not have a direct browser gate proving route mount itself
    leaves focus and native selection outside the editor before user intent.
  - Browser coverage: added
    `does not focus the editor or create an editor selection on route load` to
    `tests/editor-dom/features.spec.ts`. The test loads
    `/test/dom?scenario=basic&empty=first`, asserts the active element is not
    inside `[data-edytor]`, asserts native selection is not inside the editor,
    then clicks the placeholder, types `A`, and asserts both document content
    and model selection.
  - Runtime result: no production patch was required; current mount behavior
    already satisfied the contract.
  - Verification:
    `pnpm test:integration tests/editor-dom/features.spec.ts -g "does not focus the editor" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/features.spec.ts --workers=1`
    passed 36 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, typed `One`, toggled bold around `Two`, inserted a
    Shift+Enter soft break, typed `Soft`, used Backspace, undo, redo, and Tab,
    then inspected DOM/model state. The editor showed one paragraph containing
    `OneTwo\nSof`, one bold wrapper for `Two`, a collapsed caret in the edited
    text, and no console errors.

- 2026-05-25: completed programmatic-focus scroll stability regression.
  - DeepWiki findings: ProseMirror and Lexical explicitly prevent editor focus
    from causing unwanted document scroll, while Slate treats root focus
    restoration as a browser-sensitive selection boundary.
  - Material gap: Edytor had browser coverage proving cached selection is
    restored on programmatic root focus and Tab focus, but no regression proved
    that an internal programmatic focus path such as `clear()` can restore a
    caret without scrolling a page whose editor is below the viewport.
  - Browser coverage: added
    `keeps scroll position stable when clear programmatically focuses the editor`
    to `tests/editor-dom/selection.spec.ts`. The test inserts a tall spacer
    before the editor, scrolls to the page top, calls `edytor.clear()`, and
    proves the editor is focused, `scrollY` stays `0`, and the next typed
    character lands in the new empty paragraph.
  - Runtime result: no production patch was needed. Existing clear/focus/caret
    restoration behavior already kept the page scroll stable across the tested
    engines.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "scroll position stable" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`
    passed 96 tests with 6 documented skips across Chromium, Firefox, and
    WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, typed `One`, toggled bold, typed more text, inserted a
    Shift+Enter soft break, used Backspace, undo, redo, Tab, Enter, and typed
    `End`. The editor ended with two coherent paragraph blocks,
    `Two\nSof` and `End`, and no console errors were emitted.

- 2026-05-25: completed selected-block Escape collapse browser regression.
  - DeepWiki findings: Lexical treats Escape as a selection-resilience command
    that exits an active range by blurring/clearing DOM selection, while Slate
    and ProseMirror keep focus/blur and node-selection collapse model-owned so
    stale browser ranges do not leak into the next edit.
  - Material gap: Edytor already had a runtime `escape` hotkey for selected
    blocks, but no Chromium/Firefox/WebKit browser regression proved that
    Escape clears `selectedBlocks`, collapses to a live text caret in the
    selected block, and lets the next typed character mutate that block instead
    of a stale browser range.
  - Browser coverage: added
    `collapses selected-block state with escape before the next edit` to
    `tests/editor-dom/hotkeys.spec.ts`.
  - Runtime result: no production patch was needed. Existing selected-block
    Escape behavior already satisfied the peer-derived contract.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts -g "collapses selected-block state with escape" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts --workers=1`
    passed 66 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, typed `One`, toggled bold, typed more text, inserted a
    Shift+Enter soft break, used Backspace, undo, redo, and Tab. The editor
    ended with a single managed text wrapper containing `Two\nSof`, and no
    console errors were emitted.

- 2026-05-25: completed live localhost DOM duplication audit on `/` without a
  runtime patch.
  - Trigger: user reported that typing, mark toggles, and double-space auto-dot
    again visibly duplicated text in the DOM while the serialized value stayed
    correct.
  - Live in-app Browser evidence on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, clicked the empty editor, typed `One` through real key
    presses, toggled bold on the selection, cleared again, typed `Hello  `, and
    inspected managed `[data-edytor-text="true"]` wrappers after each step. The
    DOM stayed singular: `One` had one wrapper, bold `One` had one marked
    wrapper, and `Hello  ` had one wrapper. No console errors were emitted.
  - Follow-up live in-app Browser evidence on the current
    `http://localhost:5173/` tab: hard-reloaded `/`, cleared the editor, typed
    `One`, toggled bold on/off around `Two`, typed `Three`, split to a second
    paragraph, typed `End`, ran undo/redo, deleted inside the second paragraph,
    and pressed double space. The DOM stayed singular with one managed text
    wrapper per model text, one bold mark wrapper for `Two`, no extra auto-dot,
    and no console errors.
  - Focused browser regression coverage:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts tests/editor-dom/input.spec.ts tests/editor-dom/hotkeys.spec.ts tests/editor-dom/format-beforeinput.spec.ts tests/editor-dom/dom-mutation.spec.ts --workers=1 -g "duplicate|auto-dot|stale DOM clones|does not delete existing demo-route text|does not resurrect marked text|splits a cleared paragraph|coalesce typing after a paragraph split|placeholder after undoing text"`
    passed 30 tests across Chromium, Firefox, and WebKit.
  - Runtime result: no production patch was made because current source plus a
    hard-reloaded live tab did not reproduce the reported stale DOM clone. If
    the symptom persists in a user-held tab, the next useful evidence is the
    exact focused block/selection state before typing and whether a hard reload
    clears the stale Svelte/HMR DOM.
  - Known Browser limitation preserved: the in-app Browser locator `Enter` path
    still does not synthesize the same paragraph split as a real browser user;
    paragraph split remains covered by the Playwright demo-route gate.

- 2026-05-24: completed multiple editor instance document-listener isolation.
  - DeepWiki findings: Lexical explicitly manages root element listeners plus a
    shared document `selectionchange` listener when multiple editor instances
    exist on the same document. This is a separate boundary from ordinary
    external controls because both roots are valid editors with live cached
    selections and document-level keydown listeners.
  - Material gap: Edytor had per-editor document-level `selectionchange` and
    `keydown` listeners, but no browser regression proved that selecting and
    typing in a second editor instance could not rewrite the first editor's
    cached selection or mutate the first editor's model through stale listeners.
  - Browser coverage: added a `secondary=true` deterministic `/test/dom` route
    option that renders a second Edytor root with its own serialized value and
    selection, plus
    `isolates document selectionchange and keydown listeners across editor instances`
    in `tests/editor-dom/selection.spec.ts`.
  - Runtime result: no production patch was needed. Existing listener routing
    already scopes `selectionchange` and `keydown` to the owning editor root.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "editor instances" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`
    passed 93 tests with 6 documented skips across Chromium, Firefox, and
    WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm test:dom:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm check` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed after formatting the deterministic DOM
    route fixture.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, typed `One`, exercised mark-toggle smoke, typed
    `Hello  ` then Backspace, ran undo/redo, inserted a Shift+Enter soft break,
    sent Tab, attempted Enter, and left the page with one managed text wrapper
    containing `One`. No console errors were emitted. The in-app Browser
    locator `Enter` path still did not synthesize paragraph split; paragraph
    split remains covered by the existing focused Playwright demo-route gate.

- 2026-05-24: completed placeholder visibility during active IME composition.
  - DeepWiki findings: Slate hides placeholders while composing to avoid IME UI
    and placeholder DOM competing in empty editable text. Lexical and
    ProseMirror similarly treat active composition as a browser-owned mode where
    editor UI must not interfere with the native composition target.
  - Material gap: Edytor already removed stale placeholders after text insertion
    and browser-owned DOM drift, but had no browser regression proving an
    empty-block placeholder disappears during active composition before
    committed model text exists.
  - Failing evidence before the runtime patch:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "placeholders while IME" --workers=1`
    failed in Chromium, Firefox, and WebKit because
    `[data-edytor-text-placeholder]:visible` still had count `1` immediately
    after `compositionstart`.
  - Runtime fix: `Edytor.isComposing` is now Svelte-reactive state, and
    `Text.svelte` suppresses placeholder rendering while the owning editor is
    composing.
  - Browser coverage: added
    `hides empty-block placeholders while IME composition is active` to
    `tests/editor-dom/composition.spec.ts`. The test proves placeholder
    visible-before, hidden-during, visible-after-canceled-composition, and
    hidden-after-committed-composition behavior.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "placeholders while IME" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts --workers=1`
    passed 90 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm test:dom:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm check` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, typed `One`, exercised mark-toggle smoke, typed
    `Hello  ` then Backspace, ran undo/redo, inserted a Shift+Enter soft break,
    sent Tab, attempted Enter, and left the page with one managed text wrapper
    containing `One`. No console errors were emitted. The in-app Browser
    locator `Enter` path still did not synthesize paragraph split; paragraph
    split remains covered by the existing focused Playwright demo-route gate.

- 2026-05-24: completed non-native `contenteditable=false` island stale-key
  guard.
  - DeepWiki findings: Svedit calls out `contenteditable=false`
    custom-property islands as cursor traps, and ProseMirror/Slate treat
    uneditable inline islands as browser-sensitive selection/key boundaries.
  - Material gap: Edytor had coverage for inline atomic mentions, void block
    bodies, and native interactive controls, but not a plain non-native
    `contenteditable=false` island inside a normal editable block, such as a
    callout icon.
  - Failing evidence before the runtime patch:
    `pnpm test:integration tests/editor-dom/features.spec.ts -g "contenteditable=false island" --workers=1`
    failed in Firefox and WebKit because clicking the callout icon then
    pressing Backspace changed the callout text from `task` to `tas`.
  - Runtime fix: `EdytorSelection.applySelectionSnapshot` now detects
    non-native `contenteditable=false` islands inside the editor, excludes real
    native controls (`input`, `textarea`, `select`, `button`, links), and maps
    that browser selection back to the owning block's first editable text
    boundary before structural keys can mutate stale text.
  - Browser coverage: added the `callout` scenario to `/test/dom` and added
    `does not delete stale text after clicking a non-native contenteditable=false island`
    to `tests/editor-dom/features.spec.ts`.
  - Verification:
    `pnpm test:integration tests/editor-dom/features.spec.ts --workers=1`
    passed 33 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "native control|external contenteditable|empty native selectionchange|void body|selected block content|programmatically focusing|tabbing into the editor" --workers=1`
    passed 27 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "splits a cleared paragraph" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "does not duplicate visible text|auto-dot|does not duplicate marked text" --workers=1`
    passed 9 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, typed `One`, checked mark-toggle smoke paths,
    typed `Hello  ` then Backspace, ran undo/redo, and left the page with one
    managed text wrapper containing `One`. No console errors were emitted. The
    in-app Browser locator `Enter` path still did not synthesize paragraph
    split, so split/undo remains verified by the focused Playwright
    demo-route gate above.

- 2026-05-24: completed composition before adjacent identical committed text.
  - DeepWiki findings: ProseMirror tracks a Chrome composition crash class when
    composition happens immediately before another instance of the same
    composed text.
  - Material gap: Edytor covered same-character non-IME replacement and broad
    IME preview/final replacement, but not the browser case where final
    composition data equals the adjacent existing text.
  - Browser coverage: added `compositionRepeat` to the deterministic
    `/test/dom` route and added
    `commits composition before adjacent identical text without merging or duplicating preview`
    to `tests/editor-dom/composition.spec.ts`.
  - Runtime result: no production patch was needed. The existing composition
    replacement path already deletes the active preview by its stored range and
    inserts the final value once.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "adjacent identical text" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts --workers=1`
    exited green with 86 passed and one existing WebKit retry on the older
    post-composition Backspace selection test.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "splits a cleared paragraph" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, clicked the empty paragraph, typed `One`,
    double-clicked a word and sent mark hotkeys, typed `Hello  ` then
    Backspace/undo/redo, inserted a Shift+Enter soft break, sent Tab, and
    attempted Enter. The live DOM kept one managed text wrapper for the smoke
    states and emitted no console errors. The in-app Browser key layer still
    did not synthesize paragraph `Enter` as a split, so paragraph split/undo
    remains verified through the focused Playwright demo-route gate above.

- 2026-05-24: completed Backspace merge after previous inline atom.
  - DeepWiki findings: Lexical has regression coverage for Backspace at the
    start of a paragraph when the previous paragraph ends around an inline
    decorator. The expected editor-owned behavior is to merge the current
    paragraph into the previous one, preserve the inline/decorator node, and
    restore the caret at the merge boundary.
  - Material gap: Edytor already covered plain real-browser backward merge,
    same-block inline mention deletion, inline-atom pointer/keyboard
    selection, and real Backspace before an inline atom. It did not cover a
    block-boundary merge where the destination block already contains inline
    atoms.
  - Failing evidence:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "previous block ends after an inline mention" --workers=1`
    initially failed in Chromium, Firefox, and WebKit. The model content merged
    correctly, but the restored selection pointed to the final appended text
    part instead of the merge boundary.
  - Runtime fix: `deleteContentBackward` now restores the caret to the captured
    pre-merge `previousText` at its pre-merge offset instead of recomputing
    `previousBlock.lastText` after source content has been appended.
  - Added browser coverage in `tests/editor-dom/input.spec.ts` proving real
    Backspace from the start of the second inline scenario block preserves both
    mention atoms, merges adjacent text to `taillead `, and leaves the caret at
    the original destination boundary.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "previous block ends after an inline mention|merges backward at the start|merges forward at the end" --workers=1`
    passed 9 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1`
    passed 150 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "splits a cleared paragraph" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed after formatting the edited browser spec.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, clicked the empty paragraph, typed `One`,
    double-clicked a word and sent bold hotkeys, typed `Hello  ` then
    Backspace/undo/redo, toggled collapsed bold before typing `B`, inserted a
    Shift+Enter soft break, and sent Tab after typed text. The live DOM kept
    one text wrapper for each smoke state (`One`, `Hello  `, `Hello `, `B`,
    `One\nTwo`, `Tab`) and emitted no console errors. The in-app Browser smoke
    did not rely on mark-application as proof; it only checked for the reported
    DOM duplication. The in-app Browser key layer still did not synthesize
    paragraph `Enter` as a split in this smoke; paragraph split/undo was
    verified through the focused Playwright demo-route gate above.

- 2026-05-24: completed selected inline atom front-click clearing coverage.
  - DeepWiki findings: ProseMirror tracks a browser selection quirk where
    clicking directly in front of a node selection may not clear the
    node-selection markup. Edytor already covered direct inline atom clicks,
    off-edge clicks after atoms, keyboard traversal, and drag selections, but
    not the selected-atom to pre-atom caret transition by real pointer click.
  - Added browser coverage in `tests/editor-dom/inline-atomic.spec.ts` proving
    that after selecting the second inline mention in
    `/test/dom?scenario=inline`, a real click just before the mention clears
    `selectedInlineBlock` and `inlineBlockDeletionTarget`, collapses the model
    caret to the end of the preceding text, and lets the next typed character
    insert before the mention.
  - Runtime result: no production patch was needed. Existing selection mapping
    already normalizes this front-edge click in Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts -g "clicking directly before" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts --workers=1`
    passed 36 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "splits a cleared paragraph" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed before this ledger update.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, clicked the empty paragraph, typed `One`, toggled bold
    on a selected word, typed `Hello  ` then Backspace/undo/redo, toggled
    collapsed bold before typing `B`, retried Shift+Enter soft break, and sent
    Tab after typed text. The live DOM kept one text wrapper for each smoke
    state (`One`, `Hello  `, `Hello `, `B`, `One\nTwo`, `Tab`) and emitted no
    console errors. The in-app Browser key layer still did not synthesize
    paragraph `Enter` as a split in this smoke; paragraph split/undo was
    verified through the focused Playwright demo-route gate above.

- 2026-05-24: completed off-edge inline atomic coordinate-click coverage.
  - DeepWiki findings: ProseMirror tracks Chrome coordinate quirks where
    clicking above/right of an uneditable inline node can place the cursor
    after the atom in a browser-owned position. Edytor already covered direct
    atomic mention clicks and keyboard traversal, but not an off-edge pointer
    coordinate near an uneditable inline atom.
  - Added browser coverage in `tests/editor-dom/inline-atomic.spec.ts` proving
    a click just after the second inline mention in `/test/dom?scenario=inline`
    maps to the trailing editable text at offset `0`; the next typed
    character inserts before the existing trailing text and leaves the mention
    unselected.
  - Runtime result: no production patch was needed. Existing selection mapping
    already normalizes this coordinate boundary in Chromium, Firefox, and
    WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts -g "off-edge clicks" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts --workers=1`
    passed 33 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed after formatting the edited browser spec.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, clicked the empty paragraph, typed `One`, toggled bold
    on a selected word, cleared again, typed `Hello  `, cleared again,
    toggled collapsed bold before typing `B`, used Backspace and undo/redo
    over text edits, and checked the live DOM. Visible text wrappers stayed
    singular (`One`, `Hello  `, then `B`), no duplicated rendered text
    appeared, and no browser console errors were emitted. The in-app Browser
    key layer did not synthesize paragraph `Enter` on this surface during this
    smoke; paragraph split/undo remains covered by the Playwright browser
    gates.

- 2026-05-24: completed composition after collapsed pending-mark toggle.
  - DeepWiki findings: Safari can break composition after active formatting
    changes, and Slate/Lexical treat composition state plus formatting state as
    a browser-sensitive boundary.
  - Material gap: existing tests covered composition inside existing marked
    text and formatting during an active composition. They did not cover the
    inverse order where a collapsed mark command creates pending formatting and
    the next IME composition must inherit it.
  - Failing evidence:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "pending mark" --workers=1`
    initially failed 6 tests across Chromium, Firefox, and WebKit because the
    committed IME text was inserted without the pending bold mark.
  - Runtime fix: collapsed rich-text mark commands now target `startText`
    directly even when `selection.state.texts` is empty, and `Text.markText`
    no longer treats an empty mark range as already marked. Empty-text pending
    marks now store `{ bold: true }` instead of `{ bold: null }`.
  - Browser coverage: added composition tests for both
    `insertCompositionText` and compositionend-only commits after a collapsed
    bold toggle in `tests/editor-dom/composition.spec.ts`.
  - Model coverage: added `applies pending marks from an empty text` to
    `src/tests/fixtures/model/operations/text.fixtures.tsx`.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "pending mark" --workers=1`
    passed 6 tests across Chromium, Firefox, and WebKit after the fix.
  - Verification:
    `pnpm test -- --run src/tests/fixtures/model/operations.test.ts` passed
    269 tests.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts --workers=1`
    passed 84 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/format-beforeinput.spec.ts -g "pending marks" --workers=1`
    passed 6 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed after formatting
    `src/lib/plugins/richtext/RichTextPlugin.svelte`.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, clicked the empty paragraph, toggled bold before
    typing the first character, typed `Bold`, toggled bold off, typed plain
    text, used double-space plus Backspace, inserted a Shift+Enter soft break,
    used Backspace plus undo/redo, and checked the live DOM. The page rendered
    one text wrapper, bold stayed scoped to `Bold`, and no browser console
    errors were emitted. The in-app Browser key layer still did not synthesize
    paragraph `Enter`; paragraph split remains verified by the real Playwright
    browser gates.

- 2026-05-24: completed link-mark anchor-boundary text insertion coverage.
  - DeepWiki findings: Slate treats Chrome insertion at the end of anchor
    elements as unsafe native editing because the browser can mutate anchor DOM
    away from the editor model. Edytor renders `link` marks as real `<a>`
    elements, so this needed a browser regression distinct from bold/italic
    mark-wrapper coverage.
  - Material gap: existing mark-boundary coverage covered plain formatting
    wrappers and IME composition from a mark-wrapper boundary. It did not prove
    collapsed typing from inside an actual anchor endpoint preserves link data
    and avoids browser-created DOM clones.
  - Browser coverage: added a deterministic `/test/dom?scenario=links` fixture
    and `types at the end of a link anchor without losing link marks or cloning DOM`
    in `tests/editor-dom/input.spec.ts`.
  - Runtime result: no runtime patch was needed. The existing model-owned text
    insertion path preserves the link mark and keeps visible DOM single-copy.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "link anchor" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "link anchor|browser-cloned mark|marked content|auto-dot" --workers=1`
    passed 9 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "splits a cleared paragraph|coalesce typing after a paragraph split" --workers=1`
    passed 6 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, clicked the empty paragraph, typed `One`, toggled bold
    around `Bold`, typed plain text, used double-space plus Backspace, inserted
    a Shift+Enter soft break, and checked the live DOM. The editor had one text
    wrapper for the visible content, bold was scoped to `Bold`, and no browser
    console errors were emitted. The in-app key layer did not reliably
    synthesize paragraph `Enter`; paragraph split and split-history behavior
    remain covered by the real Playwright browser gates above.

- 2026-05-24: completed Safari/WebKit null-data `beforeinput` dataTransfer
  text insertion coverage.
  - DeepWiki findings: Lexical handles Safari/WebKit `insertText` and
    `insertTranspose` events whose `event.data` is `null` while `dataTransfer`
    contains the actual text; Svedit likewise falls back to
    `dataTransfer.getData('text/plain')` for replacement input before DOM
    diffing.
  - Material gap: Edytor already covered `insertReplacementText`,
    `insertTranspose`, autocorrect, and native DOM reconciliation when
    `event.data` is present or a browser DOM mutation follows. It did not
    handle the cancelable Safari-shaped event where the useful text exists only
    in `event.dataTransfer`.
  - Failing evidence:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "dataTransfer text when Safari" --workers=1`
    initially failed 6 tests across Chromium, Firefox, and WebKit:
    `insertText` prevented default but left the model unchanged, and collapsed
    `insertReplacementText` returned `defaultPrevented === false`.
  - Runtime fix: `BeforeInputSnapshot` now derives effective text data from
    `dataTransfer.getData('text/plain')` for `insertText`,
    `insertReplacementText`, and `insertTranspose` when `event.data === null`.
    Cancelable replacement events with a transfer payload no longer stay
    browser-owned, so they run through controlled text insertion.
  - Browser coverage: added
    `uses dataTransfer text when Safari insertText reports null data` and
    `uses dataTransfer text when Safari replacement beforeinput reports null data`
    to `tests/editor-dom/input.spec.ts`.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "dataTransfer text when Safari" --workers=1`
    passed 6 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "dataTransfer text when Safari|insertReplacementText|insertTranspose|auto-dot|replacement" --workers=1`
    passed 33 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, clicked the empty paragraph, typed `One`, toggled bold
    with `Meta+B`, typed `Bold`, toggled bold off, typed `Plain`, pressed Space
    twice, Backspace, Enter, typed `Two`, inserted a Shift+Enter soft break,
    typed `Soft`, pressed Tab, Backspace, undo, and redo. The visible content
    stayed coherent, bold remained scoped to `Bold`, the soft break stayed
    inside the paragraph, Tab nested the second block, and no browser console
    errors were emitted.

- 2026-05-24: completed real Backspace-before-inline-atom bogus line-break
  coverage.
  - DeepWiki findings: ProseMirror records Chrome and Firefox regressions where
    Backspace before widgets, flex/grid widgets, or inline-flex atom-like nodes
    can create bogus line breaks. Svedit's cursor-trap design and Slate/Lexical
    void/decorator deletion handling reinforce that deletion beside non-text
    atoms must stay model-owned and browser DOM drift must be repaired.
  - Material gap: Edytor already removed deliberately injected bogus `<br>`
    nodes around inline mentions and covered selected inline-atom deletion, but
    it did not directly exercise the real repeated-Backspace sequence that
    deletes all text immediately before an inline atom.
  - Browser coverage: added
    `does not leave browser-created line breaks when backspacing text before an inline mention`
    to `tests/editor-dom/inline-atomic.spec.ts`.
  - Expectation correction: the first run proved the product serializes
    `mention + trailing text` without an explicit leading empty text sentinel
    once `lead ` is deleted. The test now asserts the existing JSON contract
    while still requiring no `<br>`, preserved inline atom, trailing text,
    top-level inline count, and collapsed caret at the inline boundary.
  - Runtime result: no production patch was needed. Existing deletion and DOM
    repair already keep the browser-owned line-break drift out of the model and
    DOM.
  - Verification:
    `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts -g "backspacing text before an inline mention" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts -g "backspacing text before an inline mention|bogus browser line breaks|native-selected inline mention|drag-selected ranges across inline mentions" --workers=1`
    passed 12 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, clicked the empty paragraph, typed `One`, toggled bold
    with `Meta+B`, typed `Bold`, toggled bold off, typed `Plain`, pressed Space
    twice, Backspace, Enter, typed `Two`, inserted a Shift+Enter soft break,
    typed `Soft`, pressed Tab, Backspace, undo, and redo. The visible content
    stayed coherent, bold remained scoped to `Bold`, the soft break stayed
    inside the paragraph, Tab nested the second block, and no browser console
    errors were emitted.

- 2026-05-24: repeated live localhost audit for the reported DOM duplication
  on `/`.
  - User-visible symptom rechecked: normal typing, collapsed mark toggles,
    double-space, Backspace, paragraph split, undo, redo, and marked-text
    aftermath on `http://localhost:5173/`.
  - In-app Browser verification: cleared the route, typed `One`, toggled bold
    around `Bold`, typed `Plain`, pressed Space twice, Backspace, Enter, typed
    `Two`, and ran undo/redo. After a full page reload, the same smoke still
    produced one managed text node per logical text segment, bold only around
    `Bold`, no visible duplicated DOM text, and no console errors.
  - Focused regression gate:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts tests/editor-dom/hotkeys.spec.ts tests/editor-dom/format-beforeinput.spec.ts tests/editor-dom/dom-mutation.spec.ts --workers=1 -g "stale visible DOM clones|duplicate visible text|stale DOM clones|auto-dot|does not delete existing demo-route text|does not resurrect marked text|splits a cleared paragraph|placeholder after undoing text"`
    passed 24 tests across Chromium, Firefox, and WebKit.
  - Result: no runtime change. Reopen this area only with a fresh browser
    sequence that fails after a page reload, because the current route and
    focused cross-browser tests are green.

- 2026-05-24: completed Shift-click range extension coverage across marked
  text and inline atomic content.
  - DeepWiki findings: Lexical models Shift-selection through range-selection
    commands and decorator/block-aware extension logic; ProseMirror records
    Shift-selection workarounds around uneditable inline/block nodes,
    especially WebKit; Svedit maps DOM selections through explicit
    cursor-trap/text-selection logic before commands run.
  - Material gap: Edytor already covered arrow-based selection extension, drag
    ranges across inline atoms, double/triple-click follow-up mutations, and
    pointer clicks inside selected block content, but not real Shift+click
    extension from marked text into text after an inline mention followed by a
    mutation.
  - Browser coverage: added
    `maps Shift-click range extension across marked text and inline atoms before replacement`
    to `tests/editor-dom/selection.spec.ts`.
  - Test harness hardening: Shift-click pointer targeting now clicks near the
    requested glyph boundary rather than the glyph midpoint, because Chromium
    placed the caret on the far side of the glyph while Firefox/WebKit placed
    it on the near side.
  - Runtime result: no production patch was needed. Current selection mapping
    and text replacement already delete the full Shift-click range and restore
    a collapsed caret after the inserted character.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "Shift-click range extension" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "Shift-click|drag-created|inline mention|double-click|triple-click|selected block content" --workers=1`
    passed 21 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm test:dom:typecheck` passed with 0 errors and 0
    warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, typed `One`, toggled bold with `Meta+B`, typed `Bold`,
    toggled bold off, typed `Plain`, pressed Space twice, Backspace, Enter,
    typed `Two`, inserted a Shift+Enter soft break, typed `Soft`, pressed Tab,
    Backspace, undo, and redo. The live DOM stayed coherent with bold only
    around `Bold`, nested text after Tab remained model-owned, and no console
    errors were emitted.

- 2026-05-24: live localhost regression audit for reported duplicated DOM
  text.
  - User-visible symptom checked: typing into `/`, toggling marks, double-space
    auto-dot behavior, paragraph split, undo, and redo allegedly duplicated
    text in the DOM while serialized value stayed correct.
  - In-app Browser verification on `http://localhost:5173/`: refreshed the
    route, cleared the document, typed `One`, toggled bold with `Meta+B`, typed
    `Bold`, toggled bold off, typed `Plain`, pressed Space twice, split with
    Enter, typed `Two`, and exercised undo/redo. The live DOM remained coherent:
    first paragraph `OneBoldPlain  ` with bold only around `Bold`, second
    paragraph `Two`, and no console errors.
  - In-app Browser verification also selected text on `/`, toggled bold with
    `Meta+B`, and replaced the selected marked text. The visible DOM did not
    duplicate selected text.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "mark-toggle|auto-dot|duplicat|clear|typing" --workers=1`
    passed 30 tests across Chromium, Firefox, and WebKit.
  - Result: no runtime change was made in this slice because the fresh
    browser-backed session and existing regression gates did not reproduce the
    reported stale-DOM duplication. If the symptom reappears, capture the exact
    sequence from a freshly reloaded page before reopening this area.

- 2026-05-24: completed inline-adjacent triple-click replacement coverage.
  - DeepWiki findings: Slate fixes Chrome triple-clicks before
    `contenteditable=false` nodes and uses unhang-style normalization to keep
    browser triple-click ranges from spilling into adjacent content.
    ProseMirror routes triple-clicks to semantic block/document selection and
    has WebKit handling for selections next to uneditable nodes. Lexical
    adjusts triple-click selections when anchor/focus spill across nodes and
    treats decorator nodes as atomic selection boundaries.
  - Material gap: Edytor already covered normal text triple-click replacement,
    void-body triple-click selection, inline atom click/drag/delete, and inline
    boundary arrow behavior, but not immediate typed replacement after
    triple-clicking editable text immediately before an inline mention atom.
  - Failing evidence:
    `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts -g "triple-click before an inline atom" --workers=1`
    initially failed in WebKit because the immediate typed replacement produced
    `X + mention + trailing text` instead of replacing the whole
    inline-containing paragraph.
  - Runtime changes: triple-click now writes a synchronous model selection for
    the clicked block content before delayed DOM range normalization. The next
    text insertion preserves that model-owned range instead of trusting a
    WebKit target range that may still represent only the pre-atom text. The
    delayed DOM normalization now skips if typing already collapsed the
    selection.
  - Browser coverage: added
    `replaces only an inline-containing paragraph after a triple-click before an inline atom`
    to `tests/editor-dom/inline-atomic.spec.ts`.
  - Verification:
    `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts -g "triple-click before an inline atom" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts tests/editor-dom/selection.spec.ts -g "inline|triple-click|double-click|void body|word-boundary|selected block content" --workers=1`
    passed 54 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:dom:typecheck` passed with 0 errors and 0
    warnings.
  - Verification: `pnpm check` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    confirmed the editor root was present, cleared the document, clicked the
    placeholder, typed `One`, toggled bold with `Meta+B`, typed `Bold`, toggled
    bold off, typed `Plain`, used double-space, Backspace, undo, redo, split
    with Enter, typed `Two`, inserted a Shift+Enter soft break, typed `Soft`,
    Backspaced once, used undo/redo, and confirmed no browser console errors.
    The live DOM showed coherent paragraph text `OneBoldPlain  ` and
    `Two\nSof` with the bold mark only around `Bold`.

- 2026-05-24: completed editable root textbox semantics coverage.
  - DeepWiki findings: Slate treats root `contenteditable` attributes as
    explicit browser-facing contracts, including textbox semantics and
    `aria-multiline`; ProseMirror/Lexical/Svedit likewise keep root
    contenteditable attributes deliberate because browsers and assistive
    technologies interpret them as part of editing behavior.
  - Material gap: Edytor already browser-tested mutation guard attributes
    (`translate`, `spellcheck`, `autocorrect`, `autocomplete`,
    `autocapitalize`) and their overrides, but did not lock
    `role="textbox"`, `aria-multiline`, or readonly semantics on the root.
  - Runtime changes: the editable root now renders `role="textbox"`,
    `aria-multiline="true"`, and `aria-readonly` from the current readonly
    mode; the readonly rendering helper mirrors the same semantic root.
  - Browser coverage: extended `tests/editor-dom/features.spec.ts` so the
    editable route asserts textbox semantics and the readonly route asserts the
    same root remains discoverable as readonly text.
  - Mounted coverage: extended `src/tests/fixtures/dom/callbacks.fixtures.tsx`
    to assert root textbox semantics in the fixture-driven DOM lane.
  - Verification:
    `pnpm test:integration tests/editor-dom/features.spec.ts -g "browser-mutation guard|readonly routes" --workers=1`
    passed 9 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:dom src/tests/fixtures/dom/dom.test.ts` passed 90
    mounted DOM fixtures.
  - Verification: `pnpm test:dom:typecheck` passed with 0 errors and 0
    warnings.
  - Verification: `pnpm lint` passed.
  - Verification: `pnpm check` passed with 0 errors and 0 warnings.
  - Demo-route verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "typing in default marked text|toggling a mark|auto-dot|splits a cleared paragraph|typing after a paragraph split|placeholder after undoing text|clears after edit history" --workers=1`
    passed 21 tests across Chromium, Firefox, and WebKit.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    confirmed the live editor root now exposes `role="textbox"`,
    `aria-multiline="true"`, `aria-readonly="false"`, `translate="no"`, and
    the existing mutation guard attributes. Cleared the editor and exercised
    per-key typing plus mark toggles; visible DOM did not duplicate typed or
    marked text. The in-app Browser text helper was unavailable because its
    virtual clipboard layer was not installed, and the keypress-only surface
    did not emit a trustworthy Enter split, so the demo-route Playwright gate
    above remains the source of truth for Enter/undo behavior on `/`.

- 2026-05-24: completed empty native selectionchange after blur coverage.
  - DeepWiki findings: Slate has Safari/WebKit blur handling that can remove
    all native ranges while keeping editor focus/selection semantics coherent;
    ProseMirror resynchronizes the DOM selection from internal state on focus
    when browsers reset or clear it; Lexical stores selection in `EditorState`
    and marks it dirty on focus; Svedit returns early when
    `window.getSelection().rangeCount === 0`.
  - Material gap: Edytor already covered external controls, external
    `contenteditable`, stale blurred ranges, and programmatic root focus, but
    not the Safari/WebKit-shaped case where the document selection has no
    ranges at all after blur before the editor is refocused.
  - Browser coverage: added
    `ignores empty native selectionchange after blur before programmatic refocus`
    to `tests/editor-dom/selection.spec.ts`.
  - Contract locked: after the cached Edytor caret is inside `note` at offset
    `2`, focusing an external button, clearing all native DOM ranges, and
    dispatching `selectionchange` leaves Edytor selection unchanged;
    `edytor.node.focus()` followed by typing `X` produces `noXte` and a
    collapsed caret at offset `3`.
  - Runtime changes: none. Existing null-selection filtering and cached
    model-selection restoration already handled this browser shape; the missing
    part was browser regression coverage.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "empty native selectionchange" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "native control|external contenteditable|empty native selectionchange|partially belong|tabbing into the editor|programmatically focusing" --workers=1`
    passed 19 tests and skipped 2 expected WebKit synthetic partial-range
    cases.
  - Verification: `pnpm test:dom:typecheck` passed with 0 errors and 0
    warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, clicked the empty placeholder, typed `One`, toggled
    bold with `Meta+B`, typed `Bold`, toggled bold off, typed `Plain`, used
    double-space, split with Enter, typed `Two`, inserted a Shift+Enter soft
    break, typed `Soft`, Backspaced once, used undo/redo, and confirmed no
    console errors. The live DOM had two managed paragraph blocks with text
    `OneBoldPlain  ` and `Two\nSof`, one bold mark wrapping only `Bold`, and no
    stale placeholders.

- 2026-05-24: completed external `contenteditable` selectionchange refocus
  coverage.
  - DeepWiki findings: Slate ignores external native control
    `selectionchange` noise and preserves editor selection through focus
    return; ProseMirror restores selection on focus when browsers reset or move
    DOM selection; Lexical keeps internal selection when focus leaves external
    controls/window and marks selection dirty on refocus; Svedit ignores
    `selectionchange` whose range is outside the editor canvas.
  - Material gap: Edytor already covered external `<input>`/`<textarea>`
    selectionchange noise, partial native selections crossing editor/outside,
    Tab refocus, and button-driven programmatic focus, but not a full external
    `contenteditable` selection that owns a native text range before Edytor is
    programmatically refocused.
  - Browser coverage: added
    `ignores external contenteditable selectionchange before programmatic refocus`
    to `tests/editor-dom/selection.spec.ts`.
  - Contract locked: after the cached Edytor caret is inside `note` at offset
    `2`, selecting `ternal e` inside an external `contenteditable` leaves
    Edytor selection unchanged; `edytor.node.focus()` followed by typing `X`
    produces `noXte` and a collapsed caret at offset `3`.
  - Runtime changes: none. Existing outside-selection filtering and cached
    model-selection restoration already handled this peer-editor quirk; the
    missing part was browser regression coverage.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "external contenteditable" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "native control|external contenteditable|partially belong|tabbing into the editor|programmatically focusing" --workers=1`
    passed 16 tests and skipped 2 expected WebKit synthetic partial-range
    cases.
  - Verification: `pnpm test:dom:typecheck` passed with 0 errors and 0
    warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, clicked the empty placeholder, typed `One`, toggled
    bold with `Meta+B`, typed `Bold`, toggled bold off, typed `Plain`, used
    double-space, split with Enter, typed `Two`, inserted a Shift+Enter soft
    break, typed `Soft`, Backspaced once, used undo/redo, and confirmed no
    console errors. The live DOM had two managed paragraph blocks with text
    `OneBoldPlain  ` and `Two\nSof`, one bold mark wrapping only `Bold`, and no
    stale placeholders.

- 2026-05-24: rechecked live root-route DOM duplication report without a
  runtime patch.
  - Fresh user report: on `http://localhost:5173/`, typing and mark toggles
    visibly duplicated text in the DOM while the serialized value remained
    correct; double-space auto-dot also appeared to delete previous content.
  - In-app Browser evidence: hard-reloaded `/`, cleared the editor, clicked the
    placeholder, typed `One`, toggled bold with the macOS `Meta+B` path, typed
    `Two`, toggled bold off, used double-space plus Backspace, then checked the
    live DOM. The editor had one managed text wrapper, one bold mark wrapping
    only `Two`, visible text `OneTwo  `, no stale placeholder, and no console
    errors.
  - In-app Browser evidence: repeated the longer flow with paragraph split,
    typing `Next`, undo, and redo. The live DOM had two paragraph blocks with
    managed text wrappers `OneTwo  ` and `Next`; no duplicated managed text
    nodes or stale clones were visible.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts tests/editor-dom/hotkeys.spec.ts tests/editor-dom/format-beforeinput.spec.ts tests/editor-dom/input.spec.ts tests/editor-dom/dom-mutation.spec.ts --workers=1 -g "duplicate|auto-dot|stale DOM clones|does not delete existing demo-route text|does not resurrect marked text|splits a cleared paragraph|coalesce typing after a paragraph split|placeholder after undoing text"`
    passed 30 tests across Chromium, Firefox, and WebKit.
  - Runtime changes: none. The current checked runtime and a hard-reloaded
    localhost tab do not reproduce the reported DOM/value divergence, so a
    production patch would be speculative.

- 2026-05-24: completed reverse soft-break range mark-formatting coverage.
  - DeepWiki findings: ProseMirror preserves reverse DOM selections via
    `Selection.extend` with range fallback and has BR-specific selection
    workarounds; Slate uses DOM-to-model range mapping plus
    `setBaseAndExtent` for backward ranges; Lexical keeps backward
    `RangeSelection` semantics while formatting selected nodes across
    `LineBreakNode` boundaries; Svedit explicitly detects backward native
    selections and maps newline/`<br>` offsets back to model text positions.
  - Material gap: Edytor already covered reverse mark formatting across sibling
    blocks and forward replacement across a soft break, but not a backward
    native range spanning the model soft break followed by a model-owned mark
    toggle that remounts marked DOM.
  - Browser coverage: added
    `preserves a reverse native selection across a soft break when toggling a mark`
    to `tests/editor-dom/hotkeys.spec.ts`.
  - Contract locked: after creating `le\nad`, a backward native range from
    after `a` to before `e` toggles bold only on `e\na`, leaves `l` and `d`
    plain, and keeps both Edytor selection state and native DOM selection
    backward.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts -g "soft break when toggling a mark" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts -g "reverse|mark|double-click|format" --workers=1`
    passed 18 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts --workers=1`
    passed 63 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run` passed 268 tests.
  - Verification: `pnpm check` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, typed `One`, toggled bold for `Bold`, toggled bold off
    for `Plain`, inserted two spaces, split with Enter, typed `Two`, inserted a
    Shift+Enter soft break, typed `Soft`, Backspaced once, used undo/redo,
    pressed Tab to nest the second paragraph, and confirmed no console errors
    or stale placeholders. Managed text wrappers stayed coherent:
    `OneBoldPlain  ` and nested `Two\nSof`.
  - Runtime changes: none. Existing reverse-selection restoration and mark
    formatting already handled this peer-editor quirk; the missing part was a
    browser regression gate.

- 2026-05-24: completed soft-break-spanning native range replacement coverage.
  - DeepWiki findings: ProseMirror maps `<br>`/hard-break positions through
    `selectionFromDOM`, `selectionToDOM`, `viewdesc`, and DOM change reading;
    Slate normalizes soft-break/newline selection through DOM-to-model point
    mapping and browser-specific newline offsets; Lexical treats line breaks as
    model `LineBreakNode`s and reconciles managed `<br>` nodes; Svedit maps
    trailing rendered `<br>` positions back to the model text length.
  - Material gap: Edytor already covered Shift+Enter insertion, trailing
    soft-break marker caret mapping, typing after the marker, Backspace from
    the marker, and unmanaged browser `<br>` cleanup, but not replacement of a
    native text range spanning the newline itself.
  - Browser coverage: added
    `replaces a native range spanning a soft break when typing` to
    `tests/editor-dom/input.spec.ts`.
  - Contract locked: after creating `le\nad`, selecting from before `e` to
    after `a`, and typing `X`, the document becomes `lXd`; the visible text
    wrapper is exactly `lXd`; selection collapses at model offset `2`.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "soft break when typing" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "soft break|replacement|cross-block" --workers=1`
    passed 33 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1`
    passed 138 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run` passed 268 tests.
  - Verification: `pnpm check` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded `/`,
    cleared the editor, typed `One`, toggled bold for `Bold`, toggled bold off
    for `Plain`, inserted two spaces, split with Enter, typed `Two`, inserted a
    Shift+Enter soft break, typed `Soft`, Backspaced once, used undo/redo,
    pressed Tab to nest the second paragraph, and confirmed no console errors
    or stale placeholders. Managed text wrappers stayed coherent:
    `OneBoldPlain  ` and nested `Two\nSof`.
  - Runtime changes: none. Existing selection mapping and model-owned
    replacement already handled this peer-editor line-break quirk; the missing
    part was a browser regression gate.

- 2026-05-24: completed live localhost duplication triage without runtime
  changes.
  - Fresh user report: the open root route at `http://localhost:5173/` showed
    duplicated visible editor DOM during typing and mark toggles, while the
    serialized value looked cleaner.
  - Live Browser evidence: after reloading `/`, clearing the editor, typing
    `One`, toggling bold for `Bold`, toggling bold off for `Plain`, pressing
    double Space, splitting with Enter, typing `Two`, and undoing/redoing once,
    the live DOM contained exactly two managed text wrappers:
    `OneBoldPlain  ` and `Two`; no console errors were present.
  - Material finding: the current runtime could not reproduce the reported
    duplication after reload. The likely boundary is a stale dev-server/HMR
    browser state or a still-unidentified selection gesture not covered by the
    user-provided screenshots.
  - Browser coverage rechecked: existing demo-route and input specs already
    cover visible marked DOM duplication, mark-toggle duplication, auto-dot
    preservation, marked deletion undo, paragraph split/undo grouping, browser
    replacement, double-click word replacement, cross-block replacement, and
    soft-break drift.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts tests/editor-dom/input.spec.ts -g "typing|bold|auto-dot|duplicat|split|replacement|same character|double-click word|soft break|cross-block" --workers=1`
    passed 72 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run` passed 268 tests.
  - Verification: `pnpm check` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - Runtime changes: none.

- 2026-05-24: completed same-character replacement selection aftermath
  coverage.
  - Fresh DeepWiki input: ProseMirror's DOM change reader, Svedit's input
    diff/selection commit flow, Slate's DOM selection synchronization, and
    Lexical's selection reconciliation all treat unchanged text plus changed
    selection as meaningful editor state rather than a no-op.
  - Material gap: Edytor already covered changed replacement text, marked-range
    replacement, double-click typed replacement, and browser-owned replacement
    reconciliation, but did not directly prove the case where replacing
    selected text with identical text must still collapse the caret.
  - Browser coverage: added
    `collapses the caret after replacing selected text with the same character`
    to `tests/editor-dom/input.spec.ts`.
  - Contract locked: selecting `o` in `note`, typing `o`, and then typing `X`
    leaves the first mutation as unchanged text `note`, collapses the caret at
    offset `2`, and inserts the follow-up character as `noXte`.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "same character" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "replacement|same character|double-click word|cross-block" --workers=1`
    passed 30 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1`
    passed 135 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run` passed 268 tests.
  - Verification: `pnpm test:dom:typecheck`, `pnpm check`, and `pnpm lint`
    passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, typed `One`, toggled bold for `Bold`, toggled
    bold off for `Plain`, pressed double-space, split with Enter, typed `Two`,
    inserted a Shift+Enter soft break, used Backspace plus undo/redo, pressed
    Tab to nest the second paragraph, and checked console errors. Visible DOM
    stayed coherent with no visible placeholders in non-empty content and no
    console errors.
  - Runtime changes: none. The existing model-owned expanded insertion path
    already handled the peer-editor quirk correctly; the missing part was the
    browser regression gate.

- 2026-05-24: completed live root-route nested child typing and duplicate-DOM
  regression recheck.
  - Fresh user report: duplicated visible DOM was observed on
    `http://localhost:5173/` while the serialized value stayed cleaner,
    especially around typing, mark toggles, and double-space auto-dot.
  - Live Browser evidence: after clearing the root route, typed `One`, toggled
    bold for `Bold`, toggled bold off for `Plain`, pressed double-space, split
    with Enter, typed `Two`, and used undo/redo. The rendered text wrappers
    stayed singular, no placeholder remained in non-empty content, and console
    errors were empty.
  - Material gap added: the screenshot-shaped default route path now has a real
    browser regression. A native mouse click into the default nested `One` child
    followed by typing must update only that nested child to `Oneeee`; parent
    `Prout`, sibling `Two`, and code content must remain unchanged.
  - Browser coverage: added
    `clicks and types into the default nested child without duplicating parent DOM`
    to `tests/editor-dom/demo-route.spec.ts`.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "default nested child" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1`
    passed 33 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:integration --workers=1` passed with exit code
    `0`: 811 passed, 11 skipped, and 3 known WebKit navigation flakes passed on
    retry.
  - Verification: `pnpm test -- --run` passed 268 tests.
  - Verification: `pnpm test:typecheck`, `pnpm test:dom:typecheck`,
    `pnpm check`, `pnpm lint`, and `pnpm build` passed.
  - Runtime changes: none. The newly locked browser path was already correct in
    terminal Playwright and the live post-clear route was coherent, so changing
    runtime would have been speculative.

- 2026-05-24: completed readonly browser selection and mutation-key no-op
  coverage.
  - Fresh DeepWiki input: Slate treats selection in `readOnly=true` editors as
    a supported DOM contract. Lexical similarly keeps selection coherent across
    non-editing boundaries rather than treating readonly or blurred state as a
    reason to lose the model selection.
  - Fresh gap: Edytor already had browser coverage proving readonly routes do
    not mutate under typing/paste, but did not prove a native readonly text
    selection maps into Edytor selection state. The new browser test exposed
    WebKit: after a readonly text selection, Backspace was not handled by
    Edytor because the keydown target was outside the editor even though the
    native selection remained inside it.
  - Runtime fix: keydown ownership now also checks whether the native selection
    is inside the editor root. In readonly mode, mutation keys are prevented
    while copy/select-all shortcuts and navigation keys remain available.
  - Browser coverage: added
    `maps native readonly text selection without allowing keyboard mutation` to
    `tests/editor-dom/features.spec.ts`.
  - Verification:
    `pnpm test:integration tests/editor-dom/features.spec.ts -g "readonly" --workers=1`
    passed 6 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/features.spec.ts tests/editor-dom/hotkeys.spec.ts tests/editor-dom/selection.spec.ts --workers=1 -g "readonly|outside control|focus moves outside|programmatically focusing|tabbing into the editor|cached model selection"`
    passed 18 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/features.spec.ts --workers=1`
    passed 30 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run` passed 268 tests.
  - Verification: `pnpm test:typecheck`, `pnpm test:dom:typecheck`,
    `pnpm check`, `pnpm lint`, and `pnpm build` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, typed `One`, toggled bold for `Bold`, toggled
    bold off for `Plain`, used double-space, split with Enter, typed `Two`,
    inserted a Shift+Enter soft break, used Backspace plus undo/redo, pressed
    Tab to nest the second paragraph, and checked console errors. Visible DOM
    stayed coherent with one scoped bold mark, no stale placeholders, nested
    `Two\nSof` content after Tab, and no console errors.

- 2026-05-24: rechecked the live localhost duplicate-text report on
  `http://localhost:5173/` without a runtime patch.
  - Fresh browser evidence: the in-app Browser was reloaded on the root route,
    the editor was cleared, and the live editor was exercised with plain typing,
    collapsed bold typing, bold-off plain typing, double-space plus Backspace,
    Enter split, undo, and redo. The rendered DOM stayed coherent: one scoped
    bold mark for `Bold`, no placeholder in non-empty text, and text wrappers
    matching the visible content.
  - Selected-range mark path: the in-app Browser was also exercised with
    `Control+A` followed by bold on existing typed text. The selected content
    stayed one visible text run wrapped by one bold mark, with no DOM-only
    duplicate.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts tests/editor-dom/hotkeys.spec.ts tests/editor-dom/format-beforeinput.spec.ts tests/editor-dom/dom-mutation.spec.ts --workers=1 -g "stale DOM clones|duplicate visible text|auto-dot|browser-cloned|wrappers that do not change|does not delete existing demo-route text|does not delete preceding"`
    passed 18 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1 -g "duplicate|auto-dot|split|undo"`
    passed 18 tests across Chromium, Firefox, and WebKit.
  - Note: an earlier demo-route run was started in parallel with another
    Playwright command and produced WebKit `page.goto` server-connection
    failures. The isolated sequential rerun above passed, so that failure was
    orchestration noise, not an editor regression.

- 2026-05-24: completed Chromium CDP IME delete-and-reinsert composition
  coverage.
  - Fresh DeepWiki input: `prosemirror-view` tracks `lastChromeDelete` because
    Chrome can delete and immediately reinsert the active composition while the
    IME session is still open; editor content and selection must not be
    double-applied, lost, or moved to a stale native selection.
  - Material difference from existing coverage: Edytor already covered CDP IME
    commit/cancel and late Firefox-style composition input after
    `compositionend`. This slice covers an active-composition sequence where
    Chromium temporarily clears the composing text, then reinserts the final
    preview before commit.
  - Runtime result: no production patch was needed. The existing composition
    mutation deferral and commit path already satisfy the invariant.
  - Browser coverage: added
    `keeps Chromium CDP IME delete-and-reinsert composition to one commit` to
    `tests/editor-dom/mobile-composition.spec.ts`.
  - Verification:
    `pnpm test:integration tests/editor-dom/mobile-composition.spec.ts -g "delete-and-reinsert" --workers=1`
    passed 1 Chromium CDP test with 1 expected WebKit skip.
  - Verification:
    `pnpm test:integration tests/editor-dom/mobile-composition.spec.ts --workers=1`
    passed 19 tests with 3 expected WebKit skips.
  - Verification: `pnpm test -- --run` passed 268 tests.
  - Verification: `pnpm test:typecheck`, `pnpm check`, `pnpm lint`, and
    `pnpm build` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, clicked the placeholder, typed `One`, toggled
    bold with `Control+B`, typed marked `Bold`, toggled bold off, typed
    `Plain`, split with Enter, typed `Two`, inserted a Shift+Enter soft break,
    typed `Soft`, used Backspace plus undo/redo, and checked console errors.
    Visible blocks stayed coherent as `OneBoldPlain` and `Two\nSof`; the bold
    wrapper stayed scoped to `Bold`, no placeholder/trailing marker remained,
    and console errors stayed empty.

- 2026-05-24: completed reverse-selection restoration throw fallback.
  - Fresh DeepWiki input: `prosemirror-view` explicitly guards browser
    selection restoration because `Selection.extend()` can throw a DOMException
    while writing backward DOM selections.
  - Material difference from existing coverage: Edytor already proved reverse
    selections preserve direction when native selection APIs succeed. This
    slice proves the editor does not crash when those native APIs reject the
    backward restoration.
  - Runtime fix: `EdytorSelection.setAtRange` now tries
    `setBaseAndExtent()`, then `collapse()` + `extend()`, and falls back to a
    normal forward `Range` if the reverse-selection APIs throw.
  - Browser coverage: added
    `falls back when native reverse-selection restoration throws` to
    `tests/editor-dom/selection.spec.ts`.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "reverse-selection restoration" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`
    passed the new case in all three projects and 80 total tests, with 6
    skipped. The run hit the previously-known Firefox triple-click flake.
  - Focused rerun:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "replaces only the clicked block after a browser triple-click selection" --project=firefox --workers=1`
    passed 1 test.
  - Verification: `pnpm test -- --run` passed 268 tests.
  - Verification: `pnpm test:typecheck`, `pnpm check`, `pnpm lint`, and
    `pnpm build` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, clicked the placeholder, typed `One`, toggled
    bold with `Control+B`, typed marked `Bold`, toggled bold off, typed
    `Plain`, used double-space, split with Enter, typed `Two`, inserted a
    Shift+Enter soft break, typed `Soft`, used Backspace plus undo/redo, and
    checked console errors. Visible blocks stayed coherent, the bold wrapper
    stayed scoped to `Bold`, the soft break/delete path produced `Two\nSof`,
    and console errors stayed empty.

- 2026-05-24: completed trailing soft-break marker Backspace coverage.
  - Fresh DeepWiki input: `prosemirror-view` documents Chrome-specific
    Backspace repair at the end of a textblock that ends in a newline and
    treats random browser-inserted trailing `<br>` nodes as DOM-change
    artifacts.
  - Material difference from existing coverage: Edytor already tested
    selection mapping and typing after the trailing soft-break marker. This
    slice proves real Backspace from a native caret inside the marker deletes
    only the trailing model newline and removes the marker.
  - Runtime fix: `onKeyDown` now schedules a structural Backspace fallback when
    the native caret is inside `[data-edytor-trailing-newline]` at the model
    text end. `onBeforeInput` handles that case synchronously, before any async
    checkpoint, so `preventDefault()` happens during event dispatch and the
    browser cannot apply an extra native deletion.
  - Runtime guard: the `beforeinput` hotkey bridge now prevents the original
    `beforeinput` when it routes a structural edit through hotkeys, preserving
    the no-double-mutation contract.
  - Browser coverage: added
    `deletes only the trailing soft break when Backspace starts in the marker`
    to `tests/editor-dom/input.spec.ts`.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "trailing soft break" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts tests/editor-dom/beforeinput-fallback.spec.ts -g "trailing soft break|soft-break|Backspace|deleteContentBackward" --workers=1`
    passed 24 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1`
    passed 132 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run` passed 268 tests.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, clicked the placeholder, typed `One`, toggled
    collapsed bold with `Control+B`, typed marked `Z`, toggled bold off, typed
    plain `Q`, used double-space, split with Enter, typed `C`, ran undo/redo,
    inserted a Shift+Enter soft break, and pressed Backspace. Visible DOM and
    model text stayed coherent; the bold wrapper stayed scoped to `Z`, the
    trailing marker disappeared after Backspace, and console errors stayed
    empty.

- 2026-05-24: hardened Firefox trailing soft-break marker browser setup while
  rechecking the live localhost duplicate-text report.
  - Fresh browser evidence: the focused stale-DOM/mark/auto-dot gate failed
    once in Firefox because the model already contained `lead\n`, but the test
    immediately queried `[data-edytor-trailing-newline]` before Svelte had
    flushed the rendered marker.
  - Runtime result: no production change was needed. The product path passed on
    focused rerun; the test now waits for the marker before moving the native
    caret into it.
  - Browser coverage: hardened both trailing-soft-break marker cases in
    `tests/editor-dom/input.spec.ts`.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "trailing soft-break marker" --workers=1`
    passed 6 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts tests/editor-dom/hotkeys.spec.ts tests/editor-dom/input.spec.ts tests/editor-dom/dom-mutation.spec.ts tests/editor-dom/format-beforeinput.spec.ts --workers=1 -g "duplicate|auto-dot|stale DOM clones|mark|marked|double-space|splits a cleared paragraph|undo"`
    passed 99 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run` passed 268 tests.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: hard-reloaded the
    root route, cleared the editor, focused the placeholder, typed `One`,
    toggled collapsed bold while typing `Two`, toggled bold off, used
    double-space plus Backspace, split with Enter, typed `C`, and ran undo/redo.
    The live DOM had two managed text nodes (`OneTwo ` and `C`), one scoped
    bold mark (`Two`), no placeholders in non-empty blocks, no visible duplicate
    content, and no console warnings/errors.

- 2026-05-24: completed Firefox-style compositionend-before-input duplication
  coverage.
  - Fresh DeepWiki input: Lexical tracks Firefox's event order where
    `compositionend` fires before the final `input`. If composition finalization
    is applied immediately and the later input is trusted, editors can double
    insert the committed text or restore the caret to the wrong offset.
  - Material difference from existing coverage: Edytor already tested a late
    stale `input.insertCompositionText` after `compositionend` where the DOM
    still contained the preview text. This regression covers the Firefox-style
    follow-up input after the browser has already produced duplicated committed
    DOM text (`にに`) and proves Edytor repairs back to the single committed
    value (`に`).
  - Browser coverage: added
    `repairs Firefox-style duplicated committed input after compositionend` to
    `tests/editor-dom/composition.spec.ts`.
  - Runtime result: no production change was needed. The current
    compositionend suppression and suppressed-input repair path already
    satisfies the peer-editor contract.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "Firefox-style duplicated committed input" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts --workers=1`
    passed 78 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run` passed 268 tests.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - Verification: `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, clicked the placeholder, typed `One`, toggled
    bold for `Two`, used double-space plus Backspace, split with Enter, typed a
    second paragraph, inserted a Shift+Enter soft break, used undo/redo, then
    used Tab to nest the second paragraph under the first. Visible DOM stayed
    coherent, the bold wrapper stayed scoped, the soft break remained inside the
    paragraph, nesting moved the block under the previous block, and console
    warnings/errors stayed empty.

- 2026-05-24: live `/` duplicate-text regression report rechecked without a
  runtime patch.
  - Fresh browser evidence: the in-app Browser on `http://localhost:5173/` was
    reloaded, cleared, focused through the empty placeholder, then exercised
    with real typing, collapsed bold insertion, double-space/backspace,
    `Enter`, and undo. The visible paragraph stayed coherent, the text model
    and rendered DOM agreed, stale placeholders did not remain, and browser
    console warnings/errors were empty.
  - Automation limitation: the in-app Browser keypress layer did not produce a
    reliable Shift-selection in this tab, so selected-range mark toggling was
    verified through Playwright instead of being claimed from the in-app
    Browser interaction.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1`
    passed 30 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts tests/editor-dom/hotkeys.spec.ts -g "duplicate|visible|mark|double-click|resurrect|stale|browser DOM mutation" --workers=1`
    passed 36 tests across Chromium, Firefox, and WebKit.
  - Result: no production change was made because the current live route after
    reload and the focused browser regressions did not reproduce the reported
    DOM-only duplication. If the symptom persists in a user-held tab, the most
    likely next variable is stale dev-server/HMR DOM state rather than the
    current loaded runtime.

- 2026-05-24: completed empty-block native selection cleanup coverage.
  - Fresh DeepWiki input: Lexical explicitly works around a Chrome bug where
    selecting the contents of a single empty block leaves a tiny/stuck native
    selection box. ProseMirror has related empty-textblock and uneditable-node
    selection workarounds. The safe editor contract is to clear or remap that
    native range before the next click/edit instead of preserving it as an
    authoritative selection.
  - Material difference from existing coverage: earlier Edytor tests proved
    empty first/middle/last placeholders can receive a caret. This new browser
    regression starts from a browser-created native range over the empty
    placeholder/zero-width text, then uses a real pointer click into a different
    text block and verifies that the next typed character lands in the clicked
    block while the empty block remains empty.
  - Runtime result: no production change was needed. Current placeholder
    selection mapping and pointer click handling already satisfy the peer-editor
    contract.
  - Browser coverage: added
    `clears a native empty-placeholder selection before the next click and edit`
    to `tests/editor-dom/selection.spec.ts`.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "empty-placeholder" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`
    passed 78 tests with 6 expected project skips. The first full-suite attempt
    showed an intermittent Firefox triple-click replacement failure; the focused
    rerun of that case passed across Chromium, Firefox, and WebKit, and the
    second full selection-suite run passed.
  - Verification: `pnpm test -- --run` passed 268 tests.
  - Verification: `pnpm test:dom` passed 90 tests.
  - Verification: `pnpm test:typecheck` and `pnpm check` passed with 0 errors
    and 0 warnings.
  - Verification: `pnpm test:dom:typecheck` passed with 0 errors and 0
    warnings.
  - Verification: `pnpm lint` passed after formatting the new browser spec.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, typed text, toggled bold, split with Enter,
    nested via Tab, used Shift+Enter, Backspace, undo, and redo. Then cleared
    again, clicked the visible placeholder, typed `Click`, moved with
    ArrowLeft, Backspaced, and used undo/redo. Visible text stayed coherent,
    the bold wrapper stayed scoped to the intended text, placeholder text did
    not duplicate, and browser console errors stayed empty.

- 2026-05-24: completed native non-text control isolation and Firefox
  expanded-selection input fallback.
  - Fresh gap: the previous native-control guard covered editable controls, but
    a focused `<button>` inside a void body could still bubble Enter, Space, or
    Backspace into the parent editor. Backspace was especially dangerous
    because browser default navigation could remove the control before the
    model had changed. A separate Firefox regression showed that a
    browser-created triple-click text selection could be followed by an
    `input.insertText` event without a useful `data` payload, causing the new
    character to append instead of replacing the selected block text.
  - Runtime fix: shared native-interactive-control detection now covers
    `input`, `textarea`, `select`, `button`, and `a[href]`. Root
    `beforeinput`/`input` ignore those targets, and document `keydown` ignores
    them unless the editor already owns an explicit selected-block deletion.
    Backspace/Delete on non-text native controls are prevented so browser
    navigation cannot masquerade as an editor command. The input-only expanded
    selection fallback now uses the live DOM/model text diff to infer inserted
    text when Firefox omits `InputEvent.data`.
  - Browser coverage: `tests/editor-dom/features.spec.ts` now proves focused
    native inputs and buttons inside void blocks keep focus, preserve their own
    value or activation behavior, and do not mutate the parent editor. Existing
    selected-block deletion coverage proves the guard does not block real
    editor-owned block deletion.
  - Verification:
    `pnpm test:integration tests/editor-dom/features.spec.ts -g "native buttons inside void|native controls inside void" --workers=1`
    passed 6 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "replaces only the clicked block after a browser triple-click selection" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`
    passed 75 tests, with 6 expected project skips.
  - Verification: `pnpm test:integration --workers=1` passed with 792 tests,
    10 skipped, and 3 WebKit navigation-timeout retries that passed on retry.
  - Verification: `pnpm test -- --run` passed 268 tests.
  - Verification: `pnpm test:dom` passed 90 tests.
  - Verification: `pnpm test:typecheck`, `pnpm test:dom:typecheck`,
    `pnpm check`, and `pnpm lint` passed with 0 errors or warnings.
  - Verification: `pnpm build` completed `vite build`, `svelte-package`, and
    `publint` successfully.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, typed `One`, toggled bold before typing `Bold`,
    toggled bold off, typed ` next`, pressed double Space, split with Enter,
    typed `Two`, then used undo and redo. Visible DOM text stayed singular,
    the bold wrapper wrapped only `Bold`, no prior content was deleted by the
    double-space keypress path, the split produced two coherent paragraph
    blocks, undo/redo restored the expected second paragraph state, and browser
    console errors stayed empty. The in-app high-level text helper still failed
    because the Browser virtual clipboard is unavailable, so live verification
    used keypress-level input.

- 2026-05-24: completed external-control command selection preservation gate.
  - Fresh gap: DeepWiki pointed at toolbar/external-control selection
    preservation as a separate browser boundary from generic blur/refocus.
    Slate filters `selectionchange` noise from external controls and stores the
    user selection around input events. Lexical uses explicit selection updates
    and skip-DOM-selection tags so toolbar-like updates do not steal or corrupt
    the editor selection. ProseMirror restores DOM selection from model state
    across focus changes and stops its DOM observer while applying selection.
    Svedit keeps commands model-driven and re-renders the browser selection from
    the document selection after focus returns.
  - Material difference from existing coverage: earlier tests covered focus
    moving outside the editor, keyboard Tab focus into the editor, and direct
    `edytor.node.focus()`. This new browser gate covers a command run from an
    external button after the editor is no longer the native focus/selection
    target.
  - Added Playwright coverage in `tests/editor-dom/features.spec.ts`: select the
    second paragraph, focus and click an external `Heading 2` button that calls
    `edytor.runCommand('block.heading2')`, then assert the second paragraph is
    converted while the first and empty third paragraph are untouched. Chromium
    and WebKit do not reliably keep the button as final active element once the
    editor restores DOM selection, so the stable contract is command target and
    model selection, not final button focus.
  - Runtime result: no production change was needed; the current selection
    preservation model already satisfies this browser contract.
  - Verification:
    `pnpm test:integration tests/editor-dom/features.spec.ts -g "external control commands" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/features.spec.ts --workers=1`
    passed 24 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run` passed 268 tests.
  - Verification: `pnpm test:dom:typecheck`, `pnpm test:typecheck`,
    `pnpm check`, and `pnpm lint` passed with 0 errors.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, clicked the empty paragraph, typed `One`,
    toggled bold before typing `Two`, toggled bold off, used Space, Backspace,
    undo, redo, Enter, Shift+Enter, and Tab. Visible text stayed singular, the
    bold wrapper wrapped only `Two`, structural keys left coherent block/text
    wrappers, and browser console errors stayed empty.

- 2026-05-24: completed native-control isolation inside void blocks.
  - Fresh gap: DeepWiki pointed at Slate/Lexical focus and embedded-control
    guards around void/decorator content. Existing Edytor coverage proved image
    caption editability and void-body selection, but not that a native `<input>`
    inside a void block could receive typing, Backspace, and Enter without the
    outer editor consuming those bubbled events through stale cached selection.
  - DeepWiki findings: Slate ignores selectionchange/input interactions from
    `<input>`/`<textarea>` and special-cases focus/blur moving between the
    editor and editable void internals. Lexical checks whether event targets
    are inside decorator/native-control surfaces and avoids routing those
    events through the parent editor command pipeline. ProseMirror has
    non-editable-node selection workarounds that reinforce the same boundary:
    native or non-editable embedded surfaces must not corrupt editor selection.
  - Failing command before runtime patch:
    `pnpm test:integration tests/editor-dom/features.spec.ts -g "native controls inside void" --workers=1`
    failed in Chromium and WebKit because pressing Enter in the nested input
    moved focus back to the editor via the structural-key fallback.
  - Runtime fix: document-level `onKeyDown`, root `onBeforeInput`, and root
    `onInput` now ignore events whose live target is a native editable control
    (`input` or `textarea`). The guard is DOM-safe for model tests where
    `HTMLInputElement` is undefined.
  - Verification:
    `pnpm test:integration tests/editor-dom/features.spec.ts -g "native controls inside void" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/features.spec.ts --workers=1`
    passed 21 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "void|focus|programmatically focusing|focus moves outside" --workers=1`
    passed 24 tests across Chromium, Firefox, and WebKit. A first attempted
    run of that selection filter was invalid because it ran in parallel with
    another Playwright command and the shared preview server disappeared during
    WebKit; the sequential rerun passed.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts --workers=1`
    passed 60 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run` passed 268 tests.
  - Verification: `pnpm test:typecheck`, `pnpm test:dom:typecheck`,
    `pnpm check`, and `pnpm lint` passed with 0 errors.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, clicked the empty paragraph, typed `ONE`,
    toggled bold before typing `TWO`, used Backspace, undo, redo, and Tab, then
    inspected the managed text wrappers and browser console errors. Visible
    text remained singular and no console errors were emitted.

- 2026-05-24: completed empty-inputType browser-owned deletion history
  restoration.
  - Fresh gap: peer-editor research flagged delete paths as part of the same
    browser-owned reconciliation family as replacement/autocorrect. A
    non-cancelable `beforeinput.deleteContentBackward` can be followed by an
    `input` event whose `inputType` is empty or unavailable after native DOM
    selection has already jumped elsewhere.
  - DeepWiki findings: Slate/Svedit preserve event-time selection and then
    reconcile the browser DOM diff; Lexical and ProseMirror do not rely on a
    strict follow-up input type for browser-owned DOM changes. Edytor's
    contract is that deletion ownership comes from the beforeinput snapshot
    when the follow-up input event is less specific.
  - Failing command before runtime patch:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "empty follow-up inputType" --workers=1`
    failed across Chromium, Firefox, and WebKit because undo restored content
    but left the caret at the post-delete offset `4` instead of the restored
    pre-delete offset `5`.
  - Runtime fix: `browserOwnedInputTarget` now stores an optional
    `historyOffset` for browser-owned deletions. `onInput` treats a pending
    target as deletion when either the follow-up input event or the original
    beforeinput snapshot is delete-shaped, stops history capture accordingly,
    stores the pre-delete history caret, and still restores the live caret to
    the post-delete offset after reconciliation.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "empty follow-up inputType" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1` passed
    129 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run` passed 268 tests.
  - Verification: `pnpm test:typecheck`, `pnpm test:dom:typecheck`,
    `pnpm check`, and `pnpm lint` passed with 0 errors.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    editor, clicked the editable paragraph, typed `ONE`, toggled bold before
    typing `TWO`, typed more text, used Backspace, undo, redo, and Tab, then
    inspected managed text wrappers and browser console errors. Visible text
    remained singular with no stale DOM duplication and no console errors. The
    in-app key-injection path still did not produce a useful paragraph-split
    Enter event; the real browser Enter path is covered by the green
    Playwright `input.spec.ts` suite above.

- 2026-05-24: completed empty-inputType replacement follow-up coverage.
  - Fresh gap: DeepWiki flagged the same autocorrect/spellcheck family as
    capable of delivering less-specific or empty follow-up `input.inputType`
    values after `beforeinput.insertReplacementText`. The previous slice
    covered `input.insertText`; this locks the empty/unavailable inputType edge
    explicitly.
  - DeepWiki findings: Lexical does not rely on strict event-type equality for
    text-change reconciliation, and Slate/Svedit reconcile browser-owned text
    through pending selection plus DOM diff state. The Edytor contract is that
    an empty follow-up inputType is compatible with a pending browser-owned text
    target.
  - Runtime result: no production patch was needed. The compatible input-type
    logic already accepts empty inputType as a pending text reconciliation
    follow-up.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "follow-up inputType is empty" --workers=1`
    passed 3 tests.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1` passed
    126 tests.
  - Verification: `pnpm test:typecheck`, `pnpm check`, and `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, typed `one`, toggled bold before typing `two`,
    split to a second paragraph, typed `next`, used Backspace, undo, redo, and
    Tab, then confirmed visible managed text was not duplicated, no literal tab
    was inserted into paragraph text, and no browser console warnings/errors
    were emitted.

- 2026-05-24: completed replacement/input inputType mismatch reconciliation.
  - Fresh gap: `browserOwnedInputTarget` rejected the pending target when the
    follow-up `input.inputType` differed from the original
    `beforeinput.inputType`. A browser-owned autocorrect path like
    `beforeinput.insertReplacementText` followed by `input.insertText` could
    reconcile visible text but leave selection on a browser-jumped neighboring
    block.
  - DeepWiki findings: Lexical has event coverage for replacement beforeinput
    followed by text input and treats text insertion events as potentially
    user-authored changes rather than requiring strict type equality. Slate and
    Svedit reconcile browser-owned text through pending selection/DOM diff
    state. Edytor should accept compatible text input follow-ups for the same
    pending browser-owned text target.
  - Failing command before runtime patch:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "follow-up input reports insertText" --workers=1`
    failed across Chromium, Firefox, and WebKit because selection stayed on
    block `[1]` offset `2` instead of returning to block `[0]` offset `5`.
  - Runtime fix: `onInput` now accepts pending browser-owned text targets when
    both the beforeinput and input types are text-compatible
    (`insertText`/`insertReplacementText`), while keeping non-text and delete
    reconciliation type-specific.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "follow-up input reports insertText" --workers=1`
    passed 3 tests.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1` passed
    123 tests.
  - Verification: `pnpm test:typecheck`, `pnpm check`, and `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, typed `one`, toggled bold before typing `two`,
    split to a second paragraph, typed `next`, used Backspace, undo, redo, and
    Tab, then confirmed visible managed text was not duplicated, no literal tab
    was inserted into paragraph text, and no browser console warnings/errors
    were emitted.

- 2026-05-24: completed collapsed native replacement target retention.
  - Fresh gap: collapsed `insertReplacementText` was allowed to stay
    browser-owned, but it did not store the beforeinput-time text target like
    safe `insertText` did. If native selection moved to the next block before
    the follow-up `input`, Edytor could reconcile the text while leaving the
    caret on the wrong block.
  - DeepWiki findings: Lexical model-owns unsafe `insertReplacementText` and
    stores unprocessed beforeinput data for later input reconciliation; Slate
    and Svedit reconcile browser-owned text diffs against event-time/pending
    input state. The shared lesson is to keep event-time ownership for
    replacement input, not trust the later native selection blindly.
  - Failing command before runtime patch:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "collapsed native replacement" --workers=1`
    failed across Chromium, Firefox, and WebKit because selection remained on
    block `[1]` offset `2` instead of returning to block `[0]` offset `5`.
  - Runtime fix: `browserOwnedInputTarget` now records the text value before
    native input, collapsed replacement events store that target, and `onInput`
    infers the final caret from the before/after text diff when the native DOM
    selection no longer points at the edited text.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "collapsed native replacement" --workers=1`
    passed 3 tests.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1` passed
    120 tests.
  - Verification: `pnpm test:typecheck`, `pnpm check`, and `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, typed `one`, toggled bold before typing `two`,
    split to a second paragraph, typed `next`, used Backspace, undo, redo, and
    Tab, then confirmed visible managed text was not duplicated, no literal tab
    was inserted into paragraph text, and no browser console warnings/errors
    were emitted.

- 2026-05-24: completed `beforeinput.insertText` tab payload routing.
  - Fresh gap: physical Tab key behavior was covered, but browser/tool-created
    `beforeinput` text payloads containing `\t` were treated as ordinary text.
    In paragraphs that produced `n\tote` instead of using Edytor's block-level
    Tab semantics.
  - DeepWiki findings: Svedit blocks structural whitespace text payloads in
    normal rich text to avoid browser writing tools mutating the document
    structure; Lexical models tab as an explicit editor command/node; Slate has
    tab-specific guards for preformatted native events. Edytor's policy is:
    normal paragraph tab routes through semantic Tab nesting, and code-line tab
    routes through the existing code plugin tab insertion behavior.
  - Failing command before runtime patch:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "tab payload" --workers=1`
    failed in Chromium, Firefox, and WebKit because paragraph content became
    `n\tote`.
  - Runtime fix: `onBeforeInput` now detects `insertText` payload `\t`, keeps
    it out of the browser-owned non-cancelable text-local path, and dispatches
    the existing semantic Tab hotkey from the model-owned insert command path.
  - Added browser coverage proving paragraph tab payloads nest the current
    block and code-line tab payloads insert a literal tab in the code text.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "tab payload" --workers=1`
    passed 6 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1` passed
    117 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts -g "tab|code suggestions" --workers=1`
    passed 18 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` and `pnpm lint` passed after formatting
    the touched files.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, clicked the editable paragraph by browser
    coordinates, typed `one`, toggled bold around `two`, inserted two spaces,
    Backspace, undo, redo, and pressed physical Tab. The rendered text remained
    `onetwo  ` with one managed text wrapper, one bold mark wrapper around
    `two`, no placeholder clone, no literal tab insertion, and no console
    warnings/errors. The in-app browser evaluation sandbox could not construct
    synthetic `beforeinput` events, so the new payload-specific behavior is
    proven by the Playwright browser regression above.

- 2026-05-24: completed active-composition Arrow/Escape candidate-navigation
  guard coverage and rechecked the live root route.
  - Fresh gap: active-composition coverage already locked editor hotkeys and
    structural keys, but not Arrow/Escape keys that IME and accent candidate
    UIs commonly own.
  - DeepWiki findings: Slate, Lexical, and Svedit return early from editor
    keydown handling while composing, while ProseMirror keeps composition-near
    key handling guarded with browser-specific candidate UI quirks in mind.
  - Added Chromium/Firefox/WebKit coverage that dispatches composing
    ArrowLeft, ArrowRight, ArrowUp, ArrowDown, and Escape in the same
    active-composition keydown regression. The events are not prevented, no
    editor command/navigation runs, and the preview caret remains stable before
    `compositionend`.
  - Runtime result: no production patch was needed. Existing
    `shouldIgnoreCompositionKeyDown` already suppresses editor command handling
    while `isComposing` or `event.isComposing` is true.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition-cancellation.spec.ts --workers=1`
    passed 24 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1`
    passed 30 tests across Chromium, Firefox, and WebKit, including the root
    route regressions for clear-and-type, default marked typing, mark toggle
    duplication, auto-dot payload preservation, marked undo/delete, Enter
    split/undo, and split history grouping.
  - Verification: `pnpm test:typecheck` and `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: used the live root
    route controls, cleared the editor, clicked the editable paragraph by
    browser coordinates, typed `one`, toggled bold around `two`, inserted two
    spaces, typed more text, checked undo/redo and Tab, and inspected rendered
    text wrappers plus console warnings/errors. Visible DOM stayed coherent:
    one managed text wrapper, `two` wrapped once in bold, no stale placeholder
    clone, and no console warnings or errors. The in-app key channel did not
    emit a paragraph-splitting Enter event; the real Playwright demo-route
    suite above covers that browser key path directly.

- 2026-05-24: completed explicit dead-key keydown hotkey guard coverage.
  - Fresh gap: the tracker said `AltGraph/dead-key`, and runtime had a
    `KeyboardEvent.key === 'Dead'` guard, but the browser regression only
    dispatched an AltGraph-shaped printable keydown. The literal dead-key path
    was not directly locked.
  - DeepWiki findings: Slate, ProseMirror, Lexical, and Svedit all keep
    dead-key/accent composition input out of editor key command handling,
    usually by returning early during composition or by letting the later
    composition/beforeinput/input path own text insertion.
  - Added a test-only `mod+alt+dead` hotkey on `/test/dom`, then added browser
    coverage proving a `key: "Dead"` keydown does not fire that hotkey and the
    following `beforeinput.insertText` inserts `é` with the caret after it.
  - Runtime result: no production patch was needed. Existing `HotKeys.isHotkey`
    guard already ignores dead-key keydowns.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts -g "dead-key" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts --workers=1`
    passed 60 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` and `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, typed `One`, toggled bold, typed `Two`, split,
    typed `Three`, inserted a soft break, typed `Soft`, checked Backspace,
    undo, redo, and Tab nesting. The visible editor stayed coherent with one
    managed text wrapper per model text, one bold mark wrapping only `Two`, no
    placeholder clone, and no console warnings or errors.

- 2026-05-24: completed outside-to-inside partial native selection guard.
  - DeepWiki findings: Slate, Lexical, ProseMirror, and Svedit all keep
    selection updates editor-owned by requiring native selection endpoints to
    map inside the editor root, or by preserving the previous valid editor
    selection when a boundary-crossing DOM selection cannot be safely mapped.
  - Material difference from existing coverage: Edytor already ignored native
    ranges that start inside the editor and end outside it; this slice locks
    the reverse browser shape where the anchor starts in external DOM and the
    focus lands inside the contenteditable root.
  - Runtime result: no production patch was needed. Current selection mapping
    already ignores the reverse partial range without corrupting the cached
    model selection.
  - Added browser coverage in `tests/editor-dom/selection.spec.ts`. Chromium
    and Firefox exercise the reverse boundary-crossing range; WebKit is
    explicitly skipped because it normalizes this synthetic range back inside
    contenteditable.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "outside-to-inside" --workers=1`
    passed 2 tests with 1 expected WebKit quirk skip.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`
    passed 75 tests with 6 expected skips.
  - Verification: `pnpm test:typecheck` and `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, typed `One`, toggled bold, typed `Two`, split,
    typed `Three`, inserted a soft break, typed `Soft`, checked Backspace,
    undo, redo, and Tab nesting. The visible editor stayed coherent with one
    managed text wrapper per model text, one bold mark wrapping only `Two`, no
    placeholder clone, and no console warnings or errors.

- 2026-05-24: re-audited the active localhost tab after the user pointed back
  to `http://localhost:5173/`.
  - Runtime result: no production patch was made. The current in-app Browser
    tab did not reproduce visible DOM duplication after a hard reload and
    direct root-route editing.
  - In-app Browser verification: cleared the editor, clicked the editable
    surface, typed `One`, toggled bold, typed `Two`, toggled bold off, pressed
    `Enter`, typed `Beta`, ran undo/redo, then typed two spaces. The live DOM
    had two blocks, one managed text wrapper per block, one bold mark wrapping
    only `Two`, no placeholder clone, and no console warnings or errors.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts tests/editor-dom/hotkeys.spec.ts tests/editor-dom/input.spec.ts tests/editor-dom/dom-mutation.spec.ts --workers=1 -g "duplicate|auto-dot|stale DOM clones|does not delete preceding|Svelte-owned text remount|splits a cleared paragraph|undoing a deletion"`
    passed 24 tests across Chromium, Firefox, and WebKit.

- 2026-05-24: completed AltGraph printable keydown hotkey guard.
  - Materially new gap: existing composition tests ignored hotkeys while
    `isComposing`, but no browser regression proved that AltGraph-style
    printable keydown (`Ctrl+Alt` plus `getModifierState('AltGraph')`) does not
    run `mod+alt` hotkeys before the following text insertion.
  - DeepWiki findings: Slate, ProseMirror, and Lexical all prioritize
    composition/dead-key/AltGraph text input over command hotkeys. Their
    recommended regression shape is AltGraph/Ctrl+Alt printable input that
    inserts text and does not trigger formatting, undo, or structural commands.
  - Proven gap before runtime patch:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts -g "AltGraph" --workers=1`
    failed in Chromium, Firefox, and WebKit because the synthetic AltGraph
    keydown was treated as `mod+alt+b` and prevented.
  - Runtime fix: `HotKeys.isHotkey` now ignores `AltGraph`, `Dead`, and events
    where `getModifierState('AltGraph')` is true, leaving the following
    `beforeinput.insertText` path to insert the printable character normally.
  - Added browser coverage in `tests/editor-dom/hotkeys.spec.ts` using a
    test-only `mod+alt+b` hotkey on `/test/dom`; the AltGraph-shaped keydown
    must not fire the hotkey, and the following `insertText` payload must
    produce exactly `β`.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts -g "AltGraph" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts --workers=1`
    passed 57 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm check`, `pnpm test:typecheck`,
    `pnpm test:dom:typecheck`, `pnpm test -- --run`, and `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, typed `Alpha`, toggled a bold character, split
    with `Meta+Enter`, typed `Beta`, inserted a `Shift+Enter` soft break, typed
    `Soft`, then checked Backspace, undo, redo, and Tab nesting. Visible text
    stayed coherent for the nested block structure and emitted no console
    errors.

- 2026-05-24: completed typing after trailing soft-break marker coverage.
  - Materially new gap: existing coverage proved Shift+Enter soft-break
    insertion and mapped native selection inside the trailing marker to the text
    end, but did not prove the next text input used that mapped model offset.
  - DeepWiki findings: ProseMirror keeps trailing break/hack nodes as
    browser-only cursor affordances and works around Firefox/Safari cursor
    positions around `<br>` or uneditable trailing nodes. Svedit maps rendered
    newline `<br>` markers back to model text length and recommends
    typing-after-newline tests. Lexical represents soft breaks in the model and
    tests insertion around line-break boundaries.
  - Added browser coverage in `tests/editor-dom/input.spec.ts` that inserts a
    soft break, forces the native caret inside the trailing marker, types `x`,
    and asserts the model text becomes `lead\nx`, the trailing marker is gone,
    and the caret is restored after the inserted character.
  - Runtime result: no production patch was needed. Current selection mapping
    and input routing already handled the marker boundary correctly.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "trailing soft-break marker" --workers=1`
    passed 6 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1`
    passed 111 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test:typecheck` passed with 0 errors and 0 warnings.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, typed `Soft`, pressed `Shift+Enter`, typed `x`,
    toggled bold for a following character, then checked Backspace, undo, and
    redo. The visible paragraph remained one model text with `Soft\nx`/`Soft\nxB`
    as expected and emitted no console errors.

- 2026-05-24: completed live localhost duplication audit requested after the
  regression report.
  - Runtime result: no production patch was made. The current root route did
    not reproduce the reported visible DOM duplication after a live in-app
    Browser reload and direct interaction with `http://localhost:5173/`.
  - In-app Browser verification: cleared the editor, typed `One`, toggled bold
    on/off around inserted marked text, selected the full text range and toggled
    bold on/off, cleared again, typed `hello  `, then pressed Backspace. The
    rendered paragraph text and the managed `[data-edytor-text]` node stayed
    singular; no page console errors were emitted.
  - In-app Browser note: this automation surface still did not emit a useful
    Enter split from its direct key injection path in this tab. The real
    browser Enter behavior remains covered by the Playwright browser lane.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts tests/editor-dom/hotkeys.spec.ts tests/editor-dom/format-beforeinput.spec.ts tests/editor-dom/dom-mutation.spec.ts --workers=1 -g "stale visible DOM clones|duplicate visible text|stale DOM clones|auto-dot|does not delete existing demo-route text|does not resurrect marked text|splits a cleared paragraph|coalesce typing after a paragraph split|placeholder after undoing text"`
    passed 27 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts tests/editor-dom/input.spec.ts --workers=1 -g "splits a cleared paragraph|real browser enter key|paragraph in the middle|soft break with the real browser key"`
    passed 9 tests across Chromium, Firefox, and WebKit.

- 2026-05-24: completed Playwright all-project preview-server stability and
  selected-block pointer resilience follow-up.
  - DeepWiki findings refreshed for this slice: Lexical, ProseMirror, and Slate
    all treat the editor model selection as the source of truth. Native
    `selectionchange` is useful when it maps cleanly inside the editor, but
    pointer/key events that leave stale node or block selection require an
    editor-owned transition back to a model caret.
  - Runtime fix: Playwright's web server now runs `pnpm build:app` before
    `pnpm preview`, keeping package emission out of browser startup. This
    removes the prior full-suite preview-server cascade caused by running the
    package build during integration startup.
  - Runtime fix: pointerdown inside editable text while model blocks are
    selected now collapses selected-block state to the clicked text point
    through `setAtTextOffset`. This keeps Chromium full-suite runs from
    preserving stale block selection when native `selectionchange` is absent or
    delayed.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "clicking inside selected block content clears block selection to a caret" --project=chromium --workers=1`
    passed 1 Chromium test.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`
    passed 73 tests with 5 explicit browser/capability skips.
  - Verification: `pnpm test:integration --workers=1` passed 757 tests with 9
    explicit skips; no preview-server disconnect cascade and no selected-block
    failure remained.
  - Verification: `pnpm test -- --run` passed 268 tests and `pnpm test:dom`
    passed 90 tests.
  - Verification: `pnpm test:typecheck`, `pnpm test:dom:typecheck`,
    `pnpm check`, `pnpm lint`, and `pnpm build` passed with 0 errors.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, typed `one`, toggled bold with `Meta+B`, cleared
    again, typed `hello  `, checked Backspace, undo, and redo. Visible editor
    text stayed singular (`one`/`hello`) and no page console errors were
    emitted. Browser-key injection in this tab still did not emit a usable
    Enter split; that path is covered by the Playwright browser lane above.

- 2026-05-24: completed pointer click inside already selected block content.
  - DeepWiki findings: ProseMirror documents a Safari workaround where clicking
    inside an already selected element does not reliably place the cursor
    there. Lexical treats clicks after node/decorator selection as
    editor-owned selection transitions, especially for selected decorator/node
    content and touch-like input. The model-first invariant is that pointer
    interaction inside editable text must clear node/block selection and create
    a valid collapsed text caret.
  - Added browser coverage that selects the second paragraph as a model block
    selection using `mod+a`, then performs a real pointer click inside that
    selected block's editable text and asserts selected-block state is cleared
    and the model selection is collapsed inside the clicked block.
  - Runtime result: no production patch was needed. Current selection mapping
    already honors the pointer-created caret over stale selected-block state.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "clicking inside selected block" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`
    passed 73 tests with 5 explicit browser/capability skips.
  - Verification: `pnpm test -- --run` passed 268 tests,
    `pnpm test:dom` passed 90 tests, and `pnpm test:typecheck`,
    `pnpm test:dom:typecheck`, `pnpm check`, and `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    route, typed `One`, toggled bold with `Meta+B`, cleared again, typed `Two`,
    inserted a `Shift+Enter` soft break, typed `Br`, checked Backspace,
    undo/redo, and Tab. The visible editor stayed coherent with one live text
    wrapper for the edited paragraph and emitted no console errors.

- 2026-05-24: completed Android Backspace misreported as
  `beforeinput.insertParagraph`.
  - DeepWiki findings: ProseMirror documents Android/SwiftKey issues where
    Backspace is interpreted as Enter, and where Backspace joins around image
    or uneditable content can run Enter-like handling. ProseMirror handles this
    class through delayed DOM-change interpretation plus keydown/model intent
    heuristics. Lexical and Slate likewise treat Android `beforeinput`/`input`
    as a reconciled model boundary rather than a fully trustworthy source.
  - Added mobile browser coverage that places the caret at the start of the
    second paragraph, dispatches Backspace keydown, then dispatches a
    non-cancelable `beforeinput.insertParagraph` plus browser-created paragraph
    DOM drift. The invariant is backward merge to `leadnote`, native paragraph
    drift removed, and caret restored at the merge boundary.
  - Runtime result: no production patch was needed. The current
    keydown-time structural fallback normalization already preserves Backspace
    intent over the later Enter-shaped `beforeinput`.
  - Verification:
    `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts -g "misreported as insertParagraph" --workers=1`
    passed 2 tests across mobile Chromium and mobile WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts -g "misreported|block merge|non-cancelable enter|soft break" --workers=1`
    passed 14 tests across mobile Chromium and mobile WebKit.
  - Verification: `pnpm test -- --run` passed 268 tests,
    `pnpm test:dom` passed 90 tests, and `pnpm test:typecheck`,
    `pnpm test:dom:typecheck`, `pnpm check`, and `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    route, typed `One`, toggled bold with `Meta+B`, cleared again, typed `Two`,
    inserted a `Shift+Enter` soft break, typed `Br`, checked Backspace,
    undo/redo, and Tab. The visible editor stayed at one live text wrapper for
    the edited paragraph and emitted no console errors.

- 2026-05-24: completed Shift+ArrowDown selection across a void/image block.
  - DeepWiki findings: ProseMirror has Safari/WebKit-specific workarounds for
    Shift+Down before uneditable content and normalizes ignored/uneditable DOM
    nodes; Lexical routes vertical movement around decorator blocks through
    editor-owned commands. The invariant for Edytor is that selection may
    extend to an atomic void block or a safe editable target, but must not stay
    trapped on the original caret or inside the non-editable body.
  - Proven gap before runtime patch:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "Shift\\+ArrowDown" --workers=1`
    failed in Chromium because the native selection stayed collapsed before
    the image-like void block.
  - Runtime fix: `hotkeys.ts` now promotes collapsed Shift+ArrowDown at the end
    of text before a void block into editor-owned block selection.
  - While rerunning the browser selection matrix, Firefox exposed a separate
    triple-click replacement gap where typing after a browser-created block
    selection appended text (`First blockX`) instead of replacing the selected
    block text. `onInput.ts` now handles actual text insertion over an expanded
    model selection through the shared model replacement path, and avoids the
    extra async checkpoint for non-data input events that caused marked DOM
    reconciliation to duplicate text in mounted tests.
  - Live Browser verification then exposed a real Shift+Enter product bug:
    clean `Shift+Enter` in a paragraph created a second block. `onBeforeInput`
    now preserves the keydown-time structural fallback long enough to normalize
    the browser's follow-up `beforeinput` to `insertLineBreak`.
  - Added browser coverage for Shift+ArrowDown across a void body, Firefox
    triple-click replacement, and real-browser Shift+Enter soft break.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "browser-owned|replacement|cross-block|typing|insertText|Shift\\+Enter as a soft break" --workers=1`
    passed 36 tests across Chromium, Firefox, and WebKit.
  - Verification after the final target-range typing fix:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "uses beforeinput target ranges|cross-block replacement|Shift\\+Enter as a soft break" --workers=1`
    passed 9 tests across Chromium, Firefox, and WebKit.
  - Verification after the final target-range typing fix:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "Shift\\+ArrowDown|replaces only the clicked block" --workers=1`
    passed 6 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`
    passed 70 tests with 5 explicit browser/capability skips.
  - Verification: `pnpm test:dom` passed 90 mounted DOM tests, and
    `pnpm test -- --run` passed 268 model/unit tests.
  - Verification: `pnpm test:typecheck`, `pnpm test:dom:typecheck`,
    `pnpm check`, `pnpm lint`, and `pnpm build` passed.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    route, typed `One`, toggled bold with `Meta+B`, verified one visible text
    wrapper and no duplicate DOM text, cleared again, typed `Two`,
    pressed `Shift+Enter`, typed `Br`, verified one block and one text wrapper,
    then checked Backspace, undo, redo, and console errors. No console errors
    were emitted.

- 2026-05-24: completed active composition interrupted by forward delete.
  - DeepWiki findings: Slate defers forward/backward composition deletion via
    its Android input manager, Lexical suppresses keydown interference while
    composing but routes `deleteContentForward` semantically when it arrives,
    and ProseMirror reconciles composition deletion through DOM-change parsing.
  - Added browser coverage that starts an IME preview in the first paragraph,
    sends `deleteContentForward` while composing at the following block
    boundary, then commits the composition and asserts the next block was not
    merged into the preview.
  - Proven gap before runtime patch:
    `pnpm test:integration tests/editor-dom/composition-cancellation.spec.ts -g "deleteContentForward" --workers=1`
    failed across Chromium, Firefox, and WebKit with `かnote` instead of `か`.
  - Runtime fix: `onBeforeInput.ts` now treats forward delete inside the active
    composition preview as composition-owned, restores the caret inside the
    preview, and avoids routing the event into structural forward-merge logic.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition-cancellation.spec.ts -g "deleteContentForward" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition-cancellation.spec.ts --workers=1`
    passed 24 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts --workers=1`
    passed 72 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run`, `pnpm test:typecheck`,
    `pnpm test:dom:typecheck`, `pnpm check`, and `pnpm lint` passed during the
    slice. After live browser verification, the focused regression and
    `pnpm lint` were rerun and passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, clicked the empty placeholder, typed `One` using
    direct key events, ran Backspace plus undo/redo, toggled bold on the
    selected text, and confirmed the visible DOM had one block, one live text
    wrapper, no duplicated text, and no console errors. The Browser text helper
    hit its virtual-clipboard limitation, so printable typing was verified via
    direct browser key events instead.

- 2026-05-24: completed composition from a rendered mark-wrapper boundary.
  - DeepWiki findings: ProseMirror has a Firefox mark-inheritance workaround
    for composition that starts after but outside a marked node. Slate and
    Lexical similarly treat composition start selection and formatting context
    as editor-owned state rather than trusting browser wrapper boundaries.
  - Added browser coverage that places a DOM element-node caret immediately
    after the first rendered mark wrapper in `/test/dom?scenario=marks`, starts
    an IME composition, and asserts the inserted character remains in the bold
    mark segment with the caret after the committed composition text.
  - Runtime result: no production patch was needed. Existing selection mapping
    and composition insertion already preserved the left mark context.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "mark-wrapper boundary" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts --workers=1`
    passed 72 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run`, `pnpm test:typecheck`,
    `pnpm test:dom:typecheck`, `pnpm check`, and `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, clicked the empty placeholder, typed `One`,
    ran Backspace plus undo/redo, and confirmed the visible DOM had one live
    text wrapper, no stale placeholder, no duplicated text, and no console
    errors. The Browser key helper still does not reliably synthesize Enter or
    modifier-selection in this environment; mark/split/break regressions for
    this slice are covered by the Playwright browser gates above.

- 2026-05-24: completed ShadowRoot backward-selection direction mapping.
  - DeepWiki findings: Slate, Lexical, and ProseMirror treat anchor/focus
    direction as semantic editor state rather than relying on an ordinal DOM
    `Range`. Lexical explicitly stores anchor/focus and swaps points when the
    native DOM direction differs; ProseMirror uses inverted DOM selection
    restoration through `Selection.extend` when possible.
  - Added browser coverage that moves Edytor into a ShadowRoot, exposes a
    native-like backward shadow selection where anchor/focus are reversed, and
    asserts Edytor preserves the logical range plus `isReversed: true`.
  - Test-harness fix: `readNativeSelectionDirection` now reads from the editor's
    ShadowRoot when the editor has been moved out of `document`, instead of
    reading a stale global selection.
  - Runtime result: no production patch was needed. Existing selection mapping
    already computed direction from anchor/focus node order once the correct
    shadow selection was supplied.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "backward ShadowRoot" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`
    passed 67 tests with 5 explicit browser/capability skips.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "duplicate|auto-dot|split|undo" --workers=1`
    passed 18 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run`, `pnpm test:typecheck`,
    `pnpm test:dom:typecheck`, `pnpm check`, and `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, clicked the empty placeholder, typed text,
    backspaced, undid/redid, and confirmed the visible DOM had one live text
    wrapper, no placeholders, no duplicated text, and no console errors. The
    Browser key helper did not reliably generate Enter or modifier-selection
    interactions in this environment, so paragraph split and mark-toggle
    regressions were verified through the Playwright demo-route gates above.

- 2026-05-24: completed ShadowRoot `Selection.isCollapsed` false-positive
  handling.
  - DeepWiki findings: Slate works around Chrome ShadowRoot selections where
    `Selection.isCollapsed` can be `true` for expanded ranges by comparing
    anchor/focus node and offset. Lexical and ProseMirror use their own
    collapsed-selection checks rather than native `isCollapsed` alone; Svedit
    similarly treats DOM selection mapping as an explicit model boundary.
  - Proven gap before the runtime patch:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "buggy ShadowRoot" --workers=1`
    failed in Chromium, Firefox, and WebKit. Edytor mapped a synthetic
    ShadowRoot range from offset `2` to `6` as collapsed at offset `2`.
  - Runtime fix: `createDomSelectionSnapshot` now computes collapsed state by
    comparing `anchorNode === focusNode` and `anchorOffset === focusOffset`
    instead of trusting `selection.isCollapsed`.
  - Added browser coverage that moves Edytor into a ShadowRoot, exposes a
    native-like shadow selection with different anchor/focus points but
    `isCollapsed: true`, and asserts Edytor preserves the expanded model
    selection.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "buggy ShadowRoot" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`
    passed 64 tests with 5 explicit browser/capability skips.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts tests/editor-dom/composition.spec.ts -g "shadow-root|ShadowRoot" --workers=1`
    passed 6 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run`, `pnpm test:typecheck`,
    `pnpm test:dom:typecheck`, `pnpm check`, and `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, typed `One`, toggled bold around `Two`,
    backspaced, undid/redid, split with Enter, typed `Next`, inserted a soft
    break, typed/deleted `Soft`, undid/redid, pressed Tab, and confirmed the
    managed text wrappers stayed `OneTwo`, `Next`, and `Sof` with no
    placeholders or console errors.

- 2026-05-24: completed bogus inline-atomic `<br>` drift coverage.
  - DeepWiki findings: ProseMirror explicitly repairs bogus browser `<br>`
    insertions around widgets/inline-flex/uneditable inline nodes through its
    DOM-observer path. Slate and Lexical treat decorator/void/inline atomic
    boundaries as semantic editor boundaries. Svedit keeps structural browser
    mutations out of the model and reconciles DOM drift back to editor state.
  - Added browser coverage that inserts unmanaged `<br>` nodes immediately
    before and after an inline mention atom in `/test/dom?scenario=inline`.
    The tests assert the bogus nodes are removed, model content is unchanged,
    the inline mention remains atomic, and the caret stays on the live text
    boundary.
  - Runtime result: no production patch was needed. Existing DOM mutation
    repair already removes unmanaged line breaks outside model-owned content.
  - Verification:
    `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts -g "bogus browser line breaks" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts --workers=1`
    passed 24 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run`, `pnpm test:typecheck`,
    `pnpm test:dom:typecheck`, and `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, typed `One`, toggled bold around `Two`,
    backspaced, undid/redid, split with Enter, typed `Next`, inserted a soft
    break, typed/deleted `Soft`, undid/redid, pressed Tab, and confirmed the
    managed text wrappers stayed `OneTwo`, `Next`, and `Sof` with no
    placeholders or console errors.

- 2026-05-24: completed partial-outside native selection containment.
  - DeepWiki findings: Slate, Lexical, ProseMirror, and Svedit all require a
    native selection to be fully mappable to the editor before updating internal
    selection state. Partial external ranges are ignored, deselected, or fail
    DOM-to-model mapping rather than becoming model selections.
  - Proven gap before the runtime patch: a native range starting in Edytor and
    ending in external DOM rewrote cached selection in Chromium/Firefox to
    `{ startBlockPath: [0], endBlockPath: null, yStart: 2, yEnd: 8 }`; WebKit
    normalized the synthetic range back into the editor, so it cannot exercise
    the same condition and is explicitly skipped.
  - Runtime fix: `EdytorSelection.applySelectionSnapshot` now requires both
    `anchorNode` and `focusNode` to be inside the editor container before
    applying a DOM selection snapshot.
  - Added browser coverage proving the previous editor selection remains stable
    when the native selection only partially belongs to Edytor.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "partially belong" --workers=1`
    passed 2 tests with 1 explicit WebKit quirk skip.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`
    passed 61 tests with 5 explicit browser/capability skips.
  - Verification: `pnpm test -- --run`, `pnpm test:typecheck`,
    `pnpm test:dom:typecheck`, and `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    route, typed `One`, toggled bold around `Two`, used Backspace, undo, redo,
    Enter, typed `Next`, inserted a soft break, typed and deleted `Soft`,
    undid/redid, pressed Tab, and confirmed the visible text wrappers stayed
    coherent with no console errors.

- 2026-05-24: completed missing-beforeinput modifier line deletion
  reconciliation.
  - DeepWiki findings: Slate and Lexical map soft/hard line deletion inputTypes
    and modifier keydowns into editor-owned line/block deletion commands when
    `beforeinput` is missing or unreliable. ProseMirror reconciles browser DOM
    deletion drift through DOM observation and selection repair. Svedit uses
    `oninput` model-vs-DOM diffing for browser-owned text mutations and handles
    structural keys in keydown.
  - Added Chromium/Firefox/WebKit coverage for `deleteSoftLineBackward`,
    `deleteHardLineBackward`, `deleteSoftLineForward`, and
    `deleteHardLineForward` when no reliable `beforeinput` fires. The tests
    dispatch modifier keydowns, simulate the browser-owned DOM text deletion,
    emit the follow-up `input` event, and assert the Yjs model plus caret
    reconcile to the expected line boundary.
  - Runtime result: no production patch was needed. Existing input-diff
    reconciliation already handles these line deletion DOM mutations when the
    follow-up `input` event arrives.
  - Verification:
    `pnpm test:integration tests/editor-dom/beforeinput-fallback.spec.ts -g "deleteSoftLine|deleteHardLine" --workers=1`
    passed 12 tests.
  - Verification:
    `pnpm test:integration tests/editor-dom/beforeinput-fallback.spec.ts --workers=1`
    passed 54 tests.
  - Verification: `pnpm lint` and `pnpm test:dom:typecheck` passed.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    route, typed `One`, toggled bold around `Two`, used double-space,
    Backspace, undo, redo, Enter, typed `Next`, inserted a soft break, typed and
    deleted `Soft`, undid/redid, pressed Tab, and confirmed the visible text
    wrappers stayed coherent with no console errors.

- 2026-05-24: completed root-route live regression audit after the reported
  visible DOM duplication, mark-toggle duplication, and double-space deletion
  symptoms on `http://localhost:5173/`.
  - Runtime result: no production patch was made. The current root route did not
    reproduce the visible DOM/value divergence after a reload.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    route, typed `One`, toggled bold around `Two`, used double-space,
    Backspace, undo, redo, Enter, typed `Next`, undid/redid the structural edit,
    and confirmed the live text wrappers rendered `OneTwo ` and `Next` once
    each with no browser console errors.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1`
    passed 30 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts tests/editor-dom/hotkeys.spec.ts tests/editor-dom/format-beforeinput.spec.ts tests/editor-dom/dom-mutation.spec.ts -g "auto-dot|browser-cloned|marked content|stale DOM clones|toggling a mark off|managed mark clone|wrappers that do not change" --workers=1`
    passed 18 focused stale-DOM/auto-dot tests across Chromium, Firefox, and
    WebKit.

- 2026-05-24: completed missing-beforeinput forward modifier word deletion
  reconciliation.
  - DeepWiki findings: Lexical, Slate, ProseMirror, and Svedit all treat
    forward word deletion as an editor command when `beforeinput` is missing or
    unreliable. They either prevent the keydown path directly or reconcile the
    resulting DOM/input diff while restoring the model caret.
  - Added Chromium/Firefox/WebKit coverage that dispatches `Alt+Delete` without
    a reliable `beforeinput`, applies the browser-owned DOM mutation from
    `First block` to ` block`, emits `input.deleteWordForward`, and asserts the
    Yjs model plus caret become ` block` at offset `0`.
  - Runtime result: no production patch was needed. Existing input-diff
    reconciliation already handles the forward deletion when the follow-up
    `input` event arrives.
  - Verification:
    `pnpm test:integration tests/editor-dom/beforeinput-fallback.spec.ts -g "forward word deletion" --workers=1`
    passed 3 tests.
  - Verification:
    `pnpm test:integration tests/editor-dom/beforeinput-fallback.spec.ts --workers=1`
    passed 42 tests.
  - Verification: `pnpm test -- --run` passed 268 tests.
  - Verification: `pnpm lint`, `pnpm test:typecheck`, and
    `pnpm test:dom:typecheck` passed.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    route, typed `One`, toggled bold around `Two`, used double-space,
    split paragraphs, inserted a soft break, backspaced, undid, redid, pressed
    Tab, and confirmed visible text `OneTwo   Next Sof ` with no console errors.

- 2026-05-24: completed browser-native drag selection across inline atomic
  mention deletion.
  - DeepWiki findings: Slate, Lexical, ProseMirror, and Svedit all treat
    selections crossing void/decorator/atomic inline content as semantic editor
    selections. They either prevent native deletion, route Backspace/Delete/Cut
    through model commands, or reconcile DOM drift afterward.
  - Added Chromium/Firefox/WebKit coverage that creates a real mouse-drag
    selection from text before a mention to text after the mention, then deletes
    it with Backspace/Delete and asserts the model becomes `lend`.
  - Initial focused run failed in Firefox: native drag collapsed the model
    selection at the trailing text and left the inline mention selected, so
    Backspace removed only the mention and left `lead  end`.
  - Runtime fix: pointerdown now records the event-time text/offset drag start,
    pointerup repairs an inline-atom-only collapsed selection back to the
    semantic dragged text range when the drag crosses exactly one inline atom,
    and the stale atomic deletion target is cleared before the next key command.
  - Verification:
    `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts -g "drag-selected" --workers=1`
    passed 3 tests.
  - Verification:
    `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts --workers=1`
    passed 21 tests.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "drag-selects" --workers=1`
    passed 6 tests.
  - Verification: `pnpm test -- --run` passed 268 tests.
  - Verification: `pnpm lint`, `pnpm test:typecheck`, and
    `pnpm test:dom:typecheck` passed.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    route, typed `One`, toggled bold around `Two`, used double-space,
    split paragraphs, inserted a soft break, backspaced, undid, redid, pressed
    Tab, and confirmed visible text `OneTwo   Next Sof ` with no console errors.

- 2026-05-24: completed canceled-composition undo history coverage.
  - DeepWiki findings: Lexical has a `Cancel composition not push undo stack`
    e2e history test: type a normal character, start an IME composition, cancel
    it, then undo once. The expected undo target is the normal character, not an
    intermediate empty/canceled composition state. Slate similarly avoids saving
    intermediate composition changes; only committed composition text should be
    history-visible.
  - Added Chromium/Firefox/WebKit coverage that types `a`, waits past the Yjs
    capture window, starts a composition preview, cancels it with empty
    `compositionend.data`, then asserts one undo removes `a` and one redo
    restores `a`.
  - Runtime result: no production patch was needed. Existing composition
    cancellation behavior does not create a user-visible undo step for the
    canceled preview.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition-cancellation.spec.ts -g "noisy undo" --workers=1`
    passed 3 tests.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition-cancellation.spec.ts --workers=1`
    passed 21 tests.
  - Verification: `pnpm test -- --run` passed 268 tests.
  - Verification: `pnpm lint`, `pnpm test:typecheck`, and
    `pnpm test:dom:typecheck` passed.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    route, typed `One`, toggled bold around `Two`, split paragraphs, inserted a
    soft break, backspaced, undid, redid, pressed Tab, and confirmed root
    visible text `OneTwo Next Sof` with no console errors.

- 2026-05-24: completed active-composition keydown and hotkey suppression
  coverage.
  - DeepWiki findings: Lexical, Slate, ProseMirror, and Svedit all keep an
    explicit active-composition state and return early from editor keydown or
    hotkey command handling while IME composition is in progress. The peer
    contract is active-composition keydowns do not split blocks, nest blocks,
    toggle marks, undo/redo, or otherwise mutate the editor command layer;
    post-composition keydowns resume normal behavior, with separate Safari-style
    guards where needed.
  - Added Chromium/Firefox/WebKit coverage that starts a composition preview,
    dispatches composing `mod+b`, Enter, Tab, and `mod+z` keydowns, commits the
    IME value, and asserts the document remains three flat paragraphs with the
    committed text unmarked and the caret after the final composition text.
  - Runtime result: no production patch was needed. Existing
    `shouldIgnoreCompositionKeyDown` already suppresses editor keydown command
    handling while `isComposing` or `event.isComposing` is true.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition-cancellation.spec.ts -g "hotkeys" --workers=1`
    passed 3 tests.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition-cancellation.spec.ts --workers=1`
    passed 18 tests.
  - Verification: `pnpm test -- --run` passed 268 tests.
  - Verification: `pnpm lint`, `pnpm test:typecheck`, and
    `pnpm test:dom:typecheck` passed.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    route, typed `One`, toggled bold around `Two`, split paragraphs, inserted a
    soft break, backspaced, undid, redid, pressed Tab, and confirmed root
    visible text `OneTwo Next Sof` with no console errors.

- 2026-05-24: completed browser Select All document-level deletion.
  - DeepWiki findings: Lexical treats Select All as a model-level normalized
    selection and has tests for select-all followed by deletion, including
    decorator/complex nodes; ProseMirror has WebKit selection workarounds around
    uneditable nodes, reinforcing that native DOM Select All cannot be trusted
    as the editor contract.
  - Initial regression:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts -g "document block selection" --workers=1`
    failed across Chromium, Firefox, and WebKit because content normalized to
    one fallback block but the editor selection snapshot stayed on the deleted
    `[0] -> [2]` block range.
  - Runtime fix: selected-block deletion now uses document-order selected
    blocks, chooses a focus fallback outside the deleted set, removes blocks in
    shared replacement logic, and falls back to the root's normalized empty
    paragraph when the whole document is deleted.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts -g "document block selection" --workers=1`
    passed 3 tests.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts --workers=1` passed
    51 tests.
  - Verification:
    `pnpm test:integration tests/editor-dom/clipboard.spec.ts -g "selected block" --workers=1`
    passed 9 tests, covering the shared selected-block replacement helper in
    clipboard cut/paste paths.
  - Verification: `pnpm test -- --run` passed 268 tests.
  - Verification: `pnpm lint`, `pnpm test:typecheck`, and
    `pnpm test:dom:typecheck` passed.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    route, typed `One`, toggled bold around `Two`, split paragraphs, inserted a
    soft break, backspaced, undid, redid, pressed Tab, and confirmed root
    visible text `OneTwo Next Sof` with no console errors. Then created three
    root blocks, cycled `mod+a` to document block selection, pressed Backspace,
    and confirmed exactly one focused empty placeholder block with caret offset
    `0` and no console errors.

- 2026-05-24: completed controlled `insertFromYank` text insertion.
  - DeepWiki findings: Slate and Lexical route `insertFromYank` through
    controlled text insertion commands. Lexical groups it with
    `insertReplacementText`/`insertFromDrop`, and Slate's editable
    beforeinput/Android input manager paths call text/data insertion for
    `insertFromYank` rather than leaving browser DOM mutation uncontrolled.
  - Initial regression:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "insertFromYank" --workers=1`
    failed across Chromium, Firefox, and WebKit because Edytor prevented the
    event while leaving model text at `lead`.
  - Runtime fix: `insertFromYank` now participates in the text-insertion input
    family, dispatches through the existing `insertText` command path, and
    refreshes the affected DOM text after the model command.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "insertFromYank" --workers=1`
    passed 3 tests.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1` passed
    102 tests.
  - Verification: `pnpm lint` and `pnpm test:typecheck` passed.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    route, typed `One`, toggled bold around `Two`, split paragraphs, inserted a
    soft break, backspaced, undid, redid, pressed Tab, and confirmed root
    visible text `OneTwo Next Sof` with no console errors.

- 2026-05-24: completed missing-beforeinput word deletion reconciliation.
  - DeepWiki findings: ProseMirror treats modifier/word deletion as an
    input/DOM-observer reconciliation boundary when the browser mutates the
    editable DOM; Slate and Lexical keep keydown hotkey/fallback paths separate
    from text/composition input paths and flush or control native operations
    after browser-owned text mutations.
  - Added Chromium/Firefox/WebKit coverage for `Alt+Backspace` keydown that is
    not prevented by Edytor, followed by browser-owned DOM deletion from `lead`
    to an empty text value and a follow-up `input.deleteWordBackward`.
  - Runtime result: no production patch was needed. Existing DOM text
    reconciliation normalized the now-empty block and restored selection to
    offset `0`.
  - Verification:
    `pnpm test:integration tests/editor-dom/beforeinput-fallback.spec.ts -g "word deletion" --workers=1`
    passed 3 tests.
  - Verification:
    `pnpm test:integration tests/editor-dom/beforeinput-fallback.spec.ts --workers=1`
    passed 39 tests.
  - Verification: `pnpm lint` and `pnpm test:typecheck` passed.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    route, typed `One`, toggled bold around `Two`, split paragraphs, inserted a
    soft break, backspaced, undid, redid, pressed Tab, and confirmed root
    visible text `OneTwo Next Sof` with no console errors.

- 2026-05-24: completed consecutive browser-owned text mutation coverage.
  - DeepWiki findings: Lexical handles macOS autocorrect/autocapitalization by
    flushing unprocessed `beforeinput` data when consecutive text events arrive
    before the normal input flush; Slate's Android input manager queues DOM
    text diffs/actions with pending selection; ProseMirror and Svedit reconcile
    observed DOM text diffs against stored input state rather than assuming a
    single event boundary.
  - Added Chromium/Firefox/WebKit coverage for two non-cancelable
    `beforeinput.insertText` events where the browser mutates DOM to `leXad`,
    moves selection to offset `3`, emits a second beforeinput for `Y`, then
    flushes one `input` event with DOM text `leXYad`.
  - Runtime result: no production patch was needed. Existing browser-owned
    input target tracking plus DOM text diff reconciliation produced model text
    `leXYad` and restored the final caret to offset `4`.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "consecutive browser-owned" --workers=1`
    passed 3 tests.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1` passed
    99 tests.
  - Verification: `pnpm test:typecheck` and `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, typed `One`, toggled bold around `Two`, split
    paragraphs, inserted a soft break, backspaced, undid, redid, and confirmed
    visible text parts `OneTwo`, `Next`, `Sof` with no console errors.

- 2026-05-24: completed mobile non-cancelable cross-paragraph deletion
  selection restoration.
  - DeepWiki findings: Lexical records Android rightward selection shift after
    delete and restores a saved post-delete selection; Slate/Svedit store
    beforeinput-time selection for later input reconciliation on mobile;
    ProseMirror treats Android delete as a delayed DOM-change/selection-repair
    path.
  - Added mobile Chromium/WebKit coverage for non-cancelable
    `deleteContentBackward` and `deleteContentForward` over a text range from
    `lead` into `note`, followed by simulated native DOM deletion to `lete`
    and a browser-shifted caret at offset `3`.
  - Runtime result: no production patch was needed. Existing event-time
    selection and suppressed native input repair kept the model as `lete` and
    restored the caret to offset `2` in the surviving first block.
  - Verification:
    `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts -g "deletes across paragraphs" --workers=1`
    passed 4 tests.
  - Verification:
    `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts --workers=1`
    passed 48 tests.
  - Verification: `pnpm test:typecheck` and `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, typed `One`, toggled bold around `Two`, split
    paragraphs, inserted a soft break, backspaced, undid, redid, and confirmed
    visible text parts `OneTwo`, `Next`, `Sof` with no console errors.

- 2026-05-24: tightened live-root typing regression coverage after a reported
  localhost DOM-duplication symptom.
  - Fresh check: reloaded `http://localhost:5173/`, cleared the editor, typed
    `One`, toggled bold around `Two`, split paragraphs, inserted a soft break,
    backspaced, undid, and redid through the in-app Browser. The visible DOM
    had `OneTwo`, `Next`, and `Sof` exactly once, and the page emitted no
    console errors.
  - Test hardening: upgraded the demo-route clear-and-type smoke from a weak
    `contains` assertion to exact text/paragraph equality for `Oneee`, plus a
    placeholder removal assertion.
  - Runtime result: no production patch was applied because the current runtime
    and the existing cross-browser regressions were already green for the
    duplicate-mark and auto-dot classes.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts tests/editor-dom/hotkeys.spec.ts tests/editor-dom/format-beforeinput.spec.ts tests/editor-dom/input.spec.ts tests/editor-dom/dom-mutation.spec.ts --workers=1 -g "stale DOM clones|duplicate visible text|auto-dot|browser-cloned|wrappers that do not change|does not delete existing demo-route text"`.

- 2026-05-24: completed mobile non-cancelable line break inside code lines.
  - DeepWiki findings: Slate maps `insertLineBreak` to editor-owned soft breaks
    and defers Android non-cancelable paths to its Android input manager;
    Lexical dispatches `INSERT_LINE_BREAK_COMMAND` and removes unmanaged `<br>`
    drift; ProseMirror reconciles Android DOM line/paragraph drift through DOM
    change parsing and selection restoration.
  - Added mobile Chromium/WebKit coverage for non-cancelable
    `beforeinput.insertLineBreak` inside a `codeLine`, followed by simulated
    native `<br>` drift.
  - Runtime result: no production patch was needed. Existing code-line
    normalization and suppressed native mutation repair produced code lines
    `const `, `a = 1;`, `return a;`, removed the native `<br>`, and restored
    the caret to the new code line.
  - Verification: `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts -g "line break inside a code line" --workers=1`
    passed 2 tests.
  - Verification: `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts --workers=1`
    passed 44 tests.
  - Verification: `pnpm test:typecheck`, `pnpm test:dom:typecheck`, and
    `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: `clear` -> type
    `One` -> bold toggle -> type `Two` -> bold toggle off -> Enter -> type
    `Next` -> Shift+Enter -> type `Soft` -> Backspace -> undo -> redo -> Tab
    produced visible text parts `OneTwo`, `Next`, and `Sof`, zero placeholders,
    and no page error logs.
- 2026-05-24: completed mobile non-cancelable Enter inside code lines.
  - DeepWiki findings: ProseMirror fixed Android GBoard Enter in code blocks
    while spell correction was selected; Slate's Android input manager maps
    `insertParagraph`/`insertLineBreak` to editor commands; Lexical dispatches
    line-break/paragraph commands from beforeinput and resets composition state
    around those commands.
  - Added mobile Chromium/WebKit coverage for non-cancelable
    `beforeinput.insertParagraph` inside a `codeLine`, followed by simulated
    native paragraph DOM drift.
  - Runtime result: no production patch was needed. Existing code-line split
    behavior and suppressed native mutation repair already produced code lines
    `const `, `a = 1;`, `return a;`, removed the native paragraph, and restored
    the caret to the new code line.
  - Verification: `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts -g "code line" --workers=1`
    passed 2 tests.
  - Verification: `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts --workers=1`
    passed 42 tests.
  - Verification: `pnpm test:typecheck`, `pnpm test:dom:typecheck`, and
    `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: `clear` -> type
    `Alpha` -> bold toggle -> type `Beta` -> bold toggle off -> Enter -> type
    `Gamma` -> Shift+Enter -> type `Delta` -> Backspace -> undo -> redo -> Tab
    produced visible text parts `AlphaBeta`, `Gamma`, and `Delt`, zero
    placeholders, and no page error logs.
- 2026-05-24: completed start-of-text non-cancelable insertion target
  restoration.
  - DeepWiki findings: Slate prevents native single-character insertion at text
    offset `0` because Chrome can corrupt start-node edits; Lexical prevents or
    reconciles insertion when DOM selection/target range disagrees with the
    editor selection; ProseMirror and Svedit reconcile DOM/input mutations
    while preserving the event-time selection target.
  - Added a mobile Chromium/WebKit regression for non-cancelable `insertText`
    at offset `0` where native DOM inserts `Xlead` and then moves selection
    into another block before the follow-up `input` event.
  - Runtime result: no production patch was needed. Existing browser-owned
    input target tracking and input reconciliation already restored the model
    to `Xlead` with the caret at offset `1`.
  - Verification: `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts -g "start of a text node" --workers=1`
    passed 2 tests.
  - Verification: `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts --workers=1`
    passed 40 tests.
  - Verification: `pnpm test:typecheck`, `pnpm test:dom:typecheck`, and
    `pnpm lint` passed.
  - In-app Browser verification on `http://localhost:5173/`: `clear` -> type
    `Alpha` -> bold toggle -> type `Beta` -> bold toggle off -> Enter -> type
    `Gamma` -> Shift+Enter -> type `Delta` -> Backspace -> undo -> redo
    produced visible text parts `AlphaBeta`, `Gamma`, and `Delt`, with no page
    error logs.
- 2026-05-24: completed generic and entire-soft-line delete beforeinput
  routing.
  - Added browser regressions for `deleteContent` and `deleteEntireSoftLine`
    target ranges across Chromium, Firefox, and WebKit.
  - Runtime now treats `deleteContent` as model-owned deletion and routes
    `deleteEntireSoftLine` through model deletion for ranges or full current
    block-content clearing for collapsed carets.
  - During validation, browser-owned typing undo/redo exposed a caret
    restoration race: redo restored content but stale DOM refresh left the
    caret at offset `0`.
  - History commands now capture the undo/redo stack-item selection snapshot
    before moving the stack item and restore collapsed text selections after
    DOM refresh.
  - Verification: `pnpm test:integration tests/editor-dom/advanced-delete.spec.ts --workers=1`
    passed 48 tests.
  - Verification: `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1`
    passed 96 tests.
  - Verification: `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts --workers=1`
    passed 38 tests.
  - Verification: `pnpm test:integration tests/editor-dom/hotkeys.spec.ts --workers=1`
    passed 48 tests.
  - Verification: `pnpm test:integration --workers=1` passed with 671 tests, 8
    skipped, and 3 retried WebKit navigation flakes.
  - Verification: `pnpm check`, `pnpm test:typecheck`,
    `pnpm test:dom:typecheck`, `pnpm lint`, `pnpm test -- --run`,
    `pnpm test:dom`, and `pnpm build` passed.
  - In-app Browser verification on `http://localhost:5173/`: `clear` ->
    `One` -> bold toggle -> `Two` -> bold toggle off -> double-space ->
    Backspace -> Enter -> `Next` -> undo -> redo produced
    `OneTwo \n\nNext`, two managed text parts, and no unmanaged editor text
    nodes.
- 2026-05-24: completed unsupported native link/direction/horizontal-rule
  beforeinput coverage.
  - Materially new gap: unsupported-native browser coverage already locked list,
    indent/outdent, block conversion, justify, and color/font commands, but not
    native link insertion, text-direction formatting, or horizontal-rule
    insertion.
  - DeepWiki findings: Slate and Lexical prevent unsupported native structure
    or attribute `beforeinput` commands instead of allowing uncontrolled
    `contenteditable` DOM mutation; Svedit keeps unsupported commands behind
    transaction-owned behavior; ProseMirror treats DOM mutation as something to
    reconcile through its observer/transaction pipeline rather than as
    authoritative editor state.
  - Added collapsed and ranged browser coverage for `insertLink`,
    `formatSetBlockTextDirection`, `formatSetInlineTextDirection`, and
    `insertHorizontalRule` in `tests/editor-dom/unsupported-beforeinput.spec.ts`.
    The assertion now also checks for uncontrolled `<a>`, `<hr>`, and `dir`
    attributes inside the editor DOM.
  - Runtime result: no production code change was needed; Edytor's existing
    generic model-owned beforeinput path already prevents unknown commands and
    leaves the model/DOM unchanged.
  - Verification:
    `pnpm test:integration tests/editor-dom/unsupported-beforeinput.spec.ts --workers=1`,
    `pnpm test -- --run`, `pnpm test:dom`, `pnpm test:typecheck`,
    `pnpm test:dom:typecheck`, `pnpm check`, `pnpm lint`, `pnpm build`.
  - In-app Browser verification on `/`: simple `clear` -> `One` -> Enter ->
    `Two` produced two paragraph blocks with no console errors; broader
    mark-toggle, double-space, Backspace, Enter, undo/redo, Shift+Enter, and Tab
    smoke produced coherent visible blocks and no uncontrolled anchor, `dir`,
    horizontal-rule, color, or font DOM nodes.

- 2026-05-24: completed unsupported native color/font formatting beforeinput
  coverage.
  - Materially new gap: existing unsupported-native-command browser coverage
    locked lists, indent/outdent, block conversion, and center justify, but not
    data-bearing browser color/font formatting commands that can style
    `contenteditable` DOM outside the model.
  - DeepWiki findings: Slate and Lexical prevent unsupported native formatting
    beforeinput commands instead of trusting browser DOM mutation; Svedit routes
    supported formatting through transactions and blocks unsupported native
    formatting; ProseMirror reconciles native DOM changes through its observer
    pipeline rather than treating browser formatting as authoritative.
  - Spec check: current Input Events Level 2 lists `formatBackColor`,
    `formatFontColor`, and `formatFontName` as data-bearing inputTypes; the
    older/legacy `formatForeColor` command is also locked as no-op because some
    browser command surfaces still use foreground-color terminology.
  - Added browser coverage for collapsed and ranged `formatForeColor`,
    `formatBackColor`, `formatFontColor`, and `formatFontName` in
    `tests/editor-dom/unsupported-beforeinput.spec.ts`.
  - Runtime result: no production code change was needed; Edytor's existing
    generic model-owned beforeinput path already prevents unknown commands and
    leaves the model/DOM unchanged.
  - Verification:
    `pnpm test:integration tests/editor-dom/unsupported-beforeinput.spec.ts --workers=1`,
    `pnpm test -- --run`, `pnpm test:dom`, `pnpm test:typecheck`,
    `pnpm test:dom:typecheck`, `pnpm check`, `pnpm lint`, `pnpm build`.
  - In-app Browser verification on `/`: after `clear`, typing `One`, toggling
    bold while typing `Two`, double-space, Backspace, Enter, typing `C`, undo,
    and redo, the visible editor contained `OneTwo  ` and `C`, with zero
    console/page errors and no unmanaged native color/font style nodes.

- 2026-05-24: completed native `formatRemove` collapsed pending-mark clearing.
  - Materially new gap: existing native format tests cover ranged
    `formatRemove`, and collapsed format commands that create pending marks,
    but not the browser command that clears pending marks before the next typed
    character.
  - DeepWiki findings: Slate clears pending insertion marks and user marks for
    remove-format/add-mark transitions; Lexical owns native beforeinput
    formatting through internal commands and tracks collapsed selection formats
    for future insertion; ProseMirror avoids trusting browser-native formatting
    and reconciles DOM mark changes through its transaction/stored-mark layer;
    Svedit prevents native formatting commands and routes formatting through
    transactions.
  - Failing command before runtime patch:
    `pnpm test:integration tests/editor-dom/format-beforeinput.spec.ts -g "clears pending marks" --workers=1`.
    Chromium, Firefox, and WebKit inserted `x` with `{ underline: true }`
    after `formatUnderline`, `formatRemove`, and `insertText`.
  - Runtime fix: collapsed `formatRemove` now sets the current text's
    `markOnNextInsert` to an empty override and restores the collapsed
    selection, so later model-owned or browser-reconciled insertion is plain
    instead of inheriting stale pending marks.
  - Verification:
    `pnpm test:integration tests/editor-dom/format-beforeinput.spec.ts -g "clears pending marks" --workers=1`,
    `pnpm test:integration tests/editor-dom/format-beforeinput.spec.ts --workers=1`,
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts -g "native format|reverse-selection mark toggle|undoes and redoes a reverse-selection" --workers=1`,
    `pnpm test -- --run`, `pnpm test:dom`, `pnpm test:typecheck`,
    `pnpm test:dom:typecheck`, `pnpm check`, `pnpm lint`, and `pnpm build`.
  - Live Browser verification on `http://localhost:5173/`: clear, click the
    placeholder, type text, toggle marks, split paragraph, soft break, delete,
    undo, redo, and Tab/nest. Result: managed text stayed coherent and no
    console errors were emitted.

- 2026-05-24: completed hidden stale placeholder clone cleanup after real
  split/undo/redo.
  - Fresh browser-backed failure: direct in-app Browser interaction on
    `http://localhost:5173/` using real click/key events left three
    `data-edytor-text-placeholder` elements in a paragraph after
    Enter/type/undo/redo. The Yjs value and managed text were correct, but the
    DOM text still contained repeated placeholder strings.
  - Existing test gap: the demo-route placeholder regression only counted
    visible placeholders, so hidden stale placeholder nodes escaped.
  - Runtime fix: placeholder cleanup now has a root-level DOM normalization path
    in the mutation observer, plus shared post-history DOM refresh for both
    hotkey undo/redo and native `beforeinput.historyUndo`/`historyRedo`.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "does not duplicate the placeholder" --workers=1`,
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1`,
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts --workers=1`,
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "placeholder" --workers=1`,
    `pnpm test -- --run`, `pnpm test:dom`, `pnpm test:typecheck`,
    `pnpm test:dom:typecheck`, `pnpm check`, `pnpm lint`, and `pnpm build`.
  - Live Browser verification on `http://localhost:5173/`: clear, click the
    placeholder, type `One`, toggle bold while typing `Two`, double-space,
    Backspace, Enter, type `C`, undo, redo. Result: two managed text blocks
    (`OneTwo ` and `C`), zero placeholder nodes in non-empty blocks, and no
    console errors.

- 2026-05-24: completed stale blurred selection recovery.
  - DeepWiki findings from Slate, Lexical, ProseMirror, and Svedit: mature
    editors do not blindly trust a cached pre-blur selection when focus returns.
    They clear stale native ranges on blur/focus, flush or read event-time DOM
    selection before input, and only restore cached selection for likely browser
    focus-reset artifacts rather than newer user/native selections.
  - Failing command before runtime patch:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "ignores stale blurred selection" --workers=1`.
    Chromium, Firefox, and WebKit inserted `A` into `lead` as `leAad` after a
    blur/refocus sequence, proving the cached pre-blur range was overriding the
    later empty-block selection.
  - Runtime fix: root focus restoration now first inspects the current DOM
    selection inside the editor. If it is meaningful, Edytor applies it to the
    model selection and does not restore the cached selection. A collapsed
    selection at the first editable text offset `0` is still treated as the
    browser's likely focus reset, so keyboard/programmatic focus restoration
    remains intact.
  - In-app Browser verification on `http://localhost:5173/`: after reload,
    `clear`, typing, mark toggle, paragraph split, undo, redo, soft break,
    delete, and tab interactions produced no console errors. A simple
    mark/split/undo/redo flow left visible block text matching managed model
    text: `AB` then `C`.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "ignores stale blurred selection" --workers=1`,
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "cached model selection|programmatically focusing|tabbing" --workers=1`,
    `pnpm test:integration tests/editor-dom/composition.spec.ts --workers=1`,
    `pnpm test:integration tests/editor-dom/blurred-programmatic-update.spec.ts --workers=1`,
    `pnpm test -- --run`, `pnpm test:dom`, `pnpm test:typecheck`,
    `pnpm test:dom:typecheck`, `pnpm check`, `pnpm lint`, `pnpm build`.
  - Process note: a concurrent Playwright run reproduced the known
    `.svelte-kit/__package__` race. It was discarded and rerun sequentially
    with `--workers=1`; the sequential browser suites above passed.

- 2026-05-24: completed browser triple-click text replacement and split-undo
  placeholder dedupe.
  - DeepWiki findings from Slate, Lexical, ProseMirror, and Svedit: browser
    double/triple-click selections can overhang or collapse at DOM boundaries,
    so mature editors keep the semantic selection model-owned before applying
    the next insertion.
  - Added a Playwright regression that triple-clicks the first paragraph,
    types one character, and asserts only that paragraph is replaced while
    following marked/inline sibling blocks stay intact across Chromium,
    Firefox, and WebKit.
  - Failing command before runtime patch:
    `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`.
    Firefox appended `X` to `First block` because
    `beforeinput.getTargetRanges()` reported a collapsed insertion target and
    overwrote Edytor's expanded model selection.
  - Runtime fix: text insertion `beforeinput` no longer syncs a collapsed
    target range over an already-expanded Edytor model selection.
  - Fresh in-app Browser verification on `http://localhost:5173/` found a
    separate visible DOM regression: after `clear`, typing, `Enter`, typing in
    the split paragraph, and undo, the empty split paragraph displayed duplicate
    placeholders while the model remained clean.
  - Added a demo-route Playwright regression for that split/undo placeholder
    case. The locked contract is visible output: one visible placeholder in
    the empty split paragraph. Some engines can still keep a hidden
    browser-restored placeholder sibling after undo; eliminating that hidden
    node requires a deeper placeholder-rendering strategy, not more global
    cleanup loops.
  - In-app Browser verification on `http://localhost:5173/`: after reload,
    `clear`, typing `One`, collapsed bold `Two`, toggling bold off,
    double-space, `Enter`, typing `Next`, and undo left visible blocks
    `OneTwo  ` plus one visible empty placeholder block, with no unmanaged text
    nodes and no console errors.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`,
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "distinguishes image void body focus" --project=webkit --workers=1`,
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "duplicate the placeholder" --workers=1`,
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "target ranges|cross-block browser selection" --workers=1`,
    `pnpm test:typecheck`, `pnpm test:dom:typecheck`, `pnpm lint`,
    `pnpm test -- --run`, `pnpm test:dom`, `pnpm check`, `pnpm build`.
  - Full integration audit after the focused fix:
    `pnpm test:integration --workers=1` is still red on two broader
    browser-backed contracts. `tests/editor-dom/clipboard.spec.ts` fails
    `copies and pastes a nested selected block with regenerated ids` across
    Chromium, Firefox, and WebKit because the inserted nested block is not at
    the index asserted by the spec. `tests/editor-dom/composition.spec.ts`
    fails `ignores stale blurred selection and keeps later edits coherent`
    across Chromium, Firefox, and WebKit because typing after blur still lands
    in the stale first-block range. These are not part of the visible
    root-route duplication slice and must be handled as separate browser
    slices, not hidden in this entry.

- 2026-05-24: completed reverse native selection preservation through
  history undo/redo restoration.
  - DeepWiki findings from Slate, Lexical, ProseMirror, and Svedit: mature
    editors persist anchor/focus direction in internal selection state and use
    `setBaseAndExtent()` or `extend()` when writing history-restored
    selections back to the DOM.
  - Added Playwright coverage that creates a backward native selection across
    two paragraphs, toggles bold, undoes the mark operation, and redoes it,
    asserting model marks plus native backward selection direction across
    Chromium, Firefox, and WebKit.
  - Failing command before runtime patch:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts --workers=1 -g "reverse-selection mark toggle"`.
  - Runtime fix: range history restoration now resolves stale text IDs through
    current model paths when Yjs undo/redo has remounted text wrappers, then
    retries the reversed range restore after DOM ticks so browser/Svelte
    selectionchange fallout cannot collapse it.
  - Rich-text mark operations now queue the event-time selection snapshot before
    range formatting mutates Yjs, so history metadata records the user range
    instead of a later remount/collapse artifact.
  - In-app Browser verification on `http://localhost:5173/`: after reload,
    code-line `Tab`, `clear`, typing `One`, collapsed bold `Two`, toggling bold
    off, `Space`, `Backspace`, `Enter`, and undo left visible text and managed
    text wrappers as `OneTwo`, with no unmanaged clones and no console errors.
    The in-app Browser redo key did not visibly replay the split, matching the
    existing key-synthesis limitation; Playwright remains authoritative for
    redo and passed across all browser projects.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts --workers=1 -g "reverse-selection mark toggle"`,
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts tests/editor-dom/dom-mutation.spec.ts tests/editor-dom/demo-route.spec.ts --workers=1`,
    `pnpm test:typecheck`, `pnpm test:dom:typecheck`,
    `pnpm test -- --run`, `pnpm test:dom`, `pnpm check`, `pnpm lint`,
    `pnpm build`.
- 2026-05-24: completed reverse native selection preservation through
  model-owned mark formatting.
  - DeepWiki findings from Slate, Lexical, ProseMirror, and Svedit: mature
    editors preserve anchor/focus direction separately from logical
    start/end when mapping model selections back into browser DOM selection.
  - Added Playwright coverage that creates a backward native selection across
    two paragraphs, toggles bold through the real hotkey path, then asserts
    both model marks and native backward anchor/focus direction across
    Chromium, Firefox, and WebKit.
  - Failing command before runtime patch:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts --workers=1 -g "preserves a reverse native selection"`.
  - Runtime fix: `EdytorSelection` now stores `isReversed`, records it in
    undo/redo selection snapshots, and restores unchanged reversed ranges with
    `Selection.setBaseAndExtent()` or `Selection.extend()` instead of always
    re-adding a forward `Range`.
  - In-app Browser verification on `http://localhost:5173/`: after reload,
    `clear`, typing `One`, collapsed bold `Two`, toggling bold off, `Space`,
    `Backspace`, `Enter`, and undo left visible text and managed text wrappers
    as `OneTwo`, with no unmanaged clones and no console errors.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts --workers=1 -g "preserves a reverse native selection"`,
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts tests/editor-dom/dom-mutation.spec.ts tests/editor-dom/demo-route.spec.ts --workers=1`,
    `pnpm test:typecheck`, `pnpm test:dom:typecheck`,
    `pnpm test -- --run`, `pnpm test:dom`, `pnpm check`, `pnpm lint`,
    `pnpm build`.
- 2026-05-24: completed unsupported native structural `beforeinput` no-op
  coverage and stale managed-mark DOM repair.
  - DeepWiki findings: Slate prevents unhandled native `beforeinput` commands
    in `Editable`; Lexical routes supported values through commands and leaves
    unsupported inputTypes as command-system no-ops; ProseMirror treats native
    DOM changes as reconciliation input rather than source of truth; Svedit
    keeps unsupported structural `beforeinput` out of its model-owned editing
    path.
  - Added Playwright coverage for collapsed and ranged
    `insertOrderedList`, `insertUnorderedList`, `indent`, `outdent`,
    `formatBlock`, and `formatJustifyCenter`, asserting `preventDefault`,
    unchanged JSON, unchanged visible DOM, no native list/heading nodes, and
    stable selection across Chromium, Firefox, and WebKit.
  - Fresh runtime defect found during required in-app Browser verification:
    browser-created Edytor-shaped mark DOM could remain visible while the Yjs
    model was correct. Reproduction on `http://localhost:5173/`: `clear`, type
    `One`, `Meta+B`, type `Two`, `Meta+B`, `Space`, `Backspace` showed cloned
    bold text before the patch.
  - Failing command before runtime patch:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts --workers=1 -g "browser-cloned managed mark"`.
  - Runtime fix: the DOM mutation observer now remounts a live text from the
    model when a managed-subtree mutation leaves the text node's visible content
    different from `Text.stringContent`, then restores the collapsed selection.
  - In-app Browser verification on `http://localhost:5173/`: after reload,
    `clear`, typing `One`, collapsed bold `Two`, toggling bold off, `Space`,
    and `Backspace`, the visible block was `OneTwo ` with no duplicated bold
    clone and no native structural nodes.
  - Verification:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts --workers=1 -g "browser-cloned managed mark"`,
    `pnpm test:integration tests/editor-dom/unsupported-beforeinput.spec.ts --workers=1`,
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts tests/editor-dom/demo-route.spec.ts tests/editor-dom/unsupported-beforeinput.spec.ts tests/editor-dom/format-beforeinput.spec.ts --workers=1`,
    `pnpm test -- --run`, `pnpm test:dom`, `pnpm test:typecheck`,
    `pnpm test:dom:typecheck`, `pnpm check`, `pnpm lint`, `pnpm build`.
- 2026-05-24: added an immediate post-Backspace demo-route regression for
  collapsed mark typing at a mark boundary.
  - Fresh browser-backed reason: while verifying `http://localhost:5173/` with
    the in-app Browser, the automation path `clear`, type `One`, `Meta+B`,
    type `Two`, `Meta+B`, `Space`, `Space`, `Backspace` surfaced visible
    `OneTwo Two`.
  - Material difference from existing coverage: prior `/` coverage proved
    selected mark toggles and the undo-after-Backspace recovery path. This new
    gate asserts the immediate post-Backspace state before undo can repair or
    hide the issue.
  - Result: the real Playwright keyboard path passed in Chromium, Firefox, and
    WebKit, so no runtime patch was made. The in-app Browser reproduction is
    recorded as an automation-specific `locator.press('Meta+B')`/keypress
    artifact unless a user/manual browser failure reproduces it outside that
    automation path.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1 -g "resurrect marked text"`,
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1`,
    `pnpm test:dom:typecheck`, `pnpm lint`, `pnpm check`.
- 2026-05-24: completed real-browser root `dragover`/`drop` prevention for
  the current non-DnD product boundary.
  - DeepWiki finding: Slate, Lexical, ProseMirror, and Svedit all treat drag
    and drop as an editor-owned browser boundary. Slate carries drop/dragend
    state reset fixes, Lexical routes drag/drop through commands, ProseMirror
    guards `EditorView.dragging`/drop handling, and Svedit prevents native
    `insertFromDrop` when DnD is unsupported.
  - Material difference from completed `insertFromDrop` beforeinput coverage:
    this slice tests the actual root `dragover`/`drop` event path. A browser
    can dispatch or act on drop events before or without a useful
    `beforeinput.insertFromDrop`, so preventing only beforeinput is not a full
    uncontrolled-native-drop guard.
  - Proven gap before the runtime patch:
    `pnpm test:integration tests/editor-dom/drop-beforeinput.spec.ts --workers=1 -g "root dragover"`
    failed in Chromium, Firefox, and WebKit with `dragoverPrevented=false` and
    `dropPrevented=false`.
  - Runtime fix: the editable root now prevents and stops unsupported
    `dragover` and `drop` events while DnD is not a supported product surface.
  - Added Playwright coverage proving root `dragover`/`drop` are prevented,
    document text remains unchanged, and selection remains stable across
    Chromium, Firefox, and WebKit.
  - In-app Browser verification on `http://localhost:5173/`: after reload and
    `clear`, placeholder click, typing `One`, bold `Two`, double space,
    Backspace, `Control+Z`, Tab, Enter, `Beta`, and `Control+Z` left a coherent
    editor surface with no duplicated marked DOM. The in-app Browser evaluation
    surface could not construct synthetic drag/drop events, so actual drop
    prevention is verified by Playwright.
  - Verification:
    `pnpm test:integration tests/editor-dom/drop-beforeinput.spec.ts --workers=1`,
    `pnpm test:integration tests/editor-dom/drop-beforeinput.spec.ts tests/editor-dom/input.spec.ts --workers=1 -g "drop|outside target range|uses beforeinput target ranges|missing and only input fires"`,
    `pnpm test -- --run`, `pnpm test:dom`, `pnpm test:typecheck`,
    `pnpm test:dom:typecheck`, `pnpm lint`, `pnpm check`, `pnpm build`.
- 2026-05-24: completed real-browser code-line Tab, marked-history DOM
  duplication, and paragraph-split history boundary gates.
  - DeepWiki finding: Lexical owns Tab inside code blocks through keydown
    commands, prevents native focus navigation, and has browser/e2e regressions
    such as tabbing inside a code block. ProseMirror's event hierarchy likewise
    expects custom keydown handlers to prevent browser defaults for editor-owned
    behavior, while Slate/Svedit reinforce central keydown ownership around
    contenteditable quirks and IME-sensitive regions.
  - Material difference from completed code island Backspace/Delete: this slice
    tests Tab, which browsers normally use for focus navigation. Existing
    Edytor model and mounted fixtures cover code-line Tab insertion and
    suggestion acceptance, but the Playwright browser lane currently only
    covers code suggestion Escape.
  - Fresh localhost failure: in-app Browser verification on
    `http://localhost:5173/` reproduced visible `OneTwoTwoTwo` DOM after
    typing `One`, toggling bold for `Two`, deleting a trailing space, undoing,
    and pressing Tab, while the model value was not equivalently duplicated.
  - Runtime fixes: history undo/redo now waits for the queued history selection
    restore, refreshes connected text DOM from the Yjs model, and restores the
    settled selection after remount; delete `beforeinput` paths stop history
    capture before browser-owned/model-owned deletion; paragraph insertion
    stops history capture again after the structural mutation so following
    typing is not merged into the split undo step.
  - Mounted DOM harness fix: `clickPlaceholder` no longer fabricates a native
    selection inside the placeholder button before click handling; after the
    click events it normalizes through the underlying empty text selection,
    matching the browser-facing placeholder contract.
  - Added Playwright coverage proving code-line Tab insertion, code suggestion
    Tab acceptance, no marked-text DOM duplication after delete/undo on `/`,
    and separate undo steps for paragraph split followed by typing.
  - In-app Browser verification on `http://localhost:5173/`: after reload,
    `clear`, placeholder click, `One`, `Control+B`, `Two`, `Control+B`, two
    spaces, Backspace, `Control+Z`, and Tab rendered exactly one `OneTwo  `
    paragraph with a single bold `Two` span. A second live run with `Alpha`,
    Enter, `Beta`, then `Control+Z` left two blocks, `Alpha` and an empty
    second paragraph.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1 -g "undoing a deletion"`,
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts --workers=1 -g "browser text insertion|paragraph split|code.*tab|tab.*code"`,
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1 -g "coalesce typing after a paragraph split"`,
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts tests/editor-dom/hotkeys.spec.ts --workers=1`,
    `pnpm exec vitest run src/tests/fixtures/model/history.test.ts`,
    `pnpm test -- --run`, `pnpm test:dom`,
    `pnpm test:typecheck`, `pnpm test:dom:typecheck`,
    `pnpm check`, `pnpm lint`, `pnpm build`.
- 2026-05-24: added explicit demo-route gates for the user-reported localhost
  mark-toggle and auto-dot symptoms.
  - Fresh reason: user asked to verify specifically on
    `http://localhost:5173/` after seeing duplicated visible DOM when toggling
    marks and text loss during double-space auto-dot behavior.
  - In-app Browser verification on `/`: `clear`, placeholder click, plain
    typing, collapsed bold typing, selected-mark toggle probe, and double-space
    typing did not show visible duplicate text or browser console errors. The
    in-app Browser Enter key path remains a known manual-driver limitation, so
    Enter/split/undo authority stays in Playwright.
  - Added Playwright coverage on `/` proving selected bold toggle keeps visible
    text exactly `One`, and synthetic `. ` insert after `lead` yields
    `lead. ` instead of deleting existing text.
  - Result: existing runtime passed the new regressions. No runtime patch was
    needed.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1`,
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1 -g "browser-cloned mark DOM|auto-dot"`.
- 2026-05-24: completed code island Backspace/Delete boundary browser gate.
  - DeepWiki finding: Lexical and ProseMirror treat code/isolating blocks and
    uneditable widgets as browser-sensitive boundaries. They intercept
    Backspace/Delete/Enter/Tab and selection near code/tooling elements so the
    browser cannot escape the isolated block or corrupt surrounding content.
  - Material difference from existing code plugin/model fixtures: model and
    mounted fixtures covered code hotkeys and merge guards, but the browser lane
    did not directly prove real Backspace at the first `codeLine` and real
    Delete at the last `codeLine` keep the code island isolated.
  - Added Playwright coverage proving the code block keeps its two lines, the
    following paragraph is not merged into the island, and selection remains on
    the code-line edge across Chromium, Firefox, and WebKit.
  - Result: existing runtime code passed the new regression; no runtime patch was
    needed.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    route, clicked the placeholder, typed `One`, toggled bold, typed `Two`,
    split with Enter, inserted a soft break, typed `Soft`, used
    Backspace/Delete/Tab, and undid the latest edit. The visible editor stayed
    coherent, placeholders did not leak into text, and console errors stayed
    empty.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1 -g "code island boundaries"`,
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1`,
    `pnpm lint`.
- 2026-05-24: completed structural paragraph-split redo browser gate.
  - DeepWiki finding: Lexical has e2e history tests that type paragraphs with
    Enter, undo structural splits, then redo them while asserting content and
    selection. Slate handles undo/redo hotkeys manually because browser-native
    history behavior is inconsistent.
  - Fresh reason from live Browser verification: after a root-route Enter split
    and undo, the in-app Browser key probe did not visibly restore the split
    with `Meta+Shift+Z` or `Control+Shift+Z`.
  - Material difference from existing text redo coverage: existing Playwright
    hotkey coverage proved text insertion redo only, not structural paragraph
    split redo.
  - Added Playwright coverage proving real browser Enter split, `mod+z`, and
    `mod+shift+z` restore both document shape and selection across Chromium,
    Firefox, and WebKit.
  - Result: the runtime passed the new browser regression. The in-app Browser
    redo probe appears to be a key-synthesis/focus limitation of the manual
    driver, not a confirmed editor runtime bug.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts --workers=1 -g "paragraph split"`,
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts --workers=1`.
- 2026-05-24: completed programmatic editor focus/refocus selection
  restoration gate.
  - DeepWiki finding: ProseMirror, Slate, and Lexical treat editor focus/refocus
    as a selection synchronization boundary because direct `focus()` and browser
    focus entry do not reliably produce a useful `selectionchange` before the
    next input, especially in Firefox/Safari-style behavior.
  - Material difference from completed Tab focus: this case calls
    `edytor.node.focus()` directly after an external button owns focus and does
    not manually call `selection.setAtTextOffset()` after focus.
  - Existing runtime behavior passed the new browser regression because the
    focus-entry restore added for keyboard focus also covers non-pointer
    programmatic root focus.
  - Added Playwright coverage proving the next typed character inserts at a
    cached second-paragraph caret across Chromium, Firefox, and WebKit after
    direct programmatic root focus.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1 -g "programmatically focusing"`.
- 2026-05-24: verified root-route behavior after user-specified
  `http://localhost:5173/` target.
  - No runtime change in this slice.
  - In-app Browser verification on `http://localhost:5173/`: cleared the
    editor, clicked the empty placeholder, typed `One`, toggled bold, typed
    `Two`, split with Enter, undid the split, cleared again, and typed
    `abc  `. The visible editor stayed coherent with no duplicate visible text,
    no stale placeholder after input, and no double-space deletion.
  - Console check on the live tab returned no browser error logs.
  - The in-app Browser driver did not produce a real expanded text range with
    Shift+Arrow or drag, so range-mark verification was kept in Playwright
    rather than counted as a manual Browser proof.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1`,
    `pnpm test:integration tests/editor-dom/format-beforeinput.spec.ts --workers=1 -g "stale DOM clones"`.
- 2026-05-24: completed tab focus restores cached model selection.
  - DeepWiki finding: Slate has a Safari tabbing-into-editor fix, and
    ProseMirror guards Chrome selection reset/jump on focus by restoring the
    editor selection from state.
  - Fresh Edytor failure on `http://localhost:5173/test/dom?scenario=basic&empty=last`:
    with a cached caret in the second paragraph at offset `2`, focusing an
    external button, pressing `Tab`, then typing `X` inserted into the first
    paragraph (`Xlead`) instead of the cached caret target (`noXte`).
  - This is materially different from the completed outside-focus selection
    clearing and blurred programmatic update cases because the browser owns the
    focus navigation into the editor and creates a misleading internal caret
    before typing.
  - Runtime fix: focus entering the editable root by keyboard queues a cached
    model-selection restore in a microtask. Pointer-origin focus is ignored so
    normal click placement still wins.
  - Added Playwright coverage proving Tab focus from an external control
    inserts into the cached second-paragraph caret across Chromium, Firefox,
    and WebKit.
  - In-app Browser verification on `http://localhost:5173/`: cleared the root
    route, typed `One`, toggled bold, typed `Two`, split with Enter, undid the
    split, and probed `abc  `. The visible editor stayed coherent with one
    `OneTwo` paragraph after undo and no double-space deletion.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1 -g "tabbing into the editor"`,
    `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`,
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1`,
    `pnpm lint`.
- 2026-05-24: completed live localhost managed-remount DOM duplication audit.
  - Fresh browser-backed reason to revisit a completed area: the user reported
    visible duplicated text on `http://localhost:5173/` after typing and mark
    toggles while the serialized value stayed correct.
  - Initial local Playwright probe against the running dev server showed
    `clear` + placeholder typing still serializes and renders one text node,
    so the active hypothesis is a timing-sensitive managed-node remount repair
    path rather than a basic text-operation defect.
  - Runtime fix: DOM mutation repair now distinguishes browser-created DOM
    corruption from Svelte-owned managed-node remounts by refusing to restore
    removed managed nodes when the same mutation added a managed replacement.
  - Added Playwright coverage that forces a Svelte-owned text remount and
    asserts the paragraph remains a single `Alpha beta` render across Chromium,
    Firefox, and WebKit.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, typed `One`, toggled bold, typed `Two`, pressed
    Enter, undid the split, and probed `abc  `. The live DOM showed one managed
    `OneTwo` text wrapper, one bold mark for `Two`, one paragraph restored
    after undo, and no visible duplicate content.
  - Verification:
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts --workers=1 -g "Svelte-owned text remount|mark remount"`,
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts tests/editor-dom/demo-route.spec.ts --workers=1`,
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts tests/editor-dom/input.spec.ts --workers=1 -g "stale DOM clones|auto-dot|does not delete preceding"`,
    `pnpm lint`.
- 2026-05-24: added peer-inspired native control selectionchange regression
  gate.
  - DeepWiki finding: Slate guards native `selectionchange` noise from appended
    or focused `<input>` and `<textarea>` controls because browser selection can
    move outside the editor without representing editor intent.
  - Existing Edytor coverage already had outside button blur; this slice adds
    the materially different native text-control case where the outside control
    owns its own text selection range.
  - Added Playwright coverage on `/test/dom?scenario=basic&empty=last` proving
    external `<input>` and `<textarea>` selections keep Edytor's cached
    block-spanning model selection and focused block paths unchanged.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, clicked the editable surface, typed `One`, used
    mark/Enter/undo/redo key paths through the live contenteditable root, and
    confirmed the visible editor text stayed a single `OneTwo` surface without
    stale DOM clone text.
  - Verification:
    `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1 -g "native control"`,
    `pnpm lint`.
- 2026-05-23: completed live localhost edit-history, attachment lifecycle, and
  browser-owned input target repair.
  - Fresh localhost symptom from the user: after prior cross-browser repair,
    typing, mark toggling, double-space, paragraph split, and undo on `/` could
    still look broken in the visible DOM even when the serialized value was
    cleaner.
  - Stale `Text` and `Block` destroy callbacks now only remove id maps and
    observers when they still own the current live model node. A stale keyed
    remount can no longer detach the replacement wrapper.
  - `clear()` now focuses the editor root and sets selection on the new empty
    paragraph text after the Svelte tick, so edit-history clearing no longer
    leaves the caret on a stale/root wrapper.
  - Non-cancelable collapsed `insertText` that is intentionally browser-owned
    now records its event-time text/offset target. The follow-up `input`
    reconciliation uses that target for selection restoration if the browser
    selection jumps before input delivery.
  - In-app Browser verification on `http://localhost:5173/` after reload:
    `clear`, click placeholder, type `One`, toggle bold, type `Two`, toggle
    bold off, press Enter, then `Mod+Z`. The DOM showed one managed `OneTwo`
    text node, one bold mark for `Two`, Enter created one empty paragraph, undo
    restored one paragraph, and `clear` returned to the visible placeholder.
    A fresh double-space probe produced `abc  ` without deleting prior text.
  - Verification:
    `pnpm exec vitest run src/tests/attachmentLifecycle.test.tsx`,
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts tests/editor-dom/demo-route.spec.ts --workers=1`,
    `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts --workers=1`,
    `pnpm test:dom`,
    `pnpm test:integration tests/editor-dom/input.spec.ts tests/editor-dom/mobile-beforeinput.spec.ts --workers=1 -g "replacement|browser-owned text insertion"`,
    `pnpm check`,
    `pnpm test -- --run`,
    `pnpm test:typecheck`,
    `pnpm test:dom:typecheck`,
    `pnpm lint`,
    `pnpm test:integration --workers=1`.
- 2026-05-23: completed root-route DOM duplication, mark-toggle clone, raw
  Enter, and CDP IME regression repair.
  - Fresh localhost symptom: typing in `/`, toggling a mark, or pressing Enter
    after edits could leave visible duplicated text or raw native structural
    characters in the DOM while the serialized value was cleaner.
  - `onBeforeInput` now treats raw newline/carriage-return `insertText`
    payloads as structural fallback signals and keeps suppression armed after
    model-owned non-cancelable mutation commands.
  - Suppressed observed DOM mutations now remove browser-created unmanaged
    wrappers and restore managed nodes without reconciling stale native text
    back into the model.
  - Composition start is idempotent, active-composition `insertText` commits
    exactly once, and idle CDP composition cancellation removes preview text
    when the browser sends no final cancellation event.
  - In-app Browser verification on `http://localhost:5173/` after reload and
    `clear`: click placeholder, type `One`, toggle bold, type `Two`, toggle
    bold off, press Enter, then `Mod+Z`. The DOM showed one managed text value
    `OneTwo`, Enter split into a new paragraph, undo restored one paragraph,
    and browser errors/warnings were empty.
  - Test harness note: WebKit desktop can intermittently stall `page.goto` in
    long sequential Playwright runs while the same route preflight succeeds and
    the assertion passes immediately on retry. Desktop WebKit now has one retry
    for navigation-only stalls; this preserves assertion coverage instead of
    skipping WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts tests/editor-dom/mobile-composition.spec.ts --workers=1`,
    `pnpm test:integration tests/editor-dom/beforeinput-fallback.spec.ts tests/editor-dom/mobile-beforeinput.spec.ts --workers=1 -g "parent-with-children|same-text range insertText|inline-spanning insertText|cross-block insertText|all-marked range insertText|mixed-mark range insertText|nested parent end"`,
    `pnpm test:integration --project=webkit --workers=1`,
    `pnpm test:integration --workers=1`,
    `pnpm test -- --run`,
    `pnpm test:dom`,
    `pnpm test:typecheck && pnpm test:dom:typecheck`,
    `pnpm check && pnpm lint && pnpm build`.
- 2026-05-23: completed live root-route DOM duplication regression repair.
  - Fresh localhost symptom: typing and mark toggling on `/` could visibly
    duplicate rendered text while the serialized value stayed cleaner. A later
    Enter/undo probe also showed how browser-owned structural mutations can
    drift away from the model when the input event sequence is incomplete.
  - Runtime now keeps explicit caret repair targets for model-owned insert,
    soft-break, paste, paragraph, and merge commands so the following native
    `input` event repairs to the intended live model target instead of a stale
    browser selection.
  - Suppressed native input now waits for delayed observed-mutation repair when
    needed, ignores drifted DOM selection while a structural key fallback is
    pending, and keeps observed mutations suppressed until the fallback command
    runs.
  - Selection restoration now falls back to a model-only collapsed state when
    the target text wrapper is temporarily missing or disconnected, which is
    required for WebKit-style node detachment during structural Backspace.
  - DOM mutation repair now detects native newline/carriage-return text
    mutations and routes them back through the structural paragraph/soft-break
    command path rather than reconciling them as literal text.
  - In-app Browser verification on `http://localhost:5173/` after reload and
    `clear`: typing `One`, toggling bold, and typing `Two` produced one visible
    block with one managed text value, `OneTwo`; no stale visible clone was
    present.
  - Historical caveat, superseded by the later raw Enter repair entry above:
    the Browser plugin's synthetic Enter key path still injected a raw `\r` in
    this page at this point, while the real Playwright keyboard path for `/`
    split the paragraph and undid it correctly.
  - Verification:
    `pnpm test:integration tests/editor-dom/beforeinput-fallback.spec.ts tests/editor-dom/demo-route.spec.ts tests/editor-dom/mobile-beforeinput.spec.ts --workers=1`.
- 2026-05-23: closed root-route typing, Enter, undo, and code-suggestion
  follow-up.
  - In-app Browser verification on `http://localhost:5173/` after clearing the
    demo route: typing `One` produced one managed text node with value `One`;
    the placeholder sibling remained only as `display: none`, so the visible
    `OneWrite something here ...` duplication was gone.
  - Added a root demo smoke regression for the exact cleared paragraph flow:
    click placeholder, type `One`, press Enter, then undo. The real Playwright
    keyboard path splits the paragraph and restores it with `Mod+Z`.
  - The in-app Browser keypress path is not treated as authoritative for Enter:
    it can deliver a soft line break where Playwright's real keyboard path
    dispatches the expected editor input sequence.
  - Fixed the code-suggestion Escape page error by making readonly suggestion
    text/inline-block wrappers expose the renderer fields/actions used by the
    shared text and inline-block components.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1 --project=chromium`,
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts --workers=1 --project=chromium`,
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1 --project=chromium`,
    `pnpm test:typecheck`, `pnpm build`.
- 2026-05-23: completed stale placeholder cleanup after native empty-block
  insertion.
  - Fresh localhost symptom: after clearing the root demo and typing into the
    empty paragraph, visible DOM could show `OneWrite something here ...` while
    the managed text wrapper contained only `One`.
  - Runtime now treats `Text.isEmpty` as the renderer source of truth for
    placeholder visibility instead of relying on `stringContent`, and stale
    placeholder cleanup also checks live DOM text for browser-owned mutations.
  - Added browser regressions for non-cancelable native `insertText` into an
    empty placeholder block and DOM text mutation without a matching input
    event. Both assert model text, managed text, and placeholder removal.
  - Browser audit note: the in-app Browser `cua.keypress` character path can
    mutate contenteditable text without delivering the same input/mutation
    sequence as Playwright/real keyboard typing; it still reproduced the visual
    stale-placeholder symptom, but the product gate is the real browser spec.
  - Follow-up discovered but not fixed in this slice:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts --workers=1 --project=chromium --grep "undoes and redoes a browser text insertion"`
    still restores redo content with caret offset `0` instead of `1`.
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts --workers=1 --project=chromium --grep "clears code suggestions"`
    also exposes a code-suggestion `TypeError: object is not a function`.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1 --project=chromium`,
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1 --project=chromium --grep "types into an empty first paragraph|removes placeholder after"`,
    `pnpm build`.
- 2026-05-23: completed native replacement/autocorrect inside marked text.
  - DeepWiki findings: Lexical model-owns `insertReplacementText` through
    controlled insertion; Slate disables native replacement in dirty/marked DOM
    and uses Android diff repair; Svedit allows native replacement only through
    text diffing and disables Chrome desktop autocorrect because native DOM
    replacement can corrupt keyed contenteditable structure.
  - Proven gaps before the runtime patches:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "native replacement rewrites marked DOM" --project=chromium --workers=1`
    produced `AlphaAlf`/`a` instead of bold `Alfa` plus plain ` beta`.
    The harder non-cancelable replacement path then produced duplicated model
    text `AlfaAlfa`.
  - Runtime now lets native `insertReplacementText` stay browser-owned only for
    collapsed text-local replacements. Range replacement is model-owned, so
    marked selections are replaced before the browser can rewrite nested mark
    wrapper DOM.
  - Non-cancelable `insertReplacementText` over unsafe ranges now receives the
    same suppressed-input repair window as unsafe non-cancelable `insertText`,
    so the later browser `input` event refreshes from the model instead of
    duplicating the model insertion.
  - Full input-suite verification also exposed stale placeholder drift after
    browser-owned typing in Firefox/WebKit. Text rendering now keys placeholder
    visibility directly to the live text content/version, and native input
    reconciliation removes stale placeholder nodes after model updates.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "replacement.*marked ranges" --workers=1`,
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "types into an empty first paragraph|replacement.*marked ranges" --workers=1`,
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1`,
    `pnpm test -- --run`, `pnpm test:dom`, `pnpm check`,
    `pnpm test:typecheck`, `pnpm test:dom:typecheck`, `pnpm lint`,
    `pnpm build`.
- 2026-05-23: completed mark-toggle DOM duplication and auto-dot corruption
  regression repair.
  - Fresh localhost symptom: toggling a mark on selected text visually
    duplicated managed content while the serialized value could remain
    plausible. Double-space auto-dot insertion could also delete too much
    preceding content.
  - Proven mark gap before the runtime patch: selecting `Alpha` in
    `/test/dom?scenario=marks` and pressing `Mod+B` changed the model to plain
    `Alpha beta`, but the visible paragraph could render stale cloned DOM like
    `Alpha betaAlpha`.
  - Runtime now refreshes the affected `Text` wrapper from the Yjs model after
    range mark formatting and mark removal, forcing stale browser-created mark
    DOM to be discarded.
  - Runtime now applies the auto-dot replacement path only when the insertion
    target is immediately after a space or an existing dot. A synthetic `. `
    insert after ordinary text now inserts `. ` without deleting the previous
    letter.
  - Added browser regressions for hotkey mark removal, native
    `formatBold`/beforeinput mark removal, and auto-dot insertion after
    non-space text across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts -g "stale DOM clones" --workers=1`,
    `pnpm test:integration tests/editor-dom/format-beforeinput.spec.ts -g "stale DOM clones" --workers=1`,
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "auto-dot" --workers=1`,
    `pnpm test --run src/tests/fixtures/model/operations.test.ts`,
    `pnpm check`, `pnpm test:typecheck`, `pnpm lint`.
- 2026-05-23: completed grapheme-safe collapsed deletion.
  - DeepWiki findings: Svedit explicitly maps UTF-16 DOM offsets to character
    offsets for multi-byte characters; Slate records caret/composition
    regressions around wrong browser offsets; ProseMirror treats DOM-change
    interpretation as a browser integration surface; Lexical uses model
    commands when native selection/node boundaries are unsafe.
  - Proven gap before the runtime patch:
    `pnpm test:integration tests/editor-dom/advanced-delete.spec.ts -g "target-range-free" --project=chromium --workers=1`.
    Target-range-free model-owned Backspace after `🚀` left `�`, and Delete
    before `e\u0301` left a dangling combining accent.
  - Runtime now makes collapsed single-character `Text.deleteText` delete one
    grapheme cluster using `Intl.Segmenter` when available, with a code-point
    fallback. The operation returns the actual deleted range so Backspace
    restores the caret to the real start offset.
  - Added `/test/dom?scenario=unicode` and browser coverage for real
    Backspace/Delete plus target-range-free synthetic beforeinput across emoji
    and combining-accent text.
  - Also hardened `restoreRelativePosition` for non-DOM model test
    environments by guarding access to the browser `Node` constructor.
  - Verification:
    `pnpm test:integration tests/editor-dom/advanced-delete.spec.ts --workers=1`,
    `pnpm test --run src/tests/fixtures/model/operations.test.ts`,
    `pnpm test --run src/tests/fixtures/model/history.test.ts`,
    `pnpm test:dom`, `pnpm test:typecheck`, `pnpm test:dom:typecheck`,
    `pnpm check`, `pnpm lint`.
- 2026-05-23: completed browser-cloned marked DOM cleanup after model-owned
  typing.
  - Proven gap before the runtime patch: typing in marked content could leave
    browser-cloned `[data-edytor-mark]` spans in the managed text wrapper. The
    serialized model was correct, but visible DOM text duplicated. WebKit also
    kept the empty-block placeholder after the model text became non-empty.
  - Runtime now refreshes the selected text DOM from the model after
    non-composition model-owned `beforeinput` commands, and suppressed input
    fallback repair also refreshes from the model instead of trusting cloned
    browser DOM.
  - Text attach now re-registers the wrapper and Yjs observer after a keyed
    remount, and placeholder visibility is keyed to the text DOM version so
    remounts correctly remove stale placeholders.
  - Added browser coverage for empty-first-paragraph typing DOM state and
    marked-content typing DOM state.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1`,
    `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts --workers=1`,
    `pnpm test:typecheck`, `pnpm test:dom:typecheck`, `pnpm lint`,
    `pnpm check`.
- 2026-05-23: completed demo-route visible DOM clone regression gate.
  - Fresh user report: typing in localhost could visually show accumulated text
    clones such as `OneeeOneeOne` while the serialized value stayed correct.
  - Current source did not reproduce the duplication after a clean browser load
    of `/`, but the previous regression only asserted the managed text wrapper
    and could miss stale siblings in the visible paragraph/block DOM.
  - Added a demo-route browser regression that types into the default nested
    bold `One` text and asserts both the managed text wrapper and its enclosing
    paragraph render exactly `Oneeee`.
  - No runtime patch was made because the stronger assertion stayed green across
    Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1`,
    `pnpm lint`.
- 2026-05-23: completed RTL/bidi horizontal navigation across inline atomic
  mention boundaries.
  - DeepWiki findings: Slate reverses ArrowLeft/ArrowRight movement in RTL and
    carries RTL selection-collapse fixes; ProseMirror uses bidi-aware
    `endOfTextblock`, `Selection.modify`, and Firefox `caretBidiLevel`
    preservation; Lexical has explicit RTL DecoratorNode navigation tests.
    Svedit does not expose explicit RTL docs in DeepWiki, but reinforces the
    same boundary class through Unicode offset and `contenteditable=false`
    island handling.
  - Proven gap before the runtime patch:
    `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts -g "RTL" --workers=1`
    failed in Firefox. The collapsed caret crossed the inline mention, but
    `Shift+ArrowLeft/Shift+ArrowRight` selected the adjacent RTL text/space
    instead of Edytor's atomic inline mention.
  - Runtime now model-owns only horizontal arrow movement at inline-block
    boundaries. It reads the effective CSS direction, maps visual left/right to
    logical forward/backward for RTL, and selects or crosses the mention without
    entering `contenteditable=false` DOM. Normal in-text arrow movement remains
    browser-native.
  - Added `/test/dom?scenario=rtlInline&dir=rtl` plus browser coverage for
    collapsed and shift-extended horizontal movement across Chromium, Firefox,
    and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts -g "RTL" --workers=1`,
    `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts --workers=1`,
    `pnpm check`, `pnpm lint`.
- 2026-05-23: completed real pointer-click coverage for non-editable inline
  atoms.
  - DeepWiki findings: Svedit calls out `contenteditable=false` islands as a
    source of extra cursor positions in Svelte editors. Lexical routes pointer
    and click selection around decorator/void nodes through editor selection
    commands. Slate and ProseMirror carry void/uneditable-node fixes for
    crashes, cursor placement, and selection consistency. The shared contract is
    that clicking an inline atom must not create a browser-owned caret inside
    non-editable DOM that the editor model cannot represent.
  - Added browser coverage using a real pointer click on the top-level mention
    atom in the second paragraph, then Backspace deletion through the model in
    Chromium, Firefox, and WebKit.
  - Current runtime already satisfied the corrected contract, so no runtime
    patch was made for this slice.
- 2026-05-23: completed blurred-editor programmatic model update selection
  resilience.
  - DeepWiki findings: Lexical has an e2e regression for programmatic updates on
    a blurred editor and uses `SKIP_DOM_SELECTION_TAG` so the DOM selection
    remains outside while internal selection survives. ProseMirror and Slate
    keep blurred internal selection and DOM selection reconciliation separate,
    restoring DOM selection only when focus returns to the editor.
  - Proven gap before the runtime patch:
    `pnpm test:integration tests/editor-dom/blurred-programmatic-update.spec.ts --workers=1`
    failed in Chromium, Firefox, and WebKit. A remote Yjs text update while an
    outside button was focused called selection restoration, moved DOM selection
    back into the editor, and left `document.activeElement` inside the editor.
  - Runtime now keeps remote/programmatic text reconciliation internal while the
    editor does not own focus. It updates the cached model offsets from the Yjs
    relative position without touching DOM selection, and still restores the DOM
    caret when the editor is focused.
  - Added browser coverage proving the external focus target and native
    selection remain outside the editor during the remote update, then explicit
    refocus/typing uses the cached caret in Chromium, Firefox, and WebKit.
- 2026-05-23: completed unsupported native `insertFromDrop` beforeinput
  coverage.
  - DeepWiki findings: Svedit prevents `insertFromDrop` outright when DnD is
    not a product feature. Slate and Lexical parse dropped data only when they
    intentionally support drop insertion. The shared editor-owned model
    contract is that native DOM drop insertion must never run uncontrolled; for
    Edytor's current non-DnD product boundary, `insertFromDrop` should prevent
    default and no-op.
  - Added browser coverage proving `insertFromDrop` prevents default, preserves
    document content, and preserves selection across Chromium, Firefox, and
    WebKit.
  - Current runtime already satisfied this contract, so no runtime patch was
    made.
- 2026-05-23: completed composition interrupted by native `formatUnderline`.
  - DeepWiki findings: Lexical and Slate treat formatting/toolbars during IME as
    fragile because composition state, pending format state, and selection UI
    can drift. The contract for Edytor is that native formatting during an
    active IME preview must not corrupt the final `compositionend` replacement
    or leak a newly-created pending mark into the committed IME text.
  - Proven gap before the runtime patch:
    `pnpm test:integration tests/editor-dom/composition-cancellation.spec.ts -g "formatUnderline" --workers=1`
    failed in Chromium, Firefox, and WebKit. Native `formatUnderline` created a
    pending mark during the active IME preview, and later final
    `compositionend.data = "に"` inherited that pending mark instead of keeping
    the plain preview formatting.
  - Runtime now derives final composition replacement marks from the existing
    preview segment before deleting it, so the final IME value preserves the
    preview's original marks and ignores pending marks created mid-composition.
- 2026-05-23: completed composition interrupted by `deleteContentBackward`
  coverage.
  - DeepWiki findings: ProseMirror detects DOM changes that look like Backspace
    during composition and routes them through editor commands while preserving
    composition state. Lexical has Android Chrome handling for
    `deleteContentBackward` during composition to avoid duplicate deletion and
    selection drift. The contract is that Backspace during active IME preview
    must not leave stale preview text, double-delete neighboring text, or lose
    the final `compositionend` value.
  - Added browser coverage for normal `deleteContentBackward` beforeinput while
    an IME preview is active, distinct from the existing `deleteCompositionText`
    and post-composition Backspace cases.
  - Current runtime already satisfied this contract in Chromium, Firefox, and
    WebKit, so no runtime patch was made.
- 2026-05-23: completed composition interrupted by `insertParagraph`.
  - DeepWiki findings: ProseMirror explicitly detects DOM changes that look
    like Enter/Backspace during composition and dispatches the corresponding
    model action while preserving composition semantics. Lexical clears or
    preserves composition keys intentionally around interrupting inputTypes and
    has regression coverage for IME interruption/order issues. The contract is
    that interrupting Enter must not leave stale preview text when later
    `compositionend` contains a different final IME value.
  - Proven gap before the runtime patch:
    `pnpm test:integration tests/editor-dom/composition-cancellation.spec.ts -g "insertParagraph" --workers=1`
    failed in Chromium, Firefox, and WebKit. Enter split the block while the IME
    preview was active, but later `compositionend.data = "に"` could no longer
    replace the preview, leaving stale model text `n`.
  - Runtime now preserves `compositionState` through non-composition
    beforeinput commands while an IME session is active, records the post-command
    caret target, and lets `compositionend` replace the preview text before
    restoring that caret.
- 2026-05-23: completed composition cancellation and `deleteCompositionText`
  beforeinput coverage.
  - DeepWiki findings: Lexical and Slate both treat composition cancellation and
    IME deletion as fragile browser-owned paths. Lexical has explicit handling
    for `deleteCompositionText`/composition events and Firefox/Safari ordering
    quirks; Slate has Android/composition manager logic so composition previews
    and final commits do not leave stale model text.
  - Added browser coverage for canceling a composition preview with empty
    `compositionend.data`, and for a `deleteCompositionText` beforeinput emitted
    while an IME preview is active before the final commit.
  - Current runtime already satisfied this contract in Chromium, Firefox, and
    WebKit, so no runtime patch was made.
- 2026-05-23: completed native format beforeinput inputTypes beyond
  bold/remove.
  - DeepWiki findings: Lexical dispatches native `formatBold`,
    `formatItalic`, and `formatUnderline` beforeinput commands through model
    formatting rather than allowing browser DOM mutation. Svedit similarly
    intercepts native format beforeinput values. The contract is that native
    format inputTypes must prevent browser formatting, mutate model mark state,
    and preserve editor selection.
  - Added browser coverage for `formatItalic`, `formatUnderline`,
    `formatStrikeThrough`, `formatSuperscript`, and `formatSubscript` over a
    multi-block range, plus collapsed `formatUnderline` pending-mark insertion.
  - Current runtime already satisfied this contract in Chromium, Firefox, and
    WebKit, so no runtime patch was made.
- 2026-05-23: completed invalid/out-of-editor `beforeinput.getTargetRanges()`
  defense.
  - DeepWiki findings: Lexical treats valid DOM target ranges as a selection
    resync source, but prevents controlled text insertion when the DOM target
    range diverges from the native selection in unsafe ways. Slate validates
    editable targets and converts WebKit/Android native target ranges to model
    ranges before preventing default and mutating the model. The shared
    contract is: valid in-editor target ranges can resync selection; invalid
    out-of-editor ranges must not mutate stale internal selection.
  - Proven gap before the runtime patch:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g "outside target range" --workers=1`
    failed in Chromium, Firefox, and WebKit. The event was prevented, but the
    model still mutated stale cached editor selection, turning `lead` into
    `lXead` even though the event target range pointed outside the editor.
  - Runtime now rejects out-of-editor beforeinput target ranges before creating
    the event-time input snapshot, prevents default when possible, and returns
    without running any model command.
- 2026-05-23: refreshed the status snapshot after the `insertTranspose` and
  mixed-mark IME composition slices were completed.
  - No runtime or test behavior changed in this ledger-only update.
  - Future continuation should start from those completed slices rather than
    the older Alt/Ctrl word-boundary navigation slice.
- 2026-05-23: completed IME composition replacement across mixed marked text.
  - DeepWiki findings: Lexical has explicit IME regressions for replacing
    multiple formatted text nodes, including Korean composition over formatted
    selections. Slate's Android input manager tracks pending diffs, actions, and
    selections during IME because Android and Safari can mutate DOM and
    selection out of order.
  - Proven gap before the runtime patch:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g mixed-mark --workers=1`
    failed in Chromium, Firefox, and WebKit because composition over a
    mixed-mark selection inserted the composed text with the left bold boundary,
    producing bold `Al한` instead of bold `Al` followed by plain `한ta`.
  - Runtime now computes composition insertion marks from the event-time
    selected range when composition starts, stores those marks in
    `compositionState`, and reuses them for every preview/final IME replacement.
- 2026-05-23: completed `insertTranspose` beforeinput routing.
  - DeepWiki findings: Lexical handles `insertTranspose` in its beforeinput
    path by using event-time target ranges and dispatching controlled text
    insertion when `event.data` is present. Slate prevents native transpose
    behavior when beforeinput is unreliable. ProseMirror is conservative with
    beforeinput generally, but still uses target ranges for browser-specific
    selection correction.
  - Proven gap before the runtime patch:
    `pnpm test:integration tests/editor-dom/input.spec.ts -g insertTranspose --workers=1`
    failed in Chromium, Firefox, and WebKit because Edytor prevented the
    transpose beforeinput event but did not run a model command, leaving `lead`
    unchanged instead of replacing target-range `ea` with `ae`.
  - Runtime now routes `insertTranspose` through the same controlled text
    insertion path as `insertText` and `insertReplacementText`, after
    `beforeinput.getTargetRanges()` has already synchronized the event-time
    model selection.
- 2026-05-23: completed Alt/Ctrl word-boundary navigation and selection around
  marks, emoji, and inline atomic mention blocks.
  - DeepWiki findings: Slate intercepts word movement with
    `Transforms.move(..., unit: 'word')`; Lexical has keyboard shortcut helpers
    and e2e coverage for Ctrl/Alt word movement, decorator-node movement, and
    browser-specific word-boundary behavior; ProseMirror treats navigation
    consistency around rich nodes as editor-owned.
  - Proven gap before the runtime patch:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g word-boundary --workers=1`
    failed because native word-left movement was not portable around inline
    mention boundaries and emoji. Firefox/WebKit skipped from the text after a
    mention to the previous word start instead of stopping at the atomic
    boundary; Chromium exposed a later race where shift-word selection could
    leave only the deletion target after native selectionchange.
  - Added a `wordNavigation` browser fixture containing plain text, bold-marked
    text, an inline mention, emoji, and trailing text.
  - Runtime now owns platform word keys: Alt/Option on macOS and Ctrl on
    non-mac browsers. Word movement uses Unicode-aware word characters, skips
    punctuation/emoji consistently, treats inline mentions as atomic waypoints,
    and selects inline mentions directly for shift-word selection instead of
    relying on a DOM boundary range.
  - Navigation hotkeys were split into `src/lib/hotkeys/navigation.ts` so
    `src/lib/hotkeys.ts` stays below the repo's hard file-size threshold.
- 2026-05-23: completed PageUp/PageDown and command-arrow document-boundary
  navigation across nested and void content.
  - DeepWiki findings: Lexical uses browser-specific helpers for
    editor-boundary navigation and Firefox PageUp/PageDown quirks; Slate and
    ProseMirror take ownership of navigation around void/selectable nodes rather
    than leaving complex document movement to the browser.
  - Proven gap before the runtime patch:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g document-boundary --workers=1`
    failed in Chromium, Firefox, and WebKit because PageUp left the caret in the
    nested block at offset 6 instead of moving to the editor's first editable
    text.
  - Added a mixed `navigation` browser fixture with root text, nested text, an
    image-like void block with editable caption, and final text.
  - Runtime now owns PageUp/PageDown, Shift+PageUp/PageDown,
    mod+ArrowUp/Down, and mod+Shift+ArrowUp/Down for text selections, moving or
    extending selection to the editor's first/last editable text.
- 2026-05-23: completed Home/End line-boundary navigation through rendered mark
  wrappers.
  - DeepWiki findings: Lexical normalizes Home/End/PageUp/PageDown and
    command-arrow movement with browser-specific helpers, including Firefox
    document-boundary quirks; Slate intercepts Home/End equivalents as
    line-unit selection movement.
  - Proven gap before the runtime patch:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "Home and End" --workers=1`
    failed in Chromium, Firefox, and WebKit. Chromium moved to the logical text
    end through native behavior, while Firefox and WebKit left the caret
    unchanged, proving that Home/End could not stay browser-owned.
  - Runtime now owns `Home`, `End`, `Shift+Home`, and `Shift+End` in the default
    hotkey layer, moving or extending selection to the current block's logical
    first/last editable text boundary.
  - Added a browser regression for marked text that asserts logical offsets
    after Home/End and coherent ranges after Shift+Home/End across Chromium,
    Firefox, and WebKit.
- 2026-05-23: completed vertical ArrowUp/ArrowDown navigation coverage around
  image-like void blocks.
  - DeepWiki findings: ProseMirror and Lexical treat vertical navigation near
    uneditable/decorator nodes as browser-sensitive. ProseMirror has Safari and
    Chrome workarounds for arrow motion near uneditable nodes and selectable
    block nodes; Lexical treats decorator/image-like nodes as selectable units
    and keeps editable captions as valid targets.
  - Added a browser regression that starts in the paragraph after an image-like
    void block, presses ArrowUp, and accepts only editor-valid outcomes: caret
    in the editable caption or atomic void-block selection. It explicitly
    rejects focus drift into the figure button, input, or image body, then
    presses ArrowDown and asserts the caret returns to the following paragraph.
  - Current Edytor runtime already satisfied this contract in Chromium, Firefox,
    and WebKit, so no runtime patch was made.
- 2026-05-23: added the resume checklist after the explicit request to keep
  track in Markdown and avoid repeating completed features after compaction.
  - No runtime or test behavior changed in this ledger-only update.
  - The required workflow is now: read this file, search for the proposed
    behavior, mark one active slice, prove the browser gap, then patch.
  - Paste, clipboard, composition, inline-atomic navigation, advanced delete,
    missing-`beforeinput` fallback, and void-body triple-click work must not be
    reopened without a materially different browser-backed failure.
- 2026-05-23: completed triple-click selection on non-editable void block
  bodies.
  - DeepWiki findings: Slate and Lexical treat triple-click around
    void/decorator nodes as a first-class browser selection quirk. Native
    selection can overhang into adjacent text, select only the nearest editable
    text, or crash at the editor root, so they resolve the nearest block and
    select it through the editor model.
  - Proven gap before the runtime patch:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "void body" --workers=1`
    failed the new triple-click regression in Chromium, Firefox, and WebKit
    because clicking the image body produced a non-collapsed caption text range
    with no selected block.
  - Added a browser regression that triple-clicks the non-editable image body,
    asserts the image block is selected atomically, presses Backspace, and
    asserts the void block is deleted with the caret restored to the survivor
    paragraph.
  - Runtime now detects triple-click targets inside void blocks but outside
    editable text, clears native DOM selection, and selects the void block
    through `selection.selectBlocks(...)`.
- 2026-05-23: completed WebKit post-composition Backspace with explicit user
  selection.
  - DeepWiki findings: Lexical has a WebKit regression for Safari's
    `compositionend`/`keydown` ordering where the immediate post-composition
    Backspace guard must not swallow a Backspace after the user has selected
    content. The collapsed-caret synthetic Backspace remains browser-specific,
    but explicit selections are real user intent.
  - Proven gap before the runtime patch:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "selected content" --workers=1`
    passed in Chromium and Firefox, but failed in WebKit because Backspace left
    the selected composed text unchanged.
  - Added a browser regression that composes text, selects the composed block
    with `mod+a`, presses Backspace, and asserts deletion plus collapsed caret
    aftermath.
  - Runtime now only ignores the immediate WebKit post-composition Backspace
    when there is no explicit text, block, or inline-block selection. Existing
    collapsed-caret WebKit guard behavior remains covered.
- 2026-05-23: completed advanced delete `beforeinput` routing.
  - DeepWiki findings: Slate and Lexical model-own advanced delete inputTypes.
    `deleteWordBackward`/`deleteWordForward` map to word deletion,
    `deleteSoftLine*`/`deleteHardLine*` map to line deletion, and
    `deleteByCut`/`deleteByDrag`/`deleteByComposition` delete the current
    fragment. They prevent default instead of trusting browser DOM mutation,
    with keydown only as a fallback when `beforeinput` is unavailable.
  - Proven gap before the runtime patch:
    `pnpm test:integration tests/editor-dom/advanced-delete.spec.ts --workers=1`
    failed 15/15 because Edytor prevented default for these inputTypes but ran
    no model command, leaving content unchanged.
  - Added browser regressions across Chromium, Firefox, and WebKit for
    `deleteWordBackward`, `deleteWordForward`, `deleteSoftLineBackward`,
    `deleteSoftLineForward`, `deleteHardLineBackward`,
    `deleteHardLineForward`, `deleteByCut`, `deleteByDrag`, and
    `deleteByComposition` using `beforeinput.getTargetRanges()`.
  - Added fallback coverage for `deleteWordBackward` when target ranges are
    unavailable.
  - Runtime now routes advanced delete inputTypes through model deletion and
    falls back to same-text word deletion or block-line deletion when browsers
    do not provide target ranges.
- 2026-05-23: confirmed this worklog as the durable anti-repeat tracker after
  the explicit user request to stop reworking the same feature after
  compaction.
  - No runtime or test behavior changed in this ledger-only update.
  - Future cross-browser work must start by checking this file, then updating
    `Active Slice` before edits.
  - Reopening paste, clipboard, composition, inline-atomic navigation, or
    missing-`beforeinput` fallback requires a fresh browser-backed failure that
    is not already covered below.
- 2026-05-23: completed horizontal arrow navigation and shift-selection across
  inline atomic mention boundaries.
  - DeepWiki findings: ProseMirror, Lexical, and Slate all treat horizontal
    selection across non-text inline/void/decorator nodes as unreliable browser
    behavior. ProseMirror explicitly works around extra cursor positions and bad
    shift-selection across non-text inline nodes; Lexical and Slate move through
    atomic/void nodes with editor commands instead of trusting native selection.
  - Added browser regressions for plain ArrowRight/ArrowLeft crossing a mention
    and Shift+ArrowRight/Shift+ArrowLeft atomically selecting a mention in
    Chromium, Firefox, and WebKit.
  - Runtime now recognizes a selection range from the end of one text part to
    the start of the next text part with exactly one inline block between as an
    atomic inline selection. Backspace/Delete then removes the mention through
    the existing selected-inline-block command path.
- 2026-05-23: completed mobile non-cancelable `insertText` across mark/style
  boundaries.
  - Added browser regressions for all-marked range replacement and mixed-mark
    range replacement in mobile Chromium and mobile WebKit.
  - Runtime now computes replacement insertion marks from the event-time
    selected range before deleting the selection.
  - Common marks are preserved; mixed marks insert plain text instead of
    inheriting the left or right browser/Yjs formatting boundary.
  - Suppressed native text drift can force a `Text` component remount through
    `refreshFromModel()` so browser-created unmanaged marked-text DOM is removed.
  - Firefox `keyboard.insertText()` into empty placeholder-backed paragraphs is
    covered through the composition-shaped path: non-cancelable
    `insertCompositionText` is model-owned, and placeholder clicks focus the
    editor root before setting the caret.
- 2026-05-23: initially recorded the in-progress browser slice after compaction.
  - The ledger gained a fast coverage index so future work can check completed,
    active, and out-of-scope areas without rereading the full history.
  - This entry was superseded the same day by the completed mark/style-boundary
    entry above.
- 2026-05-23: tightened the worklog contract itself after compaction.
  - At the time, the active browser slice was mobile non-cancelable
    `insertText` over expanded selections.
  - No runtime or test behavior was changed in this ledger-only update.
  - Future agents must update this file before touching another browser slice,
    so completed clipboard, composition, selection, and fallback coverage is not
    reimplemented accidentally.

- 2026-05-24: completed native double-click word selection follow-up
  mutations.
  - DeepWiki findings: Slate has Firefox-specific double-click mark-selection
    coverage for browser-overinclusive word selection, and Lexical/ProseMirror
    keep formatting and replacement after native selection routed through
    model-owned commands.
  - Added browser coverage for double-clicking a word, then applying bold, and
    for double-clicking a word, then typing replacement. Both cases assert
    serialized model state, selection aftermath, and visible text so stale DOM
    clones cannot hide behind a correct value.
  - Runtime result: no production patch was needed. Existing selection mapping
    and text/mark operations already apply follow-up mutations to the intended
    word only.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts tests/editor-dom/input.spec.ts -g "double-click" --workers=1`
    passed 6 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/hotkeys.spec.ts tests/editor-dom/input.spec.ts --workers=1`
    passed 162 tests across Chromium, Firefox, and WebKit.
  - Verification: live in-app browser smoke on `http://localhost:5173/` passed
    clear, typing, mark toggle, soft break, Backspace, undo/redo, Enter split,
    and double-click replacement. Final visible text nodes were `OneBold\nB`
    and `X`, with no obvious duplication and no page console errors. Browser
    screenshot capture timed out, but the DOM/model smoke itself completed.
  - Verification: full `pnpm test:integration --workers=1` exited
    successfully with 751 passed, 9 skipped, and 3 WebKit navigation-timeout
    retries. Focused rerun of the three retrying WebKit cases passed.
  - Verification: `pnpm test -- --run` passed 268 tests,
    `pnpm test:dom` passed 90 tests, `pnpm test:typecheck`,
    `pnpm test:dom:typecheck`, `pnpm check`, `pnpm lint`, and `pnpm build`
    passed.

- 2026-05-24: completed post-composition multi-block selection deletion.
  - DeepWiki findings: Lexical has
    `packages/lexical-playground/__tests__/regression/8153-safari-ime-delete-selection.spec.mjs`
    coverage for Safari IME composition followed by explicit user selection and
    Backspace deletion. The editor invariant is that the immediate
    post-composition Backspace guard may protect collapsed synthetic keydowns,
    but must not swallow a user-created expanded selection.
  - Proven gap before runtime patch:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "selected multiple blocks" --workers=1`
    initially deleted the content but left the caret pointed at a removed block
    in Chromium and WebKit.
  - Runtime fix: `deleteContentWithinSelection` now computes a live fallback
    text target before removing selected blocks. `deleteContentBackward` and
    `deleteContentForward` now restore selection to that returned live target
    instead of blindly reusing the stale event-time first selected text.
  - Added browser coverage that composes text, creates a multi-block selection
    after `compositionend`, presses Backspace, and asserts the selected blocks
    are deleted with the caret at the end of the surviving previous block.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "selected multiple blocks" --workers=1`
    passed 3 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/composition.spec.ts --workers=1`
    passed 75 tests across Chromium, Firefox, and WebKit.
  - Verification:
    `pnpm test:integration tests/editor-dom/input.spec.ts tests/editor-dom/hotkeys.spec.ts --workers=1`
    passed 162 tests across Chromium, Firefox, and WebKit.
  - Verification: `pnpm test -- --run` passed 268 tests,
    `pnpm test:dom` passed 90 tests, `pnpm test:typecheck`,
    `pnpm test:dom:typecheck`, `pnpm check`, `pnpm lint`, and `pnpm build`
    passed.
  - Full-run note: `pnpm test:integration --workers=1` did not complete green
    in this run. It reached 528 passed and 8 skipped, then the preview server
    stopped responding during the WebKit project, causing a navigation cascade
    into WebKit and mobile projects. The single Firefox triple-click failure
    from that run passed on focused rerun, and the new WebKit regression passed
    on focused rerun.
  - Focused rerun:
    `pnpm test:integration tests/editor-dom/selection.spec.ts -g "replaces only the clicked block after a browser triple-click selection" --project=firefox --workers=1`
    passed 1 test.
  - Focused rerun:
    `pnpm test:integration tests/editor-dom/composition.spec.ts -g "does not ignore Backspace after compositionend when the user selected multiple blocks" --project=webkit --workers=1`
    passed 1 test.
  - Focused rerun:
    `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts -g "keeps cross-block insertText model-owned when mobile beforeinput is non-cancelable" --project=mobile-chromium --workers=1`
    passed 1 test.
  - Focused rerun:
    `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "splits a cleared paragraph on enter and restores it with undo" --project=webkit --workers=1`
    passed 1 test after clearing a generated Svelte package temp directory
    left by two accidentally parallel Playwright web-server starts.
  - In-app Browser verification on `http://localhost:5173/`: reloaded the root
    route, cleared the editor, clicked the empty placeholder, typed `One`,
    toggled bold on selected text, cleared again, typed `Hello  `, checked that
    the text node remained `Hello  ` without deleting previous content, cleared
    again, typed `One`, pressed real `Enter`, typed `Two`, verified two blocks
    with text nodes `One` and `Two`, then verified undo/redo split history and
    no page console errors. The first attempted direct key name `ENTER` was an
    automation mistake and did not dispatch Enter; the actual `Enter` key path
    split correctly.

## Active Slice

- None.

## Current Rule

- Work on cross-browser behavior only when it improves one of these lanes:
  missing or unreliable `beforeinput`, structural key fallback, IME composition,
  selection resilience, DOM drift repair, browser-specific regression gates.
- Do not reopen clipboard or HTML paste hardening unless a browser regression
  directly proves that clipboard/paste behavior is the failing cross-browser
  boundary.
- Real browser evidence matters more than model fixtures for this track.
  Prefer Playwright specs across Chromium, Firefox, and WebKit for native
  `contenteditable`, selection, `beforeinput`, `input`, and composition behavior.

## Peer-Editor Findings Already Applied

- Slate: uses model-owned commands for structural keys when `beforeinput` is
  unavailable, Android-specific DOM/input reconciliation, and target-range
  handling for WebKit/ShadowRoot quirks.
- ProseMirror: treats browser DOM mutation as an integration surface through
  DOM observation and DOM-change interpretation, with browser-specific repairs
  for Enter/Backspace/Delete drift.
- Lexical: routes keydown through semantic commands, reconciles browser text DOM
  mutations through input paths, and has heavy IME regression coverage.
- Svedit: keeps structural keys model-owned in keydown and uses text diffing for
  native text input reconciliation.
- Slate native control follow-up: external native `<input>`/`<textarea>`
  `selectionchange` events must not be interpreted as editor selections.
- Inline/atomic deletion follow-up from DeepWiki: Slate, Lexical, and
  ProseMirror treat selections crossing void/decorator/atomic nodes as semantic
  editor deletions. The practical browser test shape is text + inline atomic +
  text, keydown without reliable `beforeinput`, browser DOM drift, then assert
  model deletion and DOM repair.
- Horizontal inline atomic selection follow-up from DeepWiki: ProseMirror
  works around extra cursor positions and broken Shift+Arrow selection across
  non-text inline nodes; Lexical and Slate prevent native movement around
  decorator/void nodes and move the selection with editor commands.
- Browser-expectation policy follow-up from DeepWiki: Lexical, Slate, and
  ProseMirror keep browser-specific skips, expected values, and compatibility
  branches explicit, local to the browser-owned behavior, and documented with
  the engine/capability reason.
- Mobile history/composition follow-up from DeepWiki: Slate and Lexical keep
  undo/redo history model-owned, restore selection snapshots explicitly, and
  then require the next IME commit to use the restored selection rather than
  stale DOM or stale composition state. ProseMirror/Svedit reinforce the same
  idea from the DOM-observer/diff side: after history changes, reconcile DOM and
  selection before trusting the next browser input.
- Mobile selected-structure deletion follow-up from DeepWiki: Slate and Lexical
  route selected block/fragment deletion through model commands on unreliable
  `beforeinput`, then repair browser-created DOM drift and restore a caret to a
  live fallback block.
- Mobile soft-break follow-up from DeepWiki: Lexical and Slate route
  `insertLineBreak`/Shift+Enter through model-owned commands on Android and
  unreliable `beforeinput`, preserve mark context through soft-break insertion,
  and repair browser-created `<br>` drift. ProseMirror/Svedit add the DOM side:
  normalize bogus `<br>` nodes and map inline-boundary carets back to editable
  text positions.
- Mobile IME mark/inline follow-up from DeepWiki: composition must keep the
  active mark/leaf context and must map element-node carets around inline atomic
  nodes back to editable text before applying the committed IME data.
- Mobile insertText selection follow-up from DeepWiki: Lexical prevents native
  insertText when a range spans multiple nodes, non-text/decorator nodes, token
  or segmented nodes, dirty nodes, DOM-selection mismatches, or format/style
  changes. Slate treats expanded-selection insertText as unsafe for native
  mutation and routes it through model replacement.
- Mobile insertText implementation follow-up: the safe browser-owned path in
  Edytor is now collapsed text-local non-cancelable `insertText` only. Expanded
  selections run through the model first, then the following native `input`
  drift is repaired.
- WebKit post-composition selection deletion follow-up from DeepWiki: Safari can
  emit `compositionend` before a later Backspace keydown, so editors guard the
  synthetic collapsed-caret Backspace while still allowing an explicit
  user-created selection to delete normally.
- Void/decorator triple-click follow-up from DeepWiki: Slate and Lexical treat
  triple-click around void/decorator content as model-owned block selection,
  because native selection often lands in the nearest editable text instead of
  representing the non-editable block.
- Focus/refocus follow-up from DeepWiki: ProseMirror, Slate, and Lexical
  restore or reconcile the editor selection during root focus because browser
  `selectionchange` is not reliable enough to be the only signal before the next
  input.
- Structural history follow-up from DeepWiki: Lexical tests paragraph creation,
  undo, and redo as a browser-visible history contract, including selection
  restoration. Edytor should keep structural redo coverage separate from plain
  text redo.
- Code island follow-up from DeepWiki: Lexical and ProseMirror make code or
  isolating blocks command-owned at their Backspace/Delete/Tab/Enter boundaries
  because native contenteditable can move selection into tooling or merge
  surrounding content through the island.
- Firefox composition follow-up from DeepWiki: Lexical treats Firefox
  `compositionend` before the final `input` as a first-class event-order quirk
  and delays finalization so the later input cannot double-insert committed IME
  text or leave selection offsets wrong.
- Shift-click selection follow-up from DeepWiki: Lexical and ProseMirror treat
  Shift-based range extension across decorators/uneditable nodes as an
  editor-selection concern; the browser DOM range must be mapped back to one
  semantic model range before a formatting or insertion command runs.

## Completed Edytor Coverage

- Chromium, Firefox, and WebKit browser projects are active in Playwright.
- Root-route text insertion undo/redo now preserves inline content on `/`.
  Focused real-click coverage clicks the first `hello` text, types `U`, undoes,
  and redoes, then verifies the visible text leaves remain `hUello`, `World`,
  `Prout`, `One`, `Two`, and the code line, with both top-level mention atoms
  still present. The failing proof reproduced the audit gap after redo as
  `['hUello', 'One', 'Two', '\t\tconsole.log("hello")']`. The runtime fix is
  scoped to keyboard history hotkeys: `mod+z` and `mod+shift+z` now suppress and
  repair the browser's following native history DOM drift before the model-owned
  Yjs history state is rendered back. Verification:
  `lsof -ti :4173 | xargs -r kill && pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "preserves root inline content" --workers=1`,
  `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "undo|redo|history" --workers=1`,
  and
  `pnpm test:integration tests/editor-dom/hotkeys.spec.ts tests/editor-dom/input.spec.ts -g "undoes and redoes a browser text insertion|undoes and redoes a paragraph split|routes native history beforeinput undo and redo through editor history|routes input-only native history undo through editor history|routes unfocused input-only native history through editor history" --workers=1`
  all passed across Chromium, Firefox, and WebKit. `pnpm check` passed.
  `pnpm lint` passed after formatting
  `docs/manual-browser-input-audit-2026-06-19.md`.
- Root-route selection routing after real locator-backed clicks into non-first
  editable text is quarantined. On `/`, typing after clicks into `World`,
  nested `One`, nested `Two`, and the code line mutates only the clicked text
  leaf, and `End` then `Enter` after clicking nested `One` splits the nested
  child block instead of the parent paragraph.
- Root-route visible DOM duplication regressions now have both automated and
  live-localhost evidence: typing in a cleared paragraph, typing through a bold
  mark toggle, dot-space insertion, double-space insertion, undo, and redo keep
  one managed text node and do not clone visible content.
- Dynamic readonly transitions now synchronize the component prop into the live
  `Edytor.readonly` runtime state, so stale selections cannot mutate the model
  after the root flips to `contenteditable=false`.
- Native `formatRemove` target ranges now route through the model over
  mixed-mark selections that span inline atoms, preserving the atom and restoring
  the event-time selected range across Chromium, Firefox, and WebKit.
- Real browser drag-created ranges across inline mention atoms now also have
  mark-formatting coverage: the same text + mention + text selection can be
  bolded through the hotkey path while preserving the mention atom, selected
  model range, and non-duplicated managed DOM across Chromium, Firefox, and
  WebKit.
- Partial inside/outside `beforeinput.getTargetRanges()` values are treated as
  invalid browser input: both directions are prevented without mutating stale
  cached editor selection across Chromium, Firefox, and WebKit.
- Cross-text `deleteContentForward` target ranges at block boundaries are
  treated as unsafe browser input: the event is prevented, the range is not
  trusted, and structural Delete still merges the next block through the model
  command across Chromium, Firefox, and WebKit.
- Selected-block history redo now updates the model selection synchronously to
  the live fallback block before asynchronous DOM selection restoration, so
  mounted DOM tests do not observe stale selection pointed at the deleted block.
- Selected-block pointer collapse now sets the collapsed model caret
  synchronously before DOM restoration, so a real click inside selected block
  content clears block selection across Chromium, Firefox, and WebKit.
- Clipboard paste now reconciles a stale selected-block model state with a live
  collapsed DOM caret before inserting internal fragments, so copying a nested
  selected block and pasting at a later caret inserts a regenerated-ID subtree at
  the caret target across Chromium, Firefox, and WebKit.
- Browser triple-click text replacement now preserves the intended clicked-block
  model range before late native selectionchange can expand the range into the
  following block.
- Synthetic inline mention selection now establishes the model selected-inline
  state before clearing native DOM selection, and the ignored selectionchange
  path preserves selected inline atoms instead of clearing the selected set while
  leaving only the deletion target.
- Composition finalization uses `compositionend.data` as authoritative when it
  differs from intermediate `insertCompositionText`.
- Composition coverage includes:
  - empty-block placeholder hidden during active composition and restored after
    cancellation
  - empty paragraph commit
  - non-cancelable composition beforeinput
  - final `insertFromComposition`
  - intermediate replacement
  - adjacent identical committed text
  - compositionend-only commit
  - same-block selection replacement
  - cross-block selection replacement for both preview-beforeinput and
    compositionend-only commit paths
  - compositionend-only commit anchored to the composition-start target after
    active-composition selectionchange drift
  - inline mention boundaries
  - marked text
  - rendered mark-wrapper boundary
  - forward delete during active composition
  - stale blurred selection
  - dangling composition after blur without a `compositionend` event
  - delayed compositionend data ignored after blur and dangling composition
    cleanup
  - blurred-editor programmatic/remote text update focus preservation
  - late post-composition input repair
  - mobile Chromium CDP IME smoke
- ShadowRoot selection coverage includes:
  - `Selection.getComposedRanges()`
  - stale global selection
  - `beforeinput.getTargetRanges()` as event-time source
  - shadow-root composition target ranges
  - backward anchor/focus direction preservation
- Focus/refocus selection coverage includes:
  - route load does not focus the editor or create an editor-native selection
    before user interaction
  - multiple editor roots on the same document do not leak document-level
    selectionchange or keydown handling across instances
  - keyboard Tab focus into the editor restores cached model selection before
    typing
  - direct programmatic root focus restores cached model selection before typing
  - internal programmatic focus during `clear()` restores a focused empty-block
    caret without scrolling the page
  - blurred programmatic/remote text updates preserve external focus and cached
    caret state
  - vertical ArrowUp inside code islands keeps the code-line selection live for
    the next typed edit
- Text/native DOM drift coverage includes:
  - missing-`beforeinput` text insertion
  - whole text-wrapper replacement
  - unmanaged node removal
  - unmanaged `<br>` cleanup
  - removed managed text/block restoration
  - removed trailing newline marker restoration when the owning model text
    still ends with a newline, including consecutive trailing soft breaks
  - non-native `contenteditable=false` island selection remapping before stale
    Backspace/Delete can mutate the previous model selection
- Structural browser fallback coverage includes:
  - real browser Enter split in the middle of a paragraph
  - parent-with-children Enter behavior
  - real browser Backspace backward merge
  - real browser Backspace backward merge when the previous block contains
    inline mention atoms, including merge-boundary caret restoration
  - real browser Delete forward merge
  - missing-`beforeinput` Backspace at a block boundary
  - missing-`beforeinput` Delete at a block boundary
  - missing-`beforeinput` Enter at parent-with-children end
  - missing-`beforeinput` Shift+Enter soft break with browser-created `<br>`
    drift
  - real-browser repeated Shift+Enter at the text end keeps the trailing
    soft-break marker mapped to the full model text end before the next typed
    character
  - same-text native range replacement spanning a model soft break, including
    visible DOM text and collapsed caret aftermath after typing
  - reverse native range mark formatting across a model soft break, including
    backward DOM selection direction restoration after marked DOM remount
  - missing-`beforeinput` selected-block Backspace/Delete with post-keydown
    DOM drift that removes a live survivor block
  - real-browser document-level block selection deletion after cycling `mod+a`
    through every root block, including caret restoration to the normalized
    empty fallback paragraph
  - real-browser Escape collapse from selected-block state clears
    `selectedBlocks`, restores a live text caret in the selected block, and lets
    the next typed character mutate that block
  - missing-`beforeinput` forward modifier word deletion reconciles the
    browser-owned `input.deleteWordForward` DOM diff and restores the caret at
    the deletion start
  - missing-`beforeinput` Backspace/Delete for a text range spanning an inline
    mention, with browser-mutated text and removed inline DOM
  - plain ArrowRight/ArrowLeft crossing inline mentions without entering atomic
    DOM
  - Shift+ArrowRight/Shift+ArrowLeft selecting inline mentions atomically and
    deleting them through the selected-inline-block command path
  - real pointer clicks on non-editable inline mention atoms select and delete
    the atom through the model
  - off-edge pointer clicks just after inline mention atoms map to trailing
    editable text before the next typed insertion
  - real pointer clicks just before already selected inline mention atoms clear
    selected-inline deletion state and map to the preceding editable text
  - secondary-click/contextmenu inside editable text maps the next keyboard edit
    to the browser's secondary-click selection target rather than a stale
    cached model caret, with Firefox caret insertion and Chromium/WebKit
    clicked-word replacement documented separately
  - real browser drag-created ranges across inline mention atoms restore a
    semantic model range before Backspace/Delete, including Firefox's collapsed
    inline-atom selection quirk
  - interrupted mouse drag released outside the editor cannot corrupt the next
    click-and-type edit or leave selected inline-atom state behind
  - real Backspace repeatedly deleting all text immediately before an inline
    mention preserves the atom/trailing text and leaves no bogus `<br>` DOM
  - real Shift+click range extension from marked text into text after an inline
    mention maps to a semantic model range before typed replacement
  - collapsed element-node `beforeinput.getTargetRanges()` immediately before
    or after inline mention atoms normalize to the neighboring editable text
    before model-owned `insertText`
  - browser-native `insertReplacementText` target ranges spanning text, inline
    mention, and following text are model-owned, remove the mention atomically,
    normalize content to one text node, and restore the caret after the
    replacement
  - post-composition Backspace after an explicit cross-block selection spanning
    inline mention atoms deletes the selected range and restores the caret in
    the surviving inline-adjacent text
  - ArrowUp/ArrowDown around image-like void blocks stays on editable caption
    text or atomic block selection and does not enter the non-editable body
  - Home/End and Shift+Home/End are model-owned line-boundary moves through the
    current block's logical text, including rendered mark wrappers
  - PageUp/PageDown and command-arrow document-boundary keys are model-owned
    across nested and void content
  - Alt/Ctrl word-boundary movement is model-owned across marked text, emoji,
    and inline atomic mention boundaries
  - Shift+Alt/Ctrl word-boundary selection treats inline mentions as atomic
    selections instead of browser DOM text ranges
  - `insertTranspose` beforeinput target ranges replace the model range with
    event data instead of being prevented as a no-op
  - IME composition across mixed marked text applies only common selected marks,
    matching the mixed-mark insertion policy
  - out-of-editor beforeinput target ranges are ignored before snapshotting so
    stale cached editor selection is not mutated
  - native format beforeinput values beyond bold/remove mutate model marks and
    preserve selection instead of relying on browser formatting
  - reverse native selection direction is preserved after model-owned mark
    formatting
  - reverse native selection direction is preserved after history undo/redo of
    model-owned mark formatting
  - triple-click text replacement is model-owned when the browser reports a
    collapsed insertion target after an expanded model selection
  - split-paragraph undo leaves exactly one visible placeholder in the empty
    survivor block
  - composition cancellation removes IME preview text when final
    `compositionend.data` is empty
  - `deleteCompositionText` remains browser-owned during active IME preview and
    final composition commit replaces the preview cleanly
  - `insertParagraph` during active composition keeps the IME preview replaceable
    by later `compositionend.data` while preserving the post-Enter caret
  - normal `deleteContentBackward` during active composition does not corrupt
    the later final IME commit
  - active-composition editor keydowns/hotkeys are ignored until the final IME
    commit, including `mod+b`, Enter, Tab, and undo
  - canceled composition previews do not create noisy undo entries; undo skips
    the canceled preview and targets the previous committed text insertion
  - collapsed Backspace/Delete deletes emoji and combining-accent grapheme
    clusters whole, including when `beforeinput.getTargetRanges()` is absent
  - native `formatUnderline` during active composition does not leak a pending
    mark into the later final IME commit
  - unsupported native `insertFromDrop` is prevented and leaves model/selection
    unchanged
  - mobile non-cancelable Backspace/Delete block-boundary merge repair
  - mobile non-cancelable Enter native paragraph drift repair
  - mobile non-cancelable soft-break `<br>` drift repair
  - mobile non-cancelable inline mention boundary deletion
  - real-browser paragraph split undo/redo with selection restoration
  - unfocused input-only native history sync after focus moved to an outside
    native input
  - real-browser code island Backspace/Delete edge guards
- Runtime fixes already in place:
  - structural keydown fallback schedules a delayed synthetic model command
  - real `beforeinput` cancels the delayed keydown fallback
  - fallback stores and restores keydown-time selection before running the model
    command
  - native input fallback suppression prevents browser DOM merge drift from
    becoming model content
  - suppressed mutation batches are retried after suppression instead of being
    discarded, so unmanaged browser-created structural nodes can still be
    removed
  - DOM repair no longer restores removed managed wrappers whose Yjs model object
    is already deleted
  - selected-block deletion clears block selection before removal and retries
    caret restoration after DOM repair
- Browser-specific expectations are now reason-labelled through
  `tests/editor-dom/browserExpectations.ts`. Existing Chromium clipboard
  permission, Firefox multi-range, ShadowRoot selection, Chromium CDP IME,
  Android Chromium fallback, and WebKit post-composition Backspace branches now
  use explicit quirk IDs instead of raw `browserName` conditionals.
- Mobile IME after history restoration is covered in Chromium and WebKit:
  composition after `historyUndo` inserts at the restored empty-block caret, and
  composition after `historyRedo` appends at the restored end-of-text caret.
- Mobile selected-block Backspace/Delete is covered in Chromium and WebKit for
  non-cancelable `deleteContentBackward` and `deleteContentForward` with
  browser-created DOM survivor removal. Selected-block deletion now stays
  model-owned and repairs the removed live survivor block.
- Runtime fix: non-cancelable delete `beforeinput` is no longer treated as
  text-local browser-owned deletion when `selection.selectedBlocks` is non-empty.
- Mobile soft-break coverage now includes Chromium and WebKit non-cancelable
  `insertLineBreak` after history undo/redo selection restoration, inside bold
  text with mark preservation, and from an element-node caret after an inline
  mention. Each case also asserts browser-created `<br>` drift is removed.
- Mobile IME composition coverage now mirrors the desktop marked-text and
  inline-boundary contracts in Chromium and WebKit: accented composition inside
  bold text preserves marks, and composition from element-node carets before and
  after inline mentions lands in the neighboring editable text.
- Mobile non-cancelable `insertText` over expanded selections is covered in
  Chromium and WebKit:
  - same-text range replacement is model-owned and repairs duplicate native DOM
    insertion
  - inline-spanning replacement removes the mention inline block through the
    model and repairs the browser-mutated text node
  - cross-block replacement deletes the full selected range, inserts at the
    live model target, and repairs duplicate native DOM insertion
  - all-marked range replacement preserves the common mark while repairing
    browser-created duplicate marked DOM
  - mixed-mark range replacement inserts plain text, not left- or right-boundary
    inherited marks
- Runtime fixes:
  - non-cancelable `insertText` is browser-owned only when it is collapsed,
    text-local, and has no selected blocks
  - unsafe non-cancelable text insertion, including plain `insertFromPaste`,
    keeps a short suppressed-input repair window so the browser's following
    `input` event cannot duplicate model-owned insertion
  - selection replacement used by insertion commands now performs the model
    deletion synchronously before awaiting caret restoration, avoiding a
    delete-only race during non-cancelable browser input
  - selection replacement insertion marks are computed from the event-time
    selected range before deletion; common marks are preserved and mixed marks
    insert plain text
  - `Text.refreshFromModel()` can force a text component remount for suppressed
    native DOM repair, removing unmanaged browser text appended around marked
    spans
  - non-cancelable `insertCompositionText` is model-owned so Firefox
    `keyboard.insertText()` composition-shaped input does not get repaired back
    to an empty model
  - placeholder clicks focus the editor root before setting the caret, which
    keeps Firefox `keyboard.insertText()` targeted at the editable surface
  - advanced delete `beforeinput` values are model-owned instead of silently
    prevented: word deletes, soft/hard line deletes, and fragment deletes now
    route to explicit model deletion commands
  - the WebKit post-composition Backspace guard now checks for explicit text,
    block, or inline-block selections before swallowing the keydown
  - triple-click on a void block body outside editable text now selects the
    block atomically instead of selecting the nearest caption text range
  - platform word-navigation keys now run through editor hotkeys, use
    Unicode-aware word boundaries, and select inline atomic mentions directly
    for shift-word movement
  - `insertTranspose` now runs through controlled text insertion after
    event-time target range selection sync
  - composition state now stores insertion marks computed from the selected
    range and reuses them across preview and final composition replacement
  - out-of-editor beforeinput target ranges are rejected before event-time
    snapshot creation
  - composition state is preserved through interrupting non-composition commands
    and carries an explicit post-command caret target for final IME commit
  - final composition replacement marks are derived from the existing preview
    segment before deletion, not from later pending mark state
  - remote/programmatic text changes while the editor is blurred update cached
    model selection from Yjs relative positions without restoring DOM selection
    or stealing focus

## Verification Already Run

- `pnpm test:integration tests/editor-dom/input.spec.ts -g "structural delete still merges" --workers=1 --project=chromium`
  - 1 passed after adding forward structural Delete target-range coverage.
- `pnpm test:integration tests/editor-dom/input.spec.ts -g "cross-text delete target ranges" --workers=1`
  - 6 passed across Chromium, Firefox, and WebKit after adding forward
    structural Delete target-range coverage.
- `pnpm test:integration tests/editor-dom/input.spec.ts -g "text-local .*delete target ranges|cross-text delete target ranges" --workers=1`
  - 12 passed across Chromium, Firefox, and WebKit after adding forward
    structural Delete target-range coverage.
- `pnpm test:integration tests/editor-dom/dom-mutation.spec.ts --workers=1`
  - 36 passed across Chromium, Firefox, and WebKit while rechecking the
    user-reported visible duplicate-DOM class.
- `pnpm test:integration tests/editor-dom/input.spec.ts -g "auto-dot|does not delete preceding non-space text" --workers=1`
  - 3 passed across Chromium, Firefox, and WebKit while rechecking the
    user-reported auto-dot/double-space class.
- `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1`
  - 33 passed across Chromium, Firefox, and WebKit while rechecking the
    user-reported root-route editing flows.
- `pnpm test -- --run`
  - 269 passed after adding forward structural Delete target-range coverage.
- `pnpm check`
  - 0 errors, 0 warnings after adding forward structural Delete target-range
    coverage.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after adding forward structural Delete target-range
    coverage.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after adding forward structural Delete target-range
    coverage.
- `pnpm lint`
  - passed after formatting forward structural Delete target-range coverage.
- `pnpm test:integration tests/editor-dom/input.spec.ts -g "partial .* target range" --workers=1 --project=chromium`
  - 2 passed after adding partial inside/outside target-range coverage.
- `pnpm test:integration tests/editor-dom/input.spec.ts -g "partial .* target range" --workers=1`
  - 6 passed across Chromium, Firefox, and WebKit after adding partial
    inside/outside target-range coverage.
- `pnpm test:integration tests/editor-dom/input.spec.ts -g "outside target range|partial .* target range|uses beforeinput target ranges" --workers=1`
  - 12 passed across Chromium, Firefox, and WebKit after adding partial
    inside/outside target-range coverage.
- `pnpm test -- --run`
  - 269 passed after adding partial inside/outside target-range coverage.
- `pnpm check`
  - 0 errors, 0 warnings after adding partial inside/outside target-range
    coverage.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after adding partial inside/outside target-range
    coverage.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after adding partial inside/outside target-range
    coverage.
- `pnpm lint`
  - passed after formatting partial inside/outside target-range coverage.
- `pnpm test:integration tests/editor-dom/composition.spec.ts -g "ignores late compositionend" --workers=1 --project=chromium`
  - 1 passed after adding the late `compositionend` blur regression.
- `pnpm test:integration tests/editor-dom/composition.spec.ts -g "ignores late compositionend" --workers=1`
  - 3 passed across Chromium, Firefox, and WebKit after adding the late
    `compositionend` blur regression.
- `pnpm test:integration tests/editor-dom/demo-route.spec.ts -g "splits a cleared paragraph|does not coalesce typing after a paragraph split|does not duplicate visible text|does not leave stale visible DOM clones" --workers=1 --project=chromium`
  - 4 passed on the root route after the live Browser smoke showed an
    in-app-control Enter limitation.
- `pnpm test -- --run`
  - 269 passed after the late `compositionend` blur regression.
- `pnpm check`
  - 0 errors, 0 warnings after the late `compositionend` blur regression.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after the late `compositionend` blur regression.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after the late `compositionend` blur regression.
- `pnpm lint`
  - passed after formatting the late `compositionend` blur regression.
- `pnpm test:dom -t "undoes and redoes selected block deletion"`
  - 1 passed after synchronously moving selected-block redo selection to the
    fallback block.
- `pnpm test:dom`
  - 90 passed after the selected-block redo and synthetic inline-selection
    ordering fixes.
- `pnpm test -- --run`
  - 269 passed after the selected-block redo and synthetic inline-selection
    ordering fixes.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after the selected-block redo and synthetic
    inline-selection ordering fixes.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after the selected-block redo and synthetic
    inline-selection ordering fixes.
- `pnpm check`
  - 0 errors, 0 warnings after the selected-block redo and synthetic
    inline-selection ordering fixes.
- `pnpm lint`
  - passed after formatting the selected-block redo and synthetic
    inline-selection ordering fixes.
- `pnpm build`
  - passed, including `svelte-package` and `publint`.
- `pnpm test:integration tests/editor-dom/selection.spec.ts -g "clicking inside selected block content|replaces only the clicked block" --workers=1`
  - 6 passed across Chromium, Firefox, and WebKit after tightening
    selected-block pointer collapse and triple-click range preservation.
- `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`
  - 105 passed and 6 skipped across Chromium, Firefox, and WebKit after the
    selected-block pointer collapse and triple-click range preservation fixes.
- `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts -g "triple-click|shift-horizontal arrows in RTL|replaces a selected inline" --workers=1 --project=chromium`
  - 3 passed after the selected-block pointer collapse and triple-click range
    preservation fixes.
- `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts -g "selects inline mentions atomically with shift-horizontal arrows in RTL paragraphs" --workers=1 --project=chromium`
  - 1 passed after establishing synthetic selected-inline state before clearing
    native DOM selection.
- `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts --workers=1`
  - 39 passed across Chromium, Firefox, and WebKit after the synthetic
    inline-selection ordering fix.
- `pnpm test:integration tests/editor-dom/demo-route.spec.ts --workers=1`
  - 33 passed across Chromium, Firefox, and WebKit, including the root-route
    typing, mark-toggle duplication, auto-dot, split/undo, and placeholder
    guards.
- `pnpm test:integration tests/editor-dom/hotkeys.spec.ts -g "cycles mod\+a|collapses selected-block|ignores stale editor selection|deletes a selected block" --workers=1 --project=chromium`
  - 4 passed after the selected-block redo and synthetic inline-selection
    ordering fixes.
- `pnpm test:integration tests/editor-dom/beforeinput-fallback.spec.ts -g "selected-block" --workers=1 --project=chromium`
  - 2 passed after the selected-block redo and synthetic inline-selection
    ordering fixes.
- Live in-app Browser on `http://localhost:5173/`
  - clear + type `One`, bold-toggle typing `Two`, plain typing `Three`,
    double-space, dot-space, undo, and redo all kept one managed text node and
    did not duplicate visible DOM text. The in-app Browser did not deliver
    Enter to this contenteditable surface; paragraph split remains verified by
    the Playwright demo-route spec.
- `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts -g "real pointer click" --workers=1`
  - 3 passed across Chromium, Firefox, and WebKit for real pointer click
    selection and Backspace deletion of a non-editable inline mention atom.
- `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts --workers=1`
  - 12 passed across Chromium, Firefox, and WebKit for the full inline atomic
    browser suite after adding the pointer-click coverage.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after adding the inline atom pointer-click coverage.
- `pnpm check`
  - 0 errors, 0 warnings after adding the inline atom pointer-click coverage.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after adding the inline atom pointer-click coverage.
- `pnpm lint`
  - passed after adding the inline atom pointer-click coverage.
- `pnpm test:integration tests/editor-dom/blurred-programmatic-update.spec.ts --workers=1`
  - initial run failed in Chromium, Firefox, and WebKit before the runtime patch
    because remote/programmatic text changes restored DOM selection into the
    blurred editor and stole focus from the outside target.
- `pnpm test:integration tests/editor-dom/blurred-programmatic-update.spec.ts --workers=1`
  - 3 passed across Chromium, Firefox, and WebKit after keeping blurred
    remote/programmatic reconciliation DOM-free.
- `pnpm test:integration tests/editor-dom/blurred-programmatic-update.spec.ts tests/editor-dom/selection.spec.ts --workers=1`
  - 50 passed and 4 skipped across Chromium, Firefox, and WebKit for the new
    blurred update regression plus the neighboring browser selection suite.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after the blurred-editor programmatic update fix.
- `pnpm check`
  - 0 errors, 0 warnings after the blurred-editor programmatic update fix.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after the blurred-editor programmatic update fix.
- `pnpm lint`
  - passed after formatting the new browser spec and touched selection files.
- `pnpm test:integration tests/editor-dom/drop-beforeinput.spec.ts --workers=1`
  - 3 passed across Chromium, Firefox, and WebKit for unsupported
    `insertFromDrop` prevention/no-op behavior.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after adding unsupported `insertFromDrop` browser
    coverage.
- `pnpm check`
  - 0 errors, 0 warnings after adding unsupported `insertFromDrop` browser
    coverage.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after adding unsupported `insertFromDrop` browser
    coverage.
- `pnpm lint`
  - passed after adding unsupported `insertFromDrop` browser coverage.
- `pnpm test:integration tests/editor-dom/composition-cancellation.spec.ts -g "formatUnderline" --workers=1`
  - initial run failed in Chromium, Firefox, and WebKit before the runtime patch
    because native `formatUnderline` leaked a pending mark into the final IME
    commit.
- `pnpm test:integration tests/editor-dom/composition-cancellation.spec.ts -g "formatUnderline" --workers=1`
  - 3 passed across Chromium, Firefox, and WebKit after deriving final
    composition marks from the preview segment.
- `pnpm test:integration tests/editor-dom/composition-cancellation.spec.ts tests/editor-dom/composition.spec.ts --workers=1`
  - 84 passed across Chromium, Firefox, and WebKit after the
    format-during-composition fix.
- `pnpm test:integration tests/editor-dom/mobile-composition.spec.ts --workers=1`
  - 18 passed and 2 skipped across mobile Chromium and mobile WebKit after the
    format-during-composition fix.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after the format-during-composition fix.
- `pnpm check`
  - 0 errors, 0 warnings after the format-during-composition fix.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after the format-during-composition fix.
- `pnpm lint`
  - passed after the format-during-composition fix.
- `pnpm test:integration tests/editor-dom/composition-cancellation.spec.ts -g "deleteContentBackward" --workers=1`
  - 3 passed across Chromium, Firefox, and WebKit for normal Backspace
    beforeinput during active IME preview.
- `pnpm test:integration tests/editor-dom/composition-cancellation.spec.ts --workers=1`
  - 12 passed across Chromium, Firefox, and WebKit after adding the
    `deleteContentBackward` interruption coverage.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after adding `deleteContentBackward` composition
    interruption coverage.
- `pnpm check`
  - 0 errors, 0 warnings after adding `deleteContentBackward` composition
    interruption coverage.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after adding `deleteContentBackward` composition
    interruption coverage.
- `pnpm lint`
  - passed after adding `deleteContentBackward` composition interruption
    coverage.
- `pnpm test:integration tests/editor-dom/composition-cancellation.spec.ts -g "insertParagraph" --workers=1`
  - initial run failed in Chromium, Firefox, and WebKit before the runtime patch
    because `compositionend.data` could not replace stale preview text after
    Enter interrupted the composition.
- `pnpm test:integration tests/editor-dom/composition-cancellation.spec.ts -g "insertParagraph" --workers=1`
  - 3 passed across Chromium, Firefox, and WebKit after preserving composition
    state through the interrupting `insertParagraph`.
- `pnpm test:integration tests/editor-dom/composition-cancellation.spec.ts tests/editor-dom/composition.spec.ts --workers=1`
  - 78 passed across Chromium, Firefox, and WebKit after the interrupted
    composition fix.
- `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1`
  - 75 passed across Chromium, Firefox, and WebKit after the interrupted
    composition fix.
- `pnpm test:integration tests/editor-dom/mobile-composition.spec.ts --workers=1`
  - 18 passed and 2 skipped across mobile Chromium and mobile WebKit after the
    interrupted composition fix.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after the interrupted composition fix.
- `pnpm check`
  - 0 errors, 0 warnings after the interrupted composition fix.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after the interrupted composition fix.
- `pnpm lint`
  - passed after the interrupted composition fix.
- `pnpm test:integration tests/editor-dom/composition-cancellation.spec.ts --workers=1`
  - 6 passed across Chromium, Firefox, and WebKit for cancellation and
    `deleteCompositionText` during active IME preview.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after adding composition cancellation browser coverage.
- `pnpm check`
  - 0 errors, 0 warnings after adding composition cancellation browser coverage.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after adding composition cancellation browser coverage.
- `pnpm lint`
  - initial run failed only on Prettier formatting for
    `tests/editor-dom/composition-cancellation.spec.ts`; passed after
    formatting.
- `pnpm test:integration tests/editor-dom/format-beforeinput.spec.ts --workers=1`
  - 18 passed across Chromium, Firefox, and WebKit for native format inputTypes
    beyond bold/remove.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after adding native format beforeinput browser
    coverage.
- `pnpm check`
  - 0 errors, 0 warnings after adding native format beforeinput browser
    coverage.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after adding native format beforeinput browser
    coverage.
- `pnpm lint`
  - initial run failed only on Prettier formatting for
    `tests/editor-dom/format-beforeinput.spec.ts`; passed after formatting.
- `pnpm test:integration tests/editor-dom/input.spec.ts -g "outside target range" --workers=1`
  - initial run failed in Chromium, Firefox, and WebKit before the runtime patch
    because Edytor prevented the event but still inserted into stale cached
    selection.
- `pnpm test:integration tests/editor-dom/input.spec.ts -g "outside target range" --workers=1`
  - 3 passed across Chromium, Firefox, and WebKit after rejecting out-of-editor
    target ranges before snapshotting.
- `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1`
  - 75 passed across Chromium, Firefox, and WebKit after the invalid target
    range guard.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after the invalid target range guard.
- `pnpm check`
  - 0 errors, 0 warnings after the invalid target range guard.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after the invalid target range guard.
- `pnpm lint`
  - passed after the invalid target range guard.
- `pnpm test:integration tests/editor-dom/composition.spec.ts -g mixed-mark --workers=1`
  - initial run failed in Chromium, Firefox, and WebKit before the runtime patch
    because IME composition inherited the left bold boundary across a mixed-mark
    selection.
- `pnpm test:integration tests/editor-dom/composition.spec.ts -g mixed-mark --workers=1`
  - 3 passed across Chromium, Firefox, and WebKit after storing composition
    insertion marks.
- `pnpm test:integration tests/editor-dom/composition.spec.ts --workers=1`
  - 69 passed across Chromium, Firefox, and WebKit after the mixed-mark
    composition fix.
- `pnpm test:integration tests/editor-dom/mobile-composition.spec.ts --workers=1`
  - 18 passed and 2 skipped across mobile Chromium and mobile WebKit after the
    mixed-mark composition fix.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after the mixed-mark composition fix.
- `pnpm check`
  - 0 errors, 0 warnings after the mixed-mark composition fix.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after the mixed-mark composition fix.
- `pnpm lint`
  - passed after the mixed-mark composition fix.
- `pnpm test:integration tests/editor-dom/input.spec.ts -g insertTranspose --workers=1`
  - initial run failed in Chromium, Firefox, and WebKit before the runtime patch
    because the event was prevented but no model command ran.
- `pnpm test:integration tests/editor-dom/input.spec.ts -g insertTranspose --workers=1`
  - 3 passed across Chromium, Firefox, and WebKit after routing
    `insertTranspose` through controlled text insertion.
- `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1`
  - 72 passed across Chromium, Firefox, and WebKit after the `insertTranspose`
    fix.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after the `insertTranspose` fix.
- `pnpm check`
  - 0 errors, 0 warnings after the `insertTranspose` fix.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after the `insertTranspose` fix.
- `pnpm lint`
  - passed after the `insertTranspose` fix.
- `pnpm test:integration tests/editor-dom/selection.spec.ts -g word-boundary --workers=1`
  - initial run failed before the runtime patch, proving native word navigation
    was not portable around inline mention and emoji boundaries.
- `pnpm test:integration tests/editor-dom/selection.spec.ts -g word-boundary --workers=1`
  - 3 passed across Chromium, Firefox, and WebKit after routing word navigation
    through the default hotkey layer.
- `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`
  - 47 passed and 4 skipped across Chromium, Firefox, and WebKit after the
    word-boundary navigation fix.
- `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts --workers=1`
  - 9 passed across Chromium, Firefox, and WebKit after extracting the selected
    inline-block browser helper and direct shift-word inline selection.
- `pnpm test:integration tests/editor-dom/hotkeys.spec.ts --workers=1`
  - 30 passed across Chromium, Firefox, and WebKit after adding platform word
    hotkeys.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after the word-boundary navigation fix.
- `pnpm check`
  - 0 errors, 0 warnings after the word-boundary navigation fix.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after the word-boundary navigation fix.
- `pnpm lint`
  - passed after formatting the word-boundary navigation fix.
- `pnpm test:integration tests/editor-dom/selection.spec.ts -g "void body" --workers=1`
  - initial run failed the new triple-click void-body regression in Chromium,
    Firefox, and WebKit before the runtime patch.
- `pnpm test:integration tests/editor-dom/selection.spec.ts -g document-boundary --workers=1`
  - initial run failed in Chromium, Firefox, and WebKit before the runtime
    patch because PageUp did not move from nested text to the editor start.
- `pnpm test:integration tests/editor-dom/selection.spec.ts -g document-boundary --workers=1`
  - 3 passed across Chromium, Firefox, and WebKit after routing document-boundary
    navigation through the default hotkey layer.
- `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`
  - 44 passed and 4 skipped across Chromium, Firefox, and WebKit after the
    document-boundary navigation fix.
- `pnpm test:integration tests/editor-dom/hotkeys.spec.ts --workers=1`
  - 30 passed across Chromium, Firefox, and WebKit after the
    document-boundary navigation fix.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after the document-boundary navigation fix.
- `pnpm check`
  - 0 errors, 0 warnings after the document-boundary navigation fix.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after the document-boundary navigation fix.
- `pnpm lint`
  - passed after formatting the document-boundary navigation fix.
- `pnpm test:integration tests/editor-dom/selection.spec.ts -g "Home and End" --workers=1`
  - initial run failed in Chromium, Firefox, and WebKit before the runtime
    patch. Chromium reached logical block end through native behavior, while
    Firefox and WebKit left the caret unchanged.
- `pnpm test:integration tests/editor-dom/selection.spec.ts -g "Home and End" --workers=1`
  - 3 passed across Chromium, Firefox, and WebKit after routing Home/End through
    the default hotkey layer.
- `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`
  - 41 passed and 4 skipped across Chromium, Firefox, and WebKit after the
    Home/End navigation fix.
- `pnpm test:integration tests/editor-dom/hotkeys.spec.ts --workers=1`
  - 30 passed across Chromium, Firefox, and WebKit after the Home/End hotkey
    normalization.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after the Home/End navigation fix.
- `pnpm check`
  - 0 errors, 0 warnings after the Home/End navigation fix.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after the Home/End navigation fix.
- `pnpm lint`
  - passed after formatting the Home/End navigation fix.
- `pnpm test:integration tests/editor-dom/selection.spec.ts -g "void body" --workers=1`
  - 6 passed across Chromium, Firefox, and WebKit after the void-body
    triple-click selection fix.
- `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`
  - 35 passed and 4 skipped across Chromium, Firefox, and WebKit after the
    void-body triple-click selection fix.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after the void-body triple-click selection fix.
- `pnpm check`
  - 0 errors, 0 warnings after the void-body triple-click selection fix.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after the void-body triple-click selection fix.
- `pnpm test -- --run`
  - 266 passed after the void-body triple-click selection fix.
- `pnpm test:dom`
  - 88 passed after the void-body triple-click selection fix.
- `pnpm lint`
  - passed after formatting the void-body triple-click selection fix.
- `pnpm build`
  - passed and `publint` reported all good after the void-body triple-click
    selection fix.
- `pnpm test:integration tests/editor-dom/composition.spec.ts -g "selected content" --workers=1`
  - initial run passed in Chromium and Firefox, but failed in WebKit before the
    runtime patch because the post-composition Backspace guard swallowed
    selected-content deletion.
- `pnpm test:integration tests/editor-dom/composition.spec.ts -g "selected content|WebKit Backspace keydown immediately" --workers=1`
  - 6 passed across Chromium, Firefox, and WebKit after preserving explicit
    selections while keeping the collapsed-caret WebKit guard.
- `pnpm test:integration tests/editor-dom/composition.spec.ts --workers=1`
  - 66 passed across Chromium, Firefox, and WebKit after the WebKit
    post-composition selection fix.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after the WebKit post-composition selection fix.
- `pnpm check`
  - 0 errors, 0 warnings after the WebKit post-composition selection fix.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after the WebKit post-composition selection fix.
- `pnpm test -- --run`
  - 266 passed after the WebKit post-composition selection fix.
- `pnpm test:dom`
  - 88 passed after the WebKit post-composition selection fix.
- `pnpm lint`
  - passed after the WebKit post-composition selection fix.
- `pnpm build`
  - passed and `publint` reported all good after the WebKit
    post-composition selection fix.
- `pnpm test:integration tests/editor-dom/advanced-delete.spec.ts --workers=1`
  - first run failed 15/15 before the runtime patch, proving the browser-backed
    no-op gap for advanced delete inputTypes.
- `pnpm test:integration tests/editor-dom/advanced-delete.spec.ts --workers=1`
  - 30 passed across Chromium, Firefox, and WebKit after routing advanced delete
    inputTypes through model deletion.
- `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1`
  - 69 passed across Chromium, Firefox, and WebKit after advanced delete
    routing.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after advanced delete routing.
- `pnpm check`
  - 0 errors, 0 warnings after advanced delete routing.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after advanced delete routing.
- `pnpm test -- --run`
  - 266 passed after advanced delete routing.
- `pnpm test:dom`
  - 88 passed after advanced delete routing.
- `pnpm lint`
  - passed after formatting the advanced delete spec.
- `pnpm build`
  - passed and `publint` reported all good after advanced delete routing.
- `pnpm test:integration tests/editor-dom/inline-atomic.spec.ts --workers=1`
  - 9 passed across Chromium, Firefox, and WebKit after adding horizontal
    arrow/shift-arrow inline atomic coverage.
- `pnpm test:integration tests/editor-dom/beforeinput-fallback.spec.ts -g "inline mention" --workers=1`
  - 6 passed across Chromium, Firefox, and WebKit after the inline atomic
    selection mapping change.
- `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`
  - 32 passed and 4 skipped across Chromium, Firefox, and WebKit after the
    inline atomic selection mapping change.
- `pnpm test:dom`
  - 88 passed after the inline atomic selection mapping change.
- `pnpm test -- --run`
  - 266 passed after the inline atomic selection mapping change.
- `pnpm check`
  - 0 errors, 0 warnings after the inline atomic selection mapping change.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after the inline atomic selection mapping change.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after the inline atomic selection mapping change.
- `pnpm lint`
  - passed after formatting the inline atomic selection mapping change.
- `pnpm build`
  - passed and `publint` reported all good after the inline atomic selection
    mapping change.
- Parallel Playwright note: a concurrent `selection.spec.ts` and
  `beforeinput-fallback.spec.ts` run reproduced the known
  `.svelte-kit/__package__` ENOENT race. The same selection spec passed when
  rerun sequentially with `--workers=1`.
- `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts -g "mark.*insertText|all-marked|mixed-mark" --workers=1`
  - 4 passed across mobile Chromium and mobile WebKit after adding marked and
    mixed-mark non-cancelable `insertText` regressions.
- `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts --workers=1`
  - 36 passed across mobile Chromium and mobile WebKit after the mark-boundary
    insertion and DOM repair changes.
- `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1`
  - 69 passed across Chromium, Firefox, and WebKit after the placeholder focus
    and Firefox composition-shaped `insertText` fixes.
- `pnpm test:integration tests/editor-dom/mobile-composition.spec.ts --workers=1`
  - 18 passed and 2 skipped after model-owning non-cancelable
    `insertCompositionText`.
- `pnpm test:dom`
  - 88 passed after updating the mounted composition fixture contract.
- `pnpm test -- --run`
  - 266 passed after the mark-boundary insertion changes.
- `pnpm check`
  - 0 errors, 0 warnings after the mark-boundary insertion changes.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after the mark-boundary insertion changes.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after the mark-boundary insertion changes.
- `pnpm lint`
  - passed after formatting the mark-boundary insertion changes.
- `pnpm build`
  - passed and `publint` reported all good after the mark-boundary insertion
    changes.
- `pnpm test:integration --workers=1`
  - 356 passed and 8 skipped; one WebKit test timed out during `page.goto`, then
    the exact case passed on rerun.
- `pnpm test:integration tests/editor-dom/selection.spec.ts -g "vertical arrow" --workers=1`
  - 3 passed across Chromium, Firefox, and WebKit after adding the vertical
    void-body navigation regression.
- `pnpm test:integration tests/editor-dom/selection.spec.ts --workers=1`
  - 38 passed and 4 skipped across Chromium, Firefox, and WebKit after adding
    the vertical void-body navigation regression.
- `pnpm lint`
  - passed after formatting the vertical void-body navigation regression.
- `pnpm test:integration tests/editor-dom/input.spec.ts -g "replaces a cross-block browser selection" --project=webkit --workers=1`
  - 1 passed, confirming the full-suite WebKit `page.goto` timeout was not an
    editor assertion failure.
- `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts -g "insertText model-owned" --workers=1`
  - 6 passed across mobile Chromium and mobile WebKit after adding
    non-cancelable expanded `insertText` coverage and narrowing the native
    browser-owned path.
- `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts --workers=1`
  - 32 passed across mobile Chromium and mobile WebKit after the insertText
    routing and insertion-repair fix.
- `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1`
  - 69 passed across Chromium, Firefox, and WebKit after the shared insertion
    replacement change.
- `pnpm test:integration tests/editor-dom/mobile-composition.spec.ts --workers=1`
  - 18 passed and 2 skipped after the shared insertion replacement change.
- `pnpm test -- --run`
  - 266 passed after the shared insertion replacement change.
- `pnpm check`
  - 0 errors, 0 warnings after the mobile non-cancelable insertText routing
    change.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after the mobile non-cancelable insertText routing
    change.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after the mobile non-cancelable insertText routing
    change.
- `pnpm lint`
  - passed after formatting the mobile non-cancelable insertText routing change.
- `pnpm test:integration tests/editor-dom/mobile-composition.spec.ts -g "marked text|inline mention" --workers=1`
  - 6 passed across mobile Chromium and mobile WebKit after adding mobile
    marked-text and inline-boundary composition coverage.
- `pnpm test:integration tests/editor-dom/mobile-composition.spec.ts --workers=1`
  - 18 passed and 2 skipped after adding mobile marked-text and inline-boundary
    composition coverage.
- `pnpm check`
  - 0 errors, 0 warnings after mobile marked-text and inline-boundary
    composition coverage.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after mobile marked-text and inline-boundary
    composition coverage.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after mobile marked-text and inline-boundary
    composition coverage.
- `pnpm lint`
  - passed after formatting mobile marked-text and inline-boundary composition
    coverage.
- `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts -g "soft break|marked text|inline boundary" --workers=1`
  - 6 passed across mobile Chromium and mobile WebKit after adding marked-text
    and inline-boundary soft-break coverage.
- `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts -g "history undo and redo" --workers=1`
  - 2 passed across mobile Chromium and mobile WebKit after adding soft-break
    coverage at history-restored selections.
- `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts --workers=1`
  - 26 passed across mobile Chromium and mobile WebKit after adding mobile
    soft-break profiles.
- `pnpm check`
  - 0 errors, 0 warnings after mobile soft-break coverage.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after mobile soft-break coverage.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after mobile soft-break coverage.
- `pnpm lint`
  - passed after formatting mobile soft-break coverage.
- `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts -g "selected-block" --workers=1`
  - 4 passed across mobile Chromium and mobile WebKit after adding selected-block
    non-cancelable beforeinput coverage and fixing selected-block delete routing.
- `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts --workers=1`
  - 20 passed across mobile Chromium and mobile WebKit after selected-block
    delete routing fix.
- `pnpm test:integration tests/editor-dom/mobile-composition.spec.ts --workers=1`
  - 12 passed and 2 skipped after adding mobile IME-after-undo/redo coverage.
- `pnpm test:integration tests/editor-dom/hotkeys.spec.ts -g "selected block" --workers=1`
  - 3 passed across Chromium, Firefox, and WebKit after the selected-block
    beforeinput routing fix, confirming existing desktop hotkey deletion stayed
    green.
- `pnpm check`
  - 0 errors, 0 warnings after mobile IME and selected-block coverage.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after mobile IME and selected-block coverage.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings after mobile IME and selected-block coverage.
- `pnpm lint`
  - passed after formatting mobile IME and selected-block coverage.
- `pnpm test:integration tests/editor-dom/composition.spec.ts -g "first WebKit Backspace" --workers=1`
  - 3 passed across Chromium, Firefox, and WebKit after converting the WebKit
    post-composition Backspace expectations to the browser-specific expectation
    helper.
- `pnpm test:integration tests/editor-dom/clipboard.spec.ts -g "real Chromium clipboard" --workers=1`
  - 1 passed in Chromium and 2 skipped with reason-labelled browser policy.
- `pnpm test:integration tests/editor-dom/selection.spec.ts -g "multi-range|shadow root" --workers=1`
  - 2 passed and 4 skipped with reason-labelled browser/capability policy.
- `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts -g "Android Chrome Backspace beforeinput has no native effect" --workers=1`
  - 2 passed across mobile Chromium and mobile WebKit after converting divergent
    Android Chromium expectations to explicit browser policy.
- `pnpm test:integration tests/editor-dom/mobile-composition.spec.ts --workers=1`
  - 8 passed and 2 skipped after converting Android Chromium fallback and CDP
    IME Chromium-only branches to explicit browser policy.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after adding browser-specific expectation helpers.
- `pnpm check`
  - 0 errors, 0 warnings after adding browser-specific expectation helpers.
- `pnpm lint`
  - passed after formatting browser-specific expectation helpers and callers.
- `pnpm test:integration tests/editor-dom/beforeinput-fallback.spec.ts -g "range across an inline mention" --workers=1`
  - 6 passed across Chromium, Firefox, and WebKit after adding inline-range
    missing-`beforeinput` coverage.
- `pnpm test:integration tests/editor-dom/beforeinput-fallback.spec.ts --workers=1`
  - 36 passed across Chromium, Firefox, and WebKit after adding inline-range
    missing-`beforeinput` coverage.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after inline-range missing-`beforeinput` coverage.
- `pnpm check`
  - 0 errors, 0 warnings after inline-range missing-`beforeinput` coverage.
- `pnpm lint`
  - passed after formatting inline-range missing-`beforeinput` coverage.
- `pnpm test:integration tests/editor-dom/beforeinput-fallback.spec.ts -g "selected-block" --workers=1`
  - 6 passed across Chromium, Firefox, and WebKit after adding selected-block
    missing-`beforeinput` DOM-drift coverage.
- `pnpm test:integration tests/editor-dom/beforeinput-fallback.spec.ts --workers=1`
  - 30 passed across Chromium, Firefox, and WebKit after selected-block DOM
    repair hardening.
- `pnpm test:integration tests/editor-dom/hotkeys.spec.ts -g "selected block|stale editor selection" --workers=1`
  - 6 passed across Chromium, Firefox, and WebKit after selected-block
    selection cleanup.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings after selected-block DOM repair hardening.
- `pnpm check`
  - 0 errors, 0 warnings after selected-block DOM repair hardening.
- `pnpm lint`
  - passed after formatting selected-block DOM repair changes.
- `pnpm test:integration tests/editor-dom/beforeinput-fallback.spec.ts --workers=1`
  - 24 passed across Chromium, Firefox, and WebKit after adding desktop
    missing-`beforeinput` Shift+Enter coverage.
- `pnpm test:integration tests/editor-dom/input.spec.ts -g "soft|trailing soft-break" --workers=1`
  - 3 passed across Chromium, Firefox, and WebKit after adding desktop
    missing-`beforeinput` Shift+Enter coverage.
- `pnpm test:integration tests/editor-dom/mobile-beforeinput.spec.ts --workers=1`
  - 16 passed across mobile Chromium and mobile WebKit.
- `pnpm test:integration tests/editor-dom/input.spec.ts --workers=1`
  - 69 passed across Chromium, Firefox, and WebKit.
- `pnpm test:integration tests/editor-dom/composition.spec.ts --workers=1`
  - 63 passed across Chromium, Firefox, and WebKit.
- `pnpm test -- --run`
  - 266 passed.
- `pnpm test:typecheck`
  - 0 errors, 0 warnings.
- `pnpm test:dom:typecheck`
  - 0 errors, 0 warnings.
- `pnpm check`
  - 0 errors, 0 warnings.
- `pnpm lint`
  - passed after formatting `src/lib/events/onKeyDown.ts`.

## Do Not Repeat

- Do not start a new browser-hardening task until `Active Slice` is either
  moved to `Completed Edytor Coverage` with verification, or explicitly replaced
  with a short reason.
- Do not duplicate an existing completed behavior just because the memory
  summary is incomplete; this file is the source of truth after compaction.
- Do not reimplement clipboard internals unless a current browser spec proves a
  browser-owned clipboard failure.
- Do not treat a Playwright `.svelte-kit/__package__` ENOENT from concurrently
  launched Playwright commands as an editor regression. Rerun browser specs
  sequentially with `--workers=1`; the sequential mobile-beforeinput run passed
  after the observed race.
- Do not add more tests for already-covered missing-`beforeinput` Backspace,
  Delete, parent-with-children Enter, or Shift+Enter soft break unless the new
  test targets a materially different browser quirk.
- Do not treat model/JSX tests as proof for browser selection, browser
  composition, or `contenteditable` DOM drift.
- Do not run Playwright specs in parallel while SvelteKit is serving; use
  `--workers=1` for focused browser gates to avoid noisy `.svelte-kit` races.
- Before trusting a Playwright browser rerun after runtime edits, kill any stale
  preview server on port `4173`; `playwright.config.ts` reuses existing servers
  outside CI and can otherwise test an old build.

## Next Queue

1. Pick any later item only after checking `Fast Coverage Index` and asking
   DeepWiki about one concrete cross-browser behavior.

## How To Start The Next Slice

1. Read this file and `docs/cross-browser-confidence.md`.
2. Pick the first unchecked item from `Next Queue`.
3. Ask DeepWiki only for that concrete browser behavior.
4. Add a focused browser regression first.
5. Patch runtime only if the regression exposes a real gap.
6. Run the focused Playwright spec with `--workers=1`.
7. Run the nearest affected browser suites and type/lint gates.
8. Update this file with what changed and what remains.
