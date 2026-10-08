# Vendored Yjs v14 — API notes for Edytor (U01 probe record)

Executable evidence: `src/tests/crdt/v14-smoke.test.ts` (every claim below is
asserted there) and the upstream suite `vendor-tests/yjs/` (331 tests green at
the probe; 222 after P8).
Source of truth: `src/index.js` exports + JSDoc in `src/ynode.js`.

> **Since patch P8 (`UPSTREAM.md`) this fork no longer ships** the renderers
> (`AttributionsRenderer`, `DiffRenderer`, `SnapshotRenderer` and their
> factories — `AbstractRenderer` stays), snapshots, `diffDocsToDelta`, the
> delta-position helpers, `encodeRelativePosition`/`decodeRelativePosition`/
> `compareRelativePositions`, the update loggers/obfuscators,
> `diffUpdate`/`readUpdate`/`createDocFromUpdate[V2]`/`cloneDoc`,
> `encodeStateVectorFromUpdate[V2]`, `createContentIdsFromUpdate[V2]`,
> `intersectUpdateWithContentIds[V2]`, `convertUpdateFormatV1ToV2`, the id-map
> algebra (`mergeIdMaps`, `diffIdMap`, `intersectMaps`, `filterIdMap`, …), the
> content-id helpers, `$node`, `getNodeChildren`, `getPathTo`, `tryGc`,
> `undoContentIds` and `logNode`. The table below is the rc.26 probe record;
> read it against that list.

## v13 → v14 name map (what's gone, what's renamed)

