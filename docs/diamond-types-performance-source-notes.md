# Diamond Types: performance opportunities for Edytor

Research date: 2026-09-20. Diamond Types source is pinned to [`89ae3a0ab8d941a2885e6ec89d094bc9ce9d2922`](https://github.com/josephg/diamond-types/commit/89ae3a0ab8d941a2885e6ec89d094bc9ce9d2922), the default-branch HEAD inspected for this note. The comparison target is Edytor's vendored `@y/y@14.0.0-rc.26`. This note records source evidence and proposed applications; it does not report a benchmark or change the implementation plan.

## What the article establishes

The article was published on July 31, 2021. Its headline compares native Rust with `Automerge 1.0.0-preview2`, not with current Yjs. The workload replays roughly 260,000 local edits, ending near 100,000 characters, without concurrent merging. It used a Ryzen 5800X, Node 16.1 and Rust 1.52. The reported Yjs baseline was `13.5.5`; native and JavaScript-to-Wasm results differ substantially. Its useful lessons are batched spans, indexed sequence lookup, compact allocation, and separating metadata from content. It already credits Yjs with span compression and cached positions. These measurements establish neither a present-day browser speedup nor rich-text correctness. [Original article](https://josephg.com/blog/crdts-go-brrr/).

## Current source is different from the 2021 implementation

The README describes the supported product as a plain-text CRDT, says broader JSON-style types are under development, and warns that the Cargo package is outdated. Current source nevertheless contains an `OpLog` and `Branch` with map and text storage, alongside the established text-specific `ListOpLog`/`ListBranch` API. Thus “plain-text library with ongoing broader-type development” is more accurate than either “no map code” or “a complete rich-text replacement.” The inspected material does not establish Edytor-compatible marks, tree moves, text ownership or provider contracts. [Pinned README](https://github.com/josephg/diamond-types/blob/89ae3a0ab8d941a2885e6ec89d094bc9ce9d2922/README.md), [current general structures](https://github.com/josephg/diamond-types/blob/89ae3a0ab8d941a2885e6ec89d094bc9ce9d2922/src/lib.rs#L390).

`INTERNALS.md` distinguishes original positional operations, the temporary merge representation, and transformed operations applied to a materialized document. It explicitly labels the subsequent long description of persistently stored merge structures as old. Use the current implementation to resolve those details; do not present the old article's tree size, Ropey dependency or persistent representation as current facts. [Internals document](https://github.com/josephg/diamond-types/blob/89ae3a0ab8d941a2885e6ec89d094bc9ce9d2922/INTERNALS.md#L13).

## Concrete techniques and transfer limits

| Technique                                           | Verified current implementation                                                                                                                                                                                                                                                                                                                                                                                                                                       | Application to the vendored Yjs engine                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compact local identities                            | `LV` is `usize`, assigned locally; peers can assign different local positions to the same operations. `AgentId` is `u32`. Local versions must be converted before exchange or persistence. [ID definitions](https://github.com/josephg/diamond-types/blob/89ae3a0ab8d941a2885e6ec89d094bc9ce9d2922/src/lib.rs#L243), [ordering contract](https://github.com/josephg/diamond-types/blob/89ae3a0ab8d941a2885e6ec89d094bc9ce9d2922/src/lib.rs#L163).                     | **Borrowable:** dense local handles in derived indexes, with a stable mapping to Yjs identities. **Boundary:** local handle order must not replace replicated identity or conflict ordering. Changing IDs in updates, relative positions or undo records is a protocol change.                                                                                                |
| Run-length encoding                                 | `ListOpLog` documents a structure-of-arrays representation intended to compress operation fields separately. Current stored operations use `RleVec<KVPair<ListOpMetrics>>`; inserted content is kept in a separate operation context. [Operation-log representation](https://github.com/josephg/diamond-types/blob/89ae3a0ab8d941a2885e6ec89d094bc9ce9d2922/src/list/mod.rs#L83).                                                                                     | **Borrowable:** represent long contiguous ownership or formatting spans as ranges instead of allocating one derived row per character. Coalesce only semantically equivalent neighbors. **Boundary:** changing Yjs's causal operations into Diamond Types' log schema is not this optimization.                                                                               |
| Indexed sequence lookup plus cursors                | `ContentTree` stores leaves and nodes in vectors, maintains subtree lengths, and caches a cursor. Its position lookup descends through child widths; leaves contain fixed arrays of spans. [Tree layout](https://github.com/josephg/diamond-types/blob/89ae3a0ab8d941a2885e6ec89d094bc9ce9d2922/src/ost/content_tree.rs#L34), [position lookup](https://github.com/josephg/diamond-types/blob/89ae3a0ab8d941a2885e6ec89d094bc9ce9d2922/src/ost/content_tree.rs#L997). | **Borrowable:** an index over visible span lengths for repeated offset queries, with a nearby-edit cursor. For Edytor, counts must preserve UTF-16 offsets, inline-object widths and zero-width formatting records. **Boundary:** reindexing cannot alter sequence integration, boundary affinity or ownership winners.                                                       |
| Fewer allocations and better locality               | The tree code groups nodes into vectors and refers to them by integer indexes. The module rationale identifies this layout as preferable to separately allocated pointer nodes in its Rust implementation. [Layout rationale](https://github.com/josephg/diamond-types/blob/89ae3a0ab8d941a2885e6ec89d094bc9ce9d2922/src/ost/mod.rs#L1).                                                                                                                              | **Borrowable:** reduce temporary arrays, repeated conversions and duplicate indexes; evaluate compact numeric storage where profiling identifies allocation pressure. **Limit:** JavaScript arrays of objects do not provide Rust's packed layout. Typed-array arenas require explicit capacity and invalidation rules; their benefit must be measured in the target browser. |
| Separate retained history from materialized content | `ListBranch` stores a version and `JumpRopeBuf` content. `ListOpLog` can exist without a checked-out document; branches can be materialized when needed. [Branch/log separation](https://github.com/josephg/diamond-types/blob/89ae3a0ab8d941a2885e6ec89d094bc9ce9d2922/src/list/mod.rs#L53), [log-only use](https://github.com/josephg/diamond-types/blob/89ae3a0ab8d941a2885e6ec89d094bc9ce9d2922/src/list/mod.rs#L133).                                            | **Borrowable:** give each derived Edytor view one owner and update affected spans instead of rebuilding it repeatedly. **Limit:** adding another full text copy can increase memory and work. Replacing Yjs's authoritative storage with Diamond Types' history model would be an engine redesign.                                                                            |

These applications are proposals, not measured findings about Edytor. A derived index or cache can preserve the existing update format. Replacing the replicated operation vocabulary, causal-history representation or integration semantics cannot be classified as a local data-structure optimization.

## Fast-forward is a causal optimization

Current Diamond Types has a distinct fast-forward path: `ListBranch.merge` directly applies stored positional operations for a range classified as `FF`, while other changes first receive transformed positions. The planner's validation requires the fast-forwarded operation's parents to equal both the current frontier and the maximum processed frontier. This is stronger than guessing that edits are probably uncontested. [Merge path](https://github.com/josephg/diamond-types/blob/89ae3a0ab8d941a2885e6ec89d094bc9ce9d2922/src/list/merge.rs#L152), [causal validation](https://github.com/josephg/diamond-types/blob/89ae3a0ab8d941a2885e6ec89d094bc9ce9d2922/src/listmerge/plan.rs#L703).

For Edytor, the transferable principle is to avoid work when maintained invariants prove that it is unnecessary. Updating a known affected ownership interval is a candidate. Bypassing Yjs integration because an edit is local, has one author, or occurs near the last cursor is not justified by this source. Adopting Diamond Types' positional-operation DAG and fast-forward planner wholesale would replace more than an index; it would require its own compatibility and semantic proof.

## Edytor-specific candidates, in priority order

The following observations come from the working tree inspected on 2026-09-20.
The implementation agent is actively refactoring it. Recheck these paths after
the typed-node integration; that work may already remove some costs. These are
code-level findings and performance hypotheses, not profiler results.

### 1. Keep ownership compressed into intervals

`computeOwnership()` builds parallel owner, winning-claim and comparison-key
arrays by visiting every covered text position for every slice claim. The
maintained run view repeats this pattern in `buildRow()`, then scans the rows to
recover contiguous segments. A long unfragmented paragraph can therefore require
per-character derived metadata even though its backing Yjs content is stored in
spans. [Ownership construction](/Users/arnaud/code/edytor/src/lib/crdt/text/model.ts:322),
[maintained ownership row](/Users/arnaud/code/edytor/src/lib/crdt/text/runs.ts:507),
[Yjs string spans](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/structs/Item.js:1283).

**Candidate:** maintain winning ownership intervals and query/intersect those
intervals directly. A 100,000-position backing text with one winning claim can
have one ownership interval; it still retains its original character identities
and text payload. Merge adjacent intervals only when all relevant owner, claim,
and provenance fields agree. Same displayed owner alone is insufficient.

The intended improvement is for ownership work to track actual boundaries and
affected claims instead of expanding their lengths. It is not a universal
constant-time guarantee: adversarial overlaps and highly fragmented histories
must remain part of the benchmark and correctness corpus. Use the corrected
ownership algorithm as the differential oracle, including the recently reported
concurrent-split and empty-head regressions.

### 2. Share incremental indexes between commands and views

The current text operation path is `insertText → ownView → view`. That `view`
collects the entire registry, computes ownership and resolves placements. This
means the prelude for a local text edit includes work on unrelated blocks. The
rendering side already has document-scoped incremental dependencies and caches,
but those do not eliminate the command-side reconstruction.
[Command path](/Users/arnaud/code/edytor/src/lib/crdt/placement/model.ts:898),
[whole-model view](/Users/arnaud/code/edytor/src/lib/crdt/placement/model.ts:417),
[registry collection](/Users/arnaud/code/edytor/src/lib/crdt/placement/model.ts:227),
[existing incremental view](/Users/arnaud/code/edytor/src/lib/crdt/text/runs.ts:330).

**Candidate:** the document owner maintains the indexes needed by both commands
and rendering, with explicit mutation and transaction invalidation. Plain text
insertion should avoid placement resolution when the maintained dependencies
prove placement is unaffected. Structural changes invalidate their real
dependents; shared backing text means those dependents can span several blocks.
The typed-node API supplies a useful ownership boundary for this work, but method
relocation alone does not remove the reconstruction.

**Test the scaling:** edit the same paragraph while increasing the number of
unrelated blocks from 1,000 to 5,000. Record visited records and recomputed views
alongside elapsed time, including any documented full-document `onChange`
serialization as a separate cost.

### 3. Read and update ranges without repeatedly materializing the backing text

`itemsOfRange()` currently calls `text.toDelta().toJSON()` for each requested
range. The comment explains why: fresh rendering gives correct reads inside a
transaction, while the maintained delta cache updates at transaction cleanup.
Thus a small requested slice can still render the whole backing sequence, and
several slices can repeat that work.
[Range materialization](/Users/arnaud/code/edytor/src/lib/crdt/text/model.ts:464).

**Candidate:** provide a range iterator or transaction-aware maintained view
that supplies formatted content directly. Reuse normalized mark identities and
unchanged runs. This can justify a small vendored engine API patch if the model
cannot obtain the needed range efficiently through existing APIs. Retain
read-your-writes, boundary formatting and observer order; simply replacing the
fresh read with the stale cache is incorrect. Prefer removing repeated passes
before introducing a second content store.

### 4. Index formatted positions and relative-position resolution

The inspected `YNode.applyDelta()` initializes its cursor at `_start`, including
the current-format map; its retained prefix is traversed to reach the edit.
Relative-position conversion finds the referenced item and then walks left to
sum its visible index. Existing array search markers therefore do not prove
these paths have efficient position lookup.
[Delta cursor](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/ynode.js:1628),
[relative-position scan](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/RelativePosition.js:302),
[existing markers](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/ynode.js:529).

**Candidate engine patch:** compare formatting-aware cursor checkpoints with an
index carrying subtree visible lengths. It needs both position and correct
formatting state; pointing at an item is insufficient. Preserve UTF-16 units,
inline atom widths, non-countable formatting markers, deletion/undo semantics,
and any supported renderer-dependent visibility. Update the index on remote
integration, item splits and coalescing, and invalidate it when necessary.

Benchmark long paragraphs after heavy editing and formatting, distant cursor
jumps and multiple presence anchors. Fresh pasted text with very few structs can
hide this cost. Adopt the simpler candidate if it meets the measured need.

### Later candidates

- **Compact local metadata:** if heap profiles identify object allocation as a
  remaining cost, test numeric handles or packed arrays for derived ownership
  and position indexes. Keep replicated identities unchanged. Count retained
  memory, not just temporary allocation; intern tables and dependency caches
  need a clear lifetime.
- **Bulk loading and catch-up:** if observer/projection work dominates, test
  coalescing derived-view work within an existing valid transaction or a clearly
  specified load boundary. Preserve input/history/plugin transaction contracts.
  This is distinct from importing Diamond Types' causal fast-forward algorithm.
- **Bundle specialization:** measure production imports before pruning general
  engine features. Runtime speed and compressed bundle size are independent
  outcomes. A tree, extra index or Wasm module may improve one and worsen another.

## Proposed performance phase

Complete the current correctness and typed-node integration first, then freeze
an integrated baseline. Extend U11 of the existing implementation plan instead
of starting a parallel engine rewrite. Preserve the simple corrected algorithms
as test oracles where optimized representations replace them.

Use the existing planned workloads: 1,000/5,000-block documents, long paragraphs,
dense marks and inline content, repeated move/split/merge, undo, and offline
reconnection. Vary text length, block count, formatting density and structural
fragmentation independently. Measure engine mutation, ownership, rich-text view,
selection, callbacks and DOM work separately, plus the complete browser
interaction. The existing raw-node typing benchmark is not a substitute for the
Edytor command path.

Try compressed ownership and shared indexes first, then transaction-aware range
reads. Re-profile before adding a core position index or compact-memory design.
Keep only patches with repeatable benefit and no unacceptable regression in
the agreed budgets. Record engine changes against the pinned source in the
vendor patch manifest. Local derived-index changes can leave encoding intact;
prove interoperation with the baseline and unchanged conflict behavior.

## Evidence required before adopting an optimization

1. Measure the actual cost separately: CRDT integration, ownership projection, formatting runs, selection lookup and DOM updates. Include sequential typing, distant edits, heavy formatting, repeated split/merge/move and offline concurrent updates.
2. Compare the candidate against the corrected baseline on identical edits. Require identical text, marks, identities, ownership, selections and undo outcomes after each transaction and update permutation.
3. Measure p50/p95 latency, allocations or retained memory, startup/catch-up time, update bytes and production bundle size. Reduced operation counts alone do not prove a better editor.
4. Keep replicated IDs, encoding and merge rules fixed for the first experiments. Explicitly classify any proposed departure as an engine/protocol change.

No Diamond Types executable benchmark, Rust build or feature-completeness audit was run for this note. Source inspection establishes useful implementation ideas and their constraints; it does not establish a numerical speedup for Edytor.
