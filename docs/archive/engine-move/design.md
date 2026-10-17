# A move in the fork (YP21?) — design

Status: design only (2026-10-15, branch `engine-move`). Nothing is
implemented; every number below is either measured today (said so) or an
estimate (with its confidence). The model to follow is
[`docs/archive/engine-delete/design.md`](../engine-delete/design.md) (YP20).

## Verdict

- **One primitive cannot serve all three layers at a cost worth paying.**
  An explicit-id move record (YP21 below, built like YP20's hold record)
  serves a list move and a tree move: per-unit winner, order-independent,
  no replay, no cleanup messages. It **cannot** carry the text move edytor
  actually does. A merge needs the moved run's open end to take the
  appends a peer types there concurrently, and only an anchor-range move
  gives that. An anchor-range move is the design Yjs (PR #357,
  `yjs@14.0.0-1`) and yrs built. Yjs never merged it, and yrs removed it in
  May 2026. Its two engine files alone minify to 10.0 KB, more than the
  5.9 KB of text-layer workaround it would replace. A split is better as a
  boundary marker than as any move: that is what every surveyed editor
  converges on.
- **Most of the code in the three layers is product rules.** The three
  layers ship 58.5 KB (minimal probe). Of that, 13.6 KB is pure workaround
  (6.7 tree, 1.0 properties, 5.9 text). The rest is promotion, the layout
  and table rules, voids and lines islands, the text order of split
  pieces, the shown-kind rule, the per-path data merge, the LCS arrangement
  and the incremental index. Any representation needs all of that.
- **The saving is small.** List move plus tree move would remove 6.4–7.7 KB.
  They would add 1.9–2.9 KB of engine and 1.9–2.6 KB of edytor code that
  reads sequences. The net is −0.9 to −3.7 KB (central −2.3), with low
  confidence. That is less than YP20's measured −6.8 KB, at a much higher
  risk: the placement half of the index is rewritten. Text gains nothing.
  The real gains are outside the bundle:
  - −26 to −32 B of stored size per block;
  - no rank growth (a block split 300 times at one spot carries 39-character
    ranks today);
  - `order.insert.run` by construction.
- **Recommendation: do not build the move now.** Do these instead, none of
  which is a move (§9):
  1. Write merge claims as items in the holder's text (about −2.5 KB, −13 B
     per block). YATA then anchors them, which is `merge.claim.anchor` for
     free.
  2. Make block delete and withdraw marks YP20 holds (~1.5 KB). With 1, it
     clears the 3 KB floor.
  3. Replace the YP14 incarnations with multi-value keys (~1.8 KB).
  4. Make the placement cycle fallback parentless (~0.5 KB): cycle
     resolution becomes local. This changes a contract, so it needs your
     decision.

  The YP21 design stays on file. If stored size or rank growth becomes a
  product problem, stages 1 and 2 together are the move to make (§8).

## 1. How others move: survey

Primary sources only: papers, repository source, design documents and
issue threads (links in §10). The historical Yjs move engine was also read
and run locally (`node_modules/yjs-14-move`, the devDependency
`yjs@14.0.0-1` that `src/tests/crdt/historical/issue-694.test.ts` pins).
Each entry gives the same six points:

1. what it is;
2. its merge rule;
3. concurrent moves and cycles;
4. move vs delete, and move vs an edit inside;
5. its cost;
6. its fit with a YATA item store like ours.

### 1.1 List move

**Kleppmann, "Moving Elements in List CRDTs" (PaPoC 2020).**
1. An add-wins set of `(value, LWW register(position))`. A position is an id
   of the underlying list CRDT. A move inserts a fresh position and writes it
   into the element's register.
2. LWW per element, by any deterministic order (a timestamp, a replica
   priority), or a multi-value register if no move may be lost.
3. Never two copies: one register per element, and a fresh position per
   move.
4. Move vs delete is not specified. Edits inside an element follow it,
   because identity is not position. Moving a range character by character
   leaves concurrent inserts at the old place (Fig. 4). Range moves are
   called open: "there is no known algorithm" (§4).
5. One register per element. One new position per move; the old one stays
   as a tombstone.
6. A good fit. A position is a YATA item and an element is its original id.
   Yjs ids are not Lamport timestamps, so the register needs an explicit
   Lamport field.

