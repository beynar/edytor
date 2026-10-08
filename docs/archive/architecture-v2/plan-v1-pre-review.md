# Edytor architecture plan v1 (judge synthesis)

_Status: complete (scorecard, verification, sections 1–11). Judge: synthesis of the three proposals in this directory; independence rule respected (no excluded document opened)._

## 0. Inputs read and working notes

- Read in full: 6 reader reports (runtime-model, crdt-core, selection, input-events, plugins-ui, sync-collab) and
  3 proposals (representation-first = RF, ownership-first = OF, deletion-first = DF).
- Baseline re-measured at start (`xloc.mjs src/lib --dirs`): **29,087 xloc / 118 files** (crdt 8362, events 4519,
  selection 3913, plugins 3780, root 2511, block 1716, text 1195, collaboration 666, components 615, hotkeys 589,
  clipboard 518, utils 500, history 200, dnd 3). The working tree is still moving: selection was 3,786 in the task
  baseline, 3,871 when the readers measured, 3,913 now. All percentages below use 29,087 and also quote 28,941.
- Scorecard and verification sections are written next; the plan sections follow.

## Step 1 — Scorecard (1 = weak, 5 = strong)

| Criterion | Representation-first (RF) | Ownership-first (OF) | Deletion-first (DF) |
|---|:-:|:-:|:-:|
| (a) single ownership per fact | **5** | **5** | 4 |
| (b) feature-parity honesty | 4 | **5** | 3 |
| (c) LOC estimate credibility | 3 | **4** | 2 |
| (d) compositionality | 4 | 4 | 4 |
| (e) extension cost | 4 | 4 | 4 |
| (f) migration boundedness | 4 | 4 | 3 |
| **Total / 30** | **24** | **26** | **20** |

**Representation-first**
- (a) 5 — Five authoritative stores. Everything else is a cache or a pure function. The ownership map names one module per fact, and it separates id-only handles from render cells, so no object is both.
- (b) 4 — Lists twelve maintainer decisions and marks which API retirements it proposes. Three weaknesses:
  - the headline number equals the readers' floors;
  - it treats the A-5 undo corner as a forced semantic change, but the judge probe shows the engine returns the text to its own block;
  - it costs the virtual first block at 40 xloc, although render, selection, IME and presence all need special handling until the block is materialized.
- (c) 3 — The 14,170 target (−51 %) has no contingency. About 3,700 of the reduction is "trims inside retained responsibilities", which the proposal itself calls the least certain part. Its scenario B (≈15,600) is the realistic headline.
- (d) 4 — Causal segment keys and tests V7/V7b (IME × remote atom insert/delete) are the best compositional work in the three proposals. Two gaps: it misses merge-then-delete (G8 over merge claims), and it schedules the render bracket first, while timer-driven remounts would still render outside any bracket.
- (e) 4 — Block, mark and inline kinds each need one owner. Comments need the plugin plus a ≈20-xloc plugin-declared replicated root drawn in the overlay. It prices a new selection kind, a new inputType and a new content op.
- (f) 4 — Strengths: shadow-before-switch, a redesign trigger ("no new timer, flag or retry"), per-checkpoint fallbacks with costs, and two parallel tracks. Weaknesses: the bracket-first ordering and no per-checkpoint xloc track.

**Ownership-first**
- (a) 5 — 71 owner rows map every fact the readers flagged to one owner, across five contexts with nested lifetimes. It also enforces the rule "no checkpoint closes with two owners for one fact". One blur: the plugin-facing `Block` API lives inside the Surface cell module.
- (b) 5 — Contingency is itemized per domain. It includes a scope statement and 15 decisions, and it re-verified its claims in source. It is the only proposal that got the A-5 undo corner right (confirmed by judge probe), and it adds an explicit abandon criterion in case that corner fails.
- (c) 4 — Floor 14,473 plus 1,453 contingency gives 15,926 (−45 %). Moved code is counted once, at its source domain. It has a per-checkpoint xloc track and stops at a 30 % overrun. The floors are still unimplemented estimates.
- (d) 4 — The test matrix follows the method's axes:
  - nesting at two depths;
  - four failure-midway cases;
  - retry;
  - a generated value used after a boundary;
  - an empty collection;
  - two features combined.

  Two gaps: it misses merge-then-delete, and F-U4 leaves out the marked-text variant, where the boundary's formats decide the outcome.
- (e) 4 — Block, mark and inline kinds each need one owner, and it honestly counts 3 owners for comments. It names `doc/document` and `surface/observer` as the two owners that grow with features.
- (f) 4 — CP0–CP9 each has contract tests, a delete list, limits and a two-iteration rule, and the stream-boundary spike runs in parallel with an abandon criterion. Weakness: cells (CP3) come before the selection value (CP5). Today's selection repairers, which store wrappers, would first have to be adapted to cells and then deleted.

**Deletion-first**
- (a) 4 — The layering is clean:
  - headless commands receive the selection as an argument;
  - only the projector writes the DOM selection;
  - only the observer reads mutations.

  But the ownership map is thinner (37 rows), and cells are re-exported as the plugin `Block`.
- (b) 3 — It discloses decisions D-1…D-10, but:
  - more of its headline rests on a parity-changing default: DOM-only composition previews change the pinned remote-lock behavior and peers' live view of IME text, for a saving its own fallback prices at only ≈40 xloc;
  - the −54 % headline has no contingency;
  - the A-5 corner is misdescribed;
  - the Svelte `flushSync`-in-effect ban it cites is defined in the installed Svelte 5.55.1 but never thrown.
- (c) 2 — The 13,280 target:
  - is ≈1,200 below the readers' de-duplicated line-by-line floor (≈14,480) before any contingency;
  - leaves selection ≈200 under its reader floor even after accounting for its moves;
  - depends on ≈3,480 xloc of estimated "shrinkage";
  - books moved code in its destination domains (events 1,300 only because ≈560 of command logic is booked under block), which hides where complexity lands.
