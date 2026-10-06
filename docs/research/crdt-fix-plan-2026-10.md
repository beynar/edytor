# Fix plan for the 2026-10 CRDT study

Source: `docs/research/crdt-holes-and-performance-2026-10.md` (P = performance, H = hole).
Rules: AGENTS.md (one owner per fact, contract rows, tests first, every lane green, docs in the
same change). Each phase ends with a release (`next.N`, push master → Workers Builds deploys the
docs, tag → CI publishes).

## Phase 1 — core performance and correctness, no format change

- P1 Text index: `placeText` one linear sweep; rescan only when a commit touched a boundary,
  else shift offsets. Bench rows for split lineages and Enter-built documents.
- P3 Incremental placement: re-resolve only touched blocks, O(depth) cycle walk on a parent
  change, patch affected parents' child lists.
- P6 Undo cap: default steps/bytes limit, keep flags of dropped items released.
- H1 Block runs: inserting after a block this client ranked extends its run (the data arrays'
  `RUN` rule), so concurrent Enters never interleave; `rank-growth.test.ts` holds.
- H4 Turn into keeps properties: a retype writes `type` + the preset's leaves as `patchData`.
- H8 Atomic data paths: a kind declares paths written as one leaf.
- P9 Presence: a non-zero default throttle.

## Phase 2 — the room and sync

- P2 Compaction stores the healed live state (pending structs/deletes kept apart), proven
  stored == live; the room doc keeps the P11 `gcFilter`.
- P5 Storage in v2 + compression (rows, snapshots, IndexedDB), tagged in the generation record.
- H3 Quotas: document bytes, update rate, inbound frame size; a `quota` refusal.
- H2 Validation: an accept-then-compensate `validate` hook (`{user, touched, before, after}`; the
  room writes the inverse as its own transaction); `del.<n>`/`wd.<n>` keys only from client n.
- H6 Outbound chunking of the reconnect diff under the frame cap; inline `data:` images capped.
- H14 Metrics: document size, records, compaction and fold time, fan-out (RPC + logs).
- H12 `prefetch(room)` keep-fresh, a `lastUpdated` probe, read-only until first hydration (opt).

## Phase 3 — history and purge

- H11 Version history in KV: two snapshots a day per document (morning, evening; a timezone
  option, UTC by default), only when changed since the last; key `history/<doc>/<YYYY-MM-DD>-am|pm`,
  `expirationTtl` = retention (30 days default); value = compressed v2 state + JSON preview +
  metadata (size, editors). Room RPC/API: list, read, restore (a forward edit, one undo step).
  The host binds a KV namespace; without one, history is off.
- H7 Purge of deleted content past the horizon (= history retention): the room records when it
  saw each delete; content deleted more than the horizon ago is collected from the room's state
  (dead streams' text, delete marks, withdrawn creations, runner-up placements). A replica whose
  state is older than the horizon is closed with a new code (stale replica): its provider drops
  its local store, rehydrates, and hands its unsynced local edits to the app
  (`onStaleEdits(json)`) instead of losing them.

## Phase 4 — format changes (one schema generation bump, with migration)

- H5 Rich-text marks: end format items paired with their start (Peritext/Loro anchor pairing);
  comment marks keyed `comment:<id>`.
- P4 Delete marks folded per undo step / as per-writer ranges.
- P7 Rank format: variable-length digits, tiebreak on the last segment only.
- H9 Split-born siblings ordered by their boundaries' order; merge claims anchored to the head
  stream's last item.
- P5 v2 on the wire.

## Phase 5 — large pages and product

- P8 `content-visibility: auto` on top-level blocks; first paint from the room's JSON while the
  CRDT hydrates; lazy per-viewport index where it pays.
- H10 Cross-document move (tombstone the source after the destination acknowledges, forward late
  edits) and per-block locks through the H2 hook; "a page is a document" documented.
- H13 Concurrent creation of one id shows the losing incarnation's stream.
