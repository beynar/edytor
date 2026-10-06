# Editor deletion and recovery contracts

Contract IDs consumed by headless command tests, DST oracles, and browser
fixtures. Each entry was read from production behavior and pinned by a test;
it is a **statement of what the editor does**, reviewed for coherence —
not output copied into an expectation. The two original UNRESOLVED pins
(head-survival asymmetry, nested-subtree caret fallback) were confirmed
defects by adversarial review and are now fixed and specified.

Text offsets are UTF-16 code units (`yStart`/`yEnd`). "Head" = the block
containing the selection start; "tail" = the block containing the selection
end; "interior" = blocks strictly between them.

## Range deletion (selected range + Backspace/Delete/Cut)

### `del.range.flat` — flat siblings, both partial

Fixture: `<paragraph>alpha</paragraph><paragraph>beta</paragraph>`,
select `alpha@2 → beta@2`, `deleteContentBackward`.

Result: `[paragraph "alta"]`.

Rule (verified across the endpoint matrix in
`command-programs.test.tsx`): head keeps text `[0, yStart)`, tail keeps
text `[yEnd, len)`, interior blocks die — then:

- **tail cut (`yEnd > 0`, or the seam covered):** tail suffix merges **into the head block**
  (head type/id wins). Head dies iff its prefix is empty (unless nothing
  else would be left to hold the caret, `del.range.whole-doc`); tail dies
  iff its suffix is empty. `[a@1→b@1] → "ab"`, `[a@1→c@1] nonadjacent → "ac"`,
  `[a@0→b@1] → "eta"` (head dies), `[a@1→b@2] → "a","cc"` (tail dies).
- **`yEnd == 0` (range ends on the tail's start boundary):** the
  selection presents such a range, when the block before the tail shows
  text, as ending at that block's end (its canonical form), so
  `[a@2→c@0]` deletes as `[a@2→b@2]` → `"aa","cc"` (only the interior
  block dies) and `[a@0→b@0]` as the whole-text `[a@0→a@2]` →
  `"","bb","cc"` (head survives empty). A range that still ends on the
  tail's start when it reaches the delete (a model range such as
  Shift+ArrowRight's `note@4 → tail@0`, or one whose preceding block is a
  container) is not special: it covers the seam, the tail's whole text is
  its suffix, and the rules above apply — `["note","tail"]` →
  `"notetail"` (`navigation-selection-sync.spec` seam delete), and with an
  empty head prefix the tail survives whole with its id
  (`del.range.nested-tail`'s `alpha@0 → beta@0` pin). _(arch-v2 D6 fix:
  the document op does not canonicalize; the first D6 reading, "tail
  untouched", broke the seam delete.)_
- **Merge capability:** the tail's suffix merges into the head only when
  the document's `canMerge(tail, head)` allows it (`del.range.island-seal`).

### `del.range.whole-text` — one block's entire text selected

`b@0 → b@2` (forward or backward) → the block **survives empty**:
`["aa","","cc"]`. Deleting text never implicitly deletes the block shell.

### `del.range.flat.head-empty` — head fully inside range

`alpha@0 → beta@1` → `[paragraph "eta"]`.

Rule: when the head's surviving prefix is empty the head **block dies**
and the tail block survives with its suffix (tail id/type preserved).
The caret lands at the seam — see `sel.seam.next-sibling`.

### `del.range.flat.tail-empty` — tail fully inside range

`alpha@2 → beta@4` → `[paragraph "al"]` (tail dies entirely; head keeps
only its prefix).

### `del.range.whole-doc` — everything selected

`a@0 → c@2` over three flat blocks → `[a ""]`: when the range would leave
no block that can hold the caret (every block it covers dies and nothing
outside it shows text), the **head is kept**, emptied — its id, type and
data (a heading stays a heading, a list item stays in its list), its atoms
and marks deleted with its text, its children dying with the range as
covered blocks do — a closed toggle head's hidden body too:
`[T(closed) "title" > [B "body"], P "after"]`, `T@0 → P@5` deleted →
`[T ""]` (`del.range.hidden-body`). It is `del.range.replace`'s rule applied to this one
case; no block is written. Backspace, Delete and cut agree, in either
selection direction; the caret lands at `head@0`; one undo step restores
everything.

Concurrency (the user's contract: never let peers create duplicates just
by performing the same action): two peers deleting the whole document keep
the same block, so they converge to one empty block. A peer's concurrent
typing in the head survives in it (it was not in the range the other peer
deleted); typing in any other block dies with that block
(`conc.delete-wins-block`); a concurrent delete of every block (a block
selection) empties the document (`doc.empty.virtual`). Each writer's delete
holds on its own: the first undo leaves the other writer's delete in
effect, the second brings the document back. _(Before 2026-09-28 the op
wrote a fresh paragraph, so two peers kept two.)_ Pins:
`contracts-whole-delete.test.ts` (facade, three client-id assignments),
`contracts-whole-delete.test.tsx` (command dispatch, two mounted peers),
`contracts-whole-delete.spec.ts` (three engines, two contexts over the
websocket relay), `d6-range-delete.test.ts`.

### `del.range.nested-tail` — head flat, tail nested

Fixture: `paragraph "alpha"`, `ordered-list > list-item "beta"`,
`paragraph "omega"`. Select `alpha@0 → beta@2`.

Result: `[ordered-list > list-item "ta", paragraph "omega"]`.

- The head `alpha` **dies** — `alpha@0` puts its entire text inside the
  selected range, and `del.range.flat.head-empty` applies uniformly:
  nesting of the tail does not change the head's fate.
- The nested tail keeps its suffix `ta`, keeps `list-item` type and id,
  and stays in its list: a container that renders no content (a list) is
  not an ancestor the range dies through — it dies only when the range
  empties it (`del.range.empty-container`), like the keys
  (`del.merge.container`). _(Changed 2026-09-30, DR-crdt-4: the list used
  to die and its items were promoted to the root as bare items.)_ An
  ancestor that renders content (an item over a nested list) still dies
  through the range and its later blocks are rescued
  (`del.range.outside-survives`).

Former UNRESOLVED-1 — the asymmetry was a defect: the ancestor-rescue
branch returned after removing only the container, leaving the doomed
head's selected text behind. All doomed blocks outside the rescued
subtree are now removed in that branch.

### `del.range.outside-survives` — what follows the range end is kept

Blocks after the range end are outside the range and never die with it:
the tail's children, and the later siblings of the tail (and of each of
its ancestors) inside a container the range dies through. They take that
container's slot, in document order (the rescue of `del.range.nested-tail`
applies whether the head survives or not), ranked right after it. When the
tail merges into the head, its children take the tail's vacated slot exactly
as `mergeBackward` places them — right after the vacated block, so a
concurrent delete of the head that revives the tail shows it above them
(review 2026-09-29, UW-20) — and an island tail's children take that slot's
default child type. A block rescued into a new slot takes the kind the
container rule gives it there (`del.merge.container`: a list's item leaves
its kind, a paragraph rescued into a list becomes its item): `[alpha,
x "xx" > [ordered-list > [i, j]], omega]`, `alpha@1 → i@1` → `["ai",
paragraph "jj", "omega"]`. A list the range only starts before keeps its
later items: `[alpha, ordered-list > [beta, gamma], omega]`, `alpha@2 →
beta@2` → `[paragraph "alta", ordered-list > [list-item "gamma"], paragraph
"omega"]` (DR-crdt-4); `[aa, bb > [cc]]`, `aa@1 → bb@2` → `["a", "cc"]`. A
rescue never carries a block across an island boundary: when it would, the
containers the range ends inside stay (with their surviving content).

### `del.range.island-seal` — the merge is the document's (F-D1)

`root > [box(island) > [A "aa"], Y "yy"]`, `A@1 → Y@1` →
`[box > [A "a"], Y "y"]`: `canMerge(Y, A)` refuses (the island seal), so
the head keeps its prefix, the tail keeps its suffix and nothing merges —
the same answer `mergeForward(A)` gives. One level deeper
(`root > [X > [box > [A "aa"]], Y "yy"]`) is identical.

### `del.range.empty-container` — no empty container is left (F-D12)

A block that renders no content of its own (a list container) and whose
every child dies with the range dies too, and so on upward (never the
root). `[ordered-list > [i1 "one", i2 "two"], P "three"]`, `i1@0 → P@2` →
`[P "ree"]`, caret `P@0`.

### `del.range.island-kept` — a range inside one `lines` island never removes it (YW-03)

When every block the range covers lies inside one island declared `lines`
(a code block) and the island would die as an emptied container, the head
is kept instead, emptied, like a replacement. `[P "a", code > [L1 "x", L2
"y"], P "z"]`, `L1@0 → L2@1` → `[P "a", code > [L1 ""], P "z"]`, caret
`L1@0` (a code block's Mod+A, then Backspace, Delete or cut). Any other
island (a table of rows and cells) keeps `del.range.empty-container`: a
range over all its text removes it, never shrinking it to one emptied
cell (DR-behavior-2).

### `del.range.hidden-body` — what the view hides is not in the range (XW-01)

A closed toggle is one unit: a block the view hides (a closed toggle's
body, a `hidden` subtree) is not part of a text range even when document
order puts it between the endpoints. It goes only with a block that goes.
`[T(closed) "title" > [B "body"], P "after"]`, `T@2 → P@3` →
`[T "tier" > [B "body"]]`, caret `T@2`; cut (a delete) and replaced
(typing, paste, Enter) the same. `T@0 → P@3` deleted (Backspace, Delete,
cut) → `[P "er"]`: the head dies, and the body with it — also when the head is kept only to hold the caret
(`del.range.whole-doc`: `T@0 → P@5` → `[T ""]`). A toggle wholly inside the
range dies with its body. A dying closed tail's body takes its place, shown
(`del.range.outside-survives`), and the caret may land in it:
`[A "a", T(closed) > [B], P]`, `A@0 → T@5` → `[B, P]`, caret `B@0`. The view
passes its hidden blocks (`prepare.deleteRange(from, to, { hidden })`, and
`hidden(id, removed)` answers whether a block stays hidden once `removed` go);
without them (headless) document order decides. Backspace/Delete next to a
closed toggle is this rule's seam `T@end → P@0`, replaced: one plan
(XW-09). A range covers a hidden block exactly when its delete removes it
(`rangeCovers`, `src/lib/selection/visibility.ts`): copy puts it in the fragment
and marks reach it then, never otherwise, so copy then Backspace, and cut,
neither lose nor duplicate a body (DR-delete-1/3). A replacement keeps the
head's body (`replace`), and a multi-line paste that splits the head leaves
it there (`flow.split`, DR-delete-2): `T@2 → P@3` pasted `A\nB` →
`[T "tiA" > [B], T "Ber"]`.

### `del.range.replace` — the deletion half of a replacement

Typing, pasting or composing over a range deletes it with the **head
kept**: the head block survives even when its prefix is empty (the
replacement lands at `yStart` inside it), and the tail's suffix merges
into it under the same `canMerge` rule. `alpha@0 → beta@2` replaced →
`[paragraph(alpha) "ta"]`, insertion point `alpha@0`. Every other rule of
this section is unchanged. (Whole-document replacement keeps the head, as a
whole-document delete does, `del.range.whole-doc`.)

### `del.range.caret` — where the caret lands

The head survives → `head@yStart`; else the tail survives → `tail@0`
(`sel.seam.next-sibling`: the block that slid into the head's place);
else the nearest surviving block before the tail that renders content
(an island a sealed rescue kept inside the range counts), at its end; else the nearest one after it, at its start; when there is none the head
is kept (`del.range.whole-doc`) and the caret is `head@yStart`.

### `del.range.nested-subtree` — range covers a whole subtree

`alpha@0 → beta@4` (whole nested item) → `[paragraph "omega"]` — the
container and all its children die with the range (a text range selects
every block it covers; a block selection selects only its members,
`del.blocks.promote`).

### `del.range.text-only` — within one text

`alpha@1 → alpha@3` → `"aha"`. Interior structure untouched.

## Flow placement (paste, drop, fragment insertion)

Written at arch-v2 D7 (plan §4.1 `doc/flow`, decision D-4). One prepared
document op, `prepare.insertFlow(target, flow)`, places every inbound
fragment; paste, drop and programmatic fragment insertion all call it.
Over a text range the range is deleted first by `replaceRange`
(`del.range.replace`) and the flow is placed at the caret that op reports.

### `flow.shape` — what a flow is

An admitted flow is an ordered list of **lines**, every id fresh (minted
once, at ingress): a line with a kind is a block (`type`, `data`,
`content`, `children`); a line without one is an **inline run** (content
only). Sources: plain text → one run per line (`\n`, `\r\n`); a URI →
one run carrying the link mark; an internal same-block copy → one run; an
internal cross-block copy → kinded lines; external HTML (parsed by the
browser, P4.1) → a kinded line per element a kind record claims (its tag
per preset, or its `parse` hook), an inline run per unclaimed block element
or text between blocks; an internal copy of a **block selection** → kinded
lines marked `whole` (`flow.whole`). A flow with no lines (an empty payload;
HTML that carries no text, atom, child or void kind — only a comment, a
`<script>`, empty elements) changes nothing and adds no undo step (F-P10);
such HTML falls through to the clipboard's `text/plain` when it has one. A
taken id refuses the op before any write.

### `flow.inline` — one line joins the text

At a position `(B, o)`, a single line's content is inserted at `o`. `B`
keeps its kind, unless `B` shows no text: then it takes a kinded line's
kind and data (`<blockquote>` pasted into an empty paragraph gives a quote;
an empty `h2` given a paragraph line becomes a paragraph without the stale
`level`), except a header whose body shows (`flow.header`) or a closed
toggle, which keeps its kind and data. The line's children become `B`'s first children,
except under a closed toggle, which shows none: they go after it (`flow.header`). Caret: after
the inserted content (after its last nested line when those go after `B`). A line that stands apart (`flow.apart`) never joins.

### `flow.split` — several lines split the block (D-4)

`B` splits at `o`. The first line's content joins the head (`B`, text
`[0, o)`), the last line's content joins the tail (text `[o, len)`, with
`B`'s children, which come after the caret — but not those the view hides:
a closed toggle's body stays with the head, as Enter keeps it,
`del.range.hidden-body`), and the lines between are
placed as blocks between the two, in order. The tail is the last line's
block: its id, and its kind and data when it is kinded (a run keeps `B`'s,
as a split does). The head keeps `B`'s kind unless `B` showed no text
(then the first line's, as in `flow.inline`). A run placed as a block takes
the default child of its parent. A joined line's children become the first
children of the block it joins, except a closed toggle's (`flow.header`). `Hello|World` + `X`, `Y` →
`["HelloX", "YWorld"]` on the internal, HTML, plain and drop paths (F-P5).
Caret: in the tail, after the last line's content.

### `flow.apart` — a line that joins no text is placed as a block

A line whose kind joins no text — it renders no content of its own (a
list, a code block), or is a void (a divider, an image) or an island — is
never joined into `B`: its text would be stored and synced but not shown
(GX-01). As the first (or only) line it is placed after the head; as the
last it is placed before the tail, and the text after `o` stays in a shown
line: a new block of `B`'s kind and data holding `[o, len)` and `B`'s shown
children, as Enter splits a line that is no container's header (at the end
of a header whose body shows, `flow.header` applies; or, when that line
would hold nothing and exists only for the caret, a fresh line of the
parent's default kind). Nothing is
left behind as an empty line: at `o = 0` the lines go before `B`, which
keeps its text (and takes a joining last line's content first), and an
empty `B` is replaced by them when they end in a shown line; at the end of `B`, with no
children to carry, no tail is made when the caret has a pasted line to land
in. `hello| world` + `<p>x</p><hr>` → `["hellox", divider, " world"]`; a
copy of `hello…two` from `[p hello, ul > [one, two]]` pasted at `keep| this
tail` → `["keephello", ul > [one, two], " this tail"]`. Caret: after the
pasted content — the end of the last placed block's last shown line (a
list's last item, a code block's last line), or, when it shows no line or
is a void (a divider, an image: its caption is not a line the caret enters
from a paste), the start of the line after it. A divider or an image never
replaces an empty `B`: the empty line is kept for that caret. Pins:
`paste-shown-20260930.test.tsx` (every shape on the internal and HTML
paths, and the no-hidden-content assertion of `fixtures/dom/invariants.ts`).

### `flow.header` — at the end of a container's header, the body stays

At the end of a container's header whose body shows (an open toggle, a
callout or quote with nested lines: the view's `header`, where Enter opens
a first child), `B` keeps its kind, its data and its children, unless it
is empty (no text, no children: an open toggle with no body yet) and the
first line stands apart: then it is replaced or kept as `flow.apart` says.
A header with no text takes a joining first line's text only, never its
kind, so the body stays under the container (DR-rest-1, SW18): an empty
open toggle given `<h2>H</h2><p>x</p>` → `toggle "H" > ["x"]`; `callout "" >
[body]` + `<h2>H</h2><hr>` → `callout "H" > [divider, "", body]`. What `flow.split` and `flow.apart`
would place after `B` leads them instead, as `B`'s first children, in
order (a joining first line's children, the placed lines, then the tail:
the joining last line, or a fresh line of `B`'s default child when the
caret needs one or the last line is a run). The body stays under `B`, as
after Enter. `callout "hello" > [body]` + a divider at its end →
`callout "hello" > [divider, "", body]`. Mid-header, `flow.split` applies
(the text after the caret takes the body). A closed `<details>` (a closed
toggle: the view's `header` answers `'closed'`, whatever its kind) shows no
children: its body is hidden and stays, and the paste goes after it; a line
it joins leaves its nested lines after it too, as lines of the flow, so no
pasted line lands in the hidden body (DR-crdt-1): an empty closed toggle +
a list item `a` with a sub-item `b` → `toggle "a"`, `"b"` after it, caret
after `b`. An empty closed toggle keeps its kind as above, so a pasted
heading never shows its hidden body under a heading (SW18, DR-crdt-2). Headless (no
`header`), the body moves to the tail as `flow.split` says. The new first
children take plain ranks, as Enter's (a residual,
[`order-scope`](../src/tests/crdt/arch-v2/order-scope.test.ts)). HX-10.
Pins: `d7-flow.test.ts` (`flow.header`), `paste-header-20260930.test.tsx`.

