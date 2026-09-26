# Library and vendor compression — implementation handoff

## Objective

Reduce maintained library and vendored-engine code by removing duplicate decisions, obsolete mechanisms, and unnecessary intermediate representations. Preserve the editor's behavior, public API, wire/storage compatibility, and measured performance. Fewer files or shorter files alone do not satisfy this goal.

This is an implementation plan based on a read-only audit on 2026-09-25. No runtime changes or new test results are implied. Recheck every candidate against the execution tree: other work is active, and earlier deletion/selection defects may already have been repaired.

The governing elegance principle is **fewer independent truths**. For each change, explain:

1. Which necessary behavior remains?
2. Which existing owner has the information, authority, and lifetime to decide it?
3. Which implementation, state, traversal, or interpretation disappears?
4. Which invariant makes that deletion safe?
5. Which independent behavioral witness would disprove the change?

Do not introduce a generic operation framework, selection scheduler, projection language, or collection of wrapper classes to answer these questions. Extend existing owners first. Preserve necessary distinctions even when they require separate algorithms.

## Scope and compatibility

Included: `src/lib`, the vendored engine within it, declarations, packaging measurements, and narrowly necessary validation. Tests, benchmarks, and documentation support the reductions; they are counted separately. This is not a test-suite compression campaign, a rewrite of the CRDT, or another feature program.

Preserve by default:

- Existing package exports, public results and types, error identity and timing, plugin hooks, and command interception.
- Block/inline identities, marks and valued marks, relative anchors, placement/move semantics, nested content, and transaction read-your-writes.
- Default document lifecycle, awareness, local document history shared by its views, paragraph attribution, and lineage behavior. Undo capture follows tracked origins and local transactions, not actor ID; replicas using the same actor still have separate histories. Native v14 attribution remains a supported engine capability.
- Transaction atomicity, update/publication counts, semantic no-op behavior, admission refusals, hydration ordering, and resource ownership.
- Supported persisted documents and network updates, including migration input and pending/out-of-order updates.
- Scoped keystroke work, immutable public snapshots, structural sharing, composition locking, and browser-specific input/recovery guarantees.

Observed production output is evidence, not automatically the intended contract. Do not freeze an acknowledged defect as an expected result to make a refactor pass. Coordinate with active fixes; do not independently rewrite those paths.

## Initial inventory, not an execution baseline

Counts include comments and blank lines. The library category includes its three small hand-maintained declaration files. Tests and generated build output are excluded.

| Perimeter                                         | Files | Physical lines |
| ------------------------------------------------- | ----: | -------------: |
| Library excluding vendor                          |   121 |         41,973 |
| Vendor JavaScript source                          |    33 |         13,679 |
| Vendor declarations, including root `global.d.ts` |    35 |          3,986 |
| Total                                             |   189 |         59,638 |

The generated `vendor/yjs/dts/` subset is 34 files / 3,933 lines; the other 53 declaration lines belong to root `global.d.ts`. Generated declarations are not a second handwritten implementation.

Inventory identity: HEAD `d9b7de09e7110fc7a4c2fb1eec36f8267aede086`; SHA-256 of sorted `src/lib` source paths and bytes, each separated by NUL, `872d584862de897fc902f346fd529ba97a1611f7d2183d50ed88656b1d25730b`; lockfile SHA-256 `65c5921f60c6384f0b04f7cfb6f8cc5c890f5ca141dd85af2f06292444e7d1cc`. The source inventory includes `.ts`, `.tsx`, `.js`, `.mjs`, and `.svelte`. HEAD alone does not describe the dirty tree. Growth since HEAD covers several work streams, not just the latest DST work.

Large review surfaces include `selection.svelte.ts` (~3,369 lines), vendor `ynode.js` (3,140), `edytor-doc.ts` (2,627), `edytor.svelte.ts` (2,213), `text/runs.ts` (1,939), and `domTextMutationObserver.ts` (1,881). These are file sizes, **not savings estimates**. Splitting them without deleting decisions earns no compression credit.

## Execution order

1. **U0:** freeze evidence and contracts.
2. **L1 and V1:** perform the confirmed wrapper/dead-path reductions. These have disjoint owners and can run in parallel.
3. **L2 → L3 → L4:** consolidate facade/model semantics in order; one writer owns `edytor-doc.ts`. L4 proceeds only after its parity gate.
4. **V2:** consolidate marker writing after V1. Coordinate any L3 native-formatting change with the same vendor owner.
5. **L5:** consolidate selection/DOM repair ownership after relevant behavior fixes and witnesses are present.
6. **X1/X2:** bounded investigations into deeper reductions. Implement only when their gates pass; a justified rejection is an acceptable result.
7. **Q0:** qualify one fixed final source and report actual reductions.

