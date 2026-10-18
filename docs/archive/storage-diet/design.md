# A smaller stored document — design

Status: plan written before the prototype (2026-10-18, branch
`storage-diet`). The prototype's measurements are recorded at the end of
this file. The method is the one of
[`engine-delete/design.md`](../engine-delete/design.md) (YP20) and
[`engine-move/design.md`](../engine-move/design.md) (YP22): measure, survey,
rank the cuts by measured gain against risk, prototype, keep what the
measurements confirm.

## Why

The move records (YP22) cut the block structure by about 32–40 B a block.
The rest of a stored document — its text, its deleted text, and what is
left of removed blocks — was not looked at. A stored document is the
engine's one update encoding (YP17: upstream's columnar v2), kept:

- by the room: snapshot rows gzip-compressed once stored, update rows raw
  until compaction; its quota (`maxDocumentBytes`, 2 MiB) and its memory
  guard count the raw bytes;
- by the browser store: the same, snapshots gzip-compressed;
- by a history version: `packed(liveState)`, gzip;
- on the wire: a SyncStep2 and every update raw.

So both the raw and the gzip size matter, and every number below gives
both.

## 1. What a stored document is made of (measured)

`node bench/stored-size.mjs` builds seeded, deterministic documents through
the document's own operations (the facade and the document's history, one
replica per session, a virtual clock for the capture window) and reads them
as the stores keep them. The breakdown is by ablation: the update written
again without one kind of struct (the marginal bytes, raw and gzip, and the
columns they sit in). Marginals do not sum to the total (the columns'
run-length codes interact); the residual is a few kilobytes.

Workloads (base: `master` at `8b0e11aa`):

| Workload | Blocks | Characters | Clients | Raw | Gzip | Raw / block | Gzip / block | Same JSON seeded fresh (raw / gzip) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `typed`: 1,000 paragraphs of about 300 characters typed at the end in runs of 8–40 (4 % bold, 2 % italic, 1 % links, 5 % typos erased in their step), Enter at each end; one session | 1,000 | 300,330 | 2 | 611,226 | 190,259 | 611.2 | 190.3 | 525,123 / 181,119 |
| `history`: `typed`, then ten sessions (three users) doing 200 Enters at random offsets (each followed by typing), 100 block moves, 100 deletes of 5–20 characters, 50 block deletes, 5 undos | 1,149 | 291,821 | 12 | 686,932 | 213,942 | 597.9 | 186.2 | 541,638 / 187,308 |
| `typed5k` | 5,000 | 1,497,352 | 2 | 3,058,186 | 926,660 | 611.6 | 185.3 | 2,624,738 / 882,000 |
| `history5k`: five times the history | 5,751 | 1,456,781 | 12 | 3,440,284 | 1,044,907 | 598.2 | 181.7 | 2,708,574 / 911,289 |
| `views`: `typed`, then 200 view-only page loads | 1,000 | 300,330 | 202 | 621,330 | 194,577 | 621.3 | 194.6 | — |
| `churn`: `typed`, then four sessions each writing about 500 paragraphs and deleting half the document (block deletes, cross-block range deletes, word deletes) | 535 | 129,455 | 6 | 2,012,668 | 576,237 | 3,762 | 1,077 | 246,209 / 83,805 |
| `churn` after the room's purge at a horizon of now | 535 | 129,455 | 8 | 1,287,543 | 320,083 | 2,407 | 598 | 246,211 / 83,814 |

Timings and heap on the base (one machine, informative; `bench:crdt` is the
gate): `history` encodes in 3.1 ms and loads in 17.6 ms, 13.6 MB of heap
after a load (20.8 heap bytes per stored raw byte); `history5k` 18.5 ms,
100.7 ms, 64.8 MB.

What one operation sends (the transaction's update, median of 20, in a
session over `typed`): a keystroke 42 B, an Enter 294 B, bold on a word
92 B, a word delete 41 B, an undo 25 B, a block move 48 B, a block delete
60 B. A view-only page load adds 50.5 B to the stored document (its actor
binding `c/<client>` and its client section), forever.

### The `history` document by kind

