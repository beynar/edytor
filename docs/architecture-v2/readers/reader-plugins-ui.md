# Domain reader: plugins-ui (plugins, components, hotkeys, clipboard, dnd)

Status: complete (run 2026-09-26 15:02–15:40). Probes: `scratchpad/pui/probes/*.probe.test.ts`, config `scratchpad/pui/vitest.probe.config.mjs`.

Scope (execution LOC, `xloc.mjs`): `src/lib/plugins/**` 3780 · `src/lib/components/**` 614 · `src/lib/hotkeys.ts` 667 · `src/lib/hotkeys/navigation.ts` 589 · `src/lib/clipboard/**` 518 · `src/lib/dnd/pragmatic.ts` 3 → **6171 xloc / 40 files**. Collateral machinery that exists *because of* decisions made in this domain but lives elsewhere is named explicitly (e.g. `src/lib/text/removeStalePlaceholders.ts`, 192 xloc) and is not counted in the domain total.

## 1. Required behavior (guarantees, stated without implementation names)

Tags: [user-visible] a person editing can observe it · [collab-invariant] must hold across replicas/peers · [browser-constraint] forced by the platform · [test-only] pinned only by a fixture, no user/collab need behind it.

### 1a. Rendering
- R1 [user-visible] The document renders as a tree: every block shows its own inline content (text runs + inline atoms) and, separately, its nested children, through a renderer chosen by the block/mark/atom type that an extension registered. Unknown types must not crash the view.
- R2 [user-visible] A change of a block's type or of type-relevant data (e.g. heading level) re-renders that block's element; unrelated blocks keep their DOM.
- R3 [user-visible] One element per visual mark run: adjacent runs with the same mark set render as one wrapper; toggling a mark must not clone or duplicate text nodes (`tests/editor-dom/hotkeys.spec.ts:500`, `demo-route.spec.ts:164`).
- R4 [browser-constraint] An empty text must still host a caret (needs a non-empty text node); a trailing `\n` must be visibly rendered.
- R5 [user-visible] An empty block (its only content is one empty text) shows a placeholder (string or custom); it disappears as soon as the block has text by *any* path (typing, IME commit, remote edit, programmatic update, undo), never duplicates, never appears beside inline atoms, and is not shown during an active IME composition (`placeholder-repair.spec.ts`, 9 tests).
- R6 [user-visible] Clicking a placeholder puts the caret at offset 0 of that block's text (`slash-menu.spec.ts:67`, `navigation-selection-sync.spec.ts:24`).
- R7 [user-visible] Inline suggestions ("ghost text") render after the block content, are not editable, not selectable, not hit-testable; accepted/dismissed by extension keys (Tab / Escape in code lines).
- R8 [collab-invariant] Render-only decorations (syntax tokens) never reach the stored document, and are never inherited by newly inserted text.
- R9 [collab-invariant] Values from untrusted sources (remote peers, pasted HTML, native commands) are made safe at the render boundary: link hrefs restricted to safe schemes, CSS color values cannot escape the declaration.
- R10 [user-visible] Readonly shows the same tree, not editable; handles hidden; copy allowed; cut/paste ignored.
- R11 [user-visible] The editable root carries spellcheck/autocorrect/autocomplete/autocapitalize defaults that the consumer can override; optional `inputmode`/`enterkeyhint` are absent unless set (`features.spec.ts:81,100`).
- R12 [user-visible] Mounting the editor neither focuses it nor creates a selection (`features.spec.ts:23`).

### 1b. Keyboard commands
- K1 [user-visible] Key bindings compose in precedence order consumer > extensions (in list order) > built-ins; the first handler that claims a key suppresses the platform default and all later handlers; a handler that does not claim lets the next one run.
- K2 [user-visible] `mod` = Cmd on Apple, Ctrl elsewhere; on Apple bare Ctrl is a distinct modifier (Emacs/Cocoa bindings ctrl+h/d/k/o/a/e/b/f/p/n work there and only there).
- K3 [browser-constraint] A chord whose produced key is non-ASCII (Cyrillic, Greek…) with Cmd/Ctrl held resolves through the physical key position; ASCII keys are never reinterpreted (Dvorak); AltGr (incl. Windows ctrl+alt) and dead keys are text input, never commands; `ISO_Left_Tab`/`BackTab` are Shift+Tab.
- K4 [user-visible] Undo/redo (mod+z, mod+shift+z, ctrl+y off-Apple) restore the selection that was current at the step, and do nothing while a foreign control has focus (`undo-scope.spec.ts`).
- K5 [user-visible] Tab / Shift+Tab nest / outdent the caret block (or the one selected block) keeping the caret offset (or the block selection).
- K6 [user-visible] Select-all escalates: caret in block text → that block's text range → the block as a selected object → all top-level blocks; inside a code island the first step selects the whole island text (`structural-keys.spec.ts:108`).
- K7 [user-visible] With blocks selected: Backspace/Delete removes them in one undo step (extensions may intercept) and puts the caret at the end of the fallback block; Escape collapses to the end of the first selected block; ArrowUp/Down move the single block selection (island-aware); Shift+ArrowUp/Down extend it in document order; Shift+ArrowDown at a text end selects a following void block.
- K8 [user-visible] With an inline atom selected: Backspace/Delete removes it and the caret lands on the adjacent text; a printable key replaces it.
- K9 [user-visible] Horizontal arrows cross inline atoms (Shift selects the atom as a unit) and block boundaries at text edges, in visual direction under RTL; word motion is Alt+Arrow on Apple, Mod+Arrow elsewhere, and crosses atoms/blocks; Home/End go to block boundaries; PageUp/PageDown and Mod+Up/Down go to document boundaries; Shift variants extend (`selection.spec.ts:2401-2520`).
- K10 [browser-constraint] Vertical Shift-extension and Shift+horizontal extension of node-bound selections are owned by the editor because engines disagree (Firefox collapses/drops focus, WebKit flips direction, Blink no-ops).
- K11 [user-visible] mod+enter splits at the end of the block and moves the caret to the new block.

### 1c. Clipboard
- C1 [user-visible] Copy/cut write three flavours: a private fragment type, HTML that also embeds the fragment (survives clipboards that drop custom types — [browser-constraint]), and plain text.
- C2 [user-visible] Paste precedence: private type → fragment embedded in HTML → extension paste hooks (external data only) → files (claimed by an extension or dropped, never pasted as file names) → plain text / uri-list through the normal text-insertion path. Shift-paste prefers plain text. During IME composition the native paste proceeds untouched. A paste targeted at a nested foreign editable belongs to that editable.
- C3 [collab-invariant] Pasted blocks/atoms never keep copied ids; marks, data, children and order are preserved.
- C4 [user-visible] Selection shape decides fragment shape: range inside one block → inline content (spliced at the caret on paste); range across blocks → blocks with partial first/last content and nesting reconstructed; selected blocks → whole blocks with children. Pasting over selected blocks replaces them.
- C5 [user-visible] Copy creates no history entry; cut and paste are exactly one undo step each; cut/paste ignored in readonly.
- C6 [user-visible] External HTML maps tags to registered types (overridable per tag), lists become list items, links are sanitized, script/style/head/comments are dropped, entities decode, malformed input degrades without throwing.
- C7 [test-only] Invalid tag mappings (types not registered) make the paste throw *after* default prevention and before mutation, validated against every mapping including unused ones (`clipboard.fixtures.tsx:238,296`; `html-deserialize.fixtures.ts:283-867`, ~12 fixtures). No user benefits from a paste that silently does nothing; registry mutation after init (`edytor.blocks.delete('heading')`) is not a real scenario.
- C8 [test-only] Trailing inline content after the last block element merges into that block (`'<p>Content</p>After'` → one paragraph `ContentAfter`), while leading inline content stays a separate fragment (`html-deserialize.fixtures.ts:1030-1098`). Browsers render trailing text as its own line; the asymmetry is an artifact of the tokenizer, not a stated requirement.

### 1d. Extension features
- X1 [user-visible] Typing at the trailing edge of a link does not extend the link unless the DOM caret is inside the anchor (`plugins.spec.ts:22`).
- X2 [browser-constraint] Native formatting input types (formatBold…formatRemove, font/back color, insertLink, insert(Un)OrderedList, insertHorizontalRule) become model operations; a horizontal rule never destroys existing text.
- X3 [user-visible] Markdown prefixes typed at the start of an eligible block (`# ## ### - * 1. [ ] [] > --- ```) convert the block, remove the prefix and leave the caret at offset 0.
- X4 [user-visible] Slash menu: `/` in an eligible block opens a command list filtered by the text typed after it; arrows cycle; Enter/click runs the command after removing `/query`; Escape closes and keeps the text; moving the caret out of the query closes it.
- X5 [user-visible] Selection toolbar: visible for a non-collapsed text selection outside readonly/void/island/block-selection; toggles marks; applies/edits/removes a link (pre-filled from the selection); focusing its link field must not lose the target range; the text selection is restored after each action.
- X6 [user-visible] Code block: structurally isolated; auto-pairs brackets/quotes; Tab inserts `\t` or accepts a suggestion; Escape dismisses a suggestion; Shift+Enter splits the line; pasted multi-line text becomes several lines; merges across the code boundary are guarded; tokens are decorations only.
- X7 [user-visible] Void blocks (image): body not editable, caption editable, native controls inside own their keys and composition.
- X8 [user-visible] `@` inserts a mention atom with the caret after it (demo-level).
- X9 [user-visible] Block handles: one per non-root block outside island interiors, vertically centred on the first rendered text row (island: header row), hidden in readonly; click → the block becomes the selection and a consumer callback gets (block, handle element); Alt+Up/Down/Right/Left move before/after/inside/outdent; pointer drag reorders, nests (middle band) and outdents (left gutter), multi-drags same-parent selected siblings, never into a descendant, keeps placement across small gaps, shows exactly one indicator (centred in the gap between siblings, identical whichever side is hovered); a move prevented by an extension is a cancel.
- X10 [collab-invariant] A drag/keyboard move preserves block identity (one move, not delete+insert) and is one undo step.
- X11 [user-visible] Extensions contribute named commands (label, group, keywords, enabled predicate, run) consumed by the slash menu and by consumer UIs.

