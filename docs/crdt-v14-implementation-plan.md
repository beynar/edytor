# Edytor: vendored Yjs v14 implementation plan

Prepared 2026-09-19. Status: **ready for implementation; implementation has not started**.

This is a self-contained handoff for an implementing AI. It records the agreed
direction and supersedes the exploratory sequencing in
[the architecture assessment](/Users/arnaud/code/edytor/docs/crdt-architecture-evaluation.md).
That assessment remains useful evidence, not an alternative instruction to
optimize v13 before starting v14. Temporary research files are not prerequisites
for executing this plan.

## 1. Goal and authority

Build an editor-specific CRDT model on a **directly vendored, pinned Yjs v14
baseline**. Preserve block and character identity through reordering,
reparenting, splitting, merging, and inline editing. Give rich text an efficient
maintained rendering representation. Improve performance where measurement
demonstrates a gain, then remove capabilities that the supported format does not
need.

The result must be a working Edytor integration, including collaboration,
persistence, selection, undo, plugins, readonly rendering, and package delivery.
A standalone CRDT experiment is an intermediate milestone, not completion.

### Settled direction

- Start directly from v14; do not spend a phase building a v13 optimization layer.
- Vendor source so Edytor controls its engine version and can make justified core
  changes. First preserve an unmodified baseline for comparison.
- **Moves are required**, including same-parent reorder, cross-parent movement,
  nesting/unnesting, and grouped drag operations.
- Splits and merges must retain the identities targeted by concurrent edits.
- Investigate annotation representation at its semantic owner; remove redundant
  transformations instead of merely moving them into another class.
- Evaluate success through editing semantics, integration, and measured results.
  Implementation difficulty is not a reason to remove a requirement.

### Decisions this plan deliberately does not pretend are settled

The implementation must specify and prove the ordering representation, tree cycle
policy, text-slice ownership algorithm, conflict behavior at structural
boundaries, and legacy-document migration. Units U03 and U04 own these decisions.
Their deliverable is an executable specification and a selected algorithm, not
another open-ended research report.

An editor-level move primitive is mandatory. Resurrecting historical
`ContentMove` is not mandatory. A placement-based primitive can satisfy the same
product requirement if it passes the specified tests. New wire operations remain
available when the required semantics or measured costs justify them.

### Scope boundaries

Preserve the public JSON document model and existing sequential editing behavior
unless a specific change is documented and justified. Raw Yjs-facing APIs will
need an explicit v14 contract; do not claim transparent compatibility with v13
objects. Do not redesign unrelated plugins, the editor UI, hosted collaboration,
authentication, or the entire repository structure.

This plan authorizes no deployment, package publication, production data reset,
or destructive migration. Implementation should produce reviewable local code,
tests, migration tooling, and documentation. Follow the execution request and
repository instructions for any subsequent external action.

## 2. Verified starting point

### Engine and source versions

| Role                                           | Pinned reference                           | Meaning                                                                             |
| ---------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| Current Edytor                                 | `yjs@13.6.30`, resolved `lib0@0.2.117`     | Baseline in the current manifest/lockfile                                           |
| Selected v14 baseline                          | `@y/y@14.0.0-rc.26`                        | Active package name; do not substitute the old `yjs@next` tag                       |
| Selected source                                | `96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64` | Vendor this exact upstream commit initially                                         |
| Compatible dependency measured during research | `lib0@1.0.0-rc.32`                         | Satisfies the baseline's `^1.0.0-rc.29`; pin and verify the chosen dependency graph |
| Historical move implementation                 | `b56debef005caef8660c672e17cec3e869646422` | PR #357 head and `yjs@14.0.0-1`; research reference, not the selected base          |

