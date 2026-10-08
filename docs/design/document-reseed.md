# Design: re-seeding a document near its quota (document lifetime ceiling)

Status: proposal, for the maintainer's decision (2026-10-08). Nothing here is built.

## The problem

A room's stored document grows by about 72 bytes per edit for its whole life: the CRDT keeps an
identity for every run of text ever inserted, every block ever registered, the attribution
records and the replaced map values (`lastChangedBy` is already written only when its writer
changes). The purge (`purgeAfterDays`) removes deleted content and old undo steps, but that gives
back about 5% (soak, `bench/soak/size.mjs`). At `maxDocumentBytes` (2 MiB by default) the room
refuses writes (`4413`) and the provider stops: a document many people edit daily reaches it in
days to weeks.

"Deleting history" past a threshold cannot shrink the rest: what remains is not history but the
identity of the live content. Only rebuilding the document from its content, with fresh
identities, drops it. That is a re-seed.

## What a re-seed is

At a threshold (`reseedAt`, a share of `maxDocumentBytes`, off by default), the room:

1. Reads its live document as JSON (`toJSON`: blocks, ids, kinds, data, marks, document data).
2. Seeds a new engine document from it (the generation cutover's path, `storage.convert`):
   block ids, kinds, data, content and marks survive; CRDT identities, undo history and
   attribution lineage do not (attribution keeps `createdBy`/`lastChangedBy` as data).
3. Stores it as the container of a new **epoch** in one storage transaction, keeping the
   previous epoch's JSON as a version in the history store (a restorable "before the re-seed").
4. Closes every socket with a new close code, `4410` (`reseeded`), carrying the new epoch.

The generation word does not change: an epoch is a container identity inside a generation.

## Clients

A client stores, beside its local copy (IndexedDB), the epoch it last synced with and the JSON of
the document at its last acknowledgement (the provider's `OwnWrites` ledger already knows what
the room acknowledged; the JSON is written when an ack covers every local write, so it is the
base of the local edits not yet saved).

On `4410`, or on a dial whose epoch the room no longer serves (the room answers the old epoch
with `4410` too):

- **No unsaved local edits**: the provider clears the local copy (`clearDocument`) and the view
  reloads the new epoch: the same document, by block ids.
- **Unsaved local edits (an offline session)**: they are **replayed**, not lost:
  1. diff the base JSON (at the last ack) against the local JSON: blocks added, removed, moved,
     retyped, data and content changed — by block id, the history panel's `versionDiff`;
  2. load the new epoch, then apply that diff as ordinary operations through the document's
     operations (`insertBlock`, `deleteBlock`, `moveBlock`, `setBlock`, `replaceRange` on the
     block's content), one local transaction, as the user's;
  3. a block the diff changes that another user also changed since the base keeps the replay's
     version (the later write wins, block by block); a block the diff changes that was deleted in
     the new epoch is re-inserted where it stood (content the user did not remove is preserved).

The view is rebuilt on the new document (`createDocument` + `attachSync`): the selection and the
view's undo history do not survive a re-seed; the provider reports `reseeded` so the app can say
so.

## What it costs

- Every client reloads once per re-seed; concurrent edits to the same block in an offline
  session resolve block by block, not character by character.
- Undo across the re-seed is gone; the version history keeps the pre-re-seed state.
- The protocol gains the epoch (in the Step1/dial and the generation record) and `4410`; a client
  that predates it is refused (`1008`) by a re-seeded room and must upgrade.

## Work, by owner (tests first, in this order)

| Area                           | Change                                                                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crdt/protocols`               | the epoch in the dial and the generation record; `4410` in the close table (`CLOSE`, `isRefusal`: not a refusal, a reload)                                                                                                      |
| `cloudflare/room/storage.ts`   | `reseed()`: JSON → new container of epoch + 1, one transaction; the previous JSON as a history version                                                                                                                          |
| `cloudflare/room/admission.ts` | trigger at `reseedAt` after a stored frame (never mid-frame); refuse a stale epoch with `4410`                                                                                                                                  |
| `crdt/providers`               | the epoch and the base JSON beside the local copy; on `4410` clear or replay; a `reseeded` event                                                                                                                                |
| `collaboration`                | the replay: `versionDiff` + the document's operations, one transaction                                                                                                                                                          |
| `components/Edytor.svelte`     | rebuild the view's document on `reseeded`                                                                                                                                                                                       |
| tests                          | room lane (trigger, epoch, refusal, history version), crdt (diff → replay convergence, the block-wins rule), hosted lane (an offline client replays after a re-seed in three browsers), soak (a document re-seeding under load) |
| docs                           | server/room (quotas), collaboration (persistence), limitations, the changelog                                                                                                                                                   |

Estimate: about two weeks of focused work, the replay and its convergence tests most of it.

## Alternatives

- **Drop unsaved offline edits** with a warning instead of replaying: about half the work, but it
  loses content the user did not remove.
- **Only shorten the purge window**: small gain (about 5%).
- **Raise `maxDocumentBytes`**: bounded by the room's memory (18 to 46 heap bytes per stored byte).
