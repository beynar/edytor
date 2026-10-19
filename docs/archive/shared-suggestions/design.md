# Shared suggestions — design

Status: built (branch `shared-suggestions`, 2026-10-19). Started from the
study ([`study.md`](study.md), its prototype measured there), adapted to the
user's decisions (below) and to a leaner design: the alternatives and what
each costs are in [§2](#2-leaner-ways-measured); what was built and measured
is in [§9](#9-measured).

## 0. The user's decisions

They override the study where they differ.

1. **Bundle: a leaner way first.** One record mechanism where the study had
   several, existing records reused, the existing range overlay, no second
   path for anything the dispatcher already does; measured with
   `node scripts/bundle-size.mjs --only minimal,all,export` at every step. No
   code splitting, no lazy loading, no opt-in: the feature ships in the
   editor, the app draws the review UI (controllers and typed snippets).
2. **One list with a flag**, not a rename to drafts: `edytor.suggestions`
   holds today's view-local suggestions and the shared ones, each with
   `shared: true | false`.
3. **`toJSON()` and `onSave` default to the document without pending
   suggestions**; an option includes them (a breaking change).
4. **An AI suggestion is attributed to the user who asked**, marked
   `via: 'ai'` ("Ada (AI)").
5. **Read-only users see pending suggestions**, marked pending.
6. **Writers accept or reject; authors withdraw their own**; a suggest-only
   user cannot decide.
7. **AI streaming is live for everyone**: the answer streams into a shared
   suggestion collaborators watch being written.
8. **Block moves in suggesting mode are refused** (a drag, a move key, a
   handle move), with an announcement.
9. **A version restore drops pending suggestions.**
10. **Grouping**: one suggestion per session and contiguous range; moving
    elsewhere starts a new one; an AI answer is always one suggestion.
11. **The decision trail is kept until the purge**, like other history.

## 1. What the study proposed (and what it cost)

A suggestion lives in the document: a record under a root `suggest`;
insertions are text written under a client id minted for the suggestion
(its *writer*, bound to its author); a deletion is a proposal record (a new
content type, YP31 `ContentPropose`, content ref 14); block deletes, merges,
retypes, data and formatting are proposed operations run through the
reviewer's dispatcher on accept; a decision is a settled entry (JSON
`[1, client, clock, len]`) plus a YP20 hold or a block delete. The
prototype measured +5.4 KB min / +1.9 KB gzip for its core; the study
estimated +11–12 KB min / +4 KB gzip for the full feature, with a new index
part, a review plugin (`createReviewPlugin`), a drafts rename and a
`toJSON` lens option with three lenses.

## 2. Leaner ways, measured

Each row: what the study had, what this design does instead, and what it
saves (bundle: min, gzip of the app; storage: raw `encode()` bytes). The
numbers are §9's.

| # | The study | Leaner | Saves |
| --- | --- | --- | --- |
| L1 | Two record kinds for one codec: a proposal record (new content type, ref 14, its reader, `YNode#propose`) and JSON settled entries `[1, c, k, n]` | **One id list for both**: YP20's hold record, which (fork patch YP31) holds nothing inside a nested node. In a suggestion's record, an id list written by its writer proposes; one written by anyone else settles. No new content type, no new reader, no JSON settle entries | engine §9.1; a decision §9.3 |
| L2 | Every decision writes a settled entry, plus a hold or a block delete when text goes | **A decision writes only what changes**: accepting a deletion or rejecting an insertion is the reviewer's hold (the text is gone, so nothing is pending); accepting an insertion or rejecting a deletion is a settled id list (the text stays, so it must stop being pending) | §9.3 |
| L3 | One writer (client id) per suggestion: a binding and a state-vector entry each, forever | **One writer per suggesting session** (a view's), its records partitioning the writer's clocks by their creation; an AI answer (which streams while its user may type) gets its own | §9.3 (fixed cost per suggestion) |
| L4 | A new index part (`text/index/suggest.ts`) folded per commit | **The document's suggestion part keeps the pending changes per block**, recomputed for the blocks a commit's change report names and the ids a record change names; nothing when the document holds no suggestion. The run index is unchanged | §9.1 |
| L5 | A review plugin (`createReviewPlugin({ card, mode })`) and a drafts layer | **The one list** (decision 2) and **the suggestion bar** it already has: the bar's payload gains the shared fields (`shared`, `by`, `via`, `canDecide`, `reject`); the keys stay the suggestions plugin's | §9.1 |
| L6 | Rendering by a new layer of decorations and badges | **The existing range overlay** (`components/Ranges.svelte`, already the find matches', a comment draft's, a `replace` suggestion's): two more layers (inserted, deleted runs) and one block attribute | §9.1 |
| L7 | Accept and reject as their own commands beside the dispatcher's | **`acceptSuggestion` is the one command** (today's) for both kinds; reject is `rejectSuggestion`; their writes are the dispatcher's own operations (`deleteText`, `deleteBlock`, `mergeBlocks`, a proposed operation run again), so hooks, undo, normalization and readonly are the dispatcher's | — |
| L8 | Three `toJSON` lenses (`inline` with annotations, `accepted`, `base`) | **Two**: the document without pending suggestions (the default) and with them (`{ suggestions: true }`, the document as shown) | §9.1 |
| L9 | A proposed move (badge, ghost line) | **Refused** (decision 8): no move proposal, no ghost | — |

Kept from the study, because no leaner way does the job: the writer's text
for an insertion (it costs what typing costs), the proposed operations for
block deletes, merges, retypes, data and formatting (stored as the step's
operation and its arguments, run again through the reviewer's dispatcher),
and the room's classifier for a `suggest` socket.

## 3. The data model (schema generation 11, wire word `14011`)

- **Root `suggest`** (a map, in the history's scope). Attr `<sid>` → a
  record node (`suggestion`) its writer wrote:
  - the node's own item: its client is the **writer**; its clock opens the
    writer's clocks the record owns, up to the writer's next record;
  - attrs: `at` (creation time, ms), `via` (`'ai'` or an agent's name),
    `lbl` (a label);
  - its list part, in order:
    - **id lists** (YP20's hold record codec, YP31: holding nothing):
      written by the writer, a **proposed deletion** of the units they name;
      written by anyone else, a **settled** range (the decision's author is
      the entry's client);
    - **operation proposals**, JSON `{ op, args }` by the writer: `deleteBlock`,
      `mergeBlocks`, `setBlockType`, `patchData`, `formatRange` (its range
      as two anchors) — the plan step's operation and its arguments
      (`ARGS`, the dispatcher's own table); settled by naming the entry's id.
- **The writer.** A client id minted for a view's suggesting session (one per
  view lifetime), bound `c/<w>` to the author by the writer itself, written
  with its first write; an AI answer gets one of its own. A record's
  creation is never in a history step (`ownTextIds`' rule), so no undo or
  redo moves the clocks a record owns.
- **Pending** is a function of the replicated state, so replicas converge in
  any delivery order:
  - an **inserted unit**: a shown unit whose client is a record's writer,
    its clock in that record's clocks, not settled;
  - an **inserted block**: a shown block whose node the writer created in
    the record's clocks, not settled (`split` when its stream lies in
    another block's text: a split);
  - a **proposed deletion**: a shown unit a writer's id list names, not
    settled;
  - a **proposed operation**: an entry whose target is shown, not settled.

| What the suggester does | What is written | Shown as | Accept | Reject |
| --- | --- | --- | --- | --- |
| Types, pastes inline content | The text, by the writer | Inserted run (overlay, author colour) | Settle its ids | `deleteText` (the reviewer's hold) |
| Deletes text | Own pending units: deleted (held or removed, the writer's); others: an id list | Struck run (overlay) | `deleteText` (the reviewer's hold) | Settle its ids |
| Inserts blocks (Enter, a paste, an AI's blocks) | The blocks, by the writer | Block marked `inserted` | Settle the node and its writer text | `deleteBlock` (children promote) |
| Splits a block | The split, by the writer | The new block marked `split` | Settle | `mergeBlocks` into the block before, and its writer text held |
| Merges, deletes, retypes blocks; changes data; formats | A proposed operation | Block marked `removed`, `merged` or `changed`; a formatted range marked | Run the operation; settle | Settle |
| Moves blocks | Refused, announced | — | — | — |
| An AI answer | One record of its own writer: the blocks or text, and the replaced range's id list | As above | Per change or the whole | Per change or the whole |

- **Edits by the writer to its own pending content are direct**: deleting its
  own pending text, retyping, formatting or merging its own pending blocks
  writes them (nobody else's content changes).
- **Withdraw** (the author): the writer deletes its pending text and blocks
  and its own entries; nothing stays pending.
- **Decisions are one command and one undo step** (`acceptSuggestion`,
  `rejectSuggestion`, over one change, a suggestion or all), never written
  as suggestions, even from a view in suggesting mode.
- **Concurrent decisions compose**: an accept and a reject of one insertion
  are a settle and a hold, so the text goes; of one deletion, a hold and a
  settle, so the text goes. The decider undoes their own step.

## 4. Reads and exports

- The document as shown is inline: pending insertions show, pending
  deletions show struck.
- **`toJSON()` defaults to the document without pending suggestions**
  (decision 3): pending inserted units and blocks are left out (a split's
  new block joins the block before it), proposed deletions and operations
  are not applied. `toJSON({ suggestions: true })` is the document as shown.
  The room's `onSave` value, `edytor.value` and the history panel's
  comparison read the default; the clipboard and `blockJSON` read the
  document as shown.
- A document with no suggestion pays nothing: every read checks the `suggest`
  root first.

## 5. The rules around it

- **Grouping** (decision 10): a view's suggesting write continues its open
  suggestion while it touches the block that suggestion last wrote in or a
  neighbour of it in document order; anywhere else it opens a new one. An AI
  answer is one suggestion of its own.
- **Moves** (decision 8): in suggesting mode `canMove` is false and a plan
  holding a `moveBlocks` step is refused, announced (`labels.editor`).
- **History**: a history replays a step under the writer that wrote it (an
  undo of suggested typing holds it as the writer, a redo of a proposal
  writes it under the writer), so the suggester's own undo withdraws what it
  suggested.
- **Version restore** (decision 9): the restore writes the version's
  document without its pending suggestions, then settles every proposal
  still pending; its undo brings them back.
- **Purge** (decision 11): a record with nothing pending, whose entries are
  all older than the horizon, and which is its writer's oldest live record
  (so no record's clocks pass to another), is removed by the purge; its
  writer's accepted text then reads as ordinary text, which it already did.
- **The room** (`authorize` → `access: 'read' | 'comment' | 'suggest' |
  'write'`): a `suggest` socket's frame is admitted struct by struct
  (suggestion-shaped writes under writers bound to its user, deletes of its
  writers' own items only; anything else stripped, refused `suggest-only`,
  the socket kept); a `comment` socket writes nothing to the document and
  the room writes a thread's anchor once `decideComment` accepts it. The
  provider tells the view its access, and a `suggest` view suggests and
  cannot decide.

## 6. Owners (new rows of AGENTS.md's table)

| Fact | Owner | Where |
| --- | --- | --- |
| A suggestion's record, its writer, its proposals, its settled ranges, what is pending per block, a decision's plan, the document without pending suggestions | the document's suggestion part (`facade.suggest`) | `crdt/doc/suggest.ts` |
| A hold record that holds nothing (an id list) | fork patch YP31 | `crdt/vendor/yjs/src/structs/Item.js` |
| Whether a view's writes are suggestions, which suggestion they continue | the view's suggesting session (`edytor.suggestions.suggesting`), read by `Dispatcher.write` | `session/suggestions.svelte.ts`, `session/commands.ts` |
| The list of suggestions (view-local and shared) | `edytor.suggestions` | `session/suggestions.svelte.ts` |
| The look of a suggested run and block | the theme; the overlay places the runs, the attribute table the block's mark | `themes/notion.css`, `components/Ranges.svelte`, `surface/attributes.ts` |
| What a `suggest` or `comment` socket may write | the room's suggest-only classifier and the comment anchor write | `cloudflare/room/suggest.ts`, `cloudflare/room/comments.ts` |

## 7. API

```ts
// the view
edytor.suggestions.suggesting = true;          // suggesting mode (false: editing)
edytor.suggestions.list;                       // Suggestion[]: view-local and shared, oldest first
suggestion.shared; suggestion.by; suggestion.via; suggestion.changes; suggestion.canDecide;
suggestion.accept(); suggestion.reject();      // a writer; reject = discard for a view-local one
suggestion.discard();                          // view-local: drop; shared: the author withdraws
edytor.suggestions.add(at, content, { shared: true, via: 'ai', label: 'AI' }); // live
edytor.suggestions.acceptAll(); edytor.suggestions.rejectAll();
// the document
document.toJSON();                             // without pending suggestions
document.toJSON({ suggestions: true });        // as shown
```

## 8. Build

1. Engine (YP31), schema generation 11, `UPSTREAM.md`, oracle.
2. Document operations (`crdt/doc/suggest.ts`), contract rows `sugg.*`, the
   random corpus' `suggest` steps.
3. Pending per block, checked against a rebuild.
4. Session: suggesting mode, grouping, the one list, the commands.
5. Surface: overlay runs, block marks, read-only display.
6. Room: `suggest` and `comment` access, the classifier, the comment anchor.
7. Live AI streaming.
8. Registry chrome and the starter's toggle.
9. Docs and changelog.

## 9. Measured

Measured on this Mac with `node scripts/bundle-size.mjs --only minimal,all,export`
(minified, gzip -9) and the stored-bytes rows of
`src/tests/crdt/suggest/shared-suggestions.test.ts` and
`src/tests/collaboration/suggesting-mode.test.tsx` (raw `encode()` bytes).

### 9.1 Bundle

| Step | minimal own (min) | minimal total (min / gzip) | all own (min) | all total (min / gzip) | export (min / gzip) | minimal own, against master (min / gzip) |
| --- | --- | --- | --- | --- | --- | --- |
| master `569823b5` | 427.7 KB | 474.4 / 163.4 KB | 657.1 KB | 705.7 / 246.3 KB | 76.6 / 28.9 KB | — |
| 1 engine (YP31) | 427.7 KB | 474.5 / 163.4 KB | 657.1 KB | 705.7 / 246.3 KB | 76.6 / 28.9 KB | +44 B / +0 B |
| 2 document part | 438.4 KB | 485.2 / 167.4 KB | 667.9 KB | 716.5 / 250.3 KB | 76.6 / 28.9 KB | +11.0 KB / +4.1 KB |
| 3–6 index, session, surface, room access | 444.6 KB | 491.4 / 169.3 KB | 674.3 KB | 723.0 / 252.4 KB | 76.6 / 28.9 KB | +17.4 KB / +6.1 KB |
| PR head (with the caption and void-press fixes, +1.4 KB, not suggestions) | 446.0 KB | 492.8 / 169.7 KB | 676.0 KB | 724.6 / 253.0 KB | 76.6 / 28.9 KB | +18.8 KB / +6.5 KB |

Shared suggestions cost **+17.4 KB min / +6.1 KB gzip** in the minimal app
(+17.7 / +6.3 KB in the app with every plugin); `edytor/export` is unchanged.
By file (minimal, min): `crdt/doc/suggest.js` 10.2 KB, `session/suggestions`
+4.8 KB, `crdt/doc/plan.js` +0.6 KB, the view's wiring and overlay layers
+0.9 KB, history, attribution, moves and the document's access +0.9 KB. The
study estimated +11–12 KB min / +4 KB gzip for the full feature: the build is
about half again over that estimate, mostly in the document part (the
decisions as plans, the document without suggestions, withdrawal, proposals
of every operation kind) and in the live streaming diff of the session.

The leaner ways that were measured on their own:

| # | Measured |
| --- | --- |
| L1 | The study's proposal content type (ref 14, its reader and `YNode#propose`) costs +340 B min against YP31's +44 B (+296 B min / +81 B gzip saved), and no JSON settle entries are read |
| L2 | A decision writes one id list or one hold: §9.3 |
| L3 | A second suggestion by the same view costs 36 B against 89 B for the first (a new writer): §9.3 |
| L4 | No index part: pending is read per block from the records, a document with no suggestion reads nothing (`debug` counts 0), a keystroke costs the same at 5,000 blocks as at 1,000 |
| L5, L6, L8 | The bar plugin grew +0.3 KB min (`SuggestionBars`), the range overlay +0.3 KB (`Ranges`); no review plugin, no lens module |

### 9.2 Engine

Fork patch YP31 (a hold record inside a nested node holds nothing): +44 B
min, no gzip change; no new content type, no new reader.

### 9.3 Storage

Raw `encode()` bytes, against the same edit made directly:

| | Suggested | Direct |
| --- | --- | --- |
| A typed character (100 typed one by one) | 1.07 B | 1.80 B |
| A typed character (1,000) | 1.007 B | 1.08 B |
| A Backspace (100) | 0.14 B (proposed) | 0.97 B |
| A Backspace (1,000) | 0.017 B (proposed) | 0.10 B |
| A suggestion's fixed cost | 89 B (its record, the writer's binding, a new client); another by the same writer 36 B | — |
| Accept an insertion / reject a deletion (a settled id list) | 11 / 12 B | — |
| Reject an insertion / accept a deletion (the reviewer's hold) | 37 / 37 B | — |

A streamed AI answer (markdown, streamed word by word through the export's
`textToBlocks(…, { streaming: true })`, a peer applying every chunk):

| Answer | Chunks | Synced (all chunks) | Stored | The same blocks written at once |
| --- | --- | --- | --- | --- |
| 257 characters (a heading, a paragraph with a bold run, a list, a table, a paragraph) | 60 | 3,509 B (58 B a chunk) | 2,080 B | 1,796 B |
| 1,034 characters (the same, four times) | 243 | 13,546 B (56 B a chunk) | 7,244 B | 6,670 B |