Current v14 exports a unified `Y.Node`, has a maintained `Node.delta` view, and
does not contain the old native move feature. Its compatibility fixtures include
historical v13 updates. That is not proof of compatibility with Edytor's schema,
providers, positions, or history. Verify the pinned source rather than using v13
examples or guessing v14 method names.
[Baseline manifest](https://github.com/yjs/yjs/blob/96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64/package.json),
[exports](https://github.com/yjs/yjs/blob/96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64/src/index.js),
[Node implementation](https://github.com/yjs/yjs/blob/96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64/src/ynode.js),
[compatibility tests](https://github.com/yjs/yjs/blob/96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64/tests/compatibility.tests.js).

Recheck upstream status when execution starts and record any relevant changes.
Do not silently switch the baseline halfway through implementation. An upstream
upgrade is a separately validated change to the recorded base.

### Relevant repository owners

The current working tree contains substantial uncommitted work. It is the
baseline for this plan; checking out HEAD alone would omit important behavior.
Inspect the current files and preserve unrelated changes.

| Responsibility                                | Existing files                                                                                                                                                                                                                                                         | Migration consequence                                                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Runtime, bootstrap, transaction origins, undo | [edytor.svelte.ts](/Users/arnaud/code/edytor/src/lib/edytor.svelte.ts)                                                                                                                                                                                                 | Root is `doc.getMap('content')`; undo currently scopes that root; initialization also uses a separate marker |
| Live block/text/inline wrappers               | [block.svelte.ts](/Users/arnaud/code/edytor/src/lib/block/block.svelte.ts), [text.svelte.ts](/Users/arnaud/code/edytor/src/lib/text/text.svelte.ts), [inlineBlock.svelte.ts](/Users/arnaud/code/edytor/src/lib/block/inlineBlock.svelte.ts)                            | Concrete v13 classes and private fields determine roles, initialization, and liveness                        |
| Structural operations                         | [block.utils.ts](/Users/arnaud/code/edytor/src/lib/block/block.utils.ts), [text.utils.ts](/Users/arnaud/code/edytor/src/lib/text/text.utils.ts)                                                                                                                        | Move/nest/split/merge and normalization contain snapshot-copy/delete paths                                   |
| Grouped drag                                  | [blockHandleOperations.ts](/Users/arnaud/code/edytor/src/lib/plugins/blockHandles/blockHandleOperations.ts)                                                                                                                                                            | Multi-block drag separately clones JSON, removes blocks, and recreates them                                  |
| Rich-text projection                          | [deltas.ts](/Users/arnaud/code/edytor/src/lib/text/deltas.ts), [Text.svelte](/Users/arnaud/code/edytor/src/lib/components/Text.svelte), [Mark.svelte](/Users/arnaud/code/edytor/src/lib/components/Mark.svelte)                                                        | Full linked-list scans and reconstructed mark tuples; random run IDs are not the renderer's keys             |
| Plugin and readonly contracts                 | [plugins.ts](/Users/arnaud/code/edytor/src/lib/plugins.ts), [CodePlugin.svelte](/Users/arnaud/code/edytor/src/lib/plugins/code/CodePlugin.svelte), [readonlyElements.svelte.ts](/Users/arnaud/code/edytor/src/lib/components/readonlyElements.svelte.ts)               | Persistent formatting must remain separate from local syntax decorations; readonly has separate wrappers     |
| Selection and history metadata                | [selection.svelte.ts](/Users/arnaud/code/edytor/src/lib/selection/selection.svelte.ts), [historySelectionSnapshot.ts](/Users/arnaud/code/edytor/src/lib/history/historySelectionSnapshot.ts)                                                                           | ID/path/offset snapshots and relative positions must resolve through new ownership                           |
| Presence and provider API                     | [awarenessSelection.ts](/Users/arnaud/code/edytor/src/lib/collaboration/awarenessSelection.ts), [remoteSelection.ts](/Users/arnaud/code/edytor/src/lib/collaboration/remoteSelection.ts), [providers.ts](/Users/arnaud/code/edytor/src/lib/collaboration/providers.ts) | Public callbacks accept concrete Doc/Awareness; raw providers are exported                                   |
| Persistence and multi-tab sync                | [localProvider.ts](/Users/arnaud/code/edytor/src/lib/localProvider.ts)                                                                                                                                                                                                 | Custom IndexedDB/BroadcastChannel provider decodes, stores, and compacts updates                             |
| Browser input liveness                        | [onInput.ts](/Users/arnaud/code/edytor/src/lib/events/onInput.ts), [domTextMutationObserver.ts](/Users/arnaud/code/edytor/src/lib/events/domTextMutationObserver.ts)                                                                                                   | Moved content must remain live during native input and composition repair                                    |
| Public package                                | [index.ts](/Users/arnaud/code/edytor/src/lib/index.ts), [package.json](/Users/arnaud/code/edytor/package.json)                                                                                                                                                         | `svelte-package` emits `src/lib` to `dist`; only `dist` ships                                                |

Current provider dependencies declare v13 peer ranges: `y-protocols@1.0.7`,
`y-indexeddb@9.0.12`, and `y-websocket@3.0.0`. The actual IndexedDB implementation
is local; dependency presence does not mean it uses `y-indexeddb` at runtime.
Do not solve this with a Vite alias and assume external consumers are repaired.

Existing model collaboration tests share one `Y.Doc`. They establish propagation
and lifecycle behavior, not independent offline convergence. Real model, DOM,
and Playwright suites now exist; older repository notes claiming there are no
browser tests or describing old failures are not the current validation record.

## 3. What the move references contribute

### Fractional placement article

The article keeps shared children alive and changes an ordering attribute rather
than deleting/recreating them. It explains why native movement affected many
iterators and was removed. Its example covers reordering within one container,
not Edytor's entire tree and text model.
[Replacing Yjs move feature](https://www.bartoszsypytkowski.com/replacing-yjs-move-feature/).

**Plan consequence:** evaluate stable payloads plus replicated placement first.
Do not copy the sample rank generator as a proven ordering algorithm. Test
insertion between concurrent equal-prefix ranks, repeated insertion, reload,
and rank growth. A tie-breaker that sorts existing entries does not necessarily
allow a new entry between them. Parent and rank must resolve as one placement,
not independently combine parts of competing moves.

### Issue #694

The report concerns `14.0.0-1`, not rc.26. Starting with `[0,1,2]` and moving the
last element into the middle can produce a sparse `toJSON()` result. The issue
is still open at this plan's date.
[Issue #694](https://github.com/yjs/yjs/issues/694).

During this planning work, the exact historical source was run with compatible
`lib0@0.2.117`. The failure reproduced inside the transaction, after it, and after
sync to a fresh document: `toJSON()` was sparse while `toArray()`, iteration,
and indexed reads returned `[0,2,1]`. This was a focused probe, not a run of the
full historical suite. U02 must preserve the scenario as a durable regression.

### PR #357

The PR remains open and unmerged. Its maintainer scoped the initial feature to
array ranges; text movement and reparenting were deferred. The branch introduces
move records and changes iteration, item integration, relative positions,
events, and encoding. It is not a ready-made rc.26 patch.
[PR #357](https://github.com/yjs/yjs/pull/357),
[scope statement](https://github.com/yjs/yjs/pull/357#issuecomment-1085695993),
[reparenting statement](https://github.com/yjs/yjs/pull/357#issuecomment-1103681017).

A second focused historical probe anchored a position to `c` in `[a,b,c]`, moved
`c` to the front, and resolved the anchor to index 2 rather than 0. A simple
move/undo/redo probe passed, which does not establish concurrent selective undo.
The historical range-cycle test is disabled and randomized move generation
uses single elements. These are reasons to expand the acceptance suite.
[Historical tests](https://github.com/yjs/yjs/blob/b56debef005caef8660c672e17cec3e869646422/tests/y-array.tests.js),
[position conversion](https://github.com/yjs/yjs/blob/b56debef005caef8660c672e17cec3e869646422/src/utils/RelativePosition.js).

If native movement is selected, port and validate the whole affected contract:
item splitting/integration, visible traversal, search indexes, event deltas,
cached deltas, observers, position conversion in both directions, undo, GC,
and update encoding. Historical move content used wire tag 11, which current
rc.26 does not read. A new core operation requires explicit format support;
preserving old binary decoding does not imply readers understand new operations.
[Historical ContentMove](https://github.com/yjs/yjs/blob/b56debef005caef8660c672e17cec3e869646422/src/structs/ContentMove.js),
[current decoder](https://github.com/yjs/yjs/blob/96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64/src/ynode.js#L2792).

### Notion and annotations

Notion's useful idea is stable text identity whose slices can belong to different
blocks. Its database search labels address separately stored blocks, which is
not automatically Edytor's storage problem. The article supplies inspiration,
not a complete split/merge protocol to port. Peritext addresses rich formatting,
not the missing tree and structural ownership algorithm.
[Notion article](https://www.notion.com/blog/how-notion-handles-concurrent-editing-with-crdts),
[Peritext](https://www.inkandswitch.com/peritext/).

Switching v13 Map/Array/Text to XML types would not independently solve these
problems: XmlText inherits Text's formatting behavior. Proceed with v14's unified
Node and explicit semantic roles instead of a preliminary XML migration.
[XmlText documentation](https://docs.yjs.dev/api/shared-types/y.xmltext).

## 4. Required contracts

These requirements constrain the algorithm. They are not claims that v14 already
implements them.

### Identity and ownership

1. A block has one stable identity and at most one visible placement. Moving it
   preserves its editable payload, descendants, inline objects, and anchors.
2. Text characters and inline atoms have stable backing identities independent
   of the block currently displaying them. Splits and merges change ownership
   or boundaries, not those identities.
3. Every live, displayable text atom has exactly one owner in the canonical
   document projection. Deleted/hidden content follows an explicit policy.
   Concurrent merges of A+B and B+C cannot display B twice.
4. The visible block structure is acyclic, deterministically ordered, and
   reachable from the root. No replica-specific repair writes may make the
   outcome depend on delivery order.
5. Raw replicated state, projected structure, cached views, and renderer output
   have distinct responsibilities. Compare each with its proper oracle; raw
   registry insertion order is not the editor's placement order.

### Movement semantics

Provide an owned move operation accepting stable source identities and an
unambiguous destination. Preserve existing public path-based commands by
resolving their path to that destination at the command boundary. Specify
whether numeric destinations refer to pre-removal gaps or final indices.

Use these proposed defaults unless an existing product contract contradicts
them; record the final choices in U03:

- Concurrent moves of one block choose one deterministic winning placement.
  Concurrent edits to that block remain attached to it.
- A grouped drag moves a snapshot of selected block IDs, in source order, as one
  local undo step. It does not implicitly capture blocks inserted later into
  the old range. Specify per-member conflict resolution for overlapping moves;
  do not advertise all-or-nothing concurrent group semantics without an
  algorithm that provides it.
- A move that is invalid in the local view is rejected without mutation.
  Concurrently created parent cycles are resolved deterministically from
  replicated state; local descendant guards alone are insufficient.
- Explicit deletion wins visibility over a concurrent move of the deleted block.
  Keep sufficient state for permitted offline integration and undo. Specify
  separately what happens to children whose parent is deleted or becomes invalid.
- A parent and its rank change atomically. Placement ordering uses a stable,
  locale-independent comparator. Wall clocks and arrival order are not conflict
  authorities.

### Text split, merge, and annotations

U04 must specify exact outcomes for same-position and different-position
concurrent splits; split versus merge; overlapping merges; insertions exactly
at boundaries; deleted boundary anchors; and edits after several ownership
changes. For an insertion at a boundary, association with a side must be
explicit and preserved in its anchor/operation context.

One backing text can appear in multiple slices; a merged block can reference
multiple backing texts. Joining them must not quietly flatten them into copied
characters. Define where typing at a join inserts and how formatting continues
across it. Independent relative start/end ranges alone are not an exclusive
ownership algorithm.

Formatting keys must remain independently mergeable: simultaneous bold and
italic cannot become conflicting replacements of one opaque marks array.
Local representation may intern equivalent mark sets. Persistent formatting,
future durable annotation entities, and local decorations are different
concepts. Implement current marks and decoration behavior; do not expand this
project into comments or tracked changes.

### Positions, history, and lifetime

A position identifies backing content plus boundary affinity, then resolves to
its current visible block/slice. Preserve both selection endpoints, direction,
selected blocks, remote presence, and deleted-anchor fallback. An old wrapper ID
plus a numeric offset is not sufficient after a split.

Undo must remove the local user's contribution while preserving unrelated remote
edits. Preserve existing grouping policies for typing, marks, split, paste,
and grouped move. Changing the document's store layout must not leave new stores
outside the undo scope. Provider/remote transactions must not enter local history.

Backing text survives deletion of an original block while any live slice still
uses it. Define reference retention for offline peers and undo before enabling
reclamation. A local reference count does not prove distributed unreachability.
Do not disable GC indefinitely and call memory optimization complete.

## 5. Intended implementation shape

Start with stable block storage, an owned placement mechanism, stable backing
rich-text sequences, and canonical structural ownership records. Use current
v14 attributes/sequences where they meet the contract. Introduce specialized
engine storage or wire operations only where a demonstrated requirement or
profile warrants them.

Conceptually:

```text
Vendored v14: identity, integration, update encoding, transactions, base history
    │
    ├─ Stable block payloads + placement decisions → ordered, acyclic block tree
    ├─ Stable text/inline atoms + structural decisions → exclusive text slices
    └─ Maintained formatted runs → local renderer view + explicit JSON export
                           │
                  Existing Block/Text/InlineBlock API
                           │
              Svelte, input, selection, plugins, providers
```

The registries must own payload lifetime independently of displayed parents.
Merely storing IDs in a reorderable array still needs a unique-placement rule.
Merely retaining a JSON ID when recreating a Yjs object does not retain CRDT
identity. Changing an Item's parent pointer locally is not a replicated move.

Keep upstream source separate from editor-specific semantics. Use this proposed
layout, subject to U01's package proof:

```text
src/lib/crdt/vendor/yjs/
    src/                  upstream ESM source, preserving its relative layout
    global.d.ts           sibling of src, as referenced by upstream declarations
    LICENSE
    UPSTREAM.md           source commit, checksums, dependency pins, local patches
src/lib/crdt/             concern-named placement/ownership/rich-text modules
src/tests/                upstream runner/fixtures and Edytor semantic tests
```

Expose `edytor/crdt` through package exports to the same vendored entry used by
internal imports: implementation under `dist/crdt/vendor/yjs/src/index.js` and
its emitted declaration entry. This is a proposed export to add, not an existing
API. No wrapper is needed solely to rename upstream exports. Introduce an
editor-specific public surface only for actual domain operations. Do not invent
one class/interface per noun. Existing Block/Text wrappers remain the public
model owners.

U01 must verify that layout through the actual packager before accepting it.
Preserve upstream files, license, declaration dependencies, and attribution.
Keep upstream test sources available without shipping them as runtime code.
Do not hand-transpile an entire upstream library or create a monorepo solely to
vendor it. Scope any formatting/type-check exclusions to unmodified vendor
sources; keep application TypeScript strict.

Expose a documented way for package consumers to create the matching Doc and
Awareness. All interpreting components use one engine implementation. Do not
leave an external consumer to import a private source path or install another
copy of upstream Yjs to satisfy a public type.

## 6. Work units and dependencies

Each unit has one accountable owner. Parallel work is useful only after its
shared contracts are settled; do not let agents edit the same operation files
or change the schema independently. Units are not independently shippable
releases. The integrated editor is complete only after U12.

| Unit | Outcome                                                    | Prerequisites                            |
| ---- | ---------------------------------------------------------- | ---------------------------------------- |
| U00  | Reproducible current baseline and contract inventory       | None                                     |
| U01  | Pinned vendored core and viable package/API boundary       | U00                                      |
| U02  | Independent-replica harness and measurement harness        | U00, U01 for v14 runs                    |
| U03  | Proven move representation and conflict specification      | U01, U02                                 |
| U04  | Proven split/merge ownership and lifetime specification    | U01, U02; placement contract from U03    |
| U05  | Maintained rich-text/annotation view and inline model      | U01, U02; anchor/slice contract from U04 |
| U06  | Complete engine-level document model and operations        | U03, U04, U05                            |
| U07  | Compatible providers, versioned persistence and migration  | U01; final schema from U06               |
| U08  | Edytor model/operation cutover to the new engine           | U06, provider/API contract from U07      |
| U09  | Selection, history, presence and browser-input integration | U07, U08                                 |
| U10  | Full editor convergence and browser regression proof       | U07, U08, U09                            |
| U11  | Measured specialization and bundle reduction               | U10                                      |
| U12  | Package, migration and release handoff                     | U11                                      |

Provider compatibility investigation in U07 can start after U01. Rich-text API
experiments can start before U04 completes, but must not freeze a conflicting
slice/anchor model. Maintain these dependency gates even when work is delegated.

### U00 — Capture the real baseline

**Owns:** validation record, current contract inventory, legacy fixture capture.

1. Read applicable repository instructions and inspect status. Record the
   starting commit and changed/untracked files without exposing secrets. Preserve
   the working tree; do not use reset, clean, or an incomplete HEAD-only worktree
   as a shortcut. If isolating work, explicitly include the current product state.
2. Install the existing locked dependencies with the project's package manager.
   Record tool versions. Establish current model, DOM, type, package, and browser
   results using the commands in section 9. Do not trust historical green/red
   claims. Diagnose only task-relevant blockers.
3. Inventory direct engine imports and private-field access throughout runtime,
   plugins, tests, demo harness, selection, providers, and public declarations.
4. Preserve representative v13 binary documents/updates as durable fixtures:
   nested blocks, marks, inline atoms, deleted content, and disconnected pending
   edits. Use synthetic fixtures, not private user documents.
5. Record current sequential behavior for all operations being ported, including
   return values, plugin hooks, island/void rules, history boundaries, bootstrap,
   readonly output, and provider lifecycle.

**Success:** another AI can identify the actual baseline, reproduce its checks,
and distinguish pre-existing failures from changes. Legacy fixtures are loadable
with the recorded v13 version. No user work is lost.

### U01 — Vendor the core and prove the package boundary

**Owns:** vendor subtree, provenance/patch manifest, engine exports, dependency and
package configuration necessary for the vendor.

1. Import the selected complete upstream source and applicable tests at the pinned
   commit. Preserve MIT license and notices. Record source checksum, dependency
   lock, local patches, and how to compare with the upstream base.
2. Build an initially unmodified baseline with its compatible pinned lib0.
   Establish the applicable upstream test result. Do not omit existing failing
   core tests from the record or substitute a package import smoke for them.
   Isolate its dependency resolution while the existing runtime still uses lib0
   0.2.117: use a separate test/build environment or a temporary exact dependency
   alias scoped to the core harness. Do not assume upgrading the root lib0 early
   leaves old providers compatible. Remove development-only aliases at cutover;
   packed consumers must require no Vite/test alias.
3. Verify actual Node creation, semantic attributes, sequences, formatting,
   observers, positions, update encoding/decoding, and UndoManager APIs in small
   executable checks. Published npm artifacts alone do not contain the entire
   upstream test suite.
4. Define the public Doc/Awareness creation/import path and raw-engine migration
   contract. Keep one canonical constructor identity. A narrow export module is
   useful; a fake v13 API compatibility layer is not the objective.
5. Prove a small packed consumer can import the vendored engine and its types.
   Ensure `svelte-package` includes its implementation and declaration references
   in `dist`; this tool does not bundle arbitrary external source automatically.
   Check browser use and explicitly supported SSR/Node entry conditions. Record
   the selected upstream package's Node >=22 requirement and verify/document the
   supported build and consumer runtimes instead of changing them implicitly.
6. Record the provider compatibility gap for U07. The old engine may remain
   isolated in baseline/migration fixtures during development; no document may
   mix v13 and v14 live objects.

**Success:** reproducible unmodified vendor baseline, tests, licensing, a working
distribution path, and one explicit engine API boundary. No claimed performance
gain merely from vendoring. Runtime cutover is not required in this unit.

### U02 — Build the semantic and measurement harnesses

**Owns:** new CRDT fixtures beside the existing model suites, durable regression
scenarios, reproducible benchmark entry points and output format.

1. Build on Vitest. Seed one document, serialize it, and create independent
   replicas from that seed. Do not initialize peers independently from the same
   JSON and mistake distinct identities for a common document.
2. Control connectivity, client identities, transaction origins, delivery order,
   duplicate delivery, update batching, reload, and reconnection. Include two
   and three replicas. Exercise incremental and complete-state synchronization.
3. Assert stable IDs, live payload identity, ownership, marks, projected ordering,
   anchors, and history in addition to serialized JSON equality. Check
   convergence after complete delivery and structural validity throughout.
4. Add deterministic schedules for section 8. Reproduce #694 and the cursor case
   against the historical reference in an isolated diagnostic fixture; never
   ship the old engine in production. The new model must pass equivalent
   semantic regressions. If native movement is selected, also test every core
   traversal surface directly.
5. Add seeded operation generation with explicit expected invariants. Persist
   failing seeds and minimize failures into readable tests. Start with at least
   100 fixed seeds of 200 operations each across three peers for the bounded CI
   corpus; maintain a larger documented pre-release run. These are initial
   coverage targets, not a correctness proof.
6. Establish comparable current-v13 and unmodified-v14 measurements. Run the
   engines separately. Record hardware/runtime, document shape, warmup, repeated
   samples, encoding mode, and bundle settings.

**Success:** failures are reproducible from committed fixtures and commands, not
ephemeral `/tmp` files. The harness distinguishes convergent data loss from
correct editing. Expected-red requirement tests stay isolated from green gates
and have named owning units; never weaken their assertions to pass a prototype.

### U03 — Select and prove the move primitive

**Owns:** placement semantics, move contract, ordering/cycle policy, focused model
implementation and tests; an architectural decision record.

1. Inspect all three user references and their pinned implementations. Record
   which contract each supports. Preserve the historical regressions from U02.
2. Implement the stable-registry plus atomic-placement candidate on the vendored
   core. Placement must include enough deterministic information for conflict
   and cycle resolution. Specify destination indexing and concurrent winners.
3. Choose a rank representation that remains insertable between concurrent
   neighbors. Test equal-prefix ranks, repeated same-gap operations, same-client
   subsequent edits, extreme prefixes/suffixes, reload, and key growth. Do not
   use floating-point midpoints as an unbounded ordering space. Avoid global
   renumbering until its concurrency/undo behavior is specified and tested.
4. Specify parent cycles, deleted/missing parents, subtree deletion, and projected
   root placement. Show why the projection is deterministic and cannot hide a
   live block forever. Define grouping and overlapping-group outcomes explicitly.
5. Compare this candidate with the historical native algorithm's required port.
   If placement passes the product contract and budgets, select it and keep the
   historical path as evidence. Do not build two production engines. If it cannot
   meet a required contract, identify the minimal counterexample, then port or
   design native movement across all affected core surfaces listed in section 3.
6. Prove engine-level selective undo before freezing the representation: retract
   a local move after a remote move or edit of the same block, then redo after
   deletion or another placement change. Define which contribution is reversed;
   do not postpone an incompatible history design until the UI port.
7. Write the selected algorithm, invariants, conflict order, operation inputs,
   complexity, wire impact, limitations, and exact expected conflict examples.

**Success:** single, cross-parent, nested, and grouped moves preserve identity;
move-versus-edit retains the edit; concurrent moves do not duplicate blocks;
cycle, rank-collision, and engine-level HI01/HI02 move tests pass. The decision is
selected and executable, not “consider fractional indexes later.” A custom core
opcode is required only if this unit's evidence selects it.

### U04 — Select and prove text ownership through split/merge

**Owns:** backing text lifetime, structural boundary/ownership semantics,
split/merge algorithm, anchor affinity, and focused tests/decision record.

1. Prototype stable backing rich-text instances with structural references that
   can partition/recombine visible content without copying text identities.
   Express ownership across the document, not independently per block.
2. Specify the state/operation format and conflict order. Resolve concurrent
   splits at equal/different anchors and overlapping merges with exact expected
   projections. Sequential repeated Enter must retain its existing meaning;
   concurrent equal-boundary splits need a documented multiplicity policy.
3. Define typing/deletion/formatting across a slice boundary or a join between
   backing texts, start/end affinity, deleted endpoints, empty slices, and inline
   atoms. Choose one consistent offset contract across Unicode, embeds, and DOM.
4. Prove exclusivity and reachability: no duplicated segment after A+B versus B+C;
   no lost suffix edit after a split; no resurrected deletion because text was
   copied before a remote delete arrived.
5. Define lifetime and GC. Deleting a source block must not delete text displayed
   by a surviving block. Specify history retention and late-update integration.
6. Prove structural inverses against concurrent changes at engine level. Undo a
   split after another peer edits its suffix; undo a merge after text has been
   edited or moved again. Add move/reparent versus split/merge and deletion versus
   split/merge schedules using U03's placement contract. Define which block
   identity owns each surviving slice when the structural destination changes.
   For example, when A=`ab` moves from P to Q concurrently with a split into
   A=`a` and B=`b`, specify whether B belongs under P or Q, why, and its ordering.
   “Both replicas agree” alone does not answer the product question.
7. If structural records over current Node cannot meet the contract or measured
   costs, add the smallest justified core support. Specify its encoding and
   migration consequences before changing the update format.

**Success:** all TX and combined structural cases in section 8 pass at engine
level, including three-peer overlapping changes, selective structural undo,
and reload. The algorithm has one canonical ownership rule, an explicit boundary
policy, and a demonstrated lifetime strategy. A happy-path slice wrapper or a
call to `clone()` is not sufficient.

### U05 — Own formatted runs and inline content efficiently

**Owns:** rich-text projection API, mark representation, native inline atoms,
change notifications and cache behavior.

1. Evaluate the pinned `Node.delta` contract: lazy initialization, mutation during
   transactions, deep events, and renderer caveats. Compare held cache state
   with a fresh authoritative delta after local/remote edits and history.
   Consumers must not mutate the engine-owned cache or retain it as an immutable
   snapshot. Clone at explicit snapshot boundaries.
2. Expose one maintained run view to Edytor. Keep unaffected runs/mark sets stable
   where possible. Integrate explicit change notifications with Svelte; an
   in-place engine cache mutation is not automatically a reactive invalidation.
3. Keep independent formatting keys replicated independently. Preserve supported
   mark values, removals, deterministic rendering order, and insertion affinity.
   Convert to public JSON at its API/export boundary, not repeatedly through
   JSON and tuples for normal rendering.
   First write golden expected outcomes for overlapping same-key ranges,
   concurrent add/remove, competing values, and insertions at either endpoint
   including a deleted endpoint after split/merge. State which pinned upstream
   semantics are accepted and any deliberate Edytor differences. Cache/fresh
   delta equality cannot substitute for this independent semantic oracle.
4. Integrate inline atoms into backing rich-text sequences if the native v14
   representation meets the contract. Preserve atomic deletion, mutable inline
   metadata, and identity. Surrounding text must not be copied to insert a
   mention. Public content wrappers may still expose logical text/inline views
   without persisting empty separator texts.
5. Keep plugin decorations such as Prism syntax tokens local. Preserve or
   explicitly adapt `transformText`; do not persist derived syntax marks into the
   CRDT. Include readonly projection.
6. Measure invalidation and allocation sites. Include observer-driven refresh,
   explicit refresh calls, renderer keys, and whole-document `onChange`
   serialization. Optimize the owned cause without changing callback semantics
   silently. Specialize the core only for a demonstrated remaining cost.

**Success:** annotation and inline cases pass; rendered/exported text and marks
match the authoritative model; no internal physical-list scanner remains in
the normal renderer path; unaffected text is not rematerialized unnecessarily.
Any unavoidable full traversal is measured and attributed to a documented API.
“Zero transformation” is not promised: overlapping annotations still need a
resolved visible run representation.

### U06 — Assemble the complete document model

**Owns:** schema, stable storage, canonical projections, operation composition,
initialization, JSON boundary, normalization, and semantic change events.

1. Combine the selected placement, ownership, and rich-text implementations into
   one schema. Record semantic Node roles explicitly; `instanceof Y.Text` versus
   `Y.Map` cannot distinguish them in a unified Node API.
2. Define engine/schema versions and document initialization. Handle concurrent
   initial creation and the empty-root invariant deterministically. Do not let
   each peer create unrelated random fallback paragraphs during normalization.
3. Provide the operations required by the existing command layer: creation,
   move/nest/unnest, split, merge, deletion with/without child preservation,
   text insertion/deletion/formatting, inline insertion/removal, and metadata
   updates. Reuse one semantic implementation per operation.
4. Distinguish operations where new identity is intentional—paste, duplication,
   explicit content replacement—from relocation and structural editing. Do not
   mechanically turn every JSON copy into a move.
5. Define canonical read/notification behavior for ordered children, content,
   parent/path/index, affected ranges, and exported JSON. Apply observed changes
   to an independent mirror and compare with fresh materialization.
6. Preserve islands, voids, and visible content invariants. Remove obsolete
   storage normalization only when the replacement owns the same user behavior.

**Success:** one engine-level model passes MV/TX/ST/AN cases, engine-level
HI01/HI02 structural inverses, and seeded schedules; serialization preserves the
public JSON shape; change events and fresh reads agree. No generic alternative
backend or parallel semantic implementation is introduced. Core format changes,
if any, are documented and fixture-tested.

### U07 — Port providers and preserve saved documents

**Owns:** sync/awareness implementations, public provider types, IndexedDB and
BroadcastChannel integration, version negotiation and migration fixtures/tooling.

1. Inspect provider APIs against the vendored engine. Use compatible upstream
   implementations when verified; otherwise port the minimal relevant provider
   code with attribution. Resolve engine imports throughout their dependency
   graph. Do not silence v13 peer/type failures with assertions or aliases.
2. Preserve the current `{ doc, awareness, synced }` lifecycle intent, hydration
   order, cleanup, and owned/shared awareness rules. Publish the new concrete
   engine contract and supported provider construction path.
3. Version both application schema and any changed wire/presence format. Reject
   unsupported documents/peers before applying application mutations. A metadata
   marker alone does not stop an old client writing to a shared room: define the
   transport/storage separation or handshake that actually enforces the boundary.
4. Test legacy binary decoding separately from application-schema conversion.
   Define what is retained or intentionally reset: logical IDs, character IDs,
   pending offline updates, presence, and history. Never describe JSON import as
   preserving CRDT identities or old collaborative undo.
5. Implement a non-destructive migration path using copied fixtures/new storage
   generations and verification before switching the active pointer. Retain the
   original data for rollback. If disconnected legacy writes cannot be mapped,
   require an explicit version/epoch cutover and a recovery/import path; do not
   accept them into the new schema and silently lose their intent.
   Make migration idempotent and define one authoritative generation/cutover
   decision under concurrent tabs or clients. Rehearse interruption before and
   after snapshot persistence and before and after activation. Resuming must
   neither duplicate identities nor accept two competing migrated documents.
6. Port update persistence and compaction. Verify a stored compacted snapshot plus
   later updates reconstructs the complete document. Use isolated test databases;
   do not clear user databases to get a passing result.
7. Classify server compatibility. Opaque update relays may remain reusable;
   services that load, merge, compact, validate, or inspect documents need the
   compatible engine/format. Test the actual supported websocket path.

**Success:** separate clients and browser tabs sync/reconnect; cold reload and
compaction preserve the document; lifecycle tests pass; unsupported versions fail
clearly; a rehearsed migration/rollback procedure exists. No claim of mixed-v13/
v14 live compatibility is made without dedicated evidence.

### U08 — Cut over Edytor wrappers and operations

**Owns:** runtime and component engine imports, Block/Text/InlineBlock hydration,
operation utilities and structural callers, public declarations and fixtures.

1. Port the runtime once to the selected model. Avoid a production detour that
   migrates the old nested schema to Node and later rebuilds it again. Remove
   obsolete v13 constructors/private-field assumptions from live application code.
2. Preserve wrapper identity and attachment maps for surviving logical nodes.
   Resolve parent/index/path from the canonical projection. Distinguish hidden,
   deleted, moved, and detached nodes through the model's liveness contract.
3. Route `moveBlock`, `nestBlock`, `unNestBlock`, split/merge, inline insertion,
   adjacent-text normalization, and keep-children deletion through the owned
   primitives. Inspect code-block normalization and other direct structural
   callers. Port grouped drag in `blockHandleOperations.ts` explicitly.
4. Preserve plugin before/after interception, transactions, operation results,
   bootstrap, `onChange`, readonly views, and supported replacement semantics.
   Update tests and the browser harness to use the same engine constructors.
5. Replace delta reconstruction with U05's maintained view. Remove dead adapter
   code and obsolete separator storage after callers have been migrated.
6. Document raw-engine public API changes; provide examples of creating matching
   docs/providers. Do not hide incompatible changes behind broad type casts.

**Success:** existing sequential model fixtures pass or have a documented,
justified contract update. All structural command paths retain required
identities. No production runtime path creates old-engine objects. Selection and
history completion belongs to U09; this intermediate state is not releasable.

### U09 — Integrate selection, selective undo, and input

**Owns:** selection/DOM coordinate mapping, history origins/scope/metadata,
presence positions, renderer attachment lifecycle, input/composition liveness.

1. Resolve backing anchors through current slices into visible wrappers and DOM
   offsets. Support both endpoints, direction, selected blocks, boundaries,
   inline atoms, Unicode, hidden/deleted targets, and remote awareness.
2. Update undo scope to include every new replicated store changed by a user
   operation. Keep provider/remote origins out. Preserve grouping and selection
   metadata; verify undo/redo after concurrent edits and moves, not only local
   round trips. Integrate the structural inverse rules already proved in U03/U04.
   If integration invalidates them, return to that decision gate and revalidate
   schema/migration implications; do not silently add a competing history model.
3. Version presence data as required and define safe handling of unsupported
   presence without interpreting offsets against the wrong model. Preserve the
   shared-awareness cleanup contract.
4. Ensure native DOM mutation repair, IME composition, beforeinput, and stale-node
   handling recognize moved-but-live content. Avoid remounting unaffected text
   during a mark or placement update when that would disrupt composition.
5. Port readonly and plugin rendering assumptions affected by mark/inline views.
   Keep browser behavior in existing input/selection owners rather than patching
   individual snippets with model workarounds.

**Success:** history grouping fixtures, selection/awareness tests, inline atomicity,
and applicable browser input/composition tests pass. Cursors follow content
through move/split/merge and local undo preserves unrelated remote changes.

### U10 — Prove the integrated editor on independent peers

**Owns:** end-to-end convergence fixtures, real-browser multi-client scenarios,
regression reduction and validation report.

1. Run section 8 through actual Edytor operations over separate docs, not only
   the engine prototype. Include plugins, normalization, input translation,
   selection restoration, and grouped drag.
2. Extend the existing browser harness to connect independent editors with
   controlled disconnect/reconnect. Test typing during another user's structural
   edit, remote selections, undo after merge, offline persistence, and multi-tab
   startup/cleanup. A shared in-memory Doc cannot stand in for network behavior.
3. Run the fixed randomized corpus and a larger recorded pre-release campaign.
   Turn every discovered relevant failure into a minimal durable regression.
4. Run applicable browser projects, including Firefox, WebKit, and mobile
   configurations; report what synthetic composition tests do and do not prove.
   Perform a focused real-browser interaction audit for the changed workflows.

**Success:** integrated tests establish convergence, identity retention, valid
ownership, correct visible results, and interaction behavior. No skipped
required conflict case or JSON-only test substitutes for a failed identity test.

### U11 — Specialize the measured costs and trim the bundle

**Owns:** profiles, targeted engine/application optimization, retained-feature
inventory, bundle analysis, comparison report.

1. Measure the complete integrated implementation against U02's baselines using
   section 10. Separate engine time, projection, Svelte/DOM work, callbacks,
   transport payload, retained memory, and load time.
2. Prioritize demonstrated costs: structural copying, annotation reconstruction,
   repeated whole-document serialization, rank/tree projection, boundary lookup,
   or formatted-position indexing. Do not add a second cache/index without clear
   ownership and invalidation.
3. Compare v14's native maintained view with any proposed specialized text type.
   Change storage/core algorithms only when the same workload demonstrates a
   useful improvement and the correctness suite stays green.
4. Remove unused runtime surfaces after identifying which readers, encoders,
   legacy fixtures, provider APIs, and public contracts still require them.
   Preserve numeric type references; do not renumber decoders after deletion.
   Reject unsupported formats explicitly if support is intentionally removed.
5. Retain an upstream comparison manifest and narrowly explained patches. Avoid
   generic CRDT features unrelated to Edytor. Rerun affected upstream tests and
   the full semantic corpus when core integration/encoding/GC changes.

**Success:** a reproducible report shows actual gains and any remaining costs.
Moves/splits do not emit copied payload proportional to retained text. Normal
local edits do not rebuild unrelated rich-text projections. Bundle reductions
are demonstrated against the appropriate v14 baseline and correctness remains
unchanged. A smaller type count or a speculative speed claim is not evidence.

### U12 — Complete the package and release handoff

**Owns:** release validation, packed-consumer smoke, migration documentation,
public API examples, durable repository guidance and final completion record.

1. Run the full existing release command and added CRDT/upstream/package checks.
   Separate unrelated baseline failures from regressions; do not claim a green
   release if a required check failed or was not run.
2. Build and pack the actual library, install it in a clean Svelte consumer, and
   verify declarations, editor/readonly rendering, plugins, document/provider
   creation, collaboration, and the documented SSR/Node support. Inspect the
   artifact for missing vendor code, private paths, licenses, and duplicate
   engines. Do not publish as part of this smoke test.
3. Rehearse migration, offline cutover behavior, version rejection, snapshot
   compaction, reload, and rollback on copied fixtures with the packed package.
4. Update applicable project-local documentation for the new schema, semantic
   owners, package exports, commands, provider requirements, fork maintenance,
   and supported formats. Do not modify the user constitution.
5. Remove abandoned prototype paths and development-only dual-engine wiring.
   Keep historical compatibility fixtures only where they serve a test contract.
6. Produce a completion record linking the algorithm decisions, tests, measured
   results, package artifact, migration procedure, and any unresolved blocker.

**Success:** every global completion criterion in section 11 is evidenced. The
result is ready for user review and a separately authorized release.

## 7. Decision gates and execution discipline

The implementation should advance autonomously through settled, reversible work.
Do not ask for approval at every unit. Ask only when a concrete unresolved product
choice contradicts existing behavior, requires destructive handling of real
data, or expands the agreed scope. Present the smallest failing example and
concrete alternatives, not a general claim that CRDTs are difficult.

- **After U01:** the selected source builds/tests and can be distributed. Resolve
  engine/provider identity before porting application consumers.
- **After U03/U04:** select the move and ownership algorithms against written
  outcomes, including engine-level selective undo and combined structural
  conflicts. U09 adds history/selection integration, not the first test of
  whether the chosen schema supports undo. Do not bury open conflict semantics
  in implementation TODOs.
- **After U06/U07:** schema, public engine boundary, offline cutover, and history
  retention are explicit before the application cutover.
- **After U10:** functional correctness is established before size-oriented
  feature removal or more invasive performance work.
- **After U12:** report complete only with artifact and validation evidence.

Maintain an execution ledger beside the plan. Each entry records unit, status
(`planned`, `in progress`, `blocked`, `complete`), owned files, selected decisions,
commands/results, and remaining requirement IDs. All units start as `planned`.
Keep failure reports exact. Do not silently replace errors with empty documents,
fallback arrays, skipped tests, or regenerated IDs.

## 8. Minimum correctness matrix

These are required scenarios, not a claim that the list is exhaustive. For every
conflicting schedule, compare all replicas after complete delivery, both update
orders where applicable, duplicate replay, and reload. Include local views before
sync and user-visible intent, not only eventual equal serialization.

| ID   | Scenario                                                                                                 | Required assertion                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| MV01 | Move a text-bearing block while another peer inserts/deletes/formats inside it                           | One original logical block; permitted edits and marks follow it                                        |
| MV02 | Same block concurrently moved to different positions/parents                                             | One deterministic placement; no duplicated payload                                                     |
| MV03 | Reorder first/last/middle, no-op, adjacent gap, both directions                                          | Exact destination contract; stable IDs and coherent events                                             |
| MV04 | Nest/unnest and move a subtree while descendants are edited                                              | All surviving descendant identities and edits retained                                                 |
| MV05 | Concurrent A-under-B and B-under-A; longer ancestor cycle                                                | Deterministic acyclic reachable projection on every peer                                               |
| MV06 | Move versus block/subtree deletion; delete destination parent                                            | Explicit deletion/descendant policy; no hidden orphan or accidental resurrection                       |
| MV07 | Disjoint/overlapping group moves and a member moved separately                                           | Specified membership/winners; uncontested relative order; one local undo step                          |
| MV08 | Concurrent rank collision, then insert/move between tied neighbors                                       | Correct insertion position; deterministic comparator; no exhausted numeric gap                         |
| MV09 | #694 separate inserts then move, with reads in the same transaction                                      | Dense correct materialization; length/index/iteration/cache views agree at their documented boundaries |
| MV10 | Anchor to a moved element; nested observer paths and event mirrors                                       | Anchors and projected paths follow content; mirror equals fresh read                                   |
| TX01 | Split `hello world` before `world`; concurrently append `!`                                              | Visible suffix is `world!`, not `world` with `!` stranded before it                                    |
| TX02 | Same split; concurrently delete original suffix                                                          | Deleted characters are not recreated by the split                                                      |
| TX03 | Merge two blocks; concurrently edit/format the second                                                    | Merged content retains those edits without copied identities                                           |
| TX04 | Concurrent splits at same/different anchors; repeated causal splits                                      | Exact specified partition/multiplicity; no overlap or dropped characters                               |
| TX05 | A+B and B+C concurrent merges; split versus overlapping merge                                            | Each surviving atom appears once; deterministic ownership                                              |
| TX06 | Insert/delete/format exactly at split/join boundaries                                                    | Specified affinity, inheritance, and deleted-anchor fallback                                           |
| TX07 | Several move/split/merge cycles followed by a late offline edit                                          | Original target identity resolves to its current owner                                                 |
| TX08 | Delete original source block while another block owns its slice                                          | Surviving slice remains editable and reloadable; GC preserves needed backing state                     |
| TX09 | Empty blocks, inline atoms, nested children, island/void boundaries                                      | Existing sequential behavior and structural constraints retained                                       |
| ST01 | Move/reparent versus split/merge of the source or destination block                                      | Specified block identity and placement for every surviving slice; no lost/duplicated text              |
| ST02 | Delete a source/destination/ancestor while another peer splits or merges                                 | Explicit visibility and child/slice ownership; no hidden orphan or resurrected payload                 |
| ST03 | Move, split, merge and edit combined across three offline peers                                          | One valid tree and exclusive text ownership under all tested schedules                                 |
| AN01 | Concurrent overlapping bold/italic, removal, object-valued mark                                          | Independent keys merge; correct run boundaries and JSON                                                |
| AN02 | Formatting across split/merge; typing at a marked boundary                                               | Formatting follows atoms and documented affinity                                                       |
| AN03 | Inline insertion while remote peer edits surrounding text                                                | Original characters survive; atom metadata/selection remain correct                                    |
| AN04 | Live delta cache, fresh delta, incremental run view, readonly export                                     | Equivalent content/marks; proper invalidation and snapshot isolation                                   |
| AN05 | Local syntax decorations with remote persistent marks                                                    | Decorations are not replicated; persistent marks remain correct                                        |
| AN06 | Concurrent overlapping same-key marks, add/remove, and conflicting values                                | Explicit golden semantic outcome independent of the cache/export implementation                        |
| AN07 | Insert at either annotation endpoint, including an endpoint deleted by another peer across a split/merge | Specified mark inheritance and anchor affinity; no lost annotation intent                              |
| HI01 | Local move/split/merge undo after remote text/placement edits                                            | Selective undo preserves unrelated remote contributions                                                |
| HI02 | Redo after deletion; grouped move; typing/mark/paste grouping                                            | Documented history boundaries and stable ownership                                                     |
| SE01 | Forward/backward range spanning moved/split/merged content                                               | Both endpoints, direction and selected blocks resolve correctly                                        |
| SE02 | Unicode graphemes, surrogate pairs, embeds and deleted anchors                                           | Consistent CRDT/DOM offsets; valid caret and fallback                                                  |
| SE03 | Remote presence before/after reconnection and format mismatch                                            | Correct positions or explicit unsupported-format handling                                              |
| IN01 | Native input/IME during remote move, split, or formatting                                                | No lost composition, stale-node write, or duplicate insertion                                          |
| SY01 | Independent offline peers, reorder/duplicate delivery, state-vector sync                                 | Convergence and intent; no dependence on shared object identity                                        |
| SY02 | Cold IndexedDB reload, compaction, BroadcastChannel, cleanup                                             | Complete state and correct ownership/lifecycle                                                         |
| SY03 | Concurrent bootstrap and empty-root normalization                                                        | One valid canonical root; no repair-driven duplicate placeholders                                      |
| CO01 | Legacy fixtures, unsupported schemas/wire operations, offline old client                                 | Tested migration/rejection; originals retained; no silent corruption                                   |
| CO02 | Repeat migration or run it concurrently from two tabs/clients                                            | Idempotent canonical result; one active generation; no duplicated identities                           |
| CO03 | Interrupt migration around snapshot write and activation; resume/rollback                                | Recoverable verified state; original data retained; no partially active schema                         |
| PK01 | Packed fresh consumer with editor, providers and declarations                                            | One compatible engine; no missing/private vendor paths                                                 |

For core movement, also exercise native `get`, slice, iterator, map/forEach,
JSON, deltas, relative positions, and encoding where those APIs exist. For
placement-based movement, test these guarantees on the canonical editor view;
the underlying registry is allowed to retain its physical storage order.

## 9. Validation commands

These scripts exist in the inspected manifest. Establish their actual baseline;
none is asserted to have passed as part of writing this plan.

```sh
pnpm check
pnpm lint
pnpm test -- --run
pnpm test:dom
pnpm test:typecheck
pnpm test:dom:typecheck
pnpm test:integration:serial
pnpm build
pnpm package
```

The aggregate release gate is:

```sh
pnpm release:check
```

Examples of existing narrow checks:

```sh
pnpm exec vitest run src/tests/fixtures/model/collaboration/collaboration.test.tsx
pnpm exec vitest run src/tests/fixtures/model/operations.test.ts src/tests/fixtures/model/transforms.test.ts src/tests/fixtures/model/history.test.ts
pnpm test:integration:serial tests/editor-dom/collaboration.spec.ts --project=chromium
```

Fixture modules under the aggregate model suites are not necessarily standalone
test entries. Use their owning test file. U01/U02 must add and document exact
commands for vendored upstream tests, CRDT schedules, and benchmarks; those
commands do not exist yet. U12 must add the packed-consumer check to the recorded
release procedure.

Run narrow relevant checks during each unit and broaden at integration gates.
Do not repeatedly rerun the entire release suite after documentation-only changes.
Do not kill unrelated local servers to free the browser test port; resolve the
test environment without discarding another task's work.

## 10. Performance evidence and acceptance

### What is already known

Earlier isolated browser-ESM measurements used esbuild 0.28.2, ES2022, minification,
gzip level 9 and Brotli quality 11. Representative v13 APIs measured **26,134
gzip bytes**; analogous v14 APIs measured **37,744 gzip bytes**. A v13 source
experiment removing XML readers/accessors saved **1,422 gzip bytes** against its
matching source baseline. These exclude Edytor, Svelte and providers and are not
application bundle budgets. They show why vendoring or fewer shared types does
not automatically produce a smaller application.

A separate simplified v13 probe moved a text-bearing payload either by copying
or by updating placement. For 100,000 characters, raw v1 update sizes were
approximately **100,058 bytes versus 56 bytes**. This demonstrates the cost of
copying content; it is not a v14 speed, memory, or full-editor benchmark.

The new harness must reproduce relevant comparisons from durable scripts. Do
not base a release claim on these historical scratch measurements alone.

### Workloads and metrics

| Workload                                               | Required measurements                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Short typing, deletion, mark changes, inline insertion | Local/remote p50 and p95; projection allocations/invalidation; DOM work             |
| Move/nest/unnest one block and groups                  | Engine/projection time; update bytes; identity retention; key growth                |
| Split/merge long marked text repeatedly                | Local/remote latency; copied bytes; slice/boundary count; retained memory           |
| Large documents                                        | 1,000 and 5,000 blocks, depth 100; load/materialization and affected-range cost     |
| Dense formatting/inline content                        | Existing 128-run and 250-inline shapes, plus long paragraphs; lookup/render costs   |
| Offline history                                        | Repeated edits/structural changes, reconnect, GC/history retention, snapshot growth |
| Actual package/app build                               | Minified/gzip/Brotli totals and attributed engine/provider chunks; startup/load     |

Compare the current editor, unmodified v14 core/model baseline, and final
specialization where the operations are semantically comparable. A v13 baseline
that loses edits is not a correctness-equivalent competitor; label that limit.

### Acceptance rules

- Establish numerical budgets after U02's reproducible baseline and **before**
  tuning. Record the sample distribution and a repeatable comparison procedure.
  Do not invent hardware-independent millisecond guarantees in the plan.
- Moves must not include the moved text/subtree payload again in replicated
  updates merely to change its location. Splits/merges must not emit retained
  characters as newly inserted payload in those updates.
  Metadata growth and encoded identifier widths are measured separately.
- An edit to one paragraph must not reconstruct unrelated paragraphs' formatted
  run views. Preserve documented full-value callbacks while measuring their cost
  separately; changing that API requires an explicit contract decision.
- Core optimization must demonstrate a repeatable benefit on its target workload
  without correctness loss or an unexplained material regression elsewhere.
- Report memory after a comparable history/GC lifecycle, not immediately after
  omitting undo retention. Track rank, boundary, tombstone, and cache growth.
- Report final bundle size honestly, including providers and duplicate-dependency
  checks. If correct v14 remains larger than v13, do not label it a size win.
  Remove proven unused code and state any remaining bundle target as unmet.

## 11. Global definition of done

The handoff is complete only when all of these are evidenced:

- A pinned, attributable, reproducible vendored v14 engine ships through Edytor's
  actual package and has a maintained upstream comparison/patch record.
- Same-parent, cross-parent, nested, and grouped moves retain identity and pass
  the concurrency, cursor, deletion, event, and undo contracts.
- Split/merge operations preserve original atoms and concurrent edits, with one
  canonical owner per visible atom under the full conflict matrix.
- Rich-text formatting and local decoration behavior are preserved with a
  maintained rendering view; redundant normal-path conversions are removed.
- Existing model/input/plugin/readonly behavior, selection, awareness, history,
  providers, and persistence are integrated with one engine.
- Independent replica tests, deterministic randomized schedules, required
  browser checks, upstream checks, and package-consumer checks pass. Any unrelated
  baseline failure is reported separately and never presented as a passing gate.
- Migration, old offline-client handling, version boundaries, backup/rollback,
  and compaction are tested on retained synthetic documents.
- Performance and bundle results are reproducible, measured against recorded
  baselines, and explicit about any unmet target.
- No required behavior is left behind a stub, ignored assertion, disabled test,
  hidden data reset, or untracked TODO.

## 12. Copyable kickoff for the implementing AI

> Implement the Edytor vendored Yjs v14 plan in
> `docs/crdt-v14-implementation-plan.md`. Treat that document as the task contract
> and read applicable repository instructions. Preserve the current working tree,
> including uncommitted work. Begin with U00, then follow the dependency gates.
> The selected direction is direct vendoring of the pinned current v14; do not
> restart a v13-versus-v14 debate or build a preliminary v13 optimization layer.
> Moves, including reparenting and grouped moves, and identity-preserving text
> splitting/merging are required. Select their algorithms from explicit conflict
> outcomes and independent-replica evidence. Preserve current marks, decorations,
> selection, history, provider lifecycle, readonly behavior, and public JSON.
> Keep a concise execution ledger with unit status and validation results. Work
> autonomously on settled steps; surface only concrete decisions that change
> product contracts or cross an authorization boundary. Do not publish, deploy,
> or destructively migrate real user data. Complete the integrated package and
> its evidence, not only an engine prototype.
