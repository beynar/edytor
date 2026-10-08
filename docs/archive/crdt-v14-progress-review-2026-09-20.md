# CRDT v14 implementation: progress review

Reviewed 2026-09-20, around 12:20 Europe/Paris, against the current working tree.
The implementing agent was changing files during this review. Application check
results below are a recorded snapshot of that work in progress. The reproduced
ownership defects are in the new engine model, independently of the unfinished
Svelte integration.

## Assessment

There is substantial implementation behind the ledger: a pinned vendored v14
engine, stable block placement, anchored text ownership, a maintained formatted
run view, a document facade, provider ports, migration code, and extensive tests.
This is well beyond scaffolding.

However, **U04 should be reopened before its semantics are treated as complete**.
Two ordinary editing sequences misassign text to another block, and a valid block
ID collides with an internal sentinel. All three reproduce through the assembled
`EdytorDoc` API. The live editor cutover is also incomplete, and the package root
currently exposes only the CRDT API rather than the editor product.

The appropriate status is: **implemented engine foundation, correctness work
still required, editor integration underway, not release-ready**.

## Progress against the plan

| Units                              | Evidence found                                                                                                                        | Assessment                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| U00–U02: baseline, vendor, harness | Pinned source/provenance, upstream test adapter, legacy fixtures, independent replicas, seeded schedules, benchmarks, package smoke   | Substantial foundation exists; see validation qualifications below               |
| U03: moves                         | Stable registry, replicated placement candidates, rank allocation, cycle projection, grouped moves, engine undo tests                 | Implemented at engine level; live editor commands are not fully connected        |
| U04: split/merge ownership         | Stable backing text and anchored claims; independent-replica and overlapping-merge tests                                              | Implemented, but the three reproduced defects below prevent accepting completion |
| U05: annotations/run view          | Maintained run snapshots, local invalidation, mark interning, golden formatting cases, local decorations                              | Implemented at engine level; renderer and input integration remain in progress   |
| U06: document model                | `EdytorDoc` facade, schema/bootstrap, semantic operations and change events                                                           | Present, but inherits the ownership defects                                      |
| U07: providers/migration           | Ported sync/awareness, IndexedDB, websocket envelope, migration, compaction/lifecycle tests                                           | Substantial implementation; unsupported-schema handling differs from the plan    |
| U08: editor cutover                | Text/InlineBlock compatibility work was actively changing during review                                                               | In progress despite the ledger still saying planned                              |
| U09–U12                            | Selection/history/browser integration, complete-editor testing, measured optimization and final package validation remain on the plan | Not complete; earlier engine-only gates do not establish these outcomes          |

Evidence: [execution ledger](/Users/arnaud/code/edytor/docs/crdt-v14-execution-ledger.md),
[vendor provenance](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/UPSTREAM.md),
[move decision](/Users/arnaud/code/edytor/docs/crdt-v14-move-adr.md),
[text ownership decision](/Users/arnaud/code/edytor/docs/crdt-v14-text-ownership-adr.md),
[rich-text decision](/Users/arnaud/code/edytor/docs/crdt-v14-richtext-adr.md).

## Reproduced correctness findings

### P1 — Typing after concurrent splits takes text from another paragraph

1. Seed one document with block `b` containing `abcdefghij`; create two independent
   replicas from that seed.
2. Peer A splits `b` at offset 3 into `b` and `early`.
3. Peer B concurrently splits `b` at offset 8 into `b` and `late`.
4. Synchronize. Both peers correctly display `abc`, `defgh`, `ij`.
5. Insert `X` at offset 0 of `early`, then synchronize again.

Expected: `abc`, `Xdefgh`, `ij`.

Observed on both replicas: **`abc`, `Xdefghij`, empty**.

The left-edge insertion rewrites the original covering record with a higher
generation but retains its old end anchor. It therefore wins atoms that had
become owned by `late`, rather than extending only the currently owned segment.
[Rewrite](/Users/arnaud/code/edytor/src/lib/crdt/text/model.ts:658).

This is convergent wrong ownership: a test checking only replica equality,
uniqueness, or retention of all characters can pass. The existing different-anchor
split scenario stops before the subsequent typing operation.
[Existing scenario](/Users/arnaud/code/edytor/src/tests/crdt/scenarios/active-text.ts:211).

### P1 — Typing into the empty head after a split edits the tail

1. Start with `b = abcdefghij`.
2. Split `b` at offset 0, creating `tail`.
3. Call `insertText('b', 0, 'X')`.

Expected: `b = X`, `tail = abcdefghij`.

