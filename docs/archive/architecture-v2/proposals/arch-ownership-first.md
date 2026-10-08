# Edytor — Ownership-First Architecture Proposal

Status: COMPLETE (11 sections). Target: 15,926 xloc (−45.1 % from 29,026); floor 14,473 (−50.1 %); 17,153 (−40.9 %) if the stream-boundary representation fails its checkpoint.

Angle: **ownership-first.** Every fact gets exactly one owner that has the information, the lifetime and the
authority to decide it. Code that exists because ownership is unclear is deleted, and the invariant the owner
establishes is stated in its place. Owners are five broad contexts, not one class per noun:

| Context | Lifetime | Authority | One-line mandate |
|---|---|---|---|
| **Document** | the Y.Doc (per-doc derived state lives exactly as long as the doc) | replicated truth + adopted semantics | the only writer of replicated state; answers every structural question once |
| **Session** | one view (mount → destroy) | this local user's intent | owns the selection value, commands, input attempts, composition, history snapshots |
| **Surface** | one mounted DOM (may remount) | none over meaning; renders and observes | the only reader/writer of the editable DOM and the DOM selection |
| **Extensions** | editor construction (immutable afterwards) | definitions | kinds, marks, atoms, bindings, hooks — each declared once, in one record |
| **Transport** | provider / container / document | channel integrity | generations, joins, persistence, presence entries, migration |

Evidence base: the six domain reader reports (`scratchpad/arch/reader-*.md`), re-verified in source where a claim is
load-bearing for this plan (listed at the end of §11), the allowed contract docs (`editor-delete-contract.md`,
`crdt-v14-*-adr.md`, `crdt-v14-selection.md`, `crdt-v14-document.md`, `crdt-v14-providers.md`, `README.md`,
`AGENTS.md`, vendored `API-NOTES.md`/`UPSTREAM.md`). No other architecture opinion was read.

Measurement: `node scratchpad/xloc.mjs src/lib --dirs` measures **29,026 xloc / 118 files today** (the task baseline
said 28,941; the working tree grew since — selection is 3,871, not 3,786). All deltas below are against 29,026.

Two facts found while verifying that shape the plan:
- **The v14 engine has never shipped.** `d9b7de0` is not an ancestor of `master`; `package.json` is `0.0.11`. No user
  storage holds a v14 document and no deployed peer speaks v14. Changing the v14 storage representation, dropping
  legacy v14 presence fields, and moving schema compatibility into the generation word therefore break no deployed
  data or peer. The v13→v14 migration stays mandatory and is representation-agnostic (it materializes JSON).
- **The vendored engine already skips tombstones on insert.** `minimizeFormatChanges` (`vendor/yjs/src/ynode.js:285-297`)
  advances an insertion past deleted items whose rendered length is 0. This matters for the stream-boundary
  representation in rule R2. §8 has a falsification test for it (U4).

---

## 1. The few necessary facts and rules from which the behavior follows

Twelve rules. Each is one sentence and is owned by one context. Every deletion in §5 cites the rule whose invariant
replaces it.

| # | Rule | Owner |
|---|---|---|
| **R1** | **One writer per store.** The replicated document is written only by Document operations, the editable DOM only by the Surface renderer, the DOM selection only by the Surface projector, a presence entry only by the view that minted it, and persisted rows only by the Transport's append-only store. | all |
| **R2** | **Streams are delimited by replicated boundary items.** A block's own text is the run of atoms after its boundary item up to the next live boundary item in its backing text, and a block displays its stream followed by the streams it claims by merge, so the owner of any text position is a pure function of replicated items and is never re-decided by a contest, a rewrite or a repair. | Document |
| **R3** | **Positions that outlive a synchronous turn are anchors.** Every position kept across an await, a render or a peer's edit (selection endpoints, composition region, keydown targets, UI-held ranges, undo snapshots, presence) is stored as a document anchor and resolved to *(block id, display offset)* when read; numeric offsets and text-segment identities are never stored. | Document (codec), Session (holders) |
| **R4** | **Semantics are adopted once and answered by one predicate.** Block roles (void, island), the default child type per parent type, targetability, structural permission and document order are document semantics adopted from definitions at construction and answered by one function each, so an affordance asked in advance and the operation at execution get the same answer. | Document |
| **R5** | **Effects are observed, not predicted.** A document operation validates before its first write and reports `refused`, `noop` or `applied` with the ids and position it produced, and publication, attribution, render patches and undo capture all derive from one fold of the transaction's own change set. | Document |
| **R6** | **One command, one dispatcher.** Every mutation a view makes is a command value run by that view's dispatcher, which alone applies permission (readonly, document writability), extension veto as a returned value before any write, exactly one transaction, the undo-step policy with this view's before/after selection, and the command's returned selection. | Session |
| **R7** | **One occurrence, one attempt.** Each user input occurrence opens at most one attempt whose intent, anchored target and owner (model or browser) are fixed at admission; DOM changes seen while it is open are adopted if the browser owns it and reverted otherwise, and a composition is an attempt that ends exactly once, in commit or cancel. | Session |
| **R8** | **The selection is a value.** The local selection is an immutable tagged value (none, text anchors with pending marks, one atom, or a block-id set) replaced only by `select()`, which advances the selection epoch and applies every side effect once; positions, covered blocks, flags and marks are projections of *(value, document version)*. | Session |
| **R9** | **Display is a projection of the current value.** Only the projector writes the DOM selection, always from the current value, only when the target is mounted and focus is not foreign, and it classifies each observed selection as echo, render drift, composition noise, foreign write or user intent by comparing it with its last display and the render epoch. | Surface |
| **R10** | **The editable host holds only model content.** Every node inside the contenteditable host is model text or core-rendered structure whose presence is a pure function of the model; chrome (handles, menus, drop indicator, remote carets) lives in an overlay outside the host, and the placeholder is an attribute. | Surface |
| **R11** | **Own renders are never input.** Document changes render inside a bracket that first drains pending mutation records and then discards the records its own flush produced, so every record that reaches classification was made by the browser or a foreign script. | Surface |
| **R12** | **Opening never writes, and channels prove their generation.** A replica writes only content it authored (a command or an explicit create), and it integrates bytes only from a frame or container proven to carry its own engine, wire and schema generation. | Transport + Document |

How behavior follows (examples, not exhaustive):
- *Undo restores the caret in the issuing view only* follows from R6 (the dispatcher records this view's
  before/after values on the step) + R8 (restore is an ordinary `select()`). One restorer; the id/path restorer has
  no owner left.
- *Delete wins over a concurrent insert into the deleted block* (`conc.delete-wins-block`) follows from R2: the
  concurrent insert lands inside the deleted block's stream, which is hidden with it. No view-side tombstoning.
- *Undo returns deleted text to its pre-delete block on every replica* follows from R2 + the engine's `redoItem`
  placement (a copy is integrated between the tombstone's left neighbour and the tombstone, i.e. inside the same
  stream). No repair transaction, no second wire update.
- *A veto never half-executes a command* follows from R6 (hooks run before the transaction; nested sub-steps call the
  Document directly, not the hooks).
- *The keydown fallback deletes the right text after a remote insert* follows from R3 + R7 (the attempt's target is
  anchored at admission).
- *A paused IME is not cancelled by the editor's own attribute writes* follows from R11.
- *Typing into an empty block hides the placeholder in the same frame* follows from R10 (the placeholder is
  `data-placeholder` derived from the model) + R7 (browser text is adopted in the same microtask).

---

## 2. Authoritative representations and derived views

### 2.1 Stored once (authoritative)

| # | Representation | Stored in | Only writer | Lifetime | Category |
|---|---|---|---|---|---|
| A1 | **Registry record** per block id: `{type, data, del, content, claims, at}`. `content` is the block's *backing text*: characters with marks, inline-atom nodes and **boundary items** `{s: blockId, n: nonce}`. `claims` holds only merge claims `{m: blockId}`. `at` holds placement candidates `{p, r}` (parent, rank; one attr, LWW). | Y.Doc `blocks` root | Document ops | replicated, persisted | durable progress |
| A2 | Document meta: schema stamp; attribution records `b/<id>`, actor profiles `u/<actor>` | Y.Doc | Document (write funnel) | replicated | durable progress |
| A3 | **Adopted semantics** `{roles: type→void\|island, defaultChild: parentType→type, defaultType}`, declared as data by kind records and validated for conflicts on every view's adoption | Document | adoption, once per document | document | immutable admitted meaning |
| A4 | **History** stacks (engine UndoManager, scope = registry) with per-item `meta: Map<viewKey, {before, after}>` holding *selection values* (anchors only, no pending marks) | UndoManager (in memory) | Session dispatcher (records), engine (pops) | document | durable progress for the session |
| A5 | **Definitions**: kind, mark and atom records; key bindings; hooks | Extensions registry | construction | editor | immutable admitted meaning |
| A6 | **Selection value** `none \| {text, anchor, focus, pending?} \| {atom, blockId, atomId} \| {blocks, ids}` + selection **epoch** | Session (`$state`, replaced, never mutated) | `select()` | until the next `select()` | immutable admitted meaning |
| A7 | **Command** value `{kind, target, payload, origin}` and its result `{status, selection?}` | Session dispatcher | the producer (binding, menu, attempt) | one command | immutable admitted meaning |
| A8 | **Input attempt** `{id, intent, target: anchored, owner: model\|browser, expect?, deadline?, phase}` | Session | admission | one occurrence | intent/target/owner immutable; `phase`/`expect`/`deadline` replaceable |
| A9 | **Composition** `{host, startTarget, marks, region: {start, end} anchors, phase}` | Session | composition session | compositionstart → commit/cancel | `host` = resource; `startTarget`/`marks` immutable; `region`/`phase` replaceable |
| A10 | Surface bookkeeping: `displayed = {epoch, range, renderEpoch}`, `renderEpoch`, gesture serial, attribution frame (user/programmatic), node↔cell `WeakMap` bindings | Surface | projector / renderer / event adapter | one mount | replaceable attempt state + resource ownership |
| A11 | Transport: provider per *(document, transport target)*; `hasSynced` (lifetime) and `connected` (transient); awareness instance (owned by its creator); container record `{engine, protocol, schema}`; append-only rows; migration record `{status}` | Transport | provider / container / migrator | provider or container | durable progress (rows, records) + resource ownership (sockets, timers, locks) |
| A12 | Presence entry `selections[viewKey] = {start, end, collapsed, reversed, t}` (anchors only) | awareness state | the view that minted `viewKey` | the view | replaceable |

Everything absent from this table is derived. In particular: no text-segment ids, no numeric caret offsets, no
`_live`/`_bound` flags, no slice records, no generation counters on claims, no second freshness counter, no
`synced` shadow flag on the view.

### 2.2 Derived (computed; never stored as truth)

| Derived view | From | Owner | Recomputed | Consumers |
|---|---|---|---|---|
| **Per-doc index**: record cache, stream table (boundary positions per backing text), merge-claim owners, winning placements, visible tree, children order, document order, maintained runs per block | A1–A3 | Document index (one per doc, doc lifetime) | folded **once** per transaction from `transaction.changed`/`insertSet`/`deleteSet`; read-your-writes inside a transaction | every op, anchors, change report, JSON export |
| **Change report** `{added, removed, moved, meta, content, order, local, origin}` | the fold | Document | once per commit (nested transactions publish once; change-then-revert publishes nothing) | Surface cells, Session repair of held anchors, `onChange` |
| **Op result** `{status: refused\|noop\|applied, ids, at}` | the fold | Document | per op | dispatcher, attribution, undo capture |
| **Selection view** `project(value, indexVersion)` → start/end *(block, offset, segment)*, collapsed, direction, covered blocks and segments, at-edge flags, island/void root, marks at caret, content string (the last two lazy) | A6 + index | Session | memoized per (value, version) | commands, `selection.state` compat getter, toolbar, clipboard |
| **Render cells** (one reactive cell per visible block id) and their **segments** (`$derived` from content runs; merged adjacent equal-mark runs; ZWSP/newline fillers) | change reports | Surface | patched only from change reports | components, DOM mapping |
| Placeholder attribute | cell emptiness ∧ not composing in that cell | Surface (`$derived`) | per render | CSS `::before` |
| Presence payload | `serialize(A6)` | Session → Transport | on `select()` when the value changed | peers |
| Remote caret geometry | resolve(peer anchor) → Surface mapper → rects in editor-relative coordinates | Surface overlay | per frame when peers or layout changed | overlay |
| JSON value | Document `toJSON()` | Document | on demand, memoized on index version | `value` export, `onChange` |
| Readiness | Document state machine | Document | on events | views (informational `synced`) |
| Structural permission, document order, default child type | A3 + index | Document | per call (cheap reads of the index) | DnD affordance, commands, range delete, navigation |

### 2.3 Lifetimes (nested; an inner lifetime may never own a fact an outer one needs)

```
document (Y.Doc, adopted semantics, index, history, attribution, providers)
 └─ view / Session (selection value + epoch, keymap, dispatcher, held ranges, presence entry)
     └─ mount / Surface (cells, DOM bindings, projector 'displayed', observer, overlay)
         └─ command (value → one transaction → result)
             └─ attempt / composition (intent, anchored target, owner; host node pinned)
                 └─ render flush (bracket: drain → patch → flushSync → discard own records → display)
```

Two consequences that remove existing machinery:
- Per-doc derived state (index, undo-repair listener today, lineage ring trim) is attached **once per doc** and dies
  with the doc. The lease/refcount wrapper and the "undo repair disarmed after the last facade dispose" window
  disappear because nothing view-scoped owns doc-scoped state.
- Anything that must survive a remount (the facade change subscription, today re-established on every `attach`) is
  owned by the Session, not by the mount. The "re-subscribe on attach" patch (`edytor.svelte.ts:828-910`) has no
  reason to exist.

### 2.4 The four categories the method asks to keep apart

| Category | Where it lives in this design | Never mixed with |
|---|---|---|
| **Immutable admitted meaning** | command values, attempt intent/target/owner, composition `startTarget` + `marks`, admitted clipboard flows (validated, fresh ids), adopted semantics, definitions, selection values | attempt state: nothing re-reads the DOM event or recomputes the target after admission |
| **Replaceable attempt state** | attempt `phase/expect/deadline`, composition `region/phase`, projector `displayed`, drag placement, UI-held anchors | durable state: it is never persisted, replicated or put in an undo step (composition previews are the exception; see D13 in §6) |
| **Durable progress** | Y.Doc, persisted rows, migration record, undo stacks | attempt ownership: no lease, owner or expiry fields in durable records |
| **Resource ownership** | IME host node (composition), DOM nodes (cells), sockets/timers/awareness (provider that created them), `navigator.locks` lock (migration attempt), observers/listeners (mount) | meaning: releasing a resource never changes a document fact |

---

## 3. Ownership map (NEW): fact → owner module → lifetime → consumers

Citation keys for "replaces": **S** = selection reader, **I** = input-events, **M** = runtime-model, **C** = crdt-core,
**T** = sync-collab, **P** = plugins-ui (their §3 fact ids). A count such as "×7" is the number of places deciding
the fact today.

### 3.1 Document (lifetime: the doc unless noted)