### 1e. Guarantees nobody states but the domain needs (derived from contracts)
- G1 [collab-invariant] Any position an extension holds across user think-time (open slash query, toolbar link field, pending caret restore) must either follow concurrent edits or be dropped — never be applied at a stale numeric offset. Nothing in this domain currently satisfies it (see §7).
- G2 [user-visible] "Which marks the next typed character carries" has exactly one answer for a given caret, independent of whether the last action was typing, a collapsed format toggle, a color command or a link edge.
- G3 [user-visible] Each discrete user command is one undo step regardless of which extension issued it.

## 2. Real constraints

What the platform actually forces, with the concrete fact and where the code meets it. Anything not listed here is a choice.

### Browser (contenteditable, events, selection, layout)
- B1 **Every element inside the editable host is editable territory.** Browsers delete/insert DOM anywhere under a `contenteditable` root (select-all+Delete removes framework anchor comments; IME/spellcheck/autocorrect write text next to non-editable spans). Consequences that are forced: a stable end-of-root anchor (`Edytor.svelte:237-242`), `contenteditable="false"` on chrome, and a reconciliation path that knows which elements are not model text. What is *not* forced: putting chrome inside the host at all. Placeholders (`Text.svelte:252-270`) and handle hosts (`blockHandlesPlugin.ts:27-35`, `node.before(host)`) are placed there by choice, and that choice is what makes `events/domTextMutationObserver.ts` carry placeholder/chrome liveness logic (`:27-40,346-392,441-466,563-615,956-963,1164-1234`).
- B2 **`beforeinput` is not the only write path.** `insertCompositionText` is not cancelable and Android keyboards bypass it, so DOM mutations must be reconciled after the fact (events domain). This is why any extra DOM in the host has a recurring cost.
- B3 **Programmatic selection writes emit asynchronous `selectionchange`.** A model-then-DOM write can be overwritten by the DOM→model derivation of its own echo. This is the real reason for `ignoreNextSelectionChange` and for re-asserting model state after `setAtRange` (`richTextOperations.ts:124-129`, `ToolbarController.svelte.ts:139-153`). One echo-suppression owner is forced; per-caller re-assertion is not.
- B4 **`ClipboardEvent` carries no modifier state.** Shift-paste needs keydown/keyup tracking at the root (`events/onPaste.ts:14-42`).
- B5 **Custom clipboard MIME types are not portable** (dropped across apps / by some engines). Mirroring the fragment into HTML (`serializeClipboardFragment.ts:140-143`, `fragmentData.ts:118-137`) is forced.
- B6 **`KeyboardEvent.key` is layout-produced.** Non-Latin layouts, AltGr reported as Ctrl+Alt on Windows, `getModifierState('AltGraph')`, `key === 'Dead'`, `ISO_Left_Tab` (`hotkeys.ts:86-97,250-289`). Forced.
- B7 **The IME owns specific text nodes during composition.** Any remount under the composing node must wait (`edytor.svelte.ts:445-466`, `refreshEditorDom` deferral); placeholders must not appear mid-composition (`Text.svelte:203`).
- B8 **Layout facts exist only after layout.** First-line position (`blockHandlesPlugin.ts:37-54`), gap between siblings (`BlockHandleController.svelte.ts:370-383`), menu anchors (`slashMenuPlugin.ts:14-37`, `toolbarPlugin.ts:12-27`) need `getClientRects`/`getBoundingClientRect` after flush, batched in rAF; ResizeObserver reports after layout. Measuring is forced; *how many* independent positioning loops exist is not.
- B9 **Engines disagree on selection extension** around node-bound endpoints and vertical Shift-extension (comments at `navigation.ts:485-496`, `hotkeys.ts:556-558`). Owning these semantics is forced.
- B10 **A real HTML parser is always present where HTML can arrive.** `paste`/`drop` only fire in a browser, where `DOMParser` exists (already used by `clipboard/fragmentData.ts:118-127`). The 426-xloc tokenizer in `plugins/html/parser.ts` is driven by the unit-test environment (`vite.config.ts` has no DOM environment for `src/tests/fixtures/model/parser.test.ts`), not by the product.

### Pragmatic drag-and-drop (element adapter 1.7.10)
- P1 The source's `onDrop` fires before the drop target's (`BlockHandleController.svelte.ts:120-122`), so the indicator must outlive the source callback. Forced.
- P2 Stickiness (`getIsSticky`) keeps the last target across gaps; `isActiveDueToStickiness` must not re-resolve placement (`:139-151,313-315`). Forced by the "keep placement across small gaps" requirement.
- P3 Data given through `getInitialDataForExternal` becomes a native `dataTransfer` type, so the native drop handler must recognise it (`events/onDrop.ts:58-63`). Forced, but the MIME string is declared twice (`BlockHandleController.svelte.ts:10`, `events/onDrop.ts:20`).
- P4 The package's ESM entry is not loadable by Node SSR after SvelteKit externalization (`dnd/pragmatic.ts:3-9`). Forced (3 xloc).

### Svelte 5.55 runes
- S1 A keyed `{#each}` cannot move a component instance between two different `{#each}` blocks. Nest/outdent therefore destroys and recreates the moved block's DOM, and the caret node dies. One post-commit caret placement is forced. Retries at `tick`/30 ms/500 ms (`hotkeys.ts:217-219,244-247`) and forcing every `children` array to re-render (`hotkeys.ts:183-188`) are not.
- S2 `{#key}` destroys the subtree. Using it as a repair hammer (`Edytor.svelte:222`, `editorDomRevision`) is a choice that conflicts with B7.
- S3 DOM updates flush in a microtask after state writes (`tick()`). Code that reads DOM right after a model write must await one flush. It does not need `setTimeout` chains (`MentionPlugin.svelte:48-52`, `hotkeys.ts:694-695`).
- S4 Svelte owns the nodes it renders. User code that `remove()`s a Svelte-rendered node (`Text.svelte:105,122-124`; `text/removeStalePlaceholders.ts:56,63`) leaves Svelte believing the node exists until its `{#if}` flips. That creates exactly the "duplicate/stale placeholder" states the repair code then chases.
- S5 A snippet cannot be forced to attach its root element exactly once. `use:block.attach` is a convention repeated in ~20 snippets (`RichTextPlugin.svelte:299-438`, `CodePlugin.svelte:222,237,244`: the code block attaches **twice**). The handle ownership guard `activeHandles` (`blockHandlesPlugin.ts:204,225-227`) exists for this.
- S6 Components mounted imperatively (`mount`/`unmount`) for chrome outside the editor tree do not share context and need explicit teardown (`slashMenuPlugin.ts:89-114`, `toolbarPlugin.ts:45-70`, `blockHandlesPlugin.ts:215-237`). Forced if chrome lives outside the tree.

### Vendored Yjs v14 engine / document facade
- E1 **Block moves are one identity-preserving placement primitive** (`crdt/placement/model.ts:963-979`: `nestBlock` = move to last child, `unNestBlock` = move beside the parent). Nothing in the engine requires four wrapper vocabularies (`moveBlock({path})`, `moveBlocks({blocks,target,position})`, `nestBlock()`, `unNestBlock()`), all of which this domain calls.
- E2 **Positions that follow concurrent edits exist**: relative positions (`vendor/yjs/API-NOTES.md:17`) and the selection's text anchors (`selection.svelte.ts:2059`). Holding numeric offsets across think-time is a choice (`SlashMenuController.svelte.ts:6-10`, `ToolbarController.svelte.ts:12-18`).
- E3 **Undo grouping is time-based unless `stopCapturing()` is called** (`API-NOTES.md:18`). *Some* owner must cut steps per command. Today that owner is 20 call sites in 9 files (`hotkeys.ts` ×9, `richTextOperations.ts` ×3, `htmlPlugin.ts`, `onPaste.ts` ×2, `onCut.ts`…), and the extensions that forget (markdown shortcuts, slash commands, mention, arrow-move) inherit whatever grouping the timer produces.
- E4 **Text wrappers are not identity-stable across reconcile.** Pending carriers are re-aliased (`text.svelte.ts` `_pendingAliases`), so extensions re-resolve by id (`MentionPlugin.svelte:24`). Any extension that keys state on a wrapper object (`SlashMenuController.svelte.ts:71,88`) silently closes or mis-targets when the wrapper is swapped.
- E5 **Void/island roles are document semantics** adopted from the view's definitions (`edytor.svelte.ts:589-597`, `adoptSemantics`), and the facade owns move/nest permission (`block/block.utils.ts:422-424,434-436`). "May this block be converted, moved, or host a menu?" is a document fact. It does not need to be recomputed per extension.

## 3. Fact → authoritative owner → lifetime → consumers

