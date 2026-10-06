# CRDT holes and performance gains (study, 2026-10-06)

Sources studied: the Loro blog (all posts, read from github.com/loro-dev/loro-docs),
Notion's "How Notion handles concurrent editing with CRDTs" (+ its data-model,
offline and page-load posts), json-joy's list CRDT benchmarks (+ dmonad/crdt-benchmarks,
josephg/editing-traces), Liveblocks vs Yjs. Measured against `edytor@0.1.0-next.21`
(`arch-v2`), headless and through the facade. Experiment scripts:
`/private/tmp/claude-501/research-{loro,notion,jsonjoy}/` (not in the repo).

## Headline

edytor's design holds up well where the hard CRDT problems are (splits that copy no
text, offline structural merges, tree moves without cycles or duplication, per-writer
undo — ahead of what Notion describes). Its weak spots are **its own index and storage
code, not Yjs**: typing cost grows quadratically with the blocks sharing one backing
text, the room stores a 4–112× too-large snapshot, and text delete marks are ~76 % of
the encoded document. On a real editing trace (`automerge-paper`, 259,778 edits) edytor
applies at 12K ops/s against 141K ops/s for the plain vendored Yjs underneath it.

## Performance gains (ranked by impact / effort)

| #   | Gain                                                                                                                                                                                                                                                   | Evidence                                                                                                                                                                                                                                            | Fix                                                                                                                                                                                                                                                | Effort                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| P1  | **Quadratic text index.** Every commit rescans the whole backing text (`scanText`, `crdt/text/model.ts:318`, via `rescan` `text/runs.ts:479`) and `placeText` (`model.ts:359`) runs `row.bounds.filter` per stream: O(B²) for B blocks sharing a text. | Keystroke (model only) in an Enter-built doc: 1.1 ms @500 blocks, 3.9 ms @1k, **15.3 ms @2k**. One paragraph split N times: ~12 ms @1k splits, **~96 ms @5k**. `foldTexts` = 80 % of CPU on the trace. The room pays it too once its facade exists. | One linear sweep in `placeText` (small); skip the rescan when a commit touched no boundary and only shift offsets, or keep boundary positions in an ordered structure (Fenwick tree) (medium). Add a split-lineage case to `bench:crdt`.           | S → M                  |
| P2  | **Room compaction stores `mergeUpdates`**, which neither merges per-keystroke items nor collects deleted content (`DocumentRoom.ts:1144-1160`, restore `:1073`).                                                                                       | Trace: 6.69 MB stored vs 1.60 MB live state; wake load **611 ms vs 25 ms**; each compaction blocks the DO up to 124 ms. Churn (type/delete ×2000): 46.7 KB vs 0.4 KB (**112×**).                                                                    | Snapshot the healed live doc, keeping waiting structs and pending deletes apart (the `onLoad` path already does this, `:998-1001`); prove stored == live; check the room doc applies the P11 `gcFilter`. Also removes retained deleted text (H10). | S–M                    |
| P3  | **Structural ops recompute every placement** (`resolvePlacements`, `childrenIndex`, layout pass: `text/runs.ts:613-660`).                                                                                                                              | Enter p50: 1.5 ms @1k, 7.6 ms @5k, **46 ms @20k**; move 11 ms, delete 16 ms @20k. Keystrokes stay ~0.04 ms in steady state.                                                                                                                         | Incremental placement: re-resolve only touched blocks, O(depth) cycle walk on a parent change, patch only affected parents' child lists.                                                                                                           | M                      |
| P4  | **Text delete marks dominate size and heap** (`crdt/text/deletes.ts`, one record per delete).                                                                                                                                                          | Trace: 77,463 records = ~1.22 MB of the 1.60 MB encoding (~16 B each), ~10.8 MB of the 13.8 MB heap.                                                                                                                                                | Fold consecutive deletes of one undo step (backspace runs) into one record; store marks as per-writer ranges.                                                                                                                                      | M                      |
| P5  | **v2 (columnar) encoding + compression for storage.** Only `pendingDs` uses v2 (`protocols/sync.ts:206`).                                                                                                                                              | v1→v2: 1k blocks 308→220 KB (gzip 46→21 KB); trace 1.60→1.34 MB. gzip(v2) is 7–10× smaller than raw v1.                                                                                                                                             | Storage first (room rows, snapshots, IndexedDB) tagged in the generation record; wire later with a generation bump.                                                                                                                                | S (storage) / M (wire) |
| P6  | **Unbounded undo stack pins deleted content.** No limit passed (`edytor-doc.ts:1533`).                                                                                                                                                                 | A live doc encodes to 20 KB vs 466 B reloaded; worst case 260k steps = +230 MB heap; GC effectively off while history holds items. Loro defaults to 100 steps.                                                                                      | Default cap (steps and/or bytes), release keep flags of dropped items.                                                                                                                                                                             | S                      |
| P7  | **Rank length growth.** 16-char segments, 9 of them a client tiebreak (`placement/rank.ts`).                                                                                                                                                           | `rank-growth.test.ts`: 1,000 Enters in one spot → 592-char rank, 611 KB doc.                                                                                                                                                                        | Variable-length digits, tiebreak only on the last segment (2–3× shorter; format change). The H1 run rule also keeps ranks shallow.                                                                                                                 | M–L                    |
| P8  | **Large-page load and render.** ~250 B of structure per block; 20k blocks = 5.9 MB, cold load 237–323 ms + first read ~90 ms; no render virtualization.                                                                                                | Measured in all three studies.                                                                                                                                                                                                                      | `content-visibility: auto` on top-level blocks (keeps DOM, selection, IME); first paint from the room's `onSave` JSON while the CRDT hydrates; lazy per-viewport index.                                                                            | M–L                    |
| P9  | **Presence fans out every selection change** (`throttle: 0` default, `collaboration/awarenessSelection.ts:129`).                                                                                                                                       | Single-threaded DO per room.                                                                                                                                                                                                                        | Non-zero default throttle (e.g. 50–100 ms); document per-room limits.                                                                                                                                                                              | S                      |

