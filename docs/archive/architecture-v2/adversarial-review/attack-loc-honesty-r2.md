# Adversarial review, revision 2: LOC honesty

_Lens: loc-honesty-r2. Target: the revision-2 delta, i.e. `plan-final-r1.md` compared with
`docs/archive/architecture-v2/plan.md` (§0, §1.1, R1/R10/R12, L8, O50–O67, §4.4 and its re-budget table, L33/L39/L65, D30/D58,
§5.10, §7.1–7.4, F-O2/F-O5/F-O8/F-O10/F-O13, §9.1 rules 3/5/8, R6/R7, §9.4, K2/K5/K13, D-24, U-1/U-8, §11.5, §12.5).
The maintainer decisions (Option B, Svelte's flush order as the timing hook, the owned fork) are taken as given. This
review attacks only how the plan implements and prices them._

## Measured for this review

| Measure | Value | How |
|---|---:|---|
| `src/lib` now | 29,109 | `node scratchpad/xloc.mjs src/lib --dirs` |
| `src/lib/crdt/protocols` | 508 (awareness 242, sync 215, envelope 32, auth 19) | `xloc.mjs src/lib/crdt/protocols --files` |
| Upstream `@y/protocols@1.0.6-rc.1` (installed devDependency) | 255 (awareness 195, sync 47, auth 13) | `xloc.mjs node_modules/@y/protocols/src --files` |
| Import lines route (ii) must rewrite | 13 (10 `lib0/*`, 3 `@y/y`) | `grep import node_modules/@y/protocols/src/*.js` |
| Edytor fixes in the ports that upstream lacks | 3 | `awareness.ts:77,124-127` (idempotent `destroy`), `awareness.ts:116` (interval `unref`), `auth.ts:32,37` (subtype returned so skew is reported); upstream `awareness.js:89-94` has no guard or `unref`, `auth.js` returns nothing |
| Svelte text writer | writes whenever the value differs from its own cache `__t` | `svelte/src/internal/client/render.js:46-55` |
| Attachment bodies | `effect(() => fn(node))` on an **element** | `svelte/src/internal/client/dom/elements/attachments.js` |
| Nested `transact` inside `beforeTransaction` | joins the outer transaction and its origin | vendored `utils/Transaction.js:417-427` (`beforeTransaction` emitted after `doc._transaction` is set) |
| Provider echo suppression | updates whose origin is the provider are neither broadcast nor persisted | `providers/room.ts:312`, `websocket.ts:479`, `indexeddb.ts:507-535`; remote applies use the provider as origin (`room.ts:232-236`) |

## Findings (most severe first)

### 1. G-c's route (ii) is a relocation into the excluded directory, not a cut (major)

- D-24 proposes G-c "by route (ii)" (vendor the three upstream files beside the fork) and books ≈240. That is the
  cut that lifts the confident number over the line (§7.3: "D-24's proposed cuts close it (−40.2 %)").
- The ports are upstream code already (§4.2 calls `sync/awareness.ts` a "verbatim port"). Route (ii) moves ≈255
  upstream lines under `vendor/`, which the counter skips by path. The ported text leaves `src/lib`, but the repo and
  the shipped package keep the same code plus an adapter: 255 + ≈53 = ≈308 lines, against the 280 the target budgets
  for the ports. Maintained code grows by ≈+28 while the headline falls by ≈227. §7.4 says "no budget can be met by
  moving Edytor code across the boundary", and revision 2 amended rule 8 to exempt exactly this move.
- The adapter is under-listed. §7.3 names "applyRemote with the inbound admission, the remote origin, the coverage test,
  re-exports" (≈40). It also needs:
  - the gated dispatch, because upstream `readSyncMessage` applies directly (`sync.js`, `readSyncStep2`);
  - the three Edytor fixes upstream lacks: idempotent `destroy()` for the owned-doc plus owned-awareness double destroy,
    the interval `unref()`, and `readAuthMessage` returning the subtype.

  The adapter is ≈53, so the metric saving is ≈227.
- "The import rewrite adds ≈3 lines of delta" is wrong on both measures. Thirteen import lines are rewritten (10
  `lib0/`→`lib0-v14/` as in P1/P3, 3 `@y/y`), and a rewrite adds 0 xloc.
- **Repair.** Report route (ii) as "≈227 relocated into the vendor total" and keep it out of the gap-closing sum. On
  the plan's own confident number, G-a + G-e plus the ≈15 codec lines that really disappear gives 17,629 (−39.4 %).
  Only route (i) (publish the fork, depend on `@y/protocols`) removes the code from the repo, and it costs U-8. Budget the adapter at ≈53, with
  the fixes as a subclass or wrapper, and correct the delta sentence.

### 2. Skeptical recount: the confident number is −38.0 %, and D-24's cuts reach the 40 % line only by counting the relocation (major)

This finding aggregates findings 1 and 4–8, with the plan's other numbers unchanged.

| Item (revision-2 delta only) | Plan | Skeptical | Where |
|---|---:|---:|---|
| Structural-variant protection for divergent nodes (finding 4) | 0 | +15..25 | observer / pin |
| Per-cell base, retained `removedNodes`, a records signal, hand-back re-dirty (finding 6) | 0 | +15..25 | observer |
| Element-hosted run writer, domPoint normalisation, no-attempt rebase (finding 7) | 0 | +10..20 | components / domPoint / observer |
| Projector admission moved out of `beforeTransaction` (finding 5) | 0 | +10..15 | projector |
| Target total | 17,060 (−41.4 %) | **17,125 (−41.1 %)** | +65 (range +50..+85) |
| Confident (+65; the hand-back booked twice, finding 9, −10) | 17,974 (−38.2 %) | **18,029 (−38.0 %)** | |
| Confident + G-a + G-c + G-e, with G-c at ≈227 (relocation counted) | 17,404 (−40.2 %) | 17,472 (**−39.96 %**, 13 above the 40 % line at 17,459) | |
| Same, with G-c at its real removal (≈15) | — | 17,684 (−39.2 %) | |
| Target with R7's recorded fallback (+800) | not shown | 17,925 (−38.4 %) | see finding 3 |

- Against revision 1, Option B moves the target by about **+35**, not −30.
- Its confident gain is about **−75**, not −130. All of that gain comes from halving the allowance (+200 → +100); none
  of it comes from code.
- **Repair.** Restate §7.3's honest statement: target ≈−41 %, confident ≈−38.0 %. D-24's cuts reach 40 % only if the
  relocation is counted, and even then they fall 13 xloc short.

### 3. §7.3 drops the priced fallback that R7 still records (major)

- Revision 2 deleted "Target, R12 abandoned (+800)" and "R2 and R12 abandoned". LH-1 (r2) explains that only R2's
  abandonment is still priced, because compare-to-truth rests on no whole-program property.
- Yet R7's limit column keeps "the last-resort fallback is today's liveness classification (+800)". K2 still lists
  three open exposures, and finding 4 adds a fourth.
- K2's fallback column also lost the +800 that revision 1 had. The table now prices one bet where the plan carries two
  fallbacks.
- **Repair.**
  - Restore "Target, R7 fallback (liveness classification, +800)" at 17,860 (−38.6 %).
  - Restore "R2 and R7 fallbacks" at 19,087 (−34.4 %).
  - Put +800 back in K2's fallback column.
  - Reword LH-1's r2 note.

### 4. The write guard covers text writes only; structural re-renders still destroy browser input (major)

- K2 exposure (1) is a model change landing in the same task as a native edit (an in-process provider, an extension's
  `input` listener). The plan says it is closed by "the writer's guard keeps the node" (D58, F-O13 (b)).
- The guard only stops text overwrites. The same synchronous change can instead restructure the node's cell, for
  example:
  - a remote format of the run holding an autocorrected word;
  - a mark nesting change;
  - a block retype.
- Today's render replaces that run's DOM: the run key is `index:marks` (`Text.svelte:32,236`), with the
  `{#if delta.marks.length}` and `{#if definition?.snippet}` switches (`Text.svelte:237`, `Mark.svelte:28`).
- The divergent node is removed, its attachment unregisters it, and the compare pass then ignores its record. The
  user's edit is lost.
- F-O13 exercises only a remote *insert*.
- Protecting the node brings back revision 1's "hand pending records before apply" duty under another name, and it is
  unbudgeted.
- **Repair**, one of:
  - (a) A pre-render divergence check in the root `$effect.pre` (decision 2 already allows it). It compares the
    registered nodes of the cells patched in this batch with their last-written text and adopts before the writes.
    This also makes the text-write guard unnecessary, so it is probably LOC-neutral or better.
  - (b) Freeze-until-adopted for a cell with a divergent node, reusing the pin (+15..25).

  In either case, add F-O13 (d): a remote format and a retype of the block holding the autocorrected word, applied
  synchronously in the `input` task.

### 5. The DOM-selection read moved into `beforeTransaction` re-creates the nested-apply problem (major)

- R10/O52 now read the live DOM selection "before the first transaction after a settled render (the document's
  `beforeTransaction`)" and admit an unobserved move. Admission means `select()`, which runs hooks.