- (d) 4 — Its delete rule is the only one of the three that covers merge-claimed blocks (the judge probe confirms today's code resurrects them). T1 keeps document order separate from island policy. Risk: DOM-only previews and generic record inversion both land in the most fragile area (IME × remote edits × foreign DOM changes).
- (e) 4 — Each new kind needs one owner. Comments via mark families are elegant (2 owners), but they make annotations undoable with the text. The proposal flags this as a product decision.
- (f) 3 — The census script is the best progress metric of the three. Three things make the riskiest steps the least bounded:
  - "no dual runtime paths" rules out shadowing;
  - the replicated-schema switch comes early, at CP2;
  - CP6 bundles cells, the bracket and the projector into one checkpoint.

**Chosen base: ownership-first.** It has the most defensible numbers and the most honest parity statement. It is also the only proposal whose load-bearing engine claim survived verification without correction. Grafts:
- from representation-first: the five-store summary, causal segment keys, handle/cell separation, shadow-before-switch, and the no-timer redesign trigger;
- from deletion-first: delete-with-claims, a readiness rule without a virtual block, the census, the single `prevent()` catch, selection-before-cells ordering, and an early transport track;
- three judge findings: the boundary-mark rule, merge-then-delete, and the actual `flushSync` constraint.

## Step 2 — Load-bearing claims of the base proposal, verified against source

Probe files: `scratchpad/arch/judge-probes/` (`a5-boundary-undo*.mjs` run the vendored engine directly with node;
`merge-delete.judge.test.ts` runs through the repo's test harness with `vitest.judge.config.mts`). No repo file was
modified.

| # | Claim (ownership-first) | Verdict | Evidence |
|---|---|---|---|
| V1 | v14 has never shipped, so the replicated layout may change before merge without a user migration (the v13→v14 migration stays) | **Confirmed** | `git merge-base --is-ancestor d9b7de0 master` is false. `master` is `d6c4781`. `package.json` is `0.0.11`. |
| V2 | Under stream boundaries, undoing a text delete returns the text to its block even after a concurrent split at the deletion gap (F-U4), because the engine's insert walks past zero-length tombstones and `redoItem` integrates copies between the tombstone's current left neighbour and the tombstone | **Confirmed, with a condition the base missed** | Source: `insertContent` calls `minimizeFormatChanges` (`vendor/yjs/src/ynode.js:285-297, 348`), which skips deleted items with rendered length 0 and format items equal to the requested formats. `redoItem` sets `left = item.left; right = item` (`utils/UndoManager.js:458-460`). Executed (`a5-boundary-undo.mjs`): tail `world` deleted, a peer splits the empty tail at 0, then undo. Result `["hello ",{s:t},"world",{s:u}]`: the text returns to `t` on both replicas, in both the sequential and the concurrent order. **Condition** (`a5-boundary-undo-marks2.mjs`): when the deleted text sits at the head of a longer marked run, the run's opening format item stays live. A boundary inserted with `{}` then stops before that live format item, and the undo copy lands in `u` (`[{s:t},{s:u}],"world tail"`). Inserted with the marks of the first live character to its right (`{bold:true}`), the boundary passes the format item and the tombstones, and the text returns to `t`. **Rule adopted (§2.1):** a boundary atom is inserted carrying the formats of the first live character at the split point. **Correction to representation-first M12, deletion-first R1/D-1 and the crdt reader's A-5:** this corner is not a forced semantic change. |
| V3 | The per-commit change record already carries what render cells need | **Confirmed (shape), exactness still to prove** | `DocChange` = `{origin, local, version, added, removed, moved, meta, content, order}` (`crdt/edytor-doc.ts:470-497`). Shape alone does not prove it is exact, so the current `diffSnaps` stays as the oracle (§9). |
| V4 | Plugin hooks run on every nested sub-step, and `prevent()` throws through a transaction that cannot roll back | **Confirmed** | `runOperation` (`block/block.utils.ts:130-172`) runs `onBeforeOperation` on every call. The `PreventionError` is "deliberately not caught". The body runs in `edytor.transact`, which joins an enclosing transaction (engine fact E3: no rollback). A dispatcher that consults hooks once, before opening the transaction, is therefore required, not a matter of style. |
| V5 | Two history restorers race | **Confirmed** | `events/undoRestore.ts:22-66` (`runHistoryCommand`, id/path snapshot) runs next to the selection's `stack-item-popped` handler (`selection/selection.svelte.ts:998`). |
| V6 | Default-block rules are pure functions of the parent type, so they can be adopted as data | **Confirmed** | `RichTextPlugin.svelte:82-92` (list parents → `list-item`, else `edytor.defaultType`) and `CodePlugin.svelte:106-110` (`code`/`codeLine` → `codeLine`). |

Findings the base proposal (and representation-first) missed:

- **X1: G8 fails over merge claims today, on both paths.** Setup: `[a "aa", b "bb", c "cc"]`, merge `b` backward into `a`, then delete `a`.
  - View `removeBlock` leaves `["b:", "c:cc"]`: the merged-away block reappears, empty.
  - Headless `facade.deleteBlock` leaves `["b:bb", "c:cc"]`: the deleted text reappears.

  The cause is that a claim held by a deleted block is inert. The merged block then owns itself again. Neither "a deleted block hides its stream" (ownership-first, representation-first) nor view-side tombstoning covers this case. Deletion-first's rule does. **Rule adopted (§1 R3):** deleting a block also deletes, in the same transaction, every block it currently displays through merge claims (transitively). A merge concurrent with the delete stays voided (ST02b), because the merged block was not displayed at delete time.
- **X2: Svelte 5.55.1 does not enforce `flush_sync_in_effect`.** The error is defined (`svelte/src/internal/client/errors.js:255`), but nothing in the installed Svelte calls it. `flushSync` (`reactivity/batch.js:797`) has no effect-context guard. The render bracket's real risk is re-entrancy and ordering, not a thrown error. It gets a dev assertion ("host mutated outside a bracket") and a test (§8, §9).
- **X3:** `src/lib/utils/jsx.ts` has no importer (dead). There are 18 `flushMirror(` references in `src/lib`.

---

# The unified plan

Base: ownership-first (five owner contexts, contingency-backed numbers, parallel spike for the stream representation).
Grafts are marked **[RF]** (representation-first), **[DF]** (deletion-first) and **[J]** (judge finding with a probe).

## 1. The few necessary facts and rules from which the behavior follows

### 1.1 Platform facts (not ours to change)

- **Engine (vendored Yjs v14).**
  - The engine replicates sequences, attributes and relative positions.
  - It has no move primitive and never rolls back a transaction.
  - Undo re-creates deleted items as *new* items. They are linked only by a local `redone` pointer, and each is integrated between the tombstone's current left neighbour and the tombstone.
  - An insert walks past zero-length tombstones, and past format items equal to its own formats, before placing content [J].
  - Every transaction exposes its changed set.
  - The wire encoder replaces lone surrogates.
- **Browser.**
  - The browser writes the DOM itself for IME, Android, spellcheck and autocorrect input.
  - Every programmatic selection write echoes back as an asynchronous `selectionchange`.
  - Mutation records carry no provenance.
  - The IME owns the text node it composes into.
  - Some engines skip or misreport `beforeinput` for structural keys.
- **Svelte 5.55.**
  - DOM writes are batched after the synchronous block.
  - A keyed `{#each}` reuses DOM by key, and `{#key}` destroys it.
  - `flushSync` forces the pending flush. The installed version does not guard it against effect context [J], so correctness of the render bracket rests on our own discipline.

### 1.2 The rules

Each rule is one sentence, is owned by one context (§2.3), and is cited by every deletion in §5 that it justifies.

| # | Rule | Owner |
|---|---|---|
| **R1** | **One writer per store.** Only the listed writer may write each store: the replicated document is written only by Document operations, the editable DOM only by the Surface renderer, the DOM selection only by the Surface projector, a presence entry only by the view that minted its key, and persisted rows only by the Transport's append-only store. | all |
| **R2** | **Streams are delimited by boundary items.** A block's own text runs from its boundary item, or from index 0 of its own backing text, to the next live boundary item. The rules on boundary items: a split inserts one boundary carrying the formats of the first live character at the split point [J]; no content delete ever removes a boundary; a boundary whose nonce does not match its block's record is inert. As a result, the block that owns a text position is a pure function of replicated items and is never re-decided by a contest, a rewrite or a repair. | Document |
| **R3** | **Deletion wins and deletes what the block displays** [DF][J]. A block is visible iff it is not deleted, owns itself (no live merge claim routes it elsewhere) and has a visible display parent. Deleting a block also deletes, in the same transaction, every block it currently displays through merge claims (transitively). A deleted block hides its stream and its subtree, including anything inserted into them concurrently. | Document |
| **R4** | **Positions that outlive a synchronous turn are anchors.** Within one document version, a position is *(block id, display offset)*: UTF-16 units, with an inline atom counting 1. Anything held across an await, a render, a commit or the wire is an anchor: one item plus a side. Numeric offsets, text-segment identities, wrapper references and DOM nodes are never stored as positions. | Document (codec), Session (holders) |
| **R5** | **Semantics are adopted once and each is answered by one predicate.** This covers: block roles (void, island, renders-own-content), the default child type per parent type, targetability, structural permission and document order (one pre-order over visible blocks; island sealing is a *policy* applied by the operation that needs it, not a different order [DF]). Asked in advance (an affordance) or at execution, each gives the same answer. | Document |
| **R6** | **Effects are observed, not predicted.** A document operation validates before its first write and reports `refused`, `noop` or `applied`, with the ids and position it produced. Publication, attribution, render patches and undo capture all derive from one fold of the transaction's own change set. | Document |
| **R7** | **One command, one dispatcher.** Every mutation a view makes is a command value run by that view's dispatcher. The dispatcher alone applies permission (readonly, document writability) and extension vetoes. It consults each extension hook once, on the user-level command, before any write; `prevent()` keeps its signature and is caught there, exactly once [DF]. It then runs exactly one transaction, applies the undo-step policy and returns the selection the command intends. Commands receive the selection value as an argument and never read ambient state [DF]. | Session |
| **R8** | **One occurrence, one attempt; one composition, one ending.** Each input occurrence opens at most one attempt. Its intent, anchored target and owner (model or browser) are fixed at admission. A composition is a session whose region is two anchors. Its preview writes are mechanical: they bypass hooks and are never an undo step. It ends exactly once, in one commit or one cancel. | Session |
| **R9** | **The selection is a value.** It is one of: none; a text range of two anchors with optional pending marks; one inline atom; a set of block ids. It is replaced only by `select()`, which advances the selection epoch and applies every side effect once. Positions, covered blocks, flags and marks are projections of *(value, document version)*. | Session |
| **R10** | **Display is a projection of the current value.** Only the projector writes the DOM selection. It always writes the current value, only when the target is mounted, and never over foreign focus. It classifies each observed `selectionchange` as echo, drift, composition noise, foreign write or user intent. It does this by comparing against its last display, the render epoch and the gesture serial, never with timers. | Surface |
| **R11** | **The editable host holds only model content.** Every node inside the contenteditable host is model text or core-rendered structure whose presence is a pure function of the model. Chrome (handles, menus, drop indicator, remote carets, range highlights) lives in an overlay outside the host. The placeholder is an attribute. | Surface |
| **R12** | **Own renders are never input.** Document changes render inside a bracket. The bracket first hands pending mutation records to the observer, then applies and flushes, then discards the records its own flush produced. Every record that reaches classification was therefore made by the browser or by a foreign script. | Surface |
| **R13** | **Channels prove their generation; opening never overwrites.** A replica integrates bytes only from a frame or container proven to carry its own engine, wire and schema generation. A document seeds content only when it is empty, only after every attached provider has settled or its bound has elapsed, and only under fresh ids [DF]. No view holds a stand-in for a document block. | Transport + Document |

### 1.3 Behavior that follows

| Required behavior (contract / pin) | Follows from | What it replaces |
|---|---|---|
| Typing at a block's start, end or empty display lands in that block (R8 crdt, ownership-regression A/B) | R2 | per-keystroke claim rewrites, empty-display revive, right-edge rival claim (68 B/keystroke at a seam) |
| A caret at a split-born block's start stays there when the neighbour receives text at the shared gap (anchor rule 1, `にHello`) | R2, R4 | the `a ≤ -2` + `o` owner facet, emission offset, outward scan |
| Undo returns deleted text to the block that displayed it, on every replica, in one update, even after a concurrent split at the gap (R16; A-5) | R2 + engine `redoItem` + the boundary-format rule | the undo repair transaction, the redone-space contest, the second wire update |
| Deleting a block hides everything it displays: split-tail text typed concurrently, and blocks merged into it (G8, `conc.delete-wins-block`) | R3 | view-side tombstoning in `removeBlock`; also fixes the headless and concurrent leaks (P3/P3b) and the merge-then-delete resurrection (X1) |
| Structural permission is the same when asked for a drop affordance and when the move executes (G6) | R5 | view re-derivation (`blockMove`, `insideIsland`, range-delete branches); fixes P1, P2 |
| Enter at the start, middle or end of a list item creates a list item (G5) | R5 | two default-type rules and an implicit caret-derived argument (P10, P12) |
| A veto never half-executes a command; a hook error surfaces and the command stays atomic (R13 crdt, A.1) | R6, R7 | seven `PreventionError` catch sites and the hotkey catch-all; fixes P11, P11b, `prevent-midway` |
| One user action is one undo step, and undo restores the caret only in the issuing view (G12, G13, H1) | R7, R9 | 20 `stopCapturing` sites, two restorers (C1/P4), the snapshot queue |
| A deferred caret write never overrides a newer gesture (W1; delete contract "Selection ownership") | R10 | 16 staleness mechanisms, 8+ mount-wait loops |
| A foreign programmatic selection is adopted, not reverted (O1) | R10 | "no gesture ⇒ drift" (probe C4) |
| The IME's node is never re-rendered; the commit replaces exactly the preview, once; plugins see one insert (G18, `composition*.spec`, probe `ime-plugins`) | R8, R11, R12 | three region encodings, nine reset sites, two cancel semantics, hooks on preview replays |
| Browser-owned input is adopted exactly once; drift around model-owned input is reverted (`mobile-beforeinput.spec`) | R8, R12 | seven flags, four timers, two adopters |
| The placeholder shows only for the lone empty text of an empty block, never twice (`placeholder-repair.spec`) | R11 | observers, sweeps, a six-phase repair queue |
| A peer's caret follows edits and disappears with its view (G20–G23) | R1, R4 | three wire encodings, owner registries, destroyed-view sweep |
| Opening a room never duplicates or erases its content, and the first client is usable (G9–G11) | R13 | two-round settle window, reserved-id seed overwrite, 50 ms poll (P4, P4b/c, P6) |
| Readonly forbids mutation but keeps selection and copy (R10 ui, O6) | R7 (permission), R9 (capability) | seven readonly checks in controllers |

## 2. Authoritative representations and derived views

### 2.0 What the maintained structures actually describe [RF]

Today the runtime maintains all of the following:
- a replicated tree, with a mirror tree of stateful wrappers beside it;
- five id/node → wrapper registries;
- a 30-field selection object;
- three encodings of a caret on the wire, and three encodings of a composition region;
- anchored slice records with a per-atom contest;
- two history restorers;
- mutation-record liveness heuristics.

All of it describes **five things**:
1. **The document.** Replicated, durable.
2. **Local history.** The engine stacks, plus the selection each step started from.
3. **Per-view intent.** The selection value, the open input attempt and the composition session.
4. **Presence.** One entry per view.
5. **Storage and transport.** Rows, container records, provider sessions and the migration lock.

Everything else is a cache with one owner or a pure function of these five.

### 2.1 The replicated document (stored once; only writer: Document operations)

```
doc.get('blocks')                    registry: blockId → Node          (never replaced; ids never reused)
  attrs   type, data, del?, n        n = incarnation nonce, random at creation
          at: {"<seq>.<client>": {p, r}}   placement candidates, atomic parent+rank (unchanged)
  content → backing text             created lazily; a split-born block never needs one
      characters (+ format items)    typed text; never moved or copied
      Node('inline'){id,type,data}   inline atoms (unchanged)
      {s: blockId, n}  embedded      BOUNDARY ITEM, length 1, never displayed:
                                     "block s's stream starts right after me"
  claims  → [{m: blockId}]           ordered merge claims (the {t,s,e,g} slice records are gone)
doc.get('meta')                      generation stamp {v, schema}
attribution roots                    b/<id>, u/<actor>, lineage ring (product feature, unchanged)
```

- **Stream.**
  - A fresh block's stream runs from index 0 of its own backing text.
  - A split-born block's stream starts right after its live boundary item.
  - Either stream ends at the next *live* boundary item in the same text, or at the end of that text.
  - A boundary item is live iff it is not tombstoned and its `n` matches the registry nonce of its block id. The nonce settles concurrent same-id creation (A-2).
- **Display.** `display(b) = stream(b)`, followed in claim order by `display(m)` for each merge claim `{m}`. It is empty if `b` is deleted, and hidden if a live claim routes `b` elsewhere. Owner resolution over claims (max-stamp claim, cycles, "a claim held by a deleted block is inert") is today's `computeOwners` graph, kept unchanged.
- **Split `b` at display offset k.**
  - `locate(b, k)` gives (backing text, index).
  - Insert one boundary item there, **carrying the formats of the first live character at or after the split point** [J]. The engine's format-minimizing walk then carries it past equal format items and past tombstones. Without this, a concurrent-split-then-undo sends restored text into the new block (probe `a5-boundary-undo-marks2`).
  - Move the merge claims that follow k to the new block.
  - Write the new block's record and placement.
  - All of this happens in one transaction, and nothing is copied.
- **Merge `c` into `b`.** Append `{m: c}` to `b`'s claims. As today, deleting `c` hides its text, and a concurrent delete of `b` voids the claim.
- **Delete `b`** [DF][J].
  - Set `del` on `b` and on every block `b` currently displays through claims, transitively. This is the correctness fact: G8 plus the merge-then-delete case X1.
  - In the same transaction, tombstone the content items (never the boundary items) of those streams. This is for storage only: dead text should not stay live forever. Undo re-integrates those items in place (verified mechanics, V2).
  - A peer's concurrent insert into a dead stream stays hidden, because its block is dead.
- **Content writes.**
  - The per-stream delete is the only content delete path, and it never removes a boundary item (A-1).
  - Every range read skips boundary items. This is one predicate, in the range reader.
  - Typing at a stream's start inserts after its boundary; typing at its end inserts before the next boundary. The engine's walk and the caret affinity choose the side. Nothing is repaired afterwards.
- **Undo of a text delete.** The engine integrates each copy between the tombstone's current left neighbour and the tombstone, which is inside the same stream (V2). It is one update with no repair.
- **Anchors.** `{b, a}` is the home text id plus an engine relative position. A left-affine caret at a split-born block's start binds that block's boundary item:
  - text inserted at the predecessor's end lands before the boundary, so the caret stays;
  - text inserted at the caret lands after it.

  Gap ownership and affinity are two separate facts: the containing stream, and the anchor side.

Pre-merge `v14-schema-1` documents exist only in development (V1). The v13→v14 migration imports JSON, so it targets
this layout unchanged. Development documents are re-imported from JSON; no converter is kept in `src/lib`.

### 2.2 Local authority (not replicated, not derivable)

| # | State | Only writer | Lifetime | Category |
|---|---|---|---|---|
| L1 | Adopted semantics `{roles: type → void \| island, rendersContent: type → bool, defaultChild: parentType → type, defaultType}`, adopted from extension records and conflict-checked on every view's adoption | document adoption | document | immutable admitted meaning |
| L2 | Undo stacks (engine, scope = registry, tracked origins = view transactions) + per-item `meta: Map<viewKey, {before, after}>` of selection values (anchors only) | engine (stacks), issuing view's dispatcher (meta) | document, in memory | durable progress for the session |
| L3 | Extension definitions: kind, mark and atom records; key-binding rows; hooks | construction | editor | immutable admitted meaning |
| L4 | Selection value `none \| {text, anchor, focus, pending?} \| {atom, blockId, atomId} \| {blocks, ids}` + selection epoch | `select()` | until the next `select()` | immutable admitted meaning |
| L5 | Command value `{kind, target, payload, origin: user \| composition-replay \| remote-repair}` + result `{status, selection?, ids}` | the producer (binding, menu, attempt, extension) | one command | immutable admitted meaning |
| L6 | Input attempt `{id, intent, target (anchored), owner: model \| browser, expect?, deadline?, phase: open \| applied \| failed}` | admission | one occurrence | intent/target/owner immutable; phase/expect/deadline replaceable |
| L7 | Composition session `{host element, startTarget, marks, region: {start, end} anchors, phase}` | the session | compositionstart → commit/cancel | host = resource; startTarget/marks immutable; region/phase replaceable |
| L8 | Surface bookkeeping: `displayed = {epoch, range, renderEpoch}`, render epoch, gesture serial, attribution frame (user/programmatic), element ↔ cell `WeakMap` | projector / renderer / event adapter | one mount | replaceable + resource ownership |
| L9 | Transport: provider per *(document, transport target)*; `hasSynced` (lifetime) vs `connected` (transient); awareness instance owned by its creator; container record `{engine, protocol, schema}`; append-only rows; migration record `{status}`; migration lock | provider / container / migrator | provider or container | durable progress (rows, records) + resource ownership (sockets, timers, locks) |
| L10 | Presence entry `selections[viewKey] = {start, end, collapsed, reversed, t}` (anchors only) | the view that minted `viewKey` | the view | replaceable |
| L11 | Readiness `pending \| local \| hydrated` and the seed decision | document lifecycle | document | durable decision (once) |

Nothing else is stored as truth. In particular, none of the following exist anymore:
- text-segment ids;
- numeric caret offsets held across turns;
- `_live`/`_bound` flags;
- slice records or claim generations;
- a second freshness counter;
- a `synced` shadow flag on the view;
- a virtual first block.

### 2.3 Owner contexts and nested lifetimes

| Context | Lifetime | Authority | Mandate |
|---|---|---|---|
| **Document** | the engine doc (per-doc derived state lives exactly as long as the doc: attached once, never leased) | replicated truth + adopted semantics | the only writer of replicated state; answers every structural question once |
| **Session** | one view (mount → destroy) | this local user's intent | selection value, commands, dispatcher, attempts, composition, history snapshots, held ranges |
| **Surface** | one mounted DOM (may remount) | none over meaning; renders and observes | the only reader and writer of the editable DOM and of the DOM selection |
| **Extensions** | editor construction (immutable afterwards) | definitions | kinds, marks, atoms, bindings, hooks — each declared once, in one record |
| **Transport** | provider / container / document | channel integrity | generations, joins, persistence, presence entries, migration |

```
document (engine doc, adopted semantics, index, history, attribution, providers)
 └─ view / Session (selection value + epoch, keymap, dispatcher, held ranges, presence entry)
     └─ mount / Surface (cells, element bindings, projector 'displayed', observer, overlay)
         └─ command (value → one transaction → result)
             └─ attempt / composition (intent, anchored target, owner; host element pinned)
                 └─ render bracket (hand pending records to observer → apply → flushSync → discard own records → display)
```

An inner lifetime never owns a fact an outer one needs. Two machineries disappear because of this:
- The lease/refcount around the derived index goes, because the index lives with the doc.
- The "re-subscribe on attach" patch (`edytor.svelte.ts:828-910`) goes, because the commit subscription belongs to the Session, not to the mount.

### 2.4 Derived views (computed; never stored as truth)

| Derived view | From | Owner | Recomputed | Consumers |
|---|---|---|---|---|
| **Per-doc index**: records, stream table (live boundaries per backing text), owner map, winning placements, visible tree, children order, document order, depth/path, maintained runs per block (structurally shared), dependency sets | §2.1 + L1 | Document index | folded **once** per transaction from the engine's changed/insert/delete sets (fold cursor); mid-transaction reads fold pending entries first (read-your-writes, linear) | ops, anchors, change report, JSON export, handles |
| **Change report** `{added, removed, moved, meta, content, order, local, origin}` | the fold vs the previous committed index | Document | once per commit; nested transactions publish once; change-then-revert publishes nothing | render cells, Session (held anchors), `onChange`, remote carets |
| **Op result** `{status, ids, at}` | the fold (clock advance, located deletes, set-if-changed attrs) | Document write funnel | per op | dispatcher, attribution stamp (once per outer transaction), undo capture |
| **Selection projection** `project(value, version)` → endpoints *(block, offset)*, direction, collapsed, covered blocks and segments with sub-ranges, at-edge flags, island/void root (one rule), marks at caret (lazy), content string (lazy) | L4 + index | Session | memoized per (value, version) | commands, `selection.state` compatibility getter, toolbar, clipboard |
| **Seam of a vanished endpoint** | the replicated slot `{p, r}` of the topmost dead ancestor + visible siblings + `rendersContent` | Document anchors | per resolution | projection (remote delete, redo, cut, block-set delete — one rule) |
| **Render cells** (one per visible block id: `{type, data, childIds, runs}`) | change reports | Surface | patched only from change reports | components |
| **Segments** of a cell (text parts between atoms; text-first/last; ZWSP/newline fillers). **Key = id of the preceding atom (or `start`)**; a key pinned by a live composition stays alive until the session ends [RF] | cell runs + session | Surface (`$derived`) | per cell change | Text renderer, DOM mapping, composition pin |
| **Placeholder attribute** `data-placeholder` | cell has one empty text ∧ no live composition in it | Surface (`$derived`) | per render | CSS `::before` |
| **Handles** for plugins and hooks: id-only `Block`/`Text`/`InlineBlock` objects whose getters read the index (read-your-writes) and whose mutators issue commands [RF] | index | Session | on demand (cached by id; no registration) | extensions, normalizers, consumers |
| **Snippet view objects** (declared shape: `{type, data, selected, focused, …}` + command helpers; suggestions supply `selected: false`) | cell + selection projection | Surface | per render | extension snippets |
| **Kind catalogue** (slash commands, markdown table, HTML import/export maps, clipboard exporters, default child rules) | L3 records | Extensions registry | at construction | slash menu, markdown, HTML, clipboard, adoption |
| **Presence payload** | `serialize(L4)` | Session → Transport | on `select()` when the value changed | peers |
| **Remote caret geometry** | peer anchor → projection → Surface mapper → editor-relative rects | Surface overlay | per frame when peers or layout changed | overlay |
| **Caret-stop stream** (grapheme, word, atom, block edge, document edge) | index order + cells | Session navigation | per motion | navigation keys |
| **JSON value** | `document.toJSON()` | Document | on demand, memoized per version, skipped when unconsumed | `value` export, `onChange` |

The **four categories** the method asks to keep apart:

| Category | Where it lives | Never mixed with |
|---|---|---|
| Immutable admitted meaning | command values; attempt intent/target/owner; composition `startTarget` + `marks`; admitted clipboard flows (validated, fresh ids); adopted semantics; definitions; selection values | nothing re-reads the DOM event or recomputes a target after admission |
| Replaceable attempt state | attempt `phase/expect/deadline`; composition `region/phase`; projector `displayed`; drag placement; UI-held anchors | never persisted or put in an undo step. Replicated composition previews are the one exception. They are kept for parity (§11 D-6): mechanical writes that bypass hooks and undo. |
| Durable progress | engine doc; persisted rows; migration record; undo stacks | no lease, owner or expiry fields in durable records |
| Resource ownership | IME host element (session); DOM nodes (cells); sockets, timers, awareness (the provider that created them); `navigator.locks` lock (migration attempt); observers and listeners (mount) | releasing a resource never changes a document fact |

## 3. Ownership map: fact → owner → lifetime → consumers

Citation keys in the "Replaces" column point at the reader reports' fact tables:
- **M** runtime-model
- **C** crdt-core
- **S** selection
- **I** input-events
- **P** plugins-ui
- **T** sync-collab

"×n" is the number of places that decide the fact today. Every flagged reader fact maps to exactly one row here. A fact
that was already single-owner keeps its owner and is not repeated: rank codec, word boundary, grapheme segmentation,
node-bound provenance, goal column, pointer drag, drop placement, handle offset, platform flag, remote-apply origin.

### 3.1 Document (lifetime: the doc unless noted)

| # | Fact | Owner module | Lifetime | Consumers | Replaces |
|---|---|---|---|---|---|
| O1 | Block identity (minted by the creating op; one normalization for writes **and** lookups) | `doc/ingress` + creating op | replicated | everyone | M-F1 (5 mint sites, 3 wrapper fields), C-F20 (≥12 ingress sites), C-C11 (a normalized id is unreachable by its creator) |
| O2 | Which block displays a text position | `doc/streams` (boundary items + claims, R2) → index | per transaction | content ops, anchors, runs | C-F5 (×6), C-F17 (×2) |
| O3 | Display offset ↔ (backing text, index) | `doc/streams` `locate`/`position` (the only mapper) | derived | content ops, anchors | C-F6 (≥10 walks, 3 boundary rules), M-F5 (7 mappers + an atoms-count-0 coordinate system), S-F12 |
| O4 | Boundary insert formats = formats of the first live character at the split point [J] | `doc/streams` split | per split | split, undo placement | — (missing today; decides A-5) |
| O5 | Block is live / targetable (one predicate: not deleted ∧ self-owned ∧ every display ancestor visible) | `doc/index` `isLive` | per transaction | op preconditions, change report, anchors, Session | C-F3 (×7, disagreeing; probe C6), M-F9 (6 flags) |
| O6 | Deleting a block deletes what it displays (claims, transitively) [DF][J] | `doc/document` delete | per delete, replicated | every delete path (view, headless, remote) | M-F15 (view-only tombstoning; P3/P3b), X1 (merge-then-delete resurrection) |
| O7 | Document order (pre-order over visible blocks; island sealing is separate policy) [DF] | `doc/index` `order`, `compare(a, b)` | per transaction | range selection, range delete, block-selection extension, clipboard, drag groups, navigation | M-F11 (wrapper vs facade disagree, P1), 4 block-range walks, P-F8 (×3, one wrong: `block-extend`) |
| O8 | Structural permission (move/nest/merge across void/island/own subtree) | `doc/document` `canPlace`, `canMerge` over adopted roles | per call | DnD affordance **and** commands (same function) | M-F12 (P2: island breached by range delete), P-F5 (×6 eligibility predicates) |
| O9 | Default child type for a parent | adopted semantics `defaultChild(parentType)`, applied against the **actual** parent | document | split, paragraph insert, merge-unnest, clear, root normalize | M-F14 (view rule + flat facade rule + an implicit caret-derived argument; P10, P12), M-F16 (copy then reset) |
| O10 | Op outcome `refused \| noop \| applied`, created ids, resulting position | the transaction fold (R6) | per op | dispatcher, attribution, undo capture | C-F10 (~10 per-op predictions), C-D9, M-F6 (result shapes per op) |
| O11 | Freshness ("derived state caught up") | `doc/index` version (one counter) | per transaction | memoized reads | C-F11 (5 counters), M-F19 (4 commit counters) |
| O12 | Which blocks/facets a transaction touched | the fold over the engine's changed set | per transaction | index invalidation, change report, attribution | C-F12 (5 interpreters incl. a fake-op round trip), C-F13 (2 diff algorithms) |
| O13 | Change report | `doc/index` fold → `doc/document` publication | per commit | cells, Session, `onChange` | M-F10 (2 reconcile algorithms), M-F3 (2 live sources of `_items`) |
| O14 | Anchor mint/resolve (`pending` ≠ `dead`), seam of a dead block | `doc/anchors` | per call | selection, presence, history, composition, held ranges | S-F2 (affinity ×5), S-F19 (5 seam rules), C-F17 (`o` facet) |
| O15 | Range deletion between two positions (`del.range.*`, merges governed by `canMerge`) | `doc/rangeDelete` | per command | delete keys, typing over a range, cut, paste over a range | I-F19 (3 ladders), `deleteContentWithinSelection` (P2, P5, P9) |
| O16 | Placement of an admitted flow (inline runs + kinded blocks, fresh ids) at a position | `doc/flow` | per paste/drop/convert | clipboard, HTML, markdown, slash convert | P-F16 (×3 divergent, `paste-shape`), P-F17 (id stripping ×3) |
| O17 | Readiness and the seed decision (empty ∧ all providers settled or bound elapsed ⇒ seed with fresh ids) [DF] | `doc/lifecycle` | document | views (`ready`), history | T-F6 (4 latches), T-F8 (4 mirrors), C-F14 (×3), M-F25 (view timer) |
| O18 | Document writable (a foreign stamp was observed) | `doc/lifecycle` `writable` | document | dispatcher permission, UI | T-F25 (the transport silently drops input, P7) |
| O19 | Attribution stamp + lineage capture | write funnel, from O12's touched set, once per outer transaction | outer transaction | `b/` records | C-F22 (~20 call sites) |
| O20 | Schema / attribute names | `doc/schema` (one table) | build | all | C-F19 (2 tables) |
| O21 | Lifetime of per-doc derived services | the doc (attached once, never leased) | document | index, lineage trim, rand | C-F15 (4 policies incl. a lease) |
| O22 | Phantom content slot (block does not render its own content) | adopted semantics `rendersContent` (declared by the kind record) | document | seam, navigation, projection | M-F30 (inferred from DOM mount state) |

### 3.2 Session (lifetime: the view unless noted)

| # | Fact | Owner module | Lifetime | Consumers | Replaces |
|---|---|---|---|---|---|
| O23 | The local selection | `session/selection` value (L4) | until next `select()` | everything | S-F1 (4 constructors + 5 repairers), S-F5 (4 containers), P-F9 (2 fields) |
| O24 | Direction | the value (anchor/focus order), taken from the observation or the writer | value | commands, presence, history | S-F3 (a wrong formula ×4 + 3 inferences; probe C6) |
| O25 | Side effects of a selection change | `select()`: focused/selected sets + hooks + attributes (rendered inside the bracket), one `onSelectionChange`, presence publish | per write | UI, plugins, peers | S-F13 (7 writers, 5 side-effect sets; C2, C3), S-F20 / T-F15 (5 equality decisions) |
| O26 | Pending marks at a collapsed caret (values kept, not only `true`) | the value (`pending`) | until the caret moves or text is inserted | insertion | M-F7 (stored on a segment wrapper and migrated), I-D12 |
| O27 | Marks of an inserted run: explicit → pending → common-of-replaced → neighbour before, else after → mark edge policy | `session/editing/text` `marksForInsertion` | per insertion | typing, IME commit, paste, adoption, soft break | I-F5 / M-F8 / P-F6 (×8, 3 divergent rules; `mark-inherit`) |
| O28 | Permission, hooks, transaction, undo step, result selection of a command | `session/commands` dispatcher | per command | every mutation | P-F12 (14 caret writers, 6 timing policies), P-F13 (20 `stopCapturing`), P-F15 (7 catch sites), P-F29 (readonly ×7), I-F14 (×9) |
| O29 | Undo/redo selection per view `{before, after}` | dispatcher records; `session/history` restores in the issuing view via `select()` | stack item | issuing view | S-F18 (2 restore pipelines; C1), M-F18 (P4) |
| O30 | Intent, target and owner of an input occurrence | `session/attempt` (one inputType/key → intent table) | per occurrence | commands, Surface observer | I-F1 (×7), I-F2 (×8), I-F15 (6 flags + 4 timers), I-F16, I-F17 (7 fabrication sites), M-F24 |
| O31 | Composition region, host, phase, captured marks | `session/composition` | compositionstart → commit/cancel | preview, commit, cancel, render pin | I-F6 (7 writers, 3 representations), I-F7 (9 reset sites), I-F8 (commit ×4, cancel ×2 divergent), M-F21, M-F22 |
| O32 | Ranges held by UI across think-time | `session.hold(range)` → anchors | until the UI closes | slash menu, toolbar, link editor | P-F23 (numeric second owners; `stale-offsets`) |
| O33 | Key-binding precedence (consumer > extensions in list order > built-ins; first claim wins, returned not thrown) | `session/keymap` | editor | keydown | P-F14 (5 precedence rules), I-F22 (keydown handled twice) |
| O34 | Relative block move (up/down/in/out) | `session/moves` → `doc.moveBlocks` | per command | hotkeys, handles, drag, menus | P-F22 (4 vocabularies; `move-down`) |
| O35 | Paste/drop payload precedence (fragment → extension claim → files → uri-as-link → plain) | `session/editing/clipboard` (one ladder) | per paste/drop | transfer adapters | I-F21 (×3) |
| O36 | "A range covering exactly one inline atom is an atom selection" | `session/selection` normalization of every candidate value | per value | inline-atom UX | S-F21 (DOM rule, model rule, pointerup inverse, navigation) |
| O37 | Caret after removing a selected atom | one atom-removal command | per command | Backspace/Delete/printable | P-F10, P-F11 (×2) |
| O38 | Where an operation applies | the command's explicit target (commands never read ambient selection) [DF] | per command | ops, plugins | M-F32 (`deleteText` always uses the caret offset; implicit `getDefaultBlock` argument) |
| O39 | Vertical goal column | `session/navigation` | consecutive vertical moves | navigation | single today (kept) |

### 3.3 Surface (lifetime: one mount unless noted)

| # | Fact | Owner module | Lifetime | Consumers | Replaces |
|---|---|---|---|---|---|
| O40 | Which DOM element *is* block X (tag from `definition.element(data)`; snippets render inner markup) | core `Block.svelte` | mount | DOM mapping, handles, drop targets | P-F1 (×3+, `code-attach`), P-F2 (heading re-key in core) |
| O41 | Render state of a visible block | `surface/cells` (patched only from change reports) | block visible lifetime | components | M-F10 (mid-transaction mirror), M-F28 (eager copies) |
| O42 | Segment boundaries and segment keys (key = preceding atom id; pinned while composing) [RF] | `surface/cells` `segments(runs, session)` | per runs | Text renderer, DOM map, pin | M-F2 (positional ids ×3, aliases, deferred rename), M-F4 (`deriveContentParts` + `groupContent`), S-F26 |
| O43 | DOM point → *(block, offset)* (one interpreter; modes *settled* / *DOM ahead of model*; element-boundary rules only between text elements) | `surface/domPoint` | per read | observation, admission, adoption, paste, drop | S-F10 (≈6 interpreters, 5 overlay mappers; C5), I-F3 (×3) |
| O44 | *(block, offset)* → DOM point | `surface/domPoint` | per write | projector, remote carets | S-F11 / T-F24 (×2) |
| O45 | Writing the DOM selection | `surface/projector` | per flush / select / mount | browser | S-F14 (16 staleness mechanisms), S-F17 (≥8 mount-wait loops), I-F13 (11 cadences) |
| O46 | Classifying a `selectionchange` (echo / composition / drift / foreign / intent) | `surface/projector` classifier (≤ 2 named gesture-carrying signatures) [RF] | per event | Session | S-F15 (17 flag setters + 5 classifiers; C4) |
| O47 | Focus verdict (foreign control vs orphaned `body`) | `surface/projector` (one predicate) | per write | projector | S-F16 (3 verdicts) |
| O48 | Scroll permission | `surface` attribution frame (user / programmatic) | per write | projector | M-F23 (2 counters) |
| O49 | Render epoch | `surface/observer` render bracket | monotone | classifier (drift) | missing today (conflated with gesture) |
| O50 | Gesture serial | `surface/events` (real pointer/key input only) | monotone | classifier | spread over input handlers |
| O51 | Provenance of a mutation record | `surface/observer` render bracket (R12) | per flush | observer | I-F9 (liveness inferred by 2 predicates), I-F10 (2 identity routes), I-F11 (renderer knowledge restated in spec tables) |
| O52 | Adopt or revert an observed text change | `surface/observer`, by location + the open attempt's owner; adoption by common prefix/suffix only | per record batch | Session commands | I-F15 / I-F16 (two adopters ordered by timers), I-C4 (harmful diff) |
| O53 | Placeholder visible | `Text.svelte` `$derived` → `data-placeholder` | per render | CSS | I-F12 / M-F27 / P-F4 (×9) |
| O54 | Overlay geometry (handles, menus, indicator, remote carets, range highlights) | `surface/overlay` (one measure per frame, editor-relative coordinates) | per frame | chrome | P-F24 (4 loops), T-F12 (dead invalidation counter), G24 (no scroll handling) |
| O55 | Is this event the editor's (DOM facts) | `surface/events` `admit(event)`; the Session decides permission | per event | Session | I-F18 (≥11 sites, inconsistent subsets) |
| O56 | Is the DOM out of sync with the render tree? | **no detector**: cells change only from change reports (R1); foreign damage is reverted by the observer (R12) | — | — | M-F26 (4 heuristics incl. whole-editor `{#key}` remounts; `tab-remount`) |

### 3.4 Extensions (lifetime: editor, immutable)

| # | Fact | Owner | Consumers | Replaces |
|---|---|---|---|---|
| O57 | Everything about a block kind: element choice, renderer, role, `rendersContent`, `defaultChild`, HTML import/export, markdown prefix, command row (label, icon, keywords), empty shape | one **kind record** in the defining extension | adoption, Surface, clipboard, slash, markdown | P-F19 (×3 tables), P-F20 (×6 catalogues), P-F21 (code-block shape ×2) |
| O58 | Everything about a mark: renderer, HTML forms, value sanitizer, binding, edge policy (inclusive or not) | one **mark record** | Surface, clipboard, `marksForInsertion` | P-F25 (sanitizers ×3), the link-edge rule in a snippet |
| O59 | Precedence of duplicate definitions (first wins, as the README states) | extensions registry | all registries | P-F14 (definitions last-wins vs everything else first-wins) |
| O60 | Block-drag MIME | one constant | handles, drop admission | P-F28 (×2) |

### 3.5 Transport (lifetime: provider / container / document)

| # | Fact | Owner module | Lifetime | Consumers | Replaces |
|---|---|---|---|---|---|
| O61 | Bytes are of a compatible generation (engine + wire + **schema**) | `sync/envelope` per frame, `sync/container` per container | frame / container | every integration | T-F3 (staging ×3), T-F4 (8 re-evaluations), T-F2 (2 stamp rules) |
| O62 | Provider has ever synced / is connected / failed once | `sync/room` shared lifecycle | provider | document readiness, UI | T-F5 (merged; P1), T-F7 (provider + document re-decide) |
| O63 | Providers attached to a document | document registry keyed by **transport target** | document | views | T-F9 (keyed by factory identity; P8) |
| O64 | Join handshake (on a peer Step1: reply Step2(diff) and, if the peer holds what we lack, our own Step1) | `sync/room`, shared by channel and socket | per join | convergence | T-F10 (push vs pull; P5, P6) |
| O65 | Presence entry (one encoding: anchors) | the view that minted `viewKey`; `sync/presence` | view | peers | T-F13 (3 encodings), T-F14 (owner registries + sweep) |
| O66 | Stored-row key discipline (append-only for every writer) | `sync/container` | container | hydration, compaction, migration | T-F17 (key-0 overwrite vs append; P3/P3b) |
| O67 | Migration attempt vs progress | attempt = `navigator.locks` lock (resource); progress = import row + `active` record in one transaction | lock: tab; record: container | boot | T-F18, T-D7 (lease/owner/poll in the durable record) |
| O68 | Legacy logical-id normalization | one pass + the canonical JSON → spec converter | migration run | rebuild, verify | T-F19 (×3 converters) |
| O69 | Frame header (version word + type) | one `frame(type, write)` helper | per frame | all writers | T-F1 (hand-repeated at 12 sites) |

### 3.6 Open (no owner decides it yet)

| # | Fact | Status |
|---|---|---|
| O70 | Reading order of concurrently split siblings (16/40 client pairs misorder today, crdt C1) | R2 makes it *decidable*, because boundary order in the backing text is replicated, but choosing a placement rule that uses it is a separate design task. It is tracked (F-D11), not gated. |
| O71 | Concurrent `delete(p)` ‖ `move(child of p → root)` (crdt C5) | A product decision (rescue vs delete-wins-subtree). Unchanged by this plan. |

## 4. Module / layer map of the new `src/lib`

**Dependency direction** (enforced by lint import rules):
- `vendor/yjs ← doc ← sync`.
- `doc ← session`. Session never touches the DOM.
- `doc, session ← surface`. Surface is the only module that touches the DOM.
- `plugins` declare records, contribute Session commands and Surface overlay components, and receive handles.
- `edytor.svelte.ts` composes the whole thing.

**Prohibitions** [DF]. These carry the invariants, so they are checked in review:
- `doc/` never reads view state and never writes outside a validated op.
- `session/` never touches the DOM, never awaits, and never reads ambient selection.
- Only `surface/projector` writes the DOM selection.
- Only core components create, remove or re-render nodes inside the editable host.
- Only `surface/observer` interprets DOM mutations.
- Only `session/composition` holds composition state.
- `surface/observer` stays kind-agnostic. Code that teaches it about a specific block, mark or atom type violates R12.

Estimates are execution xloc with the shared counter. They include the per-domain contingency of §7.

### 4.1 `doc/` — Document context (≈ 4,520)

| Module | Responsibility (one line) | Rules | xloc |
|---|---|---|---|
| `doc/schema.ts` | One schema-name table, stamp gate reads, typed errors, `assertUsableDoc`, admission verdict + staged `admitUpdate` (only for bytes of unknown provenance: `loadDocument`, `attachDocument`) | R13 | 133 |
| `doc/rank.ts` | Rank codec for placement (digits + client tie-break, bounded append window) | — | 110 |
| `doc/placement.ts` | Candidates, atomic `{p,r}` writes, top-2 compaction, acyclic resolution, rehome; spec materialization, bulk insert, id-collision refusal; canonical `project` | R5, R6 | 507 |
| `doc/streams.ts` | Backing texts with boundary items (insert carrying the split point's formats); stream table; merge claims + `owner()`; `locate`/`position`; content ops (insert, validated right-to-left per-stream delete that never removes a boundary, format, inline atom by id); split = boundary + claim move | R2, R6 | 710 |
| `doc/index.ts` | The one per-doc derived index, folded once per transaction (fold cursor): records, streams, owners, placements, children order, document order, `isLive`, maintained runs with structural sharing, dependency capture, commit-bound publication with listener isolation | R5, R6 | 665 |
| `doc/document.ts` | The facade: structural and metadata ops with void/island/`defaultChild` policy, **delete with claims**, all-or-nothing `setBlock`, duplicate, `toJSON`, write funnel (touched set, attribution, lineage capture at first touch), change report (one algorithm), undo-manager factory | R1, R3, R5, R6 | 825 |
| `doc/anchors.ts` | Anchor codec (mint at *(block, offset, affinity)*; resolve → *(block, offset)* \| `pending` \| seam); seam from the dead block's replicated slot with editable descent | R4 | 67 |
| `doc/rangeDelete.ts` | Range deletion between two positions per `del.range.*`, merges governed by `canMerge` | R5, R6 | 110 |
| `doc/flow.ts` | Place an admitted flow (inline runs + kinded blocks, fresh ids) at a position: split, insert, join the trailing run, replace an empty target, collapse a block selection to a target first | R6 | 70 |
| `doc/ingress.ts` | JSON boundary: clone + dev warning, wire sanitize (lone surrogates), spec converters, fresh ids; one normalization for writes and lookups | R1 | 190 |
| `doc/lifecycle.ts` | Document references and dedupe; semantics adoption (roles, `rendersContent`, `defaultChild`) with atomic conflict refusal; readiness (seed only when empty, after every provider settled or its bound elapsed, fresh ids); `writable` guard over the meta root; provider registry keyed by transport target; owned/borrowed teardown | R5, R13 | 508 |
| `doc/attribution/*` | Per-block created/contributors/last-changed, incarnation stamp, lineage ring with convergent trim, actor dictionary (product feature) | R6 | 376 |
| `doc/handles.ts`, `structs.ts`, `engine-api.ts`, `rand.ts`, `public.ts` | Typed headless block handles (the documented `document.block(id)` API); two vendor-store walks; structural engine typings; rank randomness seam; public barrel (documented API only) | — | 247 |

### 4.2 `sync/` — Transport context (≈ 1,840)

| Module | Responsibility | Rules | xloc |
|---|---|---|---|
| `sync/envelope.ts` | Generation word (engine, protocol, schema) per frame; container generation record; `frame(type, write)` helper | R13 | 35 |
| `sync/sync.ts` | Step1/Step2/Update codecs, remote origin, `applyRemote(doc, update, origin, onError)`, state-vector coverage test | R13 | 54 |
| `sync/awareness.ts` | Presence protocol (verbatim; the engine has none) | — | 223 |
| `sync/auth.ts` | Permission-denied read | — | 15 |
| `sync/room.ts` | Shared provider lifecycle (`hasSynced` vs `connected`, failed-once, `whenSynced`, departure announcement, destroy guard); one join rule for channel and socket; frame dispatch | R1, R13 | 150 |
| `sync/container.ts` | IndexedDB container: store names, row codec, one verify-or-stamp rule, non-creating open, existence probe, append-only rows | R1, R13 | 56 |
| `sync/indexeddb.ts` | Hydration (verify → getAll → one apply transaction), append, debounced compaction, commit-tracked `storeState` | R1 | 235 |
| `sync/websocket.ts` | y-websocket option parity: status events, backoff, liveness, auth, optional resync timer (loss healing, no longer a correctness dependency) | — | 347 |
| `sync/index.ts` | `createIndexeddbSync` / `createWebsocketSync` factories exposing a transport-target key | — | 54 |
| `sync/presence.ts` | One entry per view key (anchors + collapsed/reversed); publish/clear by the owning view; freshest-per-client; resolve remote anchors (or paint nothing) | R1, R4 | 274 |
| `sync/attach.ts` | Attach providers to a document, deduped by transport target; readiness wait = one subscription | R13 | 20 |
| `sync/migration/*` | v13 layout reader; migration with `navigator.locks` attempt ownership; append import row + `active` record in one transaction; `force` as a replace-edit; rollback | R1, R13 | 349 |
| `collaboration/*.ts` | Public re-export shims for the documented import paths | — | 28 |

### 4.3 `session/` — Session context, DOM-free (≈ 3,180)

| Module | Responsibility | Rules | xloc |
|---|---|---|---|
| `session/selection.ts` | `SelectionValue`; `select(value, cause)` with epoch and every side effect once; `project(value, version)`; single-atom normalization; value builders behind the public write API (`setAtTextOffset`, `setAtRange`, `selectBlocks`, …); `selection.state` compatibility getter; `hold(range)` anchors | R4, R9 | 340 |
| `session/history.ts` | Record `{before, after}` per view on `stack-item-added/updated`; restore in the issuing view only, through `select()` | R7, R9 | 63 |
| `session/commands.ts` | Dispatcher: permission (readonly, `document.writable`) → hooks once on the user-level command (`prevent()` caught here, once) → one transaction → normalization once per touched parent (bounded passes) → undo policy (text insertion coalesces, everything else cuts) → result selection; command vocabulary | R7 | 278 |
| `session/handles.ts` [RF] | Plugin-facing `Block` / `Text` / `InlineBlock` handles: id-only, getters read the index (read-your-writes), mutators issue commands; a JSON-accepting `insertChildren`/`insertParts` shim | R1, R7 | 290 |
| `session/editing/text.ts` | Insert text with `marksForInsertion`; grapheme/word/line units; soft break; mark/format commands over projected segments; public `splitText`/`setText` | R4, R7 | 341 |
| `session/editing/structure.ts` | Paragraph (split, insert-before at start, lift content above children), collapsed delete ladders per the delete contract, atom removal/replacement, nest/unnest, convert, suggestion accept/dismiss, range replacement | R5, R7 | 482 |
| `session/editing/clipboard.ts` | Copy/cut (clipboard written before the delete), paste/drop payload ladder, fragment extraction from the selection projection | R7 | 150 |
| `session/attempt.ts` | One inputType/key → intent table (incl. misreport overrides); attempt lifecycle (owner, anchored target, expectation, deadline, `failed` phase); keydown fallback; Android no-op-Backspace deadline tested against the anchored atom | R4, R8 | 472 |
| `session/composition.ts` | Session: start (target + marks captured), `preview` (mechanical write, no hooks, no undo step), `commit` (one user-origin command, idempotent across commit signals), `cancel` (one decision), phantom-key guard, idle/dangling policy | R4, R8 | 190 |
| `session/keymap.ts`, `session/bindings.ts` | Registry, canonical chord encoding, platform/AltGr/dead-key/layout rules, one precedence rule; built-in bindings as rows (undo/redo, Tab, select-all ladder, block-selection keys, Emacs table) | R7 | 300 |
| `session/navigation.ts` | One ordered stream of caret stops + word stepping + block/document boundaries; one apply step; node-bound extension canonicalization; RTL; bindings as data | R9 | 230 |
| `session/moves.ts` | Relative move (up/down/in/out) → `(target, position)` → `doc.moveBlocks`; capability via `canPlace` | R5, R7 | 40 |

### 4.4 `surface/` — Surface context, the only DOM toucher (≈ 4,050)

| Module | Responsibility | Rules | xloc |
|---|---|---|---|
| `components/*.svelte` (`Edytor`, `Block`, `Content`, `Text`, `Mark`, `InlineBlock`) | Generic recursive render. `Block` renders the block element from the definition and snippets render inner markup. `Text` renders segments with fillers and the `data-placeholder` attribute. Root attributes are declarative. | R11 | 304 |
| `surface/suggestions.ts` | Ghost-text view objects from plain JSON (declared shape, no Proxy) | R11 | 25 |
| `surface/cells.ts` | One reactive cell per visible block id, created/disposed/patched **only** from change reports; segments with causal keys; atom cells (edge-click caret placement); render deltas with equal-mark merging; snippet view objects | R1 | 560 |
| `surface/pin.ts` | IME host pin: freeze the base render and splice the preview while the session owns `host` | R8 | 55 |
| `surface/domPoint.ts` | One DOM-point interpreter (element boundaries, stray nodes, fillers; modes *settled* / *DOM ahead of model*), one model → DOM mapper, shadow roots, multi-range and composed ranges, UTF-16 boundary normalization | R4 | 542 |
| `surface/projector.ts` | `display()`: the only DOM-selection writer (current value, mounted target, focus predicate, dedupe, backward ranges, scroll only in a user frame); `displayed` + render epoch; the `selectionchange` classifier (≤ 2 named gesture-carrying signatures) | R10 | 647 |
| `surface/pointer.ts` | Hit testing, triple click, drag across atoms, click-into-block-selection collapse, `selectstart` guard | R10 | 200 |
| `surface/geometry.ts` | Visual lines for vertical navigation | — | 108 |
| `surface/observer.ts` | Render bracket (hand pending records to the observer → apply → `flushSync` → discard own records → display; dev assertion on host mutation outside a bracket); classification by location and the open attempt's owner; adoption by common prefix/suffix; revert by exact inversion or smallest-unit remount; WebKit converted spaces; wrapper-replacement adoption; bounded repair; native line-break detection | R8, R12 | 790 |
| `surface/events.ts` | DOM listener wiring (one keydown handler per occurrence), `admit(event)`, gesture serial, attribution frames, Shift-paste tracking, drop point, drag source, focus-in restore | R8, R10 | 536 |
| `surface/clipboard.ts` | Three clipboard flavours (private type, HTML embedding the fragment, plain); fragment shape validation at admission; HTML/plain export walk that asks kind/mark records | R1 | 139 |
| `surface/overlay/*` | Overlay layer outside the host: remote carets, range highlights, the shared anchored-positioning helper (one measure per frame, editor-relative coordinates) | R11 | 140 |

### 4.5 `plugins/` — Extensions (≈ 2,050)

| Module | Responsibility | xloc |
|---|---|---|
| `plugins/types.ts`, `plugins/registry.ts` | Plugin contract (records, bindings, hooks), one precedence rule, adoption input for the Document | 113 |
| `plugins/richtext/*` | Mark and block snippets (inner markup only); kind/mark records (label, icon, keywords, markdown prefix, HTML forms, empty shape); native format-input mapping; link-edge policy; sanitizers at render | 475 |
| `plugins/code/*` | Code kind record; Prism decoration (render-only); auto-pair on user-origin inserts only; merge guards as vetoes; Tab/suggestion keys; normalization through document handles | 215 |
| `plugins/blockHandles/*` | Handles in the overlay, realigned once per frame; drop targets, placement bands, stickiness, indicator; keyboard moves emit the relative-move command; PDD adapter | 458 |
| `plugins/slashMenu/*`, `plugins/toolbar/*` | Controllers over held anchors and generated commands; components; shared overlay host | 497 |
| `plugins/html/*` | `DOMParser` → flow (one DOM walk with a mark stack, list handling, whitespace); tag tables derived from records, resolved once at registration | 190 |
| `plugins/markdownShortcuts.ts`, `mention`, `image`, `arrowMove`, `index` | Prefix matching over kind records → convert command; `@` → insert-atom command; void image; two bindings emitting relative moves | 106 |

### 4.6 Composition root (≈ 300)

- `edytor.svelte.ts` (283) builds the five contexts. It exposes the public `Edytor` handle (`document`, `selection`, `commands`, `readonly`, `value`, `onChange`), `useEdytor` and teardown.
- `utils.ts`, `index.ts` and `constants.ts` account for the remaining 21.

**Total: 4,520 + 1,840 + 3,180 + 4,050 + 2,050 + 304 ≈ 15,940 xloc.**

## 5. Deletion ledger

Each row gives:
- the mechanism and where it lives;
- **xloc now → what survives elsewhere**;
- the rule whose invariant replaces it, written as "unnecessary while …".

The xloc figures are the readers' range measurements, made with the same rules as `xloc.mjs`. Ownership-first
re-measured eight of them in source, and all eight matched. Read each row as ±15 %. A line is counted only in the first
group that retires it. Rows marked **moved** are listed so they are not mistaken for deletions.

### 5.1 Document: who owns a text position (R2, R3)

| # | Mechanism | xloc | Unnecessary while … |
|---|---|---|---|
| L1 | Slice-record model: payload types/guards/stamps, `readSliceEntries`, record anchors with B/E sentinels, `sliceRange` (`text/model.ts:47-164, 876-889, 932-957`) | 87 → 0 | … a stream is delimited by live boundary items, so there is no anchored range record to resolve |
| L2 | Per-atom ownership contest: interval index, lazy-expiry heap sweep, `gatherClaims`, `computeOwnership`, `maxG`, `claimRoutesToB` | 239 → 0 | … every text position lies in exactly one stream, so there is nothing to contest |
| L3 | Insertion-time ownership repair: empty-display revive, left-edge rewrite, right-edge rival claim (`:1365-1519`; 68 B/keystroke at a seam) | 82 → 0 | … typing at a stream edge inserts beside a boundary item; the engine's walk and the caret's affinity choose the side, and no record is written |
| L4 | Split planner `materializeSegs` + `splitSlices` | 105 → 35 | … a split inserts one boundary item (carrying the split point's formats) and moves the merge claims that follow it |
| L5 | Undo-resurrection repair: `undoRepairClaims` + `undo-repair.ts` (keep/redone detection, span walk, follow-up transaction, `changed` union) | 272 → 0 | … ownership is keyed only on boundary items, and `redoItem` integrates each copy between the tombstone's current left neighbour and the tombstone, which is inside the same stream. Verified including the concurrent-split corner (V2). Result: one update per undo (probes C2, C13 fixed). |
| L6 | Run-view contest index (`recordsByText`, union-ever effects, per-text atom rows, `rangeCache`) + claim-churn refinement | 130 → 0 | … R2 (there is no contest) |
| L7 | U8b extent narrowing (id-set walk → edited spans → fresh/stale row intersection) | 89 → 25 | … an edited item maps to its containing stream through the boundary index |
| L8 | Anchor owner facet (`a:-2` + `o`), `emissionOffset`, outward scan (historical part of `edytor-doc.ts:1984-2257`) | 146 → 0 (the codec keeps 22) | … a stream start is an item a caret can bind with left affinity. Block = containing stream; affinity = side. Two facts, two fields. |
| L9 | View-side content tombstoning in `removeBlock` (`block.utils.ts:292-298`); split type/data copy-then-reset | ~15 → 0 | … R3 sets `del` on the block and on the blocks it displays, on every path. The split op decides the tail's type/data once (O9). Probes P3, P3b and X1 fixed. |

### 5.2 Document: one derived owner, observed effects, adopted semantics (R5, R6)

| # | Mechanism | xloc | Unnecessary while … |
|---|---|---|---|
| L10 | Duplicate derived-state owners: fresh-collect `view()` + `collectBlocks` (60), lease wrapper (32), `ownShim`/`ctx` (33), fake-op → delta-parser round trip + unreachable `deltaDeep` fallbacks (~75), facade `stateVersion` + view memo (35), second ancestor walk + second children builder (~35), DocChange fast/slow split + escalation (~110) | ~380 → 0 | … derived facts have one owner whose lifetime is the doc's, each replicated change is folded into it once, and every read and publication goes through it. The quadratic in-transaction re-fold (probe C10) goes too. |
| L11 | `marksAlready` (36), clamp/same-value/`wrote` re-derivations (~20), per-op lineage capture and attribution stamping (~92) | ~148 → 30 | … the transaction's effect set is the only source of "changed" and "touched" |
| L12 | Second schema table (35), facade pending-gate twin (~15), `_retain` (8), duplicated lineage-depth validation (8), `UndoManager.destroy` monkey-patch (10) | 76 → 0 | … one owner per fact (O17, O20, O21) |
| L13 | View-side re-derivations: `closestPrevious/NextBlock`, `insideIsland`, `#index`, phantom-returning `firstText/lastText` (~81), `canMoveBlockTo` (35), extension eligibility predicates (~25) | ~141 → 0 | … order, permission and targetability are each answered by one document predicate (probes P1, P2, `block-extend` fixed) |
| L14 | `Block.value` second serializer (22) + `withMirrorInlineData` shim (18) | 40 → 0 | … there is one serializer (`document.toJSON()`) |
| L15 | Two-and-a-half op layers (placement structural ops, facade policy wrappers, content wrappers repeated across placement, facade and `nodes.ts`) | ~150 → 0 | … one validated op per intent in `doc/document` / `doc/streams` |

### 5.3 Render cells replace the mirror (R1, R4)

| # | Mechanism | xloc | Unnecessary while … |
|---|---|---|---|
| L16 | Mirror maintenance: mid-transaction `flushMirror` via full `project()` + whole-tree reconcile at 16 op sites, `_projectedTree` memo, preflight + full fallback, re-subscribe-on-attach, duplicate `reconcileChildren`, carrier second pass, dead `byItems` | 315 → 0 | … operations read and write only the document, and a render cell changes only when a commit's change report is applied (probes P9/P9b: 1,000-block delete drops from 10.6 s to the document's 7 ms) |
| L17 | Detached/spec mode: three-mode constructors (59), pending adoption `_pendingBlocks/_pendingParts/_toSpec` (131), detached splice helpers (84), `InlineBlock._spec` (34), `groupContent` (37) | 345 → 0 | … specs are data: insertion takes JSON through `doc/ingress`, and the cell appears at commit |
| L18 | Segment identity and offset mapping: positional ids, aliases, deferred rename, `_pendingAliases` (66); seven offset mappers (96); contentRange's atoms-count-0 coordinates (39); `getTextById`/`getBlockByIdOrContent` (22) | 223 → 0 | … positions are *(block id, display offset)* followed by anchors, and a segment's only key is derived (the preceding atom id) |
| L19 | Mid-transaction `refreshFromProject` + eager `$state` copies (51); `_live`/`_bound`/`_blockId`/`_dropPrev`/`_dropNext` flags (27); ~16 `get(id) === this` registration guards | ~100 → 0 | … cells are commit-consistent, a cell is live iff the last change report lists it, and seams come from replicated placement |

### 5.4 Selection (R4, R9, R10)

| # | Mechanism | xloc | Unnecessary while … |
|---|---|---|---|
| L20 | The 30-field state + four constructors + spread-patch writers (default state 60, `applySelectionSnapshot` private build 112, overlay re-mapping 26, spread-patch writers 44, builder duplicates ~15) | ~257 → 0 | … the stored selection is `{kind, anchors \| ids}` and every other field is a projection of *(value, version)* |
| L21 | Staleness repairers: `restoreRelativePosition` (84 of 104), dead-endpoint application half (118), `writeCollapsed/RangeCaretState` + `resolveDeadCaretTarget` (60), capture/`reconcileSelectionAfterRemoteApply` (120) | 382 → 0 | … the stored endpoint is the anchor and its position is recomputed per document version. Nothing stores wrappers, so wrappers can die without repair (probe X5 fixed). |
| L22 | Deferred-write machinery: staleness closures, mount polling and 10-attempt loops in `setAtTextOffset`/`setAtRange`/`setAtBlockRange` (382 → 45), `setAtTextsRange` (38), `pendingBlockRangeRequest`, `scheduleCaretWriteVerification` (45), `scheduleReassert`, `deadEndpointRecoveryPending`, synthetic write snapshots (22) | ~487 → 45 | … only the projector writes the DOM selection, always from the current value, and only when the target is mounted. Request order equals epoch order (probe C7 fixed). |
| L23 | Echo machinery: `ignoreNextSelectionChange` (17 setters in 7 files), `ignoreNextSelectedBlockSelectionChange`, `nativeSelectionMatchesCurrentBlockSeam` (35), `restoreDriftedEchoCaret` (81 → 15), Android post-delete snap-back (53 → 30, kept as one named signature) | ~190 → 45 | … the classifier compares each observation with its last display and the render epoch. A foreign programmatic selection is adopted (probe C4 fixed). |
| L24 | History duplicates: pop-handler loops and latches (~220), path/id helpers (60), `historySelectionSnapshot.ts` (111), `undoRestore` selection half (~39), `refreshDomAfterHistoryChange.ts` (89), snapshot queue overrides (~25) | ~544 → 63 | … the dispatcher records this view's `{before, after}` on the step, and a restore is `select()` in the issuing view (probes C1, P4 fixed) |
| L25 | Five seam rules (`_dropNext/_dropPrev`, two history redo fallbacks, `getClosestUnselectedBlock` + `blockToFocus`, a phantom-capable delete fallback) | ~81 → 45 (**moved** to `doc/anchors`) | … a vanished endpoint lands at its block's replicated slot, with the same answer for every cause and on every replica |
| L26 | Caret re-assertion outside selection: `getTextNode` polling (14), hotkey structural restore + `focusFallbackBlock` (76), onInput 30 ms re-assert (~30), `stabilizeCompositionSelection` (57), keyboard-focus ownership checks (~30), mention timers (~25), markdown restore (19), toolbar re-assertions (~30), rich-text state→DOM→state writes (~20) | ~301 → 0 | … commands return a selection and the projector displays it after the flush (R7 + R10) |
| L27 | Direction formula ×4 (wrong for ancestor focus nodes, ~63), unused `getTextsInSelection` TreeWalker result (76), never-written `hasSelectedAll`, debug probes including the unbounded `__EDYTOR_SEL_LOG__` push (~9), duplicated UA/path helpers | ~160 → 0 | … direction is stored in the value; dead results have no reader |

### 5.5 Input, composition, DOM observation (R7, R8, R11, R12)

| # | Mechanism | xloc | Unnecessary while … |
|---|---|---|---|
| L28 | Intent vocabularies: inputType predicate families (41), two routers (114), `shouldRefreshDomAfterModelCommand` (~25), `NON_COMPOSITION_INSERT_TYPES` (19), hotkey bridge + synthetic `KeyboardEvent` (60), event fabrication at seven sites (~90) | ~350 → 35 | … an occurrence becomes an intent exactly once, through one table, and nothing downstream re-reads the DOM event (probe C2 fixed: Enter binding ran 3×) |
| L29 | `beforeInputSnapshot.ts` (109), `beforeInputRepairTarget.ts` (13) + 11 call sites, the DOM-selection round trip for declared ranges (~68) | ~190 → 0 | … the attempt's target is an anchored model range fixed at admission (probe C3 fixed: `XXheo`) |
| L30 | Suppression flags and timers: 7 flags + 4 timers (81), onInput repair targets and suppressed repair (94), onBeforeInput windows (40), blanket suppression inside `transact` (~25) | ~240 → 0 | … ownership of DOM mutations is a property of the open attempt (owner + expectation + deadline + `failed` phase) (probe C7 fixed) |
| L31 | Second adopter (`input`-event path, 63); core knowledge of the mention trigger + manual plugin notification (47) | 110 → 0 | … the mutation queue is the only adopter, and adoption runs through the dispatcher, so hooks see adopted text like typed text |
| L32 | `diffText` "advanced" path: similarity switch, Myers stub, word diff | ~199 → 35 | … adoption diffs by common prefix/suffix only (probe C4 fixed: a 700-char foreign rewrite no longer deletes and re-inserts 1,100 atoms) |
| L33 | Observer liveness inference (~297), attribute spec tables and healing (297 → 15), caret capture/restore after repair (106), third point → offset copy (37), `domTextOffset.ts` (43) | ~780 → 15 | … own renders never reach classification (R12), and every classified record is adopted or inverted by location and the attempt owner (probe C1 fixed: a paused IME is no longer cancelled by the editor's own attribute writes) |
| L34 | Placeholder machinery: `removeStalePlaceholders.ts` (192), `Text.svelte` placeholder DOM/observers/timers/CSS (~118), repair-queue wiring (~25), history sweeps, placeholder branches in observer and selection (~20) | ~355 → 5 | … the placeholder is a model-derived attribute rendered by CSS (R11) |
| L35 | Composition representations: region numbers + anchors + DOM space, `_syncCompositionRegion`/`_reanchor…`/`_resolveCompositionOffset`/`deleteAt` region branch (~115), `onCompositionEnd` (128), `getFinalCompositionMarks` (20), 9 reset sites and their flags (~40), the observer's own cancel (25), `beforeInputCommands` composition (128) | ~678 → 245 (**moved**: session 190 + pin 55) | … at most one composition exists, its region is two anchors, and it ends exactly once through `commit` or `cancel` |
| L36 | Keydown listener pair | ~8 → 0 | … one handler per occurrence |

### 5.6 Commands (R7)

| # | Mechanism | xloc | Unnecessary while … |
|---|---|---|---|
| L37 | Seven `PreventionError` catch sites + the hotkey catch-all that reports every error as "handled" | ~40 → 0 | … hooks are consulted once, before the transaction, and `prevent()` is caught in one place (probes P11, P11b, `prevent-midway` fixed) |
| L38 | 20 `stopCapturing` decisions + ad-hoc snapshot queueing | ~40 → 0 | … the dispatcher applies one undo policy per command kind |
| L39 | Whole-editor remount switch (`refreshEditorDom`, `editorDomRevision`, `{#key}`) | ~25 → 0 | … only change reports render (R1), and the projector re-displays after any flush (probe `tab-remount` fixed) |
| L40 | `deleteContentWithinSelection` re-derivations and its third branch | 206 → 110 (**moved** to `doc/rangeDelete`) | … a range delete is one document operation between two positions, governed by `canMerge` (probes P2, P5 fixed) |
| L41 | Range-delete ladders ×3 (`replaceSelection`, the delete commands) | ~80 → 0 | … the three callers call `doc/rangeDelete` |
| L42 | Marks-for-insertion rules ×8 with 3 divergent policies | ~180 → 40 | … there is one `marksForInsertion`, and pending marks live on the selection value (probe `mark-inherit` fixed) |

### 5.7 Extensions and UI (R11, O34, O57)

| # | Mechanism | xloc | Unnecessary while … |
|---|---|---|---|
| L43 | Hand-written HTML tokenizer, tree builder, entity table (`html/parser.ts`) | 426 → 0 | … HTML arrives only through browser events, where `DOMParser` exists (jsdom provides it for tests) |
| L44 | `$fragment` pseudo-blocks, `mergeTrailingMarks`, duplicate mark application (`deserialize.ts`) | ~211 → 0 (110 kept) | … placement of any flow is one rule in `doc/flow` |
| L45 | Per-paste mapping validation with synthetic validation nodes | ~137 → 0 | … mappings resolve once at registration, and an unregistered result degrades to paragraph / plain text |
| L46 | Three paste placements + double id stripping + second fragment validation | ~208 → 70 (**moved** to `doc/flow`) | … one placement function, with ids made fresh once at `doc/ingress` (probe `paste-shape`, `empty-html` fixed) |
| L47 | Kind catalogues: `richTextCommands.ts` (115), markdown table + converters (~120), default HTML tables (102 → 35), core clipboard export switch naming 11 plugin types (~70), slash icon table, code-block shape ×2 | ~420 → 70 | … a kind is one record in its extension |
| L48 | Suggestion Proxies (`readonlyElements.svelte.ts`) | 125 → 25 | … snippet payloads are declared view objects (probe `suggestion-mention` fixed) |
| L49 | `use:block.attach` in ~20 snippets, handle ownership guard, core heading re-key, root-attribute action (33), handles WeakSet/alias composition (~23) | ~100 → 0 | … the core renders the block element (probe `code-attach` fixed) |
| L50 | Four positioning loops; handle mutation-record analysis (49) | ~116 → 35 | … one overlay helper measures once per frame |
| L51 | Four move vocabularies: `arrowMove` path arithmetic (72 → 15), handle keyboard/outdent + `comparePath` copy (~24), `blockMove` re-derivation (50 → 40) | ~146 → 55 | … there is one relative-move command (probe `move-down` fixed) |
| L52 | Toolbar numeric snapshot + 4× re-assertion (44); slash numeric range | ~50 → 0 | … UI-held ranges are anchors (probe `stale-offsets` fixed) |
| L53 | Five document-order navigation walkers (444 → 120) and 26 binding closures (139 → 55) | ~408 → 175 | … there is one ordered stream of caret stops with a direction, and bindings are data |
| L54 | Hotkey block-selection duplication (island walk ×2, root-index-only order, retry timers ~100), Emacs skeleton duplication (~44), atom deletion by whole-tree search (46 → 15), runtime `letter` Set (~50) | ~240 → 15 | … O7, O33, O37 |

### 5.8 Transport (R1, R13)

| # | Mechanism | xloc | Unnecessary while … |
|---|---|---|---|
| L55 | Schema-as-data staging and gating: `canApplyDirect` (91), `applyUpdateStaged` (39), hydration fast + surgical staging (53), refusal latch + compaction block (~18), `gateSchema`/emit/dedupe (25), eight outbound gates (~12), staged branch + post-apply recheck (~11), plumbing (~27) | ~276 → 20 | … the frame and the container carry the (engine, wire, **schema**) generation, and the document turns read-only, once and visibly, if a same-generation writer still produces a foreign stamp (probes P2, P7, C11 fixed) |
| L56 | Readiness plumbing: websocket two-round settle (~55), failed hand-back + 50 ms poll (~23), meta-only migration branch (8), view `setTimeout(0)` decision + `synced` shadow (28), facade `syncPending` twin (~15), reserved-bootstrap-id seed | ~150 → 20 | … the document decides once (empty ∧ every provider settled or bound elapsed) and seeds under fresh ids, so a seed can never overwrite room content (probes P4, P4b/c, P6 fixed) [DF] |
| L57 | Migration arbitration: claim loop (43), polling `waitForSettled` + an undecoded BroadcastChannel nudge (62 → 3), lease/owner vocabulary (~20), owner-carrying record writes (~26 → 10) | ~151 → 13 | … attempt ownership is a crash-released lock, and progress is an append plus an `active` record in one transaction |
| L58 | Storage duplications (codec, open and stamp copies; id policy ×2; key-0 overwrite) | ~50 → 0 | … one container module, append-only for every writer (probes P3/P3b fixed) |
| L59 | Presence: re-minting and double dedupe (~40), three encodings, legacy `textId/yStart` fields, `selection` mirror, owner registries + `sweepDestroyedViews`, numeric fallbacks, `findDomPoint` (~231) | ~271 → 0 | … a presence entry has one writer (the view that minted its key), carries anchors only, and uses the Surface mapper. No v14 peer has shipped (V1). |
| L60 | Factory-identity dedupe | ~7 → 0 | … providers are keyed by transport target (probe P8 fixed) |

### 5.9 Not simplification (reported separately so the reduction is not overstated)

| # | Kind | Items | xloc |
|---|---|---|---|
| L61 | **Dead code** (no reader) | `utils/jsx.ts` (70, no importer: X3), `getBlockByIdOrContent` (15), dead placement helpers (27), `renderVersion`, `#depth`, `initialized`, `REMOTE_ONLY_TRANSACTION`, `remotePresenceRevision` / `refreshRemotePresence` (~20) | ~130 |
| L62 | **API retirement** (no production consumer; needs maintainer approval) | `decorateRuns` + types (108), `subscribeBlock/subscribe/blockVersion/snapshot/debug` (~45), "advanced internals" barrel (~80), raw sync readers (41), `modifyAwarenessUpdate` (19), IDB `get/set/del` (19), duplicated hello + WebSocket-side BroadcastChannel fan-out + hand-copied options (~36), test seams (4) | ~352 |
| L63 | **Moved to `src/tests`** (oracles kept, not deleted from the repo) | `computeAllRuns`/`mergeRuns` (59), `blockRecordsOf` (23); today's `diffSnaps` stays in tests as the change-report oracle | ~82 |

### 5.10 Reconciliation

| Portion | xloc | Nature |
|---|---:|---|
| Mechanism removed by a representation or ownership change (§5.1–§5.8, net of survivors) | ≈ 11,200 | Architectural. Each row names the invariant that replaces it. |
| Not simplification (§5.9) | ≈ 560 | Dead code (130), API retirement (352, conditional), oracles moved to tests (82). |
| Shrinkage of retained responsibilities (shorter bodies, fewer imports and types; the readers' per-file floors) | ≈ 3,250 | **The least certain part.** It is estimated, not measured. |
| New code (dispatcher, projector + classifier, render bracket, boundary index + `locate`/`position`, fold cursor, lock-based migration, `writable` guard, join rule, delete-with-claims, readiness rule) | ≈ +400 | Counted in the targets. |
| Contingency (per domain, §7) | ≈ +1,460 | A planning allowance where the risk is. |
| **Floor → target** | **≈ 14,480 → ≈ 15,940** | |

**Census** [DF]: a script (in `scripts/`, not `src/lib`) counts the following at every checkpoint:
- timer sites, `tick()` waits and `flushMirror(` calls;
- `stopCapturing()` calls and `ignoreNextSelectionChange` writes;
- `PreventionError` catch sites and `MutationObserver` instances.

Each checkpoint must lower the counts it claims. This makes "moved, not deleted" visible.

## 6. Distinctions kept explicit, and the bug each prevents

Each pair below looks compressible but is not. For each one, the table says where the design keeps the two sides apart
and what merging them breaks. **(merged today)** marks distinctions the current code collapses, with the probe that
shows the resulting bug.

### 6.1 The method's canonical pairs

| # | Keep apart | Held as | Bug when merged |
|---|---|---|---|
| D1 | **Definition vs occurrence** (kind: element, role, renderer, external forms, `defaultChild` — vs a block: id, type name, data, position) | kind records adopted into document semantics; occurrences in the registry | The core hard-codes `heading`/`level` for re-keying, so a type named `title` loses it. Permission cached on an occurrence goes stale after a remote type change of an ancestor. One code definition renders two elements that both claim the block **(merged today; `code-attach`)**. |
| D2 | **Definition vs occurrence of an id** (an id that exists, live or deleted, vs a new block that wants it) | registry keys never reused; `setBlock` replacement mints fresh ids or refuses | `setBlock` with existing child ids silently drops a child and can never succeed on retry **(merged today; crdt C4)** |
| D3 | **Prepared intent vs execution attempt** (an admitted command or attempt — resolved target anchors, veto observed — vs its transaction) | command value + dispatcher phases; attempt intent/target/owner immutable | A veto inside a nested sub-step half-executes a range delete and duplicates text **(merged today; P11/P11b)**. `# ` under a vetoing plugin loses both characters **(`prevent-midway`)**. A keydown fallback replays numbers captured before a remote edit **(C3 input: `XXllo`)**. |
| D4 | **Announced intent vs executed effect** (non-cancelable `beforeinput` vs what the browser did) | attempt `owner = browser` + `expect` + deadline; success = the anchored atom disappeared | "Announced ⇒ done": Android's no-op Backspace never deletes. "Text changed ⇒ our delete happened": under a concurrent remote edit neither side deletes, and the keystroke is lost (C5 input). |
| D5 | **Observation vs guarantee** (DOM text, mount state, `selectionchange`, a provider's `synced` — vs document state and declared roles) | cells and the document are the guarantee; DOM and events are observations interpreted once | Phantom slots inferred from `node == null` are wrong in every settle window **(merged today; UNRESOLVED-2 class)**. The transport treats "the stamp stayed supported" as "incompatible content stayed out" **(P2)**. |
| D6 | **Transport success vs operation success** (a frame applied / a provider synced vs "this replica reflects the room") | `hasSynced` from an applied Step2 carrying state; the join rule; content decided by one document rule | An applied empty Step2 counts as "synced", the view seeds under the reserved id, and room content is erased **(merged today; P4b/P4c)** |
| D7 | **Capability vs permission** (the document could accept a move; the user can select and copy — vs readonly, writability and vetoes allow it now; `contenteditable` capability vs editor routing) | `canPlace`/`canMerge` (document) vs dispatcher permission; `admit()` for routing | A drop indicator hides legal drops or shows moves that silently fail. Caption typing inside a void is captured into the document selection. Readonly editors lose selection. |
| D8 | **Completed external effect vs disposable state** (OS clipboard written by cut; a durable import row — vs selection, attempts, locks) | cut writes the clipboard first, then dispatches the delete; import row + `active` record in one transaction; the lock is platform-released | If the order is reversed, cut loses data when the delete is vetoed. Storing attempt ownership durably forces leases, expiry, polling and a reclaim race **(merged today)**. |

### 6.2 Representation pairs

| # | Keep apart | Held as | Bug when merged |
|---|---|---|---|
| D9 | **Where characters are stored vs which block displays them** | backing texts (items never move) vs streams + merge claims | Copy-on-split/merge: an offline peer's edit to moved text lands on dead items (`lost-edit`, `duplicate-inline`, `resurrected-delete`) |
| D10 | **Block identity vs placement** | registry key vs `{p, r}` candidates | Physical nesting needs a move primitive the engine lacks. Copy-move produces `duplicate-placement` and `cycle`. |
| D11 | **Deleted vs hidden** | explicit replicated `del` (wins) vs derived (merge-claimed, or under a deleted ancestor) | Undoing a merge cannot restore the source. "Deleting the destination voids a concurrent merge" (ST02b) becomes inexpressible. |
| D12 | **Merged block displayed at delete time vs merged concurrently with the delete** [J] | R3: delete sets `del` on blocks it currently displays; a concurrent merge is not displayed at delete time, so its claim is simply inert | Delete only the holder: the merged block resurrects, empty or with its deleted text **(merged today; X1)**. Delete everything ever claimed: a concurrent merge wrongly deletes its source. |
| D13 | **A boundary item's formats vs the text's formats** [J] | a boundary is never displayed; its formats only steer the engine's placement walk | Insert the boundary with `{}`: after a concurrent split at a deletion gap, undo sends the text into the new block (probe `a5-…-marks2`). Let boundary formats leak into display: phantom mark runs. |
| D14 | **Gap ownership vs insert affinity** | the containing stream vs the anchor side | One sign bit plus the `o` facet for both **(merged today)**: the `nにello` corruption, or a split-start caret migrating into the neighbour (anchor rule 1); history dependence (crdt C3) |
| D15 | **Causal position vs display position vs DOM position** | anchor vs *(block, offset)* vs *(node, offset)* with ZWSP/newline fillers | Numeric carets cannot ride remote inserts (`sel.ride.insert`). Fillers leak into model offsets. Mid-composition writes address the model string instead of the pinned DOM. |
| D16 | **Causal segment key vs segment ordinal** [RF] | key = id of the preceding atom, pinned while a composition owns it | A peer inserting an atom before the composing segment re-keys it and remounts the IME's node (runtime X12) |
| D17 | **Operation handle vs render cell** [RF] | id-only handles (read-your-writes through the index) vs commit-consistent cells | Today's mirror: 16 mid-transaction full reconciles, O(N·doc) deletes (1,000 blocks: 11 s), and callbacks that see half-updated trees **(merged today; P9, P4b)** |
| D18 | **Freshness token vs publication revision** | index fold version (advances inside a transaction) vs one per-commit reactive revision | Reactive consumers either observe uncommitted state or never re-run |
| D19 | **This view's commit vs another local view's commit vs a remote commit** | transaction origin identity vs the engine's `local` flag | A sibling view's undo restores this view's caret, or this view's caret stops riding a sibling's edit |
| D20 | **Refused vs no-op vs applied** | op result `status` (R6) | Booleans conflate them **(merged today)**: attribution stamps no-ops; `moveBlocks([])` and `insertBlocks([])` disagree (crdt C8) |
| D21 | **Document semantics vs view configuration** (roles, `defaultChild` — shared, document lifetime — vs snippets, placeholder, bindings) | adopted semantics vs per-view definitions | One view's override reshapes structure for other views and peers. The split rule gives `paragraph` inside an `ordered-list` **(merged today; P10, P12)**. |
| D22 | **An empty document's first block (a document fact) vs a view-held stand-in** [DF] | R13: the document seeds under fresh ids after settle-or-bound; no virtual block | A virtual block is a second owner of "the first block". Anchors cannot bind it, and every view feature (render, selection, IME, presence) needs a special case until the first command materializes it. |

### 6.3 Selection, input and display pairs

| # | Keep apart | Held as | Bug when merged |
|---|---|---|---|
| D23 | **Result selection of a local command vs anchor-following for changes this view did not author** | command result → `select()`; held anchors ride only foreign changes | With left affinity, typing would leave the caret before each typed character |
| D24 | **Model destination vs DOM readiness** | value set synchronously; projector displays when mounted | "No node yet" is read as "no destination", and the caret is stranded after a remote whole-document delete (delete-contract row) |
| D25 | **Phantom slot (declared) vs temporarily unmounted text** | `rendersContent: false` in the kind record | A caret parked on a container's unrendered slot swallows the next keystroke. `beforeInputDeleteCommands.ts:37-39` still falls back to a phantom **(merged today)**. |
| D26 | **Echo vs render drift vs foreign programmatic write vs user move** | classifier inputs: `displayed`, render epoch, gesture serial | "No gesture since the last echo ⇒ drift" reverts selections set by host apps, extensions and assistive tech **(merged today; C4)** |
| D27 | **Foreign focus vs orphaned focus** (`body` after our own remount) | one focus predicate | Stealing focus from a control the user chose, or never displaying the caret after our own remount. Today there are three verdicts **(merged today)**. |
| D28 | **Not yet integrated vs deleted** (unresolvable anchor) | `resolve()` returns `pending` vs `dead` → seam | A remote caret is drawn at a seam before its item arrives, or a local caret jumps to a seam on a transient |
| D29 | **Issuing view vs sibling view vs remote** (history) | `{before, after}` keyed by view; restore only when this view issued the pop | A sibling's caret is yanked to a snapshot recorded long ago. Two restorers in the issuing view race **(merged today; C1/P4)**. |
| D30 | **Renderer-produced record vs browser/foreign record** | render bracket (R12) | The editor's own `data-edytor-focused` records arm the idle cancel and delete a live IME preview **(merged today; C1 input)** |
| D31 | **Browser-owned change (adopt) vs drift around a model-owned change (revert)** | the open attempt's `owner` | Merged text is duplicated after a non-cancelable merge, or the user's keystroke disappears |
| D32 | **Composition preview (replaceable, replicated for parity) vs committed text vs cancellation** | session `preview` (mechanical, no hooks, no undo) / `commit` (one user-origin command) / `cancel` (one decision) | Previews appended instead of replaced (`composition.spec:788`). Today the two abandonment exits disagree, one keeping the preview atoms and one deleting them **(merged today)**. |
| D33 | **User intent vs mechanical replay** | command `origin`; previews never reach hooks | Auto-pair rewrites the IME buffer (`x()` while the IME holds `x(`). The slash menu opens mid-composition and never after commit **(merged today; `ime-plugins`)**. |
| D34 | **Pending toggle vs mark value** | pending marks on the selection value carry values | A collapsed Bold toggle drops a link or color from the next character **(merged today; `mark-inherit`)** |
| D35 | **Decoration vs stored mark** | runs are stored; tokens and ghost text are view-only | Syntax tokens persisted into replicated marks and inherited by typed text (the historical `codeToken` leak) |
| D36 | **Command vs transaction vs undo step** | dispatcher policy per command kind | Typing stops coalescing, or a forgotten `stopCapturing` merges the next command into the previous step (markdown, slash, mention, arrow-move never cut today) |

### 6.4 Collaboration pairs

| # | Keep apart | Held as | Bug when merged |
|---|---|---|---|
| D37 | **Connection currently synced vs provider has ever synced** | `connected` vs `hasSynced` | A healthy provider that lost its socket reports "failed before it synced" on destroy **(merged today; P1)** |
| D38 | **Room membership vs room state** | neither is represented (an opaque relay provides neither); nothing correctness-critical waits on them | Emptiness inferred from silence never settles for zero members **(P6)** |
| D39 | **Stored bytes vs integrated state** | append-only rows; no row is refused, so compaction is always legal | Compaction deletes bytes the snapshot never contained, or a refusal latch disables it forever **(C11)** |
| D40 | **Import (fresh identity, appended) vs replace (a CRDT edit)** | `force` = hydrate → replace transaction → append its diff | Overwriting row 0 loses post-migration edits or keeps a random per-block mix **(merged today; P3, P3b)** |
| D41 | **Presence definition (a view's caret) vs occurrence (an entry in the client's shared slot)** | the view key the view minted | Clearing by slot strips sibling views' carets, or needs polling registries **(merged today; C14)** |
| D42 | **Container identity vs migration progress** | generation record (immutable once stamped) vs import record | The migrator stamps a populated foreign store, and its rows later hydrate **(merged today)** |
| D43 | **Accepting input vs being able to persist it** | the document's `writable` state gates the dispatcher | The transport silently drops every later local edit **(merged today; P7)** |
| D44 | **Local-only engine state vs replicated state** (`redone`, `keep`, `followUndoneDeletions = true`) | never read by any derivation | Replica-dependent ownership, which is the reason the current undo repair exists |
| D45 | **Monotonic vs restorable attribution** | `contributors` outside the undo scope vs `lastChangedBy` inside it | Undo strips contributors, or fails to restore the previous last changer |

## 7. LOC table

### 7.1 Per current domain

Column definitions:
- **Current** is today's measure: `node scratchpad/xloc.mjs src/lib --dirs` gives 29,087. The `crdt` total (8,362) splits into core 6,237 and transport 2,125 (providers 1,098 + protocols 508 + migration 519).
- **Floor** is the readers' line-level survivor estimate, re-assigned to this plan's owners.
- **Target** is floor plus contingency.
- **Where survivors land**: code that moves is counted once, at its source domain, so moving it neither adds nor deletes lines.

**Confidence scale:**
- **H** — mostly deletion of code shown to be dead or duplicated.
- **M** — an ownership or representation change whose mechanism is verified and test-gated but not yet implemented.
- **L** — depends on browser behavior that only real-engine lanes can prove.

| Current domain | Current | Floor | Contingency | **Target** | Δ | Δ % | Conf. | Where survivors land | What the confidence rests on |
|---|---:|---:|---:|---:|---:|---:|:-:|---|---|
| `crdt` core (facade, text, placement, runs, document, attribution, adapters) | 6,237 | 3,703 | +400 | **4,103** | −2,134 | −34 % | M | `doc/*` | R2 (stream boundaries) is the main bet. Its engine mechanics are verified (V2), including the format condition. The fallback (keep slice records, one decider) costs +1,227. Includes +30 of grafts (delete-with-claims, boundary formats, readiness bound). |
| `crdt` transport (providers, protocols, migration) | 2,125 | 1,440 | +78 | **1,518** | −607 | −29 % | M-H | `sync/*` | Mostly deletion of probe-confirmed faulty mechanisms (P1–P8). y-websocket option parity and the v13 migration are kept. `navigator.locks` on Node 22 is unverified. |
| `events` | 4,519 | 1,659 | +300 | **1,959** | −2,560 | −57 % | L-M | `surface/observer` 755, `surface/events` 386, `session/attempt` 402, `session/editing` 376, `session/composition` 40 | R12 (render bracket) and R8 (one attempt, one session) must hold on three engines. If R12 fails, +800. |
| `selection` | 3,913 | 1,794 | +200 | **1,994** | −1,919 | −49 % | L-M | `surface/projector` 604, `surface/domPoint` 542, `session/selection` 340, `surface/pointer` 200, `surface/geometry` 108, `session/editing` 102, `session/history` 53, `doc/anchors` 45 | The timer-free projector (R10) is unproven in real browsers; Android/iOS are not in the lanes. The +42 growth since the readers measured is more of the deferred-write machinery being retired. |
| `plugins` | 3,780 | 1,843 | +150 | **1,993** | −1,787 | −47 % | M | `plugins/*` 1,958, `surface/overlay` helper 35 | `DOMParser` whitespace parity; overlay handles in nested scroll containers |
| root files (`edytor.svelte.ts`, `hotkeys.ts`, `edytor.utils.ts`, `plugins.ts`, misc) | 2,511 | 1,245 | +80 | **1,325** | −1,186 | −47 % | M | `session/keymap+bindings` 300, `edytor.svelte.ts` 283, `session/composition` 150, `surface/events` 150, `doc/rangeDelete` 110, `surface/cells` 85, `plugins/types+registry` 113, `session/attempt` 70, `surface/projector` 43, misc 21 | Composition timing; keymap consolidation. No virtual first block (−20 vs ownership-first). |
| `block` | 1,716 | 911 | +100 | **1,011** | −705 | −41 % | M | `surface/cells` 208, `session/handles` 290, `session/commands` 278 (incl. **+100 new** dispatcher), `session/editing` 195, `session/moves` 40 | Plugin-facing `Block` API compatibility (`new Block({block})` → JSON specs) |
| `text` | 1,195 | 510 | +40 | **550** | −645 | −54 % | M | `surface/cells` 267, `session/editing/text` 230, `surface/pin` 55 | Segment views without identity; pin + causal keys |
| `collaboration` | 666 | 387 | +20 | **407** | −259 | −39 % | H | `sync/presence` 274, `surface/overlay` 85, `sync/attach` 20, shims 28 | Deletes three encodings and polling registries (probe-confirmed) |
| `components` | 615 | 299 | +30 | **329** | −286 | −47 % | M-H | `components/*.svelte` 304, `surface/suggestions` 25 | Needs the placeholder decision (§11 D-8) |
| `hotkeys/` (navigation) | 589 | 200 | +30 | **230** | −359 | −61 % | M | `session/navigation` | Caret-stop stream edge cases (RTL, atoms at block edges, node-bound extension) |
| `clipboard` | 518 | 254 | +25 | **279** | −239 | −46 % | M-H | `surface/clipboard` 139, `session/editing/clipboard` 70, `doc/flow` 70 | Needs the paste-placement decision (§11 D-4) |
| `utils` | 500 | 225 | 0 | **225** | −275 | −55 % | H | `doc/ingress` 190, `surface/observer` 35 | `jsx.ts` is dead (X3); `diffText` → prefix/suffix |
| `history` | 200 | 10 | 0 | **10** | −190 | −95 % | H | `session/history` | Second restorer verified (V5) |
| `dnd` | 3 | 3 | 0 | **3** | 0 | 0 % | H | `plugins/blockHandles` | — |
| **Total** | **29,087** | **14,483** | **+1,453** | **15,936** | **−13,151** | **−45.2 %** | | | |

Reader-measured values that differ from today's re-run: selection 3,871 (now 3,913), root files 2,497 (now 2,511), text 1,191 (now 1,195), components 614 (now 615). Every other domain matches the readers exactly. The growth is in the machinery this plan retires, so the targets are unchanged.

Reading the total:
- Against the task's stated baseline of 28,941, the target is −44.9 %.
- The floor (no contingency) is −50.2 %.
- §4's per-module sum (≈15,940) matches the target, up to rounding.

### 7.2 Does it reach 40–50 %?

**Yes: the planning target is −45 %, with a floor of −50 %.** The result stays inside 40–50 % under two conditions:
- at most one of the two representation bets (R2 stream boundaries, R12 render bracket) is abandoned at its checkpoint;
- the retained code lands within about 20 % of the readers' floors.

The −45 % figure itself also assumes the API retirement in L62; without it the target is −44 %.

| Scenario | Total | vs 29,087 | In range? |
|---|---:|---:|:-:|
| Floor (every bet holds, no overshoot) | 14,483 | −50.2 % | yes (upper edge) |
| **Planning target** (floor + itemized contingency) | **15,936** | **−45.2 %** | **yes** |
| Target, maintainer keeps the retired API surface (L62, +352) | 16,288 | −44.0 % | yes |
| Target, counting only architectural removal (dead code, API retirement and moved oracles excluded, +564) | 16,500 | −43.3 % | yes |
| R12 abandoned (observer keeps liveness classification, +800) | 16,736 | −42.5 % | yes |
| R2 abandoned (slice records kept with one decider, +1,227) | 17,163 | −41.0 % | yes (barely) |
| R2 **and** R12 abandoned | 17,963 | −38.2 % | **no** |
| Every bet holds, but retained code overshoots its floors by 25 % instead of 10 % | ≈ 18,100 | −37.8 % | **no** |

The honest statement: **40–50 % is reachable, and −45 % is the number to plan with.** It is not guaranteed. If both
representation bets fail, or if the floors prove 25 % optimistic, the result is about −38 %. That is still the best
available outcome for this code base: the crdt reader found that without changing what represents text ownership, the
document core alone stops at about −18 %.

### 7.3 Honesty notes

- **Moved, not deleted.** The following are counted at their source domain, never as deletions:
  - range delete → `doc/rangeDelete` (110);
  - paste placement → `doc/flow` (70);
  - the seam rule → `doc/anchors` (45);
  - composition from four files → `session/composition` + `surface/pin` (245);
  - six DOM-point interpreters → `surface/domPoint` (542);
  - change-report patching → `surface/cells` (85);
  - the chrome positioning helper → `surface/overlay` (35);
  - plugin-facing handles → `session/handles` (290).
- **Not simplification** (§5.9): ≈130 dead, ≈352 API retirement (conditional), ≈82 oracles moved to `src/tests`. The oracles must stay runnable.
- **New code is counted in the targets** (≈400): dispatcher (+100 over today's `runOperation`), projector and classifier (~90), render bracket (~30), boundary index and `locate`/`position` (~90), fold cursor (~40), readiness rule (15), delete-with-claims (10), lock-based migration (12), `writable` guard (8), join rule (6).
- **Type bodies.** The counter treats multi-line `export type` bodies as execution lines (~580 in both columns). Most survive in any design.
- **Bundle not measured.** The vendored engine (7,125 xloc) dominates shipped bytes. The concrete runtime claims are:
  - one wire update per undo instead of two or three;
  - ≈15 B instead of ≈68 B per keystroke at a split seam;
  - linear instead of quadratic cost for large transactions;
  - 1,000-block deletes at document cost (≈7 ms) instead of ≈10.6 s;
  - no whole-editor remount on Tab.

  The render bracket adds one synchronous flush per command and per remote apply. Measure it with `bench/` before claiming any speed gain.
- **Test rewrites** are outside the metric but are real work:
  - `mirror-incremental`, `scoped-text-refresh`, normalization-depth and placeholder-queue unit tests;
  - 19 tokenizer fixtures, ~12 mapping-validation fixtures, and the C8 trailing-content fixtures;
  - `schema-boundary` (613 lines), `wu3b-staging` (290), most of `r2-idb-compaction`;
  - the lease/claim parts of the migration suites;
  - the `o`-facet rows of `anchors.test.ts`, and `ownership-intervals`;
  - DST dump inventories (`textClaims`, `textMounted`).

  The user-visible assertions of every browser spec stay.

## 8. Falsification tests (written first, at CP0)

Rules:
- **Expected results come from contracts, never from either engine's output.** Contracts are the delete contract (`del.*`, `sel.*`, `conc.*`, anchor rules 1–6), the readers' G/R/S guarantees, `crdt-v14-document.md` and the migration runbook. Where the contracts are silent, the row says **decision** and proposes a value (§11.2).
- **Lanes:**
  - **doc**: headless vitest over the document.
  - **dom**: the repo's jsdom harness and command programs.
  - **browser**: Playwright on chromium/firefox/webkit plus DST.

  jsdom cannot falsify echo, IME or layout claims.
- **"Today" column:**
  - **red**: a probe reproduced the failure.
  - **red?**: failure predicted from code.
  - **green**: a regression guard.
- **Gate** names the checkpoint of §9 that cannot close until the row passes.
- Every multi-replica row runs in both delivery orders, with duplicate delivery, and after a binary reload.

### 8.1 Document: nesting, positions, empty inputs, failure midway, concurrency

| ID | Axis | Scenario | Expected (source) | Lane | Today | Gate |
|---|---|---|---|---|---|---|
| F-D1 | nesting in nesting | `root > [box(island) > [A "aa"], Y "yy"]`, and the same shape one level deeper inside `X`; select A@1 → Y@1; delete | `[box > [A "a"], Y "y"]` (resp. inside `X`). The island seal (G6) refuses the merge `del.range.flat` would perform, so the delete takes the no-merge shape. `mergeForward(A)` gives the same refusal. | doc | red (P2: `A "ay"`) | CP2 |
| F-D2 | order is one answer [DF] | `root > [X > [box(island) > [A]], Y]`: the next block after A | `Y` for every consumer (pre-order over visible blocks); island sealing is applied separately by the operation that needs it | doc | red (P1: wrapper `Y`, facade `null`) | CP1 |
| F-D3 | targetability | `p > [c]`; delete `p`; then `insertText(c)`, `insertBlock(parent: c)`, `moveBlock(c → root)`, `splitBlock(c)` | all four `refused`, zero update bytes (deletion wins; one `isLive`) | doc | red (C6: `true, true, true, false`) | CP1 |
| F-D4 | same definition, different position | `ordered-list > [li "one"]`: Enter at end, middle, start; merge an island child out into the list | end `[li "one", li ""]`, middle `[li "o", li "ne"]`, start `[li "", li "one"]`; the merged-out child is `li` (G5) | doc + dom | red (P12, P10) | CP1 |
| F-D5 | empty collection | `moveBlocks([], dest)`; `insertBlocks(dest, [])`; `insertText('')`; empty delete; empty format | all `noop`, same result shape; no attribution stamp, no undo step, no state-vector advance (R6) | doc | red (C8) | CP1 |
| F-D6 | failure midway, retry | `b > [c1]`; `setBlock(b, {children: [{id:'c1'}, {id:'c2'}]})`, then retry with fresh ids | first call `refused` (`id-collision`), zero bytes written, `c1` intact; retry `applied` (all-or-nothing) | doc | red (C4 crdt) | CP1 |
| F-D7 | generated value after a boundary | `insertBlock({id: 'x\uD800'})`, then `insertText` by the same string and by the returned id | both resolve to the stored block (one normalization for writes and lookups) | doc | red (C11) | CP1 |
| F-D8 | two features: merge then delete [J] | `[a "aa", b "bb", c "cc"]`: merge `b` into `a`, then delete `a`, through (1) the view command, (2) `facade.deleteBlock`, (3) `document.block('a').delete()`; then undo the delete | after delete: `[c "cc"]` on every path (G8: deleting a block deletes everything it displays); after undo: `[a "aabb", c "cc"]` | doc + dom | red (X1: view `["b:", "c:cc"]`, facade `["b:bb", "c:cc"]`) | CP1 |
| F-D9 | concurrent: delete destination ‖ merge | A deletes `a` ‖ B merges `b` into `a`; sync | `a` gone; `b "bb"` visible on both replicas (ST02b: deleting the destination voids a concurrent merge) | doc | green | CP1 regression |
| F-D10 | concurrent, every path | `abcde` split at 3; B types `Q` at the tail's head ‖ A deletes the tail through the view, `facade.deleteBlock` and `document.block(id).delete()` | `abc` on every path and both replicas (`conc.delete-wins-block`) | doc | red (P3/P3b: `abcQ`) | CP10 (under the fallback, CP1 fixes it in ownership resolution) |
| F-D11 | concurrent splits | `hello world`: split at 3 ‖ split at 8, all 40 client-id pairs | partition `hel`, `lo wo`, `rld`, nothing dropped or duplicated (R7) | doc | green (partition) | CP10 regression; reading order is **tracked only** (O70) |
| F-D12 | nested, empty container | `[ordered-list > [i1 "one", i2 "two"], P "three"]`; select i1@0 → P@2; Backspace | `[P "ree"]`, caret `P@0` (`del.range.nested-subtree`); no empty container left | doc + dom | red (P5) | CP2 |
| F-D13 | R2 property corpus | random split/merge/delete/insert/format/undo programs over 3 replicas with random delivery | (a) no content delete tombstones a boundary item; (b) of two boundary items naming one id, only the nonce-matching one delimits; (c) every live character renders exactly once; (d) convergence | doc | n/a | CP10 spike |
| F-D14 | seam insert | B inserts `\|` at 6 of `hello world` ‖ A splits at 6 | converges; which side is YATA order (**decision**: re-pin TX06a) | doc | pinned head-side | CP10 spike |
| F-D15 | history independence [DF] | (a) block `alpha` + separate `d2 = "Hello"`; (b) `alphaHello` split at 5 → `tail`. Caret `anchor(block, 0, left)`, then split that block at 0 | identical outcome in (a) and (b): the caret stays in the original, now empty block (anchor rule 1) | doc | red (C3 crdt) | CP10 |
| F-D16 | bytes at a seam | type 20 characters one per transaction at a split-born block's start | wire bytes per keystroke within 10 % of mid-text typing (≈15 B) | doc | red (C7: 68 B) | CP10 |

### 8.2 Undo after collaboration

| ID | Scenario | Expected (source) | Lane | Today | Gate |
|---|---|---|---|---|---|
| F-U1 | `Hello world`, caret @5, type `abc` (@8); peer inserts `XYZ` at 0; undo via the hotkey, via `beforeinput historyUndo` and via `edytor.historyUndo()` | caret @8 of `XYZHello world` on all three channels (H1 + `sel.ride.insert`) | dom | red (C1 sel: @5 on two channels) | CP5 |
| F-U2 | type `!` at the end of `hello world`; peer inserts a mention at 3; undo | caret at the end of the text (after `world`), not before the mention | dom | red (P4) | CP5 |
| F-U3 | split `hello world` at 6; delete the tail's `world`; undo; deliver to a receiver frame by frame, with lineage on and off | exactly one wire update per undo; the receiver never shows `hello world` in the head (R16) | doc | red (C2: 2 updates; C13: 3 with lineage) | CP10 |
| F-U4a | A-5, plain [J]: tail `world` deleted by A; B (having received it) splits the empty tail at 0 → `u`; A undoes | `world` returns to the tail `t`, not `u`, on both replicas (R16) | doc | green today via the repair; **engine-level green under boundaries** (probe `a5-boundary-undo`) | CP10 spike gate |
| F-U4b | A-5, marked head of a longer run [J]: tail `**world tail**`; A deletes `world`; B splits the tail at 0; A undoes | `t = **world**`, `u = ** tail**`, both replicas, one update. **Falsifies a boundary inserted without the split point's formats** (probe `a5-…-marks2`: with `{}` the text lands in `u`). | doc | n/a | CP10 spike gate |
| F-U4c | A-5, marked deleted run only (`**world**` + plain `tail`) and a run whose opening format item is shared with following text | text returns to `t` in every variant | doc | n/a | CP10 spike gate |
| F-U4d | concurrent: A undoes before receiving B's split at 0 of the still-live `world` | converges, `world` exactly once. Which block it lands in is a **decision** (proposed: the block B's split assigned it to, `u`) | doc | n/a | CP10 (tracked) |
| F-U5 | A deletes `bb`; B edits `cc`; A undoes | `bb` restored, `cc` keeps B's edit (`conc.undo.actor-local`) | doc | green | CP0 regression |
| F-U6 | select the first child of a list, delete, undo, redo, on each channel | redo lands on the recorded `after` (the adjacent editable content); the same answer on every channel (H3) | dom | red? (C11 sel: three answers) | CP5 |
| F-U7 | views V1 and V2 on one document; V1 types, then undoes | V1 restores its `before`; V2's caret rides the change and is not moved to a snapshot (H1) | dom | green | CP5 regression |
| F-U8 | typing, then a browser-owned deletion within `captureTimeout` (one merged step); undo | one restored position: the `before` of the step's first command | dom | red? (C10 sel) | CP6 |

### 8.3 Selection and display

| ID | Scenario | Expected (source) | Lane | Today | Gate |
|---|---|---|---|---|---|
| F-S1 | from caret @1: `setAtTextOffset(t, 4)` then `setAtRange(t, 2, 6)` with no await in between; and the reverse order | the later request wins in both orders (W1) | dom | red (C7 sel) | CP5 |
| F-S2 | caret in `Second`@3, focus on an outside button; peer deletes `Second` | model at `First`@5 (`sel.seam.next-sibling`, last-block branch); exactly one `onSelectionChange`; presence republished; focused set updated; outside focus kept | dom | red (C2 sel) | CP5 |
| F-S3 | `selectBlocks(b)` after a caret | one `onSelectionChange`; presence publishes the block set | dom | red (C3 sel) | CP5 |
| F-S4 | editor focused; host code calls `setBaseAndExtent(text@1 → end)` with no gesture and no render | the model adopts the range (a foreign write is not drift) | dom | red (C4 sel) | CP5 |
| F-S5 | paragraph `ab` + bold `cd` + `ef`; DOM point `(textElement, i)` for every child index | offsets 0, 2, 4, 6 | dom | red (C5 sel) | CP5 |
| F-S6 | forward native selection: anchor `text@1`, focus `(textElement, childCount)` | forward 1 → end; content equals the model slice | dom + firefox | red (C6 sel) | CP5 |
| F-S7 | block-select `bb` in `[aa, bb, cc]`; peer deletes `bb`; press Delete | the selection becomes a caret at `cc@0`; Delete acts on live content | dom | red (C8 sel) | CP5 |
| F-S8 | caret at the end of `hello world` in a blurred editor; peer inserts an atom at 3 | model caret at display offset 12 immediately, with no refocus needed | dom | red (X5) | CP5 |
| F-S9 | (a) our own render detaches the focused node (`body` focused); (b) the user focuses an outside `<input>` | (a) the caret is displayed; (b) model-only update, focus preserved | dom | inconsistent (3 verdicts) | CP5 |
| F-S10 | Gecko re-anchor after a mark toggle under the caret; Gecko/Blink clamp after a re-split; Android +1 echo after a model-owned merge; IME post-commit selection jump | after settle the DOM caret equals the model caret, with no timers and at most two named gesture-carrying signatures | **browser** (3 engines + DST) | green today, using timers | CP5 **gate for deleting timers** |

### 8.4 Input and IME

| ID | Scenario | Expected (source) | Lane | Today | Gate |
|---|---|---|---|---|---|
| F-I1 | `he[ll]o`; Backspace keydown with no `beforeinput`; a peer inserts `XX` at 0 before the deadline | `XXheo` (the fallback acts on its anchored target) | dom | red (C3 input) | CP6 |
| F-I2 | Android: non-cancelable `deleteContentBackward` that the browser does not perform, plus a peer edit to the same text inside the deadline | exactly one grapheme deleted: the one before the anchored caret | dom | red? (C5 input) | CP6 |
| F-I3 | a non-preventing `mod+alt+k` binding; a non-preventing `enter` binding | each runs once per keydown | dom | red (C2 input: 2× and 3×) | CP4 |
| F-I4 | an extension hook throws during a non-cancelable insert | attempt `failed`; after settle the DOM equals the model (re-rendered, never adopted twice); the next keystroke works; the error surfaces | dom | red? (C7 input) | CP6 |
| F-I5 | Shift+Enter in a code line, desktop (cancelable) and Android (non-cancelable `insertLineBreak`) | same intent, same hook, same result: line split, caret at the new line's start | dom + mobile spec | green by coincidence (C8 input) | CP6 |
| F-I6 | `Hello\|`, compositionstart, preview `に`, then 850 ms without events while a peer edits another paragraph and the editor writes focus attributes | the composition is still live, the preview intact, the host node not remounted; the commit gives `Helloに` | dom + **browser** | red (C1 input) | CP9 |
| F-I7 | `alpha\|Hello` split, then compose `n` → `に` at the fresh block start | `にHello`; `alpha` untouched | dom + browser | green | CP6 / CP10 regression |
| F-I8 | peer inserts before the composition region; peer text is absorbed inside the region | the commit lands at the shifted region; absorbed text is replaced at commit (`composition-remote-lock`, 7 tests) | browser | green | CP6 regression |
| F-I9 | in a code line compose `(` → `(a` → commit; compose `/` → `/h` → commit | the model equals the IME buffer at every step; final `x(a`; the slash menu opens once, after the commit, with query `h` | dom + browser | red (`ime-plugins`) | CP6 |
| F-I10 | composing in the second segment of `ab@cd`; a peer inserts an atom before `@` [RF] | the composing text node keeps its identity (no remount); the commit lands after `@` in the right block | dom + browser | red? (X12) | CP8 |
| F-I11 | composing in the segment after atom `@` in `ab@cd`; a peer deletes `@` [RF] | the composing node survives until the session ends (the pinned key stays alive); after the commit, segments merge normally | dom + browser | red? | CP8 |
| F-I12 | a peer deletes the block holding a live composition | no DOM write into the composing node before `compositionend`; the session ends by the decided rule (**decision**: `cancel` deletes the replicated preview atoms); caret at the seam | dom | red? (C9 sel) | CP6 |
| F-I13 | WebKit phantom Enter/Backspace right after `compositionend` | the first one is swallowed, later ones are not | browser | green | CP6 regression |
| F-I14 | a foreign script rewrites the middle 700 characters of an 1,100-character paragraph | adoption = retain 200 / delete 700 / insert 700; a remote caret and a concurrent remote insert in the untouched prefix survive | dom | red (C4 input) | CP6 |

### 8.5 Extensions and UI

| ID | Scenario | Expected (source) | Lane | Today | Gate |
|---|---|---|---|---|---|
| F-P1 | `A{A1, A2, A3}, B`; select A3; Shift+Up twice; Shift+Down | `{A2,A3}` → `{A1,A2,A3}` → `{A2,A3}` (document order, K7) | dom | red (`block-extend`) | CP1 |
| F-P2 | select `world`, focus the link field; a peer inserts `ZZZ` at 0; apply | the link covers `world` | dom | red (`stale-offsets`) | CP5 |
| F-P3 | `ab/quo` with the slash menu open; a peer inserts at 0 | the menu stays open with query `quo`; Enter runs the command on `/quo` | dom | closes by accident | CP5 |
| F-P4 | caret inside red italic text; Mod+B; type | `{color: red, italic, bold}` (one next-marks rule) | dom | red (`mark-inherit`) | CP4 |
| F-P5 | fragment `X`, `Y` pasted at `Hello\|World` via the internal clipboard, HTML and plain text | one structure (**decision**: `["HelloX", "YWorld"]`) | dom | red (`paste-shape`) | CP2 |
| F-P6 | `A, B{B1}, C`; move A down via the arrow-move binding and via the handle's Alt+Down | identical: `B{B1}, A, C` | dom | red (`move-down`) | CP4 |
| F-P7 | render a code block | exactly one element carries `data-edytor-id` for it; its handle mounts once | dom | red (`code-attach`) | CP9 |
| F-P8 | `suggestText` containing a mention atom | renders unselected and non-editable | dom | red (`suggestion-mention`) | CP9 |
| F-P9 | one Tab on `A, B\|b` | zero root remounts; only B's subtree is recreated; caret kept | dom | red (`tab-remount`: 3 remounts) | CP8 |
| F-P10 | paste HTML containing only a comment, `<script>` or an empty `<span>` into an empty `h2` | no change, no undo step, heading kept | dom | red (`empty-html`) | CP2 |
| F-P11 | slash query `/xyz` with zero matches; Enter | Enter is not swallowed | dom | red? | CP4 |
| F-P12 | two blocks selected; the arrow-move binding claims Mod+Down | the built-in Mod+Down does not also run | dom | red? | CP4 |
| F-P13 | a key handler throws a `TypeError` | the error surfaces; no half-executed command | dom | red? (reported as handled) | CP4 |
| F-P14 | two extensions define `heading` | the first one wins (README) | dom | red? (last wins) | CP4 |

### 8.6 Transport

| ID | Scenario | Expected (source) | Lane | Today | Gate |
|---|---|---|---|---|---|
| F-T1 | two websocket clients sync; B's socket drops; `B.destroy()` | no `failed` event (G11) | doc | red (P1) | CP3 |
| F-T2 | (a) a peer of another schema generation writes; (b) a same-generation writer produces a foreign stamp, then the user types three edits | (a) frames dropped at the envelope, observable, zero bytes integrated; (b) the document turns read-only once, visibly; no edit is accepted and then dropped (G13, G15) | doc | red (P2, P7) | CP3 |
| F-T3 | migrate → edit → `migrate(name, {force: true})` → reload, 6 trials, 2 tabs | every trial and tab equals the legacy materialization; no pending structs (G29) | doc | red (P3b, P3) | CP3 |
| F-T4 | new device: empty IndexedDB, the room already holds content; the view passes `value`; every client-id order | the local document equals the room; nothing duplicated; the room's first paragraph is never erased (G9) | doc | red (P4, P4b/c) | CP3 |
| F-T5 | opaque relay, default options; B edits offline and reconnects while A stays | A receives B's offline edits without `resyncInterval` (G2) | doc | red (P5) | CP3 |
| F-T6 | first client of a new room, default options; later a second client joins | the first client becomes ready after the bound with one fresh-id paragraph; both converge; no erasure; at most one extra empty paragraph if two seeders race (**decision**, §11 D-7) | doc + browser | red (P6/P6b) | CP3 |
| F-T7 | two views with inline `createIndexeddbSync('notes')` on one document | one provider; rows grow as with one view (G12) | doc | red (P8) | CP3 |
| F-T8 | a remote caret is idle; the local page scrolls | the remote caret stays on its anchor (G24) | browser | red (C12) | CP9 |
| F-T9 | a websocket-only peer closes its tab | peers drop its caret the same way as for IndexedDB/BroadcastChannel (announce on unload; timeout as backstop) | browser | differs (C13) | CP3 |
| F-T10 | a view is destroyed along a path that skips selection teardown | its presence entry is removed by its own teardown; no sibling activity needed | dom | red? (C14) | CP3 |

### 8.7 Ownership rules, instrumented

| ID | Rule | Scenario | Expected | Lane | Gate |
|---|---|---|---|---|---|
| F-O1 | R1, R10 | run every command program to settle | every DOM-selection write came from the projector; zero editor-owned timers left scheduled (except a live composition's idle policy) | dom | CP5 (timers), CP9 (writers) |
| F-O2 | R12 | selection-driven attribute writes and remote renders during a composition | no record produced by the editor reaches the classifier; a dev assertion fails any host mutation outside a bracket [J] | dom | CP9 |
| F-O3 | R7 | range delete, paste, split, convert, move with a counting extension | hooks run exactly once per command, before its transaction; nested sub-steps never call hooks | dom | CP4 |
| F-O4 | R6 | every op over a randomized corpus | result ∈ `refused \| noop \| applied`; `applied` ⇒ the touched set is non-empty; `noop` ⇒ the state vector did not advance | doc | CP1 |
| F-O5 | R1 + R6 | range delete and selected-block delete over 1,000 paragraphs; 2,000 inserts in one transaction | document work < 50 ms (CP2); end to end < 100 ms with one change report and cell patches proportional to touched blocks (CP8); linear in transaction size (CP7) | doc + dom | CP2 / CP7 / CP8 |
| F-O6 | R5 | a randomized corpus of move requests | `canMoveBlocks(r) ⇔ moveBlocks(r).status !== 'refused'` | doc | CP1 |
| F-O7 | R13 | change report vs the `diffSnaps` oracle over the random corpus | identical on every commit | doc | CP7 |
| F-O8 | R12 re-entrancy [J] | a remote update applied inside a keydown handler whose command is already inside a bracket; an extension `$effect` that dispatches a command | no nested `flushSync` inside an open bracket (the inner apply is queued to the bracket's end); the effect-dispatched command defers its bracket end to the flush | dom | CP9 |

### 8.8 Failure midway

| ID | Axis | Scenario | Expected (source) | Lane | Today | Gate |
|---|---|---|---|---|---|---|
| F-M1 | failure midway | `[a "aa", b "bb", c "cc", d "dd"]`, range a@1 → d@1; an extension's after-hook throws | `[a "ad"]`, exactly as with no hook; one undo step; the error surfaces | doc + dom | red (P11: text duplicated) | CP4 |
| F-M2 | veto of a nested step | same range; an extension refuses `removeBlock` for `c` | the range delete's sub-steps do not consult hooks → `[a "ad"]`; an extension that refuses the whole `deleteRange` command leaves the document unchanged | doc + dom | red (P11b) | CP4 |
| F-M3 | veto inside a composite | markdown shortcuts on; an extension refuses block conversion; type `#`, then space, in an empty paragraph | the paragraph reads `"# "`: each keystroke was its own committed command, and the conversion was refused before any write | dom | red (`prevent-midway`) | CP4 |
| F-M4 | throw after partial writes | a normalizer throws on its first call during a split | the command reports `failed`; the undo step holds exactly the committed writes, and one undo restores the pre-command document; the Surface shows the model | dom | red? | CP4 |

**The existing suites remain the parity oracle at every checkpoint:**
- unit, DOM, CRDT and chromium integration;
- DST solo and collab;
- the 40 composition, 8 cancellation and 7 remote-lock tests;
- the delete-contract matrix.

A test that pins a *mechanism* (§7.3) is rewritten against the invariant that replaced it. It is never deleted silently.

## 9. Bounded migration sequence

### 9.1 Discipline (applies to every checkpoint)

1. **The reference stays runnable.** Tag `ref/cpN` at each checkpoint start. The command-program corpus and the DST corpus (solo + collab) run against both the tag and the candidate. Outcomes may differ only where a §8 row or a recorded §11 decision says so; any other difference is a regression.
2. **Tests first.** The checkpoint's §8 rows are enabled before any production change, as expected-fail where they fail on the reference. The checkpoint closes when they pass and every lane is green: `pnpm test -- --run`, `pnpm test:dom`, `pnpm test:crdt`, `pnpm check`, `pnpm lint`, chromium integration. CP5, CP6, CP8, CP9 and CP10 also need the firefox and webkit lanes plus `pnpm test:dst:solo` and `pnpm test:dst:collab` on all three engines.
3. **Shadow before switch** [RF]. A new derivation that replaces an old one first runs in shadow: selection projection, cells, change report, streams. The two are compared on every fixture. Every difference must match a §8 row.
4. **No checkpoint closes with two owners for one fact.** The mechanism a new owner replaces is deleted in the same checkpoint that proves the owner. The shadow comparison is the proof; "keep it just in case" is not allowed.
5. **No checkpoint may add a timer, a one-shot flag or a retry loop** [RF]. Needing one is always a redesign trigger. Apply the repair order:
   1. clarify the requirement;
   2. find the existing semantic owner;
   3. improve that owner or its representation;
   4. add a new concept only if an independent responsibility remains.
6. **Budget.** Stop and apply rule 5's repair order if either of these happens:
   - a new owner's measured xloc exceeds its §4 estimate by more than 30 %;
   - it needs more than three special cases its contract does not name.
7. **Two-iteration rule.** A redesign trigger allows at most two design iterations. After that, escalate to the maintainer with the failing test and the measured cost.
8. **Census** [DF]. The mechanism census (§5.10) runs at every exit. Each checkpoint must lower the counts it claims.
9. **Measure at exit.** Record `xloc.mjs --files` per module against §4, plus `bench/` and `bench:crdt`.

### 9.2 Order and parallelism

```
CP0 ─┬─ CP1 ── CP2 ─────────────────────── CP7 ────────────┐
     │    └──(spike for CP10 runs from here, behind the facade)
     ├─ CP3 transport (independent) ──────────────────────────┼─ CP10 stream switch ── CP11 close
     └─ CP4 ── CP5 ── CP6 ── CP8 ── CP9 ──────────────────────┘
        (CP4 starts after CP1)
```

The ordering rules, and why:
- **Selection (CP5) comes before cells (CP8)** [DF][RF]. The selection must stop storing wrappers before wrappers can be replaced.
- **Composition (CP6) comes before cells**, so the region-resync machinery is deleted before it would have to be ported. Cells then carry only the small pin.
- **The render bracket (CP9) comes after cells.** Timer-driven remounts must be gone before every render can happen inside a bracket. (Representation-first placed the bracket first; this is the correction.)
- **Transport (CP3) is independent** [DF] and carries seven probe-confirmed bugs, so it can start right after CP0.
- **The stream switch (CP10) comes last.** Its schema bump is then a clean generation bump under CP3, and the fold-once index from CP7 hosts the stream table.

### 9.3 Checkpoints

**CP0 — Freeze the reference and install the oracles (≤ 2 days).**
- *Contract:* no behavior change.
- *Unit:*
  - tag the reference;
  - add every §8 row, as expected-fail where "Today" is red;
  - instrument F-O1…F-O8 through test spies, not production flags;
  - add the census script;
  - move the oracles (`computeAllRuns`, `mergeRuns`, `blockRecordsOf`, dense ownership) to `src/tests`;
  - record the maintainer's answers to §11.2.
- *Deletes:* L61 dead code, including the unconditional `__EDYTOR_SEL_LOG__` push, which is a production memory leak.
- *Limit:* a disputed expectation becomes a §11 decision before CP1 starts. No production refactor happens in CP0.

**CP1 — The Document answers structural questions once (R3, R5, R6).**
- *Contract:* F-D2…F-D9, F-O4, F-O6, F-P1.
- *Unit:*
  - one `isLive`, one `order`/`compare`, one `canPlace`/`canMerge`;
  - op results `refused | noop | applied`, with ids and position, read from the transaction;
  - all-or-nothing `setBlock`;
  - one ingress normalization for writes and lookups;
  - `defaultChild` and `rendersContent` adopted as data (both current `defaultBlock` rules are pure functions of the parent type, V6);
  - **delete with claims** (R3; F-D8);
  - view code calls these predicates.
- *Deletes:* L11, L12, L13, L14, L15, L9 (the view-side tombstoning part), and the duplicate ancestor walk and children builder.
- *Limit:* if a view consumer needs a structural answer the Document cannot express, add the fact to adopted semantics, never to the view. If an extension's default-type rule depends on block *data*, stop and ask: adopted semantics must stay comparable across views.

**CP2 — Range deletion, fragment placement and HTML import are document operations.**
- *Contract:* every `del.range.*` row, F-D1, F-D12, F-P5, F-P10, the document-work half of F-O5, and the user-visible assertions of the clipboard and HTML specs (after decision D-4).
- *Unit:*
  - `doc/rangeDelete` and `doc/flow`;
  - fresh ids at `doc/ingress`;
  - HTML through `DOMParser` into a flow;
  - mappings resolved once at registration.
- *Deletes:* L40, L41, L43, L44, L45, L46.
- *Limit:* a third structural branch, or a caller-specific flag, in `rangeDelete` means a contract row is missing. Write the row first. HTML whitespace fixtures are taken from real pasted content before the tokenizer is deleted.

**CP3 — Transport: generation, join, readiness, presence, migration (R1, R13).** Runs in parallel from CP0.
- *Contract:* F-T1…F-T7, F-T9, F-T10. The sync, persistence, presence and migration suites are rewritten against the new invariants (generation-mismatch tests replace schema-staging tests). The collaboration browser specs run on three engines **with the default `resyncInterval`**, so the specs no longer force 200/250 ms.
- *Unit:*
  - the schema in the generation word and the container record, with staging deleted;
  - the `sync/room` shared lifecycle (`hasSynced`) and one join rule;
  - the readiness rule (seed only when empty, after settle-or-bound, fresh ids) and the `writable` guard;
  - presence as one encoding keyed by view (published from today's anchors until CP5 makes it `serialize(value)`);
  - migration: lock, atomic append + activate, `force` as a replace-edit;
  - providers keyed by transport target.
- *Deletes:* L55–L60. L62's transport items only with the maintainer's approval.
- *Limit:* if a pinned schema case other than "same-generation forged stamp" (covered by the `writable` guard) cannot be expressed, it goes to the maintainer.

**CP4 — One command, one dispatcher (R7).**
- *Contract:* F-O3, F-M1…F-M4, F-I3, F-P4, F-P6, F-P11…F-P14; one undo step per command (existing history fixtures); readonly refuses every mutating command.
- *Unit:*
  - `session/commands`: permission → hooks once on the user-level command (`prevent()` caught here) → one transaction → normalization once per touched parent → undo policy → result selection (applied through the existing selection API until CP5);
  - `marksForInsertion`, with pending marks carrying values;
  - one keymap precedence rule and one keydown handler per occurrence;
  - the relative-move command;
  - kind and mark records, from which slash, markdown, HTML and clipboard tables are generated.
- *Deletes:* L37, L38, L42, L47, L51, L54; interception of nested sub-steps; each extension's caret-restore ladder (the plugin part of L26), removed as each extension starts returning a result selection.
- *Limit:* an extension that needs DOM access inside a command has a Surface concern (a post-commit effect), not a dispatcher case. If one old hook behavior cannot be expressed after two attempts, keep an adapter for that hook only and record the cost.

**CP5 — The selection is a value; display is a projection (R4, R9, R10).**
- *Contract:*
  - F-S1…F-S9, F-U1, F-U2, F-U6, F-U7, F-P2, F-P3, and the timer half of F-O1;
  - **browser gate F-S10** on three engines plus DST solo/collab;
  - the `selection*`, `navigation-selection-sync`, `android-caret-restore` and post-commit `composition` rows stay green.
- *Unit*, in five green steps:
  1. The value and `project()` run in shadow next to today's state, compared on every DOM fixture.
  2. Writers go through `select()`. `selection.state` becomes a compatibility getter, so the ~300 consumer reads do not move.
  3. The projector and classifier replace the write loops and the ignore flags.
  4. One history restorer, with `{before, after}` per view.
  5. Delete the old machinery.

  The seam rule moves to `doc/anchors`. DOM-point interpretation is consolidated in `surface/domPoint`. The navigation caret-stop stream lands here.
- *Deletes:* L20–L25, the rest of L26, L27, L52, L53, the `history/` directory, and the selection half of `undoRestore`.
- *Limit:* the classifier may carry **at most two** named gesture-carrying signatures (Android post-delete, IME post-commit jump), each pinned by a browser test. A third means a render-epoch source is missing: find it, do not add a case. Never add a timer.

**CP6 — One occurrence, one attempt; composition is a session (R4, R8).**
- *Contract:* F-I1, F-I2, F-I4, F-I5, F-I7, F-I8, F-I9, F-I12…F-I14, F-U8. The `mobile-beforeinput`, `composition*`, `unsupported-beforeinput`, `beforeinput-fallback`, `input` and `drop-beforeinput` specs stay green on three engines; DST passes.
- *Unit:*
  - `session/attempt`: one translation table; attempt lifecycle with `failed` phase; anchored keydown fallback; Android deadline tested against the anchored atom.
  - `session/composition` on top of today's text pin: the region becomes two anchors; previews are mechanical writes that bypass hooks and undo; one commit, one cancel.
  - Adoption through the dispatcher, with a prefix/suffix diff. The observer consults `attempt.owner` instead of flags; its liveness classification stays until CP9.
- *Deletes:* L28–L32, L35, L36.
- *Limit:* a browser-owned path that seems to need a second adopter must first be shown with a failing browser test. A fourth commit signal, or a second cancel semantic, means stop and record the product decision.

**CP7 — One derived index per document, folded once (R5, R6).** Doc track, parallel with CP4–CP6.
- *Contract:* F-O7 (change report = `diffSnaps` oracle on the random corpus), the linearity half of F-O5, all `test:crdt` lanes, `bench:crdt`, and the attribution suites.
- *Unit:*
  - one fold per transaction, with a cursor;
  - the change report assembled from the fold report;
  - the write funnel observes effects and stamps once.
- *Deletes:* L10; L62's crdt items (only with approval).
- *Limit:* the change report must equal the oracle. After two failed iterations, keep `diffSnaps` in production (+110) and continue.

**CP8 — Render cells and handles replace the mirror (R1, R4).**
- *Contract:*
  - F-P9, F-I10, F-I11, and the end-to-end half of F-O5;
  - "no DOM remount under the caret while typing" — `mirror-incremental` and `scoped-text-refresh` are rewritten as this user-level oracle;
  - every `sel.ride.*` and `sel.seam.*` row;
  - all browser lanes.
- *Unit*, in four green steps:
  1. Cells render in a test route next to the mirror, with DOM compared over fixtures.
  2. Components switch to cells with causal segment keys; the pin moves to `surface/pin`.
  3. Operations stop calling `flushMirror`, one at a time.
  4. Handles replace wrappers for extensions, and snippets receive declared view objects.
- *Deletes:* L16–L19, L39.
- *Limit:* if a command needs a mid-transaction wrapper read, extend the op result; never reintroduce the read. If an extension depends on segment identity across commits, record the API change; do not restore identity.

**CP9 — The host holds only model content; own renders are never input (R11, R12).**
- *Contract:*
  - F-I6, F-O2, F-O8, F-P7, F-P8, F-T8, and the writer half of F-O1;
  - the user-visible assertions of `placeholder-repair.spec`;
  - `dom-mutation.spec` (foreign damage);
  - mark rendering in `hotkeys.spec` and `demo-route.spec`;
  - the block-handle specs;
  - the DST `foreignMutation` oracle on three engines.
- *Unit:*
  - the placeholder becomes an attribute;
  - the core renders the block element;
  - chrome moves to `surface/overlay`;
  - the render bracket (hand pending records → apply → `flushSync` → discard own records → display) wraps commands, remote applies and history;
  - nested applies are queued to the bracket end (F-O8);
  - a dev assertion catches host mutations outside a bracket (X2);
  - the observer classifies by location and attempt owner only.
- *Deletes:* L33, L34, L48, L49, L50.
- *Limit:* if some render cannot run inside the bracket, move it to the overlay or to cell state. If that is impossible after two attempts, keep a **named, bounded exemption list** (not liveness inference) charged to the events contingency. Stop if `flushSync` per command exceeds the `bench/` budget (p95 keystroke at 5k blocks ≤ today's); batch remote applies per animation frame first. Fallback cost if R12 is abandoned: +800 (§7.2).

**CP10 — Streams are delimited by boundary items (R2).** The spike runs from CP1; the switch comes last.
- *Spike contract* (must pass before any old ownership code is deleted):
  - F-D13 (property corpus), F-D14 (re-pinned), F-D15, F-D16, F-U3, **F-U4a–c**, F-I7;
  - the TX01–TX09, ST01–ST03, MV, AN and HI01a/b scenario suites;
  - the reachability and random corpora;
  - the attribution-renderer configuration (U-3 in §11).
- *Switch contract:* F-D10 on every path, the whole crdt lane, and a generation bump to schema 2 (clean under CP3).
- *Unit:*
  - boundary items in `doc/streams`, inserted with the split point's formats;
  - the stream table in `doc/index`;
  - split = boundary + claim move;
  - anchors bind boundaries.

  The v13→v14 migration is re-targeted (it imports JSON). Development documents are re-imported.
- *Deletes:* L1–L8.
- **Abandon criterion (one decision point, taken once, with the failing test attached):** abandon R2 if either of these holds:
  - the spike needs any repair write (a second transaction, or a per-keystroke record rewrite) to pass F-U4a–c or F-D13;
  - F-U4a–c cannot pass with boundaries carrying the split point's formats.

  Fallback: keep slice records, but consolidate their six deciders into `doc/streams`; fix F-D10 in ownership resolution; take the +1,227 of §7.2.

**CP11 — Close.**
- *Unit:*
  - remove the compatibility shims retired by the decisions (`selection.state` setter, the `prevent()` throw path if D-10 allows);
  - update `AGENTS.md`, the delete contract (anchor section without the owner facet; one seam rule; presence wire) and the selection and document docs;
  - final xloc, `bench/` and bundle measurement against §7.
- *Exit:* the census reports:
  - timers ≤ 10 (Android no-op Backspace, missing-`beforeinput` deadline, readiness bound, provider backoff/heartbeat/liveness, awareness expiry, compaction debounce, one-per-frame chrome positioning);
  - `tick()` polling 0, `flushMirror` 0, `stopCapturing` 1, prevention catch sites 1, MutationObservers 1.

### 9.4 Expected xloc track (floor; the target adds each domain's contingency)

| After | Main ledger rows | Expected xloc (floor) |
|---|---|---:|
| start | — | 29,087 |
| CP0 | L61, oracles moved | ≈ 28,875 |
| CP1 | L9, L11–L15 | ≈ 28,225 |
| CP2 | L40, L41, L43–L46 | ≈ 26,940 |
| CP3 | L55–L60 | ≈ 25,890 |
| CP4 | L37, L38, L42, L47, L51, L54 | ≈ 24,400 |
| CP5 | L20–L27, L52, L53 | ≈ 21,380 |
| CP6 | L28–L32, L35, L36 | ≈ 19,420 |
| CP7 | L10 | ≈ 18,880 |
| CP8 | L16–L19, L39 | ≈ 17,640 |
| CP9 | L33, L34, L48–L50 | ≈ 15,970 |
| CP10 | L1–L8 | ≈ 14,940 |
| CP11 | L62 (if approved), shims | ≈ 14,480 |

A checkpoint that lands more than 30 % above its row's step triggers rule 6.

## 10. Extension-cost check

The measure is the number of **owners that must change**: modules whose decisions must be edited, not counting the
new feature's own files. The "Today" column is taken from the readers' fact tables and the code paths they name.

| Extension | Today | This plan | What makes the difference, and what is still paid |
|---|---|---|---|
| **(a) A new block type with nested children** (e.g. a toggle: summary line plus collapsible children) | **6–9 places across 3 layers:** the snippet with the `use:block.attach`/content/children skeleton, `richTextCommands.ts`, the slash icon table, the markdown table and converter, `elementDefinitions.ts`, core `serializeClipboardFragment.ts`, the demo menu, core `Block.svelte` re-keying when the element depends on data, a `defaultBlock` whose effect depends on plugin order, and eligibility predicates | **1 owner (Extensions):** one kind record `{type, element(data), rendersContent, role?, defaultChild?, dataPreset, label, icon, keywords, markdownPrefix?, html: {import, export}, plain?, empty?}` plus an inner-markup snippet with a children slot | The core renders the block element and the children slot. The Document adopts roles and `defaultChild`. Slash, markdown, HTML and clipboard read the record. Navigation, selection, delete and move are type-agnostic, and phantom slots come from `rendersContent`. **Still paid:** a structural invariant ("exactly N children") is a normalization hook in the same extension. |
| **(b) A new mark** (e.g. a valued highlight) | **4–6 places:** snippet, native format-input mapping, toolbar, HTML tables, clipboard export mapping, and three next-marks rules, one of which **drops valued marks** (`mark-inherit`), so a valued mark is broken out of the box | **1 owner:** one mark record `{name, snippet, html: {import, export}, sanitize(value), inclusive, binding?, toolbar?}` | One `marksForInsertion`, generic over values. Sanitization happens only at the render boundary. `inclusive: false` covers non-inclusive marks; the link edge uses the same field plus a boundary hook. |
| **(c) A new inline void** (e.g. a date chip with a `::` trigger) | **2 owners + copied timers:** the plugin, plus core event code that hard-codes the mention trigger so native-path input reaches it (`onInput.ts:471`, `onBeforeInput.ts:350`), plus a timer-based caret restore copied from the mention plugin | **1 owner:** one atom record (renderer, HTML forms, command row) and, optionally, a trigger hook on user-origin insert commands | Atoms are generic in offsets (they count 1), selection (the atom kind), removal, caret stops and clipboard. The trigger behaves the same for typed and adopted input, because adoption goes through the dispatcher. Composition replays never reach it (`origin`). |
| **(d) Comments / suggestions on ranges** | **6+ modules, no representation to build on:** no anchored-range store outside the selection's internals; highlight DOM inside the host would need new observer exemptions and selection overlay mappings (the placeholder shows what that costs, ~285 xloc of collateral); the remote-caret overlay has its own DOM mapper | **Default: 2 owners + 1 core affordance.** *Document:* a plugin-declared replicated collection (`threads/<id> = {start, end, …}`) plus one facet in the fold (≈20 xloc of core affordance) [RF]. *Extension:* the comments UI and its commands, which read `selection.value` anchors. The overlay painter reuses the remote-caret geometry, so the host and the observer are unaffected (R11, R12). **Alternative** [DF]: mark families `comment:<id>` / `suggest-insert:<id>` / `suggest-delete:<id>` with `inclusive: false` (1 owner plus a ≈10-xloc key-family lookup). | Ranges follow edits through the existing anchor codec (R4). Dead ranges resolve through the same `pending`/`dead` split as carets. The mark-family alternative rides R2 (text never moves), so annotations follow split, merge, move and undo on every replica — but it makes annotations undoable with the text, which is a product decision. Pick the store variant when annotations must not be undone with text. |

The same question applied to engine-level changes:

| Extension | Today | This plan |
|---|---|---|
| New document content op | 5 places: text-layer op, placement wrapper, facade wrapper (policy, no-op prediction, lineage capture, attribution stamp), typed-handle method, possibly a new run-view facet | One `doc/streams` or `doc/document` function (validate, then write) plus one command. Effect, attribution, lineage and invalidation follow from the transaction. |
| New inputType | Up to 8 decision sites: predicate family, target-sync rules, browser-owned classification, router, `shouldRefreshDomAfterModelCommand`, `NON_COMPOSITION_INSERT_TYPES`, history boundary, `onInput` predicates | One intent-table row plus one command case |
| New selection kind (e.g. table cells) | The 30-field state, 4 builders, 7 writers with different side effects, 2 dedupes, the undo snapshot with 3 restore shapes, the echo latches | One union variant, one projection branch, one display branch in the projector |
| New transport (e.g. WebRTC) | Each provider re-implements schema gates and settle heuristics; the two existing providers already disagree on departures and on `failed` | A socket adapter over `sync/room`; generation, join rule, lifecycle and failure semantics are inherited |

**Two owners grow with features and must be watched in review:**
- `doc/document` gains one op per new structural concept. That is intended: ops are the only writers.
- `surface/observer` must stay kind-agnostic. Any change that teaches it about a specific block, mark or atom type violates R12.

## 11. Risks and unknowns

### 11.1 Technical risks, largest first (each names its checkpoint and its fallback cost)

| # | Risk | Why it matters | Detected at | Fallback / cost |
|---|---|---|---|---|
| K1 | **R2 (stream boundaries) rests on engine behavior plus one rule of ours** | The two engine behaviors are verified in source and by execution (V2): the insert walks past zero-length tombstones and equal format items, and `redoItem` integrates between the tombstone's left neighbour and the tombstone. The outcome still depends on our **boundary-format rule**: a boundary inserted with `{}` in front of a live opening format item sends restored text into the new block. Other costs of R2:<br>• TX06a (seam-insert side) and TX04a's winner are re-pinned to YATA order.<br>• Deleted split-born blocks keep live boundaries that delimit their dead streams, a small permanent cost.<br>• "No content delete touches a boundary" must be enforced by making the per-stream delete the only delete path.<br>• If an attribution renderer ever claims deleted items with non-zero length on a backing text, the walk changes; the spike must run that configuration. | CP10 spike (F-D13, F-U4a–c, F-D16) | Keep slice records with one decider in `doc/streams`, and fix F-D10 in ownership resolution: +1,227 xloc (§7.2). Nothing else in the plan depends on R2: the facade API is unchanged and anchors keep `{b, a}`. |
| K2 | **R12 (render bracket) needs every host-DOM write to happen inside a bracket** | Svelte has no pre-write hook, so the bracket forces `flushSync` after each command, remote apply and history step. The installed Svelte does not forbid `flushSync` in effects (X2), so the danger is silent re-entrancy, not an error. Consequences:<br>• A render inside the host outside any bracket is treated as foreign. That costs an idempotent re-render, never data: adoption diffs DOM text against model text, and the composition host is skipped.<br>• Keyed `{#each}` anchors produced inside the bracket must still be inverted exactly after foreign damage.<br>• Per-keystroke latency must be measured. | CP9 (F-O2, F-O8, the dev assertion, `bench/`) | A named, bounded exemption list, then, if needed, keep liveness classification: +800 |
| K3 | **R10 (projector without timers) is unproven in real engines** | It claims that each of these is either "no gesture + render advanced" (drift) or one of two named signatures: the Gecko re-anchor bounce, the Gecko/Blink clamp difference, Android's post-delete +1, and the IME post-commit jump. jsdom cannot falsify this, and Android/iOS are not in the lanes. | CP5 (F-S10 on three engines + DST) | At most two named rules. A third is treated as a missing render-epoch source, not a new case. No timers. |
| K4 | **Replicated composition previews** (kept for parity, D-6) | Previews are mechanical writes, so peers see them and absorbed remote text is replaced at commit (pinned). The alternative (DOM-only previews) would delete only about 40 more xloc. It would also change the `composition-remote-lock` pin and peers' live view of IME text, so it is not the default. | CP6 | Revisit only if browser lanes attribute bugs to replicated previews |
| K5 | **Plugin API changes** in a 0.0.x package | • Snippets no longer attach the block element.<br>• Extensions get id-only handles; `Text` has no identity across commits, so key state by block id + anchor.<br>• Hooks see the user-level command once, never nested sub-steps. `prevent()` keeps its signature.<br>• Placeholder snippets become string functions.<br>• `new Block({block})` becomes a JSON spec passed to `insertChildren`.<br>• Removed internals: `ignoreNextSelectionChange`, `queueNextUndoSelectionSnapshot`, `getTextById`, direct `stopCapturing`. | CP4, CP8, CP9 | Migration notes; thin deprecated shims where cheap (≈ +40) |
| K6 | **Readers' floors may be optimistic** | They are line-level re-estimates, not implementations. The 1,453-xloc contingency covers about 10 %. At a 25 % overrun the result is about −38 % (§7.2). | every exit (rule 6) | Stop at +30 % per owner and apply the repair order |
| K7 | **Change-report exactness** | Cells never re-derive, so a missed or wrong change report means a stale render | CP7 (F-O7), CP8 | Keep `diffSnaps` in production (+110) plus a dev-mode rebuild assertion |
| K8 | **HTML import through `DOMParser`** | Inter-element whitespace handling was hard-won once (commit `43bb7bd`) | CP2 | Pin fixtures from real pasted content before the tokenizer is deleted |
| K9 | **Overlay handles in nested scroll containers** | Needs scroll-container tracking | CP9 | +20 (in the plugins contingency) |
| K10 | **Click → caret re-derivation in `Text.svelte`** (36 xloc) | Suspected historical and untested | CP9 | Keep it until a real-browser check shows native clicks land only on model text once the placeholder is an attribute |
| K11 | **Test-rewrite volume** (§7.3) | Coverage can drop silently during the transition | every checkpoint | Rewrite the oracle before removing the mechanism (rule 2); the CP0 pass sets are the non-regression baseline |

### 11.2 Decisions the maintainer must make (proposed answer in bold)

| # | Decision | Proposed | Why | If refused |
|---|---|---|---|---|
| D-1 | Stream boundaries (internal schema 2) | **Yes.** TX06a/TX04a are re-pinned to YATA order. A-5 is *not* a semantic change once boundaries carry the split point's formats (V2). | Deletes ≈1,000 xloc and the undo repair; one update per undo; fixes F-D10, F-D15, F-D16 | Keep slice records (+1,227) |
| D-2 | Compatibility by generation (engine + wire + schema) instead of per-update gating | **Yes.** Mixed-schema rooms partition instead of coexisting under last-writer-wins. | Today's gate protects only the stamp, not the content (P2); it can disable compaction forever (C11) and silently drop input (P7) | Keep staging (+≈250) and fix P7 separately |
| D-3 | Readiness | **Seed only an empty document, after every attached provider settled or its bound elapsed, under fresh ids** [DF]. Two concurrent seeders may leave one extra empty paragraph; SY03b–e becomes "no seed ever overwrites content". The virtual first block is rejected: it would make the view a second owner of a document fact. | The reserved-id seed erases room content (P4b/P4c) or never renders (P6) | Keep the reserved id (+≈100) and accept the erasure risk |
| D-4 | Placement of a block fragment at a mid-text caret | **`["HelloX", "YWorld"]` for internal, HTML and plain paths** | One placement rule; three behaviors today (`paste-shape`) | Keep per-path behavior; F-P5 stays deferred |
| D-5 | Meaning of "move down" | **After the next sibling, never into its children** (`B{B1}, A, C`) | The public relative-move semantics; two meanings today (`move-down`) | Keep per-path behavior; F-P6 stays deferred |
| D-6 | Composition previews | **Stay replicated, as mechanical writes that bypass hooks and undo** | Parity with the pinned remote-lock behavior; DOM-only would save only ≈40 xloc | — |
| D-7 | Abandoned composition, and a composition whose host block a peer deleted | **One `cancel`: the preview atoms are deleted, with no undo entry.** A deleted host means cancel. | Today the two exits disagree | — |
| D-8 | Placeholder customization | **A string or `block => string \| null`, rendered by CSS.** Rich placeholder markup goes to the overlay if ever needed. | The in-flow placeholder node costs ≈355 xloc plus bugs | Overlay-rendered snippet placeholder (+≈40) |
| D-9 | HTML import edge rules | **Unregistered mappings degrade to paragraph/plain instead of throwing (C7); trailing inline text becomes its own paragraph (C8)** | Both are pinned only by fixtures | Keep the tokenizer and validation (+≈560) |
| D-10 | Hook semantics | **Hooks see the user-level command once, before its transaction; nested sub-steps are not intercepted; `prevent()` keeps its signature** | Midway vetoes duplicate text (P11/P11b, `prevent-midway`) | None cheap: this is the fix |
| D-11 | Precedence of duplicate definitions | **First wins everywhere (README)** | Today definitions are last-wins while everything else is first-wins | — |
| D-12 | `setBlock` with reused child ids | **Refuse with `id-collision`; no implicit revive** | All-or-nothing (C4) | — |
| D-13 | `defaultBlock(parent)` hook | **Becomes data (`defaultChild` per parent type), merged across extensions, with conflicts as errors** | Comparable across views; both current rules are pure functions of the type (V6) | Evaluate the function per registered parent type at adoption |
| D-14 | Delete semantics over merges (new G8 clarification) | **Deleting a block deletes the blocks it displays through merge claims (transitively); a concurrent merge into a deleted block stays voided (ST02b)** | Today a delete resurrects merged blocks (X1) | — |
| D-15 | API retirement (L62, ≈352 xloc) | **Retire:** `decorateRuns`, subscriber variants, "advanced internals" exports, raw sync readers, IDB `get/set/del`, the server-side awareness helper | No production consumer; 0.0.x package; list them in the changelog | Keep them (+352; §7.2 still −44 %) |
| D-16 | Legacy presence fields (`startTextId`/`yStart`, `selection` mirror) | **Remove** | No v14 peer has shipped (V1); v13 peers are excluded by the envelope | Keep (+≈60) |
| D-17 | Concurrent undo vs a split at 0 of still-live text (F-U4d) | **The text stays in the block B's split assigned it to** | Convergent either way; no contract covers it | Tracked only |
| D-18 | Reading order of concurrently split siblings (O70) | **Tracked, not decided.** Boundary order makes it decidable; a placement rule is a separate task (≈30 xloc) | 16/40 client pairs misorder today | — |
| D-19 | Concurrent `delete(p)` ‖ `move(child → root)` (O71) | **Undecided:** rescue vs delete-wins-subtree | The move ADR does not cover it | — |

### 11.3 Scope statement

Feature parity is kept for everything the tests, docs and demo route exercise:
- rich text, marks and inline atoms;
- void and island blocks;
- nesting, moves, DnD and block handles;
- the split, merge and delete contracts;
- IME and composition, including replicated previews and the remote lock;
- undo/redo with selection restore;
- collaboration over awareness, websocket and IndexedDB;
- the v13→v14 migration;
- clipboard, paste and HTML;
- readonly, remote selections, slash menu, toolbar and attribution.

The only proposed scope cuts and contract changes are:
- D-1: the TX06a/TX04a pins;
- D-2: last-writer-wins schema coexistence;
- D-3: one-bootstrap-block convergence becomes no-overwrite seeding;
- D-4, D-5: unifying three paste behaviors and two move meanings;
- D-8: rich placeholder markup;
- D-9: fixture-only HTML edge behaviors;
- D-15, D-16: retiring API and wire fields with no deployed consumer.

### 11.4 Unknowns not resolvable from the repo

- **U-1** Whether `flushSync` inside the commit callback is well-ordered on every provider apply path, e.g. an update applied inside another transaction's observer. Tested at CP9 by F-O8.
- **U-2** Real Android/iOS IME behavior under the timer-free projector. The lanes run desktop engines only.
- **U-3** Whether F-U4 holds when an attribution renderer is active on a backing text. The spike must include that configuration.
- **U-4** Whether any consumer outside the repo depends on the retired surface (D-15) or on plugin internals (K5). The repo has none.
- **U-5** `navigator.locks` on the minimum supported Node (`>= 22`). It is present in current browsers and in Node 24 here. Fallback: an in-process mutex, since headless runtimes have no cross-tab contention.
- **U-6** Bundle-size effect. It is not measured, and the vendored engine dominates the bytes.
- **U-7** The wire cost of boundaries inside heavily formatted text. With the formats rule the walk usually inserts no extra format items, but F-D16 measures it.

