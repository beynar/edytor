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

- **`yEnd > 0` (tail cut):** tail suffix merges **into the head block**
  (head type/id wins). Head dies iff its prefix is empty; tail dies iff
  its suffix is empty. `[a@1→b@1] → "ab"`, `[a@1→c@1] nonadjacent → "ac"`,
  `[a@0→b@1] → "eta"` (head dies), `[a@1→b@2] → "a","cc"` (tail dies).
- **`yEnd == 0` (range ends on the tail's start boundary):** the tail is
  **untouched** and no merge runs — head keeps its own block, emptied if
  the range covered all its text. `[a@2→c@0] → "aa","cc"` (only the
  interior block dies — the neighbors do NOT join);
  `[a@0→b@0] → "","bb","cc"` (head survives empty).

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
  (the ancestor-rescue path in `deleteContentWithinSelection`).

Former UNRESOLVED-1 — the asymmetry was a defect: the ancestor-rescue
branch returned after removing only the container, leaving the doomed
head's selected text behind. All doomed blocks outside the rescued
subtree are now removed in that branch.

### `del.range.nested-subtree` — range covers a whole subtree

`alpha@0 → beta@4` (whole nested item) → `[paragraph "omega"]` — the
container and all its children die with the range.

### `del.range.text-only` — within one text

`alpha@1 → alpha@3` → `"aha"`. Interior structure untouched.

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
per their own anchor. Recovery runs through
`Text._setItems → selection.restoreRelativePosition` and
`restoreDeadSelectionEndpoints` after mirror flush.

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

## History

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

A selection endpoint anchor (`DocAnchor` = `{b, a, o?}`) carries four
separable facts; implementations and oracles must keep them distinct:

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

**`o` facet (`sel.anchor.seam-owner`).** A mid-backing stream start needs
two facts `assoc` cannot encode: left insert-affinity AND right-side
ownership. Minted anchors use `a.a <= -2` (engine treats any `assoc < 0`
as left-sticky, so affinity math is untouched) plus `o` = the intended
display block. Resolution rebases the bound gap onto `o`'s own stream —
an insert into the _left_ neighbor at the shared gap lands a foreign atom
there and must not pull the caret across. `o` is honored only while
`ownerOf(o) === o` (alive and self-owning); a merge claim or deletion
returns the anchor to generic atom-following, and an `o` that emptied in
place resolves to `{o, 0}`. Anchors without `o` resolve by the generic
path — the wire/JSON shape accepts both (compatible extension, no
migration).

## Selection ownership and lifecycle

- A newer user gesture supersedes older deferred writes — including when
  it chooses the same numeric offset. All argument forms (`Text` object,
  string id, range) and all exits (success, lookup rejection, detached
  retry, foreign-focus fallback, final fallback) check the gesture
  serial before writing.
- Programmatic focus caused by the current write is not a new gesture.
  History-restore and composition ownership remain separate lifetimes.
- **Model destination and DOM readiness are separate facts.** A valid
  destination whose text wrapper has no DOM node yet is _not_ "no
  recovery": `restoreDeadSelectionEndpoints` arms
  `deadEndpointRecoveryPending`, and the first `Text.attach` replays the
  recovery (phantom slots never attach, so the hook cannot target hidden
  text). Admission revalidates on every attempt.
- Hidden container text and temporarily-unmounted editable text differ:
  a phantom is a container's own content part that never renders; an
  editable text may lack a node only inside a settle window. At a
  settled barrier, `part.node == null` means phantom.
- After settlement, endpoints reference live editable content with
  correct owner and bounds; follow-up input reaches it without a harness
  selection reset.
- Fallback order: surviving **forward** editable destination, then
  backward, then the documented root/first-editable destination —
  traversing past noneditable descendants and siblings at every level.

### `sel.drift.churn` — render churn under a live caret

Any commit's render can mutate the DOM under a live caret — a delta
re-split shortening a text node, a keyed span remount (`domVersion`
in `Content.svelte`), a `_setItems`/`_kill` re-render. Gecko re-parks the
caret at the surviving boundary (Blink usually keeps the offset) and the
trailing `selectionchange` would derive+re-mint anchors from the drifted
spot. Two layered defenses:

- **Echo gate** (`restoreDriftedEchoCaret`): internal render churn bumps
  `domSelectionChurnSeq` (`Text.attach`/destroy, `Text._setItems`,
  `_kill`, the per-span mutation observer); `markUserGesture` snapshots it
  into `churnBaselineAtGesture`, so churn stays outstanding for the whole
  inter-gesture window. An echo at an unchanged `gestureSerial` whose
  derived position differs from the resolved anchors is drift — the DOM
  is reverted to the resolved anchors instead of deriving. A matching
  echo, an echo after a serial bump (real gesture), and an echo with no
  outstanding churn (settled foreign write) all derive normally.
- **Proactive reconcile** (`captureSelectionForRemoteApply` →
  `reconcileSelectionAfterRemoteApply` at the post-flush `tick()`):
  captures the anchored state at every commit and, after Svelte's DOM
  write lands but before the echo's task, re-asserts DOM ← resolved
  anchors when they disagree. Skipped while `isHandlingUserInput` — inside
  a user-input window the DOM caret is the user's own write (autocorrect,
  IME commit, drop) and a commit can legitimately slide the captured
  anchors (deleting the bound atom drops the anchor to the deletion seam),
  so model→DOM re-assertion would revert the user's caret; the input
  path's explicit write owns the final position.

