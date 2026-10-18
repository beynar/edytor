# A move in the fork (YP21?) — design

Status: prototyped (2026-10-17, branch `engine-move-proto`, fork patch
YP22, stages 1 and 2 together, schema generation 9, with fork patch YP23
for an upstream crash the wide corpus reached; the measured numbers
and what the build changed against this design are in
["Prototype: measured"](#prototype-measured) at the end; the bundle
cost the build added was then cut from 12.1 to 8.2 KB,
["Cutting the move's bundle cost"](#cutting-the-moves-bundle-cost)). The sections
below are the design as written on 2026-10-15: every number in them is
either measured then (said so) or an estimate (with its confidence). The
model followed is
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

## Prototype: measured

Built on branch `engine-move-proto` (2026-10-17, finished 2026-10-18): fork
patch **YP22** (YP21 was taken by the merge-claim items, PR #27), stages 1
(arrays) and 2 (block tree) together, schema generation 9 (wire word 14009,
browser database `edytor-v14-g9:`), and fork patch **YP23** (an upstream
crash the wide corpus reached). Stage 3 (text) was not built: merges stay
claim items, splits stay boundaries, `clipboard/moveText.ts` is untouched.

Every number below is of the final tree (the prototype plus the follow-up
the review of PR #29 asked for, last section), measured on one machine
(Apple M4 Pro, 14 cores, Node v24.22.0) against a fresh export of the
branch's base, `origin/engine-cuts` (`d5afd25b`, PR #27 merged; the merge
base of this branch), with the same scripts on both trees, before and after
alternating: `scratchpad/measure.mjs` (stored sizes, heap, the cycle race),
a realistic-document script (below), `scripts/bundle-size.mjs`,
`bench/run.js` and `bench/scale.js`, and a load-to-first-keystroke script.
The machine was not idle: other sessions' test runs and Spotlight kept the
load average at 19–26 during the timings, so a single timing row moves by
±20 % between runs; the sizes, the counts and the bundle are deterministic.
The bench's undo and memory lanes run the document's history on both trees
(the base's copy of `bench/lib/baseline.js` was given the same two-line
change; review item 8), and the base's cycle-race count comes from a
`foldStats.placed` counter added to the scratch export only.

### Sizes

| Measure | Before | After | Change |
| --- | --- | --- | --- |
| Stored, 1,000 seeded paragraphs (about 30 characters each) | 199,158 B (198.8 B/block) | 166,554 B (166.2 B/block) | −32.6 B/block (−16.4 %) |
| Stored, 1,000 paragraphs of about 300 characters, typed in runs of 8–40 characters with Enter at each end | 654,076 B (654.1 B/block) | 615,266 B (615.3 B/block) | −38.8 B/block (−5.9 %) |
| The same document after an edit history (200 Enters at random offsets, 100 block moves, 100 deletes of 5–20 characters, 50 block deletes, 5 undos; 1,146 blocks shown) | 730,420 B (637.4 B/block) | 680,558 B (593.9 B/block) | −49,862 B (−6.8 %) |
| 5,000 typed paragraphs (as above) | 3,293,474 B (658.7 B/block) | 3,100,463 B (620.1 B/block) | −5.9 % |
| 5,000 typed paragraphs after five times that history (1,000 Enters, 500 moves, 500 word deletes, 250 block deletes, 5 undos; 5,748 blocks shown) | 3,679,434 B (640.1 B/block) | 3,434,282 B (597.5 B/block) | −245,152 B (−6.7 %) |
| Stored, 300 Enters at one spot (each with two typed characters) | 90,898 B (303 B/Enter) | 81,624 B (272.1 B/Enter) | −31 B/Enter (−10 %) |
| Longest order key after those Enters | 39 chars, stored in every block's `at` node | 54 chars, in memory only (`placement/keys.ts`; nothing is stored) | no stored rank |
| Stored, 200 single-block moves | 9,007 B (45 B/move) | 2,500 B (12.5 B/move) | −72 % |
| Move update, same parent (bench p50) / 500 sequential moves | 80 B / 75 B per move | 44 B / 34 B per move | −45 % / −55 % |
| Heap after loading 1,000 / 5,000 blocks | 8.2 / 33.7 MB | 7.1 / 29.7 MB | −13 % / −12 % |
| Heap retained by 1,000 / 5,000 blocks (bench, three documents held) | 23.8 / 123 MB | 19.1 / 99.6 MB | −20 % / −19 % |
| Cycle race (two blocks nested into each other), placements decided at 1,000 / 5,000 blocks | 1,001 / 5,001 | 2–4 / 2 | local |
| Bundle `minimal`, edytor's own min / total min / gzip | 414.6 / 461.4 / 158.7 KB | 426.7 / 473.5 / 162.6 KB | +12.1 / +12.1 / +3.9 KB |
| Bundle `all`, own / total / gzip | 644.0 / 692.6 / 241.6 KB | 656.2 / 704.8 / 245.5 KB | +12.2 / +12.2 / +3.9 KB |
| Bundle `export`, own / total / gzip | 51.0 / 76.6 / 28.9 KB | 51.0 / 76.6 / 28.9 KB | 0 |
| Purge of 1,000 of 1,001 deleted blocks: what stays (the prototype's measurement, not repeated) | (ratio bound 1/5 of the deleted document) | 39,268 B for 189,950 B deleted, 176,920 B full; 374 B visible alone | the tombstones (a registry key and an attribution key per removed block) |

The real documents gain less than the empty-paragraph seed: a block's text
and its typing runs cost the same on both trees, and the change is the
placement (a slot instead of an `at` node with a stored rank, a move one
record instead of a candidate), about 40 B per block.

The bundle grows by 12.1 KB (`minimal`) against the base. The prototype's
first table read 424.6 → 423.9 KB, but that "before" does not reproduce:
a fresh export of `origin/engine-cuts` builds 414.6 KB with the same script
(`origin/master`, before PR #27, 417.0 KB), and the prototype commit
(`46aecf81`) 423.9 KB, so the prototype was already 9.3 KB larger and the
review's follow-up added 2.8 KB. By directory (`--by dir`, `minimal`): the
engine +4.4 KB (`crdt/vendor/yjs`: the records, their chains and the sort
that reads them, the split keys, the GC rule that keeps a slot's key), the
index +4.8 KB (`crdt/text`: the candidate edges, `settle`, the one-pass
rebuild), `crdt/placement` +3.5 KB (the writes that anchor where the index
shows a block, the chain each record names), `crdt/data` +1.3 KB, against
`crdt/doc` −1.8 KB and `crdt/flow` −0.3 KB. The design's −0.9 to −3.7 KB
estimate for stages 1 + 2 does not hold.

### Timings

`bench/run.js` (two runs a side) and `bench/scale.js` (three more), before
and after alternating, medians; the scale rows are the median of all five
runs, the facade rows of the two `bench/run.js` runs. The scale rows run on
long-lived documents; the facade lanes restore a fresh document from a
snapshot for every sample, so their time is the first operation after a
load and includes the index's first build.

| Measure | Before | After |
| --- | --- | --- |
| Keystroke on a long-lived document, 1,000 / 5,000 blocks (scale) | 0.07 / 0.04 ms | 0.08 / 0.04 ms |
| Remote keystroke, 5,000 blocks | 0.02 ms | 0.02 ms |
| Enter, 1,000 / 5,000 blocks | 0.26 / 0.20 ms | 0.27 / 0.26 ms |
| Backspace, 1,000 / 5,000 blocks | 0.09 / 0.10 ms | 0.09 / 0.10 ms |
| Range delete of 40 blocks, 1,000 / 5,000 blocks | 2.53 / 1.66 ms | 2.19 / 2.02 ms |
| Delete of 1,000 blocks, range / selected blocks | 14.9 / 21.3 ms | 20.1 / 18.3 ms |
| Load 1,000 / 5,000 blocks (scale) | 16.9 / 66.7 ms | 14.6 / 67.9 ms |
| Construct 1,000 / 5,000 blocks (scale) | 68.4 / 198 ms | 68.9 / 223 ms |
| Encode 1,000 blocks (p50) | 1.32 ms | 1.01 ms |
| Encode / load after 5,000 history steps | 0.61 / 3.13 ms | 0.78 / 3.22 ms |
| Undo, last of 10 (p50, the document's history) | 0.07 ms | 0.08 ms |
| Undo after 5,000 history steps | 0.44 ms | 0.48 ms |
| First keystroke after a load, 1,000 blocks (facade lane) | 1.68 ms | 1.83 ms |
| First move after a load, same parent / a group of 5 (facade lane) | 0.15 / 0.18 ms | 0.21 / 0.20 ms |
| First block delete after a load, 1,000 blocks (facade lane) | 1.52 ms | 1.68 ms |
| Load 1,000 blocks (workload p50) | 2.29 ms | 2.63 ms |

Load to first keystroke, timed alone (a document restored from a snapshot:
apply, view creation, first and second keystroke; five rounds alternating,
each the median of 20 samples, medians of the rounds):

| Blocks | Apply | View creation | First keystroke | Second | Load to first keystroke |
| --- | --- | --- | --- | --- | --- |
| 1,000 (before → after) | 3.03 → 2.38 ms | 4.52 → 4.85 ms | 1.78 → 1.84 ms | 0.05 → 0.05 ms | 11.59 → 10.60 ms (−9 %) |
| 5,000 (before → after) | 15.11 → 14.53 ms | 23.48 → 24.63 ms | 10.75 → 8.17 ms | 0.05 → 0.06 ms | 50.27 → 46.68 ms (−7 %) |

Building a 5,000-block document from a value (`createDocument`), five
rounds: 119.1 → 125.5 ms (+5 %): the fold reads each touched block's engine
parent from its slot's item, where the base read its `at` node.

Rows that got worse beyond the noise: the delete of 1,000 blocks as a range
(+35 %), construction at 5,000 blocks (+13 %; +5 % through
`createDocument`), Enter at 5,000 blocks (+30 %), the 40-block range delete
at 5,000 blocks (+22 %, better at 1,000), encode after 5,000 history steps
(+28 %), and the first operation after a load in the facade lanes (+9 to
+40 %, a fraction of a millisecond). The selected-blocks delete, encode,
load and the load-to-first-keystroke path are faster.

### What the build changed against the design

1. **Concurrent order needs more than the origin rule.** The design kept
   `order.insert.run` structural (YATA's origin) and dropped `sourceRank`,
   `exitRanks` and `pieceRanks` as workarounds. The gesture sweeps
   (`gesture-order-sweep.test.ts`, 240 client-id pairs a row;
   `dr-crdt-order.test.ts`) showed what they encoded: two peers' exits
   into one gap from one list sort by the clients' ids under YATA alone.
   The fork's sort rule (`utils/marks.js`) now orders the items of one
   origin by class, then:
   - a move record by the chain it stands at (`ContentMove.at`: the home
     slots from the root sequence down to the block it stands at, by
     default the first it moves, named by the writer, `unitChain`),
     compared level by level (`sourceOrder`), then its part (`ContentMove.part`:
     `PART` in `doc/steps.ts` — a head holding the items before the block,
     new blocks kept before the next, a head holding the block, the block,
     new blocks after it), then the stronger record (priority, client);
   - a block slot a split made by its split's boundary item
     (`BlockSlot.s`, the boundary's id; two boundaries in one text by their
     order there, in different texts by the text): `order.split.text`
     becomes structural and the text ranker (`display.ts textRanker`, its
     regroup wiring in the index) is removed; a collected slot keeps its
     key (`Item#gc` trims the content to it), since a sort that read
     content collection erases diverged between a replica that collected
     and one that had not;
   - `extendsRun` reads the item's ids and its parent node (a list item
     outside a `content` node), never its content, for the same reason.
   A split's head list and its new blocks are created in the innermost
   level at the split and moved out by records standing at the block they
   stand beside, written last first so each stands before the one written
   before it (`splitOut`).
2. **A record waits for its units and its chain.** `getMissing` treats a
   record's named units and every unit of its chain as dependencies, like
   an origin (a Skip standing for one too). The design had records
   integrate at once.
3. **One priority per writer until it sees a peer's.** `doc._clock` rises
   only on a peer's record, so a writer's gestures between syncs win or
   lose a contested block together (`FX-05`'s mixed outcomes are gone).
4. **Read-time promotion writes no move.** Deleting a block
   (`del.blocks.promote`), retyping one to a void kind
   (`conc.void-children`), a dissolving layout (`layout.single`) and a
   deleted layout item (`layout.only-items`) leave the children's home
   slots where they are; the read shows them in the slot. The design kept
   the delete's planned moves; with records they sorted after everything
   promoted at the slot, so a tail a peer split off or a child a peer added
   read first. A plan of `deleteBlocks` has no `moveBlocks` step and its
   `effect.moves` lists no children.
5. **The runner and oracle fingerprints.** A record written beside a unit
   carries the record's later units along (`placeAfter`), so their mover
   changes without a move: the F-O11 oracle and the corpus runner compare
   sequences and relative order, never a record's identity.
6. **Two engine findings the wide corpus (seeds 1–1,000, 300 ops) made.**
   A record waits while a Skip stands for a unit it names or stands at
   (`getMissing`: a skip counts in the clock but holds no item), or two
   records at one origin sorted by their units' order on one replica and
   by priority on another (the raw `pendingMoves` path is gone: it was the
   only reader of a skipped unit). And upstream's `BlockSet.exclude` read a
   client's first and last struct once, before the loop over the known
   ranges, so a GC spanning a skip, known ids and the state's end
   integrated whole and its delete-set entry outran the store
   (`tryMerge` threw) — the corpus's tracked `seed-140` crash, reached in a
   dozen more raw seeds once a move is one record: fork patch YP23
   (`UPSTREAM.md`, `yp23-exclude.test.ts`).
7. **A children list compares one key space.** The index's order keys are
   local to a replica (`placement/keys.ts`); a child shown under its
   parent's claim owner after a promotion (a block deleted inside a
   merged-away block) was keyed in the merged block's sequence space and
   compared with the owner's own children's keys — two replicas that
   folded the writes in different orders read different lists (model
   seeds 291, 506, 671 of the wide corpus). `displaySlotOf` keys it in the
   owner's claimed space whatever the hops (`display-keys.test.ts`). With
   stored ranks the mix was harmless: every replica held the same strings.
8. **The runner's lossy window travels with a sync.** A peer in the window
   a dropped pending attribute write opens (the old value's delete
   integrated, the new value not) hands it to a peer syncing from it; the
   step check skips the receiver too until it holds the dropped ranges
   (`inheritWindow`; roles seed 131, a type attr missing on a peer that
   never dropped anything). And a block shown under a block an undo
   lawfully removes shows elsewhere afterwards — at home, the removed
   block's sequence and the records it held gone with it — which the
   runner's placement fingerprint (now the display edge, not the raw
   candidates) sees and the undo's envelope allows (model seed 615); so
   does a block whose creation the undo or redo withdraws or brings back:
   the records its creation wrote beside it go and come back with the
   step, so it shows at home while withdrawn (doc seeds 848, 859: a split
   of a block with children, undone).

### Behaviour changes for the user's decision

Each existing test whose expected value changed, with before → after (the
review's decisions are in the last section: the cycle fallback went back
to "where it stood", FX-06 stands):

- MV05 / MV05a (`placement/concurrency.test.ts`, `scenarios/active-model.ts`):
  unchanged from the base — the block whose move a cycle drops is back
  where it stood (index 0); the first prototype showed it at the root's
  tail (index 1), which the review rejected.
- `cycle-scale.test.ts` (new with the prototype): the dropped block is at
  its home between its old neighbours (index `n / 2`, the root holding
  `n − 1` blocks), not last.
- MV10: a move writes nothing inside the moved node: `deepEvents` after
  the move is 0 (was > 0); a remote text edit still reaches the handle.
- `prepared-ops.test.ts` D5: `deleteBlock('x')` and
  `deleteBlock('x', { keepChildren: true })` plan `['deleteBlock']` (was
  `['moveBlocks', 'deleteBlock']`), `effect.moves` `[]` (was `['y']`).
- `layout.test.ts` "deleting one of three columns": a reader without the
  layout role sees `C[K1[A], B, K3[D]] Z` (the row's `writes` check is off;
  the role sees `C[K1[A], K3[D]] B Z` as before).
- `order-scope.test.ts` (pinned residuals, now the serial order on every
  client-id pair): Enter at a paragraph's end ‖ Backspace at the first
  item below → `p|n|a|b` only (was either order); two Enters by one peer ‖
  Backspace → `hello| wo|rld|a|b` (was `hello| wo|a|rld|b`); Tab on y ‖
  Enter at the end of the last child above → `x|k|n|y` only; Enter at the
  end and typing ‖ Enter in the middle → `P|hello| world|foo|Q` only;
  Duplicate then Enter ‖ Enter earlier → `P|he|llo| world|hello world|Q`
  only; a paste of whole blocks, a paste over a block and typing over a
  block ‖ Enter → the split's piece first, only; a list pasted at a line's
  start ‖ Enter above → `hello| world|one|xbody text|Q` only; FX-05's
  "Turn a and b into headings ‖ Shift+Tab on c" and "Shift+Tab on a and c
  ‖ Shift+Tab on d" → `p|a|b|c|d|e|q` only (the mixed outcomes are gone).
- `order-scope.test.ts` FX-06: a line added at the end of `hello` while the
  pasted lines after it were deleted, then the delete undone →
  `P|hello|new|one|two|Q` (was `P|hello|one|two|new|Q`): the restored
  lines come back after the line written at their place, as restored text
  comes back after text typed in its place.
- `purge-before-horizon.test.ts`: the purged document is held under a
  quarter of the deleted one (was a fifth; the tombstones per removed block
  are unchanged, the document is leaner).
- `yp22-moves.test.ts`: a record waits for its units (was: integrates at
  once); two records of incomparable units sort the stronger (greater
  client) first on equal priority and part; a record whose unit a skip
  stands for waits for the gap to fill.
- `random/corpus.test.ts` diagnostic lane: `seed-140` replays clean (was:
  an `upstream-engine-crash` evidence row that had to keep failing) — fork
  patch YP23 fixed the crash it pinned; the artifact stays as its repro.
- `fixtures/dom/collaboration/room-props.test.tsx`,
  `room-id-props.test.tsx`: the browser database is `edytor-v14-g9:…`
  (was `g8`), schema generation 9.
- `purge-before-horizon.test.ts`: `records: 0` replaces `candidates: 0`
  (the purge counts move records).
- `yp22-moves.test.ts`: a record's `at` is a chain (`[id]`, was an id).
- `stream-boundary-races.test.ts` F-D19, `stream-split-ownership.test.ts`
  (the dead-boundary rows), `derived-writer-id.test.ts`: their premise — a
  split-born block whose boundary died — came from a history without the
  withdraw rule (the test copy of the engine's undo manager, now deleted);
  a raw engine write that removes the host's node builds it. Expected
  values unchanged; F-D19's late-redo half and the "pre-contract history"
  late-redo rows went with that history (review item 8).
- `boundary-attacks/facade.test.ts` attack 2: "a schema-version write is
  never an undo step" — the document's history never reaches `meta`, so the
  version stays 99 after the undo (was: the engine's doc-scoped undo
  manager rolled it back to the older version).

### Risks not in the design

- A collected slot keeps its split key (~8 B) instead of merging into a
  bare tombstone: a purge leaves it. Measured above; no slot of the
  1,000-block purge carried one.
- The in-memory order key grows with inserts at one spot (54 characters
  after 300 Enters): nothing is stored, but a very long run at one spot
  costs memory and comparisons in the index.
- Records are countable units of their sequence (`YNode.length` counts
  them); every edytor read goes through `entriesOf` or the index.
- The index's order keys are local to a replica; any new display rule that
  shows a block in a list must key it in that list's key space (the
  promotion-under-a-claim-owner divergence the wide corpus found).
- The purge drops old records no block shows at; a cycle resolved after it
  drops a later move and finds the block's purged records gone, so the
  block falls back further (an older record, or home). Only below the
  horizon.
- A block every candidate of which closes a cycle (three or more peers
  moving blocks into each other's subtrees at once, home included) still
  shows at the root's tail: the last resort.
- A document built from a value is 5 % slower to construct (13 % in the
  scale workload at 5,000 blocks), and a 1,000-block range delete 35 %
  slower (above).
- The bundle is 12.1 KB larger than the base (above; 8.2 KB after the
  cuts of the last section), where the design
  expected it smaller.

### The review of PR #29: what its decisions changed

1. **Cycle fallback: back where it stood** (the first prototype's root-tail
   fallback was rejected). A block's candidate edges are its live move
   records, strongest first, then its home slot (`candidatesOf`); the
   resolution accepts every candidate greedily in descending
   `(priority, client, clock)`, each block at the first that closes no
   cycle (`resolveAll`), so the later move wins and the block whose move a
   cycle drops is at its next record, else home, falling further when that
   closes a cycle too; the root's tail only when every candidate does. The
   index does the same locally (`text/index/placement.ts` `settle`: a
   candidate that closes a cycle through an older edge drops that edge's
   block to its next candidate; `retryFallen` lets a dropped block rise
   again when a cycle breaks). The §1.2 claim — the runner-up made the
   resolution global — does not hold for a block's own records: the cycle
   workload decides 2–4 / 2 placements at 1,000 / 5,000 blocks (1,001 /
   5,001 on the base). Writes anchor where the index shows a block and a record
   written beside a unit carries only the units the index shows at that
   record (`anchorIn`, `beforeIn`, `shownAt`): a neighbour's write never
   re-asserts a move a cycle dropped (model seed 5's split did, first). The
   purge keeps a record a block shows at (`recordsOf` with the view).
   Rows: `cycle-fallback.test.ts` (a block moved twice falls back to its
   previous record; a previous record that closes a cycle too sends it
   home; six delivery orders over three peers; an undo of the winning move
   restores the dropped one), MV05/MV05a, `cycle-scale.test.ts`.
2. **Undo order (FX-06): accepted** as built.
3. **The first operation after a load.** The rebuild no longer inserts
   each placement into a sorted list: the resolution builds each parent's
   children in its sequence's order in one pass (`Resolution.order`) and
   writes the index's own maps; the slot collection walks each item once
   (no `entriesOf` arrays), links each home place to its slot unit, and
   the records' homes the fold keeps are not read again (`knownHomes`);
   the fold reads a block's engine parent from its slot's item alone
   (`edgeParentOf`). Load to first keystroke: 11.59 → 10.60 ms and
   50.27 → 46.68 ms (1,000 / 5,000 blocks; above). No wall clock entered a
   gate lane; `cycle-scale.test.ts` and the facade's scaling rows hold the
   work flat.
4. **The full Playwright suites**: below.
5. **The setup guard.** The anchor chain makes the order of two records a
   function of the records alone, so the document hook that read it from
   the sequences (`doc._unitOrder`, `orderingUnits`) is gone: it was also
   wrong inside one update (a replica that took a record before an
   ancestor's slot compared it by client id — the same-id differential's
   three-replica reloads diverged on it). What stays is the keep-replaced
   rule, and a facade or `attachDocument` now refuses loudly
   (`adoptRules`, a `TypeError`) a document that holds state without it
   (`document/rules-guard.test.ts`); the test suites build their raw
   documents with the rule, and so do the collaboration DST runner's
   reference document and the benches that restore a snapshot into a raw
   document (`bench/lib/memory-probe.mjs`, `bench/u10-attribution-overhead.mjs`;
   the guard's first DST run refused all 9 collab rows).
6. **The same-id test** (`same-id-order.test.ts`: two and three replicas,
   24 seeds each, every client-id assignment of `clientPairs` /
   `clientTriples`, observers in both delivery orders, reloads). It found
   two faults, both fixed: the slots of a node a concurrent creation of
   its id displaced kept their old owner in the index (`reslot`, run when
   the node an id stands for changes) and the order hook above.
7. **The undo bug** (model seeds 219, 417, 889: an undo that withdraws a
   block a peer typed into tombstoned the peer's text). The document's
   history already keeps it (`withdrawOnUndo`; the doc adapter passed the
   same schedules); the model lane ran a test copy of the engine's old
   undo manager without the withdraw rule. That copy is gone (item 8): the
   model lane runs the document's history, and
   `random/undo-withdraw-regressions.test.ts` pins the three minimized
   schedules on both lanes plus the rule through the facade.
8. **No test-only undo manager** (added to the review: tests can no longer
   exercise a history production never runs). `src/tests/crdt/harness/undo.js`
   (528 lines, the engine's `UndoManager` as the fork carried it before
   YP18, with its YP11/YP12 hooks) is deleted. Every undo a test or a bench
   runs is the document's: `createUndoManager` / `document.history`, or over
   a raw document `harness/history.ts` (41 lines: production's `UndoManager`
   class with production's rules, `historyRules` — now exported from
   `doc/history.ts`, which `createUndoManager` builds from too — only its
   scope narrowed to the probed nodes). The replica harness's `enableUndo`
   and the model lane's `trackHistory` build it (the model lane with the
   document's own scope, the raw lane's peers over every root).
   - Moved to the real history (rows kept, expected values unchanged):
     `v14-smoke` (2 rows), `range-cursor` (2), `marker-seed` (1),
     `text-model-probes/search-marker-anchors` (2),
     `hardening/search-marker-probes` (2 raw rows),
     `hardening/search-marker-format` (the replay and randomized rows),
     `hardening/undo-ownership-split-tail` ("a history built over the raw
     document gets the same repair"), `doc/undo-factory` ("a history
     attached before init cannot undo the seed"), `yp7-gap-end` (both sides
     of the differential run the one history), the vendored upstream
     `attribution.tests.js` `testRdtDeletedSubtreeUndoScope`,
     `arch-v2/stream-boundary-races` (the corpus program reads the step
     `undo()` returns instead of the old class's `stack-item-popped`
     event), every `enableUndo`/`trackHistory` user (model-edges,
     scenarios, the corpus, the harness tests) and the bench's undo and
     memory lanes (`bench/lib/baseline.js`, `memory-probe.mjs`,
     `interop.mjs`).
   - `boundary-attacks/facade` attack 2 (6 rows): moved; one expected value
     changed: "a schema-version write is never an undo step" — the
     document's history never reaches `meta`, so the undo rolls nothing
     back (`canUndo()` false, the version stays 99); the old row pinned
     that the engine's doc-scoped manager resurrected the stale version, a
     hazard production never had.
   - Deleted with their subject: upstream's `undo-redo.tests.js` (20 rows
     of the removed class: its events, `deleteFilter`, capture options,
     scope APIs) and `doc.tests.js` `testSubdocsUndo` (subdocuments are
     gone too, YP19); the undo/redo steps of `yp16-writes`' engine
     differential (an engine write path no more: the document's history
     releases a dropped step's content for collection at once, which
     upstream's undo manager leaves kept, so the gc-on rows differed by
     design); `arch-v2/stream-split-ownership` "F-D19 late redo
     (requirement 3), pre-contract history" (6 rows: the redo of a history
     without the withdraw rule; the contract's own F-D19 row under
     `hist.undo.withdraw` stays). Unused imports dropped:
     `yp9-yp10-engine`, `hardening/undo-ownership-probes`.
   - Rows whose premise was a history without the withdraw rule (a
     split-born block whose boundary died) build it without a history: a
     raw engine write removes the host's node, the state a peer that
     deletes the node leaves (`stream-split-ownership` `deadBoundary`: the
     requirement 2+4 and 5 rows; `derived-writer-id`; `stream-boundary-races`
     F-D19, whose late-redo half went with the old history).
   - Other test-side copies of removed production code, listed and kept
     (not the same kind: production runs no second version of them):
     `oracles/model-ops.ts` (201 lines, 27 importers: the placement layer's
     old validating op layer, over production's primitives; with
     `harness/ops/model-ops.ts`, 784 lines, 25 importers, it is the `model`
     corpus lane — the closest kind, a follow-up candidate), `harness/delta.js`
     (628 lines, 23 importers: the delta reader and writer YP16 removed,
     the tests' fixture language over raw nodes), `harness/node-reads.js`
     (203 lines, installed in every lane: the node reads YP19 removed);
     the from-scratch oracles (`oracles/fresh-view.ts`, `doc-change.ts`
     `diffSnaps`, `runs.ts`, `block-records.ts`) are rebuild comparators
     by design.
9. **A key walk a cycle fallback changed under it** (found by the final
   wide corpus, a regression of item 1). The index keys a placed block
   between the nearest block shown before its place and the next key of the
   list, placing a pending neighbour first; placing one can close a cycle
   that drops a block back where it stood, into the stretch the walk had
   already passed, and the key was read from the stale walk: the maintained
   order differed from its rebuild (the lanes' self-checks threw; doc seeds
   126, 157, 188, model 126, 157, 188, 212, 360, 496, roles 7, tables 423,
   516 — none fails on the prototype commit, where a dropped block went to
   the root's tail, past every walk). A walk under which a placement changed
   walks again (`text/index/placement.ts` `keyFor`, `placedEpoch`), and the
   walk skips the block being placed.
   The same walk placed its neighbours after the block's cycle check, with
   the block unplaced: a neighbour could close a cycle through it that no
   check saw (doc seed 217: the display tree held b3 under b3b under b3, and
   the change report's walk up the tree never ended — the corpus process
   hung; it passes on the prototype commit). `settle` now finds the key
   first, then checks the cycle with the neighbours placed.
   `random/key-walk-regressions.test.ts` pins four minimized schedules
   (doc 126, model 360, roles 7, tables 423) and seed 217's first 98 steps.

### Lanes (final tree)

Run on the final tree, 2026-10-18 (after every fix above):

- `check` (0 errors, 0 warnings), `lint`, `check:deps`, `check:worker`,
  `api:report` then `check:api` (current), `check:docs` (292 examples),
  `test:typecheck`, `test:dom:typecheck`, `test:do:typecheck`: pass.
- Unit (`pnpm exec vitest --run`): 4,410 passed, 1 failed, 3 skipped, 11
  todo. `test:crdt`: 3,869 passed, 1 failed, 9 skipped. The failure in both
  is the known local-only `search-marker-format` row "patched engine vs
  pre-P4 vendored baseline" (it compares against the gitignored
  `bench/vendor-baseline` and runs no undo manager).
- `test:dom`: 2,890 passed, 1 expected fail, 34 skipped. `test:do`: 313
  passed. (A run alongside the wide corpus, at a load average near 40, timed
  out one row of each — the F-O5 1,000-paragraph row's 60 s and
  `live-compaction`'s 10 s `waitFor`; both lanes pass whole at a lower load.)
- Wide corpus, `CRDT_SEEDS=1-1000 CRDT_OPS=300`, every adapter (raw, model,
  doc, roles, tables; 1,011 rows each, 5,055 in all): 0 failures. The
  model lane runs the document's history (review item 8). The known base
  failures (raw 816/975, model 550, tables 193/898) pass. The first run of
  the follow-up tree failed 12 rows and hung on doc seed 217 (review item
  9; none fails on the prototype commit).
- Playwright, full suites, one project at a time: Chromium 967 passed and 2
  skipped, Firefox 959 and 10, WebKit 955 and 14, mobile Chromium 52,
  mobile WebKit 52, cdp 62. No failure, nothing rerun.
- `test:dst`: 80 passed — after the collaboration runner's reference
  document became an edytor document from the start (`bindCrdt(Y).createDoc()`;
  the first run failed its 9 collab rows on the setup guard's `TypeError`,
  review item 5). `test:dst:extensive`: 178 passed, 16 failed — exactly the
  known solo seeds 17, 18, 25, 34, 43, 45, 52, 53, 61, 67, 70, 88, 90, 97, 98
  and collab seed 20 (fixed in PR #28).
- `test:hosted --project=chromium`: 11 passed. `tests/packed-consumer/run.sh`:
  all checks passed.

## Cutting the move's bundle cost

Done 2026-10-18 on the same branch, after the review's follow-up: the move
stays, but what it added to the bare editor is cut first. Same method as
above: `node scripts/bundle-size.mjs --only minimal,all,export` on this tree
against the fresh export of `origin/engine-cuts`, one coherent cut per
commit, each measured before and after and followed by the fast lanes
(`check`, `lint`, `check:deps`, `check:worker`, `api:report` then
`check:api`, unit, `test:crdt`, `test:dom`: the same counts after every
cut — unit 4,410 passed, `test:crdt` 3,869, `test:dom` 2,890 — and only the
known local-only `search-marker-format` row failing). No behaviour test's
expected value changed; the test-side changes are listed below.

### The cuts

Edytor's own minified bytes (`own`, without the Svelte runtime), minimal and
every-plugin probes; `edytor/export` stays 51.00 KB throughout.

| Commit | Cut | `minimal` KB | `all` KB |
| --- | --- | --- | --- |
| `f419ddb8` | **One record walk in the engine.** A move record rides YP20's hold walk: `holdRange`, `holdIds` and `holdItem` take the record (`null` for a hold), so `moveRange`, `moveIds` and `moveItem` go; one range writer (`writeIds`) and one reader (`readIds`) for both records; `Item#delete` hands its content the item, so a move record keeps no item; the sort rule reads a unit (`unitAt`) and orders two units (`unitOrder`) one way for split keys and record chains | 426.73 → 425.96 (−0.77) | 656.15 → 655.41 (−0.74) |
| `aaf21496` | **One walk over a sequence item's units** (`unitsOf`): the engine's display (`shownBy`, was `displayedUnits` and `entriesOfItem`), the index's places (`positionsOfItem`) and the writers' view of what the index shows (`shownIn`, was `shownAt` for a record and `homeShownAt` for a slot item); `unitOf` reads through `itemAt`; one unit equality (`sameUnit`); one write of the slot map (`putSlot`: the fold's slots in and out, `reslot`); one neighbour lookup for the writes at a display index (`around`: `moveBlocksTo`, `insertSpecsAt`, `writeSplit`) | 425.96 → 424.86 (−1.10) | 655.41 → 654.33 (−1.08) |
| `82a5724d` | **One placement resolution.** The first build places every block with the edit's own `settle` (unkeyed, `retryFallen`, then one dense keying pass over each sequence's places, the root's tail after it) instead of `resolveAll`'s greedy pass: the greedy result is stable under `settle`'s rules, and two stable states agree on every edge from the strongest down, so the order the blocks come in decides nothing. The greedy rebuild moved to the tests (`src/tests/oracles/placements.ts`, with the test-only `edgeOf`): the self-checks, the fresh view and the model oracles compare the index with it, independent of production's acceptance. `candidatesOf` reads its unit itself, `Edge.offset` (never read) and `collectSlots`' unit map go, and the public binding's `model.resolvePlacements` is removed (changelog) | 424.86 → 423.43 (−1.43) | 654.33 → 652.90 (−1.43) |
| `9d8d8328` | **The remaining copies of the walks and the tail key**: `recordsOf` reads a record's engine display with `shownBy` (it walked each unit through `anchorOf`), `reslot` reads a sequence's home slots with `positionsOfItem`, the rebuild keys the root's tail with `reject` (the edit's own tail key), `placeAfter` returns nothing (no caller read its result), `writeData` reads a node's data slots once per slot write | 423.43 → 423.04 (−0.39) | 652.90 → 652.50 (−0.40) |
| `b1ef6209` | **The fold writes the slot map as it reads the sequences** (no `slotsIn`/`slotsOut` lists for a second loop); one loop reads the open transaction's hold and move logs | 423.04 → 422.87 (−0.17) | 652.50 → 652.33 (−0.17) |
| `638217c1` | **Values nothing reads**: `ResolvedPlacement.home` (the self-check compares the same fact from the accepted edges), a move record's unit value is the record itself, the split key's text order in one expression | 422.87 → 422.75 (−0.12) | 652.33 → 652.21 (−0.12) |
| `777982c2` | **The engine symbol nothing calls**: `sequenceOrder` leaves edytor's engine object and the fork's namespace (the prototype's ordering hook, gone with the review, was its only caller) | 422.75 → 422.74 (−0.01) | 652.21 → 652.19 (−0.02) |
| `27a29e00` | **A unit's movers are kept strongest first**: `mover` is the first of them, `candidatesOf` sorts nothing (the engine's argmax, `moverOf`, and edytor's sort computed one order twice) | 422.74 → 422.71 (−0.03) | 652.19 → 652.17 (−0.02) |
| `9482668e` | Timing fixes (below): the first build hands each block's candidates the slot item the rebuild collected; the fold reads display parents only while there are shells | 422.71 → 422.83 (+0.12) | 652.17 → 652.28 (+0.11) |
| | **Total** | 426.73 → 422.83 (**−3.90**) | 656.15 → 652.28 (**−3.87**) |

Against the base, `minimal` 414.62 → 422.83 KB own (+8.21, was +12.11),
461.4 → 469.6 KB total, 158.67 → 161.35 KB gzip (+2.68, was +3.90); `all`
643.98 → 652.28 own (+8.30, was +12.17), 241.59 → 244.35 gzip; `export`
51.00 → 51.00. Where the 8.2 KB still is (`minimal`, minified, against the
base): the index's placement half +2.9 (`text/index/placement.js`: the local
cycle resolution — `settle`, `admits`, `canRise`, `retryFallen`, the tail
key — the order keys from neighbours, the slot map and its re-owning),
`placement/slots.js` +2.3 (new: the walk, `placeAfter`, `anchorOf`,
`removeUnit`), the fork +3.1 (`Item.js` +1.6: `ContentMove`, the movers, the
GC key rule; `marks.js` +1.5: the sort classes, the chains, the split keys;
`ynode.js`, `encoding.js` +0.6), the fold +1.6 (the sequences' changes and
the move log), `placement/model.js` +1.4 (writes that anchor where the
index shows a block, the chains), `data.js` +1.1 (the arrays' slots: insert,
move, remove), `placement/resolve.js` +0.7, `placement/keys.js` +0.5;
against `rank.js` −2.7, `display.js` −1.3, `doc/steps.js` −1.1 and smaller
cuts elsewhere.

Checked and not done:

- **Holds and moves as one record kind** (one pending set, one log). They
  share the walk now. The rest differs in kind: a hold record integrates at
  once and what it names that has not arrived waits in `pendingHolds` (a
  delete of text a room lost is stored at once), while a move record waits
  for its units and its chain like an item for its origin (`getMissing`),
  because its sort reads them — so moves have no pending set; a hold is
  counted (`holds`, and an item merges with an equally held neighbour),
  moves are an ordered list of records (`movers`); a hold record splits and
  merges with its writer's next one, a move record is one indivisible unit.
  One kind would need a new content ref and a schema generation for little
  code.
- **One log for holds and moves.** The open transaction's fold reads both
  in one loop now; past that the hold log feeds the texts' edits and the
  move log the sequences' changes, and one engine log would make each
  reader filter out the other's entries again (an atom's data arrays are a
  sequence a text reader would then see).
- **`data.ts`**: the rank-era paths are all gone (no `~id#`/`~id>` keys,
  rank pattern or `rankAfter`); what it added is the arrays' slot writes.
  The detached node's slot counter stays: a detached node's `length` is 0,
  so writing at `node.length` would reverse the slots of several arrays.
- **The setup guard's message** (the long `TypeError`): a behaviour row pins
  its words.
- **`deleted` as `gone || movers !== null`**: the engine's hottest getter,
  not traded for about 20 bytes.
- No DEV-only check or long error string came with the move besides the
  guard and `move: node is not integrated` (the same guard as `hold`'s).

Test-side changes, none of them an expected value: the greedy rebuild in
`src/tests/oracles/placements.ts` (production's `resolveAll` as it was, with
its own cycle walk), imported by `index-checks.ts`, `fresh-view.ts`, the
model oracles, `arch-v2/prepared-oracle.ts` and the harness's model ops;
`index-checks.ts` compares whether a block shows at home from the accepted
edges (`atHome`) where it read `ResolvedPlacement.home`; the surface pins
`engine-surface.test.ts` and `yp8-surface.test.ts` drop `sequenceOrder`; the
bench's from-scratch placement stage times the test oracle's greedy
rebuild, as its collection stage times the oracle's `collectBlocks`.

### Sizes (final tree)

Re-measured with `scratchpad/measure.mjs` on the final tree: the stored
format did not change, so the stored rows of the prototype's table hold
(seed 166,554 B; 300 Enters 81,594 B, 54-character longest in-memory key;
200 moves 2,500 B; heap 7.17 / 29.78 MB at 1,000 / 5,000 blocks, within
noise of 7.12 / 29.71). The bundle rows:

| Measure | Base | Prototype | After the cuts |
| --- | --- | --- | --- |
| Bundle `minimal`, own / total / gzip / brotli (KB) | 414.6 / 461.4 / 158.7 / 137.7 | 426.7 / 473.5 / 162.6 / 140.7 | 422.8 / 469.6 / 161.4 / 139.9 |
| Bundle `all`, own / total / gzip / brotli (KB) | 644.0 / 692.6 / 241.6 / 205.4 | 656.2 / 704.8 / 245.5 / 208.5 | 652.3 / 700.9 / 244.4 / 207.7 |
| Bundle `export`, own / total / gzip (KB) | 51.0 / 76.6 / 28.9 | 51.0 / 76.6 / 28.9 | 51.0 / 76.6 / 28.9 |
| Cycle race, placements decided at 1,000 / 5,000 blocks | 1,001 / 5,001 | 2–4 / 2 | 2–4 / 2–4 |

### Timings (idle machine)

`pnpm bench:crdt` (`bench/run.js`, which runs the scale workload too), the
fresh `origin/engine-cuts` export (before) and this tree (after,
`9482668e`), alternating, three runs each, medians. The runs started once
the 1-minute load average was under 4 (3.81; it had been 9–14 while the
lanes ran) and stayed between 3.3 and 4.9. The base's bench copy runs its
undo and memory lanes on the document's history, as this tree's does.

| Measure (ms) | Before | After |
| --- | --- | --- |
| Keystroke on a long-lived document, 1,000 / 5,000 blocks (scale) | 0.05 / 0.03 | 0.04 / 0.03 |
| Remote keystroke, 5,000 blocks | 0.02 | 0.02 |
| Enter, 1,000 / 5,000 blocks | 0.13 / 0.13 | 0.17 / 0.13 |
| Backspace, 1,000 / 5,000 blocks | 0.05 / 0.07 | 0.07 / 0.08 |
| Range delete of 40 blocks, 1,000 / 5,000 blocks | 1.68 / 1.21 | 1.59 / 1.25 |
| Delete of 1,000 blocks, range / selected blocks | 11.0 / 14.3 | 9.9 / 14.4 |
| Load 1,000 / 5,000 blocks (scale) | 12.3 / 57.7 | 11.3 / 43.7 |
| Construct 1,000 / 5,000 blocks (scale) | 42.6 / 142 | 38.4 / 136 |
| Encode 1,000 blocks (p50) | 1.04 | 0.79 |
| Encode / load after 5,000 history steps | 0.53 / 2.86 | 0.60 / 2.65 |
| Undo, last of 10 (p50, the document's history) | 0.06 | 0.06 |
| Undo after 5,000 history steps | 0.17 | 0.19 |
| First keystroke after a load, 1,000 blocks (facade lane) | 1.21 | 1.27 |
| First move after a load, same parent / a group of 5 (facade lane) | 0.10 / 0.13 | 0.12 / 0.14 |
| First block delete after a load, 1,000 blocks (facade lane) | 1.13 | 1.22 |
| Load 1,000 blocks (workload p50) | 1.73 | 1.90 |
| Move / Tab / outdent, 5,000 blocks (scale; new rows, no base) | — | 0.12 / 0.09 / 0.12 |

Each row that read worse, checked alone (A/B scripts alternating the two
trees, warm, many samples):

- **Delete of 1,000 blocks as a range** (+35 % on the loaded machine, +27 %
  on the idle one before the fix): real. The fold read the display parent
  of every block a commit touched (the shells' affected set) through the
  engine — since the move a store lookup per block (`edgeParent` →
  `itemAt`), where the base read a field — and a 1,000-block delete touches
  every block, with no shell in the document. Fixed in the fold: it reads
  them only while the document holds shells (`9482668e`). Range / block
  delete 11.3 → 9.1 / 13.6 → 11.6 ms (base 9.8 / 14.2).
- **Construction at 5,000 blocks** (+13 % loaded): real, the same cause;
  `createDocument` of 5,000 blocks and a first read: 121–125 ms on the
  prototype, 106 ms now (base 112). Fixed by the same change.
- **The first operation after a load** (facade lanes, +9 to +40 % loaded):
  partly mine. The one-resolution cut had dropped the review's item-3
  optimization (the rebuild handed each block its slot's item): a store
  lookup per block made the first build 25 % slower than the prototype's
  (1,000 blocks: 1.31 → 1.67 ms). Fixed (`collectSlots` keeps each slot's
  item, `candidatesOf`'s `at`): 1.30 ms. What remains, 1.11 → 1.30 ms at
  1,000 blocks (+0.2 ms: every sequence's slots and each block's home), is
  the prototype's, and the load is faster (5.85 → 5.44 ms), so load plus
  first keystroke is not slower (7.1 → 6.9 ms). The rows above: +5 to +8 %.
- **Enter at 5,000 blocks** (0.20 → 0.26 loaded): equal on the idle machine
  (0.13 / 0.13). Enter and Backspace at 1,000 blocks read +0.02–0.04 in the
  scale workload (five samples each, its first, coldest size); warm, a
  hundred samples each: Enter 0.052–0.055 / 0.052–0.054 ms, Backspace
  0.033 / 0.036 ms at 1,000 blocks, 0.076 / 0.064 ms at 5,000. Not real.
- **The 40-block range delete at 5,000 blocks** (+22 % loaded): equal (1.21
  / 1.25).
- **Encode after 5,000 history steps** (+28 % loaded, +13 % idle): one
  sample of a cold encode. Encoding that document 300 times: 0.33 ms on
  both trees (5,119 / 5,100 structs, 67.3 / 67.0 KB). Not real.
- **Undo after 5,000 history steps** (+0.02 ms): one sample. Over eleven
  fresh documents: 0.043–0.048 ms on both. Not real.
- **Load 1,000 blocks (workload p50)** (+10 %): the engine-only workload
  (`applyUpdate` of one 1,000-block engine document, identical bytes) run
  alone reads 1.42–1.43 ms on the base, the prototype and the final tree.
  Not real: the state of the long bench process.

### Lanes (after the cuts)

Run on the final tree (`9482668e`), 2026-10-18, one lane at a time after
the benches:

- After every cut: `check` (0 errors, 0 warnings), `lint`, `check:deps`,
  `check:worker`, `api:report` then `check:api` (current), unit 4,410
  passed, 1 failed, 3 skipped, 11 todo; `test:crdt` 3,869 passed, 1 failed,
  9 skipped; `test:dom` 2,890 passed, 1 expected fail, 34 skipped. The
  failure in both is the known local-only `search-marker-format` row
  "patched engine vs pre-P4 vendored baseline".
- `test:typecheck`, `test:dom:typecheck`, `test:do:typecheck`: pass;
  `check:docs`: 292 examples. `test:do`: 313 passed.
- `random/key-walk-regressions`, `random/undo-withdraw-regressions`,
  `arch-v2/same-id-order`, `arch-v2/cycle-fallback`, `arch-v2/cycle-scale`,
  `yp22-moves`: 43 passed.
- Wide corpus, `CRDT_SEEDS=1-1000 CRDT_OPS=300`, every adapter (raw, model,
  doc, roles, tables; 1,011 rows each, 5,055 in all): 0 failures.
- `test:dst` (`DST_PORT=5072`): 80 passed. `test:dst:extensive`: 179
  passed, 15 failed — the known solo seeds 17, 18, 25, 34, 43, 45, 52, 53,
  61, 67, 70, 88, 90, 97, 98 (collab seed 20, known to fail, passed).
- Playwright (`PW_PORT=5071`), full suites, one project at a time, nothing
  rerun: Chromium 967 passed and 2 skipped, Firefox 959 and 10, WebKit 955
  and 14, mobile Chromium 52, mobile WebKit 52, cdp 62.
- `test:hosted --project=chromium`: 11 passed. `tests/packed-consumer/run.sh`:
  all checks passed.
