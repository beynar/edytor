# ADR — U03: move primitive = stable payload + replicated placement records

Status: **decided and implemented** (U03). Plan reference:
`crdt-v14-implementation-plan.md` §3 (move references), §4 (movement
semantics), §8 (MV01–MV10).

## Decision

Moves are expressed as **replicated placement metadata on a stable payload
registry**, not by physically relocating a Yjs node and not by porting the
historical native-move branch.

```
doc.get('blocks')                        registry — flat map, block-id → node
  └ <blockId>  Node('block')             stable identity; survives every move
       ├ id / type / data                payload attrs
       ├ del                             explicit-delete flag (presence = deleted)
       ├ content → Node('content')       rich-text sequence (text + inline atoms)
       └ at → Node('at')                 placement candidate map
            └ "<seq>.<clientId>" → { p: parentId|null, r: rank }
```

Displayed structure is a **pure projection** over replicated state; the
registry's physical layout is never the placement order.

Implementation: `src/lib/crdt/placement/model.ts` (`bindModel(Y)`, ~884
lines), rank codec `src/lib/crdt/placement/rank.ts`, structural engine
boundary `src/lib/crdt/engine-api.ts`, harness adapter
`src/tests/crdt/harness/ops/model-ops.ts`.

## Why placement, not native PR #357 move

The plan §3 instructs: _evaluate stable payloads plus replicated placement
first_. Evaluation outcome:

1. **The pinned baseline has no native move.** `yjs@14.0.0-rc.26`
   (96c96e1) removed it; `Y.Node` exposes `insert`/`delete`/`format` only
   (`src/lib/crdt/vendor/yjs/API-NOTES.md`). Selecting native move means
   porting PR #357 onto the pinned commit — move records touching item
   integration, iteration, relative positions, update encoding — i.e.
   maintaining an engine fork, exactly the "difficulty is not a reason"
   trade-off the plan warns about but cannot justify when an equal-semantics
   alternative exists.
2. **Wire-format drift.** Historical move content used wire tag 11
   (plan §3). Current rc.26 decoders would not interoperate with a
   reintroduced tag without a compatibility story — a provider/persistence
   hazard deferred to U07.
3. **PR #357's own gaps.** Text movement and reparenting were deferred in
   the branch; its range-cycle test was disabled and randomized move
   generation uncovered unfinished cases (plan §3). It is a research
   reference, not a shippable base.
4. **Placement is provably sufficient.** Every §8 MV requirement — single
   deterministic placement, atomic parent+rank, deletion-wins, acyclicity,
   grouped move, undo, anchors — is satisfied on the unmodified baseline.
   Wire cost is _smaller_ than a native move's (one small attr write vs a
   move record spanning item ranges).

Native move remains a valid future optimization; nothing in this design
blocks a later engine-level primitive.

## Invariants

- **One stable identity per block.** The registry node never moves; `crdtId`
  = `client:clock` of its item (`model.ts:835`). Moves, reparents, splits,
  merges preserve it — proven by `crdtId` equality assertions across MV01,
  MV10 and the focused suites.
- **At most one visible placement per block.** Winner = argmax candidate;
  projection emits each live block once under its resolved parent
  (`resolvePlacements`, `model.ts:233`).
- **Acyclic projection, always — over the COMPOSED relation.** Greedy
  acceptance in the global order rejects a candidate whose _display_ edge
  `owner(p)` would close a cycle through already-accepted display edges; a
  block with no acceptable candidate rehomes at root. The relation kept
  acyclic is `b ↦ owner(parent(b))`, not raw `pl.parent` — see
  _Cycle policy_ below. No replica-specific repair writes — the projection
  is pure.
- **Atomic parent+rank.** `{p, r}` is one attr value; two competing moves
  can never merge parent from one with rank from the other
  (`writePlacement`, `model.ts:213`).
