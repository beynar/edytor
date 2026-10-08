# ADR — hardening U3 / R3: undo restores deleted text to its pre-delete owner

Status: **decided and implemented** (hardening unit 3; revised for Gate-H
round 3 — structural detection, permanent listener, same-frame repair).
Driver: `docs/archive/crdt-v14-follow-up-review-2026-09-21.md` §R3 (P1),
`docs/archive/crdt-v14-hardening-prompt.md` Unit 3, and the Gate-H R3/R5-D6
findings (`docs/archive/crdt-v14-gateH-review.md`). Base ownership model:
`docs/crdt-v14-text-ownership-adr.md`.
Implementation: `src/lib/crdt/edytor-doc.ts` (`repairUndoOwnership` /
`attachUndoRepair`, driven from `beforeObserverCalls`) +
`src/lib/crdt/text/model.ts` (`undoRepairClaims`, `resolveAnchor`'s
`followUndoneDeletions` parameter).
Tests: `src/tests/crdt/hardening/undo-ownership-split-tail.test.ts`,
`src/tests/crdt/hardening/undo-ownership-probes.test.ts`,
`src/tests/crdt/text-model-probes/delete-range-disjoint-segs.test.ts` (amended undo probe),
`src/tests/crdt/text/ownership-regression.test.ts` (amended undo/redo
expectations).

## The defect

`Y.UndoManager.undo()` does not un-delete the original items. It resurrects
the deleted atoms as **new items** and leaves a _local_ `item.redone`
pointer from each tombstone to its copy. The pointer is never serialized —
a replica that applies the undo update but never ran the deletion locally
has no `redone` chain at all.

Slice records (the replicated ownership claims of the text-ownership ADR)
bind their anchors to the **tombstoned originals**. Anchor resolution runs
with `followUndoneDeletions = false` — deliberately, because following
`redone` is replica-dependent — so a record anchored on the dead atoms
resolves _past_ the resurrected copies. The copies are then swallowed by
whichever surviving record still covers their landing gap.

Pinned reproduction (`src/tests/crdt/hardening/undo-ownership-split-tail.test.ts`):

```ts
b = 'hello world';
b.split(6, 'tail'); // b='hello ', tail='world'
um = createUndoManager({ captureTimeout: 0 });
tail.deleteText(0, 5); // tail=''
um.undo();
// pre-repair:  b='hello world', tail=''   (atoms resurrected under 'b')
// post-repair: b='hello ',     tail='world'
```

Because ownership is derived from replicated records, the wrongness was
itself replicated: receivers and binary-reloaded docs derived `b='hello
world'`, `tail=''` — the characters were conserved but restored to the
wrong paragraph, and restored marks followed the wrong owner with them.

## Why `followUndoneDeletions = true` is not the fix

Resolving slice anchors through the `redone` chain makes the _undoing_
replica see the intuitive pre-delete layout — but `redone` is engine-local
state, absent on receivers and after reload. Two replicas would derive
different ownership from identical replicated state. That violates the
ownership model's core rule (resolution must be replica-independent) and is
exactly the divergence R3 was reported as. `redone` may be used only as a
local _oracle_, never as the semantic source of truth.

## The repair — replicated claim materialization

`attachUndoRepair(doc)` registers a doc-level **`beforeObserverCalls`**
observer once per document and **never detaches it** (a module-level
`WeakMap<doc, true>` dedupes; the entry and the doc-held listener die with
the doc). Gate-H showed that a refcounted lease released the listener when
the last facade disposed — an undo landing in that window produced
permanently unrepaired (and broadcast) ownership. Facade `dispose()`
removes only facade listeners; the repair observer stays armed, so
`createUndoManager()`, a raw `new Y.UndoManager(...)`, and
undo-after-last-dispose all get the same repair.

On every committing transaction:

1. **Detect resurrection — structurally, never by origin** (Gate-H R3).
   The old `transaction.origin instanceof Y.UndoManager` gate was
   bypassable through the public API: `doc.transact` joins an outer
   transaction and cannot replace its origin, so
   `ed.transact(() => um.undo())` / `doc.transact(fn, customOrigin)`
   committed undo work under a non-UndoManager origin. The signature now
   reads what the transaction _did_:
   - _Suspicion_ — `transaction.insertSet` contains a **countable atom in
     a `content` node carrying `keep === true`**. `redoItem` mints each
     copy and marks it `keepItem(copy, true)`; `keep` is a local-only bit
     (never serialized) and at `beforeObserverCalls` time nothing else has
     run yet that could set it (`keepItem` for tombstones runs in
     `afterTransaction`). Plain inserts/deletes never carry it.
   - _Confirmation_ — a tombstoned item's **`redone` pointer lands inside
     this transaction's `insertSet`** (`redoItem` writes
     `tombstone.redone = copyId`; tombstone splits propagate it with the
     offset). This proves the copy was minted here and cannot be forged
     by keep-inheritance.

   Both hold for `undo()` **and** `redo()` (redo can resurrect too), under
   any origin — nested transactions, custom origins, raw UndoManagers.
   Remote `applyUpdate` transactions carry neither `keep` nor `redone`, so
   receivers converge on the replicated claims instead of re-deriving.

2. **Locate the copies.** Each `redone` target names a copy's first clock;
   contiguous same-client pieces to its right that were also minted in the
   transaction (split copies inherit `keep` and share the id range) are
   walked and absorbed, and each content-node piece resolves to a live
   index span `[i0, i1)` via
   `createAbsolutePositionFromRelativePosition`. Spans bound the
   resurrected atoms exactly — foreign atoms inserted between delete and
   undo are never covered — and overlapping/adjacent spans merge before
   planning so contiguous copies from separate `redoItem` calls can't
   double-claim a shared region.

3. **Identify the pre-delete owner.** `T.undoRepairClaims` re-runs the
   ownership contest over every record claiming the backing text with
   `resolveAnchor(..., followUndoneDeletions = true)` — the "as if the
   deletion never happened" view only the undoing replica can compute —
   and diffs it against the normal-resolution winner at each resurrected
   position. One exclusion sharpens the oracle: records **freshly minted
   in the same transaction** (insertSet members that are NOT resurrections
   — e.g. an `insertText` edge-rewrite batched with the undo, which can
   widen an `e` anchor to the live end) did not exist before the
   resurrection, so they cannot witness pre-delete ownership and are
   dropped from the redone-space contest only. They still count as the
   normal-resolution winner — a claim written alongside the undo keeps
   what it legitimately covered. Records _resurrected_ by the transaction
   (copies with a `redone` source) stay in the contest — they are the
   restored pre-delete claims.
   - **Same winner** → the atoms already emit under the right record;
     nothing is written (the common single-block undo adds zero state).
   - **Different winner / none** → a fresh record `{t, s, e, g}` is planned
     for the _redone-space_ winner's holder, anchored to the copy atoms at
     the contested sub-range, inserted at the winning entry's `seqIndex` so
     the copies emit at the display slot they occupied before the delete.
   - **No redone-space winner** → no claim; the documented dead-owner
     fallback applies (see _Policy_ below).

4. **Materialize as replicated state — inside the committing frame.**
   `beforeObserverCalls` fires after the transaction's mutations are done
   but BEFORE its observer pass (`_callObserver` → deep-observe →
   `afterTransaction` → `update`). The claims are written by opening a
   **follow-up transaction** (`doc._transaction` is null there, so
   `doc.transact` appends it to the in-flight cleanup sweep) under
   `UNDO_REPAIR_ORIGIN` (a Symbol), and the repair transaction's `changed`
   entries are **unioned into the committing transaction's `changed`
   map**. The runs view's `observeDeep` handler derives invalidation from
   that map, so it invalidates the slices facet and recomputes post-repair
   runs in the SAME committed frame: `subscribeBlock`/`onChange` see
   exactly one notification carrying the repaired ownership — the
   unrepaired intermediate is never published (Gate-H R5-D6, the torn
   committed frame). The repair transaction still runs its own cleanup
   and `update` afterwards — **two wire `update` events, one observer
   frame** — and its recompute is identical, so nothing publishes twice.
   The claims are ordinary `slices` list items — they replicate like any
   local write, so receivers, late joiners and reloaded docs all derive
   the restored ownership without any `redone` knowledge. The `redone`
   traversal happens exactly once, on the replica that performed the undo.