Do not assign two agents overlapping production files. Keep each change reviewable before beginning the next change in the same owner. The optional public-surface decision below is not a dependency of the main program.

## U0 — Freeze a truthful baseline

**Outcome:** a reproducible comparison and explicit preservation boundaries.

- Read the current source, working-tree changes, `docs/elegance-review-2026-09-23-remediation.md`, vendor `UPSTREAM.md`, and applicable test contracts. Preserve concurrent edits; isolate work from the agreed current tree if needed. Do not reset to HEAD and discard uncommitted work.
- Record source/config/lockfile identity, tracked and relevant untracked inputs, tool versions, and a compact file/LOC inventory. Separate maintained library, vendor source, declarations, tests, evidence, and package output. Count new shared modules wherever they are placed.
- Inventory public exports and reachable methods, dynamic registration, decoder tables, migrations, and test-only/private uses. A symbol exported from an internal file is not necessarily public; a method reachable through an exported class can be public without a named barrel export.
- Record the existing behavior needed by each chosen unit. Add only missing independent witnesses, in existing suites. Do not require completion of the entire DST hardening program before a bounded refactor.
- Refresh `bench/bundle.js` from a freshly built/packed artifact. Its September 21 `bundle-latest.json` and hardcoded eleven-symbol `used-surface` fixture are stale for this task. Measure an actual default document consumer, a representative Svelte editor consumer, relevant provider combinations, and the full raw-engine entry. Identify modules included in each graph.
- Preserve existing runtime benchmark scenarios for touched paths. Include scoped edits and a fragmented long text; use mount/large-document scenarios only when the candidate affects them. Record variability before defining an acceptable regression threshold.

**Done when:** baseline artifacts identify the exact code tested; every selected unit has named behavioral witnesses; public/wire exclusions are explicit. Report source LOC, package bytes, minified/compressed consumer bytes, allocation/work counters, and latency separately. Never add compressed entry-point sizes together as an application total.

## L1 — One block-owned content-offset mapping; remove dead wrapper paths

**Confidence:** confirmed duplication and dead paths. **Owners:** `block/block.svelte.ts`, `text/text.svelte.ts`, the two private helpers in `crdt/placement/model.ts`.

`Block.partOffsetOf` and `Text.segStart` repeat the same segment-ordinal lookup, mirror-index fallback, and atom-offset sum. The duplicate exists because `Block.projectedParts` still obtains a whole-tree projection, while `Text.segStart` uses scoped `facade.isVisibleBlock` and `facade.contentItems` reads.

1. Make `Block.projectedParts` use the existing scoped facade reads. Preserve its absent/hidden/deleted result and detached/pending-carrier behavior.
2. Let `Text.segStart` derive its answer through `parent.partOffsetOf(this)`. Delete the second mapping implementation. Do not restore a whole-document read on the typing path.
3. Remove `reconcileContent`'s `byItem` map and `byItems` fallback after rechecking the construction invariant: `deriveContentParts` allocates fresh text-item objects, so previous `_items` object identities cannot match. Inline entries in that map are not queried. Preserve pending-wrapper precedence, ordinal reuse, stable inline identity, and adoption/alias behavior.
4. Remove private placement `contentOf` and `appendItems` if still unreferenced and absent from the binding surface. Keep `contentItemsOf`, which is returned by that binding.

**Witnesses:** `src/tests/scoped-text-refresh.test.tsx`, `src/tests/mirror-incremental.test.tsx`, inline adoption tests, `tests/editor-dom/inline-atomic.spec.ts`, and composition identity/remote-lock tests. Exercise the Block mapping directly; retain the zero-`project()` assertion during ordinary scoped edits. Cover text before/after an inline atom, empty separators, stale mirrors within a transaction, pending carriers, hidden blocks, and composition-pinned wrappers.

**Done when:** one mapping rule remains, unreachable reuse machinery is gone, wrapper identities still satisfy their contracts, and scoped work counters do not regress.

## L2 — Share visibility and per-block change semantics

**Confidence:** confirmed duplication. **Owners:** `crdt/placement/model.ts`, `crdt/edytor-doc.ts`.

