# CRDT architecture evaluation for Edytor

Evaluated on 2026-09-19 against the current working tree and pinned upstream
sources. This is an assessment and a proposed development path, not an
implementation or a migration decision.

## Recommendation

Build an editor-specific replicated document model that preserves block and
character identity through moves, splits and merges. This can materially improve
collaborative editing. Start by proving those semantics over stock Yjs. Vendor a
pinned core and add narrowly scoped changes if that prototype exposes a concrete
semantic limitation or a measured performance limit.

A fork is technically viable. The strongest reason to maintain one would be
better editing semantics or a more efficient representation demonstrated against
the same workload. Removing unused shared types alone is a weak justification:
the XML removal experiment saved 1,422 gzip bytes. Implementation difficulty is
not the deciding factor; correctness, representation and measured results are.

## What the upstream evidence changes

The checkout pins `yjs` **13.6.30** and `lib0` **0.2.117**. Dependencies were not
installed in the checkout during this assessment. The experiments used isolated
temporary installations of those versions.
[Package manifest](/Users/arnaud/code/edytor/package.json),
[lockfile](/Users/arnaud/code/edytor/pnpm-lock.yaml).

The current v14 prerelease is **`@y/y@14.0.0-rc.26`**, published on September 7, 2026. The old `yjs@next` and `yjs@beta` tags point to earlier prereleases. Current
v14 exposes one `Y.Node` instead of the separate shared-type classes. It does not
provide native `move`/`moveRange` or identity-preserving text split/merge methods.
[Registry](https://registry.npmjs.org/@y%2Fy),
[pinned manifest](https://github.com/yjs/yjs/blob/96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64/package.json),
[exports](https://github.com/yjs/yjs/blob/96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64/src/index.js#L25),
[sequence operations](https://github.com/yjs/yjs/blob/96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64/src/ynode.js#L1795).

Early v14 experimental array moves operated within the same collection. They did
not provide general reparenting or move a suffix between independent text
containers. The move feature was subsequently removed; the Yrs author's account
explains the pervasive iterator complexity and proposes changing ordering
attributes while keeping elements alive.
[Early implementation](https://github.com/yjs/yjs/blob/b56debef005caef8660c672e17cec3e869646422/src/types/YArray.js#L141),
[first-party explanation](https://www.bartoszsypytkowski.com/replacing-yjs-move-feature/).

**Consequence:** upgrading to v14 is a separate API migration, not the solution
to the required move and split behavior.

### Starting directly from a vendored v14 baseline

Given the annotation findings below, the preferred next experiment is a pinned,
initially unmodified v14 source baseline. There is no requirement to implement
an intermediate v13 optimization layer first. Its unified Node and maintained
delta interface are relevant foundations for the proposed editor model.

Vendoring the baseline and changing its replicated semantics are separate
decisions. The former gives Edytor control of the source and release schedule;
the latter still needs the conflict contracts and measurements described here.
An unchanged vendored copy has the same runtime behavior as the same pinned
package version. No size or speed gain follows from copying the source itself.

Use the inspected rc.26 commit and pin its compatible lib0 dependency. Retain
upstream attribution and the applicable source test suite. Integrate the native
v14 API, then add stable placement and text-slice behavior; make core changes
where that implementation demonstrates their value. The stock-Yjs prototype
steps below can all run on this unmodified vendored v14 baseline.

The concrete integration boundary is broader than one import. Edytor's current
provider dependencies declare Yjs 13 peer ranges, its public sync callback
accepts a Y.Doc, and model code inspects v13 constructors and internals. Those
paths need compatible implementations using one engine. V14 includes historical
v13 decoding tests, but that does not establish full compatibility with our
provider APIs, stored history or a future document-schema change.
[Locked provider ranges](/Users/arnaud/code/edytor/pnpm-lock.yaml:1784),
[sync contract](/Users/arnaud/code/edytor/src/lib/collaboration/providers.ts:11),
[upstream compatibility tests](https://github.com/yjs/yjs/blob/96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64/tests/compatibility.tests.js),
[v14 package and dependency](https://github.com/yjs/yjs/blob/96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64/package.json).

## The useful lesson from Notion

Notion describes its own RGA-based CRDT with Peritext-derived formatting, not a
Yjs fork. Its text slices retain a stable text-instance identity after changing
blocks. An operation can therefore find its original characters in their new
block. Search labels reduce the number of separately stored blocks fetched for
that lookup. The authors explicitly describe applicability to Yjs/ProseMirror as
unvalidated. The article supplies no comparative performance measurements or
complete structural conflict specification.
[Notion article](https://www.notion.com/blog/how-notion-handles-concurrent-editing-with-crdts).

For Edytor, the transferable requirement is **text identity must survive changes
in block ownership**. Notion's database routing index is not automatically needed
inside Edytor's loaded `Y.Doc`. Peritext addresses inline formatting; it does not
supply the missing split/merge/tree-move semantics.
[Peritext scope and future work](https://www.inkandswitch.com/peritext/).

## Where Edytor currently loses identity

The relevant code creates new CRDT content from snapshots:

- `splitText` extracts JSON text runs and deletes the suffix; `splitBlock`
  recreates that suffix, following inline content and children in a new block.
  [Text operation](/Users/arnaud/code/edytor/src/lib/text/text.utils.ts:308),
  [block operation](/Users/arnaud/code/edytor/src/lib/block/block.utils.ts:197).
- `moveBlock`, `nestBlock` and `unNestBlock` delete the old block and construct a
  new `Block` from its JSON value. This replaces the underlying Yjs identities.
  [Move and nesting operations](/Users/arnaud/code/edytor/src/lib/block/block.utils.ts:333),
  [constructor](/Users/arnaud/code/edytor/src/lib/block/block.svelte.ts:391).
- Merge and adjacent-text normalization append copied text and delete the old
  container. Inserting an inline block also invokes `splitText`, so the same
  identity issue extends beyond Enter.
  [Append operation](/Users/arnaud/code/edytor/src/lib/block/block.utils.ts:122),
  [merge operation](/Users/arnaud/code/edytor/src/lib/block/block.utils.ts:259),
  [inline insertion and normalization](/Users/arnaud/code/edytor/src/lib/block/block.utils.ts:567).

Changing a JavaScript wrapper or preserving a JSON block ID would not preserve
the original character identities. A transaction groups these mutations; it
does not convert delete-plus-copy into a replicated move.

### Reproduced failure mechanisms

An isolated Yjs 13.6.30 probe reproduced the same underlying operation patterns
using nested maps, arrays and texts. Each case began with two independent
replicas of one seed document. Their concurrent updates were applied in both
orders to fresh receivers, then replayed to check duplicate delivery.

| Concurrent operations                                               | Observed visible result         | Required behavior                                  |
| ------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------- |
| Split `hello world` before `world`; append `!` to the original text | `hello !` / `world`             | `hello ` / `world!`                                |
| Same split; delete the original `world`                             | `hello ` / `world`              | The deleted suffix stays deleted                   |
| Move `one` after `three`; append `!` to `one`                       | `two` / `three` / `one`         | The moved block contains `one!`                    |
| Move the same `one` block to different destinations                 | `two` / `one` / `three` / `one` | One visible block at one deterministic destination |
| Merge `hello ` and `world`; append `!` to the second block          | `hello world`                   | `hello world!`                                     |

Both delivery orders converged in all five cases. The defect is loss of intended
content or placement despite convergence. These are source-pattern probes, not
full Edytor runtime regressions: they do not execute Svelte, editor
normalization, selection or history. They establish the mechanism that the
editor implementation must address.
[Probe](/tmp/edytor-crdt-probe.cJMA89/probe.mjs),
[observations](/tmp/edytor-crdt-probe.cJMA89/results.json).

A control kept a block under a stable map key and changed one placement value
while another replica appended text. It retained both the new placement and
`one!` in both delivery orders. This proves the simple move-versus-edit case,
not a complete tree or slice CRDT.
[Control experiment](/tmp/edytor-crdt-probe.cJMA89/probe.mjs).

The inspected collaboration model suite shares one `Y.Doc` between two editors.
Those tests are useful for propagation and lifecycle behavior, but that setup
does not exercise independent offline replicas.
[Existing model suite](/Users/arnaud/code/edytor/src/tests/fixtures/model/collaboration/collaboration.test.tsx:18).

## The representation to prototype

The following is a proposal, not a proven implementation.

### Stable block storage and replicated placement

Keep each block and its editable content under a stable identity, independent of
its displayed parent. Represent placement as one atomically replaced value such
as `{ parentId, rank }`. Reordering changes placement instead of copying the
block's subtree. Nesting changes the parent in that same value.

This can use stock Yjs maps. A concurrent move of one block resolves to one
placement while edits continue to target the same text. However, the domain
model must also define:

- Deterministic ordering and rank allocation after concurrent rank collisions.
  A sort tie-breaker alone does not guarantee that a new rank can be inserted
  between colliding entries.
- Cycle resolution: two individually valid moves can put A under B and B under
  A. Prefer a deterministic projection of replicated placements over
  client-specific repair writes.
- Deletion versus movement and editing, including descendants and local undo.
- Group-move behavior and the existing island/void constraints.

Storing IDs in ordinary arrays and deleting/reinserting those IDs is not a
complete alternative: it keeps content alive but still needs a unique-placement
rule for concurrent moves.

### Stable text storage and structural boundaries

Keep backing text instances alive independently of the originating block.
Represent displayed block content through slices of those instances. A split
adds a boundary and changes slice ownership; a merge combines slice references.
Neither operation should replace the original characters with copies.

Stock `Y.Text` plus replicated boundary/ownership records is the first candidate
to test. Independent start/end ranges are insufficient: concurrent splits can
overlap, and concurrent merges of A+B and B+C can display B twice. The projection
must assign every live character to one visible owner across the whole document.

Define insertion affinity at split and merge boundaries, formatting inheritance,
inline atoms, deleted anchors, and what an old operation means after several
structural changes. Cursors should resolve to a backing character and then to
its current displayed slice. Undo must invert the user's operation while
preserving concurrent edits.

Backing text cannot remain owned by a deletable original block. Reclamation
must retain the identities needed by offline edits and undo. Extra boundaries
and retained text may increase memory even when each operation becomes cheaper.
These are obligations of the proposed model, not benefits already demonstrated.

## What vendoring and custom Y types would actually buy

| Approach                                                     | Capability                                                                 | Limitation                                                                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Editor-specific classes over stock Yjs                       | Domain API, stable storage, placement and slice semantics                  | Does not automatically reduce generic runtime overhead; the projection still needs a correct specification                   |
| Fork with specialized storage but unchanged update semantics | Potentially fewer allocations, narrower APIs and smaller builds            | Gains require measurement; compatibility requires preserving the existing semantics and encoding                             |
| Fork with new move/split operations or wire types            | Direct representation of domain operations unavailable in the current core | Every interpreting peer must understand the new semantics; history, positions, GC and persistence need corresponding support |

Yjs 13 has a fixed numeric type-reader table. It references all seven built-in
types, so unused XML implementations cannot all disappear through ordinary
import changes. A subclass emitting an existing type reference is decoded as
that built-in representation; a new wire type is a protocol change. Removing
readers must not renumber the remaining references.
[Pinned decoder](https://github.com/yjs/yjs/blob/676cc334edb39867b74bd1f50a05eb85c8275d9b/src/structs/ContentType.js#L18).

V14 already consolidates shared types into `Y.Node` and preserves legacy type
references when decoding and encoding. This is worth evaluating if a specialized
core becomes justified, but it neither supplies move semantics nor guarantees a
smaller build.
[V14 decoder](https://github.com/yjs/yjs/blob/96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64/src/ynode.js#L2819),
[encoder](https://github.com/yjs/yjs/blob/96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64/src/ynode.js#L2052).

Internal storage-chunk splitting is not a block split: it retains the same
parent. Directly changing parent pointers would not establish replicated
relocation semantics. New ownership behavior must be understood by update
integration, positions, deletion and undo.
[Item splitting](https://github.com/yjs/yjs/blob/96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64/src/structs/Item.js#L396),
[relative-position resolution](https://github.com/yjs/yjs/blob/96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64/src/utils/RelativePosition.js#L278).

Edytor's migration surface includes the model wrappers and operations, direct
`Content*` inspection, awareness positions, undo scope, and provider contracts.
Changing the core import alone would be incomplete.
[Delta inspection](/Users/arnaud/code/edytor/src/lib/text/deltas.ts:92),
[awareness positions](/Users/arnaud/code/edytor/src/lib/collaboration/awarenessSelection.ts:30),
[undo scope](/Users/arnaud/code/edytor/src/lib/edytor.svelte.ts:280),
[provider API](/Users/arnaud/code/edytor/src/lib/collaboration/providers.ts:11).

## Performance evidence and limits

### Bundle size

Measured browser ESM bundles with esbuild 0.28.2, ES2022, minification, tree
shaking, gzip level 9 and Brotli quality 11. These retain representative exported
library APIs and their lib0 dependencies. They exclude Svelte, providers and the
rest of Edytor; they are not production application bundle measurements.

| Library surface                                  | Minified bytes | Gzip bytes | Brotli bytes |
| ------------------------------------------------ | -------------: | ---------: | -----------: |
| Pinned v13, Edytor's current runtime API surface |         85,286 |     26,134 |       23,461 |
| Pinned v13, broader cursor API surface           |         85,769 |     26,309 |       23,635 |
| V14 rc.26, analogous Node API surface            |        122,989 |     37,744 |       33,696 |

A scratch source build removed XML decoder support and `Doc` XML accessors. It
saved **5,758 minified bytes, 1,422 gzip bytes (5.4%), and 1,194 Brotli bytes**
against its corresponding source baseline. It deliberately rejects XML updates
and is not a validated compatible fork. This bounds only that feature removal;
it does not bound a complete redesign.

The v14 result also shows why fewer shared-type classes do not imply fewer
bytes. Neither measurement establishes runtime speed or memory use.
[Measurement method and complete results](/tmp/edytor-yjs-bundle-research.md),
[reproduction script](/tmp/edytor-yjs-bundle.lrv6Qw/measure.mjs),
[pinned dependencies](/tmp/edytor-yjs-bundle.lrv6Qw/package-lock.json).

### Update size

A separate probe compared snapshot relocation with a placement-value change for
one text-bearing block. It measured uncompressed Yjs v1 differential updates:

| Characters in the block | Snapshot relocation | Placement update |
| ----------------------: | ------------------: | ---------------: |
|                     100 |           148 bytes |         50 bytes |
|                  10,000 |        10,053 bytes |         53 bytes |
|                 100,000 |       100,058 bytes |         56 bytes |

This is a simplified representation experiment. Random client-ID encodings can
change the byte counts slightly. It is neither a full Edytor benchmark nor a
compressed network measurement. It demonstrates that avoiding text copies can
remove work and update payload proportional to the copied content, without a
core fork. Index lookup and rendering costs remain.
[Probe](/tmp/edytor-crdt-probe.cJMA89/update-bytes.mjs),
[recorded output](/tmp/edytor-crdt-probe.cJMA89/update-bytes.json).

The next performance comparison should measure operation and remote-merge
p50/p95 latency, update bytes, load time, retained memory and snapshot growth
after repeated split/merge/move cycles. Include large nested documents, marks,
inline atoms, long offline sessions and undo. Set acceptance budgets before
choosing a fork; do not infer typing speed from bundle size.

## Proposed sequence and decision gates

1. **Specify the conflict outcomes.** Turn the five reproduced mechanisms into
   tests through actual editor operations on independent documents. Add three
   replicas, reordered and repeated delivery, same/different-position splits,
   overlapping merges, nested move cycles, formatting, inline atoms, cursors and
   local undo. Completion means agreement on both convergence and intended
   visible results, not merely equal JSON.
2. **Prove stable block movement on stock Yjs.** Prototype stable storage and a
   placement rule, including deletion and deterministic tree projection.
   Completion means moving or nesting retains the original editable objects,
   remote edits and selections without duplicate blocks.
3. **Prove split and merge ownership.** Prototype stable backing text with
   canonical boundaries and exclusive slice ownership. Completion means the
   specified conflict cases preserve characters and marks through structural
   changes, with correct cursor and undo behavior. Do not ship a scheme that only
   handles one split plus one insertion.
4. **Choose the core from evidence.** Compare the stock-core prototype with a
   narrowly specialized core under the same tests and workloads. Evaluate
   current v14 as a separate candidate. Fork only for an identified semantic
   capability or a material measured gain. If stock Yjs meets the contracts and
   budgets, retain it.
5. **Integrate and define migration.** Update model operations, wrappers,
   selection, history and sync/persistence together. Even an unchanged Yjs wire
   format does not make an old application understand a new document schema.
   Version that schema and handle pending old offline updates explicitly. JSON
   export/import alone does not preserve operation identities or undo history.
   A new wire operation also requires compatible clients and any services that
   decode, merge or compact updates; opaque byte relays may remain usable.
6. **Specialize only the measured costs.** Retain a pinned upstream baseline and
   its applicable correctness tests. Optimize block/text layout and indexes
   where profiles show value, then remove unused capabilities. Preserve numeric
   type references or explicitly version the format. Use one compatible engine
   instance across editor and providers.

The development target is a better replicated editor model. A fork is one means
to implement it, with a decision gate after the model proves its value.

## Follow-up: annotations, XML types and rendering cost

The annotation question strengthens the case for evaluating the text interface
and its maintained rendering view before deciding on a fork. It does not show
that Map/Array/Text was the wrong family of types.

### XML does not provide a different annotation engine

In pinned v13, `Y.XmlText` directly extends `Y.Text`. It inherits the same
`format`, `toDelta` and text-event implementation. `Y.XmlFragment` uses the same
sequence operations as `Y.Array`, while `Y.XmlElement` adds attributes using the
same map operations as `Y.Map`. An XML element can combine attributes and one
child sequence in a single shared object, which may suit some tree models. It
does not change split, move or formatting conflict resolution.
[XmlText source](https://github.com/yjs/yjs/blob/676cc334edb39867b74bd1f50a05eb85c8275d9b/src/types/YXmlText.js#L11),
[fragment methods](https://github.com/yjs/yjs/blob/676cc334edb39867b74bd1f50a05eb85c8275d9b/src/types/YXmlFragment.js#L317),
[element attributes](https://github.com/yjs/yjs/blob/676cc334edb39867b74bd1f50a05eb85c8275d9b/src/types/YXmlElement.js#L158).

Edytor deliberately distinguishes inline `content` from nested block `children`;
one XML child list would still need conventions to retain that distinction.
There are also migration differences: XmlText string/JSON serialization emits
markup, and XmlElement has no replicated node-name rename operation. Mutable
block types could instead use a replicated attribute. XML is a representation
option, not a drop-in optimization.
[Current block structure](/Users/arnaud/code/edytor/src/lib/block/block.svelte.ts:80),
[XML serialization](https://docs.yjs.dev/api/shared-types/y.xmltext),
[element encoding](https://github.com/yjs/yjs/blob/676cc334edb39867b74bd1f50a05eb85c8275d9b/src/types/YXmlElement.js#L248).

### The current adapter does avoidable work

Each `Text.setChildren` reads the plain string through `toJSON`, then calls our
custom `toDeltas`, which traverses the text's internal linked list again. It
rebuilds run objects, mark tuples and random run IDs. The renderer keys runs by
index and serialized marks rather than those IDs. Public JSON access converts
tuples back into objects; the optional `transformText` path converts transformed
JSON back into tuples again.
[Text refresh and getters](/Users/arnaud/code/edytor/src/lib/text/text.svelte.ts:52),
[adapter](/Users/arnaud/code/edytor/src/lib/text/deltas.ts:12),
[renderer keys](/Users/arnaud/code/edytor/src/lib/components/Text.svelte:13).

Y.Text already exports formatted runs with `toDelta()`. An isolated check with
overlapping bold and italic ranges produced the same text and mark values as
our adapter. Text and XmlText emitted identical patches for insertion, mark
removal, an object-valued link and deletion. The adapter regenerated IDs even
without a content change. This verifies the representation overlap for those
cases; it is not a proof that every custom-adapter behavior can be removed.
[Probe](/tmp/edytor-crdt-probe.cJMA89/annotations.mjs),
[results](/tmp/edytor-crdt-probe.cJMA89/annotations-results.json).

The first optimization candidate is one cached run representation, initialized
from native deltas and maintained using transaction patches. Keep unaffected
run objects stable, derive the plain string without another CRDT traversal, and
convert to public JSON at API/export boundaries. Keep syntax highlighting as a
derived decoration: the code plugin already uses `transformText` for marks that
are not persisted.
[Delta API](https://docs.yjs.dev/api/delta-format),
[decoration contract](/Users/arnaud/code/edytor/src/lib/plugins.ts:151),
[code decoration](/Users/arnaud/code/edytor/src/lib/plugins/code/CodePlugin.svelte:163).

This saves application reconstruction work, but v13 computes `event.delta` by
walking from the text's `_start`. Incremental renderer updates do not establish
constant-time CRDT processing. Profile the complete transaction path.
[Event implementation](https://github.com/yjs/yjs/blob/676cc334edb39867b74bd1f50a05eb85c8275d9b/src/types/YText.js#L655).

### What a specialized text type could improve

A type could own an indexed, maintained view of formatted spans and expose runs
and change notifications directly to Edytor. It could share immutable mark sets
locally and avoid allocating equivalent representations on every edit. That
would move useful responsibility into the text owner; simply relocating the
same full conversion into a class would not remove its cost.

Some projection remains necessary. Bold over `abcd` and italic over `cdef`
requires three visible runs: bold `ab`, bold-and-italic `cd`, and italic `ef`.
The objective is to maintain that view efficiently, rather than assume a stored
annotation tree can always be rendered without resolving overlapping spans.

Keep separately mergeable marks as separate replicated keys. Encoding all marks
as one array/object-valued attribute solely to match the renderer would make
concurrent bold and italic updates compete as one value. A local mark-set cache
can share storage without changing replicated conflict granularity.
[Formatting-key insertion](https://github.com/yjs/yjs/blob/676cc334edb39867b74bd1f50a05eb85c8275d9b/src/types/YText.js#L224),
[attribute encoding](https://github.com/yjs/yjs/blob/676cc334edb39867b74bd1f50a05eb85c8275d9b/src/structs/ContentFormat.js#L87).

There is a concrete core-level question to profile: v13 disables its search
markers when formatting is introduced. The Text/XmlText probe confirmed this
for both types. Improving indexed position lookup for formatted text could be
valuable if measurements identify it as a bottleneck; this is not a measured
speedup.
[Formatting integration](https://github.com/yjs/yjs/blob/676cc334edb39867b74bd1f50a05eb85c8275d9b/src/structs/ContentFormat.js#L70).

### V14 already has a relevant maintained view

Current `Y.Node.delta` is a lazily initialized live deep-delta cache. Transactions
patch it in place. This is relevant upstream work to compare with an Edytor
adapter or custom type, even though it neither produces our exact mark-tuple
format nor solves structural identity. Consumers must not mutate that cache;
the source also notes caveats with non-base renderers.
[Cache contract](https://github.com/yjs/yjs/blob/96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64/src/ynode.js#L776),
[transaction updates](https://github.com/yjs/yjs/blob/96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64/src/utils/Transaction.js#L250).

A local rc.26 probe retained the same cache reference through two formatting
changes, an insertion and a deletion; after each, it equaled a fresh deep delta.
This is an API check, not a concurrency or performance validation.
[Probe](/tmp/edytor-crdt-probe.cJMA89/v14-cache.mjs),
[results](/tmp/edytor-crdt-probe.cJMA89/v14-cache-results.json).

### Inline embeds are another concrete stock-Yjs option

The current Text–InlineBlock–Text representation splits a text container when a
mention is inserted. `Y.Text.insertEmbed` can instead insert an inline object or
shared type directly into the text sequence, retaining the surrounding character
identities. A two-replica probe inserted a shared mention at `hello |world` while
another peer appended `!`; both update orders produced `hello `, the mention,
and `world!`.
[API source](https://github.com/yjs/yjs/blob/676cc334edb39867b74bd1f50a05eb85c8275d9b/src/types/YText.js#L1145),
[probe](/tmp/edytor-crdt-probe.cJMA89/inline-embed.mjs),
[results](/tmp/edytor-crdt-probe.cJMA89/inline-embed-results.json).

One rich-text sequence per backing text is therefore worth comparing with our
current separated inline containers. It could remove some separator
normalization and avoid this particular copy/delete split. Embeds occupy a
sequence position, so rendering and selection offsets would need explicit
support. This does not solve splitting text between paragraphs.

## Validation record

- Inspected the current working-tree operations and their Yjs ownership model.
- Read Notion and the linked Peritext material; checked the current v14 manifest,
  exports, sequence implementation and legacy decoder at the pinned commit.
- Executed five failure probes in both update orders with duplicate replay, plus
  the stable-placement control in both orders. Assertions matched the recorded
  results.
- Independently reran the bundle measurement script; all reported byte counts
  matched.
- Ran the update-size experiment and saved the output.
- Did not run the full editor suites: this assessment changes no runtime code,
  and checkout dependencies were absent. Browser correctness, memory and latency
  improvements remain unmeasured.

The linked `/tmp` artifacts are local experiment outputs and may be removed by
system cleanup. The commands to rerun the existing artifacts are:

```sh
node /tmp/edytor-crdt-probe.cJMA89/probe.mjs
node /tmp/edytor-crdt-probe.cJMA89/update-bytes.mjs
node /tmp/edytor-yjs-bundle.lrv6Qw/measure.mjs
```
