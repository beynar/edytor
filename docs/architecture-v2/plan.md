# Edytor architecture plan (final)

_Status: complete (sections 0–12 and the closing summary). Revision 2 folds in three maintainer decisions: the
compare-to-truth observer, Svelte's own flush order as the timing hook, and the engine as an owned fork. Revision 3
folds in the two attack reviews of revision 2 (18 findings: 2 blockers, 10 major, 6 minor), all accepted (§12.5).
Independence rule respected._

## 0. Inputs, baseline, and what changed from v1

**Inputs.** `plan-v1.md` (the judge synthesis), the four adversarial reviews (`attack-*.md`: 50 findings, 2 blockers,
28 major, 20 minor), the six reader reports, source and tests. The three proposals were not needed. Independence rule
respected: none of the excluded documents was opened.

**Baseline, measured now** (`node scratchpad/xloc.mjs src/lib --dirs`): **29,099 xloc / 118 files**. The tree is still
moving (+12 since v1: selection +6, events +5, root +1); all of the growth is in machinery this plan retires. A re-run
for revision 2 reads **29,109** (+10: root +14 in `edytor.svelte.ts`, selection −4), and revision 3's re-run reads the
same. The plan keeps 29,099 as its baseline; against the re-run every percentage below moves by less than 0.05 point.

| crdt | events | selection | plugins | root | block | text | collab | components | hotkeys/ | clipboard | utils | history | dnd |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 8,362 (core 6,237 + transport 2,125) | 4,524 | 3,919 | 3,780 | 2,512 | 1,716 | 1,195 | 666 | 615 | 589 | 518 | 500 | 200 | 3 |

Two measurement facts that §7 reports separately:

- **Type bodies.** The counter counts the body lines of multi-line `export type X = {…}` as execution lines (its
  `export type` regex swallows only the header). There are **853** such lines today (crdt core 333, transport 109,
  root 95, block 77, utils 54, text 47, collaboration 32, plugins 29, selection 27, events 25, clipboard 14,
  components 11). The same type written as an `interface` counts 0.
- **Vendor delta.** The vendored engine is an owned fork (revision 2) and stays out of scope (7,125 xloc). It carries
  **+405** xloc of Edytor-authored features (P4–P6, including the 185-xloc `RangeCursor.js`) over upstream
  `@y/y@14.0.0-rc.26` (6,720). This plan adds one feature (P7, ≈30 xloc), charges it, and keeps reporting the delta.

**Census baseline** (production code, vendor excluded; `scratchpad/arch/final-probes/census.sh`): timer sites 58,
`tick()` waits 48, `flushMirror(` 18, `stopCapturing(` 20, `ignoreNextSelectionChange` writes 22, `PreventionError`
catch sites 7, `MutationObserver` instances 4, `flushSync(` 0.

**Probes re-run or added for this revision** (no repo file modified):

| Probe | Result |
|---|---|
| `crdt-attack-probes/a5-concurrent-format-min.mjs` | Reproduced: a boundary carrying the first live character's formats lands before a live `bold:true` format item a concurrent formatter left in the deletion gap; undo then sends `world` into the new block, on every client order, when the delete arrives before the format. |
| `crdt-attack-probes/st02a-delete-tombstone.mjs`, `delete-tombstone-undo-offline.mjs` | Reproduced: tombstoning content on delete empties the rescued tail (ST02a) and makes undo-of-delete copy-based (an offline peer's delete and bold are lost). Without tombstoning both hold. |
| `crdt-attack-probes/nested-undo.mjs`, `lineage-in-undo.mjs` | Reproduced: an undo wrapped in an outer transaction records a new undo item and empties the redo stack; lineage captured from a `beforeTransaction` listener keeps one update per undo and redo intact. |
| `crdt-attack-probes/composition-undo2.mjs` | Reproduced: untracked previews make one undo after a commit resurrect the preview (`Helloにほん`) or undo the wrong step. |
| `crdt-attack-probes/deterministic-seed.mjs` | Reproduced: fresh-id seeds duplicate a template; caller-id seeds erase a later edit; a deterministic seed update keeps one copy and the edit. |
| **`final-probes/seed-collision.mjs` (new)** | The attack's repair used a fixed seed writer id. With two **different** templates that fixed id diverges the replicas permanently (`p2:Bodyate` on one side, `q1:Other template` on the other). A writer id derived from a hash of the seed converges in all three cases (same seed, different ids, same ids with different text). This plan adopts the hashed writer. |
| `crdt-attack-probes/double-delete-undo.mjs`, `f-u4d.mjs` | Reproduced: one LWW `del` flag lets a selective undo resurrect a block a second peer also deleted; the concurrent undo ‖ split-at-0 outcome follows client-id order. |
| **`rev2-probe/order.exp.test.svelte.ts` (revision 2)** | Svelte 5.55.1 in jsdom, one batch that bumps an epoch, edits one child and adds another: the root's top-level `$effect.pre` sees the old DOM (`pre:aabb`), the attachment bodies write next, and the root's top-level `$effect` sees every write of the flush (`post:AAbbcc`). |
| **`r2-attack-probe/attack.exp.test.svelte.ts` (revision 3, re-run)** | B1: the MutationObserver callback runs before the flush and the root `$effect.pre` still sees a browser edit (`pre:"hello world"`), but a flush that re-keys the run destroys the node before the root `$effect` compares it, and a writer created during the effect phase writes after that `$effect` (`post:""`, then `write:…`). B2: a write guard that skips a diverged node, plus an inversion to the last-written text, leaves `hell` on screen while the cell holds `Xhell`, for good. Revision 3 drops the guard and snapshots before the flush's writes. |

**What changed from v1**, in one list (section 12 maps each change to the finding that forced it):

1. **Boundary placement (R2).** A split inserts its boundary at the *end of the gap* (after every tombstone and format
   item before the next live character) through a new engine primitive (P7). The "formats of the first live character"
   rule is withdrawn: it fails when two concurrent formatters leave conflicting live format items in the gap.
2. **Deletion (R3).** Delete writes per-writer marks on the block and on what it displays, and tombstones no content.
3. **Seeding (R13).** A deterministic seed update written by a content-hashed writer replaces "fresh ids": caller ids
   survive, identical seeds are idempotent, and a late identical seed never erases an edit.
4. **Commands (R6, R7).** Operations are two-phase (prepare, then apply the prepared plan). Hooks see the prepared
   command and each planned step before any write; a veto refuses the whole command, a replacement re-prepares.
   History is a named exception (bare engine undo/redo). The undo policy is today's observable rule, and a composition
   session is one capture group.
5. **Input (R8).** Attempts carry expectations and queue per host; adoption uses a diff that prefers the attempt's
   target; a composition session has a tail; explicit cancel and abandonment are different endings.
6. **Display (R10).** The projector first admits an unobserved user move, never writes during a drag or under a live
   IME, decides focus from three facts, and targets only displayable destinations.
7. **Host (R11, R12).** The host is a projection of the model: after each flush, a block's content that differs from its
   cell, or a strict container whose children differ from what the cells render, is input (revision 2 replaced the
   render bracket with this compare-to-truth rule; revision 3 compares per content, snapshots an edited content before
   a flush re-renders it, and makes the root, text and mark elements strict); attributes have declared owners; the
   observer ignores foreign changes while read-only.
8. **Suggestions** get an owner (the Session) and render as cell state.
9. **LOC.** Target **−41.0 %** (17,174); confident **−37.9 %** (18,068); stretch **−45.6 %** (15,828). The confident
   number is below 40 %. Cuts that remove code (G-a, G-e, G-d) bring it to −39.2 %; the 40 % line needs G-c by route
   (i), which needs the fork published, or G-b (§7.3).
10. **Migration.** Forty-four PR-sized checkpoints (G0, six tracks, C1) replace v1's twelve large ones (CP0–CP11).
11. **Revision 2** (§12.5). The compare-to-truth observer, with Svelte's own flush order as the timing hook, and the
    vendored engine as an owned fork (P7 is an engine feature; G-c is available now).
12. **Revision 3** (§12.5). The write guard goes (a skipped write was never retried); the root `$effect.pre` snapshots
    an edited content before a flush re-renders it; the observer compares per content and keeps record-level
    structure for strict containers; the projector only mints anchors inside `beforeTransaction`; the composition tail
    is an expectation on its host; G-c's route (ii) is booked as a relocation; R7's fallback is priced again.

---

## 1. The few necessary facts and rules from which the behavior follows

### 1.1 Platform facts (not ours to change)

**Engine (vendored Yjs v14, an owned fork since revision 2).**
- Replicates sequences, map attributes (last-writer-wins per key) and relative positions. No move primitive; no
  transaction rollback; every transaction exposes its changed set.
- Concurrent creators converge only through equal keys. Two *different* updates that carry the same (client, clock)
  diverge permanently (`seed-collision`).
- An insert at an index walks right past zero-length tombstones and past format items whose value equals the requested
  one, then stops. It cannot pass two live same-key format items with different values, and a receiver does not prune
  redundant format items when it receives a format (it prunes only on delete receipt) (`a5-concurrent-format-min`).
- Undo re-creates deleted items as **new** items (linked by a local `redone` pointer), each integrated between the
  tombstone's current left neighbour and the tombstone. Edits a peer made to the originals meanwhile do not carry over
  to the copies (`delete-tombstone-undo-offline`).
- `popStackItem` never re-creates items inserted by the same stack item, and skips a stack item whose replay changes
  nothing (`UndoManager.js:84-114`).
- The redo stack is filled only by transactions that commit while `undoing` is set. An undo inside an enclosing
  transaction, or any tracked write after an undo, empties it (`UndoManager.js:207-223`; `nested-undo`).
- A stack item keeps absorbing tracked transactions while `now − lastChange < captureTimeout` (`lastChange` is a plain
  field; `stopCapturing()` zeroes it).
- The wire encoder replaces lone surrogates.

**Browser.**
- The browser writes the DOM itself for IME, Android, spellcheck and autocorrect input. The IME owns the text node it
  composes into; removing or moving that node ends or corrupts the composition. Focus leaving mid-composition commits
  the marked text into the DOM.
- A native caret move (arrow key, mouse, touch handles, assistive tech) changes the DOM selection synchronously; the
  `selectionchange` that reports it is a later task. Every programmatic selection write also echoes back
  asynchronously. Writing the DOM selection during a composition ends it.
- Mutation records carry no provenance.
- Engines disagree on composition order: Firefox fires the final composition `input` after `compositionend`; WebKit can
  commit on `beforeinput` before `compositionend`; Android can mutate the DOM after a *canceled* `beforeinput` and can
  send a delete and a recomposition in one frame. Some engines skip or misreport `beforeinput` for structural keys.
- Script-dispatched composition events have no IME behind them. The only real-IME driver available in the lanes is the
  Chromium DevTools `Input.imeSetComposition` (three tests use it today, `mobile-composition.spec.ts:342-470`).

**Svelte 5.55.1.**
- DOM writes are batched after the synchronous block. A keyed `{#each}` reuses DOM by key; `{#key}` destroys it.
- `{#each}`/`{#if}` fragments are delimited by empty text anchors; removing one makes the next reconcile spin forever
  (`domTextMutationObserver.ts:314-319`).
- A state write opens a batch whose flush runs on a microtask (`Batch.ensure`,
  `svelte/src/internal/client/reactivity/batch.js:665-686`). The flush (`#process`, `:242-355`) walks the effect tree
  (`#traverse`, `:364-407`): template and block effects and `$effect.pre` (a render effect, `effects.js:240-248`) run
  inline, in tree order; `$effect`s and the bodies of `{@attach}` attachments and `use:` actions are collected and run
  afterwards, in tree order (`flush_queued_effects(effects)`, `batch.js:324`). State written then, and any effect
  created then (a nested `$effect` inside an attachment body), go to the next batch (`effects.js:128-135`), which runs
  synchronously after this one (`batch.js:349`). The repo does not enable async mode (`svelte.config.js`).
- A component's top-level `$effect` is created at mount, after its template (`effects.js:213-222`,
  `context.js:201-209`). The root component's top-level `$effect` is therefore the last effect of the editor subtree:
  it runs after every DOM write that the flush's template, block and attachment effects make, and a top-level
  `$effect.pre` there runs before them (probe `rev2-probe/order.exp.test.svelte.ts`: `pre:aabb`, two attachment
  writes, then `post:AAbbcc`). A write made in a chained batch comes after it and re-runs it only if that write bumps
  the render epoch (`r2-attack-probe` B1: `post:""`, then `write:…`). An `$effect` deeper in the tree gets no such
  guarantee.