| v13 | v14 (rc.26) |
| --- | ----------- |
| `Y.Map`, `Y.Array`, `Y.Text`, `Y.XmlFragment`, `Y.XmlElement`, `Y.XmlText`, `Y.Doc#getMap/#getArray/#getText/#getXmlFragment` | **gone** — unified `Y.Node` (`class YNode`, exported as `Node`). Roots come from `doc.get(key)` (memoized per key; root nodes have `name === null`). `new Y.Node(name)` creates a named node. |
| `ytext.toDelta()` / `yarray.toDelta()` | `node.toDelta({deep?})` (fresh render) and **`node.delta`** — a *maintained* lib0 `Delta` cache (lazily rendered, kept in sync per transaction; `clearCache()` drops it). `delta.toJSON()` → `{type:'delta', name?, attrs?, children?}` with children = `{type:'insert', insert, format?, attribution?}` / `{type:'retain', retain}` / `{type:'modify', value}` / `{type:'delete', delete}` ops. |
| `ymap.get/set/delete/has/keys`, `yarray.get/insert/delete/slice/toArray`, `ytext.insert/delete/format` | one facet set on `YNode`: attrs — `setAttr/getAttr/hasAttr/deleteAttr/getAttrs/clearAttrs/attrKeys/attrValues/attrEntries/attrSize/forEachAttr`; sequence — `insert(idx, content, format?)`, `delete(idx,len)`, `get`, `slice(start,end)`, `push`, `unshift`, `map`, `forEach`, `length`, `toArray()`; rich text — `insert(idx,'text',{mark:val})`, `format(idx,len,{mark:val})`. `insert` accepts strings, objects, and `Y.Node` children in one list. |
| `yarray.toJSON()` / `ytext.toJSON()` / `yxml.toString()` | `node.toJSON()` → `{name?, attrs?, children?}` tree. `node.toString({forceTag?})` renders **`<name attrs>children</name>`** (attrs JSON-encoded; bare children when `name == null && !forceTag`). `slice()` returns an **Array** of items (chars for text), not a string. |
| `type.observe`/`observeDeep`/`unobserve`, `YEvent` / `YArrayEvent`/`YMapEvent`/`YTextEvent` | same names: `observe`, `observeDeep`, `unobserve`, `unobserveDeep`. One `YEvent` class: `e.target`, `e.currentTarget`, `e.delta` (shallow change delta), **`e.deltaDeep`** (nested modify-delta from the observer's root), `e.keysChanged` (Set of changed attrs), `e.childListChanged`, `e.transaction`, `getPathTo`. `observeDeep` fires one event per changed ancestor root — *not* the v13 array-of-events. New: **`node.on('delta', (delta, origin) => …)`** — the lib0 RDT change channel alongside `observe`. |
| `Y.applyUpdate`, `Y.encodeStateAsUpdate`, `Y.encodeStateVector`, `Y.mergeUpdates`, `Y.diffUpdate` | same names, plus `*V2` variants (`applyUpdateV2`, `encodeStateAsUpdateV2`, `mergeUpdatesV2`, `diffUpdateV2`), `readUpdate[V2]`, `createDocFromUpdate[V2]`, `cloneDoc`, `convertUpdateFormatV1ToV2`/`V2ToV1`, `decodeUpdate[V2]`, `logUpdate[V2]`, `encodeStateVectorFromUpdate[V2]`, `obfuscateUpdate[V2]`, `createContentIdsFromUpdate[V2]`, `intersectUpdateWithContentIds[V2]`. |
| `Y.createRelativePositionFromTypeIndex(type, index, assoc?)`, `createAbsolutePositionFromRelativePosition`, `relativePositionToJSON`, `createRelativePositionFromJSON` | same, plus `encodeRelativePosition`/`decodeRelativePosition` (binary), `compareRelativePositions`, `AbsolutePosition`/`RelativePosition` classes. JSON form `{tname: <root key>, assoc: -1|0|1}` — positions anchor by **root key name** (`doc.get('content')` → `tname:'content'`). New `position-helpers`: `createRelativePositionsFromDeltaPositions` & inverses (delta↔relative position mapping). |
| `Y.UndoManager(scope, opts)` | accepts `Doc \| YNode \| YNode[]` scope (a Doc covers all changes; a node covers itself + children — verified selective undo). API: `stopCapturing`, `undo`, `redo`, `canUndo/canRedo`, `addToScope`, `addTrackedOrigin`/`removeTrackedOrigin`, `clear`, `destroy`, `stack-item-added`/`stack-item-popped`/`stack-item-updated` events. `trackedOrigins` unchanged semantics (`Set`, `null` tracks bare `doc.transact`). `Y.undoContentIds` helper exported. |
| `Y.Snapshot`/`snapshot`/`createSnapshot`/`equalSnapshots` | same, plus `emptySnapshot`, `createDocFromSnapshot`, `decodeSnapshot`/`encodeSnapshot` (+V2), `snapshotContainsUpdate`. |
| (no equivalent) | **new**: `IdSet`/`IdMap` family (`createIdSet`, `mergeIdSets`, `diffIdSet`, `encodeIdSet`, `readIdMap`, `intersectMaps`, `createContentAttribute`, `ContentAttribute`, …), `BlockSet`, renderers (`AbstractRenderer`, `AttributionsRenderer`, `DiffRenderer`, `SnapshotRenderer`, `createAttributionsRenderer`, `createDiffRenderer`, `createSnapshotRenderer`), `diffDocsToDelta`, schemas (`$node`, `$nodeAny`, `$doc`, `$idSet`, `$idMap…`, `meta.js` exports), `cleanupYTextFormatting`, `transact`. |

## Behavioral caveats measured

- **Detached reads are empty.** Reading `delta`/`toString`/`slice` on a node
  before it is integrated into a `Doc` logs `Invalid access: Add Yjs type to a
  document before reading data.` and renders empty. Writes pre-integration
  persist and appear after `insert` into an integrated parent.
- **`node.delta` is a live cache** — do not mutate it (`applyDelta` is the write
  path); `clone()` for a snapshot. Integration after a detached `.delta` read
  does not retroactively refresh the cached delta — read `.delta` only once
  integrated.
- `toString()` is the element renderer (`<p id="b1">hi</p>`), not raw text —
  use `toArray()`/`delta` for text content.
- `doc.get(key)` is memoized; the root node's `name` is `null` even though the
  key exists (keys live in `tname` of relative positions, not `node.name`).

## Engine/dependency facts

- Requires `node >= 22` (upstream `engines`; recorded in edytor `package.json`).
- Runtime dep: `lib0-v14` (`lib0@1.0.0-rc.32`) — aliased; the v13 runtime keeps
  `lib0@0.2.117`. Never mix `lib0` (0.2.x) objects with the v14 engine.
- `import '@y/y'` (npm) and this vendored copy are **different engine
  instances** — the `__ $YJS14$ __` global guard logs an error and `instanceof`
  checks cross-fail. Providers must be built against the vendored entry
  (`edytor/crdt`), see U07 notes in `docs/archive/baseline/u01-report.md`.
