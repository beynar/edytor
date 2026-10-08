# Handoff: finish the current fixes by consolidating selection contracts

You are already implementing the latest review findings in `/Users/arnaud/code/edytor`. This instruction augments that work. Preserve your changes, tests, and evidence. Recheck the current tree before deciding what remains; some counterexamples below may already be fixed.

## Goal

End the cycle of fixing one selection example and breaking its neighbor. Establish coherent contracts for anchors, selection recovery, and test settlement; implement those contracts at their existing owners; qualify the result against a finite matrix and a bounded campaign.

The outcome is a defensible, scoped acceptance decision. Finite simulation cannot prove correctness for every possible execution. Increasing test counts is not the goal.

Do not restart the U0–U12 program or launch a general editor rewrite. Finish the active findings through the work below, retire redundant repairs where justified, and stop at the acceptance gate.

## Context you must retain

Edytor uses a vendored Yjs v14 engine, an application facade that projects shared backing text into blocks, live model wrappers, and a Svelte rendering layer. Splits and merges can leave multiple visible blocks sharing one backing text. An engine text position therefore does not by itself identify the intended visible block boundary.

Recent rounds made real improvements: independent command-result assertions, joint range recovery expectations, recursive editable traversal, stale-write admission, and timer/frame accounting. Preserve those gains. The repeated failures cluster around three unresolved responsibilities:

1. **Anchors:** character identity, insertion affinity, and visible block ownership must agree across edits and structural changes.
2. **Selection:** model recovery, DOM mounting, and deferred writers must respect one current selection intent.
3. **Verification:** expected semantics must be independent of production's decisions, and a checkpoint must include the deferred effects it claims to cover.

Historical test totals are evidence for the source that produced them, not acceptance criteria. Read actual code and rerun relevant checks.

### Latest confirmed counterexamples

Treat these as regressions to preserve, not as a claim about the state of your ongoing implementation.

| ID  | Reproduction                                                                                                                                                                     | Required result / defect exposed                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Split `alphaHello` into `alpha` / `Hello`. B places its caret at `Hello@0`. A appends `X` to `alpha`; deliver to B; B types `Z`.                                                 | `alphaX` / `ZHello`. The reviewed implementation produced `alphaZX` / `Hello`: the `-2` anchor preferred the newly inserted preceding block's atom. |
| F2  | Start with `[alpha, beta]`, B at `beta@2`. A selects `alpha@0 → beta@4` and deletes everything. Deliver; let the replacement empty paragraph mount; B types `Z`.                 | One live paragraph containing `Z`. The reviewed implementation left B on dead `beta`, even after mounting and an additional 80 ms, and dropped `Z`. |
| F3  | `queueMicrotask(() => queueMicrotask(() => setTimeout(callback, 10)))`; call and await `quiesce()`.                                                                              | The declared settlement checkpoint must include that callback. The reviewed helper reported zero while one settlement timer was pending.            |
| F4  | A peer has a selection; updates are held; a remote deletion is queued; release/reconnect applies it; an injected recovery defect clears the passive selection; heal immediately. | Fail for lost selection. Network operations bypassed the edit-step pre/post invariant, and final sanity accepted `selection: null`.                 |
| F5a | A dump's live text inventory contains `t: "ab"`; the selected wrapper claims `t@5` with length 6.                                                                                | Reject the out-of-bounds selection using the live inventory, not the selected wrapper's self-reported length.                                       |
| F5b | Text `t` is enumerated in block B's content, but its stale `parent` points to live block C. The selection also reports C.                                                        | Reject the ownership mismatch. Deriving both sides from `part.parent.id` made the check self-validating.                                            |

Earlier failures also remain mandatory regressions: `nにello` versus `にHello` during composition after a split; a container starting/ending with a divider; stale string-ID setters; failed lookup fallbacks overwriting newer gestures; valid survivor-collapse ranges rejected by the oracle; synchronous no-op and delayed `CORRUPTION` executors escaping checks.

## Constraints

