# Edytor — Representation-First Architecture Proposal

Angle: **representation-first.** The question that drives every section: the
runtime today maintains a replicated tree, a mirror tree of stateful wrappers,
id→wrapper and node→wrapper maps, a 30-field selection object, three
encodings of a caret on the wire, three encodings of a composition region,
anchored slice records plus per-atom contests, two history restorers, and
mutation-record liveness heuristics. Are these describing one underlying
thing? This plan answers: **they describe five things**, and everything else
is a view that can be recomputed.

Evidence base: the six domain reader reports (all read in full), spot-checked
against source with the shared counter (`xrange.mjs` on 24 of the readers' ranges: 22 within ±3 xloc; the
input-attempt flag range measured 155 against a reported 169, so treat
per-mechanism figures as ±10 %), plus these allowed docs:
`editor-delete-contract.md`, `crdt-v14-selection.md`, `crdt-v14-document.md`,
`crdt-v14-text-ownership-adr.md`, `crdt-v14-undo-ownership-adr.md`,
`vendor/yjs/API-NOTES.md`. No excluded document was opened.

Status: **complete** (sections 1–11). Requirement tags such as `R8`, `G12`, `H1`, `O5` and probe names such as `P4b`, `C1` refer to the required-behavior lists and falsifying probes of the six reader reports in this directory.

Baseline measured today with `xloc.mjs src/lib`: **29,026 xloc / 118 files**
(the stated baseline 28,941 predates +85 xloc in `selection/`). Vendored
engine excluded throughout.

One fact frames the whole proposal: `master` (`d6c4781`, package 0.0.11, on a
`yjs@14.0.0-8` prerelease with the older API) stores documents in the legacy
layout that this branch's "v13 → v14" migration reads. The registry and
slice-record schema exists **only on this unmerged branch**; it has never
shipped. A change to the replicated representation made now therefore costs
no migration between two new-schema versions; the legacy → new migration
(shipped data) stays in scope.

---

## 1. The few necessary facts and rules from which the behavior follows

### 1.1 Platform facts (not negotiable, not ours)

- **P1 — engine.** The vendored engine replicates sequences, attributes and
  relative positions; it has no move primitive, never rolls a transaction
  back, resurrects undone deletions as *new* items (local-only `redone`
  links), binds a position to one item plus a side, and exposes each
  transaction's changed set.
- **P2 — browser.** The browser writes the DOM itself for some input (IME,
  Android, spellcheck, autocorrect), echoes every programmatic selection
  write as an asynchronous `selectionchange`, delivers mutation records
  without provenance, and gives the IME ownership of the text node it
  composes into.
- **P3 — Svelte 5.** Rendering is batched after the synchronous block, DOM is
  reused by key and destroyed on key change, and `flushSync` can force the
  pending render synchronously.

### 1.2 The twelve rules

Each rule is one sentence. The words *marker*, *stream*, *cell*, *value*,
*attempt*, *session* and *projector* are defined by the rule that introduces
them; none names an existing class.

1. **One document.** Content, structure, identity and attribution are stored
   once, in the replicated document; every other structure is either a pure
   derivation of it that can be recomputed at any time, or a per-view intent
   that refers to document positions.
2. **Streams.** A block's own text is the *stream* that runs from its start
   *marker* (an item in a shared backing text that names the block) to the
   next live marker, and its display is its stream followed by the displays
   its merge claims name; a split inserts a marker and never copies text, so
   every text position belongs to exactly one stream and therefore to exactly
   one block.
3. **Positions.** A position is `(block id, display offset)` within one
   document version and an anchor (one item plus a side) across versions; no
   other form — text id, path, wrapper reference, or a number held across an
   asynchronous boundary — may be stored.
4. **One decider per derived fact.** Visibility, document order, ownership,
   structural permission, default type and content runs are each answered by
   one index over the document, folded once per transaction, which operations
   and views both consult.
5. **Commands.** Every mutation is a command value admitted once (permission,
   plugin veto, target resolution) before its transaction opens, executed as
   one all-or-nothing transaction under an explicit undo policy, and it
   returns `applied | noop | refused` plus the selection it intends.
6. **Render.** A view renders one immutable snapshot per visible block, a
   *cell* replaced only when a commit's change record names it, and keys DOM
   by block id and by each text segment's causal identity (the atom that
   precedes it).
7. **Selection value.** A local selection is a *value* — none, a text range
   of two anchors, one inline atom, or a set of blocks — that changes only
   through one commit point applying every side effect once; everything a
   command asks about the selection is a projection of (value, document
   version).
8. **Display.** Exactly one *projector* writes the DOM selection, always the
   current value and only once it is displayable; an observed DOM selection
   becomes the value only when it is neither the echo of the last display nor
   drift caused by a render since then.
9. **Provenance.** A DOM mutation is interpreted only if it lies in model
   territory and was not produced by the editor's own render; it is then
   adopted if the open attempt is browser-owned and it changes text inside
   one text element, and reverted (exact inversion or re-render) otherwise.
10. **Attempts and sessions.** Each user occurrence opens at most one input
    *attempt* whose intent, anchored target and owner (model or browser) are
    fixed at admission; a composition is one *session* whose region is two
    anchors and which ends in exactly one commit or one cancel.
11. **History.** Undo is the engine's origin-scoped local history; the view
    adds only the selection value that was current when the command or attempt
    opening a step was admitted, and restores it in the issuing view alone
    through the ordinary selection commit.
12. **Ownership is held, not reconstructed.** Whoever creates a thing removes
    it (a presence key, a provider, a migration lock); compatibility is proven
    by the frame and the container, never by inspecting replicated data; and
    opening a document never writes to it.

### 1.3 Behavior that follows (and the rules it follows from)

