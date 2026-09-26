# crdt-core domain — independent architecture read

Scope: `src/lib/crdt/{edytor-doc,document,admission,undo-repair,nodes,structs,schema,engine-api,index,rand,engine}.ts`,
`text/{model,runs}.ts`, `placement/{model,rank}.ts`, `attribution/**`. Vendored engine read as context only.
Evidence: source (read in full), `src/tests/crdt/**` titles/scenarios, allowed docs (document, richtext/text-ownership/move/undo-ownership ADRs,
selection, delete-contract anchor section, runtime-cutover, vendor UPSTREAM/API-NOTES).
Domain xloc (script): **6,237** = edytor-doc 1504 + text/runs 1184 + text/model 1014 + placement 942 + document 552 + attribution 399 +
undo-repair 196 + index 151 + nodes 104 + structs 71 + admission 61 + engine-api 34 + schema 18 + rand 5 + engine.js 2.
Note: the xloc script counts multi-line `export type X = {…}` bodies (its first regex swallows only the header line) — ~333 of the
6,237 are type bodies (text/model 70, runs 50, placement 49, nodes 37, document 27, attribution 40, edytor-doc 22, admission 19, structs 13).

Correction to the task framing: the vendored engine is NOT "upstream + one import rewrite". `UPSTREAM.md` records P1 (import rewrite),
P4 (format-aware search-marker checkpoints for `applyDelta` + relative positions), P5 (shared `readItemPieces` + a new read-only
`RangeCursor`), P6 (side-correct attribution rendering). P5's `RangeCursor` is what `text/model.ts:1078` reads through; the
facade already delegates the physical-sequence interpretation to the engine.

---

## 1. Required behavior (guarantees, stated without implementation names)

Document shape
- R1 [user-visible] A document is an ordered tree of blocks; each block has a caller-assigned stable id, a type, JSON data, and
  inline content = ordered text runs (each with a mark set) and inline atoms (id, type, JSON data). Offsets count one per UTF-16
  unit and one per inline atom.
- R2 [collab-invariant] Two replicas that integrated the same set of updates, in any order, with duplicates, render the identical
  tree, identical content, identical marks (scenarios TX/ST/MV/AN, random corpus classes `duplicate-placement`, `lost-identity`,
  `cycle`, `unreachable-block`).
- R3 [collab-invariant] Every live character/atom renders at most once; every live, non-deleted-ancestor block is reachable and
  every character it holds renders exactly once (no silent loss, no duplication) — including under concurrent cyclic
  moves/merges (`gate1/display-cycle`, `reachability` 0/150 seeds).
- R4 [collab-invariant] Identity survives relocation: moving/nesting/splitting/merging a block keeps its id and the identity of
  every character it holds, so an offline peer's concurrent edit/format to those characters lands on them wherever they are now
  displayed (TX01, TX03, TX07, HI01a/b, MV01, MV10). New identity only from explicit creation (insert, duplicate, replace).
- R5 [collab-invariant] Deletion wins: a deleted block and its subtree never reappear because of a concurrent move, merge or split;
  split never resurrects text a peer deleted (MV06a/b, TX02, ST02a–d). A deleted block's children are hidden with it, not promoted.
- R6 [collab-invariant] Concurrent moves of one block converge to exactly one placement; group moves resolve per member; a group
  move is one undo step (MV02, MV07a/b).
- R7 [collab-invariant] Concurrent splits: same point ⇒ every requested block exists, the tail goes to exactly one, the loser is an
  empty block; different points ⇒ each seam survives (nested partition), nothing dropped or duplicated (TX04a–c). Concurrent
  merges chain transitively; a contested merge has one winner; deleting the merge destination voids the merge; deleting the
  merge source hides its text (TX05a–c, ST02b/c).
- R8 [user-visible] Boundary affinity: typing at a block's start/end/empty display lands in that block, never in a neighbour that
  happens to share storage (ownership-regression A/B, gate-F1 "steal" shapes); an insert at a merge join lands on the left side
  (TX06b); range delete/format spanning a seam affects both sides (TX06b).
- R8b [test-only] (a pinned choice, not derived from any user contract) a concurrent remote insert exactly at a split seam lands
  on the head side (TX06a).
- R9 [collab-invariant] Marks: different keys union; same-key overlap resolves deterministically by item order (tail clearing is
  accepted engine semantics); set-vs-unset ⇒ unset wins; a local unmarked insert inside a marked range stays unmarked; a
  concurrent insert inside a range written before the mark was known adopts it (golden AN01–AN07).
- R10 [collab-invariant] Inline atoms: crossed by a split seam they move whole, once, identity kept; metadata update keeps
  identity; concurrent remove vs data update ⇒ remove wins (TX09b, AN03).
- R11 [collab-invariant] Writes are idempotent over the wire: the local store must equal what receivers decode (lone surrogates
  normalized at ingress, `wu9-surrogate-wire`); caller-held objects never alias replicated state.
- R12 [collab-invariant] Creating a block whose id (at any depth of the spec) already exists, live or deleted, is refused with no
  write at all (`gate1/insert-collision`); invalid local moves/merges (into own subtree, onto void, across island) are refused
  with zero update bytes.
- R13 [collab-invariant] Every op either applies fully or refuses before its first write — the engine cannot roll back
  (`gate-F2 F2-B1` partial-delete shape).
- R14 [user-visible] Structural policy per block type (void: no children/merge/split, content editable; island: subtree sealed
  against moves/merges/unnests from outside, island merge unnests + resets children) is decided from the viewer's plugin
  definitions, not stored in the document; views that disagree on a type's role must be refused, not silently mixed.

History
- R15 [user-visible] Local undo is selective: it reverts only this replica's tracked local actions, one user action per step,
  never remote work (applied updates are non-local), and preserves concurrent remote edits (`doc/selective-undo`, HI01a/b).
  Bootstrap/schema writes and bookkeeping writes are never undo steps.
- R16 [user-visible + collab-invariant] Undo of a text deletion restores the text into the block that displayed it before the
  deletion — on the undoing replica, on receivers that never ran the delete, and after binary reload (R3 ADR,
  `hardening/r3-undo-ownership`).

Selection anchors
- R17 [user-visible] A selection endpoint is a JSON value that follows its characters through local/remote edits, split, merge,
  move; carets and range ends keep left insertion affinity, range starts right; a caret at a block start stays in that block when
  the neighbour that shares its storage receives text at the shared gap; a caret in deleted text resolves to the gap; a caret whose
  block died reports "unresolvable" (caller falls back); a late-arriving bound item converges (`doc/anchors`, delete-contract
  "Anchor contract" 1–6).

Publication
- R18 [user-visible] After each committed transaction (local or remote) a subscriber gets one notification naming added subtrees,
  removed ids, moved ids, type/data changes, content changes, per-parent order changes — enough to patch a mirror without
  re-reading; no-op commits publish nothing (`doc/mirror`).
- R19 [user-visible] Notifications are commit-bound: never an intermediate state, nested transactions publish once at the outer
  commit, change-then-revert publishes nothing, a throwing subscriber does not starve others (`hardening/r5-commit-notify`).
- R20 [browser-constraint] Read-your-writes inside a transaction: a command that writes then reads (length, content, position,
  children) sees its own write (runtime-cutover "same-transaction reads").
- R21 [test-only] (user-visible only through misuse) Returned snapshots cannot mutate replicated state (`hardening/r4-snapshot-isolation`).
- R22 [test-only] (bench-pinned; user-visible as latency and bytes) A keystroke recomputes only the edited block's content (1 of 1000); a move recomputes no
  content; unchanged runs keep object identity (keyed rendering); split/merge/move cost O(1) wire bytes in payload size.

Lifecycle / admission
- R23 [collab-invariant] Concurrent initialization of an empty doc by N peers converges to one bootstrap block (SY03b–e); a doc
  whose content is still being decided by a provider is never seeded or broadcast early; foreign/legacy/unversioned/unsupported
  docs are refused without mutating them (document/admission, lifecycle-gates).
- R24 [user-visible] One document may be shared by several views: one history, one awareness, one maintained content view;
  per-view origins tracked; document lifetime = last reference.

Attribution (product feature)
- R25 [user-visible] Per block: creator, contributor set (add-only, survives undo), last changer (restored by undo); a recycled
  block id never inherits a dead incarnation's record; deletes and pure moves stamp nothing; metadata commits in the same update
  as the edit. Opt-in bounded "displaced state" ring per block with a convergent cap.

---

## 2. Real constraints (what is actually forced, with the fact that forces it)

