# Browser-input gap analysis — Edytor vs. mature editors

**Date:** 2026-09-21
**Scope:** every browser-input/behavior surface defended by Slate, Quill,
ProseMirror, Lexical, and CodeMirror 6, diffed against Edytor's engine
(`src/lib/events/`, `src/lib/selection/`, `src/lib/hotkeys.ts`,
`src/lib/plugins/`) and test coverage (UNIT / JSDOM / Playwright editor-dom /
DST harness).
**Sources:** full-source dossiers on all five editors (cloned source +
DeepWiki), plus a complete audit of Edytor's event surface. File:line cites
refer to the upstream repos; our cites refer to this tree.

---

## 1. The architectural frame (why "missing" means different things)

Three input philosophies exist across the five editors:

| Posture                       | Editors                                                                           | Mechanism                                                                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mutation-first**            | ProseMirror, Quill                                                                | Browser mutates DOM natively → MutationObserver → diff vs model → transaction. `beforeinput` barely used (PM: 3 inputType reads repo-wide; Quill: 2 inputTypes + history). |
| **Event-first controlled**    | Slate (desktop), Lexical, **Edytor**                                              | `beforeinput` inputType taxonomy → `preventDefault` → model op → model writes DOM.                                                                                         |
| **Hybrid / forced-reconcile** | Slate-on-Android, Lexical uncontrolled typing, CM6, **Edytor browser-owned path** | `beforeinput` isn't cancelable (Android) or is deliberately let through (single-char fast paths) → reconcile via observer/`input` diff.                                    |

Edytor is event-first with an explicit browser-owned allowlist
(`shouldLetBrowserHandleBeforeInput`, `onBeforeInput.ts:331-334`) and two
reconcile paths: `reconcileBrowserOwnedInputTarget` (`onInput.ts:649-693`)
and `observeDomTextMutations` (`domTextMutationObserver.ts`). That means our
obligation is **(a) completeness of the inputType/command taxonomy** — since
unknown types are swallowed (`preventDefault` at `onBeforeInput.ts:621`, no
command) — and **(b) robustness of the reconcile path** for anything we let
through or that arrives without events.

A second axis: **every mature editor defends against foreign DOM writes**
(extensions like Grammarly, browser autotranslation, spellcheck tooling).
This is the single largest class of hardening in all five codebases — and the
least-tested area of ours.

---

## 2. Confirmed gaps — correctness-critical

### G1. Attribute mutations are invisible to the observer

`observeDomTextMutations` observes `{characterData, childList, subtree}` only
(`domTextMutationObserver.ts:663-665`). PM, Quill, and CM6 all observe
`attributes` (+ `attributeOldValue`/`characterDataOldValue`). Consequences:

- Extensions (Grammarly et al.) rewriting `style`/`class`/`data-*` on managed
  nodes mutate DOM silently — no reconcile, no eviction, stale DOM forever.
- Browser-side attribute writes (WebKit format pushes, spellcheck markers)
  go unnoticed until some other mutation collides with them.
- **No `characterDataOldValue`** means we cannot detect _type-over_
  (mobile keyboards signaling "replaced selection with same text" via a
  no-op-value `characterData` record — PM `domobserver.ts:299`, CM6
  `domobserver.ts:413` both use it).

_Harness gap:_ the DST never injects foreign mutations at all — the entire
reconcile path is only exercised through browser-owned input it was designed
for, never adversarially.

### G2. Composition DOM is not protected from our own re-renders

Every mature editor locks the DOM node hosting a live composition:

- PM: `compositionNode` lock in ViewTreeUpdater — refuses to overwrite/reuse
  the node the IME is mutating (`viewdesc.ts:767-852`, `1298-1303`);
  `CompositionViewDesc` wraps orphaned composition DOM.
- Lexical: text-node identity preserved via `diffComposedText` minimal
  splices (`LexicalTextNode.ts:258-330`); `COMPOSITION_START_CHAR` marker
  inserted when no safe node exists.