| # | Fact | Owner module | Lifetime | Consumers | Replaces |
|---|---|---|---|---|---|
| O1 | Block identity | `doc/document` (the creating op mints; `doc/ingress` normalizes ids on write **and** on lookup with one function) | replicated | everyone | M-F1 (5 mint sites, 3 wrapper fields), C-F20 (≥12 ingress sites), C-C11 (normalized id unreachable by its creator) |
| O2 | Which block displays a text position | `doc/streams` (boundary items + merge claims, R2) → index | per transaction | content ops, anchors, render | C-F5 (×6), C-F17 (×2), M-F15 (delete enforced only by the view) |
| O3 | Display offset ↔ (backing text, index) | `doc/streams` `locate`/`position` pair | derived | every content op, anchors | C-F6 (≥10 walks, 3 boundary rules), M-F5 (7 mappers + a third coordinate system), S-F12 |
| O4 | Block is live / targetable | `doc/index` `isLive(id)` | per transaction | op preconditions, change report, anchors, Session | C-F3 (×7, disagreeing), M-F9 (6 flags) |
| O5 | Document order | `doc/index` `order`, `compare(a, b)` | per transaction | range selection, range delete, block-selection extension, clipboard, drag groups, navigation | M-F11 (wrapper vs facade disagree, probe P1), 4 block-range walks, P-F8 (×3, one wrong) |
| O6 | Structural permission (move/nest/merge across void/island, own subtree) | `doc/document` `canPlace`, `canMerge` over adopted roles | per call | DnD affordance, commands, range delete | M-F12, P-F5 (×6 divergent eligibility predicates) |
| O7 | Default child type for a parent | adopted semantics `defaultChild(parentType)`, applied by the op against the actual parent | document | split, paragraph insert, merge-unnest reset, clear, root normalize | M-F14 (view rule + flat facade rule + implicit caret-derived argument; probes P10, P12), M-F16 (copy then reset) |
| O8 | Op outcome `refused \| noop \| applied`, created ids, resulting position | the transaction fold (R5) | per op | dispatcher, attribution, undo capture | C-F10 (per-op re-derivation ×~10), C-D9, M-F6 (result shapes decided per op) |
| O9 | "Derived state caught up" (freshness) | `doc/index` version (one counter) | per transaction | memoized reads | C-F11 (5 counters), M-F19 (4 commit counters) |
| O10 | Which blocks and facets a transaction touched | the fold over `transaction.changed` | per transaction | index invalidation, change report, attribution | C-F12 (5 interpreters incl. a fake-op round trip), C-F13 (2 diff algorithms) |
| O11 | Change report | `doc/index` fold → `doc/document` publication | per commit | Surface cells, Session held anchors, `onChange` | M-F10 (2 reconcile algorithms), M-F3 (2 live sources of `_items`) |
| O12 | Anchor mint/resolve, including the seam for a dead block | `doc/anchors` | per call | selection, presence, history, composition, held ranges | S-F2 (affinity ×5), S-F19 (5 seam rules), C-F17 (`o` facet) |
| O13 | Range deletion between two positions | `doc/rangeDelete` | per command | delete keys, typing over a range, cut | I-F19 (3 ladders), M `deleteContentWithinSelection` re-derivations (probes P2, P5) |
| O14 | Placement of an admitted fragment (flow) at a position | `doc/flow` | per paste/drop/convert | clipboard, HTML, markdown, slash convert | P-F16 (×3 divergent), P-F17 (id stripping ×3) |
| O15 | Readiness (content decided) | `doc/lifecycle` state machine; opening never writes | document | views (informational) | T-F6 (4 latches), T-F8 (4 mirrors), C-F14 (×3), M-F25 (view timer) |
| O16 | Document still writable (foreign schema stamp observed) | `doc/lifecycle` `writable` | document | dispatcher permission, UI | T-F25 (transport silently quarantines input, probe P7) |
| O17 | Attribution stamp for a transaction | the write funnel, from O10's touched set | outer transaction | `b/` records | C-F22 (~20 call sites) |
| O18 | Schema/attr names | `doc/schema` (one table) | build | all | C-F19 (2 tables) |
| O19 | Lifetime of per-doc derived services | the doc (attached once) | document | index, lineage trim, rand | C-F15 (4 policies incl. a lease) |

### 3.2 Session (lifetime: the view unless noted)

| # | Fact | Owner module | Lifetime | Consumers | Replaces |
|---|---|---|---|---|---|
| O20 | The local selection | `session/selection` value (A6) | until next `select()` | everything | S-F1 (4 constructors + 5 repairers), S-F5 (4 containers), P-F9 (2 fields) |
| O21 | Direction | the value (`anchor`/`focus` order), taken from the observation or from the writer | value | commands, presence, history | S-F3 (a wrong formula copied ×4 + 3 inferences, probe C6) |
| O22 | Side effects of a selection change | `select()` (focused/selected sets + hooks + attributes, `onSelectionChange`, presence publish) | per write | UI, plugins, peers | S-F13 (7 writers, 5 side-effect sets), S-F20 / T-F15 (5 equality decisions) |
| O23 | Pending marks at a collapsed caret | the value (`pending`) | until the caret moves or text is inserted | insertion | M-F7 (stored on a segment wrapper and migrated on re-segmentation) |
| O24 | Marks of an inserted run | `session/editing` `marksForInsertion(value, replaced, neighbours, markPolicies)` | per insertion | typing, IME commit, paste, adoption, soft break | I-F5 / M-F8 / P-F6 (×8, 3 divergent rules; probe `mark-inherit`) |
| O25 | Command permission, veto, transaction, undo step, result selection | `session/commands` dispatcher | per command | every mutation | P-F12 (14 caret writers, 6 timing policies), P-F13 (20 `stopCapturing` sites), P-F15 (7 catch sites), P-F29 (readonly ×7), I-F14 (×9) |
| O26 | Undo/redo selection (before/after, per view) | dispatcher records; `session/history` restores in the issuing view | stack item | issuing view | S-F18 (2 restore pipelines, probe C1), M-F18 (probe P4) |
| O27 | Intent, target, owner of an input occurrence | `session/attempt` | per occurrence | commands, Surface observer | I-F1 (×7), I-F2 (×8), I-F15 (6 flags + 4 timers), I-F16, I-F17 (7 fabrication sites), M-F24 |
| O28 | Composition region, host, phase | `session/composition` | compositionstart → commit/cancel | preview, commit, cancel, render pin | I-F6 (7 writers, 3 representations), I-F7 (9 reset sites), I-F8 (commit ×4, cancel ×2 divergent), M-F21, M-F22 |
| O29 | Ranges held by UI across think-time | `session.hold(range)` → anchors | until the UI closes | slash menu, toolbar, link editor | P-F23 (numeric second owners, probe `stale-offsets`) |
| O30 | Key-binding precedence | `session/keymap` (consumer > extensions in list order > built-ins; first claim wins, returned not thrown) | editor | keydown | P-F14 (5 precedence rules), I-F22 (keydown handled twice) |
| O31 | Relative block move (up/down/in/out) | `session/moves` → `doc.moveBlocks` | per command | hotkeys, handles, drag, menus | P-F22 (4 vocabularies, probe `move-down`) |
| O32 | Empty-document editing target | `session/commands` virtual block (materialized by the first command) | while no block is visible | commands, Surface | the reserved bootstrap-id seed (T probes P4b/P4c) |
| O33 | Vertical goal column | `session/navigation` | consecutive vertical extensions | navigation | single today (kept) |

### 3.3 Surface (lifetime: one mount unless noted)

| # | Fact | Owner module | Lifetime | Consumers | Replaces |
|---|---|---|---|---|---|
| O34 | Which DOM element *is* block X | core `Block.svelte` renders the element (`definition.element(data)`); snippets render inner markup | per mount | DOM mapping, handles, drop targets | P-F1 (×3+, probe `code-attach`), P-F2 (heading re-key in core) |
| O35 | DOM point → *(block, offset)* | `surface/domPoint` (one interpreter with explicit mode: *settled* or *DOM ahead of model*) | per read | observation, admission, adoption, paste, drop | S-F10 (≈6 interpreters, 5 overlay mappers), I-F3 (×3) |
| O36 | *(block, offset)* → DOM point | `surface/domPoint` | per write | projector, remote carets | S-F11 / T-F24 (×2) |
| O37 | Writing the DOM selection | `surface/projector` | per flush / select / mount | browser | S-F14 (16 staleness mechanisms), S-F17 (≥8 mount-wait loops), I-F13 (11 cadences) |
| O38 | Classifying a `selectionchange` | `surface/projector` classifier | per event | Session | S-F15 (17 flag setters + 5 classifiers) |
| O39 | Focus verdict (foreign control vs orphaned `body`) | `surface/projector` | per write | projector | S-F16 (3 different verdicts, probe) |
| O40 | Scroll permission | `surface` attribution frame (user / programmatic) | per write | projector | M-F23 (2 counters) |
| O41 | Provenance of a DOM mutation record | `surface/observer` render bracket (R11) | per flush | observer | I-F9 (liveness inferred by 2 predicates), I-F10 (2 identity routes), I-F11 (renderer knowledge restated in spec tables) |
| O42 | Adopt or revert an observed text change | `surface/observer` by location + open attempt's owner | per record batch | Session commands | I-F15 / I-F16 (two adopters ordered by timers) |
| O43 | Placeholder visible | `Text.svelte` `$derived` `data-placeholder` | per render | CSS | I-F12 / M-F27 / P-F4 (×9) |
| O44 | Overlay geometry (handles, menus, indicator, remote carets) | `surface/overlay` one measure-per-frame helper, editor-relative coordinates | per frame | chrome | P-F24 (4 loops), T-F12 (dead invalidation counter), G24 (no scroll handling) |
| O45 | Is this event the editor's (DOM facts) | `surface/events` `admit(event)` → Session decides permission | per event | Session | I-F18 (≥11 sites, inconsistent subsets) |
| O46 | Gesture serial | `surface/events` | per event | projector classifier | today spread over input handlers |
| O47 | Phantom content slot | declared in the kind record (`rendersContent: false`) | definition | anchors seam, navigation | M-F30 (inferred from DOM mount state) |

### 3.4 Extensions (lifetime: editor, immutable)

| # | Fact | Owner | Consumers | Replaces |
|---|---|---|---|---|
| O48 | Everything about a block kind: renderer, role, `defaultChild`, element choice, HTML import/export, markdown prefix, command row (label, icon, keywords), empty shape | one **kind record** in the defining extension | Document adoption, Surface, clipboard, slash menu, markdown | P-F19 (×3 tables), P-F20 (×6 catalogues), P-F21 (code-block shape ×2) |
| O49 | Everything about a mark: renderer, HTML import/export, sanitize, binding, edge policy (link) | one **mark record** | Surface, clipboard, `marksForInsertion` | P-F25 (sanitizers ×3), the link-edge rule in a snippet |
| O50 | Block-drag MIME | one constant | handles, drop admission | P-F28 (×2) |

### 3.5 Transport (lifetime: provider / container / document)

| # | Fact | Owner module | Lifetime | Consumers | Replaces |
|---|---|---|---|---|---|
| O51 | Bytes are of a compatible generation (engine + wire + schema) | `sync/envelope` per frame, `sync/container` per container | per frame / container | every integration | T-F3 (staging ×3), T-F4 (8 re-evaluations), T-F2 (2 stamp rules) |
| O52 | Provider has ever synced / is connected | `sync/room` shared lifecycle (`hasSynced` lifetime, `connected` transient) | provider | failed latch, UI | T-F5 (merged, probe P1) |
| O53 | Provider failed terminally | `sync/room` (once) | provider | Document, UI | T-F7 (provider + document re-decide) |
| O54 | Providers attached to a document | Document registry keyed by transport target | document | views | T-F9 (keyed by factory identity, probe P8) |
| O55 | Join handshake | one state-vector rule for channel and socket | per join | convergence | T-F10 (push vs pull, probes P5/P6) |
| O56 | Presence entry | the view that minted `viewKey`; `sync/presence` has one encoding (anchors) | view | peers | T-F13 (3 encodings), T-F14 (owner registries + sweep) |
| O57 | Stored-row key discipline | `sync/container`: append-only for every writer | container | hydration, compaction, migration | T-F17 (key-0 overwrite vs append, probes P3/P3b) |
| O58 | Migration attempt vs progress | attempt = `navigator.locks` lock (resource); progress = import row + `active` record in one transaction | lock: tab; record: container | boot | T-F18, T-D7 (lease/owner/poll in the durable record) |
| O59 | Legacy logical-id normalization | one pass + the canonical JSON→spec converter | migration run | rebuild, verify | T-F19 (×3 converters) |

### 3.6 Remaining flagged facts (smaller, same principle)

| # | Fact | Owner | Replaces |
|---|---|---|---|
| O60 | Text-segment identity | **none**: a segment is a pure function of a block's content runs, memoized per content version (anchor-contract rule 6 made structural) | M-F2 (positional ids `t:{block}:{ord}` built ×3, aliases, deferred rename, `getTextById(x.id) ?? x` ×4), S-F26 |
| O61 | Segment boundaries (text-first, text-last, gaps between atoms) | Surface cells (`$derived` from runs) | M-F4 (`deriveContentParts` + `groupContent`) |
| O62 | Where an operation applies | the command's explicit target; operations never read the ambient selection | M-F32 (`deleteText` always uses the caret offset; implicit `getDefaultBlock` argument) |
| O63 | Node ↔ cell binding | the cell's component, made at mount, released on destroy | M-F29 (~16 register/unregister sites with `get(id) === this` guards) |
| O64 | Paste/drop payload precedence (fragment → extension claim → files → uri-as-link → plain) | `session/editing` (one ladder) | I-F21 (×3) |
| O65 | Collapsed, covered blocks and segments with per-segment sub-ranges, island/void root (innermost, one rule), selected content string (from the model) | the selection projection | S-F4, S-F6, S-F7 (innermost vs outermost), S-F9 (DOM `toString` vs model), P-F7 (sub-range loops ×5) |
| O66 | "A range covering exactly one inline atom is an atom selection" | `session/selection` normalization of every candidate value | S-F21 (DOM rule, model rule, pointerup inverse, navigation) |
| O67 | Caret after removing a selected atom | one atom-removal command | P-F11 (×2), P-F10 (whole-tree search) |
| O68 | "Did inserting `\n` split the block?" | the op result (R5) | I-F20 / P-F26 (re-derived by counting siblings, ×2) |
| O69 | Is the DOM out of sync with the render tree? | **no detector**: cells change only from change reports (R1), foreign damage is reverted by the observer (R11) | M-F26 (4 heuristics incl. whole-editor `{#key}` remounts; probe `tab-remount`: 3 remounts per Tab) |
| O70 | Frame header (version word + type) | one `frame(type, write)` helper in `sync/envelope` | T-F1 (hand-repeated at 12 sites) |
| O71 | Reading order of concurrently split siblings | **open** (placement). R2 makes it decidable, because boundary order in the backing text is replicated, but does not decide it by itself (§11) | C-F9 (nobody; probe C1: wrong order in 16/40 client pairs) |

**Count.** The six readers list 162 fact rows. 134 of them are flagged as decided in more than one place. Several
facts appear in two or three readers (marks of an insertion, placeholder visibility, history restore, DOM point
mapping, readiness), so the number of distinct facts is lower. Every flagged row maps to exactly one owner in
§3.1–§3.6. The facts that were already single-owner keep their owner: rank codec, word boundary, grapheme
segmentation, node-bound provenance, goal column, pointer-drag flag, drop placement, handle offset, platform flag,
remote-apply origin. The only fact without an owner is O71, and it is carried to §11 as an open decision.

---

## 4. Module/layer map of the new `src/lib`

Dependency direction (enforced by lint import rules): `vendor/yjs ← doc ← sync`; `doc ← session` (session never
touches the DOM); `doc, session ← surface` (surface is the only DOM toucher); `plugins` declare records and contribute
Session commands and Surface overlay components; `edytor.svelte.ts` composes. Estimates are execution LOC with the
same counter. They include the contingency listed per current domain in §7.

### 4.1 `doc/` — Document context (4,488)

