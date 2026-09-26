# Next implementation: CRDT correctness and acceptance hardening

## Goal and context

Make the completed v14 follow-up safe to accept while preserving its demonstrated
performance gains. This is a bounded repair of the current implementation, not a
new engine rewrite.

Read [the independent review](./crdt-v14-follow-up-review-2026-09-21.md) first.
Its R1–R8 findings supersede conflicting pass claims in the earlier gate reports.
The minimal examples are reproducible on the reviewed working tree. Also read
the current repository instructions, the existing follow-up prompt, the vendor
manifest, and the ownership/history/provider contracts relevant to each unit.

Keep the accepted architecture: pinned vendored v14 engine, semantic typed
handles, document-owned ownership/placement/history, interval representation,
shared incremental indexes, direct formatted ranges, and editor-owned input and
selection. Keep the removed compatibility layer removed. Preserve concurrent
work. Do not publish, deploy, migrate real data, or discard existing work.

The current review identifies three P1 defects: P4 corrupts formatting, IndexedDB
compaction deletes refused rows, and undo restores text into the wrong paragraph.
Fix these before additional performance tuning. Public snapshot isolation and
transaction notification behavior also require repairs.

## Order and ownership

First capture permanent failing regressions. Units 1–3 can then proceed
independently with explicit file ownership; units 4 and 5 harden the shared
model/publication and evidence boundaries. Integrate those changes before the
final transport and performance acceptance work. Use an independent reviewer for
P4, persistence deletion, and undo semantics. Verify their findings yourself.

### Unit 0 — Pin the reviewed failures

Add behavior tests for all confirmed production defects before fixing them:

- The 300-character P4 reproduction, through both raw engine and facade.
- Refused v99 persisted bytes surviving explicit and timed compaction.
- `hello world` split, tail deletion, undo restoring `world` to the tail.
- Mutation attempts through public projections/items cannot change live state.
- Mid-transaction reads never publish intermediate block subscriptions.

Add runner fault-injection tests for unrequested deletion and delayed transfer
into an unrelated split destination. These must show the current runner's false
pass and become passing assertions that the repaired runner rejects the injected
behavior. Do not leave them as accepted expected failures.

**Success:** each reproduction has a precise expected outcome and fails against
the reviewed implementation for its stated reason. Retain the existing tests;
amend tests that explicitly bless incorrect undo ownership.

### Unit 1 — Repair P4 format snapshot validity

Primary files: vendored `src/ynode.js`, related marker invalidation code,
`UPSTREAM.md`, `marker-seed.test.ts`, and Gate F2 vendor tests.

`updateMarkerFormats` must not blindly apply a format change across intervening
same-key markers. Identify exactly which cached snapshots remain valid after a
local insertion. Use conservative invalidation when that cannot be established;
try the smallest safe repair before adding another index.

Retain the format-aware optimization only where it preserves the reference
semantics. Cover distant edits before an existing formatted span, return edits
inside it, mark clears, alternating keys, zero-width boundaries, deletion,
remote integration, undo, and item split/coalescing. Test sparse long spans as
well as densely alternating single-character formats.

Compare enabled/disabled-marker operation replay after **every operation**,
including text, marks, positions, and encoded state when fixtures share IDs.
Also exchange updates between patched and reference peers; that is a separate
check, not a substitute for semantic replay.

**Success:** the original 50 characters retain bold, all bounded randomized
reference replays agree, affected upstream checks pass, and the retained patch
has a measured benefit after the repair. Update the patch manifest and performance
claims. A conservative fallback is preferable to publishing wrong formatting.

### Unit 2 — Preserve rejected durable data during compaction

Primary files: `providers/indexeddb.ts`, schema/persistence tests, provider docs.

Track whether stored rows were actually admitted and are represented in the
compacted snapshot. The fetch cursor and the safe compaction boundary are not
equivalent after refusal. A clean live schema must not authorize deleting
unsupported rows.

Choose the smallest solution consistent with the current provider contract:
blocking compaction for a refused hydration may suffice; a more selective scheme
must prove it preserves every excluded row and its dependencies. Do not introduce
an automatic migration or delete incompatible data. Ensure the returned promise
settles only after the storage transaction completes, and that failures surface.

