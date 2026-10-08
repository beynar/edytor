# Post-U12 implementation: correctness, typed nodes, and measured performance

Continue from the first agent's completed U00–U12 implementation pass. Implement
this follow-up; do not stop at an assessment or another plan. Preserve the
existing working tree and concurrent work. Reuse the implementation already
present; do not repeat the initial vendoring or runtime cutover. Performance
implementation is part of this task. Continue through it after the correctness
gate without waiting for another handoff or permission to begin that phase.

This refines the integration direction in the
[original plan](/Users/arnaud/code/edytor/docs/crdt-v14-implementation-plan.md)
and adds the fixes in the
[progress review](/Users/arnaud/code/edytor/docs/crdt-v14-progress-review-2026-09-20.md).
The earlier progress review is a historical snapshot. Read the current execution
ledger, move/text-ownership/rich-text ADRs, and the
[runtime cutover](/Users/arnaud/code/edytor/docs/crdt-v14-runtime-cutover.md),
[selection contract](/Users/arnaud/code/edytor/docs/crdt-v14-selection.md),
[browser proof](/Users/arnaud/code/edytor/docs/crdt-v14-browser-proof.md),
[Gate 3 findings](/Users/arnaud/code/edytor/docs/crdt-v14-gate3-review.md), and
[U11 measurements](/Users/arnaud/code/edytor/docs/crdt-v14-benchmarks.md).

## Updated starting point

The first agent reports a green unit/DOM/CRDT/Chromium matrix, selective undo,
anchor-based presence, migration and package checks. This follow-up review
inspected the implementation and reran the three ownership reproductions; it
did **not** rerun that full matrix. Treat prior counts as recorded evidence for
that revision, not proof of this follow-up's completion.

| Area                    | Current state and required action                                                                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime and exports     | The editor uses v14 and exports the editor/plugin surface again. Preserve this working cutover.                                                                                                                      |
| Selection and lifecycle | `DocAnchor`, selective undo, awareness, `Edytor.destroy()`, remount re-subscription and input repairs exist. Preserve their regressions during refactoring.                                                          |
| Projection              | U11 added `childrenIndex()` and skeleton/maintained-run snapshots in `takeSnap()`. Preserve these improvements; do not restore per-parent registry scans or eager full-content snapshots.                            |
| Ownership               | All three defects below still reproduce through the current facade after U12. Fix them despite the completed ledger and green existing suite.                                                                        |
| Typed-node integration  | `compat.ts`, fake Y-type adapters, synthetic `_item`, and the facade mutation-name Proxy remain. This is the new architectural work.                                                                                 |
| Correctness gates       | The corpus still broadly tolerates loss/crash categories. Unsupported application schemas still flow through providers after being flagged.                                                                          |
| Delivery proof          | Real browser collaboration exists through same-context BroadcastChannel; actual WebSocket browser transport and a mounted packed Svelte consumer remain distinct proof gaps. Firefox/WebKit evidence covers subsets. |

## Goal

Make Edytor's CRDT model own document-editing semantics and expose them through
typed nodes. Replace the current compatibility-based integration, fix the
reproduced ownership defects, and close the specific proof gaps below. Headless
clients, the live editor, and tests must exercise the same semantic
implementation. Then implement and measure the performance work below, including
justified vendored-engine patches. Deliver a working editor with demonstrably
less work in its editing paths, not only a list of optimization candidates.

Execution order: fix ownership and establish the strict correctness oracle;
complete typed-node integration and its functional proof; capture the corrected
baseline; implement and review performance changes; run final integrated gates.
Related work can proceed in parallel when it does not compromise that order.

Keep the pinned vendored `@y/y@14.0.0-rc.26` baseline and recorded provenance.
Preserve the public JSON model and existing editing behavior. Moves remain
mandatory: reorder, reparent, nest/unnest, and grouped moves must preserve payload
identity and concurrent edits. Continue the selected placement approach unless
correctness evidence requires revising it. Historical native move code is not a
requirement.

## Architectural direction

Assign responsibilities as follows:

