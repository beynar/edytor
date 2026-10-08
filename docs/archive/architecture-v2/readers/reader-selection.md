# Selection domain — independent architecture reading

Scope: `src/lib/selection/**` at `feat/crdt-v14-engine` (d9b7de0 + working tree), read-only.
Evidence: source (selection domain + every caller/decider it touches in `edytor.svelte.ts`, `text/`, `block/`,
`events/`, `history/`, `hotkeys*`, `collaboration/`, `crdt/edytor-doc.ts`), tests (`src/tests/fixtures/dom/*selection*`,
`remote-selection-preservation`, `command-simulation`, `crdt/doc/anchors`, `tests/editor-dom/selection*.spec.ts`,
`tests/editor-dst/selectionOracle.ts`), and the allowed contract docs (`editor-delete-contract.md` Anchor/Ownership
sections, `crdt-v14-selection.md`). `docs/archive/selection-contract-consolidation-handoff.md` was listed as context but is a
`*handoff*.md` file and was **not opened** (independence rule wins).

Size history (xloc, same counter): pre-v14 `d6c4781` = 622 → HEAD `d9b7de0` = 2492 → working tree = **3871**
(selection.svelte.ts 2843, selection.utils.ts 599, domSelection.ts 274, replaceSelection.ts 155). +1379 xloc in the
six days after the v14 commit, almost all of it deferred-write / echo / restore machinery.

---

## 1. Required behavior

Stated as guarantees, with no reference to current classes. Tags: [user-visible] [collab-invariant]
[browser-constraint] [test-only].

### 1.1 What a selection is
- **S1** A view has exactly one local selection, of one of four kinds: *none*; *text* (two endpoints in editable
  text, plus direction); *one inline atom* (atomic); *a set of whole blocks* (atomic). A text selection whose endpoints
  coincide is a caret. An atomic block selection is never a caret, even over an empty block. [user-visible]
- **S2** Endpoint offsets are UTF-16 code units inside the display content of one block; an endpoint never sits
  between the two halves of a surrogate pair (caret/start round backward-or-forward per the normalization rule; end
  rounds forward). [browser-constraint]
- **S3** An endpoint can only denote *rendered, editable* text: never a container's unrendered content slot, never
  inside an inline atom, never inside non-editable chrome. [user-visible]
- **S4** Commands can ask, for the current selection: collapsed?, direction, start/end block and text, covered blocks
  in document order, covered texts, at start/end of text, at start/end of block, spans texts?, spans blocks?, enclosing
  island root, enclosing void root, whether a native input inside a void owns focus, marks at the caret (collapsed:
  char before the caret, offset 0 → first run; range: the start edge), selected plain text. [user-visible]

### 1.2 Browser → model (observation)
- **O1** When the user moves the browser selection (click, drag, keyboard, touch handles, double/triple click, native
  word/line motion), the model selection becomes its model equivalent, including direction. [user-visible]
- **O2** Points that land on DOM the model does not represent resolve deterministically: element boundaries around
  inline atoms and mark wrappers, node-bound (element + child index) points, stray whitespace/empty nodes between
  blocks, the trailing-newline marker, placeholder/suggestion overlays (→ the owning block's text; empty block → 0),
  non-editable island chrome (→ first text of the island). [browser-constraint]
- **O3** A range that selects exactly one inline atom and nothing else becomes the atomic atom selection (DOM range
  cleared), and a drag whose endpoints are text on both sides of an atom stays a text range. [user-visible]
- **O4** A cross-block range ending at offset 0 of the next block's first text is read as ending at the end of the
  previous block (triple-click / drag overshoot), so replacing it never consumes the next block. [user-visible]
- **O5** Selections in native form controls, nested foreign editables, outside the editor root, or only partially
  inside it are not the editor's and are ignored; two editors on a page never read each other's selection.
  [user-visible]
- **O6** A selection cannot *start* on non-editable chrome (drag from a handle, atom, placeholder); a nested
  re-enabled editable (void caption) keeps native selection; readonly mode stays selectable. [user-visible]
- **O7** Multi-range selections (Firefox) collapse to their bounding range in both model and DOM; shadow-root
  selections are read through the shadow root or composed ranges. [browser-constraint]
- **O8** A native selection read while the DOM is *ahead of* the model (browser-owned insertion not yet reconciled)
  is interpreted without model-length clamping; a read against a settled DOM is clamped. [browser-constraint]

### 1.3 Model → browser (display)
- **D1** When the editor decides a selection (command result, history restore, remote repair), the browser selection
  shows it as soon as the target text is rendered; if the target is not rendered yet, display waits for it
  (model destination and DOM readiness are separate facts). [user-visible]
- **D2** Backward ranges are displayed backward. [user-visible]
- **D3** A display write never steals focus from a foreign element the user focused — that case gets a model-only
  update and the external focus is preserved. When nothing is focused (`body`, e.g. after our own render detached the
  focused node) the write proceeds. [user-visible]
- **D4** Programmatic writes scroll the caret into view only while handling real user input. [user-visible]
- **D5** Redundant display writes are skipped (each write forces layout). [browser-constraint, perf]

### 1.4 Ownership over time
- **W1** The latest intent wins. A write scheduled from an older state (anything that resumes after an await/timer)
  never lands over a newer user gesture — even one that re-picks the same position — nor over a newer, different
  selection. This holds for every argument form and every exit (success, lookup failure, retry, fallback). [user-visible]
- **W2** The browser's echo of an editor write (selectionchange caused by our own write, by a render replacing text
  nodes under the caret, by Gecko re-anchoring after a node swap, by Android shifting the caret after a canceled
  delete) is not a user intent and must not move the model. A real user move must. [browser-constraint]
- **W3** While an IME composition is active, only the composition owns the caret; no repair writes into the composed
  node. [browser-constraint]
- **W4** An atomic selection (atom / blocks) and an in-progress pointer drag are not overwritten by text-caret repairs.
  [user-visible]

### 1.5 Stability under edits
- **E1** Each text endpoint has a causal identity: it sticks to an atom and a side. Inserts before it shift it; an
  insert exactly at a caret lands after the caret; range start sticks to the first atom inside (boundary inserts stay
  outside), range end to the last atom inside. [collab-invariant]
- **E2** When a merge/split/move reroutes the endpoint's atoms to another block, the endpoint follows the atoms.
  A caret at a block start never migrates into a surviving neighbor that received text at the shared gap; an owning
  block that empties in place keeps the caret at its own start. [collab-invariant]
- **E3** Deleted atoms → the endpoint lands at the gap where they lived. Deleted block → the seam its topmost dead
  ancestor vacated: start of the next live editable sibling (skipping non-editable ones, descending into containers),
  else end of the previous one, else the first editable text of the document. Never a phantom slot.
  [collab-invariant]
- **E4** A range with one unresolvable endpoint collapses to the survivor; both unresolvable → the seam rule.
  [collab-invariant]
- **E5** Remote edits never make a text selection vanish and never turn a caret into a range. A peer that received
  nothing never sees its selection move. [collab-invariant]
- **E6** Anchors are JSON wire values (awareness, history meta) and survive round-trip including the block-start
  owner facet. [collab-invariant]

### 1.6 History
- **H1** Undo/redo issued *in this view* restores this view's selection recorded with the undone/redone change
  (caret, range + direction, or block set), resolved causally; other views sharing the document are not moved (as for
  a remote undo). [user-visible, collab-invariant]
- **H2** A restore is abandoned if a user gesture or a newer document commit lands during its async window. [user-visible]
- **H3** Redo of a block-set deletion places the caret at the adjacent editable content. [user-visible]

### 1.7 Presence and notification
- **P1** The local selection is published as anchors (plus legacy numeric fields) only when it actually changes;
  identical republishes are suppressed; destroying a view removes only that view's entry. [collab-invariant]
- **P2** `onSelectionChange` consumers and plugin hooks see each distinct selection once. [user-visible]
- **P3** Block membership changes fire `onSelect`/`onDeselect`(+`onBlur`) and toggle `data-edytor-selected`;
  focused-block changes fire `onFocus`/`onBlur` and toggle `data-edytor-focused`; no redundant DOM attribute writes
  (they feed the mutation observer). [user-visible]

### 1.8 Keyboard selection semantics owned by the editor
- **K1** Shift+ArrowUp/Down extends by one visual line with goal-column memory, same result in every engine; island
  boundaries are not crossed, void bodies are skipped. [browser-constraint]
- **K2** Whether the current selection came from a node-bound native range is known (Shift+Arrow from that shape is
  engine-defined and must be intercepted). [browser-constraint]
- **K3** Triple-click selects exactly the clicked block's text (void block → block selection); typing then replaces
  only that block's text. [user-visible]

### 1.9 Test-only surface found in production code
- **T1** Debug probes `globalThis.__selDrift`, `__EDYTOR_SEL_DEBUG__`, `__EDYTOR_SEL_LOG__`
  (selection.svelte.ts:1524,1590,1814,2302,2331; edytor.svelte.ts:859). Note `__EDYTOR_SEL_LOG__ ??= []).push(...)` at
  selection.svelte.ts:1590 runs **unconditionally** on every drift revert — an unbounded global array in production.
  [test-only]
