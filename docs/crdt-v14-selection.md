# CRDT v14 — selection, presence, history, browser input (U09)

Companion to `crdt-v14-implementation-plan.md` and the execution ledger.
This document records the U09 contract: how selection endpoints are
anchored to backing-text atoms, how remote carets ride awareness, how
local undo stays selective under concurrent remote edits, and what the
browser-input/composition lanes cover.

## Anchor model

### Shapes

Two levels, both JSON-serializable:

- **Engine anchor** — `{i: {c: number; k: number} | null; a: number}`.
  `i` is the bound item's id (`client`, `clock`); `a` is the engine
  association (`a < 0` left, `a >= 0` right). `i === null` is a sentinel:
  `a < 0` = live start (resolves to index 0, stays before prepends),
  `a >= 0` = live end (resolves to `text.length`, follows appends).
- **Document anchor** (`DocAnchor`, exported as `TextAnchor` at the
  selection layer) — `{b: string; a: Anchor}`. `b` is the **home block id
  of the backing text** the bound atom lives in — _not_ necessarily the
  block that displays it. Merges/splits reroute display while the anchor
  stays on the same atoms.

### Affinity

`facade.anchorAt(blockId, displayOffset, affinity)` with
`AnchorAffinity = 'left' | 'right'`:

- `'left'` (assoc `-1`) binds the atom _before_ the position. An insert
  exactly at the position lands to the anchor's **right** — the caret
  does not absorb boundary inserts. Used for carets and range **ends**
  (the baseline `Y.createRelativePositionFromTypeIndex(text, i, -1)`
  behavior).
- `'right'` (assoc `0`) binds the atom _at_ the position. An insert lands
  to the anchor's **left** — outside a range starting here. Used for
  range **starts**.

`T.atomAnchorAt` (`src/lib/crdt/text/model.ts`) is the selection-anchor
primitive — distinct from the slice-record `T.anchorAt`, which keeps
index sentinels (`{i:null,a:-1}`/`{i:null,a:0}` at both ends) because
records need absolute range edges, not affinity edges.

### `facade.anchorAt` mapping

Display offset → backing anchor:

1. `anchorView()` = `collectBlocks` + `computeOwnership` (no placements —
   pure replicated state, safe mid-transaction).
2. `T.flatten(blockId)` gives ordered `{t, i0, i1}` segments of the
   block's visible content.
3. The segment containing the position's affinity-side atom supplies the
   backing text + index; at cross-segment seams affinity picks the side.
4. Empty display binds the block's **own** backing text at index 0 —
   where typed content will land.
5. `null` when the block has no backing text (e.g. unknown id).

### `facade.resolveAnchor` mapping

Backing anchor → `{blockId, offset}` (current display position):

1. `T.resolveAnchor` resolves the engine anchor to a live gap index
   (`followUndoneDeletions = false`; `null` = bound item not yet
   integrated — the position converges when the update lands).
2. The gap's owner is the owner of the affinity-side adjacent atom
   (left atom first for left affinity, right for right), the other side
   as fallback. Moved/merged atoms keep their anchor — the position
   follows them into whichever block now displays them.
3. Neither adjacent atom owned → scan outward for the nearest owned atom
   in the same backing text (affinity direction first).