| Owner                       | Responsibility                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Typed block/rich-text nodes | Semantic insert, delete, format, split, merge, move, and inline operations; stable logical identity; access to maintained content views                      |
| Document model              | Transactions, shared ownership and placement indexes, cycle resolution, cross-node operations, schema invariants, history integration, and view invalidation |
| Editor                      | Interpret Enter/Backspace and other input; plugin interception and defaults; selection, clipboard, composition, and DOM coordination                         |
| Svelte                      | Render maintained views and connect DOM positions to model positions                                                                                         |

The intended API shape is approximately:

```ts
// Illustrative API, not assertions about existing signatures.
const block = document.block(blockId);
block.insertText(position, 'hello');
block.format(range, { bold: true });
block.moveTo(destination);
const followingBlock = block.split(position);
```

Choose signatures from existing contracts. A node method may delegate a
cross-node mutation to its document owner. Do not duplicate algorithms between
the node API and the existing facade, or introduce another facade stack merely
to change call syntax. Extend or consolidate the existing semantic owners.

A logical block can display text from several backing YNodes. Its methods must
operate on **resolved displayed content**, not blindly call `insert()` on one
backing sequence. Specify offset units, boundary affinity, and position mapping
consistently with the existing editor contract.

Typed handles over existing nodes are acceptable. Subclassing raw `Y.Node` is
not required: the current decoder constructs ordinary YNodes. If specialized
construction is necessary, implement and test it for remote integration,
hydration, and reload. Do not add wire types solely to expose methods.

Remote updates and undo do not execute local command methods. The shared
integration/projection path must maintain the same ownership and view invariants
for those changes. Keep DOM and Svelte dependencies out of the CRDT model.

## Work unit 1 — Reproduce and fix ownership defects

Add hard regression tests before changing the algorithms. All three outcomes
below were independently reproduced again after the first agent's final report,
through the current `EdytorDoc` facade. The progress review contains a standalone
reproduction specification; temporary scripts are not prerequisites. Investigate
`src/lib/crdt/text/model.ts` and its placement/facade callers.

### A. Insertion after concurrent splits steals another block's text

1. Seed `b = abcdefghij`; create two independent replicas from its binary state.
2. Peer A splits `b` at offset 3, creating `early`.
3. Peer B concurrently splits `b` at offset 8, creating `late`.
4. Synchronize. Both must display `b = abc`, `early = defgh`, `late = ij`.
5. Insert `X` at offset 0 of `early`, then synchronize again.

Required result: `b = abc`, `early = Xdefgh`, `late = ij`.

The reproduced result was `early = Xdefghij`, with `late` empty. The left-edge
insertion elevated a covering claim while retaining its original end anchor,
reclaiming atoms now owned by another block. Preserve the actual resolved
coverage, including disjoint coverage; do not assume a historical claim still
owns its entire interval.

### B. Insertion into an empty head edits the tail

1. Start with `b = abcdefghij`.
2. Split `b` at offset 0, creating `tail`.
3. Insert `X` at offset 0 of `b`.

Required result: `b = X`, `tail = abcdefghij`.

The reproduced operation returned success but left `b` empty and appended `X`
to `tail`. Its revival interval started at a dynamic end anchor that advanced
past the inserted character. Correct the gap/anchor semantics for an empty
display backed by a nonempty sequence. Preserve atom identity.

### C. A valid block ID collides with a deletion sentinel

Initialize a paragraph with ID `dead` and text `abcdefghij`. Its text must remain
visible. The internal `DEAD = 'dead'` sentinel currently collides with this valid
caller ID. Represent the internal state distinctly from every valid block ID;
do not silently reserve or rewrite caller IDs. Fix the corresponding consumers
in the run view, placement/display-parent projection and anchor resolution; a
replacement in only one module leaves competing interpretations of deletion.

**Done when:** all three pass through the shared semantic API, independent
replica sync, and binary reload. Exercise both delivery orders and duplicate
delivery for A. Extend these same scenarios with relevant subsequent
insert/delete/format, inline-atom, and undo/redo cases. Assert expected ownership
and content, not only replica equality or total character retention. No
copy/delete workaround, serialization round trip, or rendered-output patch may
conceal an ownership defect.

