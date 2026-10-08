# Adversarial review: LOC honesty of plan-v1

_Lens: loc-honesty. Target under attack: `plan-v1.md` §5 (deletion ledger), §7 (LOC table), §9.4 (xloc track).
Status: complete (sections 0–8)._

Independence: only the plan, the six reader reports, source, tests and the allowed docs were used
(`cross-browser-confidence.md`, `README.md`, `AGENTS.md`, vendored `UPSTREAM.md`). No excluded document was opened.

## 0. Ground truth measured for this review

All numbers use `scratchpad/xloc.mjs` unless stated. Scratch outputs are in `scratchpad/arch/loc-*`.

| Measure | Value | How |
|---|---:|---|
| `src/lib` non-vendor, working tree (16:3x today) | **29,092** / 118 files | `xloc.mjs src/lib --dirs` (plan used 29,087; events moved 4,519 → 4,524 since) |
| Same, at HEAD `d9b7de0` | 21,162 / 104 files | `git archive HEAD src/lib` → `loc-head/` |
| Same, pre-v14 `d6c4781` | 5,942 / 41 files | `git archive d6c4781` → `loc-prev14/` |
| Vendored engine, working tree | 7,125 | `xloc.mjs --vendor` on `crdt/vendor/yjs/src` |
| Upstream `@y/y@14.0.0-rc.26` (pnpm store) | 6,720 | same counter, `lib0-v14`→`lib0` normalized |
| **Edytor-authored code inside the vendor** | **+405** (185 of it the new `utils/RangeCursor.js`) | diff of the two trees above; HEAD vendor == upstream, so all 405 are uncommitted |
| Multi-line `export type X = {…}` bodies that the counter counts as execution lines | **853** | `arch/typebody-count.mjs` over `src/lib` (plan §7.3 says "~580") |
| Deletion-ledger rows L1–L60, parsed from the plan | 12,458 "now" → 1,271 survivors = **11,187 net** | `arch/ledger-sum.mjs` |