| Kind | Structs | Raw B | Raw % | B / block | Gzip B | Gzip % |
| --- | --- | --- | --- | --- | --- | --- |
| text (live) | 3,832 | 324,449 | 47.2 | 282.4 | 122,782 | 57.4 |
| paired mark items | 2,006 | 66,393 | 9.7 | 57.8 | 21,199 | 9.9 |
| home slots `{ b }` (`{ b, s }` when a split made the block) | 1,200 | 52,328 | 7.6 | 45.5 | 13,190 | 6.2 |
| attribution record entries (`blockattr` `b/<id>`) | 1,200 | 43,197 | 6.3 | 37.6 | 5,840 | 2.7 |
| registry entries (`blocks` `<id>`) | 1,200 | 38,371 | 5.6 | 33.4 | 5,437 | 2.5 |
| boundaries `{ s, n }` | 1,198 | 37,779 | 5.5 | 32.9 | 8,075 | 3.8 |
| block `id` attr | 1,200 | 21,601 | 3.1 | 18.8 | 2,086 | 1.0 |
| block `type` | 1,200 | 20,401 | 3.0 | 17.8 | 638 | 0.3 |
| attribution `k/<actor>` | 1,202 | 13,236 | 1.9 | 11.5 | 1,006 | 0.5 |
| attribution `i` (incarnation stamp) | 1,200 | 12,679 | 1.8 | 11.0 | 2,555 | 1.2 |
| block `n` (nonce) | 1,200 | 12,674 | 1.8 | 11.0 | 1,501 | 0.7 |
| block `l` (lastChangedBy) | 1,200 | 11,908 | 1.7 | 10.4 | 724 | 0.3 |
| attribution `c` (createdBy) | 1,199 | 11,880 | 1.7 | 10.3 | 294 | 0.1 |
| removed text (tombstones) | 650 | 4,627 | 0.7 | 4.0 | 1,566 | 0.7 |
| hold records | 82 | 2,269 | 0.3 | 2.0 | 1,137 | 0.5 |
| move records | 99 | 2,157 | 0.3 | 1.9 | 1,715 | 0.8 |
| held text | 111 | 1,543 | 0.2 | 1.3 | 646 | 0.3 |
| `del.` marks | 50 | 1,453 | 0.2 | 1.3 | 558 | 0.3 |
| actor dictionary `c/` | 11 | 454 | 0.1 | 0.4 | 112 | 0.1 |
| the rest (meta, removed attrs, the delete set: 1,939 B) | | ~7,500 | 1.1 | | | |

By column: strings 423,222 B (text, and every map key and root name as a
full string), rest 185,717 (content values through lib0 `writeAny`, the
struct-section headers, the delete set), info 25,556, left clocks 25,079,
client 11,800, parentInfo 9,621, right clocks 4,003, lengths 1,924.

Findings:

1. **Text is half the raw bytes and 57 % of the gzip bytes**, almost all of
   it the characters themselves: 305,897 characters cost 311,735 B in the
   string column. A typed run is one item (runs merge), so item headers are
   ~3 B a run. Nothing to gain on live text short of compression, which the
   stores already apply.