- Svelte's text writer compares with the value it last wrote, not with the live node (`render.js:46-55`): a node the
  browser edited is overwritten only when its rendered value changes, and a rewrite with identical text still resets
  a caret inside the node to offset 0 (the DOM's replace-data rule).
- `flushSync` forces the pending flush. This plan never calls it.

### 1.2 The rules

The bold phrase names the rule; the rest states it. Each rule is owned by one context (§2.3) and cited by the deletions in §5 it justifies.

| # | Rule | Owner |
|---|---|---|
| **R1** | **One writer per store.** The replicated document is written only by document operations (and, once, by the seed writer); the host DOM only by the renderer, from cells and declared view state (anything else found there after a flush is input, R12); the DOM selection only by the projector; a presence entry only by the view that minted its key; stored rows only by the container's append-only writer. | all |
| **R2** | **Streams are delimited by boundary items placed at the end of the gap.** A block's own text runs from its live boundary item whose nonce matches its record (or, for a block with no such boundary, from index 0 of its own backing text, else it is empty) to the next live boundary item; a split inserts exactly one boundary after every tombstone and format item that precedes the next live character at the split point, with the formats in effect there (engine primitive P7); no content delete removes a boundary. The block that displays a text position is therefore a pure function of replicated items and is never repaired. | Document |
| **R3** | **Deletion wins, and deletes what the block displays.** A block is visible iff no live delete mark is on it, it owns itself and its display parent is visible; deleting a block writes the deleter's own mark on it and on every block it currently displays through merge claims (transitively) and changes nothing else. So undo removes only the undoer's marks, and a boundary a peer inserts concurrently into the dead stream starts a block that is visible on its own terms. | Document |
| **R4** | **Positions that outlive a synchronous turn are anchors.** Within one document version a position is *(block id, display offset)* (UTF-16 units, an inline atom counts 1). Anything held across an await, a render, a commit or the wire is an anchor (one item plus a side). An admitted insertion target also records which side of an inclusive mark element's edge the DOM point lay on. Offsets, segment identities, wrappers and DOM nodes are never stored as positions. | Document (codec), Session (holders) |
| **R5** | **Capability is adopted once and answered by one predicate each.** Block roles (void, island), whether a kind renders its own content, the default child type per parent type, targetability, structural capability (`canPlace`, `canMerge`) and document order (one pre-order over visible blocks; island sealing is a policy the operation applies) are adopted from extension records and give the same answer whether asked in advance or at execution. Permission (may this view do it now) is the dispatcher's, not the document's. | Document |
| **R6** | **Operations are prepared, then applied; effects are observed.** Every document operation first prepares against the current version (pure: `refused`, or a write plan plus its effect summary of blocks removed, merged, moved and created) and applying writes exactly that plan. The observed result (`noop` or `applied`, ids, position) and everything derived from a commit (publication, attribution, render patches, undo capture) come from one fold of the transaction's own change set. | Document |
| **R7** | **One command, one dispatcher, one undo policy.** Every mutation a view makes is a command value its dispatcher admits (readonly, document writability), prepares, shows to each extension hook before any write (the prepared command, then each planned step under its documented operation name; a hook may veto, which refuses the whole command, or replace the command, and a replacement is prepared again, at most once per extension), applies in one transaction, and closes with the undo policy (cut before delete, paste, drop and structural commands; cut after a paragraph split; coalesce insertions within `captureTimeout`; a composition session is one capture group) and the command's result selection. Commands receive the selection as an argument. Two named exceptions: history runs a bare engine undo/redo with no enclosing transaction and no tracked write after it, and composition previews are mechanical tracked writes inside their session's capture group. | Session |
| **R8** | **One occurrence, one attempt; one composition, one ending plus a tail.** Each input occurrence opens at most one attempt whose intent, anchored target, owner and expectation are fixed at admission; attempts queue per host until their expectation is met, contradicted or out of time. A DOM text change is attributed to the attempt whose expectation it satisfies and adopted with a diff that prefers that attempt's target. A composition session replaces its start target through an ordinary command, keeps its previews in one capture group, ends exactly once (commit, explicit cancel, or abandonment that adopts what the DOM shows), and keeps a tail that owns late composition signals until the next non-composition occurrence. | Session |
| **R9** | **The selection is a value.** It is none, a text range of two anchors with optional pending marks (values kept), one inline atom, or a set of block ids. Only `select()` replaces it; it advances the selection epoch and applies every side effect once (focused and selected sets, attributes, hooks, presence, clearing suggestions whose block the caret left). A command's result selection is authored by the command; the replicated-slot seam applies only to endpoints this view did not author. Everything else is a projection of *(value, document version)*. | Session |
| **R10** | **Display is a projection of the current value.** Only the projector writes the DOM selection. Before the first transaction after a settled render that this view did not issue (a remote apply or a hydration, told apart by its origin, since the engine marks an apply non-local only inside it; the last flush rendered the current document version), it mints anchors from the live DOM selection, unless the DOM is ahead of the model there, and admits that move through `select()` once the transaction has committed, never inside it. It displays after each flush, from the root `$effect`, and writes the current value only when the destination is displayable, no pointer drag is active, no composition session owns a host (the session's end does the catch-up display), and focus is ours or was orphaned by our own render, never when the last gesture landed outside the editor. It classifies each `selectionchange` as echo, drift, composition noise, foreign write or intent by comparing with its last display, the render epoch and the gesture serial. | Surface |
| **R11** | **The host renders a pure function of the model and declared view state.** Every node and every owned attribute inside the contenteditable host is a function of the document plus declared per-view state (selection value, readonly, composition session, suggestions, extension view state). An attribute not declared owned (`open` on a native toggle, attributes an extension writes on a block element) belongs to the browser or the extension and is never inverted. Structure is owned where the core renders it: the root, text elements and core mark elements are strict containers, and an extension's own markup around the slots is the extension's (D-25). Chrome lives in an overlay outside the host; the placeholder is an attribute. | Surface |
| **R12** | **Divergence after flush is input.** Once a flush has written the host, a block's content whose text differs from its cell, a strict container whose children differ from what the cells render, a registered element or framework anchor that went missing, or an owned attribute that differs from the table is browser or foreign input. The observer adopts or inverts it by location and the open expectation (an attempt's, or the composition tail's); a content the flush re-renders is snapshotted before the flush's writes and its edit is placed through anchors afterwards. Inversion restores the current cell and never removes framework anchors; while read-only only owned attributes are healed, and text divergence is inverted at the flip back; the only divergence tolerated is the live composition host, which its session owns. | Surface |
| **R13** | **Channels prove their generation; seeds are deterministic.** A replica integrates bytes only from a frame or container proven to carry its own engine, wire and schema generation, and refuses any update that writes a foreign schema stamp. A document seeds content only when it is empty after every attached provider settled or its bound elapsed, by applying one deterministic seed update written by a writer id derived from a hash of the seed (caller ids kept; missing ids, nonces and ranks derived), so identical seeds are idempotent and different seeds union. No view holds a stand-in for a document block. | Transport + Document |

### 1.3 Behavior that follows

| Required behavior (contract / pin) | Follows from | What it replaces |
|---|---|---|
| Typing at a block's start, end or empty display lands in that block (crdt R8, ownership regressions A/B) | R2 | per-keystroke claim rewrites, empty-display revive, right-edge rival claim (68 B/keystroke at a seam) |
| A caret at a split-born block's start stays when the neighbour receives text at the shared gap (anchor rule 1, `にHello`) | R2, R4 | the `a ≤ -2` + `o` owner facet, emission offset, outward scan |
| Undo returns deleted text to the block that displayed it, on every replica, in one update, even after a concurrent split at the gap and a concurrent format of the deleted text (R16; A-5; attack F1) | R2 (end-of-gap boundary) + engine `redoItem` | the undo repair transaction, the redone-space contest, the second wire update |
| Deleting a block hides what it displays (split-tail text typed concurrently, blocks merged into it), a concurrently split-off tail is rescued (ST02a), and one peer's undo never resurrects a block another peer also deleted | R3 | view-side tombstoning in `removeBlock`; fixes the headless and concurrent leaks (P3/P3b), merge-then-delete resurrection (X1), selective-undo resurrection |
| Structural capability is the same for a drop affordance and for the executed move (G6) | R5 | view re-derivation (`blockMove`, `insideIsland`, range-delete branches); fixes P1, P2 |
| Enter at the start, middle or end of a list item creates a list item (G5) | R5 | two default-type rules and an implicit caret-derived argument (P10, P12) |
| A veto never half-executes a command; a hook error surfaces and the command stays atomic; a hook can still retarget a command or refuse a composite that would remove a protected block (R13 crdt, A.1, README `onBeforeOperation`) | R6, R7 | seven `PreventionError` catch sites and the hotkey catch-all; fixes P11, P11b, `prevent-midway` |
| One user action is one undo step with today's grouping (`history-coalesced-range`, `input.spec:1023`); undo restores the caret only in the issuing view; redo survives every channel (G12, G13, H1) | R7, R9 | 20 `stopCapturing` sites, two restorers (C1/P4), the snapshot queue |
| Undo right after an IME commit removes exactly the composed text and restores a selection the composition replaced (COMP-02) | R7, R8 | tracked previews split by `captureTimeout` today |
| A deferred caret write never overrides a newer gesture, including a native move whose `selectionchange` has not arrived (W1; delete contract "Selection ownership") | R10 | 16 staleness mechanisms, 8+ mount-wait loops |
| A foreign programmatic selection is adopted; a selection the user made outside the editor is never stolen (O1; reader-input item 25) | R10 | "no gesture ⇒ drift" (probe C4) and three focus verdicts |
| The IME's node is not re-rendered by our renders; the commit replaces exactly the preview, once; plugins see one insert; late composition signals are neither adopted nor committed twice (G18, `composition*.spec`, `ime-plugins`) | R8, R11, R12 | three region encodings, nine reset sites, two cancel semantics, hooks on preview replays, the 50 ms suppression windows |
| Browser-owned input is adopted exactly once, at the position the browser edited, even when a model change re-renders or re-keys the edited run in the same task; drift around model-owned input is reverted (`mobile-beforeinput.spec`, F-O13) | R8, R12 | seven flags, four timers, two adopters |
| Native toggles open, readonly can be flipped at runtime, and plugin attributes on block elements survive; foreign damage is still healed (`demo-route.spec:90`, `features.spec:221`, `dom-mutation.spec` heal specs) | R11, R12 | the observer's liveness inference, kept attribute table |
| Inline text suggestions render, clear when the caret leaves their block, survive a composition at their boundary, accept on Tab and clear on Escape (README "AI copilot ready") | R9, R11, R12 | per-block `$state` with no owner |
| The placeholder shows only for the lone empty text of an empty block, never during a composition (`placeholder-repair.spec`, `composition.spec:288`) | R11, R12 | observers, sweeps, a six-phase repair queue |
| A peer's caret follows edits and disappears with its view (G20–G23) | R1, R4 | three wire encodings, owner registries, destroyed-view sweep |
| Opening a room never duplicates or erases its content, caller ids in `value` survive, and the first client is usable (G9–G11; `crdt-v14-document.md:55-67`; demo deep links) | R13 | two-round settle window, reserved-id seed overwrite, 50 ms poll (P4, P4b/c, P6) |
| Readonly forbids mutation but keeps selection and copy; a read-only view leaves foreign annotations alone (R10 ui, O6, input A.8) | R7, R9, R12 | seven readonly checks in controllers |

## 2. Authoritative representations and derived views

### 2.0 What the maintained structures actually describe

Today the runtime maintains a replicated tree with a mirror tree of stateful wrappers beside it, five id/node →
wrapper registries, a 30-field selection object, three encodings of a caret on the wire, three encodings of a
composition region, anchored slice records with a per-atom contest, two history restorers, suppression flags and timers,
and mutation-record liveness heuristics. All of it describes **five things**:

1. **The document.** Replicated, durable.
2. **Local history.** The engine stacks, the selection each step started from, and the open capture group.
3. **Per-view intent and view state.** The selection value, the attempt queue, the composition session, suggestions,
   readonly, and extension view state the host renders.
4. **Presence.** One entry per view.
5. **Storage and transport.** Rows, container records, provider sessions, the migration lock.

Everything else is a cache with one owner or a pure function of these five.

### 2.1 The replicated document (stored once; writers: document operations, and once the seed writer)

```
doc.get('blocks')                    registry: blockId → Node
  attrs   type, data
          n                          incarnation nonce (random; derived from the seed hash for seeded blocks)
          del.<writer>: true         per-writer delete marks; the block is deleted iff any mark is live
          at: {"<seq>.<client>": {p, r}}   placement candidates, atomic parent+rank (unchanged)
  content → backing text             owned by a block created fresh, or by a streamless split-born block that got typing
      characters (+ format items)    typed text; never moved or copied
      Node('inline'){id,type,data}   inline atoms (unchanged)
      {s: blockId, n}  embedded      BOUNDARY ITEM, length 1, never displayed:
                                     "block s, incarnation n, starts right after me"
  claims  → [{m: blockId}]           ordered merge claims (the {t,s,e,g} slice records are gone)
doc.get('meta')                      generation stamp {v, schema}
attribution roots                    b/<id> keyed by incarnation n, u/<actor>, lineage ring (product feature)
```

- **Identity.** Registry keys are block ids. Local minting never reuses an id. Caller ids are public API, so two
  concurrent creations of one id do happen; the registry's last-writer-wins settles which node survives, and the nonce
  says which incarnation a boundary item belongs to (A-2). "The registry is never replaced" is not a rule.
- **Stream.**
  - `stream(b)` starts right after `b`'s live boundary item whose `n` equals `b`'s record nonce; failing that, at index
    0 of `b`'s own backing text if it has one; failing that, it is empty.
  - It ends at the next *live* boundary item in the same text (not tombstoned, nonce matching its block's record), or
    at the end of the text.
  - A split-born block never creates its own backing text while its boundary is live. If the boundary died with its
    host text (the host node was replaced by a concurrent same-id creation, or the host's insert was undone), the first
    typing creates an own text and re-mints `n`, so a late copy of the old boundary is inert (attack F9).
- **Display.** `display(b) = stream(b)`, then `display(m)` for each claim `{m}` in claim order. It is empty if `b` is
  deleted and hidden if a live claim routes `b` elsewhere. Owner resolution over claims (max-stamp claim, cycles, "a
  claim held by a deleted block is inert") is today's `computeOwners` graph, unchanged.
- **Split `b` at display offset k.**
  - `locate(b, k)` gives (backing text, index).
  - The engine primitive **P7** inserts one boundary at the **end of the gap**: it walks past every tombstone and every
    format item before the next live content item, folding their formats, and inserts the boundary with exactly the
    formats in effect there (so no format item is added). The public insert cannot do this: it stops at the first live
    format item whose value differs from the requested one, and two concurrent formatters can leave two same-key items
    with different values in one gap (attack F1).
  - The merge claims that follow k are re-inserted on the new block and deleted from `b` (the engine has no move; D-21
    pins the consequence for a concurrent undo of that merge).
  - The new block's record and placement are written. One transaction; no text is copied.
- **Merge `c` into `b`.** Append `{m: c}` to `b`'s claims. Deleting `c` hides its text; a concurrent delete of `b`
  voids the claim (ST02b).
- **Delete `b`.** Write `del.<writer>` on `b` and, transitively, on every block `b` displays through claims at delete
  time (G8 and the merge-then-delete case X1). **No content item is tombstoned.** A dead stream is already hidden by its
  block's marks; tombstoning would empty a tail a peer splits off concurrently (ST02a) and would turn undo-of-delete into
  a copy that loses an offline peer's edits (attack F2). The price is storage: dead text stays as live items until a
  causal-stability signal exists, and none exists over an opaque relay.
- **Restore definition** (migration `force` only). Clears every delete mark on an existing id and rewrites its type,
  data, placement and content in place, so a forced re-migration reproduces legacy ids (attack F13).
- **Content writes.**
  - The per-stream delete is the only content delete path, and it never removes a boundary item (A-1).
  - Every range read skips boundary items. That is one predicate in the range reader; with the engine an owned fork it
    may live in the engine's `RangeCursor` (P5 already extends it), reported as vendor delta and charged to
    `doc/streams`. Making the boundary itself an engine-level item is an option, not a decision (§11.5).
  - Typing at a stream's start inserts after its boundary; typing at its end inserts before the next boundary. The
    engine walk and the caret's side choose. Nothing is repaired afterwards.
- **Undo of a text delete.** `redoItem` integrates each copy between the tombstone's current left neighbour and the
  tombstone. Every boundary inserted after the delete sits after the whole gap (P7), so the copies stay in the stream
  that displayed them: one update, no repair, whatever formats peers wrote concurrently. A split that races the undo
  itself lands between the same neighbours and is ordered by client id (D-17: YATA order, pinned).
- **Anchors.** `{b, a}` is the home text id plus an engine relative position. A left-affine caret at a split-born
  block's start binds that block's boundary item. The containing stream and the side are two facts in two fields.
- **Seeds (R13).** The seed is built in a scratch document whose writer id is a 32-bit hash of (generation, canonical
  seed JSON). Ids are the caller's, or derived from the hash and the position; nonces and ranks come from the `rand`
  seam seeded by the hash. The update is applied with a non-local origin: never an undo step, no attribution stamp.
  Two peers seeding the same value produce the same items; different values union, and blocks sharing an id resolve by
  the registry's last-writer-wins, as caller ids do today. A hash collision between two *different* seeds in one room
  is a 2⁻³² event; it would diverge the room.

Pre-merge `v14-schema-1` documents exist only in development (V1: `d9b7de0` is not an ancestor of `master`). The
v13→v14 migration imports JSON, so it targets this layout unchanged. Development documents are re-imported; no
converter is kept in `src/lib`.

### 2.2 Local authority (not replicated, not derivable)

| # | State | Only writer | Lifetime | Category |
|---|---|---|---|---|
| L1 | Adopted capability `{roles: type → void \| island, rendersContent: type → bool, defaultChild: parentType → type, defaultType}`, conflict-checked on every view's adoption | document adoption | document | immutable admitted meaning |
| L2 | Undo stacks (engine; scope = registry; tracked origins = view transactions), per-item `meta: Map<viewKey, {before, after}>` of selection values, and the open capture group (a composition session id) | engine (stacks); the issuing view's dispatcher (meta, capture window) | document, in memory | durable progress for the session |
| L3 | Extension definitions: kind, mark and atom records (including declared view-state attributes and `rendersChildren` when children depend on view state); binding rows; hooks | construction | editor | immutable admitted meaning |
| L4 | Selection value `none \| {text, anchor, focus, pending?} \| {atom, blockId, atomId} \| {blocks, ids}` + selection epoch | `select()` | until the next `select()` | immutable admitted meaning |
| L5 | Command value `{kind, target, payload, origin: user \| composition \| history \| remote-repair}` → prepared `{plan, effect}` → result `{status, selection?, ids}` | producer → dispatcher | one command | intent immutable; plan immutable once shown to hooks; result observed |
| L6 | Input attempt `{id, intent, target (anchored, with edge side), owner: model \| browser, expect: {host, before, after \| unknown}, deadline?, phase: open \| applied \| failed \| closed}`, queued per host | admission | occurrence → expectation met, contradicted or deadline | intent/target/owner immutable; expect/phase replaceable |
| L7 | Composition session `{host element, startTarget, marks, region: {start, end} anchors, captureGroup, phase: live \| tail \| gone, endedAt}` | the session | `compositionstart` → end of tail | host = resource; startTarget/marks immutable; region/phase replaceable |
| L8 | Surface bookkeeping: `displayed = {epoch, range, renderEpoch}`, render epoch, records signal, gesture serial, last gesture landing (inside or outside), pointer-drag flag, the focused element noted before each flush, attribution frame, owned-element registry (block, text, mark and atom elements ↔ cell; each block content's last rendered text with its runs' start anchors), the dirty set (with added and removed nodes and siblings for strict containers), the pre-flush snapshots, the deferred-divergence set | projector / renderer / event adapter | one mount | replaceable + resource ownership |
| L9 | Transport: provider per *(document, transport target)*; `hasSynced` (lifetime) vs `connected` (transient); awareness owned by its creator; container record `{engine, protocol, schema}`; append-only rows; migration record `{status}`; migration lock; outbound quarantine of a read-only document | provider / container / migrator | provider or container | durable progress (rows, records) + resource ownership (sockets, timers, locks) |
| L10 | Presence entry `selections[viewKey] = {start, end, collapsed, reversed, t}` (anchors only) | the view that minted `viewKey` | the view | replaceable |
| L11 | Readiness `pending \| local \| hydrated`, and the seed decision (hash, applied) | document lifecycle | document | durable decision (once) |
| L12 | Suggestions `{blockId, parts (JSON)}` | Session (set by host or extension; cleared by `select()`, accept, dismiss) | until cleared | replaceable |
| L13 | Extension view state the host renders (collapse state and the like) | the extension; each write bumps the render epoch (`surface.update`) | mount | replaceable |

Nothing else is stored as truth. None of the following exist any more: text-segment ids; numeric caret offsets held
across turns; `_live`/`_bound` flags; slice records or claim generations; a second freshness counter; a `synced`
shadow flag; a virtual first block; a single last-writer-wins delete flag; suppression flags and windows; a durable
migration lease.

### 2.3 Owner contexts and nested lifetimes

| Context | Lifetime | Authority | Mandate |
|---|---|---|---|
| **Document** | the engine doc (per-doc derived state lives exactly as long as the doc: attached once, never leased) | replicated truth + adopted capability | the only writer of replicated state; prepares and applies operations; answers every structural question once |
| **Session** | one view (mount → destroy) | this local user's intent and view state | selection value, suggestions, commands, dispatcher, history bookkeeping, attempts, composition, held ranges |
| **Surface** | one mounted DOM (may remount) | none over meaning; renders and observes | the only reader and writer of the editable DOM and of the DOM selection; the only source of DOM facts (edge side, displayable, gesture landing) |
| **Extensions** | editor construction (immutable afterwards) | definitions | kinds, marks, atoms, bindings, hooks, declared view-state attributes: each declared once, in one record |
| **Transport** | provider / container / document | channel integrity | generations, joins, persistence, presence entries, migration |

```
document (engine doc, adopted capability, index, history stacks, attribution, providers, seed decision)
 └─ view / Session (selection value + epoch, suggestions, keymap, dispatcher, attempt queues, composition, presence entry)
     └─ mount / Surface (cells, owned-element registry, projector 'displayed', gesture facts, observer, overlay, attribute owners)
         ├─ command (value → prepare → hooks once → one transaction → result)   history: bare undo/redo → select()
         │    └─ attempt (intent, anchored target, owner, expectation; queued on its host)
         │         └─ composition session (live → tail → gone; one capture group; host element pinned)
         └─ flush (Svelte's microtask; every host-rendering state write bumps the render epoch;
              the MutationObserver callback writes the records signal)
              root $effect.pre (note focus; restore missing registered nodes; snapshot edited contents) →
              DOM writes →
              root $effect (resolve divergences against the current cells → adopt or invert → display)
```

An inner lifetime never owns a fact an outer one needs. Two machineries go because of this: the lease/refcount around
the derived index (the index lives with the doc), and the "re-subscribe on attach" patch (`edytor.svelte.ts:828-910`;
the commit subscription belongs to the Session, not to the mount). The composition session outlives its commit by a
tail, because the browser's authority over the IME node outlives the commit (attack BI-5); the tail is an expectation
on its host, so a late composition change resolves to the committed text (BI2-6).

### 2.4 Derived views (computed; never stored as truth)

| Derived view | From | Owner | Invalidated / recomputed by | Consumers |
|---|---|---|---|---|
| **Per-doc index**: records, stream table, owner map, winning placements, visible tree, children order, document order, depth/path, runs per block, dependency sets | §2.1 + L1 | Document index | folded once per transaction; mid-transaction reads fold pending work first behind a **watermark** (the local client's clock plus a folded delete set), because `transaction.changed` does not grow on a second edit to an already-changed type and its id ranges are merged in place (attack F11) | ops, anchors, change report, JSON, handles |
| **Change report** `{added, removed, moved, meta, content, order, local, origin}` | the fold vs the previous committed index | Document | once per commit; nested transactions publish once; change-then-revert publishes nothing; dev builds compare it with a rebuild | cells, Session (held anchors), `onChange`, remote carets |
| **Prepared plan** `{writes, effect: {removes, merges, moves, creates, textRanges}}` | a command + the index at version v | Document ops (prepare) | per dispatch; valid only at version v, and the dispatcher applies it in the same synchronous turn | hooks, permission, the dispatcher |
| **Op result** `{status, ids, at}` | the fold (clock advance, located deletes, set-if-changed attrs) | Document write funnel | per op | dispatcher, attribution (once per outer transaction, never for undo/redo transactions), undo capture |
| **Selection projection** `project(value, version)`: endpoints *(block, offset)*, direction, collapsed, covered blocks and segments, edge flags, island/void root, marks at caret (lazy), content string (lazy) | L4 + index | Session | memoized per (value, version). The DOM-derived compatibility fields (`startNode`, `isVoidEditableElement`, the DOM-side relative position) are supplied by the Surface and invalidated by focus and `selectionchange` | commands, `selection.state` getter, toolbar, clipboard |
| **Seam of a vanished endpoint** | the replicated slot `{p, r}` of the topmost dead ancestor + visible siblings + `rendersContent` | `doc/anchors` | per resolution; applied only to endpoints this view did not author (a local command authors its own result) | projection |
| **Displayable** *(block, text)* | cell mounted ∧ not hidden by view state (a collapsed toggle, a snippet that did not render `content()`) | Surface | per render | projector, seam descent filter, caret stops |
| **Render cells** `{type, data, childIds, runs}` per visible block; each run carries its first character's id | change reports + the session state they read (composition pin, selection side effects, placeholder, suggestions) | Surface | patched from change reports; re-derived when that session state changes; every write bumps the render epoch; text renders declaratively, with no write guard (D58) | components |
| **Divergence set** (r3): block contents whose text differs from their cell, strict containers whose children differ from what the cells render, registered elements and framework anchors that went missing, owned attributes that differ from the table | the elements mutation records named since the last pass (with added and removed nodes and siblings for strict containers) and the contents the flush re-renders × owned-element registry × cells | Surface observer | before the flush's writes in the root `$effect.pre` (missing nodes restored, edited contents snapshotted); resolved after them in the root `$effect`; the live composition host is excluded; a deferred divergence waits for the records signal | classifier, adoption, inversion |
| **Segments** (key = id of the preceding atom, or `start`) | cell runs + session | Surface (`$derived`) | per cell change; while a composition owns the host cell its **whole segment list** is frozen and released in one catch-up patch at session end (attack BI-13) | Text renderer, DOM mapping, pin |
| **Placeholder attribute** `data-placeholder` | the cell has one empty text ∧ no live composition in it | Surface | per render (a `compositionstart` in an empty block removes it in the flush that follows) | CSS `::before`, shipped by the library |
| **Handles**: id-only `Block`/`Text`/`InlineBlock` whose getters read the index and whose mutators issue commands | index | Session | on demand; the id cache is pruned from `removed`; a handle for a dead id answers through `isLive` | extensions, normalizers |
| **Snippet view objects** (`{type, data, selected, focused, …}` + command helpers; suggestions pass `selected: false`) | cell + projection | Surface | per render | extension snippets |
| **Kind catalogue** (slash commands, markdown table, HTML maps, clipboard exporters, default child rules) | L3 | registry | at construction | slash menu, markdown, HTML, clipboard, adoption |
| **Presence payload** | `serialize(L4)` | Session → Transport | on `select()` when the value changed | peers |
| **Overlay geometry** (handles, drop indicator, menus, remote carets, range highlights) | projection + Surface mapper + layout | Surface overlay | once per frame when a commit, a resize (`ResizeObserver`), a scroll of any scroll container of the host, a readonly change or a peer change happened; visible set only | overlay |
| **Caret-stop stream** (grapheme, word, atom, block edge, document edge) | index order + displayable | Session navigation | per motion | navigation keys |
| **JSON value** | `document.toJSON()` | Document | memoized per version, skipped when unconsumed | `value`, `onChange` |

The **four categories**:

| Category | Where it lives | Never mixed with |
|---|---|---|
| Immutable admitted meaning | command values and prepared plans; attempt intent/target/owner; composition `startTarget` + `marks`; admitted clipboard flows (validated, fresh ids); adopted capability; definitions; selection values | nothing re-reads the DOM event or recomputes a target after admission |
| Replaceable attempt state | attempt `expect`/`phase`/`deadline`; composition `region`/`phase`; projector `displayed`; drag placement; UI-held anchors; suggestions; extension view state | never persisted. Composition previews are replicated and tracked, but inside one capture group, so the undo step they form is the commit's |
| Durable progress | engine doc; persisted rows; migration record; undo stacks | no lease, owner or expiry fields in durable records |
| Resource ownership | IME host element (session); DOM nodes (cells); sockets, timers, awareness (the provider that created them); `navigator.locks` lock (migration attempt); observers and listeners (mount) | releasing a resource never changes a document fact |

## 3. Ownership map: fact → owner → lifetime → consumers

Citation keys in "Replaces" point at the reader reports' fact tables (**M** runtime-model, **C** crdt-core,
**S** selection, **I** input-events, **P** plugins-ui, **T** sync-collab) or at a finding in §12. "×n" is the number
of places that decide the fact today. A fact that was already single-owner keeps its owner and is not repeated (rank
codec, word boundary, grapheme segmentation, node-bound provenance, goal column, drop placement, handle offset,
platform flag, remote-apply origin).

### 3.1 Document (lifetime: the doc unless noted)

| # | Fact | Owner module | Lifetime | Consumers | Replaces |
|---|---|---|---|---|---|
| O1 | Block identity (minted by the creating op; one normalization for writes **and** lookups; a concurrent same-id creation is settled by registry last-writer-wins plus the nonce) | `doc/ingress` + creating op | replicated | everyone | M-F1 (5 mint sites), C-F20 (≥12 ingress sites), C-C11 |
| O2 | Which block displays a text position | `doc/streams` (boundary items + claims, R2) → index | per transaction | content ops, anchors, runs | C-F5 (×6), C-F17 (×2) |
| O3 | Display offset ↔ (backing text, index) | `doc/streams` `locate`/`position` (the only mapper) | derived | content ops, anchors | C-F6 (≥10 walks), M-F5 (7 mappers), S-F12 |
| O4 | Where a split's boundary goes: the end of the gap, with the formats in effect there | `doc/streams` split over vendor primitive **P7** | per split | split, undo placement | missing today; decides A-5/R16 (F1) |
| O5 | Block is live / targetable (no live delete mark ∧ self-owned ∧ every display ancestor visible) | `doc/index` `isLive` | per transaction | op preconditions, change report, anchors, Session | C-F3 (×7, disagreeing; probe C6), M-F9 (6 flags) |
| O6 | Delete: per-writer marks on the block and what it displays (claims, transitively); no content tombstoning | `doc/document` delete | per delete, replicated | every delete path (view, headless, remote) | M-F15 (P3/P3b), X1, F2, F12 |
| O7 | Document order (pre-order over visible blocks; island sealing is a separate policy) | `doc/index` `order`, `compare(a, b)` | per transaction | range selection, range delete, block selection, clipboard, drag groups, navigation | M-F11 (P1), P-F8 (×3, `block-extend`) |
| O8 | Structural capability (move/nest/merge across void/island/own subtree) | `doc/document` `canPlace`, `canMerge` over adopted roles | per call | DnD affordance **and** commands (same function) | M-F12 (P2), P-F5 (×6) |
| O9 | Default child type for a parent, applied against the **actual** parent | adopted capability `defaultChild(parentType)` | document | split, paragraph insert, merge-unnest, clear, root normalize | M-F14 (P10, P12), M-F16 |
| O10 | Prepared plan + effect summary (before any write); observed outcome `refused \| noop \| applied`, ids, position (after) | doc op `prepare` (plan); transaction fold (result) | per op | dispatcher, hooks, attribution, undo capture | C-F10 (~10 predictions), C-D9, M-F6; FP-6 |
| O11 | Freshness ("derived state caught up") | `doc/index` version (one counter) + fold watermark | per transaction | memoized reads | C-F11 (5 counters), M-F19 (4 counters); F11 |
| O12 | Which blocks/facets a transaction touched | the fold over the engine's changed set | per transaction | index invalidation, change report, attribution | C-F12 (5 interpreters), C-F13 (2 diffs) |
| O13 | Change report | `doc/index` fold → `doc/document` publication | per commit | cells, Session, `onChange` | M-F10 (2 reconcilers), M-F3 |
| O14 | Anchor mint/resolve (`pending` ≠ `dead`); seam of a dead block for endpoints this view did not author | `doc/anchors` | per call | selection, presence, history, composition, held ranges | S-F2 (×5), S-F19 (5 seam rules), C-F17 |
| O15 | Range deletion between two positions (merges governed by `canMerge`) | `doc/rangeDelete` (prepared) | per command | delete keys, typing over a range, cut, paste over a range, an IME start target | I-F19 (3 ladders), `deleteContentWithinSelection` (P2, P5, P9) |
| O16 | Placement of an admitted flow (inline runs + kinded blocks, fresh ids) | `doc/flow` | per paste/drop/convert | clipboard, HTML, markdown, slash convert | P-F16 (`paste-shape`), P-F17 |
| O17 | Readiness and the seed decision (empty ∧ every provider settled or its bound elapsed ⇒ apply the deterministic seed update) | `doc/lifecycle` | document | views (`ready`), history | T-F6 (4 latches), T-F8, C-F14, M-F25; FP-1, F5 |
| O18 | Document writable (a foreign stamp got in despite the inbound check) | `doc/lifecycle` `writable` | document | dispatcher permission, UI, outbound quarantine | T-F25 (P7) |
| O19 | Attribution stamp + lineage capture: once per outer transaction; none for undo/redo transactions; lineage for undo/redo taken from a `beforeTransaction` listener | write funnel | outer transaction | `b/` records | C-F22 (~20 sites); F4 |
| O20 | Schema / attribute names | `doc/schema` | build | all | C-F19 (2 tables) |
| O21 | Lifetime of per-doc derived services | the doc (attached once, never leased) | document | index, lineage trim, rand | C-F15 (4 policies) |
| O22 | Phantom content slot: declared `rendersContent`, verified in dev at a settled barrier; the Surface's displayable fact filters at projection | adopted capability + Surface | document | seam, navigation, projection | M-F30; FP-9 |
| O23 | Incarnation of a block (which creation a boundary, an attribution record or an anchor refers to) | the replicated nonce `n` | replicated | streams, attribution | attribution's local `redone` walk (F7) |
| O24 | Restoring a deleted definition in place | `doc/document` restore (migration `force` only) | per force | migration | F13 |

### 3.2 Session (lifetime: the view unless noted)

| # | Fact | Owner module | Lifetime | Consumers | Replaces |
|---|---|---|---|---|---|
| O25 | The local selection | `session/selection` value (L4) | until the next `select()` | everything | S-F1 (4 constructors + 5 repairers), S-F5, P-F9 |
| O26 | Direction | the value (anchor/focus order) | value | commands, presence, history | S-F3 (wrong formula ×4) |
| O27 | Side effects of a selection change: focused/selected sets, hooks, attributes (rendered from the value; the write bumps the render epoch), one `onSelectionChange`, presence publish, clearing suggestions the caret left | `select()` | per write | UI, plugins, peers | S-F13 (7 writers), S-F20 / T-F15; FP-5 |
| O28 | Pending marks at a collapsed caret (values kept) | the value (`pending`) | until the caret moves or text is inserted | insertion | M-F7, I-D12 |
| O29 | Marks of an inserted run: explicit → pending → common-of-replaced → neighbour before, else after → mark edge policy, which reads the admitted edge side | `session/editing/text` `marksForInsertion` | per insertion | typing, IME commit, paste, adoption, soft break | I-F5 / M-F8 / P-F6 (×8); FP-8 |
| O30 | Permission, hooks (before any write: the prepared command, then each planned step by its documented name; veto refuses the whole command, replacement re-prepares), transaction, result selection | `session/commands` dispatcher | per command | every mutation | P-F12 (14 caret writers), P-F15 (7 catch sites), P-F29 (readonly ×7), I-F14 (×9); FP-6 |
| O31 | Undo-step grouping: cut before delete, paste, drop and structural commands; cut after a paragraph split; coalesce insertions within `captureTimeout`; one capture group per composition session | dispatcher undo policy | per command | history | P-F13 (20 `stopCapturing`); FP-2, F3 |
| O32 | Undo/redo execution and selection restore | `session/history`: bare `um.undo()/redo()`, never inside a transaction and with no tracked write after; `{before, after}` recorded by the dispatcher; restore in the issuing view via `select()` | stack item | issuing view | S-F18 (2 pipelines; C1), M-F18 (P4); F4 |
| O33 | Intent, anchored target, owner and expectation of an input occurrence | `session/attempt` (one inputType/key → intent table; per-host queue) | occurrence → expectation met, contradicted or deadline | commands, observer | I-F1 (×7), I-F2 (×8), I-F15, I-F16, I-F17, M-F24; BI-7 |
| O34 | Composition: host, region, marks, capture group, phase (`live → tail → gone`), and the ending (commit, explicit cancel, abandonment that adopts the DOM) | `session/composition` | `compositionstart` → end of tail | preview, commit, cancel, pin, observer attribution | I-F6 (7 writers, 3 encodings), I-F7 (9 resets), I-F8, M-F21, M-F22; BI-1, BI-4, BI-5 |
| O35 | Ranges held by UI across think-time | `session.hold(range)` → anchors | until the UI closes | slash menu, toolbar, link editor | P-F23 (`stale-offsets`) |
| O36 | Key-binding precedence (consumer > extensions in list order > built-ins; first claim wins; returned, not thrown) | `session/keymap` | editor | keydown | P-F14, I-F22 |
| O37 | Relative block move (up/down/in/out) | `session/moves` → `doc.moveBlocks` (returns the moved ids) | per command | hotkeys, handles, drag, menus | P-F22 (`move-down`) |
| O38 | Paste/drop payload precedence | `session/editing/clipboard` | per paste/drop | transfer adapters | I-F21 (×3) |
| O39 | "A range covering exactly one inline atom is an atom selection" | `session/selection` normalization | per value | inline-atom UX | S-F21 |
| O40 | Caret after removing a selected atom | one atom-removal command | per command | Backspace/Delete/printable | P-F10, P-F11 |
| O41 | Where an operation applies | the command's explicit target | per command | ops, plugins | M-F32 |
| O42 | Result selection of a local command (block-set delete or cut: end of the previous unselected block's first editable text; the next block when none precedes) | the command | per command | `select()` | `replaceSelection.ts:133-143`, `hotkeys.ts:680-695`, `onCut.ts:20-27`; FP-7 |
| O43 | Suggestions: set, clear when the caret leaves the block, accept (Tab), dismiss (Escape), survive a composition at their boundary | `session` (L12) | view | Content renderer, bindings | `block.svelte.ts:247-275`, `selection.svelte.ts:1943`; FP-5 |
| O44 | Vertical goal column | `session/navigation` | consecutive vertical moves | navigation | single today |

### 3.3 Surface (lifetime: one mount unless noted)

| # | Fact | Owner module | Lifetime | Consumers | Replaces |
|---|---|---|---|---|---|
| O45 | Which DOM element *is* block X (tag from `definition.element(data)`; snippets render inner markup) | core `Block.svelte` | mount | DOM mapping, handles, drop targets | P-F1 (`code-attach`), P-F2 |
| O46 | Render state of a visible block | `surface/cells` | block visible lifetime | components | M-F10, M-F28 |
| O47 | Segment boundaries and keys (key = preceding atom id; the host cell's segment list frozen while composing) | `surface/cells` + `surface/pin` | per runs | Text renderer, DOM map, pin | M-F2, M-F4, S-F26; BI-13 |
| O48 | DOM point → *(block, offset)*, plus the side of an inclusive mark edge (one interpreter; *settled* / *DOM ahead of model*) | `surface/domPoint` | per read | observation, admission, adoption, paste, drop | S-F10 (≈6 interpreters; C5), I-F3; FP-8 |
| O49 | *(block, offset)* → DOM point (pin-aware while a session is live) | `surface/domPoint` + `surface/pin` | per write | projector, remote carets | S-F11 / T-F24; BI-2 |
| O50 | Writing the DOM selection | `surface/projector` (from the root post-flush `$effect`) | per flush / select / mount | browser | S-F14 (16 staleness mechanisms), S-F17, I-F13 |
| O51 | Classifying a `selectionchange` (echo / composition / drift / foreign / intent) | projector classifier (≤ 2 named, counted signatures) | per event | Session | S-F15 (C4) |
| O52 | A native selection move not yet reported | projector: mints anchors from the DOM selection before the first transaction after a settled render that this view did not issue (the document's `beforeTransaction`, told apart by origin; skipped where the dirty set shows the DOM ahead of the model) and admits the move through `select()` after that transaction commits; reads it at every command-issued `select()` | per transaction | classifier | BI-3, LH2-5 |
| O53 | Focus verdict: foreign control, user-owned `body` (last gesture outside), or orphaned by our own flush | projector (inputs: `activeElement`, last gesture landing, where the live DOM selection is, whether the element that held focus before the flush, noted by the root `$effect.pre`, is still connected) | per write | projector | S-F16 (3 verdicts); BI-14 |
| O54 | Scroll permission | attribution frame (user / programmatic) | per write | projector | M-F23 |
| O55 | Render epoch, and the records signal | `surface.update`: every host-rendering state write bumps the epoch; the MutationObserver callback, deadline expiry and attempt phase changes write the records signal, which re-runs both passes and never reaches the classifier | monotone | classifier (epoch only), root `$effect.pre` and `$effect` (both) | missing today |
| O56 | Gesture serial and landing (inside / outside) | `surface/events` | monotone / until the next gesture | classifier, focus verdict | `lastUserGestureOutsideEditor` and its three consumers |
| O57 | Pointer drag active | `surface/pointer` | one drag | projector (no display writes) | the drag guard at `selection.svelte.ts:2375-2380`; BI-3 |
| O58 | Whether a host DOM difference is input: each block's content (every text node under its text elements in document order, fillers stripped, an atom one unit) compared with its cell; strict containers (root, text and core mark elements) with what the cells render; registered elements and anchors that went missing; records name elements and, for strict containers, keep added and removed nodes and siblings, never provenance (R12) | `surface/observer` pre pass (root `$effect.pre`) and compare pass (root `$effect`) + the core components' attachments that register elements | per flush | classifier | I-F9, I-F10, I-F11 |
| O59 | Adopt or revert an observed text change (attributed by expectation: an attempt's or the composition tail's; the edit is the preferred-position diff from the content's last rendered text, placed through its runs' start anchors and rebased within the run when the same flush re-rendered it) | `surface/observer` + `session/attempt` | per divergence | commands | I-F15 / I-F16, I-C4; BI-7, BI-8 |
| O60 | Attribute ownership: identity attributes and the root's `contenteditable` (owned by the readonly state) are healed; declared view-state attributes and extension attributes are never inverted | `surface/observer` table built from kind records | editor | observer | `domTextMutationObserver.ts:1137-1152, 1351-1366`; FP-4, LH-6 |
| O61 | Read-only observer policy: ignore foreign changes except owned-attribute healing | `surface/observer` | while readonly | — | `domTextMutationObserver.ts:1603-1605`; FP-11 |
| O62 | Placeholder visible | `Text.svelte` `$derived` → `data-placeholder` | per render | CSS | I-F12 / M-F27 / P-F4 (×9) |
| O63 | Overlay geometry | `surface/overlay` (one measure per frame, editor-relative) | per frame | chrome | P-F24 (4 loops), T-F12, G24 |
| O64 | Is this event the editor's (DOM facts) | `surface/events` `admit(event)` | per event | Session | I-F18 (≥11 sites) |
| O65 | Displayable destination (mounted and not hidden by view state) | Surface | per render | projector, seam filter, caret stops | the delete contract's settled-barrier rule; FP-9, BI-12 |
| O66 | Host-visible view state writes | the state's owner (cells, Session, declared extension view state); `surface.update` bumps the render epoch | per write | renderer, classifier | BI-9, FP-4 |
| O67 | Is the DOM out of sync with the render tree? | **the compare pass** (R12): after each flush a divergent content or container is input, adopted or undone where it diverges; a missing registered element is re-inserted from its record before Svelte reconciles; no remount heuristic | per flush | observer | M-F26 (4 heuristics incl. whole-editor `{#key}`; `tab-remount`) |

### 3.4 Extensions (lifetime: editor, immutable)

| # | Fact | Owner | Consumers | Replaces |
|---|---|---|---|---|
| O68 | Everything about a block kind: element, renderer, role, `rendersContent`, `rendersChildren(data, view)` when view state hides children, `defaultChild`, HTML import/export, markdown prefix, command row, empty shape, declared view-state attributes, render-only text decoration | one **kind record** | adoption, Surface, clipboard, slash, markdown, observer | P-F19, P-F20, P-F21; `transformText` (FP-10) |
| O69 | Everything about a mark: renderer, HTML forms, sanitizer, binding, edge policy (inclusive, exclusive, or side-dependent) | one **mark record** | Surface, clipboard, `marksForInsertion` | P-F25; the link-edge rule (FP-8) |
| O70 | Precedence of duplicate definitions (first wins, as the README states) | registry | all registries | P-F14 |
| O71 | Block-drag MIME | one constant | handles, drop admission | P-F28 |
| O72 | Documented hook surfaces: `onBlockAttached`/`onTextAttached`/`onEdytorAttached` (Surface attach, with the element); `onBeforeInput(event)` (before admission; may claim the occurrence); `onDeleteSelectedBlocks` (hook of the block-set delete command); plugin `commands` with `isEnabled` and async `run`; `MarkDefinition.void` and `use:block.void` (Surface) | registry + the named owner | extensions | FP-10 |

### 3.5 Transport (lifetime: provider / container / document)

| # | Fact | Owner module | Lifetime | Consumers | Replaces |
|---|---|---|---|---|---|
| O73 | Bytes are of a compatible generation (engine + wire + schema); an update that writes a foreign schema stamp is refused inbound; a read-only document neither persists nor broadcasts | `sync/envelope`, `sync/room`, `sync/container` | frame / container | every integration | T-F3, T-F4, T-F2; F8 |
| O74 | Provider has ever synced / is connected / failed once | `sync/room` | provider | readiness, UI | T-F5 (P1), T-F7 |
| O75 | Providers attached to a document | registry keyed by **transport target** | document | views | T-F9 (P8) |
| O76 | Join handshake (reply Step2 and, if the peer holds what we lack, our own Step1) | `sync/room` | per join | convergence | T-F10 (P5, P6) |
| O77 | Presence entry (one encoding: anchors) | the view that minted `viewKey`; `sync/presence` | view | peers | T-F13, T-F14 |
| O78 | Stored-row key discipline (append-only for every writer) | `sync/container` | container | hydration, compaction, migration | T-F17 (P3/P3b) |
| O79 | Migration attempt (lock) vs progress (import row + `active` record); `status()` reports `pending` while another tab holds the lock | `sync/migration` | lock: tab; record: container | boot | T-F18, T-D7; FP-12 |
| O80 | Legacy logical-id normalization | one pass + the canonical converter | migration run | rebuild, verify | T-F19 |
| O81 | Frame header | `frame(type, write)` | per frame | all writers | T-F1 (12 sites) |

### 3.6 Open (no owner decides it yet)

| # | Fact | Status |
|---|---|---|
| O82 | Reading order of concurrently split siblings (16/40 client pairs misorder today) | R2 makes it decidable (boundary order is replicated); a placement rule that uses it is a separate task (D-18) |
| O83 | Concurrent `delete(p)` ‖ `move(child of p → root)` | product decision (rescue vs delete-wins-subtree), unchanged (D-19) |

## 4. Module / layer map of the new `src/lib`

**Dependency direction** (enforced by lint import rules):
- `vendor/yjs ← doc ← sync`; `doc ← session` (Session never touches the DOM); `doc, session ← surface` (the only DOM
  toucher); `plugins` declare records, contribute Session commands and Surface overlay components, and receive handles
  and `surface.update`; `edytor.svelte.ts` composes the five contexts.

**Prohibitions** (checked in review; they carry the invariants):
- `doc/` never reads view state and never writes outside an applied plan (the seed writer's one update is the only
  other write).
- `session/` never touches the DOM, never awaits, never reads ambient selection. DOM facts reach it only as values the
  Surface admitted (edge side, displayable, gesture landing).
- Only `surface/projector` writes the DOM selection. Only the renderer writes the host (from cells and declared view
  state, each write bumping the render epoch through `surface.update`), apart from the observer's inversions and
  restorations. The core's host writers are template effects and attachment bodies (lint: no nested `$effect` writes
  the host), so each write lands before the root `$effect` of its flush. Only `surface/observer` interprets DOM
  mutations, as divergence from the cells after a flush, and it learns about kinds only through the
  attribute-ownership table built from kind records.
- Only `session/composition` holds composition state. Only `session/history` calls the engine's undo/redo.
- A fork feature (P4–P7 and any later one) is recorded in `vendor/yjs/UPSTREAM.md` with its upstream base and a
  differential test, and charged to the module that needs it.

**Budgets.** Execution xloc with the shared counter, rounded to 5. They are the §7 **target** per module: the floor,
plus evidenced under-budget items, plus accepted repairs, plus the module's share of unrealized trims and of returning
browser machinery (§7.2). Rule 6 of §9 gates each checkpoint on them. They sum to ≈17,174.

### 4.1 `doc/` — Document context (≈ 4,460)

| Module | Responsibility | Rules | xloc |
|---|---|---|---:|
| `doc/schema.ts` | One schema-name table, stamp gate reads, typed errors, `assertUsableDoc`, admission verdict + staged `admitUpdate` for bytes of unknown provenance (`loadDocument`, `attachDocument`) | R13 | 125 |
| `doc/rank.ts` | Rank codec for placement (digits + client tie-break, bounded append window) | — | 100 |
| `doc/placement.ts` | Candidates, atomic `{p,r}` writes, top-2 compaction, acyclic resolution, rehome; spec materialization, bulk insert, id-collision refusal; canonical `project` | R5, R6 | 470 |
| `doc/streams.ts` | Backing texts with boundary items (split through P7 at the end of the gap); stream table with the streamless rule; merge claims + `owner()`; `locate`/`position`; content ops (insert, per-stream delete that never removes a boundary, format, inline atom by id); split = boundary + claim re-insert; range reads skip boundaries | R2, R6 | 700 |
| `doc/index.ts` | The per-doc derived index folded once per transaction behind a watermark (local clock + folded delete set); records, streams, owners, placements, children, order, `isLive` (delete marks), runs with structural sharing (each run carries its first character's id, which the Surface anchors on), dependency capture, commit-bound publication with listener isolation | R5, R6 | 655 |
| `doc/document.ts` | The facade: every structural and metadata op as `prepare → apply` with void/island/`defaultChild` policy and an effect summary; delete with per-writer marks over claims; restore-definition (for `force`); all-or-nothing `setBlock`; duplicate; `toJSON`; write funnel (touched set, attribution and lineage once per outer transaction, none for undo/redo; lineage for undo/redo from `beforeTransaction`); change report; undo-manager factory | R1, R3, R5, R6 | 860 |
| `doc/anchors.ts` | Anchor codec (mint at *(block, offset, side)*; resolve → *(block, offset)* \| `pending` \| seam); seam from the dead block's replicated slot, for endpoints the view did not author | R4 | 65 |
| `doc/rangeDelete.ts` | Prepared range deletion between two positions per `del.range.*`, merges governed by `canMerge` | R5, R6 | 130 |
| `doc/flow.ts` | Place an admitted flow (inline runs + kinded blocks, fresh ids) at a position | R6 | 70 |
| `doc/ingress.ts` | JSON boundary: clone + dev warning, wire sanitize, spec converters, fresh ids; one normalization for writes and lookups | R1 | 205 |
| `doc/lifecycle.ts` | References and dedupe; capability adoption with atomic conflict refusal; readiness (settle-or-bound) and the deterministic seed (scratch doc, hashed writer, derived ids/nonces/ranks, non-local apply); `writable` guard; provider registry keyed by transport target; owned/borrowed teardown | R5, R13 | 535 |
| `doc/attribution/*` | Per-block created/contributors/last-changed keyed by incarnation `n`; lineage ring with convergent trim; actor dictionary (product feature). The local `redone` walk is gone | R6 | 315 |
| `doc/handles.ts`, `structs.ts`, `engine-api.ts`, `rand.ts`, `public.ts` | Typed headless handles (`document.block(id)`); two vendor-store walks; engine typings; rank randomness seam (seedable); public barrel (documented API only) | — | 230 |
| *fork P7* | `insertAtGapEnd(index, content)`: the insert walk passes every deleted item and every format item before the next live content item, then inserts with the formats in effect (no format items added). Charged here, outside the `src/lib` metric | R2 | (≈30) |

### 4.2 `sync/` — Transport context (≈ 1,850)

| Module | Responsibility | Rules | xloc |
|---|---|---|---:|
| `sync/envelope.ts` | Generation word (engine, protocol, schema) per frame; container generation record; `frame(type, write)` | R13 | 35 |
| `sync/sync.ts` | Step1/Step2/Update codecs, remote origin, `applyRemote(doc, update, origin, onError)`, state-vector coverage test | R13 | 50 |
| `sync/awareness.ts` | Presence protocol (verbatim port; the engine has none) | — | 215 |
| `sync/auth.ts` | Permission-denied read | — | 15 |
| `sync/room.ts` | Shared provider lifecycle (`hasSynced` vs `connected`, failed-once, `whenSynced`, departure announcement, destroy guard); one join rule; frame dispatch; **inbound refusal of updates that write a foreign schema stamp; outbound quarantine of a read-only document** | R1, R13 | 190 |
| `sync/container.ts` | IndexedDB container: store names, row codec, one verify-or-stamp rule, non-creating open, existence probe, append-only rows | R1, R13 | 55 |
| `sync/indexeddb.ts` | Hydration (verify → getAll → one apply transaction), append, debounced compaction, commit-tracked `storeState` | R1 | 225 |
| `sync/websocket.ts` | y-websocket option parity: status events, backoff, liveness, auth, optional resync timer (no longer a correctness dependency) | — | 335 |
| `sync/index.ts` | `createIndexeddbSync` / `createWebsocketSync` factories exposing a transport-target key | — | 50 |
| `sync/presence.ts` | One entry per view key (anchors + collapsed/reversed); publish/clear by the owning view; freshest-per-client; anchor resolution (geometry lives in `surface/overlay`) | R1, R4 | 265 |
| `sync/attach.ts` | Attach providers deduped by transport target; readiness wait = one subscription | R13 | 20 |
| `sync/migration/*` | v13 reader; `navigator.locks` attempt ownership with an in-process fallback where locks are absent; import row + `active` record in one transaction; `force` through restore-definition; `status()` reports `pending` while the lock is held (`locks.query`); `wait:false` maps to `ifAvailable` | R1, R13 | 370 |
| `collaboration/*.ts` | Public re-export shims for the documented import paths | — | 25 |

### 4.3 `session/` — Session context, DOM-free (≈ 3,550)

| Module | Responsibility | Rules | xloc |
|---|---|---|---:|
| `session/selection.ts` | `SelectionValue`; `select(value, cause)` with epoch and every side effect once (incl. clearing suggestions); `project(value, version)`; single-atom normalization; value builders behind the public write API; `selection.state` compatibility getter (DOM-derived fields supplied by the Surface); `hold(range)`; suggestions state | R4, R9 | 365 |
| `session/history.ts` | Bare `um.undo()/redo()` (never wrapped, no tracked write after); `{before, after}` per view from `stack-item-added/updated`; restore in the issuing view through `select()` | R7, R9 | 75 |
| `session/commands.ts` | Dispatcher: permission (readonly, `document.writable`) → prepare → hooks before any write, on the prepared command and on each planned step by its documented operation name (veto refuses the whole command; `prevent(() => …)` or a returned command replaces it and is re-prepared, at most once per extension; `prevent()` is caught here, once; a payload returned for a nested step is ignored with a dev warning) → one transaction → normalization once per touched parent → undo policy table (cut before / cut after / coalesce / capture group) → result selection; adapters for the documented operation names hooks match on | R6, R7 | 375 |
| `session/handles.ts` | Plugin-facing `Block` / `Text` / `InlineBlock` handles (id-only; getters read the index; mutators issue commands; cache pruned from `removed`); JSON-accepting `insertChildren`/`insertParts` shim | R1, R7 | 300 |
| `session/editing/text.ts` | Insert text with `marksForInsertion` (edge side aware); grapheme/word/line units; soft break; mark/format commands over projected segments; public `splitText`/`setText` | R4, R7 | 350 |
| `session/editing/structure.ts` | Paragraph (split, insert-before at start, lift content above children), collapsed delete ladders per the delete contract, atom removal/replacement, nest/unnest, convert, block-set delete/cut with its own result selection, suggestion accept/dismiss, range replacement | R5, R7, R9 | 495 |
| `session/editing/clipboard.ts` | Copy/cut (clipboard written before the delete), paste/drop payload ladder, fragment extraction from the projection | R7 | 150 |
| `session/attempt.ts` | One inputType/key → intent table (incl. misreport overrides); attempts with owner, anchored target, expectation, deadline and phase, queued per host; keydown fallback against the anchored target; Android no-op-Backspace test = "did this attempt's adoption apply a deletion"; the pre-admission `onBeforeInput` hook | R4, R8 | 510 |
| `session/composition.ts` | Session: start (target replacement as a command, marks captured, capture window opened), `preview` (mechanical tracked write inside the capture group, no hooks), `commit` (one user-origin command deleting the live preview items per stream and inserting at the region start), explicit `cancel`, abandonment (adopt the DOM), tail (`live → tail → gone`, ended by the next non-composition occurrence or a timestamp compared at use; while it lasts, an expectation queued on the host resolves late composition changes to the committed text), phantom-key guard, D-20 structural rule (IME updates that continue after a forced commit open a new session) | R4, R7, R8 | 325 |
| `session/keymap.ts`, `session/bindings.ts` | Registry, canonical chord encoding, platform/AltGr/dead-key/layout rules, one precedence rule; built-in bindings as rows (undo/redo, Tab, select-all ladder, block-selection keys, Emacs table) | R7 | 350 |
| `session/navigation.ts` | One ordered stream of caret stops (skipping non-displayable content) + word stepping + block/document boundaries; one apply step; node-bound extension canonicalization; RTL; bindings as data | R9 | 215 |
| `session/moves.ts` | Relative move (up/down/in/out) → `(target, position)` → `doc.moveBlocks`; capability via `canPlace` | R5, R7 | 40 |

### 4.4 `surface/` — Surface context, the only DOM toucher (≈ 4,615)

| Module | Responsibility | Rules | xloc |
|---|---|---|---:|
| `components/*.svelte` (`Edytor`, `Block`, `Content`, `Text`, `Mark`, `InlineBlock`) | Generic recursive render. `Block` renders the block element from the definition; snippets render inner markup. `Text` renders each run declaratively (Svelte's text writer; filler and text in one node for an empty block), with no write guard; `Mark` renders the element a mark record declares; the core's attachments register the block, text, mark and atom elements (lines booked with the observer). `Text` renders the `data-placeholder` attribute (the library ships its `::before` rule). Root attributes are declarative. The click re-derivation stays until a real-browser check retires it | R11 | 340 |
| `surface/suggestions.ts` | Ghost-text view objects from plain JSON (declared shape, no Proxy) | R11 | 25 |
| `surface/cells.ts` | One reactive cell per visible block id, created/disposed/patched from change reports and re-derived from the session state it reads (each write bumps the render epoch; the cells patched since the last pass are kept for the observer's pre pass); segments with causal keys; atom cells (edge-click caret placement); render deltas with equal-mark merging; snippet view objects; displayable | R1, R11 | 610 |
| `surface/pin.ts` | IME host pin: freeze the host cell's element, segment list and base render; splice the preview; pin-aware DOM mapping; one catch-up patch at session end, after which the host returns to the compare pass against its cell, re-dirtied (the tail's expectation covers late composition changes) | R8 | 60 |
| `surface/domPoint.ts` | One DOM-point interpreter (element boundaries, stray nodes, fillers; *settled* / *DOM ahead of model*; edge side of an inclusive mark), one model → DOM mapper, shadow roots, multi-range and composed ranges, UTF-16 normalization | R4 | 565 |
| `surface/projector.ts` | `display()`: the only DOM-selection writer (current value, displayable target, no drag, no live composition host, three-input focus verdict, dedupe, backward ranges, scroll only in a user frame); mints anchors from the live DOM selection before the first transaction after a settled render that this view did not issue and admits the move through `select()` after that transaction commits; displays from the root post-flush `$effect`, deduped on (selection epoch, render epoch); `displayed` + render epoch; the classifier with ≤ 2 named, counted signatures; DOM-derived compatibility fields | R10 | 815 |
| `surface/pointer.ts` | Hit testing, triple click, drag across atoms, drag flag, click-into-block-selection collapse, `selectstart` guard | R10 | 210 |
| `surface/geometry.ts` | Visual lines for vertical navigation | — | 110 |
| `surface/observer.ts` | Render epoch (`surface.update` is an epoch bump) and the records signal; record intake (the elements to compare, plus added and removed nodes and siblings for strict containers); owned-element registry (block, text, mark and atom elements ↔ cell; each content's last rendered text and run anchors; strict or tolerant container); the pre pass in the root `$effect.pre` (missing registered nodes and anchors re-inserted, edited contents snapshotted); the compare pass in the root post-flush `$effect` (each content's text against its cell, shape against its runs, unregistered children of strict containers, identity clones and escaped nodes, owned attributes against the table; the live composition host skipped, re-dirtied at session end); classification by location and expectation (attempts, the composition tail); adoption by prefix/suffix diff with a preferred position, placed through run anchors; undo of foreign damage by restoring the current cell (exact text, else a remount of that element; never removing framework anchors); attribute-ownership table; read-only policy (text divergence inverted at the flip back); bounded repair; WebKit converted spaces; wrapper-replacement adoption; native line-break detection | R8, R11, R12 | 1,070 |
| `surface/events.ts` | DOM listener wiring (one keydown handler per occurrence), `admit(event)`, gesture serial and landing, attribution frames, Shift-paste tracking, drop point, drag source, focus-in restore, attach hooks | R8, R10 | 550 |
| `surface/clipboard.ts` | Three clipboard flavours (private type, HTML embedding the fragment, plain); fragment shape validation at admission; HTML/plain export walk over kind/mark records | R1 | 140 |
| `surface/overlay/*` | Layer outside the host: remote carets and range highlights (geometry moved from `collaboration/remoteSelection.ts`), the shared anchored-positioning helper (one measure per frame over the visible set; invalidated by commits, resizes, any scroll container, readonly, peers) | R11 | 120 |

**`surface/observer` re-budget (revisions 2 and 3).** Only the lines that change are estimated; the rest carries over.

| Change | What | xloc |
|---|---|---:|
| Revision 1 budget | the bracket design | 990 |
| Disappears (r2) | bracket duties: record hand-off before apply, `flushSync` and display ordering, own-record discard, nested-apply queue, effect-deferred bracket end, the dev assertion and its CI wiring, the exemption hook (LH-6's list) | −80 |
| Disappears (r2) | the record queue, the observer's own microtask flush and `oldValue` capture: records now only name the nodes to compare (L65) | −35 |
| Disappears (r2) | the location classifier and the identity helpers: both become registry lookups (L65) | −30 |
| Stays (r2) | classification by location and attempt expectation; the preferred-position diff and its plumbing; inversion by exact text or smallest-unit re-render; bounded repair; the attribute-ownership table (≈100); the read-only policy; WebKit converted spaces; wrapper-replacement adoption; native line-break detection; the composition-host exclusion, now the IME-preview tolerance; the module's share of unrealized trims and returning machinery | 845 carried |
| New (r2) | render epoch: `surface.update` is an epoch bump | +5 |
| New (r2) | owned-node registry: text node ↔ cell, segment and text last written; element ↔ cell; strict or tolerant surface; framework-anchor predicate; the registration calls in the component attachments (a node is registered by the attachment that first writes it) | +25 |
| New (r2) | the compare pass in the root `$effect`: dirty-node walk; text against the text last written; strict child lists (text and mark elements) against registered nodes and anchors; owned attributes against the table; the live composition host skipped, and handed back with the base its session accounted for; the focus-orphan check; then the projector's display | +60 |
| New (r2) | render write guard and base-relative adoption: the writer never overwrites a node that differs from what it last wrote, and adoption diffs against that text at the open attempt's anchored target | +25 |
| **Revision 2 budget** | | **960** |
| Changed (r3) | the registry holds elements only (block, text, mark, atom), each content's last rendered text and its runs' start anchors; no text-node entries | 0 |
| Disappears (r3) | the render write guard: a skipped write was never retried and left stale text (BI2-1) | −25 |
| New (r3) | pre pass in the root `$effect.pre`: every dirty or re-rendered content whose DOM differs from its last rendered text is snapshotted before the flush's writes (BI2-3, LH2-4) | +15 |
| New (r3) | placement of a snapshotted edit through its base runs' start anchors, rebased within the run (three-way prefix/suffix), so it follows its text through a re-key, split, move or retype (`doc/index` +5 for the run ids) | +15 |
| Changed (r3) | per-content comparison: every text node under the content's text elements in document order, fillers stripped, an atom one unit, against the cell; partition and mark-chain check against the runs (BI2-4) | +30 |
| New (r3) | structure: record retention for strict containers; missing registered elements and anchors re-inserted at their recorded siblings in the pre pass, before Svelte reconciles; unregistered children of the root, text and core mark elements removed; identity clones and nodes that left a strict container removed with their topmost unregistered ancestor (BI2-2) | +55 |
| New (r3) | records signal (MutationObserver callback, deadline expiry, attempt phase changes) and the deferred-divergence set (BI2-5, LH2-6) | +12 |
| New (r3) | the hand-back re-dirties the host; read-only text divergence is inverted at the flip back (BI2-1) | +10 |
| **Revision 3 budget** | outside the module: the tail's expectation +10 (`session/composition`), admission after commit +12 (projector), run ids +5 (`doc/index`), declared mark elements −25 (`plugins/richtext` −30, `Mark` +5); +114 in all | **1,070** |

Option B does not save lines inside the observer: the bracket's duties go, but comparing with truth needs a registry, a
pre pass, per-content comparison and record-level structure for strict containers, so the module lands at 1,070
against revision 1's 990. The gain is risk: no other module routes its writes through a bracket, nothing depends on
who wrote a record, and the confident case's +200 exemption list is gone (§7.2, K2).

### 4.5 `plugins/` — Extensions (≈ 2,245)

| Module | Responsibility | xloc |
|---|---|---:|
| `plugins/types.ts`, `plugins/registry.ts` | Plugin contract (records, bindings, hooks on prepared commands, `surface.update` (a render-epoch bump) for view state), one precedence rule, adoption input | 130 |
| `plugins/richtext/*` | Block snippets (inner markup only); mark records that declare the element the core renders (tag and sanitized attributes from the value), which replaces the ten mark snippets; kind/mark records carrying today's per-kind data (labels, icons, keywords, markdown prefixes, HTML forms, empty shapes, ≈140 of it); native format-input mapping; link edge as a side-dependent mark policy; `open` declared view-state for `details`/`toggle`; sanitizers at render | 525 |
| `plugins/code/*` | Code kind record; Prism decoration (render-only); auto-pair on user-origin inserts; forward-delete before a code block as a command replacement; merge guard as capability; Tab/suggestion keys | 230 |
| `plugins/blockHandles/*` | Handles in the overlay, realigned once per frame over the visible set; drop targets, placement bands, stickiness, indicator; keyboard moves emit the relative-move command; PDD adapter | 505 |
| `plugins/slashMenu/*`, `plugins/toolbar/*` | Controllers over held anchors and generated commands; components; shared overlay host | 505 |
| `plugins/html/*` | `DOMParser` → flow (one DOM walk with a mark stack, lists, whitespace pinned by fixtures from real pastes); tag tables derived from records, resolved once; flow-shape validation | 240 |
| `plugins/markdownShortcuts.ts`, `mention`, `image`, `arrowMove`, `index` | Prefix matching over kind records → convert command; `@` → insert-atom command; void image; two bindings emitting relative moves | 110 |

### 4.6 Composition root (≈ 460)

`edytor.svelte.ts` builds the five contexts and exposes the public `Edytor` handle (`document`, `selection`, `commands`,
`readonly`, `value`, `onChange`), `useEdytor` and teardown. It keeps the constructor's compatibility duties (legacy
`doc`/`awareness` path, snippet-override suffix parsing, unwinding a failed adoption), which the readers' floors
count and v1 did not. `utils.ts`, `index.ts` and `constants.ts` are the rest.

**Total: 4,460 + 1,850 + 3,550 + 4,615 + 2,245 + 460 ≈ 17,180 (the §7 target, 17,174, up to rounding).**

## 5. Deletion ledger

Each row gives the mechanism and where it lives, **xloc now → what survives elsewhere**, the rule whose invariant
replaces it ("unnecessary while …"), and the checkpoint of §9 that deletes it. Figures are the readers' range
measurements (same rules as `xloc.mjs`); read each as ±15 %. A line is counted only in the first row that retires it.
Rows marked **moved** are listed so they are not mistaken for deletions. Rows changed by the review are marked ‡, and
rows changed in revisions 2 and 3 (§12.5) are marked (r2) and (r3).

### 5.1 Document: who owns a text position (R2, R3)

| # | Mechanism | xloc | Unnecessary while … | CP |
|---|---|---|---|---|
| L1 | Slice-record model: payload types/guards/stamps, `readSliceEntries`, record anchors with B/E sentinels, `sliceRange` (`text/model.ts:47-164, 876-889, 932-957`) | 87 → 0 | … a stream is delimited by live boundary items, so there is no anchored range record to resolve | D12 |
| L2 | Per-atom ownership contest: interval index, lazy-expiry heap sweep, `gatherClaims`, `computeOwnership`, `maxG`, `claimRoutesToB` | 239 → 0 | … every text position lies in exactly one stream | D12 |
| L3 | Insertion-time ownership repair: empty-display revive, left-edge rewrite, right-edge rival claim (68 B/keystroke at a seam) | 82 → 0 | … typing at a stream edge inserts beside a boundary item; the engine walk and the caret side choose | D12 |
| L4 | Split planner `materializeSegs` + `splitSlices` | 105 → 35 | … a split inserts one boundary at the end of the gap and re-inserts the claims that follow it | D12 |
| L5 ‡ | Undo-resurrection repair: `undoRepairClaims` + `undo-repair.ts` (keep/redone detection, span walk, follow-up transaction, `changed` union) | 272 → 0 | … every boundary sits after the gap it was inserted into (P7), and `redoItem` integrates each copy between the tombstone's current left neighbour and the tombstone, so the copy stays in its stream whatever formats peers wrote. Deleted only after the D11 spike passes F-U4a–e, including the three-peer concurrent-format case | D12 |
| L6 | Run-view contest index (`recordsByText`, union-ever effects, per-text atom rows, `rangeCache`) + claim-churn refinement | 130 → 0 | … R2 (there is no contest) | D12 |
| L7 | U8b extent narrowing | 89 → 25 | … an edited item maps to its stream through the boundary index | D12 |
| L8 | Anchor owner facet (`a:-2` + `o`), `emissionOffset`, outward scan | 146 → 0 (codec keeps 22) | … a stream start is an item a caret can bind with left affinity; block = containing stream, affinity = side | D12 |
| L9 ‡ | View-side content tombstoning in `removeBlock` (`block.utils.ts:292-298`); split type/data copy-then-reset | ~15 → 0 | … R3 writes delete marks on every path and tombstones no content (the tombstoning would break ST02a and make undo-of-delete a copy); the split decides the tail's type/data once (O9) | D1 |

### 5.2 Document: one derived owner, prepared operations, adopted capability (R5, R6)

| # | Mechanism | xloc | Unnecessary while … | CP |
|---|---|---|---|---|
| L10 ‡ | Duplicate derived-state owners: fresh-collect `view()` + `collectBlocks` (60), lease wrapper (32), `ownShim`/`ctx` (33), fake-op → delta-parser round trip (~75), facade `stateVersion` + view memo (35), second ancestor walk + children builder (~35), DocChange fast/slow split + escalation (~110, of which `diffSnaps` 81 **moves** to `src/tests` as the F-O7 oracle, L63) | ~380 → 0 (net 299) | … derived facts have one owner living as long as the doc, each change is folded into it once behind a watermark, and every read and publication goes through it (probe C10's quadratic re-fold goes) | D9 |
| L11 | `marksAlready` (36), clamp/same-value/`wrote` re-derivations (~20), per-op lineage capture and attribution stamping (~92) | ~148 → 30 | … the transaction's effect set is the only source of "changed" and "touched" | D4 |
| L12 | Second schema table (35), facade pending-gate twin (~15), `_retain` (8), duplicated lineage-depth validation (8), `UndoManager.destroy` monkey-patch (10) | 76 → 0 | … one owner per fact (O17, O20, O21) | D4 |
| L13 | View re-derivations: `closestPrevious/NextBlock`, `insideIsland`, `#index`, phantom-returning `firstText/lastText` (~81), `canMoveBlockTo` (35), extension eligibility predicates (~25) | ~141 → 0 | … liveness, order and capability are each one document predicate (probes P1, P2, `block-extend`) | D1–D3 |
| L14 | `Block.value` second serializer (22) + `withMirrorInlineData` (18) | 40 → 0 | … there is one serializer | D4 |
| L15 | Two-and-a-half op layers (placement structural ops, facade policy wrappers, content wrappers repeated in placement, facade and `nodes.ts`) | ~150 → 0 | … one prepared op per intent in `doc/document` / `doc/streams` | D4, D5 |
| L64 ‡ | Attribution's incarnation walk: `sameIncarnationLine` over the local `redone` chain and the pre-incarnation heal (`attribution/block.ts:290-353`) | ~35 → 0 | … attribution records are keyed by the replicated nonce `n`, which redo copies with the record (F7); the replica-dependent early swap goes with it | D10 |

### 5.3 Render cells replace the mirror (R1, R4)

| # | Mechanism | xloc | Unnecessary while … | CP |
|---|---|---|---|---|
| L16 | Mirror maintenance: mid-transaction `flushMirror` via full `project()` + whole-tree reconcile at 16 op sites, `_projectedTree` memo, preflight + full fallback, re-subscribe-on-attach, duplicate `reconcileChildren`, carrier second pass, dead `byItems` | 315 → 0 | … operations read and write only the document, and a cell changes only when a change report is applied (probes P9/P9b: a 1,000-block delete goes from 10.6 s to the document's 7 ms) | R3 |
| L17 | Detached/spec mode: three-mode constructors (59), pending adoption (131), detached splice helpers (84), `InlineBlock._spec` (34), `groupContent` (37) | 345 → 0 | … specs are data: insertion takes JSON through `doc/ingress`, and the cell appears at commit | R4 |
| L18 | Segment identity and offset mapping: positional ids, aliases, deferred rename (66); seven offset mappers (96); contentRange's atoms-count-0 coordinates (39); `getTextById`/`getBlockByIdOrContent` (22) | 223 → 0 | … positions are *(block id, display offset)* then anchors, and a segment's only key is derived | R2 |
| L19 | Mid-transaction `refreshFromProject` + eager `$state` copies (51); `_live`/`_bound`/`_blockId`/`_drop*` flags (27); ~16 `get(id) === this` guards | ~100 → 0 | … cells are commit-consistent and a cell is live iff the last change report lists it | R2 |

### 5.4 Selection (R4, R9, R10)

| # | Mechanism | xloc | Unnecessary while … | CP |
|---|---|---|---|---|
| L20 | The 30-field state + four constructors + spread-patch writers | ~257 → 0 | … the stored selection is `{kind, anchors \| ids}` and every other field is a projection | V2 |
| L21 | Staleness repairers: `restoreRelativePosition` (84 of 104), dead-endpoint application (118), `writeCollapsed/RangeCaretState` + `resolveDeadCaretTarget` (60), capture/`reconcileSelectionAfterRemoteApply` (120) | 382 → 0 | … the stored endpoint is the anchor, its position is recomputed per version, and the projector (not a repairer) owns the composition, drag and outside-gesture guards (probe X5) | V3, V4 |
| L22 ‡ | Deferred-write machinery: staleness closures, mount polling and 10-attempt loops in `setAtTextOffset`/`setAtRange`/`setAtBlockRange`, `setAtTextsRange`, `pendingBlockRangeRequest`, `scheduleCaretWriteVerification`, `scheduleReassert`, `deadEndpointRecoveryPending`, synthetic write snapshots | ~499 → 90 | … only the projector writes, always from the current value, after admitting any unobserved native move, and only to a displayable target; the drag guard and the outside-gesture fact survive as projector inputs (probe C7) | V4 |
| L23 ‡ | Echo machinery: `ignoreNextSelectionChange` (22 writes in 7 files), `ignoreNextSelectedBlockSelectionChange`, `nativeSelectionMatchesCurrentBlockSeam`, `restoreDriftedEchoCaret`, Android post-delete snap-back | ~190 → 60 | … the classifier compares each observation with its last display and the render epoch; the Android post-delete snap-back and the IME post-commit jump stay as two named, counted, time-bounded rules until a real-device lane can falsify their removal (BI-10) | V5 |
| L24 | History duplicates: pop-handler loops and latches (~220), path/id helpers (60), `historySelectionSnapshot.ts` (111), `undoRestore` selection half (~39), `refreshDomAfterHistoryChange.ts` (89 → keeps ~20), snapshot queue overrides (~25) | ~544 → 63 | … the dispatcher records this view's `{before, after}`, history runs a bare engine undo/redo, and a restore is `select()` in the issuing view (probes C1, P4) | S7 |
| L25 ‡ | Seam rules (`_dropNext/_dropPrev`, two history redo fallbacks, a phantom-capable delete fallback). `getClosestUnselectedBlock` + `blockToFocus` are **not** in this row: they become the block-set delete/cut command's result selection (FP-7) | ~81 → 45 (**moved** to `doc/anchors`) | … a vanished endpoint this view did not author lands at its block's replicated slot, the same answer on every replica | V3 |
| L26 | Caret re-assertion outside selection: `getTextNode` polling, hotkey structural restore + `focusFallbackBlock`, onInput 30 ms re-assert, `stabilizeCompositionSelection`, keyboard-focus ownership checks, mention timers, markdown restore, toolbar re-assertions, rich-text state→DOM→state writes | ~301 → 0 | … commands return a selection and the projector displays it after the flush | S2, V4 |
| L27 | Direction formula ×4, unused `getTextsInSelection` TreeWalker result, never-written `hasSelectedAll`, debug probes incl. the unbounded `__EDYTOR_SEL_LOG__` push, duplicated UA/path helpers | ~160 → 0 | … direction is stored in the value; dead results have no reader | V2 |

### 5.5 Input, composition, DOM observation (R7, R8, R11, R12)

| # | Mechanism | xloc | Unnecessary while … | CP |
|---|---|---|---|---|
| L28 | Intent vocabularies: inputType predicate families, two routers, `shouldRefreshDomAfterModelCommand`, `NON_COMPOSITION_INSERT_TYPES`, hotkey bridge + synthetic `KeyboardEvent`, event fabrication at seven sites | ~355 → 35 | … an occurrence becomes an intent once, through one table (probe C2: Enter binding ran 3×) | I1 |
| L29 | `beforeInputSnapshot.ts`, `beforeInputRepairTarget.ts` + 11 call sites, the DOM-selection round trip for declared ranges | ~190 → 0 | … the attempt's target is an anchored model range fixed at admission (probe C3: `XXheo`) | I1 |
| L30 ‡ | Suppression flags and timers: 7 flags + 4 timers, onInput repair targets and suppressed repair, onBeforeInput windows, blanket suppression in `transact`, the 50 ms post-commit windows | ~241 → 0 | … DOM changes are attributed to queued attempts by expectation, with one model-owned drift deadline (counted in the census), and late composition signals belong to the session tail (BI-5, BI-7) | I1, I3 |
| L31 | Second adopter (`input`-event path); core knowledge of the mention trigger + manual plugin notification | 110 → 0 | … the mutation queue is the only adopter, and adoption runs through the dispatcher | I2 |
| L32 ‡ | `diffText` "advanced" path: similarity switch, Myers stub, word diff | ~199 → 50 | … adoption is a common prefix/suffix diff that prefers the attempt's target (probe C4; BI-8: doubled letters) | I2 |
| L33 ‡ (r2, r3) | Observer liveness inference (~297), attribute spec tables and healing (297 → ≈100 as the declared ownership table), caret capture/restore after repair (106), third point → offset copy (37), `domTextOffset.ts` (43) | ~780 → 100 | … after a flush, a content or strict container that equals what its cells render is not input whoever wrote it, so no record needs a liveness verdict (R12); a divergent one is adopted or inverted by location and expectation; attributes are compared only where the table declares ownership (probe C1: the editor's own attribute writes compare equal, so a paused IME is no longer cancelled) | R7 |
| L65 (r2, r3) | Record-level plumbing the compare pass subsumes: the record queue with the observer's own microtask flush and `oldValue` capture, and the identity helpers (what revision 1 kept of them: 60 + 10 of 107 today; the rest was booked as trims) | ~70 → 25 | … records never carry provenance: they name the elements to compare (and, for strict containers, the added and removed nodes and siblings, which is new code in §4.4), and an element's identity and location come from the owned-element registry (R12) | R7 |
| L34 | Placeholder machinery: `removeStalePlaceholders.ts`, `Text.svelte` placeholder DOM/observers/timers, repair-queue wiring, history sweeps, placeholder branches in observer and selection | ~355 → 5 | … the placeholder is a model- and session-derived attribute rendered by a `::before` rule the library ships | R5 |
| L35 ‡ | Composition representations: region numbers + anchors + DOM space, `_syncCompositionRegion`/`_reanchor…`/`_resolveCompositionOffset`/`deleteAt` region branch, `onCompositionEnd`, `getFinalCompositionMarks`, 9 reset sites and flags, the observer's own cancel, `beforeInputCommands` composition | ~678 → 245 (**moved**: session + pin) | … at most one session exists, its region is two anchors, it is one capture group, and it ends once plus a tail | I3 |
| L36 | Keydown listener pair | ~8 → 0 | … one handler per occurrence | S4 |

### 5.6 Commands (R6, R7)

| # | Mechanism | xloc | Unnecessary while … | CP |
|---|---|---|---|---|
| L37 | Seven `PreventionError` catch sites + the hotkey catch-all that reports every error as "handled" | ~40 → 0 | … hooks see the prepared command once, before its transaction, and `prevent()` is caught in one place (P11, P11b, `prevent-midway`) | S1 |
| L38 | 20 `stopCapturing` decisions + ad-hoc snapshot queueing | ~40 → 0 | … the dispatcher applies one undo policy table (today's observable grouping) | S1 |
| L39 (r2, r3) | Whole-editor remount switch (`refreshEditorDom`, `editorDomRevision`, `{#key}`) | ~25 → 0 | … the host is a projection of cells, a divergence is healed where it diverges (a block element WebKit drops from the root is re-inserted from its record, `cross-browser-confidence.md`), and the projector re-displays after every flush (`tab-remount`) | R6 |
| L40 | `deleteContentWithinSelection` re-derivations and its third branch | 206 → 110 (**moved** to `doc/rangeDelete`) | … a range delete is one prepared document operation governed by `canMerge` (P2, P5) | D6 |
| L41 | Range-delete ladders ×3 (`replaceSelection`, the delete commands) | ~80 → 0 | … the callers call `doc/rangeDelete` | D6 |
| L42 | Marks-for-insertion rules ×8 with 3 divergent policies | ~180 → 40 | … one `marksForInsertion`; pending marks carry values; the edge policy reads the admitted side (`mark-inherit`, FP-8) | S3 |

### 5.7 Extensions and UI (R11, O37, O68)

| # | Mechanism | xloc | Unnecessary while … | CP |
|---|---|---|---|---|
| L43 | Hand-written HTML tokenizer, tree builder, entity table (`html/parser.ts`) | 426 → 0 | … HTML arrives only through browser events, where `DOMParser` exists (jsdom provides it for tests) | D8 |
| L44 | `$fragment` pseudo-blocks, `mergeTrailingMarks`, duplicate mark application (`deserialize.ts`) | ~211 → 0 (110 kept) | … placement of any flow is one rule in `doc/flow` | D8 |
| L45 | Per-paste mapping validation with synthetic validation nodes | ~137 → 0 | … mappings resolve once at registration; unregistered results degrade | D8 |
| L46 | Three paste placements + double id stripping + second fragment validation | ~208 → 70 (**moved** to `doc/flow`) | … one placement function, fresh ids once at ingress (`paste-shape`, `empty-html`) | D7 |
| L47 ‡ | Kind catalogues: `richTextCommands.ts` (115), markdown table + converters (~120), default HTML tables (97), core clipboard export switch naming 11 plugin types (~70), slash icon table, code-block shape ×2 | ~420 → 140 (**data moved** into records; only switch and `run:` scaffolding is deleted) | … a kind is one record in its extension | S6 |
| L48 | Suggestion Proxies (`readonlyElements.svelte.ts`) | 125 → 25 | … snippet payloads are declared view objects (`suggestion-mention`) | R5 |
| L49 | `use:block.attach` in ~20 snippets, handle ownership guard, core heading re-key, root-attribute action, handles WeakSet/alias composition | ~100 → 0 | … the core renders the block element (`code-attach`) | R5 |
| L50 | Four positioning loops; handle mutation-record analysis | ~116 → 35 | … one overlay helper measures once per frame | R5 |
| L51 | Four move vocabularies: `arrowMove` path arithmetic, handle keyboard/outdent + `comparePath` copy, `blockMove` re-derivation | ~146 → 55 | … one relative-move command (`move-down`) | S5 |
| L52 | Toolbar numeric snapshot + 4× re-assertion; slash numeric range | ~50 → 0 | … UI-held ranges are anchors (`stale-offsets`) | V4 |
| L53 | Five document-order navigation walkers (444 → 120) and 26 binding closures (139 → 55) | ~408 → 175 | … one ordered stream of caret stops; bindings are data | V6 |
| L54 | Hotkey block-selection duplication (island walk ×2, root-index-only order, retry timers), Emacs skeleton duplication, atom deletion by whole-tree search, runtime `letter` Set | ~240 → 15 | … O7, O36, O40 | D2, S4 |

### 5.8 Transport (R1, R13)

| # | Mechanism | xloc | Unnecessary while … | CP |
|---|---|---|---|---|
| L55 ‡ | Schema-as-data staging and gating: `canApplyDirect` (91), `applyUpdateStaged` (39), hydration fast + surgical staging (53), refusal latch + compaction block (~18), `gateSchema`/emit/dedupe (25), eight outbound gates (~12), staged branch + post-apply recheck (~11), plumbing (~27) | ~276 → 55 | … frames and containers carry the (engine, wire, schema) generation; one inbound check refuses updates that write a foreign stamp and one outbound quarantine keeps a read-only document from spreading (F8) (probes P2, P7, C11) | T1 |
| L56 ‡ | Readiness plumbing: websocket two-round settle (~55), failed hand-back + 50 ms poll (~23), meta-only migration branch (8), view `setTimeout(0)` decision + `synced` shadow (28), facade `syncPending` twin (~15), the reserved-bootstrap-id seed | ~150 → 20 | … the document decides once (empty ∧ settled-or-bound) and applies a deterministic seed update, so an identical late seed is a no-op and never overwrites an edit (P4, P4b/c, P6; FP-1, F5) | T2, T3 |
| L57 | Migration arbitration: claim loop (43), polling `waitForSettled` + undecoded BroadcastChannel nudge (62 → 3), lease/owner vocabulary (~20), owner-carrying record writes (~26 → 10) | ~151 → 13 | … the attempt is a crash-released lock, progress is an append plus an `active` record in one transaction, and `status()` asks the lock manager | T5 |
| L58 | Storage duplications (codec, open and stamp copies; id policy ×2; key-0 overwrite) | ~50 → 0 | … one container module, append-only for every writer (P3/P3b) | T5 |
| L59 | Presence: re-minting and double dedupe, three encodings, legacy `textId/yStart` fields, `selection` mirror, owner registries + `sweepDestroyedViews`, numeric fallbacks, `findDomPoint` | ~271 → 0 | … one writer per entry (the view that minted its key), anchors only, the Surface mapper (no v14 peer has shipped) | T6 |
| L60 | Factory-identity dedupe | ~7 → 0 | … providers are keyed by transport target (P8) | T4 |

### 5.9 Not simplification (reported separately so the reduction is not overstated)

| # | Kind | Items | xloc | CP |
|---|---|---|---:|---|
| L61 | **Dead code** (no reader) | `utils/jsx.ts` (70, no importer), `getBlockByIdOrContent` (15), dead placement helpers (27), `renderVersion`, `#depth`, `initialized`, `REMOTE_ONLY_TRANSACTION`, `remotePresenceRevision` / `refreshRemotePresence` (~20) | ~130 | G0 |
| L62 | **API retirement** (no production consumer; needs D-15) | `decorateRuns` + types (108), `subscribeBlock/subscribe/blockVersion/snapshot/debug` (~45), "advanced internals" barrel (~80), raw sync readers (41), `modifyAwarenessUpdate` (19), IDB `get/set/del` (19), duplicated hello + WebSocket-side BroadcastChannel fan-out + hand-copied options (~36), test seams (4) | ~352 | C1 |
| L63 ‡ | **Moved to `src/tests`** (oracles stay runnable) | `computeAllRuns`/`mergeRuns` (59), `blockRecordsOf` (23), `diffSnaps` (81, the F-O7 oracle) | ~163 | G0 (copy), D9 (production copy deleted) |

### 5.10 Reconciliation

| Portion | xloc | Nature |
|---|---:|---|
| Current | 29,099 | measured |
| Mechanism removed (L1–L60, L64, L65, net of survivors) | −10,933 | architectural; each row names its invariant |
| Not simplification (§5.9) | −645 | dead 130, API retirement 352 (conditional), oracles moved 163 |
| Per-file trims realized at 75 % of the readers' 3,250 | −2,438 | shorter bodies of retained responsibilities; each file's reader floor is its gate (§9.1 rule 7) |
| New code (v1's new owners ≈400; repairs and evidenced items not booked as ledger survivors ≈1,031; revision 2's compare pass, registry, write guard and render epoch +115, less the bracket and the location classifier −100; revision 3's pre pass, placement, per-content comparison, record-level structure, records signal, tail expectation, admission after commit, run ids and `Mark` +169, less the write guard −25 and the mark snippets −30) | +1,560 | counted in the targets |
| Browser machinery expected to return (30 % of the R10/R8 ledger, less the named repairs) | +531 | allowance, not a mechanism |
| **Target** | **17,174** | **−41.0 %** |

The ledger alone (architectural removal) is −37.6 %; the target needs three quarters of the per-file trims. §7 prices
what happens when they do not land.

**Census** (`scratchpad/arch/final-probes/census.sh`, moved to `scripts/` at G0) counts at every checkpoint: timer
sites, `tick()` waits, `flushMirror(` calls, `stopCapturing(` calls, `ignoreNextSelectionChange` writes,
`PreventionError` catch sites, `MutationObserver` instances, `flushSync(` calls, **the vendor delta against the pinned
upstream**, and **the type-body lines** (`typebody-count.mjs`). Each checkpoint must lower the counts it claims and may
not lower the type-body count by restyling (§9.1 rule 8).

## 6. Distinctions kept explicit, and the bug each prevents

Each pair looks compressible and is not. **(merged today)** marks distinctions the current code collapses, with the
probe or pin that shows the bug. ‡ marks rows added or changed by the review; (r2) marks rows changed in revision 2.

### 6.1 The canonical pairs

| # | Keep apart | Held as | Bug when merged |
|---|---|---|---|
| D1 | **Definition vs occurrence** (kind vs block) | kind records adopted into capability; occurrences in the registry | The core re-keys on `heading`/`level`, so a kind named `title` loses it; one definition renders two elements that both claim the block **(merged today; `code-attach`)** |
| D2 | **Definition vs occurrence of an id** | registry keys never reused by local minting; `setBlock` refuses reused ids; restore-definition exists only for migration `force` | `setBlock` with existing child ids silently drops a child and can never succeed on retry **(merged today; crdt C4)** |
| D3 | **Prepared intent vs execution attempt** | command value → prepared plan (immutable once hooks saw it) → one transaction | A veto inside a nested sub-step half-executes a range delete and duplicates text **(merged today; P11/P11b)**; a keydown fallback replays numbers captured before a remote edit (`XXllo`) |
| D4 | **Announced intent vs executed effect** | attempt `owner = browser` + `expect`; success = this attempt's adoption applied the change | "Announced ⇒ done": Android's no-op Backspace never deletes. "Text changed ⇒ ours": under a concurrent edit neither side deletes (C5 input) |
| D5 | **Observation vs guarantee** | cells and the document are the guarantee; DOM and events are observations interpreted once | Phantom slots inferred from `node == null` in every settle window **(merged today)**; "the stamp stayed supported" read as "incompatible content stayed out" (P2) |
| D6 | **Transport success vs operation success** | `hasSynced` from an applied Step2 carrying state; the join rule; content decided by one document rule | An applied empty Step2 counts as synced and the seed erases room content **(merged today; P4b/P4c)** |
| D7 | **Capability vs permission** | `canPlace`/`canMerge` (document) vs dispatcher permission and hooks (view); `admit()` for routing | A drop indicator hides legal drops or shows moves that fail; caption typing inside a void reaches the document; readonly loses selection |
| D8 | **Completed external effect vs disposable state** | cut writes the clipboard, then dispatches the delete; import row + `active` record in one transaction; the lock is platform-released | Cut loses data when the delete is vetoed; durable attempt ownership forces leases, polling and a reclaim race **(merged today)** |

### 6.2 Representation pairs

| # | Keep apart | Held as | Bug when merged |
|---|---|---|---|
| D9 | **Where characters are stored vs which block displays them** | backing texts (items never move) vs streams + claims | Copy-on-split/merge: an offline peer's edit lands on dead items (`lost-edit`, `duplicate-inline`, `resurrected-delete`) |
| D10 | **Block identity vs placement** | registry key vs `{p, r}` candidates | Physical nesting needs a move the engine lacks (`duplicate-placement`, `cycle`) |
| D11 | **Deleted vs hidden** | per-writer delete marks (win) vs derived (merge-claimed, or under a deleted ancestor) | Undoing a merge cannot restore the source; "deleting the destination voids a concurrent merge" (ST02b) becomes inexpressible |
| D12 | **Merged block displayed at delete time vs merged concurrently** | R3 marks what is displayed at delete time; a concurrent merge's claim is inert | Delete only the holder: the merged block resurrects **(merged today; X1)**. Delete everything ever claimed: a concurrent merge wrongly deletes its source |
| D13 ‡ | **A boundary's position vs the formats around it** | the boundary sits at the end of the gap (P7) and carries the formats in effect there | Positioning by format matching stops before a live format item a concurrent formatter left in the gap, and undo sends the text into the new block (F1) |
| D14 | **Gap ownership vs insert affinity** | containing stream vs anchor side | One sign bit plus the `o` facet for both **(merged today)**: `nにello`, or a split-start caret migrating (anchor rule 1) |
| D15 | **Causal vs display vs DOM position** | anchor vs *(block, offset)* vs *(node, offset)* with fillers | Numeric carets cannot ride remote inserts; fillers leak into offsets; mid-composition writes address the model string instead of the pinned DOM |
| D16 | **Causal segment key vs segment ordinal** | key = preceding atom id; the host cell's list frozen while composing | A peer inserting an atom before (or inside) the composing segment re-keys it and remounts the IME node, or renders the same text twice (X12, BI-13) |
| D17 | **Operation handle vs render cell** | id-only handles vs commit-consistent cells | 16 mid-transaction full reconciles, 11 s deletes, callbacks seeing half-updated trees **(merged today; P9, P4b)** |
| D18 | **Freshness token vs publication revision** | fold version + watermark (inside a transaction) vs one per-commit reactive revision | Reactive consumers see uncommitted state or never re-run; a read after a second edit to the same text misses it (F11) |
| D19 | **This view's commit vs another local view's vs a remote one** | transaction origin identity vs the engine's `local` flag | A sibling view's undo restores this view's caret |
| D20 | **Refused vs no-op vs applied** | op result `status` | Attribution stamps no-ops; `moveBlocks([])` and `insertBlocks([])` disagree **(merged today; crdt C8)** |
| D21 | **Document capability vs view configuration** | adopted capability vs per-view definitions | One view's override reshapes structure for peers; the split gives `paragraph` inside an `ordered-list` **(merged today; P10, P12)** |
| D22 | **An empty document's first block vs a view-held stand-in** | the document applies a deterministic seed; no virtual block | A virtual block is a second owner of "the first block" and needs a special case in render, selection, IME and presence |
| D53 ‡ | **Seed content identity vs writer identity** | writer id = hash of the seed; caller ids kept; ids/nonces/ranks derived | Fresh ids duplicate a template (F5); a fixed writer id diverges replicas whose seeds differ (`seed-collision`); a user writer re-seeding under caller ids erases an edit **(merged today)** |
| D54 ‡ | **One delete mark per writer vs one shared flag** | `del.<writer>` | One peer's undo resurrects a block another peer also deleted **(merged today; F12)** |
| D55 ‡ | **Dead stream vs rescued tail** | delete marks only; content untouched | Tombstoning on delete empties a tail a peer split off concurrently (ST02a) and makes undo-of-delete a copy that drops an offline peer's edits (F2) |

### 6.3 Selection, input and display pairs

| # | Keep apart | Held as | Bug when merged |
|---|---|---|---|
| D23 ‡ | **A local command's result selection vs anchor-following for changes this view did not author** | command result → `select()`; held anchors and the slot seam only for foreign changes | Block-set Backspace lands on the next block instead of the previous (FP-7); with left affinity, typing leaves the caret before each character |
| D24 | **Model destination vs DOM readiness** | value set synchronously; projector displays when displayable | "No node yet" read as "no destination": the caret strands after a remote whole-document delete |
| D25 | **Phantom slot (declared) vs temporarily unmounted text** | `rendersContent` in the kind record, verified at a settled barrier | A caret parked on an unrendered slot swallows the next keystroke **(merged today, `beforeInputDeleteCommands.ts:37-39`)** |
| D52 ‡ | **Document-editable vs displayable destination** | Surface `displayable` filters the seam and caret stops at projection | The seam lands in a collapsed toggle's hidden child and the next keystroke edits invisible text (BI-12) |
| D26 | **Echo vs render drift vs foreign write vs user move** | classifier inputs: `displayed`, render epoch, gesture serial | "No gesture since the last echo ⇒ drift" reverts selections set by host apps and assistive tech **(merged today; C4)** |
| D50 ‡ (r3) | **Unobserved native move vs drift** | the projector mints anchors from the DOM selection before the first transaction after a settled render that this view did not issue and admits the move after that transaction commits | An arrow press whose `selectionchange` is still queued is overwritten by the next remote apply (BI-3; exists today for remote reconcile); admitted inside the transaction, a hook's command is written under the provider's origin and is never broadcast or persisted (LH2-5) |
| D27 ‡ (r2) | **Foreign focus vs user-owned `body` vs orphaned `body`** | focus verdict from `activeElement`, last gesture landing, DOM selection location, and whether the element that held focus before the flush is still connected | Stealing a selection the user made outside the editor on every remote apply (BI-14), or never displaying after our own remount |
| D28 | **Not yet integrated vs deleted** | `resolve()` returns `pending` vs `dead` → seam | A remote caret drawn at a seam before its item arrives |
| D29 | **Issuing view vs sibling view vs remote (history)** | `{before, after}` keyed by view | Two restorers race in the issuing view **(merged today; C1/P4)** |
| D30 (r2, r3) | **DOM divergence vs DOM provenance** | after a flush, each block's content is compared with its cell and each strict container with what the cells render (R12); records name the elements to compare, never who wrote them | Asking who wrote a record: the editor's own attribute records arm the idle cancel and delete a live IME preview **(merged today; C1 input)**; two liveness predicates guess which nodes the renderer made; a bracket must wrap every host-visible write or its records look foreign (revision 1) |
| D58 (r3) | **The content an element last rendered vs its cell's current content** | the registry keeps each content's last rendered text and its runs' start anchors; the root `$effect.pre` snapshots an edited content before a flush re-renders it; the edit is placed through those anchors | A model change that re-renders or re-keys a run the browser just edited erases the edit (probe B1); a write guard that skips the node instead leaves it stale for good (probe B2); an adoption diffed against the new cell text reverts the concurrent change |
| D59 (r3) | **Core-rendered structure vs extension markup** | strict containers (the root, text elements, core mark elements) and registered elements vs tolerant extension markup (D-25); identity clones and nodes that left a strict container are removed wherever they land | A tolerant root keeps Android's native paragraph and DST's injected elements (BI2-2); a strict snippet element would need to know who wrote each node, or would strip an extension's own markup |
| D51 ‡ | **Owned vs unowned host attributes** | declared ownership table | Inverting `open` keeps a native toggle shut; readonly cannot flip; plugin attributes are stripped; or a spoofed identity attribute is accepted (FP-4) |
| D31 | **Browser-owned change (adopt) vs drift around a model-owned change (revert)** | the queued attempt whose expectation the change satisfies | Merged text duplicated after a non-cancelable merge, or a keystroke disappears |
| D56 ‡ | **The change an attempt expected vs other changes in the same host** | per-host attempt queue matched by expectation | Late drift of a prevented delete is adopted (double delete) or the user's next character is reverted (BI-7) |
| D57 ‡ | **Preferred-position diff vs greedy diff** | adoption prefers the attempt's target | Backspace between doubled letters deletes twice on Android; two identical words with different marks swap (BI-8) |
| D32 ‡ | **Preview vs commit vs explicit cancel vs abandonment** | previews tracked inside the session's capture group; commit = one command; explicit cancel deletes previews in the same group; abandonment adopts the DOM | Untracked previews: undo resurrects `にほん` or loses a replaced selection (F3, BI-1). Destructive abandonment: a blur without `compositionend` deletes text the browser committed (BI-4) |
| D48 ‡ (r3) | **Live session vs tail vs gone** | session phases; the tail is an expectation on its host that resolves late composition changes to the committed text | Firefox's trailing composition `input` is adopted as `にに`; WebKit's early commit is committed twice (BI-5) |
| D49 ‡ (r2) | **Background display vs user-command display during a composition** | a display after a background render never writes the DOM selection while a session owns a host; the session end catches up | Every remote keystroke in the paragraph aborts the IME (BI-2) |
| D33 | **User intent vs mechanical replay** | command `origin`; previews never reach hooks | Auto-pair rewrites the IME buffer; the slash menu opens mid-composition and never after commit **(merged today; `ime-plugins`)** |
| D34 | **Pending toggle vs mark value** | pending marks carry values | A collapsed Bold toggle drops a link or color **(merged today; `mark-inherit`)** |
| D35 | **Decoration vs stored mark** | runs stored; tokens and ghost text view-only | Syntax tokens persisted into replicated marks |
| D36 ‡ | **Command vs transaction vs undo step vs capture group** | the dispatcher's policy table | Delete-then-type splits into two steps (FP-2); a composition with a long pause splits; a forgotten `stopCapturing` merges the next command **(merged today)** |
| D46 ‡ | **Prepared plan vs applied write vs observed result** | `prepare` (pure) → hooks see the plan and its steps → `apply(plan)` → fold | Hooks consulted mid-execution half-execute (P11); a prediction diverges from the effect (C-F10); with hooks on the user-level command only, a protected-block veto cannot see a composite's removals and the code plugin's nested replacement never runs (FP-6) |

### 6.4 Collaboration pairs

| # | Keep apart | Held as | Bug when merged |
|---|---|---|---|
| D37 | **Connection synced vs provider has ever synced** | `connected` vs `hasSynced` | A healthy provider that lost its socket reports "failed before it synced" **(merged today; P1)** |
| D38 | **Room membership vs room state** | neither is represented; nothing correctness-critical waits on them | Emptiness inferred from silence never settles for zero members (P6) |
| D39 | **Stored bytes vs integrated state** | append-only rows; no row refused | Compaction deletes bytes the snapshot never had, or a refusal latch disables it forever (C11) |
| D40 | **Import (fresh identity, appended) vs replace (a CRDT edit)** | `force` = hydrate → restore-definition + replace transaction → append its diff | Overwriting row 0 loses post-migration edits **(merged today; P3, P3b)** |
| D41 | **Presence definition vs occurrence** | the view key the view minted | Clearing by slot strips sibling views' carets **(merged today; C14)** |
| D42 | **Container identity vs migration progress** | generation record vs import record | The migrator stamps a populated foreign store **(merged today)** |
| D43 | **Accepting input vs being able to persist it** | `writable` gates the dispatcher; inbound refusal keeps foreign stamps out | The transport silently drops every later edit **(merged today; P7)**; a same-generation foreign stamp spreads and turns every replica read-only (F8) |
| D44 ‡ | **Local-only engine state vs replicated state** (`redone`, `keep`) | never read by any derivation (attribution keyed by `n`) | Replica-dependent incarnation decisions (F7) and the current undo repair |
| D45 | **Monotonic vs restorable attribution** | `contributors` outside the undo scope vs `lastChangedBy` inside it; no stamp for undo/redo transactions | Undo strips contributors, or fails to restore the previous last changer (R25) |

## 7. LOC table

### 7.1 Per current domain (final)

Columns:
- **Current**: measured with `node scratchpad/xloc.mjs src/lib --dirs` (29,099; the revision-2 and revision-3 re-runs read 29,109, §0). `crdt` splits into core 6,237
  and transport 2,125 (providers 1,098 + protocols 508 + migration 519).
- **Target**: the planning number and the sum of the §4 module budgets (built in §7.2).
- **Stretch**: every representation bet holds and every per-file trim lands. **Confident**: the number this plan
  commits to (§7.2 gives its assumptions).
- Survivors are counted at their source domain, so moving code neither adds nor deletes lines.
- **Confidence**: **H** mostly deletion of code shown dead or duplicated; **M** an ownership or representation change
  whose mechanism is verified and test-gated but not implemented; **L** depends on browser behavior only real-engine
  lanes can prove.

| Current domain | Current | **Target** | Δ | Δ % | Conf. | Stretch | Confident | What survives |
|---|---:|---:|---:|---:|:-:|---:|---:|---|
| `crdt` core | 6,237 | **4,013** | −2,224 | −36 % | M | 3,895 | 4,131 | `doc/*`: streams with end-of-gap boundaries (P7), one index folded once, prepared ops, delete marks, deterministic seed, attribution keyed by nonce |
| `crdt` transport | 2,125 | **1,538** | −587 | −28 % | M-H | 1,520 | 1,556 | `sync/*`: generation envelope + inbound stamp refusal, one room lifecycle and join rule, append-only container, lock-based migration, y-websocket option parity |
| `events` | 4,524 | **2,340** | −2,184 | −48 % | L-M | 2,086 | 2,562 | `surface/observer` (pre pass and post-flush compare pass over contents and strict containers, attribute ownership, adoption by expectation), `surface/events`, `session/attempt`, `session/composition` |
| `selection` | 3,919 | **2,228** | −1,691 | −43 % | L-M | 1,951 | 2,288 | `surface/projector` (classifier, focus verdict, drag and composition gates), `surface/domPoint`, `session/selection`, `surface/pointer`, geometry |
| `plugins` | 3,780 | **2,166** | −1,614 | −43 % | M | 1,981 | 2,323 | kind/mark records carrying today's per-kind data (marks declare their element), overlay handles, slash/toolbar over held anchors, `DOMParser` HTML import |
| root files | 2,512 | **1,630** | −882 | −35 % | M | 1,350 | 1,736 | `edytor.svelte.ts` with its compatibility duties, keymap + bindings, part of composition and events |
| `block` | 1,716 | **1,124** | −592 | −34 % | M | 1,046 | 1,202 | dispatcher with prepared plans and hook adapters, id-only handles, structural commands, part of cells |
| `text` | 1,195 | **600** | −595 | −50 % | M | 555 | 644 | cell segments with causal keys, the pin with a frozen segment list, text commands |
| `collaboration` | 666 | **393** | −273 | −41 % | H | 387 | 399 | presence as one encoding per view key; remote-caret geometry moves to the overlay |
| `components` | 615 | **366** | −249 | −40 % | M-H | 340 | 392 | generic recursive render, placeholder attribute, click re-derivation until a browser check retires it |
| `hotkeys/` (navigation) | 589 | **217** | −372 | −63 % | M | 200 | 234 | one caret-stop stream, bindings as rows |
| `clipboard` | 518 | **276** | −242 | −47 % | M-H | 254 | 298 | three flavours, one placement function, validation at admission |
| `utils` | 500 | **259** | −241 | −48 % | H | 240 | 278 | JSON ingress; prefix/suffix diff with a preferred position |
| `history` | 200 | **21** | −179 | −90 % | H | 20 | 22 | one per-view restorer (in `session/history`) |
| `dnd` | 3 | **3** | 0 | 0 % | H | 3 | 3 | PDD adapter |
| **Total** | **29,099** | **17,174** | **−11,925** | **−41.0 %** | | **15,828 (−45.6 %)** | **18,068 (−37.9 %)** | |

Against the task's baseline of 28,941: target −40.7 %, stretch −45.3 %, confident −37.6 %. Revision 2 moved only the
`events` row. Revision 3 moves `events` (+122: the pre pass, placement through run anchors, per-content comparison,
record-level structure for strict containers, the records signal, the hand-back and the tail expectation, less the
write guard), `selection` (+12: the projector admits an unobserved move after the transaction instead of inside it),
`plugins` (−30: mark records declare their element), `components` (+5) and `crdt` core (+5: run ids). The root row
keeps its number: the composition root never held bracket code.

### 7.2 How the numbers are built

| Step | Total | vs 29,099 | What it adds |
|---|---:|---:|---|
| v1 floor (readers' line-level survivors) | 14,483 | −50.2 % | — |
| + evidenced under-budget items | 15,074 | | +591: foreign-attribute ownership (≈100 of the 297 lines survive), per-kind data moved into records (≈140, not 70), compatibility-getter fields the Session may not compute, constructor compat duties the readers counted and v1 did not, handle-cache pruning, hook payload adapters, cell invalidation sources, the click re-derivation K10 keeps, `navigator.locks` fallback, nonce liveness and adoption checks (revision 2 drops the bracket's +50) |
| + accepted repairs (§12), revisions 2 and 3 | **15,828** | **−45.6 % (stretch)** | +754: P7 call site and streamless rule, delete marks, restore-definition, prepared plans and hook replacement, history exception, deterministic seed, inbound stamp check, migration status, capture group, session tail, cancel vs abandonment, attempt queue, preferred-position diff, projector gates, suggestions owner, block-set result selection, edge side, displayable filter, pinned segment list; minus the incarnation walk (+620). Revision 2 (+20): the compare pass, owned-node registry, write guard and render epoch (+115), less v1's bracket (−30) and the record plumbing the compare pass subsumes (−65). Revision 3 (+114): the pre pass, placement through run anchors, per-content comparison, record-level structure for strict containers, the records signal, the hand-back and the tail expectation (+147 in `events`), admission after commit (+12), run ids (+5), less the write guard (−25) and the mark snippets (−30, with `Mark` +5) |
| + 25 % of per-file trims not realized | 16,642 | | +814, spread by floor share (crdt core 118, events 142, plugins 157, root 106, block 78, selection 60, text 44, …) |
| + browser machinery that returns (R10/R8 at 30 % of their ≈2,560 at-risk ledger, less the ≈235 already named as repairs) | **17,174** | **−41.0 % (target)** | +532: selection 217, root 174, events 112, plugins 28 |
| + a further 25 % of trims not realized (trims at 50 %) | 17,988 | | +814 |
| + Option B residual (K2): the early equal-drop in the MutationObserver callback (≈15) and the upper ends of revision 3's observer ranges (≈65); no tolerance list, since decision 1 tolerates only the live IME host | **18,068** | **−37.9 % (confident)** | +80 |

The confident number assumes R2 holds: its engine mechanics are verified and the one counterexample (F1) has a
mechanism (P7). If R2 is abandoned at D11, add its fallback (+1,227: slice records kept behind one decider); if the
compare pass fails R7's gates, add R7's (+800: today's liveness classification).

### 7.3 Does it reach 40–50 %?

| Scenario | Total | vs 29,099 | In 40–50 %? |
|---|---:|---:|:-:|
| Stretch (every bet holds, every trim lands) | 15,828 | −45.6 % | yes |
| **Target** (plan with this) | **17,174** | **−41.0 %** | **yes** |
| Target, maintainer keeps the retired API surface (D-15, +352) | 17,526 | −39.8 % | no |
| Target, decisions D-2, D-3, D-8, D-16 refused (+250, +100, +40, +60) | 17,624 | −39.4 % | no |
| Target, Option B residual at the confident allowance (+80) | 17,254 | −40.7 % | yes |
| Target, R7 fallback (the observer keeps today's liveness classification, +800) | 17,974 | −38.2 % | no |
| Target, R2 abandoned (slice records with one decider, +1,227) | 18,401 | −36.8 % | no |
| Target, R2 and R7 fallbacks (+2,027) | 19,201 | −34.0 % | no |
| **Confident** | **18,068** | **−37.9 %** | **no** |
| Confident, with the cuts that remove code (G-a, G-e, G-d: −385) | 17,683 | −39.2 % | no |
| Confident, those cuts and G-c by route (i) (−612) | 17,456 | −40.0 % | yes (edge: 3 under the line) |
| Confident, R2 abandoned | 19,295 | −33.7 % | no |
| Target, vendor delta counted in both columns (+405, and +30 for P7) | 17,609 / 29,504 | −40.3 % | yes |
| Target, counter corrected to exclude type bodies (baseline 28,246; ≈640 of the 853 type-body lines survive) | ≈16,534 | ≈−41.5 % | yes |

**The honest statement: plan with −41 %; the reduction this plan is confident of is −37.9 %, below the 40 % line by
≈609 xloc. The cuts that remove code (G-a, G-e, G-d) bring it to −39.2 %; the line needs G-c by route (i), which needs
the fork published (U-8), or G-b. G-c by route (ii) moves code into the vendor total and closes nothing.** The view-side rows (events, selection, root, plugins) carry most of the uncertainty: they hold the
browser machinery that each engine-specific bug brought back (`cross-browser-confidence.md` lists ≈50 hardening items),
and Android/iOS are not in the lanes. The document and transport rows are honestly budgeted.

These cuts and engine-native features can close the gap. Each is a maintainer decision (D-24), priced against the
confident total:

| # | Cut, or engine-native feature | Saves | What it costs |
|---|---|---:|---|
| G-a | Retire the HTML import plugin. It is not exported (`plugins/index.ts`) and is wired only in `src/routes/test/dom`; `paste-html.spec.ts` goes with it | ≈250 | External HTML paste falls back to plain text unless a consumer's `onPaste` handles it (the README keeps `onPaste` as the extension point) |
| G-b | Retire the v13→v14 migration; the generation gate keeps refusing v13 containers | ≈370 | Only if no persisted v13 data must be carried forward (G26–G29; README's upgrade path and `docs/crdt-v14-migration.md`) |
| G-c (r3) | Consume `@y/protocols` sync, awareness and auth instead of the in-tree ports. The ports cost 280 in the target (`sync/awareness` 215, `sync/sync` 50, `sync/auth` 15); an adapter around upstream costs ≈53: `applyRemote` with the inbound admission, the remote origin and the coverage test; the gated dispatch (upstream `readSyncMessage` applies directly); the three fixes upstream lacks as a wrapper (idempotent `destroy()` for the owned-doc plus owned-awareness double destroy, the interval `unref()`, `readAuthMessage` returning the subtype so skew is reported); re-exports. Route (i): depend on upstream at runtime, with the fork resolving as its `@y/y`. Route (ii): vendor the three upstream files (255) beside the fork, rewriting 13 import lines (10 `lib0/` → `lib0-v14/`, 3 `@y/y`; a rewrite adds no delta) | Route (i): ≈227. Route (ii): none; ≈227 relocated | Measured: `crdt/protocols` is 508 today (awareness 242, sync 215, auth 19, envelope 32) and imports no `@y/y` (the engine is injected, `bindSync(Y)`); upstream `sync.js` calls `@y/y` at runtime and `awareness.js`/`auth.js` import it. Route (i) needs the fork published and resolving as `@y/y` in every consumer install (U-8); a consumer that also installs upstream `@y/y` gets two engines. Route (ii) grows maintained code by ≈28 (255 + 53 against 280) and is booked as relocated, never as removed (§7.4, rule 8) |
| G-d | Use the platform's native Emacs bindings (macOS `ctrl+a/e/k/d/h` arrive as native caret moves or `beforeinput` intents) instead of the bindings table | ≈55 | A real-browser check per engine first; `ctrl+o`/`ctrl+t` may still need rows |
| G-e | Retire the y-websocket option surface the docs and demo do not use (hand-copied options beyond status, backoff and liveness; the resync timer) | ≈80 | An API retirement in a 0.0.x package |

G-a + G-e + G-d (D-24's proposal) gives 17,683 (−39.2 %); adding G-c by route (i) gives 17,456 (−40.0 %); G-a + G-b +
G-d + G-e gives 17,313 (−40.5 %); all five, G-c by route (i), give 17,086 (−41.3 %). No refactor inside the retained
scope closes the gap by itself: the remaining reduction would have to come from the per-file trims landing better than
50 %.

### 7.4 Honesty notes

- **Moved, not deleted** (counted at the source domain): range delete → `doc/rangeDelete`; paste placement → `doc/flow`;
  the seam rule → `doc/anchors`; composition from four files → `session/composition` + `surface/pin`; six DOM-point
  interpreters → `surface/domPoint`; change-report patching → `surface/cells`; the chrome helper → `surface/overlay`;
  plugin-facing handles → `session/handles`; per-kind data (≈140 of 318) → kind/mark records; remote-caret geometry →
  `surface/overlay`; `diffSnaps` and three other oracles → `src/tests` (163).
- **Not simplification** (§5.9): 130 dead, 352 API retirement (conditional on D-15), 163 oracles moved.
- **Vendor.** The metric excludes the engine, now an owned fork carrying +405 xloc of Edytor-authored features
  (P4–P6); this plan adds P7 (≈30) and, if taken, the boundary-skipping read in `RangeCursor`. Every fork line the plan
  adds or grows is charged to the module that needs it and the census reports the delta at every exit, so no budget
  can be met by moving Edytor code across the boundary. G-c's route (ii) would move 255 lines of *upstream* protocol
  code into the vendored tree: the census reports them in the vendor total, and they count as relocated, never as
  removed or toward the 40 % line.
- **Type bodies.** The counter counts 853 `export type` body lines today. They are counted identically before and after;
  no checkpoint may meet a budget by rewriting types as interfaces (§9.1 rule 8), and the census reports them.
- **New code is counted in the targets** (≈1,560): dispatcher, prepared plans, projector and classifier, pre pass, compare pass and owned-element registry,
  boundary index and `locate`/`position`, fold cursor and watermark, readiness and deterministic seed, delete marks,
  restore-definition, lock-based migration, inbound stamp check, attempt queue, session tail and capture group,
  attribute-ownership table, suggestions owner, and the evidenced items of §7.2.
- **Bundle not measured.** The vendored engine dominates shipped bytes. The concrete runtime claims are one wire update
  per undo instead of two or three, ≈15 B instead of ≈68 B per keystroke at a split seam, linear instead of quadratic
  large transactions, a 1,000-block delete at document cost (≈7 ms instead of ≈10.6 s), and no whole-editor remount on
  Tab. The passes add one extra flush per render, over the elements its records name; `bench/` measures it before any
  speed claim.
- **Test rewrites** are outside the metric but real: `mirror-incremental`, `scoped-text-refresh`, normalization-depth
  and placeholder-queue unit tests; 19 tokenizer and ~12 mapping-validation fixtures; `schema-boundary` (613 lines),
  `wu3b-staging` (290), most of `r2-idb-compaction`; the lease/claim parts of the migration suites; the `o`-facet rows
  of `anchors.test.ts` and `ownership-intervals`; DST dump inventories (`textClaims`, `textMounted`). The user-visible
  assertions of every browser spec stay.

## 8. Falsification tests (written first, at G0)

Rules:
- **Expected results come from contracts, never from either engine's output**: the delete contract (`del.*`, `sel.*`,
  `conc.*`, anchor rules 1–6), the readers' G/R/S guarantees, `crdt-v14-document.md`, the migration runbook, the
  README and the pinned specs. Where contracts are silent the row says **decision** and names the §11.2 entry.
- **Lanes.** **doc**: headless vitest. **dom**: the jsdom harness and command programs. **browser**: Playwright on
  chromium/firefox/webkit plus DST. **cdp**: Chromium driven through `Input.imeSetComposition` / `Input.insertText`
  (a real IME path), with a second browser context as the peer. jsdom and script-dispatched composition events cannot
  falsify IME, echo or layout claims; rows that claim IME-node survival, no-write-during-composition or post-commit
  behavior are **cdp gates**, not smoke tests.
- **Today**: **red** (a probe reproduced the failure), **red?** (predicted from code), **green** (regression guard).
- **Gate** names the §9 checkpoint that cannot close until the row passes.
- Every multi-replica row runs in both delivery orders, with duplicate delivery, after a binary reload, and under at
  least three client-id assignments (a single assignment hid F1 and F-U4d).

### 8.1 Document: nesting, positions, empty inputs, failure midway, concurrency

| ID | Axis | Scenario | Expected (source) | Lane | Today | Gate |
|---|---|---|---|---|---|---|
| F-D1 | nesting in nesting | `root > [box(island) > [A "aa"], Y "yy"]`, and one level deeper inside `X`; select A@1 → Y@1; delete | `[box > [A "a"], Y "y"]`: the island seal refuses the merge `del.range.flat` would do; `mergeForward(A)` refuses the same way | doc | red (P2) | D6 |
| F-D2 | order is one answer | `root > [X > [box(island) > [A]], Y]`: the next block after A | `Y` for every consumer | doc | red (P1) | D2 |
| F-D3 | targetability | `p > [c]`; delete `p`; then `insertText(c)`, `insertBlock(parent: c)`, `moveBlock(c → root)`, `splitBlock(c)` | all four `refused`, zero bytes | doc | red (C6) | D1 |
| F-D4 | same definition, different position | `ordered-list > [li "one"]`: Enter at end, middle, start; merge an island child out into the list | `[li "one", li ""]`, `[li "o", li "ne"]`, `[li "", li "one"]`; the merged-out child is `li` (G5) | doc + dom | red (P12, P10) | D3 |
| F-D5 | empty collection | `moveBlocks([], dest)`; `insertBlocks(dest, [])`; `insertText('')`; empty delete; empty format | all `noop`, one result shape; no stamp, no undo step, no state-vector advance | doc | red (C8) | D4 |
| F-D6 | failure midway, retry | `b > [c1]`; `setBlock(b, {children: [{id:'c1'}, {id:'c2'}]})`, then retry with fresh ids | first `refused` (`id-collision`), zero bytes, `c1` intact; retry `applied` | doc | red (C4) | D4 |
| F-D7 | generated value after a boundary | `insertBlock({id: 'x\uD800'})`, then `insertText` by the same string and by the returned id | both resolve to the stored block | doc | red (C11) | D4 |
| F-D8 | merge then delete | `[a "aa", b "bb", c "cc"]`: merge `b` into `a`, delete `a` via the view, `facade.deleteBlock`, `document.block('a').delete()`; then undo | after delete `[c "cc"]` on every path; after undo `[a "aabb", c "cc"]` | doc + dom | red (X1) | D1 |
| F-D9 | concurrent: delete destination ‖ merge | A deletes `a` ‖ B merges `b` into `a` | `a` gone; `b "bb"` visible (ST02b) | doc | green | D1 |
| F-D10 | concurrent, every path | `abcde` split at 3; B types `Q` at the tail's head ‖ A deletes the tail (view, facade, handle) | `abc` everywhere (`conc.delete-wins-block`) | doc | red (P3/P3b) | D1 (marks), D12 (streams) |
| F-D11 | concurrent splits | `hello world`: split at 3 ‖ split at 8, all 40 client pairs | partition `hel`, `lo wo`, `rld`; nothing dropped or duplicated; reading order tracked only (D-18) | doc | green | D12 |
| F-D12 | nested, empty container | `[ordered-list > [i1 "one", i2 "two"], P "three"]`; select i1@0 → P@2; Backspace | `[P "ree"]`, caret `P@0`; no empty container left | doc + dom | red (P5) | D6 |
| F-D13 | R2 property corpus | random split/merge/delete/insert/format/undo programs over **4** replicas, random delivery, a concurrent-format generator | (a) no content delete tombstones a boundary; (b) of two boundaries naming one id, only the nonce-matching one delimits; (c) every live character renders once; (d) convergence; **(e) R16: undoing a text delete returns the text to the block that displayed it at delete time** | doc | n/a | D11 |
| F-D14 | seam insert | B inserts `\|` at 6 of `hello world` ‖ A splits at 6 | converges; side is YATA order (decision D-1: re-pin TX06a) | doc | pinned head-side | D11 |
| F-D15 | history independence | (a) block `alpha` + separate `d2 = "Hello"`; (b) `alphaHello` split at 5. Caret `anchor(block, 0, left)`, then split that block at 0 | identical in (a) and (b): the caret stays in the original, now empty block (anchor rule 1) | doc | red (C3) | D12 |
| F-D16 | bytes at a seam | type 20 characters at a split-born block's start | per-keystroke bytes within 10 % of mid-text typing (≈15 B) | doc | red (C7: 68 B) | D12 |
| F-D17 ‡ | undo of delete with an offline peer | A deletes block `b` ("hello world") and undoes; offline P deletes `world` and bolds `hello` inside `b`; sync | `b` = **hello** + ` `: P's edits survive (F2) | doc | red on the view path (tombstoning) | D1 |
| F-D18 ‡ | concurrent double delete, selective undo | A and P delete the same block concurrently; A undoes; both client orders | still deleted (F12) | doc | red (client-order dependent) | D1 |
| F-D19 ‡ | streamless split-born block | A pastes block P; B presses Enter inside P (creating `u`) and types into `u`; A undoes the paste | `u` is visible and empty (its boundary died with P's text); typing into `u` creates its own text; a late copy of the old boundary is inert (F9) | doc | n/a | D11 |
| F-D20 ‡ | delete source ‖ split (ST02a) | A deletes `b1` ‖ B splits `b1` at 6 into `s1` (view, facade and handle paths) | `text(s1) === 'world'`, both orders and reload | doc + dom | green headless; red? on the view path | D1 |
| F-D21 ‡ | claims re-inserted by a split (decision D-21) | M merges `c` into `b` then undoes ‖ S splits `b` before `c`'s content | `c` stays merged into the new block (pinned anomaly, parity with today) | doc | same class today | D12 |

### 8.2 Undo after collaboration

| ID | Scenario | Expected (source) | Lane | Today | Gate |
|---|---|---|---|---|---|
| F-U1 | `Hello world`, caret @5, type `abc` (@8); peer inserts `XYZ` at 0; undo via hotkey, `beforeinput historyUndo`, `edytor.historyUndo()` | caret @8 of `XYZHello world` on all three channels | dom | red (C1 sel) | S7 |
| F-U2 | type `!` at the end of `hello world`; peer inserts a mention at 3; undo | caret after `world`, not before the mention | dom | red (P4) | S7 |
| F-U3 | split `hello world` at 6; delete the tail's `world`; undo; deliver frame by frame, lineage on and off | one wire update per undo; the receiver never shows `hello world` in the head | doc | red (C2: 2 updates; C13: 3) | D12 (lineage part D10) |
| F-U4a | tail `world` deleted by A; B splits the empty tail at 0 → `u`; A undoes | `world` returns to `t`, both replicas | doc | green via the repair | D11 |
| F-U4b | tail `**world tail**`; A deletes `world`; B splits the tail at 0; A undoes | `t = **world**`, `u = ** tail**`, one update | doc | n/a | D11 |
| F-U4c | marked deleted run only; a run whose opening format item is shared with following text | text returns to `t` in every variant | doc | n/a | D11 |
| F-U4d ‡ | A undoes before receiving B's split at 0 of the still-live `world` | converges with `world` once; the block follows client-id order (decision D-17: YATA order, pinned for both orders) | doc | n/a | D11 |
| F-U4e ‡ | three peers: A deletes `world` ‖ B bolds `world` (variant: B bolds `wo`, D bolds `rld`); C receives A then B (and B then A) and splits the tail at 0; A undoes | `world` returns to `t` on every replica, every client order, one update (F1) | doc | green via the repair; **red for a boundary positioned by formats** (`a5-concurrent-format-min`) | D11 |
| F-U5 | A deletes `bb`; B edits `cc`; A undoes | `bb` restored, `cc` keeps B's edit | doc | green | G0 |
| F-U6 | select the first child of a list, delete, undo, redo, on each channel | redo lands on the recorded `after`, the same answer on every channel (H3) | dom | red? (C11 sel) | S7 |
| F-U7 | views V1 and V2 on one document; V1 types, then undoes | V1 restores its `before`; V2's caret rides the change (H1) | dom | green | S7 |
| F-U9 ‡ | undo then redo through every channel; a normalizer that fires after the undo | redo stays available; the normalizer does not empty the redo stack; with lineage on, one update per undo (F4) | doc + dom | green today (bare undo) | S7 |

v1's F-U8 ("typing, then a browser-owned deletion within `captureTimeout` is one merged step") contradicted
`input.spec.ts:1023` and is replaced by F-M5.

### 8.3 Selection and display

| ID | Scenario | Expected (source) | Lane | Today | Gate |
|---|---|---|---|---|---|
| F-S1 | `setAtTextOffset(t, 4)` then `setAtRange(t, 2, 6)` with no await; and the reverse | the later request wins in both orders (W1) | dom | red (C7 sel) | V4 |
| F-S2 | caret in `Second`@3, focus on an outside button; peer deletes `Second` | model at `First`@5 (`sel.seam.next-sibling`); one `onSelectionChange`; presence and focused set updated; outside focus kept | dom | red (C2 sel) | V2 |
| F-S3 | `selectBlocks(b)` after a caret | one `onSelectionChange`; presence publishes the block set | dom | red (C3 sel) | V2 |
| F-S4 | editor focused; host code calls `setBaseAndExtent(text@1 → end)`, no gesture, no render | the model adopts the range | dom | red (C4 sel) | V4 |
| F-S5 | `ab` + bold `cd` + `ef`; DOM point `(textElement, i)` for every child index | offsets 0, 2, 4, 6 | dom | red (C5 sel) | V4 |
| F-S6 | forward native selection: anchor `text@1`, focus `(textElement, childCount)` | forward 1 → end; content equals the model slice | dom + firefox | red (C6 sel) | V4 |
| F-S7 | block-select `bb` in `[aa, bb, cc]`; peer deletes `bb`; press Delete | the selection becomes a caret at `cc@0`; Delete acts on live content | dom | red (C8 sel) | V2 |
| F-S8 | caret at the end of `hello world`, editor blurred; peer inserts an atom at 3 | model caret at display offset 12 immediately | dom | red (X5) | V2 |
| F-S9 ‡ | (a) our render detaches the focused node; (b) the user focuses an outside `<input>`; (c) the user selects text in non-focusable page content outside the editor, then a remote apply runs | (a) the caret is displayed; (b) and (c) model-only update, the user's focus and selection kept (BI-14) | dom + browser | inconsistent; (c) guarded today by `lastUserGestureOutsideEditor` | V4 |
| F-S10 | Gecko re-anchor after a mark toggle; Gecko/Blink clamp after a re-split; Android +1 echo after a model-owned merge; IME post-commit jump | after settle the DOM caret equals the model caret, no timers except the two named rules | browser (3 engines + DST) + cdp | green, using timers | V5 |
| F-S11 ‡ (r3) | (a) ArrowRight with a remote update applied before its `selectionchange` (a peer update inside a keydown capture listener's microtask); (b) a mouse-drag selection with remote updates at 60 Hz; (c) `setBaseAndExtent` from a page script racing a remote apply; (d) as (a), with an `onSelectionChange` hook that dispatches a command when the move is admitted, and the same hook when an undo restores a selection | (a)–(c) the user's move survives (BI-3); (d) the hook's command is its own local transaction: broadcast and persisted, never inside the remote apply's or the undo's transaction (LH2-5) | browser (3 engines) + dom | (a) red? today too; (b) green (drag guard); (d) new | V4 |
| F-S12 ‡ | real IME composition; a peer inserts before the region | no DOM-selection write while the session lives; the next `imeSetComposition` extends the same composition; one commit at the shifted region (BI-2) | cdp | green (guards at `text.svelte.ts:762-769`, `selection.svelte.ts:2388`) | V4 |
| F-S13 ‡ | `['First block', 'Marked middle', 'lead @ tail']`: select block `[1]`, Backspace; the same with Delete and with cut; the same with block `[0]` selected | caret at the end of `[0]`'s first editable text; with `[0]` selected, the next block (`hotkeys.spec:955-993`, CLIP-07) | dom + browser | green | V3 |
| F-S14 ‡ | a collapsed toggle follows the caret's block; a peer deletes the caret's block. Separately, a kind declared `rendersContent: true` whose snippet renders no `content()` | the caret lands on the next displayable stop, never in the hidden child; the dev check reports the undeclared phantom and the seam skips it (FP-9, BI-12) | dom | red? | V3 |

### 8.4 Input and IME

| ID | Scenario | Expected (source) | Lane | Today | Gate |
|---|---|---|---|---|---|
| F-I1 | `he[ll]o`; Backspace keydown with no `beforeinput`; a peer inserts `XX` at 0 before the deadline | `XXheo` | dom | red (C3 input) | I1 |
| F-I2 | Android non-cancelable `deleteContentBackward` the browser does not perform, plus a peer edit inside the deadline | exactly one grapheme deleted, before the anchored caret | dom | red? (C5 input) | I1 |
| F-I3 | a non-preventing `mod+alt+k` binding; a non-preventing `enter` binding | each runs once per keydown | dom | red (2× and 3×) | S4 |
| F-I4 | a hook throws during a non-cancelable insert | attempt `failed`; the DOM equals the model after settle; the next keystroke works; the error surfaces | dom | red? (C7 input) | I1 |
| F-I5 | Shift+Enter in a code line, desktop and Android (`insertLineBreak`) | same intent, hook and result | dom + mobile spec | green by coincidence | I1 |
| F-I6 | `Hello\|`, compositionstart, preview `に`, 850 ms without events while a peer edits another paragraph and the editor writes focus attributes | the composition stays live, the preview intact, the host not remounted; commit gives `Helloに` | dom + cdp | red (C1 input) | I3, R7 |
| F-I7 | `alpha\|Hello` split, then compose `n` → `に` at the fresh block start | `にHello`; `alpha` untouched | dom + cdp | green | I3, D12 |
| F-I8 | peer inserts before the region; peer text absorbed inside the region | the commit lands at the shifted region; absorbed text replaced at commit (`composition-remote-lock`, 7 tests) | browser + cdp | green | I3 |
| F-I9 | in a code line compose `(` → `(a` → commit; compose `/` → `/h` → commit | the model equals the IME buffer at every step; final `x(a`; the slash menu opens once, after commit, with query `h` | dom + cdp | red (`ime-plugins`) | I3 |
| F-I10 | composing in the second segment of `ab@cd`; a peer inserts an atom before `@` | the composing text node keeps its identity; the commit lands after `@` | dom + cdp | red? (X12) | I4 |
| F-I10b ‡ | composing at `ab@cd\|`; a peer inserts a mention between `c` and `d` | the host text is never rendered twice during the session; after commit the atom renders once, in place (BI-13) | dom + cdp | new | I4 |
| F-I11 | composing after atom `@` in `ab@cd`; a peer deletes `@` | the composing node survives until the session ends; segments merge after commit | dom + cdp | red? | I4 |
| F-I12 ‡ (r3) | (a) a peer deletes, retypes, re-parents (Tab) or merges the block holding a live composition; (b) after that forced commit, the IME keeps sending updates to a host that survived | (a) per D-20: the session commits what the IME shows before the structural change renders; text typed into a deleted block is lost with it (deletion wins); nothing duplicated; the caret lands per the contract; the editor never writes into the composing node except by the structural render itself (BI-6); (b) the continued composition opens a new session over what the IME shows and commits once; the compare pass never adopts it (BI2-6) | dom + cdp | red? (C9 sel) | I4 |
| F-I13 | WebKit phantom Enter/Backspace right after `compositionend` | the first is swallowed, later ones are not | browser | green | I3 |
| F-I14 | a foreign script rewrites the middle 700 characters of an 1,100-character paragraph | adoption = retain 200 / delete 700 / insert 700; a remote caret and a concurrent insert in the prefix survive | dom | red (C4 input) | I2 |
| F-I15 ‡ | compose into an empty paragraph | the host text node before the first preview is the node after the pin release; no `data-placeholder` during the session (BI-15, BI-9) | cdp | unobserved today | I4 |
| F-I16 ‡ | (a) compose `nihon` → `日本` with 1 s gaps, commit, one undo, one redo; (b) the same with an equal-text commit (`한`); (c) compose over a selected `hello`, commit, undo (COMP-02); (d) compose, cancel after 1 s, undo; (e) an extension refuses block deletion, then an IME composition starts over a cross-block selection | (a) undo gives the pre-composition text, redo gives `日本`; (b) same; (c) `hello` restored; (d) the previous step is undone and no preview resurrects; (e) refused exactly as typing is (F3, BI-1, FP-3) | doc + dom + cdp | red (`composition-undo2`) | I3 |
| F-I17 ‡ | a preview, then a blur with `compositionend` suppressed; separately, a 10 s pause with no events | the composed text stays in model and DOM; after the pause the session is live and commits once (BI-4) | dom + cdp | red? (idle cancel at 750 ms) | I3 |
| F-I18 ‡ | Firefox order (`compositionend`, then the trailing `insertCompositionText` input); WebKit order (`insertFromComposition` before `compositionend`); Android (composition mutation without `beforeinput`, then a duplicate `compositionend`) | one commit, no duplicate text (`composition.spec:662, :896, :935`); the late change lands on a host already back in the compare pass and is resolved by the tail's expectation (BI-5, BI2-6) | browser (firefox, webkit) + dom | green, using 50 ms windows | I3, R7 |
| F-I19 ‡ | one text: a prevented Backspace plus late drift, then within one frame a non-cancelable `insertText` | both effects land exactly once (BI-7) | dom | red? | I1 |
| F-I20 ‡ | Android browser-owned Backspace at `hel\|lo`; a word-delete of the first of two identical words with different marks | exactly one `l` deleted and the deadline does nothing; the surviving word keeps its own marks and a remote caret inside it stays (BI-8) | dom | green (string check) / red (word marks) | I2 |
| F-I21 ‡ | A composes `にほんご`; peer C, seeing the preview, splits inside it; A commits `日本語` | the live preview items are deleted in both streams; `日本語` lands at the region start; C's split stands; no duplicate (BI-11) | doc + dom | red? (numeric fallback duplicates) | I3 |
| F-I22 (r3) | Android: the first character typed natively (non-composition `insertText`) into an empty block, then a second one | each character adopted once; the filler never reaches the model and a filler-only difference never counts as an edit; the caret ends after the character, with at most one display write per adoption (BI2-8) | dom + mobile spec | new | R7 |

### 8.5 Extensions and UI

| ID | Scenario | Expected (source) | Lane | Today | Gate |
|---|---|---|---|---|---|
| F-P1 | `A{A1, A2, A3}, B`; select A3; Shift+Up twice; Shift+Down | `{A2,A3}` → `{A1,A2,A3}` → `{A2,A3}` | dom | red (`block-extend`) | D2 |
| F-P2 | select `world`, focus the link field; a peer inserts `ZZZ` at 0; apply | the link covers `world` | dom | red (`stale-offsets`) | V4 |
| F-P3 | `ab/quo` with the slash menu open; a peer inserts at 0 | the menu stays open with `quo`; Enter runs on `/quo` | dom | closes by accident | V4 |
| F-P4 | caret inside red italic text; Mod+B; type | `{color: red, italic, bold}` | dom | red (`mark-inherit`) | S3 |
| F-P5 | fragment `X`, `Y` pasted at `Hello\|World` via internal, HTML and plain paths | one structure (decision D-4: `["HelloX", "YWorld"]`) | dom | red (`paste-shape`) | D7 |
| F-P6 | `A, B{B1}, C`; move A down via arrow-move and via the handle's Alt+Down | `B{B1}, A, C` (decision D-5) | dom | red (`move-down`) | S5 |
| F-P7 | render a code block | one element carries `data-edytor-id`; its handle mounts once | dom | red (`code-attach`) | R5 |
| F-P8 | `suggestText` containing a mention atom | renders unselected and non-editable | dom | red (`suggestion-mention`) | R5 |
| F-P9 | one Tab on `A, B\|b` | zero root remounts; only B's subtree recreated; caret kept | dom | red (`tab-remount`) | R2 |
| F-P10 | paste HTML with only a comment, `<script>` or an empty `<span>` into an empty `h2` | no change, no undo step | dom | red (`empty-html`) | D7 |
| F-P11 | slash query `/xyz` with zero matches; Enter | Enter is not swallowed | dom | red? | S4 |
| F-P12 | two blocks selected; arrow-move claims Mod+Down | the built-in Mod+Down does not also run | dom | red? | S4 |
| F-P13 | a key handler throws a `TypeError` | the error surfaces; no half-executed command | dom | red? | S4 |
| F-P14 | two extensions define `heading` | the first wins (README) | dom | red? | S4 |
| F-P15 ‡ | caret at `Link\|` inside the anchor, type `!`; caret after the anchor, type `!` | `Link!` fully linked, then ` tail`; outside the anchor the `!` is not linked (`plugins.fixtures.tsx:22-70`, `plugins.spec.ts:22-58`, `input.spec.ts:480-512`) (FP-8) | dom + browser | green | S3 |
| F-P16 ‡ | (a) the grouped-move retarget fixture (`pipeline.fixtures.tsx:99-125`); (b) `[p "a", p "", code > [codeLine "x"]]`, caret in the empty paragraph, Delete; (c) an extension refuses any command whose effect removes block `c`, then a range delete spans `c` | (a) the hook's replacement lands; (b) the empty paragraph is removed (code plugin's replacement); (c) the range delete is refused whole, zero bytes (FP-6) | dom | (a), (b) green; (c) red (P11b) | S2 |
| F-P17 ‡ (r3) | (a) click the `page-toggle` summary, type and Enter in its child; (b) flip readonly at runtime and back, with a foreign script rewriting text while read-only; (c) the demo's deep-link plugin writes `id` on block elements at attach; (d) a toggle-style snippet with local collapse state, collapsed and expanded three times, then collapsed while the caret is in its child; (e) the five `dom-mutation.spec` heal specs | (a) opens, edits land in the child (`demo-route.spec:90-127`); (b) `features.spec:221, 301`; the read-only rewrite stays until the flip back, then is inverted; (c) the attribute stays; (d) no divergence after any flush, the editor stays responsive, and the collapse moves the caret to the next displayable stop with focus kept (LH2-8); (e) foreign damage still healed (FP-4, BI-9) | browser + dom | (a)–(c), (e) green; (d) red? under v1's R12 | R7 |
| F-P18 ‡ | suggestions set asynchronously; the caret leaves the block; Tab and Escape in a code line; a composition at the suggestion boundary; a dismissed suggestion | cleared on leave; Tab accepts, Escape clears (`hotkeys.spec:1618, 1670`); kept through the composition (`composition.spec:321-372`); never resurrected (`adversarial-wave3:290-313`) (FP-5) | dom + browser | green | V2, R6 |
| F-P19 ‡ | each documented hook surface: attach hooks with the element; `onBeforeInput(event)` claiming an occurrence; `onDeleteSelectedBlocks`; plugin `commands` with `isEnabled` and async `run`; `MarkDefinition.void`; `use:block.void`; `transformText` decoration; `moveBlocks` returning the moved blocks; the placeholder function's argument | each keeps its README behavior or has a recorded migration note (FP-10) | dom | green | S1, R5 |
| F-P20 ‡ | a read-only view; a foreign annotation extension wraps text in its own elements; separately it damages an identity attribute | the wrapper stays; the identity attribute is healed (FP-11) | dom | green | R7 |

### 8.6 Transport

| ID | Scenario | Expected (source) | Lane | Today | Gate |
|---|---|---|---|---|---|
| F-T1 | two websocket clients sync; B's socket drops; `B.destroy()` | no `failed` event (G11) | doc | red (P1) | T2 |
| F-T2 | (a) a peer of another schema generation writes; (b) a same-generation document ends up with a foreign stamp, then the user types | (a) frames dropped at the envelope, observable, zero bytes; (b) the document turns read-only once, visibly; no edit accepted then dropped | doc | red (P2, P7) | T1 |
| F-T3 | migrate → edit → `migrate(name, {force: true})` → reload, 6 trials, 2 tabs | every trial and tab equals the legacy materialization | doc | red (P3b, P3) | T5 |
| F-T4 | new device: empty IndexedDB, the room already holds content; `value` passed; every client-id order | local equals the room; nothing duplicated; nothing erased (G9) | doc | red (P4, P4b/c) | T3 |
| F-T5 | opaque relay, default options; B edits offline and reconnects | A receives B's offline edits without `resyncInterval` (G2) | doc | red (P5) | T2 |
| F-T6 ‡ | first client of a new room, default options; a second client joins; two clients seed the default paragraph concurrently | the first client is ready after the bound with one paragraph; both converge; concurrent default seeds produce **one** paragraph (identical seed) | doc + browser | red (P6/P6b) | T3 |
| F-T7 | two views with inline `createIndexeddbSync('notes')` on one document | one provider; rows grow as with one view | doc | red (P8) | T4 |
| F-T8 | a remote caret is idle; the page scrolls | the caret stays on its anchor (G24) | browser | red (C12) | R5 |
| F-T9 | a websocket-only peer closes its tab | peers drop its caret as for IndexedDB/BroadcastChannel | browser | differs (C13) | T2 |
| F-T10 | a view is destroyed along a path that skips selection teardown | its presence entry is removed by its own teardown | dom | red? (C14) | T6 |
| F-T11 ‡ | two clients, the same non-empty template `value` (with ids), both client-id orders, the room reply after the bound | one copy (F5) | doc | red for fresh ids; green for caller ids | T3 |
| F-T12 ‡ | a late identical seed after another client edited the seeded title | the edit is kept (F5) | doc | red (caller ids erase it) | T3 |
| F-T13 ‡ | the demo route's ids (`page-title` … `page-end`) after reload; deep links; `onChange` JSON re-mounted as `value`; `createDocument({value})` round trip | ids survive everywhere (`crdt-v14-document.md:55-67`; `demo-route.spec`, `demo.spec`, `handle-alignment.spec`) (FP-1) | doc + browser | green | T3 |
| F-T14 ‡ | a same-generation writer produces a foreign stamp | receivers refuse and report the update; the stamp never reaches their containers; a read-only document neither persists nor broadcasts (F8) | doc | green (staging) | T1 |
| F-T15 ‡ | migrate → an edit deletes a legacy block → `force` → verify; two devices force independently, then sync | every legacy id restored in place; verify compares ids; no duplicate after sync (F13) | doc | red? | T5 |
| F-T16 ‡ | a second tab calls `status()` while the first holds the migration lock; `migrate({wait: false})` | `pending`; `busy` (FP-12, runbook API) | doc + browser | green (lease) | T5 |
| F-T17 ‡ | two different templates seeded concurrently: disjoint ids; same ids with different text | union, converged; one version per id (registry LWW), converged; never divergence (`seed-collision`) | doc | n/a | T3 |

### 8.7 Ownership rules, instrumented

| ID | Rule | Scenario | Expected | Lane | Gate |
|---|---|---|---|---|---|
| F-O1 | R1, R10 | run every command program to settle | every DOM-selection write came from the projector; no editor-owned timer left scheduled except the named ones | dom | V4 (timers), R6 (writers) |
| F-O2 (r3) | R12 | selection-driven attribute writes, a readonly flip, suggestions and extension view state, each rendered during a live composition and outside one | after each of these flushes the compare pass finds no divergence; the IME preview diverges from its cell for the session's whole lifetime and is never inverted or adopted by the observer; the session commits it once; during the tail, a late change in the host is inverted to the committed text | dom + cdp | R6 |
| F-O3 | R7 | range delete, paste, split, convert, move with a counting extension | every hook call happens before the transaction: once for the prepared command and once per planned step (by its documented name); none happens inside it | dom | S1 |
| F-O4 | R6 | every op over a randomized corpus | result ∈ `refused \| noop \| applied`; `applied` ⇒ non-empty touched set; `noop` ⇒ no state-vector advance | doc | D4 |
| F-O5 | R1 + R6 + R12 | range delete and selected-block delete over 1,000 paragraphs; 2,000 inserts in one transaction | document work < 50 ms; end to end < 100 ms, including the compare pass over the render's records, with one change report and cell patches proportional to touched blocks; linear in transaction size | doc + dom | D6 / D9 / R3 / R6 |
| F-O6 | R5 | a randomized corpus of move requests | `canMoveBlocks(r) ⇔ moveBlocks(r).status !== 'refused'` | doc | D3 |
| F-O7 | R6 | change report vs the `diffSnaps` oracle over the random corpus | identical on every commit | doc | D9 |
| F-O8 (r2) | R12 | a remote update applied synchronously inside a keydown handler; an extension `$effect` that dispatches a command; an update applied inside another transaction's observer | no forced flush anywhere; after the flush the compare pass finds no divergence; the next keystroke is adopted once | dom | R6 |
| F-O9 ‡ | R6 | inside one transaction: insert → read → insert into the same text → read; delete → read → delete → read | the second read sees the second edit (F11) | doc | D9 |
| F-O10 ‡ (r3) | R12 | DST solo + collab and every dom fixture | after every settle, every block's content equals its cell's current text, every strict container holds its expected children and every registered element is connected, except the live composition host (and read-only text divergence until the flip back); in the jsdom lane, a test-side log of the `Node`/`CharacterData` mutators tagged with the calling module shows that nothing the renderer wrote was adopted or inverted (BI-9, BI2-9) | dom + browser | R7 |
| F-O11 ‡ | R6 | `prepare` over the random corpus | zero bytes and no state-vector advance; the effect summary equals the applied result's touched set (FP-6) | doc | D5 |
| F-O12 ‡ | R6 | attribution over undo/redo | no stamp for undo/redo transactions; the last changer is restored by undo (R25) (F4) | doc | D10 |
| F-O13 (r3) | R12 | (a) browser autocorrect replaces a word while a remote insert lands in the same block in the same frame, in both task orders; (b) the same with the remote update applied synchronously in the autocorrect's `input` task; (c) an extension writes an unowned attribute on a block element and a style on a mark element; (d) Android drift of an applied prevented Backspace, plus a same-task model change to that run (probe B2); (e) as (b), but the same-task change is a remote format of the autocorrected run, a mark-nesting change, a retype of its block, a deletion of the atom before it, a move of its block, or a split before it (probe B1) | (a), (b), (e) the autocorrect is adopted exactly once, where it was typed, and the concurrent change stands; (c) never inverted; (d) the DOM ends equal to the cell's current text, never at the text last rendered | dom + cdp | R7 |

### 8.8 Failure midway

| ID | Axis | Scenario | Expected (source) | Lane | Today | Gate |
|---|---|---|---|---|---|---|
| F-M1 | failure midway | `[a "aa", b "bb", c "cc", d "dd"]`, range a@1 → d@1; an after-hook throws | `[a "ad"]`; one undo step; the error surfaces | doc + dom | red (P11) | S1 |
| F-M2 | veto of a nested step | same range; an extension refuses the `removeBlock` step for `c` (old-style hook, matched by operation name) | the whole range delete is refused before any write: document unchanged, zero bytes, no undo step; never half-executed | doc + dom | red (P11b) | S1 |
| F-M3 | veto inside a composite | markdown shortcuts on; an extension refuses conversion; type `#`, then space, in an empty paragraph | the paragraph reads `"# "` | dom | red (`prevent-midway`) | S2 |
| F-M4 | throw after partial writes | a normalizer throws on its first call during a split | the command reports `failed`; one undo restores the pre-command document; the Surface shows the model | dom | red? | S1 |
| F-M5 ‡ | undo grouping | (a) type `.` with a code mark, select it, Delete, type `!`, Mod+Z; (b) type `!` natively, delete it natively with an empty follow-up inputType, undo | (a) `[{text: '.', marks: {code: true}}]`, forward range 0→1 (`history-coalesced-range.spec:14-58`); (b) `lead!` restored: the browser-owned deletion is its own step (`input.spec:1023-1105`) (FP-2) | browser + dom | green | S1 |

**The existing suites remain the parity oracle at every checkpoint**: unit, DOM, CRDT, chromium integration, DST solo
and collab, the 40 composition, 8 cancellation and 7 remote-lock tests, and the delete-contract matrix. A test that
pins a *mechanism* (§7.4) is rewritten against the invariant that replaced it, never deleted silently.

## 9. Bounded migration sequence

### 9.1 Discipline (every checkpoint)

1. **The reference stays runnable.** Tag `ref/<cp>` when a checkpoint starts. The command-program corpus and the DST
   corpus (solo + collab) run against the tag and the candidate; outcomes may differ only where a §8 row or a recorded
   §11.2 decision says so.
2. **Tests first, in their own commit.** The checkpoint's §8 rows land first, as expected-fail where they are red on the
   reference. The PR closes when they pass and every lane is green: `pnpm test -- --run`, `pnpm test:dom`,
   `pnpm test:crdt`, `pnpm check`, `pnpm lint`, chromium integration. Checkpoints marked **◆** also need the firefox
   and webkit lanes, `pnpm test:dst:solo` and `pnpm test:dst:collab` on three engines, and the cdp lane.
3. **Shadow before switch.** A derivation that replaces another runs in shadow first (selection projection V1, cells
   R1, change report D9, streams D11, the compare pass R6), compared on every fixture; every difference must match a §8 row.
4. **One owner per fact at close.** The mechanism a new owner replaces is deleted in the checkpoint that proves the
   owner, or in the named next checkpoint when the first one is a shadow step. "Keep it just in case" is not allowed.
5. **No new timer, one-shot flag, retry loop or forced flush (`flushSync`)**, except the five named, counted, time-bounded rules for browser
   behavior the lanes cannot falsify: the Android no-op-Backspace deadline, the missing-`beforeinput` deadline, the
   model-owned drift deadline, the Android post-delete snap-back and the IME post-commit jump. Needing another is a
   redesign trigger. Repair order: clarify the requirement → find the existing semantic owner → improve that owner or
   its representation → add a concept only if an independent responsibility remains.
6. **One PR per checkpoint.** At most ≈1,500 changed production lines (added + removed, tests excluded) and one owner
   introduced or changed. D12 and R7 are the two exceptions; each is preceded by its shadow checkpoint.
7. **Budget.** Stop and apply the repair order when any of these holds: a module exceeds its §4 budget by more than
   30 %; a file the checkpoint rewrote lands above 125 % of its reader floor (the per-file tables in the reader reports,
   §8 of each) without a recorded reason; the checkpoint's measured step falls more than 30 % short of its §9.4 step; or
   it needs more than three special cases its contract does not name.
8. **Measurement integrity.** The counter's hash is frozen at G0. No checkpoint may meet a budget by rewriting types
   as interfaces or by moving code into the vendored engine; the census reports type-body lines and the vendor delta.
   Moved code is booked where it came from. The engine is an owned fork: a feature it gains for this plan (P7, a
   boundary-aware `RangeCursor`) is charged to the module that needs it, and verbatim upstream code vendored beside it
   (G-c's route (ii)) is reported in the vendor total and booked as relocated: it meets no budget and does not count
   toward the 40 % line.
9. **Two iterations.** A redesign trigger allows at most two design iterations. After that, escalate with the failing
   test and the measured cost, and take the checkpoint's recorded fallback.
10. **Census and measurement at exit.** Each checkpoint lowers the census counts it claims; `xloc.mjs --files` per
    module against §4; `bench/` and `bench:crdt` for checkpoints on hot paths (D9, D12, R3, R6).

### 9.2 Order and parallelism

```
G0 ─┬─ D1 → D2 → D3 → D4 → D5 ─┬─ D6 → D7 → D8
    │                            ├─ D9 → D10
    │                            └─ D11 (spike behind the facade) ···························· D12 (switch)
    ├─ T1 → T2 → T3 → T4 → T5 (needs D1's marks) → T6 (final wire form after V2)
    └─ S1 (after D5) → S2 (after D6) · S3 · S4 · S5 (after D3) · S6
                   └─ V1 → V2 ─┬─ V3 → V4 → V5 → V6
                               ├─ S7 ─────────────┐
                               ├─ I1 → I2 → I3 (after S7) → I4 (after R2)
                               └─ R1 → R2 (after I3) → R3 → R4 → R5 → R6 (after V4, I3) → R7
    D12 after D9, T1 and R3.   C1 closes.
```

- **Document questions first** (D1–D5): every later owner consumes `isLive`, order, capability and prepared plans.
- **Selection before cells** (V2 before R2): the selection must stop storing wrappers before wrappers can go.
- **History before composition** (S7 before I3): the composition's capture group is an entry of the undo policy.
- **Composition before cells** (I3 before R2): region resync is deleted before it would have to be ported.
- **The compare pass after cells, the projector and the session** (R6 after R2–R5, V4, I3): cells must be the host's
  only render path, the projector must already display from the post-flush `$effect`, and the session must own the
  composition host the pass tolerates.
- **Transport is independent** and carries seven probe-confirmed bugs, so it starts at G0.
- **The stream switch comes last**: its schema bump is a clean generation bump under T1, D9's fold hosts the stream
  table, and cells no longer read wrappers.

### 9.3 Checkpoints

Each row is one PR. Δ is the expected xloc step (§9.4); a checkpoint landing more than 30 % short of it trips rule 7.

**G0 — Freeze and instrument** (no production behavior change)

| Tests first | Change | Deletes | Δ | Limit |
|---|---|---|---:|---|
| Every §8 row (expected-fail where red); the cdp harness (Chromium `Input.imeSetComposition`, a second context as peer) promoted from three smoke tests to a lane; F-O1…F-O13 spies (test-side, no production flags; F-O10's jsdom writer log patches the `Node` and `CharacterData` mutators to tag each write with its calling module) | tag the reference; move the census script to `scripts/` with the vendor-delta and type-body columns; freeze the counter hash; copy the oracles (`computeAllRuns`, `mergeRuns`, `blockRecordsOf`, `diffSnaps`) into `src/tests`; record the §11.2 answers | L61 (incl. the unconditional `__EDYTOR_SEL_LOG__` push, a production memory leak), L63 (production copies of three oracles; `diffSnaps` leaves at D9) | −290 | a disputed expectation becomes a §11.2 decision before any production PR |

**Track D — Document**

| CP | Tests first | Change | Deletes | Δ | Limit / fallback |
|---|---|---|---|---:|---|
| D1 | F-D3, F-D8, F-D9, F-D10 (marks half), F-D17, F-D18, F-D20 | one `isLive`; per-writer delete marks; delete-with-claims (marks only, no content tombstoning) on every path; view `removeBlock` calls it | L9, the liveness part of L13 | −25 | a consumer needing a caller-specific liveness answer means a missing fact: stop |
| D2 | F-D2, F-P1 | one pre-order `order`/`compare`; island sealing as a parameter of the ops that need it; view walkers and block-selection keys call it | L13 (order walkers), L54 (island walk ×2) | −175 | never a second order; sealing is a policy argument |
| D3 | F-D4, F-O6, F-S14 (dev-check half) | roles, `rendersContent`, `defaultChild` adopted as data with conflict refusal; `canPlace`/`canMerge`; `defaultChild` applied against the actual parent; dev check of declared `rendersContent` | L13 (`canMoveBlockTo`, eligibility predicates) | −5 | a default-type rule that depends on block data: stop and ask |
| D4 | F-D5, F-D6, F-D7, F-O4 | results `refused \| noop \| applied` from the fold; all-or-nothing `setBlock`; one ingress normalization; `moveBlocks` returns the moved ids | L11, L12, L14, L15 (op layers) | −470 | — |
| D5 | F-O11, F-M4 | every document op split into `prepare` (pure: plan + effect summary) and `apply(plan)`; composites compose prepared plans | per-op predictions (C-F10 remainder) | +40 | at most two composite ops may stay single-phase behind a pre-validation; a third means the plan vocabulary lacks a step kind |
| D6 | every `del.range.*` row, F-D1, F-D12, F-O5 (document half) | `doc/rangeDelete` as a prepared op; callers call it | L40 (moved), L41 | −215 | a third structural branch or a caller flag means a contract row is missing: write it first |
| D7 | F-P5 (after D-4), F-P10, clipboard spec assertions | `doc/flow`; fresh ids at ingress; one placement function | L46 (moved) | −170 | same as D6 |
| D8 ◆ | whitespace fixtures captured from real pasted content, then `paste-html.spec` | HTML through `DOMParser` into a flow; mappings resolved once; unregistered results degrade (D-9) | L43, L44, L45 | −900 | parity fails twice: keep the tokenizer's whitespace normalizer only (+60). Superseded if G-a retires the plugin |
| D9 | F-O7, F-O9, F-O5 (linearity), all `test:crdt` lanes, `bench:crdt` | one fold per transaction behind a watermark (local clock + folded delete set); change report from the fold; the write funnel stamps once | L10 (`diffSnaps` leaves production) | −310 | report ≠ oracle after two iterations: keep `diffSnaps` in production (+81) and continue |
| D10 | attribution suites, F-O12, F-U9 (lineage half) | `b/<id>` keyed by `n`; no stamp for undo/redo transactions; lineage for undo/redo from a `beforeTransaction` listener | L64 | −30 | — |
| D11 ◆ | F-D13 (with property (e) and the concurrent-format generator), F-D14, F-D19, F-U3, F-U4a–e, F-I7; TX01–TX09, ST01–ST03, MV, AN, HI01a/b; the attribution-renderer configuration | fork feature **P7** (`insertAtGapEnd`) recorded in `UPSTREAM.md` with a byte-equality differential test like P4's; boundary items, stream table, streamless rule, split = boundary + claim re-insert, anchors bind boundaries — in a parallel `doc/streams.next.ts` behind the facade | none yet (temporary ≈+600 of spike code, counted, removed at D12) | +150 | **abandon** if any repair write is needed, if F-U4a–e fail with P7, or if P7 fails the engine's differential tests: take the fallback at D12's slot (slice records behind one decider in `doc/streams`, F-D10 fixed in ownership resolution; +1,227) |
| D12 ◆ | F-D10 (every path), F-D11, F-D15, F-D16, F-D21, the whole crdt lane; generation bump to schema 2 (clean under T1) | switch to streams; the v13 migration re-targeted (it imports JSON); development documents re-imported | L1–L8, the spike duplicate | −1,335 | a pinned scenario that cannot be re-pinned to YATA order (TX06a, TX04a) goes to the maintainer before the switch |

**Track T — Transport** (from G0)

| CP | Tests first | Change | Deletes | Δ | Limit / fallback |
|---|---|---|---|---:|---|
| T1 | F-T2, F-T14; the schema-boundary suite rewritten against generation mismatch | schema in the generation word and container record; staging deleted; inbound refusal of foreign-stamp updates; outbound quarantine; the `writable` guard | L55 | −225 | a pinned schema case other than the same-generation forged stamp goes to the maintainer |
| T2 ◆ | F-T1, F-T5, F-T9; collaboration specs on three engines with the default `resyncInterval` | `sync/room` lifecycle (`hasSynced` vs `connected`); one join rule; departure announcement | L56 (settle window, hand-back, poll) | −80 | — |
| T3 | F-T4, F-T6, F-T11, F-T12, F-T13, F-T17 | the deterministic seed (scratch doc, hashed writer, derived ids/nonces/ranks, non-local apply); seed only when empty after settle-or-bound | L56 (reserved bootstrap id, view `setTimeout(0)`, `synced` shadow, facade twin) | −20 | a provider that cannot report "settled" gets the default bound, never a poll |
| T4 | F-T7 | providers keyed by transport target | L60 | −10 | — |
| T5 | F-T3, F-T15, F-T16; the migration suites rewritten without leases | `navigator.locks` attempt (in-process fallback where absent); import row + `active` in one transaction; `force` through restore-definition (needs D1); `status()` from `locks.query`; `wait:false` → `ifAvailable` | L57, L58 | −160 | lease or owner fields never return to durable records |
| T6 | F-T10; presence suites | one presence encoding keyed by view key, published from today's anchors, switched to `serialize(value)` at V2 | L59 | −330 | — |

**Track S — Commands** (after D5)

| CP | Tests first | Change | Deletes | Δ | Limit / fallback |
|---|---|---|---|---:|---|
| S1 | F-O3, F-M1, F-M2, F-M4, F-M5, F-P19 (hook half); readonly refuses every mutating command | the dispatcher: permission → prepare → hooks on the prepared command and each planned step → one transaction → normalization → undo policy table → result selection (through today's selection API until V2); `prevent()` caught once; adapters for the documented operation names | L37, L38, the hotkey catch-all | +75 | an old hook behavior not expressible after two attempts keeps an adapter for that hook only, costed; an extension needing the DOM inside a command has a Surface concern (a post-commit effect) |
| S2 | F-P16, F-M3, the delete-contract matrix | split, merge, delete ladders, nest/unnest, convert and atom removal as commands over prepared plans; the code plugin's forward-delete rule as a replacement | nested interception in `runOperation`; each extension's caret-restore ladder (L26, plugin part) | −140 | — |
| S3 ◆ | F-P4, F-P15 | one `marksForInsertion`; pending marks with values; the edge side from the existing DOM-point interpreter as an admission field | L42 | −160 | if the Session needs any DOM fact other than the admitted side, an admission field is missing: stop |
| S4 | F-I3, F-P11, F-P12, F-P13, F-P14 | one precedence rule; one keydown handler per occurrence; bindings as rows | L36, L54 (rest) | −210 | — |
| S5 | F-P6 (after D-5) | one relative-move command | L51 | −110 | — |
| S6 | slash, markdown, HTML-export and clipboard spec assertions | kind and mark records carry the per-kind data; tables generated | L47 (scaffolding; data moved) | −340 | — |
| S7 | F-U1, F-U2, F-U6, F-U7, F-U9 | history runs bare `um.undo()/redo()`; `{before, after}` per view; one restorer through `select()` (needs V2) | L24, `history/`, the selection half of `undoRestore` | −590 | any tracked write after an undo is a defect: post-history normalization runs untracked (documented) or not at all |

**Track V — Selection and display** (after S1)

| CP | Tests first | Change | Deletes | Δ | Limit / fallback |
|---|---|---|---|---:|---|
| V1 | shadow comparison on every DOM fixture | `SelectionValue` + `project(value, version)` computed next to today's state | — (temporary ≈+250, removed in V2) | 0 | every shadow difference must match a §8 row |
| V2 | F-S2, F-S3, F-S7, F-S8, F-P18 (session half) | writers go through `select()`; `selection.state` becomes a compatibility getter (DOM-derived fields from the Surface); suggestions owned by the Session and cleared by `select()`; presence switches to `serialize(value)` | L20, L27 | −470 | — |
| V3 | F-S13, F-S14, every `sel.seam.*` row | commands return result selections (block-set delete/cut authored by the command); the slot seam in `doc/anchors` for foreign endpoints only; the displayable filter | L25 (moved), L21 (dead-endpoint application, `writeCollapsed…`) | −220 | — |
| V4 ◆ | F-S1, F-S4, F-S5, F-S6, F-S9 (a–c), F-S11 (a–d), F-S12, F-P2, F-P3, F-O1 (timer half) | `display()` as the only writer, run from the root post-flush `$effect` and deduped on (selection epoch, render epoch): anchors minted from the DOM selection before the first transaction after a settled render that this view did not issue, admitted through `select()` after its commit, drag guard, composition gate, three-input focus verdict (the focused element noted by the root `$effect.pre`), displayable targets | L22, L21 (rest), L26 (core part), L52 | −693 | never a new timer: a display race means an observation is missing (rule 5) |
| V5 ◆ | F-S10 on three engines + DST; the cdp post-commit rows | the classifier (echo, drift, foreign, intent) against `displayed`, render epoch and gesture serial; the Android snap-back and IME post-commit jump as the two named, counted rules | L23 | −160 | a third signature means a render-epoch source is missing: find it |
| V6 | `navigation-selection-sync` spec, RTL rows, atoms at block edges | one caret-stop stream; bindings as rows | L53 | −285 | — |

**Track I — Input and composition** (after V2)

| CP | Tests first | Change | Deletes | Δ | Limit / fallback |
|---|---|---|---|---:|---|
| I1 ◆ | F-I1, F-I2, F-I4, F-I5, F-I19; `mobile-beforeinput`, `unsupported-beforeinput`, `beforeinput-fallback` specs | one intent table; attempts with owner, anchored target, expectation and deadline, queued per host; anchored keydown fallback; phase-based Android no-op test; the pre-admission `onBeforeInput` hook | L28, L29, L30 (flags; the model-owned drift deadline is counted) | −745 | a browser-owned path that seems to need a second adopter must first be shown by a failing browser test |
| I2 ◆ | F-I14, F-I20; `dom-mutation`, `input`, `drop-beforeinput` specs | adoption through the dispatcher; prefix/suffix diff with a preferred position | L31, L32 | −315 | — |
| I3 ◆ | F-I6, F-I7, F-I8, F-I9, F-I13, F-I16, F-I17, F-I18, F-I21; `composition*` specs | the session: target replacement as a command, capture group (window opened at start, held open before each preview), commit as a per-stream delete of live preview items plus an insert at the region start, explicit cancel vs abandonment, `live → tail → gone` | L35 (moved), composition flags, the 50 ms windows | −430 | a fourth commit signal or a second cancel semantic: stop and record the decision; no timer ever ends a session |
| I4 ◆ | F-I10, F-I10b, F-I11, F-I12, F-I15 (cdp) | the pin freezes the host cell's element and segment list; filler and text in one node; the D-20 rule for structural changes | — | +25 | if D-20's default fails a cdp row, the maintainer picks between the retain policy and a recorded regression |

**Track R — Render** (after V2)

| CP | Tests first | Change | Deletes | Δ | Limit / fallback |
|---|---|---|---|---:|---|
| R1 | DOM compared over fixtures in a test route | cells rendered next to the mirror | — (temporary ≈+600 until R4) | +20 | every difference matches a §8 row |
| R2 ◆ | F-P9; "no DOM remount under the caret while typing" (rewrites of `mirror-incremental` and `scoped-text-refresh`) | components read cells; causal segment keys; the pin moves to `surface/pin` | L18, L19 | −395 | an extension that depends on segment identity across commits gets a recorded API change, not identity |
| R3 | F-O5 (end to end), every `sel.ride.*` row | operations stop calling `flushMirror`, one op family per commit (text, structure, clipboard/flow) | L16 | −385 | a command needing a mid-transaction wrapper read extends the op result instead |
| R4 | plugin fixtures; K5 migration notes | handles replace wrappers for extensions; snippets receive declared view objects | L17 | −315 | — |
| R5 ◆ | `placeholder-repair.spec` (user-visible assertions), F-P7, F-P8, F-T8, block-handle and handle-alignment specs, F-P19 (attach half), the mark specs of `dom-mutation.spec` | placeholder attribute + shipped CSS rule; the core renders and registers the block element and each mark's declared element; chrome moves to the overlay | L34, L48, L49, L50, the ten rich-text mark snippets | −670 | — |
| R6 ◆ (r3) | F-O2 and F-O8 on the shadow verdict log; F-O13 (d), (e) on the snapshot log; F-P18 (render half); `bench/` p95 keystroke latency at 5k blocks | the render epoch (`surface.update` becomes an epoch bump; cells, `select()`, readonly, composition phases, suggestions and extension view state bump it) and the records signal; the owned-element registry in the core attachments; run ids from `doc/index`; the pre pass in the root `$effect.pre` and the compare pass in the root post-flush `$effect`, in shadow beside today's observer, their verdicts logged and compared on every dom fixture and DST run (≈+40 temporary); the tail's expectation; read-only policy | L39 | +372 | a divergence the pass cannot classify after two iterations takes the location default (adopt text inside a content, invert structure) and escalates with its failing test (rule 9); there is no tolerance list; stop if p95 keystroke latency at 5k blocks exceeds today's, and drop equal contents in the MutationObserver callback first |
| R7 ◆ (r3) | F-O10, F-O13, F-P17, F-P20, F-I6 (cdp), F-I18, F-I22; `dom-mutation.spec` foreign-damage specs; `mobile-beforeinput.spec` native-drift specs; DST `foreignMutation` on three engines, with D-25's block-level oracle | the observer acts on the passes alone: classification by location and expectation (attempts, the composition tail); adoption of the snapshotted edit placed through run anchors; restoration of the current cell and of missing registered nodes; removal of unregistered children of strict containers, identity clones and escaped nodes; the attribute-ownership table | L33, L65, the shadow comparison | −870 | a legitimate divergence the location default mishandles escalates with its failing test (rule 9); the last-resort fallback is today's liveness classification (+800, priced in §7.3), never a bracket |

**C1 — Close.** Remove the compatibility shims retired by the decisions (the `selection.state` setter, the legacy
`prevent()` throw path if D-10 allows); retire L62 if D-15 is approved; update `AGENTS.md`, the delete contract (anchor
section without the owner facet, one seam rule for foreign endpoints, presence wire, capture group), and the selection
and document docs; final xloc, `bench/` and bundle measurement against §7. Δ −350.
Exit census: timers ≤ 12 (the five named rules, readiness bound, provider backoff/heartbeat/liveness, awareness
expiry, compaction debounce, one-per-frame overlay positioning); `tick()` polling 0; `flushMirror` 0; `stopCapturing` ≤ 2
(the policy table and the capture window); prevention catch sites 1; `ignoreNextSelectionChange` 0; `MutationObserver`
1 (plus one `ResizeObserver` for the overlay); `flushSync` 0; vendor delta = +405 + P7 (≈+30); if G-c takes route (ii), the
vendor total also carries 255 upstream protocol lines, booked as relocated (13 import lines rewritten, no delta).

### 9.4 Expected xloc track

Steps are the Δ column above (target basis: ledger rows, three quarters of the trims on the files touched, minus new
code and the returning-machinery allowance). Temporary shadow code (D11 ≈+600, V1 ≈+250, R1 ≈+600, R6 ≈+40) is allowed on top of
the running total until the checkpoint that removes it. The total is order-independent.

| After | Running total (listing order) | | After | Running total |
|---|---:|---|---|---:|
| start | 29,099 | | S1 | 24,620 |
| G0 | 28,806 | | S2 | 24,478 |
| D1 | 28,782 | | S3 | 24,317 |
| D2 | 28,609 | | S4 | 24,105 |
| D3 | 28,606 | | S5 | 23,994 |
| D4 | 28,136 | | S6 | 23,656 |
| D5 | 28,176 | | S7 | 23,067 |
| D6 | 27,961 | | V1–V6 | 21,237 |
| D7 | 27,792 | | I1 | 20,492 |
| D8 | 26,890 | | I2 | 20,175 |
| D9 | 26,579 | | I3 | 19,745 |
| D10 | 26,551 | | I4 | 19,770 |
| D11 | 26,701 | | R1–R4 | 18,692 |
| D12 | 25,367 | | R5 | 18,024 |
| T1–T6 | 24,543 | | R6 | 18,396 |
| | | | R7 | 17,526 |
| | | | C1 | **17,174 ≈ target** |

## 10. Extension-cost check

The measure is the number of **owners that must change** (modules whose decisions must be edited, not counting the new
feature's own files). "Today" comes from the readers' fact tables.

| Extension | Today | This plan | What makes the difference, and what is still paid |
|---|---|---|---|
| **(a) A new block type with nested children** (a toggle: summary line plus collapsible children) | **6–9 places across 3 layers**: the snippet skeleton with `use:block.attach`, `richTextCommands.ts`, the slash icon table, the markdown table and converter, `elementDefinitions.ts`, core `serializeClipboardFragment.ts`, the demo menu, core `Block.svelte` re-keying, an order-dependent `defaultBlock`, eligibility predicates | **1 owner (Extensions)**: one kind record `{type, element(data), rendersContent, rendersChildren?(data, view), role?, defaultChild?, dataPreset, label, icon, keywords, markdownPrefix?, html, plain?, empty?, viewStateAttributes?}` + an inner-markup snippet with a children slot | The core renders the element and the slot; the Document adopts roles and `defaultChild`; slash, markdown, HTML and clipboard read the record; navigation, selection, delete and move are type-agnostic. **Still paid:** a collapse state the host renders bumps the render epoch through `surface.update`, and a view-state attribute such as `open` is declared so the observer leaves it alone; a structural invariant ("exactly N children") is a normalization hook in the same extension |
| **(b) A new mark** (a valued highlight) | **4–6 places**, and three next-marks rules, one of which drops valued marks | **1 owner**: one mark record `{name, element(value), snippet?, html, sanitize(value), edge: inclusive \| exclusive \| side-dependent, binding?, toolbar?}` | One `marksForInsertion`, generic over values; the edge side is an admission fact, so a link-like mark needs no DOM access |
| **(c) A new inline void with a trigger** (a date chip on `::`) | **2 owners + copied timers**: the plugin, core event code that hard-codes the mention trigger (`onInput.ts:471`, `onBeforeInput.ts:350`), a copied timer-based caret restore | **1 owner**: one atom record and, optionally, a hook on user-origin insert commands | Atoms are generic in offsets, selection, removal, caret stops and clipboard; adopted input goes through the dispatcher, so the trigger fires for native-path typing too; composition previews never reach it |
| **(d) Comments / suggestions on ranges** | **6+ modules**: no anchored-range store; highlight DOM inside the host needs observer exemptions; the remote-caret overlay has its own mapper | **Default: 2 owners + 1 core affordance.** Document: a plugin-declared replicated collection (`threads/<id> = {start, end, …}`) + one facet in the fold (≈20). Extension: the UI and commands over `selection.value` anchors, painted by the overlay (outside the host, so R11/R12 are untouched). **Alternative:** mark families `comment:<id>` with `edge: exclusive` (1 owner + a ≈10-xloc family lookup) | Ranges follow edits through the anchor codec; dead ranges resolve through `pending`/`dead`. Mark families make annotations undoable with the text (a product decision). AI ghost-text suggestions already have an owner (L12) and need no new representation |

Engine-level changes:

| Extension | Today | This plan |
|---|---|---|
| New document content op | 5 places: text-layer op, placement wrapper, facade wrapper (policy, prediction, lineage, attribution), handle method, maybe a run-view facet | One `prepare`/`apply` pair in `doc/streams` or `doc/document` + one command; effect, attribution, lineage, invalidation and hook visibility (as a named step) follow |
| New inputType | Up to 8 decision sites | One intent-table row + one command case (+ an expectation shape if browser-owned) |
| New selection kind (table cells) | The 30-field state, 4 builders, 7 writers, 2 dedupes, 3 restore shapes, echo latches | One union variant, one projection branch, one display branch |
| New transport (WebRTC) | Each provider re-implements schema gates and settle heuristics | A socket adapter over `sync/room`; generation, inbound stamp check, join rule and lifecycle are inherited |

**Obligations this plan adds for extension authors** (the price of single ownership): declare `rendersContent` and
`rendersChildren` truthfully (dev-checked at a settled barrier); declare view-state attributes; bump the render epoch
(`surface.update`) when host-visible view state changes; declare a mark's element (a mark snippet adds inner markup
only, which stays the extension's, D-25); never write imperatively into owned text or mark elements (after a flush
that is input, R12); intervene in nested steps only by veto or replacement (no nested payload rewrites); never touch
the DOM inside a command.

**Owners that grow with features, watched in review:** `doc/document` (one prepared op per structural concept, by
design); `session/attempt`'s intent table (one row per inputType); `surface/observer`, which must stay kind-agnostic
except through the declared attribute table.

## 11. Risks, decisions and scope

### 11.1 Technical risks, largest first

| # | Risk | Why it matters | Detected at | Fallback / cost |
|---|---|---|---|---|
| K1 | **R2 rests on engine behavior plus one engine primitive of ours (P7)** | The engine's walk past tombstones and `redoItem`'s placement are verified; F1 showed that no format choice places a boundary after a gap holding conflicting live format items, so the end-of-gap insert must be an engine primitive. Remaining exposure: other multi-writer counterexamples (F-D13 now runs 4 replicas with a concurrent-format generator and property (e)); TX06a/TX04a re-pinned to YATA order; dead streams keep live boundaries and text (K14); the attribution-renderer configuration | D11 spike | Slice records behind one decider, F-D10 fixed in ownership resolution: +1,227. The facade API is unchanged either way |
| K2 | **Compare-to-truth leaves five exposures** (r3) | The rule needs no whole-program discipline: a render the observer did not expect still compares equal, because the comparison is with the cells, not with who wrote a record. What remains: (1) a browser edit that a same-task model change re-renders, re-keys or moves before the compare (an in-process provider, an extension's `input` listener): the root `$effect.pre` snapshots every content the records name or the flush re-renders, and the edit is placed through run anchors (F-O13 (b), (d), (e)); (2) structure inside an extension's own markup is tolerant (D-25): only identity clones and nodes that left a strict container are removed there; (3) every render is compared once more when its records arrive: one extra flush and one text read per content its records name (F-O5, `bench/`); (4) the live composition host is outside the rule, so a peer's edit inside it renders at the session's end, and its tail's expectation resolves late composition changes; (5) an extension that renders host-visible state without `surface.update` loses no DOM change (its records still run the passes), but that flush's focus note and display are skipped until they do (F-P17 (d)). Anything that writes imperatively into owned text or mark elements is input by definition | R6 (F-O2, F-O8, F-O13 (d), (e), `bench/`), R7 (F-O10, F-O13, F-P17) | The equal-drop in the MutationObserver callback and the upper ends of revision 3's ranges (+80, in the confident number); the last resort is today's liveness classification (+800, R7, priced in §7.3) |
| K3 | **R10 is unproven on real engines** | The projector claims every post-render bounce is "no gesture + render advanced" or one of two named rules. The lanes drive desktop engines; Android and iOS are absent; composition specs are synthetic except the cdp lane | V4, V5 (F-S10, F-S11, F-S12 on three engines + cdp) | The two named rules stay counted until a real-device lane exists; unidentified returns are priced in the target (+532 with K4) |
| K4 | **R8's attempt queue and session tail on engines not in the lanes** | The expectation model replaces seven flags and four timers; the tail replaces the 50 ms windows; both are exercised by Firefox/WebKit specs and cdp, not by real Android IMEs | I1–I4 | Within the returning-machinery allowance of the target |
| K5 | **Plugin API changes in a 0.0.x package** | Snippets no longer attach the block element; extensions get id-only handles (key state by block id + anchor, `Text` has no identity across commits); hooks see the prepared command and each planned step before any write, a nested veto refuses the whole command, nested payload rewrites are ignored with a dev warning; placeholder snippets become `(view: {type, data, focused, empty}) => string \| null`; `new Block({block})` becomes a JSON spec; extensions bump the render epoch through `surface.update` when host-visible view state changes and never write imperatively into owned text or mark elements; mark records declare the element the core renders (a snippet adds inner markup only); kinds declare `rendersContent`, `rendersChildren` and view-state attributes; removed internals: `ignoreNextSelectionChange`, `queueNextUndoSelectionSnapshot`, `getTextById`, direct `stopCapturing` | S1, S2, R4, R5, R6 | Migration notes; thin deprecated shims where cheap (≈ +40) |
| K6 | **Readers' floors may be optimistic** | Line-level estimates, not implementations; the working tree grew ≈8,000 xloc in this wave, mostly browser hardening | every exit (rule 7, per-file gates) | Priced: the target assumes 75 % of the trims, the confident number 50 % |
| K7 | **Change-report exactness** | Cells never re-derive, so a wrong report means a stale render | D9 (F-O7), R2–R4 | Keep `diffSnaps` in production (+81) plus the dev rebuild comparison |
| K8 | **HTML import through `DOMParser`** | Inter-element whitespace was hard-won (commit `43bb7bd`) | D8 | Fixtures from real pastes first; keep the whitespace normalizer (+60); or retire the plugin (G-a) |
| K9 | **Overlay handles in nested scroll containers** | Positions become measured views invalidated by any scroll container | R5 | Budgeted in `plugins/blockHandles` |
| K10 | **Click → caret re-derivation in `Text.svelte`** (36) | Suspected historical, untested | R5 | Kept (budgeted) until a real-browser check retires it |
| K11 | **Test-rewrite volume** (§7.4) | Coverage can drop silently | every checkpoint | Rewrite the oracle before removing the mechanism (rule 2) |
| K12 | **Deterministic seeds** | A hash collision between two different seeds in one room (2⁻³²) diverges it; the hash must cover the engine and schema generation so builds agree; two *different* templates that reuse ids resolve per block by last-writer-wins, as caller ids do today | T3 (F-T11, F-T12, F-T17) | Document "change a template's ids when its content changes"; D-3's refusal keeps the reserved-id seed (+100) and its erasure risk |
| K13 (r2) | **The engine is an owned fork** | P4–P7 are features of our engine, not patches waiting for upstream, so Edytor owns engine correctness and the cost of following upstream. The fork is pinned at upstream `96c96e1` (`@y/y@14.0.0-rc.26`); every upstream merge must keep `UPSTREAM.md`'s diff procedure printing only recorded features and pass the upstream suite (325 tests) plus each feature's differential test | D11 (P7), every upstream merge | Merges are scheduled, not forced; P7 lands with a byte-equality differential test like P4's; offering features upstream is optional and only shrinks the delta |
| K14 | **Dead streams are never reclaimed** | Without delete-time tombstoning, a deleted block's text stays as live items; storage grows with deleted content | D1, D12 (bench) | Acceptable for the product today; a reclaim needs a causal-stability signal an opaque relay does not provide |
| K15 | **The composition capture window relies on `UndoManager.lastChange`** | A plain engine field refreshed before each preview keeps one session in one stack item | I3 | An `UndoManager` `captureTransaction` rule keyed by the session id replaces it if an upstream merge changes the field |

### 11.2 Decisions the maintainer must make (proposed answer in bold)

| # | Decision | Proposed | Why | If refused |
|---|---|---|---|---|
| D-1 | Stream boundaries (internal schema 2) with the P7 primitive | **Yes.** TX06a/TX04a re-pinned to YATA order | Deletes ≈1,090 xloc and the undo repair; one update per undo; fixes F-D10, F-D15, F-D16 | Keep slice records (+1,227) |
| D-2 | Compatibility by generation (engine + wire + schema), plus one inbound refusal of foreign-stamp updates and an outbound quarantine | **Yes.** Mixed-schema rooms partition | Today's gate protects the stamp, not the content (P2), can disable compaction (C11) and drops input (P7); the inbound check keeps a same-generation foreign stamp from spreading (F8) | Keep staging (+≈250) |
| D-3 | Seeding | **Deterministic seed update by a hashed writer: caller ids kept; identical seeds idempotent; a late identical seed never erases an edit; different templates union, and shared ids resolve by last-writer-wins as today.** No virtual first block | Fresh ids duplicate templates (F5) and destroy caller ids (FP-1); caller ids under a user writer erase edits (P4b/c) | Keep the reserved-id seed (+≈100) and accept the erasure risk |
| D-4 | Block fragment pasted at a mid-text caret | **`["HelloX", "YWorld"]` on every path** | One placement rule (`paste-shape`) | Per-path behavior; F-P5 deferred |
| D-5 | Meaning of "move down" | **After the next sibling, never into its children** | Public relative-move semantics (`move-down`) | Per-path behavior; F-P6 deferred |
| D-6 | Composition previews | **Replicated and tracked, inside the session's capture group, so the commit and its previews are one undo step** | Parity with the remote-lock pins; untracked previews break undo (F3, BI-1) | — |
| D-7 | How a composition ends without a commit | **Explicit cancel (empty final value, or `deleteCompositionText` with no insert) deletes the preview inside the capture group. Abandonment (focus loss, a non-composing key, a new `compositionstart`, a selection gesture outside the region) adopts what the DOM shows. Time alone never ends a session** | The browser has committed the text on abandonment (BI-4) | — |
| D-8 | Placeholder customization | **`string \| (view: {type, data, focused, empty}) => string \| null`, rendered by a CSS rule the library ships** | The in-flow node costs ≈355 xloc plus bugs; the demo's focused-only placeholder needs `focused` | Overlay-rendered snippet (+≈40) |
| D-9 | HTML import edge rules | **Unregistered mappings degrade to paragraph/plain; trailing inline text becomes its own paragraph** | Pinned only by fixtures | Keep tokenizer and validation (+≈560) |
| D-10 | Hook semantics | **Hooks run before any write, on the prepared command and on each planned step under its documented name. A veto refuses the whole command; `prevent(() => …)` or a returned command replaces it; a returned payload on the user-level command re-prepares it; a payload returned for a nested step is ignored with a dev warning** | Mid-execution vetoes duplicate text (P11/P11b, `prevent-midway`); this keeps the README's "before any operation", the retarget fixture and the code plugin's replacement (FP-6) | None cheap: interception during execution is the bug |
| D-11 | Duplicate definitions | **First wins everywhere (README)** | Definitions are last-wins today | — |
| D-12 | `setBlock` with reused child ids | **Refuse (`id-collision`); restore-definition exists only for migration `force`** | All-or-nothing (C4) | — |
| D-13 | `defaultBlock(parent)` hook | **Becomes data (`defaultChild` per parent type), merged across extensions, conflicts are errors** | Comparable across views; both current rules are pure functions of the type (V6) | Evaluate the function per registered parent type at adoption |
| D-14 | Delete semantics | **Per-writer marks on the block and what it displays through claims; no content tombstoning; a concurrent merge into a deleted block stays voided (ST02b); a tail split off concurrently is rescued (ST02a)** | X1, F2, F12 | — |
| D-15 | API retirement (L62, ≈352) and the migration options that lose meaning | **Retire** `decorateRuns`, subscriber variants, "advanced internals", raw sync readers, IDB `get/set/del`, the server-side awareness helper; `leaseMs`/`owner`/`pollMs` become documented no-ops; `status()` keeps reporting `pending` through the lock manager; `wait: false` returns `busy` | No production consumer; 0.0.x; changelog entry | Keep them (+352; target −39.8 %) |
| D-16 | Legacy presence fields (`startTextId`/`yStart`, `selection` mirror) | **Remove** | No v14 peer has shipped; v13 peers are excluded by the envelope | Keep (+≈60) |
| D-17 | Concurrent undo vs a split at 0 of still-live text (F-U4d) | **YATA order (client-id dependent), pinned for both orders** | Any other answer needs a repair write (F6) | — |
| D-18 | Reading order of concurrently split siblings | **Tracked, not decided** | Boundary order makes it decidable (≈30 xloc) | — |
| D-19 | Concurrent `delete(p)` ‖ `move(child → root)` | **Undecided** | The move ADR does not cover it | — |
| D-20 | A peer's structural change to the block holding a live composition (delete, retype, re-parent, merge) | **Commit first**: the session commits what the IME shows before the change renders (parity with today's class of behavior). **Retain** (freeze the host cell until the session ends, ≈+60) is the upgrade once the cdp rows exist | R11 makes the remount unavoidable otherwise (BI-6) | Retain now (+≈60) |
| D-21 | Split re-inserts the claims that follow the split point | **Pin the consequence**: a concurrent undo of that merge re-merges into the new block (parity with today's copy of slice records) | No move primitive (F10) | Keep claims on `b` and let the display walk decide (a larger change) |
| D-22 | Forced re-migration | **Restore-definition: legacy ids restored in place** | Verify compares ids (F13) | Fresh ids and an id-free verify |
| D-23 | Normalization after undo/redo | **None** (a tracked write would empty the redo stack) | F4 | Untracked and documented as not undoable |
| D-24 (r3) | Cuts that close the LOC gap (§7.3) | **G-a yes; G-e yes; G-d after a browser check; G-c only by route (i), once U-8 publishes the fork (route (ii) relocates the code into the vendor total and is not proposed); G-b only if no v13 data exists in the field** | The confident number is −37.9 % without them; G-a + G-e + G-d bring it to −39.2 %; adding G-c by route (i) reaches −40.0 %, and G-b instead −40.5 % | Plan with −41 % and accept a confident −37.9 % |
| D-25 (r3) | Structure inside an extension's own markup (a block snippet's elements around the slots, a mark snippet's inner markup) | **Tolerant, like an extension's own attributes.** The root, text elements and core mark elements are strict; missing registered elements are restored anywhere; identity clones and nodes that left a strict container are removed wherever they land. DST's block-level `insertForeignElement` oracle becomes "removed inside a text element or at the root, tolerated in extension markup" | The core renders the block element, the slots' children and the marks, not the snippet's markup (the rich-text snippets hold the content and a children wrapper in one element, `RichTextPlugin.svelte:297-420`), and R12 compares only with what the cells render; policing snippet markup would need to know who wrote each node, which decision 1 excludes | Snippets register every element they render through a core attachment: an obligation on every snippet element, and the observer compares their child lists (≈+30) |

### 11.3 Scope statement

Parity is kept for everything the tests, docs and demo route exercise: rich text, marks and inline atoms; void and
island blocks; nesting, moves, DnD and block handles; the split, merge and delete contracts; IME and composition,
including replicated previews and the remote lock; undo/redo with selection restore and today's grouping; inline text
suggestions; collaboration over awareness, websocket and IndexedDB; the v13→v14 migration; clipboard, paste and HTML;
readonly (including runtime flips), remote selections, slash menu, toolbar and attribution; caller ids in `value`.

The contract changes this plan proposes, all listed in §11.2:
- D-1: the TX06a/TX04a pins; D-17 and D-21 pin client-order and claim-copy outcomes.
- D-2: last-writer-wins schema coexistence is replaced by partition.
- D-3: bootstrap convergence becomes deterministic seeding (templates must change ids when their content changes).
- D-4, D-5: one paste shape and one move meaning instead of several.
- D-8: rich placeholder markup.
- D-9: fixture-only HTML edge behaviors.
- D-10: a nested veto refuses the whole command; nested payload rewrites stop.
- D-14: no delete-time content tombstoning (storage cost, K14).
- D-15, D-16: API and wire fields with no deployed consumer; migration options that lose meaning.
- D-20: composition interrupted by a peer's structural change commits first.
- D-24, if taken: the unexported HTML plugin, the v13 migration, the in-tree protocol ports, the Emacs table, parts of
  the y-websocket option surface.
- D-25: a foreign element inside an extension's own markup survives until that markup re-renders (DST's block-level
  oracle changes); at the root and inside text it is still removed.

### 11.4 Unknowns not resolvable from the repo

- **U-1** (r2) How far upstream v14 final moves from rc.26 in the code the fork's features touch (`Item.js`,
  `RangeCursor.js`, `RelativePosition.js`, the renderers, the insert walk P7 extends) and in the semantics the plan
  relies on (`redoItem` placement, `captureTimeout`, format-item pruning). It prices every upstream merge (K13).
  Revision 1's U-1, whether `flushSync` in the commit callback is well-ordered on every provider apply path, is
  dissolved: nothing calls `flushSync`.
- **U-2** Real Android/iOS IME behavior under the projector, the attempt queue and the session tail. The lanes run
  desktop engines and the cdp path only.
- **U-3** Whether F-U4a–e hold with an attribution renderer active on a backing text. D11 runs that configuration.
- **U-4** Whether any consumer outside the repo depends on the retired surface (D-15) or on plugin internals (K5).
- **U-5** `navigator.locks` on Node 22 (present in current browsers and Node 24). Fallback: an in-process mutex.
- **U-6** Bundle-size effect. Not measured; the engine dominates the bytes.
- **U-7** The wire cost of boundaries in heavily formatted text. P7 adds no format items; F-D16 measures it.
- **U-8** (r3) Whether to publish the fork as a package. G-c's route (i) needs it: upstream `@y/protocols` imports
  `@y/y` at runtime (sync) and for types (awareness, auth), so the fork must resolve as `@y/y` in every consumer
  install, and a consumer who also installs upstream `@y/y` gets two engines. Consumers who want one engine copy
  shared with their own server code need it too; upstream acceptance of P4–P7 is now optional and would only shrink
  the delta.
- **U-9** Whether the engine's update encoding for a seed is stable across engine releases; the seed hash includes the
  generation, so a new generation seeds a new identity by design.

### 11.5 Options the fork opens (not decisions)

| Option | Benefit | Cost | Revisit when |
|---|---|---|---|
| **The boundary as an engine-level item**: a non-countable content type in the fork (like a format item) that every read skips, no content delete removes, and a relative position binds to natively | Display offsets become engine indices minus the stream start. The range-read skip, the boundary guards in `locate`/`position` and in the per-stream delete, and the anchor codec's boundary case leave `src/lib` (≈−50 xloc). "Never displayed, never deleted by content, skipped by every read" becomes an engine invariant instead of a convention held in four places | ≈+150 to +200 fork lines: the content type and its encoding; delete and format walks that pass it; reader and renderer skips (P5, P6); an insert that names its side, because an index no longer says which stream a gap-edge insert joins. A new content ref changes the wire, so it needs an engine generation bump (it can ride D12's schema bump), and every upstream merge touches more of the fork (K13). Edytor-maintained code grows by ≈100–150 net | D11 shows the boundary handling of `doc/streams` or `doc/anchors` over budget, or F-D13 keeps finding boundary-edge failures |

## 12. Review disposition

Every finding was checked against source or by re-running its probe before its verdict. Lens keys: **LH** loc-honesty,
**FP** feature-parity, **F** crdt-constraints, **BI** browser-input.

### 12.1 Blockers (2)

| ID | Finding | Verdict | Verified by | What changed in the plan |
|---|---|---|---|---|
| FP-1 | R13's "seed under fresh ids" destroys caller-id preservation of `value` (demo deep links, JSON round trip, same-template dedupe), and v1's no-overwrite claim silently depended on that loss | **ACCEPTED** | `crdt/document.ts:636-645` keeps caller ids ("concurrent same-id inits dedupe"); demo ids `+page.svelte:84-172` and the deep-link `onBlockAttached` at `:29`; `deterministic-seed.mjs` re-run | R13 rewritten: one deterministic seed update from a content-hashed writer, caller ids kept, identical seeds idempotent, a late identical seed keeps edits (§2.1 Seeds, O17, L56, D53, D-3, K12). Rows F-T11, F-T12, F-T13, F-T17; checkpoint T3 |
| F1 | The boundary-format rule does not make R16 hold: a three-peer delete ‖ format race sends the undone text into the new block, and L5's deletion rested on it | **ACCEPTED** | `a5-concurrent-format-min.mjs` re-run: R16 violated for every client order when the delete arrives before the format; `ynode.js:285-297`: the walk stops at a live format item whose value differs, so no single format map passes two conflicting items | R2 rewritten: the boundary goes to the end of the gap through the engine primitive P7, charged as vendor delta (§1.1, §2.1 Split, O4, D13, §4.1). L5 is deleted only after F-U4e and F-D13's new property (e) pass on 4 replicas with a concurrent-format generator; the D11 abandon criterion includes P7 failing its differential test (K1, K13). **r2:** P7 is a feature of the owned fork |

### 12.2 Major findings (28)

| ID | Finding | Verdict | Verified by | What changed in the plan |
|---|---|---|---|---|
| LH-1 | v1's §7.2 robustness claim fails: the view-side rows exceed their targets, so the band needs both representation bets | **ACCEPTED** | the evidence items at the lines they cite (attribute healing `domTextMutationObserver.ts:1137-1152, 1351-1366`; 18 compatibility-getter fields; 318 xloc of per-kind tables) | §7 rebuilt: stretch (floor + evidenced items + repairs, −45.9 %), target (+ unrealized trims + returning machinery, −41.3 %), confident (−37.8 %); the scenario table shows either bet's abandonment leaves the band; gap closers priced (§7.3, D-24). **r3:** −45.6 %, −41.0 %, −37.9 %; both fallbacks are priced (R2's +1,227 and R7's liveness classification, +800); the cuts that remove code bring the confident number to −39.2 %, and the 40 % line needs G-c by route (i) or G-b (§7.3; LH2-2, LH2-3) |
| LH-2 | ≈3,250 xloc of "shrinkage" has no ledger row, invariant or owner, yet v1's track booked it at 100 % | **ACCEPTED** | the reader reports' per-file floor tables (they itemize most of it per file) | §5.10 books trims as their own line, at 75 % in the target and 50 % in the confident number; rule 7 makes each rewritten file's reader floor a gate (≤ 125 %); §9.4 steps count three quarters of the trims |
| LH-3 | R10 and R8 carry ≈2,560 xloc of ledger with no priced fallback; contingency is flat | **ACCEPTED** | the cited `cross-browser-confidence.md` hardening items and the ledger rows L21–L23, L26, L28–L31, L35 | a 30 % partial return is priced (the named BI repairs plus +532 unidentified); decision refusals priced in §7.3; the named browser rules survive (rule 5) |
| LH-4 | The vendor boundary is porous: +405 xloc of Edytor patches sit outside the metric, and R2's code could land there | **ACCEPTED** (as a reporting rule) | `xloc.mjs --vendor`: vendored 7,125 vs upstream 6,720; P5's `RangeCursor.js` 185 | The maintainer's metric stays the headline; the delta is reported (§0, §7.3: −40.6 % with the delta in both columns) and censused; P7 is charged; rule 8 forbids meeting a budget by moving code into the vendor. **r2:** the engine is an owned fork; the delta is still reported and charged, and rule 8 says what may move into it |
| LH-5 | The counter counts 853 `export type` body lines, so budgets can be met by restyling | **ACCEPTED** (as a reporting rule) | `typebody-count.mjs`: 853 (crdt core 333, transport 109, root 95, block 77, …) | The counter hash is frozen for comparability; type-body lines are reported per domain (§0) and in the census; restyling to meet a gate is forbidden (rule 8); §7.3 gives the corrected-counter figure (≈−41.8 %) |
| LH-6 | The events floor treats foreign-writer attribute handling as own-render noise; the bracket is budgeted 30 for five duties | **ACCEPTED** | `domTextMutationObserver.ts:1080-1100` (foreign writers), `:1137-1152` (non-strict block elements), `:1351-1366` (`contenteditable` healed to the readonly state) | R11/R12 declare attribute owners (O60, D51); L33 keeps ≈100 as the ownership table; the bracket carries its real duties in `surface/observer` (990). **r2, r3:** the bracket is gone; the observer is re-budgeted line by line at 960, then 1,070 (§4.4), and the ownership table stays |
| FP-2 | "Insertion coalesces, everything else cuts" breaks the pinned delete-then-type step; v1's F-U8 contradicted a pinned spec | **ACCEPTED** | `onBeforeInput.ts:539-549` (cut before paragraph, paste, drop, delete), `beforeInputCommands.ts:584-586` (cut after Enter), `history-coalesced-range.spec.ts:14`, `input.spec.ts:1023` | R7 and O31 state today's grouping as the policy table; F-U8 removed; F-M5 added; S1 |
| FP-3 | Previews that bypass undo make undo resurrect the preview and lose a selection the composition replaced (same root as F3, BI-1) | **ACCEPTED** | `UndoManager.js:84-96` (own insertions never redone), `:98-114` (no-op items skipped), `:200-238` (`lastChange` capture); `composition-undo2.mjs` re-run | Previews are tracked inside the session's capture group (window opened at start and held open before each preview); the start-target replacement is an ordinary command (hooks, veto, tracked); explicit cancel lands in the same group (R7, R8, D-6, D-7, D32, K15); F-I16; I3 |
| FP-4 | R12 brackets only document changes, but native `<details>`, runtime readonly and plugin attributes render into the host from other state (same root as BI-9) | **ACCEPTED** | `RichTextPlugin.svelte:306-319` (`details`/`toggle` kinds), `Edytor.svelte:229` (`contenteditable={!readonly}`), the observer's owned/unowned attribute rules | R11 (host = f(model, declared view state); unowned attributes never inverted) and R12 (every host-visible write through `surface.update`; inversion never removes framework anchors) (O60, O66, D51); F-P17; R6. **r2:** renders need no bracket (R12 compares with truth); the attribute owners and the anchor rule stay; F-P17 gates R7 |
| FP-5 | Inline text suggestions (README "AI copilot ready") have no owner and render outside any bracket | **ACCEPTED** | `block.svelte.ts:247-275` (per-block `$state`), `Content.svelte:37-45`, the clear-on-leave in `selection.svelte.ts` | Suggestions are Session state (L12, O43) cleared by `select()` (R9, O27) and rendered through the bracket; F-P18; V2, R6. **r2:** they render as ordinary cell state, their elements registered as owned |
| FP-6 | The documented interception contract (every operation; payload replacement) changes silently | **ACCEPTED** (repair modified) | `plugins.ts:91` (`=> C['payload'] \| void`), `CodePlugin.svelte:103-133` (nested veto with a replacement, payload rewrite), `RichTextPlugin.svelte:98-127`, `pipeline.fixtures.tsx:99-125` | Operations are two-phase (R6); hooks run before any write on the prepared command and on each planned step under its documented name; a veto refuses the whole command; `prevent(() => …)` or a returned command replaces it; user-level payload replacement re-prepares; nested payload rewrites are dropped with a dev warning and declared (R7, O30, D46, D-10, §11.3, K5); F-P16, F-M2, F-O3, F-O11; D5, S1, S2 |
| FP-7 | "One seam rule for every cause" moves the caret after a local block-selection delete or cut | **ACCEPTED** | `replaceSelection.ts:132-142` (`getClosestUnselectedBlock` previous, then next), `hotkeys.spec.ts:955-993` | The command authors its result selection; the slot seam applies only to endpoints the view did not author (R9, O14, O42, D23; L25 no longer claims `getClosestUnselectedBlock`); F-S13; V3 |
| FP-8 | A static non-inclusive link edge reverses the pinned "type inside the trailing anchor edge extends the link" | **ACCEPTED** | `RichTextPlugin.svelte:98-127`: the rule reads whether the DOM caret sits inside the `<a>` | The admitted target records the edge side (R4, O48); the mark's edge policy may be side-dependent and reads it (O29, O69); F-P15; S3 |
| F2 | Delete-time content tombstoning breaks ST02a and makes undo-of-delete a copy that loses an offline peer's edits | **ACCEPTED** | `st02a-delete-tombstone.mjs` and `delete-tombstone-undo-offline.mjs` re-run; ST02a pinned at `src/tests/crdt/scenarios/active-text.ts:647-665` | Delete writes marks only (R3, §2.1 Delete, O6, D55, L9); the storage cost is declared (K14); F-D17, F-D20; D1 |
| F3 | Composition previews that bypass undo make undo resurrect the preview or undo the wrong step | **ACCEPTED** | as FP-3 | as FP-3 |
| F4 | History cannot run as a dispatcher command: an enclosing transaction or a tracked post-undo write empties the redo stack; lineage-in-undo has no mechanism | **ACCEPTED** | `UndoManager.js:207-223` and `:328-359`; `nested-undo.mjs`, `lineage-in-undo.mjs` re-run; today's bare call in `edytor.svelte.ts` `historyUndo` | History is R7's named exception (bare undo/redo, no tracked write after, D-23); lineage for undo/redo from a `beforeTransaction` listener and no attribution stamp for undo/redo (O19, O32); F-U9, F-O12; D10, S7 |
| F5 | "Seed under fresh ids" duplicates every non-empty initial value; a deterministic seed removes both duplication and erasure | **ACCEPTED** (repair corrected) | `deterministic-seed.mjs` re-run; **new probe `final-probes/seed-collision.mjs`: the attack's fixed seed writer id diverges replicas whose seeds differ** (`p2:Bodyate` vs `q1:Other template`); a hashed writer id converges | The seed writer id is a hash of the generation and the canonical seed (§2.1, R13, D53, K12); F-T11, F-T12, F-T17; T3 |
| BI-1 | Previews that bypass undo make committed IME text un-undoable; composing over a selection deletes it with no hooks and no undo | **ACCEPTED** | as FP-3; `beforeInputCommands.ts:173-186` (today's first preview replaces the selection through ordinary ops) | as FP-3; the target replacement goes through the dispatcher, so a veto refuses an IME composition over a protected block exactly as typing (F-I16 (e)) |
| BI-2 | The projector has no composition gate, so the bracket's display writes the DOM selection into a live IME session | **ACCEPTED** | today's guards at `text.svelte.ts:762-769` and `selection.svelte.ts:2388` sit in rows v1 deleted (L16, L21) without moving them | R10: no display while a session owns a host; the session's end performs the catch-up display; mapping is pin-aware (O49, D49); F-S12 (cdp); V4. **r2:** the display runs from the post-flush `$effect`, behind the same gate |
| BI-3 | "Always write the current value" overwrites native moves whose `selectionchange` is still queued, and the drag guard loses its consumers | **ACCEPTED** | drag guards at `selection.svelte.ts:2194, 2378` | R10: every bracket first reads the live DOM selection and admits an unobserved move; no display during a drag (O52, O57, D50; L22 keeps ≈90); F-S11; V4. The arrow-key race exists today too; v1's claim that W1 became structural is withdrawn. **r2, r3:** the read happens before the first transaction after a settled render that this view did not issue (a `$effect.pre` read would come after the commit), only mints anchors, and admits the move after that transaction commits (LH2-5) |
| BI-4 | D-7 deletes composed text on abandonment, where the browser already committed it | **ACCEPTED** | the dangling-blur reset keeps previews while the observer's idle cancel deletes them after 750 ms (today's two exits) | D-7 splits explicit cancel from abandonment, which adopts what the DOM shows; time never ends a session (R8, D32); F-I17; I3 |
| BI-5 | The session ends at commit, but Firefox and WebKit keep signalling after it | **ACCEPTED** | the post-commit windows and timestamp at `edytor.svelte.ts:350, 1665, 1683-1684, 1760-1761`; pins `composition.spec.ts:896, 935` | Sessions have phases `live → tail → gone`; the tail ends at the next non-composition occurrence or a timestamp compared at use, not a timer (R8, L7, O34, D48); F-I18; I3 |
| BI-6 | R11 forbids keeping the IME node alive through a peer's structural edit, so v1's F-I12 could not pass | **ACCEPTED** (as a decision) | R11 as written in v1; `Block.svelte` `{#key}` re-keying today | D-20: commit first by default (parity with today's class), retain as the upgrade; F-I12 rewritten; §1.3 no longer claims node survival for structural remote changes; I4 with cdp rows |
| BI-7 | "The open attempt's owner" is singular, but Android drift outlives its attempt and overlaps the next one | **ACCEPTED** | `onBeforeInput.ts` drift window armed after the awaited command; `mobile-beforeinput.spec.ts:1288` | Attempts carry expectations and queue per host; records are attributed by expectation; the model-owned drift deadline is a named, counted rule (R8, L6, O33, O59, D56); F-I19; I1 |
| BI-8 | An identity-based Android no-op check plus a prefix-greedy diff double-deletes after doubled letters | **ACCEPTED** | `utils/diffText.ts:20-62` (prefix-greedy); today's fallback compares strings | The diff prefers the attempt's target (D57; L32 keeps ≈50); the no-op test is "did this attempt's adoption apply a deletion" (§4.3 `session/attempt`); F-I20; I2 |
| BI-9 | The bracket covers document changes, but session and view state also render into the host; inverting Svelte childList can hang | **ACCEPTED** | `domTextMutationObserver.ts:314-319` (removing fragment anchors spins the reconciler) | as FP-4; plus the placeholder's composition dependence renders inside the bracket, inversion never removes anchors, and CI runs the dev assertion (F-O10). **r2, r3:** no bracket and no dev assertion; F-O10 is a truth invariant, with a jsdom writer log as its diagnostic (BI2-9); inversion still never removes anchors |
| BI-10 | The gates chosen for IME, projector and bracket claims cannot falsify them | **ACCEPTED** | `dispatchComposition` (`tests/editor-dom/helpers.ts:1017`); DST composition is `isTrusted: false` (`runner.ts:495`); CDP only in `mobile-composition.spec.ts:348-430` | A cdp lane with gate status is built at G0 (§8 rules); the Android snap-back, the IME post-commit jump and the drift deadline stay named, counted rules until a real-device lane exists (rule 5; L23 keeps ≈60; K3) |
| BI-14 | The single focus predicate has no gesture-location fact, so the projector steals a selection made outside the editor | **ACCEPTED** | `lastUserGestureOutsideEditor` set at `edytor.svelte.ts:2113, 2186` and read at `selection.svelte.ts:2269`, `domTextMutationObserver.ts:975, 1042` | The focus verdict takes `activeElement`, the last gesture's landing, where the DOM selection is, and what our flush detached (R10, O53, O56, D27); F-S9(c); V4. **r2:** "what our flush detached" is whether the element the root `$effect.pre` noted is still connected |

### 12.3 Minor findings (20), grouped

| Group | Findings | Verdict | What changed |
|---|---|---|---|
| Measurement | LH-7 per-kind data moved, not deleted; LH-8 `diffSnaps` booked as deletion; LH-9 derived views with unbudgeted invalidation; LH-10 root floor 110 below the readers' and no hook/operation-name adapter | **ACCEPTED** | L47 books the data as moved (records ≈140, in `plugins/richtext`); `diffSnaps` moves to L63; §2.4 names each invalidation source (overlay, cells, handle cache, DOM-derived compat fields, dev rebuild) and §7.2 budgets them; root +90 and the adapter in `session/commands` |
| Contracts and surfaces | FP-9 declared `rendersContent` without enforcement; FP-10 documented hooks and APIs with no owner; FP-11 read-only observer policy; FP-12 migration API shape | **ACCEPTED** | dev check plus the displayable filter (O22, O65, F-S14); every surface mapped (O72, F-P19, K5); R12's read-only policy (O61, F-P20); `status()` via `locks.query`, `wait:false` → `busy`, lease options documented as no-ops (O79, D-15, F-T16) |
| CRDT | F6 D-17 is a client-order coin flip; F7 two incarnation identities; F8 frame-level schema spreads a same-generation foreign stamp; F9 streamless split-born blocks; F10 split moves claims by copy; F11 the fold cursor cannot use `transaction.changed`; F12 selective undo of a double delete; F13 `force` needs a revive op | **ACCEPTED** | F6: D-17 pins YATA order, and every multi-replica row runs ≥3 client assignments (v1's V2 "concurrent order" was one assignment). F7: attribution keyed by `n`, L64, D44. F8: inbound refusal + outbound quarantine (O73, L55 keeps ≈55, F-T14). F9: the streamless rule (§2.1, F-D19). F10: D-21 pins the consequence. F11: the watermark (§2.4, O11, F-O9). F12: per-writer delete marks (R3, D54, F-D18). F13: restore-definition (O24, D-22, F-T15) |
| Browser | BI-11 a peer split inside a replicated preview; BI-12 recovery into content hidden by view state; BI-13 a pinned key plus an atom inside the host segment duplicates text; BI-15 the filler-to-text swap in an empty block | **ACCEPTED** | BI-11: the commit deletes live preview items per stream and inserts at the region start (F-I21). BI-12: merged with FP-9 (displayable, `rendersChildren`). BI-13: the pin freezes the host cell's segment list (O47, D16, F-I10b). BI-15: filler and text in one node (components, F-I15) |

### 12.4 Rejected

None. Every finding held against source or a re-run probe. Two repairs were corrected rather than adopted as written:
F5's fixed seed writer id (it diverges replicas whose seeds differ; replaced by a hashed writer id), and FP-6's two
options (the plan keeps nested visibility by showing each planned step before any write, instead of dropping nested
interception or adding a hook phase per step during execution). LH-4 and LH-5 are adopted as reporting and gating rules;
the maintainer's metric is unchanged.

### 12.5 Revisions 2 and 3 (Option B + fork, and its review)

Three maintainer decisions, folded in without re-litigation: the compare-to-truth observer (Option B), Svelte's own
flush order as the timing hook, and the vendored engine as an owned fork.

| Change | Where | Why |
|---|---|---|
| R12 is **Divergence after flush is input**. The bracket, `flushSync`, the own-record discard, the nested-apply queue, the dev assertion and the +200 exemption list are gone; `surface.update` survives as a render-epoch bump | §0, §1.2, §2.2–2.4, §3.3, §4, §6.3 (D30), §10 | Decision 1: divergence from truth needs neither record provenance nor a whole-program discipline |
| §1.1 records the flush order from source and a scratch probe; the timing hook is the root component's top-level `$effect` | §1.1 | Decision 2, made precise: an `$effect` deeper in the tree can run before later attachment writes, while the root's top-level one runs after all of them |
| The render write guard and base-relative adoption (D58, F-O13 (b)). **Withdrawn in revision 3** (BI2-1): replaced by the pre-flush snapshot and placement through run anchors | §2.4, §4.4, §6.3, §8.7 | Without them, a model change that lands on a browser-edited node in the same flush erases the divergence the rule relies on (the synchronous variant of the maintainer's autocorrect example) |
| The projector reads the DOM selection before the first transaction after a settled render, displays from the post-flush `$effect`, and detects focus orphaning with the element the root `$effect.pre` noted (revision 3: anchors only, before transactions this view did not issue; admission after the commit, LH2-5) | R10, O50–O53, D27, D49, D50, V4 | The bracket's first and last steps needed homes; a `$effect.pre` read comes after the commit, when the DOM point can no longer be mapped |
| `surface/observer` 990 → 960; L33 and L39 restated, L65 added; §5.10 and §7 recomputed: target 17,060 (−41.4 %), stretch 15,714 (−46.0 %), confident 17,974 (−38.2 %) (revision 3: 1,070; 17,174, 15,828, 18,068) | §4.4, §5, §7 | Line-by-line re-budget; only the `events` row moves |
| R6 is the render epoch, the registry and the compare pass in shadow (+245); R7 switches, adds the write guard and deletes L33 and L65 (−870) (revision 3: R6 +372 with the pre pass; R7 adopts the snapshotted edit) | §9 | Rule 3 (shadow before switch); R7's rule-6 exception now has its shadow checkpoint |
| F-O2, F-O8, F-O10 rewritten as compare-to-truth tests; F-O13 added; F-O5 covers the compare pass; F-P17, F-P20 and F-I6 gate R7 | §8 | Decision 1 |
| K2 rewritten; K13, U-1 and U-8 rewritten for the fork; G-c re-measured (≈240, route (ii) proposed in D-24); the engine-level boundary item added as an option (§11.5); rule 8 says what may move into the fork (revision 3: route (ii) is a relocation and D-24 proposes route (i) only, LH2-1) | §7.3, §9.1, §11 | Decision 3 |

Dispositions whose repair changed are marked **r2** in §12.1–12.2: BI-9, FP-4, FP-5 and LH-6 (the bracket); BI-2, BI-3
and BI-14 (its first and last steps); F1 and LH-4 (the fork); LH-1 (the recomputed band). F-O10's check moved from a dev assertion to a test-side
writer log. Revision 3 re-marks LH-1, LH-6, BI-3 and BI-9 (**r3**).

**Revision 3: the two attack reviews of revision 2** (`attack-loc-honesty-r2.md`, 9 findings; `attack-browser-input-r2.md`,
9 findings; 2 blockers, 10 major, 6 minor). Each was checked against source; the observer findings also by re-running
the attack's probe (`r2-attack-probe`, both cases reproduce). The three maintainer decisions are taken as given. Keys:
**LH2** loc-honesty, **BI2** browser-input.

Blockers (2):

| ID | Finding | Verdict | Verified by | What changed in the plan |
|---|---|---|---|---|
| BI2-1 | A write the guard skipped is never retried, so an inversion to the last-written text, a tolerated divergence, a read-only node or a deferred divergence leaves stale text that every later pass reads as truth | **ACCEPTED** | probe B2 re-run: `guard-skip:"hel"(cell "Xhell")`, `invert-to:"hell"`, and the DOM keeps `hell` after a later epoch bump; Svelte's own writer would have written (`render.js:46-55`) | The write guard is withdrawn (D58): Svelte's declarative writer always renders the current cell, and the root `$effect.pre` snapshots an edited content before a flush re-renders it. Inversion restores the current cell (exact text when the text-node partition matches, else a remount of that element). No tolerance list exists (R6's limit, K2; decision 1 tolerates only the live IME host). Read-only text divergence is inverted at the flip back (F-P17 (b)); deferred divergences wait for the records signal; the hand-back re-dirties the host. F-O13 (d); F-O10 becomes "after settle every content equals its cell's current text" |
| BI2-2 | Structural divergence is either own-render noise (mark snippet markup is never registered) or invisible (root and block child lists are tolerant), so Android's native paragraph, Chrome's re-nested marks, DST's injected elements and removed elements survive | **ACCEPTED** (repair adapted) | `RichTextPlugin.svelte:231-296` (mark snippets render `<b>`, `<a>`, `<span style>`); `mobile-beforeinput.spec.ts:351-354, 406-409` against `:1346, :1373`; DST `runner.ts:748-760`, `browserState.ts:2205-2215`, `generator.ts:77-78`; `dom-mutation.spec.ts:708, 854`; `domTextMutationObserver.ts:679-745` (restoration needs each record's added and removed nodes and siblings); `cross-browser-confidence.md` (WebKit drops a root sibling; today's `{#key}` remount) | The root, text elements and core mark elements are strict containers. Missing registered elements and framework anchors are re-inserted from their records in the root `$effect.pre`, before Svelte reconciles; unregistered children of strict containers are removed after their text is compared; identity clones and nodes that left a strict container are removed with their topmost unregistered ancestor. Mark records declare the element the core renders and registers, which replaces the ten rich-text mark snippets. An extension's own markup around the slots is tolerant through D-25, which changes DST's block-level oracle: the rich-text snippets hold the content and a children wrapper in one element (`RichTextPlugin.svelte:297-420`), so slot elements cannot be strict (R11, R12, D59, O58, §4.4 +55, R5, R7) |

Major (10):

| ID | Finding | Verdict | Verified by | What changed in the plan |
|---|---|---|---|---|
| LH2-1 | G-c's route (ii) relocates ≈227 xloc into the excluded vendor directory and grows maintained code by ≈28; the adapter is ≈53, not ≈40; the import rewrite adds no delta | **ACCEPTED** | `xloc.mjs`: `crdt/protocols` 508, upstream `@y/protocols` 255; 13 rewritten import lines (10 `lib0/`, 3 `@y/y`); the fixes at `awareness.ts:77, 116, 124-127` and `auth.ts:32-37`, which upstream `awareness.js:89-94` and `auth.js` lack; the ports import no `@y/y` (`bindSync(Y)`), while upstream `sync.js` calls it | Decision 3's question answered: the ports (280 in the target) are larger than an adapter around upstream (≈53), so consuming upstream saves ≈227, but only route (i) removes it from the repo, and route (i) needs U-8. G-c's row prices both routes; D-24 proposes route (i) only; rule 8 and §7.4 book relocated upstream code as neither removed nor toward the 40 % line; C1's census line corrected (§7.3, §7.4, §9.1, §11.2, U-8) |
| LH2-2 | Recounted, the confident number is −38.0 %, and D-24's cuts reach 40 % only by counting the relocation | **ACCEPTED** (recounted) | this plan's line-by-line re-budget (§4.4) and `scratchpad/arch/rev3/loc-model-r3.mjs` | §7 rebuilt: target 17,174 (−41.0 %), confident 18,068 (−37.9 %), stretch 15,828 (−45.6 %). The cuts that remove code reach −39.2 %; the line needs G-c by route (i) (−40.0 %) or G-b (−40.5 %). Against revision 1, Option B as repaired moves the target by +84 and the confident number by −36 (the +200 exemption list is gone) |
| LH2-3 | §7.3 dropped the +800 fallback that R7 still records | **ACCEPTED** | R7's limit column; K2 | "Target, R7 fallback" (17,974, −38.2 %) and "R2 and R7 fallbacks" (19,201, −34.0 %) restored; K2's fallback column and §7.2 carry +800; LH-1's note reworded |
| LH2-4, BI2-3 | The guard covers text writes only: a same-task mark change, atom deletion, retype, move or split re-keys or destroys the edited node, and the edit is lost | **ACCEPTED** (LH2-4's option (a)) | probe B1 re-run: `pre:"hello world"`, then `unregister:"hello world"` and `cmp:…:unregistered:detached`; `Text.svelte:32, 236-244` (run key `index:marks`, the `{#if delta.marks.length}` switch), `Mark.svelte:28` | The root `$effect.pre` snapshots every content the records name or the flush re-renders whose DOM differs from its last rendered text; the post pass places the edit through its base runs' start anchors (runs carry their first character's id) and rebases it within the run, so it follows its text through a re-key, split, move or retype. F-O13 (e) covers each case (D58, O59, §4.4 +30, `doc/index` +5) |
| LH2-5 | Admitting an unobserved move inside `beforeTransaction` runs hooks inside the transaction: a hook's command joins it under the provider's origin (never broadcast or persisted) or lands in the undo's redo item; during an adoption the DOM is ahead of the model | **ACCEPTED** | vendored `Transaction.js:417-427` (`beforeTransaction` fires after `doc._transaction` is set); `room.ts:312`, `websocket.ts:479`, `indexeddb.ts:507-535` (provider-origin updates are neither broadcast nor persisted) | The projector only mints anchors there, only before transactions this view did not issue (remote applies and hydration, told apart by origin because the engine sets `local = false` inside the apply, `encoding.js:248-249`; a command of this view admits the DOM selection with its event), and not where the dirty set shows the DOM ahead of the model; it admits through `select()` after the commit (R10, O52, D50, V4); projector +12; F-S11 (d) |
| BI2-4 | Comparing one node at a time misreads browser splits and multi-node edits | **ACCEPTED** | `dom-mutation.spec.ts:299-341, 655-706` (a split inside a mark leaves the model unchanged and one text node); `cross-browser-confidence.md` ("logical text content is unchanged") | The unit is a block's content: every text node under its text elements in document order, fillers stripped, an atom one unit, against the cell. Equal text with a different partition or mark chain is a structural re-render; one preferred-position diff per content is matched against that host's expectation queue (O58, O59, R12, §4.4 +30) |
| BI2-5 | The timing hook is half specified: nothing says what records trigger, effect-phase writes land after the compare and display, K2's missed-bump claim is wrong, and deadlines have no trigger | **ACCEPTED** | `effects.js:128-135`, `batch.js:290, 324, 349`; probe B1 (`post:""` before `write:…`) | §1.1 restated. A records signal, written by the MutationObserver callback, deadline expiry and attempt phase changes, re-runs both passes and never reaches the classifier (L8, O55). The core's host writers are template effects and attachment bodies (lint, §4). The display dedupes on (selection epoch, render epoch), so a chained batch that bumps the epoch re-displays. K2 restated (with LH2-8). Divergence no expectation claims takes the location default: text inside a content is adopted, structure is inverted (R6's limit) |
| BI2-6 | The host returns to the compare pass at session end while the tail still owns late composition changes: WebKit's early commit and Firefox's trailing input land on a node the pass owns, and "the base the session accounted for" is undefined | **ACCEPTED** (repair modified) | `composition.spec.ts:662-727` (commit before `compositionend`), `:896-975` (trailing input); `cross-browser-confidence.md` | The tail is an expectation queued on its host: a late composition change resolves to the committed text (inverted, never adopted). The pin is released and the host re-dirtied at session end and compared with its cell (no accounted base). IME updates that continue after a D-20 forced commit open a new session (F-I12 (b), cdp); F-I18 gates R7. The host is not kept excluded through the tail: a tail that ends only by a timestamp compared at use could keep it frozen, and a peer's edit unrendered, indefinitely |
| BI2-7 | The re-budget omits these mechanisms; the confident case with the cuts had a 55-xloc margin | **ACCEPTED** | the findings above | §4.4 itemizes revision 3 (observer 960 → 1,070; `session/composition` +10, projector +12, `doc/index` +5, declared mark elements −25): +114 net. §5.10, §7 and §9.4 recomputed; the claim that D-24's cuts close the gap is withdrawn (§7.3) |

Minor (6), grouped:

| Group | Findings | Verdict | What changed |
|---|---|---|---|
| Bookkeeping | LH2-6: per-cell base, retained removed nodes, a records signal, hand-back re-dirty | **ACCEPTED** | Per-content last rendered text with run anchors; added and removed nodes and siblings kept for strict containers; the records signal; the hand-back re-dirties the host (L8, §4.4) |
| Writer | LH2-7: guarding the writer changes the host's DOM shape | **ACCEPTED** (cost avoided) | The guard it prices is withdrawn, so no element per run and no `domPoint` change; the no-attempt rebase is booked (§4.4, placement +15) |
| Discipline | LH2-8: `surface.update`'s call-site discipline survives | **ACCEPTED** | K2 exposure (5): a missed bump loses no DOM change (records still run the passes) but skips that flush's focus note and display; F-P17 (d) collapses the block that holds the caret |
| Residual | LH2-9: the hand-back is booked twice and R6's cap spends the whole allowance | **ACCEPTED** | The hand-back is in the target only; there is no tolerance list; the confident residual is the equal-drop (≈15) plus the upper ends of revision 3's ranges (≈65): +80 (§7.2) |
| Filler | BI2-8: the filler and the placeholder under the compare pass | **ACCEPTED** (repair modified) | Fillers are stripped on both sides of every comparison; F-I22 (Android first character). The splicing writer is not adopted: the text writer stays Svelte's `set_text`, whose identical-value rewrite resets the caret as it does today (`render.js:46-55`), and the post-flush display restores it in the same task; F-I22 bounds that to one display write per adoption |
| Oracle | BI2-9: F-O10 needs the per-write provenance the design dropped | **ACCEPTED** | F-O10 is a truth invariant (after settle, every content equals its cell's current text and every strict container holds its expected children); the writer log is a jsdom diagnostic, built at G0 by tagging the `Node`/`CharacterData` mutators with the calling module (test-side) |

Rejected: none. Every finding held against source or a re-run probe. Three repairs were adapted rather than adopted as
written: BI2-2's strict slot child lists (slot elements also hold extension markup, so strictness stops at core
elements and D-25 records the tolerance), BI2-6's exclusion of the host through the tail (the tail's expectation
replaces it), and BI2-8's splicing writer (Svelte's writer stays; F-I22 bounds the cost). LH2-7's cost is avoided rather
than paid.

---

**What disappears, and which invariant replaces it.** The slice-record ownership model — `readSliceEntries`, the
per-atom contest (`gatherClaims`, `computeOwnership`, the interval heap), the insertion-time revive, rewrite and
rival-claim repairs, `undoRepairClaims` with `undo-repair.ts`, and the anchor owner facet (`a:-2` + `o`,
`emissionOffset`) — goes because a stream is delimited by boundary items inserted at the end of the gap, so the block
that displays a character is a function of replicated items and undo's copies land in the stream that displayed them.
The mirror — `flushMirror` at 16 op sites, `_projectedTree`, `refreshFromProject`, the three-mode wrapper constructors,
pending adoption, positional segment ids and seven offset mappers — goes because operations read and write only the
document and render cells change only from change reports. The 30-field selection state,
`restoreRelativePosition`, the deferred-write loops in `setAtTextOffset`/`setAtRange`/`setAtBlockRange`,
`ignoreNextSelectionChange` in seven files, the second history restorer and `historySelectionSnapshot.ts` go because
the selection is one value with one commit point, the projector is its only writer and always writes the current value
after admitting any unobserved native move, and history restores `{before, after}` in the issuing view. `beforeInputSnapshot.ts`,
the seven suppression flags and four timers, the second adopter, the "advanced" diff and the nine composition reset
sites go because an occurrence is one attempt with an anchored target and an expectation, and a composition is one
session with one capture group, one ending and a tail. The observer's liveness inference and the placeholder sweep
(`removeStalePlaceholders.ts`) go because the host is a projection of the model: after each flush, a content or strict
container that equals what its cells render is not input whoever wrote it, one that differs is, and attributes have
declared owners. The seven `PreventionError` catch sites and twenty `stopCapturing` calls
go because hooks see a prepared plan before any write and one dispatcher owns the undo policy. Schema staging
(`canApplyDirect`, `applyUpdateStaged`), the two-round settle window, the reserved-bootstrap-id seed, the migration lease
and the presence owner registries go because channels prove their generation and refuse foreign stamps, seeds are
deterministic updates from a content-hashed writer, a migration attempt is a crash-released lock, and a presence entry
has one writer.