- The engine emits `beforeTransaction` after setting `doc._transaction` (`Transaction.js:417-427`). A hook that
  dispatches a command therefore writes into the outer transaction with its origin:
  - in a remote apply, the origin is the provider, so the write is echo-suppressed (`room.ts:312`, `websocket.ts:479`)
    and never reaches peers;
  - in IndexedDB hydration, it is never persisted;
  - in a bare undo, it lands in the undo's own transaction and is captured in the redo item, which is the class of
    write F4/D-23 exclude.
- During the compare pass's own adoptions the render is "settled" but the DOM is ahead of the model, so the read maps
  a caret that is not yet in the model.
- The bundled hooks (toolbar, slash menu) only read today. Consumer `onSelectionChange` hooks may write.
- §7.1 books the move at zero ("the projector keeps its duties").
- **Repair.**
  - In `beforeTransaction`, only mint anchors from the DOM selection, and skip that when the dirty set names its
    nodes.
  - Admit through `select()` after the commit.
  - Budget +10..15 in `surface/projector`.
  - Add F-S11 rows with an `onSelectionChange` hook that dispatches a command during a remote apply and during an undo.

### 6. The compare pass needs per-cell and records bookkeeping the registry does not list (minor)

- **Per-cell base text.** Adoption is per cell: autocorrect can span a mark edge, and a Backspace can empty a run and
  remove its node. The registry is per node ("text node ↔ segment and the text last written"). Rebuilding a cell's
  base needs the nodes the browser already detached. Records name those in `removedNodes`, which a node-only dirty set
  does not keep. The fix is a per-cell ordered node list or rendered-text snapshot, plus retaining `removedNodes`.
