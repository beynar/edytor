# U07 provider-port research (pre-work, conducted post-U01)

Read-only investigation record. Feeds U07. Source: background exploration agent, 2026-09-19.

## Current provider surface

### `src/lib/localProvider.ts` (407 lines) — forked y-indexeddb `IndexeddbPersistence` + BroadcastChannel

Imports: `yjs` (Doc/transact/applyUpdate/encodeStateAsUpdate), `lib0/indexeddb`, `lib0/promise`, `lib0/observable` (ObservableV2), `lib0/broadcastchannel`, `lib0/encoding`, `lib0/decoding`, `y-protocols/sync`, `y-protocols/awareness`.

- IDB layout: DB name = ctor `name`; stores `updates` (autoIncrement) + `custom` (meta get/set/del). `_dbref` = next unread key, `_dbsize` = row count.
- `doc.on('update')` → `addAutoKey(encodeUpdateForStore(update))` unless origin === provider; `_dbsize >= 500` → debounced `storeState` (1s).
- `storeState`: fetchUpdates → append full `encodeStateAsUpdate` snapshot → delete rows ≤ `_dbref`.
- `fetchUpdates`: applies rows with `Y.transact(doc, …, provider, local=false)` — origin suppresses re-store.
- BC room = name; messageSync=0, messageAwareness=1, messageQueryAwareness=3 (y-websocket numbering). connectBc publishes SyncStep1+2+QueryAwareness then `synced=true`.
- Public: `doc`, `name`, `synced`, `whenSynced`, `awareness`, `bcconnected`, `get/set/del`, `destroy()` (idempotent; owns-awareness only destroys owned awareness).
- Deliberate deviation: `encodeUpdateForStore`/`decodeStoredUpdate` wraps raw Uint8Array in fresh ArrayBuffer — keep.

### `src/lib/collaboration/providers.ts`

- `EdytorSync = (payload: { doc, awareness, synced(provider?) }) => void | cleanup`.
- `createIndexeddbSync(name)` → IndexeddbPersistence, `'synced'` event → `synced(provider)`, cleanup `destroy()`.
- `createWebsocketSync(opts)` → y-websocket `WebsocketProvider`, listens `'sync'` (boolean).
- `Edytor.svelte` onMount calls `sync({doc, awareness, synced: () => edytor.sync(initialValue)})`; `Edytor` creates `new Awareness(doc)` and subscribes `'change'/'update'`.

### awarenessSelection.ts / remoteSelection.ts

- Publishes `Y.createRelativePositionFromTypeIndex(text.yText, offset, -1)` → `relativePositionToJSON` via `awareness.getLocalState/setLocalState`.
- Remote side: `createRelativePositionFromJSON` → `createAbsolutePositionFromRelativePosition` → `absolutePosition.type instanceof Y.Text` → match `text.yText === yText`. **v14: `.type` is a `YNode`; instanceof guard must become `Y.Node`.**

### Websocket usage

- `WebsocketProvider` imported only in providers.ts; re-exported via index. **No websocket server exists in the repo.** Playwright collaboration spec uses only IndexeddbPersistence+BroadcastChannel (two providers, two docs, one page). Model collab test shares ONE Y.Doc.

## npm state of v14-compatible providers

- `@y/protocols@1.0.6-rc.1` (installed): exports `./sync ./awareness ./auth`. sync.js is a REAL runtime dep on `@y/y` (encodeStateVector/encodeStateAsUpdate/applyUpdate) — byte-identical to `vendor-tests/yjs/tests/sync-shim.js` modulo imports. awareness.js `@y/y` import is JSDoc-only but still executes the module → fires double-engine guard; port must make it `import type`. Awareness extends ObservableV2; wire format is clock/JSON — v13-compatible on the wire.
- `@y/websocket`: v4 prerelease line exists (4.0.0-0 … 4.0.0-rc.2 — verify exact latest with `npm view` at exec time). Client-only; server moved to `@y/websocket-server`. Client ≈ y-websocket@3.0.0 src with retargeted imports — port reference.
- `@y/indexeddb`: **does not exist**. Local fork is the only impl → must port.
- `@y/y@14.0.0-rc.26` tarball: ships ESM `src/**` + `dist/**/*.d.ts` only. Deps `lib0@^1.0.0-rc.29`, engines node>=22, sideEffects:false.