| Required behavior (contract / test pin) | Follows from | Mechanism it replaces |
|---|---|---|
| Typing at a block start, end or empty block lands in that block, never in a neighbor sharing storage (`R8`, ownership-regression A/B) | 2 | per-keystroke claim rewrite, empty-display revive, right-edge claim |
| A caret at a split-born block start never migrates into the neighbor that received text at the shared gap (anchor rule 1, `にHello`) | 2, 3 | `a ≤ -2` + `o` owner facet, emission seam, outward scan |
| Undo of a text delete restores it to the block that displayed it, on every replica, in one update (`R16`, undo-ownership ADR) | 2 + P1 (`redoItem` integrates copies between the same markers) | undo-resurrection repair, redone-space contest, second wire update |
| A block deleted concurrently with an insert into it keeps the insert hidden (`conc.delete-wins-block`) | 2 (a deleted block's whole stream is hidden, whoever wrote into it) | view-side tombstoning in the delete command; fixes the headless/concurrent leak (reader probes P3/P3b) |
| Remote inserts ride carets; a dead endpoint lands at the seam its block vacated (`sel.ride.*`, `sel.seam.*`) | 3, 7 + replicated placement of dead blocks | five seam rules, five endpoint repairers |
| One undo step per command; undo restores the caret only in the issuing view (`G12`, `G13`, `H1`) | 5, 11 | twenty `stopCapturing` sites, two restorers, snapshot queue |
| A deferred caret write never overrides a newer gesture (delete contract "Selection ownership") | 8 | sixteen staleness mechanisms |
| The IME's node is never re-rendered; a commit replaces exactly the preview atoms, once (`composition*.spec`) | 6, 9, 10 | three region encodings, nine reset sites, positional host id |
| Browser-owned input is adopted exactly once; model-owned drift is reverted (`mobile-beforeinput.spec`) | 9, 10 | seven flags, four timers, two adopters |
| The placeholder shows for the lone empty text of an empty block, never twice (`placeholder-repair.spec`) | 6 (pure render of the cell) | observers, sweeps, 6-phase repair queue |
| Presence shows each peer's caret at its anchor and disappears with its view (`G20`–`G23`) | 3, 12 | three wire encodings, owner registries, destroyed-view sweep |
| A replica never seeds content it did not author (`G9`) | 12 | settle windows, poll backstops, reserved-id seed overwrite |
| Readonly forbids mutation but keeps selection and copy (`R10`, `O6`) | 5 (permission at admission) vs 7 (capability) | seven readonly checks in controllers |

---

## 2. Authoritative representations and derived views

### 2.1 The answer to the angle's question

Every structure the runtime maintains today, and what it is under this plan:

| Maintained today | What it actually describes | Becomes |
|---|---|---|
| Replicated tree (registry, backing texts, slice records, placement candidates, `del`, merge claims) | the document | **A1** — kept, except slice records, which become start markers (2.2) |
| Derived CRDT state held by several owners (fresh-collect views, maintained run view, facade memo + `stateVersion`, DocChange skeleton snapshot) | projections of A1 | **D1** — one index per engine doc, folded once per transaction |
| Mirror tree of stateful `Block`/`Text`/`InlineBlock` wrappers (`_items`, children lists, `#index`, `_live`, `_bound`, `_dropPrev/_dropNext`, pending adoption, carriers, aliases) | a second copy of A1, kept consistent by 16 mid-transaction `flushMirror` calls plus a commit-time incremental apply | **D2** cells (reactive pointers to D1's committed snapshots) + stateless id-only handles. No second copy. |
| `idToBlock`, `idToText`, `idToInlineBlock` registries (≈16 register/unregister sites guarded by `get(id) === this`) | "which live object stands for this id" | one `Map<BlockId, Cell>` owned by the cell layer; text segments have no id; atoms are addressed as `(blockId, atomId)` |
| `nodeToText`, `nodeToInlineBlock`, `Block.node`/`container` | "which model thing does this element render" | one `WeakMap<Element, ElementRef>` written by the core renderer on mount (entries die with elements) + one `Map<BlockId, Element>` for model→DOM |
| 30-field selection state + `selectedBlocks` + `selectedInlineBlock` + `inlineBlockDeletionTarget` + `hasSelectedAll` + triple-click flags | the local selection | **A3** value `{kind, anchors \| ids}` + epoch; every field is a projection |
| Undo snapshot (anchors + text ids + paths + numbers), `nextUndoSelectionSnapshot`, `restores` map | "where the caret was when this step started" | **A2** meta: the selection value current when the command or attempt that opened the step was admitted |
| Composition state as offsets, anchors and DOM-space pin | the region the IME occupies | **A3** session: two anchors + host element; the pinned render is derived |
| Seven input flags + four timers + repair-target plumbing | who owns the DOM effect of the current input | **A3** attempt record (≤ 1 open) |
| Mutation-observer liveness inference, attribute spec tables | "did the editor make this node / attribute?" | nothing stored: provenance is established at the source (render bracket, rule 9) |
| Placeholder DOM nodes + observers + repair queue | "is this block empty?" | a pure render of the cell |
| Awareness caret in three encodings + owner registries | this view's selection, for peers | **A4** one entry per view key = serialize(value) |
| Attribution records (`b/<id>`, actor dictionary, lineage ring) | who wrote what (product feature) | **A1** — kept; stamping derived once per transaction from the touched set |
| Placement ranks `{p, r}` | where each block sits | **A1** — kept; order/visibility derived in D1 |
| `facade.version`, `DocChange.version`, `_docCommitVersion`, `valueRevision`, `remotePresenceRevision`, `Block.renderVersion` | "a commit happened" | exactly two counters: D1 fold version (freshness, bumps inside a transaction) and the view's publication revision (bumps once per commit). The rest are deleted. |
| Readiness flags: document `_readiness`, `_pendingSyncs`, facade `syncPending`, view `synced`, 0 ms self-seed timer, 50 ms poll | whether initial content is decided | **A5**/document: one state machine; opening never writes (rule 12) |

**Five authoritative things remain.** Everything else is D1–D3 (maintained,
rebuildable caches with one owner each) or a pure function.

### 2.2 Authoritative stores

| # | Store | Contents | Owner (sole writer) | Lifetime | Durable? |
|---|---|---|---|---|---|
| **A1** | Replicated document | block registry, backing texts (characters, inline atoms, start markers), merge claims, placement candidates, `del` flags, incarnation nonces, schema/generation stamp, attribution roots | the document module, through its write funnel | document | yes (providers) |
| **A2** | Local history | the engine's undo/redo stacks (origin-scoped, per document) + per issuing view: the selection value at admission of the command or attempt that opened the step (stack-item meta; a merged item keeps its first value) | engine (stacks); the view that issued the step (meta) | stack item, memory only | no |
| **A3** | Per-view intent | selection value + epoch + pending marks + vertical goal column; the open input attempt (≤ 1); the composition session (≤ 1) | the view's selection commit point; the input pipeline | view / occurrence / session | no |
| **A4** | Presence | `selections[viewKey] = {start, end, collapsed, reversed}` + actor profile in the awareness map | the view that minted `viewKey` | view (writer); peer timeout (readers) | no |
| **A5** | Storage and transport | append-only update rows + container generation record; provider session state (`hasSynced`, connection); migration: completed-import record (durable) and exclusivity lock (platform-released) | each provider / the migrator | container / provider / tab | rows + records yes; locks no |

#### The replicated schema (the representation behind rule 2)

```
doc.get('blocks')                       registry, keyed by block id (never replaced)
  └ <blockId> Node
       type, data, del, n               n = incarnation nonce (random, minted at creation)
       at      → [ {p, r} … ]           placement candidates (unchanged)
       claims  → [ {m: BlockId} … ]     ordered merge claims (the only list entries left)
       content → backing text           characters | inline-atom nodes | markers ⟨s: BlockId, n⟩
doc.get('meta')                         generation stamp {engine, wire, schema}
attribution roots                       unchanged (b/<id>, u/, c/, lineage ring)
```

- **Stream of block `b`**: if `b` has a live marker whose nonce matches `b`'s
  record, the atoms after that marker up to the next matching live marker in
  the same backing text; otherwise the atoms of `b`'s own `content` from index
  0 to its first matching live marker.
- **Display of `b`**: `stream(b)` followed by `display(m)` for each live merge
  claim `m` in order — if `owner(b) = b`; hidden if a merge claim routes `b`
  elsewhere; nothing if `b` is deleted. `owner` is the existing merge-claim
  graph (max-stamp claim, cycles, "a claim held by a deleted holder is inert").
- **Split** `b` at display offset `k`: locate `k` → (backing text, index);
  insert marker ⟨c, n_c⟩ there; move the merge claims that follow `k` to `c`;
  create `c`'s record and placement. One transaction, no copy.
- **Merge** `c` into `b`: append claim `{m: c}` to `b` (unchanged semantics:
  deleting the source hides its text, deleting the destination voids the claim).
- **Undo of a text delete**: the engine integrates copies between the
  tombstone's left neighbor and the tombstone (P1), i.e. between the same two
  markers, so the text re-enters the same stream on every replica, in the
  same update. Nothing to repair.
- **Invariants that need exactly one owner each** (the content-op module):
  a content delete never deletes a marker (only undo of a split does); every
  read skips markers (one predicate in the range reader); a marker whose
  nonce does not match its block's record is inert (concurrent same-id
  creation).

Markers are ordinary engine items (the API accepts objects and nodes in one
sequence), so the vendored engine is untouched.

### 2.3 Maintained derived caches (one owner each, never authoritative)

| # | Cache | Holds | Owner | Invalidation | Rebuild / oracle |
|---|---|---|---|---|---|
| **D1** | Document index (one per engine doc, lifetime = doc) | block records, marker index (stream starts per backing text), owners, resolved placements, children index, visibility, document order, per-block content runs (structurally shared, immutable), dependency sets (which backing texts a display reads), the previous committed child lists | the document module | folded once per transaction from the engine's changed/insert/delete sets; mid-transaction reads fold pending entries first (read-your-writes, linear) | full recompute from A1 — kept in `src/tests` as the oracle |
| **D2** | Render cells (per view) | for each visible block id: `$state.raw` pointer to D1's committed snapshot `{type, data, childIds, runs}`; root child ids | the view's cell layer | patched from each commit's change record (`added`, `removed`, `meta`, `content`, `order`) — nothing else writes them | rebuild from `project()` on bind or a missed subscription |
| **D3** | DOM | Svelte's rendering of D2 + browser-owned text inside an open browser-owned attempt or composition | Svelte + the browser | Svelte flush; adoption/reversion by the input pipeline | re-render the affected cell |

D2 is not a copy: a cell holds a reference to D1's immutable snapshot, so
"stale cell" and "cell differs from document" are not representable states
between commits.

### 2.4 Pure derivations (computed on read; memoized only by their inputs)

| View | Inputs | Memo key | Consumers |
|---|---|---|---|
| Segments of a block (text parts split at inline atoms, text-first/last, segment key = id of the preceding atom or `start`; a key pinned by a live composition stays alive until the session ends) | cell runs + session | runs identity + session phase (`$derived`) | renderer, DOM↔position mapping, composition pin |
| Selection projection: endpoints `(block, offset)`, direction, collapsed, covered blocks/texts in document order, at-edge flags, marks at caret (lazy), island/void root (one rule), selected plain text (lazy) | value, D1 | `(value, D1 version)` | every command, toolbar, clipboard, hotkeys |
| Seam of a vanished endpoint | dead block's replicated placement `{p, r}`, visible siblings, definitions' "renders own content" flag | per resolution | projection (remote delete, redo, cut, block-set delete) |
| Position ↔ DOM point (two modes: settled / DOM-ahead-of-model) | DOM, element map, cells | per call | selection observation, projector, remote carets, adoption |
| Placeholder visible | cell (one empty text), session (not composing here) | `$derived` | Text renderer (CSS attribute) |
| Presence payload | value | per commit | awareness writer |
| Undo selection record | value | the value itself (immutable) | history |
| Attribution stamps, lineage capture | transaction's touched set | per outermost transaction | write funnel |
| Op effect `applied / noop / refused` | the transaction (this client's clock advanced; a located range was non-empty) | per op | command results, stamping |
| Caret-stop stream (grapheme, word, atom, block edge) | D1 order + cells | per motion | navigation keys |
| Structural permission (move/nest/merge/void/island) | D1 tree + roles | per call | drop affordance and command admission (same answer) |
| Default type of a new block | parent's type + definitions | per call (explicit parent) | split, insert, clear, merge-unnest |
| Clipboard fragment | projection + D1 | per copy | copy/cut/drag |

---

## 3. Ownership map — fact → owner → lifetime → consumers (the new map)

Owners are modules of the new layout (§4). "Decided today by" counts the
deciders the readers found, so each row states which duplication it ends.
Every row has **one** owner; a consumer that needs the fact asks the owner and
never re-derives it.

### 3.1 Document facts (headless, `crdt/`)

| Fact | Owner | Lifetime | Consumers | Decided today by |
|---|---|---|---|---|
| Block identity | registry key, minted at the JSON→spec boundary (`crdt/ops/structure`) | forever (records are never replaced; ids never reused) | everything | 5 places + 3 fields per wrapper |
| Type / data of a block | A1 record via `crdt/ops/structure` | block | D1 → cells, commands, plugins | engine copy + view reset in the same transaction (split) |
| Which block a text position belongs to | A1 markers, read through `crdt/index/streams` | per document version | anchors, content ops, runs | 6 deciders (contest, revive, edge rewrite, right-edge claim, undo contest, `o` facet) |
| Placement (parent, rank) | A1 candidates, resolved by `crdt/index/placement` | block | order, cells, DnD, seam | 2 child-order builders, 5 ancestor walks |
| Visible / hidden / deleted | `crdt/index/placement` (one predicate: live ∧ self-owned ∧ every display ancestor visible) | per fold | op preconditions, cells, anchors, seam | 7 definitions (probe: 3 ops accept a hidden child that `splitBlock` refuses) |
| Document order | `crdt/index/placement` | per fold | covered blocks, range delete, navigation, block-selection extension, copy, drag groups | wrapper walk ≠ facade walk (probe P1), root-index-only sort in hotkeys (probe `block-extend`) |
| Content runs of a block | `crdt/index/runs` | per fold | cells, commands, clipboard, marks at caret | 2 live readers + oracle, 3 run-merging copies |
| Structural permission | `crdt/index/placement` × roles | per call | drop affordance **and** command admission (same function) | facade + `blockMove` + `Block.insideIsland` + range delete (probe P2: island breached) |
| Block roles (void / island / renders-own-content) | document semantics, adopted once from definitions (conflicts refused) | document | permission, projection (phantom slots), keys | copied per wrapper; phantom inferred from `node == null` |
| Default type of a new block | document semantics: `rule(parent type)`, explicit parent argument | per call | split, insert paragraph, clear, merge-unnest | 2 rules + an implicit caret-derived argument (probes P10, P12) |
| Op effect `applied / noop / refused` | `crdt/ops/funnel`, observed from the transaction | per op | command results, stamping | ~20 per-op predictions, contradictory booleans |
| Attribution stamp + lineage capture | `crdt/ops/funnel`, once per outermost transaction | transaction | attribution records | ~20 call sites |
| Commit publication (change record) | `crdt/index/change` | per commit | cells, `onChange`, remote carets, projector | 2 diff algorithms + escalation |
| Freshness (read-your-writes token) | `crdt/index/fold` version | per write | projection memo | 5 counters |
| Readiness (content decided) | `crdt/document` state machine | document | views subscribe | 4 latches + view timer + poll |
| Undo scope (tracked origins) | `crdt/document` history factory | document | views | single today (kept) |
| Compatibility of bytes | frame envelope (per frame) + container record (per container), `crdt/protocols/envelope` + `crdt/providers/container`; document admission only for bytes of unknown provenance | frame / container | transports, storage, load/attach | 3 staging implementations + 8 outbound re-checks |

### 3.2 View facts (`view/`, `components/`)

| Fact | Owner | Lifetime | Consumers | Decided today by |
|---|---|---|---|---|
| Rendered snapshot of a visible block | `view/cells` (patched only from the change record) | commit | components | 2 reconcile algorithms (mid-transaction full + commit incremental) |
| Segment boundaries and segment keys | `view/cells` `segments(runs)` (key = preceding atom id) | runs | Text renderer, DOM map, pin | 3 id constructions, aliasing, deferred rename |
| The one element of a block occurrence and its tag | `components/Block` from `definition.element(data)` | mount | DOM map, handle overlay, DnD | ~20 `use:block.attach` sites; code block attaches twice (probe) |
| Element ↔ model reference | `view/dom-map` (written by core renderer actions only) | element | selection observation, projector, adoption, remote carets | `nodeToText` + `data-edytor-id` + `text.node === el` re-checks |
| Placeholder visible | `components/Text` `$derived(cell, session)` → CSS attribute | render | user | 9 deciders |
| Plugin-facing block / text / atom handle | `view/handles` (id-only; getters ask D1, methods issue commands) | on demand (cached by id, no registration) | plugins, consumers | stateful wrappers + `getTextById(x.id) ?? x` rediscovery |

### 3.3 Selection facts (`selection/`)

| Fact | Owner | Lifetime | Consumers | Decided today by |
|---|---|---|---|---|
| Selection value `{none \| text(anchor, focus) \| atom(block, atom) \| blocks(ids)}` | `selection/value` commit point | until next commit | everything | 4 state constructors, 4 containers for "kind" |
| Selection epoch (intent order) | `selection/value` | monotone per view | projector, every async continuation | 16 staleness mechanisms |
| Side effects of a selection change (focused / selected block attributes and hooks, suggestion reset, `onSelectionChange`, presence) | `selection/value` commit point, applied once | per commit | UI, plugins, peers | 7 writers with 5 different side-effect sets (probes C2, C3) |
| Pending marks (the caret's override for the next insert) | a field of the selection value, dropped on any new value | until the caret moves or text is inserted | the next-marks rule | stored on a text-segment wrapper and migrated across re-segmentation |
| Endpoint projection, covered blocks, flags, island/void root | `selection/project` | `(value, D1 version)` | commands | 2 builders; island root innermost vs outermost |
| Seam of a vanished endpoint | `selection/project` over the dead block's replicated placement | per resolution | projection (remote delete, redo, cut, block-set delete) | 5 rules (one can name a phantom slot) |
| What the DOM selection was last set to | `selection/projector` | until next display | echo classification | 17 one-shot `ignoreNextSelectionChange` setters in 7 files |
| Echo / drift / user intent / foreign write | `selection/projector` classifier (last display, gesture serial, render epoch, composition) | per `selectionchange` | value | 5 classifiers (probe C4: foreign writes reverted) |
| May a write touch the DOM (foreign focus vs orphaned focus) | `selection/projector` (one predicate) | per write | projector | 3 verdicts for `body` focus |
| DOM point → position (settled / DOM-ahead modes) | `selection/observe` | per read | observation, beforeinput target, adoption, paste, drop | 3 interpreters (probe C5: wrong offset inside a text element) |
| Position → DOM point | `view/dom-map` | per write | projector, remote carets | 2 walkers with different fallbacks |
| Gesture serial | `input/handlers` (real pointer/key input only) | monotone | classifier | kept (single) |
| Render epoch | `view/cells` bracket | monotone | classifier (drift) | missing today (conflated with gesture) |
| Node-bound provenance, goal column, pointer drag | `selection/observe`, `selection/vertical`, `selection/pointer` | observation / vertical run / drag | keys, guards | single today (kept) |

### 3.4 Input facts (`input/`)

| Fact | Owner | Lifetime | Consumers | Decided today by |
|---|---|---|---|---|
| Event belongs to the editor surface | `input/admission` (one predicate per event) | per event | every handler | ≥ 11 sites with different subsets |
| Intent of an event (inputType or key) | `input/intents` (one table, incl. misreport overrides) | per event | dispatcher | predicate families re-listed in 4 files; 7 event-fabrication sites |
| Open attempt: intent, anchored target, owner, `expect`, deadline, phase (`open / applied / failed`) | `input/attempt` | occurrence (closed by next gesture, `input`, or deadline) | observer, adoption, fallbacks | 7 flags + 4 timers on the runtime root |
| Composition session: host element, start/end anchors, marks, phase, start target | `input/composition` | session | renderer pin, commit, phantom-key guard | 3 representations, 9 reset sites, 2 cancel semantics |
| Provenance of a mutation record | `input/observer` bracket | per record | classifier | reconstructed by ~560 xloc of liveness and spec tables |
| Undo boundary | `view/commands` policy per command kind | per command | engine history | 20 `stopCapturing` sites in 9 files |
| Marks of inserted text | `view/operations/marks` (one rule, one plugin hook for link edges) | per insertion | typing, IME commit, paste, adoption, soft break | 7–8 deciders, 3 divergent rules (probe `mark-inherit`) |

### 3.5 Extension and collaboration facts

| Fact | Owner | Lifetime | Consumers | Decided today by |
|---|---|---|---|---|
| Kind catalogue (label, icon, keywords, markdown prefix, HTML import/export, empty shape) | the defining plugin's kind record | plugin | slash menu, markdown, HTML import, clipboard export, demo | 6 tables (core clipboard names 11 plugin types) |
| Precedence among plugins | one rule for every registry (first wins, as documented) | view | registries, hotkeys, hooks | 5 rules (definitions: last wins, contradicting the README) |
| Held range across think-time (slash query, toolbar link target) | a selection value held by the plugin (anchors) | until the UI closes | slash menu, toolbar | numeric snapshots (probe `stale-offsets`: link lands on "lo wo") |
| Relative move (up / down / in / out) | `view/operations/block` — one command over the one engine move | per command | arrow-move, handle keys, drag, menus | 4 vocabularies with 2 meanings of "down" (probe `move-down`) |
| Fragment placement (inline runs + blocks at a collapsed target) | `content/flow` — one function | per paste / drop | internal, HTML, plain paste, drop | 3 placements, 3 results for one fragment (probe `paste-shape`) |
| Presence key | the view that minted it (`collaboration/presence`) | view | peers | owner registries + destroyed-view sweep |
| Provider `hasSynced` (lifetime) vs `connected` (transient) | each provider | provider / connection | `failed` latch, factories | merged (probe P1: healthy provider reports "failed") |
| Provider attachment dedupe | `crdt/document`, keyed by transport target | document | views | factory identity in a module `WeakMap` (probe P8: two providers on one db) |
| Join handshake | `crdt/providers/room`, shared by broadcast channel and socket | per join | convergence | two rules; socket joins only pull (probe P5: offline edits never reach peers under defaults) |
| Storage generation verify-or-stamp | `crdt/providers/container` | container | provider, migrator | 2 rules (migrator stamps a populated foreign store) |
| Migration exclusivity vs durable progress | platform lock (tab) vs `{row + active record}` in one transaction (`crdt/migration`) | tab / generation | other tabs, boot | lease + claim loop + poll in durable records |

---

## 4. Module / layer map of the new `src/lib`

Dependency direction is strict and one-way:
`crdt/` (headless, no Svelte) ← `view/` (cells, handles, DOM map, commands,
operations) ← `selection/`, `input/`, `keys/`, `content/` ← `components/`,
`collaboration/` ← `plugins/`. The composition root (`view/edytor.svelte.ts`)
is the one module allowed to import every layer: it constructs the view and
wires selection, input and keys into it; nothing imports it except components
and plugins (through `useEdytor`). Nothing in `crdt/` imports the view;
nothing below `plugins/` imports a plugin; plugins use only the public view
surface (handles, commands, kind records, overlay).

Estimates are execution xloc with the same counter. Where a reader measured a
line-by-line floor for the same responsibility, the estimate uses it (cited
as *reader floor*); where this design differs, the difference is stated.

### Layer 1 — `crdt/` (the document; headless) ≈ 5,060

| Module | Responsibility (one line) | xloc |
|---|---|---|
| `schema.ts` | The one name table and the generation constants `{engine, wire, schema}`. | 20 |
| `admission.ts` | Verdict for bytes of unknown provenance (`loadDocument`, `attachDocument`), staged admit, typed errors. | 113 |
| `rank.ts` | Rank codec for placement (digits + client tiebreak, bounded append window). | 110 |
| `index/fold.ts` | Doc-lifetime attach; folds each transaction's changed/insert/delete sets exactly once (cursor); read-your-writes; freshness version; commit publication with listener isolation. | 230 |
| `index/streams.ts` | Marker index per backing text; the range reader (skips markers, folds marks, interns runs); `locate(block, offset) → (text, index)` and its inverse. | 260 |
| `index/owners.ts` | Merge-claim graph: `owner(b)`, hidden, cycles, inert claims of deleted holders. | 70 |
| `index/placement.ts` | Candidates → acyclic winning placement and rehome; one children index; visibility; document order; ancestors; structural permission. | 300 |
| `index/runs.ts` | Per-block display runs (stream + claimed displays), structural sharing, dependency capture. | 230 |
| `index/change.ts` | The per-commit change record, assembled from the fold report (one algorithm). | 120 |
| `ops/content.ts` | Insert text/atom, per-stream delete (never a marker), format, inline-by-id; validate-then-write. | 180 |
| `ops/structure.ts` | Insert (spec ingress, id-collision refusal), split = marker + claim partition, merge, one move primitive (move/moveBlocks/nest/unnest), delete, all-or-nothing `setBlock`, duplicate; void/island policy. | 440 |
| `ops/funnel.ts` | The only write path: effect observation, touched set, attribution stamp and lineage capture once per outermost transaction. | 70 |
| `anchors.ts` | Anchor mint (side; a block start binds its marker) and resolve (stream → owner → display offset; `null` = not yet integrated, distinct from dead). | 70 |
| `facade.ts` | The documented headless surface, bootstrap init, undo-manager factory, `toJSON`/`project`, cached typed per-id handles. | 410 |
| `document.ts` | Document lifecycle: readiness state machine (open never writes), explicit create, refs and borrowed teardown, semantics adoption (roles, default-type rule), history, provider attachments keyed by transport target, read-only on an incompatible stamp. | 470 |
| `attribution/` | Block records, incarnation stamps, lineage ring with convergent trim, actor dictionary, legacy reads (product feature, kept). | 376 |
| `index.ts`, `engine-api.ts`, `structs.ts`, `rand.ts`, `engine.js` | Public barrel + `bindCrdt`; structural engine typings; incarnation store walk. | 147 |
| `protocols/sync.ts` | Step1/Step2/Update codec; `applyRemote(doc, update, origin, onError)`; state-vector coverage test for the join rule. | 54 |
| `protocols/awareness.ts` | Presence protocol (unchanged). | 223 |
| `protocols/envelope.ts` | Generation word per frame and generation record per container, both carrying the schema version. | 35 |
| `protocols/auth.ts` | Permission-denied read. | 15 |
| `providers/room.ts` | Shared message dispatch; **one** join rule for broadcast channel and socket; awareness wiring. | 171 |
| `providers/container.ts` | Store names, row codec, open-with-stores, non-creating open, one verify-or-stamp rule (shared by provider and migrator). | 56 |
| `providers/indexeddb.ts` | Append-only persistence, hydration in one transaction, compaction, cross-tab channel. | 241 |
| `providers/websocket.ts` | Socket transport with y-websocket option parity; `synced` = first applied Step2; liveness; backoff. | 322 |
| `providers/index.ts` (+ shared lifecycle) | Factories (spread options, transport-target key) and the one provider lifecycle (`hasSynced`, failed-once, departure announce), which removes ≈ 40 of lifecycle code duplicated across the three providers (net of that removal) | 14 |
| `migration/legacy-schema.ts` | v13 layout reader (shipped data — kept). | 117 |
| `migration/migrate.ts` | Platform-lock exclusivity; append import row + `active` record in one transaction; `force` as a replace-edit; rollback. | 192 |

*Reader floors:* crdt-core ≈ 3,685 (this layout: ≈ 3,620, from 40 fewer in
the lifecycle once opening never writes and 100 fewer adapters by folding the
typed handles into the facade); providers/protocols/migration ≈ 1,440.

### Layer 2 — `view/` (per-view runtime) ≈ 2,215

| Module | Responsibility | xloc |
|---|---|---|
| `edytor.svelte.ts` | View root: definition / mark / atom / command registries with one precedence rule; binds the document and subscribes to readiness; commit → cells → publication inside the render bracket; value export and `onChange`; attach wiring and keyboard-focus restore; destroy. | 560 |
| `cells.svelte.ts` | D2: cells patched only from change records; `segments(runs)` with causal keys; merged mark runs, decoration transforms, empty/newline facts; the virtual first block of an empty document; the render epoch. | 220 |
| `handles.ts` | Id-only block / text / atom handles for plugins: getters ask D1, methods issue commands; JSON-accepting insert shim. | 170 |
| `dom-map.ts` | Element ↔ model references (written only by core renderers); block element map; position → DOM point. | 50 |
| `commands.ts` | The dispatcher: readonly gate, plugin hooks as values (`continue / replace / refuse`), one transaction, undo policy, result, selection intent. **New owner.** | 100 |
| `operations/block.ts` | Interceptable block vocabulary (split, merge, relative move, nest/unnest, set, insert, remove, suggest/accept); normalization once per commit per touched parent. | 310 |
| `operations/text.ts` | Insert with the one next-marks rule, grapheme delete, marks at range, mark/toggle/unmark, split/set text. | 260 |
| `operations/range.ts` | Range delete between two anchors (`del.range.*`), replace selection, remove selected blocks. | 180 |
| `operations/content.ts` | Content-range helpers used by clipboard (text slicing). | 35 |
| `json.ts`, `plugins.ts`, `deltas.ts` | JSON boundary (clone, sanitize, spec converters), plugin contract types, delta helpers. | 330 |

*Reader floor* for the runtime domain: ≈ 2,530 including composition
(≈ 197) and wrapper render classes (≈ 500). Here composition moves to
`input/` (moved, not deleted), wrapper classes become cells + handles
(≈ 390), and the dispatcher (100), range-selection commands (90, from
`selection/`) and the virtual first block (40) are added.

### Layer 3 — `selection/` ≈ 1,720

| Module | Responsibility | xloc |
|---|---|---|
| `value.ts` | The value type, epoch, commit point with every side effect applied once (focused/selected attributes and hooks inside the render bracket, one `onSelectionChange`, presence publish), thin value builders for the public write API. | 140 |
| `project.ts` | `project(value, version)`, lazy marks/content, one island/void rule, anchor mint/resolve glue, the seam function over replicated placement. | 245 |
| `projector.ts` | `display()` — the only DOM selection writer (mount check, compare, write, budget); the `selectionchange` classifier; one focus predicate; backward-range write; Android post-delete signature; history record/restore glue. | 273 |
| `observe.ts` | DOM point interpreter with settled and DOM-ahead modes; element-boundary and stray-node rules; surrogate normalization; shadow roots, composed and multi-range selections; scroll into view. | 690 |
| `pointer.ts` | Triple click, hit testing, drags across atoms, block-selection collapse, `selectstart` guard, atom edge clicks (moved from the atom wrapper). | 216 |
| `vertical.ts` | Shift+Up/Down by visual line with goal column. | 153 |

*Reader floor* ≈ 1,795 including the range-selection commands (102), which
this layout places in `view/operations/range.ts`.

### Layer 4 — `input/` ≈ 1,880

| Module | Responsibility | xloc |
|---|---|---|
| `admission.ts` | One predicate per event: editor surface or not (native controls, nested editables, shadow paths, readonly, foreign history). | 95 |
| `intents.ts` | One table: inputType / key → intent, including misreport overrides (Android Backspace as paragraph, `\n` text as break). | 70 |
| `attempt.ts` | The open attempt: owner decided once, anchored target, `expect` for browser-owned changes, deadlines (structural-key fallback, Android no-op Backspace), `failed` phase. | 115 |
| `beforeinput.ts` | Declared-target resolution (containment, text-local deletes, never widen a live range), attempt creation, dispatch. | 115 |
| `composition.ts` | The session: start target, marks captured once, region as two anchors, `preview / commit / cancel`, phantom-key guard, idle policy, the render pin (frozen base + preview splice keyed by segment). | 180 |
| `observer.ts` | Mutation queue; the render bracket's discard; location classifier (model territory vs declared chrome); adopt-or-invert; exact childList inversion (Svelte anchors); attribute inversion from `oldValue`; WebKit converted spaces; wrapper replacement; bounded repair. | 295 |
| `adopt.ts` | DOM → model adoption through the interceptable insert/delete operations; prefix/suffix diff only; pending marks after a native delete; native line-break detection. | 245 |
| `insert.ts` | Insert / break / paragraph intents (lift-above-children, insert-before at start); one payload ladder for paste, drop and quotation. | 160 |
| `delete.ts` | Collapsed delete ladders (unnest, island edge, void select, merge, atom), word/line/soft-line units. | 130 |
| `keydown.ts` | Keydown admission specifics, readonly key filter, native navigation sync + boundary fallback, structural fallback typing. | 195 |
| `clipboard.ts` | Copy, cut (clipboard written before the delete), paste (Shift tracking), drop (drop point, internal drag source). | 200 |
| `history.ts`, `wordBoundary.ts`, `utils.ts` | History intent routing, word rule, shared UA helper. | 79 |

*Reader floor* ≈ 1,800 for the domain + ≈ 100 of coupled code moved in
(render pin, structural fallback) = 1,900.

### Layers 5–9

| Module | Responsibility | xloc |
|---|---|---|
| `keys/registry.ts` | Chord normalization (one encoder), layout / AltGr / dead keys, precedence, handlers return results (no thrown prevention). | 100 |
| `keys/navigation.ts` | One caret-stop stream (grapheme, word, atom, block edge, document edge) + bindings as data rows; RTL mapping; node-bound extension canonicalization. | 200 |
| `keys/blockKeys.ts` | Block-selection keys (arrows, shift-extend in document order, escape, select-all ladder, delete, tab/shift-tab, mod+enter); atom removal command. | 140 |
| `keys/emacs.ts` | macOS Cocoa/Emacs bindings as rows of chord → command. | 55 |
| `content/` | Fragment extraction from the selection projection, one validation of untrusted input, encode/decode (HTML-embedded fallback), generic export walk over kind/mark records, **one** placement function for any content flow. | 254 |
| `components/` | `Edytor` (declarative root attributes, overlay host), `Block` (owns the one block element, tag from the definition), `Content`, `Text` (causal segment keys, pin, placeholder attribute), `Mark`, `InlineBlock`, one anchored-positioning helper for all chrome. | 334 |
| `collaboration/` | Presence entry (one encoding, view-owned key), remote caret rendering (anchor or nothing; editor-relative frame), overlay component, document-sync glue (dedupe by target, readiness wait). | 387 |
| `plugins/richtext` | Mark + block snippets (inner markup only), native format-input mapping, kind and mark records (label, icon, keywords, markdown prefix, HTML forms), link-edge hook, sanitizers, operations. | 435 |
| `plugins/blockHandles` | Drop targets, placement bands, stickiness, indicator, keyboard moves (emit the relative-move command), overlay handles aligned once per frame. | 415 |
| `plugins/code` | Decoration transform, auto-pair on user-origin inserts only, merge guards, line split, code kind record. | 195 |
| `plugins/slashMenu`, `plugins/toolbar` | Query / filter / run over command records with anchored held range; toolbar actions over the anchored selection; presentation. | 497 |
| `plugins/html` | `DOMParser` → content flow; tag tables derived from kind/mark records, resolved once at registration. | 160 |
| `plugins/{markdown, arrowMove, mention, image, index}` | Prefix matching over kind records → convert command; two move bindings; `@` → insert-atom command; image void; barrel. | 106 |
| misc (`utils.ts`, `index.ts`, `dnd/`) | Id minting, package root, DnD adapter shim. | 20 |

### Totals by layer

| Layer | xloc |
|---|---|
| `crdt/` | 5,060 |
| `view/` | 2,215 |
| `selection/` | 1,720 |
| `input/` | 1,880 |
| `keys/` | 495 |
| `content/` | 254 |
| `components/` | 334 |
| `collaboration/` | 387 |
| `plugins/` | 1,808 |
| misc | 20 |
| **Total** | **≈ 14,170** (−51 % from 29,026; honest range in §7) |

---

## 5. Deletion ledger

Each row: the mechanism, its current xloc (reader measurement, spot-checked
with `xrange.mjs`), what survives, and the invariant that replaces it, stated
as "unnecessary while *X* holds". Rows are grouped by the representation
decision that retires them; a line is counted in the first group that
retires it (no double counting). "Moved" rows are listed so they are not
mistaken for deletions.

### 5.1 Start markers replace anchored slice records (rule 2) — `crdt/`

| Mechanism | Now | Survives | Unnecessary while … |
|---|---|---|---|
| Slice-record model: payload types/guards, stamps, claim keys, `readSliceEntries`, record anchors with index sentinels, `sliceRange` (`text/model.ts:47-164, 876-889, 932-957`) | 87 | 0 | … ownership is keyed only on markers and merge claims, so no replicated fact references a character item |
| Per-atom contest: interval index, lazy-expiry heap sweep, `gatherClaims`, `computeOwnership`, `maxG`, `claimRoutesToB` (`:483-799, 959-1004, 1124-1166`) | 239 | 0 | … every text position lies in exactly one stream (between two live markers), so there is nothing to contest |
| Insertion-time ownership repair: empty-display revive, left-edge record rewrite, right-edge rival claim (`:1365-1519`; 68 B per keystroke at a seam, reader probe C7) | 82 | 0 | … typing at a block's start/end/empty display is an insert after/before its marker; the side is chosen by the position, never repaired afterwards |
| Split planner `materializeSegs` + `splitSlices` (`:1637-1791`) | 105 | 35 | … a split is "insert one marker, move the merge claims after the split point" |
| Undo-resurrection repair: `undoRepairClaims` (`:1168-1312`) + `undo-repair.ts` (keep/redone detection, span walk, follow-up transaction) | 272 | 0 | … ownership is keyed only on markers; the engine integrates undo copies between the tombstone's neighbors, i.e. between the same markers (fixes the torn two-update undo, reader probe C2, and the three-frame undo with lineage, C13) |
| Run-view contest record index (`recordsByText`, `effects`, atom rows, range cache) | 100 | 0 | … same as the contest row |
| Edited-extent narrowing through fresh/stale row intersection (`runs.ts:456-575, 1217-1270`) + claim-churn refinement | 119 | 25 | … an edited item invalidates exactly the stream that contains it |
| Anchor owner facet (`a ≤ -2` + `o`), emission offset, outward scan (`edytor-doc.ts:1984-2257`, ≈ 130 of 168) | 130 | 0 | … gap ownership is the containing stream and affinity is the anchor side — two facts in two fields; a block start binds its own marker |
| Store walks used only by the repair (3 of 4 `structs.ts` callers) | 31 | 0 | … no repair exists |
| View-side content tombstoning in the delete command (`block.utils.ts:292-298`) | 7 | 0 | … a deleted block hides its whole stream, including concurrent inserts (fixes the headless and concurrent leaks, reader probes P3/P3b) |
| **Added**: marker index + `locate`/`position` pair | — | +90 | |
| **Net** | **1,172** | **150** | **≈ −1,020** |

### 5.2 One derived index per document, folded once (rule 4) — `crdt/`

| Mechanism | Now | Survives | Unnecessary while … |
|---|---|---|---|
| Fresh-collect `view()` + `collectBlocks` (3 record builders) | 60 | 0 | … derived facts have exactly one owner whose lifetime is the engine doc's |
| Refcounted lease around the run view | 32 | 0 | … the index lives exactly as long as the doc (the repair and trim listeners already do) |
| `ownShim` / `ctx` adapter dressing one owner as another's interface | 33 | 0 | … one owner, one interface |
| Unreachable `deltaDeep`/empty-`changed` fallbacks + fake-op synthesis re-parsed by the delta parser | 75 | 0 | … invalidation reads the engine's changed set directly (every transaction has one) |
| Facade `stateVersion` + view memo | 35 | 0 | … the index's fold version is the freshness token |
| Second display-ancestor walk (`isVisibleBlock`) + second child-order builder | 35 | 0 | … visibility and order have one decider (fixes reader probe C6: ops accepting a hidden child) |
| DocChange fast/slow split + escalation re-validation | 239 | 120 | … the change record is assembled from the fold report of the one owner |
| Quadratic in-transaction re-fold (not lines — cost: 2,000 inserts in one transaction 2,968 ms vs 746 ms, reader probe C10) | — | — | … each changed entry is folded once per transaction (fold cursor) |
| **Moved to `src/tests`** (oracle, not deleted): `computeAllRuns`/`mergeRuns` 59, `blockRecordsOf` 23 | 82 | 0 in `src/lib` | kept as oracles; their leaving `src/lib` is not a simplification of the candidate |
| **No production consumer** (declared API retirement): `decorateRuns` + types 108, subscriber variants ≈ 45, dead helpers 27, "advanced internals" barrel re-exports ≈ 80 | 260 | 0 | … nothing in `src/lib`, `src/routes` or the documented API uses them |

### 5.3 Effects are observed, not predicted (rule 5) — `crdt/`

| Mechanism | Now | Survives | Unnecessary while … |
|---|---|---|---|
| `marksAlready` (predicts whether a format will write) | 36 | 0 | … the engine writes nothing for a format already satisfied, which the funnel observes (this client's clock did not advance) |
| Clamp / same-value / `wrote` re-derivations in op wrappers | 20 | 0 | … `applied / noop / refused` is read from the transaction |
| Per-op lineage capture + attribution stamp threading (~53 lines in op bodies + ~30 helpers) | 83 | 30 | … the funnel stamps once per outermost transaction from the touched set |
| Contradictory op result shapes (`deleteRange('') → true`, `formatRange('') → false`, `moveBlocks([]) → false` vs `insertBlocks([]) → true`) | — | — | … one result type (fixes reader probe C8 and the silent `setBlock` partial write C4) |

### 5.4 Cells and handles replace the mirror tree (rules 1, 6) — `view/`

| Mechanism | Now | Survives | Unnecessary while … |
|---|---|---|---|
| Mid-transaction `flushMirror` (16 op-level sites), `_projectedTree` memo, full-tree `reconcileChildren`, divergence preflight + full fallback, re-subscribe-on-attach patch (`edytor.svelte.ts`, `block.svelte.ts`) | 315 | 60 | … operations read and write only the document; a cell changes only when a commit's change record names it (also removes the 2N+1 full reconciles per N-block range delete: 1,000 blocks 11 s → document-only 7 ms, reader probe P9) |
| Pending adoption and typed mutation surface (`insertChildren/deleteChildren/insertParts/deleteParts/_toSpec`, carriers) | 131 | 25 | … insertion takes a spec built from JSON; the live cell is found by id after commit |
| Three-mode constructors (JSON-root, detached spec, bound) + detached splice helpers + atom `_spec` + `groupContent` | 214 | 0 | … specs are plain data; the document owns the content invariant |
| Offset mappers (`partOffsetOf`, `atomOffsetOfPartIndex`, `displayLength`, `segStart`, `isInDocument`, `deleteParts` span) | 96 | 0 | … positions are `(block, display offset)`; segments are a pure function of runs |
| Segment identity: positional ids `t:<block>:<ord>` built in 3 places, aliases, `_pendingAliases`, deferred rename under the pin, `getTextById(x.id) ?? x` rediscovery | 108 | 0 | … a segment's key is the id of the atom that precedes it (causal, derived); nothing stores a segment |
| Liveness and cache flags (`_live`, `_bound`, `_blockId`, `#index`, `#depth`, `_dropPrev/_dropNext`) + re-derived navigation (`closestNext/PreviousBlock`, `insideIsland` — disagrees with the document, probe P1) | 81 | 0 | … the index answers liveness, order and permission |
| Mid-transaction `refreshFromProject` + eager `$state` copies of derivable facts | 51 | 0 | … cell facts are `$derived` from immutable runs |
| Second JSON serializer (`Block.value`) + inline-data shape shim | 40 | 0 | … one serializer (`toJSON`) |
| Block ops' H parts: path→parent resolution, result re-lookup, repeated `normalizeChildren`, split type/data copy-then-reset | 131 | 0 | … destinations are `(parent id, index)`; ops return ids; normalization runs once per commit per touched parent |
| `edytor.utils.ts` range delete re-deriving the block walk and island permission (probe P2: island breached; P5: empty container left) | 126 | 0 | … range delete is one operation between two anchors governed by the document's merge rules |
| `blockMove` rule re-derivation + path arithmetic; `contentRange` 0-width-atom coordinate system; dead `getBlockByIdOrContent`, `renderVersion`, `initialized` | 110 | 0 | … permission has one decider; atoms count 1 everywhere |
| **Added**: cell patching, causal segment keys, id-only handle delegation | — | +135 | |
| **Net** | **1,403** | **220** | **≈ −1,180** |

### 5.5 A position is `(block, offset)` + anchor — nothing else is stored (rule 3)

| Mechanism | Now | Survives | Unnecessary while … |
|---|---|---|---|
| Second history restorer: `history/historySelectionSnapshot.ts` + the selection half of the history routing (probes C1/P4: the stale numeric restore runs last and wins) | 141 | 0 | … history stores the selection value; one restorer resolves its anchors |
| Path / id snapshot helpers and `resolveSnapshotEndpoint` in the selection | 60 | 0 | … ids and paths are never identities; in-memory stack items cannot hold pre-anchor snapshots |
| Pending marks stored on a segment wrapper and migrated in a microtask after atom insertion | 20 | 0 | … pending marks are a field of the selection value |
| `compositionState.textId` host lookup with three-way fallback | 12 | 0 | … the session holds its host element and its anchors |

### 5.6 The selection is a value with one commit point (rule 7) — `selection/`

| Mechanism | Now | Survives | Unnecessary while … |
|---|---|---|---|
| 30-field default state + the second and third state builders (`applySelectionSnapshot`'s private build, spread-patch writers) | 216 | 0 | … the stored selection is `{kind, anchors \| ids}`; every other field is a projection |
| Emit dedupe over 17 fields | 30 | 8 | … emit iff the value changed |
| `restoreRelativePosition` (re-derives position because wrappers + offsets were stored) | 104 | 20 | … the stored endpoint is the anchor (the blur-time external-focus repair survives) |
| Application half of `restoreDeadSelectionEndpoints` (focus branches, write-without-emit variants, pending flag) | 118 | 0 | … dead-endpoint resolution is part of the pure projection (fixes probe C2: unfocused peer never emits; C8: block selection keeps dead blocks) |
| `writeCollapsed/RangeCaretState` + `resolveDeadCaretTarget` | 60 | 0 | … writes capture anchors at call time, before any await |
| `SelectionReplacementState` copier; `getTextsInSelection` TreeWalker whose result is discarded; never-written `hasSelectedAll`; ownership predicates and `caretSignature` | 128 | 10 | … commands receive the immutable value |

### 5.7 One projector, one epoch (rule 8) — `selection/` and callers

| Mechanism | Now | Survives | Unnecessary while … |
|---|---|---|---|
| `ignoreNextSelectionChange` (17 setters, 11 in 6 files outside the domain) + `ignoreNextSelectedBlockSelectionChange` + `nativeSelectionMatchesCurrentBlockSeam` | 55 | 0 | … a DOM selection equal to the last display is an echo, by comparison |
| `restoreDriftedEchoCaret`, `captureSelectionForRemoteApply` + `reconcileSelectionAfterRemoteApply`, `scheduleCaretWriteVerification` | 246 | 15 | … after every render the projector compares DOM with the current value and rewrites unless a gesture intervened; no-gesture-and-no-render changes are foreign writes and are adopted (fixes probe C4) |
| Staleness closures, mount polling and 10-attempt loops in `setAtTextOffset` / `setAtRange` / `setAtBlockRange`, `setAtTextsRange`, `pendingBlockRangeRequest` | 420 | 45 | … a write sets the value synchronously; display is the projector's job under the epoch (fixes probe C7: an older request dropping a newer one; C14: three answers to "not displayable yet") |
| History restore (three restore shapes, each with its own 10-attempt loop, `[0,30]` re-asserts, version + serial latches, a private redo seam rule) + snapshot creation queue | 298 | 53 | … a restore is one ordinary value commit displayed by the projector |
| `deadEndpointRecoveryPending` + mount notification side channel | 12 | 0 | … the projector re-runs on mount; destination and readiness stay separate facts |
| Synthetic DOM snapshots built so writes can reuse the read path | 22 | 0 | … writes are model-first; the read path is only for observations |
| **Outside `selection/`:** `getTextNode` tick polling (14), hotkey structural restores + fallback focus (68), block-range deletion restore (32), `stabilizeCompositionSelection` timers (≈ 35), keyboard-focus restore ownership checks (≈ 30), onInput 30 ms re-assert, per-plugin caret restores in mention / markdown / toolbar / rich-text operations (≈ 120) | ≈ 300 | 0 | … commands return a selection intent that the dispatcher commits once; the projector displays it |

### 5.8 Seams come from replicated placement

| Mechanism | Now | Survives | Unnecessary while … |
|---|---|---|---|
| `_dropNext/_dropPrev` capture, the wrapper-link climb, two history redo fallbacks, `getClosestUnselectedBlock` + `blockToFocus`, the phantom-capable root fallback | 104 | 45 | … a vanished endpoint lands at its block's replicated slot `{p, r}` — the same answer on every replica and for every cause (remote delete, redo, cut, block-set delete); phantomness is declared by the definition |

### 5.9 Provenance is established at the source (rule 9) — `input/observer`

| Mechanism | Now | Survives | Unnecessary while … |
|---|---|---|---|
| Liveness inference: removed-side and added-side predicates, placeholder DOM-shape guess, mark counting, island exemption, chrome host, anchor keep-alive (`domTextMutationObserver.ts:72-116, 277-652`) | 297 | 20 | … no record produced by the editor's own render is ever classified (bracket: flush pending records → apply change → `flushSync` → discard `takeRecords()`), and records inside declared chrome subtrees are ignored by location |
| Attribute spec tables restating what templates write, shorthand longhands, strict strip, spoof strip (`:1080-1492`) | 297 | 15 | … every attribute record that reaches classification is foreign by construction and is inverted from `oldValue` |
| Caret capture/restore after repair + deferred re-check (`:897-1078`) | 106 | 0 | … the projector re-displays the current value after the repair's render |
| Blanket observation suppression on every transaction + suppressed/retry branch | 35 | 0 | … provenance is decided per record, not per time window (fixes probe C1: the editor's own `data-edytor-focused` records arming the 750 ms idle cancel and deleting a live IME preview) |
| Third and fourth DOM point → offset copies (`:187-229`, `events/domTextOffset.ts`) | 80 | 10 | … one interpreter with an explicit "DOM ahead of model" mode |

### 5.10 The placeholder is a pure render of the cell (rule 6)

| Mechanism | Now | Survives | Unnecessary while … |
|---|---|---|---|
| `text/removeStalePlaceholders.ts` (sweep + 6-phase coalesced queue at microtask, rAF, 50, 250, 1000 ms) | 192 | 0 | … the placeholder is not a node in the editable flow: it is a `data-edytor-placeholder` attribute on the empty text element rendered by CSS `::before`, visible iff the cell has one empty text and no session composes in it |
| Placeholder DOM, per-placeholder and per-text MutationObservers, duplicate sweeps, `hasDomText` bridge, hide rules (`Text.svelte:79-216, 252-285`) | 118 | 5 | … same (browser-typed text is adopted in the same microtask, so the model is never behind long enough to paint) |
| Per-commit placeholder repair queue + history sweeps + selection's placeholder point mapping | 48 | 0 | … no placeholder node exists to repair or to land a selection point on |

### 5.11 One attempt per occurrence, one session per composition (rule 10) — `input/`

| Mechanism | Now | Survives | Unnecessary while … |
|---|---|---|---|
| inputType predicate families re-listed in 4 files, two routers, `shouldRefreshDomAfterModelCommand`, `NON_COMPOSITION_INSERT_TYPES` | 134 | 35 | … an inputType is translated into an intent once, by one table |
| Hotkey bridge (beforeinput → synthetic keydown) and seven event-fabrication sites (keydown → beforeinput, DOM line break → beforeinput, paste, drop, hotkey delete stub, code-line Shift+Enter) | 185 | 0 | … keys, inputTypes, paste and drop all produce intents; plugin overrides attach to intents, not key strings (fixes probe C2: one Enter runs a binding 3×; C8: a key-bound override silently absent on Android) |
| 25-field before-input snapshot + repair-target module | 122 | 15 | … the attempt's target is a model range (anchors); predicates are computed from it |
| Seven suppression flags, four timers, consume/suppress/repair/clear functions, repair-target plumbing through 11 call sites | 356 | 115 | … at most one attempt is open per view and it names who owns the resulting DOM mutation (`owner`, `expect`, deadline, `failed` phase — fixes C7: a throwing plugin leaves windows armed and the user's input is reverted) |
| Second adopter on the `input` event + the mention trigger hard-coded into adoption | 110 | 0 | … the mutation queue is the only adopter and it inserts through the interceptable operation |
| Declared-range → DOM selection → re-derive → snapshot round trip; block-selection target decided twice | 121 | 60 | … admission resolves the declared range directly into the attempt's anchored target |
| Composition: model-written preview/commit in commands, `onCompositionEnd` + stabilize, `getFinalCompositionMarks`, text-side region resync and offset remap, the `deleteAt` numeric-coincidence redirect, the observer's own cancel, 9 reset sites over 6 fields | 542 | 180 | … at most one session exists; only it writes composition state; it ends through exactly one of `commit`/`cancel`; its region is two anchors, never cached numbers (the one abandonment semantics — keep or delete replicated preview atoms — is decided once, see §11) |
| Keydown handled by two listeners (node capture + document bubble) | 8 | 0 | … one handler per occurrence |

### 5.12 Adoption keeps identity

| Mechanism | Now | Survives | Unnecessary while … |
|---|---|---|---|
| `diffText` "advanced" path: similarity switch, a Myers stub whose result is discarded, a word diff that degenerates to delete-all/insert-all (probe C4: a 700-char foreign rewrite deletes and re-inserts all 1,100 atoms, killing anchors, remote carets and concurrent inserts, and flattening marks) | 199 | 0 | … adoption diffs by common prefix and suffix only (35 xloc survive) |

### 5.13 Commands are values (rule 5) — `view/commands`

| Mechanism | Now | Survives | Unnecessary while … |
|---|---|---|---|
| Seven `PreventionError` catch sites, including the hotkey catch-all that reports any `TypeError` as "handled" | 25 | 0 | … a veto is a returned value observed before the transaction opens (fixes probe `prevent-midway`: `# ` under a vetoing plugin loses both characters) |
| Twenty `stopCapturing` call sites in 9 files + ad-hoc snapshot queueing (markdown, slash, mention and arrow-move never cut a step) | 30 | 0 | … the dispatcher applies one undo policy per command kind |
| Seven readonly checks inside controllers | 20 | 0 | … permission is checked once at admission |
| `{#key editorDomRevision}` whole-editor remount + `refreshEditorDom`, `history/refreshDomAfterHistoryChange.ts` (drift scan, resync of every text, sweeps, duplicate restore) | 134 | 0 | … a block's rendered children are a pure derivation of the cell, committed in the same flush (fixes probe `tab-remount`: one Tab rebuilt the whole editor DOM three times) |
| Toolbar selection snapshot + four re-assertions; slash menu numeric range | 44 | 0 | … held ranges are selection values (anchors); focus moving into chrome never rewrites the editor selection (fixes probe `stale-offsets`: link applied to "lo wo") |
| **Added**: the dispatcher | — | +100 | |

### 5.14 The core owns every node in the host; chrome lives outside

| Mechanism | Now | Survives | Unnecessary while … |
|---|---|---|---|
| `use:block.attach` repeated in ~20 snippets, the handle ownership guard for double attachment, the core's hard-coded `heading`/`level` re-key | 28 | 0 | … `Block` renders the one block element with a tag from `definition.element(data)`; snippets render inner markup (fixes probe `code-attach`: two elements claim one block) |
| Suggestion Proxies over live-wrapper APIs + fresh ids per getter read | 100 | 0 | … snippet payloads are declared view objects; a suggested atom supplies `selected: false` (fixes probe `suggestion-mention`) |
| Four positioning loops (slash menu, toolbar, drop indicator, demo menu) | 102 | 35 | … one anchored-positioning helper for the overlay layer |
| Handle alignment via mutation-record analysis of the subtree | 49 | 0 | … handles live in the overlay and are realigned once per frame / resize |
| Root browser-attribute action; handle plugin de-duplication and WeakSet recognition | 56 | 8 | … root attributes are declarative; handles are a view option |
| Click → caret re-derivation from pointer coordinates in every text element | 36 | 0 | … text elements contain only model text, so a native click already lands on a mappable point (**risk**: keep if a real-browser check disproves it) |

### 5.15 One content flow and per-kind records

| Mechanism | Now | Survives | Unnecessary while … |
|---|---|---|---|
| Hand-written HTML tokenizer, tree builder, entity table (`plugins/html/parser.ts`) | 426 | 0 | … HTML only arrives through browser events, where `DOMParser` exists (the tests that pin the tokenizer run under jsdom) |
| Deserializer's `$fragment` pseudo-blocks, `mergeTrailingMarks`, duplicated mark application and branches | 211 | 0 | … the importer yields a flow of inline runs and blocks; placement decides where leading and trailing runs go |
| Mapping validation against registries on every paste (synthetic validation nodes); default tag tables | 239 | 35 | … mappings resolve once at registration from kind/mark records; an unregistered result degrades to paragraph / plain text |
| Three placement implementations (internal content, internal blocks, HTML) + selected-block replacement helpers + double id stripping | 138 | 45 | … one placement function places any flow at a collapsed target; ids are made fresh at the JSON → spec boundary (fixes probe `paste-shape`: three structures for one fragment; `empty-html`: heading destroyed by an empty paste) |
| Core clipboard export naming 11 plugin types; the rich-text command list; markdown per-type converters, eligibility and caret restore; the slash icon table | 404 | 60 | … each kind record carries its label, icon, keywords, markdown prefix, HTML import/export and empty shape |

### 5.16 One caret-stop stream and bindings as data — `keys/`

| Mechanism | Now | Survives | Unnecessary while … |
|---|---|---|---|
| Five document-order walkers (word positions, horizontal crossing, extend destination, adjacent editable text, block/document boundary) and 26 near-identical binding closures (`hotkeys/navigation.ts`) | 589 | 200 | … one ordered stream of caret stops with a direction; motions are predicates over it; bindings are rows |
| Hotkey file: throw-based dispatch, key-union `Set` kept only for its type, atom deletion by whole-tree search (duplicated in keydown), block-selection keys with a root-index-only order (probe `block-extend`), Emacs closures | 667 | 300 | … handlers return results; order is the index's document order; atoms know their block |

### 5.17 – 5.20 Collaboration: held ownership and container-level compatibility (rule 12)

| Mechanism | Now | Survives | Unnecessary while … |
|---|---|---|---|
| Schema-as-data gating: `canApplyDirect` (re-implements the engine's origin-chain resolution), `applyUpdateStaged`, hydration fast and per-row staging, refusal latch that disables compaction forever, gate/emit/dedupe closures, eight outbound re-checks | ≈ 276 | ≈ 21 | … a replica integrates bytes only from writers of its own `{engine, wire, schema}` generation, proven by the frame envelope and the container record; the document observes its own stamp and turns itself read-only once if a same-generation writer forges it (fixes P2: the gate protected the stamp, not the content; P7: the transport silently stopped persisting user input) |
| Two-round empty-room settle window; failed-provider hand-back + 50 ms readiness poll; view 0 ms self-seed; reserved-id bootstrap seed; migration's hand-written meta-only branch; gated full-state push + duplicated socket hello | ≈ 180 | ≈ 15 | … opening never writes (an empty document shows a virtual first block that the first command materializes) and one join rule — on a peer Step1, reply Step2 and, if the peer holds what we lack, our own Step1 — makes two replicas hold each other's state after one exchange (fixes P4/P4b/P4c: seed duplicates or erases room content; P5: offline edits never reach peers under defaults; P6: the first client of a room never becomes ready) |
| Presence: three caret encodings, legacy id/offset fields and the numeric and mirror fallbacks, owner registries + destroyed-view sweep, three equality notions, a second model → DOM walker, the never-read presence revision | ≈ 255 | ≈ 10 | … every presence key has exactly one writer, the view that minted it, which removes it on teardown; the wire carries anchors only (no older peer exists: v13 peers are excluded by the envelope and no pre-anchor v14 peer shipped) |
| Migration arbitration: claim loop, lease/owner vocabulary, polling `waitForSettled` + an announce whose payload nobody decodes, three owner-carrying record writes, the key-0 overwrite, duplicated codec/open/stamp | ≈ 216 | ≈ 16 | … the store is append-only for every writer; an import is visible iff its row and `active` record committed together; exclusivity is a platform lock that dies with the tab (fixes P3/P3b: forced re-migration loses edits or keeps a random per-block mix) |

### 5.21 Dead or unused code (no representation change needed)

| Mechanism | Now | Note |
|---|---|---|
| `utils/jsx.ts` | 70 | no importer in `src/`, tests or config (the fixture DSL lives in `src/tests/jsx`) |
| `getBlockByIdOrContent`, `Block.renderVersion`, `#depth`, `initialized`, `byItems` path, `REMOTE_ONLY_TRANSACTION` | ≈ 30 | written, never read / zero callers |
| Debug probes `__selDrift`, `__EDYTOR_SEL_DEBUG__`, `__EDYTOR_SEL_LOG__` (the last appends to an unbounded global array in production on every drift revert) | ≈ 9 | move behind a test hook |
| Unused protocol surface: `readSyncMessage` family, `modifyAwarenessUpdate`, IndexedDB `get/set/del`, provider `readMessage` test seam | ≈ 65 | **declared API retirement**, not simplification of the candidate |

### 5.22 Reconciliation

| Source of reduction | xloc |
|---|---|
| Ledger rows 5.1–5.21 (each tied to a representation decision or dead code), net of the code each decision adds | ≈ −11,150 |
| Of which: moved to `src/tests` as oracles (not a simplification) | 82 |
| Of which: unused surface retired (needs maintainer acceptance) | ≈ 325 |
| Trims inside retained responsibilities (the readers' line-by-line floors for code whose responsibility survives: pointer handling, observation utilities, structural ops, facade object, lifecycle, provider option plumbing, controllers, components) — **not** tied to a representation change and the least certain part of the estimate | ≈ −3,700 |
| **Total** (29,026 → ≈ 14,170) | **≈ −14,850** |

---

## 6. Distinctions kept explicit, and the bug each prevents

Compressing a representation is only safe where two facts are truly one.
These pairs look compressible and are not; each row names the representation
that holds each side in this design, and the bug that merging them causes
(observed by a reader probe where cited, otherwise derived from a contract).

### 6.1 The method's canonical pairs

| Distinction | Held as | Bug if merged |
|---|---|---|
| **Definition vs occurrence** (kind: role, element tag, renderer, external forms, default-child rule — vs a block: id, type name, data, position) | definitions in the view registry, adopted once into document semantics; occurrences in A1 | the core hard-codes `heading`/`level` for re-keying (a `title` type loses it); permission cached on an occurrence goes stale after a remote type change of an ancestor; one code definition renders two elements claiming one block (probe `code-attach`) |
| **Definition vs occurrence of an id** (an id that exists, live or deleted, vs a new block that wants it) | registry keys are never reused; replacement specs mint fresh ids or explicitly target the live block | `setBlock` with existing child ids silently drops a child and can never succeed on retry (probe C4) |
| **Prepared intent vs execution attempt** (an admitted command — resolved target anchors, veto observed — vs its transaction) | command value + dispatcher; the attempt record for input; the composition session's start target | a veto or throw inside a transaction half-executes it: range delete duplicates text (probes P11/P11b), `# ` loses both characters (`prevent-midway`); a composition commit recomputing its target from the post-preview DOM deletes the preview twice |
| **Announced intent vs executed effect** (a non-cancelable `beforeinput` vs what the browser actually did) | attempt `owner = browser` + `expect` + deadline + `failed` phase | Android's no-op Backspace never deletes (`mobile-beforeinput.spec:706`), or deletes twice; a concurrent remote edit makes the no-op check lie (reader C5) — the check must be "does the atom before my anchored caret still exist" |
| **Observation vs guarantee** (DOM text, mount state, `selectionchange`, a provider's `synced` vs document state, declared roles) | cells and the document are the guarantee; DOM and events are observations interpreted once | phantom slots inferred from `node == null` are wrong in every settle window (UNRESOLVED-2 class); the transport treated "the stamp stayed supported" as "incompatible content stayed out" (probe P2) |
| **Transport success vs operation success** (a frame applied vs "this replica reflects the other side") | `hasSynced` from an applied Step2 carrying state; the join rule; readiness never inferred from silence | a relayed empty Step2 counts as "synced", the document seeds, and a reserved-id seed erases room content (probes P4b/P4c) |
| **Capability vs permission** (the document could accept a move / the user can select and copy — vs readonly and plugin vetoes allow it now) | structural permission in D1; readonly and hooks at command admission | the drop indicator hides legal drops or shows drops that silently fail; readonly editors lose selection; `isContentEditable` used as permission captures caption typing |
| **Completed external effect vs disposable state** (the OS clipboard written by cut; a durable import row — vs selection, attempts, locks) | cut writes the clipboard *then* dispatches the delete; migration row + `active` record commit together, the lock is platform-released | cut loses data when the delete is vetoed; storing attempt ownership durably forces leases, expiry, polling and a reclaim race |

### 6.2 Representation-specific pairs

| Distinction | Held as | Bug if merged |
|---|---|---|
| **Where characters are stored vs which block displays them** | backing texts (items never move) vs streams + merge claims | copy-on-split: an offline peer's edit to moved text lands on dead items (`lost-edit`, `duplicate-inline` classes) |
| **Gap ownership vs insert affinity** | the containing stream vs the anchor side | one bit for both: a caret absorbs boundary inserts (`nにello`) or migrates into the neighbor that received text at a shared gap (anchor rule 1) |
| **Deleted vs hidden** | explicit replicated `del` flag (wins) vs derived (merge-claimed, or under a deleted ancestor) | undoing a merge cannot restore the source; "deleting the destination voids the merge" becomes inexpressible; un-hiding a moved child would need a write |
| **Causal position vs display position vs DOM position** | anchor vs `(block, offset)` vs `(node, offset)` with ZWSP/newline fillers | numeric carets cannot ride remote inserts (`sel.ride.insert`); fillers leak into model offsets; mid-composition writes address the model string instead of the pinned DOM |
| **Causal segment key vs segment ordinal** | key = id of the preceding atom | a peer inserting an atom before the composing segment re-keys and remounts the IME's node (reader X12) |
| **Operation handle vs render cell** | stateless id handle (read-your-writes) vs `$state.raw` pointer to a committed snapshot | today's mirror: 16 mid-transaction full reconciles, O(N·doc) deletes (1,000 blocks: 11 s), half-updated trees seen by callbacks (probe P4b) |
| **Freshness token vs publication revision** | D1 fold version (bumps inside a transaction) vs the view's per-commit revision | reactive consumers re-run on uncommitted state, or never re-run |
| **This view's commit vs another local view's commit vs a remote commit** | transaction origin identity vs the engine's `local` flag | a sibling view's undo restores this view's caret, or this view's caret stops riding a sibling's edit |
| **History restore (issuing view) vs caret riding (every other view)** | stack-item meta read only by the issuing view; anchors for everyone else | sibling carets are yanked to a snapshot recorded long ago (and today, two restorers in the issuing view race: probe C1/P4) |
| **Unresolvable because not yet integrated vs because deleted** | anchor resolve returns `pending` vs `dead` | a peer's caret is drawn at a seam instead of waiting for the update; a local caret jumps on a transient |
| **Model destination vs DOM readiness** | projection (destination) vs projector (display when mounted) | a valid destination not yet mounted is read as "no destination" and the caret is stranded after a whole-document remote delete |
| **Phantom content slot vs temporarily unmounted text** | declared by the definition (`renders own content: false`) vs a mount observation inside a settle window | a caret parked on a container's unrendered slot swallows the next keystroke |
| **Echo vs render drift vs foreign programmatic write vs user move** | last display, render epoch, gesture serial | a host application, extension or assistive technology that moves the selection is reverted as "drift" (probe C4) |
| **Foreign focus vs orphaned focus** | one focus predicate: `body` after our own render is orphaned (write), a user-chosen element is foreign (model-only) | steal focus from a control the user chose, or never display the caret after our own remount (three verdicts today) |
| **Renderer-produced record vs browser or foreign record** | the render bracket | the editor's own attribute records arm the idle cancel and delete a live IME preview (probe C1) |
| **Browser-owned change (adopt) vs drift around a model-owned change (revert)** | the attempt's `owner` | duplicated merged text after a non-cancelable merge, or the user's keystroke disappears |
| **Composition preview (replaceable, but replicated) vs committed text vs cancellation** | session `phase`; region anchors; one cancel semantics | appended previews; preview atoms left in the shared document by one abandonment path and deleted by another (two answers today) |
| **User intent vs mechanical replay** (a typed `(` vs a composition preview rewrite) | command `origin: user \| composition-replay \| remote-repair` | auto-pair doubles a composed bracket (`x(a)`); the slash menu opens mid-composition and never after commit (probe `ime-plugins`) |
| **Decoration vs stored mark** | runs are stored; tokens and ghost text are view-only | syntax tokens persisted into replicated marks and inherited by typed text |
| **Pending toggle vs mark value** | pending marks on the selection value carry values | a collapsed Bold toggle drops a link or color from the next character (probe `mark-inherit`) |
| **Command vs transaction vs undo step** | dispatcher policy per command kind | typing stops coalescing, or a forgotten `stopCapturing` merges the next command into the previous step |

### 6.3 Collaboration pairs

| Distinction | Held as | Bug if merged |
|---|---|---|
| **Connection currently synced vs provider has ever synced** | provider `connected` vs `hasSynced` | a healthy provider that lost its socket reports "failed" on destroy (probe P1) |
| **Creating a document vs opening one** | explicit create vs attach/open (never writes) | duplicate seed on a new device, erased room content, a first client that never renders (P4, P4b/c, P6) |
| **Room membership vs room state** | not represented at all (the opaque relay provides neither); nothing waits on it | emptiness inferred from silence never settles for zero members |
| **Stored bytes vs integrated state** | append-only rows; no row is ever refused, so compaction is always legal | compaction deleting bytes the snapshot never contained, or disabled forever by a refusal latch |
| **Import (fresh identity appended) vs replace (a CRDT edit)** | `force` is a replace-edit whose diff is appended | overwriting row 0 loses post-migration edits or keeps a random per-block mix (P3, P3b) |
| **Presence definition (a view's caret) vs occurrence (an entry in the client's shared slot)** | the view key the view minted | clearing by slot strips sibling views' carets or needs polling registries |
| **Replicated state vs ephemeral presence** | A1 vs A4 | presence writes creating undo steps and persisted rows |
| **Monotonic vs restorable attribution** | `contributors` outside the undo scope vs `lastChangedBy` inside | undo strips contributors, or fails to restore the previous last changer |
| **Container identity vs migration progress** | generation record (immutable once stamped) vs import record | stamping a populated foreign store, whose rows later hydrate |
| **Local-only engine state vs replicated state** (`redone`, `keep`, `followUndoneDeletions = true`) | never read by any derivation | replica-dependent ownership (the reason the current undo repair exists) |

---

## 7. LOC table

### 7.1 Per current domain (target attributed to where the surviving code comes from)

Attributing by origin keeps moves visible: code that leaves a domain is
counted in the domain it came from, at the size it has after the move.

| Current domain | Current | Target | Delta | Where the surviving code lives |
|---|---:|---:|---:|---|
| `crdt/` | 8,362 | 5,060 | −3,302 | `crdt/` (core 3,620; providers/protocols/migration 1,440) |
| `events/` | 4,519 | 1,745 | −2,774 | `input/` |
| `selection/` | 3,871 | 1,768 | −2,103 | `selection/` 1,660; range-selection commands → `view/operations/range` 90; model → DOM mapper → `view/dom-map` 18 |
| `plugins/` | 3,780 | 1,843 | −1,937 | `plugins/` 1,808; the shared chrome positioning helper → `components/` 35 |
| root files (`edytor.svelte.ts`, `hotkeys.ts`, `edytor.utils.ts`, `plugins.ts`, `utils.ts`, `index.ts`, `constants.ts`) | 2,497 | 1,130 | −1,367 | `view/edytor` 560, cell patching 60, `keys/` registry + block keys + Emacs 295, range delete 90, structural-key fallback → `input/attempt` 30, `plugins.ts` 75, misc 20 |
| `block/` | 1,716 | 541 | −1,175 | `view/operations/block` 310, handles 110, content range 35, segment derivation 26, atom edge clicks → `selection/pointer` 60 |
| `text/` | 1,191 | 500 | −691 | `view/operations/text` 230, handles 60, cell render facts 75, composition pin → `input/composition` 70, deltas 65 |
| `collaboration/` | 666 | 387 | −279 | `collaboration/` |
| `components/` | 614 | 299 | −315 | `components/` |
| `hotkeys/` (navigation) | 589 | 200 | −389 | `keys/navigation` |
| `clipboard/` | 518 | 254 | −264 | `content/` |
| `utils/` | 500 | 225 | −275 | JSON boundary 190, prefix/suffix diff → `input/adopt` 35; `jsx.ts` deleted (dead) |
| `history/` | 200 | 0 | −200 | the one restorer is part of `selection/projector` (counted in `selection/`) |
| `dnd/` | 3 | 3 | 0 | — |
| **New owners** | 0 | 215 | +215 | dispatcher 100, next-marks rule 30, virtual first block 40, render bracket + render epoch + causal segment keys 45 |
| **Total** | **29,026** | **≈ 14,170** | **≈ −14,856 (−51.2 %)** | |

Baseline note: the task's stated baseline is 28,941; today's count is
29,026 (+85 in `selection/`). Against 28,941 the target is −51.0 %.

### 7.2 What the number depends on (scenarios)

| Scenario | Total | vs today |
|---|---:|---:|
| **A.** Every representation change passes its checkpoint; retained code is rewritten at the readers' line-by-line floors | ≈ 14,170 | −51 % |
| **B.** A, but retained code overshoots the floors by 10 % | ≈ 15,600 | −46 % |
| **C.** Start markers rejected at their checkpoint (slice records, contest and undo repair stay; everything else as A) | ≈ 15,190 | −48 % |
| **D.** Render bracket rejected at its checkpoint (observer keeps classification ≈ 1,100; a placeholder sweep ≈ 100 stays) | ≈ 15,075 | −48 % |
| **E.** C and D | ≈ 16,095 | −45 % |
| **F.** E with a 10 % overshoot | ≈ 17,700 | −39 % |
| **G.** Maintainer declines retiring unused surface (§5.22) | + 325 on any row | ≈ +1 pt |

The 40–50 % target therefore holds unless both high-risk representation
changes fail **and** retained code overshoots its floors. The view-side
changes (selection value + projector, cells + handles, commands, attempt +
session, content flow) carry about −8,000 on their own and are the part to
protect.

### 7.3 Honesty notes

- **Moved, not deleted.** Composition code moves from the runtime root and
  the text wrapper into one session (≈ 390 lines become ≈ 180, of which
  ≈ 100 are moves); range-selection commands (90) move from `selection/` to
  operations; atom edge clicks (60) move to pointer handling; the seam's
  placement query (≈ 15–20) moves into the document index; four positioning
  loops become one helper (35). All are counted where they land.
- **Retiring comparison implementations is not simplification.** The dense
  ownership oracle, `computeAllRuns`, `blockRecordsOf` and today's
  `diffSnaps` leave `src/lib` for `src/tests` (82 xloc of production code
  moves; `diffSnaps` stays as the change-record oracle). They must stay
  runnable so the new representations remain falsifiable.
- **Unused surface.** ≈ 325 xloc of the reduction is API that nothing in the
  repo uses (decorations, subscriber variants, protocol parity readers,
  IndexedDB `get/set/del`, barrel internals). Its removal is a declared API
  retirement for a 0.0.x package, not a simplification of the candidate.
- **Type bodies.** About 580 xloc of multi-line `export type` bodies are
  counted by the script in both columns (crdt ≈ 333, runtime ≈ 250). They
  survive in any design.
- **The least certain 3,700.** Trims inside retained responsibilities come
  from the readers' floors (code rewritten at the size its remaining job
  needs). They are the likeliest to overshoot — hence scenario B.
- **Bundle.** Not measured. The vendored engine (7,125 xloc) dominates the
  shipped bytes. Most deletions here are executed code (tokenizer 426,
  staging 130, contest + repair ≈ 600, liveness + spec tables ≈ 600, retry
  loops ≈ 400), so the bundle should shrink, but not proportionally;
  measure with `bench/` before claiming a number.
- **Runtime cost moves too.** The render bracket adds one synchronous flush
  per commit (a flush that would have happened a microtask later anyway);
  the index removes the quadratic in-transaction re-fold (reader C10) and
  the O(N·doc) mirror reconciles (reader P9). Measure both with `bench/`.
- **Tests.** Test LOC is outside the metric, but the rewrite is real: mirror
  and scoped-refresh unit tests (they pin the mechanism, not a guarantee),
  the history snapshot tests, the placeholder queue tests, the schema-gate
  suites (`schema-boundary` 613 lines, `wu3b-staging` 290, most of
  `r2-idb-compaction` 404), ownership-regression and undo-repair suites
  (re-pinned against markers), tokenizer and mapping-validation fixtures.

---

## 8. Falsification tests (must pass before the matching implementation proceeds)

Each test is the smallest counterexample I could find for one
representation claim. **Expected** is derived from a contract (delete
contract rule or row, selection doc, reader's required-behavior list, pinned
spec), never from either engine's current output. Where the contract is
silent the row says **decision** and names the value this plan proposes;
the maintainer must confirm it before the test is written. "Gate" is the
checkpoint (§9) that cannot close until the test passes. Every test runs on
both delivery orders, with duplicate delivery and a binary reload, where the
scenario has more than one replica.

### 8.1 Start markers (rule 2) — gate CP7

| ID | Scenario | Expected (source) |
|---|---|---|
| M1 | `hello world` split at 6. Type `X` at the head's end and `Y` at the tail's start — locally, then as two concurrent peers | head `hello X`, tail `Yworld`, both cases (boundary affinity `R8`) |
| M2 | `hello world`: A splits at 3 (`sA`) ‖ B splits at 8 (`sB`) | three blocks with `hel`, `lo wo`, `rld`, each character exactly once (`TX04b`, `R3`); reading order: **decision** — propose `hel │ lo wo │ rld` via a placement tie-break by stream order (today 16/40 client pairs misorder; not fixed by markers alone, see §11) |
| M3 | Same point: A splits at 6 (`x`) ‖ B splits at 6 (`y`) | both blocks exist; `world` in exactly one; the other empty (`TX04a`) |
| M4 | Split at 6, delete `world` in the tail, undo; deliver the undo to a receiver | head `hello `, tail `world` on the undoing replica **and** on the receiver, delivered as **one** update — no frame shows `hello world` in the head (`R16`; falsifies today's two-update repair, reader C2) |
| M5 | M4 with lineage depth 5 | still one update per undo (reader C13 shows three today) |
| M6 | Split `abcde` at 3. B types `Q` at the tail's head ‖ A deletes the tail. Also: the same delete through the headless facade | head `abc` everywhere (`conc.delete-wins-block`, `G8`; falsifies reader probes P3/P3b) |
| M7 | Caret `anchor(block, 0, left)` in (a) a fresh block `Hello`, (b) a split-born block `Hello`; a remote peer splits that block at 0 | caret stays at `{original block, 0}` in **both** histories (anchor rule 1 and left affinity; today the two histories disagree, reader C3) |
| M8 | Range delete from inside the head's stream to inside the tail's stream (one backing text) | the tail keeps its marker (it still exists as a block until the range-delete contract merges it); no content delete removes a marker (A-1) |
| M9 | Two replicas each split a different block using caller id `x` | exactly one live `x`; the non-matching marker is inert; no text lost or duplicated (`R12`, A-2) |
| M10 | B inserts `\|` at offset 6 of `hello world` ‖ A splits at 6 | `\|` in exactly one block, identical on both replicas; which side is **decision** — the pinned head side (`TX06a`) becomes an engine tie-break side unless an explicit rule is added (A-3) |
| M11 | A undoes its split ‖ B types in the tail | B's text joins the head (`HI01a`, A-4) |
| M12 | A deletes the tail's `world`; B (having received it) splits the empty tail at 0 creating `u`; A undoes | **decision** — markers put `world` in `u` (the block now displaying that gap); today it returns to the tail. Propose accepting `u`: the contract's "the block that displayed it" is ambiguous after a concurrent structural change, and the alternative needs an engine primitive (A-5) |
| M13 | Type 20 characters one per transaction at a split-born block's start | wire bytes per keystroke within 10 % of typing mid-text (today 68 B vs 15 B, reader C7) |

### 8.2 One index per document (rule 4) — gate CP6

| ID | Scenario | Expected (source) |
|---|---|---|
| I1 | Delete `p`; then on its hidden child `c`: insert text, insert a child, move to root, split | all four `refused`, zero update bytes (`R12`/`R13`; today three return `true`, reader C6) |
| I2 | 2,000 block inserts inside one transaction vs 2,000 separate transactions | within 1.2× of each other (linear fold; today 4×, reader C10) |
| I3 | `root > [X > [box(island) > [A]], Y]` | "next block after A" is one answer for selection walks, range delete and merges (today two, reader P1) |
| I4 | Change record vs the retained `diffSnaps` oracle over the random corpus | identical on every commit |

### 8.3 Commands, cells, handles (rules 5, 6) — gates CP2, CP5

| ID | Scenario | Expected (source) |
|---|---|---|
| V1 | Range delete over 1,000 paragraphs (jsdom) | < 100 ms and one undo step (`G25`; today 11 s, reader P9) |
| V2 | `root > [box(island) > [A "aa"], Y "yy"]`, select A@1 → Y@1, Backspace | the island stays sealed: nothing outside moves in (`G6`; today `A "ay"`, reader P2). Exact result: the document's merge rule refuses the join, so the range delete clears both partial ranges and leaves both blocks — `A "a"`, `Y "y"` (derived from the `del.range.*` rules plus the island seal; confirm in CP0) |
| V3 | Range a@1 → d@1 over four paragraphs; a plugin vetoes `removeBlock` | the veto applies to the user-level command only; either the whole command is refused before any write, or internal steps do not consult the hook — never `["a:ad","c:cc","d:d"]` (reader P11b) |
| V4 | Same range; an after-hook throws | the transaction commits fully; the after-hook observes a committed result and cannot unwind it (`R13`) |
| V5 | `moveBlocks([], dest)`; `insertBlocks(dest, [])` | both `noop` (one result type; today `false` vs `true`, reader C8) |
| V6 | Enter at the end, middle and start of a `list-item`; merge an island child out into a list | every new block is a `list-item` inside the list (`G5` parent-appropriate default; today `paragraph` at end/start, probes P10/P12) |
| V7 | Composing in the second segment of `ab@cd`; a peer inserts an atom before `@` | the composing text node keeps its identity (no remount); the commit lands after `@` in the right block (`G18`; reader X12) |
| V7b | Composing in the segment after atom `@` in `ab@cd`; a peer deletes `@` | the composing node survives until the session ends: segment derivation takes the session as input and keeps the pinned key alive (`G18`); after commit the segments merge normally |
| V8 | One Tab on `A, B\|b` | zero whole-editor remounts; only B's element is re-parented (probe `tab-remount`: three remounts today) |
| V9 | `placeholder-repair.spec` (9 tests) against the CSS placeholder | all pass; no placeholder node exists in the host |

### 8.4 Selection value and projector (rules 7, 8) — gate CP3 (real-browser lanes on all three engines)

| ID | Scenario | Expected (source) |
|---|---|---|
| S1 | `Hello world`, caret @5, type `abc`, a peer inserts `XYZ` at 0, undo — through `beforeinput historyUndo` and through `historyUndo()` | caret after `XYZHello` (@8) both ways (`H1` + anchor ride; today @5 vs @8, reader C1) |
| S2 | Caret in `Second`@3, focus an outside button, a peer deletes `Second` | value moves to the seam (`First`@5); exactly one `onSelectionChange`; presence republishes; focused-block attribute moves (`P1`/`P2`; reader C2) |
| S3 | Select block `bb` in `[aa, bb, cc]`; a peer deletes `bb` | the value becomes the seam caret (`cc`@0); no dead id remains selected (reader C8) |
| S4 | Editor focused; host code calls `setBaseAndExtent` on text@1 → end with no gesture | the value adopts the programmatic range; nothing reverts it (reader C4) |
| S5 | Paragraph `ab` + bold `cd` + `ef`; DOM point `(textElement, i)` for each `i` | offsets 0, 2, 4, 6 at the child boundaries (reader C5) |
| S6 | Forward native range with anchor text@1, focus `(textElement, childCount)` | `start ≤ end`, forward (reader C6) |
| S7 | From caret @1: `setAtTextOffset(4)` then `setAtRange(2, 6)`; and the reverse order | the later request wins in both orders (`W1`; reader C7) |
| S8 | `[alpha, list > item(beta), omega]`, caret in `beta`, a peer deletes the list | caret `omega@0`; the next keystroke lands there (`sel.seam.nested-subtree`) |
| S9 | Select the first child of a list, delete, undo, redo | the caret lands where the seam rule says — one answer for redo, remote delete, cut and block-set delete (`H3`; three answers today, reader C11) |
| S10 | Gecko: render replaces the text node under a live caret (mark toggle mid-word) | no model movement; DOM re-displayed once (echo/drift, `W2`) |
| S11 | Android: canceled `deleteContentBackward` followed by the +1 caret echo | model caret stays at the merge point (`android-caret-restore.test`, the one retained gesture-carrying signature) |

### 8.5 Attempts, sessions, provenance (rules 9, 10) — gates CP1, CP4

| ID | Scenario | Expected (source) |
|---|---|---|
| N1 | `Hello\|`, compositionstart, preview `に`, no event for 850 ms while the editor itself writes focus attributes | session still live, preview intact (`G18`/`G19`; today deleted by the idle cancel armed by the editor's own records, reader C1) |
| N2 | A plugin binds `mod+alt+k` without claiming; press it once. Same for a non-claiming `enter` binding | each runs once per keydown (occurrence identity; today 2× and 3×, reader C2) |
| N3 | `he[ll]o`, Backspace keydown with no `beforeinput`; a peer inserts `XX` at 0 before the deadline | `XXheo` (anchored keydown target; today `XXllo`, reader C3) |
| N4 | 1,100-char paragraph, a foreign script replaces the middle 700 characters | adoption = retain 200 / delete 700 / insert 700; a peer's caret in the first 200 keeps its position (reader C4) |
| N5 | Android no-op `deleteContentBackward`; a peer edits the same text within the deadline | exactly one character deleted (reader C5) |
| N6 | Non-cancelable text insertion; a plugin hook throws | the user's character appears exactly once (`A.1` "exactly one effect"; reader C7) |
| N7 | Editable caption inside an image void inside a list item, with a plugin chrome control beside it: type, paste, cut, compose, undo in the caption | none of these events reaches the document or the editor selection (`O5`; reader C9) |
| N8 | Composition in a block that a peer deletes | no DOM caret write during the composition; the session ends by the decided cancel/commit rule (**decision**: propose `cancel`, deleting the replicated preview atoms, since the host block is gone) |
| N9 | Paste during composition; undo during composition | native paste proceeds untouched; undo swallowed (`C2`, `31`) |

### 8.6 Collaboration (rule 12) — gate CP8

| ID | Scenario | Expected (source) |
|---|---|---|
| C-1 | Two socket clients sync; B's socket drops; destroy B | no `failed` event (`G11`; today fired, P1) |
| C-2 | New device: empty IndexedDB, room holds content; view created with and without `value` | room content appears once; nothing duplicated or erased (`G9`; P4, P4b/c) |
| C-3 | First client of a socket room, library defaults | editor usable at once (virtual first block); a second client's content arrives (`G9`/`G10`; P6/P6b) |
| C-4 | B disconnects, edits offline, reconnects; A stayed connected; defaults | A receives B's edits (`G2`; P5) |
| C-5 | migrate → type → force re-migrate → reload | the typed edit survives; no pending structs (`G29`; P3/P3b) |
| C-6 | Two views with inline `createIndexeddbSync('notes')` on one document | one provider, rows grow linearly (`G12`; P8) |
| C-7 | A peer of another schema generation; and a same-generation forged stamp | frames dropped observably; forged stamp → document read-only + one signal; no silent loss of later input (`G13`/`G15`; P2, P7) |
| C-8 | A view of a shared document is torn down with no sibling activity afterwards | its caret disappears for peers (`G21`; reader C14) |
| C-9 | A peer idles; the local user scrolls | remote caret stays on its anchor (`G24` — missing today, reader C12) |

### 8.7 Plugins and content (rules 5, 6) — gate CP9

| ID | Scenario | Expected (source) |
|---|---|---|
| P-1 | Fragment of two paragraphs `X`, `Y` pasted at `Hello\|World` through the internal, HTML and plain paths | one structure for all three: **decision** — propose `["HelloX", "YWorld"]` (leading run joins the text before the caret, trailing run the text after; the plain path already does this) |
| P-2 | `A, B{B1}, C`; move A down with the arrow-move binding and with the handle's Alt+Down | one meaning: `B{B1}, A, C` (handle keys "move before/after/inside/outdent", `X9`) |
| P-3 | Caret inside red italic text; Mod+B; type | `{color: red, italic, bold}` (`G2`; today red is dropped, probe `mark-inherit`) |
| P-4 | Select `world`, focus the link field, a peer inserts `ZZZ` at 0, apply | link on `world` (`G1`; today on `lo wo`) |
| P-5 | In a code line compose `(` → `(a` → commit; compose `/` → `/h` → commit in a paragraph | `x(a` with no auto-pair duplication; the slash menu opens once after the commit, not mid-composition (probe `ime-plugins`) |
| P-6 | Paste HTML containing only a comment into an empty `h2` | no change and no undo step (probe `empty-html`) |
| P-7 | Slash menu with zero matches; press Enter | Enter is not swallowed (reader §7-14) |
| P-8 | Nested list `A{A1, A2, A3}, B`; select A3; Shift+Up twice; Shift+Down | `{A3, A2}`, `{A3, A2, A1}`, then back to `{A3, A2}` — document order, not root index (probe `block-extend`) |

---

## 9. Bounded migration sequence

### 9.1 Ground rules (apply to every checkpoint)

- **The reference stays runnable.** Each checkpoint puts the new
  representation next to the old one, switches consumers, and deletes the
  old path only after the gate passes. `pnpm check`, `pnpm lint`,
  `pnpm test -- --run`, `pnpm test:dom`, `pnpm test:crdt` and the chromium
  Playwright lane are green at every commit; the DST solo/collab lanes and
  the firefox/webkit specs are green at every checkpoint exit.
- **Tests first.** The §8 rows of the gate are written before the unit:
  rows the current engine passes become pins; rows it fails are marked
  expected-fail with the contract value, and flip at the gate.
- **Shadow before switch.** Where a new derivation replaces an old one
  (selection projection, cells, change record, streams), it first runs in
  shadow and the two are compared on every fixture; every difference must
  match a §8 row or it is a regression.
- **Redesign limits.** Each checkpoint names the complication that means the
  representation is missing a fact. Hitting it stops the checkpoint; the
  repair order is: clarify the requirement → find the existing semantic owner
  → improve that owner's representation → add a new concept only if an
  independent responsibility remains. **No checkpoint may add a timer, a
  one-shot flag or a retry loop** — that is always a redesign trigger.
- **Measure at exit.** `xloc.mjs --files` per module against §4; `bench/`
  for runtime; record in the ledger.

### 9.2 Checkpoints

Two tracks can run in parallel: **headless** (CP6 → CP7 → CP8-document) and
**view** (CP1 → CP2 → CP3 → CP4 → CP5 → CP9). CP8's presence and view parts
start after CP3.

**CP0 — Harness, decisions, dead code (no behavior change).**
- *Contract:* none changes.
- *Unit:* move the dense ownership oracle, `computeAllRuns`,
  `blockRecordsOf` to `src/tests` (still runnable); write every §8 row;
  delete §5.21 dead code; record the maintainer's answers to every
  **decision** row and to the scope changes in §11.2.
- *Exit:* all lanes green; decisions written into the delete contract.
- *Limit:* a decision that cannot be made blocks only its own row's gate.

**CP1 — Render bracket (view; first because it is the riskiest view bet and small).**
- *Contract:* rule 9. No record produced by the editor's render is
  classified.
- *Tests first:* N1; `dom-mutation.spec`, `placeholder-repair.spec`,
  `composition*.spec`; the DST foreign-mutation oracle.
- *Unit:* commit path = flush pending records → apply → `flushSync` →
  discard `takeRecords()`; selection attribute writes inside the same
  bracket; declared chrome subtrees ignored by location. The old classifier
  keeps running in shadow and **counts** records it would have called
  renderer-made; the count must be zero on every lane before its liveness
  inference, spec tables, repair caret restore and time-window suppression
  are deleted.
- *Limit:* if after two iterations a render into model territory cannot be
  moved inside a bracket (e.g. an effect-timed write the editor does not
  control), stop: keep classification (scenario D, +900) and continue.

**CP2 — Commands as values (view).**
- *Contract:* rule 5. One dispatcher; vetoes are values; one transaction;
  undo policy per command kind; results `applied / noop / refused` + a
  selection intent (applied at first through the existing selection API).
- *Tests first:* V3, V4, V5; `prevent-midway`; one step per command for
  markdown, slash, mention and arrow-move; `undo-scope.spec`.
- *Unit:* wrap the existing operations; `prevent()` becomes an adapter that
  returns `refuse`; delete the catch sites, `stopCapturing` sites and
  controller readonly checks.
- *Limit:* two plugins needing different transaction boundaries for one
  command is a missing command kind, never a flag.

**CP3 — Selection value, commit point, projector, one restorer (view).**
- *Contract:* rules 3, 7, 8, 11.
- *Tests first:* S1–S11, `selection*.spec`, `navigation-selection-sync.spec`,
  `android-caret-restore`, `composition.spec:565`, DST solo on all engines.
- *Unit, in five green steps:* (a) the value and `project()` run in shadow
  next to today's state, compared on every DOM fixture; (b) writers go
  through the commit point; `selection.state` becomes a compatibility getter;
  (c) the projector and classifier replace the write loops and the ignore
  flags; (d) one history restorer (the value in stack-item meta); (e) delete
  the old machinery and the second restorer.
- *Limit:* the classifier may carry at most two gesture-carrying signatures
  (Android post-delete, IME post-commit jump). A third means a render-epoch
  source is missing; find it, do not add a case.

**CP4 — Input attempt, composition session, intents table, one adopter (view).**
- *Contract:* rule 10.
- *Tests first:* N2–N9; `beforeinput-fallback.spec`, `mobile-beforeinput.spec`,
  all `composition*.spec`, `unsupported-beforeinput.spec`, `input.spec`,
  `dom-mutation.spec`; command-simulation programs; DST.
- *Unit:* the attempt record replaces the flags and timers; the session
  holds two anchors and the host element; one intents table; fabricated
  events deleted; adoption through interceptable operations with the
  prefix/suffix diff.
- *Limit:* the attempt may only gain fields for facts listed in §3.4.

**CP5 — Cells and handles replace the mirror (view).**
- *Contract:* rules 1, 3, 6.
- *Tests first:* V1, V6, V7, V8; the mirror-incremental tests rewritten as
  "one cell per visible id, unchanged blocks keep their DOM"; the scoped
  refresh tests rewritten as "a keystroke patches one cell";
  `demo-route.spec`.
- *Unit, in five green steps:* (a) cells render in a test route next to the
  mirror, DOM compared over fixtures; (b) components switch to cells with
  causal segment keys; (c) operations switch to the document one at a time;
  (d) handles replace wrappers for plugins; (e) delete the mirror, the
  id/node registries, offset mappers and positional ids.
- *Limit:* a consumer needing object identity beyond the per-id handle
  cache is a plugin API decision, not a reason to put state in handles.

**CP6 — One index per document; effects observed (headless).**
- *Contract:* rule 4.
- *Tests first:* I1–I4; all `test:crdt` lanes; `bench:crdt`; attribution
  suites.
- *Unit:* one fold per transaction with a cursor; one visibility and order
  decider; the change record from the fold report; the write funnel observes
  effects and stamps once.
- *Limit:* the change record must equal the `diffSnaps` oracle on the random
  corpus; after two failed iterations keep `diffSnaps` in production (+110)
  and continue.

**CP7 — Start markers (headless; the schema change).**
- *Contract:* rule 2. Behind a schema flag until green; the reference model
  keeps running the same corpus.
- *Tests first:* M1–M13; the whole CRDT corpus (scenario classes TX, ST, MV,
  AN, HI; random classes; gate suites) against the oracle rewritten for
  streams; collab DST on three engines; anchor wire round trip.
- *Unit:* marker index, `locate`/`position`, split = marker + claim move,
  per-stream delete, anchors binding markers; delete slice records, the
  contest, the undo repair and the owner facet.
- *Limit:* pinned outcomes may change only where §8 says **decision** and
  the maintainer agreed. Any other failure whose fix needs a per-atom
  contest, a generation counter or a repair transaction ends the
  checkpoint: keep slice records (scenario C, +1,020) and record why.

**CP8 — Collaboration representation.**
- *Contract:* rule 12.
- *Tests first:* C-1–C-9; provider suites rewritten as generation-mismatch
  tests; collaboration specs on three engines **with library defaults**
  (no forced `resyncInterval`).
- *Unit:* generation in envelope and container; read-only on a forged stamp;
  open never writes + virtual first block + explicit create; one join rule;
  presence as one entry per view key; migration lock + append-only + one
  container module; `hasSynced`.
- *Limit:* if the `value + sync` contract change is declined, apply the
  minimal step (fresh-id seed, one timeout) and keep ≈ 40 xloc.

**CP9 — Plugins and UI.**
- *Contract:* the core owns every node in the host; chrome in the overlay;
  CSS placeholder; one content flow and kind records; `DOMParser`; the
  caret-stop stream; bindings as data.
- *Tests first:* P-1–P-8, V9; `clipboard.spec`, `drop-beforeinput.spec`,
  `structural-keys.spec`, `hotkeys.spec`, `slash-menu.spec`, `plugins.spec`,
  block-handle fixtures, `selection.spec` navigation rows, `demo-route.spec`.
- *Limit:* HTML whitespace differences between `DOMParser` and the tokenizer
  must be pinned with fixtures taken from real pasted content before the
  tokenizer is deleted.

**CP10 — Close.** Delete remaining old paths; update `AGENTS.md`, the delete
contract (anchor section without the owner facet; one seam rule; presence
wire), the selection and document docs; final `xloc`, `bench/` and bundle
measurement against §7.

---

## 10. Extension-cost check

"Owners that change" counts modules whose code must be edited. Today's
counts are measured by where an existing, fully integrated extension of the
same kind is mentioned in `src/lib` (plus the demo route).

| Extension | Today (measured) | This design | What makes the difference |
|---|---|---|---|
| **(a) A new block type with nested children** (e.g. a callout that holds paragraphs) | **5–7 owners.** `quote` appears in the rich-text plugin (snippet + definition), the command list, markdown shortcuts, the HTML tag table, and **core** clipboard export (`serializeClipboardFragment.ts`), plus the demo menu. A type whose element depends on data also needs the core's hard-coded re-key (`Block.svelte`). `callout` is only in 3 of those files — its HTML import/export and markdown are simply missing, which is what a 6-place cost produces. | **1 owner** — the plugin's definition + kind record: `element(data)`, role flags (void / island / renders own content), default child type for its parent rule, inner-markup snippet with `content` and `children`, and the record fields (label, icon, keywords, markdown prefix, HTML import tags, HTML/plain export, empty shape). Cells, handles, selection (phantom slots come from the declared flag), commands, slash, markdown, HTML import and clipboard export are generic and read the record. | kind records (§5.15); core owns the block element (§5.14); roles and default type are document semantics (rule 4) |
| **(b) A new mark** (e.g. `kbd`) | **5–6 owners.** `strike` appears in the rich-text plugin, rich-text operations, toolbar component and controller, the HTML tag table, and core clipboard export. A valued mark (color, link) additionally meets three divergent next-marks rules (probe `mark-inherit`). | **1 owner** — the mark record: snippet, HTML import/export, hotkey row, toolbar command record, and one flag or hook for edge inheritance consumed by the single next-marks rule. | one next-marks rule (§3.4); records (§5.15) |
| **(c) A new inline void** (e.g. a date chip with a `#` trigger) | **plugin + 3 core files.** The `@` mention trigger is hard-coded in `events/onBeforeInput.ts:350` and `events/onInput.ts:465-504`, and core clipboard export special-cases `mention` labels. A second trigger-based atom would edit the same core files again. | **1 owner** — the inline definition + record: snippet, data, HTML/plain export, and a trigger expressed as a hook on user-origin insert intents (the dispatcher's `origin` keeps composition replays out). Atom selection, atom removal, causal segment keys, the DOM map and adoption are generic. | intents with origin (§5.11, §6.2); adoption through interceptable operations |
| **(d) Comments / suggestions on ranges** | **4–5 owners, and no representation to build on.** No anchored range type is available to plugins (they hold numeric offsets; anchors are tied to positional text wrappers); no plugin-owned replicated root; decorations exist only as a per-text transform over positional segments; any new node inside the host must be taught to the mutation observer's liveness tables; clipboard behavior must be decided separately. | **1 plugin owner + 1 small core affordance.** The range is a pair of anchors (rule 3: start `right`, end `left`), stored in a plugin-declared replicated root (a named extension map on the document — the one new affordance, ≈ 20 xloc). Highlights are drawn in the overlay layer with the same anchored geometry as remote carets, so nothing new enters the host (rule 9 unaffected, IME unaffected); inline rendering, if ever required, is a display-range decoration channel in the cell renderer (≈ 40 xloc). Creating, resolving or accepting a comment/suggestion is a command (own undo step by policy). Anchors already are the wire format, so peers resolve them identically; a range whose content died resolves through the same `dead`/`pending` distinction as a caret. | positions are anchors (rule 3); chrome outside the host; commands as values |

Three further measures the readers asked for:

- **A new selection kind** (e.g. table cells): today the 30-field state, four
  builders, seven writers' side-effect sets, two dedupes, the undo snapshot
  with three restore shapes and the echo latches; here one union variant,
  one projection branch, one display branch.
- **A new inputType**: today up to eight decision sites (predicate family,
  target sync rules, browser-owned classification, router, refresh list,
  composition list, history boundary, input-event predicates); here one
  table row and one command case.
- **A new document content op**: today a text-layer op, a placement
  wrapper, a facade wrapper (policy, no-op prediction, lineage capture,
  attribution stamp), a typed-handle method and possibly a new facet in the
  run view's change classifier; here a content op and a facade entry with
  its policy — effect, attribution, lineage and invalidation follow from
  the transaction.

---

## 11. Risks and unknowns

### 11.1 Technical risks (each has a falsifying checkpoint and a fallback)

| # | Risk | Falsified at | Fallback and its cost |
|---|---|---|---|
| 1 | **Start markers change pinned outcomes in concurrent corners**: the side of a concurrent insert at a split point (M10), text restored after a concurrent split at the deletion gap (M12), and they do not by themselves fix the reading order of concurrently split siblings (M2). Also unverified: the byte cost of format items the engine writes around a marker inserted inside a formatted run, and anchors that bind a marker item | CP7 | keep slice records, contest and repair (scenario C, +1,020 xloc); everything else stands |
| 2 | **The render bracket may not hold**: Svelte 5 has no pre-write hook, so every render into model territory must happen inside `flushSync` brackets. Unknown whether `flushSync` can run inside the engine's commit callback on every path (socket message handler, undo from a keydown, hydration during mount) without re-entrancy, and whether plugin state renders inside the host outside commits (code header, image caption UI) can all be declared chrome | CP1 | keep observer classification and a small placeholder sweep (scenario D, +900) |
| 3 | **The selection classifier must explain real-browser behavior** (Gecko re-anchor bounces "observed twice", WebKit skipping `selectionchange` for an equal write, Android's post-delete shift, IME post-commit jumps) with at most two gesture-carrying signatures and no timers. jsdom cannot falsify this | CP3 (three-engine lanes) | a third signature is allowed only after the missing render-epoch source is shown not to exist; still no timers |
| 4 | **Change-record exactness.** Cells never re-derive, so a missed or wrong change record is a stale render | CP5, CP6 | keep `diffSnaps` in production (+110) and a dev-mode rebuild assertion |
| 5 | **Opening never writes** changes the `<Edytor value sync>` contract and introduces the virtual first block, whose caret is not an anchor until the first command materializes the block; two peers typing into an empty room create two blocks (no loss, but "one bootstrap block" no longer holds) | CP8 | minimal step: fresh-id seed + one timeout (+≈ 40 xloc), fixes P4b/P6 but not P4 |
| 6 | **Plugin API breaks** in a 0.0.x package: snippets no longer attach the block element; handles replace wrappers (`refreshFromModel`, `syncFromModel` disappear; `markOnNextInsert` moves to the selection); `prevent()` becomes an adapter returning a value; hooks see user-level commands, not nested sub-steps; placeholder snippets become string functions + CSS | CP2, CP5, CP9 | none needed functionally; the cost is migration notes and demo/test updates |
| 7 | **The bulk of the work is mechanical rewriting of consumers** from wrapper references to `(block, offset)` positions and handles (events, hotkeys, plugins, clipboard) | CP3, CP5 | none; it is priced into the targets, but it is where schedule risk lives |
| 8 | **Floors for retained code** (≈ 3,700 of the reduction) may not hold | every exit measurement | scenario B (−46 %) |
| 9 | **Performance.** One synchronous flush per commit; anchor resolution per endpoint per commit through the index; remote carets resolved per peer per commit | CP1, CP3, CP6 (`bench/`) | memoize by `(value, version)`; batch remote caret resolution per commit |
| 10 | **Test rewrite volume** (listed in §7.3) is outside the metric and large | all | none — schedule it |

### 11.2 Decisions this plan needs from the maintainer (proposed value in brackets)

1. Side of a concurrent insert at a split point (M10) [engine tie-break; drop the head-side pin].
2. Text restored after a concurrent split at the deletion gap (M12) [accept: it returns into the block now displaying that gap].
3. Reading order of concurrently split siblings (M2) [placement tie-break by stream order; ≈ 30 xloc, not counted].
4. Concurrent delete of a parent vs move of its child out (reader C5) [delete wins for the subtree; the move ADR's wording].
5. Composition abandonment (blur, idle, host deleted) [cancel = delete the replicated preview atoms; keep only on commit].
6. Paste placement (P-1) [`["HelloX", "YWorld"]` for every path].
7. Meaning of "move down" (P-2) [after the next sibling, as the handle keys do].
8. `<Edytor value sync>` [explicit create + virtual first block].
9. Placeholder snippets [string function of the block + CSS; rich markup dropped].
10. HTML import edge rules [unregistered mappings degrade instead of throwing; trailing inline content becomes its own paragraph].
11. Retire unused API surface (§5.22, ≈ 325 xloc) [yes, before first v14 release].
12. Development-only v14 documents written with slice records [discard, or one throwaway conversion script outside `src/lib`].

### 11.3 Unknowns I could not resolve from the evidence

- Whether `flushSync` inside the engine's commit callback is safe on every
  commit path (needs a spike, CP1's first iteration).
- Whether text elements that contain only model text make the click →
  caret re-derivation in every text element unnecessary on all three
  engines (a real-browser check; 36 xloc either way).
- The wire and CPU cost of markers inside heavily formatted text.
- Whether any consumer relies on the y-protocols parity readers,
  `decorateRuns` or the per-block subscription API.
- Whether `navigator.locks` is available in every environment the package
  targets (current browsers and Node 24 yes; others unverified).
- Bundle-size effect (not measured).
- Whether the empty-text zero-width filler and the trailing-newline span
  can move out of the text element's model territory, which would let the
  DOM point interpreter drop two of its special cases (not assumed in any
  estimate).