Observed: the operation returns **true**, but `b` stays empty and
`tail = abcdefghijX`.

The empty-block revival record uses `anchorAt(text.length)` for its start.
That is the dynamic end sentinel, also used for its end, so the interval advances
past the inserted character instead of claiming it.
[Revival record](/Users/arnaud/code/edytor/src/lib/crdt/text/model.ts:618),
[end-anchor implementation](/Users/arnaud/code/edytor/src/lib/crdt/text/model.ts:303).

This needs a test for an empty _display_ backed by nonempty text, not just a
fresh empty backing sequence.

### P2 — A valid block ID can suppress its content

Initialize a paragraph with ID `dead` and text `abcdefghij`. The paragraph is
visible, but its rendered text is empty. The internal deleted-owner sentinel is
the same string as that valid caller-supplied ID.
[Sentinel](/Users/arnaud/code/edytor/src/lib/crdt/text/model.ts:153),
[ownership exclusion](/Users/arnaud/code/edytor/src/lib/crdt/text/model.ts:374).

The internal absence/deletion state must be distinguishable from every valid
block ID. These findings reproduced through both `bindModel` and `EdytorDoc`.

## Other completion gaps

**The randomized suite is not a strict no-loss/no-crash gate.**
`expectedViolations()` permits `lost-edit`, `unrecoverable-loss`, and
`upstream-engine-crash` for every adapter. Some lost-tag observations represent
legitimate later deletions or movement; explicitly lossy reload schedules also
need a separate oracle. But the blanket categories allow an unexpected real
regression to receive the same treatment. An engine stack frame is enough to
classify a crash as allowed evidence.
[Classification](/Users/arnaud/code/edytor/src/tests/crdt/random/runner.ts:82),
[crash classification](/Users/arnaud/code/edytor/src/tests/crdt/random/runner.ts:409),
[passing evidence-class aborts](/Users/arnaud/code/edytor/src/tests/crdt/random/corpus.test.ts:176).

For the production model, ordinary legal schedules should fail on an unexpected
engine exception. Track expected surviving atoms/owners separately from explicit
deletions, and keep deliberately destructive schedules and known historical
failures in a distinct diagnostic lane. The deterministic ownership regressions
above should be hard failures regardless of fuzz classification.

**Unsupported application schemas are signaled but still accepted.** U07 in the
plan requires rejection before application mutation. Current providers expressly
continue syncing/persisting an unsupported `meta.v`; the websocket schema check
runs after update application. A mismatch event is useful, but it does not enforce
the specified boundary. A replicated last-writer-wins version attribute also
cannot serve as peer capability negotiation.
[IndexedDB policy](/Users/arnaud/code/edytor/src/lib/crdt/providers/indexeddb.ts:129),
[hydration accepts unsupported versions](/Users/arnaud/code/edytor/src/lib/crdt/providers/indexeddb.ts:212),
[websocket post-apply check](/Users/arnaud/code/edytor/src/lib/crdt/providers/websocket.ts:160).

**The published editor API is temporarily absent.** The package root exports
only the CRDT layer. It does not currently export the existing `Edytor`,
`useEdytor`, and plugin surface. The packed smoke checks the new CRDT entry points,
so its pass does not prove the editor package works. Restore the product API as
part of cutover and test an actual Svelte consumer.
[Package root](/Users/arnaud/code/edytor/src/lib/index.ts:18),
[packed smoke](/Users/arnaud/code/edytor/tests/packed-consumer/smoke.js:49).

**Live editing and server compatibility still need integration.** At inspection,
the runtime and core structural commands still used v13 while some wrappers were
being ported. The new websocket envelope is deliberately incompatible with the
old protocol; the recorded test uses an opaque relay. A successful standalone
provider test does not establish compatibility with an existing interpreting
websocket server.
[Runtime](/Users/arnaud/code/edytor/src/lib/edytor.svelte.ts:181),
[live structural operations](/Users/arnaud/code/edytor/src/lib/block/block.utils.ts:333),
[provider deployment notes](/Users/arnaud/code/edytor/docs/crdt-v14-providers.md:212).

## Validation performed during this review