- **T2** Tests assign `selection.state = {...}` directly (selection-ownership.test.tsx:148) — the 30-field state is
  de-facto public and writable. [test-only]

---

## 2. Real constraints

What the platform actually forces. Each item names the specific fact and where the code depends on it.

### 2.1 Browser selection API / contenteditable
1. **`selectionchange` is asynchronous, uncancelable, fired on `document`, and fired for our own writes too.** A
   write via `removeAllRanges`/`addRange`/`setBaseAndExtent` produces a later event indistinguishable from a user move
   except by context. → something must classify each event as *echo* vs *intent* (W2). Today: 17 setters of a one-shot
   `ignoreNextSelectionChange` flag (11 of them in 6 files outside the domain), plus four more classifiers (§4 P/O rows).
2. **DOM points are `(node, offset)` where `offset` is a UTF-16 index for text nodes and a child index for
   elements**; Firefox emits element (node-bound) anchors/focuses and multi-range selections; points land on
   whitespace text nodes between blocks. → a DOM-point interpreter is required (O2, O7). `selection.direction` exists
   but the code recomputes direction from `compareDocumentPosition` in four places (selection.svelte.ts:1429-1435,
   1560-1566, 1730-1738, 2395-2401); that formula reports *reversed* whenever the focus node is an **ancestor** of the
   anchor node (CONTAINS|PRECEDING), regardless of the child index — wrong for Firefox node-bound forward extensions.
3. **`addRange` does not scroll** and forces synchronous layout; Firefox focuses a contenteditable on `addRange`
   alone. → explicit scroll-into-view gated on user input (D4), dedupe predicates (D5), foreign-focus check before any
   deferred write (D3).
4. **Backward ranges need `setBaseAndExtent` (or `collapse`+`extend`)**; `addRange` is always forward.
   (`restoreBackwardDomRange`, selection.svelte.ts:284-313.)
5. **`selectstart` is the only event before a drag selection starts**; `contenteditable=false` subtrees cannot hold
   a caret. → O6 guard; atom/void/island chrome mapping.
6. **Shadow DOM:** `document.getSelection()` retargets to the host; Chromium has `ShadowRoot.getSelection()`,
   standards track has `Selection.getComposedRanges({shadowRoots})`. (domSelection.ts:31-41, 218-237, 334-359.)
7. **Hit testing:** `caretPositionFromPoint` (Gecko/standard) vs `caretRangeFromPoint` (WebKit/Blink).
   (selection.svelte.ts:1229-1246.)
8. **Engine-specific echoes (documented in code, pinned by tests):**
   - Gecko re-anchors the DOM caret at the *same absolute offset* when the text node under it is swapped by a render,
     "observed bouncing twice" while a remount chain settles (selection.svelte.ts:258-266, 3218-3226).
   - Gecko clamps / Blink keeps the offset when a render re-splits text under a live caret (2318-2324).
   - Android Chrome mutates the DOM after a *canceled* `deleteContentBackward` and then reports the caret one
     position right of the model merge point (244-256).
   - Native vertical extension (Shift+Up/Down) differs per engine (3340-3355).
9. **`beforeinput.getTargetRanges()`** declares word/line delete units (platform segmentation) and may be absent or
   collapsed; target ranges can straddle model boundaries. → the event layer adopts the target range into the model
   selection before running commands (onBeforeInput.ts:190-237).
10. **IME composition:** composition events are not reliably cancelable; replacing the DOM node the IME is composing
   into breaks the composition. → W3; the render pin; no repair writes during composition.

### 2.2 Svelte 5
1. **DOM updates are batched and applied after the synchronous block; `tick()` resolves after the flush.** A model
   write's text node does not exist until then → every display write must wait for mount (D1). The code implements
   this wait at least **8 separate times** (getTextNode's 10×tick loop edytor.svelte.ts:1844-1857; the 10-attempt
   loops in setAtTextOffset 3087-3137, setAtRange 3498-3628, setAtBlockRange 3707-3784; history-restore loops
   1075-1110 and 840-938; `deadEndpointRecoveryPending`+`Text.attach` 2656-2677; `restoreSelectionAfterBlockRangeDeletion`
   beforeInputDeleteCommands.ts:26-63 (10×10 ms); hotkeys `focusFallbackBlock` tick+30 ms hotkeys.ts:681-695).
2. **Keyed `{#each}` / `{#key}` destroy and recreate DOM.** Text spans are keyed by `index:JSON(marks)`
   (Text.svelte:31-32, 232) so a mark change replaces text nodes under a live caret; `{#key edytor.editorDomRevision}`
   (Edytor.svelte:222) remounts the whole editor subtree on `refreshEditorDom()`. → carets on detached nodes, the
   Gecko/Blink echoes above, and `node.isConnected` retries.
3. **`$state` reassignment is the reactivity trigger**; `SvelteSet` mutations are reactive. The 30-field `state`
   object is replaced wholesale on every derive, which is why "state identity changed" cannot mean "position changed"
   (the `stateMatchesSelectionTarget` field compare exists because of this, selection.svelte.ts:492-507).

### 2.3 Vendored Yjs v14 engine + placement/ownership model
1. **Relative positions bind to an item id `(client, clock)` plus `assoc`;** `assoc < 0` is left-sticky for any
   negative value (the `-2` owner-facet trick relies on it, edytor-doc.ts:2104-2119); `{i:null}` sentinels encode live
   start/end (crdt/text/model.ts:913-929).
2. **Resolution:** a tombstoned item resolves to the gap where it lived (`followUndoneDeletions=false`, the only
   replica-independent mode, crdt/text/model.ts:840-872); an item not yet integrated resolves to `null` (converges
   later) — so "unresolvable" is not "deleted" (contract rule 4).