4. No atom of the backing text owned anywhere → `ownerOf(t)` — the block
   the slice list routes to — at the **emission seam**
   (`emissionOffset`, the display offset where a merge-claim chain first
   reaches `t`'s records — exactly where restored content reappears).
5. Dead/deleted owner → `null`; callers fall back to id/path restore.
6. Bound atom tombstoned → resolves to the gap where it lived; deleted
   content never resurrects and never displaces the anchor.

`selection.resolveTextAnchor` then maps the display offset onto a `Text`
wrapper using the **engine-fresh projection** (`deriveContentParts`
boundaries + `_segOrd` matching) — wrapper part lengths can lag a model
write until the mirror reconciles, which previously misplaced the caret
right after an edit (found by the inline-atom round-trip fixture).

## Selection integration

`EdytorSelection` keeps the public contract — `startText`, `endText`,
`yStart`, `yEnd`, collapsed/range flags — while endpoints are
anchor-authoritative underneath:

- `createTextAnchor(text, offset, affinity)` → `facade.anchorAt(
blockId, text.segStart + offset, affinity)`; `null` while the text is
  not bound to a live block (mirrors the old non-integrated `Y.Text`
  behavior).
- `state.relativePosition` = the caret's `TextAnchor` — `'left'` when
  collapsed, `'right'` for a range's left edge.
- `restoreRelativePosition` re-anchors a caret whose text was edited
  under it (blur-repair path unchanged).

### Undo selection snapshots

`UndoSelectionSnapshot` carries `startAnchor`/`endAnchor` **plus** the
pre-U09 fields (text ids, paths, `yStart`/`yEnd`, selected block
ids/paths). Restore resolves anchors **first** — they follow
moved/merged atoms and land on the documented deleted-backing fallback —
and falls back to id/path + numeric offset only when the anchor cannot
resolve (deleted target, pre-U09 snapshot, not-yet-integrated bound
item). Anchors are re-resolved on every retry attempt, so a bound item
that was in flight converges as remote updates land. Block selections
still restore by id/path (block identity is stable; anchors are a
text-position concern).

## Presence contract

`EdytorAwarenessSelection` (awareness `selection` field):

- `start`/`end`: `TextAnchor | null` — serialized anchors with affinity
  (range start `'right'`, end/caret `'left'`).
- `startTextId`/`endTextId`, `yStart`/`yEnd`, `isCollapsed`,
  `isReversed`: compatibility fields for older peers and as the numeric
  fallback.

Remote rendering (`getRenderedRemoteSelections`) resolves anchors first,
then `startTextId`/`yStart`. `isTextAnchor` validates the wire shape —
`{b: string, a: {i: {c,k}|null, a: number}}` — so foreign payloads
(v13-shaped `RelativePosition` `{type,item,assoc}`, malformed objects)
are safely ignored rather than interpreted with wrong offsets, and
`resolveTextOffset` is wrapped so a malformed remote id degrades to "not
rendered" instead of throwing. Awareness changes (`added`/`updated`/
`removed`) drive `remotePresenceRevision`; `selection.destroy()` calls
`clearAwarenessSelection` so detaching the editor drops our published
caret (the awareness object itself is owned by the provider, which
already broadcasts `setLocalState(null)` on disconnect).

## History

- Undo manager: registry-scoped `ed.createUndoManager`, attached after
  init — `meta.v`/schema writes and the bootstrap are never captured.
- `Edytor` transactions run under `this.transaction`; the manager tracks
  `{this.transaction, null}`. Remote updates are non-local transactions
  with foreign origins — they never enter the local stack.
- Selective undo evidence (`src/tests/crdt/doc/selective-undo.test.ts`,
  two replicas, state-vector sync):
  - concurrent text edits — local undo removes only the local insert;
  - local edit then remote text edit — remote text survives undo;
  - local `nestBlock` + remote text edit — undo restores the position,
    remote text survives;
  - undo+redo converge on both replicas (`toJSON` equality);
  - remote deletes adjacent to a local insert stay deleted;
  - remote writes mid-session grow the stack by 0.
- `historyUndo`/`historyRedo` beforeinput routes through
  `runBeforeInputHistoryCommand` → `undoManager` + anchored snapshot
  restore.

## Browser input / IME

Routing (`onBeforeInput` → `runBeforeInputCommand` /
`runBeforeInputDeleteCommand`) covers:

- insertion: `insertText`, `insertReplacementText`,
  `insertFromPaste`, `insertFromYank`, `insertTranspose`,
  `insertCompositionText`, `insertFromComposition`;