2. **Per-block structure is about 230 B a block (38 % raw, 21 % gzip).** It
   is mostly strings written again and again: every map entry writes its key
   as a full string (`"blocks"`, `"blockattr"`, `"id"`, `"type"`, `"n"`,
   `"l"`, `"i"`, `"c"`, `"k/alice"`), because the v2 encoder's key cache is
   disabled upstream and map keys do not go through it anyway; a block's id
   (12 characters, `b_` and ten) is written five times (its registry key,
   its `id` attr, its home slot `{ b }`, its record key `b/<id>`, and the
   boundary `{ s }` of the split that made it); `"paragraph"` and the
   actor's id are written once per block each. The id attr is never read
   for a block (only an atom's is).
3. **Marks cost 33 B an item, 66 B a pair**: a start's value
   `[v, l, c, k, side]` and an end's `[c, k, side]` go through `writeAny`,
   so the operation id's 53-bit client is a 9-byte float64 in each, and the
   start's id is (almost always) the item's own id, written again.
4. **The client column grows with sessions**: a 53-bit client id is an
   8-byte varint, written again each time the referenced client changes
   (origins pointing at another session's text). 11.8 KB in `history`
   (1.7 %), 202 KB in `churn` (10 %), 159 KB after its purge (12 %).
5. **Every page load writes 50 B**: the actor binding is published at
   attach, before the replica writes anything; a document opened 10,000
   times carries 500 KB of bindings of replicas that wrote nothing.
6. **Before the purge, a long-lived document is mostly dead text**: in
   `churn`, the text of deleted blocks (a block delete is a mark: its text
   stays live, for an undo) is ~670 KB of the 814 KB of live text items, and
   held text 119 KB: 39 % of the raw bytes. This is the product rule (undo
   gives deleted text back; the purge horizon, 30 days by default); the
   bytes go at the purge.
7. **After the purge, what is left of removed blocks dominates**: the purge
   removes a deleted block whole only when its whole text family is dead.
   A document typed with Enter is one backing text (every split-born block
   streams in the first block's text), so almost no block is ever removed:
   2,313 dead blocks keep their registry entry, attrs, home slot, boundary
   and attribution record, about 230 B each (527 KB, 41 %). Their marks stay
   live too (the purge deletes their text, not the marks around it): 197 KB
   (15 %). Removed text keeps its tombstone headers: 93 KB (7 %), mostly
   the client column.

**A purge bug found on the way** (fixed first, its own commit, with a
regression row in `purge-before-horizon.test.ts`): the purge deletes the old
hold records in a walk over its writer's structs, and deleting one releases
its holds, which can split items of that same writer (its own text) while
the walk reads the array; the walk then visited the structs written just
before the record as if they were it, and deleted them. In `churn` it
deleted 52 `del.` marks: 52 deleted blocks came back, empty, after the
purge. The records are now read first and deleted after.

## 2. How others encode and collect (survey)

From primary sources (code and specs; clones of y-crdt `ac33960`, loro
`70d6cae`, automerge `f4b14f0` and its binary format spec, diamond-types
`89ae3a0`, json-joy `afa06a5`, crdt-benchmarks `796f702`; the Eg-walker
paper, arXiv 2409.14252):

| System | Actor / client per op | Repeated keys and strings | A deleted character at rest | A deleted map entry / container | Compression |
| --- | --- | --- | --- | --- | --- |
| Yjs v14 upstream | the full 53-bit id in one `UintOptRle` column (struct clients, origin and right-origin clients), raw in the delete set and the state vector (`// @todo use a special client decoder that is based on mapping`, `utils/encoding.js`) | `writeKey`'s cache is commented out (`keyMap.set`, with a `@todo`: old decoders read format keys with `readString`); map keys and root names use `writeString` in the writer and both readers; the decoder already supports the cache (`readKey`) | `ContentDeleted(len)` keeps the header (origin, right origin, parent, key); a header-less GC struct only when the parent was collected | the head item of a key keeps the key string; a deleted container keeps its header, its children become GC | none |
| yrs | identical to Yjs v2 (`write_left_id` writes the u64 client); `write_key`'s table is never updated ("matches Yjs") | as Yjs | as Yjs (`Item::gc`, `squash_left`) | as Yjs | none |
| Loro | ops in per-peer change blocks: ids implicit (`counter_start` + lengths); a peer table per block (u64 each, first use order); every peer reference an index (`docs/encoding.md`) | a `keys` arena per block (map keys, root names, mark keys), referenced by index | positional ops; the snapshot's text state holds only live text plus id spans; a shallow snapshot drops history below its frontier ("typically 70–90 % smaller") | tombstoned keys kept (`keys_with_none_value`, peer index and Lamport); containers deleted before a shallow root dropped | LZ4 per 4 KiB SSTable block |
| Automerge 2 | an actor array (sorted in a document chunk); every actor field an RLE column of indices | a key-string column, RLE; ops sorted by object then key, so repeats collapse within an object; no table across objects | one op per character, kept forever with its successor (a document holds its whole history) | the put row stays, with a successor | DEFLATE per column of 256 B or more |
| Diamond Types / Eg-walker | an `AgentNames` chunk, each name once; agent runs as (index, length, seq delta) | n/a (lists and text) | positional ops, run-length coded; at rest no CRDT metadata at all ("we never write the CRDT state to disk"); deleted content optional | n/a | LZ4 on content chunks |
| json-joy | a clock table (session, time); an id as (table index, time diff), one byte when both are small | keys as full strings per object | a tombstone chunk is id + span, no origins (the RGA chunk order is the state); contiguous tombstones merge | a delete writes `undefined` over the key | none (zlib and LZ4 benchmarked outside) |

Sizes on the automerge-paper trace (Loro's table, `docsize.md`): Yjs v2 with
GC 159,921 B (71,033 compressed), Automerge 292,742 (129,062), Loro snapshot
273,561 (132,459), shallow snapshot 63,352, Diamond Types 281,042 (106,242
with GC and compression).

What fits a YATA item store without changing its merge rules — the decoded
items, ids and contents identical, only their bytes change:

- **a client table per update** (Loro's peer table, Automerge's actor
  array, Diamond Types' agent names, json-joy's clock table): each client
  once, then an index, in the client column and the delete set;
- **one string table per update** for map keys, root names, node names and
  string values (Loro's `keys` arena; the v14 `IdMap`'s attribute tables):
  upstream's own decoder already reads a cached key;
- **typed content for marks** (Loro keeps peer and key indices inside
  values): the operation id as an id (a client index and a clock) instead of
  a float64 and a varint inside a JSON array;
- default-reference flags ("parent = the previous event", Diamond Types;
  `dep_on_self`, Loro): an origin equal to the item's own previous id
  written as one flag — a smaller gain here, since a typed run is one item.

What does not fit without a horizon rule on peers: dropping tombstone
headers or a deleted map key's head below a horizon. A remote item whose
origin resolves to a collected struct is turned into a collected struct
itself (`utils/encoding.js` `getMissing` → `Item#integrate`): data loss, not
an error; later entries of a map key take their key from its head; and no
proof shows that unlinking tombstones from a live sequence keeps the order
of later concurrent inserts. Loro and Eg-walker both state that a peer
concurrent with the horizon can never merge. That is a behaviour change for
the room's stale replicas (`room.purge.stale`), so it is listed for a
decision (§5), not planned.

## 3. The candidate cuts

Estimated by a what-if encoder over the same stores (the base's own
encoder re-implemented with each change; its baseline output is
byte-identical to `encodeStateAsUpdate` on every workload), so the numbers
are of the bytes the change writes, not of a decoder. "Alone" is the cut on
the base; "marginal" is what removing it from the full set costs, the share
it keeps once every other cut is in.

| # | Cut | Removes | Target (history) | Saving alone, history raw / gzip | Marginal in the full set, history raw / gzip | `churn` after purge, alone raw / gzip | Change | Risks | Bundle |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E1 | **String table** (engine): every map key, root name and node name through `writeKey` with its cache on, and every string and object key inside a content value (`writeAny`) through the same table | keys and repeated strings (a block id once per update instead of five times) | 38 % structure | −17.0 % / −3.1 % | −21.6 % / −7.4 % (with S2, E6) | −24.7 % / −5.0 % | `UpdateEncoder`/`UpdateDecoder` (`writeKey` cache, a content-value codec over lib0's), `Item#write` and both struct readers read keys with `readKey`; a new update encoding: schema generation 10 | none to convergence (same items decoded); every path that re-encodes (`mergeUpdates`, `diffUpdate`, the room's stripped frames) goes through the encoder's own methods; loses wire interop with upstream Yjs (already lost for holds and moves) | ~+0.4 KB (the value codec; lib0's `writeAny`/`readAny` stay for primitives) |
| E3 | **Native paired marks** (engine): a mark item writes its key, flags (side, own id, value `true`), its Lamport stamp as a length and its operation id as an id only when it is not the item's own; an end its start as a clock delta | float64 clients and repeated ids in mark values | 9.7 % marks | −4.7 % / −3.9 % | −4.7 % / −3.5 % | −6.7 % / −6.9 % | `ContentFormat#write`, `readContentFormat` (given the item's id) | a redo's copy keeps the original id (written in full); plain format items (inert, YP19) keep the JSON form | ~+0.3 KB |
| S2 | **The attribution record's key is the block id** (edytor): `blockattr` holds only records, so the `b/` prefix goes and the string table writes the id once | an id copy per block | 6.3 % record entries | (needs E1) −2.6 % / −2.6 % | −2.6 % / −3.9 % | −4.8 % / −3.4 % | `attribution/block.ts`, `purge.ts`, `schema.ts` | none (one root, one owner) | ≈ 0 |
| E6 | Native slots, boundaries and claims (engine): `{ b, s }`, `{ s, n }`, `{ m }` as typed contents, the split key an id | object overhead, the split key's float64 client | 13 % slots and boundaries | (with E1) −4.2 % / −0.1 % | −4.1 % / −2.2 % | −6.1 % / +1.0 % | a content ref per kind, the fork's sort rules (`splitKey`, `markClass`, `extendsRun`) and every edytor reader of `content.arr[0]` | the widest blast radius of the encoding cuts: the sort rules read these contents | ~+0.5 KB |
| E2 | **Client table** (engine): each client id once per update (a new column), then its index in the client column and the delete set | 8-byte client ids | 1.7 % client column (12 % after a purge) | −1.4 % / −0.3 % | −1.3 % / −0.2 % | −10.4 % / −0.6 % | `UpdateEncoder#writeClient`/`writeLeftID`/`writeRightID`, `UpdateDecoder#readClient`/…, `writeIdSet`/`readIdSet` | none to convergence; small updates pay one table entry (8 B) per client, as before | ~+0.2 KB |
| S1 | **No block `id` attr** (edytor): the registry key is the block's id; nothing reads the attr | 18.8 B a block | 3.1 % | −3.1 % / −1.0 % | −1.2 % / −2.0 % | −4.2 % / −1.9 % | `placement/model.ts` `createBlock` | a test or a tool that reads it | ≈ −0.05 KB |
| E5 | **The parent kind in the info byte** (engine): content refs fit four bits; bit 5 says the parent is a root, and the `parentInfo` column goes | the run-length code of an alternating flag (8 B a block) | 1.4 % | −1.4 % / −0.1 % | −1.4 % / −0.1 % | −1.9 % / −0.2 % | `Item#write`, both struct readers | none | ≈ 0 |
| E4 | Non-negative integers as varints in content values (nonces, clocks above 2³¹ as float64 today) | 4 B on half the nonces | | −0.9 % / −0.8 % | −0.5 % / −0.1 % | −1.2 % / −1.2 % | the value codec | none | ≈ 0 |
| T1 | **A deleted block that streams in another block's text is removed alone at the purge** (edytor): its boundary stays and keeps delimiting its emptied stream; only a block that owns a backing text waits for its whole family | ~154 B a dead block after the purge (its node, attrs, home slot, record) | 41 % of `churn` after purge | — | — | −27.6 % / −13.0 % | the purge's family rule, the index's delimiter rule (a boundary naming a removed key delimits a stream nobody shows) | the stream index; a stale replica's edit inside the removed block (lands in a stream nobody shows, as today's emptied one) | ~+0.2 KB |
| T2 | **Marks inside purged streams are deleted at the purge, and a collected mark keeps only its class** (engine + edytor) | 197 KB of marks around purged text | 15 % of `churn` after purge | — | — | −9.0 % / −9.6 % (upper bound: marks over no live unit) | `Item#gc` trims a class-0/2/3 item's content to its class (a new content ref, YP21's rule kept); the purge deletes the mark pairs of the streams it empties | the class must answer `markClass` exactly as before; marks over deleted text in a live stream are kept (a stale replica's late insert there keeps its formatting) | ~+0.3 KB |
| C1 | **The actor binding is published with the replica's first write**, not at attach (edytor) | 50.5 B per view-only page load | the `views` growth | — | — | — | `attribution/attribution.ts` (`attach`), in the first local transaction that writes | the room's binding rules (`room.attribution.trust`, `rebind`, orphans) read `c/` entries; a reader of `actorOf` for a client with no write | ≈ 0 |
| — | Info as `UintOptRle` | | | −0.2 % / 0 % | | | | | |

Full set (E1–E6, S1, S2): `history` 686,932 → ~459,000 B raw (−33 %),
213,942 → ~185,400 gzip (−13 %); `churn` −38 % / −13.5 %; `churn` after the
purge −57 % / −20 %, and with T1 and T2 on top of it more (they were
estimated on the base's encoding: −37 % / −22 % together there).

Not candidates:

- **Live text**: the characters are irreducible short of compressing the
  string column, which the stores already do (gzip, the one
  `CompressionStream` format of every supported engine).
- **`l`, `c`, `k/`**: per-writer attribution (`lastChangedBy` restores on
  undo, contributors are a union set): behaviour. Their keys and values
  shrink with E1.
- **The nonce `n` and its stamp `i`**: incarnations (`id.same.concurrent`)
  read them; deriving them from item ids would rework incarnations for
  ~1.5 % gzip. With E1/E4 they shrink anyway.
- **Origin flags** (Diamond Types' "parent = previous event"): a typed run
  is one item here, so few origins are their own previous id; below 1 %.

## 4. The plan

One generation for everything this branch changes in the format: schema
generation 10 (wire word `14010`, browser database `edytor-v14-g10:`); a
room, a browser store or a history version of generation 9 is refused,
never converted.

Order (gain against risk; each one commit, measured on every workload,
the fast lanes green after it; reverted if its measured gain on `history`
is under 1 % raw and gzip, or if it needs a test weakened):

1. E1 string table (YP24) — with the schema generation;
2. E3 native marks (YP25);
3. S2 record key = id;
4. E2 client table (YP26);
5. S1 no block `id` attr;
6. E5 the parent kind in the info byte (YP27);
7. T1 dead streams removed alone at the purge;
8. T2 marks of purged streams, collected marks trimmed to their class (YP28);
9. C1 the actor binding with the first write;
10. E6 native slots, boundaries and claims — last, only if the lanes and
    the time allow: its marginal gzip gain (−2.2 %) is the smallest of the
    encoding cuts against the widest change.

E4 (under 1 % on `history`) and the info column are not built.

The oracles of the engine's differential rows compare encodings: against
upstream's pristine engine (the baseline legs of `search-marker-format`
and `yp16-writes`, `bench/lib/interop.mjs`). With a new encoding those
compare the decoded stores instead (struct by struct: id, origins, parent,
key, content, deletion), never a copy of the old encoder; the upstream
interop check (`upstream.yml`) keeps diffing the source and runs the
upstream suite, and stops claiming wire interop.

## 5. Behaviour changes not to make (for the user's decision)

Each is measured in the prototype section; none is built.

- **Purge sooner.** `churn` stores 2.01 MB until its deletes pass
  `purgeAfterDays` (30 by default) and 1.29 MB after (−36 % raw, −44 %
  gzip on the base encoding): dead text is 39 % of it. A shorter default
  horizon shortens how long an undo (a stale replica's, or a version
  restore's revive) can bring content back.
- **Release a session's deletes when its history ends.** A writer's held
  text and the text of the blocks it deleted can come back only through its
  own history (per-writer records and marks) until the purge. When a page
  closes, nothing releases them. Releasing at `pagehide` would make them
  purge-ready at once; it is a write at unload, which is not reliable, and a
  tab that only lost its network keeps its history.
- **Drop tombstone headers and removed keys below the horizon** (Loro's
  shallow snapshot): removed text in live streams (93 KB in `churn` after
  its purge, 7 %) and a removed block's registry and record keys (~40 B each,
  less with E1 and S2). A stale replica's insert next to a dropped tombstone
  would be dropped instead of shown (`room.purge.stale` keeps it today), and
  a recycled block id (a seed, a caller id) written after the purge would
  diverge between replicas that dropped the key and those that had not.
- **Marks over deleted text in live streams** (T2's part outside purged
  streams): deleting them would change the formatting of a stale replica's
  late insert there.
- **The room's quota**: E1–E3 shrink the bytes of the same structs, so the
  default `maxDocumentBytes` (2 MiB, sized at 46 heap bytes a stored byte by
  `bench/room-memory.mjs`) admits more structs than before. Keeping the same
  memory bound would mean a lower default (re-measured in the prototype); not
  changing it admits every document admitted today, and larger ones.

## 6. Risks

1. **Every reader of the encoding.** The engine's two struct readers
   (`updates.js` lazy reader, `BlockSet.js`), the room's stripped-frame
   writer (`cloudflare/room/updates.ts`), the store-before-ack body
   (`protocols/sync.ts` `writeSaved`), the bench's breakdown. The ones that
   write through the encoder's methods follow the change; any that parses
   bytes by hand must change with it. The engine's upstream suite and the
   random corpus (every adapter) are the check.
2. **Determinism.** The tables are built in write order, so an update's
   bytes stay a function of the store (the differential rows compare
   stores byte for byte on one engine).
3. **Small updates.** A keystroke writes no key; an attribute write pays one
   table entry, as its string before. Measured per operation.
4. **The purge's stream rules (T1).** A boundary naming a removed key must
   delimit on every replica, before and after the purge reaches it; the
   index's self-checks and the purge fuzz are the check.
5. **Interop with upstream Yjs** ends for every document, where it already
   ended for documents holding hold or move records.

## Prototype: measured

(After the prototype.)