3. **A block's display content is not one text type.** It is the concatenation of slice claims into *backing texts*
   (possibly other blocks'), with merge claims; ownership is computed per replica (placement/model.ts:36-45). A display
   offset in block B maps to `(backing text t, index)` through `T.flatten` + ownership. Both `anchorAt` and
   `resolveAnchor` compute a fresh ownership view: "O(doc) per call" (edytor-doc.ts:1985-1990). → anchors are the only
   causal position identity; `(block, offset)` is a *view*.
4. **Block order is rank-based placement records `{p, r}` with LWW candidates and an independent `del` flag**
   (placement/model.ts:11-35). A deleted block keeps its registry entry and winning placement → "the slot a dead
   block vacated" is a replicated fact, recoverable from the document itself.
5. **The UndoManager is document-shared**: `stack-item-added/updated/popped` reach every listener (every view);
   `stack-item-popped` is emitted synchronously inside `undo()/redo()` (vendor UndoManager.js:119); items merge within
   `captureTimeout` = 500 ms and emit `stack-item-updated` (UndoManager.js:227-253); stack-item `meta` is an in-memory
   Map, never persisted → there are no "pre-U09 snapshots" at runtime.
6. **Remote updates are transactions with a foreign origin**; the facade `onChange` runs after commit, before
   Svelte's flush (edytor.svelte.ts:844-897).

### 2.4 Wrapper-identity facts imposed by the mirror (not by the platform, but load-bearing today)
1. A bound text wrapper's id is **positional**: `t:${blockId}:${segOrd}` (text.svelte.ts:778, re-aliased at 568).
   Inserting an inline atom before a segment changes which segment an id names. Text ids and text paths (undo
   snapshot fallback, awareness legacy fields, composition `textId`, focus-restore cache) are therefore positions,
   not identities.
2. Wrappers die silently: `_drop`/`reconcileContent` `_kill` wrappers without calling the per-text change hook, so a
   selection holding wrapper references can point at dead objects until someone re-resolves
   (selection.svelte.ts:2440-2450 comment; flushMirror calls the repair after every change, edytor.svelte.ts:1176-1195).
   This is a consequence of storing wrappers in the selection, not a platform constraint.

---

## 3. Fact → authoritative owner → lifetime → consumers

"Owner (should be)" = the party that has the information, the right lifetime and the authority. "Deciders today"
lists every place that independently decides the fact. **⚑ = decided in more than one place.** Paths without a
directory prefix are in `src/lib/selection/selection.svelte.ts`. Findings marked *(probe)* were reproduced with
throwaway vitest probes in the scratchpad against the unmodified repo (see §7).

| # | Fact | Owner (should be) | Lifetime | Consumers | Deciders today |
|---|------|-------------------|----------|-----------|----------------|
| F1 | Text endpoint position (block, text segment, UTF-16 offset) | A pure resolution of the endpoint's anchor against the current document version | Per (selection value, doc version) | ~100 `setAtTextOffset` callers, 98 `state.startText` reads, `yStart` 56, `yEnd` 21 (all of events/hotkeys/plugins/clipboard) | ⚑ **Four state constructors**: `applySelectionSnapshot` builds its own 30-field object (1962-1998); `buildSelectionState` (2810-2915) used by `setRangeStateAtTextOffsets` 2917, `setCollapsedStateAtTextOffset` 2946, `restoreRelativePosition` 2230, `restoreDeadSelectionEndpoints` 2497; spread-patch variants `setStateFromSelectedBlocks` 2688-2702 and `setStateFromBlockContentRange` 2720-2726. Plus five *repairers* that re-derive position after the stored wrapper/offset went stale: `restoreRelativePosition` 2158-2287, `reconcileSelectionAfterRemoteApply` 2325-2438, `restoreDeadSelectionEndpoints` 2451-2662, `writeCollapsedCaretState`/`writeRangeCaretState` 3160-3216, `restoreDriftedEchoCaret` 1522-1604 |
| F2 | Endpoint causal identity: anchor + affinity (start 'right'/caret 'left'/end 'left') | Minted once when the endpoint is set; stored as the endpoint itself | Until the next selection write | awareness, history, remote repair, composition pin | ⚑ Affinity rule decided in **5 places**: 1989-1992 (DOM derive), 2905-2910 (model build, with a `startAffinity:'left'` override for block selections 2694/2713), `createUndoSelectionSnapshot` 640-650, `createAwarenessSelection` collaboration/awarenessSelection.ts:235-262, `resolveDeadCaretTarget` 3148-3158 (calls `facade.anchorAt` directly). Anchors are re-minted (O(doc) each) on every derive, every emit (awareness re-mints instead of reusing `state.relativePosition`), every history push. For a block selection the three stored start anchors disagree: state binds **left**, undo snapshot and presence bind **right** *(probe: `rp:-1` on `selectBlocks`)* |
| F3 | Direction | Browser (observed) or the writer (decided) — stored once | Selection value | commands (7 reads), presence, history | ⚑ DOM formula copied 4× (1429-1435, 1560-1566, 1730-1738, 2395-2401), all wrong when the focus node is an ancestor of the anchor node *(probe: forward native range → `yStart 11, yEnd 1, isReversed true, content ""`)*; model-side inference in `setAtRange` (3433-3440, "inherit reversed if same endpoints"), `normalizeTextRangePoints` 789-826, `extendSelectionVertically` 3386-3395 |
| F4 | Collapsed | Derived: endpoints equal **and** kind = text | Derived | 37 reads | ⚑ `domSelection.ts:112-113` (ignores native `isCollapsed`), 1851-1854 (re-collapses equal endpoints), 2827 (`buildSelectionState`), forced `false` for block kinds 2697/2723 |
| F5 | Selection kind + precedence (none/text/atom/blocks) | One tagged field on the selection value | Selection value | every command; `onSelectionChange` 1471-1474; hotkeys | ⚑ Encoded in four containers — `selectedBlocks` (SvelteSet, 318), `selectedInlineBlock` + `inlineBlockDeletionTarget` (319-320, "one selection" kept in two fields, 675-687), `state.startText !== null`, and `hasSelectedAll` (321, **never written**; read by `Block.selected` block.svelte.ts:135). A block selection is *also* written into `state` as a text range (2679-2703), so every consumer must check `selectedBlocks.size` before trusting `state` (e.g. hotkeys.ts:197-205 checks three containers) |
| F6 | Covered blocks/texts/contentParts, spanning flags, at-edge flags | Derived view of F1 | Derived | commands, clipboard | ⚑ Block walk + contentParts duplicated 1937-1956 vs 2830-2849; contentParts fallback differs (`[]` 1956 vs `[startText,endText]` 2847); `getTextsInSelection` computes a `texts` set with a TreeWalker (selection.utils.ts:415-463) that **no caller uses** (1744-1748 keeps only `startText/endText/inlineBlock`) |
| F7 | Island root / void root of the selection | Derived from the start block's ancestry | Derived | hotkeys.ts:509-525, CodePlugin.svelte:49-60, beforeInputDeleteCommands.ts:150-170 | ⚑ DOM derive climbs and **stops at the innermost** (1876-1893) and additionally trusts `data-edytor-void` DOM attributes (1895-1906); model build climbs to the **outermost** (2865-2874); `islandRootOfBlock` selection.utils.ts:634-643 (innermost); `Block.insideIsland` block.svelte.ts:141-150; `Text.attach` insideVoid text.svelte.ts:915-921. Same position, different `islandRoot` depending on which writer produced the state (latent while islands do not nest) |
| F8 | Marks at the caret | Derived on read | Derived | tests + toolbar-style consumers of `onSelectionChange` (no `src/lib` reader) | Single rule `getMarksAtSelection` 540-554 (good), but evaluated eagerly on every derive from two builders (1995-1997, 2912-2913) and part of the emit-dedupe key |
| F9 | Selected content string / length | Derived from model text | Derived | `length` for single-text deletes (beforeInputDeleteCommands.ts:121,213), `content` hotkeys.ts | ⚑ DOM `selection.toString()` for cross-text ranges (1931-1936, includes atom/chrome text) vs model slices joined (2851-2859) |
| F10 | DOM point → (text, offset) | One interpreter with an explicit mode: settled DOM vs DOM-ahead-of-model | Per read | selection derive, beforeinput, input, paste, focus restore | ⚑ `getTextOfNode`+`getYIndex` selection.utils.ts:269-319, 473-551; `getTextContentOffsetAtPoint` events/domTextOffset.ts:19-56 (claims "the same rule as getYIndex", differs: no empty-text rule, ancestor child-index rule); `getBeforeInputTextTargetRange` onBeforeInput.ts:103-119 calls `getTextOfNode` **without** the offset, so element-boundary resolution is skipped for the safety check while the subsequent derive uses it; beforeInputCommands.ts:442-451; onPaste.ts:112-124; edytor.svelte.ts:1958-1967; pointer hit-test 1229-1281 (+ Text.svelte:50-66 re-deciding every click the browser already resolved). Overlay/placeholder mapping alone is decided in 5 spots: selection.utils.ts:277-284, 1750-1768, 1801-1807, 1856-1859, selection.utils.ts:547-549 |
| F11 | (text, offset) → DOM point | One mapper | Per write | all DOM writers, remote rendering | ⚑ `findTextNode` 2972-2996; `findDomPoint` collaboration/remoteSelection.ts:138-167 (same walk, different fallback) |
| F12 | Block display offset ↔ text segment offset | The text segment (one function) | Per doc version | anchors, typed mutations | ⚑ `Text.segStart` text.svelte.ts:339-366, `Block.partOffsetOf` block.svelte.ts:816-848 ("mirrors exactly"), `resolveTextAnchor` 2080-2156 (two strategies inside: projection by `segOrd`, then wrapper walk) |
| F13 | Side effects of a selection change (focusedBlocks, clearing the other kinds, suggestions reset, `onSelectionChange`, plugins, presence) | One commit point for every selection write | Per write | UI, plugins, peers | ⚑ Seven writers, five different side-effect sets: DOM derive does all (1770-1771, 1809, 1914-1925, 1958, 1999); `setRange…`/`setCollapsed…` skip suggestions (2939-2943, 2961-2969); `setStateFromBlockContentRange` 2717-2727; `selectBlocks`→`setStateFromSelectedBlocks` **never emits**; `restoreRelativePosition` unfocused 2230 and `restoreDeadSelectionEndpoints` 2497 **neither emit nor refocus blocks**. *(probe: unfocused remote deletion moves the model to the seam but `onSelectionChange` count stays 1, presence keeps the dead text id, `focusedBlocks` keeps the dead block; `selectBlocks` emits nothing and presence keeps the old caret)* |
| F14 | Current selection intent / write admission ("is this deferred write still wanted?") | One monotone selection-intent epoch compared by every async continuation | From intent to next intent | every deferred writer | ⚑ **16 mechanisms**: `stale()` in setAtTextOffset 3054, setAtRange 3486, `blockStale` 3684 + `pendingBlockRangeRequest` 378/2731/3680-3782; history `isCurrentRestore` 1033-1036 + `historySelectionRestoreVersion` 379 + `historyRestoreGestureSerial` 331; `restoreRangeSelectionSnapshot` ownedState 834-906; `scheduleCaretWriteVerification` 3227-3275; remote reconcile serial 2353-2356; `onSelectionChange` latch 1452-1466; edytor.svelte.ts `stabilizeCompositionSelection` 1496-1570 (`armedSerial`); `restoreCachedSelectionAfterKeyboardFocus` edytor.svelte.ts:1928-2015 (state compare); `scheduleStructuralKeyFallback` edytor.svelte.ts:1379-1440 (timer identity); hotkeys.ts:190-216 and 218-245 (state compare, **no gesture check**); history/historySelectionSnapshot.ts:77-96 (command+doc version, **no gesture check**); onInput.ts:699-710 (liveness only); beforeInputDeleteCommands.ts:26-63 (only `destroyed`) |
| F15 | Is this `selectionchange` an echo, drift, or user intent? | The same epoch: DOM ≠ last displayed target ∧ no gesture since → echo/drift; else intent | Per event | model | ⚑ `ignoreNextSelectionChange` one-shot flag set at 17 sites (11 outside the domain: hotkeys.ts:213,241,522; navigation.ts:167; inlineBlock.svelte.ts:164,172; onInput.ts:702,707; MentionPlugin.svelte:42,46; historySelectionSnapshot.ts:163) and read by onKeyDown.ts:91; `ignoreNextSelectedBlockSelectionChange` 346/1468-1471/1691-1692/2733 (+hotkeys.ts:240,521); `nativeSelectionMatchesCurrentBlockSeam` 1412-1448; `restorePostDeleteShiftedCaret` 1619-1651 + `recordPostDeleteCaretTarget` 1663-1685 (6 call sites); `restoreDriftedEchoCaret` 1522-1604 with `lastEchoGestureSerial` 1496/1507; `reconcileSelectionAfterRemoteApply` DOM compare 2387-2428; `scheduleCaretWriteVerification` "back to pre-write" 3252-3262 |
| F16 | May a write touch the DOM (focus verdict)? | One predicate | Per write | all writers | ⚑ `foreignFocusOwnsSelection` 3010-3020 treats `body` focus as **writable**; `restoreRelativePosition` 2213-2217 and `restoreDeadSelectionEndpoints` 2482-2486 treat `body` as **unfocused → model-only**; `scheduleCaretWriteVerification` 3242-3249 treats `body` as **stop**; domSelection.ts:268-271 (scroll); edytor.svelte.ts `stabilizeCompositionSelection` 1520-1545 (own rule). Same DOM state, three verdicts *(probe: jsdom leaves `body` focused after `setNativeSelection`; the dead-endpoint repair then takes the model-only branch)* |
| F17 | DOM readiness (target text mounted?) and waiting for it | One display projector re-run after each flush/mount | Until DOM matches intent | every writer | ⚑ ≥8 wait loops (see §2.2-1): `getTextNode` edytor.svelte.ts:1844-1857 inside the 10-attempt loops of setAtTextOffset 3087-3137, setAtRange 3498-3628, setAtBlockRange 3707-3784; history loops 840-938, 1075-1110; `deadEndpointRecoveryPending` 452/2662 + `notifyTextMounted` 2673-2677 + `Text.attach` text.svelte.ts:932; beforeInputDeleteCommands.ts:26-63; hotkeys.ts:681-695 |
| F18 | Undo selection snapshot: content, which one, staleness | The selection value (kind + anchors) recorded per view per stack item; one restorer | Stack-item lifetime (in-memory) | undo/redo in this view | ⚑ Writer 983-996 (+ five external `queueNextUndoSelectionSnapshot` callers). **Two restore pipelines run for the same undo**: the pop handler 998-1161 (anchors first, id/path fallback, `restores ?? snapshots`, deletes `restores`) and `runHistoryCommand` events/undoRestore.ts:22-66 → history/historySelectionSnapshot.ts:65-167 (id/path + `yEnd` only, `preferRestore` only on redo, collapsed only). Meta keys duplicated (245-246 vs historySelectionSnapshot.ts:37-38); `getTextByPath` duplicated (564-575 vs historySelectionSnapshot.ts:109-121); "current text" defined two ways (path round-trip 588-589 vs `isInDocument` historySelectionSnapshot.ts:123). `queueBrowserOwnedInputSelectionSnapshot` onInput.ts:78-95 overrides the numeric fields but **not** the anchors, so one snapshot can describe two positions; independently, the two pipelines always read different halves of the snapshot (anchors vs numbers). *(probe: same undo after a remote insert before the caret → caret 5 via `beforeinput historyUndo`, 8 via `edytor.historyUndo()`; 8 is correct)* |
| F19 | Seam destination when the endpoint's block(s) vanish | One pure rule on replicated placement (slot of the dead block = its `{p, r}`) | Per resolution | remote repair, history redo, block deletion, cut | ⚑ **Five rules**: `restoreDeadSelectionEndpoints` 2537-2654 (forward start via `_dropNext`, else backward `lastEditableText` end, else root first editable); history pop redo fallback 1051-1066 (previous sibling **by path**, `firstEditableText` **end**); undoRestore.ts:34-50 (`closestPreviousBlock` — may be the parent — `?? closestNextBlock`, `firstEditableText` end); replaceSelection.ts:133-143 + consumers hotkeys.ts:681-691, onCut.ts:24-27 (closest unselected neighbor, else `parent.children[index] ?? [index-1] ?? root.children[0]`); beforeInputDeleteCommands.ts:37-39 (`root.children[0]?.firstText` — can name a phantom slot, which the contract forbids) |
| F20 | Presence payload | Serialization of the selection value | Per change | peers | ⚑ Re-derived from `state` + re-minted anchors in awarenessSelection.ts:235-262; change detection decided twice (emit dedupe 453-470 over 17 fields, `publishedEntryEquals` awarenessSelection.ts:341-353 + final structural guard) |
| F21 | "The range selects exactly one inline atom" | One rule on model boundaries | Per derive | inline-atom UX | ⚑ DOM rule selection.utils.ts:340-375; model rule 181-207; inverse rule on pointerup 1319-1370; hotkeys/navigation.ts:165-169 |
| F22 | Selection came from a node-bound native range | Recorded with the observation that produced it | Until next derive | hotkeys/navigation.ts:504 | Single owner (2012-2019, 2030-2044); signature string duplicated at 2012 and 2041 |
| F23 | Vertical goal column | Single | Consecutive Shift+Up/Down | — | Single owner (3338-3403) |
| F24 | Pointer drag in progress | Single | pointerdown → pointerup/cancel | four repair guards (1532, 2170, 2348, 2459) | Single owner, cleared from edytor.svelte.ts:2086-2089 (document-level) |
| F25 | Keep the model block-range for the next text insertion (triple-click) | Selection value (a "block content" range) | Until next insertion or pointerdown | onBeforeInput.ts:152-156 | Two fields (376-377) + `isStateBlockContentRange` 692-701 re-checks shape; armed at 1204-1208 |
| F26 | Text id / text path as pointers | Should not be used as identity at all (positional: `t:<block>:<segOrd>`) | — | legacy presence fields, history fallback, composition, focus cache | ⚑ Path computed in 556-562 and events/events.utils.ts:16-19; id resolution with try/catch in 590-604 and collaboration/remoteSelection.ts:115-136 |

Net: of 26 facts, 20 are decided in more than one place; 6 of those duplications produce **different answers for the
same input** (F3, F7, F13, F16, F18, F19), and three of the six are reproduced by probes.

---

## 4. Machinery inventory

xloc measured with the shared counter on the exact line ranges (`xrange.mjs`). Classes: **REQUIRED** (a guarantee
from §1 needs it), **CONSTRAINT-DRIVEN** (a §2 fact forces it), **HISTORICAL** (exists because of how the solution
accumulated; the invariant that makes it unnecessary is named). Mixed rows give the split.

### 4.1 `selection.svelte.ts` (2843)

| Mechanism | Lines | xloc | Class | Why it exists / replacing invariant |
|---|---|---|---|---|
| Imports, types | 1-56 | 40 | overhead | scales with the file |
| Overlay / placeholder DOM helpers | 102-179 | 64 | CONSTRAINT-DRIVEN, duplicated | Placeholder/suggestion chrome (O2) — but `getTextOfNode` already maps overlays (selection.utils.ts:277-284). **Invariant:** *a point inside overlay chrome is interpreted once, by the point interpreter, as the end of the owning block's last text.* |
| `getInlineBlockBetweenBoundaryTexts` | 180-208 | 24 | REQUIRED | O3, model-side rule |
| Android UA + timing constants | 209-283 | 17 | CONSTRAINT-DRIVEN | UA sniff also copied in events/events.utils.ts:8-14 |
| `restoreBackwardDomRange` | 284-314 | 28 | CONSTRAINT-DRIVEN | D2 (`setBaseAndExtent` / `extend` fallback) |
| Fields + 30-field default `state` | 315-452 | 60 | HISTORICAL | **Invariant:** *the stored selection is `{kind, anchor, focus \| ids}`; every other field is a derived view.* |
| Emit dedupe (`emittedStatesMatch`, `emitSelectionChange`) | 453-482 | 30 | HISTORICAL | 17-field compare over a state object that is replaced on every derive. **Invariant:** *emit iff the selection value changed (compare kind + anchor JSON + direction).* |
| Ownership predicates, `caretSignature`, `scheduleReassert` | 483-531 | 26 | HISTORICAL | **Invariant:** *one selection epoch; a continuation acts only if the epoch it captured is current.* |
| `getMarksAtSelection` | 532-555 | 15 | REQUIRED | S4; should be a lazy getter |
| Path/id helpers, `resolveSnapshotEndpoint` | 556-630 | 60 | HISTORICAL | Positional fallback for history. **Invariant:** *history stores the selection value; an unresolvable anchor takes the same seam rule as a remote deletion; ids/paths are never identities* (in-memory stack items cannot hold "pre-U09" snapshots). |
| Undo snapshot creation / queue | 631-658 | 28 | REQUIRED (shrinks) | H1: snapshot = current selection value |
| `destroy` | 659-674 | 8 | REQUIRED | |
| Inline-atom selection + triple-click preservation | 675-721 | 41 | mixed | Atom kind REQUIRED (O3); the preservation flag pair exists so a beforeinput target range re-reporting the browser's triple-click range does not overwrite the model's block range — **Invariant:** *an observation older than the current intent never overrides it* (epoch). |
| Chrome / island pointer helpers | 727-788 | 53 | CONSTRAINT-DRIVEN | O2/O6; `getBlockOfNode`-style lookups duplicated with selection.utils |
| `normalizeTextRangePoints` | 789-827 | 32 | REQUIRED | model ordering of endpoints |
| History restore (`restoreRangeSelectionSnapshot` + `init` listeners) | 828-1183 | 270 | ~50 REQUIRED / ~220 HISTORICAL | Required: per-view snapshot record on added/updated (35), issuer-only pop (≈10), "apply snapshot". Historical: three restore shapes each with its own 10-attempt loop (blocks 55, range 27+92, caret 24), `[0,30]` re-asserts, version+serial latches, a private redo seam rule. **Invariant:** *a restore is one ordinary selection write (epoch bump) displayed by the projector; failures use the common seam rule.* |
| Triple click | 1184-1228 | 42 | CONSTRAINT-DRIVEN | K3 (browser triple-click overshoots into next block) |
| Pointer hit-testing | 1229-1293 | 58 | CONSTRAINT-DRIVEN, partly suspect | `caretPositionFromPoint`/`caretRangeFromPoint` needed for chrome clicks; the per-offset `getBoundingClientRect` scan (1256-1281) is O(text length) layout reads per click, and Text.svelte:50-66 re-decides every plain click the browser already resolved |
| Drag + block-collapse at pointer | 1294-1371 | 66 | CONSTRAINT-DRIVEN | O3 drags across atoms; clicking into a block selection collapses it |
| `onSelectStart` | 1372-1411 | 21 | CONSTRAINT-DRIVEN | O6 |
| `nativeSelectionMatchesCurrentBlockSeam` | 1412-1449 | 35 | HISTORICAL | A special echo case. **Invariant:** *a DOM selection equal to the last displayed target is an echo.* |
| `onSelectionChange` | 1450-1506 | 37 | REQUIRED entry (shrinks) | today a cascade of five latches/flags before deriving |
| `restoreDriftedEchoCaret` | 1507-1605 | 81 | CONSTRAINT-DRIVEN (as a separate classifier: HISTORICAL) | Gecko/Blink render drift is real (§2.1-8) — but it is the same rule as the post-write verification and the post-remote reconcile. Also reverts *any* programmatic DOM selection that arrives without a gesture (probe, §7 C4). |
| Android post-delete snap-back | 1606-1686 | 53 | CONSTRAINT-DRIVEN | follows a gesture (beforeinput), so it needs its own signature; recorded from 6 call sites |
| `applySelectionSnapshot` | 1687-2022 | 289 | ~110 REQUIRED/CONSTRAINT, ~170 HISTORICAL, ~9 test-only | Required: admission (31), whitespace/atom/no-text branch (27), UTF-16 + next-block-start normalization (≈30), boundary atom (11), node-bound key. Historical: its own state construction (island/void 31, content/blocks/parts 24, state object 36, edges 21) duplicating `buildSelectionState`, placeholder/overlay re-mapping (26), per-writer side effects. Direction formula (21) is wrong for ancestor focus nodes (probe). |
| `hasNativeNodeSelection` key | 2023-2045 | 11 | CONSTRAINT-DRIVEN | K2 |
| `createTextAnchor` | 2046-2070 | 11 | REQUIRED | E1 |
| `resolveTextAnchor` | 2071-2157 | 62 | REQUIRED core, duplicated mapping | block offset → segment is also `Text.segStart` / `Block.partOffsetOf`; the wrapper-walk fallback (2138-2156) is a second strategy. **Invariant:** *the segment owns its offset mapping; the projection is the only source of segment boundaries.* |
| `restoreRelativePosition` | 2158-2288 | 104 | HISTORICAL (≈20 CONSTRAINT-DRIVEN) | Re-derives position because the state stores wrappers+offsets. **Invariant:** *the stored endpoint is the anchor; position is recomputed per document version.* The external-focus repair on blur (≈20) is the only constraint-driven part. |
| `captureSelectionForRemoteApply` + `reconcileSelectionAfterRemoteApply` | 2289-2439 | 120 | HISTORICAL (≈20 test-only probes) | **Invariant:** *after every render flush the projector compares DOM with the intended display and rewrites if they differ and no gesture intervened.* |
| `restoreDeadSelectionEndpoints` + `notifyTextMounted` | 2440-2678 | 173 | ~55 REQUIRED / ~118 HISTORICAL | Required: the seam rule (E3/E4). Historical: focus branching, `applyState` without emit, `writeResolved` variants, the pending flag, the `_dropNext/_dropPrev` dependency. **Invariants:** *dead-endpoint resolution is part of the pure projection* and *the slot of a dead block is its replicated placement `{p, r}`* (no wrapper-lifetime neighbor links). |
| `setStateFromSelectedBlocks` / `setStateFromBlockContentRange` | 2679-2729 | 44 | HISTORICAL | spread-patch writers. **Invariant:** *kind is a tag on the value; one builder.* |
| `selectBlocks` / add / remove / `focusBlocks` | 2730-2800 | 60 | REQUIRED (duplicated ×3) | P3; hook+attribute logic triplicated |
| `buildSelectionState` | 2801-2916 | 95 | REQUIRED as the single derived view | should also serve DOM-derived selections |
| `setRangeStateAtTextOffsets` / `setCollapsedStateAtTextOffset` | 2917-2971 | 46 | REQUIRED API (shrinks) | model-first writes |
| `findTextNode` | 2972-2997 | 23 | REQUIRED | shared with remote rendering (F11) |
| `foreignFocusOwnsSelection` | 2998-3021 | 11 | REQUIRED | single focus predicate (F16) |
| `setAtTextOffset` | 3022-3138 | 85 | HISTORICAL (≈8 API) | staleness closure, mount polling, detached retry, model fallback, verification arm. **Invariant:** *a write sets the selection value synchronously; display is the projector's job under the epoch.* |
| `resolveDeadCaretTarget` / `writeCollapsed…` / `writeRange…` | 3139-3217 | 60 | HISTORICAL | A target wrapper dying during the await. **Invariant:** *writes capture anchors at call time, before any await.* |
| `scheduleCaretWriteVerification` | 3218-3276 | 45 | CONSTRAINT-DRIVEN (as separate mechanism: HISTORICAL) | Gecko re-anchor; subsumed by the projector's post-flush compare |
| `setAtTextsRange` | 3277-3326 | 38 | HISTORICAL | one caller (CodePlugin.svelte:60), a stripped copy of `setAtRange` without staleness gate |
| `scrollCaretIntoView` wrapper | 3327-3337 | 5 | REQUIRED | D4 |
| `extendSelectionVertically` | 3338-3417 | 53 | CONSTRAINT-DRIVEN | K1 |
| `setAtRange` | 3418-3629 | 165 | HISTORICAL (≈25 DOM write REQUIRED) | 66 xloc of target/normalization/staleness setup + 99 of retry loop. The DOM range write itself belongs to the projector. |
| `setAtBlockRange` | 3630-3786 | 132 | HISTORICAL | **Invariant:** *a block-content range is an ordinary selection value.* |
| `setAtNodeOffset` | 3787-3810 | 18 | REQUIRED | the projector's collapsed write primitive |

### 4.2 `selection.utils.ts` (599)

| Mechanism | Lines | xloc | Class | Note |
|---|---|---|---|---|
| Element helpers, selectors | 1-48 | 30 | overhead | |
| `isTextBoundSelectionPoint` | 49-53 | 4 | CONSTRAINT-DRIVEN | K2 |
| Element-boundary resolution (`isIgnoredBoundaryNode` … `getTextElementAtBoundary`) | 54-197 | 105 | CONSTRAINT-DRIVEN | O2 |
| Stray-boundary resolution | 198-234 | 32 | CONSTRAINT-DRIVEN | Firefox stray whitespace nodes |
| `getTextOffsetAtElementBoundary` | 235-268 | 26 | CONSTRAINT-DRIVEN, **buggy** | applied before the in-element walk, it maps every `(textElement, i)` after a bare run to `text.length` (probe, §7 C5); last two branches (258-264) are unreachable (already covered by 250-256) |
| `getTextOfNode` | 269-320 | 47 | REQUIRED | canonical point→text |
| `getInlineBlockOfNode`, `getInlineBlockInSelectedRange` | 321-376 | 46 | ~15 REQUIRED / ~31 HISTORICAL | DOM version of the atom-selected rule (F21) |
| `getTextsInSelection` | 377-472 | 86 | ~10 REQUIRED / ~76 HISTORICAL | its TreeWalker `texts` result is discarded by the only caller |
| `getYIndex` | 473-553 | 65 | REQUIRED | should carry the "DOM ahead of model" mode instead of events/domTextOffset.ts duplicating it (O8) |
| Visual lines + vertical destination | 554-706 | 119 | CONSTRAINT-DRIVEN | K1; `islandRootOfBlock` duplicates F7 |
| `normalizeUtf16Boundary` | 707-732 | 18 | REQUIRED | S2 |
| `getRangesFromSelection`, `climb`, `climbDom` | 733-754 | 21 | overhead | |

### 4.3 `domSelection.ts` (274) and `replaceSelection.ts` (155)

| Mechanism | xloc | Class | Note |
|---|---|---|---|
| Shadow/document selection + active element access | 49 | CONSTRAINT-DRIVEN | §2.1-6 |
| `domSelectionIsCollapsedAt` / `domSelectionCoversRange` | 34 | CONSTRAINT-DRIVEN | D5 |
| Snapshot constructors (incl. `…FromRange`, `…FromStaticRange`) | 44 | ~20 HISTORICAL | synthetic snapshots exist so that a *write* can be fed back through the *read* path (`applySelectionSnapshot(createDomSelectionSnapshotFromRange(...))` in every writer). With model-first writes the read path is only for real observations. |
| Multi-range canonicalization | 45 | CONSTRAINT-DRIVEN | O7 |
| Composed ranges | 18 | CONSTRAINT-DRIVEN | O7 |
| `scrollCaretIntoView` | 61 | REQUIRED | D4 |
| `getDomSelectionSnapshot` | 23 | CONSTRAINT-DRIVEN | |
| `SelectionReplacementState` + copier | 32 | HISTORICAL | a fourth copy of selection fields (with `BeforeInputSnapshot`, `UndoSelectionSnapshot`, awareness payload); **Invariant:** *commands receive the immutable selection value.* |
| `getClosestUnselectedBlock` | 11 | HISTORICAL | one of five seam rules (F19) |
| Replace-selection / remove-selected-blocks commands | 112 | REQUIRED | operation-layer commands living in the selection folder |

### 4.4 Outside the domain but deciding the domain's facts (not in the 3871)

| Mechanism | xloc | Class | Replacing invariant |
|---|---|---|---|
| history/historySelectionSnapshot.ts (whole file) | 111 | HISTORICAL | second history restore pipeline (F18) — *one restorer* |
| events/undoRestore.ts selection parts | ~30 of 49 | HISTORICAL | same |
| events/domTextOffset.ts | 43 | CONSTRAINT-DRIVEN, duplicated | O8 is real; belongs as a mode of the one interpreter |
| hotkeys.ts `restoreStructuralHotkey*` + `focusFallbackBlock` | 68 | HISTORICAL | projector + epoch (they also call `refreshEditorDom()` — a full subtree remount — at tick, 30 ms and the repair window) |
| beforeInputDeleteCommands.ts `restoreSelectionAfterBlockRangeDeletion` | 32 | HISTORICAL | projector; its fallback can target a phantom slot |
| edytor.svelte.ts `restoreCachedSelectionAfterKeyboardFocus` | 63 | ~30 REQUIRED | focus-in restore is a real requirement; the rest re-implements ownership checks |
| edytor.svelte.ts `stabilizeCompositionSelection` | 58 | CONSTRAINT-DRIVEN (IME post-commit caret jumps) | would become "composition commit = selection write; projector handles delayed jumps" |
| edytor.svelte.ts `getTextNode` polling | 14 | HISTORICAL | projector readiness |
| block.svelte.ts `_dropNext/_dropPrev` | 9 | HISTORICAL | seam from replicated placement |
| collaboration: `findDomPoint`, `createAwarenessSelection`, dedupe | 27 + 21 + 35 | ~50 HISTORICAL | presence = serialized selection value; one model→DOM mapper |

---

## 5. Distinctions that must stay explicit

Each pair below is a place where two facts look alike; the parenthesis names the bug that merging them causes.
Several are already merged today (marked **merged today**).

1. **Causal identity (anchor: backing atom + side) vs display position (block, segment, offset).** The position is a
   view of the identity. (Store only the position → remote inserts before the caret leave it stale — the reason
   `endPosition` was added; store only a text id → `t:<block>:<segOrd>` names a different segment after an atom is
   inserted before it.)
2. **Insert affinity vs owner facet at a seam** (`a.a <= -2` + `o`). (One bit for both → either the caret absorbs a
   boundary insert, the `nにello` corruption, or a split-start caret migrates into the neighbor that received text —
   contract rule 1.)
3. **Result selection of a local command vs anchor-following.** A local insert at a left-affine caret lands to the
   anchor's *right*; the command must set its own result. (Let anchor-following decide local results → typing leaves
   the caret before each typed character.) Anchor-following is only for changes the view did not author.
