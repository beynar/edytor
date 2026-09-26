# Review of the completed CRDT v14 follow-up

Reviewed on 2026-09-21 against the uncommitted working tree on
`feat/crdt-v14-engine`, based on `d9b7de09e7110fc7a4c2fb1eec36f8267aede086`.
This review inspected the implementation, the completion report, the previous
two gate reviews, and benchmark artifacts. It also ran focused tests and
independent adversarial probes. No production implementation was changed.

## Verdict

The architectural direction remains sound. Typed nodes now delegate to the
shared semantic model; the compatibility bridge is removed; interval ownership,
shared indexes, and direct range reads address real redundant work. The recorded
facade benchmarks support a large improvement.

**Do not accept the completion report's unconditional pass yet.** Three confirmed
P1 defects remain: the P4 optimization corrupts formatting, persistence compaction
discards refused data, and undo can restore text into the wrong paragraph.
Additional findings concern public snapshot isolation, notification timing,
oracle strength, and performance/transport claims.

Convergence alone does not establish correct editing semantics. In several of
these cases, every peer can agree on an incorrect document.

## Confirmed findings

### R1 — P1: P4 can remove formatting from existing text

Owner: [updateMarkerFormats](../src/lib/crdt/vendor/yjs/src/ynode.js#L522),
especially the unconditional format update at line 539.

The new code applies an inserted format marker to every later cached format
snapshot. It does not account for intervening markers that set the same key
again. A snapshot farther along the text can therefore be changed even though
the actual formatting there is unchanged.

Minimal reproduction through the ordinary facade, starting with paragraph `p`
containing 300 `x` characters:

```ts
ed.setMark('p', 100, 100, 'b', true);
ed.insertText('p', 150, 'P', { b: true });
ed.insertText('p', 50, 'Z', { b: true });
ed.insertText('p', 152, 'Q', { b: true });
```

The third operation corrupts a later snapshot; the fourth uses it and removes
bold from the final 50 original characters of the bold span. Identical operations
on an equivalent document with `_searchMarker = null` preserve the formatting.
Projection and encoded state match until the last operation, then differ.

This is a semantic regression introduced by the optimization. It is **not** a
demonstration that peers exchanging the resulting update fail to converge: they
can all converge to the same incorrectly formatted text. Successful
patched/baseline update exchange consequently does not discharge this finding.

**Required next step:** correct snapshot invalidation/maintenance across
intervening same-key boundaries. Conservatively invalidate snapshots when their
validity cannot be established. Retain accelerated paths only where equivalent
operation replay proves them safe.

### R2 — P1: IndexedDB compaction deletes refused persisted data

Owners: [fetchUpdates](../src/lib/crdt/providers/indexeddb.ts#L278) and
[storeState](../src/lib/crdt/providers/indexeddb.ts#L295).

Hydration correctly rejects a stored unsupported-schema row, leaving the live
document clean. It nevertheless advances `_dbref` past the rejected row.
`storeState()` checks only the live document's schema, writes its snapshot, then
deletes all older rows—including the refused bytes that snapshot never included.
`_hydrationRefused` does not prevent compaction. The regular compaction timer uses
this same path.

Independently reproduced using **fake-indexeddb only**:

1. Seed a correctly generation-tagged database with a document claiming schema
   version 99 and containing a future-content entry.
2. Open it with the current provider; `whenSynced` rejects as expected.
3. Confirm the original future-version bytes remain stored.
4. Call `storeState(provider)` and allow the asynchronous write to finish.

Observed: two stored rows before compaction, one afterward; the original refused
bytes are gone. Refusal protects the live document but currently fails to protect
the durable source.

**Required next step:** preserve refused rows and their dependencies. Compaction
may remove only data proven to be represented in its replacement snapshot; a
clean live schema is insufficient proof. Cover explicit and scheduled compaction,
including completion/error propagation of the asynchronous storage operation.

### R3 — P1: undo restores deleted text into the wrong paragraph

Owners: [ownership anchor resolution](../src/lib/crdt/text/model.ts#L821) and
[createUndoManager](../src/lib/crdt/edytor-doc.ts#L1079).

This requires no concurrency or manually constructed claims:

```ts
// Seed b with "hello world".
ed.block('b').split(6, 'tail');
const history = ed.createUndoManager({ captureTimeout: 0 });
ed.block('tail').deleteText(0, 5);
history.undo();
```

| State                                 | `b`           | `tail`  |
| ------------------------------------- | ------------- | ------- |
| Before deletion / expected after undo | `hello `      | `world` |
| Actual after undo                     | `hello world` | empty   |

Binary save/reload preserves the wrong result. The prior Gate F2 report discloses
this behavior, and its deletion test explicitly accepts redistributed ownership.
That proves conservation and convergence, not the expected inverse of deletion.

Upstream undo restores deleted characters as new items. Existing ownership
anchors do not automatically claim those replacements for the original display
owner. Simply enabling local `redone` traversal is not a complete repair because
those pointers do not serialize.

**Required next step:** make history restore ownership through replicated model
semantics. Specify concurrent undo behavior separately; even the sequential
case must restore the correct paragraph, marks, and selection.

### R4 — P2: public projections expose mutable engine payloads

Owners: [project](../src/lib/crdt/placement/model.ts#L1111),
[contentItems](../src/lib/crdt/edytor-doc.ts#L1316), and
[DocBlock.items](../src/lib/crdt/nodes.ts#L236).

The direct range reader intentionally borrows nested mark values and inline
data. These references also escape through public content/projection APIs.
The public `ProjectedBlock.content` and `ContentItem` types are mutable;
`DocBlock.items` only makes the outer array readonly.

Confirmed reproduction: obtain `ed.project()`, change an inline item's
`data.label` and a text item's nested `marks.link.href`. Subsequent local
projections show both changes, while cached `ed.runs()` and a synchronized peer
retain the original values. **No update event fires.** The `.items` surface
permits the same mutations.

**Required next step:** detach or deeply protect payloads at public publication
boundaries. Preserve internal sharing and range-read efficiency. A readonly
TypeScript annotation alone does not isolate runtime state.

### R5 — P2: a read can publish a partial transaction to subscribers

Owner: [computeRuns/runs](../src/lib/crdt/text/runs.ts#L995).

Start with `a`, register `subscribeBlock`, and execute:

```ts
ed.transact(() => {
	ed.block('b').insertText(1, 'b');
	void ed.block('b').runs;
	ed.block('b').insertText(2, 'c');
});
```

The listener receives `ab` while the transaction is open, then `abc` after
commit. `runs()` synchronizes in-flight changes and `computeRuns()` immediately
calls subscribers. This contradicts the documented commit-based notification
contract in [nodes.ts](../src/lib/crdt/nodes.ts#L25). The document's `onChange`
boundary itself remains commit-based.

**Required next step:** retain read-your-writes while deferring subscriber
publication until the transaction completes. Update read-surface documentation
to match the chosen contract; do not use documentation alone to excuse partial
notifications.

### R6 — P2: the strict oracle still accepts real semantic failures

Owners: [global legitimate-owner set](../src/tests/crdt/random/runner.ts#L330),
[tag verdicts](../src/tests/crdt/random/runner.ts#L726), and
[atom classification](../src/tests/crdt/harness/ops/model-ops.ts#L208).

Two independently executed fault injections pass through the current production
adapter and runner with `ok: true` and no violations:

| Injected incorrect behavior                                                                                           | Current accepted verdict |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| A `setMark` implementation also deletes the entire tracked tag, although no deletion was requested                    | `deleted-legit`          |
| After an unrelated paragraph is split, `setMark` unexpectedly merges the tagged paragraph into that split destination | `moved-edit`             |

The first passes because tombstoned atoms are treated as legitimate deletion
without checking what the scheduled operation was allowed to delete. The second
passes because any destination ever produced by any split/merge becomes a
legitimate owner for every tag in the run. The immediate insertion-time check
does not catch a later wrongful transfer.

These probes deliberately introduce faulty adapter behavior. They demonstrate
**verification gaps**, not evidence that the current `setMark` implementation
performs those extra mutations.

Loss correlation has improved, but global `sawLoss` exemptions also remain for
resurrected deletions and divergence. The generator does not exercise undo/redo.
The passing corpus is useful evidence, not a proof of zero unintended deletion,
transfer, or history errors.

**Required next step:** record operation intent against stable atom identities;
correlate deletion, transfer, and destroyed dependencies to the affected atoms.
Add both injections as tests that must fail the runner. Include history in the
production corpus and retain explicit expected-result tests.

### R7 — P2: the claimed browser bottleneck is not established

Owners: [browser benchmark](../bench/browser.js#L91) and
[performance attribution](./crdt-v14-benchmarks.md#L375).

`keystrokeMs` ends inside a `requestAnimationFrame` callback after a DOM mutation.
`facadeToDomMs` ends at the MutationObserver callback without that frame wait.
Subtracting their independent medians—4.1 minus 0.3 milliseconds—does not measure
3.8 milliseconds of input-handler work. The difference includes different timing
boundaries and scheduling. A rAF callback is not proof that paint has completed.

The browser artifact also predates WU6–WU9 and uses a small fixture. It does not
establish current 5,000-block browser latency or that input handling now dominates
the optimized editor.

**Required next step:** instrument comparable stages of the same real keystroke,
separate execution from frame scheduling, await all samples, and measure the
freshly packed current editor at representative scales. Correct source/build
identification as well: the current dirty hash hashes status filenames, not file
contents, and the engine label still says “unmodified” despite P4.

### R8 — P2: the documented upstream WebSocket server example is incompatible

[Provider documentation](./crdt-v14-providers.md#L329) describes upstream
`setupWSConnection` without persistence as an opaque byte relay. The
[official y-websocket v1.5.4 implementation](https://raw.githubusercontent.com/yjs/y-websocket/v1.5.4/bin/utils.js)
creates a server-side document, decodes message types, and performs the sync
handshake even without persistence. The new leading envelope word `14` is not a
handled message type there.

The actual custom relay test is valid. It does not establish compatibility with
the documented upstream server example. Correct the documentation and matching
comment in `tests/editor-dom/ws-relay.ts`; retain the explicit opaque-relay
contract unless a separately implemented compatible server is added.

## What the performance evidence supports

Comparing the corrected WU5 artifact with the latest recorded artifact:

| Metric                             |        WU5 | Latest recorded | Interpretation                                  |
| ---------------------------------- | ---------: | --------------: | ----------------------------------------------- |
| Facade keystroke p50, 1,000 blocks |  2.0524 ms |       0.2295 ms | About 9× faster                                 |
| Facade keystroke p50, 5,000 blocks | 11.7714 ms |       0.9697 ms | About 12× faster; earlier WU7 run was 0.8389 ms |
| Facade keystroke p95, 5,000 blocks | 23.4829 ms |       5.6283 ms | Encouraging, but only 15 samples                |
| Packed consumer entry, Brotli      |  119,518 B |       121,658 B | About 1.8% larger; within the stated budget     |

Sources: [WU5 artifact](../bench/results/2026-09-21T00-10-26-013Z.json),
[latest recorded artifact](../bench/results/2026-09-21T06-42-21-839Z.json).
These timings were inspected, not regenerated by this review. They measure the
facade workload on one machine, not end-to-end browser typing.

The latest range-read artifact reports 0.0102 ms warm p50, versus 0.3627 ms for
the full-render reference, and 0.4983 ms for the first read including index build.
Cold costs and invalidation frequency still matter. The interval/shared-index
gains are strong reasons to keep the architecture. P4's speed claim needs to be
reassessed after its correctness repair. Bundle reduction has not yet been
demonstrated by this slice.

## Validation and limits

The review team ran 109 existing focused tests successfully:

- Ownership intervals, range reads, shared state, and Gate F2 range deletion:
  55 passed.
- Marker seeding, Gate F2 vendor checks, and surrogate normalization:
  33 passed.
- Provider schema boundary and staging: 18 passed.
- Gate F1 oracle checks: 3 passed.

The main reviewer independently reran the new formatting, refused-row compaction,
undo, snapshot aliasing, notification timing, and oracle injection probes. All
confirmed the findings above. Persistence probes used isolated fake databases.
No production data was accessed or altered.

The full 1,197-test browser matrix, package build, and complete release gate were
not rerun in this review. Their reported prior results do not cover the new
counterexamples. Real-socket and packed-consumer test implementations were
inspected: they do exercise actual sockets and an installed tarball. More than
two real browser clients remains an integration coverage gap, distinct from the
three-peer model corpus.

Next implementation handoff: [hardening plan](./crdt-v14-hardening-prompt.md).