## Vendored engine API for providers

- `applyUpdate` = V2-path decoding **V1** updates (v13 wire format). `update` event emits V1 payload; `updateV2` event exists. Keep V1 wire → byte-compatible sync protocol; do NOT claim mixed-v13/v14 live compat.
- `transact(doc, f, origin, local)` signature identical to v13. `readUpdateV2` forces `transaction.local=false`.
- `doc.get(key, name?)` → memoized YNode roots (replaces getMap/getText/getArray).
- No in-engine Awareness — port from @y/protocols.
- Relative positions exported: createRelativePositionFromTypeIndex/FromJSON, createAbsolutePositionFromRelativePosition, compareRelativePositions, relativePositionToJSON, encode/decodeRelativePosition. JSON form `{tname, assoc}`.
- Double-engine guard `__ $YJS14$ __` — any npm @y/\* runtime import instantiates a second engine and breaks instanceof.
- lib0-v14@1.0.0-rc.32 ships every needed module with same signatures: indexeddb, broadcastchannel, encoding, decoding, observable (ObservableV2), promise, time, math, function (equalityDeep), environment, url.

## Port list

| #   | Deliverable                                                                   | Port from                                    | Rewrite                                  | Notes                                                                                                                       |
| --- | ----------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| a   | `src/lib/crdt/protocols/sync.*`                                               | @y/protocols sync.js = sync-shim.js verbatim | imports only                             | already proven by 331-test suite                                                                                            |
| b   | `src/lib/crdt/protocols/awareness.*`                                          | @y/protocols awareness.js                    | lib0-v14 imports; `@y/y` → `import type` | keeps ObservableV2; wire-compatible presence                                                                                |
| c   | `src/lib/crdt/protocols/auth.*`                                               | @y/protocols auth.js                         | same                                     | only if websocket auth kept                                                                                                 |
| d   | localProvider port (`src/lib/crdt/providers/indexeddb.ts` or in-place at U08) | current localProvider.ts                     | imports only — verified 1:1              | keep ArrayBuffer wrapping, `_ownsAwareness`; U07.3/.5 add generation marker + version gate on `custom` store or new DB name |
| e   | WebsocketProvider port (if exports retained)                                  | y-websocket@3.0.0 src / @y/websocket v4      | imports only                             | emits both `'synced'`+`'sync'`; server side may use @y/websocket-server as opaque V1 relay only                             |
| f   | providers.ts retarget                                                         | current                                      | imports                                  | preserve EdytorSync shape                                                                                                   |
| g   | awarenessSelection/remoteSelection                                            | current                                      | vendored engine; `instanceof Y.Node`     | version presence payload per U07.3/U09.3                                                                                    |

## Cross-cutting risks

- Double engine: shipped v14 path must never runtime-import `@y/y`/`y-protocols`/`y-websocket`/`lib0` (0.2). JSDoc-only imports still execute — make them `import type`.
- lib0 split: keep 0.2 (v13 stack) and 1.0-rc.32 (v14) instances separate; duck-typed encoding is byte-compatible.
- Types for ported JS under src/lib: write as TS or extend `scripts/regen-crdt-vendor-types.sh` JSDoc→d.ts approach.
- U07.3 is the requirement that changes "verbatim port" shape: a real version gate (BC room naming/protocol-version handshake before readSyncMessage applies; generation marker consulted before fetchUpdates applies stored rows).
- U07.5: generation pointer slot in `custom` store or new DB name; BC + IDB transaction arbitrates concurrent tabs; never deleteDB old generation until verified.
- U07.7: opaque relay servers OK; doc-loading servers need vendored engine.