4. **Model destination vs DOM readiness.** (Merge → "no node yet" is read as "no destination", stranding the caret on
   dead content after a whole-document remote delete — contract F2 pin.)
5. **Phantom content slot vs temporarily unmounted editable text.** (Merge → a caret parked on a container's
   unrendered slot silently swallows the next keystroke — former UNRESOLVED-2; or real texts are skipped during a
   remount.) `beforeInputDeleteCommands.ts:37-39` still falls back to `root.children[0]?.firstText`, which can be a
   phantom.
6. **Echo of our own display vs render drift vs foreign programmatic write vs user move.** (**merged today** for the
   last three: "no gesture since the last admitted echo ⇒ drift". Consequence: a host application, an extension or
   assistive tech that sets the DOM selection without a pointer/key event is reverted — probe C4. Render drift can
   only happen after a flush; a foreign write can happen without one. Distinguishing them needs a render epoch, not
   more gesture heuristics.)
7. **User gesture vs the editor's own focus/selection side effects** (`expectInternalFocus`). (Merge → every restore
   that calls `.focus()` bumps the serial and cancels itself.)
8. **Issuing view vs sibling view of a shared document** (history). (Merge → one view's undo yanks every sibling's
   caret to a snapshot recorded long ago.)
9. **Prepared intent vs execution attempt** for undo snapshots. A snapshot queued by a command must belong to *that
   command's* transaction. (**merged today**: `nextUndoSelectionSnapshot` is consumed by whichever stack item comes
   next, and `queueBrowserOwnedInputSelectionSnapshot` overrides the numeric half but not the anchor half, so one
   snapshot can name two positions — C10, predicted. Even without an override the two restore pipelines read
   different halves of every snapshot, anchors vs numbers, which diverge as soon as a remote edit shifts the text —
   probe C1.)