- Preserve concurrent and uncommitted work. Do not use `git checkout`, reset, or whole-file restoration to test a mutation. Use isolated fault injection or disposable test artifacts, and remove your own probes only.
- Continue through routine implementation choices. Internal corrections within the existing owners are in scope. An incompatible public/wire change or a new product policy requires an explicit, concrete decision; complete independent work while presenting it.
- Keep the vendored engine unless evidence establishes a defect at that boundary. The latest anchor defect is in application ownership resolution, not evidence that Yjs's sign handling is broken.
- No new framework, generic scheduler platform, second editor, or replacement CRDT. Extend existing tests and scheduling seams.
- Preserve the current deletion, undo, composition, awareness, readonly, and isolation contracts outside the affected boundary. Do not expand this into unrelated feature work.
- Do not weaken an oracle to accommodate production output. A valid platform allowance must have independent evidence and a bounded predicate.
- Do not fix chained microtasks by adding a fixed number of Promise awaits. Do not fix ownership by adding another unexplained association-number special case.
- Prefer removing competing repair paths to layering another timer or state flag over them. A new field is justified only by a distinct requirement the existing representation cannot express.

## Work 0 — reconcile the active work and freeze the scope

Before more product edits, make a concise inventory of F1–F5 and the earlier pins: fixed and verified, implemented but unverified, or still open. Reuse work already done. Record the current relevant source identity, runtime/browser versions, and focused test commands in the execution ledger. Preserve existing failure artifacts outside runner-owned output directories.

Inspect these seams, following renamed files if necessary:

- `src/lib/crdt/edytor-doc.ts`: `anchorAt`, `resolveAnchor`, `DocAnchor`.
- `src/lib/crdt/text/model.ts`: atom anchors, backing positions, ownership/flattening.
- `src/lib/selection/selection.svelte.ts`: anchor mint/resolve, relative/dead-endpoint recovery, setters, verification callbacks, gesture admission.
- `src/lib/edytor.svelte.ts`: mirror flush, render lifecycle, existing commit/gesture ownership.
- `src/lib/block/block.svelte.ts`: editable traversal and drop-time neighbors.
- `src/lib/events/domTextMutationObserver.ts`: selection capture and restoration after repair.
- `src/lib/collaboration/{awarenessSelection,remoteSelection}.ts` and history snapshot consumers of anchors.
- `src/tests/crdt/doc/anchors.test.ts`, `src/tests/crdt/harness/dense-ownership-oracle.ts`.
- `src/tests/fixtures/dom/command-*.test.*`, `command-peer-set.ts`, `deterministic-command-scenario.ts`, selection ownership/preservation fixtures, and `input-fallback.fixtures.tsx`.
- `tests/editor-dst/{selectionOracle,collab-runner,browser-state-oracle.spec}.ts`, browser collaboration specs, and `src/routes/test/dom/+page.svelte`.

**Done when:** there is one bounded open-work list, and ongoing fixes have not been duplicated or overwritten.

## Work 1 — specify the contracts before selecting the representation

Update `docs/editor-delete-contract.md` as the normative behavior document. Keep observations, intended behavior, and implementation choices distinct. Its current introduction describes behavior discovered from production, and it has contained stale `omega@5` recovery text after the intended forward seam became `omega@0`. Reconcile the relevant entries with independent expectations; do not simply copy the latest implementation into the document.

### Anchor contract

State these properties separately:

- The visible position: owning block, inline/text boundary, and offset.
- Insertion affinity: which side of inserts at that position the endpoint remains on.
- Causal identity: which existing content or boundary is followed through edits.
- Structural relocation: what happens when the owning block splits, merges, moves, or dies.

Required semantics:

1. A caret in a surviving block must not migrate into a different surviving block merely because that neighboring block receives text. This includes blocks sharing a backing and empty block boundaries.
2. An insertion before a caret in its own text shifts its offset; an insertion exactly at a left-associated caret remains to its right. Block-start ownership must not reverse that affinity.
3. When a merge moves the caret's surviving content into another block, the caret follows the intended content to the correct merge offset.
4. When the selected content no longer provides a destination, recovery follows the documented structural fallback. It must not confuse an unresolved incoming anchor with a proven deleted destination.
5. Range starts, range ends, and collapsed carets have explicit boundary semantics. Preserve direction for surviving noncollapsed ranges. If one endpoint dies and only the other remains resolvable, specify survivor collapse; if neither survives, specify the structural fallback.
6. Same-block text-part boundary equivalence must be defined explicitly. Equivalent wrappers at the same editable gap may be normalized; two different blocks, or opposite sides of an inline atom, are not interchangeable positions.