| Module | Responsibility (one line) | Rules | xloc |
|---|---|---|---|
| `doc/schema.ts` | One schema-name table, stamp gate reads, typed errors, `assertUsableDoc`, admission verdict + staged `admitUpdate` (only for bytes of unknown provenance: `loadDocument`/`attachDocument`) | R12 | 133 |
| `doc/rank.ts` | Logoot rank codec with client tie-break | — | 110 |
| `doc/placement.ts` | Placement candidates, atomic `{p,r}` writes, top-2 compaction, acyclic resolution, rehome; spec materialization, bulk insert, id-collision refusal; canonical `project` | R4, R5 | 507 |
| `doc/streams.ts` | Backing texts with boundary items; stream table; merge claims and `owner()`; `locate`/`position`; content ops (insert, validated right-to-left delete, format, inline atom by id); split = insert boundary + move following claims | R2, R5 | 705 |
| `doc/index.ts` | The one per-doc derived index, folded once per transaction: records, streams, owners, placements, children order, document order, `isLive`, maintained runs with structural sharing, dependency capture, commit-bound publication | R4, R5 | 665 |
| `doc/document.ts` | The facade: structural and metadata ops with void/island/defaultChild policy, all-or-nothing `setBlock`, duplicate, `toJSON`, write funnel (touched set, attribution, lineage capture at first touch), change report (one algorithm), undo-manager factory | R1, R4, R5 | 815 |
| `doc/anchors.ts` | Anchor codec (mint at *(block, offset, affinity)*, resolve to *(block, offset)* \| `pending` \| seam); seam of a dead block from its replicated slot `{p, r}` with editable descent | R3 | 67 |
| `doc/rangeDelete.ts` | Range deletion between two positions per `del.range.*`, with merges governed by `canMerge` | R4, R5 | 110 |
| `doc/flow.ts` | Place an admitted flow (inline runs + kinded blocks, fresh ids) at a position: split, insert, join the trailing run, replace an empty target, collapse a block selection to a target first | R5 | 70 |
| `doc/ingress.ts` | JSON boundary: clone + dev warning, wire sanitize (lone surrogates), spec converters, fresh ids; one normalization for writes and lookups | R1 | 190 |
| `doc/lifecycle.ts` | Document references and dedupe, semantics adoption (roles, `defaultChild`) with atomic conflict refusal, readiness state machine (open never writes; explicit create), `writable` guard over the meta root, provider registry keyed by transport target, owned/borrowed teardown | R4, R12 | 493 |
| `doc/attribution/*` | Per-block created/contributors/last-changed, incarnation stamp, lineage ring with convergent trim, actor dictionary (a product feature, kept) | R5 | 376 |
| `doc/handles.ts`, `structs.ts`, `engine-api.ts`, `rand.ts`, `public.ts` | Typed headless block handles; two vendor-store walks; structural engine typings; rank randomness seam; public barrel (documented API only) | — | 247 |

### 4.2 `sync/` — Transport context (1,840)

| Module | Responsibility | Rules | xloc |
|---|---|---|---|
| `sync/envelope.ts` | Generation word (engine, protocol, **schema**) per frame; container generation record; `frame(type, write)` helper | R12 | 35 |
| `sync/sync.ts` | Step1/Step2/Update codecs, remote origin, `applyRemote`, `svCovers` | R12 | 54 |
| `sync/awareness.ts` | Awareness protocol (verbatim; the engine has no presence) | — | 223 |
| `sync/auth.ts` | Permission-denied read | — | 15 |
| `sync/room.ts` | Shared provider lifecycle: `hasSynced` (lifetime) vs `connected`, failed-once, `whenSynced`, departure announcement, destroy guard; one join rule for channel and socket; frame dispatch | R1, R12 | 150 |
| `sync/container.ts` | IndexedDB container: store names, row codec, verify-or-stamp (one rule), non-creating open and existence probe, append-only rows | R1, R12 | 56 |
| `sync/indexeddb.ts` | Hydration (verify → getAll → one apply transaction), append, debounced compaction, commit-tracked `storeState` | R1 | 235 |
| `sync/websocket.ts` | y-websocket option parity: status events, backoff, liveness, auth, optional resync timer (loss healing, no longer needed for correctness) | — | 347 |
| `sync/index.ts` | `createIndexeddbSync`/`createWebsocketSync` factories exposing a transport-target key | — | 54 |
| `sync/presence.ts` | One entry per view key (anchors + collapsed/reversed); publish/clear by the owning view; freshest-per-client; resolve remote anchors (or paint nothing) | R1, R3 | 274 |
| `sync/attach.ts` | Attach providers to a document, deduped by transport target; readiness wait = one subscription | R12 | 20 |
| `sync/migration/*` | v13 layout reader; migration with `navigator.locks` attempt ownership; append import row + `active` record in one transaction; `force` as a replace-edit; rollback | R1, R12 | 349 |
| `collaboration/*.ts` (public shims) | Re-exports kept for the documented import paths | — | 28 |

### 4.3 `session/` — Session context, DOM-free (2,906)

| Module | Responsibility | Rules | xloc |
|---|---|---|---|
| `session/selection.ts` | `SelectionValue`; `select(value, cause)` with epoch and every side effect once; `project(value, version)` (positions, covered blocks/segments with sub-ranges, flags, island/void root, lazy marks and content); single-atom normalization; value builders behind the public write API (`setAtTextOffset`, `setAtRange`, `selectBlocks`, …); `selection.state` compat getter; `hold(range)` anchors | R3, R8 | 340 |
| `session/history.ts` | Record `{before, after}` per view on `stack-item-added/updated`; restore in the issuing view only through `select()` | R6, R8 | 63 |
| `session/commands.ts` | Dispatcher: permission (readonly, `document.writable`) → hooks returning `continue \| replace \| refuse` → one transaction → normalization once per touched parent (bounded passes) → undo policy (text insertion coalesces, everything else cuts) → result selection; command vocabulary types; virtual first block | R6 | 298 |
| `session/editing/text.ts` | Insert text with `marksForInsertion` (explicit → pending → common-of-replaced → neighbour → mark edge policy); grapheme/word/line units; soft break; mark/format commands over projected segments; public `splitText`/`setText` | R3, R6 | 341 |
| `session/editing/structure.ts` | Paragraph (split, insert-before at start, lift content above children), collapsed delete ladders per the delete contract, atom removal/replacement, nest/unnest, convert, suggestions accept/dismiss, range replacement | R4, R6 | 482 |
| `session/editing/clipboard.ts` | Copy/cut (clipboard written before the delete), paste/drop payload ladder, fragment extraction from the selection projection | R6 | 150 |
| `session/attempt.ts` | One inputType/key → intent table (incl. misreport overrides); attempt lifecycle (owner, anchored target, expectation, deadline, `failed` phase); keydown fallback; Android no-op-Backspace deadline tested against the anchored atom; readonly/composition permission | R3, R7 | 472 |
| `session/composition.ts` | Composition session: start (target + marks captured), `preview` (mechanical write, no hooks), `commit` (one command, idempotent across commit signals), `cancel` (one decision), phantom-key guard, idle/dangling policy | R3, R7 | 190 |
| `session/keymap.ts`, `session/bindings.ts` | Registry, canonical chord encoding, platform/AltGr/dead-key/layout rules, one precedence rule; built-in bindings as rows (undo/redo, Tab, select-all ladder, block-selection keys, Emacs table) | R6 | 300 |
| `session/navigation.ts` | One ordered stream of caret stops (grapheme, atom, block edge) + word stepping + block/document boundaries; one apply step; node-bound extension canonicalization; RTL; bindings as data | R8 | 230 |
| `session/moves.ts` | Relative move (up/down/in/out) → `(target, position)` → `doc.moveBlocks`; capability through `canPlace` | R4, R6 | 40 |

### 4.4 `surface/` — Surface context, the only DOM toucher (4,336)

| Module | Responsibility | Rules | xloc |
|---|---|---|---|
| `components/*.svelte` (`Edytor`, `Block`, `Content`, `Text`, `Mark`, `InlineBlock`) | Generic recursive render; `Block` renders the block element from the definition, snippets render inner markup; `Text` renders segments with fillers and the `data-placeholder` attribute; declarative root attributes | R10 | 304 |
| `surface/suggestions.ts` | Ghost-text view objects from plain JSON (declared shape; no Proxy) | R10 | 25 |
| `surface/cells.ts` | One reactive cell per visible block id, created/disposed/patched **only** from change reports; segment views; atom cells (edge-click caret); render deltas with equal-mark merging; the plugin-facing `Block`/`Text`/`InlineBlock` API (getters delegate to the doc index; mutators build commands) | R1 | 850 |
| `surface/pin.ts` | IME host pin: freeze the base render and splice the preview while the session's composition owns `host` | R7 | 55 |
| `surface/domPoint.ts` | One DOM-point interpreter (element boundaries, stray nodes, fillers; modes *settled* / *DOM ahead of model*), one model→DOM mapper, shadow roots, multi-range and composed ranges, UTF-16 boundary normalization | R3 | 542 |
| `surface/projector.ts` | `display()`: the only DOM-selection writer (current value, mounted target, focus predicate, dedupe, backward ranges, scroll only in a user frame); `displayed` + render epoch; the `selectionchange` classifier (echo / composition / drift / foreign / intent) | R9 | 647 |
| `surface/pointer.ts` | Hit testing, triple click, drag across atoms, click-into-block-selection collapse, `selectstart` guard | R9 | 200 |
| `surface/geometry.ts` | Visual lines for vertical navigation | — | 108 |
| `surface/observer.ts` | Render bracket (drain → patch → `flushSync` → discard own records → display); classification by location and the open attempt's owner; adoption by common prefix/suffix; revert by exact inversion or smallest-unit remount; WebKit converted spaces; wrapper-replacement adoption; bounded repair; native line-break detection | R7, R11 | 790 |
| `surface/events.ts` | DOM listener wiring (one keydown handler per occurrence), `admit(event)` (native controls, nested editables, outside targets, foreign undo scope), gesture serial, attribution frames, Shift-paste tracking, drop point, drag source, focus-in restore | R7, R9 | 536 |
| `surface/clipboard.ts` | Three clipboard flavours (private type, HTML embedding the fragment, plain); fragment shape validation at admission; HTML/plain export walk that asks kind/mark records | R1 | 139 |
| `surface/overlay/*` | Overlay layer outside the host: remote carets and the shared anchored-positioning helper (one measure per frame, editor-relative coordinates) | R10 | 140 |

### 4.5 `plugins/` — Extensions (2,054)

| Module | Responsibility | xloc |
|---|---|---|
| `plugins/types.ts`, `plugins/registry.ts` | Plugin contract (records, bindings, hooks returning values), one precedence rule, adoption input for the Document | 113 |
| `plugins/richtext/*` | Mark and block snippets (inner markup only), kind/mark records (label, icon, keywords, markdown prefix, HTML forms, empty shape), native format-input mapping, link-edge policy, sanitizers at render | 475 |
| `plugins/code/*` | Code kind record, Prism decoration (render-only), auto-pair on user-origin inserts only, merge guards as veto values, Tab/suggestion keys, normalization through document handles | 215 |
| `plugins/blockHandles/*` | Handles in the overlay, realigned once per frame; drop targets, placement bands, stickiness, indicator; keyboard moves emit the relative-move command; PDD adapter | 458 |
| `plugins/slashMenu/*`, `plugins/toolbar/*` | Controllers over held anchors and generated commands; components; shared overlay host | 497 |
| `plugins/html/*` | `DOMParser` → flow (one DOM walk with a mark stack, list handling, whitespace); tag tables derived from records, resolved once at registration | 190 |
| `plugins/markdownShortcuts.ts`, `mention`, `image`, `arrowMove`, `index` | Prefix matching over kind records → convert command; `@` → insert-atom command; void image; two bindings emitting relative moves | 106 |

### 4.6 Composition root (304)

`edytor.svelte.ts` (283): builds the five contexts, exposes the public `Edytor` handle (`document`, `selection`,
`commands`, `readonly`, `value`, `onChange`), `useEdytor`, teardown. `utils.ts`/`index.ts`/`constants.ts` (21).

**Total: 4,488 + 1,840 + 2,906 + 4,336 + 2,054 + 304 = 15,928 xloc**, down from 29,026 (−45.1 %).

---

## 5. Deletion ledger