- structure: `insertLineBreak`, `insertParagraph`;
- deletion: `deleteContentBackward/Forward`, `deleteWordBackward/
Forward`, `deleteSoftLine*`, `deleteHardLine*`, `deleteByCut`,
  `deleteByDrag`, `deleteByComposition`, `deleteContent`,
  `deleteEntireSoftLine`;
- history: `historyUndo`, `historyRedo`.

Browser-owned fast paths (text-local insert/delete, `deleteComposition-
Text`, text-local `insertReplacementText`) intentionally fall through
and are reconciled by the DOM-mutation fallback — verified by the
autocorrect/reconciliation fixtures.

Composition (`edytor.svelte.ts` + `beforeInputCommands`):

- `compositionstart` captures the selection snapshot +
  `compositionStartReplacementState`;
- `insertCompositionText` keeps `compositionState`
  `{textId, startOffset, value, marks}` and replaces the whole
  intermediate span on every event — the model is the source of truth
  for the composed span, so DOM mutations stay suppressed while
  composing (`observeDomTextMutations` guard);
- `insertFromComposition` commits the final value and restores the caret
  through `stabilizeCompositionSelection` (rAF + 0/30ms restores absorb
  delayed browser caret jumps);
- browsers that send `insertText` as the final commit are handled by
  `commitCompositionFromInsertText`;
- non-cancelable composition input still flows through the model;
- a browser-owned backward delete during composition leaves the model
  span intact for the next composition write (fixture);
- `focusout` schedules the dangling-composition reset (50ms) —
  `resetDanglingComposition` clears `isComposing`/`compositionState`/
  restore timers, and `destroy` clears the timer (fixture).

## Verification snapshot (U09)

- New unit coverage: `src/tests/crdt/doc/anchors.test.ts` (19) +
  `src/tests/crdt/doc/selective-undo.test.ts` (7).
- New DOM coverage: collaboration anchors/payloads/lifecycle (+5),
  word/line/cut/drag/composition-delete + hard/soft-line + yank/
  transpose/replacement/deleteContent fixtures (+18), caret-anchor
  round-trip through inline atoms (+1).
- Final lane results: `pnpm test` **1207 passed** (50 files, 2 skipped
  files, 1 skipped, 11 todo); `pnpm test:dom` **135 passed**;
  `pnpm test:crdt` **1228 passed**; `pnpm test:crdt:extensive`
  **1234 passed** (incl. 331 vendored upstream engine tests);
  `pnpm test:typecheck` 0 errors; `pnpm test:dom:typecheck` 0 errors;
  `pnpm check` 0 errors; `pnpm lint` clean (prettier pass + two dead
  assignments removed + five scoped `no-this-alias` disables on the
  compat-adapter `self` captures, which are required because adapter
  getter shorthand rebinds `this`).
- Chromium Playwright (`tests/editor-dom`, first run of the suite):
  **355 passed / 4 failed / 1 skipped**. All four failures are
  deterministic and sit in code untouched by U09:
  - `block-handles.spec.ts` multi-block drag drops both selected
    blocks (placement/DnD — DnD is unfinished);
  - `collaboration.spec.ts` IndexedDB reload spec calls v13
    `doc.getText('note')` — test-side API drift; v14 exposes
    `doc.get(key, name)` returning a `YNode`;
  - `selection.spec.ts` typing into a code line truncates at the
    caret (code/prism DOM↔model mapping);
  - `composition.spec.ts` composed char dropped at a code-suggestion
    boundary.
    These reproduce on re-run and are deferred to U10 with the rest of
    the browser matrix.

## Deferred

- **U10** — real-browser convergence/IME proof plus the four
  deterministic chromium failures above (multi-block DnD, code-plugin
  input/composition mapping, persistence-spec v13 API drift); jsdom
  cannot exercise native editing, real IME sessions, or
  layout-dependent caret rects.
- **U12** — release handoff: presence UX polish, awareness throttling
  policy, and any migration notes for peers pinned to numeric-offset
  presence payloads.