### Selection ownership and lifecycle contract

- A newer user gesture supersedes older deferred writes, including when it chooses the same numeric offset. All argument forms and all write exits obey this rule.
- Programmatic focus caused by the current write is not a new user gesture. Existing history and composition ownership remain distinct responsibilities.
- Logical recovery cannot depend on the destination already having a DOM node. A valid, not-yet-mounted destination must eventually receive the correct DOM selection without losing the logical editing position or stealing a newer gesture.
- Hidden container text and temporarily unmounted editable text are different cases. Document how the existing schema/render lifecycle distinguishes them.
- After settlement, endpoints reference live editable content with correct owner and bounds. Follow-up input reaches that destination without a harness selection reset.
- Fallback order uses the previous sibling ordering: surviving forward editable destination, then backward destination, then the documented root/replacement destination. Traverse past noneditable descendants and siblings.

### Oracle and checkpoint contract

- A wire-replay reference proves delivery/convergence. It does not prove editing intent.
- Production anchor resolution is an integration check. Independent scenario expectations must detect a resolver and caret that agree on the wrong block.
- Inventory ownership comes from containing blocks, lengths from enumerated live content, and editability from a declared independent observation. Verify wrapper pointers against those facts.
- Selection presence and shape are checked across every delivery boundary, including release, reconnect, heal, and batched delivery. A reload resets its prior selection baseline explicitly; an initially unselected peer need not acquire a selection.
- A local command's result includes its settlement-class deferred work. Assert the precomputed expected result after local settlement and before remote delivery; settle and verify remote effects separately.
- Declare exactly which queues/time sources the harness controls or observes. A mocked UndoManager clock is not a virtual event loop. Exact trace claims exclude uncontrolled wall-time diagnostics.

**Done when:** the requirements above have unambiguous outcomes and a short responsibility map names their existing owners. Identify a genuine product-policy ambiguity before implementation; do not label a disagreement with current code an ambiguity automatically.

## Work 2 — close the boundary matrix, then finish the anchor implementation

Write expected outcomes before running the candidate implementation. Use parameterized cases where they express the same contract, with readable failure names. Keep the matrix bounded:

| Family                | Mandatory cases                                                                                                                                                                      | Required observations                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Block-start ownership | Directly constructed versus split-backed `alpha` / `Hello`; insert into preceding block end and into selected block start; delete predecessor's last atom; delete predecessor block. | Intended block, offset/affinity, unchanged unrelated content, follow-up typing destination.                                                  |
| Structural relocation | Split, merge backward/forward where supported, move/nest the selected block, delete its atoms or entire block; empty surviving block.                                                | Content/identity preservation, defined relocation or fallback, convergence.                                                                  |
| Composition           | Ordinary and split-backed start; intermediate `n` then final `に`; a remote edit before the composition region and an adjacent-block edit.                                           | Exact committed text, no lost/repeated intermediate characters, final caret, no edits to neighbor. Use existing supported composition paths. |
| Recovery topology     | Forward/backward sibling, deleted nested ancestor, surviving container with leading/trailing divider, whole-document deletion with a newly created empty paragraph.                  | Editable destination, correct seam, live endpoints after render, exact continuation.                                                         |
| Range recovery        | Forward/reversed range; both endpoints survive, one dies, both die; text-part/inline boundary.                                                                                       | Whole-selection shape, direction where meaningful, exact continuation.                                                                       |
| Deferred ownership    | Text object/string ID; successful/rejected/detached lookup; newer gesture at a different or identical position; destination mounts after mirror flush.                               | No stale write at any exit, no focus theft, no lost input.                                                                                   |

Use two replicas for the conflict rows. Add one three-peer program: B owns a selection, A deletes/merges its destination while delivery is held, C edits unrelated content, then release in different legal orders. Assert all unrelated content survives and B can continue at the specified destination.

For secondary dimensions, use explicit pairwise coverage rather than the full Cartesian product. The high-risk combinations above are mandatory, not left to random generation.

Add a narrow history-independence check: sequential edits on already-synchronized documents with equivalent visible structure should behave equivalently whether that structure was constructed directly or produced by a split. Compare semantic positions/content under an explicit identity mapping, not CRDT bytes or arbitrary concurrent histories.