- **Insert is all-or-nothing** (gate-1 finding #2). `insertBlock` validates
  every id in the spec tree — root AND nested `children[]` — against the
  registry plus within-spec duplicates _before_ mutating; any collision
  (live or deleted entries alike) returns `false` with zero mutations.
  A blind recursive `registry.setAttr` would tombstone the victim's
  registry item in place — content, slices, placements, engine identity.

## Conflict ordering

Total order on candidates: **`(seq, clientId, blockId)` descending**, where
`seq` = writer-local `localMax+1` per block and `clientId` =
`doc.clientID`. Applied identically to:

- per-block winner selection (MV02: higher stamp wins — deterministic, not
  delivery-dependent);
- global acceptance order for cycle resolution (MV05);
- per-member group-move resolution (MV07).

Concurrent moves of one block therefore converge to one placement with one
survivor; a winner's _effect_ is still monotone — losers' writes are kept
as fallback candidates (top-2 retention), then tombstoned below that.

## Rank format

`rank.ts` implements a Logoot-style codec:

- Alphabet `-0-9A-Z_a-z` — chosen to match JavaScript character-code order
  so encoded strings sort lexicographically (fixed an earlier alphabet bug).
- `rankBetween(left, right, client)` mints a strictly interior rank;
  open bounds append/prepend; equal prefixes descend a level with the
  client id as the disambiguating tie segment (MV08 collision case).
- Equal-rank neighbors (possible after cycle-fallback rehoming) cannot
  yield an interior string — `rankAt` (`model.ts:435`) joins the tie and
  the `(rank, id)` sibling sort places the newcomer deterministically
  inside the tie group.
- Bounded open-end allocation keeps append/prepend ranks shallow (13
  rank tests incl. density/collision in `rank.test.ts`).

## Deletion policy

`deleteBlock` sets the `del` flag — **explicit deletion wins visibility**
over any concurrent or later-arriving move (MV06a): the block and its
subtree are hidden because children still point at it. Payload, placements
and content are retained in the registry for undo and offline integration;
reclamation is U07's problem, not this layer's.

Children of a deleted (or never-integrated) parent are hidden **with the
subtree** — no orphan promotion (MV06b). `crdtId`/`positionOf` return null
for hidden blocks even though their records live on.

> **Superseded 2026-09-29 (UW-08).** An unmarked child of a delete-marked
> parent is now promoted at read time into the parent's slot
> (`placement/model.ts` `displaySlotOf`), and a whole-subtree delete marks
> every member. The cycle check walks a deleted parent instead of treating
> it as a sink. Normative rows: `del.blocks.promote` in
> `docs/editor-delete-contract.md`.

## Cycle policy

The relation the model keeps acyclic is the **composed display-parent
relation**, not raw placement parentage:

```
displayParent(b) = owner(pl.parent(b))     — pl.parent null ⇒ root;
                                             owner 'dead'  ⇒ hidden-with-subtree sink
```

A block whose placement parent was merged away displays under the parent's
claim _owner_ (U04), so a merge claim can redirect a display edge back into
the block's own subtree — e.g. `mergeBlocks(A → B)` while `B` sits under
`A`, or concurrent `merge(B → A)` + `move(A under B)`. Each input relation
(raw placements, the claim-owner map) is acyclic on its own; their
composition is not — the gate-1 blocker made such blocks live but
unreachable on every replica (silent convergent content loss).

Two complementary mechanisms (same layering as plan §4):

- **Projector resolution** (`resolvePlacements`): candidates are tried in
  the global order `(seq, clientId, blockId)` descending; a candidate is
  accepted iff its tentative _display_ edge `owner(p)` cannot reach the
  block through already-accepted display edges (`'dead'` parents are sinks —
  they hide the subtree and can never close a cycle). Rejected candidates
  fall through to the block's next candidate, ending in a deterministic
  root fallback (argmax rank, `MIN_RANK` if none survives). Because the
  claim-owner map is computed from `slices` records independently of
  placements, the composed acceptance test remains a **pure function of
  replicated state** — concurrent cycles no local guard could see are
  resolved identically on every replica, and no live block is hidden
  forever.
- **Local op guards**: `moveBlock`/`moveBlocks`/`nestBlock` reject a
  destination inside the mover's own _display_ subtree, and
  `mergeBlocks(fromId, intoId)` rejects when `intoId` lies inside
  `fromId`'s display ancestry (the claim would close
  `intoId → … → fromId → intoId` — invisible to the raw graph). Both reject
  **before** mutation (`isSelfOrDescendant` walks the composed chain) and
  return `false` — zero update bytes.

Evidence: `src/tests/crdt/model-edges/display-cycle.test.ts` (3 tests),
`reachability.test.ts` sweep **0/150 seeds** with vanished blocks (was
~29/150 pre-fix), corpus `unreachable-block`×0.

## Grouped move

`moveBlocks(ids, dest)` (model.ts:530): moves the **snapshot** of `ids`, in
source order, to consecutive positions at `dest.index` — one transaction,
hence **one undo step** (MV07b asserts `undo()` restores both placements).
Does not capture blocks inserted later into the old range. Conflict
resolution is **per member** (each block writes its own candidate under the
normal order); an overlapping concurrent move of a member wins/loses per
member — no all-or-nothing concurrent claim (MV07a). Locally the group is
all-or-nothing: any unresolvable member or invalid destination aborts
without mutation.