Exercise explicit compaction, threshold-triggered compaction, mixed supported
and unsupported rows, dependent/out-of-order updates, close/reopen, and repeated
attempts. Use fake-indexeddb and isolated browser databases only. Preserve normal
compaction efficiency for fully admitted state.

**Success:** refused bytes remain byte-for-byte recoverable after every supported
maintenance path; `whenSynced`/load errors remain truthful; accepted updates
persist and reload normally; refused updates never enter the live projection or
rebroadcast path.

### Unit 3 — Make undo restore semantic ownership

Primary owners: document history integration, text ownership/anchors, and editor
selection restoration. Avoid putting ownership repair in DOM code.

Sequential behavior is required: delete from a split paragraph, then undo,
restores the original displayed text to that paragraph. Conservation across the
document is insufficient. The model must represent the restored ownership in
replicated state so receivers and reloaded clients derive the same result.

Design the repair around the existing undo machinery and ownership records.
Inspect the restored item identities and history grouping before choosing the
mechanism. Do not rely solely on local `redone` pointers or replace the whole
document with a historical JSON snapshot. Preserve concurrent remote edits and
existing move/split/merge identity behavior.

Write down the policy for a concurrent move, split, merge, or deletion of the
original owner; then encode that policy in expected-result tests. At minimum cover
head/tail/full-range/partial deletion, disjoint same-backing ranges, multi-backing
merged content, marks, inline atoms, undo/redo cycles, binary reload, and a peer
that never performed the original operation. Verify editor selection remains in
the restored logical block.

**Success:** the simple reproduction returns `b="hello "`, `tail="world"` on all
replicas and after reload. Concurrent history tests satisfy the explicit policy,
foreign edits survive, and one user action remains one undo group. If the design
requires a wire/schema contract change, identify it before implementing it rather
than silently changing compatibility.

### Unit 4 — Isolate public reads and publish only complete transactions

Primary files: `nodes.ts`, `edytor-doc.ts`, `placement/model.ts`, `text/runs.ts`,
and the direct range reader where needed.

Separate internal borrowed range data from public snapshots. Audit the actual
publication paths `project()`, `contentItems()`, `.items`, `.runs`, and content
JSON. Preserve mutable detached JSON exports where already promised; use stable,
deeply protected shared values for maintained immutable views. Reuse the current
clone/intern owners instead of adding a second payload system. Avoid cloning an
entire backing text for a small public range.

Mutating a returned value must either be rejected or affect only that detached
value. It must never silently alter replicated content, markers, cached runs, or
another previously returned snapshot. Check nested object/array mark values and
inline data, with proxy-backed caller input where supported.

Keep read-your-writes within transactions. Decouple recomputation for a read from
subscriber publication: observers should receive the final coherent state at
the documented transaction boundary. Test repeated reads, nested operations,
multiple blocks, change-then-revert transactions, remote updates, and undo/redo.
Preserve unchanged run identities and existing teardown behavior.

**Success:** the aliasing probes leave engine state, cached views, and peers
unchanged; the `a → ab → abc` transaction publishes only its completed state;
document callbacks remain complete; targeted DOM/selection tests and incremental
invalidation counters still pass.

### Unit 5 — Make the strict oracle check intent

Primary files: the random runner/generator, model/doc adapters, and harness docs.

Capture the intended affected atoms and ownership transitions before a mutation.
Use stable identities and an independent bounded reference where possible. A
tombstone proves deletion occurred, not that deletion was requested. A destination
created by an unrelated split proves nothing about a particular atom's transfer.
Do not derive every expected outcome from the same post-operation projection
whose correctness is being tested.

Replace run-global legitimate-owner permissions with atom/operation-related
evidence. Correlate loss exemptions with the actual lost writes and dependencies,
including resurrection and divergence checks. Keep destructive stale-backup
experiments in a clearly identified diagnostic/loss-injection lane; ordinary
delivery/reordering/partition-healing runs must enforce full convergence and
intent invariants without a broad exception.