Vendored engine (`src/lib/crdt/vendor/yjs/src`, rc.26 + P1/P4/P5/P6):
- E1 **No native move** (`API-NOTES.md`: `Y.Node` exposes insert/delete/format only; move ADR §"Why placement"). Relocating a subtree
  by copy violates R4, so block position must be replicated metadata over a stable registry. Forces: per-block placement records
  + a projection that picks one winner and keeps the tree acyclic (R3, R6).
- E2 **Map attrs are LWW by item order and overwrite tombstones the old subtree.** `registry.setAttr(id, node)` on an existing id
  replaces content/slices/placements (placement/model.ts:879-883 comment; gate-1 finding). Forces id pre-validation (R12) and
  gives R23 (same-key bootstrap converges) for free.
- E3 **No rollback.** `transact` (utils/Transaction.js:411-432) is `try { f() } finally { cleanup }` — a throw leaves prior writes
  applied and broadcast. Forces validate-then-write for every multi-write op (R13; text/model.ts:1548-1596 is the pattern).
- E4 **Remote applies are non-local**: `applyUpdate` forces `transaction.local = false` even when nested (utils/encoding.js:248-249).
  R15's remote exclusion is one `captureTransaction` predicate (document.ts:747) — nothing else is required for it.
- E5 **Undo resurrects deleted content as NEW items**, integrated between the tombstone's current left neighbour and the
  tombstone (`redoItem`,
  utils/UndoManager.js:458-528: `left=item.left`, `right=item`, fresh id, `item.redone = nextId`, `keepItem(copy,true)`); `redone`
  and `keep` are local, never serialized. Anything that identifies ownership by *character items* loses it across undo; anything
  anchored on items undo does not recreate (neighbours, boundaries) keeps it. This single fact is the root cause of R16's
  machinery (see §6 candidate A).
- E6 **Relative positions bind an item and resolve a deleted item to its gap**; `createAbsolutePositionFromRelativePosition`
  defaults `followUndoneDeletions = true` (utils/RelativePosition.js:292), which is replica-dependent (E5). Convergent derivations
  must pass `false`.
- E7 **Commit hooks run after `doc._transaction = null`** (Transaction.js:431 nulls it, then `cleanupTransactions` emits
  `beforeObserverCalls` at :221). Anything that wants "this transaction's changes" at commit must take the transaction argument,
  not read `doc._transaction`.
- E8 **`transaction.changed: Map<type, Set<parentSub>>`, `insertSet`, `deleteSet` exist on every transaction** and every observer
  event carries `transaction` (utils/YEvent.js:32). The deep delta is a render, not a necessity. Consequence: an event without
  `transaction.changed` cannot be produced by this engine.