Select the smallest anchor representation that satisfies the whole matrix. You may retain, amend, or replace the current `-2` mechanism based on evidence. Engine acceptance of a number does not establish the application meaning of that number. Explain how the chosen representation preserves the intended boundary when either neighboring owner inserts at the shared backing gap.

Check every actual anchor consumer: selection, awareness serialization, history, JSON/encoding round trips, and any persisted uses that exist. Prefer compatible extension and explicit fallback for older anchors. Do not invent a migration requirement without finding stored data that needs it; do not silently change existing wire interpretation either.

Keep the dense ownership oracle for differential bookkeeping coverage. Add independent semantic expectations outside its mirrored algorithm so the same wrong owner rule cannot validate itself.

**Done when:** F1, split composition, affinity, owner relocation, serialization, and the anchor rows all pass against one coherent representation. No production-derived expected positions qualify as independent proof.

## Work 3 — complete selection recovery and remove competing writes

Finish F2 and the ownership/lifecycle rows using the existing selection and render owners. Resolve the model destination and DOM readiness as separate facts. An unavailable DOM node must not silently turn a live destination into “no recovery possible.”

If restoration is deferred, bind it to the current logical intent, revalidate it when it runs, and complete it when the destination mounts. The next accepted input must reach the intended live block. Preserve the current safeguards against phantom text, outside focus theft, stale gestures, history restores, and composition corruption.

Audit the affected write paths once as a set: successful lookup, string resolution, lookup rejection, detached-node retry, foreign-focus fallback, final fallback, and post-write verification. Assert race outcomes immediately after the deferred write resolves and again after settlement; a later selectionchange echo must not hide an earlier incorrect write.

Consolidate admission or repair logic only when it expresses the same rule and lifetime. Do not combine history, composition, gesture, and render lifetimes into one generic boolean. Remove obsolete branches/comments introduced by the earlier failed approaches when tests show they are redundant. Avoid unrelated file splitting or cosmetic LOC reduction.

**Done when:** all recovery/write rows pass, including whole-document deletion followed by actual input without manually restoring selection. The responsibility map identifies who resolves the logical destination, who waits for rendering, and who admits the final write.

## Work 4 — make the harness enforce the contracts

Finish F3–F5 in the existing harness:

1. Establish settlement across the relevant event-loop queues. Before declaring an empty tracked queue settled, cross a task boundary that permits finite queued microtask chains to finish registering work, then recheck. Preserve bounded failure for nonsettling work, cancellation accounting, and frame accounting. If another mechanism is chosen, prove the same behavior with the canaries below.
2. Keep long policy/persistence timers explicitly outside the declared settlement class only where justified. Track/report them; do not include wall-time-dependent pending counts in a supposedly deterministic fingerprint. Do not silently ignore a timer that can change the command result under test.
3. Preserve local-settle → independent assertion → remote delivery → remote-settle ordering. At the final barrier, drain transport and deferred effects to the declared fixed point, or reject unexpected post-drain authoring; do not snapshot between mutually generating queues.
4. Capture prior selection facts around delivery-producing network steps and check presence/shape after they settle. Multi-frame exactness may remain a stated limit, but identity, owner, bounds, editability, and preservation of an existing selection must not be skipped.
5. Build dump inventories from containing blocks and live content. Check selected wrapper length/parent against those inventories. Keep unavailable instrumentation distinct from an absent selection or a valid empty result; a required probe failure must fail the step.
6. Joint range expectations and independent seam traversal must implement the written contract. Sharing neutral data types/fixtures is fine. Importing production's decision algorithm as the expected result is not.

Required mutation/canary set, using reversible injection rather than editing/reverting dirty product files:

- No-op executor and delayed local `CORRUPTION` write.
- Wrong-but-converged owner/caret with a resolver agreeing on the wrong block.
- Dead text ID, stale length, mismatched parent pointer, hidden phantom target, inconsistent collapsed endpoints.
- Valid one-survivor range collapse must pass.
- Lost selection specifically during held-update release/heal must fail.
- One and nested microtask chains registering timers, timer → microtask → timer, frame → microtask → timer, and cancellation.
- A deliberately nonsettling callback chain must fail the bounded settlement check for that reason.