Growth HEAD → working tree is concentrated in the files the plan cuts hardest
(`arch/loc-growth.txt`): `selection.svelte.ts` +1,130, `domTextMutationObserver.ts` +701, `edytor-doc.ts` +644,
`edytor.svelte.ts` +448, `runs.ts` +428, `text/model.ts` +355, `BlockHandleController` +246, `text.svelte.ts` +228,
`selection.utils.ts` +197, `awarenessSelection.ts` +188. `cross-browser-confidence.md` ("Edytor Changes From This
Pass") lists about 50 browser-hardening items that landed in exactly these files. The working implementation is evidence
of requirements; the plan's floors delete most of that growth on the strength of invariants that are, for R10/R8,
not yet provable in any lane (U-2: Android/iOS are not in the lanes).

## 1. Measurement integrity: the ruler moves with the work

### 1.1 The vendor boundary is porous, and the plan is silent about it (major)

- The task defines the metric as `src/lib` minus `src/lib/crdt/vendor`, "vendored Yjs engine = 7125 xloc (out of scope)".
  Upstream `@y/y@14.0.0-rc.26` measures **6,720**. The difference, **+405 xloc**, is Edytor-authored code:
  patches P4 (format-aware search markers), P5 (`readItemPieces` + a new 185-xloc `utils/RangeCursor.js`) and P6
  (side-correct attribution rendering), recorded in `crdt/vendor/yjs/UPSTREAM.md` §"Local patches". HEAD's vendor
  equals upstream, so all 405 lines are part of the same uncommitted wave the plan is cutting.
- There is precedent for relocating Edytor logic across the boundary. P5 states that the Edytor-side range
  interpretation was consolidated into the engine and "the Edytor-side index is deleted". Under this metric that
  move shows up as deletion.
- The plan never mentions P4–P6 (`grep -c 'RangeCursor\|patch' plan-v1.md` finds only unrelated hits). Yet its
  central bet depends on engine-adjacent code:
  - §2.1 puts "one predicate, in the range reader" in charge of skipping boundary items, and today's range
    reader *is* the vendored `RangeCursor`;
  - the boundary-format rule (O4) needs "formats of the first live character", which P5's cursor already folds;
  - F-D16 and U-7 measure wire cost inside the engine's walk.

  The cheapest place to land any of these is another vendor patch, and the metric would book it as zero.
- **Scenario.** At CP10, `doc/streams.ts` meets its 710 budget because the boundary skip and format capture ship
  as a 60-line P7 patch inside `RangeCursor`. §9.1 rule 6 (budget) and the census both stay green.
- **Repair.** Count `diff(vendor, pinned upstream)` as in-scope execution LOC.
  - The baseline becomes 29,092 + 405 = 29,497.
  - Every new or grown vendor patch is charged to the plan module that needs it.
  - The census reports the vendor delta at every exit.

### 1.2 The counter contradicts the metric's own definition, and the plan under-measures the gap (major)

- The task defines execution LOC as excluding "type-only lines". `xloc.mjs` skips `interface` bodies and
  non-exported `type` bodies, but its `import|export type` regex swallows only the *header* of
  `export type X = {`. The body lines are then counted as execution lines.
- Reproduced (`arch/ctest/`): the same four-field type counts **4** written as `export type Foo = {…}` and **0**
  written as `export interface Foo {…}` or as `type Foo = {…}; export type { Foo }`.
- Current `src/lib` holds **853** such lines (`arch/typebody-count.mjs`). The largest holders are `text/model.ts` 70,
  `block.utils.ts` 63, `utils/json.ts` 54, `plugins.ts` 52, `runs.ts` 50 and `placement/model.ts` 49. Plan §7.3
  says "~580 in both columns. Most survive in any design".
- They do not survive "in both columns" by construction. The plan introduces many new shapes (command values, op
  results, the selection value, attempts, sessions, cells, snippet view objects, kind and mark records, handles,
  presence entries). Whether those cost 0 or several hundred xloc depends only on whether an author writes
  `interface` or `export type`. The same style choice applied to retained types can delete up to 853 "execution"
  lines with no behavior change.
- **Scenario.** At CP4 the dispatcher lands 25 % over its budget. Rewriting 12 retained exported types as
  interfaces brings the checkpoint back under rule 6.
- **Repair.** Fix the counter so it matches the definition: treat `export type X = …` bodies as type-only. Then
  restate the baseline (≈ 28,239) and every floor, and freeze the counter's hash for the remaining checkpoints.
  Alternatively, keep the counter and report type-body lines as a separate column that no checkpoint may lower.

### 1.3 Code moved to `src/tests` is booked as architectural removal (minor)

- L10 counts "DocChange fast/slow split + escalation (~110)" as deleted mechanism. Yet F-O7 (CP7) needs "the
  change report vs the `diffSnaps` oracle … identical on every commit", and §5.9 L63 says "today's `diffSnaps`
  stays in tests".
- `diffSnaps` is **81 xloc** of production code today (`crdt/edytor-doc.ts:1201-1300`, measured with
  `xrange.mjs`). L63's "~82" covers only `computeAllRuns`/`mergeRuns`/`blockRecordsOf`, so the 81 are counted
  as architectural deletion.
- The "counting only architectural removal" row of §7.2 (16,500) therefore still includes about 81 lines of
  relocation.
- **Repair.** Book `diffSnaps` under L63 (moved, ≈163 total). Keep the census script and any shadow-comparison
  harness explicitly outside the metric, and say so.

## 2. Ledger arithmetic: a fifth of the reduction has no owner

- Parsing ledger rows L1–L60 (`arch/ledger-sum.mjs`) gives **12,458 → 1,271, net 11,187**. That matches §5.10's
  "≈ 11,200", so the rows are internally consistent.
- The floor is nonetheless 29,087 − 11,187 − 560 (§5.9) − **3,250 ("shrinkage of retained responsibilities")** +
  400 (new) ≈ 14,490. The 3,250 is:
  - **22 % of the claimed 14,607-xloc reduction**;
  - labelled "the least certain part … estimated, not measured" by the plan itself;
  - the only portion with no ledger row, no invariant ("unnecessary while …") and no owner.
- Without it, the floor is ≈ 17,740 (−39 %) and the target with contingency is ≈ 19,190 (**−34 %**).
- **The checkpoint track spends the residual without naming it.** Subtracting each checkpoint's cited ledger rows
  from its §9.4 step gives the following residuals. These are reductions §9.4 expects that no cited ledger row
  accounts for:

  | CP | §9.4 step | Cited ledger rows (net) | Unattributed | Unattributed / cited |
  |---|---:|---:|---:|---:|
  | CP1 | 650 | 540 | 110 | +20 % |
  | CP2 | 1,285 | 1,088 | 197 | +18 % |
  | CP3 | 1,050 | 852 | 198 | +23 % |
  | **CP4** | 1,490 | 886 | **604** | **+68 %** |
  | CP5 | 3,020 | 2,487 | 533 | +21 % |
  | CP6 | 1,960 | 1,460 | 500 | +34 % |
  | CP7 | 540 | 380 | 160 | +42 % |
  | CP8 | 1,240 | 1,008 | 232 | +23 % |
  | CP9 | 1,670 | 1,396 | 274 | +20 % |
  | CP10 | 1,030 | 1,090 | −60 | new boundary code |
  | CP11 | 460 | 352 (L62) | 108 | shims |
  | **Sum** | | | **≈ 2,856** | (= 3,250 shrinkage − ≈ 400 new code) |

- Rule 6 ("more than 30 % above its row's step") detects a missing residual. It cannot recover one, because
  there is no mechanism to redesign: the residual is "shorter bodies, fewer imports and types".
  - At CP4 the unattributed part alone is 68 % of the cited rows. A checkpoint that deletes exactly its ledger
    rows would land 604 above its step, which is 41 % of the step and trips rule 6 on bookkeeping alone.
  - Part of the residual is type-body style (§1.2), which should not count at all.
- **Scenario.** CP4 deletes L37, L38, L42, L47, L51 and L54 completely and passes every §8 row, then measures
  25,004 against the expected 24,400. Rule 6 fires, and the repair order (clarify requirement → owner →
  representation) has nothing to act on.
- **Repair.**
  - Attribute the shrinkage per file, as the readers did, and make each file's floor a checkpoint gate.
  - Or plan with the residual realized at 50 %: floor ≈ 16,115, target ≈ 17,570 (−40 %).
  - Report the headline as "architectural −39 %, plus up to −11 % from per-file trims".

## 3. Contingency is flat, and the scenario table prices only two of the bets

§7.2 prices four things: the R2 fallback (+1,227), the R12 fallback (+800), keeping L62 (+352) and a floor
overshoot. Everything else the plan identifies as uncertain is either priced elsewhere and left out of the
scenarios, or not priced at all.

| Risk (plan's own name) | Where the plan states it | Price in the plan | In §7.2 scenarios? | At-risk ledger (net xloc) |
|---|---|---|---|---:|
| R10: projector without timers; F-S10 is "green today, using timers" | K3, U-2, CP5 limit | **none**: "No timers" is a policy, not a fallback | no | L21 382, L22 442, L23 145, L26 301 ≈ **1,270** |
| R8: one attempt, one composition session on engines not in the lanes (Android/iOS) | U-2, CP6 limit | **none** | no | L28 315, L29 190, L30 240, L31 110, L35 433 ≈ **1,290** |
| D-2 generation compatibility refused | §11.2 | +250 | no | L55 |
| D-3 readiness refused | §11.2 | +100 | no | L56 |
| D-8 placeholder snippet kept | §11.2 | +40 | no | L34 |
| D-16 legacy presence fields kept | §11.2 | +60 | no | L59 |
| K5 deprecated shims | §11.1 | +40 | no | — |
| K7 change report not exact, `diffSnaps` stays | §11.1, CP7 limit | +110 | no | L10 |
| K10 click re-derivation kept | §11.1 | +36 | no | L34/components |

- Contingency is ≈ 10 % per row, and lowest where decisions are pending: transport gets +78 on a 1,440 floor (5 %)
  while D-2, D-3 and D-16 (+410 if refused) fall on transport and its presence neighbour.
- R10 and R8 carry ≈ 2,560 xloc of ledger. That is **more than the R2 and R12 fallbacks combined** (2,027), and
  neither has a priced fallback. The browser evidence says both are exposed. `cross-browser-confidence.md` lists
  about 50 hardening items. More than 20 of them are non-cancelable or missing-`beforeinput` paths, mobile
  composition, and "restore the caret after the async command finishes". Each was added because a
  timer-free/flag-free version failed in a lane. The mobile ones cannot be re-proven, because Android/iOS are
  not in the lanes (U-2).
- **Scenario.** F-S10 passes on desktop Chromium/Firefox/WebKit. The first Android bug report after CP5 needs a
  post-render re-assert for one IME. Rule 5 forbids a timer, and rule 7 escalates after two iterations. The plan
  has no line item for the outcome the maintainer will almost certainly choose: a bounded re-assert for that
  class, costing tens to hundreds of xloc of L22/L26 machinery.
- **Repair.**
  - Add R10 and R8 rows to §7.2 with a partial-return price. I use 30 % of their at-risk machinery, ≈ +380 and
    ≈ +390.
  - Add the priced decision fallbacks as their own scenario (+636).
  - Size contingency by exposure (at-risk ledger × probability) instead of a flat 10 %.

## 4. Per-row skeptical targets

Method: skeptical target = plan floor + (a) + (b) + (c).

- **(a) Evidenced under-budget.** Each item was checked in source and is cited.
- **(b) Unpriced-bet exposure.** R10 and R8 each return 30 % of their at-risk ledger (§3), allocated to the rows
  that hold that machinery:
  - R10: selection 939, root 177, plugins 94, events 60;
  - R8: events 797, root 404, text 87.
- **(c) Per-file trims realized at 75 %.** Where a reader itemized its trims, I use them: crdt core ≈ 470,
  transport ≈ 95, selection ≈ 240. The remaining ≈ 2,445 of the 3,250 residual is allocated by floor share.

The result is an **expected outcome, with no contingency on top**. The plan's target includes its contingency, so
a skeptical expectation above the plan's target means the contingency is already spent before any risk
materializes. The table assumes R2 and R12 both hold; the last column prices each row's own representation bet.

| Row | Plan floor → target | (a) evidenced under-budget | (b) | (c) | **Skeptical (bets hold)** | vs plan target | If the row's bet fails |
|---|---|---|---:|---:|---:|---:|---|
| crdt core | 3,703 → 4,103 | +80: stored nonce `n` + liveness (today incarnation = integrating item id, `attribution/block.ts:180`); `rendersContent`/`defaultChild` adoption with atomic conflict refusal (today roles + `defaultType` only, `document.ts:427-552`); R2 range-read boundary skip if it lands in `RangeCursor` (§1.1) | 0 | +118 | **3,900** | −200 (OK) | R2: +1,227 → ≈ 5,130 |
| crdt transport | 1,440 → 1,518 | +25: `navigator.locks` fallback for Node 22 (U-5; `package.json` engines `>=22`); unload announcement for F-T9 | 0 | +18 | **1,483** | −35 (OK) | D-2 refused +250; L62 transport items kept +119 |
| events | 1,659 → 1,959 | +135: foreign-attribute healing is **297 xloc built for foreign writers** ("Grammarly-class extensions, spellcheck overlays, and browser UI", `domTextMutationObserver.ts:1080-1100`: strict vs tolerant surfaces, owned-attribute restore, style longhands, identity-spoof stripping). R12 discards only *own* records, yet L33 books it at 15. §4.4's observer line names no attribute policy, and its "exact inversion" would fight the tolerant surfaces the source deliberately leaves alone (`:1089-1092`); ≈ 100 survives. Render bracket budget ~30 vs its stated duties: record hand-off, nested-apply queue (F-O8), effect-deferred bracket end, dev assertion (X2), named exemption list (CP9 limit) ≈ 80 | +257 | +142 | **2,193** | **+234** | R12: +800 → ≈ 2,990 |
| selection | 1,794 → 1,994 | +30: the compat getter serves 18 distinct fields over 105 reads (`grep 'selection\.state\.'`). Those include `relativePosition` (`text.svelte.ts:469`, observer `:919`) and the DOM-derived `startNode` (`RichTextPlugin.svelte:131`) and `isVoidEditableElement` (onKeyDown/onCut/onPaste/onCopy/`edytor.svelte.ts:1660`), which `session/` may not compute (§4 prohibitions) | +282 | +60 | **2,166** | **+172** | R10 outright (70 % of its selection machinery returns): +376 → ≈ 2,540 |
| plugins | 1,843 → 1,993 | +155: kind/mark records must carry today's **318 xloc** of per-kind tables (commands 115, HTML tables 97, markdown 38, clipboard export 53, slash icons 15). Compacted that is ≈ 140, against ≈ 70 budgeted (≈ 60 in RichTextPlugin + 10 in code). Overlay handles leave the flow, so every visible handle's position becomes a measured, invalidated view (+40). The reader's own risk list: whitespace +30, clipboard validator +15 | +28 | +157 | **2,183** | **+190** | D-9 refused +560 (unlikely: the HTML plugin is unexported, `plugins/index.ts`) |
| root files | 1,245 → 1,325 | +90: the plan's root floor is 110 below the reader floors for the same files (`edytor.svelte.ts` ~860, `edytor.utils.ts` ~90, `plugins.ts` ~75, `hotkeys.ts` 300, misc ~30 = 1,355). Only "no virtual first block (−20)" explains it. The constructor's compat duties (legacy `doc`/`awareness` path, snippet-override suffix parsing, unwinding on failed adoption, `edytor.svelte.ts:491-672`) all survive | +174 | +106 | **1,615** | **+290** | R8/R10 outright (70 % returns): ≈ +230 → ≈ 1,845 |
| block | 911 → 1,011 | +60: handle-cache pruning for dead ids (ids never reused ⇒ an id-keyed cache only grows). Payload adapters for seven documented hooks the plan never names (O25's generic "hooks" in `select()` covers four of them) (`onBlockAttached`, `onTextAttached`, `onFocus`, `onBlur`, `onSelect`, `onDeselect`, `onDeleteSelectedBlocks`; README "Plugin Operations"). An operation-name adapter for hooks keyed on nested ops (`insertText`, `mergeBlockBackward`, `mergeBlockForward`: 6 sites in 5 bundled plugins), which D-10 stops emitting | 0 | +78 | **1,049** | +38 | identity-comparison shims, reader upper bound +100 |
| text | 510 → 550 | +20: cells gain an invalidation source that is not a change report. F-I11 keeps a deleted atom's segment key alive while a composition pins it and re-merges at session end, so "patched only from change reports" is incomplete | +26 | +44 | **600** | +50 | — |
| collaboration | 387 → 407 | 0. Remote-caret geometry (`remoteSelection.ts` rect/range loop) is booked under `sync/presence` but must live in `surface/overlay`; same size, wrong module | 0 | +6 | **393** | −14 (OK) | D-16 refused +60 |
| components | 299 → 329 | +36: K10 says "keep [the click re-derivation] until a real-browser check…", yet the floor already deletes it | 0 | +26 | **361** | +32 | — |
| hotkeys/ (navigation) | 200 → 230 | 0 | 0 | +17 | **217** | −13 (OK) | — |
| clipboard | 254 → 279 | 0 (the kind data is charged to plugins above) | 0 | +22 | **276** | −3 (OK) | D-4 refused: per-path placements stay |
| utils | 225 → 225 | 0 | 0 | +19 | **244** | +19 (zero contingency) | — |
| history | 10 → 10 | +10: the runtime reader kept ~20 for "re-render if the caret's node detached (C)" | 0 | +1 | **21** | +11 | — |
| dnd | 3 → 3 | 0 | 0 | 0 | **3** | 0 | — |
| **Total** | **14,483 → 15,936** | **+641** | **+767** | **+814** | **≈ 16,705 (−42.6 %)** | **+769** | |

Reading the table:

- **The document and transport rows are honestly budgeted** (crdt core, transport, collaboration, clipboard,
  navigation). Their floors come from line-level reads whose deletions have verified mechanisms (V2, probes
  P1–P8).
- **The view-side rows are not.** Events, selection, root files and plugins exceed their targets by 170–290 each.
  That is exactly where browser behavior and the two unpriced bets concentrate.
- **Consequence for §7.2.** With the plan's own fallback prices applied to this expectation:
  - R12 abandoned: ≈ 17,505 (**−39.8 %**);
  - R2 abandoned: ≈ 17,930 (**−38.4 %**);
  - both: ≈ 18,730 (−35.6 %).

  The plan's claim that the result "stays inside 40–50 % [if] at most one of the two representation bets … is
  abandoned" does not survive. On this evidence, the band holds only if **both** R2 and R12 hold and R10/R8
  return no more than about a third of their machinery.
- **Measured honestly (§1).** Counting the +405 vendor delta in both columns, plus ≈ 60 of expected R2 engine-side
  work, gives ≈ 17,170 / 29,497 (**−41.8 %**) with every bet holding.

## 5. Derived views that need caching or invalidation the plan does not budget

§2.4 lists each derived view with a "Recomputed" column. Five entries understate what keeps the view correct, and
each carries code the floors do not include. The xloc effects are already inside §4's column (a); this section
names the missing invalidation rule itself.

| Derived view (plan) | What the plan says | What actually invalidates it | Missing code | Evidence |
|---|---|---|---:|---|
| Overlay chrome: handles, drop indicator, menus, remote carets (O54, R11) | "one measure per frame, editor-relative coordinates" | Today's handles sit in-flow, so CSS moves them. In the overlay, every visible handle's `left/top` derives from its block's rect, and is invalidated by resize of *any* preceding block, commits that insert or move blocks above, nested-scroll containers (K9 prices only this, +20), readonly toggles, and font/image loads. Measuring every frame needs a visible-set filter at 5k blocks | ≈ 40–60 | `blockHandlesPlugin.ts` already needs a ResizeObserver, a MutationObserver and a rAF batch just to centre handles in-flow (`:69-183`). `RemoteSelections.svelte` refreshes only on awareness `change` and doc `update`, which is why F-T8/G24 fails today |
| Render cells (O41) | "patched **only** from change reports" | Three more sources re-derive cell output with no change report: (1) the composition session, since F-I11 keeps a deleted atom's segment key alive while pinned and re-merges at session end; (2) the selection value (`selected`/`focused` rendered inside the bracket); (3) the placeholder, which depends on a live composition | ≈ 20 | §2.4 rows "Segments" and "Placeholder attribute" themselves depend on `session` |
| Handles "cached by id; no registration" | cache only | Ids are never reused (§2.1), so an id-keyed cache only grows unless pruned from `removed`. A handle for a dead block must answer through `isLive`, never with a stale value | ≈ 15 | §2.1 "ids never reused"; O5 |
| Selection projection, memoized per *(value, version)* | pure function of value + index | Three fields the compat getter must keep are **not** functions of (value, version): `startNode`, `isVoidEditableElement` (DOM focus inside a void's native control) and `relativePosition`. They need a Surface-side part invalidated by focus and `selectionchange` | ≈ 30 | 105 `selection.state.*` reads over 18 fields; readers in `onKeyDown.ts:321`, `onCut.ts:31`, `onPaste.ts:129`, `onCopy.ts:12`, `RichTextPlugin.svelte:131` |
| Change report (K7) | exact by construction; `diffSnaps` fallback +110 | When the fold misses a facet, cells never re-derive (the plan's own K7). The only detector offered is "a dev-mode rebuild assertion", which is production code in dev builds that no row budgets | ≈ 20 | §11.1 K7 |

Checked and **not** a finding: the per-doc index fold with read-your-writes. A cursor over the transaction's
monotone `insertSet`/`deleteSet` id ranges (already walked by `makeExtentIndex`, `runs.ts:516`) is linear. It
replaces today's full re-fold on every mid-transaction read (`syncTransaction`, `runs.ts:1515`), so the budgeted
~40 is plausible.

## 6. Moved-not-deleted items missing from §7.3's list

§7.3 lists eight moves, all correctly counted at their source domain. These are missing:

| Item | Booked as | Actually | xloc |
|---|---|---|---:|
| `diffSnaps` (`edytor-doc.ts:1201-1300`) | L10 architectural deletion | moved to `src/tests` as the F-O7 oracle | 81 |
| Per-kind tables: `richTextCommands.ts` 115, HTML default tables 97 (`elementDefinitions.ts:157-258`), markdown `getShortcut` 38, clipboard per-kind export 53 (`serializeClipboardFragment.ts:69-128`), slash icons 15 | L47 "~420 → 70" mechanism deletion | the facts (labels, keywords, icons, data presets, tags, prefixes, export forms) move into kind/mark records; only switch and `run:` scaffolding is deleted | 318 → ≈ 140 survive (≈ 70 budgeted) |
| Remote-caret geometry (`remoteSelection.ts` rect/range loop) | `sync/presence` 274 | must live in `surface/overlay` (§4: "Surface is the only module that touches the DOM") | same size, wrong module |
| Engine-side range interpretation (P5) | outside the metric | Edytor logic already relocated into the vendor; R2's range-read predicate would follow | 185 today (+ future) |
| Placeholder rendering | L34 "~355 → 5" | the placeholder text is rendered by the library today (`Text.svelte:256-271`). A `data-placeholder` attribute renders nothing unless a `::before` rule ships. Today's styling already sits partly in `src/routes/demo.css:344`, outside the metric, and the floor (Text.svelte 60) has no CSS for it | ≈ 5 (library must ship it) |

## 7. Claims in the LOC table that checked out (no finding)

- **The table is internally consistent.** §4 module sums equal §7.1 targets row by row (doc 4,518; sync 1,840;
  session 3,176; surface 4,046; plugins 2,054). Each "where survivors land" column sums to its row target. The
  ledger rows sum to the stated ≈ 11,200.
- **Moves are counted once, at the source.** Examples: composition 245, DOM point 542, range delete 110, flow 70,
  seam 45, handles 290, cells 85 from root.
- **"The +42 selection growth is more of the machinery being retired" is true.** Diffing
  `scratchpad/rs-snap/selection.svelte.ts` (13:13) against today's file shows the additions are a
  `caretWriteEpoch` + `commitVersion` staleness check inside `scheduleCaretWriteVerification`, plus debug probe
  counters (`__selN`, stack capture for `__EDYTOR_SEL_LOG__`).
- **D-9 is low-risk.** The HTML plugin is not exported (`plugins/index.ts`), and core external HTML goes through
  the `onPaste` hook, so removing the tokenizer changes no shipped surface.
- **The crdt core and transport floors hold** if R2 holds (§4). The fold-with-read-your-writes design is linear
  (§5).
- **No DST/test seams are hidden in production.** The `textClaims`/`textMounted` dumps live in
  `tests/editor-dst/`, not `src/lib`.

## 8. Findings, ranked, with repairs

| # | Sev. | Finding | Repair |
|---|---|---|---|
| 1 | major | **§7.2's robustness claim fails.** On evidence, the view-side rows (events +234, root +290, plugins +190, selection +172) exceed their targets; the expected total is ≈ 16,705 (−42.6 %). Abandoning R12 then gives −39.8 % and abandoning R2 gives −38.4 %, so the band needs **both** bets to hold, not "at most one abandoned" (§4) | Re-state §7.2 with evidence-based per-row expectations. Move contingency from crdt core (currently spare, ≈ 200) to the view rows. Plan the headline at ≈ −42 % |
| 2 | major | **≈ 3,250 xloc (22 % of the reduction) has no ledger row, invariant or owner**, yet §9.4 books it at 100 %. CP4's step is 68 % above its cited rows, so a perfect CP4 trips rule 6 on bookkeeping alone (§2) | Attribute per-file trims with named reasons and gate each checkpoint on per-file measured xloc. Or book the residual at 50 % and report "architectural −39 % plus trims" |
| 3 | major | **R10 and R8 carry ≈ 2,560 xloc of ledger with no priced fallback.** That is more than the R2 and R12 fallbacks combined (2,027). Priced decision fallbacks (+636) are left out of §7.2, and contingency is a flat ≈ 10 % (transport 5 %) (§3) | Add R10 and R8 partial-return rows (≈ +380, ≈ +390) and a decisions-refused row (+636). Size contingency by exposure |
| 4 | major | **The vendor boundary is porous.** +405 xloc of Edytor-authored engine patches (P4–P6, incl. the new `RangeCursor.js`, 185) sit outside the metric. P5 already moved Edytor logic across it, and R2's range-read predicate would naturally land there (§1.1) | Count `diff(vendor, pinned upstream)` in the metric and the census (baseline 29,497). Charge new patches to the module that needs them |
| 5 | major | **The counter counts 853 `export type` body lines** although the definition excludes type-only lines (plan: "~580"). The target's value depends on `interface` vs `export type` style, so rule-6 gates can be met by restyling (§1.2) | Fix the counter, restate baseline (≈ 28,239) and floors, and freeze the counter. Or report type lines separately and forbid lowering them |
| 6 | major | **The events floor treats foreign-writer handling as own-render noise.** 297 xloc of attribute healing exist for extensions, spellcheck and browser UI (strict/tolerant surfaces, spoofed identity attributes). L33 books them at 15, and the observer's module line names no attribute policy. Its "revert by exact inversion" would fight the tolerant surfaces where plugin attach hooks and extensions legitimately write (`domTextMutationObserver.ts:1089-1092`). The render bracket is budgeted ~30 for five stated duties (§4) | Add "foreign attribute policy" to `surface/observer` with ≈ 100 and a DST foreign-extension case. Re-budget the bracket at ≈ 80 |
| 7 | minor | **Per-kind data is moved, not deleted.** 318 xloc of tables become kind/mark records budgeted at ≈ 70; ≈ 140 needed (§4 plugins, §6) | Budget records at ≈ 140 in `plugins/richtext`, and book L47 as "scaffolding deleted, data moved" |
| 8 | minor | **`diffSnaps` (81 xloc) moves to `src/tests` but is booked as architectural deletion (L10)** (§1.3) | Move it to L63 (moved, ≈ 163) |
| 9 | minor | **Derived views with unbudgeted invalidation:** overlay chrome positions, cell re-derivation from session state, handle-cache pruning, DOM-derived compat fields that `session/` may not compute, and K7's dev assertion (§5) | Add each invalidation rule to §2.4 and its xloc to the owning module (≈ 125 total) |
| 10 | minor | **The root floor is 110 below the readers' floors** for the same files, with only −20 explained (§4). The documented hooks the plan never names (7; only four are covered generically by O25) and the `onBeforeOperation` operation-name vocabulary (6 sites in 5 bundled plugins) that D-10 stops emitting are not mapped anywhere | Reconcile the root floor to ≈ 1,335, and add a hook/operation-name adapter line to `session/commands` (≈ 45) |

_Status: complete._
