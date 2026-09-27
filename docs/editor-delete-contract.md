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
  (head type/id wins). Head dies iff its prefix is empty; tail dies iff
  its suffix is empty. `[a@1→b@1] → "ab"`, `[a@1→c@1] nonadjacent → "ac"`,
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

`a@0 → c@2` over three flat blocks → `[paragraph ""]` — when every
endpoint dies the document still retains exactly one empty block
(`del.range.flat` applied to the limits: head dies on empty prefix, tail
dies on empty suffix, and the model synthesizes a survivor).

### `del.range.nested-tail` — head flat, tail nested

Fixture: `paragraph "alpha"`, `ordered-list > list-item "beta"`,
`paragraph "omega"`. Select `alpha@0 → beta@2`.

Result: `[list-item "ta", paragraph "omega"]`.

- The head `alpha` **dies** — `alpha@0` puts its entire text inside the
  selected range, and `del.range.flat.head-empty` applies uniformly:
  nesting of the tail does not change the head's fate.
- The nested tail keeps its suffix `ta`, keeps `list-item` type and id,
  and is **promoted to root** when its `ordered-list` container dies
  (the ancestor rescue of the document's range deletion,
  `prepare.deleteRange`).

Former UNRESOLVED-1 — the asymmetry was a defect: the ancestor-rescue
branch returned after removing only the container, leaving the doomed
head's selected text behind. All doomed blocks outside the rescued
subtree are now removed in that branch.

### `del.range.outside-survives` — what follows the range end is kept

Blocks after the range end are outside the range and never die with it:
the tail's children, and the later siblings of the tail (and of each of
its ancestors) inside a container the range dies through. They take that
container's slot, in document order (the rescue of `del.range.nested-tail`
applies whether the head survives or not). When the tail merges into the
head, its children take the tail's vacated slot exactly as
`mergeBackward` places them (an island tail's children take that slot's
default child type). `[alpha, ordered-list > [beta, gamma], omega]`,
`alpha@2 → beta@2` → `[paragraph "alta", list-item "gamma", paragraph
"omega"]`; `[aa, bb > [cc]]`, `aa@1 → bb@2` → `["a", "cc"]`. A rescue
never carries a block across an island boundary: when it would, the
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

### `del.range.replace` — the deletion half of a replacement

Typing, pasting or composing over a range deletes it with the **head
kept**: the head block survives even when its prefix is empty (the
replacement lands at `yStart` inside it), and the tail's suffix merges
into it under the same `canMerge` rule. `alpha@0 → beta@2` replaced →
`[paragraph(alpha) "ta"]`, insertion point `alpha@0`. Every other rule of
this section is unchanged. (Whole-document replacement therefore keeps
the head instead of synthesizing a survivor.)

### `del.range.caret` — where the caret lands

