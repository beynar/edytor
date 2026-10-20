# Session and selection: the cross-module overview

Study of `src/lib/session/`, `src/lib/selection/`, `src/lib/block/`, `src/lib/text/`,
`src/lib/clipboard/` and `src/lib/kinds.ts` on `master` (9f592dde), following
`docs/agents/bundle-trim.md` steps 2–6, reported in its step 12 format. Raw reduction
only, no behaviour change, engine first. Everything was done in this export; the main
checkout was only read.

Tools (all in this export):

- `scripts/bundle-size.mjs`: the repository's script, its cache moved to `.bundle-cache/`
  and Vite's `cacheDir` to the probe's own folder (the linked `node_modules/.cache` and
  `node_modules/.vite` were never written).
- `scripts/bundle-attribution.mjs`: every minified byte of a probe, through its source map,
  to the innermost declaration of its `dist/` source (function, method, class field,
  top-level constant; TypeScript's parser). `node scripts/bundle-attribution.mjs minimal
  '<file regex>' --top N --json out.json`. `rollup.mjs` rolls it up to `Class.method` or
  top-level function; `q.mjs` sums what a regex names; `measure.sh` packages, builds the
  probe and prints the numbers.
- `vitest.local.{unit,dom,crdt}.config.ts`: the lanes with their Vite cache in `.vite-cache/`.
- `prototypes/0001…0003-*.patch`: the three measured prototypes, in order on `master`.

## Report

### Baseline and result (edytor's own, the Svelte runtime excluded; gzip of the whole entry)

| probe | master min | prototypes min | delta | master gzip | prototypes gzip | delta |
|---|---:|---:|---:|---:|---:|---:|
| `minimal` | 456,314 | 455,077 | **−1,237** | 173,662 | 173,292 | **−370** |
| `all` | 691,629 | 690,382 | **−1,247** | 258,848 | 258,460 | **−388** |
| `export` | 52,220 | 52,220 | 0 | 29,579 | 29,579 | 0 |

The area weighs **108,770 B (23.8 %)** of `minimal`'s own bytes, in 761 functions.

### Each cut

| cut | pattern | `minimal` min | gzip | `all` min | kept? |
|---|---|---:|---:|---:|---|
| **A** `sameValue` is `jsonEquals`: a selection value is plain frozen JSON, so the hand-written equality (`sameValue`, `sameAnchor`, `sameMarks`) is the JSON equality the bundle already ships | 5 (a private copy of a shared helper) | −470 | −131 | −470 | kept |
| **C** one segmentation of a block's content: `crdt/parts.ts` (`partsOf(runs)`, memoized per runs array, with display offsets and `segOrd`; `segmentAt`) read by the cells, the handles (`Handles.parts`, `Block.content`/`textAtOffset`, `Text`, `InlineBlock`), the projection (`segmentsOf`, `textSegmentAt`), navigation (`stringOf`) and find; `contentParts` and the cells' own `partsOf` gone; the dead atom branch of `textAtOffset` gone | 5 + 6 + 8 (three segmenters and three offset mappers of the same runs) | −664 | −212 | −683 | kept |
| **B** points as the selection's writing shape, scoped: `valueAt`/`selectAt` mint from `SelectionPoint`; `textValue`, `selectText`, `setCaret`, `clearInlineBlockSelection`, `createTextAnchor`, `dispatcher.caret`/`caretIn`/`write`, `navigation.select`, `moveText`, `deleteRange` over them; the `isRoot` guard of `createTextAnchor` dropped (the facade anchors nothing at `root`, checked) | 1 + 4 | −103 | −27 | −94 | **below the 0.3 KB bar**: as a cut alone it would be reverted. Kept in the export as the measured first step of opportunity 2, whose gain needs the callers in `events/` and the plugins to read points (the Text adapters stay until then) |

### Behaviour changes not made (found, neither built nor measured: estimates only)

| change | estimate | why it is a behaviour change |
|---|---:|---|
| one rule for a value that no longer projects (`selectText`'s seam, `caretIn`'s and `History.#run`'s `restoreDead…`, `#shown`, `#keepPending`) | −0.4 KB | the five paths decide three different things: the seam of the new value's block, the seam of the last text's block, or keeping the old value |
| `mint` reading the DOM with the adopter's full rules (shared with `applySelectionSnapshot`) | −0.15 KB | `mint` would start normalizing surrogate halves, moving an end at the next block's start, reading overlays |
| the composition's re-placement test from `change.moved` instead of `#place`/`#replaced` | −0.25 KB | `moved` also names an index shift: a block inserted before the host would end the IME session |
| `blockSelection` ids sorted once at the producer (drops `live.sort(compareBlocks)` in `wrapBlocks`, `convertBlocks`) | −0.1 KB | `selectedBlocks`' insertion order is the anchor/focus Shift+Arrow reads |
| `Block.path`/`depth`/`isChildOf` from `facade.pathOf`/`ancestorsOf` | −0.1 KB | the root and a dead handle answer `[0]`/a chain today, `null`/`[]` there |

### Verification

- `svelte-check` (`tsconfig.json` and `tsconfig.tests.json`): 0 errors, 0 warnings. eslint on
  every touched file: clean. `scripts/deps.mjs`: 307 modules, 0 cycles across contexts,
  0 forbidden imports (`crdt/parts.ts` is in the doc context, read by session and surface).
- By file, after each cut, all green: unit `mirror-incremental` (its oracle moved from
  `contentParts` to `partsOf`), `replaceSelection`, `fixtures/model/*` (268); crdt
  `arch-v2/render-cells` (19); dom: `select-commit-point`, `selection-write-dedupe`,
  `history-selection`, `presence-per-view`, `input-attempts`, `selection-sync-setters`,
  `remote-selection-preservation`, `insertion-marks`, `caret-navigation`, `find`,
  `composition-session`, `composition-pin`, `composition-over-block-selection`,
  `atom-press`, `text-drag`, `selection-shown`, `selection-seam`, `hidden-body-marks`,
  `word-chord-at-edge`, `caret-same-turn`, `keystroke-scale`, `handle-reactivity`,
  `core-api`, `input-adoption`, `elegance-selection`, `trailing-paragraph`,
  `block-selection-keys`, `kinds-conversions`, `dispatcher-hooks`,
  `contracts-virtual-paragraph`, `behavior-matrix`, `notion-parity`, `targetless-input`,
  `block-selection-extend-nested`.
- The whole `test:dom` lane once on A+B+C: 2,902 passed, 1 declared fail, 34 skipped,
  **1 timeout**: `ops-read-document` "2,000 inserts in one transaction" took 97 s against its
  60 s limit under the full lane's load. Alone it passes on the prototypes in 10.5 s, on
  `master` in 9.9 s (same machine, same command): load, not the cuts.
- Left to CI and the next pass: Playwright Chromium (not run: `pnpm build:app` writes Vite's
  cache through the linked `node_modules`), `pnpm check:api` (C changes public types:
  `SelectionSegment.runs` becomes readonly and carries the part's fields, `ProjectionDoc`
  picks `runs` instead of `contentItems`, `ContentPart` is the shared `Part`; B adds
  `selection.valueAt`/`selectAt`, to be marked `@internal`), `pnpm check:docs`, the whole
  `pnpm lint`, `pnpm test:crdt`, the changelog note.

### Pull request

None: a study. The patches are in `prototypes/`.

## Step 2. Attribution table

The `minimal` probe's own bytes, 456,314 B (445.6 KB), attributed by function with
`scripts/bundle-attribution.mjs`: the area is **108,770 B (23.8 %)** in 761 functions.
Property names are 24 % of the whole bundle (`selection` 229 times, `edytor` 293, `facade`
96, `projection` 53, `idToBlock` 55): reaching through the root is a real cost, not counted
here (destructuring would be a minification trick).

| file | bytes (master) | after prototypes A+B+C |
|---|---:|---:|
| selection/selection.svelte.js | 10720 | 10825 |
| session/suggestions.svelte.js | 9851 | 9851 |
| session/commands.js | 8440 | 8413 |
| session/composition.svelte.js | 7551 | 7551 |
| selection/pointer.svelte.js | 5437 | 5437 |
| session/navigation.js | 5208 | 5079 |
| clipboard/htmlFlow.js | 4808 | 4808 |
| block/block.svelte.js | 4616 | 4582 |
| session/selection.js | 4324 | 3530 |
| selection/replaceSelection.js | 3982 | 3932 |
| selection/selection.utils.js | 3768 | 3768 |
| session/bindings.js | 3765 | 3765 |
| session/attempt.js | 3412 | 3412 |
| session/virtual.js | 3064 | 3064 |
| kinds.js | 2741 | 2741 |
| selection/domSelection.js | 2699 | 2699 |
| session/moves.js | 2321 | 2321 |
| clipboard/textBlocks.js | 1881 | 1881 |
| session/history.js | 1829 | 1829 |
| block/inlineBlock.svelte.js | 1817 | 1773 |
| session/handles.js | 1799 | 1483 |
| selection/visibility.js | 1696 | 1696 |
| text/text.svelte.js | 1493 | 1412 |
| clipboard/moveText.js | 1445 | 1389 |
| session/keymap.js | 1385 | 1385 |
| clipboard/serializeClipboardFragment.js | 1373 | 1373 |
| session/editing/text.js | 1265 | 1265 |
| clipboard/createClipboardFragment.js | 1159 | 1159 |
| session/props.js | 1025 | 1025 |
| clipboard/insertClipboardFragment.js | 922 | 922 |
| clipboard/fragmentData.js | 759 | 759 |
| session/announcer.svelte.js | 758 | 758 |
| block/colors.js | 575 | 575 |
| text/wordBoundary.js | 509 | 509 |
| (4 files under 200 B) | 373 | 373 |
| **total** | **108770** | **107344** |

(`selection.svelte.js` grows by 105 B in prototype B: it gained the point writers while
the Text adapters stay for the callers outside the area. The shared segmenter moved to
`crdt/parts.js`, outside the area's filter: the bundle-level numbers of the Report are the
ones to read.)

The 60 heaviest functions of the area (master):

| bytes | file | function |
|---:|---|---|
| 3449 | clipboard/htmlFlow.js | `linesOfHtml` |
| 3039 | session/virtual.js | `virtualLens` |
| 1845 | session/commands.js | `Dispatcher.dispatch` |
| 1692 | selection/selection.svelte.js | `EdytorSelection.applySelectionSnapshot` |
| 1256 | clipboard/moveText.js | `dropText` |
| 1164 | session/navigation.js | `move` |
| 1070 | session/selection.js | `projectRange` |
| 1008 | selection/selection.svelte.js | `EdytorSelection.commit` |
| 960 | selection/selection.svelte.js | `EdytorSelection.restoreDeadSelectionEndpoints` |
| 959 | session/suggestions.svelte.js | `Suggestions.write` |
| 930 | block/inlineBlock.svelte.js | `InlineBlock.attach` |
| 926 | selection/domSelection.js | `scrollCaretIntoView` |
| 923 | session/composition.svelte.js | `Composition.#end` |
| 917 | session/composition.svelte.js | `Composition.start` |
| 892 | clipboard/textBlocks.js | `textToBlocks` |
| 819 | session/selection.js | `compute` |
| 806 | session/suggestions.svelte.js | `Suggestions.accept` |
| 798 | session/moves.js | `destination` |
| 779 | session/bindings.js | `builtInBindings` |
| 712 | selection/domSelection.js | `snapshotOf` |
| 698 | kinds.js | `convertToKind` |
| 640 | selection/selection.svelte.js | `EdytorSelection.#shown` |
| 639 | clipboard/createClipboardFragment.js | `fragmentOf` |
| 608 | session/commands.js | `Dispatcher.write` |
| 576 | session/suggestions.svelte.js | `Suggestions.#decide` |
| 564 | session/bindings.js | `nest` |
| 563 | selection/pointer.svelte.js | `SelectionPointer.#voidPress` |
| 545 | session/suggestions.svelte.js | `Suggestions.#places` |
| 543 | session/composition.svelte.js | `Composition.input` |
| 542 | session/commands.js | `Dispatcher.#touched` |
| 522 | session/suggestions.svelte.js | `Suggestions.written` |
| 520 | session/history.js | `History.bind` |
| 508 | block/block.svelte.js | `Block.attach` |
| 506 | session/history.js | `History.#run` |
| 505 | session/suggestions.svelte.js | `Suggestions.#resolve` |
| 484 | selection/replaceSelection.js | `deleteSelectedBlocks` |
| 460 | session/commands.js | `Dispatcher.drain` |
| 452 | kinds.js | `placing` |
| 450 | session/suggestions.svelte.js | `grown` |
| 437 | selection/pointer.svelte.js | `SelectionPointer.restoreAtomRange` |
| 433 | session/composition.svelte.js | `Composition.#open` |
| 428 | session/moves.js | `placement` |
| 423 | clipboard/textBlocks.js | `lineKind` |
| 420 | session/navigation.js | `rows` (+ the `navigationBindings` table) |
| 414 | selection/pointer.svelte.js | `SelectionPointer.#offsetAt` |
| 414 | session/commands.js | `Dispatcher.run` |
| 412 | session/suggestions.svelte.js | `Suggestions.#target` |
| 410 | session/editing/text.js | `marksForInsertion` |
| 410 | session/props.js | `DataWrites.proxy` |
| 408 | session/suggestions.svelte.js | `Suggestion.append` |
| 405 | session/bindings.js | `emacs` |
| 395 | selection/replaceSelection.js | `acrossColumns` |
| 393 | selection/pointer.svelte.js | `SelectionPointer.dragAcross` |
| 393 | session/commands.js | `Dispatcher.operate` |
| 390 | selection/replaceSelection.js | `liftLayouts` |
| 389 | session/bindings.js | `extend` |
| 387 | selection/visibility.js | `rangeCovers` |
| 386 | session/attempt.js | `KINDS` (+ the `INTENTS` loops) |
| 383 | session/attempt.js | `attemptOf` |
| 382 | selection/pointer.svelte.js | `SelectionPointer.marginClick` |

Families (one fact, all its functions, master bytes):

| family | bytes |
|---|---:|
| DOM selection → model (derive, `mint`, `selection.utils`, pointer readers, `isBackward`, `overlayAt`, `atomBetween`) | 8330 |
| shown line and block walkers (`firstText`/`lastText`/`#editable`, `shownText`, `caretBeside`, `beside`, `selectedBlocksLine`/`Exit`, `caretAfterBlockDelete`, `rangeEdge`, ancestor loops, `liftLayouts`, `outermost`, `movable`, `reveal`, `acrossColumns`, `hidden`, `shown`, `selectedMembers`) | 4617 |
| repair of a value that no longer projects (`restoreDead…`, `#shown`, `#seamValue`, `#land`, `#keepPending`, `rangeEdge`, `History.#run`) | 2571 |
| the Text-segment caret API (`textAt`, `textRange`, `textValue`, `selectText`, `createTextAnchor`, `resolveTextAnchor`, `setCaret`, `caret`, `caretIn`, `caretLeft`, `caretAt`, `admittedSide`) | 2378 |
| content segmentation (`segmentsOf`, `textSegmentAt`, `contentParts`, `Handles.parts`, `partsOf`, `textAtOffset`, `Text.#at`, `InlineBlock.#item`, `content`, `stringOf`) | 2120 |
| document-order walks (`displayable`, `stopBelow`, `between`, `islandOf`, `lineStop`, `linesOf`, `blockBefore`/`After`, `shown`, `stepOnto`) | 2069 |
| handle attachments (`Block.attach`, `Text.attach`, `InlineBlock.attach`) | 1813 |
| undo grouping (`CUT`, `policyOf`, `insertion`, `inserts`, `textPatch`, `typedFrom`, `continuesTyping`, `cut`/`policy`/`decide`, `History.wrote`/`continues`/`selected`/`began`) | 1720 |

## Step 3. Fact map

| fact | computed by (shape) | consumed by | re-derived, converted or re-checked at |
|---|---|---|---|
| **A caret / a range end** | `EdytorSelection.commit` holds the value: two `DocAnchor`s `{b, a:{i,a}}`; `project()` gives `SelectionPoint {block, offset}` | every command | **six shapes of one position**: `DocAnchor`; `SelectionPoint`; `DocPosition` (same shape, second type, `crdt/rangeDelete`); `{blockId, offset}` (`facade.resolveAnchor`, converted back to `{block, offset}` in `compute`, `resolveTextAnchor`, `moveText` ×3, comments); `{text, offset}` / `RangeEndpoints {startText, yStart, …}` (`textRange()`, `textAt()`, `SelectionInsertionTarget`, `TextPoint`, `PointerTextPoint`); `Caret {block: Block, offset}`. The Text shape is lowered from points by `textAt` → `Block.textAtOffset` and raised back by `text.segStart + y` at **48 sites in 22 files** (29 in the probe), `text.parent.id` 24 times. Minting goes through 9 entry points (`textValue`, `createTextAnchor`, `selectText`, `setCaret`, `selectLines`, `caret`, `caretIn`, `#seamValue`, raw `anchorAt` in `restoreDead…`, composition, `moveText`). Point comparison written 3 times (`navigation.compare`, `moveText.compare`, `projectRange`). |
| **A block's content as segments** | the index's runs (`facade.runs`, merged, interned) | cells, handles, projection, navigation | **three segmenters** of the same runs: `cells.partsOf` (keyed causally), `handles.contentParts` (display starts), `selection.segmentsOf` (from `contentItems`, unmerged, recomputed per projection, per block in range); **two offset → segment mappers** with one rule (`Block.textAtOffset`, `textSegmentAt`), plus `Text.#at` and `InlineBlock.#item` scanning parts, `navigation.stringOf` rebuilding the block's string (3 times per key), the observer's and suggest's own `ATOM` strings. |
| **Value equality** | `sameValue` (+ `sameAnchor`, `sameMarks`) | `commit`, node-bound check, `onBeforeInput` | the value is plain JSON: `jsonEquals` (already in the bundle) is the same rule. Also `sameEnds`, `surface/overlay.sameValues`. |
| **A value that no longer projects** | `restoreDeadSelectionEndpoints` (per kind) and `#shown` (non-rendering blocks) | post-flush, `select()` | also decided in `selectText` (seam of the start's block), `Dispatcher.caretIn` (`if (!projection.start) restoreDead…`), `History.#run` (same check, keeps the old value), `#keepPending`. These are **different rules** (new value's block vs. the last text's block vs. keep the old value): not one fact, no merge without a behaviour change. |
| **Is a block shown** | DOM reads: `hidden(block)` (`block.node.closest(HIDDEN)`), `selection.displayable(id)` (first mounted text, not hidden), `Block.#editable` (a rendered text), `bodyShows` | navigation, deletes, ranges, Escape, menus | walkers over the order, each with its predicate: `shown` (over `facade.previous/next`), `navigation.displayable` and `stopBelow` (over `facade.order().indexOf`, O(n) per step), `between` (slice of `order()`), `stepOnto`, `caretBeside`, `beside`, `acrossColumns`, and **seven "nearest shown line" readers** (`shownText`, `caretBeside`, `selectedBlocksLine`, `selectedBlocksExit`, `caretAfterBlockDelete`, `rangeEdge`, `#shown.moved`) next to `firstText`/`lastText`/`firstEditableText`/`lastEditableText`. |
| **Ancestors** | `facade.ancestorsOf(id)` (ids, nearest first, no root) | projection, navigation, composition | handle parent-chain loops (`block.parent` = one `positionOf` per step) written 11 times: `Block.depth`/`path`/`isChildOf`/`list`, `liftLayouts`, `acrossColumns.columns`, `outermost.inside`, `movable`, `reveal`, `hidden`'s owner, `rangeCovers`' hider, `caretAfterBlockDelete`. Island root twice (`projection.islandRoot`, `navigation.islandOf`). `Block.path` re-derives `facade.pathOf`. |
| **May this view write** | `dispatcher.permits()` | `run`, `dispatch`, `History.replay` | asked again for UI claims (whether a key or press is the editor's: `leavesLastStop`, `belowPress`, `marginClick`, `#end`) and `edytor.readonly` in `moves.destination`/`canPlaceNew` (needed by `canMove`, `canPlaceNew` for the UI). In the area these are claims, not duplicate admissions; the duplicated admission is in the plugins (25 `permits()`/`readonly` checks before a dispatch that refuses anyway: other study). |
| **Undo grouping** | the dispatcher's `CUT` table + `policyOf`/`decide` | every write | **three continuation rules** for "typing continues the step": `history.continues` (text, by the caret the step left, `INSERTING` meta), `textPatch`/`typedFrom`/`continuesTyping` (bound fields, by path and edit shape), the composition's `#hold`/`#tracked` (writes `um.lastChange` itself). |
| **What a step normalizes** | `Dispatcher.#touched` (by op over `PlanStep`) | `drain` | the doc's `effectOf` walks the same `PlanStep` union by op for the effect; `argsOf` (doc) + `steps()` + `subjectOf` + `operate` map the same args to a block and a text handle twice. |
| **Node ↔ handle** | the observer's registry (`register(node, kind, block)`) | observer, attributes | parallel maps: `nodeToText`, `nodeToInlineBlock`, `Block.node`/`Text.node`/`InlineBlock.node`; lookups `getBlockOfNode` (closest + `dataset` + `idToBlock`), `getTextOfNode` (closest + `nodeToText` + stray rules), `getInlineBlockOfNode`, the observer's `#textOf` (registry walk). The three `attach` methods repeat set node / register / plugin hook / destroy. |
| **Marks at a position** | `marksForInsertion` (Text + `getMarksAtRange`) | typing, IME, paste, adoption | `projection.marks` (`marksOver` over runs), `insertionMarksAt` (block offset → Text → back); "push a run, merging equal marks" written **7 times** (`segmentJSON`, `htmlFlow.text`, `export/markdown`, `cells.renderDeltas`, `crdt/text/ranges`, `crdt/text/index/cache`, `crdt/restore`) with three equality tests (`===` keys, `JSON.stringify`, `marksEqual`). |
| **Platform** | none | | `keymap.isMac`, `composition.isAppleWebKit`, `events.utils.isAndroidChromeBrowser`: three sniffers, three modules. |
| **Focus the host for a press the model answers** | none | | `expectInternalFocus(); node.focus({ preventScroll: true })` at 5 sites (pointer ×4, `takeKeys`). |
| **Where a move lands** | `moves.destination` (parent, index minus the moved siblings, `canPlace`) | keys, drops, menus | the doc's `prepare.moveBlocks` checks `canPlace` again; `placeNew` builds destinations the same way; the doc already answers `nestParent`, `besideAt`, `landingOf`, `unNestBlocks`. |
| **The virtual paragraph** | `session/virtual.ts` (the lens, owner) | every read of the view | 17 read overrides (`on(b) ? X : base.X(b)`) and 14 write folds; nothing duplicated, but every read pays the lens. |

What the area asks of the doc: anchors (`anchorAt`, `resolveAnchor`, `followUndo`, `seam`),
order (`order`, `compare`, `next`/`previous`, `ancestorsOf`, `pathOf`, `positionOf`,
`childrenIds`), roles (`isIsland`, `isVoid`, `isVisibleBlock`, `isLayoutItem`,
`isTableCell`/`Row`, `tableOf`, `rendersContent`), content (`runs`, `contentItems`,
`displayLength`), plans (`prepare.*`, `compose`, `apply`), placement answers (`canPlace`,
`nestParent`, `landingOf`, `besideAt`, `fits`). What it re-derives: the segment split,
the block string, point order, the island root, a move's index, the `{blockId}` →
`{block}` conversion. What it asks of the surface: `ports.surface` (`park`, `placed`,
`parked`, `flush`, `clear`, `pointAt`, `sameLine`), `projector` (`classify`, `observe`,
`mounted`), `surface.register`/`update`, `pin`, `cells`, `overlay.observe`. What it
re-derives there: two "is it shown" predicates and three node → handle lookups.

## Step 4. The patterns, named

The guide's numbering: 1 one idea, several shapes; 2 a check at every layer; 3 special
cases a rule covers; 4 guards for impossible states; 5 private copies of a shared helper;
6 a walk written per caller; 7 edytor computing what the engine could hold; 8 a missing
provider.

| finding | where | pattern |
|---|---|---|
| six shapes of one position, raised back by `text.segStart + y` at 48 sites (29 in the probe) | selection, commands, events, clipboard, plugins | 1, 8 (the projection's points are the provider nobody reads) |
| three segmenters and three offset → segment mappers of the same runs | cells, handles, projection, `Block`, `Text`, `InlineBlock`, navigation | 5, 6, 8 (**cut C**) |
| value equality written by hand beside `jsonEquals` | `session/selection` | 5 (**cut A**) |
| `createTextAnchor`'s `isRoot` guard: the facade anchors nothing at `root` | `selection.svelte` | 4 (**cut B**) |
| `textAtOffset`'s atom branch could never return (the text before an atom catches every offset up to it) | `block.svelte` | 4 (**cut C**) |
| seven "nearest shown line" readers, four "first text" getters, eleven parent-chain loops | `replaceSelection`, `visibility`, `selection.svelte`, `block.svelte`, `bindings` | 5, 6 |
| `navigation.displayable`/`stopBelow` walk `order().indexOf` where the doc answers `next`/`previous`; `between` slices `order()` | navigation, projection | 6 |
| three continuation rules for "typing continues the step" | commands (`textPatch`…), history (`continues`), composition (`#hold`) | 1 |
| `#touched` walks `PlanStep` by op as `effectOf` does | commands vs `crdt/doc/plan` | 6 |
| node → handle in four registries, three `attach` bodies | root maps, observer registry, handles | 5 |
| "push a run, merging equal marks" seven times | handles, htmlFlow, export, cells, crdt (×3) | 5 |
| the preview's units probed with one `anchorAt(…).a.i` per offset | composition | 7 |
| `{blockId, offset}` → `{block, offset}` five times; point comparison three times | projection, selection, moveText, comments | 1, 5 |
| three platform sniffers; five "focus the host" pairs; two modifier tests | keymap, composition, events, pointer | 5 |
| a move's index computed in the view, `canPlace` asked by the view then by the doc | moves | 2, 8 |
| the virtual paragraph's 17 read overrides | virtual | 8 (the index could show it) |
| suggested plans rewritten by the view | suggestions | 7 (in flight) |

Not findings, checked: the area's `permits()`/`readonly` reads are UI claims (is this key or
press the editor's?), not second admissions (the plugins' 25 are: another area);
`scrollCaretIntoView`'s own clip test is a browser rule; the five repair paths are different
rules (behaviour changes table).

## Step 5. Every opportunity, accounted

Ranked by net, then risk. **Measured** rows were built and counted with the bundle script
(`minimal`, own bytes); the others are estimates from the attribution of the functions
involved, which the guide's history says can be off by 2× to 5×.

| # | opportunity | pattern | producer (+bytes) | consumers (−bytes) | net | risk |
|---:|---|---|---|---|---:|---|
| 1 | suggestions written by the engine (in flight on `suggestions-in-engine`, 109 lines out so far) | 7 | `crdt/doc/suggest.ts` | `Suggestions.write`/`written`/`#places`/`#target`/`#resolve`/`#slot`/`grown`/`accept` (≈5 KB of 9.9 KB) | ≈ −3.5 KB est. | the branch's |
| 2 | points as the one caret shape: writers take `SelectionPoint`, commands read `projection.start/end` instead of `textRange()` + `segStart`, then the Text adapters go | 1, 8 | `valueAt`, `selectAt`, `pointOf` (+0.25 KB) | 29 `segStart` round trips (≈ −20 B each), 37 ends-only `textRange()` lowerings (≈ −10 B), the adapters (−0.3 KB) | **−0.10 KB measured** (scoped); ≈ −0.6 KB est. through `events/` (re-estimated down from −0.8 after the prototype) | low |
| 3 | one segmentation of a block's content | 5, 6, 8 | `crdt/parts.ts` (+≈0.35 KB) | segmenters and mappers (≈1.0 KB) | **−0.66 KB measured** | low |
| 4 | the shown-line family as one reader over one walker, and a `Block.ancestors` getter | 5, 6 | `visibility.ts` (+≈0.3 KB) | the 4.6 KB family | ≈ −0.8 KB est. | medium (seven Notion rules with contract rows) |
| 5 | one DOM point → text point reader, one node → handle registry, one `attachHandle` | 5 | surface registry (+≈0.15 KB) | `mint`, pointer readers, three lookups, three `attach` | ≈ −0.6 KB est. | low-medium (the surface's owner) |
| 6 | `sameValue` is `jsonEquals` | 5 | none | `sameValue`, `sameAnchor`, `sameMarks` | **−0.47 KB measured** | none |
| 7 | one undo continuation rule (`history.continues(key, value)`, the capture group held through the history) | 1 | `History` (+≈0.15 KB) | `textPatch`, `typedFrom`, `continuesTyping`, `patched`, `#hold`, `#tracked` | ≈ −0.4 KB est. | medium |
| 8 | relative move destinations in the doc (`moveBlocks(ids, {target, position})`) | 2, 8 | `crdt/doc` (+≈0.2 KB) | `destination`/`placement`/`placeNew` index arithmetic and second `canPlace` | ≈ −0.4 KB est. | medium-high |
| 9 | what a step normalizes from the doc's step walker | 6 | `effectOf` (+≈0.2 KB, additive `PlanEffect` field) | `#touched` (542 B) | ≈ −0.3 KB est. | low-medium |
| 10 | one "push a run, merging equal marks" leaf | 5 | `utils/json.ts` (+≈0.1 KB) | seven copies | ≈ −0.3 KB est. | low (each site keeps its equality) |
| 11 | composition units from the engine (the write answers its ids, or `itemsIn`) | 7 | crdt text read (+≈0.1 KB) | `#unit`, `#units` | ≈ −0.25 KB est. | medium |
| 12 | platform facts and `focusHost()` once | 5 | leaf + root (+≈0.1 KB) | three sniffers, five focus pairs, two modifier tests | ≈ −0.25 KB est. | none |
| 13 | point vocabulary in the doc (`resolveAnchor` also answers `block`; `comparePoints`) | 1, 5 | doc (+≈0.05 KB) | five conversions, three comparisons | ≈ −0.2 KB est. | low |
| 14 | the virtual paragraph as an index fact | 8 | index (+≈0.4 KB) | 17 read overrides and the `onChange` rewrite (1.2 KB) | ≈ −0.8 KB est. | high (the index self-checks rebuild from replicated state, which never holds it) |

## Step 6. The prototypes

The top rows by expected net outside the in-flight branch (2, 3) and the surest (6, cut A),
each in this export, measured with `scripts/bundle-size.mjs`, tests by file name (see the
Verification list).

- **Row 3 (cut C)** saved what its row said: −664 B min, −212 B gzip in `minimal`
  (−683 B in `all`). The projection also got cheaper: it reads the index's cached runs
  instead of re-reading items for every block of a range.
- **Row 6 (cut A)**: −470 B min, −131 B gzip, as estimated.
- **Row 2 (cut B, scoped)**: −103 B min. The scoped prototype adds the point writers and
  keeps every Text adapter for the callers outside the area, so the consumers it converted
  (`navigation.select`, `moveText`, `deleteRange`, the dispatcher's carets) pay for the
  writers and little more. Re-estimated from −0.8 to about −0.6 KB, to be measured again
  once `events/beforeInputCommands.ts` and `beforeInputDeleteCommands.ts` (13 of the 29
  round trips) read points.

## The modules to rewrite toward −30 %

The ten biggest of the area, ordered by the gain I expect without a behaviour change
(each cross-module row counted once). Estimates, except where a cut is named.

1. **`session/suggestions.svelte.ts`** 9.9 KB → ≈ −3.5 KB (−35 %), in flight on
   `suggestions-in-engine`. The view rewrites plans into suggestion writes the engine can
   own (`write`, `written`, `#places`, `#target`, `#resolve`, `#slot`, pattern 7); `grown`
   compares JSON blocks a second time with `canonKey` (1); a decision walks changes the
   engine already groups (6).
2. **`selection/selection.svelte.ts`** 10.7 KB → ≈ −2.0 KB (−19 %). Six entry points to
   mint one anchor pair over a Text layer (row 2, pattern 1); the DOM derive written twice,
   `applySelectionSnapshot` and `mint`, and `getBlockOfNode`'s own `dataset` lookup (row 5,
   5); four mirrors of one value (`#selected`, `#focused`, `selectedInlineBlock`,
   `inlineBlockDeletionTarget` beside `Membership`: the atom pair is one fact, 1);
   `#keepPending` projects twice what `commit` projects again (6); `sameValue` (cut A).
3. **`session/commands.ts`** 8.4 KB → ≈ −1.3 KB (−15 %). Two continuation rules (row 7);
   `#touched` beside `effectOf` (row 9); `steps()` and `operate()` map arguments to a block
   and a text handle the same way (5); `caret`/`caretIn` (row 2, started in B); refusals
   recorded at five places (`#refused`, `record`, `PREVENTED`, `run`'s `applied`,
   `plan`'s `?? PREVENTED`, 1); six prevention-scope entry points around one try/catch
   (`run`, `each`, `scope`, `intercept`, `replace`, `settle`, 3).
4. **`session/composition.svelte.ts`** 7.6 KB → ≈ −1.2 KB (−16 %). Units probed one offset
   at a time (row 11, 7); region anchor → `{blockId, offset}` → Text → block offset in
   `#slot`, `#at`, `#kept`, `covers` and `#end`'s arguments (row 2, 1); the capture group
   held by writing `um.lastChange` (row 7); `isAppleWebKit` (row 12, 5); `textRange()` read
   three times for its start (6).
5. **`session/selection.ts`** 4.3 KB → ≈ −1.0 KB (−23 %), **−0.8 KB done** by cuts A and C.
   Left: `EMPTY`, `none()` and the atom branch build three empty projections (3);
   `sameEnds` beside `jsonEquals` (5).
6. **`selection/pointer.svelte.ts`** 5.4 KB → ≈ −0.9 KB (−17 %). The host-focus pair ×4 and
   the modifier test ×2 (row 12, 5); three DOM point readers (row 5, 5); "a primary press on
   the host" tested separately in `belowPress`, `marginPress`, `capture`,
   `collapseBlocksAt`, `#voidPress` (2); `#offsetAt` measures every offset after the
   caret-at-point reader already answered (6).
7. **`block/block.svelte.ts`** 4.6 KB → ≈ −0.9 KB (−20 %). Four "first text" getters beside
   `shownText` (row 4, 5); `depth`, `path`, `isChildOf`, `list` walk parents one
   `positionOf` at a time (6); `attach` (row 5, 5); `textAtOffset` (cut C).
8. **`session/navigation.ts`** 5.2 KB → ≈ −0.8 KB (−15 %), −0.13 KB done by B and C.
   `stringOf` rebuilt three times per key (6); `displayable()`/`stopBelow` over
   `order().indexOf` (6); `compare` (also `moveText`'s) and `islandOf` (the projection's
   `islandRoot`) (row 13, 5).
9. **`selection/replaceSelection.ts`** 4.0 KB → ≈ −0.7 KB (−18 %). The shown-line family and
   seven parent-chain loops (row 4, 5 and 6); `deleteRange` → `caretLeft` → `textRange()`
   again for the caret the plan already declared (`plan.at`, 1).
10. **`clipboard/htmlFlow.ts`** 4.8 KB → ≈ −0.6 KB (−12 %). `kindOf` asked again for the same
    element by `isBlock`, `isVoid` and `blockOf` (6); three `Cursor` objects built by hand
    (5); the run merge (row 10); `end()` re-trimming lines the cursor just closed (6).

Next, smaller: `selection.utils` (3.8 KB, ≈ −0.4: the boundary readers are browser rules),
`bindings` (3.8 KB, ≈ −0.4: `kill`, `deleteSelection` and `wordAndLineDeletes` are one row
type, 3), `attempt` (3.4 KB, ≈ −0.3), `virtual` (3.1 KB, ≈ −0.3 locally, −0.8 with row 14).

The ten together: ≈ **−12.9 KB of 59.0 KB (−22 %)**. −30 % on all ten is not reachable
without a behaviour change: much of their weight is browser rules (Firefox's stray nodes,
WebKit's phantom keys, Android's unannounced updates) and Notion rules that each have a
contract row. The behaviour changes table above lists what going further would take.

## What I estimate is reachable in the area

| source | bytes |
|---|---:|
| measured (cuts A + B + C) | −1.24 KB |
| the other low/medium-risk rows (2 rest, 4, 5, 7, 9–13) | ≈ −3.6 KB |
| suggestions into the engine (row 1, in flight) | ≈ −3.5 KB |
| module-local rewrites in the ten modules (section above, net of the rows) | ≈ −4.3 KB |
| **total without a behaviour change** | **≈ −13 KB of 108.8 KB (−12 %)** |
| plus the high-risk engine moves (rows 8, 14) | ≈ −1.2 KB |
| plus the behaviour changes listed (for the user) | ≈ −1.0 KB |
