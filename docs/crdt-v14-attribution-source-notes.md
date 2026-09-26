# Native v14 attribution: source notes and integration boundary

Date: 2026-09-21. Research only; no runtime changes.

## Conclusion

**Attribution is already a v14 feature. Edytor should connect the existing APIs, not implement another attribution algorithm.** The pinned engine supplies item-range metadata, compact encoding, attributed deltas, renderer-aware events/positions, and document diffs. Edytor must supply the actor identity, retain/transport that metadata, and expose it through its own projected runs. These are integration responsibilities. Accept/reject UI and a new history system are outside this proposal.

The reviewed sources are `@y/y@14.0.0-rc.26`, commit `96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64`, plus the documented local vendor patches; `lib0-v14` resolves to `lib0@1.0.0-rc.32`, npm `gitHead` `47b5e8480a77bd4641cdb01c4686c8466863e59e`. [Vendor manifest](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/UPSTREAM.md), [lib0 package metadata](https://registry.npmjs.org/lib0/1.0.0-rc.32).

## What the existing APIs provide

| Native API                                                                                 | Exact responsibility                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createContentIds(inserts, deletes)`                                                       | Pair of inserted/deleted item-ID range sets. Transactions already provide `insertSet` and `deleteSet`; `createContentIdsFromUpdate` can extract ranges from an encoded update.                           |
| `createContentAttribute(name, value)`                                                      | One metadata value, such as `('insert', userId)`, `('delete', userId)`, or `('insertAt', timestamp)`. It is not a formatting mark.                                                                       |
| `IdMap`, `createIdMapFromIdSet`, `insertIntoIdMap`, `mergeIdMaps`                          | Associate metadata with `(client, clock, length)` ranges; union overlapping attributes and merge adjacent equal ranges.                                                                                  |
| `createContentMap(inserts, deletes)`                                                       | Pair of attribution maps. `mergeContentMaps`, filtering, intersection, and `encodeContentMap`/`decodeContentMap` are supplied.                                                                           |
| `createAttributionsRenderer(contentMap, options?)`                                         | Render supplied attribution over document content. It does not discover application users or persist the maps.                                                                                           |
| `createDiffRenderer(previousDoc, currentDoc, { attributions })`                            | Render changes between two versions, optionally attaching the supplied actors. It already has suggestion/accept/reject machinery; using ordinary attribution does not require introducing that workflow. |
| `node.toDelta({ renderer })`, `event.getDelta({ renderer })`, `node.useRenderer(renderer)` | Read attributed state/events or set a default renderer. `node.delta` is the engine's maintained deep-delta cache.                                                                                        |

Sources: [public exports](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/index.js:6), [metadata helpers](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/meta.js:103), [IdMap](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/ids.js:1223), [renderers](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/Renderer.js:63), [default renderer/cache](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/ynode.js:953). The pinned source/export tree has **no `AttributionManager` class**; a runtime import returned `undefined`. That absence does not mean attribution is missing: these are its actual native APIs.

The native delta attribution shape is:

```ts
{
  insert?: string[];
  insertAt?: number;
  delete?: string[];
  deleteAt?: number;
  format?: Record<string, string[]>;
  formatAt?: number;
}
```

Actors are references, so `insert: ['user-123']` can resolve through one `users['user-123']` profile dictionary. Values are supplied by the caller; the engine does not create application user IDs or timestamps. Lib0 treats attribution as metadata, with per-key merging inside `format`. Its `rebase` explicitly does not reconcile concurrent attribution edits, so these rendered deltas should not become a second collaboration authority. [Pinned lib0 attribution definition](https://github.com/dmonad/lib0/blob/47b5e8480a77bd4641cdb01c4686c8466863e59e/src/delta/delta.js#L43), [engine schema](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/renderer-helpers.js:7).

## What needs automatic wiring

Upstream's own attribution test captures locally produced update ranges, adds `insert`/`delete` actor attributes to a `ContentMap`, and supplies it to a renderer. The compact equivalent can consume the transaction sets directly. This is the integration pattern to reuse. [Pinned upstream example](https://github.com/yjs/yjs/blob/96c96e1fcb1ef6ce866d5264b3f97f7f77b11f64/tests/attribution.tests.js#L135), [local copy](/Users/arnaud/code/edytor/vendor-tests/yjs/tests/attribution.tests.js:143).

```js
const change = Y.createContentMapFromContentIds(
	Y.createContentIds(transaction.insertSet, transaction.deleteSet),
	[Y.createContentAttribute('insert', userId)],
	[Y.createContentAttribute('delete', userId)]
);
```

This snippet demonstrates the native conversion, not a complete lifecycle handler. Runtime wiring must select user-origin transactions, exclude attribution-metadata writes from recapture, preserve received authors, and make attribution available before attributed event consumers read it.

**An attributed input delta does not persist authorship into the Y document.** `YNode.applyDelta` applies content and formats but does not copy `op.attribution` into stored items. Setting `origin` is also insufficient: transaction origins and `meta` are local runtime values; a receiving `applyUpdate` gets the receiver-supplied origin. [Application loop](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/ynode.js:1877), [transaction metadata](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/Transaction.js:97), [update application](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/encoding.js:246).

`ContentMap`/`IdMap` are ordinary runtime structures, not automatically replicated Y nodes. The supplied binary codecs solve serialization, but raw `encodeStateAsUpdate(doc)` does not include external maps. A single public save/load API must retain document bytes, attribution maps, and actor references together. Live providers need the same guarantee. If the existing Y update protocol must remain unchanged, store immutable, independently keyed encoded attribution records in document metadata and merge them with the native helpers. If metadata is carried beside updates, the save/transport envelope must include it. **Do not overwrite one shared global attribution blob:** concurrent captures would replace rather than merge one another. This storage choice is integration design, not a new attribution format or algorithm. [ContentMap codecs](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/meta.js:155), [IdMap representation](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/ids.js:1223).

**Minimal durability recommendation for the existing providers: a dedicated synced metadata root.** Put the actor dictionary and immutable `encodeContentMap(change)` records under reserved application-owned keys; rebuild/merge the in-memory attribution index with native `decodeContentMap`/`mergeContentMaps` on load and receipt. This makes current document save/IndexedDB/websocket paths carry attribution automatically. Capture only editing content, exclude that root and its write origin from capture/undo, and define how a content update and its metadata are committed/delivered so attributed reads never silently claim complete coverage before both arrive. Per-record Y overhead and eventual compaction still need measurement. This is proposed plumbing, not an existing automatic engine behavior.

A binary sidecar avoids the extra Y metadata records and permits efficient batching, but every persistence, initial-sync, reconnect, and incremental transport path must carry and merge it; a doc-only export would otherwise omit attribution. It is a reasonable later storage optimization once measured. Starting with it would enlarge this integration across the provider boundary. Neither choice requires replacing IdMap or building an audit/tracked-change subsystem.

Keep application identity separate from `doc.clientID`. The latter identifies a replica/session, is randomly generated, and can change after collision detection. One user may have multiple clients. A client-to-user dictionary can identify an item's original inserting replica, including a newly inserted format marker. It cannot recover the author of a deletion: the deletion range names the victim's item IDs. Capture deletion attribution at its origin and retain it. [Doc initialization](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/Doc.js:54), [collision handling](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/Transaction.js:310), [upstream attribution capture](/Users/arnaud/code/edytor/vendor-tests/yjs/tests/attribution.tests.js:149).

## The user dictionary idea already fits the storage model

Use one profile record per stable application user, referenced by native attribution strings. Avoid embedding names, avatar URLs, and other profile data into every range. A second bespoke per-delta dictionary is unnecessary initially: `IdMap` already interns equal `ContentAttribute` values, combines matching adjacent ranges, and encodes previously seen attributes/names as numeric references within each encoded map. That dictionary is scoped to an encoding; it does not eliminate repetition across separately encoded messages. [Interning](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/ids.js:1641), [range merging](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/ids.js:1119), [binary references](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/ids.js:1506).

A targeted probe encoded 100 disjoint ranges with the same long actor ID into 437 bytes; the actor string occurred once and all 100 ranges decoded. This establishes deduplication, not a production size or latency target. Distinct timestamps per keystroke or many actor boundaries reduce coalescing and increase metadata, rendering splits, and allocation. Profile lookup remains separate from attribution compression.

## Correct default rendering and undo behavior

1. **Preserve normal editing coordinates.** `AttributionsRenderer` displays every covered attributed range, including deleted content. Passing the full historical map as the ordinary editing renderer would resurrect deleted text in the view and change its offsets. Even an insertion-only map must be restricted to currently live IDs, since historical insertions can subsequently be deleted. The native intersection/set APIs can form this live view. Deleted-content/diff rendering is an explicit alternate view. [Renderer semantics](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/Renderer.js:45), [rendered lengths](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/Renderer.js:174).
2. **Maintain the renderer's view.** The constructor merges/copies the supplied maps into `renderAs`; mutating the original `ContentMap` does not refresh an existing renderer. The verified simple path is to build a fresh renderer for a read. A maintained default must update/rebuild its overlay and publish native renderer changes deliberately; merely constructing it once is insufficient. Repeated `useRenderer` switches can re-render/diff cached state. [Constructor](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/Renderer.js:70), [renderer switching](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/ynode.js:1021).
3. **Propagate attribution through Edytor's projection.** Its current direct text-range reader emits only text and marks, and coalesces by marks. Attaching a native renderer alone does not change those runs. Preserve native attribution as its own field and split/coalesce at attribution boundaries; do not turn authorship into a formatting mark. [Current range output](/Users/arnaud/code/edytor/src/lib/crdt/text/model.ts:415).
4. **Use the existing UndoManager, with explicit local origins.** Its defaults track `null` and do not automatically exclude remote transactions. Attribute system writes and received updates must not pollute user undo groups. Undo stacks and their `meta` remain runtime state, not durable authorship. [Capture/defaults](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/UndoManager.js:162), [capture predicate](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/UndoManager.js:207).
5. **Specify authorship on restoration.** Undo resurrects deleted content as new item IDs, copying content but not external attribution. A generic capture hook labels those new items with the undoing user. If `insert` means original content author, copy the old item's attribution onto the restored range; if it means author of the restoring operation, use the current actor. The engine supplies restoration, but cannot choose this product meaning. Edytor already has a local undo-restoration integration point for ownership. [New IDs on undo](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/UndoManager.js:515), [existing ownership repair](/Users/arnaud/code/edytor/docs/crdt-v14-undo-ownership-adr.md).

## Retention and performance limits

| Requirement                               | What must be retained                                                                                                                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Author of visible text/current formatting | Attribution for live item/format ranges plus actor references; no need to disable GC globally.                                                                                                        |
| Who deleted a range                       | Deletion actor metadata; victim item IDs alone cannot supply it.                                                                                                                                      |
| Render the old deleted text               | Its actual content. `AttributionsRenderer` cannot recover GC-discarded payloads; it documents `gc: false` for this view. `DiffRenderer` can retrieve old content from its retained previous document. |
| Undo recent local actions                 | UndoManager's stack and kept items; retention is bounded by clearing history. `keep` does not persist through storage or peer updates.                                                                |
| Full ordered, durable audit history       | Additional event/history retention. A merged range map is not an ordered log of every operation. This is not required to use native attribution.                                                      |

Sources: [renderer retention](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/Renderer.js:56), [DiffRenderer restoration](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/Renderer.js:550), [UndoManager keep semantics](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/UndoManager.js:531), [IdMap union representation](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/ids.js:1119).

Attribution lookup/segmentation and overlay maintenance add real work. The current vendored P4 edit/position optimizations require `renderer === null`; activating a default renderer bypasses those paths. Capture metadata by default if required, but measure normal edit, attributed read, and historical view independently. Do not infer the existing unrendered benchmark gains survive a default attributed renderer. [Seed gate](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/ynode.js:1833), [renderer-aware length](/Users/arnaud/code/edytor/src/lib/crdt/vendor/yjs/src/utils/renderer-helpers.js:120).

## Executed evidence

Temporary probe: `/tmp/edytor-attribution-probe.mjs`, executed against the working-tree vendor and installed pinned lib0. It verified:

- Supplying `insert: ['alice']` on an input delta alone does not appear in a later plain document delta.
- Captured item ranges render native insertion author `alice` and formatting author `bob`; deleting renders author `carol` through the native renderer.
- Updating the source maps leaves an existing renderer stale; a fresh renderer observes the new attribution.
- A document-only round trip loses the external attribution; a document plus encoded `ContentMap` round trip restores it.
- Native encoding deduplicates repeated actor values as described above.
- Naive capture attributes undo-restored text to the current undo actor.
- With default GC, attributing the deleted IDs does not recover their discarded text.

No multi-client persistence implementation or end-to-end attributed Svelte rendering was built or benchmarked. The proposed wiring should be validated with concurrent actors, multiple clients per user, offline/reordered delivery, reload, undo/redo, split/merge ownership, and live-view offset invariance before becoming the default.
