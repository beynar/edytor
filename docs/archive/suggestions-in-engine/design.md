# Shared suggestions, smaller — design

Status: built (branch `suggestions-in-engine`, 2026-10-19 and 20), not
merged: the +6 KB target is missed (§4, §5); the behaviour changes that
would go further are measured in §6 for the user. PR #32 (`9f592dde`)
shipped shared suggestions for +17.1 KB min / +5.95 KB gzip on the bare
`<Edytor />`; a smaller bundle is a requirement of all work since the last
release, so the cost is a no-go. This file measures where the bytes are,
asks of each fact whether the engine (the vendored Yjs fork) holds it or
could, records the behaviour changes the user accepted after that report,
and lists the cuts, one commit each, with what each measured. The model
before this work is
[`../shared-suggestions/design.md`](../shared-suggestions/design.md).

## 1. Where the 17 KB goes (measured)

`node scripts/bundle-size.mjs --only minimal,all,export`, `569823b5` (the
commit before #32) against `9f592dde`, then each emitted byte attributed to
its source declaration through the source maps (the scratch method of the
earlier diets: the probe's `out/assets/*.map`, `acorn` over the packaged
`dist/` file, bytes summed per top-level declaration and member).

The minimal app grew +18,392 B min / +6,351 B gzip. The image caption and
void-block press fixes that rode in #32 account for 1,325 B
(`nativeInteractiveControl` 509, `pointer` 449, `selection.utils` 309,
`onFocus` 58): shared suggestions are **+17,067 B**.

### `crdt/doc/suggest.js`: 9,830 B

| Function | B | What it maintains or computes | The engine |
| --- | ---: | --- | --- |
| `records` | 1,080 | Every record node read again: its writer, the writer clocks it owns, its settled and proposed id sets, its operations, `by`/`via`/`lbl`/`at` | holds the items and the id lists; the per-record sets are edytor's reading of them |
| `compute` | 935 | A block's pending runs (insert, delete), its block or split change, its operations | knows each unit's client and the id lists naming it, not display offsets |
| `candidates` | 628 | The blocks holding a record's writer's structs or a proposal's units | holds the structs (this walks them) |
| `unitsOf` | 349 | A block's shown units with their ids | the range cursor (this is a loop over it) |
| `pending` | 283 | The per-block map, read again at every version | — |
| `opChange` | 280 | An operation proposal as a change (a format's anchors resolved) | — |
| `sourceOf` | 242 | The block a split-born block came from | the stream table (edytor's index) |
| `pendingIn` | 110 | The record whose clocks hold a unit, unless settled | — |
| `apply` | 1,674 | A plan written as a suggestion: insertions as they are, deletions proposed (the author's own pending units held), operations proposed, a move refused; later steps' offsets moved past the proposed text, which is still shown | a delete into a records list already holds; a delete that proposes and lets the plan read on is not there |
| `decide` | 737 | A decision's parts: settled id lists, then operations | — |
| `deleteRun` | 230 | The `deleteText` calls of the units a decision takes away | a hold record names the same units |
| `withdraw` | 260 | The author takes a suggestion back | — |
| `run`, `settle` | 166 | A decision written | — |
| `base`, `without` | 1,067 | The document without its pending suggestions | — |
| `open`, `writer`, `recOf`, `ownBlock`, `entry`, `as`, `actorOf` | 884 | A record opened, its writer minted, lookups | — |
| constants, `push`, `listOf`, the returned object | 528 | — | — |

### `session/suggestions.svelte.js`: +4,860 B

| Member | B | What |
| --- | ---: | --- |
| `write`, `grown`, `#slot`, `same` | 1,691 | A shared AI answer written live, only what changed per chunk |
| `#decide`, `decide`, `acceptAll`, `rejectAll`, `withdraw` | 808 | A decision as one command of a view that decides |
| `written` | 522 | Suggesting mode's routing: grouping, the move refusal |
| `list`, `changes` | 401 | The one list, shared suggestions included |
| `marked`, `MARKS`, `colorOf` | 453 | A block's mark, a run's colour |
| `Suggestion` getters, `accept`/`reject`/`discard` | ~600 | `by`, `via`, `changes`, `canDecide`, `mine` |
| `suggesting`, `decides` | 259 | The mode, who may decide |

### The rest: +2,520 B

`edytor.svelte` 625 (the overlay's inserted and deleted runs 211, their two
mounts 215, the record and access listeners 160), `Ranges.svelte` 317 (a
run's colour), `plan.js` 636 (the dispatcher's step arguments moved there,
−552 in `commands.js`, `argsOf` +84), `history` 241 (a step replayed under
its writer), `edytor-doc` 186, `document.access` 180, `moves` 175 (the
refusal), `attribution` 161 (a writer's binding), `text/model` 88
(`writersOf`), the provider and the access message 145, `Block` 76 (the
mark), `labels` 49, `Item.js` 44 (YP31), `funnel` 23.

## 2. What the engine could hold

- **Upstream Yjs v14's suggestion machinery** (`DiffRenderer`,
  `AttributionsRenderer`, `createAttributionManagerFromDiff`; `Renderer.js`
  in `@y/y@14.0.0-rc.26`, 702 lines) diffs a base document against a
  suggestion document and renders a delta whose pieces carry attributes
  from an `IdMap`. The fork removed it with the id-map algebra and the delta
  layer (YP8, YP16), and its model is a second document, which the study
  rejected (memory, partial accept). It computes per item what edytor
  computes per unit: bringing it back adds several KB and removes nothing.
- **A per-transaction log of suggestion items** (like YP20's
  `transaction.holds`, YP22's `transaction.moves`) would replace
  `candidates`' struct walk only; edytor would then keep a per-block map
  updated from the log, more code than the walk it replaces.
- **Decisions as one engine call over an id set** (cut 1): the text a
  decision keeps is an id list in its record, the text it takes away the
  decider's hold, both `YNode#hold(ids)`; `deleteRun` goes.
- **A delete that proposes** (cut 8, fork patch YP32): `YNode#delete`
  with a suggestion's `propose` context proposes the units (an id list in
  its record), holds its author's own and hides what it proposed until the
  plan ends, so the plan's later steps read the offsets they were prepared
  with; `apply`'s offset remapping, batching and caret walk go.
- **Pending runs in the run index** (change 3, measured in cut 6 and
  reverted): an id list in a nested node marking what it names changed (a
  zero-length entry in `transaction.holds`), the index reading each unit's
  state as it builds the runs, a mark the view draws. It costs +483 B: the
  changes still need their units' ids for a decision, so the per-block walk
  stays, and the overlay it replaces reuses a layer other features ship.
- **Proposed operations as id lists**: only deletions name units. A merge,
  a retype, a data change or a format written for real (and held on
  reject) would show applied before it is accepted. Operations are dropped
  instead (change 1).

### The fact map (the method's step 3, after the accepted changes)

| Fact | Computed by | Consumed by | Restated where, before the rewrites |
| --- | --- | --- | --- |
| The record whose clocks hold a unit | `records`, `pendingIn` | the pending changes, a suggesting delete's sort, the own-block test | an end clock kept per record beside the start that implies it |
| A change's units | `compute` | a decision | ranges, flattened at each decision, converted to display runs again (`deleteRun`) |
| Whether a plan can be suggested | the document's `apply` | the view's `written` | asked by the view, then again by `apply` |
| A block's node id | the registry | the pending changes, the own-block test, a block deletion's proposal | three lookups |
| Writing as another client | — | the own text, a suggestion's writer, the history's replay, a writer's binding | four try/finally copies |
| A position's slot | the view-local accept's flow target | a shared answer's first write | a second computation of the same slot |
| The suggestion runs drawn | the overlay's range layer | — | three mounts of the layer |
| Whether the view's open suggestion exists | the records | the view's grouping | asked by the view, needed by `apply` |

## 3. The behaviour changes the user accepted (2026-10-19)

After the report above, the user accepted these, each its own commit:

1. **Only text and blocks.** Suggesting mode proposes text insertions and
   deletions, and block insertions and deletions. A retype, a data change,
   a format or a merge is refused and announced, as a move is (on the
   author's own pending blocks it is written directly, as before). The
   proposed-operations path and its replay on accept go; a block deletion
   is an id list naming the block's node, accepted as the decider's block
   delete.
2. **AI answers rewritten whole.** A shared answer is still written live,
   but each chunk replaces what the answer wrote before: no per-chunk diff.
   Built (cut 4), then reverted at the user's decision (cut 12): the cost
   grew with the square of the answer's length (a 257-character answer in
   60 chunks synced 35 KB and stored 8.7 KB, against 3.5 KB and 2.1 KB with
   the diff).
3. **Pending runs drawn inline.** The run index carries each run's
   suggestion state, the text renders it as a styled run (a mark the view
   draws), and the overlay's suggestion layers go.
4. **`toJSON()` by rejecting everything on a copy.** The document without
   its pending suggestions is the document as shown, on a copy, with every
   pending suggestion rejected: a whole-document cost while any suggestion
   is pending.
5. **Withdraw is reject.** An author removing their own suggestion runs the
   reviewer's reject; `discard()` on a shared suggestion is `reject()`.

Kept: a split stays a split (not proposed as blocks), blocks keep their
marks.

## 4. The cuts

One commit each, measured with `node scripts/bundle-size.mjs --only
minimal,all,export` (bytes of edytor's own code, minified; gzip of the
whole app), kept only when the minimal app's net is below 0. From the
bundle trim method's adoption (`docs/agents/bundle-trim.md`, mid-pass) each
cut also names the pattern it removes; `scripts/bundle-attribution.mjs`
gives the per-declaration numbers. `edytor/export` stays at 52,220 B
(29,579 B gzip) throughout: it ships no suggestion code.

| # | Cut | Pattern | minimal own | minimal gzip | all own | Kept |
| --- | --- | --- | ---: | ---: | ---: | --- |
| — | `9f592dde` against `569823b5` (the press fixes included: +1,325) | — | +18,392 | +6,351 | +18,783 | — |
| 1 | A decision is one engine call over its ids: `YNode#hold` into the record (a settle) or into `textdel` (the decider's hold, in the funnel's attribution frame); `deleteRun` and the per-run `deleteText` go | edytor computing what the engine holds | −247 | −68 | −241 | yes |
| 2 | Change 1: only text and blocks are suggested; block deletions are id lists naming nodes, the rest refused; the proposed operations and their replay go | (behaviour, accepted) | −863 | −304 | −858 | yes |
| 3 | Change 5: withdrawing is rejecting (by a writer of the author's when the view may not decide) | (behaviour, accepted) | −374 | −124 | −383 | yes |
| 4 | Change 2: a live answer is rewritten whole, the previous chunk's blocks removed for real | (behaviour, accepted) | −764 | −273 | −762 | no: reverted by cut 12 |
| 5 | Change 4: `toJSON()` without pending suggestions is a copy with every one rejected | (behaviour, accepted) | −927 | −345 | −897 | yes |
| 6 | Change 3: pending runs drawn inline through the run index (each run's state, an id list marking what it names changed, a mark the view draws) | (behaviour, accepted) | +483 | +271 | +568 | no: reverted in the next commit |
| 7 | The dispatcher's step arguments back where they are read, one history replay method, the records' walk bounded by a clock | a shape moved for a consumer that left | −27 | −10 | −79 | yes (before the method's 0.3 KB floor) |
| 8 | Engine YP32, a delete that proposes: a suggesting plan is one frame, its proposed text hidden until the plan ends; the offset remapping, the batching and the caret walk go | edytor computing what the engine could hold | −269 | +26 | −261 | yes |
| 9 | The document part rewritten: one id shape (the engine's triples), a decision table, the refusal decided once in `apply`, one `writeAs` and `ownIdsOf` for four copies, a dead guard and parameter | one idea in several shapes; special cases a rule covers; a check at every layer; private copies of a helper | −616 | −223 | −616 | yes |
| 10 | The view's part: one overlay layer for the suggestion runs, a shared answer's slot from the flow target, the open record's existence asked once | one idea in several shapes; a missing provider; a check at every layer | −325 | −7 | −338 | yes |
| 11 | A split's source is another block (a fix: the suggestion corpus at 300 operations found a split read as its own source) | — | +7 | +6 | +7 | yes |
| 12 | Change 2 reverted at the user's decision: a live answer writes only what changed again (equal blocks kept, the last block's text extended, the rest replaced); `erase` goes | (behaviour, the user's decision) | +751 | +270 | +762 | yes |

**Result.** The minimal app: +18,392 → **+14,738 B** min against
`569823b5` (+6,351 → +5,299 B gzip); every plugin: +18,783 → +15,117 B
(+6,683 → +5,654 B gzip). Shared suggestions alone (the press fixes set
aside): **+17,067 → +13,413 B** (13.1 KiB). The target was +6 KB: missed by
about 7.4 KB.

## 5. Why the target is missed

The bytes left are the feature's rules, not a layer over the engine:

| Part | B | What it is |
| --- | ---: | --- |
| `crdt/doc/suggest.js` | 6,321 | records 770, pending per block (`compute` 801, `candidates` 620, `unitsOf` 349, `sourceOf` 236, the memo 175), a suggesting plan (`apply` 901), decisions (`decide` 359, `run` 129, `hold` 84), `open` 300 |
| `session/suggestions.svelte.js` | +4,280 | suggesting mode and its grouping (`written` 416), decisions as commands (`decide` 551), the one list (`list` 286), a live answer (`write` 959, its diff `grown` 450 and `same` 44, `#slot` 185), block marks, colours, the shared `Suggestion`'s getters |
| the rest | +2,800 | the overlay layer and the view's wiring, the access level on the document and the provider, the history's writer, the writer's binding, the press fixes (1,325, not suggestions) |

What the engine could take, it took: a decision is one engine call, a
suggesting delete proposes in the engine (YP32). What it cannot take is
what the view reads: pending runs by display offset per block, the
grouping, the list, the decisions as commands, the live answer, the
access level. Drawing the runs through the run index instead of the
overlay costs more than it saves (cut 6): the overlay reuses the range
layer other features ship.

## 6. Behaviour changes not made, measured

Each prototyped on the final tree, measured with the same command, then
reverted (minimal app, own bytes min / gzip; the first after cut 12, the
others before it, whose code they do not touch):

| Change | Saves | Notes |
| --- | ---: | --- |
| AI answers not shared live (an app's shared answer written once, or not at all: view-local drafts only) | −1,653 / −645 | reverses the user's decision 7; measured again with the per-chunk diff back (−875 / −360 while the answer was rewritten whole) |
| Block deletions refused too (suggesting mode proposes text and new blocks only) | −499 / −215 | a block selection's Delete is refused while suggesting |
| No access level on the client (the room still enforces; the app sets `suggesting` itself for a suggest-only user) | −343 / −123 | `document.access` and `onAccessChange` go |
| `toJSON()` shows pending suggestions by default (`{ suggestions: false }` for the copy) | −285 / −159 | reverses the user's decision 3; also drops the whole-document cost of reads |
| No author colour on the runs (one colour per kind) | −173 / −80 | |
| One suggestion per suggesting session (no contiguity grouping) | −166 / −79 | reverses the user's decision 10 |
| A decision's block operations written as the document's (hooks see `acceptSuggestion`/`rejectSuggestion`, not the nested `deleteBlock`/`mergeBlocks`) | −63 / −32 | |

Together about −3.2 KB: shared suggestions would still cost about
+10.2 KB. Reaching +6 KB needs a smaller feature than the one the user
decided (for example no shared AI answers and no client access level and
no block proposals), not a smaller implementation of it.