## Work unit 2 — Integrate commands into typed nodes

Refactor the existing document, placement, and text owners to expose the node
contract above. Route editor operations through it, including grouped drag,
nest/unnest, split/merge, inline operations, normalization, and clipboard paths
that mutate existing content. Preserve plugin hook ordering, transaction origins,
void/island rules, and history grouping.

Remove the production dependency on `src/lib/crdt/compat.ts`, the fabricated
`YTextLike`/`YArrayLike`/`YBlockLike` objects, synthetic `_item` fields, and fake
root objects. Update consumers to explicit domain contracts. Preserve supported
editor APIs; document intentional changes to raw Yjs-facing APIs rather than
pretending v13 objects remain available.

Consolidate view maintenance. Current points to inspect include
`createAdapter()` in `text.svelte.ts`, the three adapters in `block.svelte.ts`,
and `FACADE_MUTATORS`/the facade Proxy in `edytor.svelte.ts`. Remove duplicated
semantic state and mutation-name lists used to keep it synchronized. Retain
Svelte reactivity and DOM state where they belong.

Preserve **read-your-writes inside a transaction**: commands may immediately
read content, lengths, or positions after a mutation. Replacing optimistic
adapter copies with stale cached views is a regression. Give the model one
coherent invalidation/read contract, with complete views at the existing public
notification boundary and correct behavior after remote updates and undo.

Expose maintained rich-text runs directly to rendering. Preserve annotation
boundaries, mark precedence and inheritance, inline atoms, stable view identities
where content is unchanged, and local decorations separate from replicated
formatting. Remove repeated delta/mark transformations where the model already
owns an equivalent representation. Additional storage or wire changes require a
demonstrated semantic or measured performance need.

Preserve the integration fixes established by the first agent:

- `DocAnchor.b` identifies the backing text's home block, which can differ from
  the displaying block. Keep affinity, deleted-content fallback, pending remote
  anchors and selective undo behavior when replacing the adapter API.
- Stable wrapper references and selection must survive reconciliation. A
  structurally keyed Svelte remount must reattach subscriptions; final destroy
  must release them exactly once without destroying caller-owned documents.
- Keep persistent marks separate from local syntax decorations, and preserve
  one-shot direct-insert versus contextual browser-insert mark behavior.
- Keep proxy-safe JSON cloning and the documented JSON payload contract.
- Retain the DOM fixes for Svelte's empty text anchors, foreign wrapper
  injection, IME/code-line suffix preservation, grouped drag, and the marked
  inline undo/redo selection-restore race. Refactor through their tests.

**Done when:** the editor and headless API use the same implementation; moved or
split content stays editable through sync and reload; the compatibility bridge
is removed from live paths; maintained views reflect local, remote, and history
changes without competing semantic mirrors. A temporary bridge during the
refactor is acceptable, but leaving it as the final architecture is not.

## Work unit 3 — Make the correctness gates meaningful

Fix the randomized harness in `src/tests/crdt/random/`. It currently permits
`lost-edit`, `unrecoverable-loss`, and `upstream-engine-crash` too broadly.

For production-model schedules composed of legal supported operations, an
unexpected exception or actual lost edit must fail. An engine stack frame does
not justify accepting a crash. Make the oracle distinguish explicit causally
valid deletion, movement to a different owner, and actual loss. Keep deliberately
lossy schedules and exact known historical failures in a separate diagnostic
suite; do not count them as successful production correctness tests. Preserve
minimal failing seeds. Prove the gate fails on a deliberately injected crash or
loss within the test harness, then remove the injection.

Classify the reported residual `lost-edit`/`unrecoverable-loss` cases by replayed
seed and violated invariant. Counts alone do not show whether an edit was
legitimately deleted, ownership changed, the oracle was wrong, or data was lost.
Preserve the exact seed-86/140 upstream crash reproductions in the diagnostic
lane. The reported provider probes support a bounded reachability claim; they
do not justify accepting all future crashes with similar stack frames. Establish
the strict gate before accepting the typed-node refactor.