Format: mechanism (location) · **xloc now → survives** · why it exists today · **replacing invariant** ("unnecessary
while …"). The xloc figures are the readers' range measurements (`xrange.mjs`, same rules as `xloc.mjs`); I
re-measured `canApplyDirect` 91, `applyUpdateStaged` 39, `restoreDeadSelectionEndpoints` 172, `applySelectionSnapshot`
289, `setAtRange` 165, history restore 270, and the observer's attribute tables 297 and caret restore 106, and they
match. Where a mechanism shrinks instead of vanishing, the survivor is counted in §4.

### 5.1 Document: ownership of text positions (R2)

| # | Mechanism | xloc | Why it exists | Unnecessary while… |
|---|---|---|---|---|
| L1 | Slice-record model: payload types/guards/stamps, `readSliceEntries`, record anchors with B/E sentinels, `sliceRange` (`text/model.ts:47-164, 876-889, 932-957`) | 87 → 0 | a stream boundary has no identity, so coverage is an anchored range record | …a stream is delimited by live boundary items; there is no range record to resolve |
| L2 | Per-atom ownership contest: interval index, lazy-expiry heap sweep, `gatherClaims`, `computeOwnership`, `maxG`, `claimRoutesToB` | 239 → 0 | overlapping records must be ranked by `(g, s0, stamp)` per atom | …every text position lies in exactly one stream, so there is nothing to contest |
| L3 | Insertion-time ownership repair: empty-display revive, left-edge record rewrite, right-edge rival claim (`:1365-1519`) | 82 → 0 | typing at a seam must re-assert ownership by writing records (68 B/keystroke measured, probe C7) | …typing at a stream edge inserts on the side of a boundary item chosen by the caret's affinity, and no record is written |
| L4 | Split planner `materializeSegs` + `splitSlices` (keep/move/cutRecord/cutClaim) | 105 → 35 | a split must partition every record covering the seam | …a split inserts one boundary item and moves the merge claims that follow it |
| L5 | Undo-resurrection repair: `undoRepairClaims` + `undo-repair.ts` (keep/redone detection, span walk, follow-up transaction, `changed` union) | 272 → 0 | ownership is keyed on character items, which undo re-creates as new items (engine fact) | …ownership is keyed only on boundary items and `redoItem` integrates each copy between the tombstone's left neighbour and the tombstone, i.e. inside the same stream (one update per undo; probes C2 and C13 fixed) |
| L6 | Run-view contest index: `recordsByText`, union-ever effects, per-text atom rows, `rangeCache` | 100 → 0 | the maintained view must re-run the contest incrementally | …R2 (no contest) |
| L7 | U8b extent narrowing (id-set walk → edited spans → fresh/stale row intersection) | 89 → 25 | siblings share one backing text, so an edit must be attributed to a block through the contest | …an edited item maps to its containing stream by the boundary index |
| L8 | Anchor owner facet (`a:-2` + `o`), `emissionOffset`, outward scan (`edytor-doc.ts:1984-2257`, historical part) | 146 → 0 (codec 22 kept) | "which block owns a caret at a seam" had no replicated fact | …a stream start is an item a caret binds with left `assoc`: block = containing stream, affinity = `assoc`, and the two facts no longer share one bit (contract rules 1, 2, 6; history independence holds by construction) |

### 5.2 Document: one derived index, observed effects, adopted semantics (R4, R5)

| # | Mechanism | xloc | Why it exists | Unnecessary while… |
|---|---|---|---|---|
| L9 | Duplicate derived-state owners: fresh-collect `view()` + `collectBlocks` (60), lease wrapper (32), `ownShim`/`ctx` (33), fake-op → delta-parser round trip + unreachable `deltaDeep` fallbacks (~75), facade `stateVersion` + view memo (35), second ancestor walk + second children builder (~35), DocChange fast/slow split + escalation (~110), claim-churn refinement (~30) | ~410 → 0 | derived facts had several owners with different lifetimes | …derived facts have one owner whose lifetime is the doc's, each replicated change is folded into it once, and every read and publication goes through it |
| L10 | `marksAlready` (36), clamp/same-value/`wrote` re-derivations (~20), per-op lineage capture and attribution stamping (~92) | ~148 → 30 | "did this op change anything" was predicted per op | …the transaction's effect set is the only source of "changed" and "touched" (R5) |
| L11 | Second schema table (35), facade pending-gate twin (~15), `_retain` (8), duplicated lineage-depth validation (8), `UndoManager.destroy` monkey-patch (10) | 76 → 0 | one fact, two holders | …one owner per fact (O15, O18, O19) |
| L12 | View-side re-derivations: `closestPrevious/NextBlock`, `insideIsland`, `#index` cache, phantom-returning `firstText/lastText` (~81), `canMoveBlockTo` (35), extension eligibility predicates `canConvertBlock`/`canApplyShortcut`/`canOpenInBlock`/toolbar/handle checks (~25) | ~141 → 0 | the view could not ask the document | …order, permission and targetability are answered by one document predicate each (R4). Probes P1, P2, `block-extend` fixed |
| L13 | `Block.value` second serializer (22) + `withMirrorInlineData` shim (18) | 40 → 0 | the mirror had its own serializer | …there is one serializer (`document.toJSON()`) |
| L14 | View-side content tombstoning in `removeBlock`; split type/data copy-then-reset | ~15 → 0 | a view-layer patch for a document invariant | …R2 hides a deleted block's stream with it (probes P3/P3b fixed on every path), and the split op decides the tail's type/data once |

### 5.3 Render cells (R1)

| # | Mechanism | xloc | Why it exists | Unnecessary while… |
|---|---|---|---|---|
| L15 | Mirror maintenance: mid-transaction `flushMirror` via full `project()` + whole-tree reconcile at 16 op sites, `_projectedTree` memo, preflight/full fallback, re-subscribe-on-attach, duplicate `reconcileChildren`, carrier second pass, dead `byItems` | 315 → 0 | one object was both the read-your-writes operation handle and the commit-consistent render cell | …operations read and write only the document, and a render cell changes only when a commit's change report is applied (probes P9/P9b: 1,000-block delete 10.6 s → the 7 ms document cost) |
| L16 | Detached/spec mode: three-mode constructors (59), pending adoption `_pendingBlocks/_pendingParts/_toSpec` (131), detached splice helpers (84), `InlineBlock._spec` (34), `groupContent` (37) | 345 → 0 | v13 "prelim" emulation | …specs are data: insertion takes JSON through `doc/ingress`, and the cell is found by id after commit |
| L17 | Segment identity and offset mapping: positional ids, aliases, deferred rename, `_pendingAliases`, identity work in `_kill/_setItems` (66); 7 offset mappers (96); contentRange text-only coordinates (39); `getTextById`/`getBlockByIdOrContent` (22) | 223 → 0 | positions were addressed by segment wrappers | …positions are *(block id, display offset)* followed by anchors and segments have no identity (R3, O60) |
| L18 | Mid-transaction `refreshFromProject` + eager `$state` copies (51); `_live/_bound/_blockId/_dropPrev/_dropNext` flags (27) | 78 → 0 | the handle had to look current mid-transaction | …cells are commit-consistent, a cell is live iff the last change report lists it, and seams come from replicated placement |

### 5.4 Selection (R3, R8, R9)

| # | Mechanism | xloc | Why it exists | Unnecessary while… |
|---|---|---|---|---|
| L19 | 30-field state + four state constructors + spread-patch writers (default state 60, private state build in `applySelectionSnapshot` 112, overlay re-mapping 26, spread-patch writers 44, builder duplicates ~15) | ~257 → 0 | derived fields were stored, so every writer rebuilt them | …the stored selection is `{kind, anchors \| ids}` and every other field is a projection of *(value, version)* |
| L20 | Staleness repairers: `restoreRelativePosition` (84 of 104), dead-endpoint application half (118), `writeCollapsed/RangeCaretState` + `resolveDeadCaretTarget` (60), capture/`reconcileSelectionAfterRemoteApply` (120) | 382 → 0 | the state stored wrappers and offsets that went stale | …the stored endpoint is the anchor and the position is recomputed per document version; wrappers can die silently because nothing stores them (probe X5 fixed) |
| L21 | Deferred-write machinery: staleness closures, mount polling and 10-attempt loops in `setAtTextOffset`/`setAtRange`/`setAtBlockRange` (382 → 45), `setAtTextsRange` (38), `pendingBlockRangeRequest`, `scheduleCaretWriteVerification` (45), `scheduleReassert`, `deadEndpointRecoveryPending`, synthetic write snapshots (22) | ~487 → 45 | each writer carried its own "am I still wanted, is the node mounted" logic | …only the projector writes the DOM selection, always from the current value, when the target is mounted; request order equals epoch order (probe C7 fixed) |
| L22 | Echo machinery: `ignoreNextSelectionChange` (17 setters in 7 files), `ignoreNextSelectedBlockSelectionChange`, `nativeSelectionMatchesCurrentBlockSeam` (35), `restoreDriftedEchoCaret` (81 → 15), Android post-delete snap-back (53 → 30 until proven subsumed) | ~190 → 45 | echo, drift and foreign writes were told apart by one-shot flags | …the classifier compares the observation with the last display and the render epoch (probe C4 fixed: a foreign programmatic selection is adopted, not reverted) |
| L23 | History duplicates: pop-handler loops and latches (~220), path/id helpers (60), `historySelectionSnapshot.ts` (111), `undoRestore` selection half (~39), `refreshDomAfterHistoryChange.ts` (89), snapshot queue overrides (~25) | ~544 → 63 | two restorers read two halves of one snapshot | …the dispatcher records this view's `{before, after}` values on the step and restore is `select()` in the issuing view (probes C1, P4 fixed) |
| L24 | Five seam rules: `_dropNext/_dropPrev`, history pop redo fallback, undoRestore redo fallback, `getClosestUnselectedBlock` + `blockToFocus`, `restoreSelectionAfterBlockRangeDeletion` (can target a phantom slot) | ~81 → 45 (moved to `doc/anchors`) | each cause had its own "where does the caret go" | …a vanished endpoint lands at its block's replicated slot, with the same answer for every cause |
| L25 | Caret-restore implementations outside selection: `getTextNode` polling (14), hotkeys structural restore + `focusFallbackBlock` (76), onInput 30 ms re-assert (~30), `stabilizeCompositionSelection` (57), keyboard-focus ownership checks (~30), mention timers (~25), markdown restore (19), toolbar re-assertions (~30), richtext state→DOM→state writes (~20) | ~301 → 0 | callers could not trust the write to land | …commands return a selection and the projector displays it after the flush (R6 + R9) |
| L26 | Presence: re-minting and double dedupe (~40), three encodings, legacy `textId/yStart` fields, `selection` mirror, owner registries + `sweepDestroyedViews`, numeric fallbacks, `findDomPoint` (~231) | ~271 → 0 | ownership of an entry was reconstructed; a caret had three wire forms | …a presence entry has one writer (the view that minted its key), carries anchors only, and uses the Surface mapper. No v14 peer has shipped, so no legacy consumer exists |
| L27 | Direction formula ×4 (wrong for ancestor focus nodes; ~63), unused `getTextsInSelection` TreeWalker result (76), never-written `hasSelectedAll`, debug probes including the unbounded `__EDYTOR_SEL_LOG__` push (~9), duplicated UA/path helpers | ~160 → 0 | duplicates and dead results | …direction is stored in the value; dead code has no reader |

### 5.5 Input, composition, DOM observation (R6, R7, R10, R11)

| # | Mechanism | xloc | Why it exists | Unnecessary while… |
|---|---|---|---|---|
| L28 | Intent vocabularies: inputType predicate families (41), two routers (114), `shouldRefreshDomAfterModelCommand` (~25), `NON_COMPOSITION_INSERT_TYPES` (19), hotkey bridge + synthetic `KeyboardEvent` (60), event fabrication at 7 sites (~90 more) | ~350 → 35 | keys and inputTypes were two routing tables, bridged by fabricating events | …an occurrence becomes an intent exactly once, through one table, and nothing downstream re-reads the DOM event (probe C2: Enter binding runs 3×, fixed) |
| L29 | `beforeInputSnapshot.ts` (109), `beforeInputRepairTarget.ts` (13) + 11 call sites, the DOM-selection round trip for declared ranges (~68) | ~190 → 0 | the target was carried through the DOM selection and a 25-field snapshot | …the attempt's target is an anchored model range fixed at admission (probe C3 fixed: `XXheo`) |
| L30 | Suppression flags and timers: 7 flags + 4 timers in `edytor.svelte.ts` (81), onInput repair targets and suppressed repair (94), onBeforeInput windows (40), blanket suppression inside `transact` (~25) | ~240 → 0 | who owned DOM mutations was a set of global booleans with timer lifetimes | …ownership of DOM mutations is a property of the open attempt (owner + expectation + deadline + `failed` phase; probe C7 fixed) |
| L31 | Second adopter (`input`-event path, 63); core knowledge of the mention trigger + manual plugin notification (47) | 110 → 0 | adoption bypassed the op layer | …the mutation queue is the only adopter and adoption runs through the dispatcher, so hooks see it like typing |
| L32 | `diffText` "advanced" path: similarity switch, Myers stub, word diff | ~199 → 35 | — (harmful: a 700-char middle change became delete-all/insert-all, destroying identities; probe C4) | …adoption diffs by common prefix/suffix only |
| L33 | Observer liveness inference (~297), attribute spec tables and healing (297 → 15), caret capture/restore after repair (106), third point→offset copy (37), `domTextOffset.ts` (43) | ~780 → 15 | the observer could not tell renderer records from foreign ones | …own renders never reach classification (R11), and every classified record is adopted or inverted by location and the attempt owner (probe C1 IME pause fixed) |
| L34 | Placeholder machinery: `removeStalePlaceholders.ts` (192), `Text.svelte` placeholder DOM, observers, timers and CSS (~118), repair-queue wiring (~25), history sweeps, placeholder branches in observer and selection (~20) | ~355 → 5 | the placeholder was a node inside the editable host whose visibility raced the DOM | …the placeholder is a model-derived attribute rendered by CSS (R10) |
| L35 | Composition representations: region numbers + anchors + DOM space, `_syncCompositionRegion`/`_reanchor…`/`_resolveCompositionOffset`/`deleteAt` region branch (~115 H of 175), `onCompositionEnd` (128), `getFinalCompositionMarks` (20), 9 reset sites and their flags (~40), observer's own cancel (25), `beforeInputCommands` composition (128) | ~678 total → 245 (session 190 + pin 55) | the session had three representations and several ends | …at most one composition exists, its region is two anchors, and it ends exactly once through `commit` or `cancel` (D5, D6) |
| L36 | Keydown listener pair | ~8 → 0 | — | …one handler per occurrence |

### 5.6 Commands (R6)

| # | Mechanism | xloc | Why it exists | Unnecessary while… |
|---|---|---|---|---|
| L37 | 7 `PreventionError` catch sites + the hotkey catch-all that swallows every error as "handled" | ~40 → 0 | a veto was an exception thrown through a transaction | …a veto is a value returned before the transaction opens, and nested sub-steps never consult hooks (probes X8, X9, `prevent-midway` fixed) |
| L38 | 21 `stopCapturing` decisions + ad-hoc snapshot queueing | ~40 → 0 | each caller decided undo boundaries | …the dispatcher applies one undo policy per command kind |
| L39 | Whole-editor remount switch (`refreshEditorDom`, `editorDomRevision`, `{#key}`) | ~25 → 0 | repaired drift the model could not explain | …nothing but change reports renders (R1), and the projector re-displays after any flush |
| L40 | `deleteContentWithinSelection` selection re-derivation and third branch | 206 → 110 (moved to `doc/rangeDelete`) | range delete re-decided walk and permission | …a range delete is one document operation between two positions governed by `canMerge` (probes P2, P5 fixed) |
| L41 | Range-delete ladders ×3 in `replaceSelection` and the delete commands | ~80 → 0 | the endpoints' flags were re-derived | …the three callers call `doc/rangeDelete` |
| L42 | Marks-for-insertion rule ×8 with 3 divergent policies | ~180 → 40 | Y1 forces a decision per insertion; each channel made its own | …one `marksForInsertion`, with pending marks on the selection value (probe `mark-inherit` fixed) |

### 5.7 Extensions and UI (R10, O31, O48)

| # | Mechanism | xloc | Why it exists | Unnecessary while… |
|---|---|---|---|---|
| L43 | Hand-written HTML tokenizer, tree builder, entity table (`html/parser.ts`) | 426 → 0 | the unit-test environment had no DOM | …HTML arrives only through browser events, where `DOMParser` exists (jsdom has it too) |
| L44 | `$fragment` pseudo-blocks, `mergeTrailingMarks`, duplicate mark application (`deserialize.ts`) | ~211 → 0 (110 kept) | the parser decided placement of leading/trailing runs | …placement of any flow is one rule in `doc/flow` |
| L45 | Per-paste mapping validation with synthetic validation nodes | ~137 → 0 | mappings were validated on every paste | …mappings resolve once at registration; an unregistered result degrades to paragraph/plain text |
| L46 | Three paste placements + double id stripping (`insertContentFragment`, `insertBlockFragment`, HTML placement, `jsonClipboard`, `insertClipboardFragment`) | ~208 → 70 (moved to `doc/flow`) | three owners of one placement (probe `paste-shape`: three structures) | …one placement function; ids are made fresh once at `doc/ingress` |
| L47 | Kind catalogues: `richTextCommands.ts` (115), markdown table + converters (~120), default HTML tables (102 → 35), core clipboard export switch naming 11 plugin types (~70), slash icon table, code-block shape ×2 | ~420 → 70 | knowledge about a kind lived in 5–6 places | …a kind is one record in its extension |
| L48 | Suggestion Proxies (`readonlyElements.svelte.ts`) | 125 → 25 | live-wrapper APIs were faked for ghost text | …snippet payloads are declared view objects (probe `suggestion-mention` fixed) |
| L49 | `use:block.attach` in ~20 snippets, handle ownership guard, heading re-key in core, root-attribute action (33), handles WeakSet/alias composition (~23) | ~100 → 0 | extensions rendered the block element | …the core renders the block element (O34) |
| L50 | Four positioning loops; handle mutation-record analysis (49) | ~116 → 35 | each chrome measured independently | …one overlay helper measures once per frame |
| L51 | Four move vocabularies: `arrowMove` path arithmetic (72 → 15), handle keyboard/outdent + `comparePath` copy (~24), `blockMove` re-derivation (50 → 40) | ~146 → 55 | "move down" had four meanings (probe `move-down`) | …one relative-move command |
| L52 | Toolbar numeric snapshot + 4× re-assertion (44); slash numeric range | ~50 → 0 | a second, numeric owner of the selection | …UI-held ranges are anchors (probe `stale-offsets` fixed) |
| L53 | Five document-order navigation walkers (444 → 120) and 26 binding closures (139 → 55) | ~400 over the survivors | each motion re-walked the document | …one ordered stream of caret stops with a direction; bindings are data |
| L54 | Hotkeys block-selection duplication (island walk ×2, root-index-only order, retry timers ~100), Emacs skeleton duplication (~44), atom deletion by whole-tree search (46 → 15), runtime `letter` Set (~50) | ~230 → 15 | local re-derivations | …O5, O30, O67 |

### 5.8 Transport (R1, R12)

| # | Mechanism | xloc | Why it exists | Unnecessary while… |
|---|---|---|---|---|
| L55 | Schema-as-data staging and gating: `canApplyDirect` (91), `applyUpdateStaged` (39), hydration fast + surgical staging (53), refusal latch + compaction block (~18), `gateSchema`/emit/dedupe (25), 8 outbound gates (~12), staged branch + post-apply recheck (~11), plumbing (~27) | ~276 → 20 | compatibility was a replicated LWW attribute, so every entry point simulated integration | …the frame and the container carry the (engine, wire, **schema**) generation, and the document switches itself read-only, once and visibly, if a same-generation writer still produces a foreign stamp (R12; probes P2, P7, C11 fixed) |
| L56 | Readiness plumbing: WebSocket two-round settle (~55), failed hand-back + 50 ms poll (~23), meta-only migration branch (8), view `setTimeout(0)` decision + `synced` shadow (28), facade `syncPending` twin (~15), document seed gating (~20) | ~150 → 0 | "synced" had to prove emptiness because opening could write | …no replica writes content it did not author; `synced` is informational (R12; probes P4, P4b/c, P6 fixed) |
| L57 | Migration arbitration: claim loop (43), polling `waitForSettled` + a BroadcastChannel nudge whose payload nobody decodes (62 → 3), lease/owner vocabulary (~20), owner-carrying record writes (~26 → 10) | ~151 → 13 | attempt ownership was stored as durable progress | …attempt ownership is a crash-released `navigator.locks` lock, and progress is an append plus an `active` record in one transaction |
| L58 | Storage duplications: codec, open and stamp copies; id policy ×2; key-0 overwrite | ~50 → 0 | two writers with two disciplines in one store (probes P3/P3b) | …one container module, append-only for every writer |
| L59 | Factory-identity dedupe | ~7 → 0 | the key was the factory object | …providers are keyed by transport target (probe P8 fixed) |

### 5.9 Not simplification — reported separately so the reduction is not overstated

| # | Kind | Items | xloc |
|---|---|---|---|
| L60 | **Dead code** (no reader) | `utils/jsx.ts` (70, no importers anywhere), `getBlockByIdOrContent` (15), dead placement helpers (27), `renderVersion`, `#depth`, `initialized`, `REMOTE_ONLY_TRANSACTION`, `remotePresenceRevision`/`refreshRemotePresence` (~20) | ~130 |
| L61 | **API retirement** (no production consumer; needs maintainer approval) | `decorateRuns` + decoration types (108), subscriber variants `subscribeBlock/subscribe/blockVersion/snapshot/debug` (~45), "advanced internals" barrel (~80), raw sync readers (41), `modifyAwarenessUpdate` (19), IDB `get/set/del` (19), duplicated hello, WebSocket-side BroadcastChannel fan-out and hand-copied options (~36), test seams (4) | ~352 |
| L62 | **Moved to `src/tests`** (oracles kept, not deleted from the repo) | `computeAllRuns`/`mergeRuns` (59), `blockRecordsOf` (23), today's `diffSnaps` kept as the change-report oracle | ~82 |

**Reconciliation.** The rows in §5.1–§5.8 add up to about 11.2k xloc of mechanism removed (5.1: 1,060; 5.2: 800; 5.3: 961; 5.4: 2,475; 5.5: 2,575; 5.6: 421; 5.7: 2,307; 5.8: 601). §5.9 adds about 0.56k.
Re-estimating the surviving mechanisms at the size their remaining responsibility needs (shorter bodies, fewer
imports and types; itemized in the readers' per-file floors) accounts for about 3.2k more. Genuinely new code costs
about 0.4k: dispatcher, projector and classifier, render bracket, boundary index and `locate`/`position`, virtual
block, lock-based migration, `writable` guard, join rule. That gives a floor reduction of about 14.6k. The
contingency in §7 adds back 1.46k, for a target reduction of about 13.1k. Rows can overlap at the edges, so read
each row's figure as ±15 %.

---

## 6. Distinctions kept explicit, and the bug each prevents

Each pair looks compressible. The right column says where the design keeps them apart and what merging them breaks.
**(merged today)** marks distinctions the current code collapses, with the probe that shows the bug.

| # | Keep apart | Represented as | Bug when merged |
|---|---|---|---|
| D1 | **Causal position** (anchor: bound item + `assoc`) vs **display position** *(block, offset)* vs **DOM position** *(node, offset, fillers)* | A6 stores anchors; `project()` yields display; `surface/domPoint` alone knows fillers | Display stored as truth: a caret cannot ride a remote insert (`sel.ride.insert`). Segment id stored as truth: `t:b:1` names another segment after an atom insert (probe P4: caret lands before the mention). DOM offsets leaking: ZWSP/newline fillers counted in model offsets |
| D2 | **Insert affinity** vs **stream membership** of a position | `assoc` vs the containing stream (R2) | Squeezed into one sign bit plus the `o` facet today **(merged today)**: the contract's `nにello` corruption, a split-start caret migrating into a neighbour, history dependence (probe C3) |
| D3 | **Result selection of a local command** vs **anchor-following** for changes this view did not author | command result → `select()`; held anchors only ride foreign changes | Letting anchor-following decide local results leaves the caret before each typed character (left affinity) |
| D4 | **Model destination** vs **DOM readiness** | value set synchronously; projector displays when mounted | Treating "no node yet" as "no destination" strands the caret after a remote whole-document delete (contract row "recovery topology × whole-document deletion") |
| D5 | **Phantom slot** (declared: `rendersContent: false`) vs **temporarily unmounted text** | kind record (O47) | Inferring phantomness from `node == null` **(merged today)** lets a caret park on a container's unrendered slot and the next keystroke is silently dropped (former UNRESOLVED-2); `beforeInputDeleteCommands.ts:37-39` still falls back to a phantom |
| D6 | **Echo** of our own display vs **render drift** vs **foreign programmatic write** vs **user move** | classifier inputs: `displayed`, render epoch, gesture serial | "No gesture since the last echo ⇒ drift" **(merged today)** reverts selections set by the host app, extensions or assistive tech (probe C4) |
| D7 | **Prepared intent** (command value, attempt target: immutable after admission) vs **execution attempt** (transaction; may be refused or fail) | A7/A8 immutable fields vs `phase` | The keydown fallback replays numbers captured before a remote edit **(merged today)**: deletes `he` instead of `ll` (probe C3, `XXllo`). Hooks running inside the transaction half-execute a vetoed command and duplicate text (probes X8, X9, `prevent-midway`) |
| D8 | **Announced intent** vs **executed effect** (browser-owned input) | attempt `owner=browser` + `expect` + `deadline`; success = the anchored atom disappeared | "Announced ⇒ done": Android's no-op Backspace never deletes. "Text changed ⇒ our delete happened": under a concurrent remote edit neither side deletes and the keystroke is lost (C5 in the input reader) |
| D9 | **Browser-owned change** (adopt) vs **drift around a model-owned command** (revert) | the open attempt's `owner` decides | Adopting drift duplicates merged text after a non-cancelable block merge; reverting a browser-owned insert loses the keystroke |
| D10 | **Renderer-produced record** vs **browser/foreign record** | render bracket (R11) | Liveness heuristics **(merged today)**: the editor's own `data-edytor-focused` writes arm the IME idle-cancel and delete a live preview after 850 ms (probe C1 in the input reader) |
| D11 | **Composition preview** (replaceable, but replicated) vs **committed text** (durable, one command) vs **cancellation** (reversal of a replicated effect) | composition `preview` / `commit` / `cancel` | Previews appended instead of replaced (`composition.spec:788`); the two abandonment exits disagree today **(merged today)**: the blur reset keeps the preview atoms in the shared doc, the idle cancel deletes them. This design has one `cancel` that deletes them, with no undo entry |
| D12 | **User intent** vs **mechanical replay** (composition previews) | previews are direct document writes without hooks; `commit` is a user-origin command | Auto-pair rewrites the IME buffer (`x()` while the IME holds `x(`); the slash menu opens then closes mid-composition and never opens after commit (probe `ime-plugins`) |
| D13 | **Replicated effect** vs **disposable view state** | pending marks on the selection value; previews in the document | Pending marks replicated or put in undo break "next insertion only"; treating previews as disposable makes commit forget absorbed remote text |
| D14 | **Refused** vs **no-op** vs **applied** | op result `status` (R5) | Booleans conflate them **(merged today)**: `setBlock` returns `true` after dropping a child as an id collision (probe C4 crdt); attribution stamps no-ops; `moveBlocks([])` and `insertBlocks([])` disagree |
| D15 | **Definition** vs **occurrence** (kind vs block; id definition vs a new occurrence in a replacement spec) | kind records; `setBlock` replacement mints or explicitly revives | Core hard-codes `heading`/`level`; the code block renders two elements claiming one identity (probe `code-attach`); re-using a child id in `setBlock` silently deletes it |
| D16 | **Capability** vs **permission** (structure allows vs readonly/veto/writability forbids; `contenteditable` capability vs editor routing) | `canPlace` (document) vs dispatcher permission; `admit()` for routing | DnD shows moves that then fail, or hides legal ones; caption typing inside a void is captured into the document selection; readonly editors lose selection |
| D17 | **Transport success** vs **operation success** (bytes integrated / provider synced vs content decided) | R12: nothing decides content from `synced` | IndexedDB "hydrated locally" treated as "document is new" **(merged today)**: the default value is seeded next to room content, or the room's first paragraph is erased through the reserved bootstrap id (probes P4, P4b/c) |
| D18 | **Connection currently synced** vs **has ever synced** | `connected` vs `hasSynced` | A synced provider that loses its socket and is destroyed reports "failed before it synced" **(merged today)** (probe P1) |
| D19 | **Attempt ownership** (lock, dies with the tab) vs **durable progress** (row + `active` record, one transaction) | `navigator.locks` vs migration record | Leases, expiry, polling and reclaim races **(merged today)** |
| D20 | **Import** (fresh identity, appended) vs **replace** (a CRDT edit) | `force` = hydrate → replace transaction → append its diff | Re-migration overwrites key 0: edits vanish or survive by per-block coin flip **(merged today)** (probes P3, P3b) |
| D21 | **Document semantics** (roles, `defaultChild`; shared, document lifetime) vs **view configuration** (snippets, placeholder, bindings) | adopted semantics (A3) vs definitions per view | One view's override would reshape structure for other views and peers; the default-type rule split across both sides today gives `paragraph` inside an `ordered-list` (probes P10, P12) |
| D22 | **Freshness token** (index version, advances inside a transaction) vs **publication revision** (once per commit, reactive) | `doc/index` version vs one Surface counter | Reactive consumers observe uncommitted state, or never re-run |
| D23 | **Issuing view** vs **sibling view** vs **remote** (history) | `{before, after}` keyed by view; restore only when this view issued the pop | A sibling's caret is yanked to a snapshot recorded long ago |
| D24 | **Completed external effect** vs **document mutation** (cut) | clipboard written first, then the delete command | A vetoed or failed delete after a clipboard write loses nothing; the reverse order loses the user's data |
| D25 | **Atomic selection kinds** (block set, one atom) vs **text range** | tagged value (A6) | Backspace on a selected empty block runs a caret merge; typing beside an atom replaces it |
| D26 | **Foreign focus** (user chose a control) vs **orphaned focus** (`body` after our own remount) | one focus predicate | Stealing focus from a control, or never displaying the caret after our own remount; three verdicts today **(merged today)** |
| D27 | **Not yet integrated** vs **deleted** (unresolvable anchor) | `resolve()` returns `pending` vs seam | A remote caret drawn at a seam before its item arrives; a local caret jumping to a seam on a transient |
| D28 | **Decoration** vs **stored mark** | render-only segment transform | `codeToken` persisted into replicated marks (the historical leak `text.utils.ts:89-95` documents) |

---

## 7. LOC table

"Target" is what remains of a current domain's responsibilities, wherever it lands in §4. Code that moves is counted
**once, at its source domain**, so moving it neither adds nor deletes. "Floor" is the reader-derived line-level
estimate re-assigned to my owners. The contingency is my own allowance for the risk named in the last column.

| Current domain | Now | Floor | Contingency | **Target** | Δ | Δ % | Where the survivors land | Contingency reason |
|---|---:|---:|---:|---:|---:|---:|---|---|
| `crdt` core (facade, text, placement, runs, document, attribution, adapters) | 6,237 | 3,673 | +400 | **4,073** | −2,164 | −34.7 % | `doc/*` | R2 is a representation change; edge cases (incarnation nonce, boundary-deletion invariant, index fold) |
| `crdt` transport (providers, protocols, migration) | 2,125 | 1,440 | +78 | **1,518** | −607 | −28.6 % | `sync/*` | websocket join/liveness semantics, lock-based migration |
| `events` | 4,519 | 1,659 | +300 | **1,959** | −2,560 | −56.6 % | `surface/observer` 755, `surface/events` 386, `session/attempt` 402, `session/editing` 376, `session/composition` 40 | R11 is unproven in browsers; foreign-damage healing may keep named cases |
| `selection` | 3,871 | 1,794 | +200 | **1,994** | −1,877 | −48.5 % | `surface/projector` 604, `surface/domPoint` 542, `session/selection` 340, `surface/pointer` 200, `surface/geometry` 108, `session/editing` 102, `session/history` 53, `doc/anchors` 45 | engine-specific echoes may need named classifier rules |
| `plugins` | 3,780 | 1,843 | +150 | **1,993** | −1,787 | −47.3 % | `plugins/*` 1,958, `surface/overlay` helper 35 | HTML whitespace over DOM nodes, overlay handles in nested scroll containers |
| root files (`edytor.svelte.ts`, `hotkeys.ts`, `edytor.utils.ts`, `plugins.ts`, misc) | 2,497 | 1,265 | +80 | **1,345** | −1,152 | −46.1 % | `session/keymap+bindings` 300, `edytor.svelte.ts` 283, `session/composition` 150, `surface/events` 150, `doc/rangeDelete` 110, `surface/cells` 85, `plugins/types+registry` 113, `session/attempt` 70, `surface/projector` 43, `session/commands` 20, misc 21 | composition timing |
| `block` | 1,716 | 911 | +100 | **1,011** | −705 | −41.1 % | `surface/cells` 498, `session/commands` 278, `session/editing` 195, `session/moves` 40 | plugin-facing `Block` API compatibility; includes +100 of **new** dispatcher code |
| `text` | 1,191 | 510 | +40 | **550** | −641 | −53.8 % | `surface/cells` 267, `session/editing/text` 230, `surface/pin` 55 | segment-view compatibility |
| `collaboration` | 666 | 387 | +20 | **407** | −259 | −38.9 % | `sync/presence` 274, `surface/overlay` 85, `sync/attach` 20, shims 28 | overlay coordinates |
| `components` | 614 | 299 | +30 | **329** | −285 | −46.4 % | `components/*.svelte` 304, `surface/suggestions` 25 | block element ownership moving to the core |
| `hotkeys/` (navigation) | 589 | 200 | +30 | **230** | −359 | −61.0 % | `session/navigation` | caret-stop stream edge cases (RTL, atoms at block edges) |
| `clipboard` | 518 | 254 | +25 | **279** | −239 | −46.1 % | `surface/clipboard` 139, `session/editing/clipboard` 70, `doc/flow` 70 | replace-empty-target and block-selection collapse rules |
| `utils` | 500 | 225 | 0 | **225** | −275 | −55.0 % | `doc/ingress` 190, `surface/observer` 35 | — |
| `history` | 200 | 10 | 0 | **10** | −190 | −95.0 % | `session/history` | — |
| `dnd` | 3 | 3 | 0 | **3** | 0 | 0 % | `plugins/blockHandles` | — |
| **Total** | **29,026** | **14,473** | **+1,453** | **15,926** | **−13,100** | **−45.1 %** | | |

Against the task's stated baseline (28,941), the target is −45.0 %. The per-module sum in §4 is 15,928; the
difference is rounding in the transport rows.

### 7.1 Sensitivity (what each decision is worth)

| Scenario | Target xloc | Δ vs 29,026 |
|---|---:|---:|
| Floor, no contingency | 14,473 | −50.1 % |
| **Proposed target** | **15,926** | **−45.1 %** |
| Target, but the maintainer keeps every retired API surface in L61 | 16,278 | −43.9 % |
| Target, R2 rejected by its checkpoint (keep slice records, but with one decider; the crdt reader's no-A figure of 5,100 plus 200 contingency) | 17,153 | −40.9 % |
| R2 **and** R11 rejected (observer keeps classifying by liveness, ≈ +800) | ≈ 17,950 | −38.2 % |

The 40 % line holds without R2. It does not hold if both R2 and R11 fail their checkpoints. Everything else in the
plan is an ownership consolidation that needs no new representation.

### 7.2 Honest notes

- **Moved, not deleted.** These are counted at their source domain in the table above, not as deletions: the range
  delete moves into `doc/rangeDelete` (110); paste placement into `doc/flow` (70); the seam rule into `doc/anchors`
  (45); composition from four files into `session/composition` + `surface/pin` (245); the six DOM-point interpreters
  into `surface/domPoint` (542); change-report patching into `surface/cells` (85); the chrome positioning helper into
  `surface/overlay` (35).
- **New code, counted in the targets** (~0.4k): the dispatcher (+100 over today's `runOperation`), the projector and
  classifier (~90), the render bracket (~30), the boundary index and `locate`/`position` (~90), the virtual first
  block (20), lock-based migration (12), the `writable` guard (8), the state-vector join rule (6), the fold cursor
  (~40).
- **Not simplification** (§5.9), reported so the reduction is not overstated: ~130 xloc of dead code, ~352 xloc of
  API retirement that needs the maintainer's approval, ~82 xloc of oracles moved into `src/tests`. Moving an oracle
  into tests lowers `src/lib` xloc but does not simplify anything.
- **Type bodies.** The counter treats multi-line `export type X = {…}` bodies as execution lines (~250 in the runtime
  domain, ~333 in crdt). They appear in both columns, and most survive in any design.
- **Bundle size was not measured.** The vendored engine (7,125 xloc, out of scope) dominates the shipped bytes. The
  runtime gains are more concrete than the byte gains:
  - one wire update per undo instead of two or three (probes C2, C13);
  - ~15 B instead of ~68 B per keystroke at a split seam (probe C7);
  - linear instead of quadratic cost for large transactions (probe C10);
  - document-cost range deletes: 7 ms instead of 10.6 s at 1,000 blocks (probes P9/P9b);
  - no whole-editor remount on Tab (probe `tab-remount`).
  R11 adds a synchronous `flushSync` per command and per remote apply. Measure it with `bench/` before claiming a
  speed gain.
- **Tests to rewrite** (real work that the metric does not show):
  - suites that pin today's mechanism rather than a user guarantee: `mirror-incremental`, `scoped-text-refresh`,
    `normalization-depth`, the placeholder repair-queue unit tests, the 19 tokenizer fixtures, ~12 mapping-validation
    fixtures and the C8 trailing-content fixtures;
  - suites that pin the retired gates: `schema-boundary` (613 lines), `wu3b-staging` (290), most of
    `r2-idb-compaction`, and the lease/claim parts of the migration suites;
  - suites that assert the ownership internals: the `anchors.test.ts` `o`-facet rows and `ownership-intervals`.
  The user-visible assertions of every browser spec stay unchanged.

---

## 8. Falsification tests

Rules for this suite:
- Expected results come from contracts: the delete contract (`del.*`, `sel.*`, `conc.*`, anchor rules 1–6),
  G/R/S guarantees in the reader reports, `crdt-v14-document.md` and the migration runbook. They never come from
  either engine's output.
- Each test is written **before** its checkpoint (§9). It must fail on the reference where the "Today" column says
  so, and the checkpoint cannot close until it passes.
- Lanes: **doc** = headless vitest over the document; **dom** = the repo's jsdom harness (`pnpm test:dom`, command
  programs); **browser** = Playwright on chromium/firefox/webkit + DST. jsdom cannot falsify echo, IME or layout
  claims, so those rows name a browser lane.
- "Today" cites the reader probe that reproduced the failure. "passes" = a regression guard. "predicted" = derived
  from code, not executed.

### 8.1 Document (nesting, same definition in different positions, empty, failure midway, concurrency)

| ID | Axis | Scenario | Expected (source) | Lane | Today | Gate |
|---|---|---|---|---|---|---|
| F-D1 | nesting in nesting | `root > [box(island) > [A "aa"], Y "yy"]`, and the same shape one level deeper inside a block `X`; select A@1 → Y@1; delete | `[box > [A "a"], Y "y"]` (resp. `[X > [box > [A "a"]], Y "y"]`): the merge `del.range.flat` would do is refused by the island seal (G6), so the delete takes the no-merge shape; `mergeForward(A)` gives the same answer | doc | fails (P2: `A "ay"`, Y deleted) | CP2 |
| F-D2 | nesting, targetability | `p > [c]`; delete `p`; then `insertText(c)`, `insertBlock(parent: c)`, `moveBlock(c → root)`, `splitBlock(c)` | all four `refused`, zero update bytes (C-R5 deletion wins; one `isLive`) | doc | fails (C6: `true, true, true, false`) | CP1 |
| F-D3 | same definition, different position | `ordered-list > [li "one"]`: Enter at end, middle, start; and merge an island child out into the list | end `[li "one", li ""]`, middle `[li "o", li "ne"]`, start `[li "", li "one"]`; the merged-out child is `li` (G5: parent-appropriate default type) | doc + dom | fails (P12: `paragraph` inside the list at end/start; P10) | CP1 |
| F-D4 | empty collection | `moveBlocks([], dest)`; `insertBlocks(dest, [])`; `insertText('')`; empty delete; empty format | all `noop` with the same result shape; no attribution stamp, no undo step, no state-vector advance (R5, D14) | doc | fails (C8: `false` vs `true`) | CP1 |
| F-D5 | failure midway, retry | `b > [c1]`; `setBlock(b, {children: [{id: 'c1'}, {id: 'c2'}]})`; then retry with fresh ids | first call `refused` (`id-collision`) with zero bytes written and `c1` intact; retry `applied` (C-R13 all-or-nothing, D15) | doc | fails (C4 crdt: returns `true`, `c1` gone, retry impossible) | CP1 |
| F-D6 | generated value after a boundary | `insertBlock({id: 'x\uD800'})`, then `insertText` by the same string and by the returned id | both resolve to the same block (one normalization for writes and lookups, O1) | doc | fails (C11 crdt) | CP1 |
| F-D7 | concurrent, headless path | `abcde` split at 3; B types `Q` at the tail's head ‖ A deletes the tail, through the view, `facade.deleteBlock` and `document.block(id).delete()` | every path, both replicas: `abc` (`conc.delete-wins-block`, G8) | doc | fails (P3/P3b: `abcQ`) | CP9 (if R2 is rejected, the same test gates the fallback fix in document ownership resolution) |
| F-D8 | R2 property | random split/merge/delete/insert/format/undo programs over 3 replicas, random delivery | (a) no content delete tombstones a boundary item (A-1); (b) of two boundary items naming one id, only the incarnation-matching one delimits (A-2); (c) every live character renders exactly once; (d) convergence | doc | n/a | CP9 spike |
| F-D9 | concurrent seam insert | B inserts `\|` at 6 of `hello world` ‖ A splits at 6 | converges on every replica; which side the insert lands on is decided by YATA's client order (TX06a is re-pinned; nothing changes for users) | doc | pinned head-side today | CP9 spike |
| F-D10 | undo × concurrent typing | A undoes its split ‖ B types in the tail | B's text joins the head (HI01a) | doc | passes | CP9 regression |
| F-D11 | concurrent splits, reading order | `hello world`: split at 3 ‖ split at 8 | reading order `hel │ lo wo │ rld` for every client-id pair | doc | fails (C1: wrong order in 16/40 pairs) | **tracking only** (O71 is open) |

### 8.2 Undo after collaboration

| ID | Scenario | Expected (source) | Lane | Today | Gate |
|---|---|---|---|---|---|
| F-U1 | `Hello world`, caret @5, type `abc` (caret @8); peer inserts `XYZ` at 0 (caret rides to @11); undo through the hotkey, `beforeinput historyUndo` and `edytor.historyUndo()` | caret @8 of `XYZHello world` on all three channels (H1 + `sel.ride.insert`) | dom | fails (C1: @5 on two channels) | CP5 |
| F-U2 | type `!` at the end of `hello world`; peer inserts a mention at 3; undo | caret at the end of the paragraph, after `world` (display offset 12) | dom | fails (P4: before the mention) | CP5 |
| F-U3 | split `hello world` at 6; delete the tail's `world`; undo; deliver to a receiver frame by frame, with lineage on and off | exactly one wire update per undo; the receiver never shows `hello world` in the head (R16, one frame) | doc | fails (C2: 2 updates, torn frame; C13: 3 updates with lineage) | CP9 |
| F-U4 | A deletes `t = 'world'`; B, after receiving that delete, splits the empty `t` at 0 (new block `u`); A undoes | `world` returns to `t` on both replicas (R16). This relies on `minimizeFormatChanges` placing `u`'s boundary after the tombstone run, so the undo copies land before it | doc | passes today (through the repair) | CP9 **spike gate for R2** |
| F-U5 | A deletes `bb`; B edits `cc`; A undoes | `bb` restored, `cc` keeps B's edit (`conc.undo.actor-local`) | doc | passes | CP0 regression |
| F-U6 | select the first child of a list, delete, undo, redo, on each channel | redo lands on the command's recorded `after` (the adjacent editable content); same answer on every channel (H3) | dom | predicted to disagree (C11) | CP5 |
| F-U7 | views V1 and V2 on one document; V1 types, then undoes | V1 restores its `before`; V2's caret rides the change and is not moved to a snapshot (H1, D23) | dom | passes | CP5 regression |
| F-U8 | typing, then a browser-owned deletion within `captureTimeout` (one merged step); undo | one restored position: the `before` of the step's first command (D7) | dom | predicted (C10: two carets) | CP6 |

### 8.3 Selection and display

| ID | Scenario | Expected (source) | Lane | Today | Gate |
|---|---|---|---|---|---|
| F-S1 | from caret @1: `setAtTextOffset(t, 4)` then `setAtRange(t, 2, 6)` with no await in between; then the reverse order | the later request wins in both orders (W1: latest intent) | dom | fails (C7: caret @4) | CP5 |
| F-S2 | caret in `Second`@3, focus on an outside button; peer deletes `Second` (last block) | model at `First`@5 (`sel.seam.next-sibling`, last-block branch); exactly one `onSelectionChange`; presence republished; focused set updated; outside focus kept | dom | fails (C2 sel) | CP5 |
| F-S3 | `selectBlocks(b)` after a caret | one `onSelectionChange`; presence publishes the block set | dom | fails (C3 sel) | CP5 |
| F-S4 | editor focused; host code calls `setBaseAndExtent(text@1 → end)` with no gesture and no render | the model adopts the range (D6: a foreign write is not drift) | dom | fails (C4: reverted) | CP5 |
| F-S5 | paragraph `ab` + bold `cd` + `ef`; DOM point `(textElement, i)` | offsets 2 after `ab` and 4 after the bold span | dom | fails (C5: 6) | CP5 |
| F-S6 | forward native range, anchor `text@1`, focus `(textElement, childCount)` | forward range 1 → end; content equals the model slice | dom + firefox | fails (C6: reversed, empty) | CP5 |
| F-S7 | block-select `bb` in `[aa, bb, cc]`; peer deletes `bb`; press Delete | the selection becomes a caret at `cc@0` (`sel.seam.next-sibling`); Delete acts on live content | dom | fails (C8: dead block set) | CP5 |
| F-S8 | caret at the end of `hello world` in a blurred editor; peer inserts an atom at 3 | model caret at display offset 12 immediately, with no refocus needed (`sel.ride.insert`) | dom | fails (X5) | CP5 |
| F-S9 | (a) our own render detaches the focused node (`body` focused); (b) the user focuses an outside `<input>` | (a) the caret is displayed; (b) model-only update, focus preserved (D3, D26) | dom | inconsistent (F16: 3 verdicts) | CP5 |
| F-S10 | Gecko re-anchor after a mark toggle under the caret; Gecko/Blink clamp after a re-split; Android +1 echo after a model-owned merge; IME post-commit selection jump | DOM caret equals the model caret after settle, with no timers (R9) | **browser** (3 engines + DST) | passes today with timers | CP5 **gate for deleting timers** |

### 8.4 Input and IME

| ID | Scenario | Expected (source) | Lane | Today | Gate |
|---|---|---|---|---|---|
| F-I1 | `he[ll]o`; Backspace keydown with no `beforeinput`; a peer inserts `XX` at 0 before the fallback deadline | `XXheo` (A3: the key's intent against its anchored keydown target) | dom | fails (C3 input: `XXllo`) | CP6 |
| F-I2 | Android: non-cancelable `deleteContentBackward` that the browser does not perform, plus a peer edit to the same text inside the deadline | exactly one grapheme deleted: the one before the anchored caret (A1, D8) | dom | predicted lost (C5 input) | CP6 |
| F-I3 | a non-preventing `mod+alt+k` binding; a non-preventing `enter` binding | each runs once per keydown | dom | fails (C2 input: 2× and 3×) | CP4 |
| F-I4 | an extension hook throws during a non-cancelable insert | attempt `failed`; after settle the DOM equals the model (re-rendered, never adopted twice); the next keystroke works; the error surfaces (A1 "one effect or a named outcome") | dom | predicted (C7 input: input lost silently) | CP6 |
| F-I5 | Shift+Enter in a code line, desktop (cancelable) and Android (non-cancelable `insertLineBreak`) | same result through the same intent and the same extension hook: line split, caret at the new line's start | dom + mobile spec | passes by coincidence (C8 input) | CP6 |
| F-I6 | `Hello\|`, compositionstart, preview `に`, then 850 ms with no events while a peer edits another paragraph and the editor writes focus attributes | composition still live, preview intact, host node not remounted; commit gives `Helloに` (B4, R11) | dom + **browser** | fails (C1 input: preview deleted) | CP7 |
| F-I7 | `alpha\|Hello` split, then compose `n` → `に` at the fresh block start | `にHello`; `alpha` untouched (contract: block-start ownership × composition) | dom + browser | passes | CP6/CP9 regression |
| F-I8 | a peer inserts before the composition region; a peer's text is absorbed inside the region | the commit lands at the shifted region; absorbed text is replaced at commit (`composition-remote-lock`, 7 tests) | browser | passes | CP6 regression |
| F-I9 | in a code line compose `(` → `(a` → commit; compose `/` → `/h` → commit | the model equals the IME buffer at every step; final `x(a`; the slash menu opens once, after commit, with query `h` (D12) | dom + browser | fails (`ime-plugins`) | CP6 |
| F-I10 | a peer deletes the block holding a live composition | no DOM write into the composing node before `compositionend`; the commit is written through the region anchors, hidden with the deleted block (`conc.delete-wins-block`); caret at the seam | dom | predicted (C9 sel: repair writes into the composed node) | CP6 (the expected result needs maintainer confirmation, §11) |
| F-I11 | WebKit phantom Enter/Backspace right after `compositionend` | the first one is swallowed, later ones are not | browser | passes | CP6 regression |
| F-I12 | a foreign script rewrites the middle 700 characters of an 1,100-character paragraph | adoption = retain 200 / delete 700 / insert 700; a remote caret and a concurrent remote insert in the untouched prefix survive; prefix/suffix marks unchanged (A22) | dom | fails (C4 input: delete-all/insert-all) | CP6 |

### 8.5 Extensions and UI

| ID | Scenario | Expected (source) | Lane | Today | Gate |
|---|---|---|---|---|---|
| F-P1 | `A{A1, A2, A3}, B`; select A3; Shift+Up twice | `{A1, A2, A3}`; Shift+Down then shrinks in document order (K7) | dom | fails (`block-extend`: stalls) | CP1 |
| F-P2 | select `world` in `Hello world`, focus the link field; peer inserts `ZZZ` at 0; apply | link on `world` (G1 in the UI reader) | dom | fails (`stale-offsets`: `lo wo`) | CP5 |
| F-P3 | `ab/quo` with the slash menu open; peer inserts at 0 | menu stays open with query `quo`; Enter runs the command on `/quo` | dom | closes by accident | CP5 |
| F-P4 | caret inside red italic text; Mod+B; type | `{color: red, italic, bold}` (G2: one answer for the next marks) | dom | fails (`mark-inherit`: red dropped) | CP4 |
| F-P5 | fragment X, Y pasted at `Hello\|World` through the internal clipboard and through HTML | both give `["HelloX", "YWorld"]` (one placement rule, D17; plain text is a recorded decision, §11) | dom | fails (`paste-shape`: 3 structures) | CP2 |
| F-P6 | `A, B{B1}, C`; move A down through the arrow-move binding and through the handle's Alt+Down | identical: `B{B1}, A, C` (the public relative-move semantics in AGENTS.md) | dom | fails (`move-down`) | CP4 |
| F-P7 | render a code block | exactly one element carries `data-edytor-id` for it; its handle mounts once | dom | fails (`code-attach`: 2 elements) | CP7 |
| F-P8 | `suggestText` containing a mention atom | renders unselected and non-editable | dom | fails (`suggestion-mention`) | CP7 |
| F-P9 | one Tab on `A, B\|b` | zero root remounts; only B's subtree is recreated; caret kept (K5) | dom | fails (`tab-remount`: 3 remounts) | CP3 |
| F-P10 | paste HTML containing only a comment, `<script>` or an empty `<span>` into an empty `h2` | no change, no undo step, heading kept (empty flow = named no-op) | dom | fails (`empty-html`) | CP2 |
| F-P11 | slash query `/xyz` with zero matches; Enter | Enter is not swallowed | dom | fails (code) | CP4 |
| F-P12 | two blocks selected; the arrow-move binding claims Mod+Down | the built-in Mod+Down does not also run (K1) | dom | fails (code) | CP4 |
| F-P13 | a key handler throws `TypeError` | the error surfaces; no half-executed command (the transaction either never opened or committed atomically) | dom | fails (code: reported as handled) | CP4 |
| F-P14 | two extensions define `heading` | the first one wins (README) | dom | fails (code: last wins) | CP4 |

### 8.6 Transport

| ID | Scenario | Expected (source) | Lane | Today | Gate |
|---|---|---|---|---|---|
| F-T1 | two websocket clients sync; B's socket drops; `B.destroy()` | no `failed` event (G11; D18) | doc | fails (P1) | CP8 |
| F-T2 | (a) a peer of another schema generation writes; (b) a same-generation writer produces a foreign stamp, then the user types three edits | (a) frames dropped at the envelope with an observable event, zero bytes integrated; (b) the document turns read-only once, visibly, and no edit is accepted by the editor and then dropped by the transport (G13, G15, D17) | doc | fails (P2: content integrates; P7: silent loss after reload) | CP8 |
| F-T3 | migrate → edit → `migrate(name, {force: true})` → reload, in 6 trials and 2 tabs | the document equals the legacy materialization on every trial and tab, with no pending structs (runbook: `force` is a fresh import that replaces) | doc | fails (P3b: edit gone and pending forever; P3: per-block coin flip) | CP8 |
| F-T4 | new device, empty IndexedDB, room already holds content; the view passes `value`; every client-id order | open writes nothing; after sync the local document equals the room; the room's first paragraph is never erased (G9) | doc | fails (P4 duplicate seed; P4b/P4c erasure in 7/8 trials) | CP8 |
| F-T5 | opaque relay, default options; B edits offline and reconnects while A stays | A receives B's offline edits without `resyncInterval` (G2) | doc | fails (P5) | CP8 |
| F-T6 | first client of a new room, default options; later a second client joins | the first client can edit at once (virtual block); both converge; the first client receives later edits | doc + browser | fails (P6/P6b: never renders) | CP8 |
| F-T7 | two views, each with an inline `createIndexeddbSync('notes')`, on one document | one provider; rows grow as with one view (G12) | doc | fails (P8: 2 providers, doubled rows) | CP8 |
| F-T8 | a remote caret is idle; the local page scrolls | the remote caret stays on its anchor (G24) | browser | fails (C12) | CP8 |
| F-T9 | a websocket-only peer closes its tab | peers drop its caret the same way as for the IndexedDB/BroadcastChannel provider (announce on unload; timeout as backstop) | browser | differs (C13) | CP8 |
| F-T10 | a view is destroyed along a path that skips selection teardown | its presence entry is removed by its own teardown (O56); no sibling activity is needed | dom | predicted (C14) | CP8 |

### 8.7 Ownership rules (instrumented)

| ID | Rule | Scenario | Expected | Lane | Gate |
|---|---|---|---|---|---|
| F-O1 | R1, R9 | run every command in the command-program corpus to settle | every DOM-selection write came from the projector; zero editor-owned timers remain scheduled (except a live composition's idle policy) | dom | CP5 (timers), CP7 (writers) |
| F-O2 | R11 | selection-driven attribute writes and remote renders during a composition | no record produced by the editor reaches the classifier | dom | CP7 |
| F-O3 | R6 | range delete, paste, split, convert, move with a counting extension | hooks run exactly once per command, before its transaction; nested sub-steps never call hooks | dom | CP4 |
| F-O4 | R5 | every op over a randomized corpus | the result is always one of `refused \| noop \| applied`; `applied` ⇒ the fold's touched set is non-empty; `noop` ⇒ the state vector did not advance | doc | CP1 |
| F-O5 | R1 + R5 | range delete and selected-block delete over 1,000 paragraphs | document work < 50 ms; exactly one change report; cell patches proportional to the touched blocks (G25) | dom | CP3 |

### 8.8 Failure midway and the nested empty case

| ID | Axis | Scenario | Expected (source) | Lane | Today | Gate |
|---|---|---|---|---|---|---|
| F-M1 | failure midway | `[a "aa", b "bb", c "cc", d "dd"]`, range a@1 → d@1; an extension's after-command hook throws | document `[a "ad"]`, exactly as with no hook (`del.range.flat`); one undo step; the error surfaces to the caller. After-hooks run after an atomic commit and cannot leave a partial effect | doc + dom | fails (P11: `["a:ad", "c:cc", "d:d"]`, text duplicated) | CP4 |
| F-M2 | veto of a nested step | same range; an extension refuses `removeBlock` for `c` | the range delete is one command whose sub-steps do not consult hooks, so the result is `[a "ad"]`. An extension that wants to stop range deletes refuses `deleteRange` as a whole, and then nothing changes (D7) | doc + dom | fails (P11b: half-executed, text duplicated) | CP4 |
| F-M3 | veto inside a composite command | markdown shortcuts on; an extension refuses block-type conversion; type `#`, then space, in an empty paragraph | the paragraph reads `"# "`: each keystroke was its own committed command, and the convert command is refused before any write | dom | fails (`prevent-midway`: empty paragraph, both characters lost) | CP4 |
| F-M4 | throw inside a command after partial writes | a normalizer throws on its first call during a split | the command reports `failed`; the undo step holds exactly the committed writes and one undo restores the pre-command document; the Surface shows the model (no native drift adopted in that window) | dom | predicted | CP4 |
| F-D12 | nested, empty collection | `[ordered-list > [i1 "one", i2 "two"], P "three"]`; select i1@0 → P@2; Backspace | `[P "ree"]`, caret `P@0`: the list's whole subtree lies inside the range (`del.range.nested-subtree`, `del.range.flat.head-empty`), so no empty container is left | doc + dom | fails (P5: empty `ordered-list` left) | CP2 |

---

## 9. Bounded migration sequence

### 9.1 Discipline that applies to every checkpoint

1. **The reference stays runnable.** Tag `ref/cpN` at each checkpoint start. The command-program corpus and the DST
   corpus (solo + collab) run against both the tag and the candidate. Outcomes may differ only where a §8 test or a
   recorded §11 decision says so; any other difference is a failure. Nothing is deleted while the reference is the
   only thing passing a test.
2. **No checkpoint closes with two owners for one fact.** The mechanism a new owner replaces is deleted in the same
   checkpoint that proves the owner. A checkpoint that leaves the old path "just in case" is not closed.
3. **Tests first.** The checkpoint's §8 rows are enabled (as expected-fail where they fail on the reference) before
   any production change. The checkpoint closes when they pass and every lane is green: `pnpm test -- --run`,
   `pnpm test:dom`, `pnpm test:crdt`, `pnpm check`, `pnpm lint`, chromium integration. CP5–CP8 also need the
   firefox and webkit browser lanes and `pnpm test:dst:solo` + `pnpm test:dst:collab` on all three engines.
4. **Size and special-case budget.** If a new owner's measured xloc exceeds its §4 estimate by more than 30 %, or it
   needs more than three special cases its contract does not name, stop. Treat the complication as diagnostic and
   apply the repair order (clarify the requirement → find the existing semantic owner → improve the owner or the
   representation → a new concept only if an independent responsibility remains) before writing more code.
5. **Two-iteration rule.** A redesign trigger allows at most two design iterations. After that, escalate to the
   maintainer with the failing test and the measured cost.

Order: `CP0 → CP1 → CP2 → CP3 → CP4 → CP5 → CP6 → CP7 → CP8 → CP9(switch)`. The CP9 spike runs in parallel from
CP1 on, because it lives behind the document facade. The CP9 switch lands after CP8 so that the schema bump is a
clean generation bump under R12.

### 9.2 Checkpoints

**CP0 — Freeze the reference and install the oracle** (bounded to 2 days)
- *Contract:* no behavior change; all lanes green.
- *Unit:* tag the reference. Add every §8 row: expected-fail where "Today: fails", normal otherwise. Instrument
  F-O1…F-O5 through test spies (on `Selection.prototype.addRange`/`setBaseAndExtent`, timers, hook calls, change
  reports), not through production flags. Record xloc per module.
- *Deletes:* L60 dead code (no readers), and the unconditional `__EDYTOR_SEL_LOG__` push, which is a production
  memory leak.
- *Limit:* any disputed §8 expectation becomes a §11 decision before CP1 starts. No production refactor in CP0.

**CP1 — The Document answers structural questions once (R4, R5)**
- *Contract:* F-D2, F-D3, F-D4, F-D5, F-D6, F-O4, F-P1. Plus, over a randomized request corpus,
  `canMoveBlocks(r) ⇔ moveBlocks(r).status !== 'refused'`.
- *Unit:*
  - one `isLive`, one `order`/`compare`, one `canPlace`/`canMerge` in `doc/index` and `doc/document`;
  - op results `refused | noop | applied` with ids and position, read from the transaction fold;
  - all-or-nothing `setBlock`;
  - one ingress normalization for writes and lookups;
  - `defaultChild` adopted as data. A function-valued `defaultBlock` is evaluated for each registered parent type at
    adoption, and must be a pure function of the type.
  View code calls these predicates.
- *Deletes:* L11, L12, L13, L14, L10, and the ancestor-walk/children-builder duplicates of L9.
- *Limit:* if a view consumer needs a structural answer the Document cannot express, add the fact to adopted
  semantics, never to the view. If a plugin's default-type rule depends on block *data*, not type, stop and ask:
  adopted semantics must stay comparable across views.

**CP2 — Range deletion, paste placement and HTML import are document operations**
- *Contract:* every `del.range.*` row, F-D1, F-D12, F-P5, F-P10, and the user-visible assertions of the clipboard and
  HTML specs (after the paste-shape decision is recorded).
- *Unit:* `doc/rangeDelete`; `doc/flow`; fresh ids at `doc/ingress`; HTML through `DOMParser` into a flow; mapping
  resolution once at registration. Callers (typing over a range, delete keys, cut, internal paste, HTML paste,
  markdown/slash convert) use them.
- *Deletes:* L40, L41, L43, L44, L45, L46.
- *Limit:* a third structural branch or a caller-specific flag in `rangeDelete` means a contract row is missing.
  Write that row first, then continue.

**CP3 — Render cells change only from change reports (R1)**, in two units
- *CP3a, structure:* ops stop calling `flushMirror`. Block cells are created, disposed, reordered and meta-patched
  only from change reports. `Block` becomes the cell: plugin-facing getters delegate to the index, and mutators keep
  today's `batch` path until CP4. The derived index gets its single fold, which absorbs the rest of L9.
- *CP3b, text:* segment views are derived; positional text ids are removed; `Text` becomes a segment view memoized
  per content version; every position is *(block, display offset)*.
- *Contract:* F-O5, F-P9; "no DOM remount under the caret while typing" (rewrite `mirror-incremental` and
  `scoped-text-refresh` as that user-level oracle); every `sel.ride.*`/`sel.seam.*` row; all browser lanes.
- *Deletes:* L9 (rest), L15, L16, L17, L18, L39.
- *Limit:* if a command needs a mid-transaction wrapper read, extend the op result; never reintroduce the read. If a
  plugin depends on segment identity across commits and per-version memoization does not satisfy it, record the
  API change; do not restore identity.

**CP4 — One command, one dispatcher (R6)**
- *Contract:* F-O3, F-M1, F-M2, F-M3, F-M4, F-I3, F-P4, F-P6, F-P11, F-P12, F-P13, F-P14; one undo step per
  command (the existing history fixtures); readonly refuses every mutating command (the existing readonly fixture).
- *Unit:*
  - `session/commands`: permission → hooks returning values → one transaction → normalization once per touched
    parent → undo policy → result selection;
  - a compatibility adapter that turns an old-style `prevent()` into `refuse` at the boundary;
  - `marksForInsertion`, with pending marks on the selection value;
  - one keymap precedence rule;
  - the relative-move command;
  - kind and mark records, from which slash, markdown, HTML and clipboard tables are generated.
- *Deletes:* L37, L38, L42, L47, L51, L54; interception of nested sub-steps; each extension's caret-restore ladder
  (the plugin part of L25), removed as that extension starts returning a result selection.
- *Limit:* an extension that needs DOM access inside a command has a Surface concern (a post-commit effect), not a
  dispatcher special case. If hooks-as-values cannot express an existing plugin behavior after two attempts, keep
  the `prevent()` adapter for that hook only and record the cost.

**CP5 — The selection is a value; display is a projection (R3, R8, R9)**
- *Contract:* F-S1…F-S9, F-U1, F-U2, F-U6, F-U7, F-P2, F-P3, the timer half of F-O1. Browser gate **F-S10** on three
  engines plus DST solo/collab. The existing `selection*`, `navigation-selection-sync`, `android-caret-restore` and
  post-commit `composition` rows stay green.
- *Unit:*
  - `session/selection` (value, `select()`, projection, a compatibility `state` getter, held anchors);
  - `session/history` (`{before, after}` per view);
  - `doc/anchors` seam over the replicated slot;
  - `surface/projector` (display, classifier, focus predicate, attribution frames);
  - `surface/domPoint` consolidation;
  - the navigation caret-stop stream.
- *Deletes:* L19–L24, the rest of L25, L27, L52, L53; the `history/` directory; the selection half of
  `undoRestore`.
- *Limit (the one the selection reader asked for):* if an engine echo cannot be classified from (displayed, render
  epoch, gesture) after two iterations, add **one named classifier rule**, pinned by a browser test ("Android
  post-delete +1" is the expected candidate). Never add a timer. If more than three named rules are needed, stop:
  some render is not bracketed, so pull CP7's bracket forward before finishing CP5's deletions.

**CP6 — One occurrence, one attempt; composition is a session (R3, R7)**
- *Contract:* F-I1, F-I2, F-I4, F-I5, F-I7…F-I12, F-U8. The `mobile-beforeinput`, `composition*`,
  `unsupported-beforeinput`, `beforeinput-fallback`, `input` and `drop-beforeinput` specs stay green on three
  engines, and DST passes.
- *Unit:* `session/attempt` (one translation table, attempt lifecycle, anchored keydown fallback, Android deadline
  tested against the anchored atom); `session/composition` plus `surface/pin`; adoption through the dispatcher with
  a prefix/suffix diff.
- *Deletes:* L28–L32, L35, L36.
- *Limit:* a browser-owned path that seems to need a second adopter must first be shown with a failing browser test.
  A fourth commit signal or a second cancel semantic means stop and record the product decision (keep or delete
  abandoned previews).

**CP7 — The host holds only model content; own renders are never input (R10, R11)**
- *Contract:* F-I6, F-O2, F-P7, F-P8, the writer half of F-O1; the user-visible assertions of
  `placeholder-repair.spec`; `dom-mutation.spec` (foreign damage); mark rendering in `hotkeys.spec` and
  `demo-route.spec`; the block-handle specs; the DST `foreignMutation` oracle on three engines.
- *Unit:* placeholder as an attribute; the core renders the block element; chrome moves into `surface/overlay`; the
  render bracket (drain → patch → `flushSync` → discard own records → display) wraps commands, remote applies and
  history; the observer classifies by location and attempt owner only.
- *Deletes:* L33, L34, L48, L49, L50.
- *Limit:* if some render cannot run inside the bracket (for example an async effect that writes host DOM), move that
  write to the overlay or to cell state. If that is impossible after two attempts, keep a **named, bounded exemption
  list** (not liveness inference) and charge its xloc to the +300 contingency. If `flushSync` per command exceeds the
  `bench/` budget (proposed: p95 keystroke at 5k blocks ≤ today's), stop and batch remote applies per animation
  frame before going further.

**CP8 — Transport: generation, join, readiness, presence, migration (R1, R12)**
- *Contract:* F-T1…F-T10. The sync, persistence, presence and migration suites are rewritten against the new
  invariants (generation-mismatch tests replace the schema-staging tests). The collaboration browser specs run on
  three engines **with default `resyncInterval`**, so the specs no longer force 200/250 ms.
- *Unit:*
  - schema in the generation word and the container record; staging deleted;
  - `sync/room` shared lifecycle (`hasSynced`); one join rule;
  - open never writes, explicit create, the virtual block; the `writable` guard;
  - one presence encoding keyed by view;
  - migration lock + atomic activation + `force` as a replace-edit;
  - providers keyed by transport target.
- *Deletes:* L26, L55–L59. L61 (API retirement) only with the maintainer's approval.
- *Limit:* the `<Edytor value>` contract change (value applies on an explicit create) needs the maintainer's
  approval. If rejected, keep a compatibility mode that seeds under **fresh ids** after the first applied Step2 or
  one timeout. That mode is non-destructive, fixes P4b/P6 but not P4, and costs about +40 xloc.

**CP9 — Streams are delimited by boundary items (R2)**: spike from CP1, switch after CP8
- *Spike contract* (must pass before any old ownership code is deleted): F-D8 (property corpus), F-D9 (re-pinned),
  F-D10, F-U3, **F-U4**, F-I7; all TX01–TX09, ST01–ST03, MV, AN and HI01a/b scenario suites; the reachability and
  random corpora; probe C3 (history independence); ≤ 20 B per keystroke at a split seam (C7).
- *Switch contract:* F-D7 on every path; the whole crdt lane; a generation bump to schema 2. The bump is clean under
  R12: no v14 data exists outside development, and development data is re-imported from JSON.
- *Unit:* boundary items in `doc/streams`; the stream table in `doc/index`; split = boundary + claims; anchors bind
  boundaries. The v13→v14 migration is re-targeted, and stays representation-agnostic because it imports JSON.
- *Deletes:* L1–L8, `undo-repair.ts`; L62 oracles move to `src/tests`.
- **Redesign limit (one explicit decision point):** abandon R2 if the spike needs any repair write (a second
  transaction, or a per-keystroke record rewrite) to pass F-U4 or F-D8, or if F-U4 fails because the engine does not
  place the new boundary after the tombstone run. In that case: keep slice records, but consolidate their six
  deciders into `doc/streams`; fix F-D7 in the document's ownership resolution; take the 17.15k target from §7.1.
  The decision is taken once, at the end of the spike, with the failing test attached.

### 9.3 Expected xloc track (floor; contingency is the per-checkpoint allowance of §7)

| After | Ledger rows deleted | Local trims | New code | Expected xloc |
|---|---:|---:|---:|---:|
| start | | | | 29,026 |
| CP0 | 130 | — | — | 28,896 |
| CP1 | 460 | 200 | — | 28,236 |
| CP2 | 1,088 | 200 | — | 26,948 |
| CP3 | 1,326 | 500 | — | 25,122 |
| CP4 | 1,026 | 600 | +140 | 23,636 |
| CP5 | 2,512 | 600 | +90 | 20,614 |
| CP6 | 1,460 | 500 | — | 18,654 |
| CP7 | 1,396 | 300 | +30 | 16,988 |
| CP8 | 1,224 (872 without L61) | 200 | +26 | 15,590 |
| CP9 | 1,142 | 100 | +130 | **14,478** (floor) |

The target with contingency is 15,926. A checkpoint that lands more than 30 % above its row triggers rule 4.

---

## 10. Extension-cost check

The question for each case: how many **owners** (contexts) change, and how many places inside them?

| Extension | Owners that change | What changes | Today (for comparison) |
|---|---|---|---|
| **(a) A new block type with nested children** (e.g. a toggle block: summary line plus collapsible children) | **1**: Extensions | One kind record: inner-markup snippet with a children slot; `role?`; `defaultChild?` (e.g. `toggle → paragraph`); HTML import/export; markdown prefix; command row (label, icon, keywords); empty shape. The Document adopts the record's semantics; commands (convert, split, merge, nest, move), navigation, clipboard, slash menu, markdown and the observer are generic. The core renders the block element, so the element choice lives in `definition.element(data)` | 6–9 files across 3 layers: snippet (+ the `use:block.attach` convention), `richTextCommands.ts`, the slash icon table, the markdown table and converter, `elementDefinitions.ts`, core `serializeClipboardFragment.ts`, demo choices, core `Block.svelte` re-keying when the element depends on data, a `defaultBlock` function whose effect depends on plugin order (it wins in the demo only because `codePlugin` is listed first), plus eligibility predicates |
| **(b) A new mark** (e.g. a coloured highlight) | **1**: Extensions | One mark record: renderer, HTML import/export, value sanitizer, binding row, edge policy (inclusive or not). `marksForInsertion` applies the edge policy generically; format commands and the toolbar read mark records | 4–6 places: snippet, native format-input mapping, toolbar, HTML tables, clipboard export mapping, and the collapsed-toggle policy, which today **drops valued marks** (probe `mark-inherit`). A valued mark is broken out of the box today |
| **(c) A new inline void** (e.g. a date chip with a `::` trigger) | **1**: Extensions | One atom record (renderer, HTML forms, command row) and, optionally, a trigger hook that returns an insert-atom command. Atom selection, removal, replacement, caret stops and edge clicks are generic, and the trigger works the same for typed and adopted input because adoption goes through the dispatcher | **2** owners: the plugin, plus core event code (`onInput.ts:471` and `onBeforeInput.ts:350` hard-code the mention trigger so native-path input reaches it), plus a timer-based caret restore copied from `MentionPlugin` |
| **(d) Comments / suggestions on ranges** | **3**: Document, Surface, Extensions | *Document:* one replicated collection (`threads/<id> = {start, end, …}`) and one facet in the fold/change report. Ranges follow edits through the existing anchor codec (R3); dead ranges resolve by the seam rule or stay `pending`. *Surface:* a range painter in the overlay that reuses the remote-caret geometry, so it is outside the host (R10) and no observer change is needed (R11). *Extensions:* the comments UI and its commands, which read `selection.value` anchors. Session and Transport do not change | 6+ modules. There is no anchored-range store outside the selection's internals. Highlight DOM inside the host would need new exemptions in the observer's liveness inference and in the selection's overlay mapping; the placeholder shows what that costs (~285 xloc of collateral). The remote-caret overlay has its own DOM mapper and is not reusable |

Other probes of the same question:
- **A new inputType:** one row in the intent table and one command case (Session). Today it touches up to 8
  decision sites: the predicate family, target-sync rules, browser-owned classification, the router,
  `shouldRefreshDomAfterModelCommand`, `NON_COMPOSITION_INSERT_TYPES`, the history boundary and the `onInput`
  predicates.
- **A new selection kind** (e.g. table cells): one union variant, one projection branch and one display branch.
  Today it touches the 30-field state, 4 builders, 7 writers with different side effects, 2 dedupes, the undo
  snapshot and its 3 restore shapes, and the echo latches.
- **A new transport** (e.g. WebRTC): a socket adapter on top of `sync/room`; generation, join rule, lifecycle and
  failure semantics are inherited. Today each provider re-implements schema gates and settle heuristics, and the
  two existing providers already disagree on departures and on `failed`.

Two owners grow with features and should be watched:
- **`doc/document`** gains one op for each new structural concept. That is intended: ops are the only writers.
- **`surface/observer`** must stay kind-agnostic. A pull request that teaches it about a specific block, mark or
  atom type violates R11 and should be rejected.

---

## 11. Risks and unknowns

### 11.1 Technical risks, largest first

1. **R2 (stream boundaries) rests on two engine behaviors.** The plan assumes:
   - the vendored insert advances past zero-rendered-length tombstones (`minimizeFormatChanges`,
     `ynode.js:285-297`);
   - `redoItem` integrates copies between the tombstone's current left neighbour and the tombstone
     (`UndoManager.js:458-528`, as the crdt reader cites it).

   The first depends on `rendererContentLength(currPos.renderer, …)`. If any path inserts into backing texts under
   an attribution renderer that gives deleted items a non-zero length, boundaries could land before a tombstone run,
   and F-U4 would fail. Other R2 costs:
   - TX06a and the identity of TX04a's winner are re-pinned;
   - the reading order of concurrently split siblings (O71) is still open;
   - "no content delete touches a boundary item" must be enforced by making the per-stream delete the only delete
     path;
   - concurrent same-id creation needs the incarnation nonce.

   Mitigation: the CP9 spike, its explicit abandon criterion, and a fallback target that still clears 40 %.
2. **R11 (render bracket) needs every host-DOM write to happen inside a bracket.** Svelte 5 has no pre-DOM-write
   hook, so the bracket forces `flushSync` after each command, remote apply and history step. Two consequences:
   - A per-keystroke cost that must be measured.
   - Any asynchronous effect that writes host DOM, and any extension snippet that mutates its own inner markup
     outside a render, would be classified as foreign.

   Keyed `{#each}` anchors (empty text nodes, comments) are produced inside the bracket, and foreign damage to them
   must still be inverted exactly (Svelte owns them). Mitigation: CP7's limit and budget; overlay chrome keeps
   extension DOM out of the host.
3. **R9 (projector without timers) is unproven in real engines.** It claims that the Gecko re-anchor bounce, the
   Gecko/Blink clamp difference, Android's post-delete +1 and IME post-commit jumps are all either a render drift
   (a render happened since the last display and there was no gesture) or a named rule. jsdom cannot falsify this.
   Mitigation: the F-S10 browser gate and the named-rule limit in CP5.
4. **Plugin API compatibility.**
   - `Block`, `Text` and `InlineBlock` stay as classes, but `Text` becomes a segment view memoized per content
     version: identity across commits is not guaranteed.
   - Hooks move from thrown `prevent()` to returned values; an adapter keeps old plugins working.
   - Normalizers receive document handles, not cells.
   - `CodePlugin`'s `new Block({block})` + `insertChildren` normalization moves to document handles.
   - Tests that assign `selection.state = {…}` must call `select()`.
5. **Readers' floors may be optimistic.** They are line-level re-estimates, not implementations. The 1,453-xloc
   contingency covers about 10 % overall, concentrated where the risk is. If actual costs run 25 % over the floors,
   the result is still about −38 %; the 30 % stop rule catches it at the checkpoint where it happens.
6. **HTML import through `DOMParser`.** Inter-element whitespace handling was hard-won once (commit `43bb7bd`). The
   19 tokenizer fixtures go, and the whitespace fixtures must be re-derived against DOM text nodes.
7. **Overlay handles in nested scroll containers** need scroll-container tracking (+20 in the contingency).
8. **The click → caret re-derivation** in `Text.svelte` (36 xloc) is suspected historical but untested. Keep it until
   a real-browser check shows native clicks land only on model text once the placeholder is an attribute.
9. **`navigator.locks`** is present in current browsers and in Node 24 here. Where it is absent, the migrator
   returns `busy` for concurrent callers instead of leasing. That is a documented degradation, not a data risk,
   because progress is still one atomic transaction.
10. **Incremental change reports** must equal a full diff. Today's `diffSnaps` becomes a test oracle (L62) and runs in
    the random corpus.

### 11.2 Decisions the maintainer must make (the plan proposes an answer for each)

| # | Decision | Proposed | Why |
|---|---|---|---|
| M1 | Placement of a block fragment at a mid-text caret | split: `["HelloX", "YWorld"]` for internal and HTML; plain text keeps soft breaks unless decided otherwise | one placement rule (F-P5); three behaviors today |
| M2 | Meaning of "move down" | the public relative-move semantics: `B{B1}, A, C` | AGENTS.md makes `moveBlocks` the owner for DnD, keyboard and menus |
| M3 | Placeholder customization | **scope cut:** a string or a `block => string \| null` function replaces the snippet; rich placeholder markup is dropped | the placeholder machinery (~355 xloc plus bugs) exists only because it is a node in the host |
| M4 | Invalid HTML mapping | degrade to paragraph/plain text instead of throwing after `preventDefault` | the throw path loses the paste entirely (C7 is pinned by test only) |
| M5 | `<Edytor value>` and empty documents | `value` applies on an explicit create; opening never writes; an empty document shows a virtual block; the `{#if synced}` render gate goes (apps can gate on the informational `synced`) | probes P4, P4b/c (erasure) and P6 (the first user never sees the editor); a compatibility mode exists (CP8 limit) |
| M6 | Schema compatibility | by generation: rooms with mixed schemas partition cleanly instead of coexisting under last-writer-wins | today's gate protects only the stamp, not the content (P2), and can disable compaction forever (C11). Nothing shipped, so no deployed room exists |
| M7 | Precedence of duplicate definitions | first wins everywhere (README) | the code is last-wins for definitions and first-wins for everything else |
| M8 | TX06a / TX04a pins | re-pin to YATA order | a concurrent tie with no user intent; the result is convergent either way |
| M9 | Composition when a peer deletes the host block | delete wins: the commit is hidden with the block and the caret goes to the seam | `conc.delete-wins-block` |
| M10 | Abandoned composition | one `cancel`: preview atoms are deleted, with no undo entry | today the two exits disagree |
| M11 | Delete of `p` concurrent with a move of its child `c` out of `p` | **undecided**, not gated (rescue vs delete-wins-subtree; probe C5 crdt) | needs a product answer; the move ADR does not cover it |
| M12 | API retirement (L61, ~352 xloc) | retire `decorateRuns`, subscriber variants, "advanced internals" exports, raw sync readers, IDB `get/set/del`, the server-side awareness helper | no production consumer; 0.0.x package; list them in the changelog |
| M13 | `setBlock` with reused child ids | refuse with `id-collision` (no implicit revive) | all-or-nothing (C-R13); probe C4 |
| M14 | `defaultBlock(parent)` hook | becomes data (`defaultChild` per parent type), merged across extensions, with conflicts as errors | it becomes comparable across views; today the result depends on plugin order (`RichTextPlugin`'s always-truthy fallback would shadow `CodePlugin`'s rule if listed first) |
| M15 | Legacy presence fields (`startTextId`/`yStart`, `selection` mirror) | remove | no v14 peer has shipped; v13 peers are excluded by the envelope |

### 11.3 Scope statement

Feature parity is kept for everything the tests, docs and demo route exercise:
- rich text, marks and inline blocks; void and island blocks;
- nesting, moves, DnD and block handles;
- split, merge and delete contracts; IME and composition;
- undo/redo with selection restore;
- collaboration over awareness, websocket and IndexedDB; v13→v14 migration;
- clipboard, paste and HTML; readonly; remote selections; slash menu; toolbar; attribution.

The only proposed scope cuts are these:
- M3: rich placeholder markup;
- M4: the throw-on-invalid-mapping behavior, and the trailing-inline merge artifact (C8), both pinned by test only;
- M5: seeding on open, with a compatibility mode offered;
- M6: last-writer-wins schema coexistence;
- M12 and M15: API and wire-field retirement with no deployed consumer;
- M8: the TX06a pin.

### 11.4 Unknowns I could not resolve

- Whether any consumer outside the repo depends on `refreshRemotePresence`, `editorDomRevision`, `decorateRuns` or
  the "advanced internals" exports. The repo has none.
- The real per-keystroke cost of `flushSync` in the bracket at 5k blocks. `bench/` must measure it at CP7.
- Whether F-U4 holds when attribution rendering is active on a backing text. The CP9 spike must include that
  configuration.
- The reading order of concurrently split siblings (O71). R2 makes it decidable from boundary order, but choosing a
  placement rule that uses it is a separate design task.

### 11.5 Claims verified directly in source for this plan (beyond the readers)

- `runOperation` (`block/block.utils.ts:130-172`): hooks run for every call, nested sub-steps included, and
  `prevent()` throws through the transaction.
- 25 `flushMirror` references, 16 of them op-level call sites.
- Two history restorers: `events/undoRestore.ts:22-66` next to the selection's `stack-item-popped` handler.
- The `DocChange` shape (`crdt/edytor-doc.ts:475-495`) already carries added/removed/moved/meta/content/order, which
  is enough to patch cells incrementally.
- The commit subscription re-subscribes on every attach and captures and reconciles the selection around every
  commit (`edytor.svelte.ts:828-910`).
- `minimizeFormatChanges` skips zero-length tombstones on insert (`vendor/yjs/src/ynode.js:285-297`).
- `src/lib/utils/jsx.ts` has no importers anywhere in `src/` or `tests/`.
- `d9b7de0` is not an ancestor of `master`; `package.json` version is `0.0.11`.
- Both `defaultBlock` implementations are pure functions of the parent's type (`RichTextPlugin.svelte:82-92`,
  `CodePlugin.svelte:106-110`); the demo lists `codePlugin` before `richTextPlugin`.
- Reader xloc spot checks: `canApplyDirect` 91, `applyUpdateStaged` 39, `restoreDeadSelectionEndpoints` 172,
  `applySelectionSnapshot` 289, `setAtRange` 165, history restore 270, observer attribute tables 297, observer caret
  restore 106 — all match.