| Check                                    | Observed result                                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test:crdt`                         | **1 suite failed, 36 passed, 1 skipped; 1,191 tests passed, 7 skipped**. Legacy-v13 suite failed during setup with `runs.filter is not a function` at the partially migrated text boundary |
| `pnpm check`                             | **38 errors, 0 warnings in 10 files**. Errors included mixed old/new wrapper contracts and missing facade properties during U08                                                            |
| Three focused ownership probes           | All reproduced through the core model and the assembled document facade; the main reviewer independently reran both probes                                                                 |
| Full browser/release/packed-editor gates | Not rerun; incomplete cutover prevents treating older green results as current integrated validation                                                                                       |

The implementing agent's earlier gate reports include successful upstream,
provider, package-smoke, and model checks, plus remediation of previous review
findings. Those are useful milestone records. They are not a substitute for
current checks after new edits. The files were actively changing, so the exact
application error count can change immediately after this snapshot.

## Performance: encouraging evidence, limited claims

The latest saved benchmark reports these raw update payloads for a 100,000-character
case:

| Operation | New model | Copy-based comparison |
| --------- | --------: | --------------------: |
| Move      |  60 bytes |         100,127 bytes |
| Split     | 346 bytes |          50,136 bytes |
| Merge     |  35 bytes |         100,035 bytes |

These are useful evidence that the representation avoids copying text. They are
isolated model measurements, not complete-editor latency or bundle-size results.
The comparison also has weaker concurrent editing semantics. The saved run-view
benchmark records one changed paragraph being recomputed while 999/1,000 other
snapshots are reused.
[Saved operation measurements](/Users/arnaud/code/edytor/bench/results/latest.json),
[saved run-view measurements](/Users/arnaud/code/edytor/bench/results/runs-latest.json).

One benchmark reporting defect should be corrected before relying on timing
claims: the move workload returns `updateBytes` to `measure()`, which labels any
numeric return as `remote`. Those particular `remote` statistics are bytes,
not remote-apply milliseconds.
[Move callback](/Users/arnaud/code/edytor/bench/lib/workloads.js:160),
[measurement collector](/Users/arnaud/code/edytor/bench/lib/stats.js:33).

No complete-editor speedup or final bundle reduction has yet been established by
this review. U11 remains necessary.

## Recommended next sequence

1. Reopen U04 for the three reproduced defects. Add hard facade-level regressions
   for editing after structural conflicts, then verify marks, inline atoms,
   undo/redo, synchronization, and reload on those same sequences.
2. Tighten the randomized test oracle and enforce the planned unsupported-schema
   boundary. Do not mark these gaps resolved solely by documenting the behavior.
3. Finish U08 as one coherent editor integration; restore package exports and
   update the ledger to reflect work in progress.
4. Complete U09–U10 selection/history/browser proof before claiming the editor
   benefits from the engine changes.
5. Complete U11–U12 measurements, migration rehearsal, packed-editor consumer,
   and final release validation.

No implementation fixes were made as part of this review. This report records
findings without overwriting the implementing agent's work or progress ledger.

## Standalone reproduction specification

The following uses the new facade directly and does not depend on temporary
research files or the Svelte runtime. Run it with the repository's TypeScript
execution tooling, resolving the two imports from the repository root. Add
assertions for the expected outcomes above when promoting it to regression tests.

```ts
import * as Y from './src/lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from './src/lib/crdt/edytor-doc.ts';

const E = bindEdytorDoc(Y);

function seed(id = 'b') {
	const doc = new Y.Doc();
	doc.clientID = 10;
	const editor = E.create(doc);
	editor.init({
		content: [{ id, type: 'paragraph', content: [{ kind: 'text', text: 'abcdefghij' }] }]
	});
	return { doc, editor };
}

function sync(a: ReturnType<typeof seed>, b: ReturnType<typeof seed>) {
	const fromA = Y.encodeStateAsUpdate(a.doc);
	const fromB = Y.encodeStateAsUpdate(b.doc);
	Y.applyUpdate(a.doc, fromB);
	Y.applyUpdate(b.doc, fromA);
}

const a = seed();
const docB = new Y.Doc();
Y.applyUpdate(docB, Y.encodeStateAsUpdate(a.doc));
const b = { doc: docB, editor: E.create(docB) };
a.doc.clientID = 100;
b.doc.clientID = 200;
a.editor.splitBlock('b', 3, 'early');
b.editor.splitBlock('b', 8, 'late');
sync(a, b);
a.editor.insertText('early', 0, 'X');
sync(a, b);
// Expected: early = 'Xdefgh', late = 'ij'.
console.log(a.editor.blockText('early'), a.editor.blockText('late'));

const emptyHead = seed();
emptyHead.editor.splitBlock('b', 0, 'tail');
emptyHead.editor.insertText('b', 0, 'X');
// Expected: b = 'X', tail = 'abcdefghij'.
console.log(emptyHead.editor.blockText('b'), emptyHead.editor.blockText('tail'));

const reservedCollision = seed('dead');
// Expected: 'abcdefghij'.
console.log(reservedCollision.editor.blockText('dead'));
```
