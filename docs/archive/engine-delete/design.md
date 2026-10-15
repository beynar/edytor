# Attributed, reversible text deletes in the fork (YP20) — design

Status: design written before the prototype (2026-10-15, branch `engine-delete`).
The prototype and its measurements are recorded at the end of this file.

## Why

`crdt/text/deletes.ts` and `crdt/text/delete-index.ts` (10.3 KB minified in
every app, `node scripts/bundle-size.mjs`: 5.04 + 5.23 KB) exist because the
engine's delete has two properties edytor's product contract cannot live with:

- **anonymous**: a delete set names ids, not who deleted them, so two writers
  who deleted one character cannot tell their deletes apart;
- **irreversible**: a deleted item is deleted forever; an undo brings text back
  as a COPY (a new item), so edytor tracks copy lineage (root, member, leaf),
  restoration records (root `restored`, never removed), a pending set per
  history, a "hold" rule (a copy a peer made while my delete holds the
  character is deleted by me), a leftmost-wins deduplication of concurrent
  copies, a `gcFilter` that keeps every deleted copy's content on every replica
  (`keepCopies`, the room too), and follow-up transactions after remote changes.

The rule the user set: a layer that exists only to patch engine behaviour is
replaced by an engine change, and the layer goes.

## The data model and the merge rule

A **hold record** is a new content type, `ContentHold` (content ref 11): one
unit per held id range (`client, clock, len`). A record is an ordinary item
appended to the document's records list (the root `textdel`, as today); its id
is its writer's, so a record is a delete that names its writer.

- An item's visibility: `deleted = removed || holds > 0`, where `removed` is
  the engine's own delete (bit 3, the delete set, unchanged) and `holds` is the
  number of live records holding it (a per-item counter, local, never encoded).
- Integrating a record adds 1 to the holds of every item it names (split at the
  range's edges); deleting the record (an ordinary engine delete of the record
  item) subtracts 1. An item that goes from 0 to 1 hold, or 1 to 0, and is not
  removed, changes visibility: its parent's length moves, the parent is in
  `transaction.changed`, and the change is logged in `transaction.holds`
  (`[client, clock, ±len, …]`, in order) for edytor's index.
- An undo of a text delete deletes the undoer's record: the text shows again,
  in place (same items, same order), unless another live record still holds
  it. A redo re-creates the record (`redoItem` copies the record, never the
  text). An undo of typing writes a record holding the typed units.
- A record waits until every item it names is integrated (`getMissing` returns
  the target's client, so the record is a pending struct like any item whose
  origin is missing), so a record is never applied to a struct it cannot find.
  A target that is a GC struct is skipped (it is gone anyway).

**Merge rule / convergence.** The state that decides visibility is
(a) the set of items, (b) the set of removed ids (the delete set: a union),
(c) the set of records and the set of deleted records (a 2P-set: records are
immutable once written, a record is deleted at most once, deletion is a union).
`visible(x) = integrated(x) ∧ x ∉ removed ∧ ¬∃ live record r: x ∈ r` is a
function of that converged state, so every replica that has the same updates
shows the same text, whatever the delivery order:

- the counter is the size of that set as integrated so far: +1 on a record's
  integration, −1 on its deletion, and the engine never deletes an item it has
  not integrated (pending delete sets wait), never integrates one twice (state
  vectors), and a record that arrives deleted with its content collected
  (`ContentDeleted`) never counted;
- splits copy the counter, merges require equal counters (and equal `removed`);
- a record's targets are immutable (no edit of a record, only its deletion), so
  "only once both deletes are undone" holds by construction: two live records
  hold the character; each undo deletes its own.

The contract rows this gives without any edytor logic:

- concurrent double delete, then both undo: holds 2 → 1 → 0, the character
  shows once, only when both undid, in any delivery order (`hist.undo.restore`);
- undo and redo restore the same order: the same items come back, nothing is
  copied (`hist.undo.order`);
- text another author added is kept: an undo only deletes its own record; a
  peer's insert inside a held run is a new item with no hold.

**GC, purge, horizon.** A held item is not removed, so the engine never
collects it (no `gcFilter` for copies: there are none). The purge
(`crdt/purge.ts`, the room) erases what a record older than the horizon holds
(an engine delete of each target, then the record's delete): the content is
collected everywhere, as before. A newer record that still holds an erased item
has nothing to bring back when undone (the older delete is permanent past the
horizon — the existing `hist.purge.horizon` rule). A stale replica's undo of a
record the purge deleted is idempotent (deleting a deleted item): it restores
nothing, where today it made a copy (a residual that goes).

**Snapshots and restore.** A snapshot encodes a held item as a live item with
its content, and its record; the receiver recomputes the counters as the
records integrate. `restoreTo` (`crdt/restore.ts`) writes through the facade's
text ops, so it writes records like any edit. History versions are snapshots.

**Storage and the room.** `mergeUpdates`/`diffUpdate` slice and re-encode a
`ContentHold` like any content (`splice`, `write`). The room no longer needs
`keepCopies`. Schema generation 7 (wire word 14007): rooms, browser stores and
history versions of generation 6 are refused, never converted (the user's
rule: no conversion, old data may be dropped).

**v13 boundary tests.** They test that a v13 frame or update never reaches a
v14 document (the envelope), not the text-delete format: they stay.

## What goes away in edytor

- `src/lib/crdt/text/deletes.ts` (whole: marks, restore, settle, hold, dedupe,
  react, fold-into-last, history policy) and `src/lib/crdt/text/delete-index.ts`
  (whole: roots, members, leaves, holders, parts, copies index, record codec).
- The restoration records root (`RESTORED_ROOT`, `restored`).
- The history's `marks` rules (`restoreFilter`, `onApply`), the text delete
  part of `#release`'s comment, `bindDeletes` in `edytor-doc.ts`,
  `keepCopies` on the public binding and its call in the room
  (`room/updates.ts`), `appendAfter`, `ContentAny`/`createID` in the engine
  object if nothing else reads them.
- The purge's copies and restoration-record part (`purgeText`'s second half,
  `PurgeReport.records`).
