# Columns: a first-party multi-column layout (plan, v2)

Status: v2 after an adversarial review and the user's decisions (D3, D4 as
Notion; left and right drop bands; default plugin last) (3 blockers, 10 major, 8 minor
findings, all addressed below; §10 maps them). 2026-10-03. Target release:
`0.1.0-next.17`.

## 1. Goal

Notion's columns, first party, identical in a view, a headless document and
the Cloudflare room:

- a **layout** shows two or more **columns** side by side; a column holds any
  blocks (text, lists, code, images, toggles…);
- created by **dragging blocks to the left or right edge of another block**
  (the main gesture), or from the slash / `+` menu (`2 columns` … `5 columns`; `/col3`, `/columns3` as Notion);
- **resizable** by dragging the gap between two columns;
- an empty column never shows; a layout showing one column shows as that
  column's blocks;
- converges under concurrency, one undo step per gesture, copies and pastes,
  stacks on narrow screens.

Non-goals for this release: a keyboard resize, column colours, markdown export
(none exists for any kind), touch drag tuning beyond what the block handles
already do.

## 2. What exists today

**Document.** `columns`/`column` already work as two generic containers in
the CRDT tests (rescore5/6/7, p1-fuzz, `ROLES_BASE_SEED`): both
`rendersContent: false`, `defaultChild: { columns: 'column' }`. `fits`
(`edytor-doc.ts:1253-1258`) makes a layout hold columns _and containers of
columns_ (so a layout may sit directly in a layout) and a column hold
anything; `fitted` keeps a paragraph a paragraph in a layout; `emptying`
removes a container a write leaves childless (write time only: nothing hides
an empty container at read time); ZW-14 refuses an outdent or merge out of a
column; Tab after a layout nests into its last column; read-time promotion
(`displaySlotOf`, `promotedRank`) shows a peer's block added under a deleted
column in that column's slot, i.e. directly in the layout.