Deferred-write discipline: `scheduleCaretWriteVerification` repairs only
when state was dragged back to the exact pre-write position inside its
window; it is superseded by a newer write (`caretWriteEpoch`) and disarmed
by an intervening document commit (`_docCommitVersion` — a remote frame's
legitimate move is not "the browser reverted my write").

Harness contract: DOM-first selection placement IS a user decision —
fixture/harness paths that write the DOM selection directly
(`setNativeSelection` in `src/tests/dom/test.utils.ts`, the playwright
helpers in `tests/editor-*/`) must call `edytor.markUserGesture()` first,
or the echo gate reads their synthetic `selectionchange` as drift.

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

| Concern                                 | Owner                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Anchor mint/resolve, owner facet        | `facade.anchorAt` / `facade.resolveAnchor` (`src/lib/crdt/edytor-doc.ts`)                        |
| Engine relative positions               | vendored Yjs v14 (`atomAnchorAt`/`resolveAnchor` in `src/lib/crdt/text/model.ts`)                |
| Logical recovery destination            | `selection.restoreDeadSelectionEndpoints` + seam walk (`src/lib/selection/selection.svelte.ts`)  |
| Editable-destination traversal          | `Block.firstEditableText`/`lastEditableText` (`src/lib/block/block.svelte.ts`)                   |
| DOM mount readiness → deferred recovery | `Text.attach` → `selection.notifyTextMounted` (`src/lib/text/text.svelte.ts`)                    |
| Final write admission (gesture serial)  | `setAtTextOffset`/`setAtRange`/`setAtBlockRange` guards                                          |
| Drift-echo gate                         | `restoreDriftedEchoCaret` + `domSelectionChurnSeq`/`churnBaselineAtGesture`                      |
| Post-commit DOM re-assert               | `captureSelectionForRemoteApply`/`reconcileSelectionAfterRemoteApply` (skipped under user input) |
| Post-write verify supersession          | `caretWriteEpoch` + `_docCommitVersion` in `scheduleCaretWriteVerification`                      |
| Remote anchor validation                | `isTextAnchor`/`resolveRelativePosition` (`src/lib/collaboration/remoteSelection.ts`)            |
| Wire/equality                           | `awarenessSelection.ts` (`anchorsEqual`, JSON round-trip)                                        |
| History snapshots                       | `UndoSelectionSnapshot` anchors (in-memory `meta`, not persisted)                                |
| Independent oracle                      | `dense-ownership-oracle.ts`, `selectionOracle.ts`, dump inventories in `collab-runner.ts`        |
| Settlement checkpoint                   | `command-peer-set.ts` `quiesce()`                                                                |

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
- Undo/redo semantic restoration beyond `hist.dead-pop`: `undoRestore.ts`
  and history fixtures own the details.

