# Shared suggestions: a study (2026-10-19)

The subject: suggestions that collaborators see and review, like Google Docs' suggesting mode and Word's track changes. Today a suggestion (`edytor.suggestions`) is session state: only the view that made it shows it, until it is accepted, and a reload loses it (site `reference/limitations`). This study surveys how others do it, chooses a design for edytor, prototypes its core in this export and measures it.

Sources for the survey are primary (API references, source code, papers, the authors' own essays), cited by key at the end of section 1. The prototype is in this export (`src/lib/crdt/doc/suggest.ts`, fork patch "YP31", two test files); section 8 lists the patch.

## 0. Verdict

- **A suggestion lives in the document**, as content plus a record. It is not kept in a side store or on a branch. The room syncs and stores it, IndexedDB keeps it offline, a reload keeps it, and history versions contain it.
- **An insertion is text written by the suggestion's own writer.** The writer is a client id minted for the suggesting session and bound to its author (`c/<writer>`, as any replica). The item ids say which text is the suggestion's, so the text costs what typing costs, and a peer's text typed inside it is never part of it.
- **A deletion writes nothing to the text.** It is a proposal record of id ranges (YP31: a YP20 hold record's codec that holds nothing). Accepting it is a real YP20 hold written by the reviewer, in the reviewer's history. Text typed inside the range later is never deleted by it.
- **Everything else is proposed as an operation** in the record (block deletes, merges, moves, retypes, data, formatting) and runs through the reviewer's dispatcher on accept. Inserted blocks and splits are written by the writer, as insertions are.
- **Accept and reject** write a settled range into the record (plus a hold or a block delete when text goes): one undo step for the reviewer, composable like holds, converging in any order.
- **A suggest-only access level** is a room rule: such a socket may write only under suggestion writers bound to its user, and only insertions, proposals and its own records. Comment-only access falls out of the same work.

The prototype proves the core on three replicas: suggest, review with author, accept and reject per change, concurrent typing inside both kinds of range, reload, suggestion over suggestion, undo, AI blocks and a streamed rewrite. It also works through a view's suggesting mode, where the dispatcher's plans become suggestions.

Measured costs:
- A suggested character costs 1.03 to 1.31 bytes, the same as typed text (1.08 to 1.80).
- A proposed deletion costs 0.015 to 0.12 bytes per character, against 0.10 to 0.97 for a real delete.
- Each suggestion has about 106 bytes of fixed overhead, and a decision costs 30 to 60 bytes.
- The prototype adds 5.4 KB min and 1.9 KB gzip to the app; the full feature is estimated at 11 to 12 KB min and about 4 KB gzip.

## 1. Survey

What a suggestion is in each system's data, who sees it, how it is accepted or rejected, what concurrent edits do, nesting and cost. A research pass read the primary sources. The Yjs source read is upstream `main` (`@y/y` 14.0.0-rc.29); the vendored fork pins rc.26. Claims we could not verify are marked.

| System | Data | Visibility | Accept / reject | Concurrent edits | Nesting | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| Google Docs [G1–G5] | Id lists on runs (`suggestedInsertionIds`, `suggestedDeletionIds`), keyed maps for style changes (`suggestedTextStyleChanges`, paragraph, bullet, table, named styles); author and time on a `SuggestionThread` | Inline for editors and commenters; view-only users get `PREVIEW_WITHOUT_SUGGESTIONS` by default (`SuggestionsViewMode` also has `PREVIEW_SUGGESTIONS_ACCEPTED`) | Accept needs edit access, reject needs edit access or authorship; one, all; API `writeMode: SUGGEST` makes a batch suggestions | Server-side (unverified) | Id arrays allow several suggestions on one run (inferred from the field shape) | Free |
| Notion [N1–N3] | Not public | Margin and inbox; needs "Can comment" | Per suggestion ✔ ✖; since 2026-08 agents "propose changes instead of making them directly" | Unknown | Unknown | Only text, to-do, heading and list blocks |
| Word / OOXML [W1–W4] | Inline revisions with `w:id`, `w:author`, `w:date`: `w:ins`, `w:del` (text kept as `w:delText`), `w:rPrChange` and `w:pPrChange` hold the previous properties, `w:moveFrom`/`w:moveTo` ranges, row inserts in `trPr` | Everyone with the file | One or all; "Lock Tracking" | Web co-authoring tracks every author (merge unverified) | `w:del` inside `w:ins` | Deleted text stays in the file |
| prosemirror-changeset [P1] | Not a store: a diff of step maps into changes whose spans carry `data` (`addSteps(newDoc, maps, data)`, `combine`, `simplifyChanges`) | Local | n/a | n/a | n/a | Memory |
| prosemirror.net track example [P2] | Commits of inverted steps and a blame map | Local | Revert a commit (rebased through later steps) | "Resolved implicitly", can be unintuitive | n/a | Memory |
| prosemirror-suggest-changes [P3–P6] | Three mutually exclusive marks in the doc: `insertion`, `deletion` (id + extra attrs), `modification` (attr name, previous and new value); a `dispatchTransaction` wrapper rewrites Replace, ReplaceAround, mark and attr steps, other steps pass untracked | Shared through the doc | `applySuggestion(s)`, `revertSuggestion(s)`; no permission model | Skips `y-sync$`, `collab$`, `history$` transactions | Excluded by design: deleting own insertion is real; an insertion inside a deletion moves to its end; adjacent ones join | MIT |
| Fidus Writer [F1–F3] | Marks `insertion`, `deletion`, `format_change` with user and date; blocks carry a `track` attr | Shared | Any order | Collaborative (detail unverified) | Unverified | AGPL |
| Tiptap Tracked Changes [T1–T3] | A `suggestion` mark; atom nodes carry `suggestionId`, `suggestionType`, user, time; adds, deletes, replaces, mark and attribute changes, splits, list sink/lift, table rows and cells | Shared, "works with Yjs" | One, bulk, by range, by user | Through Yjs | Unverified | Paid add-on |
| Tiptap AI Toolkit [T4, T6] | Decorations, "ephemeral and only visible to the current user"; preview mode leaves the doc unchanged, review mode applies then undoes | Current user only | Per suggestion | Local | n/a | Paid |
| CKEditor 5 [C1–C8] | Start/end markers in the doc named `type:suggestionId:authorId`; the record (author, `createdAt` set by the server, data) in an adapter or Cloud Services; a formatting suggestion stores a command and its options, accepted by running it | Shared, OT | One, all | OT; attribute suggestions on one key may not intersect (chains by `groupId`) | Typing inside another's insertion splits it, keeping its author (`originalSuggestionId`); `mergeNestedSuggestions` | Commercial; roles reader, commentator, writer, no suggest-only |
| Yjs v14 / y-prosemirror [Y1–Y9] | A second doc (the suggestion doc), forked from the base; `createDiffRenderer(base, suggestionDoc, { attributions })` diffs their id sets; base → fork always flows, fork → base only with `suggestionMode` off; accept copies the structs of an id range into base, reject undoes in the fork then accepts | Everyone in the suggestion doc's own room (`<room>--suggestions`; y/hub `?branch=`) | `acceptChanges(start, end)`, `rejectChanges`, all | Base streams into the fork | An insertion inside another's deletion stays visible | A second full doc, `gc: false`; authors in a server-side attribution map ("attributions carry the userid"), forged otherwise; y/hub AGPL; BlockNote's integration PR closed unmerged (2026-06) |
| Loro [L1–L6] | No suggestions; `fork`, `forkAt`, `checkout` (read-only), `diff` + `applyDiff` "for PR-style workflows" | Per fork | Whole diff (partial: filter it yourself) | CRDT merge | n/a | A full copy |
| Automerge [A1–A4] | No suggestions; `clone`, `Repo.clone` keeps history to merge back, `view(heads)`, `diff` | Per handle | Merge all | CRDT merge | n/a | A full copy |
| Peritext [K1] | Marks anchored before/after characters by op id; comments overlap | Shared | n/a | Expand rules (bold grows, link and comment do not) | Overlapping comments | n/a; "does not yet visualize differences" |
| Upwelling, Patchwork [U1–U5] | Drafts as layers (Automerge docs), merged onto a stack; Patchwork branches from main, merged and deleted; AI bots work on a branch merged in part; "Edit Groups" group edits after the fact | Private or shared drafts | Merge a draft or branch, partial for bots, revert groups | CRDT rebase | None | A doc per draft; criticizes Google's suggestions as "too fine-grained" and choosing a mode in advance |

Lessons that decide edytor's design:

1. **Shipping products keep suggestions in the shared document**, keyed by a suggestion id: Google, Word, CKEditor, Tiptap, Fidus Writer, suggest-changes. The author sits on the mark or in a record keyed by the id. A server-set author cannot be forged (CKEditor, Google).
2. **Every write needs a suggesting form, or it silently applies.** suggest-changes passes unknown steps through, and CKEditor disables commands it has not integrated. In edytor the unit is the prepared plan, so the coverage is the `PlanStep` union: about 12 step kinds, a closed set.
3. **Nesting rules are few and agree everywhere:**
   - deleting your own insertion is a real delete;
   - deleting another person's insertion nests (Word, Google);
   - an insertion inside a deletion is allowed (Yjs) or moved out (suggest-changes).
4. **Who may write decides the model.** Yjs chose a fork so that suggest-only users never write the base doc. Marks in a shared doc need a server that checks every write. Edytor's room already classifies every struct of a frame (forged marks, attribution trust), so the check belongs there.
5. **Partial accept needs ids.** A fork gets rebasing for free, but accepting one change copies structs whose origins may be other pending structs. Automerge and Loro merge all or nothing.
6. **Positional marks attach concurrent text to the suggestion.** A peer's insert between a mark's start and end is covered by it, and rejecting the suggestion then removes the peer's text. CKEditor splits the marker, keeping the original author. Id-based suggestions (Google's id lists, Yjs' id ranges) do not have this problem.
7. **A view-local layer is right for one user's AI drafts and wrong for review.** Tiptap separates the two: the AI Toolkit is local, Tracked Changes is shared. Edytor has the local layer and needs the shared one.
8. **Grouping matters more to the reviewer than storage.** Ink & Switch's Edit Groups, CKEditor's chains and suggest-changes' joining all group changes into units the reviewer acts on.

Sources:

- **Google:** [G1] developers.google.com/workspace/docs/api/reference/rest/v1/documents; [G2] …/v1/documents/request; [G3] …/v1/documents/batchUpdate; [G5] support.google.com/docs/answer/6033474.
- **Notion:** [N1] notion.com/help/suggested-edits; [N2] notion.com/releases/2024-07-29; [N3] notion.com/releases/2026-08-28.
- **Word:** [W1] learn.microsoft.com/en-us/office/open-xml/word/how-to-accept-all-revisions-in-a-word-processing-document; [W2] …/documentformat.openxml.wordprocessing.runpropertieschange; [W3] …/documentformat.openxml.wordprocessing.deletedrun; [W4] support.microsoft.com, "Track changes in Word".
- **ProseMirror:** [P1] github.com/ProseMirror/prosemirror-changeset; [P2] prosemirror.net/examples/track; [P3–P6] github.com/handlewithcarecollective/prosemirror-suggest-changes (README, `schema.ts`, `replaceStep.ts`, `withSuggestChanges.ts`).
- **Fidus Writer:** [F1] github.com/fiduswriter/fiduswriter, `schema/common/track.js`; [F2] discuss.prosemirror.net/t/socalled-tracked-changes-using-prosemirror/1365.
- **Tiptap:** [T1–T3] tiptap.dev/docs/tracked-changes; [T4] tiptap.dev/docs/ai/ai-toolkit/client/agents/review-changes; [T6] tiptap.dev/docs/content-ai/capabilities/changes/overview.
- **CKEditor:** [C1] ckeditor.com/docs/ckeditor5/latest/features/collaboration/track-changes/track-changes-integration.html; [C2] …/api/module_track-changes_trackchangesediting-TrackChangesEditing.html; [C3] …/trackchangesconfig; [C4] …/track-changes-custom-features.html; [C5] ckeditor.com/docs/cs/latest/guides/collaboration/data.html; [C6] …/security/roles.html; [C7] the CKEditor blog on real-time collaboration; [C8] …/track-changes.html.
- **Yjs:** [Y1] github.com/yjs/yjs `src/utils/Renderer.js` (and this repository's `node_modules/@y/y@14.0.0-rc.26/src/utils/Renderer.js`, `DiffRenderer`, read for this study); [Y2] `src/utils/Doc.js` (`isSuggestionDoc`); [Y3] y-prosemirror `demo/prosemirror.js`; [Y4] `tests/suggestions.test.js`; [Y5] `ATTRIBUTION.md`; [Y6] `src/commands.js`; [Y7] github.com/yjs/yhub; [Y8] FOSDEM 2026 BlockNote/Yjs/ProseMirror talk transcript; [Y9] github.com/TypeCellOS/BlockNote/pull/2843.
- **Loro:** [L1–L6] github.com/loro-dev/loro-docs (`tips`, `time_travel`, `text`, `loro-richtext`, `timestamp`) and the loro-wasm changelog.
- **Automerge:** [A1–A4] automerge.org API docs (`clone`, `Repo`, `DocHandle`, rich text).
- **Peritext:** [K1] inkandswitch.com/peritext.
- **Ink & Switch:** [U1] inkandswitch.com/upwelling; [U2–U5] inkandswitch.com/patchwork/notebook/2024-version-control/05–08.

**What the vendored fork kept of Yjs' suggestion work.** YP8 pruned the fork to the surface edytor runs on. It deleted:
- `utils/Renderer.js`: `AttributionsRenderer`, `DiffRenderer` (the suggestion mode) and `SnapshotRenderer`;
- `Snapshot.js`;
- the id-map algebra (`diffIdMap`, `mergeIdMaps`, `filterIdMap`, …);
- the content-id helpers;
- the renderer, diff and suggestion tests of `attribution.tests.js`.

It kept:
- the IdSet operations the history uses (`createIdSet`, `diffIdSet`, `insertIntoIdSet`, `mergeIdSets`, `iterateStructsByIdSet`);
- the IdMap/ContentMap codec pair, only to read legacy `a/` attribution records.

So the fork has none of upstream's suggestion machinery. It has something upstream lacks: attributed, reversible deletes (YP20) and moves (YP22), which make the in-document design cheap.

## 2. What edytor has today

- **The session layer** (`session/suggestions.svelte.ts`, 4.9 KB min; `components/Suggestion.svelte`, 0.5 KB). It holds content one view proposes at a position (`after`/`before`/`inside`/`end`/`replace`, by block ids or a range's anchors), rendered as a non-editable preview in the host. `accept()` is one dispatcher command (`acceptSuggestion`) placing it as a paste does (`prepare.insertFlow`). It streams (`update`, `append`, `done`) and retries. Nothing reaches the document before `accept()`. This is Tiptap's AI Toolkit "preview" model.
- **Comments.**
  - Thread bodies live in the room's SQLite; the document holds only each thread's anchor, a `comment:<id>` paired mark.
  - One rule decides every request, `decideComment`, which refuses a read-only actor.
  - When a thread is removed, the room writes the removal of its anchor as a room transaction.
  - So there is no comment-only access: a read-only identity cannot write the anchor mark.
- **Attribution.**
  - Every client id that wrote resolves to an actor through the replicated `c/<clientID>`. The binding is written in the first transaction that writes under that id (YP30), and the room's trust rules verify it.
  - Edytor already writes under derived client ids: the seed writer and `ownText`'s own-text writer. So a suggestion writer is an existing technique.
- **YP20 hold records.** A text delete is a `ContentHold` record (content ref 11) in the root `textdel`, naming id ranges. It belongs to its writer and lives in the history's scope.
  - An item shows iff it is not removed and no live record holds it.
  - Undo deletes the record; a peer's text inside a held run is never held.
  - **Does it give "a delete not yet in effect" for free? No.** A hold record holds at integration, wherever it is (`ContentHold.integrate` calls `holdIds(+1)`), so a proposed delete cannot be a live hold.
  - What YP20 does give for free:
    - the accept of a deletion: one hold record by the reviewer, undoable, composing with other holds;
    - the reject of an insertion: the same;
    - the codec a proposal needs (`writeIds`: a left id and a length, delta-coded).
  - YP31 below is that codec with `integrate` and `delete` empty.
- **YP22 move records.** A move is a record that names home slots, with a priority; deleting the record hands the slot back. A rejected suggested move would be exactly that. The design below proposes moves as operations instead (section 4); the record route stays open.

## 3. Where a suggestion lives

### A. In the document (chosen)

The suggestion's content and its record are replicated: the room relays and stores them, IndexedDB keeps them offline, and a reload and history versions keep them.

Concurrency is the CRDT's. An insertion is items, so concurrent typing integrates around and inside it. A deletion names item ids, so it covers exactly what the suggester saw. Every rule below is a function of the replicated state (items, records, holds, settled ranges), so replicas converge in any delivery order. The prototype runs under the index's self-checks.

### B. In a side store, like comment bodies (rejected for review, kept for drafts)

Suggestions would be JSON proposals in the room's SQLite (`{at: anchors, content: JSONBlock[], replace: anchors}`), with only anchors in the document.

- **It fails concurrent edits.** A replace accepted later re-resolves its anchors and deletes whatever lies between them, a collaborator's new text included. That breaks "preserve what was not removed" (`del.*`, the product contract). Storing ids instead of anchors only rebuilds design A in a second store.
- **Typing in suggesting mode would be an RPC per keystroke**, with no offline support and no IndexedDB.
- **Two stores must agree**: the anchors in the document and the bodies in the room, the same failure surface as comments, for every keystroke.
- **What it is good for**: one user's AI draft before anyone should see it. That is today's session layer, which stays as drafts (section 7).
- **Discussion on a suggestion** (Google's `SuggestionThread`) should reuse the comment store: a thread whose anchor is a suggestion id.

### C. As a branch (Yjs v14, Loro, Automerge, Upwelling; rejected)

A suggestion doc would be forked from the base, with suggesting writes going to the fork and the diff rendered inline. Reasons to reject it:

- **Memory and work double.** Every reviewer holds two documents and two indexes. The index is the costliest per byte: up to 77 heap bytes per stored byte in the room. Yjs keeps the fork with `gc: false`, and the room would host two documents per page.
- **Partial accept is unsafe in edytor's model.** Accepting one change copies structs from the fork into the base, and their origins may be other pending structs (upstream's `collectSuggestedChanges(…, collectAll)` pulls them in). A block's facts are spread over streams and boundaries, claim items, home slots and move records, paired marks, hold records, the nonce and attribution stamps. A partial copy of them is a state no op ever writes, which every rule of the index and the room would have to accept.
- **The inline review needs a renderer over two documents.** "What the host shows" would get a second owner beside the render cells and the index. YP8 removed exactly that renderer.
- **The security argument has an edytor answer.** Yjs chose the fork so suggest-only users never write the base. Edytor's room already admits frames struct by struct (`forged.ts`, `admission.ts`), so a suggest-only rule there gives the same guarantee on one document (section 5.7).
- **Where branches are right**: Patchwork's "AI works on a branch, merge in part". Here, a large AI rewrite is one suggestion with many changes, reviewed change by change, so no branch is needed.

### Inside A: marks or ids? (ids chosen)

Both options keep the suggestion in the document; they differ in how the suggested text is identified.

- **Marks** (Tiptap, CKEditor markers, suggest-changes, Fidus) would be `suggest:<id>` paired marks, as comment anchors are. They reuse YP13, but:
  - a mark covers whatever lies between its start and end, so a peer's concurrent insert inside a suggested insertion becomes part of it, and rejecting the suggestion removes the peer's text;
  - a pending deletion would be a formatting fact the "accepted" lens has to interpret;
  - the room's suggest-only check would be positional: is this text inside the user's mark?
- **Ids** follow YP20's precedent: "an undo only deletes its own record; a peer's insert inside a held run is a new item with no hold". The room's check is per struct: is its client this user's suggestion writer?

**Why a writer per suggesting session, rather than id lists for insertions.** The first prototype wrote each insertion's ranges into the record. That breaks typed-run merging: the text items and the record items interleave in one client's clock space, so every character becomes its own item. With its own writer:
- the suggestion's text stays one item per typed run;
- the record is written once;
- the author is the writer's binding.

## 4. The data model

Schema generation 11 (wire word `14011`, YP31 adds content ref 14; an earlier generation is refused, never converted).

- **Root `suggest`**, in the history's scope. Each attr `<sid>` is a suggestion's record node, written by its writer:
  - `w`: the writer client id (redundant with the record item's client, kept for reads; can go);
  - `by`: the author's actor id (redundant with `c/<w>`, verified by the room; can go);
  - `at`: the creation time in ms;
  - `lbl`: an optional label (`'AI'`);
  - `via`: the agent, when an AI wrote it on the author's behalf (proposed);
  - the record's list part holds, in order: proposal records (YP31, content ref 14: `client, clock, len` per range, consecutive ones of one writer merge as hold records do); operation proposals (JSON: `{op, …}`); and settled entries (JSON `[1, client, clock, len]`, written by the deciding user's own client: the item's client says who decided).
- **The writer.** One client id per suggesting session of a view, minted at its first suggesting write and bound `c/<w>` to the author by the writer itself (the room trusts no other). Each record owns the writer's clocks from the record's own creation clock to the next record's. The prototype mints one writer per suggestion, simpler, at about 10 bytes of state vector per suggestion forever (section 9).
- **The changes a record shows.** They are computed from the converged state and kept per block by the index (the prototype recomputes them; section 8):

| What the suggester does | What is written | Shown as | Accept (by the reviewer) | Reject (by the reviewer) |
| --- | --- | --- | --- | --- |
| Types text, pastes inline content | The text, by the writer (`insertText`/`insertInline`, marks by `marksForInsertion`) | Inserted run (underline, author colour) | Settle its ids | Hold its ids (YP20) + settle |
| Deletes text (Backspace, a range) | Its own pending units: removed for real; other units: a YP31 proposal of their ids | Struck run | Hold the ids (YP20) + settle | Settle |
| Inserts blocks (Enter at a block's end, a paste, an AI's blocks) | The blocks, by the writer (`insertBlocks`, `insertFlow`) | Block tinted (`data-edytor-suggestion-inserted`) | Settle the block node's id and its text | `deleteBlock` (children promote: `del.blocks.promote`) + settle |
| Splits a block (Enter inside text) | The split, by the writer (its boundary and the new block) | A pilcrow and the new block tinted | Settle | `mergeBlocks(new → previous)` + settle |
| Merges blocks (Backspace at a start) | Proposal `{op: 'mergeBlocks', from, into}` | Boundary marker `¶` struck | Run `mergeBlocks` | Settle |
| Deletes blocks (a block selection) | Proposal `{op: 'deleteBlocks', ids}` | Blocks struck (`data-edytor-suggestion-removed`) | Run `deleteBlocks` | Settle |
| Retypes (Turn into) | Proposal `{op: 'setBlockType', id, type}` | Badge "Turn into Heading" | Run `setBlockType` | Settle |
| Formats a range (bold, link, colour) | Proposal `{op: 'formatRange', from: DocAnchor, to: DocAnchor, marks}` | Overlay underline + badge "Bold" | Run `formatRange` over the anchors as they resolve | Settle |
| Changes data (to-do checked, image size) | Proposal `{op: 'patchData', target, ops}` | Badge | Run `patchData` | Settle |
| Moves blocks | Proposal `{op: 'moveBlocks', ids, dest}` (dest named by a block: `after: id` or `inside: id`) | Badge at the source, a ghost line at the destination | Run `moveBlocks` | Settle |
| An AI rewrite of a range | One record: a deletion proposal of the range and the new content inserted after it by the writer | Struck old text, inserted new text | Per change, or the record | Per change, or the record |

Further rules:

- **Edits by the writer to its own pending content are direct.** Retyping a block it inserted, deleting its own pending text and formatting its own pending text are written, not proposed: nobody else's content changes, which is how CKEditor and suggest-changes treat one's own insertion.
- **An operation proposal is prepared again at accept**, through the reviewer's dispatcher, so hooks, admission, undo and normalization are the normal ones. A proposal whose target is gone (a block deleted meanwhile) shows nothing and is dropped by the index from what is pending; nothing is written to drop it.
- **What "settled" means.** A settled range is no longer pending, whatever happened to its text. Pending insertions are the writer's shown units minus the record's settled ranges. Pending deletions are the record's proposals minus its settled ranges, over shown units.

## 5. The rules

### 5.1 Author and grouping

- **The author** of a suggestion is the actor of its writer's binding (`actorOf(w)`), checked by the room like any replica's. The author of a decision is the actor of the settling item's client. No author string is trusted from the frame: the prototype's `by` attr is a convenience the room would check against the binding, or drop.
- **One record is one reviewable suggestion.** A suggesting view opens a record at its first suggesting write and continues it while the edits are contiguous: the same block or its neighbours, within the history's capture window plus a pause rule. A new record starts when the caret jumps away. This is Google's behaviour; an app can also open a record explicitly (`document.suggestions.open({ label: 'AI' })`).
- **A record's changes** are its runs: inserted runs, deleted runs and operation proposals. The reviewer acts on a change, a record (all its changes) or everything.
- **An AI suggestion** is a record whose writer is bound to the user who asked, with `via: 'ai'` (or the agent's name) and a label. The open question of the AI as an actor of its own is section 11.

### 5.2 Accept and reject, and their undo

- **One command each** (`acceptSuggestion`, `rejectSuggestion`), dispatched by the reviewer's view. Each is one transaction and one undo step: the settled entries, plus the hold, the block delete, the merge or the proposed operation's plan.
- **Undo of a decision** deletes those items (the `suggest` root is in the history's scope; the prototype adds it), so the change is pending again. The prototype tests this.
- **The suggester's undo** removes what it suggested: an undo of typing holds the typed units, and an undo of a proposal deletes the proposal item. The prototype tests this through a view.
- **Concurrent decisions compose.**
  - Accept by A and reject by B of the same insertion: B's hold hides the text and A's settle marks it decided, so the text is hidden. The same holds for a deletion.
  - In both cases deleting wins, deterministically, and the winner can undo their own step.
  - There is no last-writer-wins on a status field.
- **Accept all and reject all** are one command over a record or over every record: one step.

### 5.3 Concurrent edits inside a suggested range (proven)

Text a peer types inside a suggested insertion is the peer's (another client): it splits the insertion into two runs and survives a reject. Text a peer types inside a proposed deletion is not in the proposal: it survives an accept. Typing by the suggester continues its insertion.

A peer deleting part of a suggested insertion in editing mode holds those units. The insertion shows less, and an accept settles what remains.

### 5.4 A suggestion over a suggestion (proven)

- **Ben proposes deleting part of Ana's insertion.** Both changes show over the same units. Rejecting Ana's insertion hides the units, so Ben's proposal names nothing shown and is no longer pending; nothing is written for it. Accepting Ben's deletion first holds those units of Ana's insertion.
- **The suggester deleting their own insertion** removes it for real.
- **Typing inside another person's pending deletion**, in suggesting mode, is a new insertion inside the struck range (Yjs' rule; it shows inside the strike).
- **Formatting proposals by two users on one range** are two proposals. They are accepted in the order the reviewer picks, through `formatRange`'s own merge.

### 5.5 Streaming (an AI's suggestion arriving in chunks)

Two paths:

- **Draft, then share** (the default for AI). The answer streams into the view's draft (today's session layer, `update`/`append`/`done`, `textToBlocks(…, { streaming: true })`): no CRDT churn, no history noise, nothing stored while it streams. `draft.suggest()` writes it as a shared suggestion: one `insertFlow` plan by the writer, plus a deletion proposal for a `replace`.
- **Live sharing** (`shared: 'live'`). Each chunk is written by the writer as it arrives, and collaborators see it stream (proven: three chunks, the peer reads the answer so far after each).
  - Appended text costs what the text costs.
  - With markdown re-read on each chunk, only the difference between the previous blocks and the new ones is written. While the last line is still arriving, `textToBlocks` streaming changes only that line (the streaming cut), and the writer edits its own pending blocks directly (5.4). This is `restoreTo`'s rule: rewrite only between the common prefix and suffix.
  - Writing at most once per animation frame or per 100 ms keeps the frame rate at the room's `maxUpdatesPerSecond`.

### 5.6 History, purge, versions

- **The purge horizon.**
  - A pending suggestion is live content and proposals: never purged.
  - A record whose changes are all settled, and whose settle items are older than the horizon, is removed by the purge with its proposals (`room.purge.what` gains a row). The writer's accepted text is then ordinary text, which it already reads as.
  - Rejected text is held by the reviewer and goes like any held text: at the horizon, or at the reviewer's session end (`hist.release.end`).
  - The writer's client id stays in the state vector (Yjs never drops a client).
- **History versions.** A version (two a day) is the document, pending suggestions included. `versionDiff` should compare the current document's `base` lens (section 5.8) with the version's, so a pending suggestion is not an "added" block. A version restore (`restoreTo`) writes blocks and content, not the `suggest` root; whether it settles the suggestions it overwrites is a user decision (section 11).
- **Release at the session's end.** A session's writer can no longer be undone after the release; its records stand.

### 5.7 The room: permissions, a suggest-only level, a comment-only level

`authorize` returns `access: 'read' | 'comment' | 'suggest' | 'write'` (today `read` and `write`, header `X-Edytor-Access`; `setAccess` gains the two levels). For a `suggest` socket the room admits a frame's structs only when:

- **every struct's client is a suggestion writer of this user**: bound `c/<w>` to the user, by `w` itself, in this frame or before; the room registers `w` as the user's replica (the `4409` rule). The one exception is the user's own client writing settled entries in a record whose writer is theirs (withdrawing their own suggestion).
- **every struct's place is one of**:
  - a text item in an existing text (an insertion);
  - a block creation (registry entry, node, home slot, its text and data);
  - a split's boundary and block;
  - the record node and its attrs and list (YP31 proposals, operation proposals);
  - the writer's binding;
  - a hold record holding only the writer's own units (deleting its own pending text).
- **every delete in the frame** removes only the writer's own items.

Anything else is stripped, as forged marks are (`forged.ts` gains a pure classifier). It is refused with `permission-denied` (`suggest-only`), logged and counted, and the socket stays. The attribution stamps a write makes (`l` lastChangedBy, contributors) are not written in suggesting mode (the funnel skips them under a writer), so a suggestion never shows as the block's last change before it is accepted.

A `comment` socket writes nothing to the document. The room writes the thread's anchor mark itself, after `decideComment` accepts the request (a room transaction, as `#removeAnchors` already does). That answers the limitation "no comment-only access level". `read` is unchanged; `write` may do everything, accepts and rejects included.

The room's optional `validate` hook sees suggested content like any frame.

### 5.8 Reads and exports: lenses

The document as displayed is inline: pending insertions show, and pending deletions show struck.

- **Exports and `toJSON`** take a lens, `suggestions: 'inline' | 'accepted' | 'base'`:
  - `inline` marks pending runs and blocks as `suggestion` annotations, `{ id, kind, by }`. This is a JSON field, not a mark, and `fromJSON` ignores it;
  - `accepted` is the document with every pending change applied;
  - `base` is the document without them.
- **The default.** `toJSON()` and `onSave`'s `value` default to `base`, so an app that mirrors the value into its database or search never stores a suggestion as agreed content. The editor's own reads (the clipboard, the facade's `blockJSON`) stay inline. This default is a user decision.
- **Copying struck text** copies it (it is text). Paste in suggesting mode is an insertion.

### 5.9 Rendering

The surface owns this.

- **Inserted and deleted runs** are overlay rectangles through `components/Ranges.svelte`, the one layer of marked text runs (find matches, comment drafts, a range `replace`): a tint and underline for insertions, a strike line for deletions, coloured by author (`--edytor-suggestion-color` per actor, from `u/<id>`'s colour).
- **Blocks** carry `data-edytor-suggestion-inserted` and `data-edytor-suggestion-removed`, owned attributes in the attribute table, with a badge for operation proposals.
- **The text rendering and the cells are untouched.** There is no `{@html}`, no new text element and no decoration inside the text: the model is right, so only the components change.
- **The caret** can enter struck text (it is real text). Navigation stops are unchanged.
- **The theme** (`themes/notion.css`) gives the look; the plugins only say the state.

## 6. Owners (new rows of AGENTS.md's table)

| Fact | Owner | Where |
| --- | --- | --- |
| A suggestion's record, its writer, its proposals and its settled ranges | the document's suggestion ops (`prepare.suggest*` → `apply`), one record per suggestion under the root `suggest` | `crdt/doc/suggest.ts` |
| Whether a unit, block or proposal is pending, and which change it belongs to | the index's suggestion part, folded per commit from the items, records and settled ranges | `crdt/text/index/suggest.ts` (new) |
| How a plan's step is suggested (written by the writer, proposed as ids, proposed as an operation) | `suggestPlan` over the `PlanStep` union (one row per step kind) | `crdt/doc/suggest.ts` |
| A proposed delete (holds nothing) | YP31 `ContentPropose` (the YP20 codec) | `crdt/vendor/yjs/src/structs/Item.js` |
| Whether the view's writes are suggestions | the view's mode (`edytor.mode`: `editing`, `suggesting`, `viewing`), read by `Dispatcher.write` only | `session/commands.ts`, `edytor.svelte.ts` |
| Which record a suggesting write continues | the view's suggesting session (writer, open record, grouping rule) | `session/suggesting.svelte.ts` (new) |
| What a socket at `suggest` or `comment` access may write | the room's suggest-only classifier and the comment anchor write | `cloudflare/room/forged.ts`, `cloudflare/room/comments.ts` |
| The look of a suggested run and block | the theme; the overlay places the rectangles | `themes/notion.css`, `components/Ranges.svelte` |
| A view's AI draft (session only, before it is shared) | the draft layer (today's `Suggestions`) | `session/drafts.svelte.ts` (renamed) |

## 7. The API sketch

**The document** (headless, Worker-safe; the room and a server agent use it too):

```ts
const s = document.suggestions.open({ label: 'AI', via: 'assistant' }); // a record; the writer is the session's
document.suggestions.apply(s, document.prepare.replaceRange(from, to)); // any plan, suggested
document.suggestions.insertText(s, block, offset, 'text');              // sugar over apply
document.suggestions.list();     // SuggestionRecord[]: id, by, at, label, via, changes, pending
document.suggestions.changes();  // SuggestedChange[]: suggestion, kind, block, offset, length, text, by
document.suggestions.accept(changeOrSuggestion); document.suggestions.reject(changeOrSuggestion);
document.suggestions.acceptAll(); document.suggestions.rejectAll();
document.toJSON({ suggestions: 'base' | 'accepted' | 'inline' });
```

**The view:**

```ts
edytor.mode = 'suggesting';   // 'editing' (default) | 'suggesting' | 'viewing' (the base lens, readonly)
edytor.suggestions;           // the review controller, reactive: list, changes, at(blockId), focus(change)
edytor.suggestions.accept(change); edytor.suggestions.reject(suggestion); edytor.suggestions.acceptAll();
edytor.drafts.add(at, content?, options?);   // today's `suggestions.add`, unchanged behaviour
draft.suggest();                             // share it as a suggestion (one plan by the writer)
```

Commands go through the dispatcher: `acceptSuggestion` and `rejectSuggestion` (payload `{ suggestion, change? }`, hooks see each step), and `setMode`. Readonly views refuse them. Keys: Mod+Alt+X toggles the mode (Google's binding is Ctrl+Alt+Shift+X), Mod+Enter accepts the change at the caret (or the latest draft), and Escape dismisses the card.

**Chrome** (headless: the app's snippets, one host per surface):

```svelte
<Edytor plugins={[createReviewPlugin({ card, mode })]} />
{#snippet card({ suggestion, changes, by, label, accept, reject, focus, readonly, canDecide }: SuggestionCardPayload)}…{/snippet}
{#snippet mode({ mode, set, labels }: SuggestionModePayload)}…{/snippet}
```

- **The card** is placed in the margin beside the suggestion's first block, like `CommentsSidebar.svelte`'s placement host; one card per record, with Accept and Reject per change and per record.
- **The mode switch** is a toolbar control.
- **The ready-made markup** goes in `registry/edytor/chrome/` (shadcn), as for comments. A thread on a suggestion is a comment thread anchored by the suggestion id (`CommentRequest.add` gains `suggestion?: string`).

**What breaks:**

- **Renames.** `edytor.suggestions` becomes the shared review controller; today's API moves to `edytor.drafts`:
  - `Suggestion` → `Draft`;
  - `suggestions.add/list/latest/get/clear/at` → `drafts.*`;
  - `createSuggestionBarPlugin` → `createDraftBarPlugin` and `SuggestionBarPayload` → `DraftBarPayload`;
  - the `acceptSuggestion` command on a draft becomes `acceptDraft`;
  - `[data-edytor-suggestion]` → `[data-edytor-draft]`, and the `editor.suggestion` label → `editor.draft`;
  - `createSuggestionsPlugin` keeps the keys of both.
  - The alternative is to keep one list with `suggestion.shared`, which mixes a session lifetime and a document lifetime in one type (two owners in one object). We recommend the rename (decision 1).
- **Schema generation 11** (wire `14011`): rooms, browser stores and history versions of generation 10 are refused (no conversion), as at every generation.
- **`toJSON()`'s default lens** if `base` is chosen (decision 4): an app that read pending content through `value` no longer sees it.
- **`authorize`** may answer `access: 'suggest' | 'comment'`; `setAccess` takes them. These are additions.

## 8. The prototype

All in this export.

- **`src/lib/crdt/vendor/yjs/src/structs/Item.js` (+33 lines): YP31 `ContentPropose`.** It extends `ContentHold`, with empty `integrate`/`delete`, its own `copy`/`splice`, and `getRef() → 14`. In `ynode.js` (+20): `contentRefs[14] = readContentPropose`, and `YNode#propose(ids)` appends one record (`insertInGapHelper` at the list's end, as `hold` does).
- **`src/lib/crdt/doc/suggest.ts` (new, 440 lines): the facade part `docSuggest`.**
  - `open({ by, label })` mints a writer and writes the record and the writer's `c/<w>` binding by the writer (`as(writer, fn)` switches `doc.clientID`, as `ownText` does).
  - `insertText` is the facade's `insertText` by the writer.
  - `deleteText` removes the writer's own pending units and proposes the others (`node.propose(ids)`).
  - `changes()` walks each block's shown units (`flatten` + `openRangeCursor`, row marks skipped) against the records: the writer's units, the proposals and the settled ranges. It finds inserted blocks by the client of the block node's item.
  - `accept`/`reject` call `settle(id, ranges, hold, block?)`, which writes the settled entries and, when text goes, `textdel.hold(ids)` or `deleteBlock`.
  - `textAs(block, 'accepted' | 'base')` gives the lenses.
  - `apply(id, plan)` is the suggesting mode for a plan. A plan of insertions goes in as written, by the writer. A plan of text inserts and deletes defers the deletes and shifts later offsets past the kept text. Any other step is refused (the prototype's limit).
- **`src/lib/crdt/edytor-doc.ts` (+11)** wires `suggest` on the facade, with the facade's `insertText`, `deleteText`, `deleteBlock` and `apply`.
- **`src/lib/crdt/doc/history.ts` (1 line)** puts the `suggest` root in the history's scope.
- **`src/lib/session/commands.ts` (+2) and `src/lib/edytor.svelte.ts` (+2)** add `edytor.suggesting` (a record id or `null`). `Dispatcher.write` applies the plan through `facade.suggest.apply` while it is set.

The key code, the pending computation (`changes()`, abridged):

```ts
for (const u of unitsOf(block)) {                       // shown units: offset, client, clock, char
	const ins = byWriter.get(u.client);                   // the writer's units: an insertion
	if (ins && ins !== whole && !settledOf.get(ins.id)!.has(u.client, u.clock)) touch(`i:${ins.id}`, ins, 'insert', u);
	for (const p of pend)                                 // proposals minus settled: a deletion
		if (p.deletes.has(u.client, u.clock) && !p.settled.has(u.client, u.clock)) touch(`d:${p.rec.id}`, p.rec, 'delete', u);
}
```

And the decision (`settle`):

```ts
doc.transact(() => {
	if (block !== undefined) c.deleteBlockOp(block);                                  // reject an inserted block
	else if (hold) doc.get(TEXT_DELETES_ROOT).hold(ranges.flatMap((r) => [...r]));  // accept a deletion, reject an insertion
	node.insert(node.length, ranges.map(([a, k, n]) => [SETTLED, a, k, n]));          // by the reviewer's own client
});
```

### Tests

`src/tests/crdt/suggest/shared-suggestions.test.ts` (crdt lane, 11 rows, all green, with the index's self-checks on):

1. A suggestion is in the document: another replica reads the insertion and the deletion with their author (`ana`), the label, and `actorOf(writer) === 'ana'`; nothing is deleted yet. The `accepted` and `base` lenses read right.
2. Three replicas.
   - Setup: ana suggests "very " and the deletion of "brown ". Then, concurrently:
     - ben types `XX` inside ana's insertion;
     - cy types `YY` inside the proposed deletion;
     - ana goes on suggesting.
   - All three converge: `The veXXry very quick broYYwn fox`, with four changes: insertions `ve` and `ry very `, deletions `bro` and `wn `. The peers' text is in none of them.
   - Ben accepts the insertions and cy rejects the deletion. All converge, with nothing pending.
3. Accepting a deletion holds exactly what the suggester saw: `YY` typed inside it stays (`The quick YYfox`).
4. Rejecting an insertion hides only the suggester's text: ben's `XX` inside it stays.
5. Deleting its own pending text deletes it; deleting other text proposes.
6. A reload (`loadDocument(encode())`) keeps every suggestion and decision.
7. A suggestion over a suggestion: ben proposes deleting part of ana's insertion. Both show; rejecting ana's insertion leaves nothing pending.
8. Undo of an accept (the reviewer's history) makes the change pending again.
9. AI blocks: two blocks proposed as one plan (`apply(s, prepare.insertBlocks(…))`) are two `block` changes. Rejecting one deletes it, accepting the other keeps it, and the peers converge.
10. An AI rewrite: the deletion of the whole paragraph plus a streamed insertion in three chunks, each seen by the peer after delivery. Accept all gives the new text.
11. The stored bytes, below.

`src/tests/collaboration/suggesting-mode.test.tsx` (unit lane, 2 rows, green): through a view (`createOperationEdytor`, `edytor.suggesting = id`), the view's `insertText` and six one-unit `deleteText` (Backspace) become a suggestion that a headless peer reviews and accepts. The suggester's own undo (`historyUndo`) withdraws the insertion, then the proposal.

**Lanes in the export.**
- **crdt:** 3,898 tests passed. One failed: the vendored suite's pin `contentRefs.length === 14` (`encoding.tests.js`), which YP31 changes to 15 by design. The random corpus, the YP20/YP22 rows and the history rows pass with the `suggest` root in scope.
- **unit:** 4,441 tests passed. One failed: the API report (`public-surface.test.ts`), by design: the facade gained `suggest` and the view `suggesting`, and `pnpm api:report` would rewrite it.

### Measured

Stored bytes are `encode()` deltas, raw (the room gzips snapshots).

| Workload | Plain edit | As a suggestion |
| --- | --- | --- |
| Type 100 characters one by one | 1.80 B/char | 1.31 B/char |
| Type 1,000 characters one by one | 1.08 B/char | 1.03 B/char |
| Backspace 100 characters | 0.97 B/char | 0.12 B/char (proposal) |
| Backspace 1,000 characters | 0.10 B/char | 0.015 B/char (proposal) |
| Open a suggestion (record, binding, new client) | — | 105–107 B |
| Accept a 1,000-character insertion (settled entry + the reviewer's binding) | — | 58 B |
| Accept a 1,000-character deletion (settled entry + hold record) | — | 32 B |

Two notes on these numbers:

- **Text.** A suggested character costs what a typed one costs: the writer's runs merge like any typing. A proposed deletion costs less than a real one, because it carries no hold bookkeeping. Before YP31, with proposals as JSON entries, a proposed deletion cost 13.9–14.1 B/char; that is why the codec matters.
- **Fixed cost.** About 106 B per suggestion. Without `by` (the binding says it) and with one writer per session (no new client per suggestion), it drops to about 40 to 60 B.

Bundle (`scripts/bundle-size.mjs --only minimal,all`, run with its cache in the export):

| App | master | Prototype | Delta |
| --- | --- | --- | --- |
| `<Edytor />` (minimal) own | 427.3 KB min, 163.3 KB gzip (total) | 432.7 KB min, 165.2 KB gzip | +5.4 KB min, +1.9 KB gzip |
| Every plugin (all) own | 656.7 KB min, 246.1 KB gzip (total) | 662.1 KB min, 248.1 KB gzip | +5.4 KB min, +2.0 KB gzip |

Of that, `crdt/doc/suggest.js` is 4.9 KB and YP31 about 0.3 KB (`Item.js` 11.4 → 11.6 KB).

Note on the measurement: in this export `node_modules` is the main checkout's (a symlink), and the stock script writes its probe apps to `node_modules/.cache/bundle-size`. The probe apps' paths then resolve outside the build root, so the build fails. The measurement used a copy of the script with its cache in the export (`scripts/bundle-size-local.mjs`), and the one cache directory the failed run created in the main checkout was removed.

### The prototype's limits

- `changes()` recomputes over the whole document on each call. The product keeps it in the index, per block (step 3).
- The funnel still stamps `l` and contributors under the writer.
- One writer per suggestion, not per session.
- The view's suggesting mode refuses plan steps other than text inserts and deletes when they mix: no deferred block ops, merges, formatting or data.
- No rendering, no controller, no room classifier.

## 9. Build plan

Every step keeps all lanes green, and each one updates the site and the changelog (`### Unreleased`).

| Step | What | Size (estimate) |
| --- | --- | --- |
| 1. Engine | YP31 `ContentPropose` in `UPSTREAM.md` with its oracle (`yp31-proposals.test.ts`: codec, merge, splice, nothing held, differential against YP20); upstream suite pin 14 → 15; schema generation 11 (`14011`); `bench/stored-size.mjs` row | +60 lines vendored, +0.3 KB |
| 2. Document ops | `crdt/doc/suggest.ts`: records, a writer per session (clock-partitioned records), `suggestPlan` over every `PlanStep` (inserts by the writer, deletes as YP31, the rest as operation proposals), accept and reject per change, record and all, lenses (`toJSON({ suggestions })`, exports), the purge of settled records; contract rows `sug.*` in `docs/editor-delete-contract.md`; the random corpus gains a `suggest` adapter (suggest, decide, undo, deliver in any order) with a `wellFormed` invariant (pending is a function of state) | +900 lines, +6 KB |
| 3. Index | `text/index/suggest.ts`: the pending runs per block folded per commit (a facet for the `suggest` root; a proposal's units found through their streams), checked against a rebuild (`indexChecks`); scaling row (a keystroke's work in suggesting mode the same at 5,000 blocks as at 1,000) | +300 lines, +1.5 KB |
| 4. Session | `edytor.mode` and `Dispatcher.write` routing; the suggesting session (grouping); no attribution stamps under a writer; the review controller (`edytor.suggestions`: changes by suggestion, `at(block)`, focus, keys); the drafts rename and `draft.suggest()` | +450 lines, +2.5 KB |
| 5. Surface | Runs in `Ranges.svelte` (inserted, deleted, by author colour), block attributes, badges, the card's placement host; theme CSS; jsdom rows (truth check: the struck text is real text) | +250 lines, +1.5 KB |
| 6. Room | `access: 'suggest' \| 'comment'` (header, `setAccess`), the suggest-only classifier in `forged.ts` (strip, `permission-denied` `suggest-only`), the room-written comment anchor, the purge of settled records, metrics and log; `tests/do` rows (a suggest socket that writes a delete mark, a hold of others' text, a move or a data leaf is stripped; one that suggests is stored and relayed) | +400 lines, room bundle only |
| 7. AI | Live sharing of a streaming draft (the last block's difference only, at most one write per frame); `via` on records; the site's AI demo suggests in the shared room | +150 lines, +0.5 KB |
| 8. Chrome and docs | `registry/edytor/chrome/` review card, mode switch, the comment thread on a suggestion; pages: `editor/suggestions` rewritten (drafts and shared), `server/room` access levels, `reference/limitations` (the two limitations go), migration; Playwright rows (suggesting mode typing, Backspace over struck text, IME composition in suggesting mode in three engines), DST corpus rows (suggesting mode solo and collab) | registry and site |

The app bundle total is about +11 to 12 KB min, about +4 KB gzip, with no lazy chunk: the controllers are always there and the markup is the app's.

## 10. Risks

1. **Coverage of every plan step.** A step without a suggesting form must be refused in suggesting mode, never written; this is suggest-changes' silent pass-through. A test should enumerate `PlanStep['op']` against `suggestPlan`'s table, so a new op fails until it has a row.
2. **Writer per session: the clock partition and the history.**
   - Records own clock intervals of the writer. A redo or undo replay writes new items under the replaying client, not the writer, so a redo of suggested typing would write ordinary text. Fix: the history replays a step under the client that wrote it, `redoItem` with the writer as the current client.
   - The undo manager's `fresh` uses `doc.clientID`: typing and erasing inside one open step in suggesting mode holds instead of removing, which is harmless but stores held text.
3. **The room classifier is the security boundary.** Every struct shape a suggesting write produces must be classified, and anything else stripped (marks, delete marks, move records, data leaves, holds of others' units, a binding written by another client). It needs adversarial `tests/do` rows like the forged-marks ones. A suggest-only user who writes ordinary text under their main client is stripped.
4. **Exports and app mirrors.** If `toJSON()` stays inline, apps that mirror the value index pending suggestions as agreed content. If it defaults to `base`, the editor's own clipboard and value must not use it by mistake. The decision is the user's (section 11); either way it needs `docs-onboarding` rows.
5. **Proposals whose targets move or vanish.**
   - An operation proposal is prepared again at accept and may be refused (a block deleted, a move no longer fits); the change then shows "can't be applied", reject only.
   - A text deletion proposal over units a peer deleted shows only the remaining units.
   - A formatting proposal over anchors follows the seam rule (`crdt/anchors.ts`).
6. **State vector growth.** With one writer per suggestion, each suggestion adds about 10 bytes to every state vector and Step1, forever. One writer per session keeps it at one client per session, the same as a second tab.
7. **Version restore over pending suggestions.** `restoreTo` deletes the pending insertions that the version lacks, so the suggestions empty out. Their records should be settled, and the restore's undo must bring them back.
8. **IME and the struck caret.** Composition in suggesting mode writes through the same plans. A composition that starts inside struck text must land as an insertion, not a re-insert of the struck units. This needs Playwright and cdp rows (Android drift) and is unproven by the prototype.
9. **Performance.** A pending deletion has to find its units' blocks. Through streams it is O(ranges) per commit, not a document walk. This is a contract row with the index's counters, not wall clock.
10. **Many suggestions on one run** (five reviewers striking the same word) mean rectangles stacked per author in the overlay. Mitigation: one rectangle per run with a count badge.

## 11. Decisions for the user

1. **Rename the session layer to drafts** (`edytor.drafts`, `Draft`; `edytor.suggestions` becomes the shared review), or keep one list with `shared: boolean`. Recommended: the rename.
2. **Are suggestions visible to read-only users?** The data is in the document they hold, so hiding them is a view lens, not a boundary. Options:
   - `viewing` mode shows the `base` lens by default for readonly views (Google's view-only default), and inline on request;
   - or always inline.
   - Filtering them out of a read-only socket's frames is possible, but the replica's state then differs from the room's, and turning the user into a writer means a full resync. We advise against it.
3. **Does accept require a permission?** Proposed: accept and reject need `write`; withdrawing one's own suggestion needs only `suggest` (Google: reject needs edit access or authorship). Should an app hook (`onBeforeOperation` on `acceptSuggestion`) be able to restrict it further, say to the document's owner? It can today, through the dispatcher.
4. **`toJSON()`'s and `onSave`'s default lens:** `base` (safe for mirrors, breaking) or `inline` (with annotations).
5. **What an AI suggestion looks like in history.** Options:
   - (a) the user who asked, with `via: 'ai'` on the record (proposed: the room's trust model stays one actor per user);
   - (b) its own actor (`<user>/ai`), which the room must allow a user to bind.
   - Which of these does the history panel's `editors` list show?
6. **The default AI path:** draft first, then `suggest()` (proposed), or live sharing while it streams.
7. **Moves in suggesting mode:** proposed as operations (badge plus ghost line), or refused in v1 as Notion does (text-only suggestions). The YP22 record route ("reject = delete the move record") is the alternative if moves should show in place.
8. **A version restore over pending suggestions:** settle them, or keep their records and let the content decide.
9. **Grouping rule:** contiguous edits within the capture window plus a pause (proposed), or one record per suggesting session until the user closes it.
10. **Who may see the decision trail**, such as "accepted by ben": kept in the settled entries until the purge horizon, then gone with the record. Is that enough, or should the room log decisions (`onSuggestion`, like `onComment`)?

## Addendum: lanes run in the export

- **crdt** (`vitest --config ./vitest.crdt.config.ts --run`): 3,898 passed. One failure, expected: the YP31 content-ref pin.
- **unit** (`vitest --run`): 4,441 passed. One failure, expected: the committed API report is not current (`suggesting: string | null` on the view, `suggest: {…}` on the facade).
- **The prototype's own files:** `npx vitest --config ./vitest.crdt.config.ts --run src/tests/crdt/suggest/` (11 rows) and `npx vitest --run src/tests/collaboration/suggesting-mode.test.tsx` (2 rows), both green.
- **The patch:** `prototype.patch` in this export (`diff -ruN` of `src/` against master; the two corpus seed files the crdt lane rewrites are left out).