### Precedence: `g = maxG + 1`

Fresh claims carry `g = maxG(t) + 1` — the same generation mechanism a
split/rewrite uses — so they deterministically outrank every record that
currently wins the copy range, through any claim depth. They are still
_subject_ to later claims: a subsequent split/merge/insert rewrite at a
higher `g` beats them normally. The repair is one ordinary claim, not a
privileged override.

### Anchor edge semantics are preserved

`anchorAt` emits the B/E sentinels at the text's ends and item-bound
anchors elsewhere. An E-ended repair claim only materializes when the copy
span reaches the live end — i.e. when no live atom followed the deleted
run — which means the pre-delete winning record was also effectively
E-ended (its `e` resolved to the same end). The fresh claim therefore
reproduces the original edge semantics: a later append at the tail's right
edge still belongs to the tail, exactly as it would have before the delete.
Item-bound ends never absorb foreign atoms.

### Undo-stack hygiene

`UNDO_REPAIR_ORIGIN` is a Symbol — not `null`, not the UndoManager — so the
vendored capture rule (`trackedOrigins = {null}` plus the manager itself,
`UndoManager.js` `afterTransactionHandler`) does not capture it: **one user
action remains one undo group**, and the write cannot recurse into itself.
The pinned tests undo/redo exact op counts and stay green.

### Convergence envelope

- **Receiver that never ran the delete**: applies the undo update plus the
  claim update; both are ordinary replicated state — same projection.
- **Message split**: a receiver that applies the resurrection update but
  not yet the claim update transiently sees the old drifted ownership; the
  claim converges it on delivery. The reverse order is also safe — a claim
  whose anchors are not yet integrated resolves to nothing and covers
  atoms once they arrive.
- **Binary save → reload**: the claim is part of the encoded state; a fresh
  doc derives the repaired ownership byte-for-byte (pinned).
- **Repeated cycles**: each undo writes claims bound to that generation's
  copy atoms; claims over atoms later re-deleted resolve to empty and go
  inert (pinned: two delete/undo cycles).

## Policy for concurrent structural ops on the original owner

The owner identity is resolved through `ownerOf` (merge claims followed
transitively) and the redone-space contest, so the repair composes with
concurrent structure instead of freezing it:

- **Owner merged between delete and undo** — the holder's slice list
  routes to the survivor via its merge claim; the fresh record lands on the
  holder's list and the resurrected atoms surface under the survivor — the
  atoms follow their pre-delete display exactly as the merge dictates.
- **Owner split between delete and undo** — the redone-space contest
  resolves the post-split records too, so each contested sub-range is
  claimed for whichever post-split block would have displayed it.
- **Owner deleted between delete and undo** — `ownerOf(holder) === DEAD`
  holders are skipped while building the redone-space claim set, so no
  claim is written and the atoms fall back to whatever record already
  covers them (dead-owner fallback). The repair never resurrects content
  into a deleted block.
- **Owner moved between delete and undo** — placement is orthogonal to
  ownership; the claim follows the holder wherever it now sits.
- **Foreign edits between delete and undo** — the repair spans bound the
  copy atoms exactly (item-bound anchors except the faithful B/E edge
  cases above), so atoms a peer inserted meanwhile are never covered.
  Pinned: a remote `!` typed into `b` before the delete survives as
  `b='hello !'` while `world` returns to `tail`.

## Selection anchors