| #   | Gap                                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | No "≥ 2 columns" rule; a layout left with one column stays one                                                                                                                                                                                                                                           |
| G2  | Non-columns end up directly in a layout: deleting a column promotes its blocks there (pinned rescore5:819), a peer's add under a deleted column shows there, raw `insertBlocks`, AW-05 (a code line shed into a layout, rescore7:239-342), a table retyped to a layout keeps its rows (rescore7:508-548) |
| G3  | Deleting a layout promotes its columns, retyped to paragraphs holding children (`settledKind`); a peer's column under a deleted layout shows the same way (`typeOf`, `runs.ts:613-625`)                                                                                                                  |
| G4  | Merges cross columns (Delete at a column's end pulls the next column's first block; a range joins its ends across columns)                                                                                                                                                                               |
| G5  | No widths                                                                                                                                                                                                                                                                                                |
| G6  | No semantics row; `defaultSemantics` (the room's) lacks columns                                                                                                                                                                                                                                          |
| G7  | No invariant in the fuzz                                                                                                                                                                                                                                                                                 |
| G8  | Empty columns arise under concurrency and undo (two `placeBeside` on one target, moves racing, undo after a peer edit keeping a withdrawn layout — P12) and nothing hides them                                                                                                                           |

**View.** Cells and the observer assume no vertical layout (strict only on
the root and text runs; D-25). DnD assumes one vertical list (`rowAt` stops
at the first descendant below the pointer; vertical own rows; horizontal
indicator; ancestor levels to the left; `BlockMovePosition = before | after |
inside`; the hitbox has no "beside" operation). A handle and a drop target
are both gated on `block.movable` (`blockHandlesPlugin.ts:112-117`); a column
2 block's handle (+ and ⋮⋮, 24 + 18 + 4 px) fills a 46px gap. Native vertical
arrows move visually; `landed` corrects only a move onto _no_ caret stop.
HTML import flattens `div`s without a `parse` hook. One `empty` shape per
kind (catalogue ids `block.<type><n>`).

## 3. Product decisions (defaults; to confirm)

- **D1 — the layout is a role, not a name.** New `BlockRole` flag
  `layout: true` (data, like `void`/`island`/`lines`, in `crdt/semantics.ts`
  and spread into the plugin's kind). A layout's default child is its
  **column** kind (a container rendering no content). No core code names
  `columns`/`column`.
- **D2 — no columns inside a column, by gesture.** Drops, moves, paste
  placement and the slash commands refuse to put a layout (or a subtree
  holding one) inside a column. If one appears anyway (a race, an explicit
  retype — rescore7:297-304 pins one), it renders normally. No flatten rule.
- **D3 — (decided: as Notion) no handles on layouts and columns; a block
  selection covering a whole layout stands for it.** When a block selection holds every shown
  block of every column of a layout, the one resolver (`dragBlocks` /
  `movable` / `outermost`) lifts it to the layout: drag, Alt+arrows,
  Mod+Shift+arrows, Duplicate, Delete, Copy then act on the layout. Blocks in
  columns show the `+` and the ⋮⋮ grip, as Notion (revisited after the
  2026-10-04 review; first shipped grip-only): the `+`'s Alt+click adds a
  column right of the block's column (`addBlock` → `moveBlocks` `right`).
  The gap budget: a block's handle shows (and takes the pointer) only for
  the hovered row; the resize strip covers the rest of the gap, under the
  handles, with a gray hover guide. A layout handle stays the fallback.
- **D4 — (decided: as Notion) merges cross columns in reading order.**
  Backspace at the start of a column's first block merges it into the last
  line of the previous column (its text joins that line; an empty block is
  removed, the caret at that line's end); at the start of column 1's first
  block it merges into the line before the layout. Forward Delete
  (the user's "Shift+Backspace"; Fn+Backspace on a Mac) at the end of a
  column's last line merges the next column's first block into it (today's
  `mergeForward` already does). Backspace at the start of the block after a
  layout joins the last column's last line. A text range across columns
  joins its two ends (today's range delete). A column emptied by a merge goes
  and the layout dissolves when one column is left (§4.3–4.4).
- **D5 — widths are weights.** `column.data.width`, a positive number,
  default `1`; the column renders `flex: <w> 1 0`. Resize writes only the two
  neighbours, by id, keeping their sum (one command, one undo step). Adding
  a column writes nothing (it gets weight 1). Concurrent resizes merge leaf
  by leaf and always fill the row.
- **D6 — stacking.** Below a layout width of 480px (container query) columns
  stack; beside zones and resize are off there.
- **D7 — navigation stays native.** Vertical arrows move visually (the
  browser's), Left/Right/word keys follow document order (end of column 1 →
  start of column 2), Shift+arrow extension and block-selection arrows follow
  document order. Documented, pinned per engine; no remapping.
- **D8 — default plugin, last.** `<Edytor>` adds the columns plugin and
  `defaultSemantics` gains the rows only at the end (C6), after DnD is green.
  The beside zones exist only when the document has a `layout` kind. Older
  clients (next.16) without the role render a layout as unknown kinds
  (stacked): documented in the migration notes.

## 4. Document layer (owner: `crdt/`)

All rules are rows in `docs/editor-delete-contract.md`, new section
`layout.*`, tested first in `src/tests/crdt/arch-v2/layout.test.ts`.
**Read-time rules own the display; write-time ops write exactly what the
display shows** (same `promotedRank`), so a replica that missed a write and
one that applied it show the same thing.

1. **Semantics**: `layoutKinds = { columns: { layout: true, rendersContent:
false, defaultChild: 'column' }, column: { rendersContent: false } }`;
   `layoutSemantics`; joins `defaultSemantics` in C6. `BlockRole.layout`
   added to the role table (`edytor-doc.ts:867-879`): `layout(type)`,
   `layoutItem(type)` = the default child of a layout kind.
2. **`fits` fix**: the "containers of its items" clause applies only when the
   item renders content (lists keep nested lists; a layout no longer fits
   directly in a layout).
3. **Read-time display** (index, chain walks, in `displaySlotOf` / the
   display ownership like `DisplayOwnership.childless`):
   - `layout.only-items`: a layout displays only its items; any other child
     displays in the layout's parent, right after the layout
     (`promotedRank`).
   - `layout.empty-item`: an item that displays no child does not display.
   - `layout.single`: a layout displaying ≤ 1 item does not display; that
     item's children display in the layout's slot (ranked from the layout's
     rank, then theirs).
   - `layout.bare-item`: an item displayed outside a layout does not display;
     its children take its slot.
   - Kinds at the new slot settle as read-time promotion already does
     (`typeOf`), so a paragraph shed into a list shows as its item.
4. **Write-time mirrors** (in the plan that causes them, one undo step): a
   write that would leave one of the states above writes the result the
   display rule would show — `emptying` already removes an emptied item; a
   new `dissolving` next to it replaces a layout left with ≤ 1 item by that
   item's blocks; deleting an item promotes its blocks after the layout
   (`layout.only-items`); deleting a layout deletes it and its items, its
   blocks promoted to its slot (`deleteBlocks([layout, ...items])`, no
   retype). The pinned rows of G2/G3 change accordingly (C0 lists them).
5. **Merges across items** (D4): `mergeBackward` of a layout item's first
   block merges into the previous _shown line_ in reading order (the
   previous item's last line, or the line before the layout for the first
   item) instead of being refused (ZW-14's merge refusals change; its outdent
   refusal stays); `mergeForward` already descends into the next item. The
   emptied item goes (`emptying`) and `dissolving` follows, in the same plan.
   Contract rows 549-553 ("Backspace at its first paragraph does nothing")
   rewritten.
6. **`prepare.placeBeside(ids, target, side, kind?)`** (two-phase): the
   target resolves to its outermost block below the root or below a column
   (a list item → its list, a code line → its code block); if that block is a
   direct child of a layout item, a new item holding `ids` goes beside that
   item; else the target and a new item holding `ids` are wrapped in a new
   layout of the document's layout kind (`kind`, or the only kind whose role
   says `layout`; none → refused). Refused when `ids` holds the target or an
   ancestor, when a moved block would put a layout inside an item (D2), or
   when a block does not fit an item. Sources are cleaned in the same plan
   (`emptying`, `dissolving`). Plain ranks (a move: not source-ranked,
   `order-scope.test.ts`).
7. **Fuzz**: `layout-shape` invariant in `well-formed.ts` over what is
   _displayed_ (a displayed layout holds ≥ 2 displayed items and nothing
   else; no displayed empty item; no displayed item outside a layout);
   `doc-ops.ts` gains `placeBeside`; concurrent campaigns for: two
   `placeBeside` on one target, move ‖ dissolve, delete item ‖ add into it,
   delete layout ‖ add item, undo after a peer edit (P12 withdraw).

## 5. View layer

**Plugin** `src/lib/plugins/columns/ColumnsPlugin.svelte` + `columns.css`
(shipped with the plugin): `columnsPlugin`, `createColumnsPlugin({ minWidth?
})`, `isColumnsPlugin`.

- **Kinds**: `columns` (`...layoutKinds.columns`, element `div
data-edytor-columns`, snippet renders its children in the one
  `div[data-edytor-children]`, made a flex row with the indent zeroed) and
  `column` (element from data: `style: flex: <w> 1 0`, children in its own
  marker, indent zeroed). `columns.css`: gap `var(--edytor-columns-gap,
46px)`, `min-width: 0`, margins reset at column edges, `container-type:
inline-size`, `@container (max-width: 480px)` stacking.
- **Commands** `columns.2` … `columns.5` ("2 columns" …, group "Layout",
  keywords `columns`, `layout`, `side by side`): a layout of N columns each
  holding an empty paragraph, caret in column 1, through `placing` (replaces
  an empty slash line, else inserts after); refused inside a column (D2).
- **Clipboard**: `html` → `<div data-edytor-columns><div data-edytor-column
data-width="…">…`; `parse` claims those attributes; `plain` writes the
  blocks in order. The internal fragment round-trips.
- **Handles** (D3): the block-handles plugin keeps every drop target (gated
  on `movable` as today) but mounts no handle for a layout or a layout item
  (from the roles: `facade.isLayout`, `isLayoutItem`), and only the grip for a
  block whose parent is a layout item. The selection lift is in the one
  resolver (`dragBlocks` / `outermost` in `replaceSelection.ts`).
- **DnD** (`BlockHandleController`, `moves.ts`):
  - `BlockMovePosition` gains `left` / `right`; `moves.ts` `destination`
    routes them to `prepare.placeBeside` — every caller keeps `moveBlocks` /
    `canMoveBlocks`, `revealing`, `selectMoved`, `history.began`,
    `dispatcher.last` (AGENTS: one move path).
  - `rowAt` skips (`continue`) descendants whose horizontal extent does not
    contain the pointer.
  - Beside bands, only while the pointer is within the row's height, the
    document has a layout kind and the layout is not stacked: **right** = the
    last 15% of the row (min 32px); **left** = within the row's sticky slop
    left of its text column (≤ 20px outside the block) inside the editor (a
    column's gap), and the page margin beyond the handle column (round-2
    review R2: the handle column — the drag's handle width left of the
    blocks — reorders, row after row), only when the row's
    parent is the root or a column (nested rows keep reparent-by-x). Checked
    before the hitbox; `canDrop` counts a beside placement so a row with both
    halves blocked still accepts it; refused bands show nothing.
  - Over a layout's gap (between two columns): `right` of the left column's
    level = a new column between.
  - Indicator: a vertical 4px bar at the row's edge (or the layout's height
    for a new column in a layout); sticky never crosses a column boundary.
  - Drag preview clones at the source's width.
- **Resize**: the overlay mounts a strip over each gap while the pointer is
  over the layout, under the handles (a column-2 block's handle box keeps
  its row's part of the gap, round 3); a drag resizes both columns live
  through a view-only preview the column kind's `element(data, id)` reads
  (round 3: no write, no peer frame), a guide in the gap; release writes the
  two neighbours' weights in one `edytor.transact` (two `setData` commands →
  one step) and drops the preview; Escape drops it alone. Min width in the
  view only (`minWidth`, default 10%). Readonly / stacked: none.
- **Keys**: Backspace/Delete at column edges (D4) are the document's merges
  (no view rule); `beforeInputDeleteCommands.ts` only keeps the caret rule of
  the merge's result. Mod+Shift+↑ at a
  column's first block / ↓ at its last moves the block out before / after the
  layout (a way out by keyboard; dissolve applies). Enter, Tab, Shift+Tab
  inside a column unchanged (ZW-14).

## 6. Tests (written first, each phase)

- **C0** lists and decides every pinned row the change touches: rescore5
  DR-crdt-1 (~747-839, incl. the one-column seed ~795 and delete column ‖ add
  at 819), rescore6 ZW-14 (214-258: its `mergeBackward` refusals become
  merges into the previous item, D4), ZW-06 (417-441), rescore7 AW-05 (239-342), a layout in a column
  (297-304), DR-crdt-2 table → layout (508-548), p1-fuzz CONTAINERS and
  `ROLES_BASE_SEED`, contract lines 549-560 and 740.
- **CRDT** `layout.test.ts`: every `layout.*` row, sequential and concurrent,
  undo of each op, convergence (display equality across replicas).
- **DOM** `columns-*.test.tsx`: rendering, widths, one children marker per
  kind (`children-container-20260930` stays green), commands (caret, one
  step), handles (none on layout/column, grip only inside), D3 lift, D4 keys,
  Mod+Shift+arrows out, clipboard, truth check.
- **Browser** `columns.spec.ts` (3 engines + mobile): beside left/right (new
  layout, new column, drag out → dissolve, beside a list item → beside the
  list), indicator geometry, resize (one write, undo), stacking at 400px,
  grip clickable in the gap, native arrows pinned per engine, two-page
  collaboration (peer sees it; concurrent resize converges).
- Existing DnD rows (block-handles.spec, dnd-nest-backdrop,
  multi-block-drag, nest-indent, children-container, drag-preview,
  handle-alignment) stay green unchanged.
- DST actions for columns: deferred (follow-up).

## 7. Docs (same change)

New `plugins/columns.mdx`; `plugins/index.mdx`, `concepts/blocks.mdx`
(kinds, containers, layouts), `customization/blocks.mdx` (`layout` role),
`customization/hotkeys.mdx` (role table: column edges), `concurrent-editing`
and `document-api` (`placeBeside`, `layout.*`), `limitations`, `migration`
(new `layout` role key — docs-drift checks new `BlockDefinition` keys —,
`left`/`right` move positions, version skew), README, AGENTS.md (owner table:
layout display; Surface: beside zones; Plugins: default plugins). Demo route
and the landing's live editor get a two-column example.

## 8. Phases

| Phase   | Content                                                                                                   | Gate                                           |
| ------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| C0      | contract rows, pinned-row decisions, failing tests                                                        | red for the right reason                       |
| C1      | role, `fits` fix, read-time display, write mirrors, merge seal, `placeBeside`, fuzz invariant + campaigns | `test:crdt`, unit, `check:worker`, fuzz        |
| C2      | plugin, CSS, commands, clipboard, handles rule, D3 lift, D4 keys                                          | `test:dom`, check, lint                        |
| C3      | DnD beside, `rowAt`, indicator, `moves.ts` positions                                                      | 3 engines + mobile; existing DnD rows          |
| C4      | resize                                                                                                    | browser + DOM                                  |
| C5      | docs, demo, live editor; default plugin + `defaultSemantics`                                              | `check:docs`, docs-drift, packed consumer, DST |
| Release | `next.17`: push master (Workers Builds deploys docs), tag (CI publishes)                                  | full AGENTS gate list                          |

## 9. Risks

- Read-time rules in the index (C1) are the heart: display equality across
  replicas and the fuzz must prove them before any view work.
- `canMerge` and `fits` changes reach every merge/flow path: rerun the
  delete-contract suites.
- Beside bands vs existing zones: tuned against the existing rows; the right
  band is the safe one, the left band may be cut if it fights reparent-by-x.
- Estimate: +700 xloc (index rules, op, plugin, DnD, resize).

## 10. Review findings → plan changes

B1 stray rank → §4.3 `only-items` after the layout, `promotedRank`; B2 empty
/ single states → §4.3 read-time rules, display-based invariant; B3 whole
layout → D3 selection lift (decided: as Notion). M1 merge rule → D4 decided
by the user: merges cross columns in reading order, as Notion (no seal); M2 nesting → `fits` fix + D2 as gesture refusal, no flatten;
M3 second move path → positions in `moves.ts`; M4 layout delete → write and
read mirrors; M5 navigation → D7 native, C5 dropped; M6 bands → §5 geometry,
`canDrop`, `continue`, handles vs drop targets split, gap budget; M7 beside a
list item → outermost target; M8 widths → D5 weights, no facade op; M9 pinned
rows → C0 list; M10 default plugin → D8 last and gated, version skew noted.
Minor: children marker kept; handle rule by roles; command ids `columns.N`;
keyboard way out (Mod+Shift+arrows); bare item rule; stacked disables
bands/resize; touch out of scope; Tab after a layout stays pinned.
