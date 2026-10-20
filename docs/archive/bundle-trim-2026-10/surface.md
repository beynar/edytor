# Bundle overview: the surface, the events and the composition root

A study, not a pass: no change landed anywhere. Everything was measured in an export of `master` (`9f592dde`) at
`/private/tmp/claude-501/-Users-arnaud-code-edytor/b263ef2a-82d9-48dc-8046-ea0619e8efda/scratchpad/ov-surface`,
with its own caches (`.bundle-cache`, `.vite-cache`, a `node_modules` of per-entry links so nothing writes the main
checkout's caches). It follows `docs/agents/bundle-trim.md`, steps 2–6, and its report format (step 12).

Area: `src/lib/surface/`, `src/lib/events/`, `src/lib/components/`, `src/lib/edytor.svelte.ts`,
`src/lib/collaboration/` (remote carets, presence), `plugins/richtext`, `plugins/suggestions`, `plugins/chrome`; and,
as the surface's boundary, the surface-side `src/lib/selection/` (the DOM adopter, the pointer, the DOM point mappers).
The boundary modules are listed with their bytes but their rewrite is shared with the session study.

Tools (in the export):

- `scripts/bundle-size.mjs` (the repository's, its cache pointed at `$S/.bundle-cache`);
- `scripts/bundle-attribution.mjs` (new, the guide's "attribution by function"): every minified byte of a probe
  build attributed through the source map to the declaration around it in `dist/` (top-level function or
  constant, class method or field, object-literal member of a large literal, a `.svelte` file's `<script>`
  declarations, its top-level snippets, its `(template)`). Gzip share: each unit's generated code gzipped alone,
  scaled so the units sum to the bundle's gzip (an estimate: gzip shares strings across units);
- `measure-state.sh <commit> <label>`: the three probes at a prototype state, `size-<label>.json` and
  `attr-<label>.json`;
- `prototypes/*.patch`: each prototype's diff; the scratch repository in the export has one commit per prototype.

## 1. Baseline

`node scripts/bundle-size.mjs --only minimal,all,export`, edytor's own bytes (the Svelte runtime excluded); gzip is
the script's figure for every emitted `.js` file (runtime included: the deltas are edytor's).

| Probe     | Own min (B) | Gzip (B) |
| --------- | ----------: | -------: |
| `minimal` |     456,314 |  173,662 |
| `all`     |     691,629 |  258,848 |
| `export`  |      52,220 |   29,579 |

The area is **136,618 B** of `minimal`'s own bytes (30 %), gzip share ≈ 50,569 B. Without the selection
boundary it is 108,280 B.

## 2. Attribution

By file (the area, `minimal`), with the five biggest units of each:

| File                                    |      Min B | Gzip share B | Biggest units (min B)                                                                                                                                                                        |
| --------------------------------------- | ---------: | -----------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| surface/observer.svelte                 |      14661 |         5725 | `adopt` 1276, `SurfaceObserver.#compare` 754, `SurfaceObserver.#restore` 713, `SurfaceObserver.#shape` 659, `SurfaceObserver.#intake` 654                                                    |
| edytor.svelte                           |      11871 |         4601 | `Edytor.attach` 2150, `Edytor.constructor` 1847, `Edytor.#onCommit` 551, `Edytor.sync` 490, `Edytor.clear` 462                                                                               |
| selection/selection.svelte              |      10720 |         4214 | `EdytorSelection.applySelectionSnapshot` 1692, `EdytorSelection.commit` 1008, `EdytorSelection.restoreDeadSelectionEndpoints` 960, `EdytorSelection.#shown` 640, `EdytorSelection.#sync` 361 |
| plugins/richtext/RichTextPlugin.svelte  |       9219 |         2346 | `module:richText` 6419, `snippet:calloutOwn` 320, `snippet:callout` 295, `snippet:todoItemOwn` 253, `snippet:detailsOwn` 253                                                                 |
| surface/projector.svelte                |       6533 |         2731 | `Projector.#display` 1147, `Projector.classify` 496, `Projector.before` 408, `Projector.#snapBack` 371, `Projector.#shows` 354                                                               |
| selection/pointer.svelte                |       5437 |         2176 | `SelectionPointer.#voidPress` 563, `SelectionPointer.restoreAtomRange` 437, `SelectionPointer.#offsetAt` 414, `SelectionPointer.dragAcross` 393, `SelectionPointer.marginClick` 382          |
| events/onBeforeInput                    |       4997 |         1704 | `nativeOf` 914, `occur` 804, `onBeforeInput` 600, `perform` 486, `declares` 482                                                                                                              |
| events/beforeInputCommands              |       4606 |         1536 | `insertParagraph` 1290, `insertPayload` 828, `splitKeepingChildren` 404, `runBeforeInputCommand` 379, `type` 266                                                                             |
| components/Block.svelte                 |       4307 |         1606 | `(template)` 1121, `script:attributes` 581, `module:elementOf` 335, `snippet:wrappedContent` 239, `module:blockViewOf` 214                                                                   |
| selection/replaceSelection              |       3982 |         1622 | `deleteSelectedBlocks` 484, `acrossColumns` 395, `liftLayouts` 390, `getSelectionBlocks` 332, `deleteRange` 303                                                                              |
| selection/selection.utils               |       3768 |         1705 | `strayText` 372, `getTextOfNode` 329, `getMarkEdgeSide` 325, `editableBoundary` 309, `getInlineBlockInSelectedRange` 285                                                                     |
| components/Edytor.svelte                |       3686 |         1337 | `(template)` 1270, `script:(top-level ExpressionStatement)` 353, `script:initialSync` 321, `script:initialEdytorOptions` 309, `module:defaultValue` 288                                      |
| events/beforeInputDeleteCommands        |       3373 |         1029 | `deleteContentBackward` 1179, `runBeforeInputDeleteCommand` 682, `deleteContentForward` 481, `deleteInText` 404, `mergeIntoHeader` 323                                                       |
| plugins/richtext/richTextOperations     |       3323 |          958 | `richTextOperations` 2289, `formatSelectedTextRange` 465, `pastedLink` 203, `typedLink` 133, `openLink` 93                                                                                   |
| collaboration/remoteSelection           |       3086 |         1036 | `getRenderedRemoteSelections` 1136, `getSelectionRects` 358, `blockBar` 353, `createRange` 278, `getCaretRect` 241                                                                           |
| events/onFocus                          |       2832 |          648 | `attachFocus` 2524, `takeKeys` 159, `selectionIsInside` 110, `isLonePress` 24, `lonePresses` 15                                                                                              |
| selection/domSelection                  |       2699 |          903 | `scrollCaretIntoView` 926, `snapshotOf` 712, `getDomSelectionSnapshot` 347, `caretAtPoint` 209, `createDomSelectionSnapshotFromRange` 168                                                    |
| components/Content.svelte               |       2683 |         1042 | `(template)` 1117, `snippet:session` 393, `script:entries` 374, `script:ghosts` 103, `script:ghost` 94                                                                                       |
| collaboration/awarenessSelection        |       2636 |         1229 | `resolvePeerSelection` 425, `readPeers` 293, `publishPresence` 283, `PresenceWriter.write` 239, `resolveAnchor` 165                                                                          |
| surface/attributes                      |       2605 |          759 | `ownedOf` 1107, `heal` 578, `setStyle` 262, `RTL` 225, `LONGHANDS` 131                                                                                                                       |
| surface/cells                           |       2526 |          892 | `createCells` 1108, `partsOf` 350, `segmentDeltas` 236, `renderDeltas` 228, `previewCells` 209                                                                                               |
| surface/overlay                         |       2264 |          950 | `Overlay.attach` 723, `Overlay.#watch` 420, `Overlay.mount` 278, `bandRun` 175, `Overlay.#run` 142                                                                                           |
| events/onDrop                           |       2225 |          872 | `preventUnsupportedDrop` 787, `onTextDragStart` 331, `insertFromDrop` 317, `observeInternalDragSources` 164, `startsInSelection` 134                                                         |
| events/onKeyDown                        |       2035 |          694 | `onKeyDown` 878, `isEventFromEditor` 407, `getStructuralFallbackInputType` 297, `shouldPreventReadonlyMutationKey` 113, `shouldRefreshSelectionBeforeKeyDown` 103                            |
| components/Text.svelte                  |       1917 |          696 | `(template)` 847, `script:restoreTextSelectionFromClick` 458, `script:tail` 167, `script:attachText` 121, `script:rendered` 107                                                              |
| selection/visibility                    |       1696 |          658 | `rangeCovers` 387, `viewOf` 321, `selectedTextSpans` 296, `selectedMembers` 211, `hidden` 184                                                                                                |
| plugins/richtext/controls.svelte        |       1594 |          550 | `calloutIcon` 660, `todoCheckbox` 498, `emptyBody` 347, `toggleTodo` 74, `richTextControls` 15                                                                                               |
| surface/pin.svelte                      |       1565 |          736 | `Pin.imeBuffer` 305, `cut` 263, `Pin.render` 219, `Pin.acquire` 196, `Pin.show` 158                                                                                                          |
| events/nativeInteractiveControl         |       1333 |          687 | `CHROME_CONTROL_SELECTOR` 282, `findNativeControlInEvent` 222, `chromeControl` 144, `isKindControl` 130, `getElementFromTarget` 108                                                          |
| events/onPaste                          |       1299 |          406 | `onPaste` 774, `syncCollapsedDomCaretForPaste` 349, `(top-level IfStatement)` 170, `shiftPasteModifierHeld` 6                                                                                |
| components/Mark.svelte                  |       1122 |          464 | `(template)` 733, `module:registerMark` 125, `module:customAt` 56, `script:register` 55, `script:inner` 40                                                                                   |
| collaboration/RemoteSelections.svelte   |       1085 |          307 | `(template)` 773, `script:(top-level ExpressionStatement)` 251, `script:rectKey` 49, `script:selections` 12                                                                                  |
| components/Ranges.svelte                |        945 |          378 | `(template)` 414, `module:runOf` 267, `script:(top-level ExpressionStatement)` 197, `script:$effect@61` 55, `script:rects` 12                                                                |
| components/CustomMark.svelte            |        853 |          352 | `snippet:content` 387, `(template)` 279, `script:inner` 40, `script:definition` 36, `script:register` 34                                                                                     |
| plugins/richtext/RichTextControl.svelte |        827 |          203 | `(template)` 768, `script:own` 44, `script:view` 15                                                                                                                                          |
| events/onInput                          |        794 |          302 | `onInput` 540, `claimOf` 193, `getInputType` 61                                                                                                                                              |
| components/InlineBlock.svelte           |        575 |          254 | `(template)` 256, `script:view` 230, `script:snippet` 50, `script:attach` 24, `script:edytor` 15                                                                                             |
| surface/lines                           |        574 |          228 | `caretBox` 388, `onOneLine` 100, `sameLine` 86                                                                                                                                               |
| components/Suggestion.svelte            |        540 |          206 | `(template)` 376, `script:cells` 121, `script:cancel` 28, `script:edytor` 15                                                                                                                 |
| plugins/suggestions/suggestionsPlugin   |        488 |          173 | `createSuggestionsPlugin` 302, `endAtCaret` 186                                                                                                                                              |
| plugins/chrome                          |        414 |          200 | `write` 198, `attach` 102, `attribute` 89, `keepSelection` 25                                                                                                                                |
| plugins/richtext/EmptyBody.svelte       |        381 |          160 | `(template)` 338, `script:view` 43                                                                                                                                                           |
| events/domTextOffset                    |        316 |          121 | `getTextContentOffsetAtPoint` 316                                                                                                                                                            |
| surface/popups.svelte                   |        307 |          224 | `Popups.set` 91, `Popups.openedBy` 84, `Popups.idOf` 49, `Popups.get current` 40, `Popups.#prefix` 20                                                                                        |
| plugins/richtext/CalloutIcon.svelte     |        295 |          115 | `(template)` 236, `script:icon` 59                                                                                                                                                           |
| events/onCopy                           |        255 |          118 | `copySelection` 220, `onCopy` 35                                                                                                                                                             |
| plugins/richtext/body                   |        234 |           96 | `openBody` 234                                                                                                                                                                               |
| components/Announcer.svelte             |        211 |           76 | `(template)` 211                                                                                                                                                                             |
| plugins/richtext/TodoCheckbox.svelte    |        188 |          100 | `(template)` 153, `script:box` 35                                                                                                                                                            |
| plugins/richtext/callouts               |        165 |          118 | `calloutHtml` 72, `iconOf` 63, `calloutIcons` 15, `calloutPickers` 15                                                                                                                        |
| events/onCut                            |        157 |           71 | `onCut` 157                                                                                                                                                                                  |
| events/events.utils                     |        154 |           71 | `isAndroidChromeBrowser` 154                                                                                                                                                                 |
| events/dataTransferPayload              |         87 |           49 | `firstUriListEntry` 87                                                                                                                                                                       |
| collaboration/providers                 |         69 |           64 | `createIndexeddbSync` 26, `createWebsocketSync` 26, `clearDocument` 17                                                                                                                       |
| collaboration/documentSync              |         58 |           38 | `whenDocumentReady` 58                                                                                                                                                                       |
| events/onPageHide                       |         46 |           33 | `attachPageHide` 46                                                                                                                                                                          |
| **area total**                          | **136618** |    **50569** |                                                                                                                                                                                              |

By unit, every unit of 400 B or more (`attribution-units-250.md` in the export lists down to 250 B):

| Min B | Gzip share B | File                                    | Unit                                            |
| ----: | -----------: | --------------------------------------- | ----------------------------------------------- |
|  6419 |         1255 | plugins/richtext/RichTextPlugin.svelte  | `module:richText`                               |
|  2524 |          486 | events/onFocus                          | `attachFocus`                                   |
|  2289 |          502 | plugins/richtext/richTextOperations     | `richTextOperations`                            |
|  2150 |          387 | edytor.svelte                           | `Edytor.attach`                                 |
|  1847 |          411 | edytor.svelte                           | `Edytor.constructor`                            |
|  1692 |          423 | selection/selection.svelte              | `EdytorSelection.applySelectionSnapshot`        |
|  1290 |          300 | events/beforeInputCommands              | `insertParagraph`                               |
|  1276 |          358 | surface/observer.svelte                 | `adopt`                                         |
|  1270 |          319 | components/Edytor.svelte                | `(template)`                                    |
|  1179 |          305 | events/beforeInputDeleteCommands        | `deleteContentBackward`                         |
|  1147 |          321 | surface/projector.svelte                | `Projector.#display`                            |
|  1136 |          279 | collaboration/remoteSelection           | `getRenderedRemoteSelections`                   |
|  1121 |          175 | components/Block.svelte                 | `(template)`                                    |
|  1117 |          250 | components/Content.svelte               | `(template)`                                    |
|  1108 |          279 | surface/cells                           | `createCells`                                   |
|  1107 |          231 | surface/attributes                      | `ownedOf`                                       |
|  1008 |          252 | selection/selection.svelte              | `EdytorSelection.commit`                        |
|   960 |          235 | selection/selection.svelte              | `EdytorSelection.restoreDeadSelectionEndpoints` |
|   926 |          256 | selection/domSelection                  | `scrollCaretIntoView`                           |
|   914 |          260 | events/onBeforeInput                    | `nativeOf`                                      |
|   878 |          199 | events/onKeyDown                        | `onKeyDown`                                     |
|   847 |          235 | components/Text.svelte                  | `(template)`                                    |
|   828 |          239 | events/beforeInputCommands              | `insertPayload`                                 |
|   804 |          220 | events/onBeforeInput                    | `occur`                                         |
|   787 |          184 | events/onDrop                           | `preventUnsupportedDrop`                        |
|   774 |          217 | events/onPaste                          | `onPaste`                                       |
|   773 |          184 | collaboration/RemoteSelections.svelte   | `(template)`                                    |
|   768 |          154 | plugins/richtext/RichTextControl.svelte | `(template)`                                    |
|   754 |          181 | surface/observer.svelte                 | `SurfaceObserver.#compare`                      |
|   733 |          200 | components/Mark.svelte                  | `(template)`                                    |
|   723 |          189 | surface/overlay                         | `Overlay.attach`                                |
|   713 |          195 | surface/observer.svelte                 | `SurfaceObserver.#restore`                      |
|   712 |          187 | selection/domSelection                  | `snapshotOf`                                    |
|   682 |          214 | events/beforeInputDeleteCommands        | `runBeforeInputDeleteCommand`                   |
|   660 |          192 | plugins/richtext/controls.svelte        | `calloutIcon`                                   |
|   659 |          190 | surface/observer.svelte                 | `SurfaceObserver.#shape`                        |
|   654 |          197 | surface/observer.svelte                 | `SurfaceObserver.#intake`                       |
|   640 |          199 | selection/selection.svelte              | `EdytorSelection.#shown`                        |
|   600 |          175 | events/onBeforeInput                    | `onBeforeInput`                                 |
|   582 |          148 | surface/observer.svelte                 | `SurfaceObserver.#resolve`                      |
|   581 |          136 | components/Block.svelte                 | `script:attributes`                             |
|   578 |          150 | surface/attributes                      | `heal`                                          |
|   563 |          186 | selection/pointer.svelte                | `SelectionPointer.#voidPress`                   |
|   551 |          154 | edytor.svelte                           | `Edytor.#onCommit`                              |
|   540 |          177 | events/onInput                          | `onInput`                                       |
|   507 |          159 | surface/observer.svelte                 | `SurfaceObserver.#heal`                         |
|   498 |          164 | plugins/richtext/controls.svelte        | `todoCheckbox`                                  |
|   496 |          140 | surface/projector.svelte                | `Projector.classify`                            |
|   490 |          136 | edytor.svelte                           | `Edytor.sync`                                   |
|   486 |          166 | events/onBeforeInput                    | `perform`                                       |
|   484 |          160 | selection/replaceSelection              | `deleteSelectedBlocks`                          |
|   482 |          151 | events/onBeforeInput                    | `declares`                                      |
|   481 |          149 | events/beforeInputDeleteCommands        | `deleteContentForward`                          |
|   475 |          169 | surface/observer.svelte                 | `SurfaceObserver.#read`                         |
|   465 |          156 | plugins/richtext/richTextOperations     | `formatSelectedTextRange`                       |
|   462 |          144 | edytor.svelte                           | `Edytor.clear`                                  |
|   458 |          128 | components/Text.svelte                  | `script:restoreTextSelectionFromClick`          |
|   454 |          118 | edytor.svelte                           | `Edytor.destroy`                                |
|   437 |          136 | selection/pointer.svelte                | `SelectionPointer.restoreAtomRange`             |
|   425 |          146 | collaboration/awarenessSelection        | `resolvePeerSelection`                          |
|   420 |          138 | surface/overlay                         | `Overlay.#watch`                                |
|   414 |          141 | selection/pointer.svelte                | `SelectionPointer.#offsetAt`                    |
|   414 |          135 | components/Ranges.svelte                | `(template)`                                    |
|   408 |          132 | surface/projector.svelte                | `Projector.before`                              |
|   407 |          133 | events/onKeyDown                        | `isEventFromEditor`                             |
|   404 |          119 | events/beforeInputCommands              | `splitKeepingChildren`                          |
|   404 |          133 | events/beforeInputDeleteCommands        | `deleteInText`                                  |

Reading it: the area has no single hot spot. Its 136.6 KB spread over 55 files and about 800 units; 204 units of
200 B or more hold 99.4 KB. Three things dominate: the rich text kind records (`module:richText`, 6.4 KB), the
event wiring (`attachFocus` 2.5 KB, `Edytor.attach` 2.2 KB, `Edytor.constructor` 1.8 KB) and the adoption paths
(`applySelectionSnapshot` 1.7 KB, the observer's `adopt` 1.3 KB). Svelte's compiled templates are ≈ 9 KB of it
(`Edytor`, `Block`, `Content`, `Text`, `Mark`, `RichTextControl`, `RemoteSelections`, `CustomMark`, the rich
text snippets): the compiler repeats a template and its effects per branch, so a branch kept for the render
markers (`render.markers`) costs 100–300 B each.

## 3. Fact map

| Fact                                                             | Computed by (shape)                                                                                                                 | Consumed by                                                     | Re-derived, converted or re-checked where                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A DOM point as a text and offset                                 | `getTextOfNode` + `getYIndex` (`selection.utils`, model rules); `textPointAt` (the session's port)                                  | the adopter, the pointer, the projector, the events             | inlined pairwise in `declares` (both ends), `dropPoint`, `syncCollapsedDomCaretForPaste`, `restoreAfterKeyboardFocus`, `#snapBack`, `#shows`, `#pointAt`; without model rules in the observer's `getCollapsedDomTextSelection` (`domOffsetIn`) and `caretIn`; a value derived twice from a DOM selection: `selection.mint` (the projector's unobserved move) and `applySelectionSnapshot` (every other) |
| A text and offset as a DOM point                                 | `domPointOf` (projector): a walk over the text element's leaves                                                                     | projector, `lines.caretBox`, remote carets, `pointer.#offsetAt` | the same leaf walk written again in `getMarkEdgeSide`, `shownMarks`, `textLeaf`, `readDomText`, `caretIn`, `Pin.imeBuffer` (textContent)                                                                                                                                                                                                                                                                |
| A node's handle (text, atom, block)                              | the observer's registry (`register`: element → `{kind, block}`)                                                                     | the observer                                                    | `edytor.nodeToText` and `nodeToInlineBlock` maps kept by `Text.attach` / `InlineBlock.attach`; `selection.getBlockOfNode` reads `data-edytor-id` (identity from an attribute, against the registry rule); `#owner` and `#textOf`: two walks up the same registry; `block.node`                                                                                                                          |
| What a core element's attributes must be                         | `ownedOf` (`surface/attributes.ts`) for the root, text, mark, atom, anchor; the block's from `Block.svelte` (`register(owned)`)     | the observer's heal                                             | restated by the templates that render them: `Mark`/`CustomMark` (3 attributes), the anchor in `Edytor.svelte` (4), `InlineBlock.attach` (3 `setAttribute`, and the table falls back on reading them back), `Text.svelte` (empty, placeholder, white-space), the root                                                                                                                                    |
| The focus is the view's                                          | `getActiveElement` + `node.contains`                                                                                                | the projector, the input and focus handlers                     | re-checked inline 9 times: projector `pre`, `#display` ×2, `#ours`; `isForeignHistory`; the root's `stabilizeCompositionSelection` and attach teardown; `clearNativeSelectionAfterExternalFocus`; `scrollCaretIntoView` (and `isEventFromEditor` reads `document.activeElement`, not shadow-aware)                                                                                                      |
| Focus the host as the editor's own                               | `expectInternalFocus()` then `focus({ preventScroll })`                                                                             | —                                                               | spelled at 6 sites (pointer ×4, projector, `takeKeys`), a 7th without `preventScroll` (`InlineBlock.attach`)                                                                                                                                                                                                                                                                                            |
| Whose event it is (a kind's control, a native control, the view) | `ownsEvent`, `isNativeInteractiveEvent`, `isControlEvent`, `isNativeInteractiveControl`, `isKindControl`, `ownsPress`, `isOwnPoint` | every handler                                                   | asked per handler in its own combination: `onKeyDown` (3), `onBeforeInput` (3), `onInput`, `onPaste`, `onCopy`, composition start and end, the pointer (6), `onDrop` (`ownsEvent` up to 4 times for one drop)                                                                                                                                                                                           |
| A press and what it means                                        | `attachFocus` + the pointer (`ownPress`, `marginPress`, `belowPress`, `chromePress`, `capture`)                                     | —                                                               | classified again by `Text.svelte`'s own `pointerdown`/`click` (a plain click's caret) and `InlineBlock.attach`'s `pointerdown` (stops the host's), against "a press inside the host is handled there"                                                                                                                                                                                                   |
| A content's segments (text between atoms)                        | `partsOf(runs)` (cells, memo by runs)                                                                                               | `Content`, the pin, the observer                                | `contentParts(items)` (session handles, memo by id and runs) over the same runs; `textOf(cell)` (observer), `ownText(runs)` (attributes), the pin's `textOf`                                                                                                                                                                                                                                            |
| A run's marks and the merge of equal runs                        | `renderDeltas` (entries, canonical JSON key)                                                                                        | `Text`, `Mark`, the observer                                    | `segmentJSON` (object, shallow equality) for `text.value`; `segmentDeltas` converts entries → object → transform → entries; `Pin.cut` entries → object; `rendersMark` filtered in `Text.rendered`, `#shape`, `modelMarks`                                                                                                                                                                               |
| A text's render deltas                                           | `Content.svelte` through `pin.shown`                                                                                                | the DOM                                                         | recomputed by the observer per compare (`deltasOf` → `segmentOf` → `pin.shown` → `segmentDeltas` + transform), in `#shape` and again in `#rewrite`                                                                                                                                                                                                                                                      |
| A content diverges                                               | `#shape` (5 reason strings), `#read` (`broken`: 2 strings)                                                                          | `#resolve`, `#invert`, `#diverges`, `#adoptContent`             | consumed only as booleans; `#invert` walks shape then rewrite, `#resolve` walks shape up to twice before `#invert` walks it again                                                                                                                                                                                                                                                                       |
| A DOM range's direction                                          | `isBackward` (selection)                                                                                                            | the adopter                                                     | `ordered`, the projector's `#write`, `#shows` (first, last), the remote carets' `createRange` (reversed)                                                                                                                                                                                                                                                                                                |
| A caret's or a range's rectangle                                 | `caretBox` (`surface/lines.ts`)                                                                                                     | navigation                                                      | `layerBox` (overlay), `toRemoteRect`, `getCaretRect`, `getFallbackRect`, `getSelectionRects`, `blockBar` (remote carets), `pointer.#offsetAt` (a caret rect per offset)                                                                                                                                                                                                                                 |
| A peer's name and colour                                         | `readPeers` (presence: user, else actor)                                                                                            | `edytor.presence.peers`                                         | `getUser` (remote carets: user only, no actor fallback)                                                                                                                                                                                                                                                                                                                                                 |
| An attach's teardown                                             | `attach`'s destroy                                                                                                                  | —                                                               | the same four releases in `destroy()`                                                                                                                                                                                                                                                                                                                                                                   |
| The root's listeners, engine events, overlay mounts              | —                                                                                                                                   | —                                                               | hand-written pairs: 4 `doc.on`/`doc.off`, 5 `mount`/`unmount`, 16 `on(node, …)`                                                                                                                                                                                                                                                                                                                         |
| A kind's children container                                      | each kind snippet (`{#if children}<div data-edytor-children>…`)                                                                     | —                                                               | written in 10 rich text snippets and `Block.svelte`'s unknown-kind fallback                                                                                                                                                                                                                                                                                                                             |
| May this view write                                              | the dispatcher's admission (`permits`, readonly)                                                                                    | every command                                                   | pre-checked by handlers before dispatching (`onPaste`, `takesTextDrop`, `onKeyDown`, `onCompositionEnd`, `belowPress`, the ArrowDown binding)                                                                                                                                                                                                                                                           |
| The collapsed caret's text and offset                            | `selection.textRange()` + `projection.isCollapsed`                                                                                  | commands, plugins                                               | read pairwise in rich text (`onPaste`, the autolink hook), `richTextOperations` ×4 (its pending-marks branch written 3 times), `endAtCaret`                                                                                                                                                                                                                                                             |
| A listener with its teardown                                     | svelte `on` (root, `attachFocus`)                                                                                                   | —                                                               | `listen` (utils), raw add/remove pairs (`Text.svelte`, `InlineBlock`, `onPress`, the overlay, `onDrop`, `onPaste`)                                                                                                                                                                                                                                                                                      |
| An attribute set or removed                                      | `heal` (attributes)                                                                                                                 | —                                                               | `browserAttributes.apply` (`Edytor.svelte`), `attribute`/`write` (`plugins/chrome.ts`)                                                                                                                                                                                                                                                                                                                  |
| A view's options                                                 | `EdytorProps`                                                                                                                       | `Edytor`                                                        | restated in `Edytor.svelte`: the destructure, `initialEdytorOptions` (13 keys), the snapshot's 10-prop spread                                                                                                                                                                                                                                                                                           |

## 4. Patterns found

Numbered as in the guide (1 one idea several shapes, 2 a check at every layer, 3 special cases a rule covers,
4 guards for impossible states, 5 private copies of a helper, 6 a walk per caller, 7 edytor computing what the
engine could hold, 8 a missing provider).

- **1** segments and marks in four shapes (`partsOf`/`contentParts`, entries/objects); a content's verdict as
  strings read as booleans; the node → handle fact in a registry and two maps; the owned attributes in a table
  and in each template; a DOM selection derived twice (`mint`, `applySelectionSnapshot`).
- **2** event ownership asked by every handler; the focus verdict re-checked at 9 sites; readonly and `permits`
  pre-checked before the dispatcher's own admission.
- **3** the root's listener, engine-event and overlay-mount pairs; the rich text presets naming their kind twice;
  `insertParagraph`'s eight branches; the format `inputType` if-chain.
- **4** `#rewrite` returning `false` for a node `#shape` already proved present; the atom table's fallback to its
  own attributes.
- **5** the leaf walk (`domPointOf`, `getMarkEdgeSide`, `shownMarks`, `textLeaf`, `readDomText`); "focus the host";
  rectangles relative to an origin; listener helpers; attribute writers.
- **6** the observer walks each content's texts in `#read`, `#shape`, `#rewrite`, `#diverges`, `#divergence` and
  `#adoptContent`, several times per pass for one content.
- **7** nothing in this area: the surface sits on the cells and the index, not on the engine. The one engine-side
  fact it re-derives is a content's segments and render deltas, which the index's runs could carry (a doc-study
  question: `partsOf` is memoized per runs identity already).
- **8** no provider for "the collapsed caret's text and offset", "the event's owner", "the text a content
  shows", or a text's render deltas (each consumer recomputes them).

## 5. Opportunities

Measured rows are prototypes (section 6), bytes of `minimal`'s own; the others are computed from the attribution
table (the consumer units' bytes, the share a rewrite removes) and calibrated by the prototypes, which realized
about 60 % of what was estimated before measuring. Ranked by net, then risk.

| #   | Opportunity                                                                                                                                                                                       | Pattern | Producer (+B)   | Consumers (−B)                                                                                                                                                                                   |                         Net (B) | Risk                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------: | -------------------------------------------------------------------- |
| P1  | The root's wiring as tables: engine events, host listeners, overlay mounts in loops; one `#detach` for both teardowns; `#withUserInput(handler, bump)`; direct port refs                          | 3, 5    | 0               | `attach` 2,150, `destroy` 454, ports 369                                                                                                                                                         |     **−607 measured** (gzip −4) | low                                                                  |
| B1  | One control snippet per rich text kind (behaviour: render markers)                                                                                                                                | 1       | —               | the 3 default snippets (`todoItem`, `details`, `callout`)                                                                                                                                        | **−1,073 measured** (gzip −115) | behaviour change, section 8                                          |
| 10  | One geometry provider (`surface/lines.ts`): a caret's and a range's client rects for remote carets, `Ranges` and `pointer.#offsetAt`                                                              | 5       | +200            | `getCaretRect` 241, `getFallbackRect` 181, `getSelectionRects` 358, `createRange` 278, `toRemoteRect` 104, `#offsetAt` 414                                                                       |                    −400 to −600 | medium (fallback sizes, dedupe)                                      |
| 12  | Rich text records stated once: presets named from their record's key, the collapsed pending-marks branch once (3 copies in `richTextOperations`), the format `inputType` chain a table            | 1, 3    | +100            | `module:richText` 6,419, `richTextOperations` 2,289, `formatSelectedTextRange` 465                                                                                                               |                    −400 to −600 | low                                                                  |
| 6   | The event's owner classified once at the boundary (the root's listener table computes the owner, a kind's control, a native one or the view; handlers read it)                                    | 2       | +150            | `preventUnsupportedDrop` 787 (+ `takesTextDrop`, `isControlDrop`), `onKeyDown` 878, `isEventFromEditor` 407, `isBrowserOwnedNativeInput` 109, `onInput`, `onPaste`, `onCopy`, composition guards |                    −300 to −500 | medium (each handler's combination differs)                          |
| 11  | One static `nested` snippet for the children container in the rich text kinds (`{#if children}{@render nested(children)}{/if}`)                                                                   | 5       | +60             | 10 snippets × ≈ 60                                                                                                                                                                               |                    −400 to −500 | medium: the marker count must not move (`render-markers.test.tsx`)   |
| 8   | One segment split: `partsOf` gains `start`/`length` and serves the handles; `text.value` reads the segment's deltas (`segmentJSON` goes)                                                          | 1       | +60             | `contentParts` 268, `segmentJSON` 239, `Handles.parts` memo 198                                                                                                                                  |                    −300 to −450 | low–medium (crosses into the session's handles)                      |
| P4  | The observer's one walk for shape and rewrite, its verdicts booleans, the impossible `#rewrite` failure gone                                                                                      | 6, 4, 1 | 0               | `#shape` 659, `#rewrite` 284, `#read`                                                                                                                                                            |   **−387 measured** (gzip −129) | low                                                                  |
| 7   | One leaf walker `leafAt(element, offset)` (the inverse of `getTextContentOffsetAtPoint`) for `domPointOf`, `getMarkEdgeSide`, `shownMarks`, `textLeaf`, `readDomText`, `caretIn`                  | 5, 6    | +120            | 325 + 352 + 172 + 337 + 200 (walk parts)                                                                                                                                                         |                    −300 to −400 | low                                                                  |
| 13  | `Edytor.svelte` passes its rest props to the view instead of restating 13 options; the snapshot spreads them                                                                                      | 1       | +40             | `initialEdytorOptions` 309, the destructure 271, the snapshot's props                                                                                                                            |                    −300 to −400 | low–medium (props proxy under `untrack`)                             |
| P3  | One registry: the observer's entries carry the handle (`handleOf`, `blockOf`); `nodeToText`, `nodeToInlineBlock` and the attribute read in `getBlockOfNode` go; `#owner`/`#textOf` share one walk | 8, 1    | +63             | `Text.attach`, `InlineBlock.attach`, `getBlockOfNode`, `ownedOf`, the root's maps                                                                                                                |    **−336 measured** (gzip −16) | low (2 browser test files read the maps)                             |
| 9   | Static core elements (anchor, atom) own what they carry at registration; the mark table built in `registerMark`                                                                                   | 1, 4    | +100            | `ownedOf` 1,107 (anchor ≈ 130, atom ≈ 200, mark ≈ 200), `InlineBlock.attach`'s `setAttribute` ×3                                                                                                 |                    −250 to −400 | low–medium (check an atom's type cannot change under its element)    |
| 17  | `adoptSemantics` reads the kind records and checks every conflict once (the root's roles, `rendersContent`, edges and default-child check go)                                                     | 2, 8    | +300 (document) | the constructor's mapping ≈ 650                                                                                                                                                                  |                    −250 to −350 | medium (the room and headless documents adopt rows of another shape) |
| P2  | `focusIn(node)` (the focus is the view's) and `expectInternalFocus(element)` focusing it                                                                                                          | 5, 2    | +19             | projector 111, pointer 111, `attachFocus` 65, root, `isForeignHistory`                                                                                                                           |    **−264 measured** (gzip −56) | low; under 0.3 KB: fold into #6 or revert                            |
| 15  | A provider for the collapsed caret's text and offset on the selection                                                                                                                             | 8       | +60             | rich text `onPaste`, the autolink hook, `richTextOperations` ×4, `endAtCaret`, `insertDividerAtSelection`                                                                                        |                    −200 to −300 | low (session boundary)                                               |
| 14  | Admission once: drop the handlers' readonly/`permits`/composing pre-checks whose early return nothing observes                                                                                    | 2       | 0               | `onPaste`, `takesTextDrop`, `onKeyDown`, `belowPress`, …                                                                                                                                         |                    −200 to −400 | medium–high (most also decide a `preventDefault`)                    |
| 16  | One listener helper (svelte `on`) where raw add/remove pairs are spelled                                                                                                                          | 5       | 0               | `Text.svelte`, `InlineBlock`, `onPress`, overlay, `onDrop`                                                                                                                                       |                    −150 to −250 | low                                                                  |
| P5  | A text's plain click handled by the one press (pointer) instead of `Text.svelte`'s own listeners                                                                                                  | 2, 8    | +393            | `restoreTextSelectionFromClick` 458                                                                                                                                                              |     **−77 measured** (gzip −34) | dropped as a size cut                                                |

Total of the rows without behaviour change: measured −1,594 B (P1–P4); estimated rows −3.5 to −5.2 KB more.

## 6. Prototypes

Each in the export, one commit each, measured with `measure-state.sh` (the three probes, same machine, same
command). `export` does not move (no surface code ships in `edytor/export`); `all` moves exactly as `minimal`.

| Cut                                                | Pattern | `minimal` own min / gzip | `all` own min / gzip | `export` | Verdict                                                    |
| -------------------------------------------------- | ------- | -----------------------: | -------------------: | -------: | ---------------------------------------------------------- |
| P1 root wiring as tables                           | 3, 5    |                −607 / −4 |            −607 / +1 |        0 | kept: above 0.3 KB, but gzip already folded the repetition |
| P2 `focusIn` + focusing `expectInternalFocus`      | 5, 2    |               −264 / −56 |           −264 / −68 |        0 | under 0.3 KB: fold into the event-owner cut (#6) or revert |
| P3 one registry for DOM → handle                   | 8, 1    |               −336 / −16 |           −336 / −31 |        0 | kept (+63 producer, −399 consumers)                        |
| P4 the observer's one shape walk, boolean verdicts | 6, 4, 1 |              −387 / −129 |          −387 / −118 |        0 | kept: 2.6 % of the observer in one cut                     |
| P5 the text click in the one press                 | 2, 8    |                −77 / −34 |            −77 / −33 |        0 | dropped: the pointer's version costs +393 B; reverted      |
| **P1–P4**                                          |         |        **−1,594 / −205** |    **−1,594 / −216** |        0 | `minimal` 456,314 → 454,720 B                              |

What each did (the patches are in `prototypes/`):

- **P1** (`edytor.svelte.ts`): the four `doc.on`/`doc.off` pairs a loop over one list; the 14 host listeners one
  table mapped through `on`; the five overlay mounts one list mapped through `mount`, one unmount loop; `attach`'s
  destroy and `destroy()` share `#detach`; `#withUserInput(handler, bump = true)` instead of an options bag;
  `placed`/`parked` passed as the projector's own bound methods (`park` kept as a wrapper: a test spies on
  `projector.park` through the instance).
- **P2**: `focusIn(node)` in `selection/domSelection.ts`, read by the projector (`pre`, `#display` ×2, `#ours`),
  `isForeignHistory`, the root (composition caret, teardown), `clearNativeSelectionAfterExternalFocus`,
  `scrollCaretIntoView`; `expectInternalFocus(element?)` focuses without scrolling, at the pointer's four sites,
  the projector's and `takeKeys`.
- **P3**: the observer's `Entry` carries `handle`; `register(…, handle)`; `handleOf(element, 'text' | 'atom')`,
  `blockOf(node)` over one `#near` walk; `edytor.nodeToText` and `nodeToInlineBlock` removed; `getBlockOfNode`
  reads the registry (no `data-edytor-id`); `ownedOf` reads the entry's handle. `src/tests/attachmentLifecycle.test.tsx`
  updated to `surface.handleOf`.
- **P4**: `#shape(id, write?)` walks each text's nodes against its deltas once and, asked to, writes the text back
  (`#rewrite` gone, its `false` a state `#shape` excludes); `#shape` and `#read.broken` booleans.

## 7. The modules to rewrite at −30 %

The ten biggest of the area, ordered by gain (30 % of their bytes, ≈ 20.0 KB together), each with the patterns
seen in it. The −30 % is the guide's budget, not an estimate: the in-module prototype (P4) took 2.6 % of the
observer in one cut, so each needs several cuts in one rewrite, the tests as the spec.

1. **`surface/observer.svelte.ts`** 14,661 B → −4.4 KB. Six walks over a content's texts per pass (pattern 6:
   `#read`, `#shape`, `#diverges`, `#divergence`, `#resolve`, `#adoptContent`; `#resolve` walks shape up to twice
   before `#invert` walks it again); foreign identity treated twice (`#clones`+`#claims` remove the element,
   `#heal` strips the attribute); `adopt` (1,276) re-derives the session's mark rules (`activeMarks`,
   `marksForInsertion` twice, `shownMarks`, `modelMarks`, `stage`): a session provider; three readings of "the
   text a content shows" (`textOf(cell)`, `readDomText`, `Pin.imeBuffer`); seven per-content sets and maps of
   pass bookkeeping (`#patched`, `#rerendered`, `#bases`, `#snapshots`, `#waiting`, `#readonly`, `#dirty`) that are
   one record per content.
2. **`edytor.svelte.ts`** 11,871 B → −3.6 KB. P1 took 5.1 %. Left: the constructor's semantics mapping (#17);
   ≈ 20 forwarding members (`isComposing`, `doc`, `awareness`, `blockAfter`/`blockBefore`, `textAt`, `atomAt`,
   `segmentOf`/`deltasOf`, the five `onX = onX.bind(this)` fields); gesture bookkeeping that belongs to the focus
   and press owners (`intentSerial`, `markUserGesture`, `lastUserGestureOutsideEditor`, the internal-focus flag);
   suggestion and placeholder rendering rules (`#replaced`, `#suggested`, `placeholderAt`) that belong to the
   suggestion layer and the cells.
3. **`plugins/richtext/RichTextPlugin.svelte`** 9,219 B → −2.8 KB. #12 and #11; the hotkeys built per view; the
   three "Own" snippets exist only for the markers (B1).
4. **`surface/projector.svelte.ts`** 6,533 B → −2.0 KB. 17 fields of evidence; four comparisons of a DOM selection
   with a stored point pair (`#shows`, `#echoes`, `#unreported`, `samePoint` over `#displayed` and `#at`); a
   second DOM → value derivation (`before`/`after` through `mint`); `shown()` re-walks `domPointOf` for offset 0.
5. **`events/onBeforeInput.ts`** 4,997 B → −1.5 KB. `nativeOf` (914) is per-type regexes over what `INTENTS`
   could carry as an owner column (pattern 3); `declares` + `adoptDeclared` (792) restate the DOM point mapping;
   three timer paths (`androidNoOpBackspaceDeadline`, `admitKeyAttempt`, `runKeyAttempt`); ownership (#6).
6. **`events/beforeInputCommands.ts`** 4,606 B → −1.4 KB. `insertParagraph` (1,290), eight branches;
   `caretAt(edytor, blockOf(edytor, …)?.firstText, 0)` ×6; `insertPayload` (828) chooses a flow from a
   `DataTransfer` as `onPaste` does (fragment, html, text, uri as a link): two paste pipelines, one rule.
7. **`components/Block.svelte`** 4,307 B → −1.3 KB. Two view objects (`blockViewOf`, `previewViewOf`), two
   `elementOf` readings, the `content`/`wrappedContent` snippets each restating the `Content` call, `attributes`
   (581) next to the table (#9); the five static-tag branches stay (markers).
8. **`components/Edytor.svelte`** 3,686 B → −1.1 KB. The options restated three times (#13); the sync wiring
   (`initialSync`, `invalidRoom`, the persist name) next to the providers' own naming; `browserAttributes` beside
   the other attribute writers.
9. **`events/beforeInputDeleteCommands.ts`** 3,373 B → −1.0 KB. Backward and forward mirrored by hand
   (1,179 + 481); two caret writers mixed (`caretAt`, `selection.selectText`: they differ in the attempt's
   repair caret, so only where no attempt reads it).
10. **`plugins/richtext/richTextOperations.ts`** 3,323 B → −1.0 KB. The collapsed pending-marks branch ×3,
    `value === undefined ? true : value` ×3, `insertDividerAtSelection`'s four prepare branches.

Boundary, shared with the session study: `selection.svelte.ts` 10,720 (`applySelectionSnapshot` 1,692, `commit`
1,008, `restoreDeadSelectionEndpoints` 960), `pointer.svelte.ts` 5,437, `selection.utils.ts` 3,768,
`events/onFocus.ts` 2,832 (`attachFocus` 2,524: nine listeners, each its own press bookkeeping).

## 8. Behaviour changes not made

For the user to decide; none was built except B1's measurement.

| #   | Change                                                                                                                                 | What changes                                                                                |                                   Saving |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------: |
| B1  | One control snippet per rich text kind (`todoItemOwn`, `detailsOwn`, `calloutOwn` always; the defaults drawn inside `RichTextControl`) | one more render marker per to-do, toggle and callout (`render-markers.test.tsx` ceilings)   |       −1,073 B min, −115 gzip (measured) |
| B2  | The core renders the children container                                                                                                | the kind API (`BlockSnippetPayload.children`), breaking                                     |    ≈ −700 (ceiling from the 10 snippets) |
| B3  | Remote selections drawn by `Ranges`                                                                                                    | `data-client-id` and `--edytor-remote-color` become `Ranges`' attributes; the theme follows | ≈ −500 (`RemoteSelections` template 773) |
| B4  | A mark owns every attribute it renders                                                                                                 | a foreign change to a mark's kind attribute (a link's `href`) re-renders it                 |                                   ≈ −200 |
| B5  | `mint` derives with the adoption's rules (one DOM → value derivation)                                                                  | an unobserved native move's value in edge cases (a UTF-16 boundary, an atom between)        |                                   ≈ −200 |
| B6  | Remote carets read `presence.peers`                                                                                                    | a peer with only an actor gets a label and colour                                           |                                   ≈ −150 |
| B7  | The projector's focus verdict counts a focused shadow host as nothing focused (`isForeignHistory`'s rule)                              | a display while the shadow host itself has the focus                                        |                                    ≈ −60 |
| B8  | The atom's press focuses without scrolling, through the shared helper                                                                  | the page no longer scrolls to the host on an atom press                                     |                                    ≈ −30 |

## 9. Verification

- `svelte-check`: 0 errors, 0 warnings after each prototype.
- `test:dom`, whole lane in the export (`vitest.dom.local.config.ts`, a cache inside the export): baseline 2,903
  passed, 1 expected fail, 34 skipped. After P1: one failure, a test spying on `projector.park` through the
  instance (the direct port reference bypassed the spy), fixed by keeping that wrapper; the file then passed.
  After P1–P3: all passed. After P1–P4: one 60 s timeout (`ops-read-document.test.tsx`, machine load average 52
  from other agents); that file, `observer-divergence`, `hostile-dom-markers` and `hostile-dom-chrome` re-run
  together: 96 passed.
- Unit: `attachmentLifecycle.test.tsx` (updated to the registry) and `deps.test.ts`: passed.
- Playwright, Chromium, port 5141: `projector.spec.ts` + `void-press.spec.ts` on P1–P3, 12 passed;
  `observer-divergence.spec.ts` on P1–P4, 5 passed.
- Not run: `pnpm lint`, `check:deps` (its test ran), `check:api`, the other browsers. P3 needs
  `tests/editor-dom/inline-atomic.spec.ts` (counts `nodeToInlineBlock.size`) and `tests/editor-dst/browserState.ts`
  (`nodeToText.get`) moved to the registry before it lands.
- No pull request: a study.

## 10. Reachable

- Measured without behaviour change: −1,594 B min, −205 gzip (P1–P4).
- With the estimated rows (#6–#17): −5.0 to −6.8 KB min for the cross-module providers and helpers.
- With the ten modules rewritten toward the −30 % budget on top of those providers, I estimate **10–14 KB min
  reachable in the area without behaviour change** (7–10 % of its 136.6 KB, ≈ 2.2–3.2 % of `minimal`), gzip about
  an eighth of that (the prototypes gave 205 B of gzip for 1,594 B min: the repetition they removed is what gzip
  already folds). The full −30 % on the ten (≈ 20 KB) is the guide's target; the evidence so far does not show it
  without the behaviour changes of section 8 (≈ 2.9 KB more).