Assert each canary fails at the intended gate with useful evidence, not merely that some exception occurred. Preserve replay source/configuration, peer actions, deliveries, endpoint identities, semantic checkpoints, and failure fingerprints. Minimize without changing the failure class.

**Done when:** these canaries prove both rejection of corruptions and acceptance of valid recoveries. Claims in harness comments and `docs/editor-dst.md` match what is controlled, observed, and still unqualified.

## Work 5 — finite qualification and stopping rule

Use one bounded adversarial review after the units are integrated. The reviewer attacks the contracts and the matrix, including owner changes and timing boundaries, rather than simply rerunning fixtures. If delegated, give production selection, anchor semantics, and harness verification disjoint ownership; do not let two agents edit the same file concurrently.

### Required gate

1. Every known active finding and mandatory matrix row passes. Preserve exact content, block/inline identity where relevant, marks, children, selection direction/owner/bounds, and follow-up input. Inspect passive selections before any harness selection reset.
2. All required canaries fail for the intended reason; valid-case controls pass.
3. Run a bounded headless campaign: **32 fixed seeds, 24 commands per seed**, using the existing generator/peer infrastructure. Include the required three-peer pinned program separately. Do not build a general structural generator to satisfy this count; use the explicit matrix for structural breadth. Record realized case/actor/delivery coverage.
4. Retain the fresh-process replay proof for the controlled lane. Include representative new boundary programs in its evidence. Equal source/configuration/seed must produce equal declared traces and semantic checkpoints; exclude uncontrolled diagnostics and state the real-timer limitation honestly.
5. Run the default browser DST corpus against a fresh source-identified preview. Also qualify the two production repros and queued-release selection checks through the relevant browser collaboration/input paths on Chromium, Firefox, and WebKit. Synthetic composition fixtures qualify the input pipeline, not real OS IME behavior. Record actual engine versions and unavailable lanes; WebKit is not a claim of testing the Safari application.
6. Run required repository checks on the final candidate once. Use focused checks while editing. If a failure causes a change, rerun the affected gates and perform one final clean qualification; do not enlarge seed budgets to chase confidence indefinitely.

Existing commands to verify against current `package.json`:

```sh
pnpm check
pnpm lint
pnpm test -- --run
pnpm test:dom
pnpm test:crdt
pnpm test:typecheck
pnpm test:dom:typecheck
pnpm test:dst
```

The browser collaboration lane defaults to Chromium; `pnpm test:dst` alone is not evidence of three-engine collaboration. Existing selectors include:

```sh
COLLAB_DST_ENGINE=firefox pnpm test:dst:collab
COLLAB_DST_ENGINE=webkit pnpm test:dst:collab
```

Reuse default browser seed/step budgets for this pass. Run focused existing browser composition/selection specs affected by the change. If a public anchor API or serialization shape changes, include the relevant package/consumer and compatibility checks. Do not automatically invoke the much larger extensive campaign or unrelated performance benchmarks.

**Stop when the gate passes.** A clean gate supports this scoped hardening result; it is not a universal correctness claim or approval to ship publicly. Do not continue hunting unrelated defects after completion. Any required unresolved defect or unavailable required lane means the qualification is incomplete: preserve its evidence and report the precise limit rather than waiving the check or restarting an unbounded program.

## Deliverables and final report

- The implementation and focused regressions, with redundant affected repair code removed where justified.
- Updated normative selection/anchor/recovery entries in `docs/editor-delete-contract.md`; avoid duplicating competing specifications across files.
- Accurate harness scope in `docs/editor-dst.md` and applicable durable guidance in project `AGENTS.md`.
- One ledger entry in `docs/archive/crdt-v14-execution-ledger.md`: matrix coverage, canary outcomes, source/configuration identity, replay evidence, commands/results, and remaining limits.

Final response: **Outcome / Validation / Risks**. Explain which contract each change now satisfies, why the prior neighboring counterexample cannot recur through that mechanism, and what evidence supports the claim. Include any meaningful simplification of selection ownership. Distinguish production failures, oracle defects, and untested boundaries. Do not substitute a large green test count for the acceptance gate.

Begin by reconciling this instruction with the fixes you are already making. Preserve them; consolidate their contracts and qualification before expanding implementation.