Note on `bench:crdt`'s facade numbers (0.16 → 4.13 ms per keystroke from 100 to 5k blocks): that growth is
the first edit after a load paying the index build; steady state is ~0.04 ms at every size (P1 is the real
growth, on documents built by splits).

## Holes (correctness, security, product)

| #   | Hole                                                                                                                                                                                                                                                  | Severity                         | Evidence                                                                                                                                                                                                     | Fix direction                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | **Concurrent Enter at the same spot interleaves paragraphs.** Block order is a random-in-gap rank; Enter at a block's end, Duplicate, `+` and whole-block pastes take plain ranks (`placement/rank.ts:27-29,200-209`). Loro/Fugue avoid exactly this. | High (most common offline merge) | Two peers each Enter at the end of the same block and type 3 paragraphs: **34 / 40** client-id pairs interleave (`x a1 b1 a2 a3 b2 b3 q`).                                                                   | Reuse the data arrays' run rule (`crdt/data.ts:166-187`, YATA's left origin) in `insertBlocks`: inserting after a block this client ranked extends its run. Must pass `rank-growth.test.ts`. Within Yjs v14.                            |
| H2  | **The room does not validate content; per-writer marks are forgeable.** Client updates are relayed as they are; `del.<client>`/`wd.<client>` keys are plain keys (`edytor-doc.ts:1021`). No per-frame hook.                                           | High (security)                  | Any writer can store unknown kinds, huge data, a malformed tree, or write/delete another writer's undo marks. Notion validates every transaction before/after.                                               | Accept-then-compensate hook `validate({user, touched, before, after})` (the room writes the inverse as its own transaction, replicas still converge); check `del.<n>`/`wd.<n>` are written by client n.                                 |
| H3  | **No quotas.** No limit on document size, update rate or inbound frame size (only the user-id length check, `DocumentRoom.ts:286`).                                                                                                                   | Medium–high                      | One client can fill the DO's storage cap or keep it busy (worse with P2).                                                                                                                                    | Byte and rate knobs, a `quota` refusal.                                                                                                                                                                                                 |
| H4  | **Turn into erases properties.** `setBlock` with data replaces the whole root (`edytor-doc.ts:1893,2898`; `kinds.ts:35,199-209`).                                                                                                                     | Medium                           | A to-do `{checked: true, color: 'red'}` turned into a heading becomes `{level: 1}`. Notion keeps `checked`.                                                                                                  | A retype writes `type` plus the preset's leaves as `patchData` sets, never a root replace.                                                                                                                                              |
| H5  | **Rich-text marks fail two Peritext cases.** Plain v14 format items with tail clearing (`docs/crdt-v14-richtext-adr.md` §4).                                                                                                                          | Medium                           | Overlapping concurrent bolds ("The quick" ‖ "quick fox jumped") → " fox jumped" loses bold. A link set ‖ typing at its right edge expands the link by client id. Two comments under one key clip each other. | Quick win: comment keys `comment:<id>` (Loro's convention). Real fix: a fork patch pairing each end format item with its start (Loro/Peritext anchor pairing) + generation bump.                                                        |
| H6  | **A large offline backlog can get stuck.** Client→room messages cap at 32 MiB and clients don't chunk outbound (`limitations.mdx:59`; provider reads chunks only, `websocket.ts:266`); `safeImageSrc` accepts `data:image/`.                          | Medium                           | A few pasted data-URI images offline can make an undeliverable backlog.                                                                                                                                      | Split the reconnect diff by client/clock ranges under the cap (`messageChunk` exists inbound); cap or refuse inline data URIs.                                                                                                          |
| H7  | **Deleted content is retained forever.** Dead streams are never reclaimed (plan K14); `mergeUpdates` keeps deleted text in the room.                                                                                                                  | Medium (storage, GDPR)           | Deleting 1,000 of 1,001 blocks: 452 KB → 476 KB for 279 B of visible JSON; 2,000 deletes +64 KB.                                                                                                             | P2 fixes the room snapshot. Beyond: a room-defined stability horizon (all registered replicas acked past a point, or N days) to tombstone dead streams; replicas older than it rehydrate (Loro shallow snapshots / Eg-walker's lesson). |
| H8  | **Per-leaf data merges two different objects into one** (`crdt/data.ts`).                                                                                                                                                                             | Low–medium                       | A sets `{url:a, title:A}` ‖ B sets `{url:b, kind:video}` → `{url:b, title:A, kind:video}`.                                                                                                                   | Let a kind declare atomic paths written as one leaf (the legacy atomic leaf exists).                                                                                                                                                    |
| H9  | **Split/merge ordering residuals** (documented: merge into a block being split, D-18/D-19 undecided; `editor-delete-contract.md:670,685`).                                                                                                            | Medium–low                       | Documented rows.                                                                                                                                                                                             | Order split-born siblings by their boundaries' order in the backing text (~30 lines per the plan); anchor merge claims to the head stream's last item.                                                                                  |
| H10 | **Permissions stop at the document; blocks can't move between documents** without copy + delete (a concurrent typist loses text).                                                                                                                     | Medium (product)                 | `authorize` is read/write per socket. Notion inherits per-block permissions via parent pointers.                                                                                                             | Document "a page is a document"; a cross-room move that tombstones the source after the destination acks; per-block locks through H2's hook.                                                                                            |
| H11 | **No version history** (GC on everywhere, no snapshots).                                                                                                                                                                                              | Low–medium                       | Liveblocks/Notion headline feature.                                                                                                                                                                          | Store `onSave` snapshots (state vector + JSON) per version; "restore" as a forward edit.                                                                                                                                                |
| H12 | Offline coverage: no keep-fresh of unopened documents; a first offline visit seeds `value` (a different `value` duplicates blocks).                                                                                                                   | Low–medium                       | `limitations.mdx:32`.                                                                                                                                                                                        | `prefetch(room)` (sync once, close), per-room `lastUpdated` probe, option to stay read-only until first hydration.                                                                                                                      |
| H13 | Concurrent creation of one caller-chosen id drops the losing incarnation's text (plan §2.1).                                                                                                                                                          | Low                              | Documented.                                                                                                                                                                                                  | Show the loser's stream through an implicit merge claim.                                                                                                                                                                                |
| H14 | Thin observability: no metrics for doc size, record count, compaction/fold time, fan-out.                                                                                                                                                             | Low                              | —                                                                                                                                                                                                            | Export counters from `compact()` and the RPC surface.                                                                                                                                                                                   |

## What is NOT a hole (keep)

- **Tree moves**: LWW placement candidates with acyclic acceptance (`placement/model.ts:20-35,336-410`); X-under-Y ‖ Y-under-X converged in 12/12 runs, a 3-cycle drops exactly one move. Read-time promotion handles "ancestor deleted while a descendant moves" better than Loro's trash.
- **Splits copy no text** (Notion's "text slices" idea; Notion's critique of Yjs/ProseMirror splits doesn't apply).
- **Forward typing doesn't interleave** (YATA); backward typing within one replica was clean 24/24 (Fugue's anomaly needs multi-replica sessions; not worth an engine change).
- **Per-writer undo** (P11/P12) is stricter than Loro's local undo and beyond what Notion describes.
- Ideas that don't apply: replacing the engine with Eg-walker/Fugue, checkout/time-travel (needs GC off, ~50× bigger churn docs), Loro Protocol multiplexing, Loro Mirror (cells already do it), fractional-index jitter (ranks can't collide).

## Suggested order

1. **P1** `placeText` linear sweep (small, removes the quadratic typing cost), then the incremental rescan.
2. **P2** room snapshot of the live state (small–medium; 4–112× less storage, 25× faster wake; fixes H7 in the room).
3. **H4** Turn into keeps properties (small).
4. **P6** undo cap and **P9** presence throttle default (small).
5. **P5** v2 + compression for storage (small).
6. **H2 + H3** room validation hook and quotas (medium; security).
7. **H1** block run rule for concurrent Enter (small–medium).
8. **P4** delete-mark folding, **P3** incremental placement (medium).
9. **H5** mark anchor pairing (fork + generation bump), **P7** rank format, **H7** stability horizon (large).

## Sources

- https://loro.dev/blog (movable-tree, loro-richtext, crdt-richtext, v1.0, mergeable-containers, crdt-is-not-enough, loro-protocol, loro-mirror), https://loro.dev/docs/concepts/event_graph_walker, /shallow_snapshots, /docs/advanced/undo, https://arxiv.org/abs/2305.00583 (Fugue)
- https://www.notion.com/blog/how-notion-handles-concurrent-editing-with-crdts, /data-model-behind-notion, /how-we-made-notion-available-offline, https://www.notion.so/blog/faster-page-load-navigation
- https://jsonjoy.com/blog/list-crdt-benchmarks/, https://github.com/dmonad/crdt-benchmarks, https://github.com/josephg/editing-traces, https://josephg.com/blog/crdts-go-brrr
- https://liveblocks.io/docs/compare/liveblocks-vs-yjs, https://liveblocks.io/docs/guides/livetext-vs-yjs

## Phase 1 results (0.1.0-next.22)

Measured on the same machine as the study, model only (the facade, no view
subscribed) unless said otherwise. "Before" is `7a2ee66` (0.1.0-next.21);
the scratch script and the new `bench:crdt` lane (`baseline.steadyState`)
time one warmed document per size, median of 20 to 200 operations.

| Item  | Measure                                                        | Before                                                   | After                                                 |
| ----- | -------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| P1    | Keystroke, Enter-built document, 500 / 1k / 2k blocks          | 838 / 3,086 / 12,540 µs                                  | 36 / 15 / 12 µs (bench p50 39 / 15 / 13 µs)           |
| P1    | One paragraph split N times: per split, 1k / 5k                | 1.36 / 29.7 ms                                           | 0.16 / 0.69 ms                                        |
| P1    | Keystroke in a split-born block, 1k / 5k splits                | 3,068 / 82,442 µs                                        | 33 / 53 µs (same block typed again: 21 / 21 µs)       |
| P1    | `automerge-paper` trace (259,778 edits), no history            | 14,020 ops/s                                             | 75,216 ops/s (plain v14: 141K)                        |
| P1+P6 | The same trace with a history (`captureTimeout: 0`)            | 5,810 ops/s, 329 MB heap, 1.68 MB encoded, 259,778 steps | 38,647 ops/s, 100 MB heap, 1.63 MB encoded, 200 steps |
| P3    | Enter, 1k / 5k / 20k flat paragraphs                           | 1.01 / 6.19 / 35.8 ms                                    | 0.05 / 0.07 / 0.12 ms (bench p50 0.05 / 0.08 / 0.11)  |
| P3    | Move to the end, same sizes                                    | 0.32 / 1.73 / 8.40 ms                                    | 0.02 / 0.02 / 0.04 ms                                 |
| P3    | Block delete, same sizes                                       | 0.42 / 2.35 / 11.5 ms                                    | 0.03 / 0.03 / 0.04 ms                                 |
| P3    | Enter / move / delete at 20k with a change subscriber (a view) | 4.4 / 5.2 / 5.0 ms (after P3's model part)               | 1.0 / 1.2 / 1.2 ms                                    |
| H1    | Concurrent Enters at one block's end, 40 client-id pairs       | 34 interleave                                            | 0 interleave                                          |
| P6    | `rank-growth` reorder row (3,000 moves, history kept)          | 151,975 B                                                | 70,647 B                                              |

What changed:

- **P1.** Each backing text keeps a maintained row (`crdt/text/rows.ts`): its
  boundaries and the units between them in a Fenwick tree. An edit that writes
  or removes no boundary moves its gap by its units (the gap found by walking
  the item list to the nearest boundary, never the engine's position caches),
  and only the display owner of that stream recomputes; a boundary change
  rescans that text and re-places only the segments between the old and new
  cut lists' common prefix and suffix. `placeText` is one sweep. Reads fold
  every transaction whose body ran but whose observers have not (a write in an
  `update` listener), which the old full invalidation used to hide.
- **P3.** Owners, placements, both children indexes, the layout rules and the
  change report are maintained: a change re-decides only what it reaches, and
  any irregular state (a rejected cycle, a rehome) runs the global resolution
  whole. Every vitest lane checks each maintained fact against its rebuild
  after every fold (`indexChecks`).
- **P6.** `history.limit` (200); a dropped step's deleted items are released
  once every step that deleted part of them fell off, and collected.
- **H1.** `rankAfter`, one rule for data arrays and inserted blocks; a run costs
  one segment once. `rank-growth` stays inside its bounds: 300 Enters 256 chars
  (240 before), 1,000 Enters 576 (592), outline 112 (96), reorders 16.
- **H4, H8, P9.** Turn into sets the preset's leaves (`data.retype.keep`);
  `atomic` data paths (`data.atomic`); presence throttled to 50 ms.

Residuals:

- A split into a text many blocks share (an Enter-built or pasted document)
  still rescans that text: O(B) per split in its boundaries, about 0.7 ms at
  5,000 boundaries, linear, not quadratic.
- In a view, a root-level structural change reports the shifted index of every
  later sibling (`moved`, the `DocChange` contract), O(siblings): about 1 ms at
  20,000 blocks. `order` is rebuilt lazily, O(N), when a command reads it after
  a structural change.
- The first read of a freshly loaded document builds the index (the
  `keystroke` bench lane's facade p50, about 1 ms at 1,000 blocks).

## Phase 2 results (0.1.0-next.23)

Measured on the same machine as Phase 1. The trace rows replay
`automerge-paper` (259,778 edits) through an edytor client into a room-like
document (the room's own collection rules, `keepCopies` included),
compacting every 500 update records as `DocumentRoom` does, with both
compaction rules side by side (scratch script `room-trace.mjs`); "wake" is a
fresh document loaded from the stored snapshot, its facade created and read.

| Item | Measure                                                 | Before (merge of the records)      | After                                                                   |
| ---- | ------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| P2   | Stored snapshot                                         | 6,689,827 B                        | 1,601,845 B (v1 live state)                                             |
| P2   | Wake (load + first read)                                | 699 ms                             | 109 ms (18 ms without the P11 text-delete index, see residuals)         |
| P2   | Compaction, 520 runs: total / worst                     | 17.3 s / 86 ms                     | 2.0 s / 20 ms                                                           |
| P5   | Snapshot in v2 / gzip(v2)                               | 1,601,845 B (v1)                   | 1,339,888 B / 223,629 B (gzip: 14 ms)                                   |
| P5   | Compaction in v2: total / worst                         | —                                  | 1.5 s / 16 ms                                                           |
| P5   | One keystroke's update, v1 / v2; a one-character delete | 24 / 28 B; 13 / 24 B               | update rows stay v1                                                     |
| H6   | 40 MB offline backlog at reconnect                      | undeliverable (32 MiB message cap) | delivered as chunks, stored, served to a fresh client (workerd, ~1.4 s) |

What changed:

- **P2.** Compaction stores `encodeStateAsUpdateV2` of the live document
  with the engine's pending store set aside, never `mergeUpdates` of the
  records; a load applies the records in one transaction. The room's
  document applies the P11 `gcFilter` from its creation
  (`crdt.doc.keepCopies`): before, it collected a deleted restoration
  copy's text, so its Step2 served the copy deleted while the merged
  records still held it. `p2-live-compaction` proves stored == live
  (state vector, delete set, encoding, JSON) across a reload, with
  structs that wait at compaction and arrive later.
- **P5.** Snapshots are v2, gzip-compressed where `CompressionStream`
  exists (the room compresses in place after storing raw, and inflates
  at start); update and waiting records stay v1, which is smaller per
  edit. The generation record carries `storage: 'v2'`; a next.22
  container loads as it is and its next compaction rewrites it. The
  IndexedDB store writes the snapshot as an object row `{ v2 }`, which a
  next.22 tab refuses to read instead of misreading.
- **H3.** Quotas: 64 MiB document (records uncompressed plus waiting
  structs, net of what the frame deletes, after compacting), 50 sync
  messages a second per socket (ten-second burst), 64 MiB per frame
  (reassembled). Past one: close `4413` (`quota: …`), a refusal the
  provider reports and does not redial.
- **H2.** `validate({ user, replica, touched, dataChanged, before, after,
facade })` after each frame that changed blocks; a denial is undone by
  the room's own transaction, the history undo of that frame (P11/P12
  rules), sent to every socket. Per-writer marks `del.<n>`/`wd.<n>` are
  written and deleted only by `n` (forged ones stripped, `mark`).
- **H6.** The provider chunks frames over `maxFrameBytes`; the room
  reassembles them. Inline images over 1 MiB are refused by the image
  plugin (upload instead).
- **H14.** `metrics()` (RPC) and a JSON log of compactions, quota hits,
  denials and faults.
- **H12.** `prefetch`, `lastUpdated` (one authorized HTTP probe), and
  `requireHydration`.

Residuals:

- Wake time on the trace is dominated by the text-delete-mark index the
  P11 filter attaches (77,463 marks: about 88 ms of the 109 ms); P4
  (Phase 4) folds the marks.
- Workers advance their clock only across I/O, so the room's compaction
  and fold timings read `0` in production for synchronous work; sizes
  and counts are exact.
- A room of an earlier release refuses a client's chunk sequence
  (`refused: malformed`): deploy the room before the clients.
- A container compacted by next.23 is refused by next.22 (and a next.22
  tab fails to load a store a next.23 tab compacted): downgrade only with
  the data.

## Phase 3 results (0.1.0-next.24)

Measured on the same machine as Phases 1 and 2, in Node through the bound
engine (scratch script `phase3-measure.mjs`: a room-like document with
P11's `keepCopies`, the purge run as one transaction at a horizon covering
everything) and in workerd (`tests/do/h7-purge.test.ts`: the room itself,
its stored rows after compaction and compression). "Wake" is a fresh room
document loaded from the stored state, its facade created and read.

| Item | Measure                                                                                                                        | Before the purge      | After                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ----------------------------------------------------------------- |
| H7   | `automerge-paper` (259,778 edits, 77,463 text delete marks): stored state, v2 / gzip                                           | 1,339,888 / 223,624 B | 189,424 / 85,155 B                                                |
| H7   | The same: wake (load + first read)                                                                                             | 100 ms                | 9 ms                                                              |
| H7   | The same: the purge transaction; its update; a client applying it                                                              | —                     | 70–107 ms; 15,342 B; 48–55 ms (the client drops to 189,424 B too) |
| H7   | 1,001 blocks of their own text, 1,000 deleted (Node), v2 / gzip                                                                | 219,495 / 21,489 B    | 18,205 / 2,452 B (purge 19 ms)                                    |
| H7   | The same in the room (workerd, stored rows)                                                                                    | 28,880 B              | 5,260 B (visible content alone: 366 B)                            |
| H7   | 20,001 blocks, 20,000 deleted, v2 / gzip                                                                                       | 4,475,906 / 391,878 B | 369,217 / 48,587 B (purge 860 ms)                                 |
| H7   | 1,001 lines split from one paragraph (Enter), 1,000 deleted, v2 / gzip                                                         | 273,801 / 29,874 B    | 248,956 / 26,871 B (bare nodes stay)                              |
| H11  | One version (gzip v2) at 100 / 1,000 / 5,000 blocks                                                                            | —                     | 2,362 / 21,223 / 99,358 B, encoded in ≤ 12 ms                     |
| H11  | Restore of a day's edits (a tenth of the blocks deleted, moved, rewritten or given data), 100 / 1,000 / 5,000 blocks; its undo | —                     | 3 / 14 / 52 ms; 1 / 1 / 5 ms                                      |

What changed:

- **H11.** `history: { store, retentionDays, timeZone }` (a KV namespace,
  `KVLike`; `DocumentRoom.history()` reads the `EDYTOR_HISTORY` binding):
  two half-day slots per local date, a version written at the slot's end
  (the alarm at local noon or midnight, the first write past the boundary
  before it applies, or a wake past it), only when the room stored a
  change in the slot; key `history/<room>/<YYYY-MM-DD>-am|pm`, value the
  compressed v2 live state, metadata `{ bytes, blocks, editors, at }`
  (under 1 KiB), TTL the retention. A value over 25 MiB is skipped and
  logged, not split (a torn multi-part version would list unreadable).
  `listHistory`, `readHistory`, `restoreHistory` (a forward edit:
  `crdt.doc.restoreTo` keeps every id the registry holds and writes only
  what differs) and `undoRestore` (the restore's step stored, its deleted
  content kept from collection until undone), over RPC and through
  `routeDocumentHistory`. The demo room keeps its history in KV namespace
  `fecd8d9e405641b98ef763bb6056af08`.
- **Alarm.** One alarm, three tasks (save, history slot, purge tick), each
  due time stored in `meta`.
- **H7.** The purge tick records an epoch a day (the room's state vector);
  content deleted before the newest epoch at least `purgeAfterDays` old
  (default the retention, 30 days) is purged by one room transaction of
  real deletes, relayed like any edit: a dead block nothing depends on is
  removed whole, any other dead block emptied (text, data, claims), old
  text delete marks and dead restoration records deleted, runner-up
  placements dropped, then the horizon record every history reads to drop
  the steps below it. A replica offline past the horizon integrates
  normally (its structs under a collected parent become collected
  structs): no stale-replica close code.

Residuals:

- A deleted line split from a live paragraph (Enter-built documents: most
  lines) keeps its bare node (id, kind, rank, nonce, marks; about 220 B
  before compression, 27 B stored): its boundary still delimits its now
  empty stream, so a stale replica's typing into it stays hidden instead of
  joining the line before it. Removing it would need that trade-off.
- A removed block leaves its registry key (and its attribution record's
  key) as engine tombstones: a map never forgets a key (about 18–39 B per
  block before compression, 2–5 B stored).
- An undo of a restore writes back the delete marks the restore removed as
  the room's (`del.<writer>` copies under the room's client), so that
  writer's own later undo of their delete no longer revives the block.
- The new purge fuzz (`h7-purge-fuzz.test.ts`, rich lane) found two seeds
  of 2,000 (651 and 1271, 120 steps) where a client's incremental index
  publishes a children list that differs from its rebuild; they fail the
  same way with the purge disabled (a pre-existing index/report bug, left
  for its own fix). The default campaign (80 seeds, 60 steps) passes.

## Phase 4 results (0.1.0-next.25, schema generation 5)

Measured on the same machine as Phases 1 to 3. The trace rows replay
`automerge-paper` (259,778 edits) through one edytor client with no
history (scratch `trace-bench.mjs`) and through a client into a room-like
document compacting every 500 records (`room-trace.mjs`); "before" is
0.1.0-next.24 (`9ff2f94`, the index fix aside), "after" this release.

| Item | Measure                                                                               | Before                         | After                             |
| ---- | ------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------- |
| P4   | Text delete records on the trace                                                      | 77,463                         | 809                               |
| P4   | Encoded trace, v1 / v2                                                                | 1,601,845 / 1,339,888 B        | 544,171 / 273,894 B               |
| P4   | Load heap (v1)                                                                        | 13.8 MB                        | 5.4 MB                            |
| P4   | Apply, ops/s; average update                                                          | 73,412; 43.5 B                 | 65,787; 57 B                      |
| P4   | Room: stored (v2 / gzip); wake (load + first read)                                    | 1,339,884 / 223,621 B; 110 ms  | 273,895 / 115,230 B; 22–25 ms     |
| P4   | Room: compaction, 520 runs, total / worst                                             | 1.9 s / 29 ms                  | 0.55 s / 19 ms                    |
| P7   | Longest rank, 300 / 1,000 Enters, outline, reorders (27-bit client id)                | 256 / 576 / 112 / 16           | 129 / 342 / 60 / 23               |
| P7   | The same with a 53-bit client id                                                      | 256 / 576 / 112 / 16           | 165 / 446 / 72 / 17               |
| P7   | Document after 300 / 1,000 Enters, outline                                            | 133,150 / 604,280 / 112,451 B  | 116,088 / 484,154 / 104,100 B     |
| P5   | SyncStep2 of a 1,000-block document (v2 now)                                          | 280,557 B (gzip 55,016)        | 220,444 B (gzip 28,476)           |
| P5   | Updates (v1, unchanged): keystroke, one-character delete, block move, block delete    | 60, 13, 62, 43 B               | same (v2 would be 60, 24, 84, 65) |
| H9   | Split one paragraph 5,000 times: per split                                            | 0.81 ms                        | 1.15 ms                           |
| H9   | Former residual (unseen edit after one's split point), outcomes on 48 client-id pairs | text order wrong on every pair | serial order on every pair        |
| H5   | Peritext rows (`h5-marks.test.ts`) failing                                            | 7 of 17                        | 0                                 |

What changed:

- **Index (item 0).** The relay-room fuzz's seeds 651 and 1271 (rich lane,
  120 steps): a remote commit's cleanup starts the delete marks' follow-up
  transaction (P11) before the commit's report; the report read the child
  lists, then folded the follow-up at its first content read and moved
  them. The report folds every queued transaction first. The 2,000-seed
  campaign passes on both lanes.
- **H5.** Paired marks (fork patch P13): a mark write is a start (value,
  Lamport timestamp, id, side) and an end naming its start; the open
  operation with the greatest timestamp shows. Overlapping marks of one
  value union, a later write wins where it covers, no tail clearing. Each
  item's side orders it among one origin's items (left-side marks, content,
  right-side marks), so a mark record's `edge` decides concurrent inserts at
  its ends on every client-id pair (a link set while text is typed after it
  stays a link of its own). Comments are one mark per thread
  (`comment:<id>`, reading the `comment` record).
- **P4.** A text delete folds into the delete record its step wrote (the
  records list's tail: the same transaction, the history step still
  capturing, or anywhere without a history), up to 8 spans; the replacement
  is appended by item, and the index drops a record in constant time.
- **P7.** Variable-length digits (a length character and base-64 places),
  a client tie only on the last segment and where two bounds differ by
  ties alone; a run's members (H1) keep their ties.
- **H9.** Pieces of one text that stand where they were made show in the
  text's order between clients (D-18, `order.split.text`).
- **P5 wire.** A SyncStep2 is v2; updates stay v1, smaller for most
  single edits.
- **Generation 5.** Wire word `14005`; a generation-4 container, browser
  store or history version is read as JSON and seeded as generation 5's
  (a room at load, a local-only store at open); generation-4 frames are
  refused (`1008`, `refused: generation`).

Residuals:

- Ranks: the ties a run keeps on every level are most of a long rank, so a
  53-bit client id leaves Enter-heavy ranks 1.3–1.6× shorter, not 2–3×
  (with the tests' 27-bit id, 1.7–2×). Dropping a run prefix's tie halved
  them again but let a peer's rank of the same digit sort inside the run
  (DR-arrays-1), so it is not done.
- H9's second half, merge claims anchored to the head stream's last item
  (R4, "heworld" / "llo"), is not done: the claim graph would read text
  positions the incremental index does not track. R3 (a new block stays
  beside a block a peer moves out) remains.
- P4 makes a delete's update larger (57 B on average on the trace, from
  43.5): it carries its step's whole record, up to 8 spans.
- The cutover does not carry undo history, attribution or what a client of
  generation 4 never sent; a room-backed browser store starts from the room.
