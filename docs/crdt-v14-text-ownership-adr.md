# ADR — U04: text ownership = stable backing texts + anchored slice claims

Status: **decided and implemented** (U04); amended by the post-U12
follow-up work units 1 (three ownership defects fixed through the facade —
see _Boundary affinity_, _Ownership resolution_, and _Undo inverses_) and 6
(ownership index representation — see _Interval index_).
Plan reference:
`crdt-v14-implementation-plan.md` §4 (split/merge identity), §8
(TX01–TX09, ST01–ST03, HI01 engine proofs).

## Decision

Block text is **never moved or copied**. Every block owns a private _backing
text_ — the `content` child of its registry node — whose items are stable
for their entire lifetime. What a block _displays_ is derived from its
`slices` child: an ordered sequence of replicated claim records.

```
doc.get('blocks')
  └ <blockId>  Node('block')
       ├ content → Node('content')   BACKING text — atoms never move/copy
       ├ slices  → Node('slices')    ordered claim records (this ADR)
       ├ at      → Node('at')        placement candidates (U03)
       └ del                         explicit-delete flag
```

Two record shapes live in `slices` (stored as `ContentAny` payloads; an
item's `(client, clock)` id is the record's _stamp_):

```ts
// slice record — "the atoms of backing text `t` in [resolve(s), resolve(e))"
{ t: TextId, s: Anchor, e: Anchor, g?: number }
// merge claim — "whatever block `m`'s slice list covers, transitively"
{ m: BlockId }
```

`g` is a **claim generation**: records materialized by a split (or a
boundary rewrite) carry `maxG(t) + 1`, so a causally later partition
deterministically outranks every record that covered those atoms before —
through any claim depth. Missing `g` reads as `0` (seed/legacy records).

Implementation: `src/lib/crdt/text/model.ts` (`bindText(Y)`), consumed by
`src/lib/crdt/placement/model.ts`. Tests:
`src/tests/crdt/text/model.test.ts` (unit), `scenarios/active-text.ts`
(TX01–TX09, ST01–ST03, HI01a/b — green lane, both delivery orders, reload),
`src/tests/crdt/text/ownership-regression.test.ts` (follow-up work unit 1 —
facade-level defect regressions: concurrent-split left-edge steal, empty-head
revive, `dead`-id sentinel; both delivery orders, duplicate delivery, binary
reload, disjoint-coverage ownership rows, undo/redo, inline atoms, marks).

## Anchors

Slice endpoints are **relative positions**, never numeric offsets:

```ts
type Anchor = { i: { c: number; k: number } | null; a: number };
```

- `{i: null, a: -1}` — **B sentinel**: beginning of the type, resolves to 0.
  Covers prepends (typing at the start of a head slice works).