10. **Observation against a DOM ahead of the model** (native insertion pending reconcile — no clamping, O8) **vs
    observation against a settled DOM** (clamped; empty-text rule). (Merge → the typed character is lost from the
    caret offset, or the caret overshoots the model.) Today this is two separate interpreters that drift apart
    (events/domTextOffset.ts vs selection.utils.ts `getYIndex`); it should be one interpreter with a mode.
11. **Point outside a text element vs point inside it.** Element-boundary rules (atom/block neighbors) apply to points
    *between* text elements; inside a text element the offset is a child-index walk. (**merged today**: the boundary
    rule runs first for inside points and returns `text.length` — probe C5.)
12. **Atomic kinds vs text ranges.** A block selection over an empty block is not a caret; an atom selection is not a
    range. (Merge → Backspace on a selected empty block runs caret-merge instead of deleting the block.) Today the
    distinction exists but is encoded twice (a set plus a synthetic text range in `state`), so every consumer must
    re-apply the precedence.
13. **Foreign focus (user chose another element) vs orphaned focus (`body`, typically because our own render
    detached the focused node).** (**merged inconsistently today**, F16: one predicate writes the DOM on `body`, two
    others go model-only, one stops. Merge wrongly → either steal focus from a user-chosen control, or never display
    the caret after our own remount.)