## Boundary matrix (recorded coverage)

Each row names the crossed boundary and the pin that carries it. Two
replicas for every conflict row; the three-peer and history rows are
separate pinned programs.

| Boundary crossed                               | Pin                                                                                                                                                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| block-start ownership × adjacent remote insert | `a split-start caret stays in its block through an adjacent-block append` (anchors.test.ts) + mounted-replica pin (command-simulation.test.tsx: caret at `Hello@0`, remote `X` append to `alpha`, local `Z` → `alphaX`/`ZHello`) |
| block-start ownership × same-gap remote insert | `a split-start caret keeps left insert-affinity` — remote insert lands to the caret's right                                                                                                                                      |
| block-start ownership × composition            | `replaces intermediate composition text at a fresh split block start` — `alpha\|Hello` split, compose `n`→`に`, result `にHello`                                                                                                 |
| block-start ownership × remote merge           | `…follows its facet into a remote merge` (backward) and `…through a remote mergeForward`                                                                                                                                         |
| block-start ownership × predecessor deletion   | `…survives deletion of the predecessor's last atom` and `…of the whole predecessor block`                                                                                                                                        |
| block-start ownership × block move             | `…stays in its block when the block is moved`                                                                                                                                                                                    |
| block-start ownership × empty-in-place         | `…lands in its own block when the destination empties in place` — live block, no atoms → `{o,0}`, no neighbor migration                                                                                                          |
| block-start ownership × serialization          | `a split-start anchor keeps its owner facet through JSON round-trip` (`o` survives the wire shape)                                                                                                                               |
| recovery topology × nested/non-editable        | `list(divider, gamma)` → caret in `gamma`; container ending in divider → previous editable end (command-simulation.test.tsx)                                                                                                     |
| recovery topology × whole-document deletion    | remote whole-doc delete → replacement paragraph mounts → pending recovery lands; `insertText("Z")` reaches it (command-simulation.test.tsx)                                                                                      |
| range recovery × one dead endpoint             | joint-shape oracle: collapse to the resolvable survivor (selectionOracle.ts + browser-state-oracle.spec.ts)                                                                                                                      |
| range recovery × both dead                     | seam walk on the start block's live/dead status → root first-editable fallback                                                                                                                                                   |
| deferred ownership × newer gesture             | all write paths (string id, range, block range, catch/fallback exits) re-check the gesture serial (selection-ownership.test.tsx, elegance-selection.test.tsx)                                                                    |
| deferred ownership × unmounted destination     | `deadEndpointRecoveryPending` + `Text.attach` retry — model destination vs DOM readiness are separate facts                                                                                                                      |
| affinity × character identity                  | `remote insert AT the caret respects affinity`, `deleted atoms resolve to the gap`                                                                                                                                               |
| three-peer held release                        | command-simulation.test.tsx three-peer program: B holds selection, A deletes the destination, C edits unrelated content; both legal release orders preserve C's content and B's continuation                                     |
| history independence                           | `a seam caret behaves identically whether its block was split or built directly` — equivalent structures via different histories, explicit identity mapping, sequential edits, semantic comparison                               |

Stale-length, dead-textId, mismatched-parent-claim, phantom-target, and
lost-selection corruptions are rejected by canaries in
`tests/editor-dst/browser-state-oracle.spec.ts` — every canary is verified
to fail for its intended reason against synthetic dumps, while the
matching valid-case controls pass.