- Tests of the old mechanics: restoration records, copies, dedup and the
  follow-up transaction (`text-delete-marks.test.ts` keeps its behaviour rows,
  which must pass unchanged), `delete-records-fold.test.ts` (folding is the
  engine's merge of consecutive records now).

## What the engine gains (YP20)

- `ContentHold` (Item.js, ~60 lines): length = ranges, `integrate`/`delete`
  hold and release, `splice`, `mergeWith`, `copy`, `write`, ref 11, and
  `readContentHold` in `contentRefs`.
- `Item`: `holds` field, `removed` getter, `deleted` includes holds; `delete`,
  `split`, `mergeWith`, `integrate` (parent check), `gc` read `removed`.
- `transaction.holds` (the ordered visibility log).
- `getMissing`: a record waits for its targets.
- `createDeleteSetFromStructStore`, `readAndApplyDeleteSet`, `tryGcDeleteSet`,
  `redoItem`, `ContentType#delete`: `removed` where they mean the engine delete.
- `YNode#delete(index, length, into, fresh)`: with `into` (the records list),
  the live units are held by one record appended there, except those `fresh`
  names (inserted by the open undo step: removed, as the engine always did, so
  a step that typed and erased the same text still changes nothing and is
  skipped by undo); search markers are moved as for a delete.
  `YNode#hold(ids)`: append a record holding `ids` (the history's undo of
  typing).

Edytor keeps: the records root in the history's scope, `deleteRange` passing
the records list and the open step's inserts, the history's undo of typing
(hold instead of remove), the index's reading of `transaction.holds`, and the
purge's erase of old records.

## Size estimate

| Piece | KB min now | after |
| ----- | ---------- | ----- |
| `text/deletes.js` | 5.04 | 0 |
| `text/delete-index.js` | 5.23 | 0 |
| history marks plumbing, `appendAfter`, engine object entries | ~0.3 | 0 |
| engine: `ContentHold`, `Item` changes, `getMissing`, `YNode#delete`/`hold`, log | 0 | ~1.6 |
| edytor: open-step registry, history hold, index log edits | 0 | ~0.5 |

Net: about −8 KB in the minimal and all probes (the export probe ships no
CRDT code: unchanged). Above the 3 KB floor.

## Risks

1. **Snapshot size.** Held text keeps its content until the purge (today a
   deleted character's content is collected once no history step keeps it,
   except copies). For a document with a lot of deleted text, stored size
   grows by that text until `purgeAfterDays`. Typing then erasing within one
   undo step still removes (the `fresh` rule), so typo correction leaves
   nothing. Measured by `bench:crdt` (encode) below.
2. **Index edits.** The index moves rows by the transaction's edits; a hold
   changes visibility without an insert or a delete, so the index must read
   the engine's ordered log (`transaction.holds`), including mid-transaction
   folds. A missed entry makes a row stale; the row-length check and the
   index self-checks (on in every vitest lane) catch it.
3. **Every reader of `deleted`.** Held items read as deleted everywhere,
   which is what every visibility reader wants; the few engine paths that mean
   "removed" (the delete set, GC, an item's delete guard, a parent's liveness
   at integration, redo's parent) must read `removed`, or a replica that holds
   an item and one that does not would diverge. Each is listed above; the
   random corpus, the replica harness and the DST lanes are the check.
4. **Search markers.** A hold on the local delete path moves markers as a
   delete does; holds from history replays, remote integration and the purge
   drop the markers of the texts they change (as today).
5. **Residual.** A text unit removed with its whole text node (a cascade:
   `restoreBlocks` overwriting a block's text) while a record holds it is not
   re-created by a redo of that overwrite; the record's undo then reveals it in
   the dead node only (unreachable). Today's copy logic had its own residuals
   here; no editor path does this under a history.
6. **Public API.** `keepCopies` goes from `bindCrdt(Y).doc`
   (`edytor/crdt/edytor`, `edytor/protocol`): a breaking change, in the
   changelog.

## Other layers that exist only to patch engine behaviour (read-only survey)

See the report at the end of this file.