Enforce the planned unsupported-schema boundary in providers. The review found
unsupported application versions applied or persisted before a mismatch was
reported. Transport generation 14 alone does not distinguish application schema
versions, and replicated `meta.v` cannot reliably negotiate capabilities.

Use the smallest boundary consistent with existing providers, such as explicit
session/storage schema metadata or validated staging. Reject incompatible data
before it mutates the live application document, enters accepted persistent
state, or is rebroadcast. Do not reject valid incremental updates merely because
they omit the schema attribute. Test websocket, BroadcastChannel, and IndexedDB
paths, including failure events, absence of false `synced`, and recoverability
of the original data. Keep migration non-destructive.

**Done when:** the strict suite catches unexpected failures, ownership tests
assert intent, and incompatible-schema tests prove no accepted-state mutation.
Verify and document the supported websocket server topology: opaque relay tests
do not prove compatibility with a server interpreting the old protocol.

## Work unit 4 — Extend the missing integration proof

Reuse the completed U08–U12 implementation and tests. Rerun affected scenarios
after the typed-node changes; do not rebuild selection, history, lifecycle or
migration from scratch. Add coverage for the gaps below.

**Actual WebSocket path.** Add a local test relay speaking the documented
supported topology and connect independent browser contexts with separate
storage. Disable BroadcastChannel so it cannot conceal socket failures. Exercise
editing through a partition and reconnect, application-message delay/duplication
or replay in the harness, awareness and selective undo. Include moves and
split-then-type ownership cases. TCP preserves order on an open connection;
distinguish deliberate harness replay/permutation from transport guarantees.
Assert expected content and identity as well as convergence. This is local test
infrastructure, not a hosted collaboration deployment.

**Packed Svelte consumer.** Extend `tests/packed-consumer/` with an actual
Vite/Svelte consumer of the tarball that builds and mounts the editor, edits
content, uses the supported plugin/readonly surface and tears down. Retain the
existing Node runtime, declaration and single-engine checks. The current
`smoke.js` deliberately expects plain Node's root import to reject `.svelte`,
then exercises the headless subpaths; bundler-mode TypeScript checking does not
compile or mount a Svelte consumer. Preserve the legitimate distinction between
the component root and Node-safe CRDT subpaths. Test SSR through the supported
Svelte build path, not by requiring plain Node to load `.svelte` files.

**Browser matrix.** Preserve the existing Chromium and three-engine
collaboration coverage. Run the configured full supported matrix at the final
gate; report failures or prerequisites explicitly. A green Firefox/WebKit
collaboration subset must not be described as a green full browser matrix.

**Done when:** actual editing, synchronization, history, reload, and package use
work through the typed model and the new socket/packed-consumer tests prove the
specific previously untested boundaries.

## Work unit 5 — Establish a trustworthy performance baseline

Preserve U11's measured improvements. Once units 1–4 establish a correct
integrated model, continue directly into this performance phase. Use the
[Diamond Types analysis](/Users/arnaud/code/edytor/docs/diamond-types-performance-source-notes.md)
for source-backed techniques. Its historical speedups are not Edytor targets.
Keep the correctness fixes separately reviewable from representation changes.

Correct these measurement/interpretation issues first:

1. `bench/lib/workloads.js` still returns move `updateBytes` to `measure()`,
   which labels numeric return values as `remote` timing. Separate bytes and
   milliseconds, invalidate affected timing fields, and rerun those measurements.
2. U11's roughly 1.6 ms `M.insertText()` measurement includes our `ownView()`:
   registry collection, ownership and placement resolution. It does not isolate
   vendored item integration. Instrument those costs separately before choosing
   an engine patch. The roughly 0.015 ms raw-node typing benchmark and 3.7 ms
   facade-plus-change benchmark measure different paths; neither measures a
   complete browser keystroke.
3. The 123 KB/44 KB gzip figures are bundle estimates with specified external
   dependencies and CSS handling. Retain that definition and add measurements
   from the actual packed consumer; do not present them as full download totals.