- **Records signal.** The root `$effect` depends on the render epoch (O55), but pure browser input produces records
  and no render. If the MutationObserver callback bumps the render epoch, the classifier reads the native caret move
  after typing as render-caused drift. So a second reactive signal is required; it is in neither O55 nor L8.
- **Hand-back.** The hand-back must re-dirty the host node so the next pass compares it.
- **Repair.** Add these three to L8 and the re-budget table (+15..25).

### 7. Guarding the writer changes the host's DOM shape (minor)

- Svelte's `set_text` cannot skip a node the browser edited (`render.js:46-55`), and attachments need an element.
  Guarding therefore means replacing every `{delta.text}` (`Text.svelte:244`, and `Mark.svelte:24` inside extension
  mark snippets) with an element-hosted writer: one extra inline element per run.
- `surface/domPoint` (565) must normalise these elements, including the edge side of inclusive marks that R4/FP-8
  read. The components (335) and domPoint budgets did not move, and "(lines booked with the observer)" does not cover
  domPoint.
- Base-relative adoption without an attempt (browser input with no `beforeinput`) also needs a three-way rebase:
  last-written text → DOM, mapped through last-written text → current cell.
- **Repair.** Book +10..20 and add a domPoint row for run elements. Option (a) of finding 4 avoids most of this cost.

### 8. `surface.update`'s call-site discipline survives, and K2 understates it (minor)

- R6 lists the same writers revision 1 bracketed as the ones that must bump the epoch: cells, `select()`, readonly,
  composition phases, suggestions and extension view state. K5 still obliges third-party extensions to bump it.
- K2 says "needs no whole-program discipline" and that a missed bump "misclassifies a `selectionchange`, never a DOM
  change". A missed bump has two further effects:
  - it skips the root `$effect.pre` focus note, so the focus-orphan verdict reads a stale element;
  - it skips the post-flush display for that flush, which is BI-14's class.

  For example, an extension collapses the block holding the caret without bumping the epoch, and the caret is lost.
- **Repair.** Restate K2 and add an F-P17 (d) variant that asserts the caret is kept.

### 9. The confident residual books the hand-back twice and R6's cap spends all of it (minor)

- The composition hand-back is already in the target: in the compare pass (+60) and in `surface/pin.ts`. §7.2 and K2
  put it into the confident +100 again.
- R6 caps the tolerance list alone at "≤ +100, the confident allowance", while the same +100 must also hold the
  equal-drop.
- **Repair.** Drop the hand-back from the residual and cap the tolerance list at the remainder (≈+85).