- CM6: `TileFlag.Composition` prevents text-node merging; no DOM reuse
  across composition (`buildtile.ts:419`).
- Slate: `TextString` skips `textContent` writes on Android while composing
  (`string.tsx:80-104`).

Ours: the MutationObserver _defers_ during `isComposing` (750ms idle cancel),
which protects against our own mutation _processing_ — but a **Svelte re-render
triggered by a remote collab edit, a plugin, or a model change during
composition can still unmount the text node the IME is composing into**.
This is the classic "안녕 → ㅇ안녕" bug class (Slate PR #6096). In a CRDT
editor with live collaboration this is a _concurrent-remote-edit_ path, not
just an edge case. **Needs a targeted investigation + test** — likely the
single highest-value correctness gap found.

### G3. No foreign-content drop / drag-in at all

`preventUnsupportedDrop` prevents **all** `dragover`/`drop` on the root
(`events/onDrop.ts:1`). `insertFromDrop` beforeinput is swallowed
(`onBeforeInput.ts:621`). Consequences:

- Users cannot drag external text/HTML/files _into_ the editor.
- No internal drag-to-move of text/selection (PM `Dragging`, Lexical
  `application/x-lexical-drag` + `deleteByDrag`, CM6 `dropText`,
  Slate `isDraggingInternally` all implement it).
- Block-handle dragging exists (plugin) but text/content drag doesn't.

Note the counter-example: Quill also prevents `dragstart` and only handles
file drops — so "drop prevention" alone isn't disqualifying, but mature
editors all handle _incoming_ drops. `caretRangeFromPoint`/
`caretPositionFromPoint` + `dropPoint`-style position resolution is the
shared mechanism.

### G4. No file/image paste

`onPaste.ts` never reads `clipboardData.files` or `text/uri-list` (verified).
Quill routes file payloads to `uploader`; Lexical dispatches
`DRAG_DROP_PASTE`; PM/CM6 resolve drop points. Screenshot-paste —
the most common file-paste case — silently produces nothing. Also no
**shift-paste = plain text** convention (PM `input.ts:620-630` exempts
Shift+Insert) and no paste-into-code-block format override (Quill
`clipboard.ts:104-108` — check whether our htmlPlugin respects the target
context).

### G5. No non-Latin keyboard-layout fallback

`isHotkey` matches `event.key`/`event.which` only — no `event.code` or
keyCode fallback (verified: zero `keyCode`/`\.code` refs in `hotkeys.ts`).
On Cyrillic/Arabic/Greek layouts `mod+в` produces `key='в'` — our
`mod+b` binding never fires. PM retries with the unmodified keyCode name
(`keymap.ts:96-105`, issues #668/#1060/#1529); CM6 uses `w3c-keyname`
base/shift tables; Lexical falls back to `event.code` for non-ASCII keys.
Real-world impact: formatting shortcuts dead for a large user population.

### G6. Missing platform keyboard conventions

Verified absent from `hotkeys.ts`:

- **Ctrl+Y** (Windows redo) — Quill `history.ts:67`, Lexical, PM `Mod-y` all bind it.
- **macOS Emacs set** — Ctrl+H/D (delete char), Ctrl+K (delete line forward),
  Ctrl+T (transpose), Ctrl+O (open line), Ctrl+B/F/P/N/A/E (motion).
  Slate `hotkeys.ts:62`, Lexical `LexicalEvents.ts:1727-1758`, PM
  `capturekeys.ts:324-339` all ship the Apple-only table. macOS users get
  these _system-wide_ — their absence is a regression vs. platform habit.
- **AltGr correctness on Windows** — PM exempts Ctrl+Alt from the keyCode
  fallback (it's AltGr, `keymap.ts:98`); we don't appear to special-case it
  beyond `isAltGraphInput` suppression.

### G7. Undo-scope walk (historyUndo at the editor while focus is elsewhere)

Lexical defends against the Chromium/WebKit **undo-scope walk**: when a
focused control outside the editor (e.g. a floating link input) exhausts its
own history, the browser dispatches `historyUndo` at the editor root with no
selection (`LexicalEvents.ts:1002-1027`, issue #6714). Our
`runBeforeInputHistoryCommand` (`onBeforeInput.ts:526-564`) prevents +
undoes — **needs verification**: does it confirm the event actually belongs
to an editor-owned selection/target before mutating history? If not, an
unrelated input's exhausted undo stack could silently undo document state.

---

## 3. Confirmed gaps — platform & UX

### G8. Android depth

We have `isAndroidChromeBrowser` native-backspace + 150ms fallback and
mobile-emulation Playwright specs — a real foundation. Missing specifics
that all mature editors carry:

- **preventDefault-ignored deletes**: Android Chrome deletes anyway after a
  canceled `deleteContentBackward` → double deletion. Lexical _declines_ to
  preventDefault for safe same-node ranges (`LexicalEvents.ts:957-981`);
  PM probes `domChangeCount` and blur/refocuses (`input.ts:813-826`).
- **Rightward caret shift** after cross-paragraph Android deletes —
  Lexical's `postDeleteSelectionToRestore`.
- **Enter reconstruction from DOM evidence** (GBoard/SwiftKey mutate without
  key events) — PM `domchange.ts:124-130,212-219`, CM6 `domchange.ts:201-213`.
- **Keyboard-resurrection refocus** when the virtual keyboard collapses
  (CM6 `visualViewport.height` watch, `input.ts:882-893`).
- **Composition-into-empty-leaf deferral** — Slate's "don't unmount the
  text node the IME is creating" rule (the 안녕→ㅇ안녕 bug).
- **Spurious compositionstart** (Gboard English) — Quill disables its
  pre-composition range-delete on Android for exactly this.
- 5s stuck-composition timeout (PM `input.ts:455`) — we have 750ms idle,
  different trade-off; verify ours doesn't cancel live compositions.

### G9. iOS specifics

- CM6's `pendingIOSKey`: Enter/Backspace/Delete/Ctrl-emacs allowed to run
  _natively_ then re-dispatched synthetically — prevents the virtual
  keyboard getting stuck in lowercase. We don't appear to have an
  equivalent (verify against `mobile-composition.spec` coverage).
- **Programmatic-focus autocapitalize** — Lexical sets
  `autocapitalize="off"` during programmatic `focus()` (`LexicalEditor.ts`
  1917-1946); iOS otherwise engages caps-lock on focus.
- iOS mid-composition clear-then-reinsert deletions → delayed flush
  (CM6 `domobserver.ts:75`); verify our composition-deferral covers it.

### G10. Composition ordering state machine

We have `isComposing` flags + post-composition Enter/Backspace guards
(Apple WebKit, 500ms window). Missing the explicit per-engine ordering
phases:

- **Safari**: `compositionend` fires _before_ the terminating keydown
  (Lexical `ending-safari`, PM swallows the Enter within 500ms —
  `input.ts:435-452`, we have an equivalent guard ✓ for Enter/Backspace —
  verify the _data_ path too: Safari also fires `insertFromComposition`
  _before_ `compositionend`, Slate `:807-823`).
- **Firefox**: `compositionend` before `input` (Lexical `ending-firefox`);
  Firefox also keeps composing after `compositionend` in some IMEs —
  anchor-offset rewind (`LexicalEvents.ts:1364-1375`).
- **Safari dead keys**: `insertText` during composition without a following
  `compositionend` — CM6 fakes one after 20ms (`input.ts:901-904`). Dead
  keys rely on composition everywhere; if Safari strands them we strand
  `isComposing` until idle-cancel (750ms) — probably survivable, verify.

### G11. Bidi / RTL

Zero bidi handling in the codebase (verified — no `dir`, `bidi`,
`caretBidiLevel`, `findDirection`). Mature editors ship:

- CM6: full UAX#9-lite (`bidi.ts`) + `caretBidiLevel` + visual cursor motion.
- PM: `findDirection` geometry probe for arrow keys over RTL
  (`capturekeys.ts:223-242`).
- Lexical: per-node direction handling, RTL scroll-into-view guard (#2495).

DST has Hebrew text samples — but only _model_ consistency is asserted, not
cursor-side/visual correctness. For RTL users: arrow keys move logically,
not visually; caret lands on wrong sides of direction boundaries; mixed
LTR/RTL selections derive oddly. `formatSetBlockTextDirection` beforeinput
is swallowed. This is a known-big area — worth an explicit product decision
(support vs. document-limitation) rather than an accidental gap.

### G12. Mobile/virtual-keyboard surface

Verified absent: `inputmode`, `enterkeyhint`, `virtualkeyboard`,
`writingsuggestions` attributes; no `visualViewport`/`virtualKeyboard`
listeners; no touch timestamps (synthetic-mouse suppression, CM6
`input.ts:527`); no drag-autoscroll at viewport edges (CM6 quadratic-speed
edge scroll); no touch-selection handling. `enterkeyhint` alone materially
affects mobile UX (`enter` vs `send` vs `newline`).

### G13. A11y surface

Present: `role="textbox"`, `aria-multiline`, `aria-readonly`,
`contenteditable` gating. Missing vs. mature editors:

- `aria-activedescendant`/`aria-controls`/`aria-autocomplete`/`aria-expanded`
  management for typeahead (mentions/slash-menu) — Lexical strips/sets these
  per editable state.
- `aria-live` announcement region (CM6 `EditorView.announce`).
- Screen-reader labeling on special/invisible content (CM6
  `highlightSpecialChars` with `aria-label`).

---

## 4. Confirmed gaps — clipboard & content ingestion

- **Paste during composition**: PM defers to native (`input.ts:656-660`,
  "very poorly handled by browsers" — they _deliberately_ don't intercept).
  Ours: `onPaste` has no composition guard — verify whether a paste arriving
  mid-composition corrupts the preview buffer.
- **`insertFromPasteAsQuotation`**: swallowed (unsupported fall-through).
  Lexical routes it to `PASTE_COMMAND`. Rare but real (context-menu item).
- **Word/Google Docs normalization**: Quill ships `msWord.ts` (mso-list
  styles → real `<ul>/<li data-list>`) and `googleDocs.ts`
  (`docs-internal-guid`, `<b style="font-weight:normal">` unwrap). PM does
  generic `normalizeSiblings`/`maxOpen`. Our `htmlPlugin` parses generic
  HTML — no source-specific normalizers. Paste-from-Word lists will
  flatten/mangle.
- **TrustedTypes CSP**: PM wraps `innerHTML` parsing through
  `maybeWrapTrusted` (`clipboard.ts:211-234`) — strict-CSP environments
  would break our HTML paste path entirely (verify `htmlPlugin`'s parser).
- **`text/uri-list`** fallback (all of PM/CM6/Quill): dragging a link
  produces only `text/uri-list` — swallowed today.
- **Firefox clipboardevents-disabled** (`dom.event.clipboardevents.enabled=false`):
  no paste event at all — Lexical harvests evicted foreign DOM text and
  `insertRawText`s it. Rare config; note as known-limitation.
- **Copy surface**: we write fragment+html+plain ✓. PM additionally stamps
  `data-pm-slice` open-boundary context so partial-structure pastes re-wrap
  correctly — check whether our fragment format preserves open-boundary
  context on partial-structure copies.

---

## 5. Confirmed gaps — selection & pointer

- **`selectstart`**: dead stub, never wired (`selection.svelte.ts:1163`).
  It's the event mature editors use to intercept selection _beginning_
  (e.g., dragging into a non-editable island).
- **Double-click**: only `event.detail` counting for triple-click; native
  double-click → selectionchange works, but PM/Slate handle click-count
  themselves (500ms/100px) because atom-void and boundary cases need
  explicit word/node semantics. Watch item.
- **Drag autoscroll**: none — dragging a selection past the viewport edge
  doesn't scroll (CM6 `input.ts:330-344`).
- **contextmenu/auxclick**: no listeners; PM `forceDOMFlush`es on
  contextmenu so the native menu sees current state. Minor.
- **Middle-click paste (X11 PRIMARY, Linux)**: Lexical avoids
  `Selection.modify('extend')` precisely to preserve PRIMARY (#8766).
  We don't use `modify` — likely fine, but middle-click paste itself is
  untested.
- **Firefox `modify()` double-call at soft-wraps** (#9100): only relevant
  if we adopt `modify`-based motion later.
- **Click clearing stuck mini-selections** (Chrome empty-block case):
  Lexical `onClick` removes stray ranges (`LexicalEvents.ts:538-543`).
  Verify our click path covers the equivalent.

## 6. Confirmed gaps — observer/reconcile depth

- **Runaway repair bound**: Quill caps reconcile at
  `MAX_OPTIMIZE_ITERATIONS=100` (throws rather than spin). Our observer
  requeue/restore loops appear unbounded — a pathological mutation storm
  could spin forever. Verify + bound.
- **Selectionchange-arrives-before-mutations ordering** (IE-era and
  Android): PM/CM6 `flushSoon` rather than trusting the empty mutation
  queue. We have a suppressed-window requeue — probably equivalent; verify
  ordering semantics match.
- **Focus-reset heuristic**: we _have_ `restoreCachedSelectionAfterKeyboardFocus`
  (equivalent to PM/CM6's "browser reset selection to start within ~200ms of
  focus" restore) ✓ — closed.
- **`preventScroll` on focus** — used at `selection.svelte.ts:1757` and
  `edytor.svelte.ts:1442` ✓ — closed.
- **Multi-range**: we normalize Firefox `rangeCount>1` — PM collapses it.
  Ours is _stronger_. Not a gap.
- **Self-inflicted `selectionchange` dedupe**: we have write-dedupe
  (tests exist). Lexical additionally records _exact applied points_ because
  WebKit skips the event entirely when the write matches — verify our
  dedupe doesn't swallow the _next real_ selection after a skipped echo.

## 7. Engine-vs-harness: what's untestable vs. untested

| Gap                              | Type                     | Note                                                                                                                                                                    |
| -------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trusted clipboard/IME/drop       | **automation-inherent**  | No cross-engine API exists; synthetic dispatch is the ceiling. Quill's own IME e2e is Chromium-only via CDP for the same reason.                                        |
| Trusted `deleteByDrag` rejection | **automation-inherent**  | `isTrusted` can't be forged; code path exists untested.                                                                                                                 |
| Foreign mutation injection       | **harness gap, fixable** | Biggest missing DST class: inject random attribute/childList/characterData mutations mid-schedule (Grammarly simulation) and assert self-heal + cross-engine agreement. |
| Pixel-precision text clicking    | **deliberate exclusion** | Font metrics diverge per engine — false positives. Element-granularity retained.                                                                                        |
| UA-mocked branches               | **harness gap, fixable** | `isMac`/`isAppleWebKit`/`isAndroidChrome` regexes never unit-tested; a UA-spoofed lane could at least cover branch selection.                                           |
| Mobile-emulation DST             | **harness gap, fixable** | PW mobile projects exist for specs; DST doesn't run mobile-viewport emulation.                                                                                          |
| Bidi assertions                  | **harness gap, fixable** | Hebrew samples exist but cursor-side correctness isn't asserted.                                                                                                        |
| compositionupdate isolation      | **harness gap, minor**   | Arrival is asserted; no test proving the ignore-by-design.                                                                                                              |
| CI soak lane                     | **process gap**          | `DST_SEEDS=1-24 DST_STEPS=36` ≈3.2min — nightly-sized.                                                                                                                  |

## 8. Hygiene findings (from the audit)

- Dead code: `src/lib/dnd.svelte.ts` (zero imports), `noWhiteSpace` action
  (`Edytor.svelte:233`), `ReadonlyEditor.svelte` (imported, never rendered —
  readonly runs through the editable root with `contenteditable=false`;
  AGENTS.md claims otherwise — doc drift).
- Plugin contract TODOs (`plugins.ts:210-213`): no arrow-event,
  block-focus/select, or select-all plugin hooks.
- `onBeforeInput` plugin hook fires **after** `preventDefault`
  (`onBeforeInput.ts:520-524` vs `621`) — plugins can intercept suppressed
  inputs but cannot veto browser-owned ones.
- `insertText` auto-dot `'. '` special case (`beforeInputCommands.ts:333-352`)
  — the Mac/Android double-space-period fix exists on the _intercepted_
  path; verify the browser-owned reconcile path honors `autocorrect="off"`
  (CM6 rewrites in `domchange.ts:144` because native inserts bypass
  beforeinput there).

## 9. What we already do that some mature editors don't (calibration)

To keep the report honest — areas where the audit shows us _ahead_:

- **Structural-fallback beforeinput synthesis** (keydown → synthetic
  beforeinput when the browser doesn't fire one) — a mechanism none of the
  five have in this form.
- **Unsupported-inputType lockdown**: 14 command types × collapsed+ranged
  asserted zero-mutation (`unsupported-beforeinput.spec.ts`) — mature
  editors swallow unknowns silently with no such contract.
- **Firefox multi-range normalization** — PM collapses to single range; we
  preserve multi-range snapshots.
- **Deterministic vertical extension** (just landed): PM/Lexical still
  surface raw native divergence here; we own the semantic.
- **DST itself**: none of the five editors run a cross-engine, fingerprinted,
  self-shrinking deterministic input harness. Their coverage is
  regression-test accretion; ours is systematic.

## 10. Recommended order of work

**P0 — correctness:**

1. Composition-DOM preservation under concurrent renders (G2) — investigate
   whether a remote-collab edit mid-composition unmounts the composing node;
   if so, implement a composition-node lock (PM `ViewTreeUpdater.lock` model).
2. Observer `attributes` + `characterDataOldValue` (G1) + foreign-mutation
   injection in DST.
3. Undo-scope-walk verification (G7) — one test decides it.
4. Paste-during-composition guard (G-verified-needed).

**P1 — platform:** 5. Non-Latin `event.code`/keyCode fallback (G5) + AltGr exemption. 6. Ctrl+Y + macOS Emacs bindings (G6) — small, high-felt. 7. Incoming drop + file/image paste (G3/G4) — product decision needed on
scope (at minimum: text/plain and file→image). 8. Android preventDefault-ignored deletes + rightward-caret restore (G8).

**P2 — coverage:** 9. Foreign-mutation DST actions + attribute-mutation class. 10. Bidi decision (G11) — support or documented limitation. 11. Mobile attrs (`inputmode`/`enterkeyhint`) + DST mobile-emulation lane. 12. Runaway-repair bound (Quill-style iteration cap). 13. Dead code removal + plugin contract TODOs.

**Explicitly out / informed punts** (mature editors skip these too):

- EditContext API (CM6-only, Android-gated) — watch, don't build.
- Firefox clipboardevents-disabled recovery — rare about:config.
- Multi-range _model_ selection — we already exceed PM here.
- Native `input`-event-only input — PM ignores `input` for content entirely;
  ours uses it correctly as reconcile signal.

---

_Generated from six parallel dossiers (Slate `279f35fd`, Quill 2.x
`slab/quill`, ProseMirror-view `ca4c78e` v1.41.7, Lexical `main`,
CodeMirror view `fbff59ba` v6.41.0) plus a full Edytor event-surface audit.
Upstream file:line cites are in the dossiers; our cites are current-tree._