4. Roughly 70 B per seam insertion is measured for the current claim-rewrite
   algorithm. It is not a lower bound for every possible ownership design.
   Measure caret-advancing typing separately from repeatedly inserting at the
   same seam. Fix the ownership bug before assessing rewrite/coalescing changes.

Save a reproducible corrected baseline before tuning: identify the source state,
hardware/runtime, build mode, fixtures, seeds, warmup and sample counts. Preserve
it without resetting or discarding the working tree. Use independent equivalent
fixtures and histories for before/after runs, including cold and warm states.
Repeat comparisons sufficiently to distinguish gains from the reported U11
noise. Set numerical acceptance/regression budgets from this baseline before
tuning; do not invent hardware-independent latency promises.

Separate engine mutation, ownership, placement, maintained runs, anchor lookup,
change callbacks, Svelte/DOM work and complete browser interaction. Report p50
and p95, sample distributions, retained memory after equivalent history/GC/undo
lifecycles, update bytes, load/catch-up, and minified/gzip/Brotli bundle sizes.
Use deterministic work counters to explain scaling; keep instrumentation out of
the production hot path.

Use these benchmark dimensions independently, rather than one giant fixture:

- 100, 1,000 and 5,000 blocks with the same edited paragraph; depth up to 100.
- 1k, 10k and 100k UTF-16 text units with a fixed small number of ownership
  boundaries; then hold text length fixed and increase competing claims/slices.
- Existing dense-mark and 250-inline shapes; fresh text versus heavily edited,
  fragmented histories; local typing, distant edits, delete, paste and format.
- Same-parent/group moves, reparenting, repeated split/merge and seam typing,
  anchor resolution, selective undo, remote bursts and offline reconnect.
- The actual packed Svelte consumer, with unchanged supported callbacks and
  normal rendering. Report explicit full-document serialization separately.

**Done when:** baseline artifacts and accurate units make each subsequent
comparison reproducible. Do not treat a raw-node microbenchmark as editor latency.

## Work unit 6 — Replace dense ownership rows with intervals

**Issue.** `computeOwnership()` and the run view's `buildRow()` fill owner/claim
arrays position by position, then scan them to recover contiguous segments. Yjs
can store text in spans while our projection still expands its length into
per-character metadata. This is a concrete representation cost to remove.

**Implement.** Keep resolved ownership as ordered, disjoint intervals per
backing text, including the winning claim and required provenance. For example:

```text
Backing text: abcdefghij
Dense owners: A A A A B B B B B B
Intervals:   [0,4) → A/claim1; [4,10) → B/claim2
```

A single winning claim over 100,000 positions should need one ownership
interval, independently of the text payload and character identities. A sweep
over resolved claim endpoints using the corrected winner rule is one suitable
approach; choose the simplest representation and algorithm that meet the
workloads. Do not mandate a tree before measuring whether one is needed.

Preserve the complete semantics established in unit 1: generation/start/stamp
ordering where retained by the fix, winning-record identity, disjoint coverage,
merge-claim routing and cycles, deleted/unknown owners, unresolved anchors,
empty ranges, and `maxG` behavior. `maxG` may depend on claims that do not win a
visible interval. Coalesce only equivalent owner/claim/provenance neighbors.
Absolute interval offsets are derived indexes; replicated anchors remain stable
atom identities with their existing affinity.

Move all production consumers to interval queries: edit/split/merge/format,
flattening, maintained runs, emission-seam fallback and selection/presence anchor
resolution. A binary search/intersection can answer point or range queries;
nearest-owned-position queries must also use interval boundaries. Recreating
dense arrays inside these consumers would defeat the change.

**Review.** Retain the corrected dense algorithm as a small-document test oracle
outside shipped code. Compare ownership and winning claims for every position
on bounded fixtures, plus exact semantic outcomes after edits, remote delivery,
reload and undo. Include the three regressions, overlapping claims with the same
display owner, gaps, equal endpoints, multiple backing texts, Unicode and inline
atoms. Expected-result tests remain necessary because two implementations can
share a mistaken assumption.