14. **Unresolvable because not yet integrated vs unresolvable because deleted.** (Merge → a remote peer's caret whose
    item has not arrived is drawn at a seam instead of being skipped until the update lands; for local history the
    same merge would jump the caret to a seam on a transient.)
15. **Capability vs permission:** readonly removes the permission to edit, not the capability to select/copy.
    (Merge → readonly editors lose selection; O6 excludes the root for this reason.)
16. **Request order vs arrival order of programmatic writes.** (**merged today**: staleness is "did `state` change since
    my call", which is also true when an *older* request lands first — probe C7: request caret@4 then range 2-6, the
    range is dropped because the caret's single lookup resolved first.)

---

## 6. Representation candidates

### R1 — The selection *is* an immutable value whose text endpoints are anchors; everything else is a derived view

```ts
type SelectionValue =
  | { kind: 'none' }
  | { kind: 'text'; anchor: DocAnchor; focus: DocAnchor }   // minted once, at the write; direction = order(anchor, focus)
  | { kind: 'atom'; blockId: BlockId; atomId: string }
  | { kind: 'blocks'; ids: readonly BlockId[] };
```

- `view = project(value)` — a pure function memoized on `(value, facade.version)` — yields today's public fields
  (`startText/yStart/endText/yEnd/isCollapsed/isReversed/blocks/texts/at-edge/spanning/islandRoot/voidRoot`), with
  `currentMarks` and `content` as lazy getters. Unresolvable anchors resolve through the seam function (R3) inside the
  projection. `selection.state` can stay as a compatibility getter over `view`, so the ~300 consumer reads do not move.
- One commit point `select(value, cause)`: bumps the epoch (R2), sets the value, applies *all* side effects once
  (focused/selected block attributes and hooks from `view.blocks` and `kind`, suggestion reset, one
  `onSelectionChange`, presence = serialize(value)). No writer can skip a side effect any more (fixes C2, C3).
- The undo snapshot of a stack item is the value current when its first local transaction began (capturable in the
  transaction wrapper). No queue, no override, no `restores` map, no id/path fallback.

**Disappears:** the 30-field default state and both duplicate builders' second copies (≈45 + 44 + ≈112 in
`applySelectionSnapshot`); `restoreRelativePosition` (104, except ≈20 of blur repair that moves into R2);
the application half of `restoreDeadSelectionEndpoints` (≈118); `writeCollapsed/RangeCaretState` +
`resolveDeadCaretTarget` (60); the 17-field emit dedupe (30 → ≈8); path/id restore helpers (60);
`queueNextUndoSelectionSnapshot` plumbing and its five callers' overrides; `SelectionReplacementState` (≈20);
outside the domain: the `_setItems` restore hook (text.svelte.ts:755-760), history/historySelectionSnapshot.ts (111),
the selection half of events/undoRestore.ts (≈30), presence re-minting and double dedupe (≈40).

