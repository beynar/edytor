# Edytor — Deletion-First Architecture Proposal

Status: **complete** (sections 1-11). Each section was appended to this file as soon as it was finished.

**Angle.** Deletion-first. I started from the required-behavior lists of the six reader reports (plus the real
engine/browser/Svelte constraints), built the smallest mechanism set that satisfies them, and made every mechanism
earn its place by naming a requirement or constraint. The current code is evidence of requirements, not a template.

**Evidence base.** I read all six reader reports in full. I verified these claims in source myself: DocAnchor `{b,a,o}` and
`anchorAt` (`crdt/edytor-doc.ts:505-545, 1984-2125`), the DocChange shape (`:475-495`), preview-in-model
composition (`events/beforeInputCommands.ts:167-305`), 18 `flushMirror(` call sites, 20 `stopCapturing()` sites,
72 `setTimeout`/`requestAnimationFrame` sites and 48 `tick()` sites in non-vendor `src/lib`, 22 assignments to
`ignoreNextSelectionChange` (the selection reader counts 17 setters), the unconditional `__EDYTOR_SEL_LOG__` push (`selection.svelte.ts:1599`), the
`{#key edytor.editorDomRevision}` remount (`Edytor.svelte:222`), and the harmful `diffText` path (`utils/diffText.ts:79-113`).
I also found that `src/lib/utils/jsx.ts` (70 xloc) has **zero importers** anywhere in `src/` or `tests/`.
The allowed contract docs I used are `editor-delete-contract.md`, the text-ownership/undo-ownership/move ADRs, `crdt-v14-document.md`,
`editor-dst.md`, `README.md` and the vendor `API-NOTES.md`/`UPSTREAM.md`. I opened no excluded document.

**Measured baseline (today, same counter).** `node scratchpad/xloc.mjs src/lib --dirs` gives **29,026 xloc / 118 files**:
crdt 8362, events 4519, selection 3871, plugins 3780, root files 2497, block 1716, text 1191, collaboration 666,
components 614, hotkeys 589, clipboard 518, utils 500, history 200, dnd 3. The task's baseline of 28,941 is 85 lower.
All of the difference is in `selection/` (3,786 → 3,871), which grew in the working tree after the baseline was taken.

**One fact that changes the cost of the biggest decision.** `master` is still at `d6c4781` (before v14). The whole v14
engine and its internal document layout ("v14-schema-1") exist only on `feat/crdt-v14-engine` (one commit plus the
working tree). No shipped document uses the slice-claim layout. Replacing that internal layout before merge therefore
costs no user migration: the required v13→v14 migration simply targets the new layout. The same fact makes
"legacy v14 peer" wire fields unnecessary, because the only older peers are v13 peers, and the envelope already excludes them.

---

## 1. The necessary facts and rules (12)

Each rule is one sentence. Every later mechanism must trace to one of them or to a named constraint.

1. **Store once.** The replicated document is the only authority for content (a flat registry of blocks, each with
   an id, type, data, deleted flag, incarnation nonce, placement candidates, one backing text and an ordered list of
   merge claims), and everything else in memory is a derived view with a named owner and lifetime.