- `{i: null, a: 0}` — **E sentinel**: end of the type, resolves to live
  length. Covers appends (TX01's concurrent `!` lands on the suffix).
- `{i: {c, k}, a}` — bound to the backing item `(client, clock)`; resolves
  to the position _before_ that item.

Encoding: `createRelativePositionFromTypeIndex` + `relativePositionToJSON`
against the backing text's item id; `assoc` maps to `a`, `item` to `i`.
Resolution: `createAbsolutePositionFromRelativePosition` with
**`followUndoneDeletions = false`** — an undone delete must not resurrect an
anchor's coverage of the restored item on replicas that never saw the undo
(replica-independent resolution).

**Deleted-anchor fallback**: when the bound item is tombstoned, the anchor
resolves to the _gap where the item lived_ — a concurrent insert at that gap
lands inside the claim (TX06c: delete the tail's bound `'w'`, insert at the
tail's left edge → `Xorld`, not a lost claim). Coverage survives the loss of
its anchor item; only the atoms themselves die.

## Ownership resolution

`owner(b)` — the block that displays `b`'s slice list:

- `b` unknown or `del`-flagged → `DEAD` — an internal **`unique symbol`**
  (`Symbol('edytor.crdt.dead')` exported from `text/model.ts`), never a
  block-id string. The original `'dead'` string sentinel collided with the
  valid caller block id `"dead"` (follow-up work unit 1 defect C): every
  consumer — placement's `displayEdge`/`displayParentOf`, the run view, the
  facade, and test oracles — compares against the shared symbol, so no
  caller-supplied id can be interpreted as deleted;
- no merge claims on `b` → `b` (self-owned);
- else follow the **max-stamp** claim's claimer, transitively. Claim cycles
  (concurrent `A→B`/`B→A`) resolve to the claimer of the max-stamp edge
  inside the cycle.
- A claim held by a **`del`-flagged** holder is inert — deleting the merge
  destination voids the claim rather than swallowing the source into a dead
  subtree (delete-beats-merge, ST02b).

`hidden(b)` ⟺ `owner(b) ≠ b` — merged-away blocks have no display but their
records keep claiming through their owner.

**Per-atom contested ranges**: atom `i` of text `t` is displayed by the
live covering record with the best key

```
(generation g,  resolved start s0,  claim stamp (client, clock))
```

- `g` first — causal partitions beat pre-existing coverage at any claim
  depth (this is what makes _split of merged content_ deterministic: the
  materialized tail records outrank the claimed list's own records, which
  still route to the claimer).
- `s0` — the record's resolved left edge. At equal generation the
  **innermost claim wins**: concurrent splits at different anchors produce
  the seam-preserving nested partition (split at 3 + split at 8 ⇒
  `[0,3) | [3,8) | [8,E)`), not winner-take-all.
- stamp — deterministic tiebreak for genuinely concurrent overlaps with
  equal `g` _and_ equal left edge (same-anchor splits).

The winning **record** is tracked per covered span (`OwnInterval.claim`),
so two overlapping records routing to the same owner cannot double-emit —
see _Interval index_ below.

## Interval index (WU6)

Resolved ownership is stored as **ordered disjoint intervals** per backing
text — `OwnInterval {i0, i1, owner, claim}` — built by `sweepOwnership`, a
claim-endpoint sweep: between two consecutive claim boundaries the active
claim set is constant, so the winner is too; each elementary span takes the
max-key active claim (a lazy-expiry max-heap over the same
`(g, s0, stamp)` key above), and adjacent spans won by the same record
coalesce. A gap (no active claim) resets coalescing, so the same record
winning both sides of a hole still emits two intervals — exactly what the
dense `claims[i] === entry` row encoded. Interval count per text is ≤
2·claims − 1, never proportional to text length: a single winning claim
over 100k atoms is ONE interval.

Queries replace the dense row lookups: `intervalAt`/`ownerAt` (point →
binary search), `intervalsOver` (range → ordered overlaps),
`nearestOwned` (nearest owned position → interval-boundary hops, used by
the facade's unresolved-anchor outward scan). `computeOwnership`, `flatten`,
the maintained `AtomRow` in `runs.ts`, `emissionOffset`, and
`resolveAnchor` all consume the interval structure; no production code
builds a dense per-position row. A corrected dense implementation is kept
as a test-only oracle
(`src/tests/crdt/harness/dense-ownership-oracle.ts`) and compared against
the intervals position-by-position in
`src/tests/crdt/text/ownership-intervals.test.ts`.

## Conflict-order examples

- **A+B vs B+C** (TX05a/b): `b2→b1` + `b3→b2` chains transitively —
  `owner(b3)=b2→b1`, so `b1` displays all three texts once, and `b3`'s
  children (reparented to `b2` by the merge) display under `b1` via the
  effective display parent. Contested `b2→b1` vs `b2→b3`: the max-stamp
  claim wins (one canonical owner), the losing claim contributes nothing.
- **Move vs split** (ST01a): the sibling's placement is written at the
  _splitter's observed source context_ — the split seam stays put while the
  head's placement is independent LWW data. `A=ab` at `P` + `P→Q` ⇒ head
  `a` under `Q`, sibling `b` at `P`. The move does not drag the sibling.
- **Split vs merge of the source** (TX05c): `split b1@6` + `b1→b2` ⇒ the
  claim covers b1's _post-split_ list (the head only); the tail sibling is
  an independent block and survives outside the claim — `b2` gains
  `'hello '`, `sA` keeps `'world'`.
- **Delete source vs split** (ST02a): the sibling's records are held by a
  _live_ block and keep their atoms — the split rescues the tail while the
  head hides with the deleted source.
- **Delete vs merge** (ST02b/c): deleting the destination voids its claims
  (source survives visible); deleting the source hides its atoms (its own
  records are dead-holder) — deletion wins both ways.

## Boundary affinity

- **Split seam**: head and tail records both bind "before the same item" —
  an insert at the seam resolves _left_ of the bound atom → head side
  (TX06a). Typing at a record's left edge rewrites that record under
  `g = maxG + 1` so the extension wins deterministically — and the rewrite
  re-asserts the record's **actual resolved coverage**, never its original
  `{s,e}` range. One record is emitted per resolved owned seg: the
  typed-into seg extends left over the new atoms, segs after the insert
  point shift by the insert length, earlier segs re-anchor unchanged. A
  record's coverage can be _disjoint_ — a rival can win a hole inside its
  claimed range (concurrent splits) — so materializing the whole original
  range under the bumped generation re-claims and steals the lost atoms
  (follow-up work unit 1 defect A: `early`'s rewritten `{3,E}` record
  re-claimed the atoms `late` had won, emptying its display).
- **Merge join**: an insert at the join lands at the end of the _preceding_
  owned segment's backing text — left-affine (TX06b).
- **Spanning delete/format**: resolve per owned segment against its backing
  text — a range crossing a split seam deletes/formats atoms on both sides.
- **Empty display revive**: inserting into a block that owns nothing writes
  a `{t: self, s, e: E, g: maxG+1}` record so the new atoms are claimed by
  this block — not swallowed by a neighbour's E-sentinel. The payload is
  appended at the backing text's end **first**, and the record's start
  anchor is created against the _post-insert_ text so `s` binds the first
  appended atom (covering `[tLen, E)`). Anchoring before the insert is
  wrong: `anchorAt(tLen)` on the pre-insert text yields the dynamic `E`
  sentinel when `tLen === len`, which then advances _past_ the appended
  atoms and the record claims nothing — the tail's whole-range record
  displayed the insert instead (follow-up work unit 1 defect B: insert into
  the empty head of a split-at-0 edited the tail). The record is skipped
  when an existing record on the same list already covers the end-of-text
  insert point (a second covering record would double-display the atoms).

## Same-anchor split multiplicity

Concurrent splits are block-creation ops: **every requested sibling exists**
in the converged state (multiplicity is preserved). The contested tail atoms
resolve to the higher-stamp tail record; losing siblings stay as **empty
blocks** — a same-anchor tie cannot share atoms without duplicating them.
Different anchors never produce empty losers (each seam survives — nested
partition). Sibling _order_ inside the rank tie is convergent but not
cross-run pinned (Logoot digits are randomized in-gap).

## Offsets and units

All public offsets (`insertText`, `deleteText`, `setMark`, `splitBlock`'s
`offset`) are **displayed-atom units** — text characters and inline atoms
count as one each, exactly what the projection shows. Internally an offset
walks the block's owned segments and lands at a backing-text index; anchors
store item ids, so offsets are only ever read against live state.

## Lifetime / GC

- Backing texts live as long as their registry node exists. `del` is a
  display flag, not reclamation — a deleted block's backing text stays
  claimable by live records on other lists (TX08: source deleted, sibling's
  slice stays live and editable).
- Records held by `del`-flagged blocks cannot claim (slice records) and do
  not route (merge claims) — dead holders are inert.
- Tombstoned atoms and records are ordinary engine tombstones; physical
  reclamation is Yjs GC on compaction — a U07 concern, unchanged by U04.
- Slice records persist in replicated storage after being contested away —
  undo needs them.

## Undo inverses

Split/merge are ordinary item writes: undo tombstones them. Proven in
`active-text.ts` HI01a/b:

- **Undo split** after a remote edit to the moved tail: the sibling's
  records + placement tombstone, the source's pre-split coverage revives —
  the remote edit on the shared backing atoms is preserved on the restored
  block (`'hello world!'`).
- **Undo merge**: the `{m}` item tombstones → the source's own coverage
  revives with all remote edits intact; a concurrent remote move of the
  destination survives (independent replicated data).
- **Undo resurrected atoms may change owner.** The engine's UndoManager
  resurrects deleted content as _new_ items with new clocks — it does not
  undelete the original item. An item-bound anchor on the tombstoned
  original still resolves to its gap under `followUndoneDeletions = false`,
  so the resurrected atom is claimed by whichever covering record currently
  wins (typically the pre-partition base coverage) — not necessarily by the
  block that owned the original. Visible content stays convergent and
  atom-preserving; only _ownership_ can drift across an undo/redo boundary.
  This is the price of replica-independent anchor resolution and is pinned
  by the work-unit-1 regression tests rather than treated as a defect;
  changing it would require anchors that follow undo resurrection, which
  diverges across replicas that never saw the undo.

## Complexity

- `computeOwnership` is O(total live records) for routing/maxG plus
  O(c log c) per text for the interval sweep — once per `view()`; anchor
  resolution is memoized per entry. Before WU6 it was
  O(records × their ranges): 9.41 ms of a 5,000-block keystroke was spent
  writing 318,891 dense ownership positions; after WU6 that text is
  covered by 5,000 intervals and ownMs measured 6.15 ms, with the
  remaining cost in per-claim resolution rather than per-atom traversal
  (`docs/crdt-v14-benchmarks.md` §15).
- `flatten` is O(displayed atoms + overlapping intervals); interval
  `claim` identity guarantees single emission without re-resolution.
- Wire bytes: split/merge emit only record churn — measured in
  `bench/results/latest.json` (workload `textOwnership`): **334 B** split of
  a 100k-char block, **35 B** merge of a 100k block; flat across
  1k/10k/100k payloads (O(record), not O(text)). Copy-semantics comparison:
  50,136 B / 100,035 B — and copy loses concurrent edits to the moved range.

## Limitations

- **Island/void are not model-level concepts.** The ownership engine is
  type-agnostic; `void`/`island` restrictions (no editing inside voids,
  island isolation at seams) are plugin/operation-layer semantics owned by
  U06 — the model exposes the machinery but does not enforce block-type
  policy. TX09 covers the model-level cases (empty blocks, inline atoms,
  nested children); the type-policy gap is recorded here explicitly.
- **Losing same-anchor siblings are empty** rather than coalesced — a
  deliberate product choice (each Enter keypress produced a paragraph
  break), deterministic via stamp order.
- **Contested same-position claim order is stamp-arbitrary** — convergent
  and deterministic, but "who wins" carries no semantic intent.
- **Left-edge typing rewrites the covering record per keystroke** —
  measured **72.8 B/char** for 100 inserts at offset 0 of a split tail
  (`gate1/growth.test.ts`), vs ~53 B/move: the dominant per-op wire cost
  observed in the gate-1 review (finding #7). It is bounded — one record
  rewrite per char, never payload copy — so this is recorded as a **U11
  optimization candidate**, not a correctness fix: an anchor-with-offset
  record could absorb left-edge bursts without rewriting the record.
- **Per-claim anchor resolution** is now the dominant `computeOwnership`
  cost (post-WU6 the sweep itself is O(c log c) per text): each slice
  record pays two `createAbsolutePositionFromRelativePosition` calls plus
  owner routing. ~0.7 µs/claim measured at 1k claims — unproblematic at
  editor scale, unmeasured at document-migration scale.
- **Undo of a contested-away record** re-asserts its claim — undo semantics
  for records that lost ownership races is "the tombstone revives and
  re-enters the contest", which is the correct selective-undo behaviour but
  can surface a previously-invisible empty sibling.