### `flow.lines` — a code line takes plain lines

At a position inside a line of an island declared `lines` (a code line),
the flow is placed as plain lines: every line it shows, nested ones
included (a list's items, a code block's lines, an image's caption), in
document order, each a run; a line that shows nothing (a divider) is
dropped, and a flow of only such lines changes nothing. A `whole` flow is
placed the same way. No block other than a line lands in the island
(SW16-paste-1). `hello| world` in a code line + `x`, `ul > [one, two]` →
code lines `["hellox", "one", "two world"]`.

### `flow.whole` — a block selection's copy is whole blocks

A `whole` flow is placed as blocks right after `B`; `B` is never split. An
empty `B` (no text, no children) is replaced by them. Caret: the end of the
last placed block's last shown line (its own content, or a list's last
item, `flow.apart`).

### `flow.slot` — over selected blocks

Over a block selection the selected blocks are deleted (`deleteBlocks`,
`del.blocks.promote`: their unselected children stay, after the placed
lines) and the lines are placed as blocks in the first one's slot, in the
same plan (runs take the slot's default child). The lines fill that slot
before the delete decides what it empties: the slot's parent is never
removed as emptied, so a list keeps its item and a column its layout
(`layout.flow-slot`). Over selected lines of an
island declared `lines` (code lines), the lines are plain lines
(`flow.lines`, HX-06): no block lands in or after the island, and a flow
that shows no line leaves one empty code line. Caret: the end of the last
placed block's last shown line (`flow.whole`).

### `flow.place` — at a slot, nothing replaced

At a slot `{slot: {parent, index}}` (an accepted suggestion's `after`,
`before` or `inside` position: `edytor.suggestions`), the lines are placed
as `flow.slot` places them, with nothing deleted: whole blocks at the
slot, at plain ranks, a run taking the parent's default child, a plain
line in a container its item (`flow.container`), plain lines in a `lines`
island (`flow.lines`). A parent that holds no children (a void, an
island's line) or is not live refuses the op before any write. In an
emptied document a root slot replaces the virtual paragraph
(`doc.empty.virtual`). Caret: the end of the last placed block's last
shown line (`flow.whole`). Pins: `d7-flow.test.ts` (`flow.place`),
`suggestions-20261002.test.tsx`.

### `flow.container` — a line placed in a list is its item

A plain line (a run, or one of the document's default kind) placed
directly in a container that holds only its items (a list: `fits`,
`del.merge.container`) takes the container's item kind — a pasted paragraph
between two list items is a `list-item`, and into an empty item it leaves
the item an item. SW9-containers-1. So does a line of the list's own flat
item kind, which the view passes in (`itemKind`: a pasted `<ol><li>` in an
`ordered-list` gives `list-item`s, AW-08). A line of any other kind keeps
its kind and data, as it would outside a list: a pasted image keeps its
`src`, a to-do its check, a heading its level, a bulleted item in an
`ordered-list` its kind (DR-crdt-1).

### `flow.layout` — no layout lands in a column (D2)

A flow placed inside a layout's item (a column), at any depth — at a
position, over selected blocks or at a slot — places each layout line it
holds, at any depth, as its items' lines in reading order (and any other
child the layout holds), then by the rows above: a copied layout pasted in
a column gives its blocks, a whole flow after the block, a pasted HTML
layout its lines (the first one joining the text, `flow.split`). Elsewhere
a layout line is placed as a block (`flow.apart`: it shows no text). Pins:
`columns-clipboard.test.tsx`.

### `flow.void` — a block that cannot split

A void block (its caption) is never split: at a position inside one, the
lines' content joins into one run separated by `\n`; their children are
not placed.

## Block deletion (a block selection, a block's delete action)

The user's contract (2026-09-28): preserve content the user did not remove.

### `sel.blocks.exact` — a block selection is exactly its members

A block selection `{blocks: ids}` covers exactly its ids. A parent and its
children are separate members: a handle click, and the select-all ladder's
block step, select one block; `data-edytor-selected` marks the members only
(the demo paints a nested non-member over its parent's highlight).
Shift+↑/↓ adds each block it passes in document order — reaching a parent
from its first child adds the parent and keeps the child; from a parent it
adds the first child. Select-all (the ladder's third step) selects every
block, nested ones included. Copy and cut of a block selection carry the
members only, nested as in the document (what a cut copies is what it
deletes). A selected block that shows only its children (a list its items,
a code block its lines: it renders no content of its own and is no void)
stands for its whole subtree, as its highlight shows: delete, cut, copy,
paste and typing over the selection, Turn into, marks and the toolbar act
on it with its items (`selectedMembers`, `visibility.ts`; GX-02,
DR-behavior-2: a grip-selected list's or code block's Backspace removes it
whole, its cut and paste moves it intact, Mod+B bolds its items). Marks and
Turn into skip a closed toggle's hidden body inside it (FX-07,
DR-behavior-4); its delete and cut take the body with the list. Turn into
keeps the converted blocks selected, even once the list that held them is
gone (DR-behavior-3). Pins: `contracts-block-selection.test.tsx`,
`contracts-block-selection.spec.ts`, `selection-shown-20260930.test.tsx`.

### `del.blocks.promote` — only the selected blocks leave

`deleteBlocks(ids)` (a block selection's Backspace/Delete/cut,
`flow.slot`) and `deleteBlock(id)` (`Block.removeBlock()`, a node's
`delete()`) mark every member with this writer's delete mark (and what it
displays through merge claims). Each member's unselected children — with
their own subtrees — take its slot in its parent, in order; a member under
an unselected child of another member takes its own slot there. A deleted
island's children take the default child type of the slot's parent (as an
island merge does). One plan, one undo step: undo removes the marks and the
children's new placements, so the parent comes back with its children under
it. `deleteBlock(id, { keepChildren: false })` is the explicit whole-subtree
delete: it marks every member (and what each displays), so nothing in the
subtree is promoted. A container (a list, a row) the delete leaves with no
child goes too, and so on upward (`del.range.empty-container`): deleting a
one-item list's item, or every item, removes the list (SW8-roles-2).

Promotion is derived when the document is read (UW-08,
`placement/model.ts` `displaySlotOf`): a block with no delete mark whose
parent carries one displays in that parent's slot, ranked just after it,
in its own order, recursively (`promotedRank` — the planned moves above
write the same rank, so the deleter's own view and a peer's agree).
Concurrency follows from that rule, not from what the deleter saw: the
promoted children keep their identity, so a peer's concurrent typing
inside them survives; a peer's Enter in a promoted child keeps the tail
and the grandchildren it carries, after the head; a child a peer adds to,
or moves into, the deleted block takes its slot too (**MV06b**, changed
2026-09-29 — it used to hide with the block); two peers promote-deleting a
parent and its child keep the grandchild in the parent's slot; a tail
split off concurrently from a deleted child is rescued (ST02a) and, its
parent deleted too, takes the parent's slot (9c). A concurrent move of a
promoted child is settled by the placement's last-writer-wins. Undo of the
delete removes the marks: everything placed under the block comes back
under it. Pins: `contracts-preserve.test.ts` (split of a promoted child
with its grandchild, typing into the tail, nested promote-deletes, a
concurrent child, the whole-subtree control), `p1-scenarios.test.ts` §9
(9a-9d) and 6b, `scenarios/active-model.ts` MV06b,
`scenarios/active-text.ts` ST02d, `review-20260929-core.test.ts`; the
corpus and p1 oracle `promotion-hidden` (on by default,
`DST_PROMOTION_ORACLE=0` turns it off) flags an unmarked block hidden
under a deleted holder.

## Collapsed caret deletion

### `del.caret.char` — character backward/forward

Caret `beta@4` + Backspace → `"bet"`. Grapheme clusters delete as units
(emoji ZWJ, flags, combining sequences, surrogate pairs) — see
`advanced-delete.spec.ts` for the native-input evidence.

### `del.caret.doc-start` — Backspace at document start

Caret `alpha@0` + Backspace → **named no-op** (`noop.doc-start`): document
unchanged. Expected no-ops are contract results, not skipped tests.

### `del.start.kind` — Backspace at the start of a non-default kind

Caret `item@0` + Backspace over `[paragraph "para", bulleted-list-item "item"]`
→ `[paragraph "para", paragraph "item"]`, caret `item@0`. A block whose kind
the catalogue offers (it has presets) and that is not its parent's default
child turns into that default first — one `setBlock`, data reset, text and
children kept — before the doc-start no-op, the unnest and the merge
(Notion). The next Backspace merges (`del.merge.backward-head`) or unnests.
A nested last-child bullet becomes a nested paragraph; an empty only bullet
becomes the empty paragraph. Kinds without presets (`list-item` in a list,
`codeLine`) keep the structural path. Pinned in `notion-parity.test.tsx`
("lists on Backspace").

### `del.merge.backward-head` — Backspace at a block's head

Caret `beta@0` + Backspace over `[alpha, beta]` → `[paragraph "alphabeta"]`:
tail content merges into the head block; the tail block dies.
Verified through the real command path in `command-simulation.test.tsx`.

### `del.merge.container` — a key merge never dissolves a list (YW-02)

A container (a block that renders no content of its own and is neither
void nor an island: a list, a table row) never merges as a whole
(`canMerge` refuses it as the source too). Next to one, the keys act on its
items (Notion):

- Delete at the end of the block above `[unordered-list > [a, b]]` pulls
  the first item's text up: `[p "pa", unordered-list > [b]]`, caret `p@1`.
  The item's children stay in the list, in its place. Inside a table
  island, Delete at the end of a row's last cell pulls the next row's first
  cell into it the same way.
- Backspace at the start of a list's first item lifts it out:
  `[p, unordered-list > [a, b]]` → `[p, paragraph "a", unordered-list > [b]]`,
  caret `a@0` (the item takes its new parent's default child and keeps its
  children; an item of a nested list that lands in its parent item stays an
  item, SW8-roles-4). At the last item it outdents after the list, also as the
  default child (the unnest); a middle item still merges into the one
  above. Inside an island nothing leaves: a row's first cell stays.
- **One container rule, one owner (`fits`, ZW-01, ZW-14).** A container
  whose default child is a kind of its own — its _item_: a list's
  `list-item`, a columns layout's `column` — holds only its items, and
  containers of them when the item renders content (a list directly in a
  list, from JSON or the API; an HTML paste gives flat items; a layout
  holds no layout, `layout.fits`); a container whose default child is the
  document's (a `column`) holds any block. Every structural placement asks it:
  - a move (`moveBlocks`, a drag, Alt/Mod+Shift+arrows) keeps its kind, so
    it is refused where the blocks do not fit (`canPlace` answers `false`)
    — a reorder within a block's own parent changes nothing the parent
    holds, so an image shed into a list still moves among its items
    (AW-06); Tab (`nestBlock`, a drop _inside_ a block) into a container
    the blocks are no items of nests under its last item instead, and so
    on down: `[p, ul > [a, b], q]`, Tab on `q` → `[p, ul > [a, b > [q]]]`
    (Notion); a last child that holds no children (a void, an island)
    refuses it, as Tab right under that block does: `[ul > [a, image], q]`,
    Tab on `q` does nothing (AW-07);
  - a plain block (the document's default kind: a paragraph) a merge, a
    delete, a range rescue, a void retype or a paste sheds into a container
    becomes its item: Delete at the end of `p` above
    `ul > [a > [paragraph "child"], b]` → `[p "pa", ul > [list-item
"child", b]]`, and with `a` the only item the list keeps `child`;
    Backspace at a middle item with a paragraph child, and deleting an
    item, keep the child in the list as an item. Any other kind keeps its
    kind and data where it is shed (an image under a bullet stays an
    image, a code block keeps its kind and lines, a heading its level,
    DR-crdt-1), as a peer's concurrent promotion shows it (`typeOf`
    resets only the default kind);
  - an outdent (Shift+Tab, Backspace at a last child) takes the kind of
    its new slot — a paragraph outdented from an item into the list is an
    item — and is refused where it would not fit (an image, a code block
    or a heading under an item: it would sit directly in the list; every path
    agrees — Shift+Tab over a range, the block handle's Alt+ArrowLeft and
    `canMoveBlocks({direction: 'out'})` ask the outdent plan, DR-crdt-2):
    in a layout (`columns > column > paragraph`, `layout.*`), Shift+Tab at
    a column's last or only paragraph does nothing (an outdent into the
    layout is refused): nothing but a column sits directly in a layout
    (Notion); Backspace at a column's first paragraph merges it into the
    previous line in reading order (`layout.merge`, D4);
  - a block is never retyped to a kind that renders no content — its text
    would vanish (DR-crdt-1); where a container's item renders none, a
    block only a delete or a peer's concurrent edit puts there keeps its
    kind, and an island's lines shed there, or an island retyped to such a
    container, take the document's default kind; any other island child
    shed there that shows text keeps its kind, and one that shows none (a
    table's row) takes the slot's default child, as the read-time promotion
    shows a child a peer adds meanwhile. A layout is not such a slot: what
    is no column leaves it at read time (`layout.only-items`), and a layout
    left with one column dissolves (`layout.single`), so a deleted column's
    paragraphs, a code block's line shed out of a column (AW-05) and a
    table's rows land beside the layout, in reading order, as the kind they
    show there (a paragraph; a row keeps its kind, DR-crdt-2). A retype of
    an island to an ordinary kind retypes only an island's lines (the new
    kind's default child, or the document's default kind where that shows
    no text); any other island keeps its children's kinds — a table
    retyped to a columns layout keeps its rows, which leave the layout and
    show beside it as rows — as `typeOf` shows a row a peer adds meanwhile
    (DR-crdt-2).

  The document's explicit kind writes place what they are told:
  `insertBlocks` and `setBlockType`/`setBlock` are not retyped or refused
  (the view's Turn into places the kind where it fits first — `liftOut`:
  out of every container it does not fit, each split around the block by
  the one split Shift+Tab makes in a list (`splitOut`, BW-06), and a
  divider or code block inserted after an item splits the list after it;
  the lifts and the retype are one plan, so a veto keeps all of it, ZW-02,
  AW-01, AW-03; the kind placed is the one the payload names after hooks,
  BW-03; its own kind keeps a block in place); pasted lines follow
  `flow.container`. The
  display rule still holds for them: a block stored as the document's
  default kind directly in a list shows as its item (the index's
  `typeOf`, AW-04), so no write, race or undo shows a bare paragraph in a
  list.

- A container either key leaves with no child goes
  (`del.range.empty-container`); one undo restores it. The keys, the
  moves and a text range share one predicate for it (`emptiable`, ZW-05):
  a range across the seam into a list holding hidden text of its own keeps
  that list and its text, as Delete does. A container that
  concurrent edits left with no child (Ada lifts the first item while Bob
  merges the second into it) is removed by the key that meets it: Delete
  at the end of the block above, Backspace at the start of the block below.
  A container holding text of its own (hidden, a peer's retype) is never
  removed this way. A container never splits (`splitBlock` refuses it).
- The moves agree: a move (`moveBlocks`: a drag, Alt/Mod+Shift+arrows),
  an outdent (`unNestBlocks`) or `mergeBlocks` that leaves a container with
  no child removes it, never one the blocks move within or land in
  (SW8-roles-5, DR-crdt-5). A moved item keeps its kind. Several
  containers a set of blocks empties together all go: deleting a list's
  last item with the only item of a list nested directly in it removes
  both lists (SW9-containers-2).
- An outdent (Shift+Tab) out of a list never takes the items after it
  (DR-crdt-3): the list splits around the outdented items, Notion's way.
  `[p, ul > [a, b, c]]`: Shift+Tab on `a` → `[p, paragraph "a", ul > [b,
c]]`; on `b` → `[p, ul' > [a], paragraph "b", ul > [c]]`, where `ul'` is
  a new list of the same kind and data: the list keeps the items _after_
  the outdented ones (ZW-03), so an item a peer appends to it meanwhile
  (Enter at the end of `c`) stays after `c`; on `c` → `[p, ul > [a, b],
paragraph "c"]`. One undo restores the list. Residual: an item a peer
  adds among the items _before_ the outdented ones meanwhile lands in
  `ul`, after them. When peers outdent, lift (Backspace at the start of a
  first item) or Turn into items of one list concurrently, one gesture
  each between syncs, the text keeps its order on every client-id pair
  the sweeps run (`clientPairs`, up to 240 a row) and every replica
  converges (CW-01): a block leaving a list is ranked by where it came from
  (`sourceRank`: a base every replica computes alike from the gap, then
  its side of the gap, then its path down the list), never drawn at
  random in the gap two peers share. The side keeps sources apart
  (DR-crdt-6): in the gap `(X, Y)`, a split's pieces of `X` first, then
  the blocks leaving `X` for the gap after it, then those leaving `Y` for
  the gap before it, as every serial order puts them — Enter in the
  paragraph above a list ‖ Backspace or Turn into on its first item reads
  the paragraph's pieces, then the item. A list the two splits leave with no item shows nothing and the
  next key next to it removes it (both outdent `b`: each made a `ul'`,
  one stays empty). Residuals, pinned in `cw01-order-sweep.test.ts`:
  - in a list nested directly in a list, `[ul > [a, ul2 > [b, c, x], d]]`,
    the two splits can move blocks at different levels, so neither
    contests the other's: Ada moves `b` into `ul` (Shift+Tab, or
    Backspace at its start) ‖ Bob lifts the later `x` out of both lists
    (Turn into a heading, a divider or a code block) → `b` stays in `ul`,
    after `x`: `[ul' > [a, ul2 > [c]], heading "x", ul > [b, d]]`, whatever
    the ids; Ada lifts `b` ‖ Bob lifts `x` out of both lists, Bob's client
    id wins `a` → `b` reads before `a`;
  - a block inserted after an item (Turn into a divider or a code block on
    an item with text: the item stays) whose item a peer's concurrent
    split of a later item takes into its new list, when that peer's id
    wins it, shows right before that new list — above the item it
    followed. The text keeps its order.
- Two peers pressing Enter in one block at once (`splitBlock` at two
  offsets), or pasting several lines of text into it (`insertFlow` at a
  position; not a `whole` or `replace` flow, below), one gesture
  each between syncs, keep its pieces in text order on every swept
  client-id pair: the blocks a split
  creates are ranked by where it splits (SW12-crdt-1, SW12-crdt-4),
  counted from the end — the text after the split point — so a peer's own
  edit before its split point (typing, then Enter; a paste over a
  selection) does not move it (DR-crdt-7). The blocks Shift+Tab moves out
  of a block that is no list, and the children a merge unnests after the
  merged block, are ranked by where they came from, as a list's
  (SW12-crdt-3). Residuals, pinned in `dr-crdt-order.test.ts`:
  - an unseen edit _after_ one's own split point counts, typed or
    deleted: Ada appends " again" to "hello world" and splits after
    "hello wo" ‖ Bob splits after "hello" → "hello", "rld again", " wo";
    Ada deletes "rld" and splits after "hello" ‖ Bob splits after
    "hello w" → "hello", "o", " w";
  - R3, a new block stays behind: the block a split creates right after
    `s` stays beside `s` in `s`'s parent while a peer moves `s` out of it
    (an outdent or lift of `s`, a split of its list at a later item whose
    head list takes `s`, a split of `s`'s parent that takes `s` into the
    new piece, Shift+Tab on an earlier nested line of a non-list block,
    which adopts `s`): Enter at the end of the last item ‖ Shift+Tab on
    it → `[ul > [a, new], paragraph "b"]` — the same residual as an item a
    peer adds among the items before an outdented one; and
    `x > [k1, "kk2", k3]`, Enter after "k" ‖ Shift+Tab on `k1` →
    `x > ["k2"]`, `k1 > ["k", k3]`;
  - R4, a merge into a split block: the merge claim appends to `into`'s
    claims list, and a concurrent split moved only the claims it saw, so
    the merged text follows the head: Backspace joins "world" into
    "hello" ‖ Enter after "he" → "heworld", "llo".
- `order.insert.run` (H1, CRDT study 2026-10): a block inserted right
  after a block this client ranked — Enter at the end of a block, a
  container header's new first child, Duplicate, the + button, a paste of
  whole lines (`insertBlocks`, `flow.place`), never a move — extends the
  client's run there (`rankAfter` in `placement/rank.ts`, the rule data
  arrays use, YATA's origin rule): its rank is the block's rank and one
  segment in the run band (`(RANK_RUN, RANK_RUN + 2^29)`, `RANK_RUN = -2^30` since P7), or, after a
  member of the client's run, the next member at that depth. A peer's
  rank in that gap is never an extension of the block's rank with a digit
  in the band, so it sorts before or after the whole run, never inside it.
  Two peers that each press Enter at the end of one block and type
  several lines keep each one's lines together on every client-id pair
  (`h1-block-runs.test.ts`: `x a1 a2 a3 b1 b2 b3 q` or `x b1 b2 b3 a1 a2
a3 q`; before, 34 of 40 pairs interleaved), and the lines of one paste
  stay together around a peer's split. Which peer's run comes first
  still follows the client ids (below). The ranks stay inside the EW-02
  bounds (`rank-growth.test.ts`): a run costs one segment once, its
  members none.
- `order.rank.format` (P7, schema generation 5): a rank is a sequence of
  segments, each a variable-length signed digit (a length character, then
  base-64 places: small digits are short) and, only where the order needs
  one, the allocating client's tie (`!` and the client id). The last
  segment always carries a tie; a copied segment keeps its tie only when
  two bounds differ by their ties alone, and a run's member
  (`order.insert.run`) keeps every tie, so a peer's rank of the same digit
  never sorts between two members. Ranks are still compared as plain
  strings. Ranks of schema generation 4 are never read: a generation-4
  document reaches generation 5 through its JSON, which ranks every block
  again (`reference/migration.mdx`). `rank-growth.test.ts`: 300 Enters
  256 → 129 characters, 1,000 Enters 576 → 342, an outline 112 → 60 (a
  27-bit client id; with a 53-bit one 165, 446 and 72).
- Not claimed (EW-05, EW-11; pinned in `order-scope.test.ts`): only the
  gestures above rank by source (`exitRanks`/`pieceRanks`); every other
  placement takes a plain rank in the gap (`ranksFor`, `M.ranksAt`), so
  its order against a peer's concurrent block follows the client ids.
  Both replicas converge and no text is lost. That covers:
  - a block inserted beside one (`insertBlocks`): Enter at the start or
    end of a block (`insertBlockBefore`/`insertBlockAfter`; at the end of
    a block with children and text, not a container header, Enter splits
    it, `liftContent`), a container header's new first child
    (`addChildBlock`) or its text after the caret when Enter splits it
    (`prepareSplitKeepingChildren`: an open toggle, a callout or quote
    with children), Duplicate (`duplicateBlock`) and the handle's +
    button. Enter at the end of X and typing "foo" ‖ Enter after "hello"
    in X → "foo" can read before " world";
  - a paste of whole blocks (a block-selection copy, `insertFlow`'s
    `whole`: after the caret's block) and a paste or typing over selected
    blocks (`replace`: the first one's slot), both `atSlot` →
    `insertBlocks` (DR-crdt-1): a whole paste with the caret in X ‖ Enter
    after "hello" in X → " world" can read before the pasted blocks (since
    `order.insert.run`, never between them).
    Ranking them by source kept the order but grew ranks 5 to 7 times as
    fast as plain ones under repeated pastes in one place (EW-02);
  - several structural gestures by one peer before it syncs (text edits
    before one's split point are fine, DR-crdt-7; one after it is the
    residual above): two Enters ‖ a first-item lift,
    a new line or Duplicate after X then a split of X ‖ a split of X.
    That includes Turn into over several blocks (`convertBlocks`: one
    `convertToKind`/`liftOut` plan per block): turning `a` and `b` of
    `[p, ul > [a, b, c, d, e], q]` into headings ‖ Shift+Tab on `c` → `b`
    can read after `c` (`unNestBlocks` over adjacent siblings is one plan
    and keeps the order), and Shift+Tab over selected items with an
    unselected one between them (`moveRoots`: one `unNestBlocks` plan per
    run of adjacent siblings): `a` and `c` ‖ Shift+Tab on `d` → `d` can
    read before `b` (SW15-crdt-1). One headless `unNestBlocks` call over
    non-adjacent siblings (`edytor.moveBlocks` with `direction: 'out'`
    makes one per run, GX-05) is not covered either: `unNestBlocks([a, c])` ‖ an
    outdent of `d` → `p|a|b|c|d|e|q` on some pairs, where the serial result
    is `p|b|a|c|d|e|q` (DR-rest-2);
  - moves (`moveBlocks`, `nestBlock`): a drag, the handle's Alt+↑/↓/→
    (Alt+← is the outdent, ranked), Mod+Shift+↑/↓ (arrowMovePlugin), the
    block menu's Move up/down and Tab (`nestBlock` at the parent's end:
    Tab on `y` ‖ Enter at the end of the last child of the block above →
    the new line can read after `y`).
- One client never mints one source rank twice in a gap: a segment tied
  by the client's clock follows a source rank's first part segment
  (DW-05), so a line a peer deleted and restores by undo never ties with
  the line minted there since, and the lines of one gesture (a paste)
  sort before what the client mints there later, never among them
  (FX-06; `order-scope.test.ts`). `rankBetween` stops descending once the
  emitted prefix is below the right bound (FX-04). `rank-growth.test.ts`
  bounds the longest rank and the encoded document after 300 and 1,000
  Enters mid-document, 300 typed outline items and 3,000 reorders of 20
  lines (EW-02); a ranking change keeps within it. Enters concentrated at
  one spot still add about one rank level per 32 (a gap halves at each
  insert there).
- Concurrency (DR-crdt-2): an item a peer adds to a list another peer's
  edit removes (a delete, lift, pull-up or move of its only item, or a
  delete of the list) is promoted into the list's slot as its new parent's
  default child, read-time like an island's (`displaySlotOf`'s `reset`, the
  index's `typeOf`); inside an outer list of its kind it stays an item. A
  delete of a list retypes the items it promotes the same way. Undo of the
  removal brings the item back into the list, as an item. The other way
  round, a block promoted _into_ a list at read time (Bob splits the
  paragraph child of an item Ada deletes) shows as the list's item, as the
  delete's own write makes the child it saw (SW9-containers-3). A
  paragraph a race leaves stored directly in a list — Ada outdents a
  middle item while Bob lifts or outdents one before it (the split's move
  of that item into the new list races Bob's move and retype), or a peer's
  concurrent undo of a retype — shows as the list's item on every replica
  (AW-04), and leaves the list as any item does: Shift+Tab, Backspace at
  the first item, Turn into Text or deleting the list gives a paragraph,
  never a bullet outside the list (DR-crdt-3). A column a peer moves under an item another peer
  deletes lands in the list as a bare item (`layout.bare-item`): it does not
  display, its blocks take its slot, a paragraph as the list's item.
  Residual: an item a peer turns into
  another kind (Turn into: a heading, a to-do) while another peer outdents
  a later item may stay in the new list the split makes, as that kind —
  `[p, ul > [a, b, c]]`, Ada outdents `b` ‖ Bob turns `a` into a heading
  → on some client-id assignments `[p, ul' > [heading "a"], paragraph "b",
ul > [c]]` (the split's move of `a` wins over the lift). It keeps its
  kind, data and place in the text, as a heading a merge sheds into a
  list does; the display cannot tell the two apart (pinned in
  `rescore7-crdt.test.ts`, Turn into ‖ an outdent).

Headless `mergeForward`/`mergeBackward`, `mergeBlocks`, `unNestBlocks`,
`deleteRange`/`replaceRange` and room `transact` apply the same rules (the
view's keys and selections call them): a text range across the same seam
agrees with the Delete key (`del.range.nested-tail`, DR-crdt-4). Pins:
`rescore5-crdt.test.ts`, `rescore5-crdt-view.test.tsx`, `rescore6-crdt.test.ts`,
`rescore7-crdt.test.ts`, `d6-range-delete.test.ts`.

### `del.caret.one-command` — each branch is one prepared command

Every collapsed Backspace/Delete branch (character, atom, unnest, merge,
word or line unit) issues exactly one command over one prepared plan: a
merge that unnests children plans the children moves with the merge. A
veto of any planned step refuses the whole branch before any write (zero
bytes, no undo step). Pinned in `arch-v2-s2-commands.test.tsx`.

## Unit deletion — word and line

### `del.unit.caret-edge` — the model owns the extent

`deleteWord*`/`deleteSoftLine*`/`deleteHardLine*` ARE
`isDeleteTargetRangeInput`s (onBeforeInput.ts): for a collapsed model
selection `syncSelectionFromBeforeInputTargetRange` collapses the
delivered `targetRange` to its caret edge (the start edge for forward
deletes, the end edge for backward), and for a live selection it skips
the sync entirely. The collapsed model command — `deleteCollapsedWord*`/
`deleteCollapsedLine*` — then owns the delete extent. **The browser's
span is a positioning hint, never the delete unit**: Firefox delivers
block-level end containers for word deletes (the range runs past the
text into the block element), and verbatim adoption minted a degenerate
caret that no-oped the delete.

The oracle mirrors the same collapse (`effective` = caret edge when the
same-text safety check passes, else the model selection stands) and
keeps the delivered span under independent bounds: over a collapsed
caret it must be anchored at the caret in the delete direction, and a
`deleteWord*` span must cover at most one contract word-run. A range
that fails either check is `delete-range-implausible` (e.g.
`alpha bravo|` → `""` covers two word-runs — not a word unit). A
delivered range covering a live (non-collapsed) selection is unanchored
by design — the selection is the unit — and skips the anchor bound. The
delivered offsets are judged in filler-free geometry, as production maps
them: an empty text renders one zero-width filler, so offset 1 inside an
empty text is its offset 0 (WebKit ends a word unit from an empty block's
end inside the next empty block's filler, DST seed 39); any other offset
past a text's length stays `delete-range-implausible`.

Fragment deletes (`deleteByCut`/`deleteByDrag`/`deleteByComposition`),
generic `deleteContent`, and `deleteEntireSoftLine` still adopt the
delivered range verbatim.

### `del.unit.model-boundary` — collapsed caret extent

The collapsed model command computes the boundary from the caret's own
text — `getPreviousWordStartOffset`/`getNextWordEndOffset` (word chars
are `[\p{L}\p{N}_]` code points; everything else is a boundary). When
no word run remains in the delete direction, the boundary is the
boundary-run's far edge — a caret before `· ` still consumes `· ` to
the text end, matching the platform's own word-delete result. Mirrored
independently by `contractWord{Start,End}Offset` in `deleteOracle.ts`.

### `del.unit.neighbour` — an empty unit deletes the neighbour

When a collapsed word or line unit is empty — nothing of the caret's own
text (word) or line (soft/hard line) lies in the delete direction: the
caret sits beside an inline atom, a `\n`, or the block's edge — the unit
is the neighbour, deleted like a character: the atom, the break, or the
block merge/unnest of `del.caret.*` (a word delete at an empty
paragraph's end pulls in the next block). Pinned: `command-programs.test.tsx`
(P1.1b word rows), `p1-delete.spec.ts`; mirrored by the DST delete oracle,
which falls back to its character delete for an empty unit.

### `del.unit.soft-line` — a line ends at a line break

The collapsed line commands take their extent from the block, not the
delivered range: `deleteSoftLine*` runs from the caret to the nearest
`\n` of the block's texts in the delete direction (an inline atom is
not a break), else to the block's edge; `deleteHardLine*` runs to the
block's edge across line breaks. A caret right after (before) a `\n`
has an empty soft line backward (forward): the unit is the neighbour,
deleted like a character — the break itself, joining the two lines.
Visual wraps stay browser-owned (U4). Pinned: `command-programs.test.tsx`
(the `del.word/del.line` rows), `delete-shapes.spec.ts` (golden
browser shapes), mirrored by `softLineEdge` in `deleteOracle.ts`.
(P1.2: the model used the block's edge for both units, which the golden
`deleteSoftLineBackward` row never accepted.)

## Selection recovery on the passive peer (remote-origin changes)

Anchors are relative positions; carets bind left affinity, range ends bind
per their own anchor. The value's anchors ride the remote change; the
projector's pass after the flush displays the current value, running
`restoreDeadSelectionEndpoints` (the seam repair) when it no longer
projects (arch-v2 V4).

### `doc.empty.virtual` — an emptied document shows a virtual paragraph

When the document is ready and has no visible block (concurrent deletes of
the last blocks, an undo, a block-selection delete of everything), every
view shows one local, virtual empty paragraph of the root's default type
(`session/virtual.ts`, id `v_…`) and places the caret in it: a view with no
selection or a dead endpoint lands there (it is the only seam stop). It is
never written; the document JSON has no block. The first edit in it
(typing, an atom, paste, Enter at its end, a block-kind command) is
prepared as the creation of a real block with that id, the edit folded in:
one plan, one transaction, one update (a paste creates its lines as
blocks, the first taking that id, and ends the caret where the flow does,
`placedEnd`: the end of the last line's own text — a toggle's header, never
its hidden body, a paragraph's own line, never a nested child — or of a
list's last item, a code block's last line; SW16-paste-2, DR-behavior-1;
lines ending on no line, a divider, get an empty paragraph after them to
hold it, as `flow.apart` does, SW16-behavior-1). An emptied root writes no
replacement block, so no replica writes one for having seen the document
empty, and two replicas typing into their own virtual paragraphs keep both
lines. Readonly views show it and refuse the edit at admission. A peer's
caret in its own (unwritten) virtual paragraph shows in this view's. The
seed of a fresh document (`D-3`) is unchanged; a whole-document range
delete keeps its head block (`del.range.whole-doc`), so it never empties
the document. Pins:
`contracts-virtual-paragraph.test.tsx`, `contracts-virtual-paragraph.spec.ts`,
the collab DST schedule seed 11.

### `sel.ride.insert` — caret rides remote inserts

Caret inside a text, remote insert before it → caret shifts by the insert
length; insert **at** the caret lands after it (left affinity).
Pinned: `remote-selection-preservation.test.tsx`.

### `sel.ride.merge` — caret's block merges away

Caret `beta@2`, remote merge of beta into alpha → caret lands in the merged
text at `5+2 = 7`. Pinned by the preservation suite and re-verified through
the command path (`command-simulation.test.tsx`).

### `sel.seam.covered-atom` — caret's atom deleted in-place

Remote `deleteText` covering the caret's atom → caret lands at the deletion
seam (offset of the removed run). A range whose every atom died is a caret
there too — a fresh left-bound caret, not the two range anchors: text
re-inserted at the seam (a peer's undo) lands after it and never re-opens
the range. Pinned: `remote-selection-preservation.test.tsx`.

### `sel.seam.next-sibling` — caret's block deleted

Caret in a deleted block → lands at the start of the sibling that slid
into the dead block's index (`alpha` deleted → caret at `eta@0`).
If the dead block was last, lands at the previous sibling's end.
Verified through real command + delivery in `command-simulation.test.tsx`.

### `sel.seam.nested-subtree` — caret's whole subtree deleted

Caret inside a nested `list-item`; remote delete destroys the entire
`ordered-list` subtree (caret's anchor atoms and every ancestor die).

Result: dead-endpoint repair climbs to the **topmost dead child of the
nearest live ancestor** (the `ordered-list` at root index 1) and applies
the same slot rule as `sel.seam.next-sibling`: the live sibling that slid
into that slot, or — when the subtree was the last child — the previous
live sibling's end. For `[alpha, list>item(beta), omega] → [omega]` the
caret lands at `omega@0`, and follow-up typing inserts there.

Former UNRESOLVED-2 — the old fallback landed on the root's phantom
content text (unrendered): the caret looked alive but the next keystroke
was silently dropped. The fallback now names the first real child's
text, never the root's own content slot.

### `sel.seam.slot` — one seam rule, for endpoints this view did not author (arch-v2 V3)

The slot is replicated data: a dead block keeps its winning placement
`{p, r}`, so the seam is the same on every replica whatever order the
deletes arrived in (`doc/anchors` `seam`, `src/lib/crdt/anchors.ts`). The
rules above are its sibling level; when the live parent has no
displayable stop on either side, the same question is asked one level up
(the parent's own content is then the stop before the slot), instead of
jumping to the document's first text. Only **displayable** stops count:
the block's own content is mounted and not hidden by view state (a
collapsed toggle's body, a `hidden` subtree; a phantom content slot never
mounts) — so a peer's delete inside a collapsed toggle lands on the next
visible stop, never in a hidden sibling (F-S14).

The seam applies only to endpoints this view did not author: remote
deletes, another view's or a headless change, a local operation that
declared no result. A command that authors its result selection declares
it before its operations run (`Dispatcher.caret(text, offset, ops)`); the
repair leaves this view's endpoints to it and the result is selected once
(`dispatcher.last.selection`). A block-set delete or cut authors its caret
by `caretAfterBlockDelete`: the start of a child promoted into the set's
place (FW-05), else the end of the nearest line before the set, else the
start of the nearest line after it; a block with no line of its own (a
void, a container) and a closed toggle's hidden body are passed over. The
block menu's Delete uses the same helper, so both land on the same caret
(F-S13, FP-7, YW-04, DR-behavior-1).

## Properties

### `data.retype.keep` — a change of kind keeps the properties (H4)

A retype (`setBlock` with a type and data: Turn into from any menu, a
markdown shortcut, the slash menu, Backspace at the start of a kind,
`del.start.kind`) sets the data leaves the new kind's preset names as
`patchData` sets, one per leaf (`leafSets`: into an object the block holds
there, else the value whole), and removes none; `setBlock` without a type
does the same. A kind ignores the keys it does not read, as Notion's blocks
keep their properties across kinds: a to-do `{checked: true, color: 'red'}`
turned into a heading is `{checked: true, color: 'red', level: 'h1'}`, and
turned back into a to-do `{checked: false, color: 'red', level: 'h1'}` (the
preset's leaf is set). A peer's concurrent property write survives the
retype (`h4-retype-keeps-data.test.ts`). Replacing the whole data stays
`setBlockData` (`block.setData`, a root patch); a flow's join (`redata`)
writes the pasted line's data whole, as before.

### `data.atomic` — a declared path is one leaf (H8)

A kind's role may declare `atomic` data paths (`BlockRole.atomic`: a key,
or an array of keys; adopted with the role, so every view, a headless
document and the room agree, and a different declaration of one kind is a
`SemanticConflictError`). A data write at such a path, or under it,
writes the path's whole value as one leaf (`patchWrites`' `atomic`,
`collapse`) and deletes every leaf stored under it, so two concurrent
assignments are one last-writer-wins attr: `{url: a, title: A}` ‖
`{url: b, kind: video}` ends as one of the two, whole, on every client-id
pair (`h8-atomic-data.test.ts`), where per-leaf merging gave
`{url: b, title: A, kind: video}`. A write inside the path writes it
whole too, so it loses to a concurrent assignment or wins over it whole.
An object leaf reads as its keys (`effective`), so a block created with
the object exploded, or one an older client wrote leaves under, reads the
same; such a client's concurrent leaf under the path still merges with the
whole value (the residual of mixed versions). Arrays inside the path are
read as the value's items and written back whole.

## Marks (H5, schema generation 5)

### `mark.pair` — an end closes only its own start

A mark write (`formatRange`, `setMark`, `unsetMark`, the marks of an
insertion or a seed) is one operation per mark: a start and an end format
item paired by the operation's id (fork patch P13, `vendor/yjs/src/utils/marks.js`),
its value (`null`: the mark off over the range) and a Lamport timestamp
above every mark the writer's document integrated. A character shows, per
mark, the value of the open operation with the greatest `(timestamp,
client, clock)`. So two overlapping writes of one value union (bold "The
quick" ‖ bold "quick fox" → "The quick fox" bold), two values overlap
with one winner where both cover and each keeps its own part elsewhere
(no end clears another write's tail), and a write made after seeing
another wins where it covers (`h5-marks.test.ts`, the Peritext cases on
every swept client-id pair). Nothing cleans up mark items: an undo
deletes its operation's two items, a redo writes copies paired as before.

### `mark.edge` — where a concurrent insert at a mark's end lands

A mark record's `edge` (adopted by the document as semantics, `marks:
{ name: { edge } }`; `richTextMarks` holds the bundled link's) decides,
at integration, where an insert made concurrently at an operation's ends
lands: `inclusive` takes it in at both ends, `exclusive` at neither,
`side-dependent` at its start only. The start and end items carry their
side (attached to the text before them, or after), and the integration
orders the items of one origin: items attached to the text before them,
then content, then items attached to the text after them, by client id
within one class. A peer typing after a link set concurrently stays out
of it on every pair (exp4b); typing after a bold joins it. A local
insertion's marks stay `marksForInsertion`'s: the text goes at the end of
its gap (after the marks attached to the text before it), then an
operation over the inserted text alone writes each mark its placement
shows that the rule did not ask for; those operations never grow
(`exclusive`), so what a peer inserts beside it concurrently keeps the
marks of where it lands.

### `mark.key` — one mark per comment

A mark key `name:<id>` is a mark of its own that reads the `name`
record (`edytor.marks.get('comment:c1')` is the `comment` record, its
edge too): two comments are two marks and never clip each other.

## History

### `hist.capture-group` — one undo step per gesture

Undo cuts come from one policy table in the dispatcher (`session/commands.ts`
`CUT`): deletions, paste, drop, structural and format commands cut before
they write; typed insertion coalesces within `captureTimeout`. A
composition session is one step with its ending: its first write opens a
capture group that is held open before each later preview (K15), and it
cuts nothing, like a typed insertion. Undo and redo are the bare engine
calls (never inside a transaction, no tracked write after them); the
issuing view selects the step's recorded `before` (undo) or `after` (redo).

### `hist.delete-marks.fold` — one delete record per step (P4)

A text delete writes the writer's record (P11, `text/deletes.ts`). A delete
made in the step that wrote this replica's last record — the records
list's tail, written in the same transaction, in the history step still
capturing, or anywhere when no history records steps on this replica —
folds into it: the record is deleted and written again, its spans merged,
while it holds at most 8 spans (`FOLD_SPANS`). A backspace run is one
record. The record is replaced, never edited, so an undo of the step takes
back exactly what the step deleted, a writer's undo never restores what
another writer's record holds, and a redo writes it again
(`p4-delete-marks-fold.test.ts`, `text-delete-marks.test.ts`). The purge
(H7) drops folded records like any other.

### `sel.presence.wire` — one presence entry per view

`selections[viewKey] = serialize(value) + t`: a text value is
`{start, end, collapsed, reversed}` (`DocAnchor`s `{b, a}` in document
order), a block set `{blocks}`, an atom `{atom, block}`. A view writes only
its own key (from `select()` when the value changed) and clears it in
`destroy()`; nobody sweeps another view's key. Peers draw the freshest
valid text entry per client; an anchor that does not resolve paints
nothing.

## Concurrency policy

### `conc.delete-wins-block` — insert into a concurrently deleted block

A types into block `bb` while B (partitioned) deletes `bb`'s entire
subtree. After heal: the concurrent insert **dies with the block** —
`tombstone-wins`: an insert into a text whose block is deleted is deleted
with it, even though the authoring peer had not seen the delete. Verified
through held delivery in `command-simulation.test.tsx` ("B types inside a
block A deletes"). B's caret lands at the deletion seam (`sel.seam.*`).
This holds for EXPLICIT deletes only; undoing a block's creation is not a
delete (`hist.undo.withdraw`). A block is not text in the deleted one: a block B
adds under the subtree, moves into it or splits off inside it takes the
subtree's slot (`del.blocks.promote`).

### `hist.undo.withdraw` — undoing a creation keeps what others put in the block

An undo removes only the undoing writer's own contributions. Undoing a step
that created a block (insert, paste, Enter at a line's end, a split's new
block) never deletes the block node: the history's `withdraw` hook (fork
patch P12, `placement/model.ts` `withdrawOnUndo`) keeps the node, its
placement and its content and claims nodes, and writes the undoer's
withdraw mark `wd.<writer>`; what the step wrote inside the content and
claims nodes (the undoer's text, atoms, boundaries, claims) is deleted as
before. A withdrawn block without a delete mark is visible while it holds
content — a live unit in its stream, or a child that is not deleted — and
hidden otherwise; the index settles it after every fold, as a least
fixpoint over the withdrawn blocks, so every replica agrees whatever the
delivery order. So: B types into A's new block and A undoes → the block
stays with B's text (also when B's text arrives after A's undo); B nests a
child in it → the block stays, empty, holding the child; B later deletes
its text → the block goes (B's undo brings it back); A's redo lifts the
mark and brings A's text back beside B's. A split's undo removes its
boundary as before: the tail's text — another writer's typing included —
rides back into the source block (authorship cannot tell text typed into
the tail after the split from text the split moved, and a boundary deleted
by the undo cannot come back for a late arrival, so keeping the tail for
foreign text would make the outcome depend on delivery order); the tail
block stays only while it holds a child. An undone creation keeps its id
(like a deleted block's): re-creating it is refused. Controls: an explicit
delete still wins over an unseen insertion (`conc.delete-wins-block`).
Pins: `contracts-preserve.test.ts`, `contracts-undo-withdraw.test.tsx`,
`p12-undo-withdraw.test.ts`, `p1-scenarios.test.ts` 5d/5f.

### `conc.seed.late` — a seed that meets existing content

A document seeds `value` only when it is empty after its providers settled
or the readiness bound elapsed (R13): one deterministic update written by a
writer derived from the value's hash, so an identical late seed is a no-op
and different values union. When a late seed shares a block id with the
content it meets, the registry entry is last-writer-wins by client id. The
seed writer lives in a low band (below 2^26, UW-03) and live replicas draw
uint53 ids, so the seed loses to a block a live replica wrote and the
room's edits since the snapshot survive. Residual: against a block another
_seed_ wrote, the larger hash wins and can replace it with everything
edited inside since — not undoable (a seed is no undo step). So never pass
a changing snapshot (an `onChange` copy) as `value` beside a room, and
never combine `createDocument({ value })` (it seeds immediately) with
`attachSync` to a room that may hold those ids. Version boundary: an
id-less template seeded late into a document an older build seeded (full
32-bit writer) mints new ids and shows twice, once. Pins:
`t3-seed.test.ts` (UW-03 rows, F-T11/F-T12/F-T17).

### `conc.void-children` — a void kind displays no children

Nothing renders a void block's children, so a void never shows any. A
retype to a void kind (`setBlockType`, `setBlock` without `children`)
moves the block's children to its slot, right after it, in their order;
the island-merge rule resets an island's children to the slot parent's
default child type (UW-21). A child a peer adds concurrently — nested
under the block, split off one of its children, moved into it — displays
in the void's slot too: the rule is derived when the document is read
(UW-21b, `placement/model.ts` `displaySlotOf`, like `del.blocks.promote`),
from the document's roles, so every replica with the same roles agrees
without a repair write, and the retype's own moves write the rank the
read gives (`promotedRank`), so a split tail stays after its head. Undo
of the retype (A retypes, B nests Q, A undoes) puts Q back under the
block: its placement never changed. Pins: `p1-scenarios.test.ts`
("capabilities under concurrency"), `review-20260929-units.test.ts`
(UW-21), `p1-fuzz.test.ts` and the `void-children` well-formed check.

### `conc.island-reset` — no island child kind outside its island

A delete or merge of an island block (`del.blocks.promote`, the island
merge of `mergeBackward`/`mergeForward`, and the adopting `mergeBlocks`)
retypes the children it moves out to the default child type of their new
parent. A child a peer adds to the island concurrently was never seen by
that write, so the rule is derived when the document is read
(`placement/model.ts` `displaySlotOf`): a block that displays out of an
island — promoted out of a deleted one, or under the owner of a merged one
— and still has the island's default child type (`codeLine` for a code
block) displays as its display parent's default child. Its stored type is
kept, so undo of the delete or merge shows it under the island again as a
`codeLine`. The rule is real, not only drawn (RW-01):

- a retype of such a block shows the new type (the override applies only
  while the stored type is the island's default child);
- a move of it — drag, Tab, Shift+Tab, `moveBlocks`, a delete of the parent
  it was promoted under, a retype of that parent to a void kind — writes
  the type it shows, so it never shows `codeLine` again outside the island;
- Enter in it (`splitBlock` without a tail) gives the tail the type it
  shows.

Pins: `p1-scenarios.test.ts` ("promoted blocks keep no container-only
kind", RW-01 rows), and the `island-kind` well-formed check (over
`lines` islands, whose line kind belongs nowhere else), held on
settled states by the p1 harness and the corpus's `roles` lane (a delivery
out of causal order may show a moved line before the retype that preceded
it).

### `conc.island-lines` — an island declared `lines` holds only lines

The line rule is opt-in (XW-03). An island kind whose role says
`lines: true` (the bundled `code`, with `defaultChild: 'codeLine'`) holds
lines only, and a line holds no children. Any other island (a table of
rows of cells, a callout with a heading and nested paragraphs) keeps the
structure its interior builds, even when it declares a `defaultChild`.
Undo can break the line rule from outside the island: A deletes or merges
away `C:code > [L1]`, B edits the plain paragraph `L1` has become, A
undoes. The display keeps it (FW-01, `displaySlotOf` and the index's
`typeOf`, derived when the document is read, so every replica agrees
without a repair write):

- a block B nested under `L1` shows right after the code block, ranked in
  the line's order, visible and movable (it was sealed inside a line that
  renders no children). It stays there when `L1` is deleted later: a dead
  line's children take the island's slot too, never the island (XW-10);
- a kind B gave `L1` shows as `codeLine` while `L1` is in the code block,
  and again once it leaves it;
- a line B moved away keeps B's placement and shows as its new parent's
  default child, never as a `codeLine` outside a code block — where that
  default child renders no content (a block retyped `codeLine` directly
  in a columns layout), the document's default kind (ZW-06). The line
  kinds come from the roles, not from the code blocks the document happens
  to hold (XW-11): a line a peer adds to a code block another peer retypes
  to a paragraph shows as a paragraph either way;
- a view follows every kind it derives: a retype reports the shown kinds
  of the promoted and stray lines under the retyped block (XW-08).

The write side agrees: inserting under a line is refused, nothing merges
into an island from outside it (`canMerge`), nothing merges into a block
that renders no content of its own — a code block's first line, a list's
first item, a table row's first cell (XW-12, DR-crdt-2: the facade, room
`transact` and the view all refuse it), and a container never merges as a
whole (`del.merge.container`, YW-02) — a copy (split tail, flow tail,
duplicate) of a block whose type a peer's half-delivered retype left
missing takes its parent's default child, never an empty type (SW7-crdt-1,
DR-crdt-1), and a retype of an island to
an ordinary kind retypes its children to that kind's default child. Pins:
`rescore3-crdt.test.ts` (FW-01, SW-crdt rows), `rescore4-crdt.test.ts`
(XW-03, 08, 10, 11, 12, DR-crdt-1, 2), the `island-kind` check, which also flags a child
under a line and another kind directly in such an island, and the
`sealed-line` check, which flags a block shown in a `lines` island that is
not stored there.

### `conc.merge-adopt` — `mergeBlocks` (`mergeFrom`) keeps the source's children with it

The engine merge adopts `from`'s children as the last children of `into`
by keeping them under `from`, ranked after `into`'s children: they display
under `into` through the merge claim. A concurrent delete of `into` voids
the claim (ST02b), and `from` comes back with its children under it,
never below them (FW-12; `P > [Q]`, `X > [K]`, A `mergeBlocks(X, P)` ‖ B
deletes `P` → `Q X > [K]`). Undo restores the pre-merge tree. Pins:
`review-20260929-units.test.ts` (FW-12) and the `merge-order` well-formed
check (corpus seed 11 was its repro).

### `conc.undo.actor-local` — undo after remote edits

A deletes `bb`; B edits survivor `cc`; A undoes → `bb` is restored AND
`cc` keeps B's edit. Undo is actor-local: it reverts only the undoing
peer's tracked transaction, never remote work. Verified in
`command-simulation.test.tsx`.

### `conc.disjoint-deletes` — disjoint held deletes

A deletes `bb`, B deletes `cc` while partitioned → both converge to the
survivor intersection `["aa"]`.

## Layouts (columns)

A **layout** is a kind whose role says `layout: true` (the bundled
`columns`, `layoutKinds` in `crdt/semantics.ts`). Its default child is its
**item** (`column`): a container that renders no content and holds any
block. The role is data, read by the index and the operations from the
document's roles (`roles.layout`), so replicas with the same roles show
the same thing; no core code names `columns` or `column`. The read-time
rules own the display; every write that would leave one of their states
writes the result the rule shows, at the rank it reads (`promotedRank`),
so a replica that missed the write and one that applied it agree. Pins:
`src/tests/crdt/arch-v2/layout.test.ts` (each row sequential, concurrent
with display equality across replicas, and undone), the `layout-shape`
well-formed check (a displayed layout holds two or more displayed items
and nothing else, no displayed item is empty, no item displays outside a
layout), held by the p1 fuzz's container lane and the corpus's `roles`
lane.

`C` below is `P, C:columns[K1:column[A, A2], K2:column[B]], Z`.

### `layout.fits` — a layout holds only its items

`fits` (`del.merge.container`): a container whose default child is a kind
of its own holds its items, and containers of them only when the item
renders content (a list holds a list directly; a layout holds no layout).
A move into a layout of anything but an item is refused (`canPlace`):
`moveBlocks([Z], {parent: C})` is refused; Tab after a layout nests in its
last column (`nestParent`).

### `layout.only-items` — a layout displays only its items (read)

Any other child a layout holds — a raw `insertBlocks`, a retype of an
item, a race — displays in the layout's parent right after the layout, at
`promotedRank(layout, its rank)`, as the kind it shows there (`typeOf`):
a paragraph stored directly in `C` shows right after it, a code line
stored there as a paragraph (AW-05).

### `layout.empty-item` — an item that displays no child does not display (read)

`C:columns[K1[A], K2[], K3[B]]` shows `C[K1[A], K3[B]]`.

### `layout.single` — a layout displaying one item or none does not display (read)

That item's children display in the layout's slot, at
`promotedRank(layout, promotedRank(item, rank))` — the rank a delete of
both reads (`del.blocks.promote`): `C:columns[K1[A, A2]]` shows `A, A2`
where `C` was; a layout holding nothing displays nothing. Kinds settle as
read-time promotion settles them: a paragraph that lands directly in a
list shows as its item.

### `layout.bare-item` — an item outside a layout does not display (read)

Its children take its slot, at `promotedRank(item, rank)`: a column a peer
adds under a layout another peer deletes, or one a race leaves at the
root, shows its blocks only.

### `layout.dissolving` — the writes that leave those states (write)

In the plan that causes them, one undo step:

- `emptying` removes an item left with no child (`del.range.empty-container`),
  like any container;
- `dissolving` follows: a layout left with one item is deleted with that
  item, the item's children moved to the layout's slot at the
  `layout.single` rank and settled there; one left with none is deleted
  (deleting `B`, the only block of `K2`: `P, A, A2, Z`). The keys, the
  moves, a text range across columns, `mergeBlocks`, a block delete and
  `placeBeside`'s sources all run it;
- deleting an item (a block selection holding it) promotes its blocks
  right after the layout (the `layout.only-items` rank), then dissolving:
  deleting `K2` gives `P, A, A2, B, Z`; a block a peer adds to `K2`
  meanwhile follows `B`;
- deleting a layout deletes it and its items: their blocks take its slot
  in reading order and keep their kinds (no column is retyped to a
  paragraph holding children): deleting `C` gives `P, A, A2, B, Z`; a
  column a peer adds to `C` meanwhile is a bare item, its blocks follow.

A retype is not mirrored: a column retyped to another kind leaves the
layout at read time (`layout.only-items`, then `layout.single`).

### `layout.flow-slot` — a flow over a column's blocks fills their slot (Notion)

Typing, a composition or a paste over a block selection in a column
(`flow.slot`) places its lines in the first selected block's slot before
the delete empties anything: the column is not emptied, so it stays and the
layout with it. Typing over `B`, the only block of `K2`, gives
`C[K1[A, A2], K2[NEW]]`, the caret in `NEW`; over `A, A2`, `C[K1[NEW],
K2[B]]`. A layout pasted there lands as its blocks (`flow.layout`). A peer
deleting `K1` meanwhile leaves one column: it dissolves as any (`layout.single`).
Pins: `layout.test.ts` (`layout.flow-slot`), `columns-replace.test.tsx`,
`columns-parity.spec.ts`.

### `layout.merge` — merges cross columns in reading order (D4, Notion)

- Backspace at the start of an item's first block (`mergeBackward`)
  merges it into the previous shown line in reading order: from the
  second item on, the previous item's last line (`mergeBackward(B)`:
  `A2` becomes `a2b`, `K2` is emptied and goes, the layout dissolves:
  `P, A, A2 "a2b", Z`); from the first item, the line before the layout
  (`mergeBackward(A)`: `P "pa"`, `C[K1[A2], K2[B]]`). An empty block is
  removed, the caret at that line's end. Refused when there is no line
  before, or it takes no merge (`canMerge`: a void, a code line). The
  merged block's children stay in its item, after its slot.
- Delete at the end of an item's last line (`mergeForward`) pulls the
  next item's first line into it; at the end of the line before the
  layout, the first item's first line.
- Backspace at the start of the block after a layout joins the last
  item's last line.
- A text range across columns joins its two ends (`del.range.*`); an item
  it empties goes and the layout dissolves.
- The outdent stays refused (ZW-14): Shift+Tab at an item's last or only
  block would place it directly in the layout. Backspace at the start of an
  item's block never outdents: its first block merges as above, any other
  into the line before it, as anywhere (`mergeBackward`).
- Mod+Shift+↑ at an item's first block, ↓ at its last (a relative move
  step, `up`/`down`), leaves the layout: the block goes before or after
  it, and an item it empties goes, then dissolving (the keyboard's way out
  of a column).

### `layout.nest` — no layout inside a column, by gesture (D2)

A move (`canPlace`: drags, Alt and Mod+Shift arrows, Tab, an outdent, a
drop) refuses to place a layout, or a block holding one, anywhere inside
an item, and `placeBeside` refuses to put one in an item. A paste or drop
inside an item places a layout's blocks instead (`flow.layout`), and the
view's layout commands (`columns.N`) are disabled there. A layout that a
race or an explicit write (`insertBlocks`, a retype) puts inside a column
displays as it is, by the rules above: no flatten.

### `sel.drag.across-columns` — a mouse selection crossing columns selects blocks (Notion, round 8)

While a pointer drag-selection (`selection.dragging`) has its native
range anchored where the press landed, in an item, and its focus in
another item of the same layout (the innermost layout holding both in
different items decides; `acrossColumns` in
`selection/replaceSelection.ts`, from the roles), the value is a block
selection: every shown block from the anchor's block to the focus's, in
reading order, but layouts and items, each a member as `selectedMembers`
reads it — so a sweep over every block of every item lifts to the layout
(`liftLayouts`, D3). The adopter (`applySelectionSnapshot`) selects it
with cause `dom`: the projector writes nothing under the drag, the
browser keeps extending the native range from the press, and the root's
`data-edytor-selection="blocks"` hides that range's highlight. Back in
the anchor's item, the same drag is a text range again. The release keeps
the block selection and asks one display, which clears the native range
(a block selection shows none); delete, cut, copy and typing then act on
it as on any block selection (`sel.blocks.exact`, `layout.flow-slot`). A
drag anchored outside every layout (it enters one), a drag leaving the
layout, a Shift+click (its range is anchored before the press) and the
keyboard (D7) keep text ranges in document order. Pins:
`columns-drag-select.test.tsx`, `columns-round8.spec.ts`.

### `layout.wrap` — `wrapInLayout(ids, kind?, columns?)`: Turn into N columns (Notion)

Sibling blocks (one or more) are wrapped in a new layout of `columns`
items (default: one per block; at least two, and at least one per block;
the view offers two to five) of the layout `kind` (else the only one the
roles declare): the blocks one per item in document order, at the first
one's place, with their children, then each further item holding one
empty block of the item's default child (a paragraph); one plan, one undo
step, plain ranks (a move): over `P, Q[Q1], R`, `wrapInLayout([P, Q, R])`
gives `NEW[NEW[P], NEW[Q[Q1]], NEW[R]]`, and `wrapInLayout([Q], _, 3)`
gives `P, NEW[NEW[Q[Q1]], NEW[NEW], NEW[NEW]], R` (one block turned into 3
columns); over `C`'s document, `wrapInLayout([P, Z])` gives `NEW[NEW[P],
NEW[Z]], C`. Nested siblings wrap where they are (a toggle's body).
Refused for no block, fewer than two items or fewer items than blocks,
blocks of different parents, an item, a layout or a block holding one
(D2), where the layout does not fit (`fits`: list items, a code block's
lines) or would sit inside an item (D2) or an island, and without a
layout kind. A peer's edit in a wrapped block lands in its column. The
view: the block menu's Turn into lists "N columns" over a block selection
of N sibling blocks, and "2 columns" to "5 columns" over one block
(`EditorCommand.turnsInto`); hooks see `wrapBlocks`; the blocks stay
selected (one block: no caret moves into the empty columns).
Pins: `layout.test.ts` (`layout.wrap`), `columns-turn-into.test.tsx`,
`columns-parity.spec.ts`.

### `layout.place-beside` — `placeBeside(ids, target, side, kind?)`

Blocks dragged to the left or right edge of another block. One plan
(`prepare.placeBeside`), one undo step, plain ranks (a move: not ranked by
source, `order-scope.test.ts`).

- The target resolves to its container only when its parent shows only
  its children (a list item → its list, at any depth) or is an island of
  lines (a code line → its code block). Any other block stands for itself
  where it is — a toggle's, a callout's or a nested block's child is
  wrapped inside its parent (`placeBeside([Z], T1, 'right')` under a
  toggle `T[T1, T2]`: `T[NEW[NEW[T1], NEW[Z]], T2]`) — when a layout fits
  there (`fits`, outside any item and island, D2); else it resolves to its
  outermost block below the root or below an item (a toggle's child in a
  column: a new column beside that column). A target that is an item
  stands for itself; a layout for its first (`left`) or last (`right`)
  slot. The view's beside bands read the same resolution (`besideAt`).
- That block directly in an item: a new item holding `ids` goes beside
  that item (`placeBeside([Z], A2, 'right')`: `C[K1[A, A2], NEW[Z], K2[B]]`).
  Otherwise the block and a new item holding `ids` are wrapped in a new
  layout of the document's layout kind (`kind`, else the only kind whose
  role says `layout`) at its place (`placeBeside([Z], P, 'right')`:
  `NEW:columns[NEW[P], NEW[Z]], C…`).
- Refused when `ids` holds the target or an ancestor of it, holds an item,
  a layout or a block holding one (D2), when a block does not fit an item,
  when a block or the target's layout is inside an island, and, wrapping,
  when the document has no layout kind (or `kind` is none).
- The sources are cleaned in the same plan (`emptying`, `dissolving`):
  `placeBeside([B], P, 'right')` gives `NEW[NEW[P], NEW[B]], A, A2, Z`.
- Concurrency is the read-time rules': two peers placing beside one
  target each wrap it; the target lands in one wrap, the other shows one
  item and dissolves (the order of the two is not claimed). Undo
  withdraws the new layout and items (`hist.undo.withdraw`): a block a
  peer put in a new column meanwhile keeps it, and that column, alone,
  dissolves into the layout's slot.

## Anchor contract

A selection endpoint anchor (`DocAnchor` = `{b, a}`: `b` the home block of
the backing text, `a` an engine relative position) carries four separable
facts; implementations and oracles must keep them distinct:

- **Visible position** — owning block, inline/text boundary, offset.
- **Insertion affinity** — which side of an insert _at_ the position the
  endpoint stays on. `a.a < 0` = left insert-affinity (caret stays left of
  same-gap inserts); `a.a >= 0` = right.
- **Causal identity** — which existing atom or boundary the endpoint
  follows through edits (`a.i` binds the backing atom).
- **Structural relocation** — what happens when the owning block splits,
  merges, moves, or dies.

Required semantics:

1. A caret in a surviving block must not migrate into a different
   surviving block merely because that neighbor received text — including
   blocks sharing one backing text and empty-block boundaries.
2. An insert before a caret shifts its offset; an insert exactly at a
   left-associated caret stays to the caret's right. Block-start
   ownership never reverses that affinity.
3. When a merge moves the caret's content into another block, the caret
   follows its atoms to the correct merge offset.
4. When the selected content provides no destination, recovery follows
   the documented seam fallback — an unresolvable incoming anchor is not
   proof of a deleted destination.
5. Collapsed carets, range starts (`'right'` — bound to the first atom
   inside), and range ends (`'left'` — bound to the last atom inside)
   have explicit boundary semantics. One dead endpoint with a resolvable
   survivor collapses the range to the survivor; neither resolvable plus
   a dead endpoint lands at the start block's seam, then the root's
   first editable text.
6. Same-block text-part boundaries at one editable gap are
   interchangeable (wrappers may normalize); different blocks or
   opposite sides of an inline atom are not.

**Block starts (`sel.anchor.seam-owner`, arch-v2 D12).** Text ownership is
streams delimited by boundary items (plan §2.1, R2): a split-born block's
stream starts right after its boundary item in the text it was split from.
A left-affine caret at such a block's start binds that boundary item, so
the containing stream and the side are two facts in two fields — no owner
facet: an insert into the _left_ neighbour at the shared gap lands before
the boundary, in the neighbour's stream, and never pulls the caret across.
Resolution finds the stream holding the resolved index (the one whose
delimiting boundary precedes it) and its display owner; a stream whose
block is deleted or hidden resolves `null` and the caller takes the seam.
A streamless block (its boundary died with its host text) binds the start
of the own text its first typing creates (`{b: block, a: {i: null}}`).

## Selection ownership and lifecycle

- **The projector is the only DOM-selection writer** (`surface/projector.svelte.ts`,
  arch-v2 V4): `post()` after every flush, and `park`, the one write made
  while a composition is live (the caret a composition over a block or
  atom selection gets before the IME writes). The named exceptions are
  listed in AGENTS.md (Surface, DOM selection exceptions): a snapshot read
  replaces a multi-range selection (Firefox) with its bounding range
  (`selection/domSelection.ts`), and a few sites clear it
  (`clearDomSelection`). There is no deferred selection write: every writer —
  commands, input attempts, history, host code — `select()`s its value in
  its own turn, and the projector writes the **current** value after the
  Svelte flush, so an older request can never overwrite a newer gesture
  (including one that picks the same numeric offset).
- Three named writes still select after a wait, and each checks the gesture
  serial after it, on every exit, yielding to any gesture since
  (independent review 2026-09-29): the observer's adoption caret after its
  render tick (`surface/observer` `adopt`, the P2.3 pin), the observer's
  next-task redisplay after a root heal (`#refocus`), and the drift
  repair's caret after its discard wait (`events/onInput` `repairDrift`).
  A new deferred write needs the same check and a row here.
- While a requested display has not landed, a `selectionchange` with no
  intent gesture since the request is not adopted. The one gesture serial
  is `Edytor.intentSerial` (pointer, focus, key, `beforeinput`, cut,
  paste, drop — not `input`, which records what the browser did). A
  native move no handler observed is minted before the next foreign
  transaction (BI-3) and admitted through `select(…, 'dom')` after it
  commits.
- Programmatic focus caused by the projector's display is not a new gesture.
  History-restore and composition ownership remain separate lifetimes.
- **Model destination and DOM readiness are separate facts.** A valid
  destination whose text wrapper has no DOM node yet is _not_ "no
  recovery": it stays the selection value, and the projector's pass after
  the flush that mounts it displays it (a value that no longer projects
  runs the seam repair; a text mount or the observer's records re-run a
  pass while a display waits). The seam's displayable filter still skips
  phantom slots.
- Hidden container text and temporarily-unmounted editable text differ:
  a phantom is a container's own content part that never renders; an
  editable text may lack a node only inside a settle window. At a
  settled barrier, `part.node == null` means phantom.
- After settlement, endpoints reference live editable content with
  correct owner and bounds; follow-up input reaches it without a harness
  selection reset.
- Fallback order (see `sel.seam.slot`): surviving **forward** editable destination, then
  backward, then the documented root/first-editable destination —
  traversing past noneditable descendants and siblings at every level.

### `sel.drift.churn` — render churn under a live caret

A commit's render can move the DOM selection under a live caret (a node
re-split, a moved block's element re-created; Gecko re-parks the caret
at the surviving boundary). The projector (`surface/projector.svelte.ts`,
arch-v2 V5) classifies every `selectionchange` against its last display,
the render epoch (a flush after which the DOM selection was not
observed, or records the observer has not reconciled) and the gesture
serial: an unchanged last display is an **echo** (ignored); a move with
no gesture since the last observation after our own render is **drift**
(the current value is displayed again); a move while a composition is
live is the IME's; a gesture or a drag is **intent** (adopted); anything
else is a **foreign** write (adopted). The two named, time-bounded
signatures are the Android post-delete snap-back (250 ms) and the IME
post-commit jump (100 ms), compared at use — no timer.

Harness contract: DOM-first selection placement IS a user decision —
fixture/harness paths that write the DOM selection directly
(`setNativeSelection` in `src/tests/dom/test.utils.ts`, the playwright
helpers in `tests/editor-*/`) call `edytor.markUserGesture()` first, or
the classifier reads their synthetic `selectionchange` as drift.

## Host DOM ownership (D-25)

The host renders a pure function of the model and declared view state;
the compare-to-truth observer (`surface/observer.svelte.ts`, arch-v2 R7)
is the only interpreter of DOM changes.

- **Strict regions** — only the editor writes them: the root's children,
  every text and core mark element, and a block's own text/atom run (the
  nodes between two registered text/atom elements of one content). A
  foreign node there is removed; foreign text inside a content is browser
  input and is adopted through the dispatcher unless an expectation
  claims its host (composition tail, pending structural key, model-owned
  drift — then the cell is restored); structure is restored from the
  cell; identity clones are removed without adoption.
- **Tolerance** covers only a kind's own markup **around** the content and
  children slots (a callout icon, a code block header, an extension's node
  beside the slots) and attributes the ownership table
  (`surface/attributes.ts`) does not list (`open` on a native toggle, an
  extension's `id` on a block element). The editor never inverts them.
- The live composition host is the IME's; read-only divergence is
  restored when the view becomes editable again; divergence during an
  open model-owned attempt window waits until the window closes.

## Oracle and checkpoint contract

- The wire-replay reference proves delivery/convergence, not editing
  intent.
- Production anchor resolution is an integration check; independent
  expectations (exact content, seam topology, joint range shapes) must
  exist so a resolver and caret agreeing on the wrong block still fail.
- Inventory facts are derived independently: text lengths from
  enumerated live `content`, ownership from containing-block traversal,
  editability from mount state — never from the selected wrapper's own
  `length`/`parent` pointers, which are checked _against_ the inventory.
- Selection presence and shape are checked across every delivery
  boundary — edits, release, reconnect, heal, killRoom. A `reload`
  resets its baseline explicitly. An initially unselected peer need not
  acquire one.
- A command's result includes its settlement-class deferred work:
  local settle → independent assertion → remote delivery → remote
  settle. Settlement crosses a real task boundary before inspecting
  tracked queues (finite chained microtasks must finish registering
  work); nonsettling work fails at a bound, not by waiting forever.
- Declared time sources: the timer spy, rAF, and cancellation are
  settlement-class; long policy/persistence timers are tracked and
  reported as out-of-horizon, excluded from deterministic fingerprints.

## Responsibility map

| Concern                           | Owner                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Anchor mint/resolve               | `facade.anchorAt` / `facade.resolveAnchor` (`src/lib/crdt/edytor-doc.ts`)                                                                              |
| Engine relative positions         | vendored Yjs v14 (`anchorAt`/`resolveAnchor` in `src/lib/crdt/text/model.ts`)                                                                          |
| Logical recovery destination      | `selection.restoreDeadSelectionEndpoints` + seam walk (`src/lib/selection/selection.svelte.ts`)                                                        |
| Editable-destination traversal    | `Block.firstEditableText`/`lastEditableText` (`src/lib/block/block.svelte.ts`)                                                                         |
| DOM mount readiness → display     | projector pass after the flush that mounts the text; a text mount or the records signal re-runs a waiting pass (`src/lib/surface/projector.svelte.ts`) |
| DOM-selection write (only writer) | `projector.post()` after every flush, current value; `park` under a live composition; writers `select()` in their own turn; exceptions: AGENTS.md      |
| Gesture serial (one)              | `Edytor.intentSerial` via `markUserGesture` (not bumped by `input`)                                                                                    |
| `selectionchange` classification  | projector `classify` (echo / drift / composition / foreign / intent; two named browser rules)                                                          |
| Unobserved native move            | projector BI-3: mint in `beforeTransaction` of a foreign transaction → `select(…, 'dom')` after commit                                                 |
| Remote anchor validation          | `isTextAnchor`/`resolvePeerSelection` (`src/lib/collaboration/awarenessSelection.ts`)                                                                  |
| Presence wire/equality            | `publishPresence` under the view's own `presenceKey` (`jsonValuesEqual` dedupe, `awarenessSelection.ts`)                                               |
| History selections                | per-view `{before, after}` values in stack-item `meta` (`src/lib/session/history.ts`)                                                                  |
| DOM change interpretation         | compare-to-truth observer + attribute table (`src/lib/surface/observer.svelte.ts`, `attributes.ts`; D-25)                                              |
| Independent oracle                | `src/tests/oracles/truth.ts`, `selectionOracle.ts`, `deleteOracle.ts`, dump inventories in `collab-runner.ts`                                          |
| Settlement checkpoint             | `command-peer-set.ts` `quiesce()`                                                                                                                      |

## History

### `hist.dead-pop` — obsolete undo items

`UndoManager.popStackItem` may consume a dead/obsolete stack item (entries
neutralized by remote edits) without applying a change or growing the
opposite stack. The legal oracle is **source stack shrank OR opposite
grew** — not both. A dead command shows neither and still fails.

## The room (server, `edytor/cloudflare`)

Rows of the room's own storage and admission (Phase 2 of the 2026-10 CRDT
study, `docs/research/crdt-fix-plan-2026-10.md`). Pins live in `tests/do`.

### `room.compact.live` — compaction stores the live state (P2)

A compaction replaces the rows with one snapshot of the room's live
document, `encodeStateAsUpdate` with the engine's pending store set aside
(`liveState`, `withoutPending`): the healed state, where the engine merged
what each keystroke wrote and collected deleted content. It is never a
merge of the records, which keeps every keystroke's struct and every
deleted character (`automerge-paper`: 6.69 MB merged, 1.60 MB live).
Memory never runs ahead of storage, so the live state is exactly what
the records hold, collected: a reload holds the same state vector,
delete set, encoding and JSON (`p2-live-compaction.test.ts`). A load
applies the records in one transaction, never merged first.

### `room.compact.waiting` — what waits stays apart (P2)

Structs waiting for a dependency are never stored (the engine's
`pendingStructs`), so compaction leaves them out; when the dependency
arrives, they integrate and are stored with it, and a reload holds them.
Deletes of items the room lacks stay in their own `pending` record,
compacted to the ones still waiting (site `server/room#storage`).

### `room.compact.copies` — the room keeps what a replica may copy again (P11)

The room's document applies the text-delete `gcFilter` from its creation
(`crdt.doc.keepCopies`, before any update applies, on a fresh, restored or
`onLoad` document): a deleted restoration copy keeps its content, as on an
editing replica, so the live state, its Step2 and its snapshot hold the
text a peer's undo may copy again. Before Phase 2 the room's live document
collected it (its Step2 served the copy deleted) while the merged records
still held it.

### `room.store.v2` — snapshots in v2, compressed, tagged (P5)

A container's generation record carries its storage format (`storage`,
absent = `'v1'`, the only format before 0.1.0-next.23). This build writes
`'v2'`: snapshots in the v2 encoding (`encodeStateAsUpdateV2`), gzip-
compressed where the platform has `CompressionStream` (a compressed
snapshot starts with `1f 8b`, a v2 update with `00`); update and waiting
records, and the IndexedDB store's update rows, stay v1, which is smaller
for one edit (24 against 28 bytes for a keystroke, 13 against 24 for a
one-character delete). The room compresses a snapshot in place after
storing it raw (`compressLater`; the store-before-ack path is
synchronous) and inflates it when it starts (`inflate`), keeping the raw
bytes for a rebuild. A v1 container loads as it is, takes v1 update
records, and is rewritten in v2 by its next compaction (`p5-storage-v2`,
`storage-v2.test.ts`). The IndexedDB store writes a snapshot as an
object row `{ v2 }`, which a build before 0.1.0-next.23 refuses to read
(its row codec throws) instead of misreading. The wire stays v1.

### `room.generation.convert` — a generation-4 container converts through its JSON (Phase 4)

Schema generation 5 (wire word `14005`) changes what a document stores
(paired marks, shorter ranks): bytes of generation 4 are never integrated
beside generation 5's. A room loading a container whose generation record
is generation 4's reads its records into a scratch document (no admission,
no write), takes its visible document as JSON
(`crdt.generations.previousJSON`) and seeds it as generation 5's (the
deterministic seed `onLoad`'s JSON gets), replacing the container in one
storage transaction (rows, replicas, purge epochs, slot editors and the
stored restore go; meta stays). A history version of generation 4 reads
through the same JSON. A frame of generation 4 is refused before decode
(`1008`, `refused: generation`); a container of any other generation is
refused until `reset()`. A browser store of generation 4
(`edytor-v14:<name>`) is left as it was beside the new one
(`edytor-v14-g5:<name>`): a document stored only there converts into it
(`convertPrevious`), one a room keeps takes the room's state
(`gen5-cutover.test.ts`, `tests/do/gen5-cutover.test.ts`).

### `net.step2.v2` — a SyncStep2 is v2, an Update v1 (P5 wire)

A SyncStep2 carries a state and is written in the v2 encoding
(`writeSyncStep2`), converted to v1 on receipt (`step2Update`) before the
one inbound path; an Update carries one transaction and stays v1, which is
smaller for most single edits. Measured (1,000-block document, 53-bit
client id): a full Step 2 280,557 → 220,444 bytes (gzip 55,016 → 28,476);
a keystroke 60 / 60, a one-character delete 13 / 24, a block move 62 / 84,
a block delete 43 / 65, an Enter 355 / 293, five keystrokes merged
114 / 53 (v1 / v2).

### `room.quota` — a write past a quota is refused, the socket closed `4413` (H3)

Three quotas, each a `vars` setting and an `attachDocument` option:
`maxDocumentBytes` (64 MiB: what the records hold, uncompressed, plus the
engine's waiting structs; checked after compacting the update records,
net of the content the frame deletes, so a frame that deletes at least
what it adds always applies), `maxUpdatesPerSecond` (50 sync messages a
second per socket, a token bucket with a ten-second burst; every sync
message counts, a Step1 too) and `maxInboundFrameBytes` (64 MiB, one
frame reassembled; a chunk sequence announcing more is refused at its
start). A frame past one is not applied, logged `quota`
(`{ user, quota, … }`), and its socket closed `4413` (`quota: <name>`,
`CLOSE.quota`, a refusal by `isRefusal`): the provider emits `refused`,
the document records `syncRefusal`, and nothing redials. Not a drop on a
live socket (the sender's later frames would wait on the dropped one in
the room's memory, unacknowledged, for good), not a redial (it resends
the same frame into the same quota). Pins: `h3-quotas.test.ts`.

### `room.marks.writer` — only `n` writes or deletes `del.<n>` / `wd.<n>` (H2)

A per-writer block mark (`del.<n>`, `wd.<n>` on a block node, R3 and
`hist.undo.withdraw`) is written only by structs of client `n`, and
deleted only by a frame whose sender owns `n` (its replica, or an id its
user registered). A frame struct whose key (resolved through its left
origins, in the frame or the room) is another client's mark on a block
node strips that client's new structs from the frame, as structs under
another user's id are (`forgedWriters`, with the deletes of the entries
they replace); a delete of a live mark the sender may not delete is
dropped from the frame's deletes (`forgedDeletes`), unless the mark's
block node is deleted too. Both are logged `mark`
(`{ user, writers, ranges }`); the rest of the frame applies and the
socket stays (`h2-validation.test.ts`). The room's own writes
(`transact`, a compensation) are not checked.

### `room.validate.inverse` — a denied frame is undone by the room (H2)

With `validate` set, after a client frame that changed blocks is applied
and stored (relayed, its waiting deletes settled), the room asks it with
`{ user, replica, touched, dataChanged, before, after, facade }`:
`touched` from the facade's change report (added and removed blocks with
their subtrees, a new display parent, a move among siblings that leaves
the longest kept run — not a shift caused by a sibling —, a type or data
change, a content change); `before`/`after` read `{ id, type, data,
content, parent }` from an index the room keeps from every change report.
`false` or a throw denies (logged `denied`, `{ user, touched }`): the room
writes the inverse as its own transaction — the history undo of exactly
that frame's transaction (a history on the room's facade whose tracked
origin is the frame's socket, released after each frame by P6's rule,
`facade.releaseHistory`, so it keeps no deleted content alive): its inserts
deleted (its creations withdrawn, `hist.undo.withdraw`), its deletes
restored (text by copy where no other writer's delete mark holds it,
P11; its block delete marks removed), its moves and attr writes reverted
(`repairAttrs`). Nothing else is between the frame and its inverse, so
it reverts exactly that frame. The inverse is stored and sent to every
socket, the sender's included: every replica converges. The frame stays
stored and acknowledged; the socket stays open (`h2-validation.test.ts`,
per-block locks as `LockedRoom`).

### `room.validate.bootstrap` — a denied first seed is deleted (H2)

A frame applied while the room's document was not initialized (the
first seed) has no history recording it (a history first initializes
its document): its denial deletes the blocks it added
(`prepare.deleteBlocks`, one room transaction); its bootstrap (the schema
stamp) stays.

### `net.chunk.outbound` — a backlog of any size reaches the room (H6)

The provider sends a frame larger than its `maxFrameBytes` (32 MiB,
Cloudflare's message limit) as a chunk sequence (`chunkFrame`, every
binary frame it sends on the socket: the hello, replies, updates), the
room reassembles it per socket (`createChunkReader(maxInboundFrameBytes)`,
the frame quota checked at the sequence's start) and admits the whole
frame as any other; a part or end with no sequence started (a wake lost
the buffer) closes the socket `1011` (`chunk sequence lost`) and the
provider resends at its redial. A 40 MB offline backlog is delivered at
reconnect and served to a fresh client (`h6-chunking.test.ts`). The image
plugin stores no inline image over `MAX_INLINE_IMAGE_BYTES` (1 MiB of its
`data:` URL): the link field refuses it and names `upload` (or a hosted
link), an HTML paste does not import it (`storableImageSrc`); rendering
still shows a larger one a document holds (`image-inline-cap.test.tsx`).

### `doc.hydrate.first` — seed nothing until fetched once (H12, opt-in)

With `requireHydration` (`DocumentOptions`, `<Edytor requireHydration>`),
the readiness decision (`_decide`) leaves an EMPTY document `pending`
unless a provider's `synced` triggered it: a bound or a failure never
seeds `value`, so a first visit offline writes no seed (which a
different seed in the room would later meet as duplicate blocks); a view
refuses every command while the document is pending (`dispatcher.permits`).
A document holding content decides as before; an explicit `sync()`
decides. `prefetch` (sync a local store once, both ways, then close) and
`lastUpdated` (the room's last stored change, one authorized HTTP probe)
keep documents fresh before a device goes offline
(`require-hydration.test.ts`, `h12-offline.test.ts`).

### `room.alarm.tasks` — one alarm, the earliest due task (Phase 3)

The room has one Durable Object alarm and three tasks on it: `save`
(`onSave`, `saveAfter` after the first unsaved change; while the rows
cannot be read, again later, up to 5 minutes), `history` (the open
half-day slot's end, `room.history.slots`) and `purge` (the daily tick,
`room.purge.timing`). Each task's due time is stored in the meta table
(`due.save`, `due.history`, `due.purge`), so a wake knows what is due;
arming a task keeps an earlier due time (a wake or an edit never pushes a
pending save back). The alarm runs every task due at its time, each
re-arms itself or clears its row, then sets the alarm to the earliest due
time left (none: no alarm). A start that finds a due time already past
leaves it to the alarm, but a slot past its end is written at once
(`room.history.slots`). An alarm armed by 0.1.0-next.23 (no due rows)
counts as a due save at its time. The scheduler is the only writer of the
alarm (`schedule`, `alarm` in `cloudflare/DocumentRoom.ts`).

### `room.history.slots` — two snapshots a day, only when changed (H11)

With `history` (`{ store, retentionDays = 30, timeZone = 'UTC' }`, a KV
namespace or any `KVLike`), a date has two slots in `timeZone` (IANA, read
with `Intl`): `am` covers what the room stores before 12:00, `pm` until
24:00. A slot opens at the first change the room stores in it (a client
frame, a `transact`, a restore, a purge), recording each writer's verified
user (`editors`); it closes at its end, by whichever comes first: the
alarm at the boundary, the first write after the boundary (its snapshot
is read before that write applies, so it holds the slot's state exactly),
or a start that finds it past its end (a room that slept through the
boundary writes it at wake). Closing writes one KV value; a slot nobody
changed writes nothing. Key: `history/<room>/<YYYY-MM-DD>-am|pm`, the room
id percent-encoded (`encodeURIComponent`, so a `/` in an id never shares
another room's prefix; a key past KV's 512 bytes is refused, logged
`history`).

### `room.history.value` — what a slot stores (H11)

The value is the room's live state, `liveState` (v2, pending set aside),
gzip-compressed (`packed`), the bytes a compaction stores. Its KV
metadata is `{ bytes, blocks, editors, at }` (stored bytes, visible
blocks, the slot's users, when it was written), kept under KV's 1,024
bytes by dropping the last editors and counting them (`more`).
`expirationTtl` = `retentionDays` days. A value over KV's 25 MiB is not
written: the slot is skipped, logged `history` (`{ key, bytes, limit }`),
and the next slot tries again. It is never split: KV writes parts one by
one, so a failure between two would list a version that cannot be read,
and a compressed state past 25 MiB is beyond the document quota's 64 MiB
of uncompressed records unless it holds incompressible data, which
belongs in an upload store. A failed write is logged `history` and the
slot stays open (retried at the next alarm).

### `room.history.restore` — restore is a forward edit (H11)

`restoreHistory(key, { user })` reads the slot (only this room's keys) and
makes the visible document equal to it in ONE room transaction
(`RESTORE_ORIGIN`): stored, relayed, one step of the room's restore
history. Ids are kept wherever the registry still holds them:

- a snapshot block whose node exists keeps it: its delete and withdraw
  marks are removed, a merge claim another block holds on it is removed,
  its type and data are written only where they differ (per leaf);
- its content, when it differs from the snapshot's: its own merge claims
  are removed, then its own stream's text is replaced through the
  per-stream delete and insert, keeping the common prefix and suffix
  (unchanged text keeps its identity: carets and attribution stay);
- its place: under its snapshot parent, in the snapshot's order; the
  longest run of the parent's children already in that order stays, the
  others get a new placement candidate between their neighbours;
- a snapshot block the registry no longer holds (purged, possible only
  when `purgeAfterDays` is shorter than the retention) is created;
- every other visible block gets the room's delete mark; the document's
  data is patched to the snapshot's.

A client edit concurrent with the restore merges as any concurrent edit
(text typed into a block the restore rewrites stays). `user` is recorded
(the slot's editors, the log), never written as attribution.

### `room.history.undo` — undo of the last restore (H11)

`undoRestore()` writes the history undo of exactly the last restore's
transaction, as `room.validate.inverse` does: its inserts deleted (blocks
it created withdrawn, `hist.undo.withdraw`), its deletes restored (text
by copy where no other writer's mark holds it, P11; marks it removed
written again), its attr writes reverted (`repairAttrs`). Edits made since
the restore are kept: it is an undo, not a restore of the earlier state.
The step's insert and delete sets are stored (table `restore`) and the
content it deleted is kept from collection (the room document's
`gcFilter`, installed before any update applies) until the step is
undone, replaced by the next restore, or older than the purge horizon; a
woken room rebuilds the step from the table. One level: a second
`undoRestore` is a `noop`.

### `room.purge.timing` — when the room saw a delete (H7)

The room's `purge` task runs at most once a day (armed by the first
stored change, re-armed daily while an epoch waits to pass the horizon):
it records an epoch, the room's state vector and the time (table
`epochs`), when the document changed since the last one. An item the
room stored before an epoch's time has a clock below its vector. The
horizon is the newest epoch at least `purgeAfterDays` old (default: the
history retention, 30 days without history; `false` turns purging off).
A deletion's time is the room's storing of the struct that made it: a
block's oldest live delete (or withdraw) mark, a text delete mark record,
a placement candidate. Content deleted before the horizon is purged, so
deleted content goes within two days of passing `purgeAfterDays`; epochs
older than the horizon are dropped.

### `room.purge.what` — real deletes, written by the room (H7)

The purge is one room transaction (`PURGE_ORIGIN`, tracked by no
history), relayed like any edit, so every replica applies it and the
engine collects the content everywhere (`crdt.doc.purge`):

- a block deleted before the horizon (a live `del.*` mark that old, or a
  hidden withdrawn block whose `wd.*` mark is, holding no claims) is
  removed — its registry entry deleted, with its attribution record and
  every claim naming it — when its whole text family (the backing text it
  owns or streams in, and every block with a stream in that text) is
  removable and no remaining block is placed under it; the engine then
  collects its node: attrs, data leaves, placement candidates, claims,
  backing text;
- any other block deleted before the horizon keeps its node: its own
  stream's text is deleted (per stream, boundaries kept, so the stream
  still delimits and stays hidden), with its data leaves and claims;
- a text delete mark record older than the horizon is deleted; a
  restoration record older than it whose copies are all deleted and held
  by no remaining mark is deleted, and those copies collected;
- a block whose winning placement candidate is older than the horizon
  and accepted drops its other candidates (the runner-up);
- the horizon record, root `horizon`, attr `h` = `{ at, sv }`, written
  last.

The room then collects what it kept (a restore step past the horizon
released) and compacts. Only the room writes the `horizon` root: a client
frame writing or deleting it is stripped (`mark`).

### `room.purge.stale` — a replica older than the horizon reconnects (H7)

A replica offline past the horizon reconnects as any replica, with no
close code of its own: its update integrates (an item whose parent the
purge collected integrates as a collected struct, `getMissing`; an item
inserted into a purged stream lands in that dead stream, hidden; a move
under a removed block resolves to the root, as for a parent never
integrated). Its edits to live content are kept; its edits inside content
deleted before the horizon are dropped on every replica (the room's
Step2 carries the deletes, the replica applies them). Residuals: a stale
split of a block deleted past the horizon rescues no text (ST02a's tail
is purged), and a stale replica's own undo of a step past the horizon,
made before it heard the horizon, is an edit like any other.

### `hist.purge.horizon` — an undo older than the horizon restores nothing (H7)

When a horizon record arrives, every history on the document drops (and
releases, P6) each undo or redo step whose inserts all lie below its
vector: an undo of a step the room stored before the horizon restores
nothing (`dispatcher.last` is `noop` when nothing else is left to undo,
`applied` for a newer step). A purge transaction never triggers a
pending P11 restoration: `react` skips the marks it releases, and drops
the pending characters no mark holds any more.

## Transport / evidence

### `net.delete-only-leak`

Insertion clocks (state vectors) can be unchanged by a deletion; partition
checks must use accepted-update/delete-set evidence. A delete leaking
through a partition must fail even when the receiver's state vector is
unchanged.

### `net.held-authored`

A held window must prove **two distinct peers authored updates**
(own-client clock growth or witnessed deletion state), not merely that two
actions were scheduled — actions may be legal no-ops.

## Out of scope for this document (assigned lanes)

- Word/soft-line/hard-line boundary discovery: the delivered
  `targetRange` locates the caret edge (`del.unit.caret-edge`); the
  delete extent is always model-computed (`del.unit.model-boundary`).
  Native chords and visual line breaks remain browser-owned (U4).
- Native composition deletion, focus theft, painted carets: browser lane.
- Undo/redo selection restoration beyond `hist.dead-pop`:
  `src/lib/session/history.ts` (per-view `{before, after}` values) and the
  history fixtures own the details.

## Boundary matrix (recorded coverage)

Each row names the crossed boundary and the pin that carries it. Two
replicas for every conflict row; the three-peer and history rows are
separate pinned programs.

| Boundary crossed                               | Pin                                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| block-start ownership × adjacent remote insert | `a split-start caret stays in its block through an adjacent-block append` (anchors.test.ts) + mounted-replica pin (command-simulation.test.tsx: caret at `Hello@0`, remote `X` append to `alpha`, local `Z` → `alphaX`/`ZHello`)                                    |
| block-start ownership × same-gap remote insert | `a split-start caret keeps left insert-affinity` — remote insert lands to the caret's right                                                                                                                                                                         |
| block-start ownership × composition            | `replaces intermediate composition text at a fresh split block start` — `alpha\|Hello` split, compose `n`→`に`, result `にHello`                                                                                                                                    |
| block-start ownership × remote merge           | `…follows its facet into a remote merge` (backward) and `…through a remote mergeForward` — the bound boundary's stream now displays in the claimer                                                                                                                  |
| block-start ownership × predecessor deletion   | `…survives deletion of the predecessor's last atom` and `…of the whole predecessor block`                                                                                                                                                                           |
| block-start ownership × block move             | `…stays in its block when the block is moved`                                                                                                                                                                                                                       |
| block-start ownership × empty-in-place         | `…lands in its own block when the destination empties in place` — live block, no atoms → `{block, 0}`, no neighbor migration                                                                                                                                        |
| block-start ownership × serialization          | `a split-start anchor binds its boundary item and survives JSON round-trip` (`{b, a}` only)                                                                                                                                                                         |
| recovery topology × nested/non-editable        | `list(divider, gamma)` → caret in `gamma`; container ending in divider → previous editable end (command-simulation.test.tsx)                                                                                                                                        |
| recovery topology × whole-document deletion    | remote whole-doc delete → the kept head is the seam; the caret on dead `beta` lands in it, `insertText("Z")` reaches it (command-simulation.test.tsx F2); a destination that mounts after the flush is the virtual paragraph (contracts-virtual-paragraph.test.tsx) |
| range recovery × one dead endpoint             | joint-shape oracle: collapse to the resolvable survivor (selectionOracle.ts + browser-state-oracle.spec.ts)                                                                                                                                                         |
| range recovery × both dead                     | seam walk on the start block's live/dead status → root first-editable fallback                                                                                                                                                                                      |
| display ownership × newer gesture              | the projector writes the current value after the flush; a later `select()` in the same turn wins (arch-v2-v4-projector F-S1, elegance-selection D7)                                                                                                                 |
| display ownership × unmounted destination      | the value waits; the pass after the flush that mounts the text displays it (arch-v2-v4-projector F-S9, arch-v2-v3-seam)                                                                                                                                             |
| affinity × character identity                  | `remote insert AT the caret respects affinity`, `deleted atoms resolve to the gap`                                                                                                                                                                                  |
| three-peer held release                        | command-simulation.test.tsx three-peer program: B holds selection, A deletes the destination, C edits unrelated content; both legal release orders preserve C's content and B's continuation                                                                        |
| history independence                           | `a seam caret behaves identically whether its block was split or built directly` — equivalent structures via different histories, explicit identity mapping, sequential edits, semantic comparison                                                                  |

Stale-length, dead-textId, mismatched-parent-claim, phantom-target, and
lost-selection corruptions are rejected by canaries in
`tests/editor-dst/browser-state-oracle.spec.ts` — every canary is verified
to fail for its intended reason against synthetic dumps, while the
matching valid-case controls pass.