**Loro `MovableList` (Fugue + move).**
1. Kleppmann 2020 over Fugue. Positions are Fugue items. An element (keyed
   by its insert's `IdLp`) holds `{value, value_id, pos}`. `Move {from, to,
   elem_id}` inserts one new position (the op's id) and deletes the old one.
2. An element's position is the maximum `IdLp = (lamport, peer)` over its
   insert and its moves; `value` is a separate LWW register.
3. No duplicates. A losing move's position stays as an unpointed "dead"
   item; it counts in op indexes, not in user indexes.
4. A delete removes a position, so a concurrent move resurrects the
   element (test `concurrent_delete_and_move_resurrects_moved_element`).
   Child containers keep their ids, so edits inside follow. Single
   elements only.
5. An element entry plus an `IdLp`; one Fugue item per move; tombstones.
   Documented overhead even without moves: about +50 % memory and +80 %
   encode/decode against `List`.
6. The closest fit: Fugue and YATA both integrate by left and right origin.
   Loro has a Lamport per op; Yjs does not.

**Automerge.**
1. No move has shipped. PR #706 (`move_id`/`move_from` columns and a
   `MoveManager`) was closed on 2026-09-08: "it'll need to be a
   reimplementation". The intended design is Da and Kleppmann (PaPoC 2024):
   a move op at the destination, made a successor of the source op.
2. The largest Lamport op id wins. A move is invalid if a greater concurrent
   move exists or if it closes a cycle. Validity is computed by
   Restore-Apply-Reapply (replay) in ascending id order.
3. A single winner per element; cycle checks for trees.
4. The #319 proposal makes a move beat a concurrent remove; the paper makes
   a delete a move to a trash node. Identity is kept, so edits follow.
5. Two op columns and replay of every greater op. About 1 ms to converge
   100 concurrent moves; 20 ms vs 6 ms on 10⁴ ops with lifecycle tracking.
   Every op is kept.
6. A poor fit: it needs a total op order and a replay. Yjs has neither.

**Liveblocks `LiveList.move`.**
1. Each item's `parentKey` is a base-95 fractional position;
   `SET_PARENT_KEY {id, parentKey}`.
2. Server authority: ops apply in arrival order. A taken key is replaced by
   a free one (`findFreeListPosition`) and the correction is broadcast.
3. One node, one key: no duplicates. "Move doesn't record an intention".
4. Delete wins: the server drops a move of a gone node ("deleted in race
   condition"). Edits address the node id, so they follow.
5. One key string per item; keys grow; no tombstones.
6. Only as a map value, and it needs a server to fix collisions.

**Replicache / Zero (rocicorp `fractional-indexing`).**
1. `generateKeyBetween(a, b)`; a move rewrites a row's `order`.
2. The server re-runs the mutator against its own siblings, so the result
   is LWW in server order with the index intent rebased.
3. One row: no duplicates. Without the server, keys can collide and
   concurrent inserts interleave.
4. Application-defined.
5. One key per row, key growth.
6. Only as a map value.

**Figma (Wallace, 2019).**
1. Each child stores its parent and its fractional position as one
   property, so they update atomically.
2. LWW per property in server order. The server rejects a parent change
   that would make a cycle.
3. Never two copies.
4. A move is never delete-and-recreate. Removal deletes the data on the
   server.
5. One property per object, no tombstones.
6. Same as Liveblocks: a map value plus an authority.

**Weidner: Fugue/FugueMax, list-positions, Collabs `CList`.**
1. Fugue has no move (the paper defers to Kleppmann 2020). list-positions
   moves "by changing its position" and leaves the rule to the app. Collabs
   `CList` ships move: each entry is `{value, position: CVar<Position>,
   present}`, and `move(index, to, count)` sets fresh positions.
2. `CVar` is a multi-value register; concurrent sets go through an
   aggregator (default: first replica id).
3. Per element. A range move is N element moves, so overlapping range moves
   split the range.
4. Delete is permanent and wins; archive/restore is restore-wins. Edits to
   the value follow; inserts next to the old place do not.
5. A register, a boolean and a position per entry. Moved positions are
   never collected.
6. It is Kleppmann 2020 again.

**json-joy.** No CRDT move: `arr` is an RGA of slots that hold LWW
references to nodes, and move exists only in JSON Patch and its OT
transform, so points 2–5 do not apply (nothing stops two slots from naming
one node). Fit: issue #223 sketches a range move (hide an RGA range, insert
a marker that names it), which is structurally Yjs `ContentMove`; #1038
(May 2026) plans forwarders and move resolution.

**Diamond Types / Eg-walker.** No move in any branch; the paper defines
insert and delete on plain text. Nothing to borrow.

**Yjs `ContentMove` (PR #357, shipped only in `yjs@14.0.0-0` and `-1`;
read locally).**
1. A move is a non-countable item at the destination, integrated by YATA.
   Its content holds a range as two relative positions (`start` and `end`,
   each an id plus `assoc`) and a `priority`. Each moved item gets a local
   `moved` pointer and renders at the move's place. Readers jump into the
   range (`ListCursor`, with a `movedStack`).
2. The higher `priority` wins, then `(client, clock)`. A local move takes
   `max(priorities in range) + 1`: a per-range Lamport counter.
3. Overlapping ranges are decided per item, so a range can split.
   - A losing single-item move is deleted outright (`deleteAsCleanup`).
     That depends on arrival order.
   - A cycle (each move's marker inside the other's range) is broken by
     `findMoveLoop`, which deletes the move being integrated. That depends
     on arrival order too.
   - Replicas converge only after a second update with origin `'cleanup'`
     (`Transaction.js`). Upstream's `testMoveCircles` is commented out, and
     its random tests use ranges of length 1.
4. A delete of moved items is independent of the move. An item integrated
   between two items of one moved range inherits `moved`, so concurrent
   inserts inside follow. An insert at an edge re-walks the whole range.
   Undo deletes the move item; redo copies it with the old priority.
5. A pointer on every item of every type, an `overrides` set per move, no
   GC of moves, search markers wiped on every move. Items on two sides of a
   move boundary cannot merge, and every reader must know about moves.
   Three readers did not, which caused the pinned bugs: `toJSON` with holes
   (#694, #475), anchors that ignore `moved`, and `moveRange` starting
   inside an item. `ContentMove.js` (296 lines) and `ListCursor.js` (740)
   minify to 2.7 + 7.4 KB (not all of it added cost: `ListCursor` replaced
   older readers).
6. Native, but unproved, never merged, Y.Array only (dmonad: moving into
   another type was out of scope), and convergent only through a second
   message. Its content ref 11 is now YP20's `ContentHold`.

**yrs `Move` (Rust; removed).** A direct port: `ItemContent::Move {start,
end: StickyIndex, priority, overrides}`, `Item.moved`, `move_to` and
`move_range_to`. Merge rule, concurrency, delete and edit are the same as
Yjs (the same cleanup deletes and loop rule); its docs warned that
convergence may take more than one sync round trip. The costs are the same;
the removal deleted about 2,000 lines (iterators, sticky indexes, array,
weak links, transaction, update, bindings). It was removed on 2026-05-14
(PR #617) for parity with Yjs v14 and its maintenance cost. dmonad agreed
that range move "touches nearly every aspect of Yjs/Y-CRDT", and said he
would like a smaller single-item move one day.

**y-octo (AFFiNE's Rust Yjs).** No move: content refs 1–9 only, and any
other ref is rejected.

### 1.2 Tree move

**Kleppmann, Mulligan, Gomes, Beresford (IEEE TPDS 2021).**
1. An op-based tree of `(parent, meta, child)` triples. One op, `Move t p m
   c`, covers create, delete (a move to a trash node) and move.
2. A log in descending timestamp order. To apply an op, undo every logged op
   with a greater timestamp, do the op, then redo them. `do_op` skips a move
   that would make `c` its own ancestor.
3. Deterministic, as if every op ran in timestamp order. Of the ops that
   close a cycle, the later one is skipped. A skipped op stays in the log,
   because a late lower-timestamp op can flip it. Proved in Isabelle
   (unique parent, acyclicity, commutativity, convergence).
4. A deleted node keeps its children under the trash, and a later move can
   bring it back. Edits inside follow (stable identity).
5. Worst case O(n·d) per op (n logged ops, d the depth). In the paper's
   measurements, remote ops saturate at 5,700/s, with about 200 undos and
   redos per remote op. The log is cut only below a causally stable
   timestamp, which needs a known replica set.
6. A poor fit as is. It needs a Lamport per move and the full move history,
   superseded moves included. Causal stability needs a known replica set
   (the room's purge horizon could stand in). Delete-as-move needs timed
   deletes; the delete set has no timestamps.

Related work:
- `crdt_tree` (MaidSafe) is a faithful Rust port.
- Da and Kleppmann (PaPoC 2024) separate liveness from parenthood
  ("lifecycle tracking"), so creates and deletes never replay: over 60 s
  becomes 20 ms on 10⁴ ops. That paper is the basis of Automerge's
  unshipped design.

**Loro movable tree.**
1. `TreeOp::{Create, Move, Delete}` with a fractional index for sibling
   order. Delete moves the node under a deleted root.
2. Kleppmann's rule. Each node keeps a set of its ops ordered by
   `(lamport, peer)`, flagged `effected`. On import, every op at or above
   the smallest new lamport is retreated and re-applied with the ancestor
   check (a windowed undo-redo). That window was rewritten on 2026-09-28
   after correctness bugs.
3. Deterministic, with replay restricted to the window.
4. A node counts as deleted when an ancestor is; a node moved out of a
   concurrently deleted ancestor stays alive under its new parent. Metadata
   is a separate map, so edits follow.
5. Parent, position and last op per node; the whole op history is kept.
   10,000 random moves over 1,000 nodes take 28 ms; at depth 300, 701 ms.
   Against Wallace's algorithm on 1,000 nodes and 10,000 moves: 9.9 ms vs
   2,795.6 ms.
6. A poor fit: it needs Lamport stamps and a retained op log.

**Figma, and Wallace's "CRDT: Mutable Tree Hierarchy".**
1. Figma: parent and position as one property; the server rejects a cycle,
   and clients hide the nodes caught in one meanwhile. Wallace's CRDT: each
   node keeps a map from parent to counter, and a move writes the node's
   highest counter + 1 on the new edge.
2. The parent is the highest-counter edge. Nodes that cannot reach the root
   are reattached from a priority queue. Nothing is written back.
3. A pure read rule, with no undo-redo and no proof. Writers "lock in"
   what they see by bumping counters on the paths.
4. Delete is not covered.
5. The demo recomputes the whole tree per op (O(n)). Storage grows per
   distinct parent. `yjs-orderedtree` and `yrs_tree` use this algorithm.
6. A natural fit for a map, but O(n) per op.

**Weidner, "CRDT survey part 2" (forests and trees).**
1. An LWW parent pointer per node, and six ways to handle a cycle: error,
   time-out zone, server rejection, topological sort and skip, hide the
   cycle's max-stamp edge at render time, or render the previous parent.
2. LWW per node.
3. For block-based rich text he recommends hiding the max-stamp edge and
   rendering its previous placement. On topological sort: "you don't know
   what result you will get".
4. Delete only the top node, or move it to a trash node. Position is a
   property of the element, so edits follow.
5. The cost of keeping the view up to date is not discussed.
6. A good fit: a read rule over map values.

**Others.**
- Nair et al., "Maram" (Inria RR-9395, 2022): up-moves beat down-moves,
  priorities decide between down-moves, with no rollback. It needs vector
  clocks and the set of concurrent ops per op, which is a poor fit.
- Anjana et al. (CCGrid 2022): compensation ops written on detection.
  Writing repairs from local arrival state is the oscillation risk Wallace
  warns about.
- Najafzadeh et al. (2018) and Tao et al. (2015): duplicate or lock.
- Notion: a parent-pointer plus child-id arrays, validated by the server.
- Sypytkowski (on replacing Yjs move): reorders children with a fractional
  `ord`; there is no reparenting, so no cycle.

**The functional-graph property** (derived for this design, not from a
source).
- With exactly one winning parent edge per block (edytor's model), the edges
  form a functional graph, whose cycles share no node.
- A greedy acceptance in any total order then rejects exactly one edge per
  cycle: the last of that cycle in the order. If no edge closes a cycle,
  the result is independent of the order, which is why edytor's argmax fast
  path is exact.
- When a block's winner changes, resolution is local, O(depth + cycle
  length), provided a rejected block falls back to a parentless place (the
  root). Today's runner-up candidate is a fallback that can close another
  cycle, and that alone is why `ensurePlacements` falls back to a global
  pass.
- Semantics differ from Kleppmann's on stale chains: Kleppmann judges a
  move against the tree of older ops, the greedy rule against newer
  winners. Both are deterministic.

### 1.3 Text range move

- **Nobody has shipped a general concurrent range move for text with
  convergence argued or proved.** Kleppmann 2020 calls it open; his "CRDTs:
  the hard parts" talk (2020) repeats it. Lord's 2019 "splicing" notes
  define no merge rule. No PaPoC 2025 or 2026 paper addresses it.
- **Kleppmann's "Block elements in rich text CRDT" note (Peritext 2,
  2023)**, the source of Automerge's design:
  - the whole document is one sequence; `splitBlock` inserts a marker,
    `joinBlock` deletes it, `updateBlock` sets its properties (LWW);
  - nesting is a `parents` path on each marker; tables are separate
    documents;
  - moving text or a list item stays delete-and-reinsert.
  - Weidner's recorded anomaly: merging A and B while C is concurrently
    split off A's end gives "A", "CB".
- **Automerge 2.2+** ships exactly that: block markers inline in the text.
  A split and a join are an insert and a delete. A block move is
  delete-and-reinsert.
- **Notion (2025–2026).** RGA texts grouped into "text instances" of
  slices. Enter moves the tail slice into the new block under its instance
  id, and a server finds the target of a late edit by label prefix. This is
  the only shipped CRDT that moves text between blocks, and only for
  splits. Merges, drags, overlaps and cycles are not described, and no
  convergence argument is published.
- **CKEditor 5 (OT behind a server).** `MoveOperation` moves a model range.
  An insert inside a moved range is remapped (it follows). Overlapping moves
  give the shared part to the "stronger" op. Mutual moves are called
  unsolvable and one is reversed. Convergence rests on server ordering and
  tests.
- **Fluid SharedTree `moveRange`** moves the nodes it named, so concurrent
  inserts inside the range stay behind; edits inside the named nodes follow.
  The last sequenced move wins. Its text type has no move.
- **y-prosemirror and loro-prosemirror** join paragraphs by delete and
  reinsert: concurrent edits inside the joined paragraph are lost. Loro's
  maintainers propose slice-and-reinsert for splits (issue #673); users
  answer with markers.
- **Yjs `ContentMove` and yrs `move_range_to`** moved ranges inside one
  array only, never in Y.Text and never across types (§1.1).
- **Google Docs, Quill, Etherpad:** one text with paragraph markers
  (newline attributes), no move.

Closest to edytor: **edytor's own boundaries are block markers in a backing
text** (Automerge's design, one marker per split). Its **merge claims** are
the cross-text join that a one-sequence document never needs.

### 1.4 Comparison and what the design adopts

| System | Moves | Merge rule | Concurrent moves, cycles | Delete / edit inside | Cost | Fits our store |
| --- | --- | --- | --- | --- | --- | --- |
| Kleppmann 2020 | list element | LWW position register | one register: no duplicate | delete unspecified; edits follow; ranges open | register + tombstoned position per move | yes, with a Lamport field |
| Loro MovableList | list element | max `(lamport, peer)` | dead positions; no duplicate | move resurrects; edits follow | +50 % memory, +80 % encode | best match |
| Automerge (unshipped) | element, tree | largest Lamport id; RAR | invalid on cycle | move or delete wins (proposals); edits follow | replay, all ops kept | no (total order) |
| Liveblocks, Replicache, Figma | element (+ parent) | server order | server fixes keys, rejects cycles | Liveblocks: delete wins; others app-defined or unstated; edits follow | key string | needs an authority |
| Collabs CList | element, ranges as N elements | MV register | ranges split | delete wins; edits follow | 2 registers + position | Kleppmann on items |
| Yjs ContentMove / yrs | range in one array | priority, `(client, clock)` | per item; loop and loser deleted by a cleanup message | delete independent; inserts inside follow | pointer per item, move-aware readers, 10.0 KB | native but abandoned |
| Kleppmann 2021, Loro tree, crdt_tree | tree node | timestamp order, skip cycle | replay of the suffix | trash node; edits follow | log until stable | needs Lamport + log |
| Wallace, Weidner 5/6 | tree node | LWW parent + read rule | pure read rule | delete open; edits follow | O(n) recompute (demo) | yes |
| edytor today | tree node (placements) | LWW `(seq, client)` | greedy acceptance, runner-up, root | delete marks win; edits follow | 37.7 B/block, ranks | — |
| Automerge blocks, Peritext 2 | none (markers) | marker insert/delete | n/a | join deletes a marker | one item per block | yes (edytor's boundaries) |
| Notion slices | text tail on split | server, by label | splits only | not described | per slice | n/a |
| CKEditor 5 | model range | OT, server order | stronger op; mutual moves reversed | inserts inside follow | OT | no |
| Fluid moveRange | named nodes | sequenced order | last sequenced wins | inserts inside stay behind | sequencer | no |

**Adopted:**
- **Kleppmann 2020's construction for lists and trees**, in the shape YP20
  already proved order-independent: a position is a YATA item and an element
  is its original item. A move record is an item at the destination naming
  explicit ids. The winner is the argmax of a Lamport priority over the live
  records, derived locally like `holds`. These are Kleppmann 2020's and
  Fluid `moveRange`'s semantics with delete winning (unlike Loro), not Yjs
  `ContentMove`'s.
- **For cycles, edytor's existing read rule** (greedy acceptance over one
  winning edge per block), with a parentless fallback so it stays local.
  This is Weidner's idea 5 with the functional-graph argument; there is no
  log and no replay (§1.2).
- **No anchor ranges.** Making every reader move-aware, inheriting at
  integration, re-walking ranges at their edges and breaking cycles with a
  cleanup message is what sank #357 and yrs. The historical engine
  converged only by giving up order independence (a second, cleanup
  message), which YP20 took care to keep.
- **For text, the boundary model stays** (Automerge, Peritext 2), so a
  split moves nothing. A general text range move is only what the
  explicit-id record gives: the units keep their identity, and an insert
  typed concurrently inside stays at home (Fluid's semantics).

## 2. What the three layers weigh today (measured)

`node scripts/bundle-size.mjs --top 400` (minimal and every-plugin probes;
the `edytor/export` probe ships no CRDT code). Function-level shares come
from the same builds' source maps: each minified byte is attributed to its
source line, and the lines to the declaration around them (a scratch
script over `node_modules/.cache/bundle-size/*/out/assets/*.map`, not
committed). KB = 1,024 bytes, minified. The all-plugin probe is equal to
±0.05 KB on every file below except `tables.js` (0.25 → 0.89). Totals: edytor
ships 417.0 KB of its own (minimal) and 646.4 KB (all), of which 46.4 KB is
the engine.

### 2.1 Block tree (placements) — 30.0 KB (30.7 all)

| Piece | KB | Kind |
| --- | --- | --- |
| `placement/rank.js` whole (codec, `rankBetween`, `rankAfter`) | 2.68 | workaround (dense keys). Data arrays use it too (`rankAfter`) |
| `resolve.js` `candidatesOf` 0.28, `rehomeRankBelow` 0.09 | 0.37 | workaround |
| `resolve.js` `resolvePlacements` 0.80 | ~0.40 / ~0.40 | argmax over candidates, runner-up (workaround) / acyclic acceptance (rule) |
| `source.js` `sourceRank` | 0.22 | workaround (ranking by source) |
| `model.js` `writePlacement` 0.21, `ranksAt` 0.19, `createBlock`'s candidate ~0.08 | 0.48 | workaround |
| `doc/steps.js` `ranksFor` 0.28, `exitRanks` 0.40, `pieceRanks` 0.21 | 0.89 | workaround |
| `index/placement.js` `argmaxOf` 0.13, `noteCands` 0.10, `setPlacement` 0.11, the irregular/global pass of `ensurePlacements`/`rebuildPlacements` ~0.45, `seek` 0.08 | ~0.87 | workaround |
| `display.js` `textRanker` 1.43 | ~0.7 / ~0.7 | permuting minted ranks (workaround) / `order.split.text` (rule) |
| `index/records.js` candidates | ~0.05 | workaround |
| **Workaround subtotal** | **~6.7** | |
| `displaySlotOf`, `lineSlotOf`, `storedLineSlotOf` | 1.30 | rule: `del.blocks.promote`, `conc.void-children`, `conc.island-lines`, layout passes |
| children index, `bySlot`, `documentOrder`, `isLiveIn`, `isSelfOrDescendant`, `positionInView`, `promotedRank` | ~1.2 | plumbing any tree needs |
| the rest of `index/placement.js`: `typeOf` 0.67, `noteKind` 0.66, `ownShim` 0.42, `patch`/`reach`/`slotIn` 1.00, the kind counting and layout wiring of `ensurePlacements`/`rebuildPlacements` ~1.3, `itemOf`, `noteFollowing`, `cyclic` | ~5.2 | rule (the shown-kind rule) and incremental plumbing |
| `index/layout.js` | 3.30 | rule: `layout.*`, `table.*` |
| `doc/moves.js`, `doc/layout.js`, the rest of `doc/steps.js` | 3.08 + 2.38 + 3.34 | rule: the gestures, `emptying`, `dissolving`, `settle` |
| the rest of `model.js`, `tables.js` | ~2.3 | plumbing, table reads |

### 2.2 Block properties — 11.9 KB (11.9 all)

| Piece | KB | Kind |
| --- | --- | --- |
| arrays' order: `itemsOf`'s rank sort and `placeOf`, `edits.lay`'s rank allocation, `apply`'s `~id#`/`~id>` writes and `order`'s re-ranking | ~1.0 (low confidence: shares inside functions) | workaround |
| leaves as a tree (`treeOf`, `valueOf`, `leavesFrom`, `closed`/`open`), `collapse` (`data.atomic`), derived ids (`assign`), `arrange` + `common` (1.07), patch planning, `patchWrites`, `previewData`, `idsAt` | ~4.7 | rule: per-path merge (two concurrent creations of one container merge, Kleppmann–Beresford JSON semantics), `data.atomic`, `table.conc.adopt`, ids kept across a whole assignment |
| `doc/meta.js` | 2.56 | rule: `patchData`, `data.retype.keep` |
| `props.js`, `session/props.js` | 2.56 + 1.00 | the view's proxy and queue (API) |

The leaf encoding exists for per-path merge, not for the missing move. A
move touches only the array order, about a twelfth of the layer.

### 2.3 Text moved between blocks — 16.6 KB (16.6 all)

| Piece | KB | Kind |
| --- | --- | --- |
| `index/claims.js` (claim graph: owners by max stamp, cycles, invalidation) | 2.23 | workaround: a merge cannot move the run, so a claim displays it |
| `index/anchored.js` (`merge.claim.anchor` retargeting) | 2.42 | workaround: the claim is not positioned in the text |
| `text/model.js` `readClaims` 0.30, `claimGraph` 0.61, `claimInto` 0.17; `displayOf`'s claim walk ~0.2 | ~1.3 | workaround |
| **Workaround subtotal** | **~5.9** | |
| `index/streams.js`, `text/streams.js` (rest), `text/rows.js` | 2.50 + ~1.1 + 1.91 | rule: splits as boundary markers (the one-sequence-with-markers design) |
| `text/model.js` writes: `splitAt` 0.61, `ownText` 0.42, insert, delete, format, `findAtom` | ~2.75 | rule and plumbing |
| `doc/split-merge.js` | 1.90 | rule: the gestures |
| `incarnations.js` | 0.55 | rule: `id.same.concurrent` (YP14) |

### 2.4 Summary

| Layer | Total | Pure workaround | Product rule and plumbing |
| --- | --- | --- | --- |
| Block tree | 30.0 | ~6.7 | ~23.3 |
| Properties | 11.9 | ~1.0 | ~10.9 |
| Text between blocks | 16.6 | ~5.9 | ~10.7 |
| **All** | **58.5** | **~13.6 (23 %)** | **~44.9** |

The product rules that stay whatever the engine does include:
- promotion (`del.blocks.promote`);
- the layout and table display rules;
- voids and lines islands;
- the shown-kind rule;
- the virtual paragraph (`session/virtual.ts`, outside these layers);
- the delete marks by writer (now YP20 holds for text, `del.<writer>` attrs
  for blocks);
- the text order of split pieces;
- the per-path data merge;
- the LCS arrangement.

**Stored size today** (measured on this branch, which is master's code: one
writer, a seeded document):
- an empty paragraph block costs 176.1 B;
- of that, its `at` node with one candidate costs 37.7 B and its `claims`
  node 13.0 B;
- one slot item per block in a sequence written as one run costs 5.9 B (a
  sequence written block by block will cost more: estimated 6–12 B);
- 300 Enters at one spot on 1,000 blocks leave the split blocks with
  39-character ranks;
- a move costs 46 B (200 moves: 336,824 − 327,596 B).

## 3. The proposed model (YP21: move records)

YP21 is written so that the data, the merge rule and the encoding never
change between stages. A stage only adds a consumer.

### 3.1 Data in the engine

- **`ContentMove`** (content ref **12**; 11 is `ContentHold`). One
  countable unit placed in the **destination** sequence at the destination
  index (written at the end of the gap, like `insertAtGapEnd`), so its
  position among concurrent inserts is YATA's. Its content:
  - `priority`: a Lamport number;
  - an **ordered** list of id ranges `(client, clock, len)`: the units it
    moves, written as `ContentHold` writes them.
  - The moved units show at the record in that order. A record names no
    record: a write naming one is refused, and on integration those ids are
    skipped. So records never nest and the engine never meets a record
    cycle.
- **Per item, local, never encoded:** `movers`, `null` or the array of live
  records that name the item. The item's **mover** is the argmax of
  `(priority, client, clock)` over them.
  - Home visibility: `deleted = removed || holds > 0 || movers !== null`.
    A moved unit is hidden at home, the same trick as YP20's holds, so every
    reader of a sequence's length and positions sees it gone from home.
  - The engine paths that mean the engine's delete already read `removed`
    (the YP20 list).
  - `gone = removed || holds > 0`: hidden everywhere.
  - A record R **displays** unit x iff `x.mover === R && !x.gone` and R
    itself is not deleted.
- **Units that have not arrived:** units named by a record that
  this replica lacks wait in `store.pendingHolds`, with a kind tag, and take
  the record when they integrate (`applyPendingHolds`). A record never
  waits: the room rows XW-07 and YW-10 forbid a record that waits.
- **Lamport:** `doc._clock` generalizes YP13's `_markClock`. Integrating a
  mark or a move raises it to at least that record's priority, and a local
  move takes `_clock + 1`. A move made after seeing another therefore wins
  over it. Yjs ids are not Lamport timestamps, which is why a "largest id
  wins" rule would be wrong.
- **Writes:**
  - `YNode#move(index, ids)`: one record at live index `index`;
  - `ContentMove#integrate`/`#delete` add or remove the record in each
    named item's `movers` (items split at range edges);
  - `Item#split` copies `movers`; `Item#mergeWith` requires the same
    `movers`.
- **Log:** `transaction.moves` (`client, clock, len`, in order) lists the
  units whose mover or home visibility changed. Each item's `mover` holds
  the new state; the index keeps the old.

### 3.2 Merge rule and convergence

The state that decides placement is:
- the items;
- the delete set (a union);
- YP20's hold records;
- the move records: immutable once written and deleted at most once, a
  2P-set like YP20's.

`mover(x)` is a maximum over the live records naming x, and `display(x)`
is either that record's position or home. Both are functions of the
converged state. So, as with YP20, every replica that has the same updates
shows the same placement, whatever the delivery order. The fallback when a
winner is deleted is the next maximum of the same set, which needs the
`movers` array rather than a counter. **No cleanup message and no replay**:
the two things that made the historical engine order-dependent (deleting a
losing move, deleting a cycle-closing move) do not exist here.

### 3.3 Concurrent moves

- **The same unit moved twice:** the higher priority wins; between
  concurrent moves, `(priority, client, clock)`. The loser stays live as a
  fallback. Never two copies.
- **Overlapping ranges** are decided per unit, so a range can split between
  two destinations (Collabs, Yjs, Fluid).
  - For a group block move, that is today's per-member rule (MV07a): a
    member moved concurrently goes where the higher move puts it.
- **Cycles in the tree** are edytor's read rule, as today. The engine sees
  references, never the tree, so a cycle rule in the vendor folder would be
  the same code moved.
  - A block's display edge is the owner of the sequence that shows it (its
    mover's, or its home slot's), composed with the claim owners as now.
    That graph is functional: one out-edge per block.
  - The greedy acceptance in descending `(priority, client, clock)` (home
    slots: priority 0) rejects exactly the oldest edge of each cycle,
    today's choice.
  - **The rejected block shows at the root**, after the last top-level
    block, ordered by its record. The runner-up candidate goes: it is what
    made resolution global. This is a contract change (MV05's fallback) for
    the user to accept.

### 3.4 Move vs delete, move vs an edit inside

- **Block deletes** (`del.<writer>`) stay independent of placement. A
  deleted block is hidden wherever it shows, and its children take its slot
  (`del.blocks.promote`). An explicit delete beats a concurrent move (MV06a,
  `conc.delete-wins-block`).
- **A YP20 hold on a moved unit** hides it everywhere (`gone`): delete wins,
  which is Liveblocks' and Collabs' choice, not Loro's "move resurrects".
  When the hold is released by an undo, the unit shows at its current mover.
- **A record whose units are all removed** displays nothing and is purged
  (§3.6).
- **An edit inside a moved block** follows it: the block keeps its node,
  text and children (as today).
- **An edit inside a moved array item** follows: its leaves are keyed by
  the item id.
- **A text unit moved by explicit id** keeps its deletes, marks and comment
  anchors. An insert a peer typed concurrently **inside** the range stays at
  home: Kleppmann 2020's Fig. 4, Fluid's semantics. This is why a merge
  cannot be a YP21 move. A peer's append at the end of the merged block must
  join the merge (TX01, the end sentinel), and only an anchor range does
  that.

### 3.5 Undo and redo by writer

- **Undo** of a move removes the writer's record (an engine delete, as the
  undo of a text delete removes the hold record). The units fall back to the
  next live record, else home.
  - Undo of a local move keeps a concurrent remote move (the remote record
    becomes the mover): the placement ADR's undo proof points.
  - A concurrent double move with both undone comes back home, in any order.
- **Redo** copies the record with its priority (`redoItem` copies a record,
  never the units), so a peer's newer move still wins. That is today's
  behaviour, where a redone candidate keeps its `seq`.
- **History rules:**
  - a `ContentMove` the step inserted is removed, never held;
  - a released step has nothing to release: a live record is the block's
    current place;
  - `hist.undo.withdraw`, `hist.undo.restore` and
    `hist.delete-marks.release` are unchanged.

### 3.6 GC, purge, horizon

- **GC:** a live record is never collected (it is a mover or a fallback),
  and its `gc` keeps its content. A removed record is collected like any
  item.
- **The home item** of a moved unit is its identity: never collected while
  any record names it.
- **The purge** (`crdt/purge.ts`, the room) removes:
  - the losing records older than the horizon (no undo can make them movers
    again, `hist.purge.horizon`);
  - the records whose units are all removed.

  This replaces today's top-2 candidate compaction.

### 3.7 Encoding, snapshots, restore

- **Ref 12:** `writeLen(priority)`, `writeLen(ranges)`, then for each range
  `writeLeftID` + `writeLen`, about 6–12 bytes. A record is one unit:
  `splice` and `mergeWith` never apply. `mergeUpdates` and `diffUpdate`
  copy it whole.
- **A snapshot** encodes records as items; a receiver rebuilds `movers` as
  they integrate. History versions are snapshots.
- **`restoreTo`** writes through the facade's operations, so a restored
  placement is a move like any other.
- **Schema generation 8** (wire word 14008): generation 7 rooms, browser
  stores and versions are refused, never converted (the user's rule).
- Peers without the fork reject ref 12, as y-octo rejects 11.

### 3.8 The index

- The index folds `transaction.moves` as it folds `transaction.holds`.
  - A unit hidden at home is a removal edit in its home sequence.
  - The record's display gains it at the record's position.
  - Mid-transaction folds read the pending log.
- **For the tree:** a slot → block map. A block's display parent is the
  owner of its mover's sequence. Its place in that parent's child list is
  found from the record's sequence neighbours, through the engine's search
  markers (`indexOfId`), never by walking the parent's sequence.
- **For arrays:** the data owner's order sequence changes are `meta`.

### 3.9 Worker-safety

Engine code, no DOM, no Svelte. `src/lib/crdt` and `src/lib/cloudflare`
stay Worker-safe, and `pnpm check:worker` holds. Two room changes:
- the purge's record compaction is a room task;
- the validator (`room.marks.writer`, `room.locks`, `room.validate.inverse`)
  reads records where it read `at` candidates. A record's id is its writer,
  as a hold's is.

## 4. What changes in edytor

### 4.1 Properties (stage 1)

- Each data owner keeps one order sequence for every array it holds, in a
  node that exists from the owner's creation (a sequence created later would
  race a peer's creation of it, and one would win):
  - a block: its node's own list part, unused today (stage 2 puts the
    block's children slots in the same sequence, a different slot kind each
    reader skips);
  - an atom: its node's own list part;
  - the document: the `docdata` root's list part.
- That sequence holds one slot per array item, `{p: path, i: id}`. An
  item's existence is its live slot (was `~id#`). A move is a YP21 record
  naming the slot (was `~id>`). The order is the sequence's (was the rank
  sort). Two peers adopting one array (derived ids, `table.conc.adopt`)
  write two slots for one id; the read keeps the first live slot per id.
- **Removed:** the `~id#`/`~id>` keys, `itemsOf`'s sort, `placeOf`,
  `lay`'s rank allocation, `apply`'s rank writes, `order`'s re-ranking
  (the longest increasing run still decides which items move).
- **Remains:** the leaves, per-path merge, `data.atomic`, derived ids, the
  LCS arrangement, patch planning, the proxies, `DataWrites`.
- **Rows that must hold:** `data.*`, `data.columns`, `table.columns`,
  `table.move-column`, `table.conc.*` (adopt, column-move, column-insert),
  `callout.icon`.

### 4.2 Block tree (stage 2)

- Each parent's children are home slots in its node's own list part (the
  sequence stage 1 opened, beside the data slots); the root's children are in
  the registry root's list part. No node is added, which is where the stored
  saving comes from (§5.3).
  - A creation writes the child's slot after its displayed left sibling's
    current item (YATA origin).
  - A move is one record in the destination parent's sequence, naming the
    moved blocks' home slots in order.
- **Removed:**
  - `placement/rank.ts` (only once stage 1 removed the arrays' use);
  - `candidatesOf`, the argmax and runner-up of `resolvePlacements`,
    `rehomeRankBelow`, `sourceRank`, `ranksAt`, `writePlacement`'s
    candidate and its top-2 compaction;
  - `ranksFor`, `exitRanks` and `pieceRanks` (an outdent's slot goes after
    its source's item);
  - the index's `argmaxOf`, `noteCands`, `byArgParent`, the irregular flag
    and the global resolution pass (local cycles, §3.3);
  - `textRanker`'s rank permutation;
  - the `at` nodes.
- **Remains:**
  - `displaySlotOf` and the line slots;
  - the layout and table rules;
  - `typeOf`;
  - the children index (now ordered by sequence position, not by rank
    string);
  - promotion (now positional: a deleted block's children are spliced at
    its place, and `promotedRank` goes);
  - `order.split.text`, as a rule over consecutive pieces of one text under
    one parent;
  - the gestures;
  - the acyclic acceptance and `isSelfOrDescendant`.
- **Rows that must hold:**
  - `del.blocks.promote`, `conc.void-children`, `conc.island-reset`,
    `conc.island-lines`, `conc.merge-adopt`, `layout.*`, `table.*`,
    `hist.undo.withdraw`;
  - `order.split.text` (two Enters in one block keep text order on every
    client-id pair);
  - `order.insert.run` (YATA's origin rule makes it structural);
  - `id.same.concurrent`;
  - MV01–MV10 and the placement ADR's undo proof points.
  - `order.rank.format` and the rank-growth rows retire with ranks.

### 4.3 Text (stage 3)

- **Nothing in the claims, streams and boundaries layer is removed**, for
  three reasons:
  - splits stay boundary markers;
  - merges stay claims, since a YP21 record cannot take a peer's
    concurrent append (§3.4);
  - an anchor-range move costs more than the 5.9 KB it would remove (the
    historical engine's two files alone: 10.0 KB).
- What stage 3 can do is a **text drag** (`clipboard/moveText.ts`,
  `dropText`): one record at the drop point instead of `insertFlow` plus
  `replaceRange`.
  - The moved text keeps its identity, marks, comments and concurrent
    deletes.
  - A concurrent insert inside the dragged range stays where it was. That is
    already true today, where the moved text is also a copy.
  - The display (streams, rows, `displayOf`) must then splice a record's
    units at the record. That is new code in the text layer, for a product
    gain, not a size gain.
- **Rows that must hold:** `flow.*`, `del.range.*`, `mark.*`,
  `comment.anchor`, `comment.copy`, `sel.ride.*`.

### 4.4 Contract decisions that must still hold (edytor-product-contract)

| Decision | How it holds |
| --- | --- |
| Concurrent double delete plus both undo restores once | Unchanged: YP20 holds. A moved unit's visibility is `!removed && holds === 0` at its mover |
| Undo of a block creation keeps another author's text | Unchanged: withdraw marks. A withdrawn block's slot stays where it is |
| Deleting a parent promotes its children | Unchanged rule. Promotion becomes positional (splice at the parent's place) |
| Empty document shows a virtual paragraph | Unchanged (`session/virtual.ts`) |
| Explicit delete beats a concurrent unseen move | Delete marks and holds are independent of movers; `gone` wins |
| Undo of a split folds the tail back | Unchanged: boundaries stay |

## 5. Size estimate

### 5.1 Engine cost

YP20 is the calibration: its core (`ContentHold`, `holdRange`, pending,
log) minifies to 1.70 KB, and the whole patch measured +2.6 KB. YP21 adds:
- `ContentMove`: ~0.6 KB;
- the `movers` argmax upkeep: ~0.4;
- pending with a kind: ~0.2;
- the log, `deleted`, `split`/`mergeWith`, Lamport: ~0.3;
- `YNode#move`: ~0.3;
- ref 12 and redo: ~0.1.

Total **1.8–2.6 KB**, medium confidence. The anchor-range alternative (Yjs
#357) costs at least 2.7 KB for `ContentMove` plus a move-aware reader
(`ListCursor`, 7.4 KB), plus the integration inheritance: **≥ 6 KB**.

### 5.2 Per stage

| Stage | Edytor removed | Engine added | Edytor added | Net | Confidence |
| --- | --- | --- | --- | --- | --- |
| 1 list move (arrays) | ~1.0 | 1.8–2.6 | 0.4–0.6 (order sequence reads, fold) | **+1.2 to +2.2 (grows)** | medium |
| 2 tree move (on stage 1) | ~5.4–6.7 (rank.ts included) | +0.1–0.3 | 1.5–2.0 (sequence-ordered children, positional promotion, slot map) | **−3.1 to −5.1** | low |
| 2 alone (arrays keep ranks: rank.ts stays) | ~2.7–4.0 | 1.8–2.6 | 1.5–2.0 | **+0.3 to +1.9 (grows)** | low |
| 3 text range move (drag) | ~0.3 | +0.1 | 1.0–1.5 (records in streams and rows) | **+0.8 to +1.3 (grows)** | low |
| 3 with anchor ranges (merges as moves) | ~5.9 | ≥ 6 | 1.5–2.5 (streams through moved ranges) | **≥ +1.6 (grows)** | medium |
| **1 + 2** | ~6.4–7.7 | 1.9–2.9 | 1.9–2.6 | **−0.9 to −3.7** (central −2.3) | low |

The edytor-added column is the least certain. The children index today is
sorted by comparable rank strings (binary search in `seek`, `bySlot`); a
sequence gives no comparable key, so the index needs a slot → position
map kept by the fold. That is new code in the index's most delicate part.

### 5.3 Outside the bundle (estimates from measured parts)

- **Stored size:** −26 to −32 B per block (37.7 B `at` node and candidate →
  a 6–12 B slot), about 15–18 % of an empty paragraph block.
- **Move bytes:** 46 B → an estimated 15–20 B per move.
- **Rank growth:** gone. Today: 39-character ranks after 300 Enters at one
  spot; the EW-02 bounds of `rank-growth.test.ts`.

## 6. Performance contracts that must hold

- **A keystroke's work is flat at 5,000 vs 1,000 blocks** (`view.scale`,
  the index counters `folds`, `foldedPairs`, `foldedStructs`, `recomputes`,
  `itemsWalked`). Typing writes no slot and no record. An unmoved item pays
  one more field read in `deleted` (`movers !== null`). No row may walk a
  sequence for a keystroke.
- **Enter, a block move and Tab touch only the slots they write.** The
  index locates a slot by its sequence neighbours through search markers,
  never by walking the parent's sequence (the root's holds 5,000 slots).
  Under a stated contract: ten times the blocks gives the same recomputes
  and at most eleven times the fold input.
- **A cycle resolves locally:** O(depth + cycle length), no global pass
  (§3.3). New row: a 5,000-block document with a two-block cycle race
  counts the same index work as a 1,000-block one.
- **Load and encode scale linearly.** Integrating a record costs its named
  units. Loading rebuilds `movers` once per named unit. `bench:crdt`'s
  `scale` workload reports load and encode at 1k/5k with moves.
- **Stored size:** a 1,000-block seed shrinks by at least 25 kB; 200 moves
  cost at most 4 kB (today 9.2 kB). Measured by `bench:crdt` encode and
  `node bench/soak/size.mjs`.

## 7. Risks, ranked

1. **The index rewrite.** The placement half of the index moves from
   rank-sorted child lists to sequence-ordered ones, with promotion made
   positional. This is the code where order rows were won one by one:
   `order.split.text`, `order.insert.run`, the R3/R4 residuals,
   DR-crdt-1…7. Every one must be re-proved on every swept client-id pair,
   and the index self-checks must hold. A miss shows as a wrong order on
   some client-id pairs, not as a crash.
2. **The saving does not materialize.** Net −0.9 to −3.7 KB is a band whose
   upper half depends on the edytor-added code staying under 2 KB, and on
   `rank.ts` going entirely. That needs both stages, because data arrays use
   `rankAfter`. Stage 2 alone grows the bundle.
3. **Semantics shift in races.** These are deterministic but different:
   - a cycle's rejected block goes to the root rather than its runner-up;
   - a concurrent tie between two new slots at one origin is ordered by
     YATA's client rule rather than by rank ties;
   - two adoptions of one array give duplicate slots, read once;
   - delete beats a concurrent move, as today, but now through a per-unit
     `gone`.

   Each needs a contract row and the user's agreement where it changes
   one.
4. **Every reader of `deleted`.** A moved unit reads as deleted at home.
   The YP20 split between `deleted` and `removed` already lists the engine
   paths that mean the engine's delete. A missed path makes a replica that
   moved a unit diverge from one that did not. The random corpus, the
   replica harness and the DST lanes are the check, as for YP20.
5. **Wire and storage cutover.** Generation 8: every room, browser store
   and history version of generation 7 is dropped, as the user's rule
   allows.
6. **The room's validator.** The H2 and H10 rules read placements;
   a mistake there either refuses legitimate moves or admits an edit of a
   locked block's placement.

## 8. Staged plan and stop rules

Each stage is shippable alone: the record format, the merge rule and the
encoding are fixed in stage 1 and never redone.

**Stage 1 — list move (properties' arrays): YP21 in the engine.**
- Proves it:
  - `src/tests/crdt/yp21-moves.test.ts`:
    - two writers move one unit, in both orders;
    - a group move overlapping a single move;
    - undo, redo and a fallback;
    - a record whose units arrive later;
    - merged, diffed and reloaded updates;
    - three seeded differentials with search markers on and off;
  - the upstream suite unchanged;
  - `encoding.tests.js` pinning ref 12;
  - the `data.*` and `table.conc.*` rows;
  - the random corpus (every adapter).
- Estimated saving: **+1.2 to +2.2 KB (the bundle grows).**
- **Stop rule: fails.** Do not ship stage 1 alone. Its only reason to
  exist is to let stage 2 delete `rank.ts`.

**Stage 2 — tree move (blocks), on stage 1.**
- Proves it:
  - MV01–MV10;
  - `order-scope.test.ts`, `split-text-order.test.ts`,
    `dr-crdt-order.test.ts`, `block-insert-runs.test.ts`,
    `gesture-order-sweep.test.ts`;
  - `display-cycle.test.ts`, `reachability.test.ts`;
  - `same-id-concurrent.test.ts`;
  - the layout and table fuzz invariants (`layout-shape`, `table-shape`);
  - the replica harness's `wellFormed` set;
  - `keystroke-scale.test.tsx` and a new cycle-scale row;
  - Playwright `block-handles.spec.ts`.
- Estimated saving: **−3.1 to −5.1 KB** on top of stage 1, **−0.9 to −3.7
  cumulative.**
- **Stop rule: borderline.** Prototype stages 1 and 2 together on a branch.
  Stop if the measured cumulative net is under 3 KB, or if any order row
  needs a new residual. Convergence can be argued: per-unit argmax over a
  2P-set (§3.2), plus the functional-graph acceptance (§1.2).

**Stage 3 — text range move.**
- Merges cannot use YP21 (§3.4), so the claims, streams and anchored layers
  stay. A drag of a text selection can use it.
- Proves it: `flow.*`, `comment.*` and `sel.ride.*`, the DST corpus, and a
  new row: a dragged range keeps its comment thread and a concurrent
  delete.
- Estimated saving: **+0.8 to +1.3 KB (the bundle grows)**; an anchor-range
  variant grows it by 1.6 KB or more.
- **Stop rule: fails as a size stage.** It is a product improvement (text
  drag keeps identity) to decide on its own merits.

**Overall:** stages 1 + 2 + 3 net ≈ −2.9 to +0.4 KB. Under the 3 KB floor.

## 9. What would be worth doing instead

Each is independent of the move. The sizes are estimates from the measured
parts of §2 (items 2 and 3 from the YP20 design's survey). Item 1 needs one
engine rule (a sort class) and no new engine state; items 2 and 3 are engine
changes of their own.

1. **Merge claims as items in the holder's text.** A merge inserts a 1-unit
   claim item `{m}` at the end of the holder's stream (the gap before the
   next boundary), instead of `{m, a, r}` in the holder's `claims` list.
   - YATA then decides which piece a concurrent split leaves it in:
     `merge.claim.anchor` without a retargeting pass.
   - One sort class orders, among the items of one origin, content and
     boundaries before claim items. That gives `merge.claim.anchor`'s
     outcomes and today's:
     - Enter after "he" ‖ merge → "he", "lloworld";
     - Enter at the end ‖ merge → "hello", "world";
     - Enter at the start ‖ merge → "", "helloworld";
     - a concurrent "!" typed at the end ‖ merge → "hello!world" (the
       typist's later characters stay before the claim too: their origin
       is the "!").
   - Like a paired mark, a claim item's content is never collected (its
     class must survive).
   - Removed: `index/anchored.js` (2.42), the `claims` nodes (13.0 B per
     block measured), `listClaims`/effective-claims plumbing, and the
     split's re-insertion of moved claims.
   - Kept: the claim graph (owners by max stamp, cycles), now read from the
     rows, which track claim items as they track boundaries.
   - Net ≈ **−2.0 to −2.8 KB**, medium-low confidence. The risk is
     moderate: rows, streams and claims change; the 48 client-id pairs of
     `text/merge-claim-anchor.test.ts` are the check.
2. **Block delete and withdraw marks as YP20 holds** on the registry value
   (the YP20 survey row: ~1.5 KB). Together with 1, above the 3 KB floor.
3. **Multi-value keys instead of YP14 incarnations** (the YP20 survey row:
   ~1.8 KB).
4. **A parentless cycle fallback** in today's placements: a rejected block
   shows at the root, as §3.3 proposes. It removes the runner-up path and
   the global resolution pass, ~0.4–0.6 KB, and makes a cycle race's index
   work local. It is a contract change (MV05's fallback) for the user.

If stored size or rank growth later becomes a product problem, YP21
stages 1 and 2 together are the change that fixes both. This design is
written so that nothing in it has to be redone then.

## 10. Method and sources

**Measurements (this branch, 2026-10-15):**
- `node scripts/bundle-size.mjs --top 400 --only minimal,all`;
- function-level shares through the builds' source maps (§2);
- the minified size of the historical move with esbuild:
  `node_modules/yjs-14-move/src/structs/ContentMove.js`, `src/utils/ListCursor.js`;
- the minified size of the YP20 core (`Item.js` lines 880–1099);
- stored sizes with the vendored engine and `createDocument`:
  - 1,000 seeded paragraphs, then 300 splits at one spot and 200 moves;
  - the same nodes built raw, with and without `at`, with and without
    `claims`, and with one slot sequence.

**Sources.**
- Kleppmann 2020 — https://martin.kleppmann.com/papers/list-move-papoc20.pdf
- Kleppmann et al. 2021 — https://martin.kleppmann.com/papers/move-op.pdf
- Da and Kleppmann 2024 — https://arxiv.org/abs/2311.14007
- "CRDTs: the hard parts" — https://speakerdeck.com/ept/crdts-the-hard-parts
- Kleppmann, block elements for Peritext 2 — https://martinkl.notion.site/Block-elements-in-rich-text-CRDT-for-Peritext-2-a3b69f886dbc4ad1abe81cea0b3e6623
- Lord, splicing CRDTs — https://lord.io/splicing-crdts/
- Loro:
  - movable list state — https://github.com/loro-dev/loro/blob/main/crates/loro-internal/src/state/movable_list_state.rs
  - list op — https://github.com/loro-dev/loro/blob/main/crates/loro-internal/src/container/list/list_op.rs
  - tree op — https://github.com/loro-dev/loro/blob/main/crates/loro-internal/src/container/tree/tree_op.rs
  - tree diff — https://github.com/loro-dev/loro/blob/main/crates/loro-internal/src/diff_calc/tree.rs
  - movable tree blog — https://loro.dev/blog/movable-tree
  - movable tree benchmark — https://github.com/Leeeon233/movable-tree-crdt
  - issue #673 — https://github.com/loro-dev/loro/issues/673
- Automerge:
  - PR #706 — https://github.com/automerge/automerge/pull/706
  - classic issue #319 — https://github.com/automerge/automerge-classic/issues/319
  - rich text schema — https://automerge.org/docs/reference/under-the-hood/rich-text-schema/
- Liveblocks `LiveList.ts` — https://github.com/liveblocks/liveblocks/blob/main/packages/liveblocks-core/src/crdts/LiveList.ts
- rocicorp `fractional-indexing` — https://github.com/rocicorp/fractional-indexing
- Figma, multiplayer — https://www.figma.com/blog/how-figmas-multiplayer-technology-works/
- Wallace, mutable tree — https://madebyevan.com/algos/crdt-mutable-tree-hierarchy/
- Weidner:
  - CRDT survey part 2 — https://mattweidner.com/2023/09/26/crdt-survey-2.html
  - Collabs `c_list.ts` — https://github.com/composablesys/collabs/blob/master/crdts/src/list/c_list.ts
  - The Art of the Fugue — https://arxiv.org/abs/2305.00583
- json-joy:
  - issue #223 — https://github.com/streamich/json-joy/issues/223
  - issue #1038 — https://github.com/streamich/json-joy/issues/1038
- Eg-walker — https://arxiv.org/abs/2409.14252
- Yjs:
  - PR #357 — https://github.com/yjs/yjs/pull/357
  - issue #694 — https://github.com/yjs/yjs/issues/694
  - issue #475 — https://github.com/yjs/yjs/issues/475
- yrs:
  - removal, PR #617 — https://github.com/y-crdt/y-crdt/pull/617
  - `moving.rs` at v0.17.4 — https://github.com/y-crdt/y-crdt/blob/v0.17.4/yrs/src/moving.rs
- y-octo — https://github.com/y-crdt/y-octo
- Maram — https://arxiv.org/abs/2103.04828
- Anjana et al. 2022 — https://arxiv.org/abs/2203.10285
- `crdt_tree` — https://github.com/maidsafe/crdt_tree
- Notion:
  - concurrent editing with CRDTs — https://www.notion.com/blog/how-notion-handles-concurrent-editing-with-crdts
  - data model — https://www.notion.com/blog/data-model-behind-notion
- CKEditor 5:
  - `transform.ts` — https://github.com/ckeditor/ckeditor5/blob/master/packages/ckeditor5-engine/src/model/operation/transform.ts
- Fluid SharedTree, array merge semantics — https://github.com/microsoft/FluidFramework/blob/main/packages/dds/tree/docs/user-facing/array-merge-semantics.md
- y-prosemirror, `sync-plugin.js` — https://github.com/yjs/y-prosemirror/blob/master/src/sync-plugin.js
