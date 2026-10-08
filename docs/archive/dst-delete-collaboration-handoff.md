# DST hardening handoff: controlled editor simulation and browser verification

Prepared against the working tree inspected on 2026-09-24. This is an implementation plan, not a claim that its new tests already exist or pass. Recheck the current tree before editing: other work is active, and earlier review findings may already be fixed.

This revision replaces the earlier browser-centered plan. It retains its deletion, selection, transport and oracle requirements, and adds two prerequisite units: U2 for executing production editor commands in the headless harness, and U3 for controlling execution. Earlier U2–U10 are now U4–U12. The primary collaboration exploration runs headlessly; browser programs qualify the real input, selection, rendering and provider boundaries.

## Goal and completion standard

Establish repeatable evidence that supported deletion actions produce the intended document, preserve unrelated content and identity, and leave every affected collaborator able to continue editing at the correct position. Agreement between replicas is necessary but insufficient: all replicas can agree on a corrupted result. Finite randomized simulation does not prove correctness for every possible execution.

Extend the existing headless replica harness and Playwright/Vitest infrastructure. Run the actual production command/model code, introduce control only at necessary environment boundaries, and keep the current wire-update reference document as a delivery oracle. Add independent semantic expectations and selection expectations. Do not build another editor, CRDT, browser emulator or generic testing framework.

Done means:

- The headless editor-command lane controls all nondeterminism that affects its declared scope. With pinned source/runtime/configuration, the same seed reproduces the same scheduled execution, semantic checkpoints and failure fingerprint in fresh processes. The browser lane claims reproducible programs and recorded execution evidence, not exact browser-internal scheduling.
- The command bridge demonstrably executes the real deletion and recovery paths. CRDT primitive coverage is not counted as coverage of editor selection/command semantics. Browser-only behavior is explicitly assigned to browser tests.
- Every required deletion family has an explicit contract and exact expected-result tests, including both directions and reversed selections where meaningful.
- Generated tests report which result contracts, structural shapes, delivery schedules, and peer roles actually executed. An action name or nonempty encoded packet does not count as proof of a mutation.
- Collaboration tests inspect the affected non-acting peers before any harness selection reset, then verify a real follow-up input at the recovered caret.
- Controlled concurrent programs have independently specified outcomes or explicitly bounded allowed outcomes. The wire reference is never described as a semantic reference model.
- Injected defects demonstrate that the new assertions fail for the intended reason. Failures preserve evidence and replay the same defect after reduction.
- Required headless and browser lanes, focused model/DOM tests, and type checks pass; uncontrolled boundaries, unsupported native input paths and unresolved product decisions are listed explicitly.

## Testing architecture and limits

Keep three responsibilities separate:

| Responsibility            | Requirement                                                                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workload generation       | Create meaningful documents, selections, edit programs and competing user intent. Bias toward structural boundaries and conflicts; report realized coverage rather than random draws.              |
| Simulation and scheduling | Choose when each legal command, update, timer and modeled persistence event occurs. Record these choices and reproduce them without wall-clock sleeps.                                             |
| Correctness oracles       | Judge intent, semantic results, conservation, selection recovery, delivery and bounded progress. They do not generate entropy, and replica agreement is not an independent semantic specification. |

Use two execution layers with shared declarative contracts and fixtures:

| Layer                                 | Runs                                                                                                            | Controls and limits                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headless deterministic simulation     | Real CRDT/facade code plus the actual editor command and logical selection/recovery paths made reachable in U2. | Existing explicit peer queues, deterministic identities/randomness, and U3's required time/storage/async boundaries. Main lane for many schedules and bounded exploration. No claims about native input, line wrapping, browser focus or painted carets.                                                               |
| Browser integration and generated E2E | Real input dispatch, DOM/model mapping, native selection, composition, rendering, providers and persistence.    | Seeded programs and explicit causal barriers, with real browser/runtime timing recorded. Covers every required browser-only contract and representative collaborative programs, plus important core regressions that can be expressed through browser input. It does not replay every internal core event identically. |

Exact golden examples establish what each rule means; guided generation varies those examples; wider stateful exploration combines them. Retain existing CRDT primitive tests as a lower-level lane. A shared fixture/schema is useful, but a universal runner or duplicate semantic implementation is not required.

The key gap is the bridge between CRDT primitives and editor command semantics. A facade `deleteText` test cannot establish the behavior of Backspace across nested blocks, and a model caret test cannot establish native DOM restoration. Conversely, browser overhead should not constrain how many collaborative command schedules can be explored.

Determinism is a scoped execution guarantee, not universal correctness. Report exactly which sources of nondeterminism are controlled and which remain external. Small exhaustive schedules may establish coverage within their declared bounds; neither those bounds nor random seed counts establish behavior outside the modeled environment. Independent expected results and fault-sensitive assertions remain necessary at every scale.