2. **Text never moves; streams are delimited by boundary atoms.** A block displays its *stream* (the atoms of one
   backing text from its start, or from the block's own boundary atom, up to the next live boundary atom) followed by
   the displays of the blocks it merge-claims, so no replicated fact ever refers to a character item.
3. **Visibility is derived and deletion wins.** A block's parent is its winning placement under the acyclic rule; it is
   visible iff it is not deleted, owns itself and has a visible display parent; and a deleted block hides its stream
   and subtree, together with anything inserted into them concurrently.
4. **Positions are (block, offset) within a version and anchors across versions.** Inside one document version a
   position is a block id plus a display offset (UTF-16 units; an inline atom counts 1), anything held across a
   commit, an await or the wire is an anchor (a relative position on one atom plus an affinity), and text segments,
   wrapper objects and DOM nodes are never stored as positions.
5. **One command per intent, admitted before it writes.** Every edit is one concrete command, resolved purely from
   the intent and admitted once by one dispatcher (readonly check, plugin veto or replacement) before it opens one
   transaction, and that transaction validates before its first write, returns the selection it intends and forms one
   undo step unless it continues typing at the caret.
6. **Views change only at commit.** Render cells, per-block runs and the selection projection are recomputed once per
   commit from that commit's change report, and rendered synchronously inside a *bracket* whose own DOM mutations are
   discarded unobserved.
7. **The selection is one value with one commit point.** The value is *none*, a *text* range of two anchors, one
   *inline atom* or a *set of blocks*; every other selection field is derived from it; and every side effect
   (attributes, hooks, presence, history record) happens once, at the commit point.
8. **Only the projector writes the DOM selection.** It always writes the current value, after the bracket, and an
   observed DOM selection counts as user intent unless it equals our last display (an echo) or follows our own render
   with no gesture in between (drift).
9. **The browser may change text, and nothing else.** A change inside one text element is adopted by a common
   prefix/suffix diff unless the current input attempt is model-owned (then it is reverted), and any other mutation
   inside the editable host is inverted from its own record (old attribute values restored, added nodes removed,
   removed nodes re-inserted, in reverse order), never touching the node a live composition owns.
10. **An input attempt and a composition are single values.** An attempt fixes its intent, anchored target, owner
    (model or browser) and deadline at admission, and a composition session keeps its preview in the DOM only and
    ends in exactly one commit (one model insert with the marks captured at start) or one cancel.
11. **Compatibility is per channel and per container; opening never guesses.** Bytes are integrated only from writers
    of the same engine, wire and schema generation (proven by the frame envelope or the container record), and a
    document seeds content only after every attached provider has settled or its bound has elapsed, with fresh ids.
12. **Kinds carry their own forms.** The record of a block, mark or inline kind (element, role, whether it renders
    content, commands, markdown prefix, HTML/clipboard forms, empty shape) is the only place its type is named, so the
    core names no plugin type.

What these rules deliberately *do not* contain:
- a notion of text-segment identity;
- a mid-transaction mirror;
- a per-update schema check;
- a timer that owns a decision;
- a synthetic DOM event;
- a second place that decides any of the facts above.

Timers survive only where the platform forces a *deadline* (about 8 sites, down from 72):
- the non-cancelable Android Backspace that may never happen;
- a missing `beforeinput` after a structural keydown;
- the readiness bound for a provider that may never answer;
- provider backoff, heartbeat and liveness, and awareness expiry;
- compaction debounce;
- chrome and handle positioning, at one frame per layout change.

---

## 2. Authoritative representations and derived views

### 2.1 Stored once (replicated; lifetime = the engine doc)

```
doc.get('blocks')                         registry: blockId → Node('block')     (placement ADR, unchanged)
  attrs  type, data, del?, n              n = incarnation nonce, random at creation
         at: {"<seq>.<client>": {p, r}}   placement candidates, atomic parent+rank (unchanged)
  content → Node('content')               BACKING TEXT, created lazily (split-born blocks never need one)
      chars (+ format marks)              typed text; never moved or copied
      Node('inline'){id,type,data}        inline atoms (as today)
      {s: blockId, n}  (embedded object)  BOUNDARY ATOM, length 1: "block s's stream starts right after me". Never displayed.
  claims → Node('claims')                 ordered merge claims [{m: blockId}]   (was `slices`: the {t,s,e,g} records go)
doc.get('meta')                           schema stamp {v, schema}
attribution roots                         per-block records, actor dictionary, lineage ring (feature kept)
```

- **Stream rule.** A fresh block's stream runs from index 0 of its own text. A split-born block's stream starts right
  after its live boundary atom. Either stream ends at the next *live* boundary atom in the same text, or at the end of
  that text. A boundary atom is live iff it is not tombstoned and its `n` equals the current registry nonce of its block
  id. The nonce settles the case of two replicas minting the same id (reader counterexample A-2).
- **Display rule.** display(b) = stream(b) followed, in claim order, by display(m) for each merge claim {m} whose holder
  `b` is not deleted. Owner resolution over claims (max-stamp claim, cycles, delete-beats-merge) is the existing
  `computeOwners` graph, kept as is.
- **Split** inserts one boundary atom at the located position. It passes the marks active at that point, so no negation
  format items are written. It also moves the claims that follow the split point to the new block.
- **Merge** appends one claim.
- **Delete** sets `del` on the block *and on every block it displays through claims* (deleting a block deletes
  everything it displays, G8), and tombstones their streams (for GC). An atom inserted into such a stream concurrently
  stays hidden, because its block is dead (`conc.delete-wins-block`, now true on every path, not only the view's). A
  *concurrent* merge into the deleted block is voided, as today (delete-beats-merge, ST02b).
- **Undo** of a text delete re-integrates the copies between the tombstone's current left neighbour and the tombstone
  (`UndoManager.redoItem`). That place is between the same two boundaries, so the text returns to its block without
  any repair.
- **Anchors** are `{b, a}`: the home text id and an engine relative position. At a split-born block's start, a
  left-affine caret binds to the boundary atom itself. Two cases follow structurally, and both needed the `a:-2`/`o`
  facet before:
  - an insert into the predecessor's end lands *before* the boundary, so the caret stays;
  - an insert at the caret lands *after* it.

### 2.2 Local authority (not replicated, not derivable)

| State | Owner | Lifetime | Why it cannot be derived |
|---|---|---|---|
| Selection value `{kind, anchor, focus, pendingMarks?} \| {kind:'atom', blockId, atomId} \| {kind:'blocks', ids}` + epoch | view selection commit point | until the next commit | user intent |
| Composition session `{host node, start/end anchors of the covered text, marks, preview string, phase}` | input/composition | compositionstart → commit/cancel | IME-owned DOM state |
| Input attempt `{id, intent, target anchors, owner, deadline}` | input/attempt | admission → confirmed / deadline / next attempt | who owns the next DOM mutation |
| Displayed marker `{epoch, domRange, renderSeq}` | selection/projector | until the next display | echo detection |
| Goal column; pointer-drag origin | navigation; selection/pointer | consecutive vertical moves; pointerdown → up | gesture memory |
| Undo stacks + per-view `{before, after}` selection per stack item | document history (meta written by the issuing view) | document (in memory) | engine-local history |
| Provider `hasSynced`, `failed` | provider | provider | transport outcome |
| Readiness (`pending \| local \| hydrated`) | document | document | who decided the content |
| DOM bindings: id → block element, element → segment/atom | the core components' attach actions (only the core) | mount | platform objects |

### 2.3 Derived (computed, never stored as authority)

| View | Derived from | Owner | Recomputed | Consumers |
|---|---|---|---|---|
| Owner map (`owner(b)`, DEAD) | `del` flags + claims | crdt/derived | per transaction fold | runs, visibility, ops policy |
| Stream index (blockId → boundary item; text → live boundaries in order) | backing texts | crdt/derived | per fold, for touched texts only | locate/position, split, anchors |
| Placement resolution: parent, order, depth, path, visibility, document order | `at` candidates + owners + `del` | crdt/derived | per fold, for touched parents only | facade reads, ops policy, seam rule |
| Per-block display runs | streams + owners + claims | crdt/derived | per fold, for streams whose items changed (edited item → nearest boundary to its left) | DocChange, reads, clipboard |
| DocChange `{added, removed, moved, meta, content, order}` | the fold's report vs the previous committed index | crdt/derived → facade `onChange` | once per commit | view cells, presence, `onChange` |
| Op effect (`refused \| noop \| applied`) + touched set | the transaction (clock advance, located deletes, `set-if-changed`) | facade write funnel | per transaction | command results, attribution stamp (one per transaction) |
| Anchor → (block, offset) | streams + owners (pure) | facade | per call; memoized per (anchor, version) in the selection | selection, presence, history |
| Render cell per visible block `{type, data, childIds, runs}` | DocChange | view/cells | patched once per commit | components |
| Segments, placeholder flag, mark groups, render deltas | cell runs (+ composition pin) | cell `$derived` | per cell change | Text/Mark components, plugin snippets |
| Selection projection (start/end block + offset, covered blocks, edges, island/void root, marks, content) | selection value × doc version | selection/value | memo per pair | commands, UI, `selection.state` compatibility getter |
| Seam destination of a dead endpoint | replicated placement `{p, r}` of the topmost dead ancestor | selection/seam (pure) | inside the projection | projection, history restore, block delete |
| Presence entry | serialization of the selection value | selection commit point → collaboration/presence | per selection commit | peers |
| Remote carets | awareness entries × doc version × layout | collaboration/remoteSelection | commit, awareness change, resize | overlay |
| JSON value | `facade.toJSON` | view | lazily, only if a consumer exists; memo per version | `onChange`, `value` binding |
| Kind catalogue: commands, markdown table, HTML maps, clipboard exporters, roles | plugin kind records | editor registry | at view construction | slash menu, markdown, HTML, clipboard, render, document semantics |

**Lifetime rule.** Doc-scoped derived state (the index) lives exactly as long as the engine doc. It is created on
first access, never leased, and shared by every facade and view (reader constraints L1/L2). View-scoped state dies with
the view. Mount-scoped bindings die with the element. Nothing stores an object whose lifetime is shorter than its own.
This one rule is what deletes the wrapper-liveness flags, the `get(id) === this` registration guards, the lease
wrapper and the dead-endpoint repair.

---

## 3. Ownership map (new): fact → owner → lifetime → consumers

"Deciders today" gives the count of independent deciders the readers found. The new owner is the only module
allowed to compute the fact; everyone else reads it.

| # | Fact | Owner (new module) | Lifetime | Consumers | Deciders today |
|---|---|---|---|---|---|
| O1 | Block exists; type, data, deleted, incarnation | `crdt/ops` writes, registry stores | doc | index, attribution | 5 id minters, 3 id fields per wrapper |
| O2 | Which block displays atom *i* | `crdt/text/streams` (stream rule + owner map) | derived per fold | runs, anchors, ops | 6 deciders (contest, maintained row, point query, undo repair, 3 insert-time rewrites) |
| O3 | Display offset ↔ (text, index) | `crdt/text/streams` `locate` / `position` | per call | every content op, anchors, commands | ≥10 walks (3 boundary rules) + 7 view-side mappers |
| O4 | Visible? parent, order, depth, path, document order | `crdt/derived` | per fold | facade, ops policy, seam, navigation | 7 visibility definitions, 5 ancestor walks, 4 block walks; wrapper vs facade disagree (probe P1) |
| O5 | Structural permission (void/island/own-subtree) | `crdt/ops` policy, from adopted roles | document | commands, DnD affordance (`canMoveBlocks` asks it) | view re-derivation vs facade (probe P2) |
| O6 | Default block type for a new block | `crdt/ops` via the semantics rule, always given the **actual new parent** | document | split, merge-unnest, clear, `insertParagraph` | 2 rules, implicit caret-block argument (probes P10, P12) |
| O7 | Op effect (refused / noop / applied); touched blocks | `crdt/facade` write funnel (read from the transaction) | per transaction | commands, attribution | ~20 per-op re-derivations |
| O8 | "Commit happened; what changed" | `crdt/derived` → DocChange | per commit | cells, presence, `onChange`, value export | 5 counters, 2 diff algorithms |
| O9 | Readiness (pending / local / hydrated) and the seed decision | `crdt/document` | document | views (`{#if ready}`), history | 3 representations + view self-timer + 50 ms poll |
| O10 | Byte compatibility | `protocols/envelope` (per frame), `providers/container` (per container) | frame / container | providers | 3 staging implementations + 8 re-checks |
| O11 | Undo capture boundary | `commands/dispatcher` (policy: every command cuts except continuing typing) | per command | UndoManager | 20 `stopCapturing()` sites |
| O12 | Selection to restore on undo/redo | `history` (records the issuing view's value before/after per stack item) → `selection.select` | stack item | the issuing view only | 2 restore pipelines racing (probes C1, P4) |
| O13 | The selection value (+ pending marks) | `selection/commit` (`select()`) | until the next select | everything | 4 state constructors, 7 writers with 5 different side-effect sets |
| O14 | Everything derivable from the selection (edges, blocks, island/void root, marks, content) | `selection/value` projection | memo per (value, version) | commands, UI, plugins | duplicated in 2 builders + DOM derive (island innermost vs outermost) |
| O15 | Where a dead endpoint lands | `selection/seam` (pure over replicated `{p, r}`) | per resolution | projection, history, block delete, cut | 5 rules with different answers |
| O16 | May this deferred write land? | nobody: no deferred writers exist; the projector always writes the current value | — | — | 16 staleness mechanisms |
| O17 | Is this `selectionchange` an echo, drift, foreign write or user move? | `selection/classifier` (displayed marker + render seq + gesture serial) | per event | select | 6 classifiers + 17 one-shot flag setters |
| O18 | May a write touch the DOM (focus verdict) | `selection/projector` (one predicate: foreign focus vs orphaned `body`) | per write | projector | 3 verdicts for the same state |
| O19 | DOM point → (block, offset) | `selection/dom` interpreter (modes: settled / DOM-ahead) | per read | classifier, input adapters, drop point | 3 interpreters + 5 overlay mappers |
| O20 | (block, offset) → DOM point | `selection/dom` mapper | per write | projector, remote carets | 2 walks with different fallbacks |
| O21 | Element of block X | `components/Block.svelte` (the core renders it) | mount | mapper, handles, drop targets | ~20 `use:block.attach` snippets; code block attaches twice |
| O22 | Render state of a block | `view/cells` (patched from DocChange) | block visible lifetime | components | 2 reconcile algorithms + mid-transaction mirror |
| O23 | Placeholder visible | cell `$derived` (one empty text ∧ no live composition in the block) → CSS `::before` | render | user | 9 deciders incl. 3 MutationObservers and 5 timers |
| O24 | Who owns the next DOM text change (model vs browser) | `input/attempt` | admission → next attempt / deadline | observer, dispatcher | 7 flags + 4 timers |
| O25 | Edit intent in source-independent form | `input/intents` (one inputType table + key bindings → intents) | per attempt | dispatcher | 3 vocabularies, 7 event-fabrication sites |
| O26 | Is this event the editor's? | `input/admission` (one predicate) | per event | all adapters | ≥11 subsets |
| O27 | Composition region, phase, marks, host | `input/composition` session | session | pin (cells), observer, keydown guard, placeholder | 7 writers, 3 representations, 9 reset sites |
| O28 | Marks of inserted text | `commands/marks` (explicit → pending → common-of-replaced → before/after neighbour → plugin boundary hook) | per insert | typing, commit, paste, adoption | 8 sites, 3 divergent rules (probe `mark-inherit`) |
| O29 | Range deletion | `commands/delete` (one algorithm over document merge rules) | per command | delete keys, typing-over, cut, paste-over | 3 ladders |
| O30 | Where a fragment lands | `commands/fragment` (one placement function) | per command | internal paste, HTML, plain text, drop | 3 placements (probe `paste-shape`) |
| O31 | Relative block move | `commands/structure.move` over the single placement primitive | per command | DnD, handle keys, arrow-move, menus | 4 vocabularies (probe `move-down`) |
| O32 | Kind catalogue (element, role, content-bearing, commands, markdown, HTML, clipboard, empty shape) | the defining plugin's kind record, read through the editor registry | editor | render, slash, markdown, HTML, clipboard, semantics | 6 places; core names 11 plugin types |
| O33 | Presence entry of a view | `collaboration/presence`, written only by that view's commit point, deleted by that view's destroy | view | peers | 3 encodings, 5 equality checks, ownership registries polling `destroyed` |
| O34 | Provider "has ever synced" / "failed" | provider (one shared lifecycle helper) | provider | document readiness | connection-scoped flag read as lifetime (probe P1) |
| O35 | Migration attempt ownership / durable progress | platform lock / container record (append + activate in one transaction) | attempt / container | migrator, boot | lease + poll + key-0 overwrite |
| O36 | May the document still be edited (stamp integrity) | `crdt/document` (observes its own `meta`; goes read-only and signals once) | document | dispatcher (readonly gate), UI | transports silently stop persisting (probe P7) |
| O37 | Readonly permission | the view's dispatcher (render-only consequences: handles and toolbar hidden) | view | commands | 7 layers |

---

## 4. Module / layer map of the new `src/lib`

Layers depend only downward: **engine ← crdt ← commands ← view/selection/history ← input/hotkeys/clipboard ←
plugins/collaboration**. `crdt/` and `commands/` import no Svelte and no DOM. Commands take the selection value
as an argument and return one, so the headless command lane tests them without jsdom.

xloc figures are estimates of surviving responsibility, not line budgets. §7 attributes each to its current domain.

```
src/lib                                                                                       ≈ 13,300 xloc
├─ crdt/                         document layer, headless                                       ≈ 4,740
│  ├─ engine.js, engine-api.ts   bind the vendored engine; structural typings                        35
│  ├─ schema.ts                  the one name table + generation constant                            25
│  ├─ admission.ts               verdicts (fresh/initialized/legacy/foreign/unsupported), load/attach gate   110
│  ├─ document.ts                EdytorDocument: refs, semantics adoption, history, readiness rule,
│  │                             attachSync, stamp-integrity read-only switch                       440
│  ├─ facade.ts                  reads, write funnel (effect + touched set + one attribution stamp
│  │                             per transaction), anchors, DocChange publication                   430
│  ├─ ops.ts                     every structural/content op: policy + validate-then-write,
│  │                             refused|noop|applied results (the single op layer)                 330
│  ├─ derived.ts                 per-doc index folded once per change from transaction.changed:
│  │                             owners, streams, placements, children, runs cache, DocChange       550
│  ├─ placement/rank.ts, tree.ts rank codec; candidates, acyclic resolution, visibility, order    110 + 400
│  ├─ text/streams.ts            range-read projection (skips boundary atoms), boundary index,
│  │                             locate/position, merge-claim owners, content writes                380
│  ├─ attribution/               per-block records, incarnation, lineage ring, actor dictionary     350
│  ├─ structs.ts, rand.ts, handles.ts, index.ts   store walks, rng, read handles for hooks, barrel  145
│  ├─ protocols/                 sync 55 · awareness 223 · envelope (engine+wire+schema) 35 · auth 15   328
│  ├─ providers/                 room 170 · container 56 · indexeddb 240 · websocket 320 · index 50 ·
│  │                             shared provider lifecycle (hasSynced/failed/destroy/leave) −40      796
│  └─ migration/                 migrate (lock + atomic append/activate) 192 · legacy-schema 117     309
├─ commands/                     editing semantics over the facade, headless                     ≈ 1,060
│  ├─ dispatcher.ts              resolve intent → one concrete command (pure) → admit (readonly,
│  │                             hooks once, prevent/replace) → one transaction → undo policy →
│  │                             returned selection → onAfterOperation                              140
│  ├─ types.ts                   operation payload contract for plugins                              90
│  ├─ marks.ts                   the one next-marks rule (+ link-boundary hook)                      50
│  ├─ text.ts                    insert (incl. pending marks), grapheme delete, mark/toggle/clear over
│  │                             selection segments, soft break                                      200
│  ├─ structure.ts               insertParagraph/split, merge ±, nest/unnest, relative move + canMove,
│  │                             convert/setBlock, insert/remove blocks, inline atom add/remove,
│  │                             accept suggestion                                                   280
│  ├─ delete.ts                  collapsed delete ladder (unnest, island no-op, void select, merge, atom,
│  │                             soft break), word/line units, range delete (one algorithm)          230
│  └─ fragment.ts                one placement function for any flow (inline runs + blocks)          70
├─ view/                         per-view runtime, Svelte                                         ≈ 1,030
│  ├─ edytor.svelte.ts           options, registries, document binding, commit subscription → cells
│  │                             → bracket, public API, event wiring, destroy                        430
│  ├─ cells.svelte.ts            BlockCell (exported as `Block`) patched from DocChange; applier      290
│  ├─ segment.svelte.ts          `Text` = segment view (derived, no identity) + composition pin render 155
│  ├─ inline.svelte.ts           `InlineBlock` = atom view + edge-click caret placement                90
│  └─ deltas.ts                  render deltas, mark grouping                                        65
├─ selection/                                                                                     ≈ 1,450
│  ├─ value.ts                   value types, point normalization, projection (memo), marks, content 260
│  ├─ seam.ts                    dead-endpoint destination over replicated placement                 45
│  ├─ commit.svelte.ts           select(): epoch, side effects once, block/focus sets, presence       90
│  ├─ api.ts                     compatibility surface (`state`, setAt*, selectBlocks…) as value builders 60
│  ├─ dom.ts                     DOM point ↔ (block, offset): element boundaries, stray nodes, UTF-16,
│  │                             DOM-ahead mode, shadow roots, multi-range                           420
│  ├─ projector.ts               display(): mount check, compare, write, backward ranges, focus, scroll 140
│  ├─ classifier.ts              selectionchange: echo / composition / gesture / drift / foreign;
│  │                             Android post-delete snap-back                                       90
│  ├─ pointer.ts                 triple click, chrome hit test, drag across atoms, selectstart       150
│  └─ (types, imports, glue across the 8 files)                                                    195
├─ history/                      issuer marking, before/after value per stack item, restore via select   70
├─ input/                        browser → intents (was events/)                                  ≈ 1,300
│  ├─ admission.ts               one "is this the editor's event" predicate                           90
│  ├─ intents.ts                 inputType → intent table (+ misreport overrides), target resolution 150
│  ├─ attempt.ts                 attempt value, owner, deadlines (Android no-op Backspace, missing beforeinput) 90
│  ├─ beforeinput.ts, input.ts   adapters                                                        100 + 40
│  ├─ keydown.ts                 hotkeys → dispatch, structural fallback arming, navigation sync     140
│  ├─ composition.ts             session: start / preview (DOM only) / commit / cancel, phantom-key guard 140
│  ├─ observer.ts                queue, bracket, classify by location + owner, invert foreign records 180
│  ├─ adopt.ts                   DOM text normalization, prefix/suffix diff, caret, native line breaks 170
│  ├─ transfer.ts                copy/cut/paste/drop/drag adapters, payload ladder, shift tracking     180
│  └─ util.ts                    UA detection (one copy), small helpers                                20
├─ hotkeys/                      registry 130 · default bindings as data 170 · navigation (caret-stop
│                                stream, word/atom/block motions, vertical extension, RTL) 260        560
├─ clipboard/                    fragment extraction, validation, encode/decode, export via kind records 210
├─ components/                   Edytor, Block (owns the element), Content, Text, Mark, InlineBlock,
│                                suggestion view objects                                              300
├─ plugins/                      richtext, code, image, mention, html (DOMParser), markdown, slash menu,
│                                toolbar, block handles, arrow-move, shared chrome host              1,850
├─ collaboration/                presence 88 · remote selection 166 · overlay 85 · documentSync 20 · shims 28   387
├─ utils/                        json boundary 190 · prefix/suffix diff 35                             225
└─ plugins.ts, utils.ts, index.ts, dnd/                                                              103
```

**What each layer is *not* allowed to do.** These prohibitions carry the invariants.
- `crdt/` never reads view state, and never writes outside a validated op.
- `commands/` never touch the DOM, never await, and never read the ambient selection. The selection is an argument
  (reader finding F32).
- `view/` never writes the document except through `commands/`.
- Only `selection/projector` writes the DOM selection.
- Only the core components create, remove or re-render nodes inside the editable host. Chrome (handles, menus,
  toolbar, drop indicator, remote carets) lives in one overlay outside it.
- Only `input/observer` interprets DOM mutations. It processes every pending record *before* a bracket begins, and the bracket
  discards only the records produced inside it, so foreign and own changes never interleave.
- Only `input/composition` holds composition state.

---

## 5. Deletion ledger

**Sources.** xloc figures come from the readers' range measurements (`xrange.mjs`, the same counting rules as
`xloc.mjs`), unless marked *(me)*, which means I measured or verified it. "→ n" means n xloc of the responsibility
survives elsewhere; the row's net deletion is the difference. Each row states the invariant that replaces the
mechanism, and the condition under which the mechanism stays unnecessary.

### 5A. Document layer (`crdt/` core)

| # | Mechanism (where) | xloc | Why it is unnecessary | Replacing invariant (unnecessary while …) |
|---|---|---|---|---|
| A1 | Slice-record model: `{t,s,e,g}` payloads, guards, stamps, record anchors, `sliceRange` (`text/model.ts:47-164,876-957`) | 87 | Ownership no longer needs anchored ranges. | *A position's block is a pure function of the live boundary atoms to its left in the same text and the merge-claim graph.* Unnecessary while every split writes a boundary atom and no content delete removes one. |
| A2 | Per-atom ownership contest: interval index, lazy-expiry heap sweep, `computeOwnership`, `maxG`, `claimRoutesToB` (`:483-799,959-1004,1124-1166`) | 239 | With one stream per position there is nothing to contest. | Same as A1. |
| A3 | Insertion-time ownership repair: empty-display revive, left-edge record rewrite, right-edge rival claim (`:1365-1519`) | 82 | Typing at a stream edge inserts beside a boundary atom. Measured cost today: 68 B/keystroke at the seam vs 15 B in the middle (reader C7). | *Inserting at a seam picks a side of the boundary atom by caret affinity.* |
| A4 | Split planner `materializeSegs`/`splitSlices` (`:1637-1791`) | 105 → 35 | A split becomes one boundary insert plus moving the claims that follow the split point. | A1 |
| A5 | Undo-ownership repair: `undoRepairClaims` + `undo-repair.ts` (keep/redone detection, follow-up transaction, second wire update) | 76 + 196 | It existed because ownership was keyed on character items, and undo re-creates those as new items (engine fact E5). | *Undo copies integrate between the tombstone's left neighbour and the tombstone, i.e. inside the same boundaries.* Unnecessary while no concurrent boundary was inserted at the deletion gap in the meantime. That case (reader A-5) becomes an explicit semantic change, §11. Also removes the torn two-update receiver frame (reader C2) and the lineage third update (C13). |
| A6 | Anchor owner facet `a:-2`/`o`, `emissionOffset`, unresolved-anchor outward scan (`edytor-doc.ts:1984-2257`) | ≈130 of 168 | A caret at a split-born block's start binds to the boundary atom with left assoc. | *Stream starts are atoms a caret can bind.* Affinity = `assoc`; ownership = the containing stream. |
| A7 | Run-view contest index (`recordsByText`, effects, atom rows, rangeCache), claim-churn refinement, U8b extent narrowing (`runs.ts:456-746,922-967,1298-1321`) | 100 + 30 + 89 → 25 | Invalidation needs only "which stream contains the edited item". | *An edited item's stream is the one whose boundary is nearest to its left.* |
| A8 | Duplicate derived-state owners: fresh-collect `view()` + `collectBlocks` 60, lease wrapper 32, `ownShim`/`ctx` 33, fake-op synthesis re-parsed as a delta + unreachable `deltaDeep` fallbacks ~75, facade `stateVersion` + memo 35, second visibility walk ~20, second child-order builder ~15, DocChange fast/slow split + escalation ~110 | ≈380 | Several owners describe one derived state, with different lifetimes. | *Derived facts have exactly one owner whose lifetime is the doc's. Each `transaction.changed` entry is folded into it once, and every read and every publication goes through it.* |
| A9 | Effect prediction: `marksAlready` 36, no-op re-derivations ~20, per-op attribution/lineage threading ~53 (+ helpers 69 → 40) | ≈110 net | The engine already tells us what happened (E8/E9). | *An op's effect and the touched set are read from the transaction; attribution is stamped once per transaction.* |
| A10 | Two-and-a-half op layers: placement structural ops, facade policy wrappers, content wrappers repeated in placement/facade/`nodes.ts` | ≈150 net | One validated op per intent is enough. | *Every op validates (policy + model invariants), then writes, in one function.* |
| A11 | Typed handles `nodes.ts` (every facade op re-exposed per id; only 3 internal call sites *(me)*) | 104 → 30 | Commands address blocks by id. | *Commands never hold handles; hooks get read-only handles by id.* |
| A12 | Duplicates: second schema table 35, facade pending-gate twin ~15, `_retain` ~8, lineage-depth validation ~8, `UndoManager.destroy` monkey-patch ~10 | ≈76 | Each is a second owner of one fact. | One owner each (§3 O9, O36). |
| A13 | No production consumer: `decorateRuns` + types 108, `subscribe`/`subscribeBlock`/`blockVersion`/`snapshot`/`debug` ~45, dead helpers 27, barrel "advanced internals for tests" ~80; oracles `computeAllRuns`/`mergeRuns` 59 and `blockRecordsOf` 23 **move to `src/tests`** | ≈342 | Dead or test-only code in production. | Not an architectural gain. §7 counts it separately. |
| A14 | View-side content tombstoning in `removeBlock` (`block.utils.ts:292-298`), which headless and remote deletes bypassed (probes P3/P3b) | ≈10 | Deleting a block hides its stream on every path. | Rule 3 |

### 5B. Sync, persistence, presence, migration

| # | Mechanism | xloc | Why it is unnecessary | Replacing invariant |
|---|---|---|---|---|
| B1 | Per-update schema staging: `canApplyDirect` 91 (it re-implements engine origin-chain resolution), `applyUpdateStaged` 39, hydration fast/surgical staging 53 → 6, refusal latch + compaction block ~18, `gateSchema`/dedupe 25, 8 outbound gate sites ~12, staged branch + post-apply recheck 19 → 8, `schema-mismatch` plumbing ~10 | ≈250 net | Its real guarantee was "the stamp stays supported": incompatible *content* already integrates (probe P2, engine fact E2). It also causes permanent compaction loss (C11) and silently drops input (P7). | *A replica integrates bytes only from writers of its own (engine, wire, schema) generation: the envelope proves it per frame, the container record per container.* An O(1) residual guard sits in the document (O36). |
| B2 | Readiness heuristics: WS two-round settle window + fields/resets ~53, `whenDocumentReady` hand-back + 50 ms poll ~23, facade `syncPending` twin, view `setTimeout(0)` self-decision, reserved `BOOTSTRAP_BLOCK_ID` LWW seed | ≈100 | Opening guessed the room was empty and could **erase** room content (probes P4b/P4c: 7/8 trials) or never render (P6). | *The document decides once: every attached provider settled, or its bound elapsed. It then seeds only an empty doc, with fresh ids.* Worst case is an extra empty paragraph, never erasure. |
| B3 | Pull-only WS join + BC full-state push (two join rules) | ≈21 | One rule, derived from state vectors, works for joiners, rejoiners and opaque relays. | *On a peer's Step1: reply Step2(diff), plus our own Step1 if their vector has something we lack.* Fixes P5 (offline edits never reached peers with default options). |
| B4 | Migration arbitration: claim loop 43, polling `waitForSettled` + undecoded BC announce 62 → 3, lease/owner vocabulary ~12, owner-carrying record writes ~16, key-0 `put` overwrite 7, duplicated codec/open/stamp ~26 | ≈165 net | Attempt ownership was stored durably. The overwrite breaks the append-only store (P3b: edits lost 6/6; P3: per-block coin flip). | *Attempt ownership is a crash-released `navigator.locks` lock. Durable progress is one readwrite transaction that appends the import row and activates the record. `force` is a replace-edit.* |
| B5 | Presence: 3 encodings (anchors, `textId`+`yStart` legacy fields, `selection` mirror), view-id WeakMap + owner registry + `sweepDestroyedViews` 44, three equality helpers 60 → 4, numeric/mirror render fallbacks ~34, duplicate `findDomPoint` 27, dead `remotePresenceRevision` path | ≈240 net | The legacy fields serve older v14 peers, and none exist because v14 is unreleased. Ownership was reconstructed by polling because teardown passed no view id (C14). | *Each presence key has one writer, the view that minted it, which deletes it on teardown. The wire carries only anchors, and remote rendering resolves the anchor or paints nothing.* Also removes the positional text id `t:{block}:{ordinal}`, whose only real consumer was this wire field. |
| B6 | Parity surface with no in-repo caller: raw `readSync*` 41, `modifyAwarenessUpdate` 19, IDB `get/set/del` 19, WS-side BC fan-out + `disableBc` ~15, duplicated hello frames ~12, hand-copied option forwarding ~9, `readMessage` test seam 4 | ≈120 | **API scope cut.** It is y-websocket/y-indexeddb parity nobody here calls. | Listed separately in §7. Keep any piece the maintainer declares public. |

### 5C. Runtime model (wrappers, mirror, history glue)

| # | Mechanism | xloc | Why it is unnecessary | Replacing invariant |
|---|---|---|---|---|
| C1 | Mid-transaction mirror: `flushMirror` at 18 sites *(me)*, `_projectedTree` memo 30, full `reconcileChildren`, preflight + full fallback in `applyMirrorChange`, re-subscribe-on-attach patch; wrapper reconcile passes | ≈315 | One object served as both the operation handle (read-your-writes) and the render cell (commit-consistent). Cost measured by reader P9: 1,000 selected blocks deleted in 10.6 s vs 7 ms on the document. | *Commands read and write only the document (transaction-aware). A render cell exists for each visible block id and changes only when a commit's DocChange is applied.* |
| C2 | Pending adoption, typed mutation surface (`insertChildren/deleteChildren/insertParts/deleteParts/_toSpec`) | 131 | It emulated v13 "prelim" types. | *Insertion takes a JSON spec; the cell appears at commit.* |
| C3 | Detached/spec mode: three-mode constructors 59, `spliceTextItems/formatTextItems/_sliceFrom` 84, InlineBlock `_spec` 34, `groupContent` 37, unbound branches ~34 | ≈248 | Specs are data, not live objects. | *No wrapper exists before its block exists in the document.* |
| C4 | Seven offset mappers (`partOffsetOf`, `segStart`, `atomOffsetOfPartIndex`, `displayLength`, `projectedParts`, `deleteParts` spans, `resolveTextAnchor` inverse walk) + the atoms-count-0 coordinate system in `contentRange.ts` | 96 + 39 | Positions are (block, display offset). | Rule 4. `crdt/text/streams` `locate/position` is the only mapper; `selection/dom` only maps segments to DOM. |
| C5 | Segment identity: `t:{b}:{ord}` built 3×, `_bind` rename deferred under the pin, aliases/`_pendingAliases`, `getTextById(x.id) ?? x` rediscovery ×4, `getTextById`/`getBlockByIdOrContent` (dead) | ≈150 | Nothing identifies a position by segment. | *Segments are a pure function of a block's runs and have no identity* (anchor rule 6 made structural). |
| C6 | Liveness flags and guarded registration (`_live`, `_bound`, `_blockId`, `isInTree`, `isInDocument`, ~16 `get(id) === this` sites) | ≈40 | Cells cannot outlive their commit record. | Lifetime rule (§2.3). |
| C7 | Second serializer `Block.value` + `withMirrorInlineData` shim | 40 | — | *The editor value is the document's canonical JSON.* |
| C8 | View re-derivation of document order/permission: `closestNextBlock/Prev`, `insideIsland`, `canMoveBlockTo`, path arithmetic | 81 + 35 | The wrapper answer and the document answer disagree (P1). Range delete merged outside text into an island (P2). | O4, O5: *order and permission are answered by the document only.* |
| C9 | Range delete re-deriving the selection walk, island permission and three structural branches (`edytor.utils.ts`) | 126 net | Costs 2N+1 full reconciles (P9) and leaves empty containers (P5). | *A range delete is one command over two anchors, governed by the document's merge rules.* |
| C10 | Pending marks stored on a segment and migrated via `queueMicrotask` + id lookup (`block.utils.ts:568-601`) | ≈35 | Pending marks belong to the caret. | *Pending marks are a field of the text selection value; any new value without them clears them.* |
| C11 | Mid-transaction `refreshFromProject`; eager `$state` copies of derivable fields | 51 | — | Rule 6 + `$derived`. |
| C12 | Second history restorer: `history/historySelectionSnapshot.ts` 111, selection half of `events/undoRestore.ts` ~30, `refreshDomAfterHistoryChange` drift scan/sweeps 69 | ≈210 | Two restorers raced, and the wrong one won (probes C1/P4: caret before the mention). | *The issuing view's `stack-item-popped` handler calls `select(recorded value)`; history commits reach the DOM like any other commit.* |
| C13 | Placeholder repair: `removeStalePlaceholders.ts` 192, `Text.svelte` observers/effects/sweeps ~118, per-commit queue ~23, observer placeholder liveness ~45, selection placeholder remapping ~20 | ≈398 | The placeholder was a DOM node in the editable flow, shown from the model while the browser writes first. | *The placeholder is CSS on the empty text element (`data-placeholder` + `::before`), derived from "one empty text and no live composition in the block".* There is no node to type into, duplicate or remove. |

### 5D. Selection

| # | Mechanism | xloc | Why it is unnecessary | Replacing invariant |
|---|---|---|---|---|
| D1 | 30-field default `state`, `applySelectionSnapshot`'s private state build (~112), spread-patch writers (44), 17-field emit dedupe (30 → 8) | ≈238 | Four constructors produced the same shape, and consumers had to re-apply kind precedence across three containers. | Rule 7: *the stored selection is `{kind, anchors \| ids}`; everything else is a projection.* |
| D2 | Repairers: `restoreRelativePosition` 104 → 20, `capture/reconcileSelectionAfterRemoteApply` 120, application half of `restoreDeadSelectionEndpoints` ~118, `writeCollapsed/RangeCaretState` + `resolveDeadCaretTarget` 60, `restoreDriftedEchoCaret` 81 → 15 | ≈450 | They re-derive positions because the state stored wrapper objects and offsets. | *Only anchors/ids are stored, and position is recomputed per document version. Wrappers can die without repair because nothing stores them.* |
| D3 | Deferred writers: staleness closures, mount polling and 10-attempt loops in `setAtTextOffset` 85, `setAtRange` 165, `setAtBlockRange` 132; `scheduleCaretWriteVerification` 45; `setAtTextsRange` 38; `restoreRangeSelectionSnapshot` + pop-handler loops ~220 | ≈650 | The contract's "latest intent wins across every exit" was enforced separately at 16 sites (reader F14). It still fails on request order (probe C7). | Rule 8: *no write is deferred; the projector writes the current value after each bracket, so request order equals epoch order by construction.* |
| D4 | Echo latches: `ignoreNextSelectionChange` (22 assignments *(me)*; the reader counts 17 setters, 11 outside `selection/`), `ignoreNextSelectedBlockSelectionChange`, `nativeSelectionMatchesCurrentBlockSeam` 35, post-delete caret recording at 6 sites | ≈60 + call sites | A one-shot flag cannot distinguish echo, drift and user moves. It also reverted foreign programmatic writes (probe C4). | *DOM == last display → echo. Render seq advanced and no gesture → drift, re-display. No gesture and no render → foreign write, adopt.* |
| D5 | Four extra seam rules (history redo fallback, `undoRestore`, `getClosestUnselectedBlock`/`blockToFocus`, a delete fallback that can name a phantom slot) | ≈65 | Five rules gave different answers to one question (reader C11). | *A vanished endpoint lands at its topmost dead ancestor's replicated slot `{p, r}`: next live editable sibling start, else previous end, else the first editable text of the document. Same answer for every cause, on every replica.* |
| D6 | Duplicated DOM interpretation: `events/domTextOffset.ts` 43, the observer's point→offset copy 37, `getTextsInSelection` TreeWalker whose result no caller uses 76, DOM atom-in-range rule 31, overlay/placeholder remapping 26 + 64, direction formula copied 4× (wrong for ancestor focus nodes, probe C6), boundary rule applied inside text elements (probe C5) | ≈330 | Three interpreters and five overlay mappers decided one mapping. | O19/O20: *one interpreter with an explicit mode (settled vs DOM-ahead); element-boundary rules apply only between text elements; direction comes from `Selection.direction`.* |
| D7 | Debug probes in production (`__selDrift`, `__EDYTOR_SEL_DEBUG__`, and the **unconditional** `__EDYTOR_SEL_LOG__ ??= []).push` at `selection.svelte.ts:1599` *(me)*: an unbounded global array) | ≈30 | Test instrumentation in production code. | Tests observe through a test-route hook. |
| D8 | Caret re-assertion outside the domain: `getTextNode` tick polling 14, `hotkeys` `restoreStructural*`/`focusFallbackBlock` 68, `restoreSelectionAfterBlockRangeDeletion` 32, `stabilizeCompositionSelection` (now/rAF/0/30 ms) ~57, the ownership re-checks of the keyboard-focus cached restore ~33 | ≈204 | 11 caret writers with 6 timing policies. | Rule 8 (projector + epoch). The focus-in restore survives as "re-display the current value on focus" (~10). |

### 5E. Input (events/)

| # | Mechanism | xloc | Why it is unnecessary | Replacing invariant |
|---|---|---|---|---|
| E1 | inputType predicate families, two routers, `shouldRefreshDomAfterModelCommand`, `NON_COMPOSITION_INSERT_TYPES` | ≈200 → 35 | Each inputType was interpreted up to 8 times. | *An inputType is translated to an intent once, by one table; everything downstream switches on the intent.* |
| E2 | Event fabrication: keydown → `beforeinput`, DOM line break → `beforeinput`, paste → `beforeinput`, drop dispatch, hotkey stub `InputEvent`, code-plugin Shift+Enter, `beforeinput` → synthetic keydown bridge | ≈150 | Fabricated events ran one hotkey 2-3× per keystroke (probe C2). Plugin overrides bound to key strings did not exist on Android (C8). | *Sources produce intent values. Plugins intercept commands, never key strings, for editing intents.* |
| E3 | 25-field before-input snapshot + repair-target threading | 109 + 13 | The target is anchors, and the predicates derive from it. | Attempt target (rule 10). |
| E4 | Declared range → DOM selection → re-derive → snapshot round trip | ≈73 of 118 | The DOM selection was used as a transport. | *Admission resolves the declared range directly into the intent's anchored target.* |
| E5 | Suppression flags (7) + timers (4) + repair-target plumbing (`edytor.svelte.ts:302-321,1298-1454`, events side) | ≈99 + 240 | Seven booleans with timer lifetimes described one fact. | *At most one attempt is open per view, and it names who owns the next DOM text change.* The constraint-driven part (~90) survives in `input/attempt`. |
| E6 | Second adopter on the `input` path 63; hardcoded mention trigger + plugin notification inside adoption 47 | 110 | Two adopters of the same text, ordered by timers. Adoption wrote through raw `insertAt`, which bypassed plugin interception. | *The observer is the only adopter, and it adopts through the same interceptable insert command as typing.* |
| E7 | `diffText` advanced path: similarity switch, Myers stub whose result is discarded, word diff | ≈185 (harmful) | It returned delete-all/insert-all for large edits, destroying atom identity, remote carets and concurrent inserts, and flattening marks (reader C4). | *Adoption diffs by common prefix/suffix only.* |
| E8 | Observer liveness inference (removed side, added side, placeholder, mark counting, island/chrome exemptions) ~297, attribute spec tables + healing ~297 → 0, caret capture/restore 106, per-node exact inversion 138 → one generic reverse-order inversion ~50 | ≈790 net | The observer could not tell our renders from foreign ones. Its idle timer was armed by *our own* attribute records, which cancelled live compositions after 750 ms (probe C1). | Rule 6: *our render mutations are discarded unobserved* (`flushSync` + `takeRecords` bracket). Rule 9: *text inside one text element is adopted/reverted by attempt owner; any other record is inverted from itself* (a record is already a precise undo entry once every classified record is foreign). No spec table is needed: the old value *is* our render's value. |
| E9 | Duplicated admission subsets (≥11 sites, ~130 of 214) + the second keydown listener (~8) | ≈138 | "Is this event the editor's?" was answered by 11 different subsets (reader C9). One keydown ran handlers twice. | *One admission predicate per event; one handler per occurrence.* |
| E10 | Composition triple representation: offsets + anchors + DOM-space pin, 7 region writers, 9 reset sites, preview writes into the document per update, the observer's own cancel, `onCompositionEnd` 128 | ≈400 → 140 | Previews were replicated document writes. So every update was a transaction, cancel had two contradictory semantics, and plugins saw composition replays as typing (probe `ime-plugins`). | Rule 10: *the preview lives in the pinned DOM only. The session ends with one commit or one cancel. Plugins see one committed insert.* |

### 5F. Plugins, components, hotkeys, clipboard

| # | Mechanism | xloc | Why it is unnecessary | Replacing invariant |
|---|---|---|---|---|
| F1 | Hand-written HTML tokenizer + tree builder + entity table (`plugins/html/parser.ts`) | 426 | HTML arrives only through browser events, where `DOMParser` exists. The tokenizer exists for a non-DOM unit-test environment. | *Parse with the platform; tests run the HTML lane under jsdom.* |
| F2 | Per-paste mapping validation with synthetic nodes 137 → 25; `$fragment` pseudo-blocks, `mergeTrailingMarks`, second mark-application copy ~120 | ≈230 | Registries don't change after init. The trailing-merge rule is a tokenizer artifact (reader C8). | *Mappings resolve once at registration. An unregistered target degrades to paragraph/plain text.* |
| F3 | Three fragment placements (`insertContentFragment`, `insertBlockFragment`, `htmlPlugin`) + double id stripping + second fragment validation | ≈190 → 70 | One pasted fragment produced three structures (probe `paste-shape`). | *One placement function for any flow. Ids are fresh at the JSON→spec boundary.* |
| F4 | Core export table naming 11 plugin types (~100 → 35), `richTextCommands.ts` 115, slash icon table ~14, markdown per-type converters and eligibility ~130, duplicated empty code-block shape | ≈325 net | The type catalogue was spread over 6 places. | Rule 12: *kind records.* |
| F5 | Suggestion Proxies (`readonlyElements.svelte.ts`) | 125 → 25 | Proxies fabricated truthy members, so a suggested mention rendered "selected" (probe `suggestion-mention`). | *Snippet payloads are declared view objects; suggestions supply `selected: false`.* |
| F6 | `use:block.attach` convention in ~20 snippets, double-attach ownership guard, heading-specific re-key in core `Block.svelte` | ≈30 + snippet lines | The code block had two elements claiming one id (probe `code-attach`). | *The core renders the block element (`definition.element(data)`); snippets render inner markup only.* |
| F7 | Structural drift repair: suppression windows, recursive `children` refresh, `{#key editorDomRevision}` whole-editor remount at tick/30/500 ms (`hotkeys.ts:169-248`) + `refreshEditorDom` | ≈91 | One Tab remounted the whole editor 3× (probe `tab-remount`). | Rules 6 + 8: *cells render in the commit's bracket; the projector places the caret after it.* |
| F8 | Five document-order walkers in `navigation.ts` (444 → 200) + 26 near-identical binding closures (139 → 55) | ≈328 net | The same caret-stop stream was re-walked five ways. | *One ordered stream of caret stops (grapheme, atom, block edge) with motions as predicates; bindings are rows.* |
| F9 | Four move vocabularies (arrow-move path arithmetic 72 → 15, handle outdent via `unNestBlock`, hotkey nest/unnest, demo) + root-index-only document order in block-selection extension | ≈90 | "Move down" had two meanings (probe `move-down`). Shift+Up stalled in nested lists (probe `block-extend`). | O31 + O4. |
| F10 | Toolbar numeric selection snapshot + 4× re-assertion 44; slash menu numeric range | ≈50 | A link landed on the wrong text after a peer edit (probe `stale-offsets`). | Rule 4: *ranges held across think-time are anchors.* |
| F11 | Four positioning loops → one chrome-host helper (~100 → 35); handle-alignment mutation-record analysis 49 | ≈114 | — | *Chrome lives in one overlay; realign all visible handles once per frame on layout change.* |
| F12 | Exception-based control flow: 7 `PreventionError` catch sites + the hotkey catch-all that turns *any* error into "handled"; 20 `stopCapturing()` sites; ~14 caret-restore implementations with 6 timing policies in plugins/hotkeys | ≈240 | A veto unwound a half-applied command and lost text (probe `prevent-midway`). Real errors were swallowed (reader C16). | Rule 5: *an intent is first resolved, purely, into one concrete user-level command (e.g. Backspace at a block start → `mergeBlockBackward`, so today's code-line merge guards keep working). Hooks see that command once, at admission, before the transaction, and never see its internal sub-steps. `prevent()` keeps its signature and is caught in one place. Undo cuts and selection results belong to the dispatcher.* |
| F13 | Atom deletion by whole-tree search + duplicated atom-removal rule (`hotkeys.ts:99-152`, `onKeyDown.ts:104-139`); root-attribute action 33; handles WeakSet/deprecated-alias plumbing ~23; `letter` Set for a type 50 | ≈180 | — | *An atomic selection is an ordinary command target. Attributes are declarative. Types need no runtime value.* |

### 5G. Dead code (any design deletes it)

`utils/jsx.ts` 70 *(me: no importer)*, `getBlockByIdOrContent` 15, `Block.renderVersion` (written, never read),
`#depth` (never assigned), `initialized`, `REMOTE_ONLY_TRANSACTION`, `LEGACY_INITIALIZED_KEY`, `remotePresenceRevision`
(written, never read), `constants.ts`. About 100 xloc. §7 counts it as cleanup, not architecture.

**Ledger total.** The rows above sum to about **12,260 xloc** of mechanisms that disappear (≈11,660 architectural + ≈470 dead/test-only + ≈130 API cuts), net of what each row
says survives. The rest of the §7 reduction (≈3,480) is *shrinkage of kept responsibilities*: shorter constructors,
fewer imports, smaller adapters, the same behavior in less glue. That part is estimated file by file (§4), not
measured, and it is the least certain part of the target (§11 R10).

---

## 6. Distinctions kept explicit, and the bug each prevents

Deleting machinery is safe only if the distinctions it used to encode (often badly) survive in the representation.
Each row names the distinction, where it now lives, and the bug that merging would cause.

| # | Keep apart | Where it lives | Bug if merged |
|---|---|---|---|
| K1 | **Where an atom is stored** (backing text, forever) vs **which block displays it** (stream + claims) | rule 2 | Copy-on-split/merge: an offline peer's edit lands on dead copies (v13 corpus classes `lost-edit`, `duplicate-inline`, `resurrected-delete`). |
| K2 | **Block identity** (registry key) vs **placement** (`{p, r}` candidates) | registry vs `at` | Physical nesting needs a move primitive the engine lacks; copy-move produces `duplicate-placement` and `cycle`. |
| K3 | **Deleted** (replicated flag, wins) vs **hidden** (derived: merged away or under a deleted ancestor) | `del` vs owner map / visibility | Undoing a merge could not restore the source. "Deleting the destination voids the merge" (ST02b) becomes inexpressible. |
| K4 | **Causal position** (anchor) vs **display position** (block, offset) vs **DOM position** (node, offset incl. ZWSP/newline fillers) | rule 4; `selection/dom` | Numeric carets fail to ride remote inserts. Fillers leak into offsets. |
| K5 | **Insertion affinity** (`assoc`) vs **stream ownership** (containing stream) | engine assoc vs boundary atoms | The `nにello` corruption, or a split-start caret migrating into the neighbour that received text (anchor rule 1). Today one sign bit plus the `o` facet encodes both; after this change they are structurally separate. |
| K6 | **Result selection of a local command** (returned by the command) vs **anchor-following** (other views, remote changes) | dispatcher vs projection | With left affinity, typing would leave the caret *before* each typed character. |
| K7 | **Model destination** vs **DOM readiness** | projection vs projector's "target mounted?" check at each bracket end | After a whole-document remote delete, the caret is lost because the replacement paragraph has not mounted yet (contract pin). |
| K8 | **Content-less block** (declared by the kind: never renders its own text) vs **temporarily unmounted text** | kind record `content: false`; the projector waits for the bracket | A caret parked on a container's phantom slot silently swallows the next keystroke (former UNRESOLVED-2). Today this is inferred from `node == null`, an observation used as a guarantee. |
| K9 | **Admitted command** (hooks resolved, immutable) vs **execution** (the transaction) | dispatcher phases | A veto raised inside a nested sub-step half-executes a range delete and duplicates text (probes P11/P11b, `prevent-midway`). |
| K10 | **Refused** vs **no-op** vs **applied** | `crdt/ops` result type | Attribution stamps no-ops. `setBlock` reports success after a partial refusal (reader C4). Empty moves and inserts disagree (C8). |
| K11 | **Announced intent** vs **executed effect** (browser-owned attempts) | attempt `owner` + deadline | Android's no-op Backspace never deletes, or deletion happens twice (`mobile-beforeinput.spec:706,1638`). |
| K12 | **Browser-owned change** (adopt) vs **drift around a model-owned change** (revert) | attempt `owner` read by the observer | Merged text is duplicated after a non-cancelable merge, or the user's keystroke disappears. |
| K13 | **Our render's mutations** vs **browser/foreign mutations** | render bracket (rule 6) | Our own `data-edytor-focused` records armed the idle cancel and deleted a live composition (probe C1). |
| K14 | **Echo** vs **render drift** vs **foreign programmatic write** vs **user move** | classifier: displayed marker, render seq, gesture serial | Assistive tech or host code that moves the selection gets reverted (probe C4); or real drift after a remount is left uncorrected. |
| K15 | **Foreign focus** (user chose another element) vs **orphaned focus** (`body`, our render detached the focused node) | one projector predicate | We steal focus from a user-chosen control, or never display the caret after our own remount (three verdicts today). |
| K16 | **Unresolvable because not yet integrated** vs **deleted** | anchor resolution returns `null` vs seam rule | A peer's caret whose item has not arrived is drawn at a seam instead of being skipped until the update lands. |
| K17 | **Issuing view** vs **sibling view** vs **remote replica** (history) | history meta keyed by view; transaction origin | A sibling view's caret is yanked to a snapshot recorded long ago (contract H1). |
| K18 | **Composition preview** (disposable, DOM only) vs **committed text** (durable) vs **cancel** (DOM re-render) | session phases | Previews are appended instead of replaced (`composition.spec:788`). Or replicated preview atoms stay after cancel, which today depends on which of the two exits ran. |
| K19 | **Connection currently synced** vs **provider has ever synced** | shared provider lifecycle | A healthy document reports `failed: destroyed before it synced` (probe P1). |
| K20 | **Transport success** (frame integrated) vs **operation success** (replica reflects the answering side) | provider synced verdict + document readiness | An applied *empty* relayed Step2 counts as "synced", and the seed erases room content (P4c). |
| K21 | **Creating** a document (may write initial content) vs **opening** one (writes only after the decided-empty rule, with fresh ids) | `document.sync` / readiness rule | Duplicate or erased first paragraphs (P4, P4b). |
| K22 | **Attempt ownership** (a lock that dies with the tab) vs **durable progress** (import row + active record) | migration | Leases, polling and reclaim races. Rows are lost by overwrite (P3b). |
| K23 | **Capability** vs **permission**: the document *could* accept a move vs a plugin or readonly allows it *now*; `contenteditable` vs editor-owned | ops policy vs dispatcher admission; `input/admission` | Drop indicators that lie. Caption typing captured into the document selection. Readonly editors losing selection. |
| K24 | **Kind definition** vs **block occurrence** (and the id of a deleted definition vs a new occurrence) | kind records vs registry; `setBlock` mints or refuses explicitly | Core re-keys only `heading`. `setBlock` with existing child ids silently drops them (reader C4). |
| K25 | **Replicated state** vs **disposable view state** (pending marks, composition preview, decorations, suggestions) | rule 1 vs §2.2 | Pending marks become undo steps. Code tokens persist as marks. |
| K26 | **Monotonic attribution** (`contributors`) vs **restorable attribution** (`lastChangedBy`) | attribution module (unchanged) | Undo strips contributors, or fails to restore the last changer. |
| K27 | **Completed external effect** (clipboard written) vs **document mutation** (cut's delete) | transfer adapter order | A vetoed or throwing delete loses clipboard data if the order is reversed. |
| K28 | **Accepting input** vs **being able to persist it** | document read-only switch (O36) | The transport silently drops every later local edit (probe P7). |

---

## 7. LOC table (execution LOC, `xloc.mjs` rules; vendored engine excluded)

"Current" is measured today (`--dirs`). "Target" is the §4 estimate, attributed to the domain whose directory
the code lives in now. Where code *moves* between domains, the destination's target includes it; the notes say so.

| Domain | Current | Target | Delta | % | Notes (what moved vs what was deleted) |
|---|---:|---:|---:|---:|---|
| crdt (core) | 6,237 | 3,305 | −2,932 | −47% | Boundary atoms ≈ −1,000 (A1-A7). One derived owner ≈ −380 (A8). One op layer ≈ −150. Effects observed ≈ −110. No-consumer code −342, of which 82 **moved to tests**. Duplicates −76. Handles −74. Readiness −70. The rest is trims. |
| crdt (providers + protocols + migration) | 2,125 | 1,433 | −692 | −33% | Compatibility per channel −250. Readiness −100. Migration lock/append −165. Parity surface **−120 (API cut)**. Shared provider lifecycle −40. Migration is **kept**; it is a hard requirement. |
| events → `input/` | 4,519 | 1,300 | −3,219 | −71% | About 560 of command logic (**moved** to `commands/`, counted under block/text). Composition session **moved in** from `edytor.svelte.ts`/`text.svelte.ts`. Bracket + record inversion ≈ −790. Attempt value ≈ −340. |
| selection | 3,871 | 1,450 | −2,421 | −63% | `replaceSelection` commands (~90) **moved** to `commands/`. Vertical extension (~50) **moved** to navigation. Value + projector + epoch ≈ −1,500. |
| plugins | 3,780 | 1,850 | −1,930 | −51% | HTML tokenizer replaced by `DOMParser` (−426). Kind records absorb `richTextCommands.ts`. Chrome host shared. |
| root files (`edytor.svelte.ts`, `hotkeys.ts`, `edytor.utils.ts`, `plugins.ts`, …) | 2,497 | 830 | −1,667 | −67% | `edytor.svelte.ts` 1,519 → 430 (mirror → cells, composition → input, attach → adapters). `hotkeys.ts` 667 → 300. `edytor.utils.ts` 206 → 0 (**moved**: range delete in `commands/delete`). |
| block | 1,716 | 1,190 | −526 | −31% | **Absorbs** commands moved in from events (~560), `edytor.utils` (~100), `replaceSelection` (~90) and clipboard placement (70). Wrapper/mirror machinery −1,000+. |
| text | 1,191 | 470 | −721 | −61% | Text commands + marks rule stay. `removeStalePlaceholders.ts` 192 → 0. Segment identity and composition resync gone. |
| collaboration | 666 | 387 | −279 | −42% | Presence single encoding, view-owned keys. |
| components | 614 | 300 | −314 | −51% | Placeholder CSS, suggestion view objects, core-owned block element. |
| hotkeys (`navigation.ts`) | 589 | 260 | −329 | −56% | **Absorbs** vertical extension. Caret-stop stream. |
| clipboard | 518 | 210 | −308 | −59% | Placement **moved** to `commands/fragment`. Export via kind records. |
| utils | 500 | 225 | −275 | −55% | `jsx.ts` dead (−70). `diffText` 234 → 35. |
| history | 200 | 70 | −130 | −65% | One restorer. |
| dnd | 3 | 3 | 0 | 0% | |
| **Total** | **29,026** | **≈13,280** | **≈ −15,740** | **−54%** | |

### Honest accounting of the −15,740

| Portion | xloc | Nature |
|---|---:|---|
| Mechanisms that disappear because a representation changed (ledger 5A-5F, net) | ≈11,660 | Architectural deletion. Each row names its replacing invariant. |
| Dead code + test-only code moved to `src/tests` + production code with no consumer (A13, D7, 5G) | ≈470 | **Not** a simplification of the candidate. Any design deletes it. |
| API scope cuts (B6 parity surface; placeholder *snippets* become string functions) | ≈130 | Only counts if the maintainer accepts the cut. |
| Shrinkage of kept responsibilities (glue, imports, shorter adapters and constructors) | ≈3,480 | Estimated per file in §4, not measured. **The least certain part.** |

**Moved, not deleted.** Command logic is consolidated into `commands/` from six places:
- `events/beforeInput*Commands`
- `block.utils`
- `text.utils`
- `edytor.utils`
- `selection/replaceSelection`
- `clipboard/insert*`

Those places total ≈2,250 xloc today. Their target is ≈1,060 in `commands/` plus the parts left in `text/` (see
the block/text rows). The composition session, the input attempt and the readiness rule each move to their single owner.
None of that movement is counted as deletion.

**Reductions that depend on contract decisions** (§11 lists the decision each needs):
- B1: per-update schema gating (−250).
- B2: seeding with fresh ids instead of the reserved bootstrap id (−100).
- E10: composition previews no longer replicated (≈ −260).
- A1-A7: boundary atoms change two pinned tie-breaks (TX06a seam-insert side, the A-5 undo corner) (≈ −1,000).
- F12: plugin hooks run at command admission, not on internal sub-steps.

**Sensitivity.** Pessimistic cases, each measured against 29,026:

| Case | Target | Reduction |
|---|---:|---:|
| Shrinkage of kept responsibilities comes in at half the estimate (+1,740), plus 10% contingency on the view layer (+600) | ≈ 15,600 | −46% |
| Also: boundary atoms rejected (slice claims + contest + undo repair kept) | ≈ 16,600 | −43% |
| Also: the render bracket (§11 R2) fails, so the observer keeps classification (+800, input reader's estimate) | ≈ 17,400 | −40% |

The 40-50% target therefore survives any single failed bet, but not all three at once.

**Bundle.** Not measured. The vendored engine (7,125 xloc, out of scope) dominates the shipped bytes. The runtime
effects are what this proposal predicts and must be measured with `bench/`:
- 72 timer sites → about 8;
- 48 `tick()` sites → about 0;
- 4 MutationObservers → 1;
- O(N·doc) → O(changed) for multi-block deletes (reader P9);
- one wire update per undo instead of 2-3.

**Test LOC is outside the metric, but the rewrite is real work.** Suites that pin retired mechanisms and must be
re-targeted at the new invariants:
- `mirror-incremental`, `scoped-text-refresh`, placeholder repair-queue stats;
- `schema-boundary`, `wu3b-staging`, refusal halves of `r2-idb-compaction`;
- ownership-regression/undo-repair internals, lease/claim parts of the migration tests;
- presence mirror/sweep tests, HTML tokenizer fixtures (19), mapping-validation fixtures (~12);
- the DST dump inventories (`textClaims`, `textMounted`), whose oracle *rules* stay but must read the new representation.

---

## 8. Falsification tests (written first, at CP0)

Each is the smallest counterexample I could find for one axis where a language like this usually breaks. The
expected result is derived from a contract: a `docs/editor-delete-contract.md` id, a reader guarantee (S*/G*/R*/X*),
or an explicit decision recorded here. It is never derived from either implementation.

**Today** column:
- **red** = the current code fails it (a reader probe reproduced it);
- **red?** = failure predicted from code, not executed;
- **green** = passes today and must keep passing.

**Gate** = the checkpoint (§9) that must turn the test green before the next checkpoint starts.

| ID | Axis | Scenario | Expected (source) | Falsifies | Today | Gate |
|---|---|---|---|---|---|---|
| T1 | nesting in nesting | `root > [X > [box(island) > [A]], Y]`: next block after A | One answer for every consumer: **Y** (pre-order over visible blocks). Island sealing is a separate policy applied by the operation that needs it (G6). | O4 | red (P1: wrapper Y, facade null) | CP3 |
| T2 | nesting + permission | `root > [box(island) > [A "aa"], Y "yy"]`, select A@1→Y@1, Backspace | `del.range.flat` + island seal: head keeps `a`, tail keeps `y`, and the merge across the seal is refused → `box > [A "a"], Y "y"`, caret A@1 | O5, rule 5 | red (P2: `A "ay"`, Y deleted) | CP5 |
| T3 | same definition, different positions | `ordered-list > [list-item "one"]`: Enter at end / middle / start. Then `ordered-list > [list-item "a", box(island) > [list-item "c"]]`: merge `c` out of the island | Parent-appropriate default type (G5): `list-item` in all three Enter cases (end: `[one, ""]`; middle: `[o, ne]`; start: `["", one]`) and for the merged-out child | O6 | red (P12, P10) | CP5 |
| T4 | failure midway | Range a@1→d@1 over `[aa, bb, cc, dd]`; a plugin's `onAfterOperation` throws | Atomic command: `["ad"]`, one undo item, error reported (not swallowed) | rule 5 | red (P11: `["ad","cc","d"]`) | CP5 |
| T5 | veto of an internal sub-step | Same range; a plugin `prevent()`s `removeBlock` | `removeBlock` is not the admitted command, so the veto does not apply → `["ad"]`. A veto on the *command* (`deleteContent`) leaves the doc unchanged. Never a partial result. | rule 5, K9 | red (P11b) | CP5 |
| T6 | retry after partial completion | `b` has child `c1`; `setBlock(b, {children: [{id:'c1'}, {id:'c2'}]})`, then retry | Refused before the first write (`result:'refused'`, zero update bytes, typed error naming `c1`). The retry gives the same answer. With ids stripped it succeeds (R12, R13). | K10, K24 | red (C4 crdt: `true`, `c1` gone forever) | CP3 |
| T7 | concurrent | `"abcde"` split at 3 (`b0 \| t`). Peer B types `Q` at t@0 while peer A deletes `t`; heal. Also headless `facade.deleteBlock(t)` after local `X` at t@0 | Both replicas `["abc"]` in both cases (`conc.delete-wins-block`, G8) | rules 2-3 | red (P3b `abcQ`, P3 `abcX`) | CP2 |
| T8 | concurrent splits | `"hello world"`: A splits at 3 ‖ B splits at 8; all 40 client-id pairs | Content partition `hel`, `lo wo`, `rld`; nothing dropped or duplicated (R7). Reading order is **not** in any contract: open question Q-order (§11). | rule 2 | green for partition | CP2 |
| T9 | same structure, different history | (a) block `alpha` + separate block `d2="Hello"`; (b) `alphaHello` split at 5 → `tail`. Caret `anchor(block, 0, left)`, then split that block at 0 | Identical outcome in (a) and (b): the caret stays in the emptied original block ("history independence" row of the boundary matrix) | K5, rule 2 | red (C3 crdt: (a) follows text, (b) stays) | CP2 |
| T10 | undo × delivery | `"hello world"` split at 6 → `t="world"`; delete `t[0,5)`; undo; deliver each resulting update separately to a receiver | Exactly **one** update per undo. The receiver never shows `b="hello world"`. After it: `b="hello "`, `t="world"` (R16) | A5 | red (C2: 2 updates, torn frame) | CP2 |
| T11 | fact changes between observation and use | `he[ll]o` selected; Backspace keydown with no `beforeinput` (fallback path); remote inserts `XX` at 0 before the deadline | `XXheo` (the fallback acts on its anchored target, Y2) | rule 10 | red (C3 input: `XXllo`) | CP7 |
| T12 | announced vs executed × collab | Android non-cancelable `deleteContentBackward` that the browser never performs; a remote edit to the same text lands inside the deadline | Exactly one grapheme before the anchored caret is deleted | K11 | red? (C5 input) | CP7 |
| T13 | request order | From caret @1: `setAtTextOffset(t,4)` then `setAtRange(t,2,6)` synchronously; and the reverse order | The later request wins in both orders: range 2-6, then caret 4 (W1) | rule 8 | red (C7 selection) | CP6 |
| T14 | empty collection | (a) Block-select `bb` in `[aa,bb,cc]`; remote deletes `bb`. (b) `moveBlocks([], d)` vs `insertBlocks(d, [])`. (c) Keydown fallback whose selected blocks were deleted remotely | (a) Seam `sel.seam.next-sibling` → caret `cc@0`, one `onSelectionChange`, presence republished; a later Delete touches nothing dead. (b) Both `noop`. (c) Named no-op. | rules 7, 5 | red (C8 selection; C8 crdt; C10 input) | CP4 / CP3 / CP7 |
| T15 | empty collection (UI) | `/xyz` with no matching command, then Enter | Enter inserts a paragraph (the menu does not swallow it) (X4) | rule 5 | red? | CP8 |
| T16 | IME × concurrency × time | `alpha\|Hello` split, caret Hello@0; compose `n`→`に`; meanwhile the peer appends `X` to `alpha`; 2 s pause with no event; commit | `alphaX` / `にHello`. The composing node is never re-rendered during the session. The pause does not cancel it. One insert at commit. | rules 10, 6 | red (C1 input: preview deleted after 750 ms) | CP7 |
| T17 | IME × plugin hooks | Code line `x\|`: compose `(` → `(a`, commit `(a`. Empty paragraph: compose `/` → `/h`, commit | `x(a` (committed value inserted exactly once). The slash menu opens **after** commit with query `h` and never opens or closes mid-composition. | rule 10 | red (probe `ime-plugins`) | CP7 |
| T18 | undo after collab | `Hello world`, caret @5, type `abc`, remote inserts `XYZ` at 0, undo via mod+z, via `beforeinput historyUndo`, and via the API. Also: type `!` at the end of `hello world`, remote inserts a mention at 3, undo | `XYZHello\| world` (caret @8) on all three channels (H1 + E1). The caret lands at the end of the text, not before the mention. | O12 | red (C1 selection: @5 vs @8; P4) | CP4 |
| T19 | two features | Select `world`, focus the toolbar link field, peer inserts `ZZZ` at 0, apply the link | The link covers `world` (G1) | rule 4 | red (probe `stale-offsets`) | CP8 |
| T20 | two features | Caret inside red italic text; Mod+B (collapsed); type | New text marks = `{color:red, italic, bold}` (one next-marks rule, G2) | O28 | red (probe `mark-inherit`) | CP5 |
| T21 | same intent, three sources | Paragraphs `X`,`Y` pasted at `Hello\|World` via internal fragment, HTML, plain `X\nY` | **Decision:** one placement rule (the leading run joins the text before the caret, the trailing run joins the text after it) → `["HelloX","YWorld"]` for all three | O30 | red (probe `paste-shape`) | CP5 |
| T22 | same intent, several paths | `A, B{B1}, C`: "move A down" via handle Alt+↓, arrow-move chord, demo menu | **Decision:** relative "down" = after the next sibling, never into its children → `B{B1}, A, C` on every path | O31 | red (probe `move-down`) | CP5 |
| T23 | nesting (keyboard) | `A{A1,A2,A3}, B`; select A3; Shift+↑, Shift+↑, Shift+↓ | `{A2,A3}` → `{A1..A3}` → `{A2,A3}` (document order, K7) | O4 | red (probe `block-extend`) | CP8 |
| T24 | render provenance × IME | During a live composition: (a) the selection commit toggles `data-edytor-focused`; (b) a peer edits another paragraph; (c) an extension sets an attribute on an unrelated block element | The session stays live and the host node is untouched. (c) is healed within one observer flush. Nothing else re-renders. | rules 6, 9 | red (C1 input) | CP6/CP7 |
| T25 | echo vs drift vs foreign | (a) Focused editor; `setBaseAndExtent(text@1→end)` with no pointer/key event. (b) A remote commit replaces the caret's text node and Gecko re-anchors the caret at the same absolute offset, with no gesture | (a) The model adopts `1..end`. (b) The projector re-displays the model caret. A peer that received nothing never moves (E5). | rule 8, K14 | red (C4 selection) / green (b) | CP6 |
| T26 | DOM point mapping | Paragraph `ab` + bold `cd` + `ef`; DOM point `(textElement, i)` for every child index | Offsets `0, 2, 4, 6` (O2) | O19 | red (C5 selection: 6 for all) | CP6 |
| T27 | DOM point mapping | Forward native selection with anchor `text@1` and focus `(textElement, childCount)` | `start 1, end 11`, not reversed (D2, S1) | O19 | red (C6 selection) | CP6 |
| T28 | readiness | (a) New device: empty IDB + WS room with content; the view passes a default `value`. (b) First WS client alone, default options. (c) A second client joins (b) | (a) Local == remote == room content; no seed. (b) Ready after the bound; one paragraph seeded with a fresh id. (c) Converges to that paragraph: no duplicate, no erasure. (G9-G11) | rule 11 | red (P4, P6/P6b) | CP1 |
| T29 | rejoin | Opaque relay, default options: B disconnects, edits offline, reconnects | A receives B's edit with no resync timer (G2) | rule 11 (join rule) | red (P5) | CP1 |
| T30 | lifecycle | Two WS clients sync; B's socket closes; `B.destroy()` | No `failed` event (G11) | K19 | red (P1) | CP1 |
| T31 | retry after partial completion | migrate → hydrate → type → `migrate(force)` → reload | Deterministic: every block equals the legacy content (force = replace-edit), no `pendingStructs`, no row lost (G29) | K22 | red (P3b 6/6 lost; P3 coin flip) | CP1 |
| T32 | generated value after a boundary | (a) Enter at the end of a parent that has children. (b) `insertBlock({id:'x\uD800'})` then `insertText` using the returned id | (a) The command returns `{blockId: new, offset: 0}`; after the bracket the caret is there. (b) The returned id is the stored `'x\uFFFD'`, and follow-ups using it succeed. | rules 4-5 | red? (C6 input), red (C11 crdt) | CP5 / CP3 |
| T33 | scale | Delete 1,000 selected blocks; paste 2,000 blocks in one command; type in a 5,000-block doc | < 100 ms; linear in transaction size; per-keystroke cost independent of document size (G25) | rules 5-6 | red (P9 10.6 s; C10 quadratic) / green (typing) | CP3/CP6 |
| T34 | side effects once | Unfocused view: remote delete of the caret's block. Then `selectBlocks(block)` | Each yields exactly one `onSelectionChange`, a republished presence, and updated focused/selected attributes (P1-P3) | rule 7 | red (C2, C3 selection) | CP4 |

**Beyond the table.** The existing suites stay the parity oracle at every checkpoint:
- unit, DOM, CRDT, chromium integration;
- DST solo and collab seed sets;
- the 48 composition tests;
- the delete-contract matrix.

A test that pins a *mechanism* (§7 list) is rewritten against the invariant that replaced it, never deleted silently.

---

## 9. Bounded migration sequence

### 9.1 Principles

**Strangler, not rewrite.** Each checkpoint (CP) replaces one subsystem behind a seam that stays stable:
- the facade API for the document layer;
- `selection.state` / `setAt*` compatibility for plugins;
- the `Block`/`Text`/`InlineBlock` names and op methods;
- the `<Edytor>` props.

A CP merges only when every suite that was green at CP0 is green again. The only exceptions are tests the CP
explicitly re-targets, each listed with the contract that justifies it.

**No dual runtime paths.** The replaced subsystem is deleted in the same CP. Two things stay as **test-only
oracles** in `src/tests` until CP9: the old ownership model (after CP2) and today's `diffSnaps` (after CP3). Oracles are
moved, never counted as savings.

**Repair/redesign limit (applies to every CP).** Suppose a contract test can only be passed by adding a special case:
a flag, a timer, a second decider, or a new replicated record type. Then the CP must first name the fact that is
missing from the representation (§2).
- If that fact can be added with one owner, add it.
- Otherwise, **stop the CP** and bring the requirement question to the maintainer.

Each failing test family gets at most **2 repair rounds**. A CP whose added code exceeds its estimate by more than
50% also stops, and gets re-derived from §1.

**Mechanism census.** A small script run at every CP counts:
- timer sites, `tick()` sites, `flushMirror(` and `stopCapturing()` sites;
- `ignoreNextSelectionChange` writes, `PreventionError` catch sites, MutationObservers.

Each CP must reduce the counts it claims. This makes "moved, not deleted" visible.

### 9.2 Checkpoints

| CP | Behavior contract (must hold at exit) | Implementation unit | Tests first | Exit gates | Stop / redesign trigger |
|---|---|---|---|---|---|
| **CP0** Baseline | No behavior change. | Record xloc per file, `bench:crdt`, runs bench, DST pass sets (solo + collab, 3 engines where available), integration pass list. Add the census script. Move test-only production code (A13 oracles, D7 probes) to `src/tests`. | Write T1-T34, marked `expected-fail` with their contract id where red. | All pre-existing suites green; census committed. | Any production change other than moving test-only code. |
| **CP1** Sync boundary | Sync reader G1-G32. Rule 11. Generation = engine + wire + schema, checked per frame and per container. Readiness: every provider settled or bound elapsed, fresh-id seed, `readiness` names unchanged. One join rule. Shared provider lifecycle (`hasSynced`). Migration: lock + atomic append/activate; `force` = replace-edit. Presence: anchors only, view-owned keys. Document read-only switch on stamp change. | `providers/`, `protocols/`, `migration/`, `collaboration/`, readiness part of `document.ts` (≈ −1,000 xloc). | T28-T31. `schema-boundary`/`wu3b-staging` re-targeted as generation-mismatch tests. | Provider/migration/collab suites, collaboration browser specs, collab DST, all with **default** transport options. The test route's forced `resyncInterval` is removed; that is the proof for T29. | A pinned schema case other than "same-generation forged stamp" (covered by the O(1) guard) cannot be expressed → maintainer decision. |
| **CP2** Streams | Facade API unchanged. Crdt R1-R17. Rule 2. Undo emits one update. TX06a (seam-insert side), A-5 (undo after a concurrent split at the deletion gap) and TX04a (which same-anchor sibling wins) re-decided **in writing** before coding. Schema generation bumped (internal layout 2). | `crdt/text/streams`, split writes a boundary + moves claims, anchors without `o`, runs invalidation by nearest boundary. Old model → test oracle. | T7-T10. The random corpus (`duplicate-placement`, `lost-identity`, `cycle`, `unreachable-block`) + reachability seeds, run against both models: displayed content must be equal except the re-decided pins. | `test:crdt`, `test:crdt:extensive`. Bench: seam keystroke ≈ middle keystroke bytes; one update per undo. All editor lanes green on the new model. | A pinned scenario outside the three re-decided pins needs a new replicated record type or an ownership repair → the representation is missing a fact. Fall back to keeping slice claims (§7 sensitivity) and continue with CP3. |
| **CP3** One derived owner, one op layer | T1, T6, T14b, T32b, T33 (paste). DocChange exact against the `diffSnaps` oracle on the random corpus. Op results typed `refused \| noop \| applied`. Attribution stamped once per transaction. | `crdt/derived.ts` (fold once, doc lifetime), `crdt/ops.ts` (placement + facade + handle op layers merged), write funnel. Delete lease, shim, fake-op parser, `stateVersion`, decorations, typed handles. | T1, T6, T14b, T32b. | CRDT lanes. No keystroke regression at 5k blocks. Large transaction linear. | DocChange exactness seems to need a second diff path → fix the fold instead; never add a fallback. |
| **CP4** Selection value | Rule 7. T14a, T18, T34. `selection.state` compatibility getter serves the existing ≈300 reads unchanged. History restores in the issuing view only, from the recorded value. | `selection/{value,seam,commit,api}`, `history/`. Delete `historySelectionSnapshot`, the selection half of `undoRestore`, the 4 extra seam rules, the 30-field state. The existing DOM writers stay for now, reading the committed value. | T14a, T18, T34. Selection-ownership tests re-targeted from `state` assignment to `select()`. | Unit/DOM/integration/DST green. | A consumer needs wrapper identity the projection cannot provide → route it through the projection; never store wrappers again. |
| **CP5** Commands + dispatcher | Rule 5. T2-T5, T20-T22, T32a. Hooks run once at admission. One command = one undo step (typing coalesces). Commands return selection values. Mid-transaction `flushMirror` removed; wrappers become commit-only mirrors whose op methods delegate to commands. | `commands/*`. Absorbs `beforeInput*Commands`, `edytor.utils`, `replaceSelection`, `clipboard/insert*`, `richTextOperations`' mark policies, `blockMove`. Delete 20 `stopCapturing`, 7 prevention catch sites, 18 `flushMirror` sites. | T2-T5, T20-T22, T32a. The headless command lane re-pointed from `runBeforeInputCommand` to `dispatch(intent)` with the **same** hand-authored expectations. | All lanes green. P9: 1,000 selected blocks deleted in < 100 ms. | Maintainer sign-off on T21 (paste placement) and T22 (move down) is required first; without it, those tests stay deferred and current per-path behavior is preserved. |
| **CP6** Cells, bracket, projector | Rules 6 and 8. T13, T24a, T25-T27, T33 (typing). Cells patched only from DocChange. `flushSync` bracket at dispatch end, remote apply and selection commit. The projector is the only DOM-selection writer. Zero `tick()` polling. Caret timers: only the Android snap-back. | `view/{cells,segment,inline}`, `components/` (Block owns the element), `selection/{dom,projector,classifier,pointer}`. Delete wrapper mirror code, `setAt*` loops, write verification, remote reconcile, `getTextNode` polling, structural-drift repair + `editorDomRevision`, post-delete caret retry, composition caret timers. | T13, T24a, T25-T27. `mirror-incremental`/`scoped-text-refresh` rewritten as DocChange → cell oracles. | All lanes on Chromium. **Every Firefox/WebKit DST seed that passed at CP0 still passes.** That is the proof that the timer-free classifier absorbs the Gecko re-anchor bounce and the WebKit skipped echo. | Riskiest CP. Each engine behavior that is neither "no gesture + render advanced" nor "equals display" may add **one** named, real-browser-tested case. A third such case → stop and revisit rule 8, e.g. a bounded post-display verification inside the projector. `flushSync` called inside an effect → dev assertion, bracket deferred to the flush. |
| **CP7** Input | Rules 9-10. T11, T12, T14c, T16, T17, T24. The 48 composition + 8 cancellation tests. Pins re-decided: remote text at the composition point is preserved (not replaced); previews are not replicated. `mobile-*` and `dom-mutation` specs. DST `foreignMutation` oracle (healing by record inversion). | `input/*`. Delete the `events/` suppression family, snapshot, predicate families, event fabrication, second adopter, observer liveness/spec tables/caret restore, the `diffText` advanced path, composition code in `edytor.svelte.ts`/`text.svelte.ts`. | T11, T12, T16, T17, T24; synthetic fixtures for the Android and WebKit event orders. | Unit/DOM/integration (every available engine)/DST solo + collab green. | If replicated previews are required, switch the session to one replace-region write per update (+≈40) **before** starting. No composition mechanism may be added without a failing real-browser test naming the engine behavior. 2 repair rounds per engine. |
| **CP8** Plugins/UI | Rule 12. T15, T19, T23. `placeholder-repair.spec` user-visible assertions pass with the CSS placeholder. HTML paste on `DOMParser`. Handles/toolbar/slash/hotkeys/navigation specs. Demo route specs. | `plugins/`, `components/`, `clipboard/`, `hotkeys/`. Delete `parser.ts`, per-paste validation, proxies, `removeStalePlaceholders`, placeholder observers, 4 positioning loops, 5 walkers, move vocabularies. | T15, T19, T23. Tokenizer fixtures retired; C7/C8 decisions recorded (degrade instead of throw; no trailing-text merge). | All lanes; demo works. | Placeholder snippets becoming string functions needs sign-off. If rich markup is required, render it in the overlay; never put a node back into the editable flow. |
| **CP9** Retire + measure | No behavior change. | Remove compatibility shims the API decisions retired. Update AGENTS.md and the ADRs. Final xloc, bench and bundle vs CP0. | — | `pnpm release:check` green. Census: timers ≤ 10, `tick()` polling 0, `flushMirror` 0, `stopCapturing` 1, prevention catch sites 1, MutationObservers 1. | — |

### 9.3 Order and parallelism

- **CP1 first.** It is independent of the view, carries seven probe-confirmed bugs and has the lowest coupling.
- **CP2 → CP3** change the document behind a stable API.
- **CP4 before CP5 before CP6.** Selection must stop storing wrappers before commands stop reading them, and commands
  must stop reading them before cells can replace them.
- **CP7 needs CP6.** Observer provenance relies on the bracket.
- **CP8 needs CP5 and CP6.** Kinds need commands; the core-owned element needs cells.
- **Parallel work.** CP1 can run alongside CP2-CP3, and CP8's HTML/clipboard part alongside CP7.

---

## 10. Extension-cost check

Counted as **owners that must change**: modules whose decisions must be edited, excluding the new feature's own
files. The "today" counts come from the readers' fact tables (F19/F20 plugins-ui, F5 runtime, F17 selection) and the
code paths named there.

| Extension | Today | Proposal | Why it is cheap now (and what is still paid) |
|---|---|---|---|
| **(a) New block type with nested children** (e.g. a toggle list) | **6-7 owners**: plugin definition + snippet with the `use:block.attach`/content/children skeleton. Core `Block.svelte` re-key if data changes the element (hardcoded for `heading`). `richTextCommands.ts`. Markdown table. HTML import table. Core clipboard export table. Eligibility predicates in 4 places (convert, markdown, slash, toolbar). Demo menu. | **1 owner** (the plugin): one kind record `{type, element(data), content: true, role?, dataPreset, label, icon, keywords, markdownPrefix?, html:{import, export}, plain?, empty?, defaultChild?(parent)}` + an inner-markup snippet. | Core renders the element and the children slot generically. Semantics (roles, default child type) are adopted from the record. Slash/markdown/HTML/clipboard read the record. Navigation, selection, delete and move are type-agnostic. **Still paid:** a structural invariant (e.g. "exactly N children") is a normalization hook in the same plugin. |
| **(b) New mark** (e.g. valued `highlight`) | **4-5 owners**: definition + snippet; HTML import; core clipboard export table; toolbar/hotkey; three divergent next-marks rules (a collapsed toggle drops valued marks: probe `mark-inherit`); sanitization in 3 places. | **1 owner**: mark record `{name, snippet, html:{import, export}, sanitize(value), inherit: boolean, hotkey?, toolbar?}`. | One next-marks rule, generic over values. Sanitization at the render boundary only. `inherit:false` covers non-inclusive marks (links at edges use the same field plus the boundary hook). |
| **(c) New inline void** (e.g. date chip with a trigger character) | **3-5 owners**: definition + snippet. Clipboard/HTML tables. Adoption hardcodes the *mention* trigger in core (`onInput.ts:471`) because adopted text bypasses plugin interception. Atom replacement/deletion rules are duplicated in `hotkeys.ts` and `onKeyDown.ts`. | **1 owner**: inline kind record `{type, snippet, html, plain}` + a command hook on `insertText` (fires the same way for typed, adopted and committed-composition text, because every source dispatches the same command). | Atoms are generic in offsets (count 1), selection (atom kind), deletion, navigation stops and clipboard. |
| **(d) Comments / suggestions on ranges** (anchored, replicated, survive edits) | Not supported. Would touch: the three next-marks rules, pending marks stored on segments, the core clipboard table, HTML tables, the toolbar snapshot. Plus, if done as a separate range store: slice-record-aware anchors and the mirror. **≈ 6+ owners.** | **2 owners** for the mark-based design: (1) the plugin, with mark families `comment:<id>` and `suggest-insert:<id>` / `suggest-delete:<id>`, `inherit:false`, empty clipboard export, and a thread store (a replicated map or an external backend); (2) the mark registry learns *key families* (prefix lookup, ≈10 xloc, core). **Suggest mode** is a command hook that replaces `deleteText` with `markText(suggest-delete)` and tags inserts. Accept/reject are commands. | Rule 2 is what makes it work: text never moves, so format items on atoms follow them through split, merge, move and undo on every replica, with different keys unioning (R9). **Still paid:** overlapping-range rendering is the Mark component's nesting (exists). Comments on *whole blocks* need a block-data field instead. An anchored-range store (3-4 owners: ops, derived index, render decorations, plugin) is only needed if annotations must not be undoable with the text. That is a product decision. |

**Engine-level extensions, for completeness:**

| Extension | Today | Proposal |
|---|---|---|
| New content op | Text-layer op + placement wrapper + facade wrapper (policy, no-op prediction, lineage capture, attribution stamp) + typed-handle method + maybe a new run-view facet: 5 places | One `ops.ts` function (validate, then write) + one command. Effect, attribution, lineage and invalidation follow from the transaction. |
| New inputType | Up to 8 decision sites: predicate family, target-sync rules, browser-owned classification, command router, `shouldRefreshDomAfterModelCommand`, `NON_COMPOSITION_INSERT_TYPES`, `stopHistoryCaptureIfNeeded`, `onInput` predicates | One intent-table row + one command case. |
| New selection kind (e.g. table cells) | 30-field state, 4 builders, 7 writers' side-effect sets, 2 dedupes, the undo snapshot with its 3 restore shapes, echo latches | One union variant + one projection branch + one display branch in the projector. |

---

## 11. Risks and unknowns

Numbered so the other sections can refer to them. Each risk names the CP that will detect it, and the fallback
with its cost in xloc.

| # | Risk | Why it matters | Detected at | Mitigation / fallback |
|---|---|---|---|---|
| R1 | **Boundary atoms change text ownership** (rule 2) | Three pinned tie-breaks change: **TX06a** (a concurrent remote insert exactly at a split seam lands on the side YATA's client order picks, not always the head), **TX04a** (which same-anchor split sibling gets the tail), **A-5** (undo after a concurrent split *at the deletion gap* may return the text into the new block; YATA order between the copy and the new boundary decides, since `redoItem` integrates copies between the tombstone's current left neighbour and the tombstone, verified at `vendor/yjs/src/utils/UndoManager.js:425-520`). New single-owner invariants are needed: content deletes never remove boundary atoms; every read skips them; a boundary insert passes the active marks (no negation format items); the nonce disambiguates duplicate ids. The boundary atoms of deleted split-born blocks stay live (they delimit dead streams): a small permanent cost. | CP2: the random corpus against both models + bench bytes | Keep slice claims + contest + undo repair (≈ +1,000 xloc; §7 sensitivity). The rest of the plan does not depend on this bet: facade API unchanged, anchors keep `{b, a}`. |
| R2 | **Render bracket via `flushSync` + `takeRecords`** (rule 6) | Svelte 5 forbids `flushSync` inside effects (verified: `flush_sync_in_effect`, `node_modules/svelte/src/internal/client/errors.js:252-263`, svelte 5.55.1), so a command dispatched from an effect must defer its bracket end. A render inside the host outside any bracket (e.g. a plugin's async decoration) is seen as foreign. That costs an idempotent re-render, never data: adoption diffs DOM text against model text, our renders produce model text, and the composition host is skipped. A synchronous flush per command/remote apply may cost typing latency. | CP6 (dev assertion "host mutated outside bracket"), `bench:browser` | Fallback: keep a smaller provenance classifier in the observer (≈ +800 xloc, input reader's estimate). |
| R3 | **Composition previews live only in the DOM** (rule 10) | Peers and persistence see composed text only at commit. On Android (GBoard composes word by word) that is a per-word lag, and a crash loses the current word. Android *recomposition* of existing words must take the covered range from the first composition target range. The `composition-remote-lock` pin "absorbed remote text is replaced at commit" changes to "preserved and ordered after the commit". | CP7: 48 + 8 composition tests on real engines; Android is only covered by synthetic fixtures | Replicated previews through one replace-region write per update (≈ +40 xloc), same session, same two anchors. |
| R4 | **Timer-free selection ownership** (rule 8) | The Gecko re-anchor bounce, the Android post-delete +1 shift, IME post-commit selection jumps and WebKit's skipped echo must each reduce to "no gesture + render advanced" (drift) or "equals display" (echo). Only real browsers can falsify this, and mobile Safari/Android are not in the lanes. | CP6/CP7: DST on 3 engines; the pass set must not shrink | One named, real-browser-tested case per engine behavior (the Android snap-back is already one). A third case triggers the CP6 stop rule. |
| R5 | **Healing by generic record inversion** (rule 9) | Inversion assumes the records are complete and replayed in reverse order. Two consequences: (1) the observer must flush pending foreign records *before* every bracket, so foreign and own changes never interleave; (2) a record whose reference siblings are gone (the browser removed a subtree and then its parent) cannot be inverted in place. Re-rendering a text element after adoption rewrites a node under the caret (per the DOM "replace data" rule the caret moves), so correctness relies on the projector re-displaying after every bracket. | CP7: DST `foreignMutation` + `dom-mutation.spec` + `mobile-beforeinput` (Android structural drift) | Remount the smallest owning unit when inversion fails (≈ +20 xloc). Re-rendering a unit that contains an image or a focused void caption reloads it or loses focus, which is acceptable only on this rare path. |
| R6 | **Readiness rule** (rule 11) | The bound for "this provider will never answer" (an empty room over an opaque relay): too short, and a slow member causes an extra empty paragraph; too long, and the first user waits. **Contract change:** SY03b-e ("concurrent seeds converge to one bootstrap block") becomes "no seed ever overwrites content, and two concurrent seeders may each leave one empty paragraph". Today's convergence comes from a reserved-id LWW that probes show erases content (P4b/P4c). | CP1: T28 | Maintainer decision. The alternative (view-level virtual first line materialized on first input) was rejected: it needs special cases in render, selection and IME. |
| R7 | **Compatibility per channel/container** (rule 11) | Every schema bump becomes a generation bump plus an import. Mixed-generation rooms *partition* instead of LWW-coexisting (documented contract change). Probe P2 shows today's coexistence does not keep incompatible content out anyway. | CP1 | Maintainer decision on the contract text. |
| R8 | **Plugin API semantics** | Hooks run once, at admission of the concrete command an intent resolved to (Backspace at a block start is still `mergeBlockBackward`). A third-party plugin that intercepted *internal* sub-steps (e.g. `removeBlock` inside a range delete) no longer sees them. Plugins that build detached `new Block({...})` objects must pass JSON specs to `insertChildren` instead. `prevent()` keeps its signature (it still throws) but is caught in exactly one place. `Text` objects have no stable identity (key state by block id + anchor). Removed internals: `ignoreNextSelectionChange`, `queueNextUndoSelectionSnapshot`, `getTextById`, direct `undoManager.stopCapturing`. Placeholder snippets become string functions. Decisions T21/T22 change behavior on some paths. | CP5/CP8 | Document it in a migration note; keep thin deprecated shims where cheap. |
| R9 | **Test-harness rewrite** | DST dump inventories, the headless command lane, mirror/refresh unit tests, schema-boundary suites and presence tests pin mechanisms. Coverage can silently drop during the transition. | every CP | Rewrite the oracle *before* removing the mechanism (tests-first rule). The census and the CP0 pass sets are the non-regression baseline. |
| R10 | **Estimation** | ≈3,480 xloc of the reduction is shrinkage of kept responsibilities, estimated not measured. Readers' floors overlapped (composition and attempt code were counted by two readers); this plan de-duplicates them, and that deduplication is itself an estimate. | per-CP xloc + census | §7 sensitivity: −46% if shrinkage halves; −40% if R1 and R2 also fail. |

### Open questions not decided here (no contract covers them)

- **Q-order.** Reading order of concurrently split siblings is decided by random in-gap placement ranks: 16/40
  client-id pairs read `hel │ rld │ lo wo` (crdt reader C1). This is pre-existing, not a regression.
  - Boundary atoms enable a fix: a split-born block with no explicit placement is displayed right after the displayer
    of the preceding stream, ordered by boundary item order, until it is explicitly moved.
  - Cost of the fix: a new ordering rule in the projection plus acyclicity handling for implicit edges. Not included.
- **Q-subtree.** A concurrent `delete(p)` ‖ `move(child of p → root)` leaves the child visible (crdt reader C5). The
  move ADR says the subtree is hidden. The choice between rescue and delete-wins-subtree is unchanged by this plan.

### Unknowns I could not resolve from the repo

- **U1.** Real Android/iOS IME behavior under DOM-only previews and a timer-free projector. The lanes run desktop
  engines only.
- **U2.** Whether `flushSync` inside the facade's commit callback is safe for every provider apply path, e.g. an
  update applied inside another transaction's observer.
- **U3.** Whether external consumers rely on the retired y-websocket/y-indexeddb parity surface (B6) or on plugin
  internals (R8).
- **U4.** Actual bundle impact. The vendored engine dominates the bytes, so it is not predictable from xloc.
- **U5.** `navigator.locks` availability on the minimum supported Node (`engines: >=22`) for headless migration.
  - Present in browsers and in this environment's Node (v24.21.0: `typeof navigator.locks === "object"`); not verified on Node 22.
  - Fallback: an in-process mutex, because headless runtimes have no cross-tab contention.

### Decisions the maintainer must make (explicit scope cuts and contract changes)

Everything else in this plan keeps feature parity with what the tests, docs and demo exercise. The following items do
not, or they change a pinned expectation. Each needs a yes or no **before** its checkpoint starts.

| # | Proposed change | What users or integrators see | Why | If refused (cost) |
|---|---|---|---|---|
| D-1 | Boundary-atom text ownership (internal schema layout 2) | Pins TX06a / TX04a / A-5 change (§11 R1). No user migration, because v14 is unreleased. | Deletes ≈1,000 xloc and the undo repair. Fixes T7, T9, T10. | Keep slice claims (+≈1,000). |
| D-2 | Compatibility by generation (engine + wire + schema) instead of per-update gating | Mixed-schema rooms partition instead of LWW coexistence. | Today's gate does not keep content out (P2). It disables compaction forever (C11) and silently drops input (P7). | Keep staging (+≈250) and fix P7 separately. |
| D-3 | Seed after all providers settle or the bound elapses, with fresh ids | Two concurrent seeders may leave two empty paragraphs instead of converging to one bootstrap block (SY03b-e). | The reserved-id seed erases content (P4b/P4c) or never renders (P6). | Keep the reserved id (+≈100) and accept the erasure risk. |
| D-4 | Composition previews stay in the DOM | Peers and persistence see IME text at commit, not while composing. Remote text at the composition point is preserved, no longer replaced. | Removes per-update transactions, a double cancel semantics and the plugin-replay bug class. | One replace-region write per update (+≈40). |
| D-5 | Plugin hooks see the concrete command once, not internal sub-steps | Plugins that intercepted sub-steps of multi-step commands must intercept the command. | Midway vetoes duplicated text (P11/P11b, `prevent-midway`). | None cheap. This is the fix. |
| D-6 | Retire plugin-facing internals: `ignoreNextSelectionChange`, `queueNextUndoSelectionSnapshot`, `getTextById`, direct `stopCapturing`, detached `new Block({...})` | Third-party plugins using them must migrate. | They exist only to patch around the mechanisms being deleted. | Thin deprecated shims (+≈40). |
| D-7 | Placeholder snippets become string-returning functions (CSS placeholder) | No rich markup inside the placeholder, or render it in the overlay. | The in-flow placeholder node costs ≈400 xloc of repair and 9 deciders. | Overlay-rendered snippet placeholder (+≈40). |
| D-8 | Paste placement unified (T21) and "move down" unified (T22) | Internal-fragment paste lands like HTML paste. The arrow-move chord no longer enters the next sibling's children. | Three placements and two meanings of "down" for one intent. | Keep per-path behavior; T21/T22 stay deferred. |
| D-9 | HTML import via `DOMParser`; invalid tag mappings degrade instead of throwing (C7); trailing inline text not merged into the last block (C8) | Edge cases pinned only by fixtures change. | 426-xloc tokenizer plus validation machinery. | Keep the tokenizer (+≈430). |
| D-10 | Drop the y-websocket/y-indexeddb parity surface nothing here calls (B6); drop `decorateRuns` and the per-block subscription variants (A13) | Loses API parity with upstream providers, and unused public helpers. | No in-repo consumer. | Keep them (+≈120 / +≈150). |

