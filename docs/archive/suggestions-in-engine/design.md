# Shared suggestions, smaller — design

Status: in progress (branch `suggestions-in-engine`, 2026-10-19). PR #32
(`9f592dde`) shipped shared suggestions for +17.1 KB min / +5.95 KB gzip on
the bare `<Edytor />`; a smaller bundle is a requirement of all work since
the last release, so the cost is a no-go. This file measures where the
bytes are, asks of each fact whether the engine (the vendored Yjs fork)
holds it or could, records the behaviour changes the user accepted after
that report, and lists the cuts, one commit each, with what each measured.
The model before this work is
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
- **A delete that proposes** (cut 6, YP32): `YNode#delete` into a
  suggestion's record proposes the units, and hides them until the plan
  ends, so the plan's later steps read the offsets they were prepared
  with; `apply`'s offset remapping goes.
- **Pending runs in the run index** (change 3, below): the engine tells
  the index which texts an id list names (an id list in a nested node marks
  their parents changed), and the index reads each unit's suggestion state
  as it builds the runs, so the runs carry it like a mark and the overlay,
  the per-block walk and the per-block map go.
- **Proposed operations as id lists**: only deletions name units. A merge,
  a retype, a data change or a format written for real (and held on
  reject) would show applied before it is accepted. Operations are dropped
  instead (change 1).

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
whole app), kept only when the minimal app's net is below 0.

| # | Cut | minimal own | minimal gzip | all own | export |
| --- | --- | ---: | ---: | ---: | ---: |
| — | `9f592dde` against `569823b5` | +18,392 | +6,351 | +18,783 | 0 |
| 1 | Decisions as one engine call (`YNode#hold` for a settle and for the decider's hold, in the funnel's attribution frame) | −247 | −68 | −241 | 0 |