Two separate reductions belong to existing owners:

- Move the duplicated projected-ancestor visibility predicate from facade `isVisibleBlock` and placement `positionInView` into the placement owner. Both consume it. Preserve ownership-redirected parents, dead/hidden ancestors, placement existence, reachability, and cycle behavior. Keep the boolean query O(depth); calling the full sibling-position query would be a performance regression. Local block visibility and projected-tree reachability remain distinct concepts.
- Give `diffSnaps` and `diffFast` one per-block metadata/content comparison and publication rule: type/data equality, safe metadata cloning, run-reference shortcut, content-key comparison, and payload emission. Keep their different traversals. Structural changes still require the tree path; ordinary content/meta changes remain scoped.

Do not mutate the previous snapshot during fast-path eligibility checking. A late escalation must not observe a partially patched baseline. Retain reference adoption for recomputed-but-equal content, change versions, immutable payloads, and subscriber behavior.

**Witnesses:** scoped refresh/visibility tests, placement reachability/display-cycle tests, `crdt/runs/shared-state.test.ts`, `mirror-incremental.test.tsx`, snapshot-isolation tests, and undo repair publication tests. Include edit-then-revert/no-op transactions, multiple facades, a structural move, and fast-to-full escalation. Expected changes must not be produced by the newly shared comparator itself.

**Done when:** one ancestor rule and one metadata/content diff rule remain; structural and scoped algorithms retain their respective costs and observable publication behavior.

## L3 — Mutation owners report their actual outcome

**Confidence:** confirmed repeated interpretation; highest contract sensitivity among the facade reductions. **Owners:** `crdt/edytor-doc.ts`, `crdt/text/model.ts`, `crdt/placement/model.ts`; vendor formatting only if a native fact is required.

The facade currently reconstructs whether an operation changes content before asking the model to execute it:

- `deleteText` repeats the model's length calculation and range clamping.
- `marksAlready` repeats sanitized-mark interpretation, flattening, clamping, cursor traversal, and comparison before formatting does its own work.
- `setInlineData` resolves and compares an inline in facade runs, then resolves it again in the model.
- Model `removeInline` and `setInlineData` separately implement the same owned-span/atom lookup.

Give the existing mutation owner enough internal result information to distinguish refusal, an accepted semantic no-op, and a change. Preserve existing externally visible method signatures and behavior: `bindModel` and `PlacementModel` are also public exports, so preserving only facade booleans is insufficient. Keep richer verdicts internal and preserve direct model callers' return, update, and no-op contracts. This is not authorization to introduce a new public result API or generic command dispatcher.

Start with deletion and inline data, whose semantic verdict is simpler. Share the placement-owned inline lookup. Then resolve formatting: physical marker writes and `transaction.changed` are **not** reliable substitutes for a semantic-change verdict. Use the native formatting owner's decision if it can expose the required fact without another scan. Otherwise retain the preflight and document why; do not falsely label physical churn as a user edit.

Keep pre-write lineage capture before mutation and commit/stamp only for the correct outcomes, in the same content transaction. A post-write verdict cannot reconstruct the displaced subtree. Preserve nested transactions, payload validation/error timing, multi-span deletion prevalidation, and right-to-left physical deletion. Do not cache a prepared mutation across an interleaving or plugin callback unless its validity is established there.

**Witnesses:** direct `bindModel` contract tests as well as facade tests, paragraph-attribution no-op tests, lineage capture/undo/children-replace tests, runs golden fixtures, inline removal-versus-data concurrency tests, and deletion safety tests. Assert public returns, exact content, identity, marks, update counts, undo entries, lineage entries, and attribution together. Include out-of-bounds ranges, empty marks, repeated same-value writes, inline-only formatting, and nested batches.

**Done when:** each completed operation has one decision owner; its facade preflight scan is deleted; facade semantic no-ops still emit no updates/history/attribution; direct model contracts and displaced-state capture remain correct. Report partial completion honestly if formatting cannot yet meet this gate.

## L4 — One JSON subtree serialization rule

**Confidence:** repeated representation work confirmed; replacement is conditional on parity. **Owner:** `crdt/edytor-doc.ts` and the existing metadata/children read owners.

`toJSON` materializes `M.project`, including content, then exports content again through `runsView.contentJSON`. `subtreeJSON` independently builds the same JSON shape for lineage. The intended reduction is one document-owned subtree serialization rule, used by full document export and pre-write capture, without an unnecessary intermediate content projection.