Add undo/redo to bounded production schedules and include assertions for marks
and inline payloads, not only text survival. Keep expected-result fixtures for
the reviewed bugs; differential implementations can share a mistaken assumption.

**Success:** both new fault injections hard-fail on otherwise healthy schedules,
including when an unrelated lossy event occurs elsewhere. Legal scheduled
deletions/transfers continue to pass. Every retained loss exemption explains its
affected atoms. Report actual seeds, adapters, operations, skips, and diagnostic
aborts separately; 470 checks across several lanes are not 470 independent
production schedules.

### Unit 6 — Close transport proof and documentation gaps

Primary files: provider docs, `collaboration-websocket.spec.ts`, relay tests, and
the existing mounted packed consumer.

Correct the claim that upstream `setupWSConnection` becomes an opaque relay when
persistence is disabled. Document the exact supported relay behavior and identify
the server actually tested. Do not add hosted infrastructure merely to close a
documentation gap.

Extend the real-socket test to at least three independent browser contexts with
BroadcastChannel disabled. Exercise concurrent split/edit/move, partition and
reconnect, duplicate/reordered relay delivery, and selective undo. Use semantic
assertions for content ownership and marks, along with convergence and absence
of false sync success. Run a focused cross-engine case and the existing transport
matrix after relevant changes. Recheck the freshly packed consumer.

**Success:** the corrected model survives real three-client histories and reload;
refused states remain refused; the documented supported topology matches the
executed test. Record the exact limits of the local relay proof.

### Unit 7 — Measure the repaired editor and choose further optimization from evidence

Primary files: `bench/browser.js`, benchmark instrumentation/artifacts, and the
existing packed Svelte consumer.

Instrument stages within the **same** trusted keystroke: input/selection work,
semantic transaction, maintained-view publication, DOM flush, and frame scheduling.
Use comparable start/end points for alternative paths. Do not subtract independent
medians with different endpoints. Label rAF timing accurately; use suitable trace
evidence if claiming completed paint. Await every sample and report timeouts.

Repack the repaired sources and identify source content, tarball, consumer build,
runtime, browser, hardware, and workload in the artifact. Hash content rather than
only git status filenames. Distinguish counts, bytes, and milliseconds, and label
patched engines correctly. If a benchmark times insert plus cleanup deletion,
report it as that combined operation.

Measure actual mounted typing, deletion, formatting, paste, remote bursts, undo,
and reconnect on small, 1,000-block, and 5,000-block documents; include long
formatted/shared backing texts and a churned history. Separate explicit
full-document export callbacks from the baseline editor path. Report cold/warm
costs, p50/p95, allocation/retention, update bytes, and actual packed bundle bytes.
Retain deterministic work counters alongside noisy timing data.

**Success:** the measurements support the claimed bottleneck on the repaired
current build. Preserve or explicitly explain changes to the interval/shared-index
gains and existing budgets. Then implement only a bounded optimization whose
measured cost and semantics justify it, with before/after evidence and focused
review. If no material bottleneck remains at the target scale, record that result
and stop. Do not use the unsupported “3.8 ms input pipeline” inference to choose
the next target.

## Final acceptance

Run focused checks during each repair. After integration, run `pnpm release:check`,
`pnpm test:crdt`, `pnpm test:crdt:extensive`, the packed-consumer check, and the
corrected relevant benchmarks. Avoid repeating unchanged expensive gates.

An independent review must challenge format-cache validity, admitted-versus-stored
state, semantic history, public snapshot isolation, and oracle fault injections.
The new counterexamples must have explicit expected-result assertions. Do not
reclassify a semantic failure as acceptable merely because replicas converge or
the same behavior existed before the optimization.

Update the ledger, contracts, vendor manifest, and applicable project guidance
only where the repaired behavior changes durable knowledge. Report **Outcome**,
**Validation**, and **Risks**, with links to regressions and comparable artifacts.
State any failed or unrun requirement directly. Acceptance requires closure of
the confirmed defects and credible evidence for retained optimizations.