- E9 **Marks are format items** with the documented concurrent semantics (richtext ADR §4); `format` over atoms that already
  satisfy the marks inserts nothing (vendored `minimizeFormatChanges`, cited at edytor-doc.ts:1870-1886). "Semantic no-op" is
  therefore observable from the engine (no item was inserted, so this client's clock did not advance) — it need not be predicted.
- E10 **Payloads are stored by reference; lone surrogates are rewritten by the UTF-8 wire encoder** — ingress must clone and
  normalize (R11).
- E11 **Detached nodes read empty / `length` invalid; `.delta` is a live, poisonable cache** (richtext ADR §2) — subtrees built
  before integration must track offsets locally; nothing may hand out `.delta`.
- E12 **One engine instance per graph** (global `$YJS14$` guard, `instanceof` cross-fails — API-NOTES). Production binds one
  vendored engine (`engine.js`); the `bindX(Y)` injection plumbing is a public composition choice (`bindCrdt(Y)` for engine-injecting consumers) and a
  test seam, not something the engine requires (E13).
- E13 **Vendored `.d.ts` generics collapse to `never`** under svelte-check (engine-api.ts:1-15) — structural interfaces are a
  typing constraint only (zero runtime).
- E14 **P4/P5 make index↔item lookups and range reads O(checkpoint gap + range)** (UPSTREAM.md P4/P5 bench). Re-deriving a
  position from an item id is cheap; the facade does not need its own position caches for correctness or speed at editor scale.

Browser (reaches this domain only through the command layer's needs):
- B1 `beforeinput` commands mutate then read positions/lengths inside one transaction (split-then-place-caret, composition
  replacement of the whole intermediate span each event) ⇒ R20 read-your-writes is a hard requirement, not a nicety.
- B2 Remote commits re-render DOM under a live caret; the editor captures anchored selection before the mirror flush and
  re-asserts after (edytor.svelte.ts:845-891) ⇒ anchors must be pure data resolvable after any commit (R17).
- B3 IME: a composition that starts at a fresh split-block start must keep left insertion affinity while staying in its own block
  (`にHello` fixture, delete-contract table) ⇒ "affinity" and "which block owns the gap" are two facts (§5 D5).
- B4 Anchors travel in awareness JSON and must be validated on receipt (selection doc "Presence contract").

Svelte 5:
- S1 `$state` proxies reject `structuredClone` ⇒ ingress uses JSON cloning (`cloneJson`/`sanitizeWireJson`) — runtime-cutover
  defect 3. No rune semantics reach this domain: it is headless by design; the editor layers reactivity on the non-reactive
  `facade.version` token + its own counters.

Lifetime:
- L1 One raw doc can back several views and documents (`attachDocument` dedupe, keyed remounts) ⇒ per-doc derived state must be
  doc-scoped, not view-scoped.
- L2 A borrowed doc may outlive every facade ⇒ doc-scoped observers that must keep working (undo repair) cannot be facade-leased.

NOT constraints (present in code but forced by nothing above):
- The `deltaDeep` event-shape fallback in the run view (runs.ts:1575-1615, plus the insert/delete branches of `facetsOfBlockOp`
  runs.ts:197-225): unreachable with this engine (E8).
- The "bare facade" fresh-collect mode of the model (`bindModel` without `modelState`, placement/model.ts:557-577): production
  always attaches the maintained state (edytor-doc.ts:648, 772); the fresh path serves tests and the undo repair only.
- A second schema-name table (`schema.ts` + `SCHEMA` object, edytor-doc.ts:169-231, whose header says "the two declarations must
  carry identical values").

---

## 3. Fact → authoritative owner → lifetime → consumers

Legend: **⚑ = decided in more than one place** (every decider listed with file:line). Paths relative to `src/lib/crdt/`.
"Replicated" facts live in the Y.Doc (lifetime = doc); "derived" facts must be recomputable from replicated state alone.

| # | Fact | Authoritative owner (today) | Lifetime | Consumers | Deciders |
|---|------|-----------------------------|----------|-----------|----------|
| F1 | Block exists (registry key) | `blocks` root attr | doc | every op, attribution, anchors | reads only: placement/model.ts:471-474, attribution/block.ts:175-178 (own copy), runs.ts:768-778. `isNodeLike` itself is defined 4× (placement:224, runs:164, edytor-doc:545, attribution/block:165 — the last with a different test `'getAttr' in v`). |
| F2 | Block record (type/data/del/content/slices/cands, legacy self-slice fallback) | — none; rebuilt per consumer | derived | model view, run view, oracle | **⚑ 3 builders**: `collectBlocks` placement/model.ts:489-520, `buildRec` runs.ts:748-765, inline collect in `computeAllRuns` runs.ts:1768-1790; the legacy `{t:id,s:B,e:E}` self-slice literal is written 3× (placement:507-515, runs:683-687, runs:1780-1788). |
| F3 | Block is visible / may be targeted | should be one oracle over the derived tree | derived | ops preconditions, mirror, anchors, diff | **⚑ 7 definitions**: `isVisible` (live ∧ self-owned, no ancestor check) placement:364-367; `positionInView` (+ display-ancestor walk) placement:1272-1299; `isVisibleBlock` (second copy of that walk, "mirrors positionInView") edytor-doc.ts:1961-1982; `childrenIndex` (isVisible ∧ dp≠DEAD) placement:419-441; `project` (reachability from root) placement:1224-1263; `mustEscalate` (deleted/hidden/`placements.has`) edytor-doc.ts:1333-1338; `runs.contentItems` (only `deleted`) runs.ts:1686-1689 / `computeAllRuns` (`deleted‖hidden`) runs.ts:1794. Op preconditions disagree: `insertText`/`insertBlock`/`moveBlock`/`mergeBlocks` use the no-ancestor `isVisible` (placement:850, 911, 1048, 1083-1087) while `splitBlock` uses `positionOf` (placement:998) — probe: after `delete(p)`, `insertText(c)`, `insertBlock(parent:c)`, `moveBlock(c→root)` all return `true` on hidden child `c`; `splitBlock(c)` returns `false`. |
| F4 | Display owner of a block's slice list (`owner(b)`, hidden = owner≠b) | `computeOwners` text/model.ts:408-481 (single algorithm ✓) | derived | placement projection, flatten, anchors, repair | single decider; the `?? DEAD` wrapper is repeated (text/model:965, runs:815, placement:279-280) and the result is cached by two independent owners (fresh per `computeOwnership`; maintained `owners` + `ownersVersion` runs.ts:593-821). |
| F5 | Which record/block displays atom *i* of backing text *t* | the per-atom `(g, s0, stamp)` contest | derived (+ replicated inputs) | flatten → every content read/write, anchors | **⚑ 6 deciders**: `computeOwnership` text/model.ts:963-1004; maintained `buildRow` runs.ts:938-958; `claimRoutesToB` (fresh point query) text/model.ts:1139-1166; `undoRepairClaims` (redone-space contest vs normal contest) text/model.ts:1221-1312; insertion-time decisions that *write* new ownership — empty-display revive :1365-1418, left-edge rewrite :1423-1495, right-edge claim :1500-1519; seam override by the anchor `o` facet edytor-doc.ts:2170-2209. `maxG` computed twice (text/model:988-992, runs:951-954). Anchor→range resolution written 4×: `sliceRange` text/model:940-957, `freshRange` :1150-1155, `redoneRange` :1236-1241, `rangeOf` runs.ts:926-927. |
| F6 | Display offset ↔ (backing text, index) | `flatten` segs text/model.ts:1017-1062 (single walk ✓) | derived, per call | every content op, anchors | **⚑ ≥10 offset→seg walks with 3 different boundary rules**: `insertIntoText` (right-edge-inclusive "left wins") text/model:1349-1364; `deleteRange` :1557-1582; `formatRangeIn` :1616-1633; `splitSlices` (per-entry cursor) :1693-1774; `marksAlready` edytor-doc.ts:1896-1923 (copy of formatRangeIn's walk); `anchorAt` (affinity-dependent `inside`) edytor-doc.ts:2074-2116; `resolveAnchor` inverse walks :2187-2207 and :2245-2256; `emissionOffset` (per-entry contribution re-derived from intervals) :2000-2050; `removeInline`/`setInlineData` array-position scans placement:1159-1175, 1196-1211; clamp re-derived in facade `deleteText` edytor-doc.ts:2405-2407; `displayLength` materializes all content to count :1859-1866 (instead of summing seg widths, text/model:1065). |
| F7 | Visible content of a block | should be one maintained per-block projection | derived | render, DocChange, JSON export, command reads | **⚑ 2 live readers + 1 oracle**: maintained runs `computeFresh` runs.ts:1032-1076 and transaction-aware items `T.contentItemsOf` text/model.ts:1095-1112 (via runs.ts:1682-1690, placement:1242-1247); `computeAllRuns` runs.ts:1763-1802 (oracle). nodes.ts:70-78 documents runs as "commit-synced" vs items "transaction-aware" — false: `runs()` calls `syncTransaction()` and recomputes mid-transaction (runs.ts:1206-1215); probe: `transact(() => { insertText('b',2,'c'); runs('b') })` returns `abc`. Adjacent-equal-mark merging implemented 3× (text/model:357-366, runs:1047-1059, runs:266-286). |
| F8 | Winning placement, display parent, sibling order | `resolvePlacements` placement:273-361 + `displayParentOf` :381-386 ✓ | derived | projection, ops, anchors | order computed by **⚑ 2 builders** `childrenOf` :396-410 and `childrenIndex` :419-441 ("ordering is identical"); **⚑ 5 display-ancestor walks**: resolvePlacements cycle test :307-319, `isSelfOrDescendant` :669-687, `positionInView` :1283-1295, `isVisibleBlock` edytor-doc:1970-1980, `ancestorsOf` edytor-doc:1051-1059. |
| F9 | Reading order of split-born siblings | **nobody** (rank is random in gap; text partition is decided by the ownership contest) | — | user | Two independent deciders of one user-visible fact: ownership contest (text/model:124-128) vs `rankAt` (placement:1006-1008). Probe: concurrent `split(b1,3)` ‖ `split(b1,8)` renders `hel │ rld │ lo wo` in **16/40** client-id pairs (convergent, wrong reading order). |
| F10 | "Did this op change anything?" (semantic no-op) | the transaction's actual effect (E8/E9) | per transaction | attribution stamping, lineage, return values | **⚑ decided per op, twice**: model return shapes disagree — `insertIntoText('')` → true (text/model:1348), `deleteRange` empty → true (:1561), `formatRangeIn` empty → false (:1620), inline ops not-found → false; facade re-derives: `text !== ''` edytor-doc.ts:2388-2391, delete clamp :2405-2410, `marksAlready` :1887-1925 (+ calls :2426, :2437, :2460), setInlineData runs scan :2520-2525, same-type :1831, `jsonEquals` data :1846, `wrote` accumulation in `setBlock` :2293-2312, type-reset guard :1734; attribution-side suppression block.ts:355-373. |
| F11 | "Has derived state caught up with writes?" (freshness) | should be one per-doc counter | per doc | memoized reads, editor projection cache, DocChange | **⚑ 5 counters/baselines**: facade `stateVersion` bumped by `write()` and every update edytor-doc.ts:797-852; facade view memo :990-1004; run-view `version`/`structureVersion`/`placementVersion`/`dirty`/`stamps` runs.ts:593-633, 1159, 1527-1528, 1616-1631; `committedClaims` fingerprints (a second commit baseline) runs.ts:920, 1406-1413; DocChange `lastSeenSeq` edytor-doc.ts:1308, 1405. |
| F12 | Which (block, facet) a transaction touched | `transaction.changed` (E8) | per transaction | run invalidation, DocChange fast path, repair, lineage | **⚑ 5 interpreters**: `applyTypeChange` synthesizes a fake delta op `{type:'modify', value:{attrs:{[sub]:{}}}}` runs.ts:1466-1498 only to feed it back through the delta parser `facetsOfBlockOp`/`facetOf` runs.ts:179-225; legacy `deltaDeep` path runs.ts:1575-1601 (unreachable, E8); extent index walks `insertSet`/`deleteSet` runs.ts:516-574; undo-repair walks `insertSet` twice + the whole store undo-repair.ts:187-211; lineage `captureTouched` walks the stack item's id sets with its own ancestor climb edytor-doc.ts:1533-1553. |
| F13 | Commit is "content/meta only" (DocChange fast path eligible) | run view `commitFast` runs.ts:1622 | per commit | DocChange | **⚑ 2**: `commitFast` (runs.ts:905, 1586, 1608, 1622) and `diffFast`'s own re-validation `mustEscalate` edytor-doc.ts:1333-1340 (escalates to full diff). Two diff algorithms: `diffSnaps` :1201-1300 and `diffFast` :1320-1387. |
| F14 | Document content decided (readiness) | `EdytorDocument._readiness` document.ts:415 | document | history, views, sync | **⚑ 3**: `_readiness` (document.ts:621-650); `isInitialized(doc)` = `meta.v` present used by `history` getter document.ts:689, `createUndoManager` edytor-doc.ts:1521-1523, admission verdict admission.ts:148; the provider-pending gate is held twice — `_pendingSyncs` document.ts:431/874-893 and facade `syncPending` edytor-doc.ts:820, 2599-2605 (`_markSyncPending`/`_clearSyncPending`). Probe §7-C14: a pending document with hydrated bytes throws the facade's `EdytorDocSyncPendingError` from `history` instead of the documented `DocumentNotReadyError`. |
| F15 | Lifetime of per-doc derived services | should be the doc | doc | runs view, repair, ring trim, document dedupe, rand | **⚑ 4 policies**: refcounted lease + doc-destroy teardown (runs.ts:411-443, 1653-1670); never-detach WeakMap (undo-repair.ts:98, 393-401; attribution/block.ts:471-551); dedupe WeakMap + refs (document.ts:1089, 425, 1010-1066); module WeakMap (rand.ts:10). Plus facade `disposed` edytor-doc.ts:810, document `_destroyed` document.ts:416, attribution `destroyed` attribution.ts:205, and `_historyDead` via monkey-patching `UndoManager.destroy` document.ts:756-761. |
| F16 | Undo capture scope / tracked origins | UndoManager on the registry root edytor-doc.ts:1524; origins document.ts:401; `captureTransaction` document.ts:747 | document | history | single decider ✓ (bookkeeping origins: `UNDO_REPAIR_ORIGIN` undo-repair.ts:107, `ATTRIBUTION_ORIGIN` attribution.ts:59, `LINEAGE_TRIM_ORIGIN` attribution/block.ts:559). The lineage capture before undo commits under the *default* origin (edytor-doc.ts:1554) and relies on the `blockattr` root being out of scope. |
| F17 | Which block owns a caret at a stream seam | — | per anchor | selection, presence, history restore | **⚑ 2 deciders**: generic affinity-side atom ownership edytor-doc.ts:2210-2256 and the `o`/`a<=-2` override edytor-doc.ts:2098-2111 (mint), 2170-2209 (resolve). Same missing fact as F5's left-edge rewrite and revive: a seam between two streams in one backing text has no identity. |
| F18 | Block incarnation (id reuse) | `b/<id>.i` stamp attribution/block.ts:163, 328-353 | doc | attribution | walks the local-only `redone` chain (block.ts:304-319) — the same engine internal (E5) the undo repair walks. |
| F19 | Schema role/attr names | `schema.ts` | build | all layers | **⚑ 2 tables**: `schema.ts:14-42` and `SCHEMA` edytor-doc.ts:169-231 ("the two declarations must carry identical values"). |
| F20 | Ingress normalization (clone + lone-surrogate fix) | should be one boundary per op | per call | every write | **⚑ ≥12 sites**: `sanitizeSpec` placement:748-773 then `materializeSpec` clones again :794, :810; `buildInline` :601-607; `insertIntoText` text/model:1337-1340; `formatRangeIn` :1615; `setInlineData` twice (edytor-doc.ts:2512 and placement:1206); `setBlockType` :1828; `setBlockData` :1845; split `newId` three times (placement:996, edytor-doc.ts:1661, nodes.ts:195); `stampSpecTree` :679; `marksAlready` :1895; `mergeUnnesting` :1730; `duplicateBlock` :2374. |
| F21 | Structural policy (void/island) per type | `EdytorDocument._roles` document.ts:426 via `roleOf` | document | facade ops | single ✓ — but resolved through `ancestorsOf` → `positionInView` per level on every move (edytor-doc.ts:1063-1085), recomputing F8 per call. |
| F22 | Attribution stamp (who changed block X in this transaction) | per-op `stampTouched`/`stampMerged`/`stampCreated*` edytor-doc.ts:873-900 | transaction | `b/` records, `l` attr | decided at ~20 call sites (every op), each paired with a pre-write `lineagePending` capture; should follow F10/F12 (the transaction's touched set). |

---

## 4. Machinery inventory

xloc measured with the range variant of the same counter (`xrange.mjs`, identical per-line rules). Classes:
REQUIRED (a guarantee in §1 needs it in any design), CONSTRAINT-DRIVEN (forced by a §2 fact *given the current representation*),
HISTORICAL (exists because of an earlier choice; the replacing invariant is named). "→A/B/C" = which §6 candidate retires it.

### 4.1 Text ownership — `text/model.ts` (1014) + `undo-repair.ts` (196)

| Mechanism | Where | xloc | Class | Retiring invariant |
|---|---|---|---|---|
| Range-read projection (engine pieces → items; canon mark keys; freeze/intern boundary; inline item read) | text/model.ts:166-375 | 104 | REQUIRED (E11, E14, R21) — `inlineItemOf`'s serialized-`{attrs}` branch (:316-325, ~10) is HISTORICAL (no `.delta` reader remains) | — |
| Merge-claim graph `computeOwners` (+DEAD) | :377-481 | 71 | REQUIRED (R7 merges, cycles, delete-beats-merge) | — |
| Relative-position codec for carets (`resolveAnchor`, `atomAnchorAt`) | :841-874, :891-930 | 38 | REQUIRED (R17, E6) | — |
| Display walk `flatten` + `ownedLength` | :1006-1065 | 42 | REQUIRED (a block's display streams) | — |
| Plain content writes (insert prelude/locate, delete validated right-to-left, format) | :1314-1364, :1496-1499, :1523-1635 | 105 | REQUIRED (R13 validate-then-write) | — |
| **Slice-record model**: payload types/guards/stamp/`ClaimKey`, `readSliceEntries`, record `anchorAt` (B/E sentinels), `sliceRange` | :47-164, :876-889, :932-957 | 87 | CONSTRAINT-DRIVEN by today's representation; HISTORICAL vs requirements | →A: "a stream boundary is an atom in the backing text; a stream = the atoms between two boundary atoms" — no anchored ranges exist to resolve |
| **Per-atom contest**: interval index + queries, lazy-expiry heap sweep, `gatherClaims`, `computeOwnership`, `maxG`, `claimRoutesToB` | :483-799, :959-1004, :1124-1166 | 239 | same | →A: "every text position lies in exactly one stream; its block is the stream's (claim-resolved) displayer" — nothing to contest, no generations |
| **Insertion-time ownership repair**: empty-display revive, left-edge record rewrite, right-edge rival claim | :1365-1418, :1419-1495, :1500-1519 | 82 | same (the seam has no identity, so ownership is re-asserted by writing records per keystroke — 68 B/keystroke measured, §7-C7) | →A: "inserting at a seam chooses a side of the boundary atom by caret affinity" |
| **Split planner**: `materializeSegs` + `splitSlices` (keep/move/cutRecord/cutClaim) | :1637-1791 | 105 | same | →A: split = insert one boundary atom + move the claims that follow the split point |
| **Undo-resurrection repair**: `undoRepairClaims` (redone-space contest) + `undo-repair.ts` (keep/redone detection, span walk, follow-up transaction, `changed`-map union into the host transaction) | text/model.ts:1168-1312; undo-repair.ts (all) | 76 + 196 | HISTORICAL (E5): exists because ownership is keyed on character items that undo re-creates | →A: "ownership is keyed only on boundary atoms; undo copies are integrated between the same boundaries (UndoManager.js:458-528)" |

### 4.2 Placement — `placement/model.ts` (829) + `rank.ts` (113)

| Mechanism | Where | xloc | Class | Retiring invariant |
|---|---|---|---|---|
| Rank codec (Logoot digits + client tiebreak, bounded append window) | rank.ts | 113 | CONSTRAINT-DRIVEN (E1) | — |
| Candidates + atomic `{p,r}` write + top-2 compaction + acyclic greedy resolution + deterministic rehome (incl. record/view types) | placement:128-361, 522-539 | 126 | CONSTRAINT-DRIVEN (E1, R3, R6) | — |
| Visibility / children order / positions / ancestor walks | :363-441, :656-687, :1265-1347 | 119 | REQUIRED, but 2 child-order builders and 5 ancestor walks (F3, F8) | →B: one maintained tree index answers visible/position/ancestors |
| Record collection + fresh `view()` | :467-520, :541-577 | 60 | HISTORICAL | →B: "derived state has exactly one owner per doc and is always attached" |
| Dead helpers `contentOf`, `slicesNodeOf`, `appendItems` | :589-594, :611-622, :633-654 | 27 | dead (no call site) | delete |
| Spec ingress (`sanitizeSpec`), materialization, bulk insert, id-collision refusal | :734-889 | 94 | REQUIRED (R11, R12) — `materializeSpec` re-clones already-sanitized payloads (:794, :810) | — |
| Structural ops (delete/move/moveBlocks/nest/unnest/split/merge) | :891-1074 | 122 | REQUIRED | — |
| Content/inline op wrappers (incl. `toArray` position scans for inline ids) | :1076-1214 | 113 | REQUIRED wrappers; inline scans duplicate offset location (F6) | →A (one `locate`) |
| Canonical projection `project` | :1216-1263 | 35 | REQUIRED (R2 comparison surface, R18 `added`) | — |

### 4.3 Maintained view — `text/runs.ts` (1184)

| Mechanism | Where | xloc | Class | Retiring invariant |
|---|---|---|---|---|
| Run construction, structural sharing, interning, commit-bound publication with listener isolation | :662-679, :1024-1215 | 138 | REQUIRED (R19, R21, R22) — `subscribeBlock`/`subscribe`/`blockVersion`/`snapshot`/`debug` have **zero** consumers outside `src/lib/crdt` (tests only) | — |
| Dependency capture (`flattenTracked`, consumer maps) | :969-1022 | 43 | REQUIRED (R22 granularity) | — |
| Placement/children facets (lazy, versioned) | :823-840 | 21 | REQUIRED (maintained tree) | — |
| Transaction fold + commit handling (`applyTypeChange`, `handleBlockChange`, `syncTransaction`, `handleEvent`) | :1272-1634 | 238 | CONSTRAINT-DRIVEN (E7, E8, R20) — contains HISTORICAL parts: fake-op synthesis (:1466-1498) re-parsed by `facetsOfBlockOp` (:197-225), the unreachable `deltaDeep`/empty-`changed` fallbacks (:1575-1615), `claimRefinable`/`claimKeySet`/`committedClaims` (:1298-1321, :920, :1406-1413) | →B: "invalidation reads `transaction.changed` directly; each changed entry is folded once" |
| Record index for the contest (`recordsByText`, union-ever `effects`, `indexEffects`, per-text atom rows, rangeCache) | :581-600, :681-746, :922-967 | 100 | CONSTRAINT-DRIVEN by the contest | →A |
| U8b extent narrowing (id-set walk → edited spans → fresh+stale row intersection) | :456-575, :1217-1270 | 89 | CONSTRAINT-DRIVEN (siblings share one backing text) | →A shrinks to "edited item → containing stream" |
| Lease/refcount wrapper around one view per doc | :400-443 | 32 | HISTORICAL | →B: "derived state lives exactly as long as the doc" (the repair and ring-trim listeners already follow this rule) |
| `ownShim` + `ctx` adapter (maintained state dressed as the fresh `Ownership`/`ModelView` shape) | :842-894 | 33 | HISTORICAL | →B: one owner ⇒ one interface |
| `computeAllRuns` + `mergeRuns` (fresh oracle) | :1758-1805, :259-286 | 59 | test oracle in production code | move to tests |
| `decorateRuns` + decoration types | :118-155, :1807-1937 | 108 | no production consumer (0 references outside crdt; 5 test files) | delete until a plugin needs it |

### 4.4 Facade — `edytor-doc.ts` (1504)

| Mechanism | Where | xloc | Class | Retiring invariant |
|---|---|---|---|---|
| Schema name table (second copy of `schema.ts`) | :160-243 | 35 | HISTORICAL | one table |
| Schema gate reads, typed errors, `assertUsableDoc` | :245-423 | 90 | REQUIRED (R23, E12) | — |
| Bootstrap `init` (+ per-spec fallback after bulk refusal) | :667-762 | 48 | REQUIRED (R23) | — |
| Write funnel + `stateVersion` + view memo | :764-852, :983-1004 | 35 | HISTORICAL (second freshness counter over an already-synced shared state) | →B |
| Reads, roles (void/island), doc-order navigation | :1006-1135 | 79 | REQUIRED (R14, baseline merge targets) | — |
| DocChange: skeleton snapshot + full diff + fast patch + validation escalation | :1137-1461 | 239 | REQUIRED (R18, R19) with two algorithms (F13) | →B: DocChange assembled from the owner's per-commit report (changed parents' old/new child lists + recomputed blocks) |
| Undo manager factory (+ lineage undo/redo wrapping) | :1480-1572 | 54 | REQUIRED ~20 (R15); lineage wrap ~34 is feature | — |
| Structural/metadata ops with island/void policy (insert, moves, split, merges, baseline merge shapes, delete, setType/Data, setBlock, duplicate) | :1574-1852, :2259-2376 | 260 | REQUIRED (R14) — `setBlock` children replacement is not all-or-nothing (§7-C4) | — |
| Content op wrappers | :2378-2531 | 118 | REQUIRED wrappers; ~50 of them re-derive no-op-ness and thread attribution/lineage per op (F10, F22) | →C |
| `marksAlready` (predicts whether the engine's format will write) | :1868-1925 | 36 | HISTORICAL (E9) | →C: "an op's effect is observed from the transaction, not predicted" |
| Caret anchors: `anchorAt` (+ `a:-2`/`o` mint), `resolveAnchor` (+ `o` rebase, outward scan), `emissionOffset` | :1984-2257 | 168 | REQUIRED ~35 (R17); ~130 HISTORICAL | →A: "a stream start is an atom a caret can bind; every position is in exactly one stream" |
| `isVisibleBlock` (second copy of the display-ancestor walk) | :1949-1982 | 20 | HISTORICAL | →B |
| Attribution/lineage helpers + ~53 per-op stamping/capture lines | :854-981 + op bodies | ~120 | REQUIRED feature (R25); per-op placement is HISTORICAL | →C: stamp once per transaction from the touched set; capture lineage at first touch in the write funnel |
| Facade object (≈75 members; ~20 have no consumer outside `src/lib/crdt` — e.g. `pathOf`, `parentOf`, `islandOf`, `crdtId`, `resolveBlock`, `blockVersion`, `subscribeBlock`, `contentJSON`, `previous/nextInDocOrder`, `ancestorsOf`; a few such as `blockText` are documented headless API) | :2557-2702 | 86 | REQUIRED surface, oversized | narrow to the documented headless API + what the editor calls |

### 4.5 Lifecycle, attribution, adapters

| Mechanism | Where | xloc | Class | Retiring invariant |
|---|---|---|---|---|
| `EdytorDocument`: readiness state machine, admission on every entry path, provider pending/failed settle, lazy history, refs/dedupe, semantics adoption, owned/borrowed teardown | document.ts | 552 | REQUIRED (R23, R24) — HISTORICAL parts: facade-side duplicate pending gate (edytor-doc:820, 2593-2605, document.ts:879-893 ~15), `_retain` next to `retain` (~8), duplicated lineage-depth validation (document.ts:1099-1105 vs edytor-doc.ts:913-924, ~8), `UndoManager.destroy` monkey-patch (~10, defensive) | one pending gate; one retain |
| Admission doorway (verdict + staged `admitUpdate` + re-exports) | admission.ts | 61 | REQUIRED ~30; re-export lines HISTORICAL | — |
| Block attribution: records, incarnation stamp (walks local `redone`, E5), stamps, lineage ring + convergent receive-side trim | attribution/block.ts | 262 | REQUIRED feature (R25); `blockRecordsOf` (23) is a test/projection helper | — |
| Actor dictionary + legacy `a/` reads + history view | attribution/attribution.ts | 125 | REQUIRED feature | — |
| Typed block handles (`document.block(id)`) — every facade op re-exposed per id | nodes.ts | 104 (37 type body) | REQUIRED as an API choice (editor block wrappers hold them) | — |
| Vendor store walks (`clientsOf`, `structAt`, `walkIdSetStructs`) | structs.ts | 71 | CONSTRAINT-DRIVEN (E5/E8 internals) — 3 of 4 callers disappear with A | — |
| Barrel with "advanced internals deliberately exported" for tests | index.ts | 151 | ~100 HISTORICAL | tests import modules directly |
| Structural engine typings | engine-api.ts | 34 | CONSTRAINT-DRIVEN (E13, typing only) | — |

---

## 5. Distinctions that must stay explicit

| # | Keep separate | Bug if merged |
|---|---|---|
| D1 | **Where characters are stored** (items in a backing text — identity) vs **which block displays them** | Copy-on-split/merge: an offline peer's edit/format to moved text lands on dead items — the v13 copy-move corpus classes `lost-edit`, `duplicate-inline`, `lost-identity`, `resurrected-delete` (move ADR evidence). R4 fails. |
| D2 | **Block identity** (registry key, never moves) vs **placement** (replicated `{parent, rank}` candidates) | Physical nesting needs a move primitive the engine lacks (E1); copy-move gives `duplicate-placement`/`cycle` classes; concurrent parent+rank from two writers could mix (the reason `{p,r}` is one attr). |
| D3 | **Deleted** (explicit replicated flag; wins) vs **hidden** (claimed by a merge, or under a deleted ancestor; derived) | If a merge set the delete flag, undoing the merge could not restore the source and "delete destination voids the merge" (ST02b) would be inexpressible. If hidden-by-ancestor were a flag, a concurrent move of the child out would need a write to un-hide. |
| D4 | **Causal identity of an anchor** (which item it follows) vs **insertion affinity** (which side of a same-gap insert it stays on) | A caret absorbs boundary inserts or a range start swallows inserted text (R17 rules 2, 5). |
| D5 | **Gap ownership** (which block a position belongs to) vs **affinity** | Today both are squeezed into the sign of `a.a` plus the `o` facet (edytor-doc.ts:2098-2111, 2155-2170); the delete-contract names the resulting `nにello` corruption when they were one fact. Under §6-A they separate structurally: ownership = containing stream, affinity = relpos `assoc`. |
| D6 | **Local-only engine state** (`redone`, `keep`, `followUndoneDeletions=true`) vs **replicated state** | Replica-dependent ownership: the undoing replica and receivers derive different trees from identical bytes (undo-ownership ADR "Why followUndoneDeletions=true is not the fix"). |
| D7 | **Local observation** (one merged observer frame) vs **replicated guarantee** (atomic state on every replica) | The R3 repair makes the undoing replica's subscribers see one repaired frame, but receivers apply two updates and render the torn state in between (probe: after msg1 the receiver shows `hello world│`, after msg2 `hello │world`). Treating the local frame fix as the guarantee hides a remote-visible transient. |
| D8 | **Transaction-aware reads** (commands) vs **committed publication** (subscribers) | Subscribers see half-finished snapshots / change-then-revert noise (R19), or commands read stale lengths mid-transaction (R20, B1). Note the distinction is about *publication*, not about *which reader*: `runs()` is already read-your-writes (probe), so two content readers are not needed to keep it. |
| D9 | **Refused** vs **no-op** vs **applied** op result | A boolean conflates them: `deleteRange` empty ⇒ `true`, `formatRangeIn` empty ⇒ `false` (text/model.ts:1561, 1620), so the facade re-derives no-op-ness per op (F10); `setBlock` returns `true` after a partially refused children replacement (§7-C4). Attribution stamps no-ops or misses real writes when these disagree. |
| D10 | **Definition-level policy** (void/island roles from plugins) vs **document state** | Storing roles in the doc makes replicas with different plugins read a different document; not reconciling them lets two views impose incompatible rules on one doc (the `SemanticConflictError` path, document.ts:569-595, is the right boundary). |
| D11 | **Engine doc lifetime** vs **document lifetime** (references) vs **view lifetime** | Undo repair disarmed after the last facade dispose (Gate-H window); a borrowed doc destroyed by its borrower; sibling views losing the maintained view when one unmounts (runs.ts lease comment). |
| D12 | **Admission verdict** (fresh/initialized — a property of bytes) vs **readiness decision** (pending/local/hydrated — who decided) | A local seed mislabelled hydrated when a schema stamp lands before the provider settles (D15 in edytor-doc.ts:408-423). Keep both, but hold each once (F14). |
| D13 | **Transport success** (update integrated) vs **operation success** (the intended ownership/structure holds) | The undo repair's two-update commit (D7) and `loadDocument`'s scratch-then-gate (admission.ts:183-192) exist because integration success says nothing about schema/ownership validity. |
| D14 | **Monotonic attribution** (`contributors`, outside undo scope) vs **restorable attribution** (`lastChangedBy`, inside undo scope) | Undo strips contributors, or fails to restore the previous last changer (attribution/block.ts:13-25). |
| D15 | **Model capability** (the engine can represent a move into a void) vs **permission** (the viewer's policy forbids it) | Enforcing policy in the replicated model would make remote writes from a differently-configured peer unrepresentable; enforcing capability in the facade would reject legal concurrent states. Keep policy at op time, representation policy-free (edytor-doc.ts:57-81). |
| D16 | **Definition vs occurrence of an id** | The same caller id reused in a replacement spec (`setBlock` children) is a *new occurrence* of a *deleted definition*; the registry treats it as a collision and silently drops it (§7-C4). Replacement must mint or explicitly revive, never both implicitly. |

---

## 6. Representation candidates

The diagnostic pattern behind most of this domain's machinery is one **missing fact**: *the boundary between two blocks'
streams inside one backing text has no identity.* Today a boundary is only "where two anchored claim records meet", so every
situation that touches a seam re-decides ownership: the insert path writes records (revive / left-edge rewrite / right-edge
claim), the anchor path invents an owner facet (`a:-2` + `o`), the undo path replays a redone-space contest and writes repair
records, and the run view needs an interval contest plus fresh/stale row intersection to know who changed. Candidate A adds the
missing fact; B and C remove duplicated owners of facts that already exist.

### A. Stream starts are atoms ("boundary atoms") + whole-stream merge claims

**What is represented.** A backing text holds characters, inline atoms, and *boundary atoms* `{s: blockId, n: incarnation}`
(a ContentAny embed; never displayed). A fresh block's stream is its own text from index 0 to the first live boundary; a
split-born block's stream is the atoms after its boundary up to the next live boundary. A block's display = its stream followed
by the displays of the blocks named by its ordered merge claims (`{m}` entries — the only list entries left). `owner(b)` over
claims is unchanged. **Every text position belongs to exactly one stream**; its display block is `owner(streamBlock)`.

**Behavior that follows.**
- Split = insert one boundary atom at the located position + move the claims that follow the split point to the new block.
  Concurrent splits at different points ⇒ nested partition (two boundaries); at the same point ⇒ two adjacent boundaries, one
  empty stream (TX04a/b) — by YATA order, no contest code. Split vs merge of the source (TX05c), split vs delete (ST02a/d),
  late offline edits (TX01, TX07) all fall out of "which boundary is to my left".
- Typing at a block start = insert right after its boundary; at a block end = insert right before the next boundary; into an
  empty block = between its boundary and the next. No revive, no left-edge rewrite, no right-edge claim, no generations
  (probe C7: 68 B/keystroke → the ordinary ~15 B).
- A caret at a split-born block's start binds the boundary atom with left assoc; it stays in its block when the neighbour
  receives text at the shared gap (inserted before the boundary) and when the block is split again at 0 (the new boundary lands
  after it). The `o` facet and `a:-2` encoding disappear; history independence holds by construction (probe C3 currently fails).
- Undo of a text delete: `redoItem` integrates the copy between the tombstone's current left neighbour and the tombstone
  (UndoManager.js:458-528), i.e. between the same two live boundaries ⇒ it re-enters the same stream on every replica, in the
  same single update. No repair, no second wire update, no torn receiver frame (probe C2). One exception must be accepted or
  engineered away: if a *concurrent* split inserted a new boundary exactly at the deletion gap before the undo (A-5 in §7), the
  copy lands in that new block — the engine's public `insert` places a new boundary before a run of tombstones, and choosing
  "after the tombstones" needs an insert-after-item primitive the public API does not expose.

**Machinery that disappears** (measured, §4): slice-record model 87, per-atom contest 239, insertion-time ownership repair 82,
split planner 105 (→ ~35), `undoRepairClaims` 76 + `undo-repair.ts` 196, contest record index in the run view 100, U8b
narrowing 89 (→ ~25 "edited item → containing stream"), claim-churn refinement ~30, anchor `o`/emission/outward-scan ~130,
3 of 4 `structs.ts` callers. Net ≈ **−1,000 xloc** after adding a boundary index (~50) and one `locate`/`position` pair (~40).

**Invariant that replaces it.** *Ownership is keyed only on boundary items: a position's block is a pure function of the live
boundary atoms to its left in the same text and the merge-claim graph. No replicated fact references character items.*

**Costs, stated honestly.**
- Pinned choices change: TX06a (a *concurrent remote* insert exactly at a split seam always goes head-side) becomes a YATA
  tie-break side (deterministic, convergent, client-order dependent); TX04a's winning sibling may differ.
- Schema v2. v14-schema-1 documents carry slice records; converting them needs today's contest code once. Kept as a migration
  module it is *moved, not deleted* (~300 xloc); declaring pre-release schema-1 documents unsupported costs 0. This is a
  maintainer decision, not an engineering detail.
- New invariants that need one owner each: content deletes never delete boundary atoms (the per-stream delete must be the only
  delete path); two boundary atoms naming one block id (concurrent same-id creation) are resolved by the incarnation nonce
  (non-matching atoms are inert); every read path skips boundary atoms (one predicate in the range-read projection).
- Reading order of concurrently split siblings (C1) is still decided by placement ranks. Boundary order offers the fix (derive a
  split-born block's placement from "after the displayer of the preceding stream"), but that is a placement-model change —
  not counted.

### B. One derived-state owner per doc, advanced by folding each change exactly once

**What is represented.** A single per-doc index (lifetime = the engine doc, like the undo-repair and ring-trim listeners
already are) holding block records, streams/claims, owners, placements, children index, runs cache and the *previous committed*
children index. It is advanced only from `transaction.changed`/`insertSet`/`deleteSet`, folding each (type, sub) entry once
per transaction (a fold cursor), and it receives the transaction object explicitly in commit hooks (E7). Model, facade,
anchors and DocChange read only through it; `version` is its own counter.

**Machinery that disappears:** fresh-collect `view()` + `collectBlocks` (60), the lease wrapper (32), `ownShim`/`ctx` (33),
the unreachable `deltaDeep`/empty-`changed` fallbacks and the fake-op → delta-parser round trip (~75), facade `stateVersion` +
view memo (35), the second display-ancestor walk `isVisibleBlock` and the second child-order builder (~35), the DocChange
fast/slow split and its escalation check (~110 of 239), `computeAllRuns`/`mergeRuns` moved to tests (59). ≈ **−440 xloc**.
Also removes the quadratic in-transaction re-fold (probe C10: 2,000 inserts in one transaction 2,968 ms vs 746 ms as
separate transactions; per-op cost grows with transaction size) — the paste path inserts children one by one
(block.svelte.ts:901-928).

**Invariant.** *Derived facts have exactly one owner whose lifetime is the doc's; each replicated change is folded into it
once; every read and every publication goes through it.* Visibility (F3), freshness (F11), change classification (F12) and
commit-fast eligibility (F13) then each have one decider.

**Risk.** DocChange must stay exact for the mirror; keep today's `diffSnaps` as a test oracle while the index-derived report
replaces it.

### C. An op's effect is observed, not predicted

**What is represented.** Model ops return `'refused' | 'noop' | 'applied'`; `noop` vs `applied` is read from the engine
(this client's clock advanced during the op — inserts and format items — or the op deleted a non-empty *located* range, which
`locate` already computes once); attr writes go through one
"set if changed" guard (the engine writes a new item for equal values). The write funnel accumulates `touched` block ids plus
explicit creation/inherit/union intents and stamps attribution once at the end of the outermost facade transaction (still the
same update — U2); lineage captures the pre-write subtree at the first write to a block in that transaction.

**Machinery that disappears:** `marksAlready` (36, "S13" admits it re-walks what `minimizeFormatChanges` resolves), the
clamp/same-value/`wrote` re-derivations (~20), per-op `lineagePending`/`stampTouched`/`commitLineage` threading (~53 lines in
op bodies + ~30 of helpers) → ~30 in the funnel. ≈ **−110 xloc**, and one decider for F10/F22 instead of ~20.

**Invariant.** *The transaction's effect set is the only source of truth for "did this op change anything" and "which blocks
did this transaction touch".* It also fixes the result-shape inconsistencies (D9) and gives `setBlock` a place to refuse
before writing (C4).

---

## 7. Falsifying counterexamples

All "observed" results come from throw-away probes run against the current tree (vitest, scratchpad
`probes-arch-crdt/p1…p7`; no repo files modified). Each scenario is the smallest one I found that exposes the abstraction.

| # | Shape | Scenario (minimal) | Observed | What it falsifies |
|---|---|---|---|---|
| C1 | concurrent + nested structure | `b1='hello world'`; A `split(b1,3,'sA')` ‖ B `split(b1,8,'sB')`; sync | 16/40 client-id pairs render `hel │ rld │ lo wo` (convergent, wrong reading order) | "content partition and placement are independent facts": reading order of split-born siblings is one user-visible fact decided by two unrelated mechanisms (ownership contest text/model.ts:124-128 vs random in-gap rank placement:1006-1008). TX04b only asserts the *set* of ids. |
| C2 | undo × remote delivery (mid-way state) | split `hello world` at 6 → `t='world'`; delete `t[0,5)`; `undo()`; deliver the two resulting updates one at a time | undo emits 2 wire updates; receiver after the first shows `b='hello world', t=''`, after the second `b='hello ', t='world'` | "undo restores text to its pre-delete owner" as a replicated guarantee: it holds for the undoing replica's observer frame only (D7). Any receiver, persisted row boundary or relay that splits the pair exposes the torn ownership; selections anchored on the deleted-then-restored atoms resolve into `b` until the second update lands. |
| C3 | same definition, different history | Direct: `alpha` + separate block `d2='Hello'`; split-born: `alphaHello` split at 5 → `tail`. Caret `anchorAt(block,0,'left')`, then split that block at 0 | direct caret → `{dNew,0}` (follows the text); split-born caret → `{tail,0}` (stays in the emptied block) | the `a:-2`/`o` owner facet (edytor-doc.ts:2098-2111, 2170-2209): the delete-contract's "history independence" requirement only has a pinned test for the append-into-predecessor edit (anchors.test.ts:404-437). |
| C4 | failure midway; same id in a new position | `b` has child `c1`; `setBlock(b, {children:[{id:'c1',…},{id:'c2'}]})` | returns `true`; children = `[c2]`; `c1` gone (old one del-flagged, new one refused as a registry collision, edytor-doc.ts:2314-2334). Retrying the same call can never succeed: the id stays taken by the deleted definition | R13 "apply fully or refuse before the first write" and the boolean result shape (D9, D16). Reachable through the public `setBlock`/`DocBlock.set` whenever a caller passes the existing children's ids (e.g. round-tripping `block.value`; block.utils.ts:451-472 keeps caller ids via `jsonBlockToSpec`, json.ts:349-355). In-repo callers happen to be safe today: they mint fresh ids (markdownShortcuts.ts:88-95, richTextOperations.ts:156-158) or strip them (clipboard `stripIdsFromBlock`). |
| C5 | concurrent delete vs nested move | A `deleteBlock('p')` ‖ B `moveBlock('c' (child of p) → root)`; sync | `c` visible at root on both replicas | the move ADR's "the block and its subtree are hidden": subtree deletion is emergent (per-block flag + per-block placement). MV06a only covers `delete(x) ‖ move(x)`. Needs a contract decision (rescue vs delete-wins-subtree), not a patch. |
| C6 | targets hidden by an ancestor | after `deleteBlock('p')`: `insertText('c',…)`, `insertBlock({parent:'c'})`, `moveBlock('c'→root)`, `splitBlock('c',…)` | `true, true, true, false` | one "targetable/visible" definition (F3 lists 7). `moveBlock` locally resurrects a subtree the same user just deleted, through the public API. |
| C7 | IME / repeated edge edits | split `hello world` at 6; type 20 chars at `t` offset 0 one per transaction, vs 20 in the middle | 68.2 B/keystroke at the edge vs 15.0 B in the middle; one slices record deleted+reinserted per keystroke (tombstones grow with keystrokes); a composition at a split-block start rewrites the record on every composition event | "split/merge cost O(record)": the seam cost is deferred to every later keystroke at the seam (ADR records 72.8 B/char as a U11 candidate). |
| C8 | empty collection | `moveBlocks([], dest)` vs `insertBlocks(doc, dest, [])` | `false` vs `true` | result shapes decided per operation (D9). |
| C9 | fact read mid-transaction | `transact(() => { insertText('b',2,'c'); runs('b') })` | `abc` | nodes.ts:70-78's "runs are commit-synced, items are transaction-aware": both readers are read-your-writes (runs.ts:1206-1215); the second content reader (F7) has no distinct job. |
| C10 | large transaction (paste) | 2,000 `insertBlock` calls inside one `transact` vs 2,000 separate transactions | 2,968 ms (1.48 ms/op, per-op cost ∝ transaction size) vs 746 ms | "read-your-writes is free": every model read re-folds the whole accumulated `changed` map (`syncTransaction`, runs.ts:1515-1530); `insertChildren` pastes one child at a time (block.svelte.ts:901-928). |
| C11 | generated value needed after a boundary | `insertBlock({id:'x\uD800'})` then `insertText('x\uD800',0,'a')` / `block('x\uD800').insertText(…)` | insert `true`; every later reference `false` (`hasBlock` true only for the normalized `'x\uFFFD'`) | ingress normalization decided per site (F20): ids are normalized on write (placement:748-773) but references are deliberately verbatim (placement:744-746) — the caller must recompute the stored id. |
| C13 | two independent features combined | `createDocument({lineage:{depth:5}})`; split `hello world` at 6; delete `t[0,5)`; `history.undo()` | 3 wire updates for one undo (lineage capture transaction under the default origin, edytor-doc.ts:1554; the undo; the ownership repair) vs 2 with lineage off; ownership correct locally | "one user action = one update/one frame": each feature added its own follow-up transaction around undo; receivers see three frames, the undoing replica two observer passes. Under §6-A+C the repair disappears and the capture can run inside the undo's own transaction (its writes are outside the undo scope). |
| C14 | fact observed vs fact decided | `createDocument()` (pending); `attachSync` with a provider that has not reported `synced`; hydration bytes applied; read `document.history` | throws `EdytorDocSyncPendingError` (a facade error) — the documented contract for a pending document is `DocumentNotReadyError` (crdt-v14-document.md "Errors worth knowing") | readiness held in three places (F14): the getter consults `isInitialized(doc)` = bytes present (document.ts:689), not `_readiness` = decided, then trips the facade's duplicate pending gate (edytor-doc.ts:1518-1520). One owner of "decided" removes both the second gate and the wrong error. |
| C12 | same-transaction batching with undo | a command that runs `undo()` and writes a `slices` record in the same transaction | per the undo-ownership ADR "Remaining gaps": records minted alongside the undo are excluded from the pre-delete contest and can be outranked by the repair | a repair defined over "this transaction" cannot distinguish the user's intent from the undo's; only a representation without repair avoids choosing. (Not probed — cited.) |

Counterexamples a replacement (§6-A) must survive — kept here so the new abstraction is falsifiable too:
- **A-1 (delete across a boundary):** any content delete issued as one engine range spanning a boundary atom silently joins two
  streams while the second block stays registered (an empty block plus a content jump). Only the per-stream delete may exist.
- **A-2 (concurrent same-id creation):** two replicas split different blocks with the same caller id ⇒ two boundary atoms name one
  registry winner; without the incarnation nonce the loser's atom would still cut a stream.
- **A-3 (seam insert side):** B inserts `|` at offset 6 of `hello world` while A splits there ⇒ `|` lands on the side YATA's
  client order picks, not always the head (today pinned head-side by TX06a).
- **A-4 (undo of split vs concurrent typing in the tail):** A undoes its split while B types in the tail ⇒ B's text joins the head
  (same as HI01a today) — must stay the pinned outcome.
- **A-5 (undo after a concurrent split at the deletion gap):** A deletes `t='world'`; B (having received the delete) splits the
  now-empty `t` at 0, inserting boundary `u` between `t`'s boundary and the tombstones; A undoes ⇒ the copies integrate after
  `u`'s boundary and `world` returns in `u`, not `t`. Today's repair returns it to `t` (redone-space contest). Under A this is a
  semantic change to R16 in a concurrent corner — decide it explicitly (accept, or give boundary inserts an "after the
  tombstone run" placement via a vendor primitive).

---

## 8. LOC — current, floor, derivation

### 8.1 Current (xloc script, per file)

| File | xloc | of which multi-line exported type bodies |
|---|---|---|
| edytor-doc.ts | 1504 | 22 |
| text/runs.ts | 1184 | 50 |
| text/model.ts | 1014 | 70 |
| placement/model.ts | 829 | 49 |
| document.ts | 552 | 27 |
| attribution/block.ts | 262 | 16 |
| undo-repair.ts | 196 | 1 |
| index.ts | 151 | 0 |
| attribution/attribution.ts | 125 | 24 |
| placement/rank.ts | 113 | 0 |
| nodes.ts | 104 | 37 |
| structs.ts | 71 | 13 |
| admission.ts | 61 | 19 |
| engine-api.ts | 34 | 5 |
| schema.ts | 18 | 0 |
| attribution/index.ts | 12 | 0 |
| rand.ts + engine.js | 7 | 0 |
| **Total** | **6,237** | ~333 |

### 8.2 Floor ≈ 3,700 xloc (−41%), by target module, derived from the measured clusters in §4

Target = §6 A + B + C, plus deleting code with no production consumer and duplicate tables. Each row: measured source clusters → what survives.

| Target module | Sources today (xloc) | Survives (xloc) | Line-by-line reasoning |
|---|---|---|---|
| Schema + admission | schema.ts 18, admission.ts 61, edytor-doc schema table 35 + gate/errors/`assertUsableDoc` 90 = **204** | **133** | one name table 20 (second table 35 gone); gate reads 26 unchanged; typed errors 45 (message text is the product); `assertUsableDoc` 12; verdict + staged `admitUpdate` + `inspectAdmission` 30; admission re-export doorway gone. |
| Placement | model.ts 829 + rank.ts 113 = **942** | **617** | rank 110; placement core (candidates, `{p,r}` write, acyclic resolution, rehome) 100 of 104; types 30; visibility + ONE children index 28 (second builder, second ancestor walk gone); ranks 26, `isSelfOrDescendant` 15; spec ingress 26 + materialize 32 (no slice record, no re-clone) + bulk insert 24; structural ops 45+25+21+9; `project` 35; positions/queries 30; registry access 12; `buildInline` 7; imports/return 42. Gone: fresh `view`+`collectBlocks` 60 (B), dead helpers 27, content/inline wrappers 113 (the op lives once in the text module), `crdtId`/`resolveBlock`-style test surfaces ~20. |
| Text streams | text/model.ts 1014 + undo-repair.ts 196 = **1,210** | **505** | range-read projection 90 of 104 (serialized-attrs branch gone, boundary skip added); merge-claim graph 60 of 71; caret relpos codec 32 of 38 (no `followUndoneDeletions` mode); NEW boundary index 50; display walk 35 of 42; NEW `locate`/`position` pair 40 (replaces ≥10 walks, F6); content ops 90 (insert, validated right-to-left delete, format, inline by id) replacing 105 + 82 edge branches; split = boundary + claim partition 35 (was 105); claim append 6; readers 22; imports/types/return 45. Gone (A): slice records 87, contest 239, repair 76+196. |
| Derived index + runs | runs.ts **1,184** | **515** | imports 20; run type 11; attr→facet map 12 (fake-op parser gone); run equality 18; API/types 20; doc-lifetime attach 8 (lease gone); edited-item→stream extents 25 (was 89); decls 30; intern 9; block/boundary/claim record maintenance 50 (was 108, contest index gone); owners+placements 20; one view object 10 (shim gone); dependency capture 35; fresh+reconcile 58; commit publication 25; fold (`applyTypeChange`/block change/`syncTransaction` with fold-once cursor/commit) 113 (was 219 + 19 refinement); scan/teardown 21; surface 30. Gone: `computeAllRuns`/`mergeRuns` → tests 59; `decorateRuns` + types 108 (no consumer); `subscribeBlock`/`subscribe`/`blockVersion`/`snapshot`/`debug` ~45 (tests only). |
| Facade | edytor-doc.ts minus schema = **1,379** | **782** | imports/types/internals 63; bootstrap `init` 38; write funnel with effect + touched set (C) 30; attribution/lineage helpers 40 (was 69 + ~53 in op bodies); reads/roles/navigation 67; DocChange ONE algorithm over the index report 120 (was 239); undo factory 45 (lineage undo capture kept); structural + metadata ops with island/void policy 140 (was 179); `setBlock` all-or-nothing 40, duplicate 22, toJSON 14; content op wrappers 55 (was 118); anchors 22 (was 168); `displayLength`/`contentItems`/`hasBlock`/visibility 10; facade object 60, return 10, dispose 6. Gone: `marksAlready` 36, view memo/`stateVersion` 35, `isVisibleBlock` walk 17, `emissionOffset` 48, `o` facet ~80. |
| Document lifecycle | document.ts **552** | **510** | everything in §4.5 survives except the facade-side pending-gate duplicate (~15), `_retain` next to `retain` (~8), duplicated lineage-depth validation (~8), the `UndoManager.destroy` monkey-patch (~10). |
| Attribution | block.ts 262 + attribution.ts 125 + index 12 = **399** | **376** | a product feature: incarnation stamp, stamps, lineage ring + convergent receive-side trim, actor dictionary, legacy `a/` reads all survive; `blockRecordsOf` (23) moves to tests. |
| Adapters | nodes 104, structs 71, index 151, engine-api 34, rand+engine 7 = **367** | **247** | nodes 100 (typed handles are the editor's API); structs 40 (extent + incarnation walks only); barrel 70 (public API + `bindCrdt`; "advanced internals deliberately exported" for tests gone); engine typings 30; rand/engine 7. |
| **Total** | **6,237** | **≈ 3,685** | |

### 8.3 Attribution of the reduction and honesty notes

- By cause (approximate, overlapping clusters de-duplicated; total −2,552): **A ≈ −1,000**, **B ≈ −440** (includes moving the
  59-xloc oracle to tests), **C ≈ −110**, one-layer content ops (placement wrappers) −113, no-consumer / test-only production
  code ≈ −283 (decorations 108, subscriber variants ~45, `blockRecordsOf` 23, dead helpers 27, barrel ~80), duplicate
  tables/gates/normalization ≈ −140; the remaining ≈ −470 are the itemized local trims in 8.2 (imports/types, structural-op
  and publication simplifications, document-lifecycle duplicates).
- **Without A** (i.e. keeping slice records + contest + repair), B + C + cleanup reach ≈ 5,100 (−18%). The 40–50% target is not
  reachable in this domain without changing *what represents ownership*; everything else is secondary.
- **Moved is not deleted.** If schema-1 v14 documents must remain loadable, the contest code needed to convert them (~300 xloc)
  moves under `migration/` ⇒ ≈ 4,000 (−36%). If the maintainer keeps `decorateRuns` and the per-block subscription API as
  public surface with no in-repo consumer ⇒ +150.
- **Oracles move, they do not vanish**: `computeAllRuns`, the dense ownership oracle and today's `diffSnaps` should live in
  `src/tests` to keep the new abstractions falsifiable (their xloc leaves `src/lib`, not the repo).
- **Bundle ≠ source lines.** The vendored engine (7,125 xloc) dominates the shipped bytes; this domain's reduction shows up as
  fewer deciders per fact, one update per undo, ~15 B instead of ~68 B per seam keystroke, and linear instead of quadratic cost
  for large transactions — not as a proportionally smaller bundle.
- **Extension cost** today for one new content op: a text-layer op + a placement wrapper + a facade wrapper (policy, no-op
  prediction, lineage capture, attribution stamp) + a typed-handle method + possibly a new facet in the run view's classifier.
  Under A+B+C: a text-layer op + a facade wrapper with policy; effect, attribution, lineage and invalidation follow from the
  transaction.