**Done when:** no production ownership array grows merely with covered text
length; fixed-boundary work/storage counters stay bounded as length increases;
the dense oracle and strict corpus agree; measured memory/latency improve on the
target workloads without an unacceptable fragmented-history regression. Do not
claim all ownership queries are constant time.

## Work unit 7 — Share incremental indexes across commands and rendering

**Issue.** `M.insertText()` currently calls `ownView()`, which collects the
registry, computes ownership and resolves placements. `takeSnap()` also builds
a document skeleton at change time. The run view already tracks dependencies,
but commands still reconstruct related state independently.

**Implement.** Consolidate the indexes under the existing document owner so
typed-node commands, maintained runs, anchors and `DocChange` read one consistent
model. Reuse the existing facet/dependency information. Track backing-text,
slice, owner, placement and block-metadata changes; invalidate their actual
dependents, including blocks sharing backing text and merge-claim chains.

Make local writes visible to subsequent reads in the same transaction. Remote
integration, undo/redo and nested operations must drive equivalent updates.
Transaction-completion notifications must expose a coherent final state. Give
each cache one owner and clear teardown; remove the obsolete duplicate caches,
manual optimistic mirrors and mutator-name Proxy machinery.

For content-only changes whose dependencies prove structure unchanged, update
the affected content and `DocChange` state without scanning unrelated blocks or
building a fresh tree skeleton. Keep snapshot state current across consecutive
fast-path transactions and a later structural edit. Preserve the existing
full-value callback contract, measuring its explicit serialization separately.
A documented wider fallback for genuinely structural changes is acceptable;
silently rebuilding everything for ordinary typing is not the target behavior.

**Review.** Differentially compare incremental state and emitted changes with a
fresh projection of the corrected model. Test local and remote sequences,
mid-transaction reads, content-only then structural operations, shared-backing
edits, pending-anchor integration, undo/redo, detach/reattach and final destroy.
Exercise the recent selection-restore race rather than assuming model equality
proves the DOM correct.

**Done when:** editing one independent paragraph visits/recomputes its actual
dependents, not every unrelated block; the counters hold from 100 to 5,000
blocks; unchanged views preserve identity; measured command-plus-change and
browser latency satisfy the recorded budgets with no cache-lifetime leak.

## Work unit 8 — Read and update formatted ranges directly

**Issue.** `itemsOfRange()` calls `toDelta().toJSON()` on the backing text to read
a slice. Several slices can repeatedly materialize the same full sequence. The
fresh render currently preserves read-your-writes, so swapping in a stale
commit-time cache is invalid.

**Implement.** Expose a range iterator or a transaction-aware maintained view
from the semantic owner, with a narrow vendored-engine extension if required.
Read the requested formatted spans and inline atoms directly, reusing mark
identities and unchanged runs. Share required prefix/format-state work across
related range reads. Remove redundant delta-to-JSON-to-run-to-mark conversions
and update only the affected rendering ranges where the contract permits it.
Do not introduce another complete text store as a shortcut.

**Review.** Compare reads and edits with fresh rendering after every step of a
multi-operation transaction. Test mark boundaries, inherited and cleared marks,
inline atoms, local decorations, split-owned content, remote format changes and
history. Include repeated small slices of one long, heavily formatted backing
text and immutable snapshot behavior after later mutations.

**Done when:** those range reads avoid repeated full backing-text materialization,
rendered output and selections remain correct, and allocation/work counters and
measured latency demonstrate the reduction. If units 2/7 already achieve this,
prove that path instead of adding another implementation.

## Work unit 9 — Patch remaining engine costs and reduce shipped overhead

Re-profile after units 6–8. Implement justified internal patches in this same
task when remaining costs warrant them; this phase is not merely a proposal.

The concrete lookup candidate is `YNode.applyDelta()` starting from `_start`
and relative-position resolution walking left to sum visible length. Compare a
formatting-aware cursor/checkpoint approach with an index of visible span lengths
on fragmented long paragraphs, distant edits and multiple anchors. A cursor
needs correct formatting state as well as position. Preserve UTF-16 indexing,
inline widths, zero-width format markers, renderer-dependent visibility where
supported, item split/coalescing, remote integration, deletion, GC and undo.
Try the smaller change first; a whole sequence-store rewrite is not a prerequisite.