**Invariant that replaces them:** *the only stored selection facts are the value's anchors/ids; position, covered
blocks, flags and marks are a pure function of (value, document), and anchors are minted exactly once, by the write
that creates the value.* Wrappers can then die silently without any repair, because nothing stores them.

Honest costs: anchor resolution is O(doc) per call (edytor-doc.ts:1985-1990) — memoized once per commit it is *less*
work than today (two mints per derive plus re-mints for presence and history). Local commands must keep writing their
result selection (distinction 3). Mirror lag (wrapper not created yet) is handled by the existing block-offset
fallback in the projection.

### R2 — One display projector and one selection epoch own every DOM selection write and every echo decision

State: `epoch` (bumped by `select`), `gesture` (bumped by real input — already exists), `render` (bumped when a flush,
remount or pin release touched editor DOM), `displayed = {epoch, domRange, render}`.

- `display()` is the only code that touches `Selection`. It runs after `select`, after each flush (the existing
  `tick()` continuation of the facade `onChange`, edytor.svelte.ts:890-895), on `Text.attach`, and on
  `selectionchange`. It writes iff the single focus predicate allows (foreign focus vs orphaned focus, distinction
  13), the target texts are mounted, and the DOM differs from the target. It always writes the *current* value, so
  there are no deferred writers whose staleness must be judged; request order = epoch order (fixes C7).
- One `selectionchange` classifier: DOM = `displayed.domRange` → echo; composition active → ignore; gesture advanced
  or pointer drag active → user intent (`select`); no gesture but `render` advanced → drift → `display()`; no gesture
  and no render → foreign programmatic write → adopt (fixes C4). The Android post-delete signature is the one
  remaining special case (its "gesture" is the delete itself).

**Disappears:** `ignoreNextSelectionChange` (17 setters, 11 of them in 6 files outside the domain) and
`ignoreNextSelectedBlockSelectionChange`; `nativeSelectionMatchesCurrentBlockSeam` (35); `restoreDriftedEchoCaret`
(81 → ≈15 inside the classifier); `captureSelectionForRemoteApply` + `reconcileSelectionAfterRemoteApply` (120);
`scheduleCaretWriteVerification` (45); the staleness closures, mount polling and 10-attempt loops of `setAtTextOffset`
/ `setAtRange` / `setAtBlockRange` (382 → ≈45 of API plus the two DOM-write primitives); `setAtTextsRange` (38);
`pendingBlockRangeRequest`; `restoreRangeSelectionSnapshot` (92) and ≈140 of the pop handler's loops/latches;
`scheduleReassert`; the `deadEndpointRecoveryPending` side channel; synthetic `DomSelectionSnapshot` construction for
writes (≈20). Outside: `getTextNode` polling (14), hotkeys `restoreStructural*`/`focusFallbackBlock` (68),
`restoreSelectionAfterBlockRangeDeletion` (32), onInput's 30 ms re-assert, most of `stabilizeCompositionSelection`'s
rAF/0/30 ms timers and of `restoreCachedSelectionAfterKeyboardFocus`'s ownership checks.

**Invariant that replaces them:** *only the projector writes the DOM selection and it always writes the current
value; an observation becomes intent only if it is explained neither by the last display (echo) nor by render churn
since it (drift).* W1 becomes structural instead of a per-exit discipline enforced by review.

Honest costs: needs a trustworthy "after flush" signal and a render counter maintained at the few places that mutate
editor DOM (flush, `refreshEditorDom`, pin release); the IME post-commit caret jump must be re-proven in real
browsers once its timers are gone (browser lane, not jsdom); a per-epoch re-display budget replaces the
`attemptsLeft = 3` bound.

### R3 — The slot of a vanished block is replicated placement data, and there is one seam function

A deleted block keeps its registry record and winning placement `{p, r}` (`resolvePlacements` iterates every
registry record, placement/model.ts:273-300). `seam(id)`: climb while the display parent is dead; among the live
parent's visible children ordered by `(rank, id)`, the first with rank > r (start of its first editable text,
descending, skipping non-editable), else the last with rank < r (end of its last editable text), else the document's
first editable text.

**Disappears:** `_dropNext/_dropPrev` capture (9) and the wrapper-link climb (≈25 of the 70-xloc seam walk); the
history pop redo fallback (≈12); the undoRestore redo fallback (≈8); `getClosestUnselectedBlock` + `blockToFocus`
fallbacks (≈20) and their consumers' "end of `firstEditableText`" convention; the phantom-capable fallback in
`restoreSelectionAfterBlockRangeDeletion`. Five rules (F19) become one.

**Invariant that replaces them:** *a vanished endpoint lands at its block's replicated slot — the same answer on every
replica and for every cause (remote delete, redo, cut, block-set delete), independent of mirror drop order.*

Honest costs: ≈15-20 xloc move into the facade (a placement query for hidden blocks) — moved, not deleted. It changes
behavior for redo/cut, which today land at the *end of the previous block's first editable text*; the contract only
specifies the remote case, so the maintainer must decide the unified rule from the contract, not from the old engine.

---

## 7. Falsifying counterexamples