First pin their real differences. `subtreeJSON` currently reads raw attributes and stringifies type; public export receives normalized projected metadata. Hidden/deleted roots, omission of empty content/children, data defaults, clone boundaries, and snapshot isolation require explicit treatment. Root enumeration and lineage capture eligibility may remain separate policies around a shared emitter.

Reuse authoritative placement and runs readers; do not recreate a third traversal that interprets visibility independently. Keep transaction read-your-writes and export memoization. If preserving the contracts requires a generic projection framework or more duplicate rules, reject this unit.

**Witnesses:** public JSON and malformed-data fixtures, lineage fidelity/isolation, nested hidden/merged blocks, export memoization, and mid-transaction export. Compare against hand-authored shapes, not only two callers of the shared serializer.

**Done when:** duplicate shape assembly and avoidable projected content disappear, or the parity investigation explains precisely why they must remain. Measure export and lineage allocation/work separately.

## L5 — Selection owns repair authority; DOM repair supplies observations

**Confidence:** overlapping decisions confirmed; exact deletion scope must be proven. **Owners:** `selection/selection.svelte.ts`, `events/domTextMutationObserver.ts`, existing DOM-selection/offset helpers and affected render/attach sites.

The observer's immediate and deferred restoration paths repeat decisions about atomic selections, foreign/nested editables, plugin focus, outside gestures, and caret restoration. Selection already owns the logical target and competing writes. Consolidate the shared repair-admission/commit rule there; the observer supplies what it observed before repairing DOM and retains ownership of its mutation queue.

Proceed as three small, sequential changes, retaining only those that delete an independent rule:

1. Inventory actual restoration entry points and their authority/lifetime. Let observer immediate/deferred paths use the same selection-owned repair decision. Keep pre-repair caret observations scoped to the attempt and preserve bounded retries and scroll suppression.
2. Examine repeated managed-node attribute/identity rules between rendering, attach code, and observer healing. Share the declared facts at the existing rendering/attachment owner where they are genuinely identical. Preserve strict owned text/inline leaves versus extensible plugin block/chrome attributes. A spoofed `data-*` marker must never confer ownership; detached old nodes and live new nodes are different observations.
3. Reuse existing offset traversal only where the coordinate contract matches. `events/domTextOffset.ts` counts raw text; selection offsets filter synthetic editor content. Observer `getTextOffsetInside` must not be replaced on syntactic similarity alone. Likewise, reuse prepared input intent where several consumers interpret the same input family; do not merge browser-native reconciliation with command execution just to remove branches.

**Do not collapse all selection guards into one epoch.** History restoration, a superseded block-range request, Android post-delete echoes, Gecko re-anchor verification, and IME composition have different causes and expiration rules. Share a common fact only when the consumers require the same validity window. Existing `domSelection` and `runHistoryCommand` already own shared behavior; extend them rather than creating parallel owners.

**Witnesses:** selection ownership/write-deduplication, remote-selection preservation, DOM mutation repair, reversed history ranges, plugin chrome/foreign-editor focus, composition, and mobile-input suites. Include a remote delete during pending local restoration and continuation typing at the recovered **block identity**, not merely an in-bounds offset. Use native `Selection.setBaseAndExtent` for backward logical ranges in jsdom; a test helper that collapses them is not an environment limitation. Real Chromium/Firefox/WebKit cover layout, native target ranges, and browser echoes.

**Done when:** duplicated authority decisions or declared DOM rules actually disappear; stale writes still lose; repairing DOM cannot steal focus or revive an obsolete selection; no browser-specific behavior was dropped on the strength of jsdom alone. A cohesive large file is acceptable if no further independent rule can be removed safely.

## V1 — Remove obsolete, non-public vendor implementations

**Confidence:** concrete deletion inventory verified. **Owners:** vendor `src/ynode.js`, `utils/EventHandler.js`, `utils/StructStore.js`, declarations, and patch provenance.

Recheck the reference/export graph, then remove:

- `typeListInsertGenericsAfter`, `typeListInsertGenerics`, `typeListPushGenerics`, `typeListDelete`, and private `lengthExceeded`: **189 physical source lines** at audit time. Their references are internal to this obsolete cluster; public `Node.insert/push/unshift/delete` already use `applyDelta`.
- `removeAllEventHandlerListeners`: 11 source lines; no callers or public export found.
- `integrityCheck`: 17 source lines; no callers or public export found. Preserve live integrity witnesses in the test suites.

