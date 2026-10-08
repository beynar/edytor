# CRDT v14 — selection, presence, history, browser input (U09)

Companion to `crdt-v14-implementation-plan.md` and the execution ledger.
This document records the U09 contract: how selection endpoints are
anchored to backing-text atoms, how remote carets ride awareness, how
local undo stays selective under concurrent remote edits, and what the
browser-input/composition lanes cover. Sections marked **arch-v2**
describe the mechanisms that replaced U09's (see
`docs/archive/architecture-v2/execution-ledger.md`).

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

`T.anchorAt` (`src/lib/crdt/text/model.ts`) mints the engine relative
position; slice records and their index sentinels are gone (arch-v2 D12).

### `facade.anchorAt` / `facade.resolveAnchor` (arch-v2 D12: streams)

Text ownership is streams in backing texts, delimited by boundary items
(`docs/crdt-v14-text-ownership-adr.md`, plan §2.1):

- `anchorAt(blockId, displayOffset, affinity)` locates the offset in the
  block's display pieces (its stream, then each claimed stream) and binds
  an engine relative position in that backing text; `b` is the text's
  home block. A merged-away or hidden block's own pieces still bind, so a
  write aimed at a text that died to a merge follows its items. A
  streamless block binds `{b: block, a: {i: null}}`, the start of the own
  text its first typing creates. A left-affine caret at a split-born
  block's start binds that block's boundary item.
- `resolveAnchor(anchor)` resolves the engine position, finds the stream
  holding it (the one whose delimiting boundary precedes it) and that
  stream's display owner → `{blockId, offset}`. `null` when the item is
  not integrated yet, or the stream's block is deleted or hidden: the
  caller takes the seam (`crdt/anchors.ts`, `sel.seam.*` in
  `docs/editor-delete-contract.md`). There is no owner facet (`o`), no
  `a: -2` form and no emission-seam scan.
- `followUndo(anchor)` rebinds an anchor through this replica's `redone`
  chain (history restores a value recorded before a delete).

## Selection integration (arch-v2 V1–V5)

The selection is a value (`src/lib/session/selection.ts`): `none`, a text
range of two `DocAnchor`s (`anchor`, `focus`, optional `pending` marks),
one atom, or a set of block ids. `EdytorSelection.select(value, cause)` is
its only writer; `project(value, doc)` (memoized per value and index
version) gives every derived field, and `selection.state` is a read-only
compatibility getter over it. The DOM selection is written only by the
projector (`surface/projector.svelte.ts`) after a flush. A range start
binds right, an end or caret binds left. A value that no longer projects
is repaired at the seam; one dead endpoint collapses the range to the
survivor.

### Undo selections (arch-v2 S7)

Each stack item's `meta` carries per-view `{before, after}` selection
values; the issuing view selects `before` on undo and `after` on redo
(anchors rebound through `followUndo`). `UndoSelectionSnapshot` and the
id/path/numeric fallbacks are gone.

## Presence contract

One encoding per view key (T6; plan L10, R1, D-16). The awareness local
state carries `selections: Record<viewKey, entry>`, where an entry is
`serialize(value)` plus a client-local publish sequence `t`:

- text: `{start, end, collapsed, reversed, t}` — `start`/`end` are
  `DocAnchor`s in document order (a range start binds right, an end or a
  caret binds left);
- block set: `{blocks, t}`; inline atom: `{atom, block, t}` (published,
  not drawn as remote carets).

Each view mints its key (`Edytor.presenceKey`) and is the only writer of
that entry: `select()` publishes when the value changed (an unchanged
payload is not rebroadcast and keeps its `t`), and `Edytor.destroy()`
clears it. Nobody removes another view's key; a DOM remount of a live view
leaves its entry alone. Peers render one caret per client — the freshest
valid text entry (`freshestPublishedSelection`), resolved by
`resolvePeerSelection` (`isTextAnchor` validates the wire shape, so
foreign payloads such as v13 `RelativePosition` objects are ignored); an
anchor that does not resolve paints nothing.

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
- Every history channel (Mod+Z, `historyUndo`/`historyRedo`
  `beforeinput`, `edytor.historyUndo()`) calls `session/history.ts`.

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

Each occurrence becomes one input attempt (`session/attempt.ts`, arch-v2
I1): intent, anchored target and owner are fixed at admission. A
browser-owned change is adopted by the observer through the dispatcher
(`surface/observer.svelte.ts`, I2/R7); a model-owned attempt owns the DOM
drift around it until its deadline.

Composition is one session (`session/composition.svelte.ts`, arch-v2
I3/I4): the start target is replaced by an ordinary command at the first
write, previews are tracked writes inside one capture group, and the
session ends exactly once (`commit`, `cancel`, `abandon`, or D-20 when a
commit re-places the host's block). No timer ends a session; while it is
live the host segment list is frozen (`surface/pin.svelte.ts`) and no DOM
selection is written. `compositionState`, the 750 ms idle cancel, the
dangling-blur reset and the post-commit restore timers are gone.

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