Method references: [FoundationDB simulation](https://apple.github.io/foundationdb/testing.html) and [TigerBeetle VOPR](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/internals/vopr.md). Their useful pattern here is production code under a controlled environment, reproducible schedules and correctness checks. They are not a reason to emulate a whole browser or storage engine.

## What exists, and what is still missing

The repository is not devoid of delete-result or remote-selection coverage. Reuse these assets:

| Existing owner                                                                | Evidence and limitation                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tests/crdt/harness/{peer-set,rng}.ts`                                    | Real independent replicas, explicit directed update queues, delivery/partition/reload controls and deterministic identity/rank randomness. Extend this owner; audit its exact determinism boundary before making broader claims. |
| `src/tests/crdt/harness/ops/{crdt-ops,doc-ops,model-ops}.ts`                  | Existing primitive-operation adapters, public facade execution and atom/intent inspection. The facade adapter is not a browser selection/command adapter, and shared production reads do not make its oracle independent.        |
| `src/tests/crdt/random/{generator,runner,shrink,corpus.test}.ts`              | Generated headless programs, reduction, structural/identity checks, atom-fate and per-operation intent checks. Preserve these stronger checks while adding editor-command contracts.                                             |
| `tests/editor-dst/{generator,runner,browserState}.ts`                         | Generated single-document browser input, DOM/model invariants, action-effect checks, and cross-engine comparison. Most delete checks require a change, without independently calculating the correct tree.                       |
| `tests/editor-dst/{collab-generator,collab-runner,editor-collab-dst.spec}.ts` | Independent browser contexts, real providers, transport faults, update capture and a Node reference document. Replaying a wrong source update reproduces its error faithfully.                                                   |
| `tests/editor-dom/advanced-delete.spec.ts`                                    | Exact text/caret expectations for several beforeinput types, target-range fallback, and real grapheme deletion. Many routing cases are synthetic; they do not establish native shortcut semantics.                               |
| `src/tests/fixtures/dom/remote-selection-preservation.test.tsx`               | Targeted insert/delete/merge caret and range preservation. These are useful contract evidence, but not generated multi-browser collaboration coverage.                                                                           |
| `tests/editor-dom/composition-remote-lock.spec.ts`                            | Remote edits during composition. Extend the relevant scenarios to deletion of the composing range/block rather than replacing this suite.                                                                                        |
| `src/lib/events/beforeInputDeleteCommands.ts`                                 | Input-type routing and boundary behavior. Word, soft-line and hard-line intent must remain distinguishable in tests.                                                                                                             |
| `src/lib/edytor.utils.ts`                                                     | Cross-block selection deletion, including partial-tail preservation and nested subtree relocation. “The head always survives” is not a valid universal description.                                                              |
| `src/lib/selection/selection.svelte.ts`                                       | Relative anchors, dead-endpoint recovery, seam fallback, focus-sensitive DOM restoration.                                                                                                                                        |
| `src/lib/collaboration/{awarenessSelection,remoteSelection}.ts`               | Publication and display of another user's selection; separate from that user's own local selection repair.                                                                                                                       |

Concrete current gaps to recheck in U0:

1. `runner.ts` calls an action `wordDelete` but maps backward deletion on macOS to `Meta+Backspace`, with a comment explicitly identifying line deletion. Collab generation emits only backward `wordDelete`. Separate these intents before interpreting coverage numbers.
2. Collab snapshots used for convergence contain durable document state, not all peers' local selection/DOM expectations. These states must be asserted separately; different users should not have identical selections.
3. A state-vector-only partition check cannot detect every deletion: insertion clocks can remain unchanged while deletion state changes.
4. The current reference uses post-action state differences, which can include received updates and bookkeeping. It is not a log of independently validated user intent.
5. The collab minimizer groups ordinary `DstHarnessFailure` errors under `unexpected` and matches only the outer code. It can reduce one defect into another.
6. The test route currently calls `fireSynced` on both success and rejection of `persistence.whenSynced`. A refused local load must not be mistaken for successful hydration.
7. Held episodes now appear to pin two `type` actions and track own-client clock growth. Preserve and verify that improvement. Extend fault verification to deletion-only episodes, which need different evidence.

## Rules for the implementation

- Read production operations to discover existing behavior and contradictions, not to manufacture expected results by calling those same operations. Expected values must not come from the live editor, its facade, its normalization helpers, or a second copy of the production delete algorithm.
- Use explicit fixture expectations first. Add a small pure semantic model only for contracts whose rules are written and independently testable.
- Reuse production code as the system under test, never as the expected-result calculator. Reuse the existing replica scheduler and adapters where they own the needed behavior; do not replace them with a parallel test framework.
- Interleave only at real legal boundaries. A synchronous transaction is atomic to other JavaScript callbacks; do not invent races inside it. Schedule actual async continuations separately only where the production path yields.
- Declare the environment/failure model. A crash before persistence acknowledgement is different from losing acknowledged durable data; arbitrary destruction of every copy cannot be used as an excuse for unrelated lost edits.
- Separate three questions: did the requested input arrive; did the source perform the correct edit; did every replica receive and render the correct edit?
- A remote update arriving during an action is not permission to ignore lost input. Controlled tests isolate the event order. Stress tests must retain the ambiguity and event trace, not silently count the action as verified.
- Keep expected no-ops narrow and named. A suppression counter proves what code ran, not that suppressing the user's key was correct.
- Fix confirmed bounded product defects at their existing semantic owner, with a failing regression first. Product-policy changes or ambiguous public behavior require an explicit decision; continue independent test work while those decisions are pending.
- Preserve concurrent work. Do not revert unrelated changes, weaken assertions to make a seed green, or globally increase delays to conceal a race.

## Required coverage matrix

Use named mandatory cases plus generated combinations. Do not claim the full Cartesian product is covered by a handful of random seeds. Cover every row explicitly, use pairwise combinations for secondary dimensions, and force the high-risk combinations listed below.

| Dimension             | Required cases                                                                                                                                                                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delete intent         | Character/grapheme backward and forward; word backward and forward; soft-line backward and forward; hard-line backward and forward; entire soft line where supported; selected-range deletion via Backspace/Delete; cut; replacement by typing/paste; composition deletion as a separately labeled lane. |
| Text boundaries       | Offset 0, middle, end; empty text; whitespace-only; repeated spaces; punctuation; newline; start/end of marked runs; surrogate pairs, combining sequences, emoji ZWJ/flags, CJK and mixed RTL/LTR. Explicitly distinguish UTF-16 addresses from grapheme deletion units.                                 |
| Inline structure      | Before/after an inline atom; selected atom; range across one/multiple atoms; empty text separators; marked prefix and differently marked suffix.                                                                                                                                                         |
| Block endpoints       | Partial/partial, full/partial, partial/full, full/full; adjacent/nonadjacent siblings; root-first/root-last; whole document; collapsed caret at a block boundary. Text-range selection and atomic block selection are distinct.                                                                          |
| Tree topology         | Parent to descendant; descendant to ancestor boundary; different branches; first/middle/last nested child; deleted ancestor with a surviving partial descendant; surviving following siblings; empty containers; nested list/todo/callout/quote/toggle and relevant code/island definitions.             |
| Structural roles      | Ordinary block; void before/inside/after range; island root/first child/last child; crossing into/out of an island; selected void/island; readonly editor. Record whether the contract deletes, selects, unnests, merges or refuses.                                                                     |
| Selection             | Collapsed, forward range, reversed range, inline/block selection, select-all; endpoints represented by native text nodes or element boundaries; focused editor, unfocused editor, focus in a menu/another control.                                                                                       |
| Collaboration         | 2 and 3 peers; affected peer is the actor, passive user, or spectator; connected delivery, held concurrent edits, deletion-only partition, reordering/duplication, reconnect, persisted offline edits/reload, late join.                                                                                 |
| History/presence      | Actor-local undo/redo; remote delete neutralizes a prior undo item; undo after merge/move/reload; carets and ranges; stale awareness arriving before/after document changes; disconnect/reconnect removes and restores presence without restoring deleted content.                                       |
| Scheduling/durability | Commands before/after delivery; recovery continuation before/after a later legal command; equal-time events; just before/at/after history and presence deadlines; crash before/after persistence acknowledgement; outstanding dependencies when a peer reloads.                                          |

Assign every mandatory cell to headless, browser, or both. Logical deletion/recovery contracts belong in both wherever U2 exposes the real path. Layout, native focus/input and provider implementation obligations belong in browsers or their existing integration suites. Track the execution layer in coverage so a headless supplied range cannot satisfy native soft-line coverage.

## U0 — Freeze evidence and make the coverage ledger

Owned artifacts: a baseline/coverage section in `docs/editor-dst.md` or a dedicated adjacent ledger; existing tests and report artifacts are inputs.

Inventory cases by actual assertion, input trust level, execution layer, browser, peer count and transport. Distinguish a primitive test, headless command simulation, browser fixture, generated browser program, and mixed-engine room. Record the source hash of the code actually executed, the dirty tree, runtime/dependency/browser versions, OS, viewport/fonts for line tests, seed and resolved schedule. Keep durable artifacts outside runner-owned output directories.

Run narrow existing CRDT determinism/corpus checks and advanced-delete, remote-selection, history-oracle and collaboration lanes before product edits. Record failures accurately; do not relabel them as fixed without replay evidence. Recheck each concrete finding above against the current tree.

Inventory nondeterminism on the included paths: client/block IDs and rank randomness; wall clock and undo grouping; awareness expiry; message ordering; persistence completion and reload; promises, scheduled selection restoration and reactive flushes. Mark each source controlled, irrelevant with evidence, or outside the lane. Measure existing headless and browser throughput separately so qualification budgets have a baseline.

Success: a reviewer can identify each missing contract and its existing owner. Baseline test totals distinguish browser programs from pure oracle/shape tests. No product edit contaminates the baseline.

## U1 — Specify deletion and recovery contracts

Owned artifact: `docs/editor-delete-contract.md`, with named examples consumed by later test fixtures.

For every matrix family, specify: deleted interval/subtree, surviving block IDs/types/data, surviving marked content and inline IDs, child order/parentage, selection result, history effect, and attribution/lineage behavior. Include refusal/selection-only cases as first-class results.

At minimum settle these questions explicitly:

- When only the head prefix and tail suffix remain, which block survives and where do the tail's children go?
- When the head is fully selected and the tail is partial, does the tail retain its ID/type? Which unselected descendant branches are preserved or promoted, and where?
- Does a text range selecting a parent's text select its descendants? Atomic selection of a parent subtree is a different operation.
- Which collapsed boundary deletes unnest, select a void/island, merge, or no-op? Do not force forward/backward symmetry where the product intentionally differs.
- Are word boundaries a portable editor contract or native platform behavior? How do punctuation, whitespace and inline atoms delimit them? A mark boundary alone should not change the meaning unless explicitly required.
- What separates a visual soft line, a newline-delimited hard line, and a block? The current fallback code must not silently define all three as the whole block.
- For a passive user's deleted anchor, when is the caret preserved with surviving atoms, collapsed to the deletion seam, or moved to an adjacent editable block? Pin first/last/nested/all-content fallbacks with concrete examples.
- What happens to concurrent inserted atoms when another user deletes their containing block? This differs from deleting a witnessed text interval; document the policy before writing an exact concurrent expectation.

Use small hand-authored examples, including `alpha bravo charlie`: backward word deletion after `bravo` must be distinguished from backward line deletion at the same caret. Include a block with both a newline and a visual wrap so soft/hard/block scope cannot accidentally agree.

Success: every mandatory test has a contract ID and independent expected outcome. Conflicting observed behavior is identified as a defect or an unresolved decision, not promoted into the specification automatically. Do not wait for a difficult policy decision before completing unrelated rows.

## U2 — Connect the simulator to production editor commands

Owned code: the existing `src/tests/crdt/harness/` adapter seam and the narrow production command/selection owners it must invoke. Reuse model-fixture runtime setup where sound, but do not import the fixture harness's manually patched selection as proof of real recovery.

Start with a bounded feasibility slice: two peers share one encoded seed; B has a logical caret in a nested block; A executes the real range-delete command; the queue delivers A's update; B's production recovery runs; B types with no selection reset. Assert the hand-authored document, survivor identities and recovered destination. Trace the command entry point so the slice cannot accidentally substitute a low-level `deleteText` call for editor behavior.

Audit the dependencies of `Edytor`, the command utilities and selection restoration. Use existing non-mounted execution where possible. If DOM access blocks a logical command, separate only the required environment effect from the semantic owner; preserve the public API and keep the browser on the same production path. Do not copy delete or recovery logic into an adapter, emulate layout with arbitrary rectangles, or replace a failing recovery with a test-only implementation. Record any materially broader architectural change as a decision rather than hiding it inside harness work.

Represent initial logical selections explicitly: stable block/content identity, offsets, direction and affinity where the production contract uses it. After setup, delivery/history must exercise real recovery; the harness may observe the new selection but cannot assign the expected result. Preserve held offline selections across concurrent programs where appropriate.

Word/grapheme/hard-line commands can run headlessly only to the extent their production contracts are independent of layout. For visual soft-line input, a supplied resolved range tests command application, not line discovery. Native target-range derivation, focus, geometry and composition remain browser obligations. List any further path that cannot be reached honestly and complete its browser coverage; do not call missing command coverage complete because the primitive lane is green.

Success: the feasibility program runs without a real browser or socket, calls the real command and logical recovery paths, and catches a deliberately wrong survivor or recovery destination. The same contract fixture has a browser counterpart. Existing CRDT adapters and product behavior remain intact.

## U3 — Control execution and establish deterministic replay

Owned code: extend `peer-set.ts` and existing schedule/runner ownership, plus small concern-specific test adapters for the asynchronous boundaries U0 actually identified. Avoid a new general scheduler framework.

- Retain seeded peer IDs/rank randomness and control every additional identity source used by U2. Record peer incarnation on reload; do not accidentally reuse a live writer identity.
- Keep encoded document updates in explicit directed queues. Schedule individual legal deliveries, duplicates, batches, drops, partitions and reconnects. Awareness is a separate ephemeral stream; pending document dependencies and stale awareness are distinct conditions.
- Use a virtual clock for tested time-dependent behavior, including nonzero undo grouping windows and awareness expiry. Existing `captureTimeout: 0` primitive tests remain useful, but do not qualify default timed history. Advance the clock and run due work through explicit steps with stable tie-breaking. Do not use real sleeps to drive headless progress.
- Control completion order for included persistence and deferred recovery/flush work at their real boundaries. Prefer existing runtime flush and test-clock facilities. Await an actual semantic checkpoint; a fixed number of promise turns is not evidence of quiescence. Fail the lane if an uncontrolled callback affects the trace.
- Model persistence only to the required contract: accepted writes, pending writes, acknowledged durable state and reload. Simulated crashes retain or lose unacknowledged work according to an explicit scenario policy. Real IndexedDB/WebSocket protocol correctness stays in its provider/browser tests; an in-memory durable log does not establish it.
- Check local invariants after commands/deliveries and recovery after its defined completion point. Require convergence and bounded progress after faults are healed and required dependencies are delivered. Do not require isolated peers to agree, or declare liveness failure while the schedule withholds progress forever.

The event record must distinguish generated intent from executed decisions: event ID, actor/incarnation, virtual time, causal prerequisites, selected message or callback, resolved command target and checkpoint outcome. Record scheduler choices as well as the seed. A replay with an unavailable event or mismatched precondition fails explicitly instead of choosing another target.

Prove determinism with repeated fresh-process runs for representative schedules and a deliberate defect: pinned source/runtime/configuration plus the same seed produces the same semantic event trace and failure fingerprint. Test equal-time event ordering, reload, timer boundaries and pending dependency delivery. Wall-clock duration is not part of the compared trace. If part of the environment remains uncontrolled, classify it as a separate integration lane instead of weakening the deterministic gate.

For small pinned two/three-peer programs, enumerate legal delivery orders and selected timer boundary choices within an explicit bound. Preserve causal prerequisites and synchronous transaction boundaries. Report the explored bounds/count and supplement them with randomized longer schedules; do not claim that arbitrary concurrent CRDT outcomes equal one of the serial command executions.

Success: the command lane reproduces its full declared execution across fresh processes; virtual-time tests catch a timer/history/recovery defect; a held deletion cannot bypass the queue. The artifact identifies the environment model and its limits. Wider sweeps are gated on this result.

## U4 — Make input intent and delivery observable

Owned code: existing `generator.ts`, `runner.ts`, `browserState.ts` event recording and their oracle specs; coordinate edits to these shared files under one owner.

Introduce explicit deletion units/directions in the action vocabulary. Keep semantic intent separate from its delivery method: native chord, synthetic beforeinput, clipboard event, or direct model probe. Preserve/rewrite old replay schemas explicitly so an old macOS `wordDelete` artifact continues replaying its original chord rather than silently changing meaning.

Verify shortcut mappings on the executing OS/browser and record the actual emitted `inputType`, target ranges and trust. A native chord that delivers a different deletion unit must fail the intent assertion or be recorded as unsupported; it cannot count as a successful word test. Synthetic fallback tests must stay labeled synthetic.

Capture the pre-state and native target ranges at the input boundary before mutation. Keep the requested selection, selection actually present at dispatch, browser target range, and editor-applied result separate. Add explicit tests for target-range priority, missing ranges, element endpoints and stale/unresolvable ranges. Do not use the browser's target range as the sole proof that the requested word/line granularity was correct.

For soft-line fixtures, use controlled layout and independently inspect native range/line geometry before editing. Assert each engine's correct line-local result; compare identical results across engines only where the pre-edit line boundaries and contract are equivalent. Record layout differences instead of normalizing away lost content.

Success: backward/forward word, soft-line and hard-line actions cannot be conflated. Replaying a failure preserves both intent and delivered event evidence. No unsupported native combination is reported as a pass.

## U5 — Add independent result oracles and prove their sensitivity

Owned code: small test-only semantic expectations and fixtures in an environment-neutral location, provisionally `src/tests/editor-contracts/`, consumed by headless and browser assertion pipelines. Keep names provisional if an existing owner can be extended coherently. Browser DOM/native assertions stay with the browser harness.

Represent a small test document as a tree of stable block identities and marked text/inline tokens. A deletion expectation describes preserved prefix/suffix, explicit structural effects and the expected caret. For simple text cases use an independently specified splice; for structural cases use U1's declarative examples/rules. Do not import production deletion, word-boundary, normalization, selection-resolution or run-building functions into the oracle.

Assertions must compare the complete expected semantic state, not only concatenated text or length: block identity/order/parentage, type/data, content/marks, inline identity, surviving unselected subtrees, normalized empty content, and caret/range. Normalize only representation-equivalent adjacent runs. Compare IDs exactly inside a shared document; standalone cross-browser fixtures may use explicit stable labels where fresh IDs differ.

Define an honest result for each oracle evaluation: exact expectation checked; named legitimate no-op checked; unsupported contract with a recorded reason. Mandatory coverage cannot complete with unsupported cases. Never catch an oracle error and return the actual result as expected.

Keep the oracle hierarchy explicit: local exact command semantics; concurrent identity/content conservation and authorized effects; per-peer logical selection policy; transport integrity/convergence; progress after recovery; browser input/DOM parity. Retain the existing headless atom-fate and operation-intent checks as complementary evidence. Their production inspection helpers and the wire reference are not independent implementations of editor semantics. For concurrent programs use independently written exact or bounded allowed outcomes plus causal preservation rules; never accept an unrestricted set constructed from observed outcomes.

Prove the oracle fails on deliberately wrong candidate results: delete one extra grapheme; delete a line for a word; lose a mark; duplicate/recreate the survivor; drop an unselected child; move a suffix into the wrong parent; leave a caret out of bounds; lose an inline atom outside the range. Include valid controls to avoid an always-failing oracle.

Success: these injected defects fail even when all replicas and the wire reference contain the same wrong result. Legitimate mark segmentation and named boundary no-ops still pass.

## U6 — Build shared deletion programs and guided generation

Owned code: declarative contract fixtures from U5, generated headless command programs through U2/U3, and thin browser scenario drivers. Reuse `advanced-delete.spec.ts` rather than duplicating its established cases. Share intent/expectations where meaningful; do not force every runner to expose identical internal events.

Start with exact golden fixtures covering every mandatory structural row in the command lane. Qualify those families through actual browser input as well, with native-only cases owned by U4. Run both input directions on selected ranges, both selection orientations, and a follow-up character at the resulting caret. Assert the exact result before that follow-up so later input cannot hide a faulty restore.

For each family, generate variations of content, marks, endpoints, sibling counts and depths around a known contract. Use generated preconditions and coverage counters; random entropy that happens to resolve to another shape is not coverage for the requested shape. Retain some fully random exploration as an additional lane.

Keep workload choice distinct from schedule choice so the same edit program can run under several legal delivery/time/failure schedules. Bias toward meaningful collisions: shared deletion seams, partially surviving descendants, boundary inserts, pending restores and history windows. Reduce invalid-target/no-op churn through state-aware generation and report every skipped operation. Do not repair a passive selection merely to make the next generated command applicable.

Include multi-step programs: delete → type; delete → undo → redo; repeated boundary delete; nest/move → delete; select-all → delete → type; cut and replacement across a marked/nested seam. Keep replacement-specific rules explicit instead of assuming every replacement equals every standalone deletion path.

Add metamorphic checks only when valid: reversing the same selected range preserves the delete result; equivalent mark segmentation does not alter deletion scope; an unrelated sibling remains unchanged; delete/undo restores semantic state under controlled history grouping. Do not assert bytes return to their prior encoding after undo.

Success: every matrix family has an independently expected result in its assigned layer, with logical command contracts covered headlessly and through browser representatives. Coverage shows both directions, selection orientations and realized shapes, not just seed counts. A defect shared by all replicas and browser engines fails its local semantic oracle.

## U7 — Observe all peers' selection, focus and awareness separately

Owned code: logical peer-selection probes in U2's existing runtime bridge; browser `collab-runner.ts`, snapshot probes and the test route. Add a small selection-oracle module only if it has a clear independent responsibility. Keep shared expected selection rules in U1/U5, not independently redefined in each runner.

In the deterministic lane, observe each peer's production logical anchors and recovery at the scheduled command/delivery/restore boundaries. Include two successive remote updates before a pending restore, a local command before that restore completes where the real path permits it, and a deleted anchor followed by undo or reload. Check the actual continuation destination, not only that offsets are in bounds. If a path depends on native DOM selection, retain its browser qualification and label the headless limit.

In browsers capture every peer after each relevant delivery and at barriers: live document/mirror/DOM consistency, local model selection, native anchor/focus and direction, active element/editor focus, composition state, published awareness and resolved remote-presence targets. Keep these local states out of durable document-equality signatures.

Take passive snapshots without calling `setSelection`, clicking or focusing the peer. The current runner prepares selection before an action; new recovery tests must support a `preserve` action so the harness does not repair the bug before testing it.

For focused peers, require native and model endpoints to agree on live editable content, with only documented grapheme/DOM-boundary equivalents. For unfocused peers, require valid model recovery and no focus theft; do not demand a DOM caret inside an unfocused editor. When one endpoint survives, assert the U1 collapse/range policy. If both survive, retain direction and intended anchors.

Assert remote awareness as an ephemeral stream: stale anchors may be pending or temporarily unrenderable until the required document update arrives. At a settled barrier, valid advertised positions must resolve appropriately or be withdrawn according to the contract. Stale overlays must not attach to a deleted/recycled wrapper. Pixel-identical caret rectangles across browsers are not a semantic requirement.

Success: a passive caret can be valid-but-wrong and still fail an exact fixture. A follow-up trusted character, with no intervening harness selection reset, appears once at the independently expected block/offset and preserves unrelated content. Remote repairs do not steal focus or create local undo entries.

## U8 — Add controlled multi-user delete programs

Owned code: named collaboration scenarios and their expected outcomes, executed first through the existing replica queues plus U2/U3, then through browser drivers and the opaque relay for applicable input/provider cases. Test 2 peers first, then 3 with an observing participant. Browser-only steps such as native composition and dragging have explicit browser ownership.

Mandatory programs:

1. B's caret lies before, inside and after text A deletes; repeat for a non-collapsed/reversed range with zero, one or both endpoints deleted.
2. B is in A's fully deleted first/middle/last block, or in its descendant; verify the specified fallback, then B types without resetting selection.
3. A merges across blocks while B's caret/range is in the surviving tail; anchors follow the retained content, marks and identity.
4. A deletes across nested branches, a void/island boundary or inline atom while B targets an affected and an unaffected sibling.
5. Hold delivery; A deletes a witnessed range while B inserts at its start, interior or end. Reverse delivery order and duplicate packets. Specify atom survival from U1; do not compute expected state by serially replaying concurrent editor commands.
6. Hold delivery; delete/delete overlapping and disjoint ranges; delete versus split, merge, move/nest/unnest and mark changes. Include same-block and ancestor/descendant conflicts, with explicit recovery/visibility rules.
7. B goes offline, edits, and reconnects after A deletes B's block; repeat with persisted reload. Verify the conflict policy and retained recovery lineage, not simply replica equality.
8. A deletes while B is composing, dragging a range, or has focus outside the editor. Assert no duplicate commit, stale restore, focus theft or write to a dead wrapper; native and synthetic composition evidence remain separate.
9. A undoes/redoes a deletion after B edits a survivor. Assert local ownership of undo, survival of B's work, correct lineage/attribution, and B's caret.
10. A late peer loads after a delete/merge; compare live state and deleted-block recovery records, then test subsequent input and a fresh save/reload.

Use causal barriers for before-delete, remote-apply, mirror flush, awareness publication, recovery and next input. A concurrent outcome is not necessarily equivalent to either serial command order. Exact expectations are required for the bounded programs; wider random schedules use those semantic laws plus conservation invariants and the delivery reference.

For headless programs vary workload and scheduler seeds separately. Exhaust the documented small delivery-order sets for high-risk seams; then generate longer histories, clock advances, persistence boundaries and reconnects. Start each peer from a common encoded seed, preserve true independent local histories and check affected/passive roles. Quiescence must account for pending restore/repair work as well as empty network queues.

Promote applicable core counterexamples to browser regressions using the same semantic preconditions and expected outcome. Browser translation reproduces the user-visible program and controlled delivery relationships; it is not a claim to replay the core's precise internal scheduling. Keep non-translatable timer/storage cases in their correct lane with an explicit reason.

Run same-engine rooms in Chromium, Firefox and WebKit, then one mixed room containing all three engines. An OS lane is separate from a browser lane; running three engines on macOS does not establish Windows/Linux shortcut behavior.

Success: cases 1–10 have named expected outcomes, layer assignments and affected/passive-peer assertions. Core conflict programs run under deterministic schedules and browser representatives exercise the real bridge. Both sides really mutate during intended concurrency. The follow-up input destination is checked independently of the captured wire result.

## U9 — Strengthen transport, history and persistence evidence

Owned code: existing replica transport/history/persistence checks plus collab transport/capture integration and test sync composition. Keep ownership coordinated with U3/U7; do not let parallel edits compete in `peer-set.ts` or `collab-runner.ts`. Assert the declared simulated contracts headlessly and qualify actual provider behavior in integration tests; neither lane substitutes for the other.

- Capture emitted updates with origin/locality and action IDs using read-only test instrumentation installed before actions. Preserve the source update before reload/teardown and record repair/bookkeeping commits separately. Feed the delivery reference all intended durable updates with declared provenance; do not call every state-vector diff an authored edit.
- Verify partition isolation using accepted update/delete-state evidence as well as insertion clocks. Add a deletion-only leak canary: an illegally delivered delete must fail even when the receiver's state vector is unchanged. Awareness traffic has its own fault/expiry assertions.
- Require held/concurrent windows to demonstrate actual independent mutations. Own-client clock growth proves pinned insertions; witnessed deletion state or emitted local mutation evidence is needed for delete-only programs. A nonempty update encoding can still contain no new operation.
- At the final heal, explicitly release faults, reconnect required peers, wait for delivery/repair quiescence, and compare every required peer plus a fresh read/load. Do not pass by skipping a held barrier or excluding an inadvertently disconnected peer. Declare intentionally partial checkpoints as such.
- Test history transition semantics against the pinned engine. `UndoManager.popStackItem` can consume obsolete entries without performing a change or growing the opposite stack. Distinguish a dead command, a valid consumed no-op, and an actual undo/redo. Verify restored content and other users' edits, not only stack lengths.
- Cover production history coalescing and awareness expiration with virtual time just before, at and after their deadlines. Keep primitive `captureTimeout: 0` tests as a separate lane. Test crash/reload around durable acknowledgement under U3's declared storage model; acknowledged-state loss is never relabeled as acceptable unpersisted loss.
- Route IndexedDB hydration rejection to observable failure, never `synced`; test delayed local restore versus a fast socket handshake, refused stored rows, initial empty-room bootstrap and offline edit persistence. Stored refused bytes must remain intact. Make the test topology match the public composition being qualified.
- Scope allowed WebSocket console failures to the intended relay/fault window, retain them in artifacts, and assert recovery. Keep unexpected application errors fatal.

Success: injected dropped edits, leaked deletes, frozen undo, obsolete undo, false hydration success and incomplete healing each produce the correct distinct verdict. A healthy equivalent schedule passes.

## U10 — Coverage, replay and minimization must preserve the claim

Owned code: existing spec drivers, schedule versions, reducers and artifact schema. Reuse single-doc fingerprinting where applicable.

Record execution layer, workload/scheduler seeds, requested and realized delete family, resolved endpoints/IDs, actual input type where relevant, contract ID, oracle result, runtime/engine/OS, structural roles, selection direction, delivery order, authoring peers and selection-recovery outcome. Keep counts of attempted, applied, expected-no-op, suppressed, unsupported and verified actions separate. Report checked invariants/contracts and schedule/shape coverage separately from total action count.

Artifacts must include immutable before/after snapshots, expected outcome or permitted outcome set, mismatch path, all peer selections/focus/presence, source update provenance, relay delivery decisions, history transition and source/browser identity. Record actual update/delivery order and relevant timing where the browser prevents deterministic scheduling; a seed alone is not complete replay evidence.

For deterministic runs include the environment configuration, virtual clock, pending events, causal event choices, peer incarnations, durable acknowledgements and a trace digest. Compare repeated runs at semantic checkpoints and keep the first divergence if the determinism self-test fails. Headless replay must reproduce the execution within its pinned environment; browser replay must report observed reproducibility without disguising timing-sensitive failures as deterministic ones.

Preserve `DstHarnessFailure.code`. Minimize using a fingerprint including contract, failure class, engine/peer role, action/selection shape and mismatch category. Preserve causal prerequisites: B's original selection, partition, two real authors, remote delete and B's unassisted follow-up typing. Reject invalid candidates rather than accepting a generic timeout or a different `unexpected` error. Save the original artifact before shrinking; shrinking has a time/attempt budget.

Reduce both the edit program and its scheduling/fault choices without breaking their dependencies. Removing a required message or selection setup makes a candidate invalid; do not silently retarget it. Retain contract, causality and failure fingerprint, not literal transient IDs that prevent useful reduction.

Replays should honor the recorded runtime/environment and engine/OS requirements or fail with an explicit mismatch; they must not silently run a Firefox failure as Chromium. Reproduce a minimized headless case exactly and report timing-sensitive browser repro rates honestly.

Success: a remote-caret corruption shrinks to the same remote-caret defect; it cannot turn into a disconnected-page timeout. Mandatory coverage fails when a required action/fault combination was never realized.

## U11 — Adversarially validate the validators

Owned artifacts: narrowly scoped oracle tests and a recorded sensitivity matrix. Use test doubles or controlled harness mutations; do not ship product fault flags.

Prove detection of: wrong-but-converged delete; extra-word/line loss; unselected subtree loss; mark/inline identity damage; stale passive caret; valid caret in the wrong block; focus theft; delete packet leaked through a partition; captured update lost on reload; dead undo; hydration refusal disguised as success; stale awareness overlay; required scenario silently skipped.

Challenge the simulator as well: uncontrolled randomness/time changes the same-seed trace; a queued callback escapes the scheduler; a partition lets a delete through; an acknowledged write disappears on crash; a heal barrier ignores pending recovery; a primitive-only adapter pretends to cover an editor command. Each must fail the appropriate determinism, environment-integrity or coverage check. Apply canaries narrowly to avoid a generic timeout obscuring the intended detection.

Also prove acceptance of: valid refusal at a protected boundary; expected atomic selection of a void; legitimate obsolete undo consumption; temporary presence lag before its document dependencies; representational mark-run differences with identical semantics.

Have an independent review examine the contracts and candidate expected values before using green sweeps as evidence. If parallel review is used, assign one bounded outcome per reviewer and verify the decisive claims locally.

Success: every primary oracle and simulation-control guarantee has at least one failing canary and a passing control. The review explains the environment, contract and platform classes outside its evidence. Repeat canary checks after any oracle or normalizer change.

## U12 — Qualification and handoff report

First run oracle/contract and simulator self-tests, then named headless command programs, then browser contract cases. Only then expand deterministic schedules and generated browser programs. Use the isolated preview workflow; do not run two processes against the same owned preview port.

Required qualification:

- Fast CI: deterministic replay self-tests, all mandatory exact headless contracts, bounded exhaustive delivery programs, canaries and realized coverage quotas. Start with 50 workload/scheduler pairs of 100 semantic events for the generated headless smoke lane; measure its cost against U0.
- Browser CI: named deletion/recovery families across the three engines, bounded 2/3-peer programs, representative mixed-engine collaboration and a small generated smoke corpus. Report provider, native-input and synthetic coverage separately.
- Extended simulation: initially 1,000 workload/scheduler pairs of at least 200 semantic events, plus a smaller set of longer histories and timer/crash/reload programs. Report executed local commands and deliveries separately so housekeeping cannot inflate the action budget. Explore multiple scheduler seeds for selected shared workloads and retain minimized regressions permanently.
- Extended browsers: initially 20 generated programs per same-engine room plus selected mixed-engine programs and applicable promoted core regressions. Choose final operation/runtime budgets from U0 throughput, required cells and observed skip rates. Report any budget adjustment; these initial counts are execution budgets, not thresholds that establish correctness.
- Determinism qualification: rerun representative successful and deliberately failing headless schedules in fresh processes, using pinned source/runtime/configuration. Require identical semantic traces and fingerprints. A leaked source of nondeterminism blocks a claim of deterministic command simulation even if the content eventually converges.
- OS qualification: native word/line mappings on supported OS lanes; record unsupported combinations. Playwright WebKit is engine coverage, not proof for every shipping Safari/device/IME.
- Focused existing model, DOM, composition, remote-selection, lineage and provider tests for touched behavior; existing source/test type checks, lint and package/build checks appropriate to any public API change. Ensure the new harness files themselves are type-checked rather than relying on transpilation alone.
- Replay every discovered regression against the final source hash. Repeat timing-sensitive cases and preserve failures instead of hiding them with retries.

Expose explicit commands for deterministic command simulation (bounded/extensive/replay) and browser collaboration verification (bounded/extensive/replay), extending existing scripts and runners where possible. Verify variable routing: the current `test:dst:extensive` sets `DST_*` variables, while the collab spec reads `COLLAB_DST_*`. An “extensive” command must actually expand the intended lane. Wire required lanes into the release gate without accidental duplicate runs or silently replacing the existing primitive corpus.

Update `docs/editor-dst.md`, `docs/crdt-v14-harness.md`, the deletion contract and applicable repository guidance with supported commands and evidence boundaries. Clearly distinguish deterministic core execution from generated browser E2E and explicitly list uncontrolled behavior. Remove stale lineage-depth claims if touched; do not convert the documentation into an execution transcript.

Final report must state completed work units, concrete product defects and fixes, exact executed programs/coverage by layer, deterministic controls and replay evidence, bounded enumeration limits, native versus synthetic evidence, failures/replays, measured throughput, performance implications of any broadened invalidation, and unresolved policy/platform limitations. Never use a total test count or the phrase “enough entropy” as a substitute for this breakdown.

## Execution order and ownership

1. U0 freezes evidence and inventories nondeterminism; U1 defines the contracts. U4's native-intent inventory and U9's provider recon may proceed independently.
2. U2 establishes the minimal real-command bridge and U3 controls its required environment. U5 specifies independent expectations in parallel. Do not start large campaigns before the command-path and replay gates pass.
3. U6 adds golden and guided programs; U7 observes passive recovery; U8 explores their collaborative schedules. U9 closes history/storage/transport gaps in coordination with U3/U7. Implement and review headless contracts first, then their browser counterparts and browser-only cases.
4. U10's artifact/replay foundation starts alongside U3 and grows with each scenario, including reduction before long campaigns. U11 challenges each oracle and simulator boundary as it lands; U12 qualifies the integrated result.

One owner coordinates shared scheduler/adapter files, and one coordinates shared browser runner/snapshot files. Parallel work is appropriate only for disjoint ownership, such as contract fixtures versus browser input probing. No task is complete merely because its own lane passes while an assigned contract is missing from the other layer.

Do not wait until the end to test. Each unit lands its narrow validation and a reproducible failure for any product fix. Stop expanding scope once these contracts and proof obligations are satisfied. No finite DST corpus makes the editor bulletproof; the deliverable is a much stronger, explicit and repeatable correctness argument.