This identifies **217 source lines**, plus approximately 10 generated declaration lines, before any import/separator cleanup. It is a bounded inventory, not a target to inflate. An internal-file export is removable here because it is absent from the published entry, has no reachable callers, and package exports reject vendor deep imports. Revalidate all three facts before deletion.

Record the change as a reproducible vendor patch under the existing provenance process. Regenerate declarations with `scripts/regen-crdt-vendor-types.sh`; do not hand-prune them. Inspect generation diagnostics: emitted files alone do not prove successful type generation, and only the documented upstream TS2589 is an accepted existing diagnostic.

**Witnesses:** upstream node operations, local engine/encoding/update tests, unchanged public export/type census, and packed Node/Svelte consumers. Preserve license and upstream attribution.

**Done when:** the obsolete mutation authority and unused private helpers are gone, generated types match, and patch provenance can reproduce the result. Expect possibly zero minified bundle savings: tree shaking may already remove these functions.

## V2 — One marker-writing implementation

**Confidence:** confirmed small duplication. **Owner:** vendor `ynode.js`; `RangeCursor.js` only for a separately proven shared rule.

`plantMarker` and `plantSearchMarker` independently perform same-index deduplication, marker replacement, and copied-format snapshot storage. Keep mutation-specific tail anchoring in `plantMarker`, then call the existing `plantSearchMarker`. Remove the duplicate record-writing block.

A further candidate is sharing marker candidate normalization/linkage validation between `RangeCursor.seek` and `applyDelta`. Do not merge their final eligibility rules: a write must start at the first physical item at an index; a read may resume later within a same-index run. Preserve null-renderer restrictions, quiescent format snapshots, bounded backtracking, and stale-anchor rejection.

**Witnesses:** `marker-seed.test.ts`, `range-cursor.test.ts`, P4 format hardening, read-purity assertions, and fragmented-text performance/work counters. Replay existing marked insert/delete/undo streams against the existing unseeded reference where applicable. Read traversal must not create updates, splits, or undo entries.

**Done when:** one marker-record writer remains, necessary read/write distinctions remain explicit, and neither correctness nor bounded traversal regresses. P5 already shares full/range item-piece traversal through `readItemPieces`; do not plan that completed consolidation again.

## X1 — Investigate duplicated update dependency interpretation

**Confidence:** duplicate interpretation confirmed; net reduction unproven. **Owners:** `crdt/protocols/sync.ts`, `crdt/structs.ts`, vendor `utils/encoding.js`.

`canApplyDirect` reconstructs clock lookup and parent/origin-chain meaning to establish whether an update can affect schema admission. Native `encoding.js:getMissing` also resolves those relationships, but mutates/splits structs while integrating. Calling it as a preflight is unsafe.

First reuse the existing `structAt` owner for genuinely equivalent lookup. Then investigate a small pure native relationship-inspection rule that both integration and admission can consume. Keep application schema policy in the protocol owner. Moving the copied interpretation into vendor without making the native integration path share it is not compression.

**Preserve:** unknown/pending state routes to staging; GC and Skip semantics; parentless metadata overwrites; delete-only schema changes; corrupt-input error timing; refused updates leave the live document, persistence, and broadcasts untouched. Ordinary admission remains proportional to the update rather than the full document.

**Witnesses:** schema-boundary/admission tests with reordered dependencies, metadata deletion/undo, pending structs/delete sets, malformed updates, and provider persistence/broadcast assertions. A pure inspector must leave the document untouched.

**Stop rule:** if the shared rule cannot express native semantics without speculative guards or a second decoder, retain the current implementation and record the reason. The 116-line preflight contains necessary policy; it is not a 116-line deletion promise.

## X2 — Investigate run/mark representation duplication

**Confidence:** similar operations found; equivalence unproven. **Owners:** `crdt/text/runs.ts`, `text/deltas.ts`, relevant detached/render consumers.

`mergeRuns`, `computeFresh`, `runsToDeltas`, and `mergeRenderDeltas` all join adjacent marked text, but at different boundaries: interned immutable document runs, raw slices, detached buffers, and composition-render deltas. Their equality rules and identity guarantees differ.

Build a short equivalence table before editing: coordinate units, normalization/equality, inline segmentation, render IDs, current-transaction reads, and composition locking. Share a merge rule only where those contracts agree; retain physical traversals where they differ. Do not replace all raw `contentItems` with merged runs: segmentation and transaction freshness are intentional behavior.