"Owner" is who *should* decide, given information, lifetime and authority. **FLAG ×n** marks a fact decided in n places today; every decider is listed. The verified probes cited here live in the scratchpad (`pui/probes/*.probe.test.ts`, run against the working tree with the repo's jsdom harness; no repo file touched).

| # | Fact | Should be owned by | Lifetime | Consumers | Deciders today |
|---|---|---|---|---|---|
| F1 | Which DOM element *is* block X | the generic block renderer (one element per block occurrence) | one mount of the block | selection DOM↔model mapping, handles, drop targets, `closest('[data-edytor-block]')` lookups | **FLAG ×3+**. Every block snippet via `use:block.attach` (`RichTextPlugin.svelte:299-438`, 14 snippets; `CodePlugin.svelte:222,237,244`; `ImagePlugin.svelte:21`). `Block.attach` stores the last writer (`block/block.svelte.ts:1031-1034`). The handle plugin re-decides "current element for id" (`blockHandlesPlugin.ts:204,225-227`). Probe `code-attach`: the code block has **2** elements tagged `data-edytor-id="c"` (DIV, PRE); the first handle is created then destroyed. |
| F2 | When a block's element must be recreated (type/data change) | the block's definition (only it knows which data changes the element) | per render | `Block.svelte` | **FLAG ×2**. The core hard-codes one plugin type, `block.type === 'heading' ? \`${type}:${data.level}\`` (`components/Block.svelte:13-15`); the heading snippet independently switches tag via `svelte:element this={level}` (`RichTextPlugin.svelte:331`). |
| F3 | Mark-run grouping + decoration of a text | the text wrapper (`renderChildren`) | per model version | `Text.svelte`, `Mark.svelte`, mutation observer | **FLAG ×2**. `text/text.svelte.ts:269-315` and a second copy for suggestion proxies (`components/readonlyElements.svelte.ts:86-100`, including its own `transformText` call). |
| F4 | Placeholder visible for block X | one model-derived boolean: "block content is one empty text ∧ not composing" | per model version | renderer only | **FLAG ×9**. `$derived` in `Text.svelte:198-204`; DOM re-check `Text.svelte:139-143`; duplicate sweep `Text.svelte:108-125`; CSS sibling/`:has` rules `Text.svelte:276-284`; DOM scanner `text/removeStalePlaceholders.ts:20-68`; repair-root selection `edytor.svelte.ts:1154-1175`; history sweep `history/refreshDomAfterHistoryChange.ts:76-80`; mutation-observer liveness `events/domTextMutationObserver.ts:346-392,441-442,563-564`; selection placeholder-in-range `selection/selection.svelte.ts:154-176,1750-1752`. |
| F5 | Block X may take text-level structural commands (convert / markdown / slash / toolbar / handle) | document semantics (void/island roles are already adopted into the document, `edytor.svelte.ts:589-597`) | document lifetime | all extensions | **FLAG ×6, divergent**. `canConvertBlock` (`richTextOperations.ts:78-84`: excludes root, *not* codeLine); `canApplyShortcut` (`markdownShortcuts.ts:55-58`: excludes codeLine, *not* root); `canOpenInBlock` (`SlashMenuController.svelte.ts:29-33`: same as markdown); toolbar `!isVoid && !isIsland` (`ToolbarController.svelte.ts:94-95`); `canUseHandle` (`BlockHandleController.svelte.ts:224-226`); handle host skip (`blockHandlesPlugin.ts:200`). |
| F6 | Marks carried by the next inserted character | the text model (one function of caret + pending override) | until the caret moves or text is inserted | typing, IME commit, paste, soft break, format commands | **FLAG ×7, divergent**. `text/text.utils.ts:279-295` (collapsed `markText`: keeps only `value === true` marks); `richTextOperations.ts:275-299` (color command, "mirrors markText"); `:216-219` (`{}`); `RichTextPlugin.svelte:103-135` (link edge, reads DOM `startNode`); `events/onInput.ts:214-231`; `events/beforeInputCommands.ts:136-158` ("mirrors getMarksForInsertion"); `block/block.utils.ts:569-599` (split carries). Probe `mark-inherit`: typing in red italic → `{color:red, italic}`; collapsed mod+b then typing → `{italic, bold}` (**red dropped**); collapsed font-color then typing keeps italic. |
| F7 | Per-text sub-range of a multi-text selection `(first? yStart : 0, last? yEnd : len)` | the selection (expose segments once) | per selection | format ops, toolbar, clipboard | **FLAG ×5**. `richTextOperations.ts:86-95,113-123,224-230,234-242`; `ToolbarController.svelte.ts:102-106`; analogous slicing in `clipboard/createClipboardFragment.ts:33-35,55-69`. |
| F8 | Document order of blocks | block path comparison (`block/blockPath.ts:3-15`) | per model version | copy, drag groups, block-selection extension | **FLAG ×3, divergent**. Verbatim copy in `BlockHandleController.svelte.ts:21-31`; root-index-only order `a.path[0] - b.path[0]` in `hotkeys.ts:535-537,572-574`. Probe `block-extend`: select nested A3, Shift+Up → {A3,A2}, Shift+Up again → **no change** (expected A1), Shift+Down → **no change**. |
| F9 | The selected inline atom | the selection, as one field | until selection changes | Backspace/Delete, arrows, printable replacement | **FLAG ×2 fields + 3 readers**. `selectedInlineBlock` Set + `inlineBlockDeletionTarget` (`selection.svelte.ts:319-320,673-687`, the comment calls them "one selection"); read as `values().next().value ?? inlineBlockDeletionTarget` in `hotkeys.ts:119-121`, `hotkeys/navigation.ts:244-246`, `events/onKeyDown.ts:105-107`. |
| F10 | Parent/index of an inline atom | the atom (`parent` pointer + index) | per model version | atom deletion/replacement | **FLAG ×2**. Pointer in `onKeyDown.ts:113-114` and `navigation.ts:248-249`; whole-tree search `findInlineBlockLocation` in `hotkeys.ts:99-116`. |
| F11 | Caret after removing a selected atom | one atom-removal command | one command | Backspace, Delete, printable replace | **FLAG ×2** (identical rule). `hotkeys.ts:137-149`, `events/onKeyDown.ts:118-137`. |
| F12 | Caret/selection after an extension command, and *when* it is written | the command dispatcher: the command returns an intended selection, one post-commit writer applies it | one command | every extension | **FLAG ×14, six timing policies**. `hotkeys.ts:190-220` (tick+30+500 ms), `:222-248` (sync+tick+30+500), `:683-695` (tick+30); `markdownShortcuts.ts:69-82` (sync+tick); `MentionPlugin.svelte:24-52` (sync+tick+0+30); `richTextOperations.ts:124-129` (state, DOM, state again), `:174-179,191,219,244,299,317`; `ToolbarController.svelte.ts:139-153` (4 re-assertions incl. `setTimeout 0`); `SlashMenuController.svelte.ts:136-142`; `clipboard/insertBlockFragment.ts:12-18`; `insertContentFragment.ts:29,46`; `htmlPlugin.ts:62-87`; `BlockHandleController.svelte.ts:232`; `arrowMove.ts:36-38,76-78`; demo `+page.svelte:206-215`. |
| F13 | Undo-step boundary for a command | the command dispatcher (one command = one step) | one command | history | **FLAG ×20 sites / 9 files**. `stopCapturing()` in `hotkeys.ts` ×9, `richTextOperations.ts:112,293,309`, `htmlPlugin.ts:102`, `onPaste.ts:158,191`, `onCut.ts:64`, …; selection snapshots queued separately (`richTextOperations.ts:110,232`, `onCut.ts:16`, `hotkeys.ts:677-679`). Markdown shortcuts, slash commands, mention insertion and arrow-move never cut a step. |
| F14 | Precedence among extensions | one rule | editor lifetime | all registries | **FLAG ×5 rules**. Definitions and commands: *last* plugin wins (`Map.set` in plugin order, `edytor.svelte.ts:517-546`), although the README says the first wins; hotkeys: first *preventing* handler, user > plugins > defaults (`hotkeys.ts:721-739,813-828`); operation hooks: first returned payload or prevention (`block/block.utils.ts:156-165`); placeholder: first plugin that has one (`edytor.svelte.ts:583-584`); default block: first truthy answer (`edytor.svelte.ts:748-760`). |
| F15 | Outcome of a prevention (abort + optional replacement) | the dispatcher that started the command | one command | all hooks | **FLAG ×7 catch sites**. `hotkeys.ts:820-826` (also swallows *every* non-prevention error as "handled"), `BlockHandleController.svelte.ts:234-239`, `events/onKeyDown.ts:377-382`, `onPaste.ts:166-171`, `onCut.ts:49-54`, `onCopy.ts:30-35`, `onBeforeInput.ts:743-747`. `runOperation` throws through transactions (`block.utils.ts:156-167`), so a prevention raised by a nested operation unwinds a partially applied outer command. |
| F16 | Where a pasted fragment lands (split or not; replacing selected blocks) | one placement function over (target position, fragment) | one command | internal paste, HTML paste, plain paste | **FLAG ×3, divergent**. `clipboard/insertContentFragment.ts:14-47`; `insertBlockFragment.ts:20-71` (blocks go *after* the caret block); `plugins/html/htmlPlugin.ts:48-111` (splits at caret, merges tail); selected-block replacement via two helpers (`removeSelectedBlocksForReplacement` vs `replaceSelectedBlocksWithEmptyBlockTarget`). Probe `paste-shape`: the same two paragraphs pasted at `Hello|World` give internal `["HelloWorld","X","Y"]`, HTML `["HelloX","YWorld"]`, plain `["HelloX\nYWorld"]`. |
| F17 | Pasted content has fresh ids | the insertion boundary (document admission) | one insertion | paste, duplicate | **FLAG ×3**. Stripped at copy (`createClipboardFragment.ts:52,101`), again at paste (`insertBlockFragment.ts:30,62`; `insertContentFragment.ts:18`), and by the demo (`+page.svelte:192-205`). |
| F18 | A clipboard fragment is valid | the decoder (once) | one paste | insert | **FLAG ×2**. `fragmentData.ts:112` then again `insertClipboardFragment.ts:11`. |
| F19 | Block type/mark ↔ HTML element correspondence | the extension that defines the type | extension lifetime | export (copy), import (paste), render | **FLAG ×3**. Export table in *core* clipboard, which names plugin types (`serializeClipboardFragment.ts:15-36,69-107`: heading, quote, todo-item, codeLine, image, divider, mention…); import table (`plugins/html/elementDefinitions.ts:157-255`); render tags in snippets (`RichTextPlugin.svelte:231-296`). |
| F20 | Block-kind catalogue (type + data preset + label/icon/keywords/markdown prefix/HTML tag) | the defining extension | extension lifetime | slash menu, markdown, HTML, demo menu | **FLAG ×6**. `richTextCommands.ts:9-117`; icons by command id `SlashMenu.svelte:7-20`; `markdownShortcuts.ts:15-46,118-165`; `+page.svelte:176-187`; `elementDefinitions.ts:157-203`; `serializeClipboardFragment.ts:78-106`. |
| F21 | Canonical empty code block | the code extension | extension lifetime | markdown ```` ``` ````, slash "Code" | **FLAG ×2, wrong owner**. `markdownShortcuts.ts:88-95`, `+page.svelte:53-59`. `CodePlugin.svelte` itself never states it. |
| F22 | "Move block one step down/up/in/out" | one relative-move command over the single engine primitive (E1) | one command | arrow-move hotkeys, handle keys, drag, menus | **FLAG ×4 vocabularies, divergent**. Path arithmetic `arrowMove.ts:15-34,59-74`; `moveBlocks`+`unNestBlock` `BlockHandleController.svelte.ts:196-221`; `nestBlock`/`unNestBlock` `hotkeys.ts:606,632`; demo `+page.svelte:240-252`. Probe `move-down` on `A, B{B1}, C`: arrow-move → `[{B:[A,B1]},C]` (A enters B); handle Alt+Down → `[{B:[B1]},A,C]`. |
| F23 | Range an extension holds across think-time (slash query, toolbar link target) | the selection's anchors (E2) | until the UI closes | slash menu, toolbar | **FLAG: second owner of the selection**. Numeric snapshot `ToolbarController.svelte.ts:12-18,119-126,155-167`; numeric `activeRange` `SlashMenuController.svelte.ts:6-10,133-136`. Probe `stale-offsets`: select "world" in "Hello world", focus the link field, a peer inserts "ZZZ" at 0, apply → link lands on **"lo wo"** (`ZZZHel|lo wo{link}|rld`). The slash menu survives a peer edit only by accident: it closes because `stringContent.at(triggerStart) !== '/'` (`SlashMenuController.svelte.ts:90`). |
| F24 | Floating-UI anchor rect + viewport clamping | one positioning helper | while open | slash menu, toolbar, drop indicator, demo menu | **FLAG ×4**. `slashMenuPlugin.ts:14-44,101-109`, `toolbarPlugin.ts:12-34,57-65`, `BlockHandleController.svelte.ts:337-384`, `+page.svelte:313-396`. |
| F25 | Link/colour value is safe to render | the render boundary (remote data can't be trusted, R9) | per render | link/color/highlight snippets | **FLAG ×3** (write-side ones redundant). Render `RichTextPlugin.svelte:256,283,292`; write `richTextOperations.ts:251,270-271`; import `elementDefinitions.ts:209`. |
| F26 | "Did inserting `\n` make normalization split the block?" | the normalization (it knows it split) | one command | soft break, Emacs ctrl+o | **FLAG ×2** (reconstructed by counting siblings). `events/beforeInputCommands.ts:376-390`, `hotkeys.ts:442-454`. The copies differ: ctrl+o inserts without explicit marks. |
| F27 | Canonical hotkey string | one encoder | editor lifetime | registration, dispatch | ×2 kept in sync by hand: `normalizeKey` `hotkeys.ts:741-758` and `combination` `hotkeys.ts:760-794`. Low risk. |
| F28 | Block-drag MIME identifier | one shared constant | forever (wire protocol) | handle source, native drop filter | **FLAG ×2**. `BlockHandleController.svelte.ts:10`, `events/onDrop.ts:20`. |
| F29 | Readonly gate for mutations | the view's command dispatcher | view lifetime | everything that writes | ×7 layers: `onKeyDown.ts:314-319`, `runOperation` `readonlyGate` (block ops only; text ops explicitly ungated, `text.utils.ts:41-46`), `onCut.ts:31`, `onPaste.ts:129`, `BlockHandleController.svelte.ts:91,99,112,135,141,192`, `SlashMenuController.svelte.ts:55`, `ToolbarController.svelte.ts:87`. |
| F30 | Drop placement (target, position) shown == committed | `BlockHandleController.resolvePlacement` + cached `activePlacement` | one drag | indicator, drop | single owner ✓ (`:262-295,160-181`) |
| F31 | Handle vertical offset | handle plugin | per layout | handle CSS var | single owner ✓ (`blockHandlesPlugin.ts:37-176`), cost driven by chrome placement (B1/B8) |
| F32 | Platform (`isMac`) | `HotKeys.isMac` | page lifetime | mod folding, Emacs table, word-nav modifier, ctrl+y | single owner ✓ (`hotkeys.ts:712-714`) |

## 4. Machinery inventory

xloc per mechanism comes from a line-range run of the same counting rules (`pui/xr.mjs`, a copy of the scratchpad's `xrange.mjs`). Note that `.svelte` totals include CSS lines: `Toolbar.svelte` 85, `SlashMenu.svelte` 89, `BlockHandle.svelte` 75. The type unions in `hotkeys.ts:58-84` are also counted by the script even though they are types.

Classes: **REQUIRED**: implements a §1 guarantee with no cheaper representation. **CONSTRAINT-DRIVEN**: forced by a §2 fact. **HISTORICAL**: exists because of an earlier decision; for each one I name the invariant that would make it unnecessary.

### Components (614)
| Mechanism | Where | xloc | Class | Invariant that deletes it (HISTORICAL only) |
|---|---|---|---|---|
| Generic recursive render tree (root each, block→snippet, content each, mark nesting, atom) | `Edytor.svelte:221-246`, `Block.svelte`, `Content.svelte:14-36`, `Mark.svelte`, `InlineBlock.svelte`, `Text.svelte:222-251` | ~150 | REQUIRED (R1-R4) | — |
| Heading-specific re-key | `Block.svelte:13-15` | 3 | HISTORICAL | "A definition states which data re-keys its element." Then the core names no plugin type. |
| Handles default/opt-out composition + deprecated alias + WeakSet recognition | `Edytor.svelte:94-121`, `blockHandlesPlugin.ts:17-25` | 33 | HISTORICAL (≈70 %) | "The handle feature is one option of the view, not a plugin that has to be de-duplicated inside the user's plugin list." |
| Root browser-attribute action | `Edytor.svelte:151-197` | 33 | HISTORICAL | "Root attributes are rendered declaratively." Svelte already omits `undefined` attributes (R11). |
| Chrome pointerdown/selectstart guard | `Edytor.svelte:199-216` | 13 | CONSTRAINT-DRIVEN (B1) | Shrinks once chrome leaves the host. |
| Sync attach + teardown | `Edytor.svelte:123-149` | 12 | REQUIRED | — |
| Text attach action (re-attach on wrapper swap) | `Text.svelte:13-30` | 15 | CONSTRAINT-DRIVEN (E4) | — |
| Click → caret from pointer coordinates | `Text.svelte:35-77` → `selection.svelte.ts:1283-1292` | 36 | HISTORICAL (suspected; no test names it, introduced wholesale in `d9b7de0`) | "A text element contains only model text (plus the empty-text ZWSP), so a native click already yields a mappable DOM position." A second caret decider for a click is only needed when non-model nodes (placeholder, newline span) sit in the hit area. Needs one real-browser check before removal. |
| **Placeholder machinery** | `Text.svelte:79-216,252-285` (~133); collateral `text/removeStalePlaceholders.ts` (192), `edytor.svelte.ts:392-399,1138-1175` (~25), `history/refreshDomAfterHistoryChange.ts:76-80`, placeholder branches of `events/domTextMutationObserver.ts` (~45) and `selection.svelte.ts:104-176,1750-1752` (~20) | 133 in-domain, ~285 collateral | HISTORICAL | **"The placeholder is not a node inside the editable host. It is the presentation of one model-derived attribute on the empty text element (`data-placeholder` + `::before`)."** No node exists for the browser to type into, for Svelte to duplicate, or for user code to `remove()`. Observers, repair windows (50/250/1000 ms), duplicate sweeps and exemptions all go. Cost: a *snippet* placeholder becomes a string-returning function (the demo's `{#if block.focused}` becomes `block => block.focused ? "Type '/'…" : null`). |
| Suggestions via fake read-only wrappers (Proxy) | `components/readonlyElements.svelte.ts` (125) + `block/block.svelte.ts:249-268` + `Content.svelte:37-46` | ~140 | HISTORICAL | "Snippet payloads are view objects with a declared interface (atom: `{type,data,selected,attach}`; text: render deltas). A suggestion supplies `selected:false`; no Proxy fabricates missing members." Probe `suggestion-mention`: a suggested mention renders **"@mention selected"** with the selection ring, because the Proxy returns a truthy object for the missing `selected` (`readonlyElements.svelte.ts:19-30`). Fresh `id('t')` on every getter read (`:108`) also defeats the keyed `{#each}`. |
| Whole-editor remount switch | `Edytor.svelte:222` + `edytor.svelte.ts:444-466` | ~20 | HISTORICAL | see "structural drift repair" below |

### Hotkeys (`hotkeys.ts` 667 + `hotkeys/navigation.ts` 589)
| Mechanism | Where | xloc | Class | Invariant (HISTORICAL) |
|---|---|---|---|---|
| Registry, normalization, dispatch, exception-based prevention | `hotkeys.ts:705-831` | 92 | REQUIRED core (K1), HISTORICAL shape | "A handler *returns* `handled` (or an intent) instead of throwing." The catch-all that turns *any* error into "handled" (`:820-826`) disappears with it. |
| AltGr / dead-key / layout fallback / reverse-tab | `hotkeys.ts:86-97,250-289` | 26 | CONSTRAINT-DRIVEN (B6) | — |
| `letter` Set + key union types | `hotkeys.ts:22-84` | 52 (≈45 of them type lines the script counts) | HISTORICAL | "Types need no runtime value." A template-literal type replaces the 26-entry `Set` that exists only for `typeof letter`. |
| Atom deletion with whole-tree search | `hotkeys.ts:99-152` | 46 | HISTORICAL | "An atom knows its parent; removing the selected atom is one command," shared with `onKeyDown.ts:103-138` (F10, F11). |
| Structural drift repair: suppression windows, recursive `children` refresh, full `{#key}` remount, restores at tick/30/500 ms | `hotkeys.ts:169-248` + callers `:599,609,613,621,634,640` | 66 | HISTORICAL | **"A block's rendered children are a pure derivation of the model's children, committed in the same flush; one post-commit writer places the selection."** After Tab this code remounts the whole editor up to three times (`:209-211` inside `restore`, scheduled at `:217-219`). |
| Delete via fake `InputEvent` | `hotkeys.ts:291-311` | 12 | HISTORICAL | "Editing commands are plain intents; `beforeinput` is one adapter among several." The same trick appears in `CodePlugin.svelte:87-103` and `events/onPaste.ts:44-82`. |
| Undo/redo | `hotkeys.ts:313-325` | 12 | REQUIRED (K4) | — |
| Block-selection keys: arrows, shift-arrows, escape, mod+a, Backspace/Delete, Tab/Shift+Tab, mod+enter, ctrl+y | `hotkeys.ts:327-363,483-703` | 231 | REQUIRED behaviours (K5-K7, K11). ≈40 % HISTORICAL: island walk duplicated `:334-339` vs `:540-545`; wrong order `:535-537,572-574`; retry timers `:694-695` | — |
| macOS Emacs table | `hotkeys.ts:365-481` | 99 | REQUIRED (K2). ctrl+o re-derives the soft-break caret (F26); h/d/k share a skeleton | — |
| Five document-order walkers: word positions, horizontal boundary crossing, extend destination, adjacent editable text, block/document boundary | `navigation.ts:15-552` | 444 | REQUIRED behaviours (K9, K10), HISTORICAL structure | **"One ordered stream of caret stops (text offsets, atom stops, block edges) with a direction."** Grapheme, word, atom and block movement become predicates over that stream. Focus/anchor extraction from `isReversed` is written twice (`:370-373`, `:509-512`); state-then-DOM double writes appear 4× (`:171-201`, `:426-435`, `:541-550`). |
| Binding table | `navigation.ts:554-700` | 139 | REQUIRED (bindings), HISTORICAL (shape) | "Bindings are data: `{chord, motion, extend}`." 26 near-identical closures become rows. |

### Clipboard (518)
| Mechanism | Where | xloc | Class | Invariant (HISTORICAL) |
|---|---|---|---|---|
| Fragment extraction from selection | `createClipboardFragment.ts` | 102 | REQUIRED (C4) | per-text slicing duplicates F7 |
| Fragment shape validation | `fragmentData.ts:13-107` | 74 | REQUIRED (clipboard is untrusted input) | the second validation (`insertClipboardFragment.ts:11`) is HISTORICAL |
| Encode/decode, HTML-embedded fallback, read/write | `fragmentData.ts:109-169`, `serializeClipboardFragment.ts:6-7,140-143` | ~60 | CONSTRAINT-DRIVEN (B5) | — |
| Type → HTML/plain export tables in core | `serializeClipboardFragment.ts:9-138` | ~100 | REQUIRED output, HISTORICAL owner | "Each definition exports its own HTML/plain form; core falls back to `<p>`/text." Today core names 11 plugin types (F19). |
| Paste placement (content vs blocks) + id stripping | `insertContentFragment.ts`, `insertBlockFragment.ts`, `insertClipboardFragment.ts`, `jsonClipboard.ts` | 138 | REQUIRED (C3, C4), HISTORICAL duplication | **"One placement function inserts any fragment (inline runs + blocks) at a collapsed target."** Plus: "id freshness is decided at the JSON→spec boundary." `jsonBlockToSpec(block, freshIds)` already exists (`utils/json.ts:315-354`) and no paste path uses it. |

### Plugins (3780)
| Mechanism | Where | xloc | Class | Invariant (HISTORICAL) |
|---|---|---|---|---|
| Hand-written HTML tokenizer + tree builder + entity table | `html/parser.ts` | 426 | HISTORICAL | **"HTML only arrives through browser events, where `DOMParser` exists (B10)."** Parser tests run under jsdom. The 19 `html-parser.fixtures.ts` cases pin the tokenizer itself and go with it. |
| DOM → JSON deserializer (mark application written twice, `$fragment` pseudo-blocks, `mergeTrailingMarks`) | `html/deserialize.ts` | 321 | REQUIRED function (C6); `$fragment` + `mergeTrailingMarks` (≈66) HISTORICAL | "The parser yields an ordered flow of inline runs and block boundaries; *placement* decides where leading/trailing inline runs go." C8 (trailing text merged into the last block) is a tokenizer artifact, not a requirement. |
| Mapping validation against registries on every paste (synthetic validation nodes) | `html/elementDefinitions.ts:21-155`, `deserialize.ts:425-453` | 137 | HISTORICAL / test-only (C7) | "Mappings are resolved once at plugin creation; an unregistered result degrades to paragraph/plain text instead of throwing." |
| Default tag tables | `elementDefinitions.ts:157-263` | 102 | REQUIRED data | a compact table needs ~35 |
| HTML paste placement | `htmlPlugin.ts:20-111` | 82 | REQUIRED (C6), HISTORICAL duplication (F16) | the single placement function |
| Rich-text mark + block snippets | `RichTextPlugin.svelte:231-439` | 185 | REQUIRED (R1). The block skeleton `<X use:block.attach data-edytor-type><div>{content}</div>{#if children}<div>…</div>{/if}</X>` is repeated 8× | shrinks if core owns the block element (§6 C2) |
| Native format-input mapping + mark lookups | `RichTextPlugin.svelte:17-71,136-192` | 94 | CONSTRAINT-DRIVEN (X2). `getMarksBefore/AfterOffset` (`:30-56`) duplicate `getMarksAtRange` | — |
| Link-edge insertion rule | `RichTextPlugin.svelte:103-135` | 28 | REQUIRED (X1), HISTORICAL placement | belongs inside the single "next marks" function (F6) |
| Rich-text operations | `richTextOperations.ts` | 253 | REQUIRED (sanitizers 31, divider 39, convert 19), ≈45 % HISTORICAL (4× sub-range loops, 3 collapsed-mark policies, state/DOM/state writes) | F6 + F7 + F12 owners |
| Rich-text command list | `richTextCommands.ts` | 115 | REQUIRED data, HISTORICAL shape | a kind catalogue row per block kind (§6 C3) |
| Handle mount per block, hover, host | `blockHandlesPlugin.ts:27-35,199-241` | 49 | REQUIRED (X9) | — |
| Handle vertical alignment: first-row measure, rAF queue, ResizeObserver, subtree MutationObserver with sibling scanning | `blockHandlesPlugin.ts:37-176` | 122 | CONSTRAINT-DRIVEN for the measurement (B8); ≈50 % HISTORICAL | "Realign all mounted handles once per render commit/resize frame." That replaces the mutation-record analysis (`:128-176`), which exists only to find the *affected* subset. |
| Drop targets, placement bands, gutter outdent, stickiness, indicator overlay | `BlockHandleController.svelte.ts:33-67,126-189,262-398` | ~210 | REQUIRED/CONSTRAINT (X9, P1, P2) | — |
| `comparePath` copy | `BlockHandleController.svelte.ts:21-31` | 11 | HISTORICAL | "Document order has one comparator" (`blockPath.ts`) |
| Keyboard moves (Alt+arrows) | `BlockHandleController.svelte.ts:191-222` | 28 | REQUIRED (X9), HISTORICAL vocabulary (outdent calls `unNestBlock`, not the move command) | single relative-move command (F22) |
| Handle component + CSS | `BlockHandle.svelte` | 111 | REQUIRED (75 CSS) | — |
| Code plugin (Prism decoration, auto-pair, merge guards, line split normalization, tab/suggestion keys) | `CodePlugin.svelte` | 227 | REQUIRED (X6). Shift+Enter via a fake `InputEvent` (`:87-103`) HISTORICAL; normalization bypasses operations with `new Block` + `insertChildren` (`:200-208`) | intent API |
| Markdown shortcuts | `markdownShortcuts.ts` | 169 | REQUIRED detection (32); conversion (79), eligibility (13) and caret restore (19) HISTORICAL | kind catalogue + F5 + F12 owners |
| Slash menu: controller (query, filter, run) | `SlashMenuController.svelte.ts` | 132 | REQUIRED (X4); numeric range HISTORICAL (G1) | "Held ranges are anchors." |
| Slash menu + toolbar hosts: `mount` + positioning + scroll/resize listeners | `slashMenuPlugin.ts:12-44,89-115`, `toolbarPlugin.ts:12-34,45-70` | 102 | CONSTRAINT-DRIVEN (S6, B8), HISTORICAL duplication | one chrome-host helper (~30) |
| Toolbar selection snapshot + 4× re-assertion | `ToolbarController.svelte.ts:12-18,119-168` | 44 | HISTORICAL | **"Focus moving into editor-owned chrome never rewrites the editor selection; commands target the (anchored) editor selection."** Probe `stale-offsets`: link applied to **"lo wo"** instead of "world" after a peer edit. |
| Toolbar visibility, link read, actions | `ToolbarController.svelte.ts:39-117` | ~88 | REQUIRED (X5) | sub-range loop is F7 |
| Menu/toolbar components (markup + CSS) | `SlashMenu.svelte`, `Toolbar.svelte` | 284 (174 CSS) | REQUIRED presentation | icon table in `SlashMenu.svelte:7-20` belongs to commands (F20) |
| Arrow-move plugin (path arithmetic) | `arrowMove.ts` | 72 | HISTORICAL | "Relative move is one command." Its multi-select branch (`:41-49`) runs **without** `prevent`, so the built-in `mod+arrowdown` handler also runs afterwards. |
| Mention plugin (`@` → atom, retry-timer caret restore, re-resolve by id) | `MentionPlugin.svelte` | 68 | REQUIRED feature (X8); ≈60 % HISTORICAL (F12, E4) | — |
| Image, index, dnd adapter | | 29 | REQUIRED / CONSTRAINT (P4) | — |

Verified addendum to §4 (probe `tab-remount`): after one Tab on `A, B|b`, `editorDomRevision` rises by **3** and the `[data-edytor]` root element is replaced. Nesting one block rebuilds the whole editor DOM three times: every block, text, handle mount, ResizeObserver registration and remote-selection overlay.

## 5. Distinctions that must stay explicit

| Distinction | Why it cannot be compressed | Bug that merging produces (observed or direct consequence) |
|---|---|---|
| **Kind definition vs block occurrence** (type-level knowledge: renderer, void/island, which data re-keys the element, external forms; occurrence: id, data, position) | the same definition renders at any depth and any number of times | Core hard-codes `heading`/`level` (`Block.svelte:13-15`). A consumer whose heading type is called `title` loses element re-keying. The code block, one definition, produces two elements that both claim to be the block (probe `code-attach`). |
| **Intended selection (model, anchored) vs observed DOM selection** | remote edits move the intent; programmatic writes echo back asynchronously (B3) | A numeric copy of an observation used as the intent → link applied to "lo wo" instead of "world" after a peer edit (probe `stale-offsets`). Treating every echo as a new intent → the state→DOM→state re-assertions in `richTextOperations.ts:124-129` and `ToolbarController.svelte.ts:139-153`. |
| **Admitted fragment (validated, fresh ids, immutable) vs placement attempt (target, may be refused)** | a paste must be parsed once; the placement may fail or be prevented | Validation runs twice (`fragmentData.ts:112`, `insertClipboardFragment.ts:11`) and id stripping twice (F17). The HTML path validates *during* the attempt, so a bad mapping throws after `preventDefault` and the user gets neither HTML nor plain text (`clipboard.fixtures.tsx:238-296`). |
| **User intent vs mechanical write** (a typed character vs the delete+insert that re-writes an IME preview) | extension hooks key on intent (`/`, `(`, `# `); composition updates are replays of the IME buffer | Both reach extensions as the same `insertText` operation. Probe `ime-plugins`: composing `(` in a code line gives model `x()` while the IME buffer holds `x(`, and the commit leaves `x(a)`. Composing `/` opens the slash menu on the first update and closes it on the second (`/h`); it never opens after commit. |
| **Guarantee vs observation (placeholder)** | "block is empty" is a model fact; "DOM shows text" is a racy observation | Using both (`Text.svelte:139-143,198-204`) requires 50/250/1000 ms repair passes and duplicate sweeps. Removing a Svelte-owned node (`Text.svelte:105`) makes the next render disagree with Svelte's bookkeeping (S4). |
| **Structural capability vs extension permission** (`canMoveBlocks` vs `onBeforeOperation` prevention) | the drop indicator must show only structurally valid places, and an extension may still veto | Merged, the indicator would either hide valid moves or show moves that silently fail. The code already keeps them apart and treats a veto as cancel (`block-handles.fixtures.tsx:61`). Keep it that way. |
| **Transient indicator vs committed move** | the source `onDrop` fires first (P1); the shown placement must equal the committed one | Clearing in the source callback loses the placement before commit. `queueMicrotask(clearIndicator)` (`BlockHandleController.svelte.ts:122`) plus the cached `activePlacement` (`:165-168`) keep them separate and in sync. |
| **Command vs transaction vs undo step** | typing coalesces into one step across many transactions; a structural command is one step; remote transactions are never local steps | One transaction per step would break typing coalescing. Leaving the cut to each caller, as today, merges the next command into the previous step whenever a caller forgets (markdown, slash, mention, arrow-move never call `stopCapturing`). |
| **Decoration vs stored mark** | syntax tokens are per-view render state | Mixing them persisted `codeToken` into replicated marks (`text.utils.ts:89-95` explains the historical leak). Any "next marks" rewrite must keep reading the model runs. |
| **Block-as-selected-object vs text range covering the block** | select-all escalation (K6) and Delete semantics differ | A DOM range cannot express the atomic state (AGENTS.md). Merging them breaks the mod+a ladder and makes Backspace delete text instead of the block. |
| **Atom-as-selection vs caret beside the atom** | Shift+Arrow selects the atom; Arrow jumps it; a printable key replaces it | Today this is one fact stored in two fields (F9). Merged with "caret at edge", typing next to an atom would replace it. |
| **Editor chrome vs document content** | chrome must never reach the model, clipboard HTML, offset mapping or mutation reconciliation | Chrome inside the host already costs observer exemptions (B1) and the selectstart guard (`Edytor.svelte:199-216`). Every new chrome kind extends that list. |
| **View readonly vs document permission** | one document can have an editable and a readonly view (`README`, shared `EdytorDocument`) | Moving the gate into the document would block the other views. The gate belongs to the view's dispatcher, not the facade. |
| **Completed external effect vs document mutation (cut)** | once the OS clipboard is written, it stays written | `onCut` writes the clipboard, *then* deletes (`onCut.ts:62-71`). The reverse order loses data when the delete is vetoed or throws. Keep the order explicit. |

## 6. Representation candidates

### C1. Editing commands are values; one per-view dispatcher owns veto, transaction, undo step, readonly and the resulting selection
**What changes in the representation.** Today a "command" is whatever function a key handler, a menu or a hook happens to call. Control flow runs on thrown `PreventionError`s, and each caller decides undo cuts and caret timing. Instead, represent a command as a value, e.g. `{ kind: 'nest', blocks } | { kind: 'convert', block, to: KindRef } | { kind: 'insertFragment', flow, at } | { kind: 'delete', unit, direction } | …`. Its execution returns `{ selection: SelectionIntent }`, where the intent is anchored (text anchor or block ids), or `refused`. Extension hooks return `continue | replace(command) | refuse` as values. The dispatcher checks the view's readonly flag, runs the hooks, opens **one** transaction, applies the undo policy (text-insertion commands coalesce; everything else cuts), and applies the returned selection intent **once**, after the render commit, behind the existing gesture-serial guard. Key bindings, the slash menu, the toolbar, handles, clipboard and `beforeinput` all become producers of commands. `beforeinput` is one adapter, no longer the de facto command bus.

**Machinery that disappears.**
- 7 `PreventionError` catch sites (F15), including the hotkey catch-all that swallows real errors (`hotkeys.ts:820-826`).
- 20 `stopCapturing()` call sites and the ad-hoc selection-snapshot queueing (F13).
- ~14 caret-restore implementations and their timer ladders (F12): `hotkeys.ts:169-248` (66), `markdownShortcuts.ts:69-82`, `MentionPlugin.svelte:24-52`, the state→DOM→state writes in `richTextOperations.ts` and `ToolbarController.svelte.ts`.
- The fake `InputEvent`s (`hotkeys.ts:291-311`, `CodePlugin.svelte:87-103`).
- 7 readonly checks inside controllers (F29), which shrink to presentation-only (hide handles/toolbar).
- `refreshStructuralChildren` and the three whole-editor remounts per Tab, once the one post-commit selection writer exists and the render invariant below holds.

**Invariant that replaces it.** *Every mutation this view makes passes through one dispatcher. A command's selection effect is a returned value, applied exactly once, after the commit that rendered it. An extension veto is a value observed before the transaction opens, never an exception unwinding a half-applied one.* The `prevent-midway` probe shows the current failure: "# " typed under a type-locking plugin loses both characters.

**Cost / honesty.** The dispatcher is a new owner of roughly 100 xloc (outside this domain). It removes more than that in `events/` as well: `onKeyDown.ts:103-138`, the prevention loops in `onCopy/onCut/onPaste/onBeforeInput`, and the suppression windows. The IME counterexample needs one more field: commands carry `origin: 'user' | 'composition-replay' | 'remote-repair'` so hooks such as auto-pair and slash trigger only on user intent.

### C2. The core owns every node inside the editable host; extensions own inner markup; chrome lives outside
**What changes in the representation.**
- (a) The generic block renderer renders the block element itself: `<svelte:element this={definition.element?.(block.data) ?? 'div'} data-edytor-block data-edytor-id …>`. It calls the snippet only for inner markup, so the definition declares which data picks the element.
- (b) The placeholder is one model-derived attribute on the empty text element (`data-placeholder="…"`) rendered by CSS `::before`, not a node.
- (c) Handles, drop indicator, slash menu and toolbar live in one overlay layer outside the host, positioned by one measure-per-frame helper.
- (d) Suggestions render through the same text/atom components from plain JSON, using declared view objects (`{type, data, selected: false}`) instead of Proxies over live-wrapper APIs.

**Machinery that disappears.**
- The `use:block.attach` convention in ~20 snippets, the double-attach ownership guard (`blockHandlesPlugin.ts:204,225-227`) and the heading re-key (`Block.svelte:13-15`).
- The whole placeholder apparatus: 133 xloc in `Text.svelte`, plus `text/removeStalePlaceholders.ts` (192), the repair queue wiring (`edytor.svelte.ts:392-399,1138-1175`), the history sweep, the placeholder/chrome liveness branches of `events/domTextMutationObserver.ts` (~45) and `selection.svelte.ts` placeholder handling (~20).
- The suggestion Proxies (`readonlyElements.svelte.ts`, 125 → ~25), which fixes probe `suggestion-mention`.
- The four positioning loops (F24 → 1).
- The mutation-record analysis for handle alignment (`blockHandlesPlugin.ts:128-176`): with a single overlay, "realign all visible handles per frame" is the natural loop.
- The chrome `selectstart`/`pointerdown` guard mostly (`Edytor.svelte:199-216`).

**Invariant that replaces it.** *Every DOM node inside the editable host is either model text or a core-rendered, non-editable element whose presence is a pure function of the model. No extension code creates or removes nodes inside the host.*

**Cost / honesty.**
- A placeholder *snippet* becomes a string-returning function. The demo's `{#if block.focused}<span>Type '/'…</span>{/if}` becomes `block => block.focused ? "Type '/' for commands" : null`, so rich markup in placeholders is lost.
- Overlay handles need left/top measurement and scroll-container tracking (≈ +10-20 xloc) instead of inheriting static position from `node.before(host)`.
- A snippet that needs two block-level elements (the code block's header + `<pre>`) keeps them as inner markup.

### C3. Everything that crosses the editor boundary is a *content flow* of inline runs and kinded blocks; kinds carry their external forms
**What changes in the representation.**
- A fragment (internal clipboard, parsed HTML, plain text, markdown shortcut result, "convert to X" command) is one type: an ordered flow of `inline run` items (text + marks + atoms) and `block` items. Each block item references a **kind**.
- A kind is one record declared by the defining extension: `{ id, type, dataPreset, label, icon, keywords, markdownPrefix?, html: { import: tags, export: tag }, empty?: JSONBlock }`. Marks likewise declare `html: { import, export }`.
- Import (HTML via `DOMParser`, B10) produces a flow. Export (clipboard HTML/plain) walks a flow and asks kinds/marks.
- **One placement function** puts any flow at a collapsed target, with a single rule for leading and trailing inline runs: the leading run joins the text before the caret and the trailing run joins the text after it, so N blocks split the target.
- Pasting over selected blocks is "collapse the selection to a placement target, then place".
- Ids are made fresh by the existing `jsonBlockToSpec(block, freshIds = true)` (`utils/json.ts:315-354`).

**Machinery that disappears.**
- `html/parser.ts` (426).
- The `$fragment` pseudo-type and `mergeTrailingMarks`, plus the duplicated mark application in `deserialize.ts` (≈120 of 321).
- Per-paste validation machinery (`elementDefinitions.ts:21-155`, 115). Mappings resolve once at registration.
- Three placement implementations → one (`insertContentFragment.ts`, `insertBlockFragment.ts`, `htmlPlugin.ts:20-88`), which also removes the three-way divergence of probe `paste-shape`.
- Double id stripping (`jsonClipboard.ts` + callers).
- Core's type switch in `serializeClipboardFragment.ts:69-107`.
- `richTextCommands.ts` (115, generated from kinds) and the slash icon table (`SlashMenu.svelte:7-20`).
- The markdown table and per-type converters (`markdownShortcuts.ts:15-46,84-165`).
- The duplicated code-block empty shape (`markdownShortcuts.ts:88-95`, `+page.svelte:53-59`), and the demo's `blockChoices`.

**Invariant that replaces it.** *Anything that converts between a block/mark and an external form (command, markdown prefix, HTML tag, clipboard export, empty shape) reads the record of the extension that defined it, and every inbound fragment is placed by the same function, whatever its source.*

**Cost / honesty.**
- Parser fixtures that pin tokenizer internals (19 in `html-parser.fixtures.ts`) and C7/C8 fixtures (~15) must be rewritten or retired. That is a behaviour decision, not free.
- Whitespace handling over DOM text nodes needs care. Browsers keep inter-element whitespace, and the history has an "improve white space handling" commit (`43bb7bd`).
- The unified placement changes the internal-block-paste result (`["HelloWorld","X","Y"]` → `["HelloX","YWorld"]`). Someone has to pick which of the three current behaviours is the contract.

### Smaller consolidations that follow from the same principle (no new concept)
- **Caret-stop stream** for navigation (owner: the selection). One walker over document-order stops replaces the five walkers in `navigation.ts:15-552` (§8).
- **One "next marks" function** (owner: the text model), fed by a pending override plus the link-edge policy hook. It replaces F6's seven deciders and fixes probe `mark-inherit`.
- **Document order = `compareBlockPath`** everywhere. This fixes probe `block-extend` and deletes the `BlockHandleController.svelte.ts:21-31` copy.
- **Extension-held ranges are anchors** (`selection.createTextAnchor`, E2). This fixes probe `stale-offsets` for the toolbar and makes the slash menu survive peer edits instead of closing by accident.
- **One relative move command** for arrow-move, handle keys, drag and menus. This fixes probe `move-down`: the product has to pick one meaning of "down".

## 7. Falsifying counterexamples

Each scenario is the smallest one I found. The expected result is derived from the §1 contracts. **[probe]** means it was reproduced with the repo's jsdom harness (`pui/probes/*.probe.test.ts`, custom vitest config rooted at the repo, no repo file touched). **[code]** means it follows directly from the cited lines and was not executed.

1. **Nested: block-selection extension stalls in a nested list** [probe `block-extend`]. Tree `A{A1,A2,A3}, B`; select A3; Shift+Up → {A3,A2}; Shift+Up again → **no change** (expected A1); Shift+Down → **no change** (expected B, or shrink). Cause: the "document order" re-decision `toSorted((a,b) => a.path[0] - b.path[0])` (`hotkeys.ts:535-537,572-574`) sees every nested block as equal. Wrong abstraction: order is re-derived locally instead of read from one comparator.
2. **Concurrent: toolbar link lands on the wrong text** [probe `stale-offsets`]. "Hello **world**" selected, link field focused, a peer inserts "ZZZ" at 0, Apply → `ZZZHel|lo wo(link)|rld`. Expected: the link on "world" (G1). Cause: a second, numeric owner of the selection (`ToolbarController.svelte.ts:12-18,155-167`) overrides the anchored one.
3. **Concurrent: a peer typing earlier in the paragraph closes an open slash menu** [probe `stale-offsets`]. "ab/quo" with the menu open, a peer inserts at 0 → menu closes, and Enter then splits the paragraph. It closes only because `stringContent.at(triggerStart) !== '/'` (`SlashMenuController.svelte.ts:90`). A peer insert that happens to put a `/` at the stale offset keeps it open on a garbage query.
4. **IME × extension hook: auto-pair rewrites the composition preview** [probe `ime-plugins`]. In a code line, composition updates `(` → `(a` → commit `(a`. The model reads `x()` while the IME holds `x(`, and the commit ends as `x(a)`. The hook (`CodePlugin.svelte:124-141`) cannot tell a typed character from a composition replay, because both are `insertText` operations.
5. **IME × slash menu: opens then closes mid-composition, never after commit** [probe `ime-plugins`]. Composing `/` → `/h` → commit: open → closed → closed, text `ab/h`. The same holds for markdown prefixes typed through an IME. Any trigger keyed on `payload.value === '/'` (`SlashMenuController.svelte.ts:62`, `markdownShortcuts.ts:15-45`) inherits it.
6. **Failure midway: a veto inside a multi-step command loses text** [probe `prevent-midway`]. A plugin that refuses `setBlock` plus markdown shortcuts; type `#`, space in an empty paragraph → **empty paragraph** (both characters gone). Baseline without the veto → h1. Cause: `clearShortcutText` (a raw `deleteAt`) runs before the vetoable `setBlock`, and the veto is an exception that unwinds after the first write (`markdownShortcuts.ts:118-127`, `block/block.utils.ts:156-167`).
7. **Two features combined: a suggested mention renders as selected** [probe `suggestion-mention`]. `suggestText([… {type:'mention'} …])` renders "@mention **selected**" with the selection ring. The Proxy returns a truthy object for the missing `selected` (`readonlyElements.svelte.ts:19-30`). Every snippet reading a live-only member gets a truthy stand-in.
8. **Two features combined: a collapsed format toggle drops a valued mark** [probe `mark-inherit`]. Caret inside red italic text: typing gives `{color:red, italic}`; Mod+B then typing gives `{italic, bold}`, and red is gone. Font-color then typing keeps italic. Three "next marks" rules (`text.utils.ts:279-286` keeps only `value === true`; `richTextOperations.ts:283-298`; `beforeInputCommands.ts:140-158`) give three answers for one caret (G2).
9. **Same intent, three sources: one fragment, three structures** [probe `paste-shape`]. Two paragraphs X, Y pasted at `Hello|World`: internal → `HelloWorld, X, Y`; HTML → `HelloX, YWorld`; plain → `HelloX⏎YWorld`. Three placement owners (F16).
10. **Same intent, two input paths: "move down"** [probe `move-down`]. `A, B{B1}, C`, move A down: the arrow-move hotkey gives `B{A,B1}, C` (A enters B's children), the handle's Alt+Down gives `B{B1}, A, C`. Four move vocabularies (F22).
11. **Same definition, repeated placement: one block, two elements** [probe `code-attach`]. A code block renders two elements carrying `data-edytor-id="c"` and `data-edytor-block="true"` (DIV and PRE). The handle plugin mounts a handle, destroys it, and mounts again. The ownership guard (`blockHandlesPlugin.ts:225-227`) exists to absorb this.
12. **Repair instead of guarantee: one Tab = three whole-editor remounts** [probe `tab-remount`]. `editorDomRevision` +3 and the root element is replaced (`hotkeys.ts:190-220`). In a 5 000-block document, one indent rebuilds 5 000 blocks three times, re-mounts every handle, and re-runs every `onBlockAttached` hook (the demo's `node.id` anchor hook included).
13. **Empty collection × adoption rule: nothing pasted, heading destroyed** [probe `empty-html`]. Paste HTML containing only a comment, a `<script>` or an empty `<span>` into an empty `h2` → the block becomes a **paragraph** carrying stale `data:{level:'h2'}`, plus one undo step. Two locally reasonable rules compose badly: "empty input → one empty paragraph" (`deserialize.ts:49-57`) and "an empty target adopts the first pasted block's type" (`htmlPlugin.ts:37-43`).
14. **Empty collection: slash menu with zero matches swallows Enter** [code]. `/xyz` with no match shows "No commands". Enter is prevented because the menu is open (`slashMenuPlugin.ts:58-64`), and `runSelected()` on an empty list returns false (`SlashMenuController.svelte.ts:122-128`). The user cannot start a new line until Escape.
15. **Veto × multi-select arrow-move: the default handler also runs** [code]. With two blocks selected, `arrowMove`'s Mod+Down branch moves the next block without calling `prevent` (`arrowMove.ts:41-49`). The built-in Mod+Down (`navigation.ts:645-649`) then runs as well, and moves the caret to the document end whenever a text caret is still recorded.
16. **Error hiding** [code]. Any exception thrown by any hotkey handler, including a `TypeError`, is reported as "handled" without `preventDefault` (`hotkeys.ts:820-826`). The browser's default then runs on top of a half-executed handler.
17. **Registry precedence contradicts the README** [code]. Two plugins define the same block type: the README says the first wins, but `Map.set` in plugin order makes the **last** win (`edytor.svelte.ts:517-546`). Hotkeys and operation hooks are first-wins. The same plugin list therefore resolves differently per registry.

## 8. LOC: current per file, floor, and how the floor was derived

Method. For each mechanism in §4 I kept the lines that implement a §1 guarantee or a §2 constraint under single ownership (C1-C3 plus the smaller consolidations in §6), and re-counted what that code needs. Lines that *move* to a new owner are charged to the new owner, not deleted: the new chrome helper (35), the shared placement function (45), the atom-removal command (15) and the kind records are counted in this domain. The C1 dispatcher (~100) is outside this domain and is reported separately below. CSS in `.svelte` files is kept at face value.

| File | now | floor | What survives (line-level reasoning) |
|---|---:|---:|---|
| `plugins/html/parser.ts` | 426 | 0 | `DOMParser` replaces tokenizer (147), tree builder (169), node class (55) and entity table (54). B10: HTML only arrives in browser events. |
| `plugins/html/deserialize.ts` | 321 | 110 | One DOM walk with a mark stack: block boundary (~25), inline runs + marks + atoms (~40), list handling (~20), whitespace normalization (~25). Gone: second mark-application copy (`:158-204`), `$fragment` + `mergeTrailingMarks` (`:73-137`), duplicated text/inline branches (`:207-214,399-417`). |
| `plugins/html/elementDefinitions.ts` | 232 | 35 | Default tables derive from kind/mark records (C3). Registration-time override normalization (~15) and resolution against registries once (~10). Validation-node synthesis gone (`:30-56,119-128`). |
| `plugins/html/htmlPlugin.ts` | 92 | 15 | `onPaste` → parse → flow → shared placement. Its own placement (`:20-88`) is the one being unified. |
| `plugins/richtext/RichTextPlugin.svelte` | 380 | 300 | Mark snippets 53 (kept). Block snippets 132 → ~90: core owns the element, so the `use:block.attach`/content/children skeleton goes, but 14 snippet headers stay. Native-format mapping 49 → 40. Lookup helpers 45 → 20 (`getMarksBefore/AfterOffset` duplicate `getMarksAtRange`). Kind + mark records (label/icon/keywords/markdown/html) ~60, absorbing `richTextCommands.ts`. Link-edge rule 28 → ~10 as a hook into the single next-marks function. Hotkeys 10, defaultBlock 9, imports 10. |
| `plugins/richtext/richTextOperations.ts` | 253 | 135 | Sanitizers 31 (render-side guarantee R9). Divider insertion 39 → 30. Convert 19 → 12. Range format over selection segments ~20 (was 43+33 with 4 sub-range loops). Collapsed pending-mark writes through the one next-marks API ~20 (was 3 policies, 50). Link set/remove ~10. `canConvertBlock` → document semantics (0). |
| `plugins/richtext/richTextCommands.ts` | 115 | 0 | Generated from kind records (the generator is ~10, counted in the slash controller). |
| `plugins/blockHandles/BlockHandleController.svelte.ts` | 349 | 225 | Drop-target registration + stickiness 64 → 55; placement bands + gutter + own-row 62 → 45; indicator 91 → 70 (measure helper shared); drag source 17 → 15; select/activate 19 → 15; keyboard 28 → 15 (emit relative-move commands); `comparePath` copy (11) and the prevention catch (8) go. |
| `plugins/blockHandles/blockHandlesPlugin.ts` | 222 | 85 | Per-block mount/hover 40 → 30 (overlay); first-row centre 18 (kept, B8); realign all visible handles per frame/resize ~25; overlay left/top ~10. Gone: incremental mutation-record analysis (`:128-176`, 49), WeakSet plugin recognition (6), ownership guard (C2). |
| `plugins/blockHandles/BlockHandle.svelte` | 111 | 105 | Presentation (75 CSS); `aria-keyshortcuts`, events. |
| `plugins/code/CodePlugin.svelte` | 227 | 195 | Prism helpers 25, snippets 29, transform 15, merge guards + auto-pair 48 → 42 (skip non-user-origin writes), hotkeys 59 → 40 (Shift+Enter becomes a 3-line command), normalization through operations ~30, code kind record (empty shape, ```` ``` ````, label) ~10. |
| `plugins/markdownShortcuts.ts` | 169 | 40 | Prefix matching over kind records (~20) plus apply as a convert command whose result carries the selection (~15). Gone: per-type branches (`:118-165`), local eligibility (`:48-60`), caret restore (`:69-82`), the code-block shape (`:84-100`). |
| `plugins/slashMenu/SlashMenu.svelte` | 142 | 130 | Presentation; icons come from command records (`:7-21` gone). |
| `plugins/slashMenu/SlashMenuController.svelte.ts` | 132 | 95 | Query/filter/navigation/run kept; the range becomes an anchor pair (±0), opening keyed on user-origin insertions (+3), eligibility from document semantics (−5), command generation from kinds (+10). |
| `plugins/slashMenu/slashMenuPlugin.ts` | 105 | 45 | Hotkeys 26 → 20 (Enter no longer swallowed when the list is empty); hooks 15; host + positioning via the shared helper ~10. |
| `plugins/toolbar/Toolbar.svelte` | 142 | 142 | Presentation (85 CSS). |
| `plugins/toolbar/ToolbarController.svelte.ts` | 132 | 60 | Visibility 15, actions 25, link read over selection segments ~15. Snapshot and 4× re-assertion (`:12-18,119-168`) go: commands target the anchored editor selection. |
| `plugins/toolbar/toolbarPlugin.ts` | 64 | 25 | Hooks + shared host/positioning helper. |
| `plugins/arrowMove/arrowMove.ts` | 72 | 15 | Two bindings emitting the relative-move command. |
| `plugins/mention/MentionPlugin.svelte` | 68 | 25 | `@` → insert-atom command with a selection result; snippet. Retry timers and re-resolution by id go. |
| `plugins/image/ImagePlugin.svelte` | 22 | 22 | — |
| `plugins/index.ts` | 4 | 4 | — |
| *new:* shared chrome host + anchored positioning helper | — | 35 | Replaces 4 loops (F24): `slashMenuPlugin.ts:14-44,89-115`, `toolbarPlugin.ts:12-34,45-70`, indicator positioning, demo menu. |
| **plugins subtotal** | **3780** | **1843** | |
| `hotkeys.ts` | 667 | 300 | Registry/dispatch 92 → 50 (one encoder, returned results instead of throws). Layout/AltGr 26 (B6). Key types 52 → 2. Undo/redo 12 → 8. Block-selection keys 231 → ~125 (one island-aware adjacency helper, `compareBlockPath`, commands with selection results). Emacs table 99 → 55 (rows of chord → command; ctrl+o = soft break with `caret:'before'`). Atom removal → shared command ~15. Delete stub 12 → 3. Imports 19 → 12. Structural drift repair (66) → 0. |
| `hotkeys/navigation.ts` | 589 | 200 | Caret-stop stream (grapheme/atom/block-edge, ~40) + word stepping (~15) + block/document boundaries (~10). One apply step: focus/anchor extraction once, document-order range, atom-as-selection when exactly one atom is crossed (~30). Node-selection extension canonicalization (~20, K10). RTL mapping (~10). Bindings as data (~45 lines of rows + ~10 of platform filtering). |
| **hotkeys subtotal** | **1256** | **500** | |
| `clipboard/fragmentData.ts` | 135 | 90 | Shape validation of untrusted input ~50 (once); encode/decode + `DOMParser` extraction ~20 (the regex fallback `:129-137` exists for non-DOM test runs); read/write 20. |
| `clipboard/serializeClipboardFragment.ts` | 118 | 35 | Generic walk + escaping; per-kind/mark HTML and plain forms come from records (charged to richtext/code). |
| `clipboard/createClipboardFragment.ts` | 108 | 70 | Content/block extraction kept; per-text slicing reads the selection's segments. |
| `clipboard/insertClipboardFragment.ts` | 16 | 45 | Becomes the single placement function for any flow (inline runs + blocks, split-at-caret rule, selected-block replacement = collapse then place). |
| `clipboard/insertBlockFragment.ts` | 58 | 0 | Folded into the placement function. |
| `clipboard/insertContentFragment.ts` | 42 | 0 | Folded into the placement function. |
| `clipboard/jsonClipboard.ts` | 22 | 0 | Fresh ids through `jsonBlockToSpec(…, true)` at the insertion boundary. |
| `clipboard/types.ts` | 15 | 10 | MIME/attribute constants. |
| `clipboard/clipboard.ts` | 4 | 4 | Barrel. |
| **clipboard subtotal** | **518** | **254** | |
| `components/Text.svelte` | 213 | 60 | Attach action 15, template ~30 (ZWSP, render deltas, trailing newline), `data-placeholder` derivation ~5, props/imports ~8. Gone: placeholder DOM/observers/effects/CSS (~118) and the click re-derivation (36, **risk**: keep it if a real-browser check shows native clicks land on non-model nodes). |
| `components/Edytor.svelte` | 178 | 115 | Props 30; module imports/exports ~25; handles option ~8; sync 12; readonly/context 5; residual selectstart guard for in-snippet non-editable markup ~6; template + overlay host ~30. Root attributes become declarative (the action `:151-197` goes). |
| `components/readonlyElements.svelte.ts` | 125 | 25 | Static suggestion view objects (render deltas from JSON; atom `{type,data,selected:false}`). |
| `components/Block.svelte` | 24 | 30 | Owns the block element (`svelte:element` from the definition, `data-edytor-*` attributes, attach), then renders the snippet's inner markup; the heading re-key goes. |
| `components/Content.svelte` | 27 | 25 | Content each kept; the suggestion branch renders the same parts from static view objects. |
| `components/Mark.svelte` | 35 | 32 | Mark nesting kept (R3). |
| `components/InlineBlock.svelte` | 12 | 12 | — |
| **components subtotal** | **614** | **299** | |
| `dnd/pragmatic.ts` | 3 | 3 | P4. |
| **Domain total** | **6171** | **≈2900** | **−53 %** |

**Honest adjustments.**
- **New owner outside the domain:** the C1 dispatcher (~100 xloc). Charging half of it here gives **≈2950**, about −52 %.
- **Collateral deletions outside the domain, caused by these changes and *not* counted above:** `text/removeStalePlaceholders.ts` (192); placeholder repair wiring in `edytor.svelte.ts` (~25); placeholder/chrome liveness in `events/domTextMutationObserver.ts` (~45) and `selection.svelte.ts` (~20); `refreshEditorDom`/`editorDomRevision` (~25); `onKeyDown.ts:103-138` (~30, merged with the atom-removal command); prevention catch blocks in `onCopy/onCut/onPaste/onBeforeInput/onKeyDown` (~25). About **360 xloc** that this domain's representation choices cause elsewhere.
- **Risks that could raise the floor by ~100:**
  - HTML whitespace normalization over DOM text nodes: +30.
  - Overlay handles in nested scroll containers: +20.
  - Keeping the click re-derivation: +36.
  - Clipboard validation if no shared JSON-shape validator exists to reuse: +15.
- **Tests retired or rewritten:** the 19 tokenizer fixtures (`html-parser.fixtures.ts`), ~12 mapping-validation fixtures and the C8 trailing-content fixtures (`html-deserialize.fixtures.ts`), and the placeholder repair-queue unit tests (`src/tests/fixtures/dom/placeholder-repair.test.tsx`, its queue-statistics assertions). `placeholder-repair.spec.ts` keeps its user-visible assertions against the CSS placeholder.
- **Behaviour decisions this floor requires someone to make:**
  - The paste placement contract (probe `paste-shape`).
  - The meaning of "move down" (probe `move-down`).
  - Whether placeholder snippets may become string functions.
  - Whether an invalid HTML mapping throws or degrades (C7).
- **Extension cost after the change:** a new block kind is one record (label, icon, keywords, markdown prefix, HTML in/out, empty shape) instead of edits in 5-6 files (F20). A new extension command never touches `stopCapturing`, prevention catching, timers or caret restoration.

*Status: complete.*