"Verified" = reproduced with throwaway vitest probes (jsdom, the repo's DOM harness, unmodified source) kept in
`scratchpad/sel-reader/probes/*.probe.test.ts` with outputs in `scratchpad/sel-reader/probes/out*.jsonl`. Expected
results are derived from §1 / the contract docs, not from either code path.

### Verified

- **C1 — same undo, two carets (concurrent + history).** `Hello world`, caret @5, type `abc` (caret @8), remote peer
  inserts `XYZ` at 0 (caret rides to @11), undo.
  Via `beforeinput historyUndo` (also the hotkey path, both through events/undoRestore.ts): caret **@5**
  (`XYZHe|llo world`). Via `edytor.historyUndo()`: caret **@8** (`XYZHello| world`). Expected (H1 + E1): @8.
  Exposes F18: the pop handler resolves the anchor; `runHistoryCommand` restores the stale numeric `yEnd` by text id
  afterwards and lands last.
- **C2 — unfocused peer loses its caret for everyone else (remote deletion).** Caret in `Second`@3, focus an outside
  button, remote deletes `Second`. Model moves to `First`@5 (correct seam) but `onSelectionChange` is not called
  (count stays 1), awareness still publishes `startTextId` of the dead text @3, and `focusedBlocks` still holds the
  dead block. With the editor root focused the same deletion emits and republishes. Expected: P1/P2 regardless of
  focus. Exposes F13 (side effects owned by individual writers).
- **C3 — block selection is invisible to consumers and peers.** `selectBlocks(block)` after a caret: no
  `onSelectionChange`, presence keeps the old caret, and `state.relativePosition` is bound left (`a:-1`) while the
  undo snapshot and presence would bind the same start right. Exposes F5/F13/F2.
- **C4 — a programmatic DOM selection is reverted as "drift".** Editor focused, then
  `getSelection().setBaseAndExtent(text@1 → end)` without a pointer/key event, then `selectionchange`: the model stays
  collapsed @0 and `restoreDriftedEchoCaret` schedules a DOM re-write back to @0 (1593-1600). Any host code, extension
  or assistive technology that moves the selection is undone. Exposes distinction 6 (drift vs foreign write
  conflated).
- **C5 — element-boundary point inside a text element.** Paragraph `ab` + bold `cd` + `ef`; DOM point
  `(textElement, i)`: `getYIndex` returns **6** for every child index after the `ab` text node (expected 2 right after
  `ab`, 4 right after the bold span). Exposes distinction 11 (outside-element boundary rule applied first).
- **C6 — node-bound focus inverts the range.** Forward native selection anchor `text@1`, focus
  `(textElement, childCount)`, with a gesture: model `yStart 11, yEnd 1, isReversed true, content ""` — start after
  end in one text, direction wrong. Exposes F3 (direction formula ×4) and the absence of a single commit point that
  would enforce `start ≤ end`.
- **C7 — request order vs arrival order.** From caret @1: `setAtTextOffset(text, 4)` then `setAtRange(text, 2, 6)`
  (no awaits between). Final: caret **@4** — the later request is dropped because the earlier one resolved its single
  node lookup first and `setAtRange`'s staleness test sees "state changed since my call". The reverse order ends at
  the later request. Expected (W1): the later request wins in both orders. Exposes F14.
- **C8 — atomic selection of a block deleted remotely.** Block-select `bb` in `[aa, bb, cc]`, remote deletes `bb`:
  `selectedBlocks` still holds the dead block (`_live:false`), `state.startText/startBlock` are dead, no emit. The
  dead-endpoint repair returns early for atomic selections (2456-2458). The next Delete/Backspace acts on a dead block
  set. Exposes F5 (kind not part of the resolvable value) — the "empty collection after concurrent change" case.

### Predicted by reading (not executed)

- **C9 — composition + remote deletion of the host block.** `restoreDeadSelectionEndpoints` has no composition guard
  (2451-2462) while `reconcileSelectionAfterRemoteApply` (2358-2361) and the per-text restore call site
  (text.svelte.ts:754) do; with the editor focused it writes a DOM caret into the seam block mid-composition.
- **C10 — merged stack item.** Typing followed within `captureTimeout` by a browser-owned text-local deletion
  (`queueBrowserOwnedInputSelectionSnapshot`, onInput.ts:78-95) triggers `stack-item-updated` with an override: the pop
  handler restores `restores` (before the typing), `runHistoryCommand` restores `snapshots` (the override's numeric
  half) — two carets again, on mobile where deletions are browser-owned.
- **C11 — redo of a nested block-set deletion.** Select the first child of a list, delete, undo, redo: the pop
  handler lands at "block at the same path → end of its first editable text"; `runHistoryCommand` lands at
  `closestPreviousBlock` (the parent) → end of its first editable text; the remote-deletion rule would land at the
  next sibling's start. Three answers to one question (F19).
- **C12 — nested islands/voids.** Any future island inside an island (or void in void) gets `islandRoot` innermost
  from DOM derives and outermost from model writes (F7); the island-escape hotkeys then act on different blocks
  depending on how the caret got there.
- **C13 — a queued snapshot outliving its command.** A command that queues an undo snapshot but commits nothing (e.g.
  a browser-owned input whose reconcile finds no change) leaves `nextUndoSelectionSnapshot` armed; the next unrelated
  edit's stack item records the stale override (distinction 9).
- **C14 — retry exhausted.** When the target text's node stays detached or missing for the whole retry budget,
  `setAtTextOffset` ends with a model-only write (3134), while `setAtRange` (loop 3498-3628) and `setAtBlockRange`
  (loop 3707-3784) simply fall out of their loops — neither model nor DOM is written, and the caller's `await`
  resolves as if it succeeded. The same "not displayable yet" condition yields a moved model caret through one API and
  an unchanged selection through the other two (distinction 4 handled three ways).

---

## 8. LOC

### 8.1 Current (execution LOC, shared counter)

| File | xloc | at HEAD d9b7de0 | pre-v14 d6c4781 |
|---|---|---|---|
| selection.svelte.ts | 2843 | 1755 | 445 |
| selection.utils.ts | 599 | 402 | 177 |
| domSelection.ts | 274 | 183 | — |
| replaceSelection.ts | 155 | 152 | — |
| **Total** | **3871** | **2492** | **622** |

### 8.2 Floor and how it was derived

Method: every mechanism in §4 was sized from its exact line range, then assigned the xloc that survives under
R1+R2+R3 **with feature parity** (all of §1, including Android snap-back, Gecko/Blink drift handling, shadow roots,
multi-range, vertical extension, triple-click, presence, per-view history). Survivors are estimated by listing what
each mechanism still has to do, not by percentage. New code the candidates require (projector, commit point, the
DOM-ahead mode, the canonical overlay mapping) is **added** to the floor, not netted out.

`selection.svelte.ts` 2843 → **≈1000**

| Survives as | xloc | From (now) |
|---|---|---|
| Observation: admission, one direction helper, no-text/atom branch, UTF-16 + next-block-start normalization, boundary-atom rule, value construction, node-bound provenance | 113 | `applySelectionSnapshot` 289 + node-bound key 11 (drops its private state build 112, overlay re-mapping 26, debug 8, 3 of 4 direction copies) |
| Projection `project(value)` incl. lazy marks/content, island/void, covered blocks/texts | 80 | `buildSelectionState` 95 |
| Anchor mint + resolve (segment mapping delegated to its single owner) | 36 | 11 + 62 |
| Seam over replicated slot + editable descent + root fallback | 45 | dead-endpoint recovery 173 |
| History: listener lifecycle, per-view record at transaction start, issuer-only `select(snapshot)`, snapshot = value | 53 | 270 + 28 |
| Unified `selectionchange` classifier (echo / composition / gesture / drift / foreign) + DOM↔target compare | 45 | `onSelectionChange` 37 + drift 81 + block-seam match 35 |
| Android post-delete snap-back | 30 | 53 |
| Projector `display()` (mount check, compare, dispatch, budget) — **new** | 45 | replaces setAtTextOffset 85, setAtRange 165, setAtBlockRange 132, verification 45, reconcile 120, texts-range 38 |
| Focus predicate (foreign vs orphaned) + blur-time external-focus repair | 34 | 11 + ≈20 of `restoreRelativePosition` 104 |
| Model→DOM point mapper | 18 | `findTextNode` 23 |
| DOM write primitives (collapsed, range with backward fallback, dedupe) | 56 | `setAtNodeOffset` 18 + `restoreBackwardDomRange` 28 + the range write inside `setAtRange` |
| Commit point `select()` (side effects once, emit by value, presence) — **new** | 38 | emit dedupe 30 + five partial side-effect sets |
| Public write API kept for ~120 call sites (`setAtTextOffset`, `setAtRange`, `setAtBlockRange`, `setCollapsed…`, `setRange…` as thin value builders) | 38 | 46 + wrappers |
| Block set / focused set with one hook+attribute helper; block-kind value builders | 36 | 60 + 44 spread-patch writers |
| Pointer: triple click, hit test, drag across atoms, block collapse, chrome pointerdown, `selectstart` | 156 | 42 + 58 + 66 + 53 + 21 (drops timer nesting and the O(n) rect-scan duplication) |
| Vertical extension, goal column | 45 | 53 |
| Fields (value, epochs, displayed, sets, drag start, goal), constants, UA import, imports | 48 | 60 + 17 + 40 |
| Marks, normalizeTextRangePoints, boundary-atom model rule, destroy, scroll gate, inline-atom kind | 82 | 15 + 32 + 24 + 8 + 5 + 41 |
| **Sum** | **≈1000 (998)** | 2843 |

`selection.utils.ts` 599 → **≈465**: element-boundary + stray resolution kept (137 → 127); boundary-offset rule
restricted to points outside text elements, dead branches removed (26 → 14); `getTextOfNode` becomes the only overlay
mapper (47 → 62, ≈20 moved in); `getYIndex` gains the DOM-ahead-of-model mode instead of events/domTextOffset.ts
(65 → ≈70); `getTextsInSelection` keeps only the endpoint lookups (86 → 10); the DOM atom-in-range rule goes
(46 → 15); `islandRootOfBlock` duplicate goes (119 → 108); UTF-16 + helpers (73 → 59).

`domSelection.ts` 274 → **≈230**: synthetic write-snapshots go (44 → 22); multi-range, composed ranges, shadow access,
dedupe predicates, scroll stay (≈208).

`replaceSelection.ts` 155 → **≈102**: `SelectionReplacementState` becomes the immutable value (32 → 12);
`getClosestUnselectedBlock` goes to the seam function (11 → 0); the three commands stay (112 → 90).

**Floor ≈ 1,800 xloc (998 + 465 + 230 + 102 = 1,795; honest range 1,700-1,950) versus 3,871 today: −54 %.**
Rough attribution of the ≈2,076 xloc removed (overlaps assigned to the first candidate that removes them): R2
(projector + epoch) ≈ 900 net of the ≈45 it adds; R1 (value + derived view + commit point) ≈ 600 net of the ≈38 it
adds; R3 ≈ 40; representation-independent cleanup (dead TreeWalker result, `hasSelectedAll`, debug probes, the 4×
direction formula, overlay re-mapping, `setAtTextsRange`, duplicated UA/path helpers) ≈ 300; trimming of retained
mechanisms (pointer, vertical extension, utils/domSelection helpers) ≈ 240.

### 8.3 What the number does not show

- **Moved, not deleted:** R3 adds ≈15-20 xloc to the facade (placement query for hidden blocks); the overlay mapping
  and the DOM-ahead mode move into selection.utils.ts (counted above).
- **Enabled deletions outside the domain (not counted in the floor):** history/historySelectionSnapshot.ts 111,
  undoRestore selection half ≈30, events/domTextOffset.ts 43 (≈10 absorbed), hotkeys restore/fallback 68,
  `restoreSelectionAfterBlockRangeDeletion` 32, `getTextNode` polling 14, ≈35 of `stabilizeCompositionSelection`,
  ≈30 of `restoreCachedSelectionAfterKeyboardFocus`, `_dropNext/_dropPrev` 9, presence re-mint/dedupe ≈40,
  `ignoreNextSelectionChange` sites in 6 files — **≈420 xloc** more.
- **Bundle vs source:** the domain has no heavy dependencies; the saving is mostly executed branches and timers, so
  source reduction should translate roughly 1:1, but that was not measured.
- **Extension cost:** adding a selection kind (e.g. table cells) today touches the 30-field state, four builders,
  seven writers' side-effect sets, two dedupes, the undo snapshot and its three restore shapes, and the echo latches.
  After R1/R2 it is one union variant, one projection branch and one display branch.
- **Risk concentration:** the floor removes every timer-based re-assert. The constraint facts behind them (Gecko
  re-anchor bounce, Android post-delete shift, IME post-commit jumps) are real; R2 claims they are all "gesture-less
  `selectionchange` after a render" or a gesture-carrying special case. That claim must be proven in the real-browser
  lanes (`tests/editor-dom`, `pnpm test:dst` on all three engines) before the old machinery is removed — jsdom cannot
  falsify it.