**Witnesses:** valued-mark and inline golden fixtures, readonly/suggestion rendering where affected, composition-lock tests, raw-slice public contracts, and run-cache invalidation benchmarks. Check equal values with distinct references and nested mark data.

**Stop rule:** no additional conversion layer or universal run object unless it demonstrably eliminates more independent interpretation than it adds. Report a rejected consolidation as preserved necessary distinctions, not an unfinished mandatory task.

## Optional decision — A narrower published raw engine

This program preserves the current `edytor/crdt` API. The published entry exports snapshot/diff renderers, position helpers, update conversion/obfuscation, metadata and attribution APIs, logging, and low-level types. No internal call site is not proof that these are unused by consumers.

If a materially smaller source perimeter requires removing these features, prepare a separate decision with the exact symbols/methods removed, measured reachable-code savings, consumer impact, migration/versioning policy, and compatibility fixtures. Do not silently execute it under this handoff. Adding another entry point only earns credit if an actual consumer graph improves; it does not by itself remove maintained source.

Keep these boundaries even in that proposal:

- v14 already uses a unified `YNode`; there are no independent legacy Map/Array/Text/Fragment implementations to casually strip out.
- Content decoder tags and legacy type handling serve existing encoded documents and v13 migration. A path that never writes a content kind may still have to decode it.
- V2 codecs support pending structs/delete sets and conversions even when a provider sends V1 updates.
- Paragraph-level attribution does not make native ID maps, renderers, undo retention, or bounded reads universally dead.
- `EdytorDocument`, stable `DocBlock` handles, and editor wrappers own different lifetimes. Their existence alone is not duplication. Awareness registries also have a tested sibling-publish cleanup contract for destroyed editors; replacing them with explicit teardown alone changes behavior.
- Shared claims, schema constants, room protocol validation, undo dispatch, and physical item traversal were already consolidated in earlier work. Verify remaining duplication before touching them again.

## Q0 — Qualification and completion

For each completed unit, record its actual baseline/candidate identity, removed decision(s), net maintained LOC including added shared code, declaration changes, witnesses run, and relevant performance results. Report any retained branch by the distinction it owns. Do not delete explanatory invariants, behavioral tests, or historical evidence merely to improve the count.

For L3, L5, and any X1 implementation, obtain a bounded adversarial review of the actual diff and witnesses. The reviewer should try to falsify no-op/lineage timing, stale selection authority, and side-effect-free admission respectively. A cleaner shared function can still centralize the wrong rule; agreement between its callers is not independent proof.

Use the narrow existing lane while working. On the final fixed tree, run applicable checks once:

- Type/lint checks and unit/DOM/CRDT suites for the touched surfaces; include test typechecks when witnesses changed.
- Packed-consumer validation and vendor declaration/export checks after vendor or package changes.
- Browser selection/input/repair/composition witnesses on Chromium, Firefox, and WebKit when those paths changed. Report unsupported or unrun cases explicitly.
- Bounded solo/collaboration DST as complementary evidence, with source-stamped artifacts. Require independent exact semantic witnesses for the changed rule; convergence and green test totals alone are insufficient.
- Fresh package/bundle measurements and the targeted baseline benchmarks, using the same fixtures and measurement method. Do not claim source deletion improved latency without data.

Existing commands include `pnpm check`, `pnpm lint`, `pnpm test -- --run`, `pnpm test:dom`, `pnpm test:typecheck`, `pnpm test:dom:typecheck`, `pnpm test:crdt`, `pnpm test:dst:solo`, `pnpm test:dst:collab`, and `pnpm package`; use current configurations and packed-consumer instructions to select the applicable runs. Do not launch a large qualification run against a tree still being edited.

Completion requires a net reduction in both the maintained library and vendor source for the completed program, fewer independent authorities for the selected rules, preserved contracts, and no material measured regression in affected paths. Generated declarations and package improvements are additional, separate results. There is no arbitrary percentage target: if deeper reductions require a behavior/API change or more machinery, stop at the coherent reduction and state the boundary.

Produce one concise execution report with **Outcome**, **Validation**, and **Risks**, plus a before/after table for library LOC, vendor source LOC, declarations, package/consumer bytes, and relevant work/latency measurements. Link evidence. Update applicable project documentation and vendor provenance to describe the resulting ownership; do not leave old and new instructions competing. Do not create a parallel permanent reduction framework or duplicate the full repository guide in the report.