## Undo / redo

`UndoManager` scoped to the registry root (`doc.get('blocks')`) captures
placement writes as ordinary item tombstones. Proven
(`concurrency.test.ts`, "undo proof points"; scenario MV07b):

- undo of a local move preserves a concurrent remote move — removing A's
  candidate exposes B's surviving one, no visual jump;
- undo after a remote text edit inside the moved block keeps the edit;
- undo restores the exact pre-move placement after a quiet move;
- a grouped move is exactly one undo step; remote placement contributions
  are not undone.

Remote/provider transactions stay out of local history via
`trackedOrigins` + `peer.localOrigin` (adapter `model-ops.ts`).

## Anchors and events (MV10)

`resolveBlock` returns the live engine handle; it is _the same object_
across moves (the node never relocates). `observeDeep` on the handle (or
the registry) fires on placement writes and remote content edits — anchors
and nested observer paths survive moves by construction.

## Wire-byte comparison

`bench/run.js` → `bench/results/latest.json` (workload `move`):

| case                            | placement model | v13 copy-move |
| ------------------------------- | --------------- | ------------- |
| 100k-char payload, one move     | **60 B**        | 100,136 B     |
| small payload, one move         | 57 B            | 129 B         |
| 500 sequential moves, amortized | **71 B/move**   | —             |

Placement move cost is O(1) in payload — one `{p, r}` attr write plus
occasional top-2 tombstones — vs O(payload) for copy-move (~1,670× at
100k). A hypothetical ported native move would emit a move record of
comparable constant size but additionally requires engine-internal changes
and the wire-tag-11 compatibility story; placement wins on risk-adjusted
cost, not just bytes.

## Limitations (owned by later units)

- **Content ownership is still copy-style.** `splitBlock`/`mergeBlocks`
  transfer the tail via new items (`contentTail`/`appendItems`), so
  concurrent edits to a moved slice can land on dead items — this is the
  U04 boundary, evidenced by corpus classes `lost-edit` and
  `duplicate-inline` (see below). Placement itself is clean.
- **Top-2 candidate compaction** drops deeper placement history; undo of
  very old moves relies on engine tombstones, not candidate replay.
- **Rank growth** under adversarial alternating inserts is bounded but not
  constant — acceptable for editor-scale sibling lists.
- **Root rehoming** of fully-cycle-rejected blocks is a policy choice
  (deterministic, acyclic); a different product could prefer parent
  retention — only projection code changes.
- Per-move bytes grow slightly with candidate churn (seq key + tombstones);
  ~71 B amortized over 500 moves is the measured bound.

## Evidence (U03 exit)

- `pnpm test:crdt` — **767 passed / 6 skipped** (both corpora).
- Model corpus, 150 seeds × 200 ops × 3 peers:
  `lost-edit×~114, unrecoverable-loss×7, duplicate-inline×~8` — **zero**
  duplicate-placement, lost-identity, resurrected-delete, cycle, or
  upstream-crash. Raw-adapter control in the same run still shows all copy
  classes (dup-placement×50, lost-identity×76, resurrected-delete×9,
  cycle×7, upstream-crash×2) — the delta is the U03 effect.
- Focused suites: `rank` 13, `model` 13, `concurrency` 24 — 50 tests.
- Scenarios: **MV01–MV10 active** in `active-model.ts` (11 entries,
  green lane) and removed from `pending.ts`.
- `pnpm test -- --run` 746 passed / 29 todo; `pnpm check` 0/0;
  `pnpm lint` clean.

## U04 handoff / blockers

- TX01–TX09 remain pending (owner U04). The split/merge scaffolding in
  `model.ts` (584, 628) is intentionally copy-based — U04 must replace it
  with stable-atom ownership (backing text independent of displaying
  block) to retire `lost-edit`/`duplicate-inline` evidence.
- `unrecoverable-loss` (×7) = schedules with observed update loss —
  contract owned by U07 alongside the upstream-crash repros
  (`failures/seed-86,140.json`).
- Engine typing: the vendored `YNode` generic collapses to `never` under
  `svelte-check`; `engine-api.ts` exposes structural `EngineDoc`/`EngineNode`
  interfaces and `bindModel` injection — U04 should reuse that boundary
  rather than fight the dts generics again.