`anchorAt`/`resolveAnchor` bind _atoms_, not records. An anchor inside a
deleted-then-undone range stays bound to the tombstone; it resolves to the
gap the tombstone occupies in the item sequence, which — because the copies
integrate ahead of the tombstones — lands at the right edge of the
resurrected run. With the repair, that gap is owned by the restoring block,
so a caret in `tail`'s deleted text resolves into `tail` again instead of
drifting into `b`. Pinned: mid/start/end anchors all resolve to
`{blockId: 'tail'}` post-undo.

Known collapse: intra-range anchor _offsets_ are not preserved through
resurrection — anchors bound to different tombstones in one deleted run all
resolve to the same gap edge. That is pre-existing tombstone-resolution
semantics, unchanged by the repair (the repair fixes the block identity,
not the intra-run offset).

## Classified limitation — remote edits captured into the local undo stack

Review §R3 noted a hostile ordering: a remote edit landing _between_ the
delete and the undo was eaten together with the missing restore.
Classification: **upstream `UndoManager` capture policy, not an ownership
defect.** `applyUpdate` transactions carry `origin = null`, and `null` is
in the default `trackedOrigins` — so the remote insert becomes a local undo
stack item. The first `undo()` pops the remote insert (deleting `!`); the
second pops the delete and the repair restores `world` to `tail`. Both
replicas converge. This is now pinned in
`undo-ownership-split-tail.test.ts` ('remote edit BETWEEN delete and undo').

Whether a collaborative editor _should_ capture remote edits into the local
undo stack is a product-level question (a `trackedOrigins` filter or a
local-edit origin marker would scope it). It is orthogonal to R3 and left
for the runtime/history unit to decide — the repair does not depend on it.

## What was deliberately not done

- **No vendor changes.** The repair lives in the document/model layer; the
  vendored engine is untouched (no `UPSTREAM.md` entry needed).
- **No `redone` in the semantic path.** Replicated claims carry the
  verdict; `followUndoneDeletions = true` is confined to the planner.
- **No undo of the repair.** The claim is intentionally untracked —
  undoing it separately would re-break the state it just restored.

## Remaining gaps / honesty notes

- The repair listener installs on the FIRST `create()` for a doc and then
  lives for the doc's lifetime — facade disposal no longer disarms it
  (Gate-H fix, pinned: undo after the last `dispose()` still repairs).
  A raw `Y.Doc` mutated by a raw UndoManager _without ever having a
  facade_ still gets no repair — but also has no edytor ownership
  semantics to repair; every replica derives the same drifted state,
  which is convergent (if semantically wrong).
- Repair writes are a second transaction per undo — a small extra update
  per resurrection, bounded by the number of contested holders. The local
  observer frame is merged (subscribers see one repaired notification);
  the wire is not — receivers apply the resurrection update and then the
  claim update, converging after both.
- A `slices` record written _inside the same transaction_ as the undo
  (batched claim work) is excluded from the pre-delete contest: the
  repair may outrank it on the resurrected span. This is the conservative
  choice — the transaction is treated as one undo action whose pre-delete
  ownership is restored; callers wanting post-undo claims should write
  them after the undo commits.
- The merged observer frame makes the deep-observe contract see the
  repair's `changed` entries under the committing transaction — correct
  for the runs view (which reads `transaction.changed`). A consumer of
  the per-type `'delta'` channel sees the repair's slices records as a
  second `'delta'` event under `UNDO_REPAIR_ORIGIN`, not folded into the
  undo frame's rendered delta (the facade emits neither, so this is
  latent).
- Anchors in restored ranges collapse to the run edge (see above).
- Remote-op capture into the local undo stack is classified but not
  changed (see above).
- The random corpus lane (`src/tests/crdt/random/`) was mid-refactor by a
  parallel work unit while this landed; its `stolen-edit` verdicts were
  verified independent of this repair (identical failures with the repair
  disabled) but a final green corpus sign-off belongs to that unit.
