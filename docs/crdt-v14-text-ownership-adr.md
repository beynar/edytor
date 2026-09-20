# ADR — U04: text ownership = stable backing texts + anchored slice claims

Status: **decided and implemented** (U04). Plan reference:
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
(TX01–TX09, ST01–ST03, HI01a/b — green lane, both delivery orders, reload).

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

- `b` unknown or `del`-flagged → `dead`;
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

The winning **record** is tracked per atom (`atomClaim`), so two
overlapping records routing to the same owner cannot double-emit.

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
  (TX06a). Typing at the tail's left edge re-anchors the record to cover the
  new atoms with `g = maxG + 1`, so the extension wins deterministically.
- **Merge join**: an insert at the join lands at the end of the _preceding_
  owned segment's backing text — left-affine (TX06b).
- **Spanning delete/format**: resolve per owned segment against its backing
  text — a range crossing a split seam deletes/formats atoms on both sides.
- **Empty display revive**: inserting into a block that owns nothing writes
  a `{t: self, s: end-pinned, e: E, g: maxG+1}` record so the new atoms are
  claimed by this block — not swallowed by a neighbour's E-sentinel.

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

## Complexity

- `computeOwnership` is O(total live records × their ranges) per call —
  once per `view()`; anchor resolution is memoized per entry.
- `flatten` is O(displayed atoms + claim depth); `atomClaim` guarantees
  single emission without re-resolution.
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
- **Anchor resolution cost** scales with text length × record count for
  contested texts; unproblematic at editor scale, unmeasured at
  document-migration scale.
- **Undo of a contested-away record** re-asserts its claim — undo semantics
  for records that lost ownership races is "the tombstone revives and
  re-enters the contest", which is the correct selective-undo behaviour but
  can surface a previously-invisible empty sibling.