If memory profiles identify a remaining allocation cost, test compact local
handles/storage for derived metadata. Local handle order must never become CRDT
conflict order. If catch-up is dominated by derived work, batch it within valid
transaction boundaries while preserving observer and history behavior.

Measure actual consumer imports and remove demonstrably unused internal code
and redundant conversions. Preserve supported exports, encoders/decoders,
numeric type references, migration, providers and retained history. A limited
bundle win can still be worthwhile; “keeping upstream byte-identical” is not by
itself a reason to reject a measured patch. Report size tradeoffs explicitly.

The earlier report's “vendor internals are not ours to patch” is not a project
constraint: vendoring was explicitly chosen to permit justified patches.
Keep each engine change narrow and reproducible, record its rationale and patch
in the vendor manifest, and regenerate declarations through the established
source process. These optimizations preserve replicated identities, encoding
and conflict semantics. Rust/Wasm replacement, a new wire protocol and adopting
Diamond Types' causal log are outside this task.

**Review.** Use differential replay against the corrected unoptimized model and
unchanged engine where applicable; test updates exchanged between patched and
baseline peers. Compare content, marks, ownership, anchors and selective undo,
not merely JSON equality. Run affected upstream tests and the strict model and
provider corpus. Review every invalidation path introduced by an index and its
memory lifecycle. Use an independent reviewer for the algorithm/invalidation
changes and for benchmark comparability; verify findings before acceptance.

**Done when:** each implemented patch has reproducible benefit beyond measurement
noise and passes semantic/interoperation checks. For a candidate that profiles
show is unnecessary, or whose controlled experiment loses overall, record the
evidence and omit/revert only that experiment. Do not retain complexity solely
to tick a checkbox, or defer a demonstrated remaining bottleneck merely because
it is inside the vendored engine.

## Performance acceptance and final review

Units 6–8 are implementation outcomes. A documented proposal alone does not
complete them. If an earlier refactor already removed the exact cost, demonstrate
that with the same counters and benchmarks. Unit 9 uses profiles to choose
additional patches; it does not require every possible optimization.

For each change, record the removed work, implementation owner, correctness
oracle, before/after distributions, retained-memory result, bundle/update-byte
effect and any regression. Keep independent runs comparable and report cold
costs as well as warm wins. Stable node identities, boundary ownership, marks,
anchors, selective undo, schema gates and current supported features must remain
correct. Moves/splits/merges must retain identity without re-encoding retained
text as new payload.

After targeted review, run the final integrated gates on the optimized tree.
Provide a performance report with commands and durable artifacts. Failure to
meet a stated target must be reported as such, not relabeled complete because
the code is cleaner or a microbenchmark improved.

## Validation and handoff

Run narrow tests during each unit. At final integration, run the repository's
release gate and `pnpm test:crdt` explicitly; `release:check` currently omits the
CRDT suite. Use `pnpm test:crdt:extensive` for the vendor checks it enables and
run `tests/packed-consumer/run.sh`, the new mounted-consumer/socket checks, and
relevant benchmarks. `release:check`
currently includes checking, lint, model and DOM suites, test typechecking,
serial browser tests, and the build/package step; verify the scripts before
execution. Do not rerun successful expensive gates without a relevant change.

Never mark a failing, skipped, or unrun requirement complete. If an environment
prerequisite blocks a gate, report the exact limitation and remaining proof.
Do not weaken assertions or hide failures to produce a green summary.

Update the ledger with follow-up units and explicitly reopen any original
requirement contradicted by a failing reproduction. Preserve historical results
as historical results. Update relevant ADRs and project documentation when
contracts change. Preserve unrelated work; do not reset the repository, publish
a package, deploy, or modify production data.

Finish with **Outcome**, **Validation**, and **Risks**: describe the semantic
ownership achieved and compatibility code removed, link each fixed regression,
report actual commands/results and measured performance, and identify any
remaining correctness, integration or performance blocker. Completion includes
the implemented interval/index/range-read improvements and evidence for retained
engine patches, as well as the verified working editor.