The head survives → `head@yStart`; else the tail survives → `tail@0`
(`sel.seam.next-sibling`: the block that slid into the head's place);
else the nearest surviving block before the tail that renders content
(an island a sealed rescue kept inside the range counts), at its end; else the nearest one after it, at its start; else the
survivor `del.range.whole-doc` synthesizes, at 0.

### `del.range.nested-subtree` — range covers a whole subtree

`alpha@0 → beta@4` (whole nested item) → `[paragraph "omega"]` — the
container and all its children die with the range.

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
internal cross-block copy and parsed HTML → kinded lines (HTML inline runs
stay runs); an internal copy of a **block selection** → kinded lines marked
`whole` (`flow.whole`). A flow with no lines (an empty payload; HTML with
only a comment, a `<script>` or an empty `<span>`) changes nothing and adds
no undo step (F-P10). A taken id refuses the op before any write.

### `flow.inline` — one line joins the text

At a position `(B, o)`, a single line's content is inserted at `o`. `B`
keeps its kind, unless `B` shows no text: then it takes a kinded line's
kind and data (`<blockquote>` pasted into an empty paragraph gives a quote;
an empty `h2` given a paragraph line becomes a paragraph without the stale
`level`). The line's children become `B`'s first children. Caret: after
the inserted content.

### `flow.split` — several lines split the block (D-4)

`B` splits at `o`. The first line's content joins the head (`B`, text
`[0, o)`), the last line's content joins the tail (text `[o, len)`, with
`B`'s children, which come after the caret), and the lines between are
placed as blocks between the two, in order. The tail is the last line's
block: its id, and its kind and data when it is kinded (a run keeps `B`'s,
as a split does). The head keeps `B`'s kind unless `B` showed no text
(then the first line's, as in `flow.inline`). A run placed as a block takes
the default child of its parent. A joined line's children become the first
children of the block it joins. `Hello|World` + `X`, `Y` →
`["HelloX", "YWorld"]` on the internal, HTML, plain and drop paths (F-P5).
Caret: in the tail, after the last line's content.

### `flow.whole` — a block selection's copy is whole blocks

A `whole` flow is placed as blocks right after `B`; `B` is never split. An
empty `B` (no text, no children) is replaced by them. Caret: the end of the
last placed block's own content.

### `flow.slot` — over selected blocks

Over a block selection the selected blocks are deleted (`deleteBlocks`) and
the lines are placed as blocks in the first one's slot, in the same plan
(runs take the slot's default child). Caret: the end of the last placed
block's own content.

### `flow.void` — a block that cannot split

A void block (its caption) is never split: at a position inside one, the
lines' content joins into one run separated by `\n`; their children are
not placed.

## Collapsed caret deletion

### `del.caret.char` — character backward/forward

Caret `beta@4` + Backspace → `"bet"`. Grapheme clusters delete as units
(emoji ZWJ, flags, combining sequences, surrogate pairs) — see
`advanced-delete.spec.ts` for the native-input evidence.

### `del.caret.doc-start` — Backspace at document start

Caret `alpha@0` + Backspace → **named no-op** (`noop.doc-start`): document
unchanged. Expected no-ops are contract results, not skipped tests.

### `del.merge.backward-head` — Backspace at a block's head

Caret `beta@0` + Backspace over `[alpha, beta]` → `[paragraph "alphabeta"]`:
tail content merges into the head block; the tail block dies.
Verified through the real command path in `command-simulation.test.tsx`.

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
by design — the selection is the unit — and skips the anchor bound.

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

## Selection recovery on the passive peer (remote-origin changes)

Anchors are relative positions; carets bind left affinity, range ends bind
per their own anchor. The value's anchors ride the remote change; the
projector's pass after the flush displays the current value, running
`restoreDeadSelectionEndpoints` (the seam repair) when it no longer
projects (arch-v2 V4).

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
seam (offset of the removed run).

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
(`dispatcher.last.selection`). A block-set delete or cut authors a caret at
the end of the first editable text of the nearest unselected block before
the set, else after it (F-S13, FP-7).

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

### `conc.undo.actor-local` — undo after remote edits

A deletes `bb`; B edits survivor `cc`; A undoes → `bb` is restored AND
`cc` keeps B's edit. Undo is actor-local: it reverts only the undoing
peer's tracked transaction, never remote work. Verified in
`command-simulation.test.tsx`.

### `conc.disjoint-deletes` — disjoint held deletes

A deletes `bb`, B deletes `cc` while partitioned → both converge to the
survivor intersection `["aa"]`.

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
  arch-v2 V4). There is no deferred selection write: every writer —
  commands, input attempts, history, host code — `select()`s its value in
  its own turn, and the projector writes the **current** value after the
  Svelte flush, so an older request can never overwrite a newer gesture
  (including one that picks the same numeric offset).
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
| DOM-selection write (only writer) | `projector.post()` after every Svelte flush, current value; writers `select()` in their own turn                                                       |
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

| Boundary crossed                               | Pin                                                                                                                                                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| block-start ownership × adjacent remote insert | `a split-start caret stays in its block through an adjacent-block append` (anchors.test.ts) + mounted-replica pin (command-simulation.test.tsx: caret at `Hello@0`, remote `X` append to `alpha`, local `Z` → `alphaX`/`ZHello`) |
| block-start ownership × same-gap remote insert | `a split-start caret keeps left insert-affinity` — remote insert lands to the caret's right                                                                                                                                      |
| block-start ownership × composition            | `replaces intermediate composition text at a fresh split block start` — `alpha\|Hello` split, compose `n`→`に`, result `にHello`                                                                                                 |
| block-start ownership × remote merge           | `…follows its facet into a remote merge` (backward) and `…through a remote mergeForward` — the bound boundary's stream now displays in the claimer                                                                               |
| block-start ownership × predecessor deletion   | `…survives deletion of the predecessor's last atom` and `…of the whole predecessor block`                                                                                                                                        |
| block-start ownership × block move             | `…stays in its block when the block is moved`                                                                                                                                                                                    |
| block-start ownership × empty-in-place         | `…lands in its own block when the destination empties in place` — live block, no atoms → `{block, 0}`, no neighbor migration                                                                                                     |
| block-start ownership × serialization          | `a split-start anchor binds its boundary item and survives JSON round-trip` (`{b, a}` only)                                                                                                                                      |
| recovery topology × nested/non-editable        | `list(divider, gamma)` → caret in `gamma`; container ending in divider → previous editable end (command-simulation.test.tsx)                                                                                                     |
| recovery topology × whole-document deletion    | remote whole-doc delete → replacement paragraph mounts → pending recovery lands; `insertText("Z")` reaches it (command-simulation.test.tsx)                                                                                      |
| range recovery × one dead endpoint             | joint-shape oracle: collapse to the resolvable survivor (selectionOracle.ts + browser-state-oracle.spec.ts)                                                                                                                      |
| range recovery × both dead                     | seam walk on the start block's live/dead status → root first-editable fallback                                                                                                                                                   |
| display ownership × newer gesture              | the projector writes the current value after the flush; a later `select()` in the same turn wins (arch-v2-v4-projector F-S1, elegance-selection D7)                                                                              |
| display ownership × unmounted destination      | the value waits; the pass after the flush that mounts the text displays it (arch-v2-v4-projector F-S9, arch-v2-v3-seam)                                                                                                          |
| affinity × character identity                  | `remote insert AT the caret respects affinity`, `deleted atoms resolve to the gap`                                                                                                                                               |
| three-peer held release                        | command-simulation.test.tsx three-peer program: B holds selection, A deletes the destination, C edits unrelated content; both legal release orders preserve C's content and B's continuation                                     |
| history independence                           | `a seam caret behaves identically whether its block was split or built directly` — equivalent structures via different histories, explicit identity mapping, sequential edits, semantic comparison                               |

Stale-length, dead-textId, mismatched-parent-claim, phantom-target, and
lost-selection corruptions are rejected by canaries in
`tests/editor-dst/browser-state-oracle.spec.ts` — every canary is verified
to fail for its intended reason against synthetic dumps, while the
matching valid-case controls pass.
